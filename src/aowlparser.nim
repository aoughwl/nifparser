## aowlparser — a nimony-native Nim-source parser that emits the SAME AIF as the
## classic `nifler`, so it can be compiled to JS (via nim_js) and run in the
## browser where classic-Nim `nifler` cannot.
##
## CLI (mirrors nifler):
##   aowlparser p <in.nim> [out.p.aif]     parse a Nim file, produce a AIF file
##
## When the output path is omitted it defaults to `<in>.p.aif`.
##
## This driver is intentionally a thin, top-level-init entry point with only
## file/stdout I/O so the same code path can later back a globalThis-driven JS
## build (no mmap, no PNode AST).

import std/[syncio, os]
import nifbuilder
import tokens, lexer, parser

type
  DiagFormat = enum dfText, dfJson, dfOff

proc closerFor(k: TokKind): char =
  ## The `)`/`]`/`}` character for a bracket kind. Accepts BOTH the open and the
  ## close kind: checkBrackets reports on the offending CLOSE token, so leaving
  ## `tkParRi`/`tkBracketRi` out of the match made every mismatched close print
  ## as `}` regardless of what it actually was.
  case k
  of tkParLe, tkParRi: ')'
  of tkBracketLe, tkBracketRi: ']'
  else: '}'

proc openerFor(k: TokKind): char =
  ## The `(`/`[`/`{` character for a bracket kind (either open or close kind).
  case k
  of tkParLe, tkParRi: '('
  of tkBracketLe, tkBracketRi: '['
  else: '{'

proc matchesClose(open, close: TokKind): bool =
  (open == tkParLe and close == tkParRi) or
  (open == tkBracketLe and close == tkBracketRi) or
  (open == tkCurlyLe and close == tkCurlyRi)

proc checkBrackets(toks: seq[Token]): seq[Diagnostic] =
  ## Structural check the range-splitter itself never reports: unbalanced or
  ## mismatched `()`/`[]`/`{}`. A stack of opens is matched against each close;
  ## a wrong or surplus close, and every open left unclosed at EOF, becomes a
  ## `sevError` diagnostic with the offending token's span. Purely a validator —
  ## it does not affect the emitted AIF (the parser stays best-effort).
  result = @[]
  var stack: seq[Token] = @[]
  for t in toks:
    case t.kind
    of tkParLe, tkBracketLe, tkCurlyLe:
      stack.add t
    of tkParRi, tkBracketRi, tkCurlyRi:
      if stack.len == 0:
        result.add Diagnostic(severity: sevError, code: "unmatched-close",
          message: "unmatched '" & closerFor(t.kind) & "'",
          line: t.line, col: t.col, endCol: t.col + 1)
      elif not matchesClose(stack[stack.len - 1].kind, t.kind):
        let top = stack[stack.len - 1]
        result.add Diagnostic(severity: sevError, code: "mismatched-bracket",
          message: "'" & closerFor(t.kind) & "' does not match '" &
                   openerFor(top.kind) & "'",
          line: t.line, col: t.col, endCol: t.col + 1,
          fix: "change it to '" & closerFor(top.kind) & "' or fix the opener",
          relMsg: "'" & openerFor(top.kind) & "' opened here",
          relLine: top.line, relCol: top.col)
        stack.setLen(stack.len - 1)
      else:
        stack.setLen(stack.len - 1)
    else: discard
  for t in stack:
    result.add Diagnostic(severity: sevError, code: "unclosed-bracket",
      message: "unclosed '" & openerFor(t.kind) & "'",
      line: t.line, col: t.col, endCol: t.col + 1,
      fix: "add a matching '" & closerFor(t.kind) & "'")

