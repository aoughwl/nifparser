## parse_expr.nim — EXPRESSIONS & OPERATORS.
##
## Spliced after parsecore.nim (parse_type.nim / parse_stmt.nim resolve against
## `parseExprRange` via the forward decl in parsecore.nim).
##
## Expression strategy: a token-range splitter. `parseExprRange [lo,hi)` finds the
## lowest-precedence depth-0 binary operator (rightmost = left-assoc) and emits
## `(infix op L R)`, recursing on the sub-ranges — reproducing nifler's operator
## nesting and pretty-print indentation. `parsePrimaryRange` handles atoms/calls/
## grouping/prefix, plus HIGH-PRECEDENCE POSTFIX chains (`.`/`[]`/`{}`/`()`) and
## keyword-led forms (`nil`/`cast`/`addr`/`if`). Constructors (`bracket`/`curly`/
## `tup`/`par`/`oconstr`/`tabconstr`) and named args (`kv`/`vv`) live here too.
## Line-info is emitted relative to the parent node via `emitInfo`.

# postfix kinds
const
  pkDot = 1
  pkAt = 2
  pkCurly = 3
  pkCall = 4

proc depth0Colon(ps: Parser; lo, hi: int): int =
  ## First depth-0 `tkColon` in `[lo, hi)`, or -1 (named-arg / table entry).
  var depth = 0
  result = -1
  var i = lo
  while i < hi:
    let t = ps.tok(i)
    if isOpenBracket(t.kind): inc depth
    elif isCloseBracket(t.kind):
      if depth > 0: dec depth
    elif depth == 0 and t.kind == tkColon:
      return i
    inc i

proc findPostfix(ps: Parser; lo, hi: int; kind: var int): int =
  ## Rightmost depth-0 postfix operator in `(lo, hi)`, or -1. Sets `kind`.
  var depth = 0
  result = -1
  kind = 0
  var i = lo
  while i < hi:
    let t = ps.tok(i)
    if depth == 0 and i > lo:
      case t.kind
      of tkDot: result = i; kind = pkDot
      of tkBracketLe: result = i; kind = pkAt
      of tkCurlyLe: result = i; kind = pkCurly
      of tkParLe: result = i; kind = pkCall
      else: discard
    if isOpenBracket(t.kind): inc depth
    elif isCloseBracket(t.kind):
      if depth > 0: dec depth
    inc i

proc calleeAnchor(ps: Parser; lo, hi: int): Token =
  ## The position at which the callee sub-expression `[lo, hi)` is emitted — the
  ## line-info of the node `parsePrimaryRange` will build for it. That is its
  ## OUTERMOST postfix operator (`.`/`[`/`{`/`(`, e.g. the `.` of `a.b.c`), or the
  ## head atom when the callee is a bare primary. Used to anchor a STATEMENT-level
  ## command at its callee's info (nifler's `newTree(nkCommand, a.info, a)`), which
  ## for a dotted callee is the dot, not the head ident.
  var pk = 0
  let k = ps.findPostfix(lo, hi, pk)
  result = if k >= 0: ps.tok(k) else: ps.tok(lo)

