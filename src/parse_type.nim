## parse_type.nim — TYPE DEFS, ROUTINE DEFS, PARAMS, GENERICS, PRAGMAS.
##
## Spliced after parse_expr.nim, before parse_stmt.nim. `parseType` /
## `parseTypeSection` are the cross-file entries (forward-declared in
## parsecore.nim); routine bodies call `parseStmt` (forward-declared in
## parsecore.nim, implemented in parse_stmt.nim).
##
## Emits NIF matching classic nifler byte-for-byte on supported constructs;
## structural (line-info-stripped) equality is the pass criterion.

# --- local forward declarations (mutual recursion inside this file) ----------
proc parseTypeRange(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32)
proc parseProcType(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32)
proc parseTupleInline(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32)
proc parseParams(ps: var Parser; b: var Builder; lpIdx: int; pl, pc: int32): int
proc parsePragmas(ps: var Parser; b: var Builder; braceIdx: int; pl, pc: int32): int
proc parseGenerics(ps: var Parser; b: var Builder; lbIdx: int; pl, pc: int32): int
proc parseObject(ps: var Parser; b: var Builder; objIdx, defIndent: int; pl, pc: int32): int
proc parseEnum(ps: var Parser; b: var Builder; enumIdx, defIndent: int; pl, pc: int32): int
proc parseTypeDef(ps: var Parser; b: var Builder; nameIdx, typeKwCol: int; pl, pc: int32): int

# --- helpers -----------------------------------------------------------------

proc isPrefixTypeKw(s: string): bool =
  # NB: `static`/`sink`/`lent` are NOT here — nifler renders `static[int]` as
  # `(at static int)` and `static int` / `lent T` as `(cmd …)`, not a prefix tag.
  s == "ref" or s == "ptr" or s == "var" or s == "out" or s == "distinct"

proc prefixTypeTag(s: string): string =
  if s == "var": "mut" else: s   # ref/ptr/out/distinct map to their own spelling

proc typeExprEnd(ps: var Parser; lo: int): int =
  ## End (exclusive) of an inline type expression starting at `lo`. Stops at a
  ## depth-0 `,` `;` `:` `)` `]` `}` `{` (pragma) or `=`, or a new logical line.
  ## Exception: a `proc`/`iterator` TYPE owns the return colon after its param
  ## parens (`proc (a): int`) — that `:` must not end the type, else the `=`
  ## default that follows is dropped.
  let procType = ps.tok(lo).kind == tkKeyword and
                 (ps.tok(lo).s == "proc" or ps.tok(lo).s == "iterator")
  var retPending = false          # proc param parens closed; the next `:` is the return
  var depth = 0
  var i = lo
  let startLine = ps.tok(lo).line
  while ps.tok(i).kind != tkEof:
    let t = ps.tok(i)
    if depth == 0 and t.kind == tkCurlyLe:
      break                       # depth-0 '{' starts a pragma → ends the type
    elif isOpenBracket(t.kind):
      inc depth
    elif isCloseBracket(t.kind):
      if depth == 0: break
      dec depth
      if depth == 0 and procType and t.kind == tkParRi: retPending = true
    elif depth == 0:
      if t.kind == tkColon and retPending:
        retPending = false        # consume the proc return colon, keep scanning
      elif t.kind == tkComma or t.kind == tkSemicolon or t.kind == tkColon:
        break
      elif t.kind == tkOperator and t.s == "=":
        break
      elif t.line != startLine and t.indent >= 0:
        break
    inc i
  result = i

# --- type expressions --------------------------------------------------------