proc checkGrammar(toks: seq[Token]; opts: LexOptions): seq[Diagnostic] =
  ## Grammar-level errors the range-splitter silently copes with but nifler
  ## rejects. Purely a validator — never changes the emitted AIF. Conservative:
  ## every case here is UNAMBIGUOUSLY malformed (zero false positives on valid
  ## Nim), so `check` can flag it the way a real front end would.
  result = @[]
  # OPT-IN advisory: the C boolean operators `&&`/`||` (Nim uses `and`/`or`).
  # These ARE definable operators, so this fires ONLY under --c-operators:warn,
  # and it carries a suggestion, never an auto-fix — `and`/`or` bind at a
  # different precedence, so the rewrite needs a human's eye.
  if opts.cOperatorsWarn:
    for ci in 0 ..< toks.len:
      let t = toks[ci]
      if t.kind == tkOperator and (t.s == "&&" or t.s == "||"):
        let word = if t.s == "&&": "and" else: "or"
        result.add Diagnostic(severity: sevWarn, code: "c-style-operator",
          message: "'" & t.s & "' is not a Nim boolean operator — use '" & word & "'",
          line: t.line, col: t.col, endCol: t.endCol,
          fix: "use '" & word & "' (mind operator precedence)")
  # OPT-IN advisory: a redundant trailing `;`. Nim separates statements by
  # newline; a STATEMENT-LEVEL (depth-0) `;` that is the LAST significant token on
  # its line (ignoring a trailing comment) separates from nothing and is safely
  # removable. Crucially we track bracket depth: a `;` INSIDE `()`/`[]`/`{}` is a
  # parameter / generic / tuple separator (`proc f(a: int;\n b: int)`) and is NOT
  # redundant even when it ends a line — flagging it would be a false positive. A
  # `;` BETWEEN two statements on one line (`a; b`) is not last, so never flagged.
  if opts.semicolonWarn:
    var sdepth = 0
    for si in 0 ..< toks.len:
      let t = toks[si]
      if t.kind == tkParLe or t.kind == tkBracketLe or t.kind == tkCurlyLe:
        inc sdepth
      elif t.kind == tkParRi or t.kind == tkBracketRi or t.kind == tkCurlyRi:
        if sdepth > 0: dec sdepth
      elif t.kind == tkSemicolon and sdepth == 0:
        var n = si + 1
        while n < toks.len and toks[n].kind == tkComment: inc n
        if n >= toks.len or toks[n].kind == tkEof or toks[n].line != t.line:
          result.add Diagnostic(severity: sevWarn, code: "redundant-semicolon",
            message: "redundant trailing ';' — Nim separates statements by newline",
            line: t.line, col: t.col, endCol: t.endCol,
            fix: "remove the ';'")
  # `let`/`const` ALWAYS introduce a declaration, so the next significant token
  # must begin a name: an identifier, or `(` for a tuple unpack. Anything else —
  # a keyword (`let proc`), an operator, a literal, a closing bracket, EOF — is
  # what nifler reports as "identifier expected, but got 'X'".
  # (`var`/`type` are deliberately NOT checked: they double as TYPE modifiers, so
  # `x: var ptr int` legitimately puts a keyword right after them.)
  for i in 0 ..< toks.len:
    let k = toks[i]
    if k.kind != tkKeyword or (k.s != "let" and k.s != "const"): continue
    # next significant token
    var j = i + 1
    while j < toks.len and toks[j].kind == tkComment: inc j
    if j >= toks.len: continue
    let nx = toks[j]
    let namey = nx.kind == tkIdent or nx.kind == tkParLe
    if not namey and nx.kind != tkEof:
      result.add Diagnostic(severity: sevError, code: "identifier-expected",
        message: "identifier expected after '" & k.s & "', but got '" &
                 (if nx.kind == tkKeyword: "keyword " & nx.s
                  elif nx.s.len > 0: nx.s else: "token") & "'",
        line: nx.line, col: nx.col, endCol: nx.endCol)
    elif nx.kind == tkEof:
      result.add Diagnostic(severity: sevError, code: "identifier-expected",
        message: "identifier expected after '" & k.s & "'",
        line: k.line, col: k.col, endCol: k.endCol)
  # Assignment '=' inside an if/elif/while/when CONDITION — the classic `==` typo
  # (`if x = 5:`). A bare depth-0 `=` there is always malformed (assignment is not
  # an expression in Nim); named args use `=` only inside `()` (depth > 0), so
  # this cannot false-positive. nifler reports a generic "expected ':', but got
  # '='"; we say what actually went wrong and offer the fix.
  for i in 0 ..< toks.len:
    let k = toks[i]
    if k.kind != tkKeyword or (k.s != "if" and k.s != "elif" and
                               k.s != "while" and k.s != "when"): continue
    # EMPTY condition: the keyword is immediately followed by its `:` (`elif:`,
    # `if:`, `while:`). A condition is always required, so this is unambiguous.
    if i + 1 < toks.len and toks[i+1].kind == tkColon:
      result.add Diagnostic(severity: sevError, code: "expected-condition",
        message: "'" & k.s & "' requires a condition before ':'",
        line: k.line, col: k.col, endCol: k.endCol,
        fix: "add a condition, e.g. '" & k.s & " cond:'")
      continue
    # scan the condition: from after the keyword to the depth-0 `:` (or line end).
    var depth = 0
    var j = i + 1
    while j < toks.len:
      let t2 = toks[j]
      if t2.kind == tkEof: break
      if t2.kind == tkParLe or t2.kind == tkBracketLe or t2.kind == tkCurlyLe:
        inc depth
      elif t2.kind == tkParRi or t2.kind == tkBracketRi or t2.kind == tkCurlyRi:
        if depth > 0: dec depth else: break
      elif depth == 0 and t2.kind == tkColon: break
      elif depth == 0 and t2.line != k.line: break   # condition ended at newline
      elif depth == 0 and t2.kind == tkOperator and t2.s == "=":
        result.add Diagnostic(severity: sevError, code: "assignment-in-condition",
          message: "'=' assigns; this '" & k.s & "' condition needs a comparison",
          line: t2.line, col: t2.col, endCol: t2.endCol,
          fix: "did you mean '=='?")
        break
      inc j
  # `==` where `=` was meant in a `let`/`const`/`var` binding — the mirror of
  # `assignment-in-condition`. `let`/`const` are always statement-level (never a
  # type modifier, never nested in an expression), so at the keyword we are always
  # at depth 0. `var` ALSO doubles as a type modifier (`x: var int`), so we accept
  # it only when it is the FIRST significant token on its line — a binding
  # position, never a param/return-type modifier. The first depth-0 operator that
  # introduces the value must be `=`; a `==` reaching that position instead
  # compares and is always malformed. We STOP at the first depth-0 `=`, so
  # `let x = a == b` — a real comparison in the value — is never seen, and we only
  # look at the keyword's own line. Zero false positives on valid Nim.
  for i in 0 ..< toks.len:
    let k = toks[i]
    if k.kind != tkKeyword: continue
    let isBinding =
      if k.s == "let" or k.s == "const":
        true
      elif k.s == "var":
        # first significant (non-comment) token on its line?
        var p = i - 1
        while p >= 0 and toks[p].kind == tkComment: dec p
        p < 0 or toks[p].line != k.line
      else:
        false
    if not isBinding: continue
    var depth = 0
    var j = i + 1
    while j < toks.len:
      let t2 = toks[j]
      if t2.kind == tkEof or t2.line != k.line: break     # same line only
      if t2.kind == tkParLe or t2.kind == tkBracketLe or t2.kind == tkCurlyLe:
        inc depth
      elif t2.kind == tkParRi or t2.kind == tkBracketRi or t2.kind == tkCurlyRi:
        if depth > 0: dec depth
      elif depth == 0 and t2.kind == tkOperator and t2.s == "=":
        break                                              # a normal binding
      elif depth == 0 and t2.kind == tkOperator and t2.s == "==":
        result.add Diagnostic(severity: sevError, code: "comparison-in-binding",
          message: "'==' compares; a '" & k.s & "' binding needs '=' to assign",
          line: t2.line, col: t2.col, endCol: t2.endCol,
          fix: "did you mean '='?")
        break
      elif depth == 0 and t2.kind == tkOperator and t2.s == ":=":
        # `:=` is the Pascal/Go assignment; Nim binds with a plain `=`. (`:=`
        # lexes as ONE operator, distinct from a `:` type annotation, which is a
        # colon token — so `let x: int = 5` is never confused with `let x := 5`.)
        result.add Diagnostic(severity: sevError, code: "walrus-in-binding",
          message: "':=' assigns in Pascal/Go; a Nim '" & k.s & "' binding uses '='",
          line: t2.line, col: t2.col, endCol: t2.endCol,
          fix: "did you mean '='?")
        break
      inc j
  # `::` — the C++ scope-resolution habit (`std::vector`). Nim qualifies with `.`.
  # `:` is an operator char, so `::` lexes as a single OPERATOR token (never a
  # colon), and it is never a valid Nim operator (nifler rejects it). A `::` inside
  # a string/comment is part of THAT token, not an operator, so IPv6 `"::"` and doc
  # examples are never touched. Suggestion, not auto-fix: the repair is `.`
  # (qualify) or `:` (a mistyped annotation) — the author's call.
  for cci in 0 ..< toks.len:
    let t = toks[cci]
    if t.kind == tkOperator and t.s == "::":
      result.add Diagnostic(severity: sevError, code: "double-colon",
        message: "'::' is not valid Nim — use '.' to qualify (a.b), or a single ':'",
        line: t.line, col: t.col, endCol: t.endCol,
        fix: "use '.' to qualify (std.vector) or ':' for a type annotation")
  # `->` as a return-type arrow (`proc f() -> int`, a Rust/Python-3/C++ habit).
  # Nim writes the return type after a colon: `proc f(): int`. Found via the nifler
  # differential. Delicate: `->` is ALSO the std/sugar lambda-type operator
  # (`(int) -> int`), so we flag it ONLY at depth 0 in a ROUTINE HEADER — after a
  # routine keyword, before the header's own `:` (return type) or `=` (body). A
  # `->` in a return TYPE (`proc f(): (int) -> int`) sits after that `:` and is
  # never reached; a `->` defined/used as an operator (`macro \`->\``, a lambda in
  # a body) is not at header depth-0 either. Restricted to the keyword's own line
  # so a multi-line body can't be misread.
  const routineKw = ["proc", "func", "method", "iterator", "converter",
                     "template", "macro"]
  var ai = 0
  while ai < toks.len:
    let k = toks[ai]
    var isRoutine = false
    if k.kind == tkKeyword:
      for rk in routineKw:
        if k.s == rk: isRoutine = true
    if isRoutine:
      var depth = 0
      var j = ai + 1
      while j < toks.len:
        let t2 = toks[j]
        if t2.kind == tkEof or t2.line != k.line: break     # header on its line
        if t2.kind == tkParLe or t2.kind == tkBracketLe or t2.kind == tkCurlyLe:
          inc depth
        elif t2.kind == tkParRi or t2.kind == tkBracketRi or t2.kind == tkCurlyRi:
          if depth > 0: dec depth
        elif depth == 0 and t2.kind == tkColon:
          break                                             # valid return-type ':'
        elif depth == 0 and t2.kind == tkOperator and t2.s == "=":
          break                                             # body starts
        elif depth == 0 and t2.kind == tkOperator and t2.s == "->":
          result.add Diagnostic(severity: sevError, code: "arrow-return-type",
            message: "'->' is not a Nim return type — write the type after ':'",
            line: t2.line, col: t2.col, endCol: t2.endCol,
            fix: "write the return type after ':' — proc f(): T")
          break
        inc j
    inc ai
  # `else if` is not Nim — `else` must be followed by `:`, and the condition-chain
  # keyword is `elif`. Two ADJACENT keyword tokens `else` then `if` on the same
  # line are always this C/Python habit, never valid Nim: a real `else:` block that
  # contains an `if` has the `:` (a token) between them, so they are not adjacent.
  var ei = 0
  while ei + 1 < toks.len:
    let k = toks[ei]
    if k.kind == tkKeyword and k.s == "else":
      var j = ei + 1
      while j < toks.len and toks[j].kind == tkComment: inc j
      if j < toks.len and toks[j].kind == tkKeyword and toks[j].s == "if" and
         toks[j].line == k.line:
        result.add Diagnostic(severity: sevError, code: "else-if-not-elif",
          message: "'else if' is not Nim — use 'elif'",
          line: k.line, col: k.col, endCol: toks[j].endCol,
          fix: "replace 'else if' with 'elif'")
    inc ei
  # An EMPTY comma-separated slot — a doubled `,,` or a leading `(,`/`[,` — has
  # no expression where one is required, so nifler reports "expression expected,
  # but found ','". A TRAILING comma (`foo(a,)`, `[1,2,]`, `(1,)`) is valid Nim
  # and must NOT be flagged, so we only look at what comes BEFORE the comma:
  # another comma, or an opening `(`/`[`. This cannot false-positive.
  for i in 0 ..< toks.len:
    if toks[i].kind != tkComma: continue
    # previous significant (non-comment) token
    var p = i - 1
    while p >= 0 and toks[p].kind == tkComment: dec p
    if p < 0: continue
    let pk = toks[p].kind
    if pk == tkComma or pk == tkParLe or pk == tkBracketLe:
      result.add Diagnostic(severity: sevError, code: "expression-expected",
        message: "expression expected before ','",
        line: toks[i].line, col: toks[i].col, endCol: toks[i].endCol)
  # last significant (non-comment) token
  var last = -1
  for i in countdown(toks.len - 1, 0):
    if toks[i].kind != tkEof and toks[i].kind != tkComment:
      last = i; break
  if last < 0: return
  let t = toks[last]
  # An operator, comma, or dot as the FINAL token has no operand after it —
  # `let x = 1 +`, `foo(a,` (the bracket check also flags the paren), `a.` — so
  # nifler reports "expression expected". Even a *prefix* operator needs a
  # following operand, so ANY trailing operator is incomplete. `=` is excluded:
  # a proc header can legitimately end `= <body>` and a lone trailing `=` is
  # rare enough to leave to the bracket/indent checks.
  let kwOp = t.kind == tkKeyword and t.s in
    ["and", "or", "xor", "div", "mod", "shl", "shr", "in", "notin",
     "is", "isnot", "not", "of"]
  if t.kind == tkComma or t.kind == tkDot or
     (t.kind == tkOperator and t.s != "=") or kwOp:
    result.add Diagnostic(severity: sevError, code: "expression-expected",
      message: "expression expected after '" &
               (if t.kind == tkComma: "," elif t.kind == tkDot: "." else: t.s) &
               "'", line: t.line, col: t.col, endCol: t.endCol)