proc parseArg(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## One comma-delimited element: `k: v` -> `(kv k v)`, `k = v` -> `(vv k v)`,
  ## else a plain expression. Keyword-led args whose own syntax owns a depth-0
  ## `:`/`=` keep it: `if`/`case` expressions, and anonymous `proc`/`func`/
  ## `iterator` literals (`sort(proc (a): int = …)` — the return `:` and default
  ## `=` are the routine's, not a `kv`/`vv` pair).
  let head = ps.tok(int(lo))
  let guardKw = head.kind == tkKeyword and
                (head.s == "if" or head.s == "case" or head.s == "proc" or
                 head.s == "func" or head.s == "iterator")
  if not guardKw:
    let ci = ps.depth0Colon(int(lo), int(hi))
    if ci >= 0:
      let op = ps.tok(ci)
      b.addTree "kv"
      ps.emitInfo(b, op.line, op.col, pl, pc, false)   # kv node = ':' pos
      ps.parseExprRange(b, lo, int32(ci), op.line, op.col)
      ps.parseExprRange(b, int32(ci) + 1, hi, op.line, op.col)
      b.endTree()
      return
    let ei = ps.findAssign(int(lo), int(hi))
    if ei >= 0:
      let op = ps.tok(ei)
      b.addTree "vv"
      ps.emitInfo(b, op.line, op.col, pl, pc, false)   # vv node = '=' pos
      ps.parseExprRange(b, lo, int32(ei), op.line, op.col)
      ps.parseExprRange(b, int32(ei) + 1, hi, op.line, op.col)
      b.endTree()
      return
  # a generic type argument led by a modifier keyword (`initTable[K, ref V]`,
  # `HashSet[ptr X]`) must go through the TYPE parser — the expression parser
  # drops the operand after `ref`/`ptr`/`var`/`out`.
  if head.kind == tkKeyword and int(lo) + 1 < int(hi) and
     (head.s == "ref" or head.s == "ptr" or head.s == "var" or head.s == "out"):
    parseTypeRange(ps, b, lo, hi, pl, pc)
    return
  # an anonymous tuple TYPE as a generic arg (`initTable[string, tuple[a: int]]`):
  # `tuple[…]` is a tuple type, not `(at tuple …)` bracket-indexing, so the type
  # parser must own it.
  if head.kind == tkKeyword and head.s == "tuple" and int(lo) + 1 < int(hi) and
     ps.tok(int(lo) + 1).kind == tkBracketLe:
    parseTypeRange(ps, b, lo, hi, pl, pc)
    return
  ps.parseExprRange(b, lo, hi, pl, pc)

proc parseArgList(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## Emit each comma-separated element of `[lo, hi)` as an arg, parent (pl,pc).
  let starts = ps.splitArgs(int(lo), int(hi))
  for ai in 0 ..< starts.len:
    let aLo = starts[ai]
    let aHi = if ai + 1 < starts.len: starts[ai+1] - 1 else: int(hi)
    if aLo < aHi:
      ps.parseArg(b, int32(aLo), int32(aHi), pl, pc)

proc parseBareResultBody(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## The body of a branch in a parenthesized StmtListExpr RESULT (rendered bare,
  ## without a `(stmts)` wrapper). Its content is still a statement in the classic
  ## parser, so a command there is a STATEMENT command — callee-anchored via
  ## parseCommand, not the expr command path's first-arg anchor. Control-flow and
  ## plain expressions keep the bare expression rendering.
  let head = ps.tok(int(lo))
  let ce = ps.cmdCalleeEnd(int(lo), int(hi))
  if head.kind == tkIdent and ce < int(hi) and ps.startsArg(ce, int(hi)):
    ps.parseCommand(b, lo, hi, pl, pc)
  else:
    ps.parseExprRange(b, lo, hi, pl, pc)

proc parseIfExpr(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32;
                 bare: bool; tag: string) =
  ## Single-line `if C: A (elif C: A)* (else: B)` -> `(if (elif C (stmts A))...)`.
  ## `tag` is `if` or `when`. `bare` (only for the result of a parenthesized
  ## StmtListExpr) emits the branch bodies as bare expressions, not `(stmts …)`.
  let ifTok = ps.tok(int(lo))
  b.addTree tag
  ps.emitInfo(b, ifTok.line, ifTok.col, pl, pc, false)   # if node = 'if' kw pos
  # branch boundaries: depth-0 `elif`/`else` keywords.
  var i = int(lo)
  while i < int(hi):
    let kw = ps.tok(i)          # `if` (first) / `elif` / `else`
    let isElse = kw.kind == tkKeyword and kw.s == "else"
    # find the branch body colon (depth 0) and the next branch keyword.
    var depth = 0
    var colon = -1
    var nxt = int(hi)
    var j = i + 1
    while j < int(hi):
      let t = ps.tok(j)
      if isOpenBracket(t.kind): inc depth
      elif isCloseBracket(t.kind):
        if depth > 0: dec depth
      elif depth == 0 and t.kind == tkColon and colon < 0:
        colon = j
      elif depth == 0 and t.kind == tkKeyword and (t.s == "elif" or t.s == "else"):
        nxt = j; break
      inc j
    let bodyLo = colon + 1
    if isElse:
      b.addTree "else"
      ps.emitInfo(b, kw.line, kw.col, ifTok.line, ifTok.col, false)
      let bt = ps.tok(bodyLo)
      if bare:
        ps.parseBareResultBody(b, int32(bodyLo), int32(nxt), kw.line, kw.col)
      else:
        b.addTree "stmts"
        ps.emitInfo(b, bt.line, bt.col, kw.line, kw.col, false)
        ps.parseExprRange(b, int32(bodyLo), int32(nxt), bt.line, bt.col)
        b.endTree()
      b.endTree()
    else:
      # first `if` and every `elif` both emit an `elif` node at the COND pos.
      let ct = ps.tok(i + 1)     # condition first token
      b.addTree "elif"
      ps.emitInfo(b, ct.line, ct.col, ifTok.line, ifTok.col, false)
      ps.parseExprRange(b, int32(i + 1), int32(colon), ct.line, ct.col)
      let bt = ps.tok(bodyLo)
      if bare:
        ps.parseBareResultBody(b, int32(bodyLo), int32(nxt), ct.line, ct.col)
      else:
        b.addTree "stmts"
        ps.emitInfo(b, bt.line, bt.col, ct.line, ct.col, false)
        ps.parseExprRange(b, int32(bodyLo), int32(nxt), bt.line, bt.col)
        b.endTree()
      b.endTree()
    i = nxt
  b.endTree()   # close the `if` node

proc parseCaseExpr(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## `case SEL of R: A (of R: A)* (elif C: A)* (else: B)` as a value expression
  ## (the result of a parenthesized StmtListExpr): branch bodies are BARE, not
  ## `(stmts …)`. Bounded to `[lo, hi)`; branch keywords found at depth 0.
  let kw = ps.tok(int(lo))
  b.addTree "case"
  ps.emitInfo(b, kw.line, kw.col, pl, pc, false)          # case node = 'case' kw pos
  # selector spans from after `case` to the first depth-0 `of` (a `:` right
  # before that `of` is the optional selector colon and is dropped).
  var depth = 0
  var firstOf = int(hi)
  var j = int(lo) + 1
  while j < int(hi):
    let t = ps.tok(j)
    if isOpenBracket(t.kind): inc depth
    elif isCloseBracket(t.kind):
      if depth > 0: dec depth
    elif depth == 0 and t.kind == tkKeyword and t.s == "of":
      firstOf = j; break
    inc j
  var selHi = firstOf
  if selHi - 1 > int(lo) and ps.tok(selHi - 1).kind == tkColon: dec selHi
  ps.parseExprRange(b, int32(lo) + 1, int32(selHi), kw.line, kw.col)  # selector parent = case
  # branches
  var i = firstOf
  while i < int(hi):
    let br = ps.tok(i)
    let isOf = br.kind == tkKeyword and br.s == "of"
    let isElse = br.kind == tkKeyword and br.s == "else"
    # find this branch's depth-0 colon and the next depth-0 branch keyword.
    var d = 0
    var colon = -1
    var nxt = int(hi)
    var k = i + 1
    while k < int(hi):
      let t = ps.tok(k)
      if isOpenBracket(t.kind): inc d
      elif isCloseBracket(t.kind):
        if d > 0: dec d
      elif d == 0 and t.kind == tkColon and colon < 0:
        colon = k
      elif d == 0 and t.kind == tkKeyword and
           (t.s == "of" or t.s == "elif" or t.s == "else"):
        nxt = k; break
      inc k
    let bodyLo = colon + 1
    if isOf:
      b.addTree "of"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      b.addTree "ranges"                                  # ranges carries NO line-info
      let starts = ps.splitArgs(i + 1, colon)
      for ai in 0 ..< starts.len:
        let aLo = starts[ai]
        let aHi = if ai + 1 < starts.len: starts[ai+1] - 1 else: colon
        if aLo < aHi:
          ps.parseExprRange(b, int32(aLo), int32(aHi), br.line, br.col)  # value parent = of
      b.endTree()                                          # ranges
      ps.parseBareResultBody(b, int32(bodyLo), int32(nxt), br.line, br.col)   # BARE body
      b.endTree()                                          # of
    elif isElse:
      b.addTree "else"
      ps.emitInfo(b, br.line, br.col, kw.line, kw.col, false)
      ps.parseBareResultBody(b, int32(bodyLo), int32(nxt), br.line, br.col)   # BARE body
      b.endTree()
    else:                                                  # elif
      b.addTree "elif"
      let ct = ps.tok(i + 1)
      ps.emitInfo(b, ct.line, ct.col, kw.line, kw.col, false)
      ps.parseExprRange(b, int32(i + 1), int32(colon), ct.line, ct.col)  # condition
      ps.parseBareResultBody(b, int32(bodyLo), int32(nxt), ct.line, ct.col)   # BARE body
      b.endTree()
    i = nxt
  b.endTree()   # close the `case` node

proc parseCastExpr(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## `cast[T](x)` -> `(cast T x)`; type & value both relative to the cast node.
  let castTok = ps.tok(int(lo))
  b.addTree "cast"
  ps.emitInfo(b, castTok.line, castTok.col, pl, pc, false)  # cast node = 'cast' kw
  let lb = int(lo) + 1                       # `[`
  let rb = ps.matchClose(lb)                 # `]`
  discard ps.parseType(b, lb + 1, castTok.line, castTok.col)
  # value: contents of the `(...)` after `]`
  let lp = rb + 1                            # `(`
  let rp = ps.matchClose(lp)
  ps.parseExprRange(b, int32(lp + 1), int32(rp), castTok.line, castTok.col)
  b.endTree()

proc parseCmdKw(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## Keyword-led command in EXPR position, e.g. `let p = addr x` -> `(cmd addr x)`.
  ## Expr-context, so the node anchors at the FIRST ARGUMENT (nifler's
  ## `commandExpr`); the keyword callee then gets a negative delta back to it.
  ## (A keyword command that is a whole STATEMENT anchors at the callee instead —
  ## parse_stmt routes those through `parseCommand`.)
  let kw = ps.tok(int(lo))
  let arg0 = ps.tok(int(lo) + 1)
  b.addTree "cmd"
  ps.emitInfo(b, arg0.line, arg0.col, pl, pc, false)   # cmd node = first-arg pos
  b.addIdent kw.s
  ps.emitInfo(b, kw.line, kw.col, arg0.line, arg0.col, false)
  ps.parseArgList(b, lo + 1, hi, arg0.line, arg0.col)
  b.endTree()

proc parsePrimaryRangeImpl(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  let t = ps.tok(int(lo))
  # --- `-<number>` folds into a signed literal (nifler): only `-`, only when
  # directly adjacent (no space), only a bare numeric literal, nothing after. ---
  if t.kind == tkOperator and t.s == "-" and int(lo) + 2 == int(hi):
    let n = ps.tok(int(lo) + 1)
    if (n.kind == tkIntLit or n.kind == tkFloatLit) and
       n.line == t.line and n.col == t.col + 1:
      let suf = n.suffix
      if n.kind == tkIntLit:
        let v = -n.iVal
        if suf.len > 0:
          # `-N'suffix` folds to `(suf -N "suffix")`, like the leaf `(suf …)`.
          b.addTree "suf"
          ps.emitInfo(b, t.line, t.col, pl, pc, false)
          if suf[0] == 'u': b.addUIntLit uint64(v) else: b.addIntLit v
          b.addStrLit suf
          b.endTree()
        elif v > 2147483647'i64 or v < -2147483648'i64:
          b.addTree "suf"
          ps.emitInfo(b, t.line, t.col, pl, pc, false)
          b.addIntLit v
          b.addStrLit "i64"
          b.endTree()
        else:
          b.addIntLit v
          ps.emitInfo(b, t.line, t.col, pl, pc, false)
      else:
        if suf.len > 0:
          b.addTree "suf"
          ps.emitInfo(b, t.line, t.col, pl, pc, false)
          b.addFloatLit(-n.fVal)
          b.addStrLit suf
          b.endTree()
        else:
          b.addFloatLit(-n.fVal, t.col - pc, t.line - pl, "")
      return
  # --- generalized call-string-literal (adjacent, no space): a dotted-ident
  # callee immediately followed by a string literal → `(callstrlit <callee>
  # (suf "str" "R"))`. Handles `re"x"`, `infile.changeExt".nif"`, `a.b.c"x"`.
  # The callee must be a pure symbol/dotted-symbol chain (Nim's rule): a
  # subscript/call ending (`args[1]"x"`) is NOT a raw string call. nifler anchors
  # the `callstrlit` node (and `suf`) at the STRING, with the callee before it. ---
  if (t.kind == tkIdent or t.kind == tkKeyword) and int(hi) - 1 > int(lo):
    let s = ps.tok(int(hi) - 1)
    let prev = ps.tok(int(hi) - 2)
    if (s.kind == tkStrLit or s.kind == tkRStrLit or s.kind == tkTripleStrLit) and
       s.line == prev.line and s.col == prev.endCol and
       (prev.kind == tkIdent or prev.kind == tkKeyword):
      # Nim's rule: the raw string call binds to a symbol reached as a plain
      # ident or via a trailing `.field` access. A subscript/call ENDING
      # (`args[1]"x"`) is not a raw string call, but `args[1].ext"x"` is (the
      # callee's last step is `.ext`). So: prev is the whole callee, or it is
      # preceded by a `.`.
      let dotAccess = int(hi) - 2 == int(lo) or ps.tok(int(hi) - 3).kind == tkDot
      if dotAccess:
        b.addTree "callstrlit"
        ps.emitInfo(b, s.line, s.col, pl, pc, false)              # node = string pos
        ps.parseExprRange(b, lo, int32(int(hi) - 1), s.line, s.col)  # callee, rel string
        b.addTree "suf"
        ps.emitInfo(b, s.line, s.col, s.line, s.col, false)       # suf inherits (no info)
        b.addStrLit s.s
        b.addStrLit "R"
        b.endTree()
        b.endTree()
        return
  # --- leading prefix operator (binds looser than postfix): `-a.b` ---
  if t.kind == tkOperator:
    b.addTree "prefix"
    ps.emitInfo(b, t.line, t.col, pl, pc, false)
    b.addIdent t.s
    ps.emitInfo(b, t.line, t.col, t.line, t.col, false)
    if int(lo) + 1 < int(hi):
      ps.parseExprRange(b, lo + 1, hi, t.line, t.col)
    b.endTree()
    return
  # --- keyword-led forms ---
  if t.kind == tkKeyword:
    case t.s
    of "nil":
      b.addTree "nil"
      ps.emitInfo(b, t.line, t.col, pl, pc, false)
      b.endTree()
      return
    of "not":
      b.addTree "prefix"
      ps.emitInfo(b, t.line, t.col, pl, pc, false)
      b.addIdent t.s
      ps.emitInfo(b, t.line, t.col, t.line, t.col, false)
      if int(lo) + 1 < int(hi):
        ps.parseExprRange(b, lo + 1, hi, t.line, t.col)
      b.endTree()
      return
    of "cast":
      if int(lo) + 1 < int(hi) and ps.tok(int(lo)+1).kind == tkBracketLe:
        # `cast[T](x)` — but a trailing postfix (`cast[T](x)[]`, `.field`) must
        # wrap the cast, so fall through to the postfix chain in that case.
        let rb = ps.matchClose(int(lo) + 1)             # ] of cast[T]
        var castEnd = rb
        if rb + 1 < int(hi) and ps.tok(rb + 1).kind == tkParLe:
          castEnd = ps.matchClose(rb + 1)               # ) of (x)
        if castEnd + 1 >= int(hi):
          ps.parseCastExpr(b, lo, hi, pl, pc)
          return
        # else: trailing postfix present → handled by findPostfix below
    of "if":
      ps.parseIfExpr(b, lo, hi, pl, pc, false, "if")
      return
    of "when":
      ps.parseIfExpr(b, lo, hi, pl, pc, false, "when")
      return
    of "try":
      # `try: A except: B` as a direct expression is stmts-wrapped, like the
      # statement form (only the parenthesized StmtListExpr result is bare).
      discard ps.parseTry(b, int(lo), pl, pc)
      return
    of "proc", "func", "iterator":
      # anonymous routine expression (lambda): `proc (x): T = body`.
      discard ps.parseRoutine(b, int(lo), pl, pc, t.s)
      return
    of "addr":
      # `addr x` (space) is a command; `addr(x)` (adjacent paren) is a call and
      # must fall through to the postfix chain → `(call addr x)`.
      let nxt = ps.tok(int(lo) + 1)
      let adjacentCall = nxt.kind == tkParLe and nxt.line == t.line and
                         nxt.col == t.col + int32(t.s.len)
      if int(lo) + 1 < int(hi) and not adjacentCall:
        ps.parseCmdKw(b, lo, hi, pl, pc)
        return
    else: discard
  # --- postfix chain: rightmost depth-0 `.`/`[`/`{`/`(` ---
  var pkind = 0
  let k = ps.findPostfix(int(lo), int(hi), pkind)
  if k >= 0:
    let opTok = ps.tok(k)
    case pkind
    of pkDot:
      b.addTree "dot"
      ps.emitInfo(b, opTok.line, opTok.col, pl, pc, false)   # dot node = '.' pos
      ps.parsePrimaryRange(b, lo, int32(k), opTok.line, opTok.col)
      let r = ps.tok(k + 1)
      ps.emitName(b, r, opTok.line, opTok.col)   # field name, or `(quoted …)`
      b.endTree()
    of pkAt:
      let rp = ps.matchClose(k)
      b.addTree "at"
      ps.emitInfo(b, opTok.line, opTok.col, pl, pc, false)   # at node = '[' pos
      ps.parsePrimaryRange(b, lo, int32(k), opTok.line, opTok.col)
      ps.parseArgList(b, int32(k + 1), int32(rp), opTok.line, opTok.col)
      b.endTree()
    of pkCurly:
      let rp = ps.matchClose(k)
      b.addTree "curlyat"
      ps.emitInfo(b, opTok.line, opTok.col, pl, pc, false)   # curlyat node = '{' pos
      ps.parsePrimaryRange(b, lo, int32(k), opTok.line, opTok.col)
      ps.parseArgList(b, int32(k + 1), int32(rp), opTok.line, opTok.col)
      b.endTree()
    else:  # pkCall
      let rp = ps.matchClose(k)
      let starts = ps.splitArgs(k + 1, rp)
      var isObj = false
      if starts.len > 0:
        let a0Hi = if starts.len > 1: starts[1] - 1 else: rp
        # `(oconstr …)` only when the first arg is a named field `name: value`
        # (head is a plain ident). A colon inside an `if`/`case` expression arg
        # (`open(if c: a else: b)`) is NOT a named field → keep it a `call`.
        isObj = ps.tok(starts[0]).kind == tkIdent and
                ps.depth0Colon(starts[0], a0Hi) >= 0
      b.addTree(if isObj: "oconstr" else: "call")
      ps.emitInfo(b, opTok.line, opTok.col, pl, pc, false)   # node = '(' pos
      ps.parsePrimaryRange(b, lo, int32(k), opTok.line, opTok.col)
      ps.parseArgList(b, int32(k + 1), int32(rp), opTok.line, opTok.col)
      b.endTree()
    return
  # --- leaf atoms / grouping / constructors ---
  case t.kind
  of tkIntLit:
    # nifler renders a bare in-range int as `N`, but a typed/oversized literal as
    # `(suf N "tag")`: an explicit suffix (i8/u16/…), or — with no suffix — an
    # int that overflows int32, which nifler auto-promotes to `(suf N "i64")`.
    # Unsigned types render the number itself with a trailing `u` (`100u`); the
    # bare `'u` (uint) is special-cased to `Nu` with no `(suf)` wrapper.
    let suf = t.suffix
    if suf.len == 0:
      if t.iVal > 2147483647'i64 or t.iVal < -2147483648'i64:
        b.addTree "suf"
        ps.emitInfo(b, t.line, t.col, pl, pc, false)
        b.addIntLit t.iVal
        b.addStrLit "i64"
        b.endTree()
      else:
        b.addIntLit t.iVal
        ps.emitInfo(b, t.line, t.col, pl, pc, false)
    elif suf == "u":
      b.addUIntLit uint64(t.iVal)
      ps.emitInfo(b, t.line, t.col, pl, pc, false)
    else:
      b.addTree "suf"
      ps.emitInfo(b, t.line, t.col, pl, pc, false)
      if suf[0] == 'u': b.addUIntLit uint64(t.iVal)
      else: b.addIntLit t.iVal
      b.addStrLit suf
      b.endTree()
  of tkFloatLit:
    if t.suffix.len == 0:
      b.addFloatLit(t.fVal, t.col - pc, t.line - pl, "")
    else:
      b.addTree "suf"
      ps.emitInfo(b, t.line, t.col, pl, pc, false)
      b.addFloatLit t.fVal
      b.addStrLit t.suffix
      b.endTree()
  of tkStrLit:
    b.addStrLit t.s
    ps.emitInfo(b, t.line, t.col, pl, pc, false)
  of tkRStrLit:
    b.addStrLit(t.s, "R", t.col - pc, t.line - pl, "")
  of tkTripleStrLit:
    b.addStrLit(t.s, "T", t.col - pc, t.line - pl, "")
  of tkCharLit:
    b.addCharLit char(t.iVal)
    ps.emitInfo(b, t.line, t.col, pl, pc, false)
  of tkParLe:
    # `(...)` grouping. Usually `(par x)` / `(tup a b)`, but a parenthesized
    # statement list (`(a; b; c)`) or a control-flow expression (`(if …)`,
    # `(try …)`) is a StmtListExpr → `(expr (stmts <leading>) <result>)`.
    let rpIdx = ps.matchClose(int(lo))
    # depth-0 `;` split points within the parens
    var semis: seq[int] = @[]
    block:
      var d = 0
      var k = int(lo) + 1
      while k < rpIdx:
        let kk = ps.tok(k)
        if isOpenBracket(kk.kind): inc d
        elif isCloseBracket(kk.kind):
          if d > 0: dec d
        elif d == 0 and kk.kind == tkKeyword and
             (kk.s == "if" or kk.s == "when" or kk.s == "case" or kk.s == "try" or
              kk.s == "block" or kk.s == "while" or kk.s == "for"):
          break   # a control-flow body owns any `;` after it, not the StmtListExpr
        elif d == 0 and kk.kind == tkSemicolon: semis.add k
        inc k
    let inner = ps.tok(int(lo) + 1)
    let ctrl = inner.kind == tkKeyword and
               (inner.s == "if" or inner.s == "try" or inner.s == "when" or
                inner.s == "case" or inner.s == "block" or inner.s == "while" or
                inner.s == "for")
    if semis.len > 0 or ctrl:
      # nifler emits the `expr` node with inherited info (delta 0) and stamps the
      # `(` position on the leading `stmts` node — not the other way round.
      b.addTree "expr"
      ps.emitInfo(b, pl, pc, pl, pc, false)
      # leading statements (everything before the last `;`-part)
      b.addTree "stmts"
      ps.emitInfo(b, t.line, t.col, pl, pc, false)
      var segLo = int(lo) + 1
      for si in 0 ..< semis.len:
        # leading statements are children of the `stmts` node, which is anchored
        # at the `(` (t) — not the first inner token — so pass t as their parent.
        discard ps.parseStmt(b, segLo, t.line, t.col, semis[si])
        segLo = semis[si] + 1
      b.endTree()   # stmts
      # result expression = the final segment. As the result of a parenthesized
      # StmtListExpr, control-flow gets BARE bodies (not `(stmts …)`).
      let rt = ps.tok(segLo)
      if rt.kind == tkKeyword and rt.s == "try":
        ps.parseTryExpr(b, int32(segLo), int32(rpIdx), t.line, t.col)
      elif rt.kind == tkKeyword and rt.s == "if":
        ps.parseIfExpr(b, int32(segLo), int32(rpIdx), t.line, t.col, true, "if")
      elif rt.kind == tkKeyword and rt.s == "when":
        ps.parseIfExpr(b, int32(segLo), int32(rpIdx), t.line, t.col, true, "when")
      elif rt.kind == tkKeyword and rt.s == "case":
        ps.parseCaseExpr(b, int32(segLo), int32(rpIdx), t.line, t.col)
      elif rt.kind == tkKeyword and rt.s == "block":
        # `(block: s1; s2; …)` as an expression → `(block <label> (stmts …))`,
        # its `;`-separated body bounded by the paren (not the physical line).
        let bcolon = ps.findColon(segLo, rpIdx)
        b.addTree "block"
        ps.emitInfo(b, rt.line, rt.col, t.line, t.col, false)
        if segLo + 1 < bcolon and ps.tok(segLo + 1).kind == tkIdent:
          ps.emitName(b, ps.tok(segLo + 1), rt.line, rt.col)   # label
        else:
          b.addEmpty
        let first = ps.tok(bcolon + 1)
        b.addTree "stmts"
        ps.emitInfo(b, first.line, first.col, rt.line, rt.col, false)
        var sj = bcolon + 1
        while sj < rpIdx and ps.tok(sj).kind != tkEof:
          sj = ps.parseStmt(b, sj, first.line, first.col, rpIdx)
          if sj < rpIdx and ps.tok(sj).kind == tkSemicolon: inc sj
        b.endTree()   # stmts
        b.endTree()   # block
      else:
        ps.parseExprRange(b, int32(segLo), int32(rpIdx), t.line, t.col)
      b.endTree()   # expr
    else:
      let starts = ps.splitArgs(int(lo) + 1, rpIdx)
      let tag = if starts.len > 1: "tup" else: "par"
      b.addTree tag
      ps.emitInfo(b, t.line, t.col, pl, pc, false)
      ps.parseArgList(b, int32(int(lo) + 1), int32(rpIdx), t.line, t.col)
      b.endTree()
  of tkBracketLe:
    # `[a, b]` array/seq constructor -> `(bracket ...)`
    let rpIdx = ps.matchClose(int(lo))
    b.addTree "bracket"
    ps.emitInfo(b, t.line, t.col, pl, pc, false)
    ps.parseArgList(b, int32(int(lo) + 1), int32(rpIdx), t.line, t.col)
    b.endTree()
  of tkCurlyLe:
    # `{a, b}` set -> `(curly ...)`; `{k: v}` table -> `(tabconstr (kv ...))`
    let rpIdx = ps.matchClose(int(lo))
    let isTab = ps.depth0Colon(int(lo) + 1, rpIdx) >= 0
    b.addTree(if isTab: "tabconstr" else: "curly")
    ps.emitInfo(b, t.line, t.col, pl, pc, false)
    ps.parseArgList(b, int32(int(lo) + 1), int32(rpIdx), t.line, t.col)
    b.endTree()
  of tkIdent, tkKeyword:
    ps.emitName(b, t, pl, pc)
  else:
    b.addEmpty

proc parsePrimaryRange(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## Depth-guarding wrapper (see `enterDepth`): counts recursion nesting for
  ## `--max-depth`, then delegates. Off-by-default: inert when maxDepth == 0.
  ps.enterDepth(ps.tok(int(lo)).line)
  ps.parsePrimaryRangeImpl(b, lo, hi, pl, pc)
  dec ps.depth

proc parseExprRangeImpl(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  # Keyword-led expression forms must NOT be split by the operator scanner
  # (their conditions/bodies contain operators that are not top-level).
  let head = ps.tok(int(lo))
  if head.kind == tkKeyword and (head.s == "if" or head.s == "when" or
     head.s == "try" or head.s == "proc" or head.s == "func" or
     head.s == "iterator"):
    ps.parsePrimaryRange(b, lo, hi, pl, pc)
    return
  # A command call whose callee starts at `lo` binds LOOSER than binary operators
  # — `f a & b` is `f(a & b)`, not `(f a) & b` — so it must be recognised BEFORE
  # the operator split. (A command on the RHS of an operator, `p & f a`, is found
  # by the recursive parse of that operand; the `startsArg` guard rejects `p`'s
  # spaced binary operator so it does not masquerade as a command here.)
  block cmdLead:
    let ce = ps.cmdCalleeEnd(int(lo), int(hi))
    if head.kind == tkIdent and ce < int(hi) and ps.startsArg(ce, int(hi)):
      # EXPRESSION-context command (`commandExpr`): nkCommand.info = the FIRST
      # ARGUMENT's position (the cursor when the node is built), so the callee
      # gets a negative delta back to it. (Statement-context commands anchor at
      # the callee instead — see parse_stmt's parseCommand.)
      let arg0 = ps.tok(ce)
      b.addTree "cmd"
      ps.emitInfo(b, arg0.line, arg0.col, pl, pc, false)
      ps.parseExprRange(b, lo, int32(ce), arg0.line, arg0.col)
      ps.parseArgList(b, int32(ce), hi, arg0.line, arg0.col)
      b.endTree()
      return
  let split = ps.findSplit(int(lo), int(hi))
  if split < 0:
    ps.parsePrimaryRange(b, lo, hi, pl, pc)
  else:
    let op = ps.tok(split)
    b.addTree "infix"
    ps.emitInfo(b, op.line, op.col, pl, pc, false)   # infix node info = operator pos
    b.addIdent op.s
    ps.emitInfo(b, op.line, op.col, op.line, op.col, false)
    ps.parseExprRange(b, lo, int32(split), op.line, op.col)          # left
    ps.parseExprRange(b, int32(split) + 1, hi, op.line, op.col)      # right
    b.endTree()

proc parseExprRange(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32) =
  ## Depth-guarding wrapper (see `enterDepth`): counts recursion nesting for
  ## `--max-depth`, then delegates. Off-by-default: inert when maxDepth == 0.
  ps.enterDepth(ps.tok(int(lo)).line)
  ps.parseExprRangeImpl(b, lo, hi, pl, pc)
  dec ps.depth
