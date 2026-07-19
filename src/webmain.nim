## webmain.nim — browser/Node entry for aowlparser, compiled through the
## nimony-web JS backend (`nim_js`). It replaces the CLI driver's file/stdout
## bridges with in-memory equivalents so the parser runs with NO file I/O:
##
##   * INPUT   — the Nim source text arrives as a JS string in
##               `globalThis.__np_src` (set by the JS glue before `main` runs).
##               The file-field path written into AIF line-info suffixes arrives
##               as `globalThis.__np_file` (defaults to "in.nim" if empty), so
##               the produced bytes can be made byte-identical to native nifler /
##               `bin/aowlparser` invoked on that same relative path.
##   * PARSE   — identical to aowlparser's parse path: tokenize -> initParser ->
##               parseModule, but the builder is an in-MEMORY nifbuilder
##               (`open(sizeHint)`) whose bytes we `extract` instead of flushing
##               to a file.
##   * CHECK   — the SAME recoverable diagnostics `aowlparser check` produces:
##               lexer diagnostics (`gLexDiags`), the bracket validator, the
##               grammar validator (`checkGrammar`), AND the grammar errors the
##               parser records as it copes (`ps.diags`) — merged, source-ordered,
##               and serialised to JSON with the optional `fix` / `related`
##               fields. This is what powers the playground's live squiggles,
##               quick-fixes, and "opened here" markers.
##   * OUTPUT  — the produced `.p.aif` bytes go back on `globalThis.__np_out`
##               (string) and the diagnostics JSON on `globalThis.__np_diag`.
##               No filesystem, no stdout.
##
## This is the proof that aowlparser (the parser half of client-side Tier 2) runs
## in the browser, now carrying the full `check` error surface.

when defined(nimony):
  {.feature: "lenientnils".}

import nifbuilder
import tokens, lexer, parser   # lexer exports tokenize + gLexDiags; parser exports initParser/parseModule + ps.diags
import checks                  # shared, byte-faithful copy of the CLI check surface
import jsffi

# --- opinion-lint style flags ------------------------------------------------
# The playground's Config panel lets the user turn on aowlparser's config-gated
# OPINION lints (nil-comparison, yoda, cast, addr, …) — the same set the CLI
# enables with `--style:<rule>:warn`. They arrive here as a comma-separated list
# of rule keys parked on `globalThis.__np_style` (empty = all off, the default,
# so behaviour is unchanged unless the user opts in). Each key flips its flag on
# a copy of `defaultLexOptions`; that copy drives BOTH tokenize and checkGrammar
# so the lints show up as diagnostics in the SAME stream as the syntax errors —
# which is exactly what the live squiggles and aowlsuggest quick-fixes consume.
proc applyStyleKey(o: var LexOptions; key: string) =
  case key
  of "trailing": o.trailingWhitespaceWarn = true
  of "coperators": o.cOperatorsWarn = true
  of "semicolon": o.semicolonWarn = true
  of "idioms": o.idiomsWarn = true
  of "floateq": o.floatEqWarn = true
  of "nil": o.nilStyleWarn = true
  of "yoda": o.yodaWarn = true
  of "parens": o.redundantParensWarn = true
  of "emptystr": o.emptyStrWarn = true
  of "echo": o.echoWarn = true
  of "range": o.rangeIndexWarn = true
  of "broadexcept": o.broadExceptWarn = true
  of "bareexcept": o.bareExceptWarn = true
  of "cast": o.castWarn = true
  of "converter": o.converterWarn = true
  of "addr": o.addrWarn = true
  of "asm": o.asmWarn = true
  of "all":
    o.cOperatorsWarn = true; o.semicolonWarn = true; o.idiomsWarn = true
    o.floatEqWarn = true; o.nilStyleWarn = true; o.yodaWarn = true
    o.redundantParensWarn = true; o.emptyStrWarn = true; o.echoWarn = true
    o.rangeIndexWarn = true; o.broadExceptWarn = true; o.bareExceptWarn = true
    o.castWarn = true; o.converterWarn = true; o.addrWarn = true; o.asmWarn = true
  else: discard

proc optsFromStyle(style: string): LexOptions =
  result = defaultLexOptions
  var cur = ""
  for i in 0 ..< style.len:
    let c = style[i]
    if c == ',' or c == ' ' or c == ';':
      if cur.len > 0: applyStyleKey(result, cur); cur = ""
    else:
      cur.add c
  if cur.len > 0: applyStyleKey(result, cur)

proc parseToStr(src, fileField: string; curly: bool; opts: LexOptions;
                diagJson: var string): string =
  ## Parse Nim source text from memory to the `.p.aif` byte string, and set
  ## `diagJson` to the JSON array of RECOVERABLE structured diagnostics — the
  ## exact set `aowlparser check --diagnostics:json` emits. Parsing is never
  ## aborted by them, so an editor gets every problem at once. `curly` enables
  ## the experimental `{ … }` block mode. `opts` carries any opt-in opinion lints.
  var errors = 0
  let toks = tokenize(src, opts, errors)
  # lexer diagnostics (unknown bytes, unterminated literals, style/portability)
  var diags = gLexDiags
  # structural + grammar validators over the token stream
  for d in checkBrackets(toks): diags.add d
  for d in checkGrammar(toks, opts): diags.add d
  # parse (in-memory builder); the parser records grammar errors at each coping
  # point into ps.diags as it goes.
  var ps = initParser(toks, fileField, curly)
  var b = nifbuilder.open(src.len * 4 + 256)
  parseModule(ps, b)
  result = extract(b)
  # grammar diagnostics are produced BY the parse, so merge them only after it
  # ran, then source-order the whole set for top-to-bottom reading.
  for d in ps.diags: diags.add d
  sortBySourceOrder(diags)
  diagJson = diagsToJson(diags)

proc npRun() =
  ## The whole browser entry, run as MODULE INIT (top-level). Like nifi's
  ## webmain it must NOT be `{.exportc: "main".}`: the JS backend emits its own
  ## `main(argc, argv, envp)` that runs the module inits, so a second `main`
  ## would shadow it. Running as top-level code means the generated entry's
  ## module-init call invokes this directly.
  # 1. read the Nim source JS parked on globalThis.__np_src
  let src = global("__np_src").toStr
  # 2. read the file-field path (relative path baked into line-info); default it
  var fileField = global("__np_file").toStr
  if fileField.len == 0:
    fileField = "in.nim"
  # 2b. read the experimental curly-block toggle: a non-empty string ("1") means
  #     accept `{ … }` block bodies; empty/absent means classic indent-only.
  let curly = global("__np_curly").toStr.len != 0
  # 2c. read the opt-in opinion-lint style keys (comma-separated; empty = none).
  let opts = optsFromStyle(global("__np_style").toStr)
  # 3. parse fully in memory (also collects syntactic diagnostics)
  var diagJson = ""
  let outp = parseToStr(src, fileField, curly, opts, diagJson)
  # 4. return the produced .p.aif bytes + diagnostics JSON to JS
  let g = global("globalThis")
  g.set("__np_out", toJs(outp))
  g.set("__np_diag", toJs(diagJson))

npRun()