proc sortBySourceOrder(diags: var seq[Diagnostic]) =
  ## Stable insertion sort by (line, col) so `check`/JSON output reads
  ## top-to-bottom instead of validator-internal order. Diagnostic counts are
  ## tiny, so an O(n²) sort is fine and avoids a stdlib dependency.
  for i in 1 ..< diags.len:
    let cur = diags[i]
    var j = i - 1
    while j >= 0 and (diags[j].line > cur.line or
                      (diags[j].line == cur.line and diags[j].col > cur.col)):
      diags[j + 1] = diags[j]
      dec j
    diags[j + 1] = cur

proc sevName(s: Severity): string =
  case s
  of sevError: "error"
  of sevWarn: "warning"
  of sevHint: "hint"

proc jsonEscape(s: string): string =
  result = ""
  for c in s:
    case c
    of '"': result.add "\\\""
    of '\\': result.add "\\\\"
    of '\n': result.add "\\n"
    of '\t': result.add "\\t"
    of '\r': result.add "\\r"
    else:
      if c < ' ': result.add "\\u" & ["0000","0001","0002","0003","0004","0005",
        "0006","0007","0008","0009","000A","000B","000C","000D","000E","000F",
        "0010","0011","0012","0013","0014","0015","0016","0017","0018","0019",
        "001A","001B","001C","001D","001E","001F"][int(c)]
      else: result.add c

