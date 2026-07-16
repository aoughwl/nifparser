## lexer.nim — full hand-written Nim lexer for aifparser.
##
## Produces the `Token` stream defined in `tokens.nim`. It is written to match
## the classic Nim lexer (`Nim/compiler/lexer.nim`) closely enough that the
## recursive-descent parser can reproduce native `nifler`'s AIF output.
##
## Coverage
## --------
## * identifiers & keywords, operators (all operator chars, multi-char),
##   punctuation `( ) [ ] { } , ; : .`, backtick-quoted identifiers.
## * numeric literals: bases `0x`/`0o`/`0b`/`0c` and decimal, `_` digit
##   separators (both DECODED — nifler emits decimal only, base/underscores are
##   LOST), float literals with `.` fraction and `e`/`E` exponent, and typed
##   suffixes `'i8`.. / `'u`.. / `'f32`.. recorded in `Token.suffix`.
## * strings: `"..."` (Nim escapes decoded to raw bytes), `r"..."`
##   (tkRStrLit), `"""..."""` / `r"""..."""` (tkTripleStrLit), char `'c'`
##   with escapes (tkCharLit, iVal = decoded byte value).
## * significant indentation on `Token.indent` (leading column of the line the
##   token starts on; -1 otherwise), 1-based `line`, 0-based `col`.
## * comments `#...` and nested block comments `#[ ... ]#` (skipped).

import tokens
import std/[parseutils, syncio]

type
  TabPolicy* = enum
    ## What leading whitespace is accepted for *indentation*.
    tpSpaces   ## spaces only (classic-Nim stance; DEFAULT). A stray `\t`
               ## advances a single column, exactly as before.
    tpTabs     ## tabs allowed for indentation; a `\t` advances `tabWidth` cols.
    tpBoth     ## either tabs or spaces; a line that MIXES both in its leading
               ## whitespace is reported (non-fatal) on stderr.

  NewlinePolicy* = enum
    ## Asserted end-of-line convention (advisory; never alters AIF).
    nlAny      ## DEFAULT: accept any line ending (CR is normalised as before).
    nlLf       ## warn on stderr for each line ending that is not bare LF.
    nlCrlf     ## warn on stderr for each line ending that is not CRLF.

  BomPolicy* = enum
    ## Handling of a leading UTF-8 BOM (`EF BB BF`).
    bomDefault ## DEFAULT: legacy behaviour (a BOM is skipped as 3 unknown
               ## bytes, which shifts line-1 column — a latent bug, left as-is).
    bomStrip   ## consume a leading BOM WITHOUT advancing the column, so line-1
               ## indent/col are unaffected.
    bomReject  ## warn on stderr (and count an error) when a BOM is present.

  TabStops* = enum
    ## How a `\t` advances the column when tabs are permitted.
    tsHard     ## DEFAULT (legacy): additive, `col += tabWidth`.
    tsRound    ## real tab stop: advance to the next multiple of `tabWidth`.

  LexOptions* = object
    ## Whitespace / indentation policy threaded into `tokenize`. The zero value
    ## (`defaultLexOptions`) reproduces the historical, nifler-compatible
    ## behaviour byte-for-byte.
    tabPolicy*: TabPolicy   ## default tpSpaces
    tabWidth*: int          ## columns a `\t` advances when tabs are permitted
                            ## (default 8, the classic Nim/editor tab stop).
                            ## Ignored under tpSpaces.
    indentWidth*: int       ## advisory columns-per-indent-level (0 = disabled,
                            ## the default). When >0, first-on-line tokens whose
                            ## indent column is not a multiple of N are reported
                            ## on stderr; parsing is NEVER affected.
    finalNewlineRequire*: bool ## when true, warn on stderr if the source does
                            ## not end with a terminating newline (default off).
    newlinePolicy*: NewlinePolicy ## assert an EOL convention (default nlAny).
    trailingWhitespaceWarn*: bool ## when true, warn for any physical line with
                            ## spaces/tabs before its newline (default off).
    bomPolicy*: BomPolicy   ## leading-BOM handling (default bomDefault).
    indentConsistency*: bool ## advisory: warn when first-on-line tokens disagree
                            ## on the file's indentation step (default off).
    tabStops*: TabStops     ## tab-advance mode when tabs permitted (default tsHard).
    docComments*: bool      ## true (default) = emit standalone doc comments as a
                            ## `(comment)` node; false = drop them entirely.