proc parseTypeRangeImpl(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## Emit ONE type expression covering tokens `[lo, hi)`.
  if lo >= hi:
    b.addEmpty
    return
  let first = ps.tok(int(lo))
  # prefix type keywords: ref/ptr/var(->mut)/out/distinct/static
  if first.kind == tkKeyword and isPrefixTypeKw(first.s):
    b.addTree prefixTypeTag(first.s)
    ps.emitInfo(b, first.line, first.col, pl, pc, false)
    parseTypeRange(ps, b, lo + 1, hi, first.line, first.col)
    b.endTree()
    return
  # proc / iterator type
  if first.kind == tkKeyword and (first.s == "proc" or first.s == "iterator"):
    parseProcType(ps, b, lo, hi, pl, pc)
    return
  # inline tuple type
  if first.kind == tkKeyword and first.s == "tuple":
    parseTupleInline(ps, b, lo, hi, pl, pc)
    return
  # parenthesized anonymous tuple type: `(string, int)` → `(tup string int)`,
  # `(line: int32, col: int32)` → `(tup (kv line int32) …)`.
  if first.kind == tkParLe and ps.matchClose(int(lo)) == int(hi) - 1:
    let rb = int(hi) - 1
    b.addTree "tup"
    ps.emitInfo(b, first.line, first.col, pl, pc, false)
    let elems = ps.splitArgs(int(lo) + 1, rb)
    for ei in 0 ..< elems.len:
      let eLo = elems[ei]
      let eHi = if ei + 1 < elems.len: elems[ei+1] - 1 else: rb
      if eLo >= eHi: continue
      let colon = ps.depth0Colon(eLo, eHi)
      if colon >= 0:
        let nm = ps.tok(eLo)
        b.addTree "kv"
        ps.emitInfo(b, nm.line, nm.col, first.line, first.col, false)
        b.addIdent nm.s
        ps.emitInfo(b, nm.line, nm.col, nm.line, nm.col, false)
        parseTypeRange(ps, b, int32(colon + 1), int32(eHi), nm.line, nm.col)
        b.endTree()
      else:
        parseTypeRange(ps, b, int32(eLo), int32(eHi), first.line, first.col)
    b.endTree()
    return
  # top-level binary operator (e.g. `T | U`) → infix
  let sp = ps.findSplit(int(lo), int(hi))
  if sp >= 0:
    let op = ps.tok(sp)
    b.addTree "infix"
    ps.emitInfo(b, op.line, op.col, pl, pc, false)
    b.addIdent op.s
    ps.emitInfo(b, op.line, op.col, op.line, op.col, false)
    parseTypeRange(ps, b, lo, int32(sp), op.line, op.col)
    parseTypeRange(ps, b, int32(sp) + 1, hi, op.line, op.col)
    b.endTree()
    return
  # command in type position: `lent string`, `sink T`, `owned Foo` → `(cmd lent
  # string)`. Must precede the postfix `[]`/`.` checks so `sink seq[string]`
  # binds as `sink (seq[string])`, not `(sink seq)[string]` — a leading modifier
  # keyword has a SPACE before its argument, so cmdCalleeEnd stops at it, whereas
  # `seq[string]` (adjacent `[`) keeps the bracket in the callee (ce == hi).
  block:
    let ce = ps.cmdCalleeEnd(int(lo), int(hi))
    if ps.tok(int(lo)).kind == tkIdent and ce < int(hi) and ps.startsArg(ce, int(hi)):
      # A command in TYPE position (`lent T`, `sink seq[int]`) is an
      # expression-context command: nkCommand.info = the FIRST ARGUMENT, so the
      # callee gets a negative delta back (like parse_expr's value commands).
      let arg0 = ps.tok(ce)
      b.addTree "cmd"
      ps.emitInfo(b, arg0.line, arg0.col, pl, pc, false)
      parseTypeRange(ps, b, lo, int32(ce), arg0.line, arg0.col)
      let starts = ps.splitArgs(ce, int(hi))
      for ai in 0 ..< starts.len:
        let aLo = starts[ai]
        let aHi = if ai + 1 < starts.len: starts[ai+1] - 1 else: int(hi)
        if aLo < aHi:
          parseTypeRange(ps, b, int32(aLo), int32(aHi), arg0.line, arg0.col)
      b.endTree()
      return
  # postfix bracket → `(at base args...)`
  if ps.tok(int(hi) - 1).kind == tkBracketRi:
    # find the matching '[' at depth 0
    var depth = 0
    var k = int(hi) - 1
    while k >= int(lo):
      let kk = ps.tok(k).kind
      if isCloseBracket(kk): inc depth
      elif isOpenBracket(kk):
        dec depth
        if depth == 0: break
      dec k
    if k > int(lo) and ps.tok(k).kind == tkBracketLe:
      let lb = ps.tok(k)
      b.addTree "at"
      ps.emitInfo(b, lb.line, lb.col, pl, pc, false)
      parseTypeRange(ps, b, lo, int32(k), lb.line, lb.col)
      let starts = ps.splitArgs(k + 1, int(hi) - 1)
      for ai in 0 ..< starts.len:
        let aLo = starts[ai]
        let aHi = if ai + 1 < starts.len: starts[ai+1] - 1 else: int(hi) - 1
        if aLo < aHi:
          parseTypeRange(ps, b, int32(aLo), int32(aHi), lb.line, lb.col)
      b.endTree()
      return
  # postfix dot → `(dot L R)` (rightmost depth-0 tkDot)
  block dotCase:
    var depth = 0
    var d = -1
    var i = int(lo)
    while i < int(hi):
      let t = ps.tok(i)
      if isOpenBracket(t.kind): inc depth
      elif isCloseBracket(t.kind):
        if depth > 0: dec depth
      elif depth == 0 and t.kind == tkDot and i > int(lo):
        d = i
      inc i
    if d > int(lo):
      let dt = ps.tok(d)
      b.addTree "dot"
      ps.emitInfo(b, dt.line, dt.col, pl, pc, false)
      parseTypeRange(ps, b, lo, int32(d), dt.line, dt.col)
      parseTypeRange(ps, b, int32(d) + 1, hi, dt.line, dt.col)
      b.endTree()
      return
  # atom: a single type name (ident/keyword, or `(quoted …)` for a backtick
  # operand like `varargs[string, ` $ `]`). Anything else that fell through the
  # type-specific forms is an EXPRESSION in type-arg position — a literal
  # (`array[4, byte]`) or a call/range bound (`array[succ(low(X))..high(X), T]`)
  # — which the expression emitter renders correctly (an int must not be
  # `addIdent`-escaped to `\34`, a call must keep its arguments).
  let t = ps.tok(int(lo))
  if int(lo) + 1 >= int(hi) and (t.kind == tkIdent or t.kind == tkKeyword):
    ps.emitName(b, t, pl, pc)
  else:
    ps.parseExprRange(b, lo, hi, pl, pc)

proc parseTypeRange(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## Depth-guarding wrapper (see `enterDepth`): counts recursion nesting for
  ## `--max-depth`, then delegates. Off-by-default: inert when maxDepth == 0.
  ps.enterDepth(ps.tok(int(lo)).line)
  ps.parseTypeRangeImpl(b, lo, hi, pl, pc)
  dec ps.depth

proc parseType(ps: var Parser; b: var Builder; idx: int; pl, pc: int32): int =
  ## Inline type expression starting at token `idx`. Returns the index after it.
  let hi = ps.typeExprEnd(idx)
  parseTypeRange(ps, b, int32(idx), int32(hi), pl, pc)
  result = hi

proc parseTupleInline(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## `tuple[a: int, b: string]` → `(tuple (kv name type)...)`.
  let kw = ps.tok(int(lo))
  b.addTree "tuple"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  # locate the `[` and its matching `]`
  var lb = int(lo) + 1
  while lb < int(hi) and ps.tok(lb).kind != tkBracketLe: inc lb
  if lb < int(hi):
    let rb = ps.matchClose(lb)
    # A field group is `name (, name)* : type` — the type is shared (duplicated
    # into each `kv`). Groups are delimited by the comma AFTER a type, so we
    # cannot just split on every comma (that would strip the type off all but
    # the last name of a shared-type group like `a, b: int`).
    var i = lb + 1
    while i < rb:
      var names: seq[Token] = @[]
      while i < rb and (ps.tok(i).kind == tkIdent or ps.tok(i).kind == tkKeyword):
        names.add ps.tok(i)
        inc i
        if i < rb and ps.tok(i).kind == tkComma: inc i
        else: break
      var tLo = -1
      var tHi = rb
      if i < rb and ps.tok(i).kind == tkColon:
        tLo = i + 1
        # type runs to the next depth-0 group separator (`,` or `;`) or `]`
        var d = 0
        var k = tLo
        while k < rb:
          let kk = ps.tok(k)
          if isOpenBracket(kk.kind): inc d
          elif isCloseBracket(kk.kind):
            if d > 0: dec d
          elif d == 0 and (kk.kind == tkComma or kk.kind == tkSemicolon): break
          inc k
        tHi = k
        i = k
      if i < rb and (ps.tok(i).kind == tkComma or ps.tok(i).kind == tkSemicolon): inc i
      for nm in names:
        b.addTree "kv"
        # nifler emits each tuple field relative to the tuple's PARENT
        # (relLineInfo(def[j], parent) — not the tuple node), so the kv's parent
        # anchor is (pl, pc), the position passed in for the tuple itself.
        ps.emitInfo(b, nm.line, nm.col, pl, pc, false)
        b.addIdent nm.s
        ps.emitInfo(b, nm.line, nm.col, nm.line, nm.col, false)
        if tLo >= 0:
          parseTypeRange(ps, b, int32(tLo), int32(tHi), nm.line, nm.col)
        else:
          b.addEmpty
        b.endTree()
      if names.len == 0: inc i     # progress guard on unexpected tokens
  b.endTree()

proc parseProcType(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## `proc(params): ret {.pragmas.}` in type position → `(proctype ...)`.
  ## Fixed shape: name/export/pattern/generics (4 empties), params + return
  ## sibling, pragmas, then exceptions+body (2 empties).
  let kw = ps.tok(int(lo))
  let tag = if kw.s == "iterator": "itertype" else: "proctype"
  # locate the params '('
  var lp = int(lo) + 1
  while lp < int(hi) and ps.tok(lp).kind != tkParLe: inc lp
  b.addTree tag
  if lp < int(hi):
    let lpTok = ps.tok(lp)
    ps.emitInfo(b, lpTok.line, lpTok.col, pl, pc, false)   # proctype node = '(' pos
    b.addEmpty 4                                            # name export pattern generics
    var i = ps.parseParams(b, lp, lpTok.line, lpTok.col)    # params (+ ret sibling)
    if ps.tok(i).kind == tkCurlyLe:
      i = ps.parsePragmas(b, i, lpTok.line, lpTok.col)
    else:
      b.addEmpty                                            # pragmas
    b.addEmpty 2                                            # exceptions, body
  else:
    ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
    b.addEmpty 8
  b.endTree()

# --- pragmas -----------------------------------------------------------------

proc parsePragmas(ps: var Parser; b: var Builder; braceIdx: int; pl, pc: int32): int =
  ## `{.a, b: c.}` → `(pragmas a ...)`. Returns index after the closing `}`.
  let brace = ps.tok(braceIdx)
  let rb = ps.matchClose(braceIdx)
  b.addTree "pragmas"
  ps.emitInfo(b, brace.line, brace.col, pl, pc, false)     # pragmas node = '{' pos
  var lo = braceIdx + 1
  if lo < rb and ps.tok(lo).kind == tkDot: inc lo          # skip leading '.'
  var hi = rb
  if hi - 1 >= lo and ps.tok(hi - 1).kind == tkDot: dec hi # skip trailing '.'
  # Leading command-pragma word: `{.push X.}` / `{.pop.}`. Nim's parsePragma
  # loops `exprColonEqExpr` without requiring commas, so a bare word followed by
  # a *new* primary (not `,`/`:`/`=`/operator/paren) is its own element and the
  # rest is the normal comma list. `{.pop.}` (word then end) stays a lone elem.
  if lo + 1 < hi and (ps.tok(lo).kind == tkIdent or ps.tok(lo).kind == tkKeyword):
    let nxt = ps.tok(lo + 1)
    if nxt.kind == tkIdent or nxt.kind == tkKeyword or
       nxt.kind == tkStrLit or nxt.kind == tkIntLit or nxt.kind == tkFloatLit:
      ps.emitName(b, ps.tok(lo), brace.line, brace.col)
      inc lo
  let starts = ps.splitArgs(lo, hi)
  for ai in 0 ..< starts.len:
    let aLo = starts[ai]
    let aHi = if ai + 1 < starts.len: starts[ai+1] - 1 else: hi
    if aLo < aHi:
      ps.parseArg(b, int32(aLo), int32(aHi), brace.line, brace.col)
  b.endTree()
  result = rb + 1

# --- generic params ----------------------------------------------------------

proc emitTypevarGroup(ps: var Parser; b: var Builder; gLo, gHi: int;
                      tvL, tvC: int32) =
  var ci = gLo
  var names: seq[Token] = @[]
  while ci < gHi and (ps.tok(ci).kind == tkIdent or ps.tok(ci).kind == tkKeyword):
    names.add ps.tok(ci)
    inc ci
    if ci < gHi and ps.tok(ci).kind == tkComma: inc ci
    else: break
  var cLo = -1
  var cHi = gHi
  if ci < gHi and ps.tok(ci).kind == tkColon:
    cLo = ci + 1
  for nm in names:
    b.addTree "typevar"
    ps.emitInfo(b, nm.line, nm.col, tvL, tvC, false)        # typevar node = name pos
    ps.emitName(b, nm, nm.line, nm.col)   # typevar name, or `(quoted …)`
    b.addEmpty                                              # export (always .)
    b.addEmpty                                              # pragma
    if cLo >= 0:
      parseTypeRange(ps, b, int32(cLo), int32(cHi), nm.line, nm.col)
    else:
      b.addEmpty                                            # constraint
    b.addEmpty                                              # value
    b.endTree()

proc parseGenerics(ps: var Parser; b: var Builder; lbIdx: int; pl, pc: int32): int =
  ## `[T; U: C]` → `(typevars (typevar name . pragma constraint value)...)`.
  ## Returns index after the closing `]`.
  let lb = ps.tok(lbIdx)
  let rb = ps.matchClose(lbIdx)
  b.addTree "typevars"
  ps.emitInfo(b, lb.line, lb.col, pl, pc, false)           # typevars node = '[' pos
  # Split into param groups on `;`, and on a `,` that follows a depth-0 `:`
  # constraint (`[T: A, L: B]` = two params) — a `,` BEFORE any `:` builds a
  # shared-constraint name list (`[T, U: C]` = one group).
  var gstart = lbIdx + 1
  var i = lbIdx + 1
  var depth = 0
  var seenColon = false
  while i < rb:
    let k = ps.tok(i).kind
    if isOpenBracket(k): inc depth
    elif isCloseBracket(k):
      if depth > 0: dec depth
    elif depth == 0 and (k == tkSemicolon or (k == tkComma and seenColon)):
      ps.emitTypevarGroup(b, gstart, i, lb.line, lb.col)
      gstart = i + 1
      seenColon = false
    elif depth == 0 and k == tkColon:
      seenColon = true
    inc i
  if gstart < rb:
    ps.emitTypevarGroup(b, gstart, rb, lb.line, lb.col)
  b.endTree()
  result = rb + 1

# --- type section / defs -----------------------------------------------------

proc splitFieldName(ps: var Parser; i: var int; hi: int;
                    nameTok: var Token; hasExport: var bool;
                    pragLo, pragHi: var int) =
  ## Consume one field/typedef name: `name`, `name*`, optional `{.prag.}`.
  nameTok = ps.tok(i)
  hasExport = false
  pragLo = -1
  pragHi = -1
  inc i
  if i < hi and ps.tok(i).kind == tkOperator and ps.tok(i).s == "*":
    hasExport = true
    inc i
  if i < hi and ps.tok(i).kind == tkCurlyLe:
    let rb = ps.matchClose(i)
    pragLo = i
    pragHi = rb
    i = rb + 1

proc emitPragmaSlot(ps: var Parser; b: var Builder; pragLo, pragHi: int;
                    pl, pc: int32) =
  if pragLo >= 0:
    discard ps.parsePragmas(b, pragLo, pl, pc)
  else:
    b.addEmpty

proc emitFieldLine(ps: var Parser; b: var Builder; fi, lineHi: int;
                   kl, kc: int32) =
  ## Emit `(fld …)` nodes for one `name(, name)* [: type] [= val]` line, with
  ## the type/value duplicated across a shared-type name group. `kl,kc` = the
  ## parent (object/of) node position.
  # a bare `nil` or `discard` marks a variant branch with no fields → `(nil)`.
  if ps.tok(fi).kind == tkKeyword and
     (ps.tok(fi).s == "nil" or ps.tok(fi).s == "discard"):
    b.addTree "nil"
    ps.emitInfo(b, ps.tok(fi).line, ps.tok(fi).col, kl, kc, false)
    b.endTree()
    return
  var j = fi
  var names: seq[Token] = @[]
  var exports: seq[bool] = @[]
  var firstPragLo = -1
  var firstPragHi = -1
  while j < lineHi and (ps.tok(j).kind == tkIdent):
    var nm = ps.tok(j)
    var ex = false
    var pl2 = -1
    var ph2 = -1
    ps.splitFieldName(j, lineHi, nm, ex, pl2, ph2)
    names.add nm
    exports.add ex
    if pl2 >= 0 and firstPragLo < 0:
      firstPragLo = pl2; firstPragHi = ph2
    if j < lineHi and ps.tok(j).kind == tkComma: inc j
    else: break
  var tLo = -1
  var tHi = lineHi
  var vLo = -1
  if j < lineHi and ps.tok(j).kind == tkColon:
    inc j
    tLo = j
    tHi = ps.typeExprEnd(j)
    j = tHi
    if j < lineHi and ps.tok(j).kind == tkCurlyLe:   # trailing proc-type pragma
      j = ps.matchClose(j) + 1
      tHi = j
  if j < lineHi and ps.tok(j).kind == tkOperator and ps.tok(j).s == "=":
    vLo = j + 1
  for ni in 0 ..< names.len:
    let nm = names[ni]
    # Field name-node anchor, mirroring the classic wrapping (see parseSectionDef):
    # a pragma wraps it in nkPragmaExpr at the `{.`; an export alone is nkPostfix
    # at the `*` (directly after the name, nm.endCol); a plain name at itself.
    let aCol =
      if firstPragLo >= 0: ps.tok(firstPragLo).col
      elif exports[ni]: nm.endCol
      else: nm.col
    b.addTree "fld"
    ps.emitInfo(b, nm.line, aCol, kl, kc, false)
    ps.emitName(b, nm, nm.line, aCol)   # field name atom, or `(quoted …)`
    if exports[ni]: b.addRaw " x" else: b.addEmpty
    ps.emitPragmaSlot(b, firstPragLo, firstPragHi, nm.line, aCol)
    if tLo >= 0:
      parseTypeRange(ps, b, int32(tLo), int32(tHi), nm.line, aCol)
    else:
      b.addEmpty
    if vLo >= 0:
      ps.parseExprRange(b, int32(vLo), int32(lineHi), nm.line, aCol)
    else:
      b.addEmpty
    b.endTree()

proc emitFieldBody(ps: var Parser; b: var Builder; colonIdx, defIndent: int;
                   kl, kc: int32): int =
  ## Body of an object-variant `of`/`else` branch: bare `(fld …)` for a one-line
  ## `of A: x: int`, or `(stmts (fld …)…)` for an indented block. Returns next idx.
  let bodyStart = colonIdx + 1
  let first = ps.tok(bodyStart)
  if first.indent < 0:
    # one-line: emit field(s) directly (bare)
    let hi = ps.lineEnd(bodyStart)
    ps.emitFieldLine(b, bodyStart, hi, kl, kc)
    result = hi
  else:
    # indented block of fields wrapped in stmts
    b.addTree "stmts"
    ps.emitInfo(b, first.line, first.col, kl, kc, false)
    var i = bodyStart
    while ps.tok(i).kind != tkEof and ps.tok(i).indent > int32(defIndent):
      if ps.tok(i).kind == tkComment: inc i; continue
      let lh = ps.lineEnd(i)
      ps.emitFieldLine(b, i, lh, first.line, first.col)
      i = lh
    b.endTree()
    result = i

proc parseObjectCase(ps: var Parser; b: var Builder; caseIdx, defIndent: int;
                     kl, kc: int32): int =
  ## Object variant: `case disc: T` + `of (ranges …): fields` / `else: fields`.
  let kw = ps.tok(caseIdx)
  b.addTree "case"
  ps.emitInfo(b, kw.line, kw.col, kl, kc, false)
  # discriminator field on the case line: `case name: Type`
  let caseHi = ps.lineEnd(caseIdx)
  ps.emitFieldLine(b, caseIdx + 1, caseHi, kw.line, kw.col)
  var i = caseHi
  let refIndent = kw.col
  while ps.tok(i).kind != tkEof and ps.tok(i).indent >= int32(refIndent) and
        ps.tok(i).kind == tkKeyword and
        (ps.tok(i).s == "of" or ps.tok(i).s == "else" or ps.tok(i).s == "elif"):
    let br = ps.tok(i)
    let bhi = ps.lineEnd(i)
    let bcolon = ps.findColon(i, bhi)
    if br.s == "of":
      b.addTree "of"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      b.addTree "ranges"
      ps.emitInfo(b, br.line, br.col, br.line, br.col, false)
      let vals = ps.splitArgs(i + 1, if bcolon >= 0: bcolon else: bhi)
      for vi in 0 ..< vals.len:
        let vLo = vals[vi]
        let vHi = if vi + 1 < vals.len: vals[vi+1] - 1 else: (if bcolon >= 0: bcolon else: bhi)
        if vLo < vHi:
          ps.parseExprRange(b, int32(vLo), int32(vHi), br.line, br.col)
      b.endTree()   # ranges
      i = ps.emitFieldBody(b, bcolon, refIndent, br.line, br.col)
      b.endTree()   # of
    else:
      b.addTree(if br.s == "elif": "elif" else: "else")
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      i = ps.emitFieldBody(b, bcolon, refIndent, br.line, br.col)
      b.endTree()
  b.endTree()   # case
  result = i

proc parseObjectWhen(ps: var Parser; b: var Builder; whenIdx, defIndent: int;
                     kl, kc: int32): int =
  ## Conditional fields in an object: `when cond: fields` (+ `elif`/`else`).
  let kw = ps.tok(whenIdx)
  b.addTree "when"
  ps.emitInfo(b, kw.line, kw.col, kl, kc, false)
  var i = whenIdx
  let refIndent = kw.col
  while ps.tok(i).kind == tkKeyword and ps.tok(i).indent >= int32(refIndent) and
        (ps.tok(i).s == "when" or ps.tok(i).s == "elif" or ps.tok(i).s == "else"):
    let br = ps.tok(i)
    let bhi = ps.lineEnd(i)
    let bcolon = ps.findColon(i, bhi)
    if br.s == "else":
      b.addTree "else"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      i = ps.emitFieldBody(b, bcolon, refIndent, br.line, br.col)
      b.endTree()
    else:
      let ct = ps.tok(i + 1)
      b.addTree "elif"
      ps.emitInfo(b, ct.line, ct.col, kw.line, kw.col, false)
      if bcolon > i + 1:
        ps.parseExprRange(b, int32(i + 1), int32(bcolon), ct.line, ct.col)  # cond
      else:
        b.addEmpty
      i = ps.emitFieldBody(b, bcolon, refIndent, ct.line, ct.col)
      b.endTree()
  b.endTree()   # when
  result = i

proc parseObject(ps: var Parser; b: var Builder; objIdx, defIndent: int;
                 pl, pc: int32): int =
  ## `(object <inherit-or-.> (fld ...)...)`. `pl,pc` = type node position.
  let kw = ps.tok(objIdx)
  b.addTree "object"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)           # object node = keyword pos
  let objLineEnd = ps.lineEnd(objIdx)
  # inheritance: `of Parent`
  var i = objIdx + 1
  if i < objLineEnd and ps.tok(i).kind == tkKeyword and ps.tok(i).s == "of":
    inc i
    if i < objLineEnd:
      let pt = ps.tok(i)
      # single parent type (ident); parented to the object node
      b.addIdent pt.s
      ps.emitInfo(b, pt.line, pt.col, kw.line, kw.col, false)
      inc i
  else:
    b.addEmpty                                             # no inheritance
  # fields: indented lines deeper than the def
  var fi = objLineEnd
  while ps.tok(fi).kind != tkEof and ps.tok(fi).indent > int32(defIndent):
    if ps.tok(fi).kind == tkComment:      # doc comment in object body: dropped
      inc fi; continue
    if ps.tok(fi).kind == tkKeyword and ps.tok(fi).s == "case":
      fi = ps.parseObjectCase(b, fi, defIndent, kw.line, kw.col)
      continue
    if ps.tok(fi).kind == tkKeyword and ps.tok(fi).s == "when":
      fi = ps.parseObjectWhen(b, fi, defIndent, kw.line, kw.col)
      continue
    let lineHi = ps.lineEnd(fi)
    ps.emitFieldLine(b, fi, lineHi, kw.line, kw.col)
    fi = lineHi
  b.endTree()
  result = fi

proc parseEnum(ps: var Parser; b: var Builder; enumIdx, defIndent: int;
               pl, pc: int32): int =
  ## `(enum . (efld name . pragma . value)...)`.
  let kw = ps.tok(enumIdx)
  b.addTree "enum"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  b.addEmpty                                               # base type: always .
  # collect the field token span: remainder of this line + deeper-indent lines
  var lo = ps.lineEnd(enumIdx)
  # fields may also start on the enum line after the keyword — but the classic
  # form places them on following indented lines. Handle both.
  var startLo = enumIdx + 1
  if startLo < lo:
    lo = startLo   # fields present on the same line as `enum`
  var hi = lo
  while ps.tok(hi).kind != tkEof and
        (ps.tok(hi).indent > int32(defIndent) or ps.tok(hi).indent < 0):
    inc hi
  # enum fields separate on depth-0 commas AND on new physical lines (one field
  # per line with no trailing comma is common).
  var iLos: seq[int] = @[]
  var iHis: seq[int] = @[]
  if lo < hi:
    var curLo = lo
    var d = 0
    var k = lo
    while k < hi:
      let t = ps.tok(k)
      if isOpenBracket(t.kind): inc d
      elif isCloseBracket(t.kind):
        if d > 0: dec d
      elif d == 0 and t.kind == tkComma:
        iLos.add curLo; iHis.add k          # end before the comma
        curLo = k + 1
      elif d == 0 and k > curLo and t.indent >= 0 and ps.tok(k-1).kind != tkComma:
        iLos.add curLo; iHis.add k          # new physical line ends the field
        curLo = k
      inc k
    if curLo < hi:
      iLos.add curLo; iHis.add hi
  for ii in 0 ..< iLos.len:
    let iLo = iLos[ii]
    let iHi = iHis[ii]
    if iLo >= iHi: continue
    var j = iLo
    let nameTok = ps.tok(j)
    if nameTok.kind != tkIdent: continue
    inc j
    var pragLo = -1
    var pragHi = -1
    if j < iHi and ps.tok(j).kind == tkCurlyLe:
      pragLo = j
      pragHi = ps.matchClose(j)
      j = pragHi + 1
    var vLo = -1
    if j < iHi and ps.tok(j).kind == tkOperator and ps.tok(j).s == "=":
      vLo = j + 1
    # efld node position: the value token if present, else the name
    let nodeTok = if vLo >= 0: ps.tok(vLo) else: nameTok
    b.addTree "efld"
    ps.emitInfo(b, nodeTok.line, nodeTok.col, kw.line, kw.col, false)
    ps.emitName(b, nameTok, nodeTok.line, nodeTok.col)   # efld name, or `(quoted …)`
    b.addEmpty                                             # export: always .
    ps.emitPragmaSlot(b, pragLo, pragHi, nodeTok.line, nodeTok.col)
    b.addEmpty                                             # type: always .
    if vLo >= 0:
      ps.parseExprRange(b, int32(vLo), int32(iHi), nodeTok.line, nodeTok.col)
    else:
      b.addEmpty
    b.endTree()
  b.endTree()
  result = hi

proc parseConcept(ps: var Parser; b: var Builder; conceptIdx, defIndent: int;
                  pl, pc: int32): int =
  ## `concept x` [+ indented body] → `(concept (stmts <params>) . . <body>)`,
  ## where <body> is `(stmts …)` or `.` when empty.
  let kw = ps.tok(conceptIdx)
  b.addTree "concept"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  let hi = ps.lineEnd(conceptIdx)
  # params: whatever follows `concept` on its line → (stmts …)
  b.addTree "stmts"
  let pfirst = ps.tok(conceptIdx + 1)
  ps.emitInfo(b, pfirst.line, pfirst.col, kw.line, kw.col, false)
  var pi = conceptIdx + 1
  while pi < hi and ps.tok(pi).kind != tkEof:
    pi = ps.parseStmt(b, pi, pfirst.line, pfirst.col, hi)
  b.endTree()   # params
  b.addEmpty
  b.addEmpty
  # body: deeper-indented statements, else empty
  let bodyFirst = ps.tok(hi)
  if bodyFirst.kind != tkEof and bodyFirst.indent > int32(defIndent):
    b.addTree "stmts"
    ps.emitInfo(b, bodyFirst.line, bodyFirst.col, kw.line, kw.col, false)
    var i = hi
    let bodyRef = bodyFirst.indent - 1
    while ps.tok(i).kind != tkEof and ps.tok(i).indent > bodyRef:
      i = ps.parseStmt(b, i, bodyFirst.line, bodyFirst.col, -1)
    b.endTree()
    result = i
  else:
    b.addEmpty
    result = hi
  b.endTree()   # concept

proc parseTypeDef(ps: var Parser; b: var Builder; nameIdx, typeKwCol: int;
                  pl, pc: int32): int =
  ## Emit one `(type name export generics pragma rhs...)`. Returns index after
  ## the def (including any indented object/enum body).
  var i = nameIdx
  var nameTok = ps.tok(nameIdx)
  var hasExport = false
  var pragLo = -1
  var pragHi = -1
  ps.splitFieldName(i, ps.toks.len, nameTok, hasExport, pragLo, pragHi)
  # generics `[...]` between name and `=`
  var genIdx = -1
  if i < ps.toks.len and ps.tok(i).kind == tkBracketLe:
    genIdx = i
    i = ps.matchClose(i) + 1
  # the `=`
  var eqIdx = -1
  block:
    var k = i
    let le = ps.lineEnd(nameIdx)
    while k < le:
      if ps.tok(k).kind == tkOperator and ps.tok(k).s == "=":
        eqIdx = k; break
      inc k
  let eqTok = if eqIdx >= 0: ps.tok(eqIdx) else: nameTok
  b.addTree "type"
  ps.emitInfo(b, eqTok.line, eqTok.col, pl, pc, false)     # type node = '=' pos
  # name
  ps.emitName(b, nameTok, eqTok.line, eqTok.col)   # type name, or `(quoted …)`
  # export
  if hasExport: b.addRaw " x" else: b.addEmpty
  # generics
  if genIdx >= 0:
    discard ps.parseGenerics(b, genIdx, eqTok.line, eqTok.col)
  else:
    b.addEmpty
  # pragma
  ps.emitPragmaSlot(b, pragLo, pragHi, eqTok.line, eqTok.col)
  # rhs
  let defIndent = if nameTok.indent >= 0: int(nameTok.indent) else: typeKwCol
  var resultIdx = ps.lineEnd(nameIdx)
  if eqIdx >= 0:
    let rhsIdx = eqIdx + 1
    let r = ps.tok(rhsIdx)
    if r.kind == tkKeyword and r.s == "object":
      resultIdx = ps.parseObject(b, rhsIdx, defIndent, eqTok.line, eqTok.col)
    elif r.kind == tkKeyword and r.s == "enum":
      resultIdx = ps.parseEnum(b, rhsIdx, defIndent, eqTok.line, eqTok.col)
    elif r.kind == tkKeyword and r.s == "concept":
      resultIdx = ps.parseConcept(b, rhsIdx, defIndent, eqTok.line, eqTok.col)
    elif r.kind == tkKeyword and (r.s == "ref" or r.s == "ptr") and
         ps.tok(rhsIdx + 1).kind == tkKeyword and ps.tok(rhsIdx + 1).s == "object":
      b.addTree r.s
      ps.emitInfo(b, r.line, r.col, eqTok.line, eqTok.col, false)
      resultIdx = ps.parseObject(b, rhsIdx + 1, defIndent, r.line, r.col)
      b.endTree()
    else:
      let hi = ps.lineEnd(rhsIdx)   # section RHS spans the whole (balanced) line
      parseTypeRange(ps, b, int32(rhsIdx), int32(hi), eqTok.line, eqTok.col)
      resultIdx = hi
  else:
    b.addEmpty
  b.endTree()
  result = resultIdx

proc parseTypeSection(ps: var Parser; b: var Builder; kwIdx: int;
                      pl, pc: int32): int =
  ## `type` section — NO wrapper node; emit each `(type ...)` as a sibling.
  let kw = ps.tok(kwIdx)
  let typeKwCol = int(kw.col)
  var i = kwIdx + 1
  if ps.tok(i).kind != tkEof and ps.tok(i).line == kw.line:
    # single inline def: `type X = ...`
    result = ps.parseTypeDef(b, i, typeKwCol, pl, pc)
  else:
    # indented block of defs
    var j = i
    while ps.tok(j).kind != tkEof and ps.tok(j).indent > int32(typeKwCol):
      if ps.tok(j).kind == tkComment:     # doc comment between type defs: dropped
        inc j; continue
      j = ps.parseTypeDef(b, j, typeKwCol, pl, pc)
    result = j

# --- params & routines -------------------------------------------------------

proc parseParams(ps: var Parser; b: var Builder; lpIdx: int; pl, pc: int32): int =
  ## Emit `(params ...)` then the return type as a sibling. `lpIdx` is `(`.
  ## Returns index after the return type (or after `)` if none).
  let lp = ps.tok(lpIdx)
  let rpIdx = ps.matchClose(lpIdx)
  b.addTree "params"
  ps.emitInfo(b, lp.line, lp.col, pl, pc, false)           # params node = '(' pos
  var i = lpIdx + 1
  while i < rpIdx:
    # collect a group of names up to ':'
    var names: seq[Token] = @[]
    var exports: seq[bool] = @[]
    var firstPragLo = -1
    var firstPragHi = -1
    while i < rpIdx and (ps.tok(i).kind == tkIdent or ps.tok(i).kind == tkKeyword):
      var nm = ps.tok(i)
      var ex = false
      var pl2 = -1
      var ph2 = -1
      ps.splitFieldName(i, rpIdx, nm, ex, pl2, ph2)
      names.add nm
      exports.add ex
      if pl2 >= 0 and firstPragLo < 0:
        firstPragLo = pl2; firstPragHi = ph2
      if i < rpIdx and ps.tok(i).kind == tkComma: inc i
      else: break
    var tLo = -1
    var tHi = rpIdx
    var vLo = -1
    if i < rpIdx and ps.tok(i).kind == tkColon:
      inc i
      tLo = i
      tHi = ps.typeExprEnd(i)
      i = tHi
      # a trailing `{.pragma.}` on a proc/iterator param type (e.g.
      # `proc () {.nimcall.}`) is part of the type — fold it in so the `=`
      # default (if any) is seen next (otherwise the loop stalls forever).
      if i < rpIdx and ps.tok(i).kind == tkCurlyLe:
        i = ps.matchClose(i) + 1
        tHi = i
    if i < rpIdx and ps.tok(i).kind == tkOperator and ps.tok(i).s == "=":
      inc i
      vLo = i
      # value runs to the group separator
      var vd = 0
      while i < rpIdx:
        let k = ps.tok(i).kind
        if isOpenBracket(k): inc vd
        elif isCloseBracket(k):
          if vd > 0: dec vd
        elif vd == 0 and (k == tkComma or k == tkSemicolon): break
        inc i
    let vHi = i
    for ni in 0 ..< names.len:
      let nm = names[ni]
      b.addTree "param"
      ps.emitInfo(b, nm.line, nm.col, lp.line, lp.col, false)
      ps.emitName(b, nm, nm.line, nm.col)   # param name atom, or `(quoted …)`
      if exports[ni]: b.addRaw " x" else: b.addEmpty
      ps.emitPragmaSlot(b, firstPragLo, firstPragHi, nm.line, nm.col)
      if tLo >= 0:
        parseTypeRange(ps, b, int32(tLo), int32(tHi), nm.line, nm.col)
      else:
        b.addEmpty
      if vLo >= 0:
        ps.parseExprRange(b, int32(vLo), int32(vHi), nm.line, nm.col)
      else:
        b.addEmpty
      b.endTree()
    if i < rpIdx and (ps.tok(i).kind == tkComma or ps.tok(i).kind == tkSemicolon):
      inc i
  b.endTree()  # close params
  # return type sibling — introduced by `:` (proc/param types) or `->` (`do`
  # blocks, `sort do (a, b) -> int:`).
  var j = rpIdx + 1
  if ps.tok(j).kind == tkColon or
     (ps.tok(j).kind == tkOperator and ps.tok(j).s == "->"):
    inc j
    j = ps.parseType(b, j, lp.line, lp.col)                 # ret parent = params node
  else:
    b.addEmpty
  result = j

proc parseRoutine(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32;
                  tag: string): int =
  let kw = ps.tok(kwIdx)
  b.addTree tag
  var i = kwIdx + 1
  # name — absent for an anonymous routine (`proc (x): T = …`), where the next
  # token is directly the params `(`/generics `[`/pragma `{`/`=`.
  let name = ps.tok(i)
  let anon = name.kind == tkParLe or name.kind == tkBracketLe or
             name.kind == tkCurlyLe or (name.kind == tkOperator and name.s == "=")
  # An anonymous routine is an nkLambda whose info nifler takes from the token
  # AFTER `proc` (the params `(`/generics `[`/`=`), and it stamps that on the empty
  # NAME placeholder — not the proc node — with every child emitted relative to it.
  # A NAMED routine anchors at the keyword. `aTok` is that per-kind anchor.
  let aTok = if anon: name else: kw
  if anon:
    b.addEmpty
    ps.emitInfo(b, aTok.line, aTok.col, pl, pc, false)     # info on the empty name
  else:
    ps.emitInfo(b, aTok.line, aTok.col, pl, pc, false)     # routine node = keyword pos
    ps.emitName(b, name, aTok.line, aTok.col)
    inc i
  # export marker `*`
  if ps.tok(i).kind == tkOperator and ps.tok(i).s == "*":
    inc i
    b.addRaw " x"
  else:
    b.addEmpty
  b.addEmpty  # pattern
  # generics
  if ps.tok(i).kind == tkBracketLe:
    i = ps.parseGenerics(b, i, aTok.line, aTok.col)
  else:
    b.addEmpty
  # params + return type
  if ps.tok(i).kind == tkParLe:
    i = ps.parseParams(b, i, aTok.line, aTok.col)
  else:
    # no param parens (`proc main =`, `proc main: int =`): nifler still emits an
    # empty `(params)` node (positioned where the params would begin), then the
    # return type sibling if a `:` follows.
    let at = ps.tok(i)
    b.addTree "params"
    ps.emitInfo(b, at.line, at.col, aTok.line, aTok.col, false)
    b.endTree()
    if ps.tok(i).kind == tkColon:
      inc i
      i = ps.parseType(b, i, at.line, at.col)                 # ret parent = params pos
    else:
      b.addEmpty  # return type slot
  # pragmas: `{.` … `.}`. In curly mode a bare `{` (no leading dot) is a block
  # BODY, not pragmas — leave it for the body handler below.
  if ps.tok(i).kind == tkCurlyLe and
     (not ps.curly or ps.tok(i + 1).kind == tkDot):
    i = ps.parsePragmas(b, i, aTok.line, aTok.col)
  else:
    b.addEmpty
  b.addEmpty  # reserved / misc
  # body: `= …` (`:`/indent style) or, in curly mode, `{ … }`. A curly body is a
  # bare `{` (not a `{.` pragma) with NO preceding `=`, so `proc f(): set = {}`
  # keeps its set-literal expression body.
  if ps.curly and ps.tok(i).kind == tkCurlyLe and ps.tok(i + 1).kind != tkDot:
    # curly-block body: `proc f() { stmt; stmt }`. Delimited by the matching `}`;
    # statements inside are `;`- or newline-separated (parseStmt chains `;`).
    let rb = ps.matchClose(i)
    let first = ps.tok(i + 1)
    b.addTree "stmts"
    ps.emitInfo(b, first.line, first.col, aTok.line, aTok.col, false)
    var j = i + 1
    while j < rb and ps.tok(j).kind != tkEof:
      if ps.tok(j).kind == tkComment: inc j; continue
      j = ps.parseStmt(b, j, first.line, first.col, rb)
    b.endTree()
    i = rb + 1
  elif ps.tok(i).kind == tkOperator and ps.tok(i).s == "=":
    inc i
    let refIndent = kw.col
    let first = ps.tok(i)
    if first.kind == tkEof:
      b.addEmpty
    elif first.indent < 0:
      # one-line body on the same line as `=`, e.g. `proc f() = echo 1`
      b.addTree "stmts"
      ps.emitInfo(b, first.line, first.col, aTok.line, aTok.col, false)
      let hi = ps.lineEnd(i)
      while i < hi and ps.tok(i).kind != tkEof:
        i = ps.parseStmt(b, i, first.line, first.col, -1)
      b.endTree()
    elif first.indent > refIndent:
      b.addTree "stmts"
      ps.emitInfo(b, first.line, first.col, aTok.line, aTok.col, false)
      while ps.tok(i).kind != tkEof and ps.tok(i).indent > refIndent:
        i = ps.parseStmt(b, i, first.line, first.col, -1)
        i = ps.skipTrailingDoc(i, first.indent)   # drop each stmt's trailing `##` doc
      b.endTree()
    else:
      b.addEmpty
  else:
    b.addEmpty
  b.endTree()
  result = i