proc renderDiags(diags: seq[Diagnostic]; fileField: string; fmt: DiagFormat;
                 dest: File) =
  ## Emit diagnostics in the requested shape. `dfText` is a compiler-style
  ## `file:line:col: severity[code]: message` line each; `dfJson` is a single
  ## array of `{severity,code,message,line,col,endCol}` objects for editors.
  case fmt
  of dfOff: discard
  of dfText:
    for d in diags:
      write dest, fileField & ":" & $d.line & ":" & $(d.col + 1) & ": " &
        sevName(d.severity) & "[" & d.code & "]: " & d.message & "\n"
      # A related location and a suggested fix are rendered as indented notes,
      # the way a modern compiler does. The classic parser offers neither.
      if d.relMsg.len > 0:
        write dest, "  note: " & d.relMsg & " (" & fileField & ":" & $d.relLine &
          ":" & $(d.relCol + 1) & ")\n"
      if d.fix.len > 0:
        write dest, "  help: " & d.fix & "\n"
  of dfJson:
    var s = "["
    for i in 0 ..< diags.len:
      let d = diags[i]
      if i > 0: s.add ","
      s.add "{\"severity\":\"" & sevName(d.severity) & "\",\"code\":\"" &
        d.code & "\",\"message\":\"" & jsonEscape(d.message) &
        "\",\"line\":" & $d.line & ",\"col\":" & $d.col &
        ",\"endCol\":" & $d.endCol
      if d.fix.len > 0:
        s.add ",\"fix\":\"" & jsonEscape(d.fix) & "\""
      if d.relMsg.len > 0:
        s.add ",\"related\":{\"message\":\"" & jsonEscape(d.relMsg) &
          "\",\"line\":" & $d.relLine & ",\"col\":" & $d.relCol & "}"
      s.add "}"
    s.add "]\n"
    write dest, s

