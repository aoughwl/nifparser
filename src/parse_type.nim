## parse_type.nim — TYPE DEFS, ROUTINE DEFS, PARAMS, GENERICS, PRAGMAS
## (owned by the type/proc/pragma agent).
##
## Spliced after parse_expr.nim, before parse_stmt.nim. `parseType` /
## `parseTypeSection` are the cross-file entries (forward-declared in
## parsecore.nim); routine bodies call `parseStmt` (forward-declared in
## parsecore.nim, implemented in parse_stmt.nim).
##
## Emits NIF matching classic nifler byte-for-byte on supported constructs;
## structural (line-info-stripped) equality is the pass criterion. See
## nifler-nif-spec.md §5–7.

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
  if s == "var": "mut"
  elif s == "out": "out"
  else: s

proc typeExprEnd(ps: var Parser; lo: int): int =
  ## End (exclusive) of an inline type expression starting at `lo`. Stops at a
  ## depth-0 `,` `;` `:` `)` `]` `}` `{` (pragma) or `=`, or a new logical line.
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
    elif depth == 0:
      if t.kind == tkComma or t.kind == tkSemicolon or t.kind == tkColon:
        break
      elif t.kind == tkOperator and t.s == "=":
        break
      elif t.line != startLine and t.indent >= 0:
        break
    inc i
  result = i

# --- type expressions --------------------------------------------------------

proc parseTypeRange(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
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
  # command in type position: `lent string`, `sink T`, `owned Foo` → `(cmd lent string)`
  block:
    let ce = ps.cmdCalleeEnd(int(lo), int(hi))
    if ps.tok(int(lo)).kind == tkIdent and ce < int(hi) and ps.startsArg(ce, int(hi)):
      let callee = ps.tok(int(lo))
      b.addTree "cmd"
      ps.emitInfo(b, callee.line, callee.col, pl, pc, false)
      parseTypeRange(ps, b, lo, int32(ce), callee.line, callee.col)
      let starts = ps.splitArgs(ce, int(hi))
      for ai in 0 ..< starts.len:
        let aLo = starts[ai]
        let aHi = if ai + 1 < starts.len: starts[ai+1] - 1 else: int(hi)
        if aLo < aHi:
          parseTypeRange(ps, b, int32(aLo), int32(aHi), callee.line, callee.col)
      b.endTree()
      return
  # atom (single ident/keyword type name)
  let t = ps.tok(int(lo))
  b.addIdent t.s
  ps.emitInfo(b, t.line, t.col, pl, pc, false)

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
        # type runs to the next depth-0 comma (= group boundary) or `]`
        var d = 0
        var k = tLo
        while k < rb:
          let kk = ps.tok(k)
          if isOpenBracket(kk.kind): inc d
          elif isCloseBracket(kk.kind):
            if d > 0: dec d
          elif d == 0 and kk.kind == tkComma: break
          inc k
        tHi = k
        i = k
      if i < rb and ps.tok(i).kind == tkComma: inc i
      for nm in names:
        b.addTree "kv"
        ps.emitInfo(b, nm.line, nm.col, kw.line, kw.col, false)
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
    b.addIdent nm.s
    ps.emitInfo(b, nm.line, nm.col, nm.line, nm.col, false)
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
  # split groups on ';'
  var gstart = lbIdx + 1
  var i = lbIdx + 1
  var depth = 0
  while i < rb:
    let k = ps.tok(i).kind
    if isOpenBracket(k): inc depth
    elif isCloseBracket(k):
      if depth > 0: dec depth
    elif depth == 0 and ps.tok(i).kind == tkSemicolon:
      ps.emitTypevarGroup(b, gstart, i, lb.line, lb.col)
      gstart = i + 1
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
    b.addTree "fld"
    ps.emitInfo(b, nm.line, nm.col, kl, kc, false)
    b.addIdent nm.s
    ps.emitInfo(b, nm.line, nm.col, nm.line, nm.col, false)
    if exports[ni]: b.addRaw " x" else: b.addEmpty
    ps.emitPragmaSlot(b, firstPragLo, firstPragHi, nm.line, nm.col)
    if tLo >= 0:
      parseTypeRange(ps, b, int32(tLo), int32(tHi), nm.line, nm.col)
    else:
      b.addEmpty
    if vLo >= 0:
      ps.parseExprRange(b, int32(vLo), int32(lineHi), nm.line, nm.col)
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
    b.addIdent nameTok.s
    ps.emitInfo(b, nameTok.line, nameTok.col, nodeTok.line, nodeTok.col, false)
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
  b.addIdent nameTok.s
  ps.emitInfo(b, nameTok.line, nameTok.col, eqTok.line, eqTok.col, false)
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
      b.addIdent nm.s
      ps.emitInfo(b, nm.line, nm.col, nm.line, nm.col, false)
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
  # return type sibling
  var j = rpIdx + 1
  if ps.tok(j).kind == tkColon:
    inc j
    j = ps.parseType(b, j, lp.line, lp.col)                 # ret parent = params node
  else:
    b.addEmpty
  result = j

proc parseRoutine(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32;
                  tag: string): int =
  let kw = ps.tok(kwIdx)
  b.addTree tag
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)           # routine node = keyword pos
  var i = kwIdx + 1
  # name — absent for an anonymous routine (`proc (x): T = …`), where the next
  # token is directly the params `(`/generics `[`/pragma `{`/`=`.
  let name = ps.tok(i)
  if name.kind == tkParLe or name.kind == tkBracketLe or name.kind == tkCurlyLe or
     (name.kind == tkOperator and name.s == "="):
    b.addEmpty
  else:
    ps.emitName(b, name, kw.line, kw.col)
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
    i = ps.parseGenerics(b, i, kw.line, kw.col)
  else:
    b.addEmpty
  # params + return type
  if ps.tok(i).kind == tkParLe:
    i = ps.parseParams(b, i, kw.line, kw.col)
  else:
    b.addEmpty  # params slot
    b.addEmpty  # return type slot
  # pragmas
  if ps.tok(i).kind == tkCurlyLe:
    i = ps.parsePragmas(b, i, kw.line, kw.col)
  else:
    b.addEmpty
  b.addEmpty  # reserved / misc
  # body after `=`
  if ps.tok(i).kind == tkOperator and ps.tok(i).s == "=":
    inc i
    let refIndent = kw.col
    let first = ps.tok(i)
    if first.kind == tkEof:
      b.addEmpty
    elif first.indent < 0:
      # one-line body on the same line as `=`, e.g. `proc f() = echo 1`
      b.addTree "stmts"
      ps.emitInfo(b, first.line, first.col, kw.line, kw.col, false)
      let hi = ps.lineEnd(i)
      while i < hi and ps.tok(i).kind != tkEof:
        i = ps.parseStmt(b, i, first.line, first.col, -1)
      b.endTree()
    elif first.indent > refIndent:
      b.addTree "stmts"
      ps.emitInfo(b, first.line, first.col, kw.line, kw.col, false)
      while ps.tok(i).kind != tkEof and ps.tok(i).indent > refIndent:
        i = ps.parseStmt(b, i, first.line, first.col, -1)
      b.endTree()
    else:
      b.addEmpty
  else:
    b.addEmpty
  b.endTree()
  result = i
