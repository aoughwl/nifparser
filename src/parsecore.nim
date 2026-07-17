## parsecore.nim — shared spine for the recursive-descent parser.
##
## This file is `include`d FIRST by parser.nim. It defines the `Parser` type,
## token-cursor helpers, line-info emission, operator classification, and the
## range-scanning utilities that every grammar area builds on.
##
## MODULE LAYOUT: the grammar is split across sibling include files —
##   parse_expr.nim   (expressions / operators / constructors)
##   parse_stmt.nim   (statements, control flow, var/let/const sections)
##   parse_type.nim   (type defs, routine/proc defs, params, pragmas)
## They are spliced (via `include`) AFTER this file, in the order expr → type →
## stmt. Cross-file calls resolve through the forward declarations in the block
## marked FORWARD DECLS at the bottom of this file — extend it when a proc in one
## area must be called from another before it is defined.

type
  Parser* = object
    toks: seq[Token]
    file: string
    curly*: bool   ## experimental: accept `{ … }` as a block body alongside `:`
    depth*: int    ## live recursion nesting through the main parse entry points
    maxDepth*: int ## abort ceiling for `depth` (0 = unlimited, the default)
    diags*: seq[Diagnostic]
                   ## GRAMMAR diagnostics recorded while parsing. The parser is
                   ## deliberately permissive — wherever a construct is malformed
                   ## it COPES (empty slot, sentinel guard, progress guard) so it
                   ## can keep going and still emit a tree. Every one of those
                   ## coping points is precisely an "expected X here" site, i.e.
                   ## exactly what the classic parser reports before it gives up.
                   ## Recording them here is what lets us match its error coverage
                   ## while keeping recovery. Never affects the emitted AIF.
    section*: string ## nifler's un-scoped `c.section` state: a var/let/const
                     ## section resets it to its own tag, but parsing a `(params)`
                     ## list (proc/proctype value or type) overwrites it to
                     ## "param" and it is NOT restored — so a section item that
                     ## FOLLOWS a proc-typed item inherits the `param` tag.

proc initParser*(toks: seq[Token]; file: string; curly = false;
                 maxDepth = 0): Parser =
  Parser(toks: toks, file: file, curly: curly, depth: 0, maxDepth: maxDepth)

proc perr(ps: var Parser; code, msg: string; t: Token; fix = "") =
  ## Record a GRAMMAR error at token `t` and keep parsing. Called from the
  ## parser's coping points (a missing `:`, a missing `in`, …) — the places the
  ## classic parser would abort at. `fix` is an optional suggested repair.
  ps.diags.add Diagnostic(severity: sevError, code: code, message: msg,
                          line: t.line, col: t.col, endCol: t.endCol, fix: fix)

proc perrAt(ps: var Parser; code, msg: string; line, col: int32; fix = "") =
  ## `perr` at a raw position, for coping points that hold a parent position
  ## rather than a token (e.g. `emitBody`, which only knows its branch anchor).
  ps.diags.add Diagnostic(severity: sevError, code: code, message: msg,
                          line: line, col: col, endCol: col, fix: fix)

proc perrRel(ps: var Parser; code, msg: string; t: Token; relMsg: string;
             rel: Token; fix = "") =
  ## `perr` plus a RELATED location (e.g. the `if` an `elif` branch belongs to).
  ## A related marker AT the error's own position is pure noise — that happens
  ## for a first `if`, where the branch keyword IS the construct keyword — so
  ## drop it and emit a plain error instead.
  if rel.line == t.line and rel.col == t.col:
    ps.perr(code, msg, t, fix)
    return
  ps.diags.add Diagnostic(severity: sevError, code: code, message: msg,
                          line: t.line, col: t.col, endCol: t.endCol, fix: fix,
                          relMsg: relMsg, relLine: rel.line, relCol: rel.col)

proc enterDepth(ps: var Parser; line: int32) =
  ## Bump the recursion counter and abort (non-zero exit) if `--max-depth` is
  ## in force and the nesting exceeds it. Callers pair this with `dec ps.depth`
  ## once the recursive entry returns. Cheap and inert when maxDepth == 0.
  inc ps.depth
  if ps.maxDepth > 0 and ps.depth > ps.maxDepth:
    write stderr, "aifparser: parse nesting exceeded --max-depth:" &
      $ps.maxDepth & " (near line " & $line & ")\n"
    quit 1

# ---------------------------------------------------------------------------
# token helpers
# ---------------------------------------------------------------------------