proc collectDiags(src: string; opts: LexOptions): (seq[Token], seq[Diagnostic]) =
  ## Tokenise and gather ALL diagnostics — the lexer's (unknown bytes, unclosed
  ## strings, style/portability warnings) plus the structural bracket check.
  ## Recoverable: tokens are returned regardless so the caller can still emit AIF.
  var errors = 0
  let toks = tokenize(src, opts, errors)
  var diags = gLexDiags
  for d in checkBrackets(toks): diags.add d
  for d in checkGrammar(toks, opts): diags.add d
  sortBySourceOrder(diags)   # source-order for top-to-bottom reading
  result = (toks, diags)

proc runParse(src, outp, fileField: string; toStdout, strict, curly: bool;
              opts: LexOptions; maxDepth: int; diagFmt: DiagFormat) =
  ## Tokenize `src`, parse it, and emit the AIF to `outp` (or stdout). Diagnostics
  ## (lexer + bracket check) are rendered to stderr in `diagFmt`; parsing is never
  ## aborted by them. With `strict`, any `sevError` diagnostic exits non-zero.
  let (toks, diags0) = collectDiags(src, opts)
  var ps = initParser(toks, fileField, curly, maxDepth)
  var diags = diags0
  if toStdout:
    # nifbuilder can target a file or an in-memory buffer; for stdout we build
    # in memory then stream the bytes out.
    var b = nifbuilder.open(4096)
    parseModule(ps, b)
    let s = b.extract()
    write stdout, s
  else:
    var b = nifbuilder.open(outp)
    parseModule(ps, b)
    b.close()
  # Grammar diagnostics are produced BY the parse, so they can only be merged
  # once it has run. Re-sort so lexer/bracket/grammar errors interleave in
  # source order.
  for d in ps.diags: diags.add d
  sortBySourceOrder(diags)
  renderDiags(diags, fileField, diagFmt, stderr)
  if strict:
    var nErr = 0
    for d in diags:
      if d.severity == sevError: inc nErr
    if nErr > 0:
      write stderr, "aowlparser: " & $nErr & " error(s) in input [--strict]\n"
      quit 1

