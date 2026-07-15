## parse_stmt.nim — STATEMENTS, CONTROL FLOW, var/let/const SECTIONS.
##
## Spliced LAST (after parse_expr.nim and parse_type.nim), so it can call
## `parseExprRange`, `parseType`, `parseRoutine` directly. `parseStmt` is the
## dispatch entry (forward-declared in parsecore.nim) — routine bodies and the
## module loop re-enter through it.
##
## Covers: expr/command/assignment statements; return-like (ret/discard/raise/
## yld) and import-like forms; the control-flow keywords `if`/`elif`/`else`,
## `case`+`(of (ranges …) …)`, `while`, `for`+`(unpackflat …)` / `(unpacktup …)`,
## `try`/`except`/`fin`, `when`, `block`/`break`/`continue`, `defer`, `static`;
## and var/let/const SECTIONS, which emit NO wrapper node — each ident-def is its
## own sibling with the type & value DUPLICATED across a multi-name group
## (`(var name . pragma type value)`), plus the var-tuple form
## `(unpackdecl value (unpacktup (let …)…))`. Indentation-delimited blocks
## threshold on `ps.tok(i).indent` (see `emitBody`).

proc parseCommand(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  # STATEMENT-context command (`parseExprStmt` → `newTree(nkCommand, a.info, a)`):
  # nkCommand.info = the CALLEE expression's info. For a dotted callee `a.b` that
  # is the `.` position, not the head ident — so anchor at the callee's emitted
  # node, not `tok(lo)`. (Expr-context commands anchor at the first arg instead.)
  let ce = ps.cmdCalleeEnd(int(lo), int(hi))   # end of the callee primary
  let anchor = ps.calleeAnchor(int(lo), ce)
  b.addTree "cmd"
  ps.emitInfo(b, anchor.line, anchor.col, pl, pc, false)   # cmd node info = callee pos
  ps.parseExprRange(b, lo, int32(ce), anchor.line, anchor.col)   # callee (may be dotted)
  ps.parseArgList(b, int32(ce), hi, anchor.line, anchor.col)
  b.endTree()

proc parseExprStmt(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32): int =
  ## Returns the consumed index (may extend past `hi` for a multi-line
  ## control-flow assignment RHS, e.g. `x = if c:` with body on later lines).
  result = int(hi)
  # A command call: bare-ident callee, then a space-separated argument that
  # begins a new expression and is NOT a binary operator (`a and b`). Operators
  # *inside* the argument are fine (`assert x == y`). Checked BEFORE assignment
  # so a named-arg `=` in a command (`f a, k = v`) is not read as an `asgn`.
  let head = ps.tok(int(lo))
  let ce = ps.cmdCalleeEnd(int(lo), int(hi))   # end of callee primary
  # A command callee is a bare ident, or the `addr` keyword in its space form
  # (`addr x`; `addr(x)` is a call, and cmdCalleeEnd already folds the adjacent
  # paren into the callee so `ce == hi` there). Routing a keyword command through
  # parseCommand — not parseCmdKw — gives it the STATEMENT-context callee anchor
  # (nifler's `newTree(nkCommand, a.info)`), not the expr-context first-arg anchor.
  let calleeOk = head.kind == tkIdent or
                 (head.kind == tkKeyword and head.s == "addr")
  let isCmd = calleeOk and ce < int(hi) and ps.startsArg(ce, int(hi))
  if isCmd:
    ps.parseCommand(b, lo, hi, pl, pc)
    return
  let eqi = ps.findAssign(int(lo), int(hi))
  if eqi >= 0:
    let op = ps.tok(eqi)
    b.addTree "asgn"
    ps.emitInfo(b, op.line, op.col, pl, pc, false)
    ps.parseExprRange(b, lo, int32(eqi), op.line, op.col)
    let rt = ps.tok(eqi + 1)
    # multi-line control-flow RHS (`= if c:` / `= try:` with body on later lines)
    if rt.kind == tkKeyword and
       (rt.s == "if" or rt.s == "when" or rt.s == "try" or
        rt.s == "case" or rt.s == "block"):
      result = ps.parseCtrlFlowValue(b, eqi + 1, op.line, op.col)
    else:
      ps.parseExprRange(b, int32(eqi) + 1, hi, op.line, op.col)
    b.endTree()
    return
  ps.parseExprRange(b, lo, hi, pl, pc)

proc parseReturnLike(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32;
                     tag: string): int =
  let kw = ps.tok(kwIdx)
  let hi = ps.semiEnd(kwIdx, ps.lineEnd(kwIdx))
  b.addTree tag
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  if kwIdx + 1 < hi and startsExpr(ps.tok(kwIdx+1)):
    ps.parseExprRange(b, int32(kwIdx) + 1, int32(hi), kw.line, kw.col)
  else:
    b.addEmpty
  b.endTree()
  result = hi

proc parseImportLike(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32;
                     tag: string): int =
  let kw = ps.tok(kwIdx)
  let hi = ps.semiEnd(kwIdx, ps.lineEnd(kwIdx))
  # `import M except a, b` → `(importexcept M a b)`: a depth-0 `except` after the
  # module turns the section into an exclusion list (mirrors the classic parser's
  # import→importexcept transition). The module before `except` is one expr.
  if (tag == "import" or tag == "export"):
    var d = 0
    var exceptIdx = -1
    var j = kwIdx + 1
    while j < hi:
      let t = ps.tok(j)
      if isOpenBracket(t.kind): inc d
      elif isCloseBracket(t.kind):
        if d > 0: dec d
      elif d == 0 and t.kind == tkKeyword and t.s == "except":
        exceptIdx = j; break
      inc j
    if exceptIdx >= 0:
      b.addTree(if tag == "import": "importexcept" else: "exportexcept")
      ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
      if kwIdx + 1 < exceptIdx:
        ps.parseExprRange(b, int32(kwIdx + 1), int32(exceptIdx), kw.line, kw.col)
      let estarts = ps.splitArgs(exceptIdx + 1, hi)
      for ai in 0 ..< estarts.len:
        let aLo = estarts[ai]
        let aHi = if ai + 1 < estarts.len: estarts[ai+1] - 1 else: hi
        if aLo < aHi:
          ps.parseExprRange(b, int32(aLo), int32(aHi), kw.line, kw.col)
      b.endTree()
      return hi
  b.addTree tag
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  let starts = ps.splitArgs(kwIdx + 1, hi)
  for ai in 0 ..< starts.len:
    let aLo = starts[ai]
    let aHi = if ai + 1 < starts.len: starts[ai+1] - 1 else: hi
    if aLo < aHi:
      ps.parseExprRange(b, int32(aLo), int32(aHi), kw.line, kw.col)
  b.endTree()
  result = hi

# ---------------------------------------------------------------------------
# control-flow helpers
# ---------------------------------------------------------------------------

proc isOperandEnd(k: TokKind): bool =
  ## A token that can END an expression (so a following `{` opens a block body,
  ## not a set literal). Used only for the experimental curly-block mode.
  k == tkIdent or k == tkParRi or k == tkBracketRi or k == tkCurlyRi or
  k == tkStrLit or k == tkRStrLit or k == tkTripleStrLit or
  k == tkIntLit or k == tkFloatLit or k == tkCharLit

proc skipTrailingDoc(ps: Parser; i, refIndent: int): int =
  ## Drop a trailing doc comment: a `##` line indented DEEPER than `refIndent`
  ## (the enclosing statement list's indent) documents the preceding declaration.
  ## nifler attaches it to that node (`indAndComment`) and, without `--docs`, does
  ## not emit it. A comment AT `refIndent` is a standalone `(comment)` statement
  ## and is kept by the caller's normal statement dispatch.
  result = i
  while ps.tok(result).kind == tkComment and ps.tok(result).indent > refIndent:
    inc result

proc findColon(ps: Parser; lo, hi: int): int =
  ## Body introducer in `[lo, hi)`: a depth-0 `:`. In curly mode, also a depth-0
  ## `{ … }` block — the first `{` (not a `{.` pragma) that follows an operand,
  ## so a set literal in the head (`if {1} == x { … }`) is not mistaken for it.
  ## `:` always wins if present. Returns the `:`/`{` index, or -1.
  var depth = 0
  var i = lo
  var brace = -1
  while i < hi:
    let t = ps.tok(i)
    if depth == 0 and t.kind == tkColon:
      return i
    if depth == 0 and ps.curly and brace < 0 and t.kind == tkCurlyLe and
       ps.tok(i + 1).kind != tkDot and i > lo:
      let prev = ps.tok(i - 1)
      # a block `{` follows an operand (`if c {`) or a bodiless-block keyword
      # (`else {`, `try {`, `block {`, `finally {`, `defer {`).
      if isOperandEnd(prev.kind) or
         (prev.kind == tkKeyword and (prev.s == "else" or prev.s == "try" or
          prev.s == "block" or prev.s == "finally" or prev.s == "defer")):
        brace = i
    if isOpenBracket(t.kind): inc depth
    elif isCloseBracket(t.kind):
      if depth > 0: dec depth
    inc i
  result = brace

proc emitBody(ps: var Parser; b: var Builder; colonIdx: int; refIndent: int32;
              pl, pc: int32): int =
  ## Emit a `(stmts …)` body after a `:`. Handles both the one-line form
  ## (`if c: stmt`) and the indented block (mirrors parseRoutine's body loop).
  ## `pl,pc` = the controlling branch node position (parent of the stmts node).
  if colonIdx < 0:
    # No body-introducing `:` found (should not happen now that lineEnd handles
    # continuations). Emit an empty body and do NOT restart at token 0.
    b.addTree "stmts"; b.addEmpty; b.endTree()
    return colonIdx     # caller advances past this construct via its own lineEnd
  if ps.tok(colonIdx).kind == tkCurlyLe:
    # curly-block body: `… { stmt; stmt }`. Delimited by the matching `}`;
    # statements inside are `;`- or newline-separated (parseStmt chains `;`).
    let rb = ps.matchClose(colonIdx)
    let first = ps.tok(colonIdx + 1)
    b.addTree "stmts"
    ps.emitInfo(b, first.line, first.col, pl, pc, false)
    var j = colonIdx + 1
    while j < rb and ps.tok(j).kind != tkEof:
      if ps.tok(j).kind == tkComment: inc j; continue
      j = ps.parseStmt(b, j, first.line, first.col, rb)
    b.endTree()
    return rb + 1
  let bodyStart = colonIdx + 1
  let first = ps.tok(bodyStart)
  b.addTree "stmts"
  ps.emitInfo(b, first.line, first.col, pl, pc, false)   # stmts info = first body stmt
  var i = bodyStart
  if first.kind == tkEof:
    discard
  elif first.indent < 0:
    # one-liner: statements on the same logical line, but STOP at a same-line
    # branch keyword (`if c: a else: b`, `case`/`try`/… one-liners) so the next
    # branch is not swallowed into this body.
    var hi = ps.lineEnd(bodyStart)
    block:
      var d = 0
      var k = bodyStart
      while k < hi:
        let kk = ps.tok(k)
        if isOpenBracket(kk.kind): inc d
        elif isCloseBracket(kk.kind):
          if d > 0: dec d
        elif d == 0 and kk.kind == tkKeyword and
             (kk.s == "elif" or kk.s == "else" or kk.s == "of" or
              kk.s == "except" or kk.s == "finally"):
          hi = k; break
        inc k
    while i < hi and ps.tok(i).kind != tkEof:
      i = ps.parseStmt(b, i, first.line, first.col, hi)
  else:
    # indented block: statements at the body's own indentation (`first.indent`)
    # or deeper. Thresholding on the body indent — not the caller's `refIndent`
    # (the keyword column) — makes value-context bodies work too, e.g. the body
    # of `let x = try:` sits mid-line so its keyword column is not its indent.
    let bodyRef = first.indent - 1
    while ps.tok(i).kind != tkEof and ps.tok(i).indent > bodyRef:
      # An inline branch keyword (`else`/`elif`/…) can follow the body on its own
      # line: `if c:\n  callBody() else: x`. Bound this statement at that keyword
      # so it is not swallowed as a command arg — the caller picks up the branch.
      var stmtHi = -1
      block:
        var d = 0
        var k = i
        var sawCf = false   # a depth-0 if/when/case/try owns any following else/elif/of
        let lend = ps.lineEnd(i)
        while k < lend:
          let kk = ps.tok(k)
          if isOpenBracket(kk.kind): inc d
          elif isCloseBracket(kk.kind):
            if d > 0: dec d
          elif d == 0 and kk.kind == tkKeyword and
               (kk.s == "if" or kk.s == "when" or kk.s == "case" or kk.s == "try"):
            sawCf = true
          elif d == 0 and k > i and not sawCf and kk.kind == tkKeyword and
               kk.indent < 0 and
               (kk.s == "elif" or kk.s == "else" or kk.s == "of" or
                kk.s == "except" or kk.s == "finally"):
            # a branch keyword that belongs to the ENCLOSING control flow
            # (`if c:\n  body() else: x`), not to an if/case EXPRESSION in this
            # statement's own args (`f(if c: a else: b)`).
            stmtHi = k; break
          inc k
      i = ps.parseStmt(b, i, first.line, first.col, int32(stmtHi))
      i = ps.skipTrailingDoc(i, first.indent)   # drop the stmt's trailing `##` doc
  b.endTree()
  result = i

proc parseIfLike(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32;
                 tag: string): int =
  ## `if`/`elif`/`else` → `(if (elif cond body) (else body))`; also `when`.
  let kw = ps.tok(kwIdx)
  let refIndent = kw.col
  let lineIndent = ps.lineIndentOf(kwIdx)     # enclosing-statement indent
  # body indent of the first branch (for value-context elif/else alignment)
  let firstColon = ps.findColon(kwIdx, ps.lineEnd(kwIdx))
  let bodyIndent = if firstColon >= 0 and ps.tok(firstColon + 1).indent >= 0:
                     ps.tok(firstColon + 1).indent else: int32(100000)
  b.addTree tag
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)   # if node = keyword pos
  var i = kwIdx
  while true:
    let branch = ps.tok(i)
    let isElif = branch.kind == tkKeyword and (branch.s == tag or branch.s == "elif")
    if isElif:
      let hi = ps.lineEnd(i)
      let colon = ps.findColon(i, hi)
      let condTok = ps.tok(i + 1)
      b.addTree "elif"
      ps.emitInfo(b, condTok.line, condTok.col, kw.line, kw.col, false)  # elif = cond pos
      ps.parseExprRange(b, int32(i + 1), int32(colon), condTok.line, condTok.col)
      i = ps.emitBody(b, colon, refIndent, condTok.line, condTok.col)
      b.endTree()
    elif branch.kind == tkKeyword and branch.s == "else":
      let hi = ps.lineEnd(i)
      let colon = ps.findColon(i, hi)
      b.addTree "else"
      ps.emitInfo(b, branch.line, branch.col, kw.line, kw.col, false)   # else = keyword pos
      i = ps.emitBody(b, colon, refIndent, branch.line, branch.col)
      b.endTree()
      break
    else:
      break
    let nxt = ps.tok(i)
    # continue to `elif`/`else` aligned with the `if` (multi-line) OR on the
    # same physical line (`indent < 0`, one-liner `if c: a else: b`).
    if nxt.kind == tkKeyword and (nxt.s == "elif" or nxt.s == "else") and
       (nxt.indent < 0 or
        (nxt.indent >= lineIndent and nxt.indent < bodyIndent)):
      continue
    else:
      break
  b.endTree()
  result = i