const
  defaultLexOptions* = LexOptions(tabPolicy: tpSpaces, tabWidth: 8, indentWidth: 0,
    finalNewlineRequire: false, newlinePolicy: nlAny, trailingWhitespaceWarn: false,
    bomPolicy: bomDefault, indentConsistency: false, tabStops: tsHard,
    docComments: true)

type
  Lexer = object
    src: string
    n: int
    pos: int
    line: int32
    col: int32
    atLineStart: bool  ## no significant token emitted on the current line yet
    opts: LexOptions
    sawSpaceInIndent: bool   ## tpBoth mixing detection: state for current line
    sawTabInIndent: bool
    warnedMixThisLine: bool
    errors: int              ## unknown/illegal bytes seen (drives --strict)
    prevIndent: int32        ## indent column of the previous first-on-line token
    indentUnit: int32        ## derived indentation step (--indent-consistency)
    diags: seq[Diagnostic]   ## structured, recoverable diagnostics (see Diagnostic)

proc initLexer(src: string; opts: LexOptions): Lexer =
  Lexer(src: src, n: src.len, pos: 0, line: 1, col: 0, atLineStart: true,
        opts: opts, errors: 0, prevIndent: 0, indentUnit: 0, diags: @[])

template addDiag(lx: var Lexer; sev: Severity; dcode, dmsg: string;
                 dline, dcol, dend: int32) =
  ## Record one structured diagnostic. This is the single seam every check funnels
  ## through — adding a new lexer/parser check is just another `addDiag` call, and
  ## `sevError` diagnostics also bump the `--strict` error count. Never aborts.
  ## A template (not a proc) so a call may read `lx.*` fields in its arguments
  ## without tripping nimony's var-parameter alias check; params are prefixed so
  ## template substitution does not clash with the `Diagnostic` field labels.
  lx.diags.add Diagnostic(severity: sev, code: dcode, message: dmsg,
                          line: dline, col: dcol, endCol: dend)
  if sev == sevError: inc lx.errors

var gLexDiags*: seq[Diagnostic] = @[]
  ## Diagnostics from the most recent `tokenize` (aifparser is single-shot per
  ## file, so a module accumulator is enough; the CLI reads it after tokenising).
  ## Parser-level checks append here too — see `checkBrackets`.

proc toHex2(b: uint8): string =
  const hex = "0123456789ABCDEF"
  result = newString(2)
  result[0] = hex[int(b shr 4)]
  result[1] = hex[int(b and 0x0F)]

proc cur(lx: Lexer): char =
  if lx.pos < lx.n: lx.src[lx.pos] else: '\0'

proc peek(lx: Lexer; k: int): char =
  let p = lx.pos + k
  if p < lx.n: lx.src[p] else: '\0'