proc usesSourceFilter(src: string): bool =
  ## A file whose first non-blank line is a `#?` filter directive (`#? stdtmpl`,
  ## `#? strip`, …) is NOT plain Nim — the compiler rewrites it through a
  ## source-code filter before parsing. We don't run filters, so any lexical
  ## "error" we'd report on the raw text (an apostrophe in HTML, a stray `>`)
  ## would be spurious. Detect the header and skip lexical linting entirely.
  var i = 0
  let n = src.len
  while i < n:
    # skip blank lines and leading horizontal whitespace
    while i < n and (src[i] == ' ' or src[i] == '\t' or src[i] == '\r' or
                     src[i] == '\n'): inc i
    if i >= n: return false
    # first real character of a line
    if src[i] == '#' and i + 1 < n and src[i+1] == '?': return true
    return false
  return false

proc runCheck(src, fileField: string; opts: LexOptions; diagFmt: DiagFormat;
              curly = false; maxDepth = 0): int =
  ## Lint-only mode (`aowlparser check`): emit diagnostics to STDOUT (text or json,
  ## default text) and no AIF. Returns the process exit code — 1 if any error-level
  ## diagnostic was found, else 0. This is the "better errors than nifler" surface:
  ## recoverable, multi-error, machine-readable, and it never aborts on the first.
  if usesSourceFilter(src):
    # Not plain Nim — needs a source-code filter we don't apply. Stay silent
    # (exit 0) rather than report spurious lexical errors on the raw template.
    return 0
  let (toks, diags0) = collectDiags(src, opts)
  var diags = diags0
  # GRAMMAR errors are discovered by parsing (each of the parser's coping points
  # is an "expected X here" site), so `check` runs a full parse and throws the
  # tree away. That is what gives lint mode the classic parser's error coverage
  # while still recovering past every one of them.
  var ps = initParser(toks, fileField, curly, maxDepth)
  var b = nifbuilder.open(4096)
  parseModule(ps, b)
  discard b.extract()
  for d in ps.diags: diags.add d
  sortBySourceOrder(diags)
  let fmt = if diagFmt == dfOff: dfText else: diagFmt
  renderDiags(diags, fileField, fmt, stdout)
  for d in diags:
    if d.severity == sevError: return 1
  return 0