proc tok(ps: Parser; i: int): Token =
  if i >= 0 and i < ps.toks.len: ps.toks[i]
  else: ps.toks[ps.toks.len-1]  # EOF sentinel

proc isOpenBracket(k: TokKind): bool =
  k == tkParLe or k == tkBracketLe or k == tkCurlyLe

proc isCloseBracket(k: TokKind): bool =
  k == tkParRi or k == tkBracketRi or k == tkCurlyRi

# ---------------------------------------------------------------------------
# line-info emission (relative to parent node, or absolute at the module root)
# ---------------------------------------------------------------------------

proc emitInfo(ps: Parser; b: var Builder; nl, nc, pl, pc: int32; root: bool) =
  if root:
    b.attachLineInfo(nc, nl, ps.file)
  else:
    b.attachLineInfo(nc - pc, nl - pl, "")

proc opIsInfix(ps: Parser; i, lo: int): bool =
  ## Whether the binary-capable operator at `i` is used INFIX (vs prefix) here.
  ## Mirrors Nim's spacing rule: an operator with leading space but no trailing
  ## space (`f $v`, `echo -x`) is a PREFIX operator, not an infix split point.
  if i <= lo: return false                     # leading operator is always prefix
  let t = ps.tok(i)
  let prev = ps.tok(i - 1)
  let nxt = ps.tok(i + 1)
  let leadSpace = t.line != prev.line or t.col > prev.endCol
  let trailSpace = nxt.line != t.line or nxt.col > t.endCol
  if leadSpace and not trailSpace: return false
  result = true

proc startsArg(ps: Parser; i, hi: int): bool =
  ## Whether token `i` (the token right after a callee primary) begins a command
  ## argument: an expression atom, or a PREFIX operator (`echo -1`, `f $v`).
  ## A prefix arg has a space BEFORE the operator but not after; with no leading
  ## space the operator is infix (`c.len-1`), so it is not a command.
  let t = ps.tok(i)
  if t.kind == tkOperator:
    if i + 1 >= hi: return false
    let prev = ps.tok(i - 1)
    let leadSpace = t.line != prev.line or t.col > prev.endCol
    let nxt = ps.tok(i + 1)
    return leadSpace and nxt.line == t.line and nxt.col == t.endCol
  # A `{.` (pragma open) is NOT a command argument — it is a trailing pragma on
  # the preceding expression (`x {.noSideEffect.} => …` = `(pragmax x …)`), not a
  # set literal that `x` is applied to.
  if t.kind == tkCurlyLe and i + 1 < hi and ps.tok(i + 1).kind == tkDot:
    return false
  result = startsExpr(t) and not isBinaryOp(t)

proc cmdCalleeEnd(ps: Parser; lo, hi: int): int =
  ## End (exclusive) of the callee *primary* of a possible command call —
  ## the maximal postfix chain `head (.name | ADJACENT [..]/{..}/(..))*`. What
  ## remains in `[result, hi)` is the space-separated argument list, if any.
  var i = lo
  var endCol: int32
  if isOpenBracket(ps.tok(i).kind):
    let c = ps.matchClose(i)
    endCol = ps.tok(c).endCol
    i = c + 1
  else:
    endCol = ps.tok(i).endCol
    inc i
  while i < hi:
    let t = ps.tok(i)
    if t.kind == tkDot and i + 1 < hi:
      let nm = ps.tok(i + 1)
      endCol = nm.endCol
      i += 2
    elif isOpenBracket(t.kind) and t.line == ps.tok(i-1).line and t.col == endCol:
      let c = ps.matchClose(i)
      endCol = ps.tok(c).endCol
      i = c + 1
    elif (t.kind == tkStrLit or t.kind == tkRStrLit or t.kind == tkTripleStrLit) and
         t.line == ps.tok(i-1).line and t.col == endCol:
      # `ident"…"` generalized call-string-literal is a postfix, not a command.
      endCol = t.col            # nothing normally follows; block further adjacency
      inc i
    else:
      break
  result = i

