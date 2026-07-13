## nifparser — a nimony-native Nim-source parser that emits the SAME NIF as the
## classic `nifler`, so it can be compiled to JS (via nim_js) and run in the
## browser where classic-Nim `nifler` cannot.
##
## CLI (mirrors nifler):
##   nifparser p <in.nim> [out.p.nif]     parse a Nim file, produce a NIF file
##
## When the output path is omitted it defaults to `<in>.p.nif`.
##
## This driver is intentionally a thin, top-level-init entry point with only
## file/stdout I/O so the same code path can later back a globalThis-driven JS
## build (no mmap, no PNode AST).

import std/[syncio, os]
import nifbuilder
import tokens, lexer, parser

proc parseToFile(inp, outp, fileField: string; curly: bool; opts: LexOptions) =
  var src = ""
  try:
    src = readFile(inp)
  except:
    write stderr, "cannot read file: " & inp & "\n"
    quit 1
  let toks = tokenize(src, opts)
  var ps = initParser(toks, fileField, curly)
  var b = nifbuilder.open(outp)
  parseModule(ps, b)
  b.close()

proc usage() =
  write stderr, "nifparser — Nim source -> NIF (nifler-compatible)\n"
  write stderr, "usage: nifparser [OPTIONS] p <in.nim> [out.p.nif]\n"
  write stderr, "  --curly            experimental: also accept `{ … }` block bodies\n"
  write stderr, "  --tabs:MODE        indentation whitespace policy (default spaces):\n"
  write stderr, "                       spaces  spaces only (classic-Nim stance)\n"
  write stderr, "                       tabs    tabs allowed (advance tab-width cols)\n"
  write stderr, "                       both    tabs or spaces; mixing on one line warns\n"
  write stderr, "  --tab-width:N      columns a `\\t` advances when tabs permitted (default 8)\n"
  write stderr, "  --indent-width:N   advisory: warn when a line's indent isn't a multiple\n"
  write stderr, "                       of N columns (default 0 = disabled; never affects\n"
  write stderr, "                       parsing — the off-side rule stays relative)\n"
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
  let cli = commandLineParams()
  for ci in 0 ..< cli.len:
    let a = cli[ci]
    if a == "--curly":
      curly = true
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
    else:
      params.add a
  if params.len < 2:
    usage()
  let action = params[0]
  if action != "p" and action != "parse":
    write stderr, "unknown command: " & action & "\n"
    usage()
  let inp = params[1]
  var outp = ""
  if params.len >= 3:
    outp = params[2]
    let n = outp.len
    if n < 4 or outp[n-4 .. n-1] != ".nif":
      outp = outp & ".nif"
  else:
    outp = inp & ".p.nif"
  # `fileField` is the path written into NIF line-info suffixes. nifler uses the
  # cwd-relative path (portablePaths); the harness invokes both tools with the
  # same relative path, so pass the input arg through verbatim.
  parseToFile(inp, outp, inp, curly, opts)

main()
