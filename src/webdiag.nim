## webdiag.nim — the syntactic-diagnostics side-channel used by the JS/web build.
##
## The classic native `nifler` (and nifparser's own file driver) only *parse* —
## they do not surface friendly syntax errors. The browser playground, however,
## wants Monaco squiggles, so the web entry (`webmain.nim`) collects a list of
## `Diag`s alongside the produced NIF.
##
## This module keeps that diagnostics layer OUT of the 8 core parser files
## (`tokens/lexer/parse_*/parsecore/parser`), which are synced byte-for-byte from
## the canonical `nifparser/src` and intentionally carry no diagnostics API. All
## the web-only reporting lives here instead.
##
## Two producers:
##   * `tokenizeD` — tokenize + return lexer-level diagnostics (unterminated
##     string / char / block-comment), via `lexDiags`.
##   * `bracketDiags` — a depth-tracking scan over the flat token list that flags
##     unmatched / mismatched / unclosed `()[]{}` brackets.

import tokens, lexer

type
  Diag* = object
    line*: int32     ## 1-based source line (as produced by the lexer)
    col*: int32      ## 0-based source column
    msg*: string     ## human-readable message

proc diag*(line, col: int32; msg: string): Diag =
  Diag(line: line, col: col, msg: msg)

# ---------------------------------------------------------------------------
# lexer-level diagnostics (unterminated literals / comments)
# ---------------------------------------------------------------------------
# The core lexer (byte-synced from canonical nifparser) parses leniently: it
# never aborts and emits no error tokens, so an unterminated `"…`, `'…`, or
# `#[ …` produces a perfectly valid token stream with no signal. Rather than
# fork the core lexer, we run a SECOND, purpose-built pass here that mirrors its
# top-level dispatch (initLexer/advance/startToken and the string/char/comment
# sub-lexers exactly) and reports the ones that never close. Positions match the
# core lexer's byte-based, 0-based column so the markers land where the tokens
# would. Numbers are consumed WITH their custom-literal `'suffix`, and idents as
# whole runs, so a suffix apostrophe or a mid-identifier `r"` is never mistaken
# for a char / raw-string start (which would be a false positive).

type
  Scan = object
    src: string
    n: int
    pos: int
    line: int32
    col: int32

proc scur(s: Scan): char =
  if s.pos < s.n: s.src[s.pos] else: '\0'

proc speek(s: Scan; k: int): char =
  let p = s.pos + k
  if p < s.n: s.src[p] else: '\0'

proc sadv(s: var Scan) =
  if s.pos < s.n:
    if s.src[s.pos] == '\n':
      inc s.line
      s.col = 0
    else:
      inc s.col
    inc s.pos

proc isDigitC(c: char): bool = c >= '0' and c <= '9'
proc isHexC(c: char): bool =
  isDigitC(c) or (c >= 'a' and c <= 'f') or (c >= 'A' and c <= 'F')