proc emitName(ps: Parser; b: var Builder; t: Token; pl, pc: int32) =
  ## Emit an identifier atom, or `(quoted <pieces>)` for an accent-quoted ident
  ## (nifler keeps accent-quoting structural — see lexer `lexBackquotedIdent`).
  if t.quoted:
    b.addTree "quoted"
    ps.emitInfo(b, t.line, t.col, pl, pc, false)
    # each piece carries line-info at its real source column, relative to the
    # `quoted` node (nifler: `` `value=` `` → `value@1 =@6`).
    for i in 0 ..< t.parts.len:
      b.addIdent t.parts[i]
      let pcol = if i < t.partCols.len: t.partCols[i] else: t.col
      ps.emitInfo(b, t.line, pcol, t.line, t.col, false)
    b.endTree()
  else:
    b.addIdent t.s
    ps.emitInfo(b, t.line, t.col, pl, pc, false)

# ---------------------------------------------------------------------------
# operator classification
# ---------------------------------------------------------------------------

const BinaryKeywords = ["div", "mod", "shl", "shr", "and", "or", "xor",
                        "in", "notin", "is", "isnot", "of", "as", "from"]

proc isBinaryOp(t: Token): bool =
  if t.kind == tkKeyword:
    for k in BinaryKeywords:
      if k == t.s: return true
    return false
  elif t.kind == tkOperator:
    return t.s != "=" and t.s != "."
  else:
    return false

proc precedenceOf(t: Token): int =
  if t.kind == tkKeyword:
    case t.s
    of "div", "mod", "shl", "shr": return 9
    of "and": return 4
    of "or", "xor": return 3
    else: return 5
  if t.s == "..": return 6
  if t.s.len == 0: return 2
  # arrow-like operators (`->`, `~>`, `=>`) bind loosest → 0
  if t.s.len > 1 and t.s[t.s.len-1] == '>' and
     (t.s[t.s.len-2] == '-' or t.s[t.s.len-2] == '~' or t.s[t.s.len-2] == '='):
    return 0
  let c = t.s[0]
  # operators ending in `=` (but not the comparison group below) are assignment
  # operators and bind loosest (`+=`, `*=`, …) → 1. Mirrors Nim getPrecedence.
  let asgn = t.s[t.s.len-1] == '='
  case c
  of '$', '^': return (if asgn: 1 else: 10)
  of '*', '/', '%', '\\': return (if asgn: 1 else: 9)
  of '~': return 8
  of '+', '-', '|': return (if asgn: 1 else: 8)
  of '&': return (if asgn: 1 else: 7)
  of '=', '<', '>', '!': return 5
  of '.': return (if asgn: 1 else: 6)
  of '?': return 2
  else: return (if asgn: 1 else: 2)

proc startsExpr(t: Token): bool =
  case t.kind
  of tkIdent, tkKeyword, tkIntLit, tkFloatLit, tkStrLit, tkRStrLit,
     tkTripleStrLit, tkCharLit, tkParLe, tkBracketLe, tkCurlyLe,
     tkOperator:   # a leading operator is a prefix: `return -1`, `return @[…]`
    true
  else:
    false

# ---------------------------------------------------------------------------
# range scanning
# ---------------------------------------------------------------------------

proc continuesLine(prev: Token): bool =
  ## Whether a logical line continues onto the next physical line because `prev`
  ## (the last token before the newline) cannot legally end a statement: a
  ## trailing binary/assignment operator, a comma, or a dot.
  case prev.kind
  of tkComma, tkOperator, tkDot: true
  # a binary keyword operator (`and`, `shl`, `in`…) or the prefix `not` cannot
  # end a statement, so a physical line ending on one continues (`x and not⏎ (…)`).
  # `import`/`export`/`include`/`from` likewise dangle when their module list is on
  # the next indented line (`import⏎  std/[hashes, strutils]`).
  of tkKeyword:
    isBinaryOp(prev) or prev.s == "not" or prev.s == "import" or
    prev.s == "export" or prev.s == "include" or prev.s == "from"
  else: false