proc parseWhile(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int =
  let kw = ps.tok(kwIdx)
  let refIndent = kw.col
  let hi = ps.lineEnd(kwIdx)
  let colon = ps.findColon(kwIdx, hi)
  b.addTree "while"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  ps.parseExprRange(b, int32(kwIdx + 1), int32(colon), kw.line, kw.col)  # cond parent = while
  result = ps.emitBody(b, colon, refIndent, kw.line, kw.col)
  b.endTree()

proc parseCase(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int =
  let kw = ps.tok(kwIdx)
  let refIndent = kw.col
  let selHi = ps.lineEnd(kwIdx)
  b.addTree "case"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  let selColon = ps.findColon(kwIdx, selHi)
  let selEnd = if selColon >= 0: selColon else: selHi
  ps.parseExprRange(b, int32(kwIdx + 1), int32(selEnd), kw.line, kw.col)  # selector parent = case
  var i = selHi
  # branches align with the FIRST `of` (its own indent), which need not equal the
  # `case` keyword column (value-context `let x = case k:` sits mid-line).
  let ofIndent = ps.tok(selHi).indent
  while ps.tok(i).kind == tkKeyword and
        (ps.tok(i).indent == ofIndent or ps.tok(i).indent < 0) and
        (ps.tok(i).s == "of" or ps.tok(i).s == "else" or ps.tok(i).s == "elif"):
    let br = ps.tok(i)
    let bhi = ps.lineEnd(i)
    let bcolon = ps.findColon(i, bhi)
    if br.s == "of":
      b.addTree "of"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      b.addTree "ranges"   # ranges carries NO line-info
      let starts = ps.splitArgs(i + 1, bcolon)
      for ai in 0 ..< starts.len:
        let aLo = starts[ai]
        let aHi = if ai + 1 < starts.len: starts[ai+1] - 1 else: bcolon
        if aLo < aHi:
          ps.parseExprRange(b, int32(aLo), int32(aHi), br.line, br.col)  # value parent = of
      b.endTree()  # ranges
      i = ps.emitBody(b, bcolon, refIndent, br.line, br.col)
      b.endTree()  # of
    else:
      b.addTree "else"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      i = ps.emitBody(b, bcolon, refIndent, br.line, br.col)
      b.endTree()
  b.endTree()  # case
  result = i

proc parseFor(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int =
  let kw = ps.tok(kwIdx)
  let refIndent = kw.col
  let hi = ps.lineEnd(kwIdx)
  let colon = ps.findColon(kwIdx, hi)
  # locate the depth-0 `in` keyword separating loop vars from the iterator
  var inIdx = -1
  block findIn:
    var depth = 0
    var j = kwIdx + 1
    while j < colon:
      let t = ps.tok(j)
      if isOpenBracket(t.kind): inc depth
      elif isCloseBracket(t.kind):
        if depth > 0: dec depth
      elif depth == 0 and t.kind == tkKeyword and t.s == "in":
        inIdx = j
        break findIn
      inc j
  let firstVar = ps.tok(kwIdx + 1)          # for node info = first loop var position
  b.addTree "for"
  ps.emitInfo(b, firstVar.line, firstVar.col, pl, pc, false)
  # iterator FIRST (parent = for node)
  ps.parseExprRange(b, int32(inIdx + 1), int32(colon), firstVar.line, firstVar.col)
  if firstVar.kind == tkParLe:
    # tuple unpacking: `(a, b)` → (unpacktup (let a . . . .) …)  (addEmpty 4)
    let rp = ps.matchClose(kwIdx + 1)
    b.addTree "unpacktup"
    let starts = ps.splitArgs(kwIdx + 2, rp)
    for ai in 0 ..< starts.len:
      let v = ps.tok(starts[ai])
      b.addTree "let"
      ps.emitName(b, v, firstVar.line, firstVar.col)   # loop var, or `(quoted …)`
      b.addEmpty 4   # export, pragma, type, value
      b.endTree()
    b.endTree()
  else:
    # flat: one `(let name . . . .)` per loop var, but a loop var that is itself a
    # `(a, b)` tuple becomes a nested `(unpacktup (let a …) …)` — e.g. the mixed
    # `for i, (a, b) in pairs`.
    b.addTree "unpackflat"
    let starts = ps.splitArgs(kwIdx + 1, inIdx)
    for ai in 0 ..< starts.len:
      let v = ps.tok(starts[ai])
      if v.kind == tkParLe:
        let rp = ps.matchClose(starts[ai])
        b.addTree "unpacktup"
        let inner = ps.splitArgs(starts[ai] + 1, rp)
        for bi in 0 ..< inner.len:
          let iv = ps.tok(inner[bi])
          b.addTree "let"
          ps.emitName(b, iv, firstVar.line, firstVar.col)
          b.addEmpty 4   # export, pragma, type, value
          b.endTree()
        b.endTree()
      else:
        b.addTree "let"
        ps.emitName(b, v, firstVar.line, firstVar.col)   # loop var, or `(quoted …)`
        b.addEmpty      # export marker
        b.addEmpty      # pragma
        b.addEmpty 2    # type, value
        b.endTree()
    b.endTree()
  # body LAST (parent = for node)
  result = ps.emitBody(b, colon, refIndent, firstVar.line, firstVar.col)
  b.endTree()

proc parseTryExpr(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## `try: X except: Y` in EXPRESSION position: bodies are bare expressions,
  ## not `(stmts …)` (that shape is only for statement-position try).
  let kw = ps.tok(int(lo))
  b.addTree "try"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  # depth-0 `except`/`finally` branch keyword positions in (lo, hi)
  var branches: seq[int] = @[]
  block:
    var d = 0
    var i = int(lo) + 1
    while i < int(hi):
      let t = ps.tok(i)
      if isOpenBracket(t.kind): inc d
      elif isCloseBracket(t.kind):
        if d > 0: dec d
      elif d == 0 and t.kind == tkKeyword and (t.s == "except" or t.s == "finally"):
        branches.add i
      inc i
  let firstBranch = if branches.len > 0: branches[0] else: int(hi)
  let colon = ps.findColon(int(lo), firstBranch)
  if colon >= 0 and colon + 1 < firstBranch:
    ps.parseExprRange(b, int32(colon + 1), int32(firstBranch), kw.line, kw.col)
  else:
    b.addEmpty
  for bi in 0 ..< branches.len:
    let bp = branches[bi]
    let br = ps.tok(bp)
    let bEnd = if bi + 1 < branches.len: branches[bi+1] else: int(hi)
    let bcolon = ps.findColon(bp, bEnd)
    if br.s == "except":
      b.addTree "except"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      if bcolon > bp + 1:
        ps.parseExprRange(b, int32(bp + 1), int32(bcolon), br.line, br.col)  # exc type
      else:
        b.addEmpty
      if bcolon >= 0 and bcolon + 1 < bEnd:
        ps.parseExprRange(b, int32(bcolon + 1), int32(bEnd), br.line, br.col)
      else:
        b.addEmpty
      b.endTree()
    else:
      b.addTree "fin"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      if bcolon >= 0 and bcolon + 1 < bEnd:
        ps.parseExprRange(b, int32(bcolon + 1), int32(bEnd), br.line, br.col)
      else:
        b.addEmpty
      b.endTree()
  b.endTree()

proc parseTry(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int =
  let kw = ps.tok(kwIdx)
  let refIndent = kw.col
  # `except`/`finally` align with the try's LINE (its enclosing statement), which
  # differs from the keyword column for a value-context try (`let x = try:`).
  let lineIndent = ps.lineIndentOf(kwIdx)
  b.addTree "try"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  let hi = ps.lineEnd(kwIdx)
  let colon = ps.findColon(kwIdx, hi)
  let bodyIndent = if colon >= 0 and ps.tok(colon + 1).indent >= 0:
                     ps.tok(colon + 1).indent else: int32(100000)
  var i = ps.emitBody(b, colon, refIndent, kw.line, kw.col)   # try body, parent = try node
  while ps.tok(i).kind == tkKeyword and
        (ps.tok(i).indent < 0 or
         (ps.tok(i).indent >= lineIndent and ps.tok(i).indent < bodyIndent)) and
        (ps.tok(i).s == "except" or ps.tok(i).s == "finally"):
    let br = ps.tok(i)
    let bhi = ps.lineEnd(i)
    let bcolon = ps.findColon(i, bhi)
    if br.s == "except":
      b.addTree "except"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      if i + 1 < bcolon:
        # `except A, B:` lists each exception type as its own child.
        let ecStarts = ps.splitArgs(i + 1, bcolon)
        for ei in 0 ..< ecStarts.len:
          let aLo = ecStarts[ei]
          let aHi = if ei + 1 < ecStarts.len: ecStarts[ei+1] - 1 else: bcolon
          if aLo < aHi:
            ps.parseExprRange(b, int32(aLo), int32(aHi), br.line, br.col)
      else:
        b.addEmpty   # bare `except:` → `.`
      i = ps.emitBody(b, bcolon, refIndent, br.line, br.col)
      b.endTree()
    else:
      b.addTree "fin"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      i = ps.emitBody(b, bcolon, refIndent, br.line, br.col)
      b.endTree()
  b.endTree()  # try
  result = i

proc parseBlock(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int =
  let kw = ps.tok(kwIdx)
  let refIndent = kw.col
  b.addTree "block"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  let hi = ps.lineEnd(kwIdx)
  let colon = ps.findColon(kwIdx, hi)
  if kwIdx + 1 < colon and ps.tok(kwIdx + 1).kind == tkIdent:
    let lbl = ps.tok(kwIdx + 1)
    ps.emitName(b, lbl, kw.line, kw.col)   # block label, or `(quoted …)`
  else:
    b.addEmpty
  result = ps.emitBody(b, colon, refIndent, kw.line, kw.col)
  b.endTree()

proc parseBreakLike(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32;
                    tag: string): int =
  ## `break`/`continue` → `(break <label-or-.>)`.
  let kw = ps.tok(kwIdx)
  let hi = ps.lineEnd(kwIdx)
  b.addTree tag
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  if kwIdx + 1 < hi and ps.tok(kwIdx + 1).kind == tkIdent:
    let lbl = ps.tok(kwIdx + 1)
    ps.emitName(b, lbl, kw.line, kw.col)   # break/continue label, or `(quoted …)`
  else:
    b.addEmpty
  b.endTree()
  result = hi

proc parseDefer(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int =
  let kw = ps.tok(kwIdx)
  let refIndent = kw.col
  b.addTree "defer"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  let hi = ps.lineEnd(kwIdx)
  let colon = ps.findColon(kwIdx, hi)
  result = ps.emitBody(b, colon, refIndent, kw.line, kw.col)
  b.endTree()

# ---------------------------------------------------------------------------
# var / let / const sections (NO wrapper node — each def is a sibling)
# ---------------------------------------------------------------------------

proc parseCtrlFlowValue(ps: var Parser; b: var Builder; kwIdx: int;
                        pl, pc: int32): int =
  ## A control-flow expression used as a value that spans multiple lines
  ## (`= try:` / `= if c:` with the body on following indented lines). Uses the
  ## statement parsers (stmts-wrapped, multi-line aware) and returns the index
  ## after the whole construct.
  let s = ps.tok(kwIdx).s
  if s == "try": result = ps.parseTry(b, kwIdx, pl, pc)
  elif s == "if": result = ps.parseIfLike(b, kwIdx, pl, pc, "if")
  elif s == "when": result = ps.parseIfLike(b, kwIdx, pl, pc, "when")
  elif s == "case": result = ps.parseCase(b, kwIdx, pl, pc)
  elif s == "block": result = ps.parseBlock(b, kwIdx, pl, pc)
  else: result = kwIdx

proc parseSectionDef(ps: var Parser; b: var Builder; lo, hi: int; tag: string;
                     pl, pc: int32): int =
  ## One ident-def logical range `[lo, hi)` → one or more sibling section nodes.
  ## Returns the index after the def (may extend past `hi` for a multi-line
  ## control-flow value).
  result = hi
  if ps.tok(lo).kind == tkParLe:
    # tuple decl: `var (a, b) = value` → (unpackdecl value (unpacktup (var a …) …))
    let lp = ps.tok(lo)
    let rp = ps.matchClose(lo)
    let assign = ps.findAssign(rp + 1, hi)
    b.addTree "unpackdecl"
    ps.emitInfo(b, lp.line, lp.col, pl, pc, false)          # unpackdecl = '(' pos
    if assign >= 0 and assign + 1 < hi:
      let vt = ps.tok(assign + 1)
      # multi-line control-flow value (`let (a, b) = if c: … else: …` with the
      # branches on later indented lines): route through the statement parser so
      # the whole construct — including a trailing `else` — is consumed.
      if vt.kind == tkKeyword and (vt.s == "try" or vt.s == "if" or
         vt.s == "when" or vt.s == "case" or vt.s == "block"):
        result = ps.parseCtrlFlowValue(b, assign + 1, lp.line, lp.col)
      else:
        ps.parseExprRange(b, int32(assign + 1), int32(hi), lp.line, lp.col)  # value
    else:
      b.addEmpty
    b.addTree "unpacktup"   # no line-info
    let starts = ps.splitArgs(lo + 1, rp)
    for ai in 0 ..< starts.len:
      let v = ps.tok(starts[ai])
      b.addTree tag         # section tag (var/let/const)
      ps.emitName(b, v, lp.line, lp.col)   # unpack var, or `(quoted …)`
      b.addEmpty            # export
      b.addEmpty            # pragma
      b.addEmpty 2          # type, value
      b.endTree()
    b.endTree()  # unpacktup
    b.endTree()  # unpackdecl
    return
  # `name1, name2, … [{.pragma.}] [: type] [= value]`
  var colon = ps.findColon(lo, hi)
  let assign = ps.findAssign(lo, hi)
  # a `:` AFTER the `=` is part of the value (e.g. `= if c in {A}: x else: y`),
  # not a type annotation — the type colon must precede the assignment.
  if assign >= 0 and colon > assign: colon = -1
  let boundary = if colon >= 0: colon elif assign >= 0: assign else: hi
  # optional `{.pragma.}` after the name list (before `:`/`=`)
  var pragLo = -1
  var pragHi = -1
  block:
    var d = 0
    var k = lo
    while k < boundary:
      let kk = ps.tok(k).kind
      if kk == tkCurlyLe and d == 0:
        pragLo = k; pragHi = ps.matchClose(k); break
      if isOpenBracket(kk): inc d
      elif isCloseBracket(kk):
        if d > 0: dec d
      inc k
  let nameEnd = if pragLo >= 0: pragLo
                elif colon >= 0: colon
                elif assign >= 0: assign
                else: hi
  let typeLo = if colon >= 0: colon + 1 else: -1
  let typeHi = if colon >= 0: (if assign >= 0: assign else: hi) else: -1
  let valLo = if assign >= 0: assign + 1 else: -1
  let nameStarts = ps.splitArgs(lo, nameEnd)
  for ni in 0 ..< nameStarts.len:
    let nTok = ps.tok(nameStarts[ni])
    # An exported name `Name*` is an nkPostfix in the classic AST; nifler anchors
    # the section node at the NAME NODE's info (relLineInfo(n[i], …)), which for a
    # postfix is the `*` position — so the name then gets a negative delta back to
    # its real column. A non-exported name anchors at the name itself. Every child
    # (name, pragma, type, value) is emitted relative to this anchor.
    let hasExport = nameStarts[ni] + 1 < nameEnd and
                    ps.tok(nameStarts[ni] + 1).kind == tkOperator and
                    ps.tok(nameStarts[ni] + 1).s == "*"
    let anchor = if hasExport: ps.tok(nameStarts[ni] + 1) else: nTok
    b.addTree tag
    ps.emitInfo(b, anchor.line, anchor.col, pl, pc, false)   # section node = name-node pos
    ps.emitName(b, nTok, anchor.line, anchor.col)   # name atom, or `(quoted …)`
    # export marker `*`
    if hasExport:
      b.addRaw " x"
    else:
      b.addEmpty
    if pragLo >= 0:
      discard ps.parsePragmas(b, pragLo, anchor.line, anchor.col)
    else:
      b.addEmpty   # pragma
    if typeLo >= 0 and typeLo < typeHi:
      # The type slot always goes through the TYPE parser (as nifler does): the
      # expression parser mishandles modifier keywords in generic args
      # (`seq[ref Foo]`, `sink seq[string]`) and `proc (…)` type signatures.
      parseTypeRange(ps, b, int32(typeLo), int32(typeHi), anchor.line, anchor.col)
    else:
      b.addEmpty
    if valLo >= 0 and valLo < hi:
      let vt = ps.tok(valLo)
      # multi-line control-flow value (`= try:` / `= if c:` with body on later
      # lines — the def line ends with the `:`): parse via the statement parser
      # so the body is consumed once, and report the extended end.
      if nameStarts.len == 1 and vt.kind == tkKeyword and
         (vt.s == "try" or vt.s == "if" or vt.s == "when" or
          vt.s == "case" or vt.s == "block"):
        result = ps.parseCtrlFlowValue(b, valLo, anchor.line, anchor.col)
      elif nameStarts.len == 1 and vt.kind == tkIdent and
           ps.depth0Colon(valLo, hi) > valLo:
        # value-position postExprBlock: `let x = onRaiseQuit:` / `= build(a):`
        # with the block body on following indented lines → `(call callee …
        # (stmts body))`. The head must be an ident (a call/command callee) — an
        # anonymous `proc (…): T = …` literal starts with a keyword and its `:` is
        # a return type, not a block; a `:` inside brackets stays at depth > 0.
        result = ps.parsePostExprBlock(b, valLo, ps.depth0Colon(valLo, hi),
                                       anchor.line, anchor.col)
      else:
        ps.parseExprRange(b, int32(valLo), int32(hi), anchor.line, anchor.col)  # value
    else:
      b.addEmpty
    b.endTree()

proc parseSection(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32;
                  tag: string): int =
  let kw = ps.tok(kwIdx)
  let next = ps.tok(kwIdx + 1)
  if next.kind == tkEof:
    return kwIdx + 1
  if next.indent >= 0:
    # indented section block: each line at indent > kw.col is one ident-def
    let refIndent = kw.col
    let memberIndent = next.indent          # column of the section's ident-defs
    var i = kwIdx + 1
    while ps.tok(i).kind != tkEof and ps.tok(i).indent > refIndent:
      if ps.tok(i).kind == tkComment:
        # A comment AT the member indent is a standalone member → a sibling
        # `(comment)` (nifler emits section members as flat siblings); a DEEPER
        # comment is the trailing doc of the preceding def and is dropped.
        if ps.tok(i).indent == memberIndent:
          let ct = ps.tok(i)
          b.addTree "comment"
          ps.emitInfo(b, ct.line, ct.col, pl, pc, false)
          b.endTree()
        inc i; continue
      let dhi = ps.lineEnd(i)
      let consumed = ps.parseSectionDef(b, i, dhi, tag, pl, pc)
      i = if consumed > dhi: consumed else: dhi
    result = i
  else:
    # inline single ident-def on the keyword's line, bounded at the next `;`
    let hi = ps.semiEnd(kwIdx, ps.lineEnd(kwIdx))
    result = ps.parseSectionDef(b, kwIdx + 1, hi, tag, pl, pc)

proc parsePragmaStmt(ps: var Parser; b: var Builder; braceIdx: int; pl, pc: int32): int =
  ## A statement that starts with `{.` is a pragma statement, NOT a `{ }` set.
  ## `{.pragmas.}: body` → `(pragmax (pragmas …) (stmts …))`; a bare
  ## `{.pragmas.}` (e.g. `{.push ….}`) is just the `(pragmas …)` node.
  let brace = ps.tok(braceIdx)
  let rb = ps.matchClose(braceIdx)          # closing `}`
  if ps.tok(rb + 1).kind == tkColon:
    b.addTree "pragmax"
    ps.emitInfo(b, brace.line, brace.col, pl, pc, false)   # pragmax = '{' pos
    discard ps.parsePragmas(b, braceIdx, brace.line, brace.col)
    result = ps.emitBody(b, rb + 1, brace.col, brace.line, brace.col)
    b.endTree()
  else:
    result = ps.parsePragmas(b, braceIdx, pl, pc)

proc parseFromImport(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int =
  ## `from M import a, b` → `(fromimport <M> a b)`. `M` may be a path expr.
  let kw = ps.tok(kwIdx)
  let hi = ps.semiEnd(kwIdx, ps.lineEnd(kwIdx))
  # locate the `import` keyword at depth 0
  var impIdx = -1
  var d = 0
  var i = kwIdx + 1
  while i < hi:
    let t = ps.tok(i)
    if isOpenBracket(t.kind): inc d
    elif isCloseBracket(t.kind):
      if d > 0: dec d
    elif d == 0 and t.kind == tkKeyword and t.s == "import":
      impIdx = i; break
    inc i
  b.addTree "fromimport"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  let modHi = if impIdx >= 0: impIdx else: hi
  if kwIdx + 1 < modHi:
    ps.parseExprRange(b, int32(kwIdx + 1), int32(modHi), kw.line, kw.col)   # module
  else:
    b.addEmpty
  if impIdx >= 0:
    let starts = ps.splitArgs(impIdx + 1, hi)
    for ai in 0 ..< starts.len:
      let aLo = starts[ai]
      let aHi = if ai + 1 < starts.len: starts[ai+1] - 1 else: hi
      if aLo < aHi:
        ps.parseExprRange(b, int32(aLo), int32(aHi), kw.line, kw.col)
  b.endTree()
  result = hi

proc parseStatic(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int =
  ## `static: body` → `(staticstmt (stmts …))`.
  let kw = ps.tok(kwIdx)
  b.addTree "staticstmt"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)
  let hi = ps.lineEnd(kwIdx)
  let colon = ps.findColon(kwIdx, hi)
  result = ps.emitBody(b, colon, kw.col, kw.line, kw.col)
  b.endTree()

proc semiEnd(ps: Parser; startIdx, bound: int): int =
  ## First depth-0 `;` in `[startIdx, bound)` (statement separator), else bound.
  var d = 0
  var i = startIdx
  while i < bound:
    let t = ps.tok(i)
    if isOpenBracket(t.kind): inc d
    elif isCloseBracket(t.kind):
      if d > 0: dec d
    elif d == 0 and t.kind == tkSemicolon:
      return i
    inc i
  result = bound

proc parsePostExprBlock(ps: var Parser; b: var Builder; headLo, colonIdx: int;
                        pl, pc: int32): int =
  ## Nim postExprBlocks: `call(args): body` / `cmd a, b: body` — the trailing
  ## `:` block becomes a `(stmts …)` argument appended to the call/command.
  let head = ps.tok(headLo)
  let refIndent = head.col
  # `do` block: `expr do (params) -> ret: body` → `(call <callee> (do (params …)
  # ret (stmts body)))`. Detect a depth-0 `do` keyword introducing the block.
  block doBlock:
    var d = 0
    var doIdx = -1
    var k = headLo
    while k < colonIdx:
      let t = ps.tok(k)
      if isOpenBracket(t.kind): inc d
      elif isCloseBracket(t.kind):
        if d > 0: dec d
      elif d == 0 and t.kind == tkKeyword and t.s == "do":
        doIdx = k; break
      inc k
    if doIdx > headLo and ps.tok(doIdx + 1).kind == tkParLe:
      let dk = ps.tok(doIdx)
      b.addTree "call"
      ps.emitInfo(b, head.line, head.col, pl, pc, false)
      # callee before `do`: `foo(x)` splits into callee+args, else a bare expr.
      if ps.tok(doIdx - 1).kind == tkParRi:
        let rparen = doIdx - 1
        let lparen = ps.matchOpen(rparen)
        ps.parseExprRange(b, int32(headLo), int32(lparen), head.line, head.col)
        ps.parseArgList(b, int32(lparen + 1), int32(rparen), head.line, head.col)
      else:
        ps.parseExprRange(b, int32(headLo), int32(doIdx), head.line, head.col)
      b.addTree "do"
      ps.emitInfo(b, dk.line, dk.col, head.line, head.col, false)
      discard ps.parseParams(b, doIdx + 1, dk.line, dk.col)   # (params …) + ret type
      result = ps.emitBody(b, colonIdx, refIndent, dk.line, dk.col)
      b.endTree()   # do
      b.endTree()   # call
      return
  let ce = ps.cmdCalleeEnd(headLo, colonIdx)
  if head.kind == tkIdent and ce < colonIdx and ps.startsArg(ce, colonIdx):
    # command with space-separated args: `foo a, b: body` → `(cmd callee args… (stmts))`.
    # Statement-context → anchor at the callee expression's info (the `.` for a
    # dotted callee), matching parseCommand / nifler's `newTree(nkCommand, a.info)`.
    let anchor = ps.calleeAnchor(headLo, ce)
    b.addTree "cmd"
    ps.emitInfo(b, anchor.line, anchor.col, pl, pc, false)
    ps.parseExprRange(b, int32(headLo), int32(ce), anchor.line, anchor.col)   # callee
    ps.parseArgList(b, int32(ce), int32(colonIdx), anchor.line, anchor.col)
    result = ps.emitBody(b, colonIdx, refIndent, anchor.line, anchor.col)     # (stmts body) arg
    b.endTree()
  else:
    # call form: `foo: body` / `c.into: body` / `foo(args): body`
    # → `(call <callee> [args…] (stmts body))`.
    b.addTree "call"
    ps.emitInfo(b, head.line, head.col, pl, pc, false)
    if colonIdx - 1 >= headLo and ps.tok(colonIdx - 1).kind == tkParRi:
      let rparen = colonIdx - 1
      let lparen = ps.matchOpen(rparen)
      ps.parseExprRange(b, int32(headLo), int32(lparen), head.line, head.col)     # callee
      ps.parseArgList(b, int32(lparen + 1), int32(rparen), head.line, head.col)   # args
    else:
      ps.parseExprRange(b, int32(headLo), int32(colonIdx), head.line, head.col)   # bare callee
    result = ps.emitBody(b, colonIdx, refIndent, head.line, head.col)     # (stmts body) arg
    b.endTree()

proc parseOneStmt(ps: var Parser; b: var Builder; startIdx: int; pl, pc: int32;
                  hiLimit: int): int =
  ## Emit one statement starting at token `startIdx`. Returns the index of the
  ## first token AFTER the statement. `hiLimit` (>=0) bounds a one-line-body
  ## statement so it cannot run past a same-line branch keyword; -1 = auto.
  let t = ps.tok(startIdx)
  # A standalone `##` doc comment is its own `(comment)` statement (nkCommentStmt).
  if t.kind == tkComment:
    b.addTree "comment"
    ps.emitInfo(b, t.line, t.col, pl, pc, false)
    b.endTree()
    return startIdx + 1
  # `{. …` at statement position is a pragma statement, not a set constructor.
  if t.kind == tkCurlyLe and ps.tok(startIdx + 1).kind == tkDot:
    return ps.parsePragmaStmt(b, startIdx, pl, pc)
  if t.kind == tkKeyword:
    case t.s
    of "proc": return ps.parseRoutine(b, startIdx, pl, pc, "proc")
    of "func": return ps.parseRoutine(b, startIdx, pl, pc, "func")
    of "method": return ps.parseRoutine(b, startIdx, pl, pc, "method")
    of "converter": return ps.parseRoutine(b, startIdx, pl, pc, "converter")
    of "iterator": return ps.parseRoutine(b, startIdx, pl, pc, "iterator")
    of "macro": return ps.parseRoutine(b, startIdx, pl, pc, "macro")
    of "template": return ps.parseRoutine(b, startIdx, pl, pc, "template")
    of "return": return ps.parseReturnLike(b, startIdx, pl, pc, "ret")
    of "discard": return ps.parseReturnLike(b, startIdx, pl, pc, "discard")
    of "raise": return ps.parseReturnLike(b, startIdx, pl, pc, "raise")
    of "yield": return ps.parseReturnLike(b, startIdx, pl, pc, "yld")
    of "import": return ps.parseImportLike(b, startIdx, pl, pc, "import")
    of "include": return ps.parseImportLike(b, startIdx, pl, pc, "include")
    of "export": return ps.parseImportLike(b, startIdx, pl, pc, "export")
    of "mixin": return ps.parseImportLike(b, startIdx, pl, pc, "mixin")
    of "bind": return ps.parseImportLike(b, startIdx, pl, pc, "bind")
    of "from": return ps.parseFromImport(b, startIdx, pl, pc)
    of "static": return ps.parseStatic(b, startIdx, pl, pc)
    of "if": return ps.parseIfLike(b, startIdx, pl, pc, "if")
    of "when": return ps.parseIfLike(b, startIdx, pl, pc, "when")
    of "while": return ps.parseWhile(b, startIdx, pl, pc)
    of "case": return ps.parseCase(b, startIdx, pl, pc)
    of "for": return ps.parseFor(b, startIdx, pl, pc)
    of "try": return ps.parseTry(b, startIdx, pl, pc)
    of "block": return ps.parseBlock(b, startIdx, pl, pc)
    of "break": return ps.parseBreakLike(b, startIdx, pl, pc, "break")
    of "continue": return ps.parseBreakLike(b, startIdx, pl, pc, "continue")
    of "defer": return ps.parseDefer(b, startIdx, pl, pc)
    of "var": return ps.parseSection(b, startIdx, pl, pc, "var")
    of "let": return ps.parseSection(b, startIdx, pl, pc, "let")
    of "const": return ps.parseSection(b, startIdx, pl, pc, "const")
    of "type": return ps.parseTypeSection(b, startIdx, pl, pc)
    else: discard
  # postExprBlock: an expression statement whose line has a depth-0 `:` (not a
  # keyword statement) is `call/cmd(args): body` — parse the block as a trailing
  # `(stmts …)` arg. (Bounded to the head line; the block is on later lines.)
  if hiLimit < 0:
    let lineHi = ps.lineEnd(startIdx)
    let pcolon = ps.depth0Colon(startIdx, lineHi)
    # A depth-0 `:` in a non-keyword statement is a command/do-block body,
    # `foo a: body` / `x.build y: body` (inline or on following lines). Guard
    # against an assignment RHS (`x = …`).
    if pcolon > startIdx and ps.findAssign(startIdx, pcolon) < 0:
      # exclude a colon owned by an unparenthesized if/when/case EXPRESSION in
      # the head (`x = if c: a`, `echo if c: a else: b`), or by an anonymous
      # routine's return type (`xs.sort proc (a): int = …` — the `: int` is the
      # proc return, not a block) — neither is a postExprBlock.
      var cf = false
      var d = 0
      var k = startIdx
      while k < pcolon:
        let t = ps.tok(k)
        if isOpenBracket(t.kind): inc d
        elif isCloseBracket(t.kind):
          if d > 0: dec d
        elif d == 0 and t.kind == tkKeyword and
             (t.s == "if" or t.s == "when" or t.s == "case" or
              t.s == "elif" or t.s == "else" or t.s == "of" or
              t.s == "proc" or t.s == "func" or t.s == "iterator"):
          cf = true; break
        inc k
      if not cf:
        return ps.parsePostExprBlock(b, startIdx, pcolon, pl, pc)
    # Fallback: the first depth-0 `:` belonged to an if/case/proc in the args, but
    # the head LINE still ends with a real block colon —
    # `addUIntTypedOp dest, if k: A else: B, 8, info:` with the body on the next
    # lines. A trailing depth-0 `:` at end of line is that block introducer.
    let eol = lineHi - 1
    if eol > startIdx and ps.tok(eol).kind == tkColon and eol > pcolon and
       ps.findAssign(startIdx, eol) < 0:
      return ps.parsePostExprBlock(b, startIdx, eol, pl, pc)
  # expression / command / assignment statement (bounded by the logical line,
  # any tighter `hiLimit`, and the next `;`)
  var bound = ps.lineEnd(startIdx)
  if hiLimit >= 0 and hiLimit < bound: bound = hiLimit
  let hi = ps.semiEnd(startIdx, bound)
  let consumed = ps.parseExprStmt(b, int32(startIdx), int32(hi), pl, pc)
  result = if consumed > hi: consumed else: hi

proc parseStmtImpl(ps: var Parser; b: var Builder; startIdx: int; pl, pc: int32;
               hiLimit: int): int =
  ## Parse a run of `;`-separated statements on the same logical line (each an
  ## `(stmts …)` sibling), bounded by `hiLimit` (a branch/brace body) or the
  ## logical line. Returns the index after the last one.
  var i = ps.parseOneStmt(b, startIdx, pl, pc, hiLimit)
  var bound = ps.lineEnd(startIdx)
  if hiLimit >= 0 and hiLimit < bound: bound = hiLimit
  while ps.tok(i).kind == tkSemicolon and i + 1 < bound:
    i = ps.parseOneStmt(b, i + 1, pl, pc, hiLimit)
  result = i

proc parseStmt(ps: var Parser; b: var Builder; startIdx: int; pl, pc: int32;
               hiLimit: int): int =
  ## Depth-guarding wrapper (see `enterDepth`): counts recursion nesting for
  ## `--max-depth`, then delegates. Off-by-default: inert when maxDepth == 0.
  ps.enterDepth(ps.tok(startIdx).line)
  result = ps.parseStmtImpl(b, startIdx, pl, pc, hiLimit)
  dec ps.depth