proc isIdentStartC(c: char): bool =
  c == '_' or (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z')
proc isIdentContC(c: char): bool =
  isIdentStartC(c) or isDigitC(c)

proc skipEscape(s: var Scan) =
  ## Mirror the core lexer's `decodeEscape` ADVANCE count; `s.cur` is the `\`.
  sadv s                                   # skip '\'
  let c = scur s
  case c
  of 'x', 'X':
    sadv s
    var k = 0
    while k < 2 and isHexC(scur s):
      sadv s
      inc k
  of 'u', 'U':
    sadv s
    if scur(s) == '{':
      sadv s
      while scur(s) != '}' and s.pos < s.n: sadv s
      if scur(s) == '}': sadv s
    else:
      var k = 0
      while k < 4 and isHexC(scur s):
        sadv s
        inc k
  of '0'..'9':
    while isDigitC(scur s): sadv s
  else:
    if s.pos < s.n: sadv s                 # single-char or invalid escape

proc scanNumber(s: var Scan) =
  ## Consume a numeric literal body plus any custom-literal `'suffix`, so the
  ## suffix apostrophe is never seen as a char-literal start.
  while s.pos < s.n:
    let ch = scur s
    if isHexC(ch) or ch == '_' or ch == 'x' or ch == 'X' or ch == 'o' or ch == 'O':
      sadv s
    elif ch == '.' and isDigitC(speek(s, 1)):
      sadv s
    else:
      break
  if scur(s) == '\'':
    sadv s
    while s.pos < s.n and isIdentContC(scur s): sadv s

proc scanString(s: var Scan; diags: var seq[Diag]) =
  ## normal `"…"` (mirrors lexString): closes on `"`, unterminated at EOL/EOF.
  let ln = s.line
  let cl = s.col
  sadv s                                   # opening "
  while s.pos < s.n and scur(s) != '"' and scur(s) != '\n':
    if scur(s) == '\\': skipEscape s
    else: sadv s
  if scur(s) == '"': sadv s
  else: diags.add diag(ln, cl, "unterminated string literal")

proc scanTriple(s: var Scan; diags: var seq[Diag]) =
  ## `"""…"""` (mirrors lexTripleString): closes on `"""` (not followed by `"`).
  let ln = s.line
  let cl = s.col
  sadv s; sadv s; sadv s                   # opening """
  var closed = false
  while s.pos < s.n:
    if scur(s) == '"' and speek(s, 1) == '"' and speek(s, 2) == '"' and speek(s, 3) != '"':
      sadv s; sadv s; sadv s
      closed = true
      break
    else:
      sadv s
  if not closed: diags.add diag(ln, cl, "unterminated triple-quoted string")

proc scanRawOrTriple(s: var Scan; diags: var seq[Diag]) =
  ## `r"…"` / `r"""…"""` (mirrors lexRawOrTriple); anchored at the `r` prefix.
  let ln = s.line
  let cl = s.col
  sadv s                                   # consume r/R
  if scur(s) == '"' and speek(s, 1) == '"' and speek(s, 2) == '"':
    sadv s; sadv s; sadv s                 # opening """
    var closed = false
    while s.pos < s.n:
      if scur(s) == '"' and speek(s, 1) == '"' and speek(s, 2) == '"' and speek(s, 3) != '"':
        sadv s; sadv s; sadv s
        closed = true
        break
      else:
        sadv s
    if not closed: diags.add diag(ln, cl, "unterminated raw triple-quoted string")
  else:
    sadv s                                 # opening "
    var closed = false
    while s.pos < s.n and scur(s) != '\n':
      if scur(s) == '"':
        if speek(s, 1) == '"':
          sadv s; sadv s                   # "" → a literal quote
        else:
          sadv s
          closed = true
          break
      else:
        sadv s
    if not closed: diags.add diag(ln, cl, "unterminated raw string literal")

proc scanChar(s: var Scan; diags: var seq[Diag]) =
  ## `'…'` (mirrors lexChar): one char or escape, then a closing `'`.
  let ln = s.line
  let cl = s.col
  sadv s                                   # opening '
  if scur(s) == '\\':
    skipEscape s
  else:
    if s.pos < s.n: sadv s
  if scur(s) == '\'': sadv s
  else: diags.add diag(ln, cl, "unterminated character literal")

proc lexDiags*(src: string): seq[Diag] =
  ## A second pass mirroring the core lexer's dispatch, reporting unterminated
  ## literals and block comments. Order of the branches matches `tokenize`.
  result = @[]
  var s = Scan(src: src, n: src.len, pos: 0, line: 1, col: 0)
  while s.pos < s.n:
    let c = scur s
    if c == '#':
      if speek(s, 1) == '[':
        let ln = s.line
        let cl = s.col
        sadv s; sadv s                     # #[
        var depth = 1
        while s.pos < s.n and depth > 0:
          if scur(s) == '#' and speek(s, 1) == '[':
            sadv s; sadv s; inc depth
          elif scur(s) == ']' and speek(s, 1) == '#':
            sadv s; sadv s; dec depth
          else: sadv s
        if depth > 0: result.add diag(ln, cl, "unclosed block comment '#[ ]#'")
      elif speek(s, 1) == '#' and speek(s, 2) == '[':
        let ln = s.line
        let cl = s.col
        sadv s; sadv s; sadv s             # ##[
        var depth = 1
        while s.pos < s.n and depth > 0:
          if scur(s) == '#' and speek(s, 1) == '#' and speek(s, 2) == '[':
            sadv s; sadv s; sadv s; inc depth
          elif scur(s) == ']' and speek(s, 1) == '#' and speek(s, 2) == '#':
            sadv s; sadv s; sadv s; dec depth
          else: sadv s
        if depth > 0: result.add diag(ln, cl, "unclosed doc comment '##[ ]##'")
      else:
        while s.pos < s.n and scur(s) != '\n': sadv s   # line comment
    elif c == '"':
      if speek(s, 1) == '"' and speek(s, 2) == '"': scanTriple(s, result)
      else: scanString(s, result)
    elif (c == 'r' or c == 'R') and speek(s, 1) == '"':
      scanRawOrTriple(s, result)
    elif c == '\'':
      scanChar(s, result)
    elif c == '`':
      sadv s                               # backquoted ident — skip its span
      while s.pos < s.n and scur(s) != '`' and scur(s) != '\n': sadv s
      if scur(s) == '`': sadv s
    elif isDigitC(c):
      scanNumber(s)
    elif isIdentStartC(c):
      while s.pos < s.n and isIdentContC(scur s): sadv s   # whole ident run
    else:
      sadv s

proc tokenizeD*(src: string): tuple[toks: seq[Token]; diags: seq[Diag]] =
  ## Tokenize `src`, returning the tokens plus lexer-level diagnostics
  ## (unterminated literals / comments). `bracketDiags` (folded in by webmain)
  ## then adds the bracket-balance checks over the token stream.
  result = (tokenize(src), lexDiags(src))

# ---------------------------------------------------------------------------
# bracket balancing
# ---------------------------------------------------------------------------

proc isOpenBracket(k: TokKind): bool =
  k == tkParLe or k == tkBracketLe or k == tkCurlyLe

proc isCloseBracket(k: TokKind): bool =
  k == tkParRi or k == tkBracketRi or k == tkCurlyRi

proc closerFor(k: TokKind): TokKind =
  ## The closing kind that matches an opening bracket kind.
  case k
  of tkParLe: tkParRi
  of tkBracketLe: tkBracketRi
  of tkCurlyLe: tkCurlyRi
  else: tkEof

proc bracketName(k: TokKind): string =
  ## `'()'` / `'[]'` / `'{}'` naming the bracket family of `k`.
  case k
  of tkParLe, tkParRi: "'()'"
  of tkBracketLe, tkBracketRi: "'[]'"
  of tkCurlyLe, tkCurlyRi: "'{}'"
  else: "''"

proc bracketDiags*(toks: seq[Token]): seq[Diag] =
  ## Scan the token list for unbalanced brackets, reporting one `Diag` each for:
  ##   * a closer with nothing open   → `unmatched closing '…'`
  ##   * a closer of the wrong family → `mismatched bracket: '…' opened at L:C closed by '…'`
  ##   * an opener never closed       → `unclosed '…'`
  result = @[]
  var stack: seq[Token] = @[]
  for i in 0 ..< toks.len:
    let ii = toks[i]
    if isOpenBracket(ii.kind):
      stack.add ii
    elif isCloseBracket(ii.kind):
      if stack.len == 0:
        result.add diag(ii.line, ii.col, "unmatched closing " & bracketName(ii.kind))
      else:
        let top = stack[stack.len - 1]
        if closerFor(top.kind) != ii.kind:
          result.add diag(ii.line, ii.col,
            "mismatched bracket: " & bracketName(top.kind) &
            " opened at " & $top.line & ":" & $(top.col + 1) &
            " closed by " & bracketName(ii.kind))
          discard stack.pop()
        else:
          discard stack.pop()
  for i in 0 ..< stack.len:
    let ii = stack[i]
    result.add diag(ii.line, ii.col, "unclosed " & bracketName(ii.kind))