proc lineEnd(ps: Parser; startIdx: int): int =
  ## First token index at or after `startIdx` that begins a new logical line at
  ## paren-depth 0 (or EOF). Continuations inside brackets — and after a trailing
  ## operator/comma/dot (`continuesLine`) — keep the same logical line.
  var i = startIdx
  var depth = 0
  while ps.tok(i).kind != tkEof:
    let t = ps.tok(i)
    # A new physical line at depth 0 ends the logical line UNLESS the previous
    # token forces a continuation (a trailing binary/assign operator, comma, or
    # dot — you cannot end a Nim statement on one). Inside brackets (depth>0) a
    # newline is always a continuation. Checked BEFORE the bracket tally so a
    # `{`/`[`/`(` that *starts* the next line (e.g. a following `{.pop.}`) does
    # not glue the next line on.
    if depth == 0 and i > startIdx:
      let prev = ps.tok(i - 1)
      # A token only STARTS a new logical line if it is genuinely first on its
      # physical line (indent >= 0). `t.line != prev.line` alone is fooled by a
      # multi-line token (a triple-quoted string / long-string literal), whose
      # `line` is its START line: a token that follows the CLOSE on the same
      # physical line (`… """ == x`) has indent -1 and must stay a continuation.
      # A line that OPENS with a `.` is a method-chain continuation of the prior
      # line (`foo()⏎  .then(x)⏎  .catch(y)`), never a new statement.
      if t.indent >= 0 and t.line != prev.line and not continuesLine(prev) and
         t.kind != tkDot:
        # A DEEPER-indented `elif`/`else` on the next line continues an if/case
        # EXPRESSION (`return if c: a⏎   else: b`). A STATEMENT's `else` aligns
        # with its `if` (same indent), so the strict `>` keeps if-statements —
        # whose bodies lineEnd must not swallow — terminating correctly.
        let startIndent = ps.tok(startIdx).indent
        if t.kind == tkKeyword and (t.s == "elif" or t.s == "else") and
           startIndent >= 0 and t.indent > startIndent:
          discard        # continuation: fall through without breaking
        else:
          break
    if isOpenBracket(t.kind): inc depth
    elif isCloseBracket(t.kind):
      if depth > 0: dec depth
    inc i
  result = i

proc matchClose(ps: Parser; openIdx: int): int =
  ## Index of the bracket that closes the one at `openIdx`.
  var depth = 0
  var i = openIdx
  while ps.tok(i).kind != tkEof:
    let k = ps.tok(i).kind
    if isOpenBracket(k): inc depth
    elif isCloseBracket(k):
      dec depth
      if depth == 0: return i
    inc i
  result = i

proc lineIndentOf(ps: Parser; idx: int): int32 =
  ## Indentation of the physical line that token `idx` is on (scans back to the
  ## first-on-line token). For a mid-line keyword (`let x = try:`) this is the
  ## enclosing statement's indent, not the keyword's column.
  var i = idx
  while i > 0 and ps.tok(i).indent < 0: dec i
  result = if ps.tok(i).indent >= 0: ps.tok(i).indent else: ps.tok(idx).col

proc matchOpen(ps: Parser; closeIdx: int): int =
  ## Index of the bracket that opens the one at `closeIdx` (scans backward).
  var depth = 0
  var i = closeIdx
  while i >= 0:
    let k = ps.tok(i).kind
    if isCloseBracket(k): inc depth
    elif isOpenBracket(k):
      dec depth
      if depth == 0: return i
    dec i
  result = closeIdx

proc findSplit(ps: Parser; lo, hi: int; typeCtx = false): int =
  ## Rightmost lowest-precedence binary operator at depth 0 in `[lo, hi)`, or -1.
  ## In TYPE context (`typeCtx`) the prefix-type keywords `ptr`/`ref` also act as
  ## infix operators when they sit between operands (`nil ptr uint32` →
  ## `(infix ptr (nil) uint32)`); nifler gives them precedence 3 (like `or`).
  var depth = 0
  var bestPrec = 1000
  result = -1
  var i = lo
  while i < hi:
    let t = ps.tok(i)
    if isOpenBracket(t.kind): inc depth
    elif isCloseBracket(t.kind):
      if depth > 0: dec depth
    elif depth == 0 and i > lo and isBinaryOp(t) and ps.opIsInfix(i, lo):
      let p = precedenceOf(t)
      if p <= bestPrec:
        bestPrec = p
        result = i
    elif depth == 0 and i > lo and i + 1 < hi and typeCtx and
         t.kind == tkKeyword and (t.s == "ptr" or t.s == "ref" or t.s == "not") and
         # `ptr`/`ref`/`not` is infix ONLY between operands (`nil ptr uint32`, the
         # nilability constraint `cstring not nil`). When its left neighbour is a
         # binary operator or another `ptr`/`ref`, it is that operator's right
         # OPERAND, not an infix — e.g. in a type class
         # `SomeInteger | bool | ptr | pointer` the `|` binds and `ptr` is a bare
         # operand. Guarding on the previous token keeps the `|` chain splitting on
         # `|` (precedence 8) instead of on the `ptr` (precedence 3).
         not isBinaryOp(ps.tok(i - 1)) and
         # A left neighbour `:` means `ptr`/`ref` opens the TYPE after a return or
         # field colon (`proc (): ptr T {.cdecl.}`, `x: ref Y`), so it is a prefix
         # modifier of that type, not an infix — otherwise the whole proc type
         # mis-splits into `(infix ptr (proctype …) …)`.
         ps.tok(i - 1).kind != tkColon and
         # A left neighbour that is a PREFIX type modifier (`var ref T`, `sink ptr
         # X`, `lent ref Y`) makes `ref`/`ptr` that modifier's operand, not an
         # infix — otherwise `var ref T` mis-splits into `(infix ref (mut) T)`.
         ps.tok(i - 1).s notin ["ptr", "ref", "var", "out", "distinct"]:
      if 3 <= bestPrec:
        bestPrec = 3
        result = i
    inc i