proc usage() =
  write stderr, "aowlparser — Nim source -> AIF (nifler-compatible)\n"
  write stderr, "usage: aowlparser [OPTIONS] p <in.nim> [out.p.aif]\n"
  write stderr, "       aowlparser [OPTIONS] check <in.nim>   # lint only: diagnostics, no AIF\n"
  write stderr, "  --curly            experimental: also accept `{ … }` block bodies\n"
  write stderr, "  --tabs:MODE        indentation whitespace policy (default spaces):\n"
  write stderr, "                       spaces  spaces only (classic-Nim stance)\n"
  write stderr, "                       tabs    tabs allowed (advance tab-width cols)\n"
  write stderr, "                       both    tabs or spaces; mixing on one line warns\n"
  write stderr, "  --tab-width:N      columns a `\\t` advances when tabs permitted (default 8)\n"
  write stderr, "  --indent-width:N   advisory: warn when a line's indent isn't a multiple\n"
  write stderr, "                       of N columns (default 0 = disabled; never affects\n"
  write stderr, "                       parsing — the off-side rule stays relative)\n"
  write stderr, "  --indent-consistency  advisory: derive the indent step from the first\n"
  write stderr, "                       deeper line, then warn on any indent not a multiple\n"
  write stderr, "                       of it (default off; never affects parsing)\n"
  write stderr, "  --tab-stops:MODE   tab column advance when tabs permitted (default hard):\n"
  write stderr, "                       hard    additive (col += tab-width)\n"
  write stderr, "                       round   advance to next multiple of tab-width\n"
  write stderr, "  --final-newline:require  warn if the source lacks a terminating newline\n"
  write stderr, "                       (default off)\n"
  write stderr, "  --newline:MODE     assert an EOL convention (default any):\n"
  write stderr, "                       any     accept any line ending (current behavior)\n"
  write stderr, "                       lf      warn on any non-LF line ending\n"
  write stderr, "                       crlf    warn on any non-CRLF line ending\n"
  write stderr, "  --trailing-whitespace:warn  warn on any line with spaces/tabs before its\n"
  write stderr, "                       newline (default off; advisory only)\n"
  write stderr, "  --c-operators:warn   warn on the C boolean operators && / || (use and/or;\n"
  write stderr, "                       default off; advisory only)\n"
  write stderr, "  --semicolons:warn    warn on a redundant trailing ';' (default off)\n"
  write stderr, "  --bom:MODE         leading UTF-8 BOM handling (default: legacy skip):\n"
  write stderr, "                       strip   consume a BOM without shifting line-1 columns\n"
  write stderr, "                       reject  warn/error on a leading BOM\n"
  write stderr, "  --doc-comments:MODE  standalone doc comments (default on):\n"
  write stderr, "                       on      emit as a (comment) node (nifler behavior)\n"
  write stderr, "                       off     drop standalone doc comments entirely\n"
  write stderr, "  --strict           exit non-zero if the lexer hit an unknown/illegal byte\n"
  write stderr, "                       (default off: such bytes are skipped, exit 0)\n"
  write stderr, "  --max-depth:N      abort with non-zero exit if parse nesting exceeds N\n"
  write stderr, "                       (default 0 = unlimited)\n"
  write stderr, "  --stdin            read source from stdin (also: input arg `-`)\n"
  write stderr, "  --stdout           write AIF to stdout (also: output arg `-`)\n"
  write stderr, "  --filename:PATH    line-info path to record for stdin (default `stdin`)\n"
  write stderr, "  --diagnostics:MODE   how diagnostics are rendered (default text):\n"
  write stderr, "                       text  compiler-style file:line:col lines\n"
  write stderr, "                       json  a JSON array (for editors/tools)\n"
  write stderr, "                       off   suppress diagnostics\n"
  write stderr, "  --portable-paths:on|off\n"
  write stderr, "                       record the source path relative to cwd with '/'\n"
  write stderr, "                       separators (default on; matches nifler)\n"
  quit 1

proc hasPrefix(s, pre: string): bool =
  if s.len < pre.len: return false
  for i in 0 ..< pre.len:
    if s[i] != pre[i]: return false
  return true

proc afterColon(s: string): string =
  ## Text following the first `:` (the option value).
  var i = 0
  while i < s.len and s[i] != ':': inc i
  if i < s.len: inc i   # skip the colon
  result = ""
  while i < s.len:
    result.add s[i]
    inc i

proc parseIntOr(s: string; dflt: int): int =
  ## Decimal parse of an option value; returns `dflt` if `s` has no digits.
  var v = 0
  var any = false
  for i in 0 ..< s.len:
    let c = s[i]
    if c >= '0' and c <= '9':
      v = v * 10 + (ord(c) - ord('0'))
      any = true
    else:
      return dflt
  if any: v else: dflt

