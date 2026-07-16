## aifparser — a nimony-native Nim-source parser that emits the SAME AIF as the
## classic `nifler`, so it can be compiled to JS (via nim_js) and run in the
## browser where classic-Nim `nifler` cannot.
##
## CLI (mirrors nifler):
##   aifparser p <in.nim> [out.p.aif]     parse a Nim file, produce a AIF file
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
  case k
  of tkParLe: ')'
  of tkBracketLe: ']'
  else: '}'

proc openerFor(k: TokKind): char =
  case k
  of tkParLe: '('
  of tkBracketLe: '['
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
                   openerFor(top.kind) & "' opened at " & $top.line & ":" & $top.col,
          line: t.line, col: t.col, endCol: t.col + 1)
        stack.setLen(stack.len - 1)
      else:
        stack.setLen(stack.len - 1)
    else: discard
  for t in stack:
    result.add Diagnostic(severity: sevError, code: "unclosed-bracket",
      message: "unclosed '" & openerFor(t.kind) & "'",
      line: t.line, col: t.col, endCol: t.col + 1)

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
  of dfJson:
    var s = "["
    for i in 0 ..< diags.len:
      let d = diags[i]
      if i > 0: s.add ","
      s.add "{\"severity\":\"" & sevName(d.severity) & "\",\"code\":\"" &
        d.code & "\",\"message\":\"" & jsonEscape(d.message) &
        "\",\"line\":" & $d.line & ",\"col\":" & $d.col &
        ",\"endCol\":" & $d.endCol & "}"
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
  result = (toks, diags)

proc runParse(src, outp, fileField: string; toStdout, strict, curly: bool;
              opts: LexOptions; maxDepth: int; diagFmt: DiagFormat) =
  ## Tokenize `src`, parse it, and emit the AIF to `outp` (or stdout). Diagnostics
  ## (lexer + bracket check) are rendered to stderr in `diagFmt`; parsing is never
  ## aborted by them. With `strict`, any `sevError` diagnostic exits non-zero.
  let (toks, diags) = collectDiags(src, opts)
  renderDiags(diags, fileField, diagFmt, stderr)
  var ps = initParser(toks, fileField, curly, maxDepth)
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
  if strict:
    var nErr = 0
    for d in diags:
      if d.severity == sevError: inc nErr
    if nErr > 0:
      write stderr, "aifparser: " & $nErr & " error(s) in input [--strict]\n"
      quit 1

proc runCheck(src, fileField: string; opts: LexOptions; diagFmt: DiagFormat): int =
  ## Lint-only mode (`aifparser check`): emit diagnostics to STDOUT (text or json,
  ## default text) and no AIF. Returns the process exit code — 1 if any error-level
  ## diagnostic was found, else 0. This is the "better errors than nifler" surface:
  ## recoverable, multi-error, machine-readable, and it never aborts on the first.
  let (_, diags) = collectDiags(src, opts)
  let fmt = if diagFmt == dfOff: dfText else: diagFmt
  renderDiags(diags, fileField, fmt, stdout)
  for d in diags:
    if d.severity == sevError: return 1
  return 0

proc usage() =
  write stderr, "aifparser — Nim source -> AIF (nifler-compatible)\n"
  write stderr, "usage: aifparser [OPTIONS] p <in.nim> [out.p.aif]\n"
  write stderr, "       aifparser [OPTIONS] check <in.nim>   # lint only: diagnostics, no AIF\n"
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
    quit runCheck(src, fileField, opts, diagFmt)
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