proc advance(lx: var Lexer) =
  if lx.pos < lx.n:
    let ch = lx.src[lx.pos]
    if ch == '\n':
      inc lx.line
      lx.col = 0
      lx.atLineStart = true
      lx.sawSpaceInIndent = false
      lx.sawTabInIndent = false
      lx.warnedMixThisLine = false
    elif ch == '\t' and lx.opts.tabPolicy != tpSpaces:
      # A tab counts as `tabWidth` columns once tabs are permitted, so a
      # tab-indented line reports the same `indent` as its space-expanded
      # equivalent. Under tpSpaces we fall through to width-1 (legacy) below.
      # tsRound advances to the next multiple of tabWidth (real tab stop);
      # tsHard (default) is additive. They agree at column 0 (indentation),
      # differing only for a tab that follows mid-line content.
      if lx.opts.tabStops == tsRound:
        let w = int32(lx.opts.tabWidth)
        lx.col = ((lx.col div w) + 1'i32) * w
      else:
        inc lx.col, int32(lx.opts.tabWidth)
    else:
      inc lx.col
    inc lx.pos

proc isIdentStart(c: char): bool =
  c == '_' or (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z')

proc isIdentCont(c: char): bool =
  isIdentStart(c) or (c >= '0' and c <= '9')

proc isDigit(c: char): bool =
  c >= '0' and c <= '9'

proc isHexDigit(c: char): bool =
  isDigit(c) or (c >= 'a' and c <= 'f') or (c >= 'A' and c <= 'F')

proc hexVal(c: char): int =
  if c >= '0' and c <= '9': ord(c) - ord('0')
  elif c >= 'a' and c <= 'f': ord(c) - ord('a') + 10
  elif c >= 'A' and c <= 'F': ord(c) - ord('A') + 10
  else: -1

const OperatorChars = {'+', '-', '*', '/', '\\', '<', '>', '=', '@', '$', '~',
                       '&', '%', '|', '!', '?', '^', '.', ':'}

proc startToken(lx: var Lexer; kind: TokKind): Token =
  result = initToken(kind, lx.line, lx.col)
  if lx.atLineStart:
    result.indent = lx.col
    # Advisory: --indent-width validation. Purely diagnostic; never alters the
    # recorded indent, so parsing (the relative off-side rule) is untouched.
    if lx.opts.indentWidth > 0 and lx.col > 0 and
       (int(lx.col) mod lx.opts.indentWidth) != 0:
      lx.addDiag(sevHint, "indent-width",
                 "indentation of " & $lx.col & " column(s) is not a multiple of " &
                 "--indent-width:" & $lx.opts.indentWidth, lx.line, 0, lx.col)
    # Advisory: --indent-consistency. The indentation *step* is auto-derived from
    # the first line that indents deeper than its predecessor; thereafter any
    # first-on-line token whose column is not a whole multiple of that derived
    # unit is flagged (a pragmatic, purely lexer-level approximation of "sibling
    # lines disagree on their indent step"). Never alters the recorded indent.
    if lx.opts.indentConsistency:
      if lx.indentUnit == 0 and lx.col > lx.prevIndent:
        lx.indentUnit = lx.col - lx.prevIndent
      if lx.indentUnit > 0 and lx.col > 0 and (lx.col mod lx.indentUnit) != 0:
        lx.addDiag(sevHint, "indent-consistency",
                   "indentation of " & $lx.col & " column(s) is not a multiple of " &
                   "the file's indent step (" & $lx.indentUnit & ") [--indent-consistency]",
                   lx.line, 0, lx.col)
      lx.prevIndent = lx.col

# ---------------------------------------------------------------------------
# escape decoding (mirrors classic getEscapedChar) — appends RAW decoded bytes
# ---------------------------------------------------------------------------

proc addUtf8(s: var string; cp: int) =
  ## Inlined UTF-8 encoding (matches classic addUnicodeCodePoint).
  let i = cp
  if i <= 0x7F:
    s.add chr(i and 0xFF)
  elif i <= 0x7FF:
    s.add chr((i shr 6) or 0xC0)
    s.add chr((i and 0x3F) or 0x80)
  elif i <= 0xFFFF:
    s.add chr((i shr 12) or 0xE0)
    s.add chr(((i shr 6) and 0x3F) or 0x80)
    s.add chr((i and 0x3F) or 0x80)
  else:
    s.add chr((i shr 18) or 0xF0)
    s.add chr(((i shr 12) and 0x3F) or 0x80)
    s.add chr(((i shr 6) and 0x3F) or 0x80)
    s.add chr((i and 0x3F) or 0x80)

proc decodeEscape(lx: var Lexer; s: var string) =
  ## `lx.cur` is the backslash; decode one escape into `s`.
  advance lx # skip '\'
  let c = lx.cur
  case c
  of 'n', 'N': s.add '\x0A'; advance lx
  of 'p', 'P': s.add '\x0A'; advance lx
  of 'r', 'R', 'c', 'C': s.add '\x0D'; advance lx
  of 'l', 'L': s.add '\x0A'; advance lx
  of 'f', 'F': s.add '\x0C'; advance lx
  of 'e', 'E': s.add '\x1B'; advance lx
  of 'a', 'A': s.add '\x07'; advance lx
  of 'b', 'B': s.add '\x08'; advance lx
  of 'v', 'V': s.add '\x0B'; advance lx
  of 't', 'T': s.add '\x09'; advance lx
  of '\'', '\"', '\\': s.add c; advance lx
  of 'x', 'X':
    advance lx
    var xi = 0
    var k = 0
    while k < 2 and isHexDigit(lx.cur):
      xi = (xi shl 4) or hexVal(lx.cur)
      advance lx
      inc k
    s.add chr(xi and 0xFF)
  of 'u', 'U':
    advance lx
    var xi = 0
    if lx.cur == '{':
      advance lx
      while lx.cur != '}' and lx.pos < lx.n:
        if isHexDigit(lx.cur):
          xi = (xi shl 4) or hexVal(lx.cur)
        advance lx
      if lx.cur == '}': advance lx
    else:
      var k = 0
      while k < 4 and isHexDigit(lx.cur):
        xi = (xi shl 4) or hexVal(lx.cur)
        advance lx
        inc k
    addUtf8(s, xi)
  of '0'..'9':
    var xi = 0
    while isDigit(lx.cur):
      xi = xi * 10 + (ord(lx.cur) - ord('0'))
      advance lx
    s.add chr(xi and 0xFF)
  else:
    # invalid escape — pass the char through verbatim
    if lx.pos < lx.n:
      s.add c
      advance lx

# ---------------------------------------------------------------------------
# string / char literals
# ---------------------------------------------------------------------------

proc lexTripleString(lx: var Lexer; raw: bool): Token =
  ## `"""..."""` (and `r"""..."""`). No escape processing; `"""` closes when
  ## not immediately followed by another `"`.
  result = startToken(lx, tkTripleStrLit)
  advance lx; advance lx; advance lx # opening """
  # skip a single leading newline (optionally after horizontal whitespace)
  if lx.cur == ' ' or lx.cur == '\t':
    var save = lx
    while lx.cur == ' ' or lx.cur == '\t': advance lx
    if lx.cur == '\r' or lx.cur == '\n':
      discard
    else:
      lx = save
  if lx.cur == '\r':
    advance lx
    if lx.cur == '\n': advance lx
  elif lx.cur == '\n':
    advance lx
  var s = ""
  while lx.pos < lx.n:
    if lx.cur == '"' and lx.peek(1) == '"' and lx.peek(2) == '"' and
       lx.peek(3) != '"':
      advance lx; advance lx; advance lx
      break
    elif lx.cur == '\r':
      advance lx
      if lx.cur == '\n': advance lx
      s.add '\n'
    elif lx.cur == '\n':
      advance lx
      s.add '\n'
    else:
      s.add lx.cur
      advance lx
  result.s = s

proc lexRawString(lx: var Lexer): Token =
  ## `r"..."` raw string: no escapes; `""` denotes a literal quote.
  result = startToken(lx, tkRStrLit)
  advance lx # opening quote
  var s = ""
  while lx.pos < lx.n and lx.cur != '\n':
    if lx.cur == '"':
      if lx.peek(1) == '"':
        s.add '"'
        advance lx; advance lx
      else:
        advance lx
        break
    else:
      s.add lx.cur
      advance lx
  result.s = s

proc lexString(lx: var Lexer): Token =
  ## `"..."` normal string (escapes decoded) or `"""..."""` triple.
  if lx.peek(1) == '"' and lx.peek(2) == '"':
    return lexTripleString(lx, false)
  result = startToken(lx, tkStrLit)
  advance lx # opening quote
  var s = ""
  while lx.pos < lx.n and lx.cur != '"' and lx.cur != '\n':
    if lx.cur == '\\':
      decodeEscape(lx, s)
    else:
      s.add lx.cur
      advance lx
  if lx.cur == '"': advance lx
  else:
    # ran into a newline or EOF before the closing quote (recoverable — we keep
    # the text scanned so far and carry on lexing the next line).
    lx.addDiag(sevError, "unterminated-string", "unterminated string literal",
               result.line, result.col, lx.col)
  result.s = s

proc lexRawOrTriple(lx: var Lexer): Token =
  ## Entry for a `r`/`R` prefix immediately followed by `"`. Native nifler
  ## anchors the literal's line-info at the `r` prefix, so record that position
  ## and carry it onto the produced token.
  let anchor = startToken(lx, tkRStrLit)
  advance lx # consume the r/R prefix
  if lx.cur == '"' and lx.peek(1) == '"' and lx.peek(2) == '"':
    result = lexTripleString(lx, true)
  else:
    result = lexRawString(lx)
  result.line = anchor.line
  result.col = anchor.col
  result.indent = anchor.indent

proc lexChar(lx: var Lexer): Token =
  result = startToken(lx, tkCharLit)
  advance lx # opening quote
  var s = ""
  if lx.cur == '\\':
    decodeEscape(lx, s)
  else:
    s.add lx.cur
    advance lx
  if lx.cur == '\'': advance lx
  if s.len > 0:
    result.iVal = int64(ord(s[0]))
  result.s = s

# ---------------------------------------------------------------------------
# numeric literals
# ---------------------------------------------------------------------------

proc decodeIntBase(digits: string; base: int): int64 =
  ## `digits` is the clean digit run (no prefix, no underscores).
  result = 0
  case base
  of 16:
    for c in digits: result = (result shl 4) or int64(hexVal(c))
  of 8:
    for c in digits: result = (result shl 3) or int64(ord(c) - ord('0'))
  of 2:
    for c in digits: result = (result shl 1) or int64(ord(c) - ord('0'))
  else:
    for c in digits: result = result * 10 + int64(ord(c) - ord('0'))

proc parseFloatStr(s: string): float =
  ## Correctly-rounded decimal float parse (same primitive native nifler uses
  ## via the compiler's `parseFloat`), so shortest round-trip output matches.
  var f: BiggestFloat = 0.0
  discard parseBiggestFloat(s, f)
  result = float(f)

proc canonFloatSuffix(s: string): string =
  ## Normalise a raw float suffix spelling to the nifler tag string.
  case s
  of "f", "f32", "F", "F32": "f32"
  of "d", "f64", "D", "F64": "f64"
  of "f128", "F128": "f128"
  else: s

proc lexNumber(lx: var Lexer): Token =
  result = startToken(lx, tkIntLit)
  var base = 10
  var digits = ""     # clean digit run for integer decode (no prefix/underscore)
  var floatText = ""  # decimal spelling for float decode (no underscore)
  var isFloat = false

  # ---- base prefix -------------------------------------------------------
  if lx.cur == '0' and lx.peek(1) in {'x', 'X', 'o', 'b', 'B', 'c', 'C'}:
    let b = lx.peek(1)
    advance lx # '0'
    advance lx # base char
    case b
    of 'x', 'X': base = 16
    of 'o': base = 8
    of 'c', 'C': base = 8
    of 'b', 'B': base = 2
    else: discard
    while true:
      let c = lx.cur
      if c == '_':
        advance lx
      elif (base == 16 and isHexDigit(c)) or
           (base == 8 and c >= '0' and c <= '7') or
           (base == 2 and (c == '0' or c == '1')):
        digits.add c
        advance lx
      else:
        break
  else:
    # ---- decimal integer part ---------------------------------------------
    while true:
      if isDigit(lx.cur):
        digits.add lx.cur
        floatText.add lx.cur
        advance lx
      elif lx.cur == '_':
        advance lx
      else:
        break
    # ---- fraction ---------------------------------------------------------
    if lx.cur == '.' and isDigit(lx.peek(1)):
      isFloat = true
      floatText.add '.'
      advance lx
      while true:
        if isDigit(lx.cur):
          floatText.add lx.cur
          advance lx
        elif lx.cur == '_':
          advance lx
        else:
          break
    # ---- exponent ---------------------------------------------------------
    if lx.cur == 'e' or lx.cur == 'E':
      isFloat = true
      floatText.add 'e'
      advance lx
      if lx.cur == '+' or lx.cur == '-':
        floatText.add lx.cur
        advance lx
      while true:
        if isDigit(lx.cur):
          floatText.add lx.cur
          advance lx
        elif lx.cur == '_':
          advance lx
        else:
          break

  # ---- type suffix -------------------------------------------------------
  var suffix = ""
  block suffixScan:
    var hasQuote = false
    if lx.cur == '\'':
      hasQuote = true
    elif lx.cur notin {'f', 'F', 'd', 'D', 'i', 'I', 'u', 'U'}:
      break suffixScan
    if hasQuote: advance lx
    if not isIdentStart(lx.cur):
      break suffixScan
    var raw = ""
    while isIdentCont(lx.cur):
      raw.add lx.cur
      advance lx
    suffix = raw

  # ---- classify + decode -------------------------------------------------
  let sufl = suffix
  if sufl.len > 0 and (sufl[0] == 'f' or sufl[0] == 'F' or
                       sufl[0] == 'd' or sufl[0] == 'D'):
    isFloat = true
    result.suffix = canonFloatSuffix(sufl)
  elif sufl.len > 0:
    # integer / unsigned suffix (i8/i16/i32/i64/u/u8/u16/u32/u64)
    result.suffix = sufl

  if isFloat:
    result.kind = tkFloatLit
    if floatText.len == 0: floatText = digits
    result.fVal = parseFloatStr(floatText)
    result.s = floatText
  else:
    result.kind = tkIntLit
    result.iVal = decodeIntBase(digits, base)
    result.s = digits
    # A hex/oct/bin literal with a fixed-width SIGNED suffix carries a two's-
    # complement value: nifler stores `0xFFFD'i16` as -3 and `0xFFFFFFFF'i32`
    # as -1, not the raw magnitude. (i64 already wraps into int64 during decode;
    # decimal literals stay magnitudes.)
    if base != 10 and (sufl == "i8" or sufl == "i16" or sufl == "i32"):
      var width = 32
      if sufl == "i8": width = 8
      elif sufl == "i16": width = 16
      if (result.iVal and (1'i64 shl (width - 1))) != 0'i64:
        result.iVal = result.iVal - (1'i64 shl width)

# ---------------------------------------------------------------------------
# operators / identifiers
# ---------------------------------------------------------------------------

proc lexOperator(lx: var Lexer): Token =
  result = startToken(lx, tkOperator)
  var s = ""
  while lx.pos < lx.n and lx.cur in OperatorChars:
    s.add lx.cur
    advance lx
  result.s = s

proc lexIdent(lx: var Lexer): Token =
  result = startToken(lx, tkIdent)
  var s = ""
  while lx.pos < lx.n and isIdentCont(lx.cur):
    s.add lx.cur
    advance lx
  result.s = s
  if isKeyword(s):
    result.kind = tkKeyword

const QuoteMergeChars = OperatorChars + {'(', ')', '[', ']', '{', '}'} - {':'}

proc lexBackquotedIdent(lx: var Lexer): Token =
  ## `` `foo bar` `` accent-quoted identifier. Nifler keeps this structural:
  ## `(quoted <pieces>)`. The pieces follow the classic Nim `accQuoted` rule
  ## (parser.nim:388): a maximal run of operator-like tokens (`tkOpr/tkDot/`
  ## `tkDotDot/tkEquals/tkParLe..tkParDotRi`) coalesces into ONE piece, while
  ## each ident/keyword/literal is its own piece. So `` `[]=` `` → one piece,
  ## `` `value=` `` → `value`, `=`, `` `foo bar` `` → `foo`, `bar`.
  result = startToken(lx, tkIdent)
  result.quoted = true
  advance lx # opening backtick
  var s = ""
  var parts: seq[string] = @[]
  var partCols: seq[int32] = @[]
  while lx.pos < lx.n and lx.cur != '`' and lx.cur != '\n':
    let c = lx.cur
    if c == ' ' or c == '\t':
      advance lx
    elif c in QuoteMergeChars:
      partCols.add lx.col
      var run = ""
      while lx.pos < lx.n and lx.cur in QuoteMergeChars:
        run.add lx.cur; s.add lx.cur; advance lx
      parts.add run
    elif isIdentStart(c) or isDigit(c):
      partCols.add lx.col
      var word = ""
      while lx.pos < lx.n and isIdentCont(lx.cur):
        word.add lx.cur; s.add lx.cur; advance lx
      parts.add word
    else:
      # unknown byte inside backticks: attach to a lone piece
      partCols.add lx.col
      var one = ""
      one.add c; s.add c; advance lx
      parts.add one
  if lx.cur == '`': advance lx
  result.s = s
  result.parts = parts
  result.partCols = partCols

proc skipBlockComment(lx: var Lexer) =
  ## `#[ ... ]#`, nesting-aware.
  advance lx # '#'
  advance lx # '['
  var depth = 1
  while lx.pos < lx.n and depth > 0:
    if lx.cur == '#' and lx.peek(1) == '[':
      advance lx; advance lx; inc depth
    elif lx.cur == ']' and lx.peek(1) == '#':
      advance lx; advance lx; dec depth
    else:
      advance lx

proc skipDocBlockComment(lx: var Lexer) =
  ## `##[ ... ]##` doc block comment, nesting-aware (nests on `##[`, closes on
  ## `]##`). Matches the classic lexer's `skipMultiLineComment(isDoc=true)`.
  advance lx; advance lx; advance lx # '##['
  var depth = 1
  while lx.pos < lx.n and depth > 0:
    if lx.cur == '#' and lx.peek(1) == '#' and lx.peek(2) == '[':
      advance lx; advance lx; advance lx; inc depth
    elif lx.cur == ']' and lx.peek(1) == '#' and lx.peek(2) == '#':
      advance lx; advance lx; advance lx; dec depth
    else:
      advance lx

proc tokenize*(src: string): seq[Token]

proc tokenize*(src: string; opts: LexOptions; errors: var int): seq[Token] =
  ## Produce the full token list terminated by a `tkEof`. Whitespace and
  ## comments are consumed; the off-side `indent` field marks first-on-line
  ## tokens. `opts` controls tab/indent policy — see `LexOptions`. `errors` is
  ## incremented for every unknown/illegal byte encountered (drives `--strict`).
  var lx = initLexer(src, opts)
  result = @[]
  # --- leading UTF-8 BOM (EF BB BF) -------------------------------------------
  if lx.opts.bomPolicy != bomDefault and lx.n >= 3 and
     src[0] == '\xEF' and src[1] == '\xBB' and src[2] == '\xBF':
    if lx.opts.bomPolicy == bomReject:
      lx.addDiag(sevError, "bom-rejected",
                 "leading UTF-8 BOM rejected [--bom:reject]", 1, 0, 0)
    # Both strip and reject consume the 3 BOM bytes WITHOUT advancing the column,
    # so line-1 indentation/columns are unaffected (fixes the latent col-shift of
    # the legacy unknown-byte skip). The default (bomDefault) path is untouched.
    lx.pos = 3
  while lx.pos < lx.n:
    let before = result.len
    let c = lx.cur
    if c == ' ' or c == '\t' or c == '\r':
      # tpBoth mixing detection: flag a line whose leading whitespace uses both
      # tabs and spaces (classic Nim rejects tabs outright; we only warn).
      if lx.atLineStart and lx.opts.tabPolicy == tpBoth and c != '\r':
        if c == ' ': lx.sawSpaceInIndent = true
        elif c == '\t': lx.sawTabInIndent = true
        if lx.sawSpaceInIndent and lx.sawTabInIndent and not lx.warnedMixThisLine:
          lx.addDiag(sevWarn, "mixed-indent",
                     "indentation mixes tabs and spaces", lx.line, 0, lx.col)
          lx.warnedMixThisLine = true
      advance lx
    elif c == '\n':
      # Advisory line-ending checks (never alter the AIF). `lx.line` is still the
      # number of the line ending here (the '\n' is not yet consumed).
      if lx.opts.newlinePolicy != nlAny or lx.opts.trailingWhitespaceWarn:
        let isCrlf = lx.pos > 0 and lx.src[lx.pos - 1] == '\r'
        if lx.opts.newlinePolicy == nlLf and isCrlf:
          lx.addDiag(sevWarn, "line-ending",
                     "line ends with CRLF, expected LF [--newline:lf]",
                     lx.line, lx.col, lx.col)
        elif lx.opts.newlinePolicy == nlCrlf and not isCrlf:
          lx.addDiag(sevWarn, "line-ending",
                     "line ends with LF, expected CRLF [--newline:crlf]",
                     lx.line, lx.col, lx.col)
        if lx.opts.trailingWhitespaceWarn:
          var j = lx.pos - 1
          if j >= 0 and lx.src[j] == '\r': dec j
          if j >= 0 and (lx.src[j] == ' ' or lx.src[j] == '\t'):
            lx.addDiag(sevWarn, "trailing-whitespace",
                       "trailing whitespace [--trailing-whitespace:warn]",
                       lx.line, lx.col, lx.col)
      advance lx
    elif c == '#':
      if lx.peek(1) == '[':
        skipBlockComment(lx)
      elif lx.peek(1) == '#' and lx.peek(2) == '[':
        # `##[ … ]##` doc block comment. Like a standalone `##` doc comment,
        # nifler emits a line-leading one as `(comment)` and drops a trailing
        # one. We skip the whole (possibly nested) block, keeping only a
        # line-leading token.
        let standalone = lx.atLineStart
        let t = startToken(lx, tkComment)
        skipDocBlockComment(lx)
        lx.atLineStart = false
        if standalone and lx.opts.docComments: result.add t
      elif lx.peek(1) == '#':
        # `##` doc comment. Nifler makes a standalone one (at statement position,
        # i.e. first token on its line) an `nkCommentStmt` → `(comment)`; a
        # trailing one attaches to the preceding node's `.comment` and is dropped
        # (structurally invisible). So we only keep line-leading doc comments as
        # tokens; trailing ones are skipped like a plain `#`. Regular `#` below.
        let standalone = lx.atLineStart
        let t = startToken(lx, tkComment)
        # The classic Nim lexer (`scanComment`) coalesces a run of consecutive
        # `##` lines (no blank/code line between) into ONE comment token, so it
        # is a single `nkCommentStmt`. Consume the whole run. Content is dropped
        # (we emit a bare `(comment)`), so only the SPAN matters here.
        while true:
          while lx.pos < lx.n and lx.cur != '\n':
            advance lx
          if lx.cur != '\n': break
          var k = 1
          while lx.peek(k) == ' ' or lx.peek(k) == '\t': inc k
          if lx.peek(k) == '#' and lx.peek(k+1) == '#':
            while k > 0: advance lx; dec k   # step over the newline + indentation
          else:
            break
        lx.atLineStart = false
        if standalone and lx.opts.docComments: result.add t
      else:
        while lx.pos < lx.n and lx.cur != '\n':
          advance lx
    elif c == '"':
      let t = lexString(lx)
      lx.atLineStart = false
      result.add t
    elif (c == 'r' or c == 'R') and lx.peek(1) == '"':
      let t = lexRawOrTriple(lx)
      lx.atLineStart = false
      result.add t
    elif c == '\'':
      let t = lexChar(lx)
      lx.atLineStart = false
      result.add t
    elif c == '`':
      let t = lexBackquotedIdent(lx)
      lx.atLineStart = false
      result.add t
    elif isDigit(c):
      let t = lexNumber(lx)
      lx.atLineStart = false
      result.add t
    elif isIdentStart(c):
      let t = lexIdent(lx)
      lx.atLineStart = false
      result.add t
    elif c == '(':
      let t = startToken(lx, tkParLe); lx.atLineStart = false; advance lx; result.add t
    elif c == ')':
      let t = startToken(lx, tkParRi); lx.atLineStart = false; advance lx; result.add t
    elif c == '[':
      let t = startToken(lx, tkBracketLe); lx.atLineStart = false; advance lx; result.add t
    elif c == ']':
      let t = startToken(lx, tkBracketRi); lx.atLineStart = false; advance lx; result.add t
    elif c == '{':
      let t = startToken(lx, tkCurlyLe); lx.atLineStart = false; advance lx; result.add t
    elif c == '}':
      let t = startToken(lx, tkCurlyRi); lx.atLineStart = false; advance lx; result.add t
    elif c == ',':
      let t = startToken(lx, tkComma); lx.atLineStart = false; advance lx; result.add t
    elif c == ';':
      let t = startToken(lx, tkSemicolon); lx.atLineStart = false; advance lx; result.add t
    elif c == ':' and lx.peek(1) notin OperatorChars:
      let t = startToken(lx, tkColon); lx.atLineStart = false; advance lx; result.add t
    elif c == '.' and lx.peek(1) notin OperatorChars and not isDigit(lx.peek(1)):
      let t = startToken(lx, tkDot); lx.atLineStart = false; advance lx; result.add t
    elif c == '*' and lx.peek(1) == ':' and lx.peek(2) notin OperatorChars:
      # `*:` is two tokens (`var v*: int`): the export `*` then the colon.
      # Matches the classic Nim lexer's special case.
      var t = startToken(lx, tkOperator)
      t.s = "*"
      advance lx
      lx.atLineStart = false
      result.add t
    elif c in OperatorChars:
      let t = lexOperator(lx)
      lx.atLineStart = false
      result.add t
    else:
      # Unknown/illegal byte: record it and skip (recoverable — we keep lexing).
      lx.addDiag(sevError, "unknown-byte",
                 "unknown/illegal byte 0x" & toHex2(uint8(c)) & " skipped",
                 lx.line, lx.col, lx.col)
      advance lx
    # Record the end column of whatever token this iteration produced (lx now
    # sits at the char just past it). Powers whitespace/adjacency checks.
    if result.len > before:
      result[result.len - 1].endCol = lx.col
  # --- final-newline check (advisory) -----------------------------------------
  if lx.opts.finalNewlineRequire and lx.n > 0 and src[lx.n - 1] != '\n':
    lx.addDiag(sevWarn, "missing-final-newline",
               "source does not end with a newline [--final-newline:require]",
               lx.line, lx.col, lx.col)
  var eof = initToken(tkEof, lx.line, lx.col)
  eof.indent = 0
  result.add eof
  errors = lx.errors
  gLexDiags = lx.diags

proc tokenize*(src: string; opts: LexOptions): seq[Token] =
  ## Overload without an error out-param (diagnostics still emitted).
  var errs = 0
  tokenize(src, opts, errs)

proc tokenize*(src: string): seq[Token] =
  ## Back-compat overload: legacy, nifler-compatible defaults (spaces-only
  ## indentation, tab width 8 but unused, indent-width validation off).
  var errs = 0
  tokenize(src, defaultLexOptions, errs)