proc main() =
  # Collect positional args, filtering the option flags (index loop: nimony's
  # borrow checker rejects `for x in commandLineParams()`).
  var params: seq[string] = @[]
  var curly = false
  var opts = defaultLexOptions
  var strict = false
  var maxDepth = 0
  var useStdin = false
  var useStdout = false
  var filenameOverride = ""
  var portablePaths = true   # nifler default: relativize the source path to cwd
  var diagFmt = dfText       # how diagnostics are rendered (text|json|off)
  let cli = commandLineParams()
  for ci in 0 ..< cli.len:
    let a = cli[ci]
    if a == "--curly":
      curly = true
    elif a == "--strict":
      strict = true
    elif a == "--stdin":
      useStdin = true
    elif a == "--stdout":
      useStdout = true
    elif a == "--indent-consistency":
      opts.indentConsistency = true
    elif hasPrefix(a, "--tabs:"):
      case afterColon(a)
      of "spaces": opts.tabPolicy = tpSpaces
      of "tabs": opts.tabPolicy = tpTabs
      of "both": opts.tabPolicy = tpBoth
      else:
        write stderr, "unknown --tabs mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--tab-width:"):
      opts.tabWidth = parseIntOr(afterColon(a), opts.tabWidth)
      if opts.tabWidth < 1: opts.tabWidth = 1
    elif hasPrefix(a, "--indent-width:"):
      opts.indentWidth = parseIntOr(afterColon(a), opts.indentWidth)
      if opts.indentWidth < 0: opts.indentWidth = 0
    elif hasPrefix(a, "--tab-stops:"):
      case afterColon(a)
      of "hard": opts.tabStops = tsHard
      of "round": opts.tabStops = tsRound
      else:
        write stderr, "unknown --tab-stops mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--final-newline:"):
      case afterColon(a)
      of "require": opts.finalNewlineRequire = true
      else:
        write stderr, "unknown --final-newline mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--newline:"):
      case afterColon(a)
      of "any": opts.newlinePolicy = nlAny
      of "lf": opts.newlinePolicy = nlLf
      of "crlf": opts.newlinePolicy = nlCrlf
      else:
        write stderr, "unknown --newline mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--trailing-whitespace:"):
      case afterColon(a)
      of "warn": opts.trailingWhitespaceWarn = true
      else:
        write stderr, "unknown --trailing-whitespace mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--c-operators:"):
      case afterColon(a)
      of "warn": opts.cOperatorsWarn = true
      else:
        write stderr, "unknown --c-operators mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--semicolons:"):
      case afterColon(a)
      of "warn": opts.semicolonWarn = true
      else:
        write stderr, "unknown --semicolons mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--bom:"):
      case afterColon(a)
      of "strip": opts.bomPolicy = bomStrip
      of "reject": opts.bomPolicy = bomReject
      else:
        write stderr, "unknown --bom mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--doc-comments:"):
      case afterColon(a)
      of "on": opts.docComments = true
      of "off": opts.docComments = false
      else:
        write stderr, "unknown --doc-comments mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--max-depth:"):
      maxDepth = parseIntOr(afterColon(a), maxDepth)
      if maxDepth < 0: maxDepth = 0
    elif hasPrefix(a, "--filename:"):
      filenameOverride = afterColon(a)
    elif hasPrefix(a, "--portable-paths:"):
      case afterColon(a)
      of "on": portablePaths = true
      of "off": portablePaths = false
      else:
        write stderr, "unknown --portable-paths mode: " & afterColon(a) & "\n"
        usage()
    elif hasPrefix(a, "--diagnostics:"):
      case afterColon(a)
      of "text": diagFmt = dfText
      of "json": diagFmt = dfJson
      of "off": diagFmt = dfOff
      else:
        write stderr, "unknown --diagnostics mode: " & afterColon(a) & "\n"
        usage()
    else:
      params.add a
  if params.len < 1:
    usage()
  let action = params[0]
  if action != "p" and action != "parse" and action != "check":
    write stderr, "unknown command: " & action & "\n"
    usage()
  # Positional args after the action: [input] [output]. `-` at either slot means
  # stdin/stdout, mirroring the `--stdin`/`--stdout` flags.
  var inputArg = ""
  var outputArg = ""
  if params.len >= 2: inputArg = params[1]
  if params.len >= 3: outputArg = params[2]
  if inputArg == "-": useStdin = true
  if outputArg == "-": useStdout = true
  if not useStdin and inputArg == "":
    write stderr, "no input file (use a path, `-`, or --stdin)\n"
    usage()
  # Read the source.
  var src = ""
  if useStdin:
    try:
      src = readAll(stdin)
    except:
      write stderr, "cannot read from stdin\n"
      quit 1
  else:
    try:
      src = readFile(inputArg)
    except:
      write stderr, "cannot read file: " & inputArg & "\n"
      quit 1
  # `fileField` is the path written into AIF line-info suffixes. nifler's default
  # (portablePaths=true) records the source path RELATIVE to the current working
  # directory with '/' separators — so the output is byte-identical regardless of
  # whether the caller passed a relative or absolute path. We mirror that exactly
  # (relativePath(absolutePath(input), cwd, '/')); `--portable-paths:off` keeps the
  # path verbatim. For stdin use `--filename:` if given, else the placeholder.
  var fileField = inputArg
  if useStdin:
    fileField = if filenameOverride.len > 0: filenameOverride else: "stdin"
  elif portablePaths:
    try:
      fileField = relativePath(absolutePath(inputArg), getCurrentDir(), '/')
    except:
      discard   # unresolvable path → keep the arg verbatim
  # `check` is lint-only: diagnostics to stdout, no AIF, exit 1 on any error.
  if action == "check":
    quit runCheck(src, fileField, opts, diagFmt, curly, maxDepth)
  # Resolve the output target.
  var outp = ""
  if not useStdout:
    if outputArg != "" and outputArg != "-":
      outp = outputArg
      let n = outp.len
      if n < 4 or outp[n-4 .. n-1] != ".aif":
        outp = outp & ".aif"
    elif useStdin:
      # No output path and reading stdin → default to stdout.
      useStdout = true
    else:
      outp = inputArg & ".p.aif"
  runParse(src, outp, fileField, useStdout, strict, curly, opts, maxDepth, diagFmt)

main()