proc findAssign(ps: Parser; lo, hi: int): int =
  ## Depth-0 bare `=` (assignment) in `[lo, hi)`, or -1.
  var depth = 0
  result = -1
  var i = lo
  while i < hi:
    let t = ps.tok(i)
    if isOpenBracket(t.kind): inc depth
    elif isCloseBracket(t.kind):
      if depth > 0: dec depth
    elif depth == 0 and t.kind == tkOperator and t.s == "=":
      return i
    inc i

proc splitArgs(ps: Parser; lo, hi: int): seq[int] =
  ## Comma boundaries (depth 0) within `[lo, hi)`; returns the start index of
  ## each argument. Empty when the range is empty.
  result = @[]
  if lo >= hi: return
  result.add lo
  var depth = 0
  var i = lo
  while i < hi:
    let t = ps.tok(i)
    if isOpenBracket(t.kind): inc depth
    elif isCloseBracket(t.kind):
      if depth > 0: dec depth
    elif depth == 0 and t.kind == tkComma:
      if i + 1 < hi: result.add(i + 1)
    inc i

proc splitPragmaItems(ps: Parser; lo, hi: int): seq[int] =
  ## Like `splitArgs`, but a pragma list separates items by a comma OR by a bare
  ## line break: Nim's parsePragma loops `exprColonEqExpr` and treats each logical
  ## line as an item, so `{.importc: "x", pure, final⏎ header: "y".}` has `final`
  ## and `header` as separate pragmas even with the comma missing. A depth-0
  ## newline whose previous token does not force a continuation starts a new item.
  result = @[]
  if lo >= hi: return
  result.add lo
  var depth = 0
  var i = lo
  while i < hi:
    let t = ps.tok(i)
    if isOpenBracket(t.kind): inc depth
    elif isCloseBracket(t.kind):
      if depth > 0: dec depth
    elif depth == 0 and i > lo:
      let prev = ps.tok(i - 1)
      if t.kind == tkComma:
        if i + 1 < hi: result.add(i + 1)
      elif prev.kind != tkComma and prev.kind != tkColon and
           t.line != prev.line and not continuesLine(prev):
        # A trailing `key:` colon dangling at end of line means the value sits on
        # the NEXT physical line (`{.deprecated:⏎ "msg".}`) — one item, not two.
        result.add i          # newline-separated item (missing comma)
    inc i

# ---------------------------------------------------------------------------
# FORWARD DECLS — cross-file call surface (append-only shared edit point)
# ---------------------------------------------------------------------------
# parse_expr.nim implements:
proc parseExprRange(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32)
proc parsePrimaryRange(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32)
proc parseCaseExpr(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32)
proc parseForExpr(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32; bare = true)
# parse_stmt.nim implements:
proc parseStmt(ps: var Parser; b: var Builder; startIdx: int; pl, pc: int32;
               hiLimit: int): int
proc parseCommand(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32;
                  singleArg = false)
proc parseTry(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int
proc parseTryExpr(ps: var Parser; b: var Builder; lo, hi, pl, pc: int32)
proc parsePostExprBlock(ps: var Parser; b: var Builder; headLo, colonIdx: int;
                        pl, pc: int32): int
proc skipTrailingDoc(ps: Parser; i, refIndent: int): int
proc parseRoutine(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32;
                  tag: string; hiBound: int = -1): int
# parse_type.nim implements:
proc parseType(ps: var Parser; b: var Builder; idx: int; pl, pc: int32): int
proc parseTypeSection(ps: var Parser; b: var Builder; kwIdx: int; pl, pc: int32): int
proc parsePragmas(ps: var Parser; b: var Builder; braceIdx: int; pl, pc: int32): int
