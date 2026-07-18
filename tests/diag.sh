#!/usr/bin/env bash
# diag.sh — smoke test for aifparser's recoverable diagnostics (the `check` mode
# and --diagnostics:json). Unlike nifler (which aborts on the first syntax error),
# aifparser records every problem with a source span and still produces output.
#
# Verifies: (1) a malformed file yields the expected diagnostic CODES and a
# non-zero exit; (2) --diagnostics:json emits parseable JSON; (3) a valid file is
# silent with exit 0.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NP="${NIFPARSER:-$ROOT/bin/aowlparser}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
fail=0

# (1) malformed input → multiple diagnostics, non-zero exit.
cat > "$WORK/bad.nim" <<'EOF'
proc f(x: int =
  echo "hello
  let y = (a + b]
EOF
out="$("$NP" check "$WORK/bad.nim" 2>&1)"; rc=$?
for code in unterminated-string mismatched-bracket unclosed-bracket; do
  if ! grep -q "$code" <<<"$out"; then echo "FAIL: missing diagnostic '$code'"; fail=1; fi
done
[ "$rc" -ne 0 ] || { echo "FAIL: check should exit non-zero on errors"; fail=1; }

# (2) json mode → a bracketed array mentioning a known code.
json="$("$NP" check --diagnostics:json "$WORK/bad.nim" 2>&1)"
case "$json" in
  '['*']') : ;;
  *) echo "FAIL: --diagnostics:json did not emit a JSON array"; fail=1 ;;
esac
grep -q '"code":"unterminated-string"' <<<"$json" || { echo "FAIL: json missing code"; fail=1; }

# (3) valid input → silent, exit 0.
printf 'proc f(x: int): int = x + 1\n' > "$WORK/ok.nim"
out="$("$NP" check "$WORK/ok.nim" 2>&1)"; rc=$?
[ -z "$out" ] || { echo "FAIL: valid file produced diagnostics: $out"; fail=1; }
[ "$rc" -eq 0 ] || { echo "FAIL: valid file exit was $rc, want 0"; fail=1; }

# (4) GRAMMAR error nifler catches but the bracket check alone would miss: a
# trailing binary/keyword operator has no operand → expression-expected.
for tail in 'let x = 1 +' 'let y = a and' 'foo(a,'; do
  printf '%s\n' "$tail" > "$WORK/g.nim"
  out="$("$NP" check "$WORK/g.nim" 2>&1)"
  grep -q 'expression-expected' <<<"$out" || {
    echo "FAIL: '$tail' should report expression-expected; got: $out"; fail=1; }
done

# (4b) `let`/`const` always declare, so a non-name after them is identifier-expected.
for bad in 'let proc' 'const if' 'let'; do
  printf '%s\n' "$bad" > "$WORK/i.nim"
  grep -q 'identifier-expected' <<<"$("$NP" check "$WORK/i.nim" 2>&1)" || {
    echo "FAIL: '$bad' should report identifier-expected"; fail=1; }
done
# ...but `var`/`type` double as TYPE modifiers, so a keyword after them is fine.
printf 'proc f(x: var ptr int) = discard\n' > "$WORK/i.nim"
[ -z "$("$NP" check "$WORK/i.nim" 2>&1)" ] || { echo "FAIL: 'var ptr int' is valid"; fail=1; }

# (4c) the reported bracket CHARACTER must be the real one (closerFor once
# printed '}' for every close because it only matched the OPEN token kinds).
printf 'let a = (1 + 2]\n' > "$WORK/c.nim"
cout="$("$NP" check "$WORK/c.nim" 2>&1)"
grep -q "']' does not match '('" <<<"$cout" || {
  echo "FAIL: mismatched-bracket must name the actual brackets"; fail=1; }
grep -q "'(' opened here" <<<"$cout" || {
  echo "FAIL: mismatched-bracket must carry a related 'opened here' note"; fail=1; }
printf 'x)\n' > "$WORK/c.nim"
grep -q "unmatched ')'" <<<"$("$NP" check "$WORK/c.nim" 2>&1)" || {
  echo "FAIL: unmatched-close must name the actual bracket"; fail=1; }

# (4d) GRAMMAR errors from the parser's coping points. Every place the parser
# silently copes with malformed input is an "expected X here" site — the same
# thing the classic parser reports before it gives up. These must surface.
printf 'if c\n  echo 1\n' > "$WORK/gc.nim"
grep -q 'expected-colon' <<<"$("$NP" check "$WORK/gc.nim" 2>&1)" || {
  echo "FAIL: 'if c' with no colon should report expected-colon"; fail=1; }
printf '(for: )\n' > "$WORK/gc.nim"
grep -q 'expected-in' <<<"$("$NP" check "$WORK/gc.nim" 2>&1)" || {
  echo "FAIL: '(for: )' should report expected-in"; fail=1; }
printf '(block)\n' > "$WORK/gc.nim"
grep -q 'expected-colon' <<<"$("$NP" check "$WORK/gc.nim" 2>&1)" || {
  echo "FAIL: '(block)' should report expected-colon"; fail=1; }

# (4e) a suggested FIX accompanies grammar errors (text `help:`, json `"fix"`) —
# the classic parser has no such concept.
printf 'if c\n  echo 1\n' > "$WORK/gc.nim"
grep -q 'help: ' <<<"$("$NP" check "$WORK/gc.nim" 2>&1)" || {
  echo "FAIL: grammar error should carry a 'help:' fix"; fail=1; }
grep -q '"fix":' <<<"$("$NP" check --diagnostics:json "$WORK/gc.nim" 2>&1)" || {
  echo "FAIL: json should carry a \"fix\" field"; fail=1; }

# (4f) assignment '=' in a condition — the classic '==' typo. A depth-0 '=' in an
# if/elif/while/when condition is always malformed; we catch it with a better
# message than the classic parser AND must not fire on named args / comparisons.
printf 'if x = 5:\n  discard\n' > "$WORK/ac.nim"
out="$("$NP" check "$WORK/ac.nim" 2>&1)"
grep -q 'assignment-in-condition' <<<"$out" || { echo "FAIL: 'if x = 5:' should flag assignment-in-condition"; fail=1; }
grep -q "==" <<<"$out" || { echo "FAIL: assignment-in-condition should suggest '=='"; fail=1; }
for ok in 'if x == 5:' 'if f(k = v):' 'when compiles(x = 5):'; do
  printf '%s\n  discard\n' "$ok" > "$WORK/ac.nim"
  grep -q 'assignment-in-condition' <<<"$("$NP" check "$WORK/ac.nim" 2>&1)" && {
    echo "FAIL: '$ok' must NOT flag assignment-in-condition"; fail=1; }
done

# (4f2) comparison-in-binding — the MIRROR: '==' where '=' was meant in a
# let/const binding ('let x == 5'). Fires on the typo, silent when '==' is a
# real comparison in the value (after the binding '=').
for bad in 'let x == 5' 'const C == 5' 'let x: int == 5' 'let (a, b) == p'; do
  printf '%s\n' "$bad" > "$WORK/cb.nim"
  grep -q 'comparison-in-binding' <<<"$("$NP" check "$WORK/cb.nim" 2>&1)" || {
    echo "FAIL: '$bad' should flag comparison-in-binding"; fail=1; }
done
for ok in 'let x = a == b' 'const C = (1 == 1)' 'let ok = f(x == y)' 'let z = 1'; do
  printf '%s\n' "$ok" > "$WORK/cb.nim"
  grep -q 'comparison-in-binding' <<<"$("$NP" check "$WORK/cb.nim" 2>&1)" && {
    echo "FAIL: '$ok' must NOT flag comparison-in-binding"; fail=1; }
done

# (4g) lexer-level numeric/identifier errors nifler catches (found by the
# Nim/tests differential). Each must fire on the bad form and stay silent on the
# valid one.
declare -A badnum=( ['echo 0x']=invalid-number ['echo 0b']=invalid-number
                    ['echo 0O5']=invalid-int-literal ['var ef_ = 3']=invalid-identifier
                    ['var a__b = 1']=invalid-identifier )
for src in "${!badnum[@]}"; do
  printf '%s\n' "$src" > "$WORK/nn.nim"
  grep -q "${badnum[$src]}" <<<"$("$NP" check "$WORK/nn.nim" 2>&1)" || {
    echo "FAIL: '$src' should report ${badnum[$src]}"; fail=1; }
done
for ok in 'let x = 1_000_000' 'let h = 0xFF_FF' 'var my_var = 1' 'let _ = f()' 'let b = 0b1010'; do
  printf '%s\n' "$ok" > "$WORK/nn.nim"
  [ -z "$("$NP" check "$WORK/nn.nim" 2>&1)" ] || { echo "FAIL: '$ok' must be silent"; fail=1; }
done

# (4h) empty condition: 'if'/'elif'/'while'/'when' immediately followed by ':'.
for src in 'elif:' 'if:' 'while:'; do
  printf '%s\n  discard\n' "$src" > "$WORK/ec.nim"
  grep -q 'expected-condition' <<<"$("$NP" check "$WORK/ec.nim" 2>&1)" || {
    echo "FAIL: '$src' should report expected-condition"; fail=1; }
done

# (4i) integer literal exceeding its unsigned type's range.
printf "let x = 0x123'u8\n" > "$WORK/oor.nim"
grep -q 'number-out-of-range' <<<"$("$NP" check "$WORK/oor.nim" 2>&1)" || {
  echo "FAIL: 0x123'u8 should be number-out-of-range"; fail=1; }
for ok in "0xFF'u8" "255'u8" "0xFFFFFFFF'u32"; do
  printf 'let x = %s\n' "$ok" > "$WORK/oor.nim"
  [ -z "$("$NP" check "$WORK/oor.nim" 2>&1)" ] || { echo "FAIL: '$ok' (= max) must be silent"; fail=1; }
done

# (4j) classic lexer errors nifler catches: bad char literals, illegal tabs, and
# unterminated block comments. Each must fire on the bad form and stay silent on
# the valid one (zero false positives).
printf "let c = ''\n" > "$WORK/lx.nim"
grep -q 'invalid-character-literal' <<<"$("$NP" check "$WORK/lx.nim" 2>&1)" || {
  echo "FAIL: empty char literal '' should be invalid-character-literal"; fail=1; }
for bad in "let c = 'ab'" "let c = 'a"; do
  printf '%s\n' "$bad" > "$WORK/lx.nim"
  grep -q 'unterminated-char' <<<"$("$NP" check "$WORK/lx.nim" 2>&1)" || {
    echo "FAIL: '$bad' should report unterminated-char"; fail=1; }
done
for ok in "let c = 'a'" "let c = '\\n'" "let c = '\\''" "let c = ' '"; do
  printf '%s\n' "$ok" > "$WORK/lx.nim"
  grep -qE 'unterminated-char|invalid-character-literal' <<<"$("$NP" check "$WORK/lx.nim" 2>&1)" && {
    echo "FAIL: valid char '$ok' must be silent"; fail=1; }
done
# a tab anywhere outside strings/comments is illegal Nim (leading OR mid-line).
printf 'if true:\n\techo 1\n' > "$WORK/lx.nim"
tout="$("$NP" check "$WORK/lx.nim" 2>&1)"
grep -q 'tabs-not-allowed' <<<"$tout" || { echo "FAIL: leading tab should report tabs-not-allowed"; fail=1; }
printf 'let\tx = 1\n' > "$WORK/lx.nim"
grep -q 'tabs-not-allowed' <<<"$("$NP" check "$WORK/lx.nim" 2>&1)" || {
  echo "FAIL: mid-line tab should report tabs-not-allowed"; fail=1; }
# ...but a tab INSIDE a string literal is fine.
printf 'let s = "a\tb"\n' > "$WORK/lx.nim"
grep -q 'tabs-not-allowed' <<<"$("$NP" check "$WORK/lx.nim" 2>&1)" && {
  echo "FAIL: tab inside a string must NOT be flagged"; fail=1; }
# unterminated `#[` block comment.
printf 'echo 1 #[ never closed\n' > "$WORK/lx.nim"
grep -q 'unterminated-comment' <<<"$("$NP" check "$WORK/lx.nim" 2>&1)" || {
  echo "FAIL: unterminated #[ should report unterminated-comment"; fail=1; }
printf 'echo 1 #[ closed ]# more\n' > "$WORK/lx.nim"
grep -q 'unterminated-comment' <<<"$("$NP" check "$WORK/lx.nim" 2>&1)" && {
  echo "FAIL: a properly-closed block comment must be silent"; fail=1; }

# (4k) more classic lexer errors nifler catches: malformed escapes and
# unterminated triple/raw strings. Fire on the bad form, silent on the valid one.
declare -A badstr=(
  ['let s = "a\qb"']=invalid-escape-sequence
  ['let s = "\x"']=invalid-escape-sequence
  ['let s = "\u{}"']=invalid-unicode-escape
  ['let s = """abc']=unterminated-string
  ['let s = r"abc']=unterminated-string
  ['let x = 1__0']=invalid-number
  ['let x = 1_']=invalid-number )
for src in "${!badstr[@]}"; do
  printf '%s\n' "$src" > "$WORK/ls.nim"
  grep -q "${badstr[$src]}" <<<"$("$NP" check "$WORK/ls.nim" 2>&1)" || {
    echo "FAIL: '$src' should report ${badstr[$src]}"; fail=1; }
done
for ok in 'let s = "a\nb\t\\x41é"' 'let s = "\x1B"' 'let s = "\u{1F600}"' \
          'let s = """closed"""' 'let s = r"closed"' 'let x = 1_000_000' 'let h = 0xFF_FF'; do
  printf '%s\n' "$ok" > "$WORK/ls.nim"
  grep -qE 'invalid-escape-sequence|invalid-unicode-escape|unterminated-string|invalid-number' \
    <<<"$("$NP" check "$WORK/ls.nim" 2>&1)" && {
    echo "FAIL: valid literal '$ok' must be silent"; fail=1; }
done

# (4l) unterminated accent-quoted identifier, and empty comma slots. A trailing
# comma is valid Nim and must stay silent; only a doubled `,,` or leading `(,`/
# `[,` is an error.
printf 'let `a = 1\n' > "$WORK/bt.nim"
grep -q 'unterminated-backtick' <<<"$("$NP" check "$WORK/bt.nim" 2>&1)" || {
  echo "FAIL: unterminated backtick should report unterminated-backtick"; fail=1; }
printf 'proc `[]=`(x: int) = discard\n' > "$WORK/bt.nim"
grep -q 'unterminated-backtick' <<<"$("$NP" check "$WORK/bt.nim" 2>&1)" && {
  echo "FAIL: a closed backtick ident must be silent"; fail=1; }
for bad in 'foo(a,,b)' 'foo(,b)' '[1,,2]' 'seq[int,,]'; do
  printf '%s\n' "$bad" > "$WORK/cc.nim"
  grep -q 'expression-expected' <<<"$("$NP" check "$WORK/cc.nim" 2>&1)" || {
    echo "FAIL: '$bad' should report expression-expected (empty comma slot)"; fail=1; }
done
for ok in 'foo(a,)' 'foo(a, b,)' '[1,2,]' '(1,)'; do
  printf '%s\n' "$ok" > "$WORK/cc.nim"
  grep -q 'expression-expected' <<<"$("$NP" check "$WORK/cc.nim" 2>&1)" && {
    echo "FAIL: trailing comma '$ok' is valid and must be silent"; fail=1; }
done

# (4m) a `#? stdtmpl` source-code filter header means the file is NOT plain Nim
# (it is rewritten by a filter before parsing). Lexical checks would report
# spurious errors on the raw template, so `check` stays silent on such files.
printf '#? stdtmpl(subsChar = $)\n<h1>${x}'"'"'s time</h1>\n' > "$WORK/tmpl.nim"
out="$("$NP" check "$WORK/tmpl.nim" 2>&1)"; rc=$?
[ -z "$out" ] || { echo "FAIL: filtered template must be silent, got: $out"; fail=1; }
[ "$rc" -eq 0 ] || { echo "FAIL: filtered template exit was $rc, want 0"; fail=1; }

# (4n) a routine (proc/func/method/iterator/…) with an indented body but no `=`
# to introduce it — the classic "forgot the '='". nifler only says "invalid
# indentation, maybe you forgot a '='"; we name the routine, point at both the
# body and the header, and offer the fix. Must NOT fire on a valid forward/magic
# declaration, even one carrying an indented `##` doc comment.
for bad in 'proc f()' 'func g(x: int)' 'iterator it(): int'; do
  printf '%s\n  echo 1\n' "$bad" > "$WORK/re.nim"
  out="$("$NP" check "$WORK/re.nim" 2>&1)"
  grep -q 'missing-routine-equals' <<<"$out" || {
    echo "FAIL: '$bad' + body should report missing-routine-equals"; fail=1; }
  grep -q 'help: ' <<<"$out" || { echo "FAIL: missing '=' should carry a fix"; fail=1; }
  grep -q 'declared here' <<<"$out" || { echo "FAIL: missing '=' should point at the header"; fail=1; }
done
# valid forms that must stay silent: a real body (`=`), a bare forward decl, and
# a magic/importc decl documented with an indented `##` comment.
printf 'func defined*(x: untyped): bool {.magic: Defined.}\n  ## doc\n  ## more\n' > "$WORK/re.nim"
grep -q 'missing-routine-equals' <<<"$("$NP" check "$WORK/re.nim" 2>&1)" && {
  echo "FAIL: documented magic decl must be silent"; fail=1; }
for ok in 'proc f() =\n  echo 1' 'proc f()\ntype T = int' 'proc c(): cint {.importc.}'; do
  printf "$ok\n" > "$WORK/re.nim"
  grep -q 'missing-routine-equals' <<<"$("$NP" check "$WORK/re.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must be silent"; fail=1; }
done

# (4o) a colon-block whose body is not indented deeper than its statement line —
# `if c:⏎x` where `x` is a sibling, not a body (the classic misindent). nifler
# says only "invalid indentation"; we name the rule and offer the fix. Must NOT
# fire on one-liners, properly-indented bodies, nested bodies, value-context
# blocks, or MULTI-LINE headers (the condition spanning several lines).
for bad in 'if true:\nlet x = 1' 'for i in 0..3:\necho 1' 'while true:\ndiscard' 'block:\ndiscard'; do
  printf "$bad\n" > "$WORK/ib.nim"
  out="$("$NP" check "$WORK/ib.nim" 2>&1)"
  grep -q 'expected-indented-body' <<<"$out" || {
    echo "FAIL: '$bad' should report expected-indented-body"; fail=1; }
  grep -q 'help: ' <<<"$out" || { echo "FAIL: expected-indented-body should carry a fix"; fail=1; }
done
for ok in 'if true: discard' 'if true:\n  discard' 'proc f() =\n  if c:\n    a' \
          'let x = if c:\n    1\n  else:\n    2' \
          'when a and\n     b:\n  discard'; do
  printf "$ok\n" > "$WORK/ib.nim"
  grep -q 'expected-indented-body' <<<"$("$NP" check "$WORK/ib.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must be silent"; fail=1; }
done

# (4p) a `type Name` with an indented body but no `=` — the author forgot the
# `= object`/`= enum`/`= …`. nifler only spews "invalid indentation" per body
# line; we name the type, point at it, and offer the fix. Must NOT fire on a bare
# forward decl, a documented forward decl, a real `= object`, sibling defs, or the
# exotic `T = call:` + trailing `do:` type-section construct (name is a keyword).
for bad in 'type\n  MyObj\n    x: int' 'type\n  E\n    a\n    b'; do
  printf "$bad\n" > "$WORK/ty.nim"
  out="$("$NP" check "$WORK/ty.nim" 2>&1)"
  grep -q 'missing-type-equals' <<<"$out" || {
    echo "FAIL: '$bad' should report missing-type-equals"; fail=1; }
  grep -q 'help: ' <<<"$out" || { echo "FAIL: missing-type-equals should carry a fix"; fail=1; }
  grep -q 'declared here' <<<"$out" || { echo "FAIL: missing-type-equals should point at the type"; fail=1; }
done
# valid forms that must stay silent
printf 'type\n  Fwd\n  Other = int\n' > "$WORK/ty.nim"
grep -q 'missing-type-equals' <<<"$("$NP" check "$WORK/ty.nim" 2>&1)" && {
  echo "FAIL: forward decl + sibling def must be silent"; fail=1; }
for ok in 'type T = object\n    x: int' 'type\n  Doc\n    ## just docs' 'type X = int'; do
  printf "$ok\n" > "$WORK/ty.nim"
  grep -q 'missing-type-equals' <<<"$("$NP" check "$WORK/ty.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must be silent"; fail=1; }
done

# (4q) `func` used in a type description — illegal in Nim (must be `proc` with a
# `{.noSideEffect.}` pragma). parseType is only ever entered in a type position,
# so a `func` head is unambiguous. Must NOT fire on a top-level `func` routine.
printf 'type T = object\n  fn: func(a: int): int\n' > "$WORK/fn.nim"
out="$("$NP" check "$WORK/fn.nim" 2>&1)"
grep -q 'func-in-type-description' <<<"$out" || { echo "FAIL: func in type-desc should be flagged"; fail=1; }
grep -q 'help: ' <<<"$out" || { echo "FAIL: func-in-type-description should carry a fix"; fail=1; }
for ok in 'func f(a: int): int =\n  a' 'type T = object\n  fn: proc(a: int): int' \
          'proc p() {.noSideEffect.} = discard'; do
  printf "$ok\n" > "$WORK/fn.nim"
  grep -q 'func-in-type-description' <<<"$("$NP" check "$WORK/fn.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must be silent"; fail=1; }
done

# (4r) a keyword (e.g. `when`) spliced in where an enum member is expected — enum
# members are always plain identifiers. Must NOT fire on ordinary enum members,
# valued members, or pragma-decorated ones.
printf 'type E = enum\n  a\n  when defined(x): b\n  c\n' > "$WORK/en.nim"
out="$("$NP" check "$WORK/en.nim" 2>&1)"
grep -q 'enum-member-not-identifier' <<<"$out" || { echo "FAIL: when-in-enum should be flagged"; fail=1; }
for ok in 'type E = enum\n  a\n  b\n  c' 'type E = enum\n  a = 1\n  b = 2' \
          'type E = enum\n  a {.deprecated.}\n  b'; do
  printf "$ok\n" > "$WORK/en.nim"
  grep -q 'enum-member-not-identifier' <<<"$("$NP" check "$WORK/en.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must be silent"; fail=1; }
done

# (4s) an empty object-variant branch — `of X:` with no field, `nil`, or
# `discard`. nifler emits a cryptic "identifier expected, but got 'keyword of'"
# pointing at the NEXT branch; we point at the empty branch itself and offer the
# fix. Must NOT fire on branches with fields or an explicit `nil`/`discard`.
printf 'type T = object\n  case k: bool\n  of true:\n  of false: x: int\n' > "$WORK/cv.nim"
out="$("$NP" check "$WORK/cv.nim" 2>&1)"
grep -q 'empty-variant-branch' <<<"$out" || { echo "FAIL: empty variant branch should be flagged"; fail=1; }
grep -q 'help: ' <<<"$out" || { echo "FAIL: empty-variant-branch should carry a fix"; fail=1; }
for ok in 'type T = object\n  case k: bool\n  of true: x: int\n  of false: y: int' \
          'type T = object\n  case k: bool\n  of true: nil\n  of false: y: int' \
          'type T = object\n  case k: bool\n  of true:\n    x: int\n  else: discard'; do
  printf "$ok\n" > "$WORK/cv.nim"
  grep -q 'empty-variant-branch' <<<"$("$NP" check "$WORK/cv.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must be silent"; fail=1; }
done

# (4t) an `of` branch with no match value — a `:` directly after `of` (`of: x:`).
# nifler says "expression expected, but found ':'"; we name the rule. Applies to
# both statement `case` and object-variant `case`. Must NOT fire on normal
# branches (`of 1:`, `of A, B:`) or an `else:`.
printf 'case k\nof: 1:\n  discard\nelse: discard\n' > "$WORK/of.nim"
grep -q 'of-without-value' <<<"$("$NP" check "$WORK/of.nim" 2>&1)" || {
  echo "FAIL: statement 'of:' should be flagged"; fail=1; }
printf 'type T = object\n  case k: bool\n  of: true: x: int\n  else: discard\n' > "$WORK/of.nim"
grep -q 'of-without-value' <<<"$("$NP" check "$WORK/of.nim" 2>&1)" || {
  echo "FAIL: variant 'of:' should be flagged"; fail=1; }
for ok in 'case k\nof 1:\n  discard\nelse:\n  discard' \
          'case k\nof 1, 2, 3: discard\nelse: discard' \
          'type T = object\n  case k: bool\n  of true: x: int\n  else: discard'; do
  printf "$ok\n" > "$WORK/of.nim"
  grep -q 'of-without-value' <<<"$("$NP" check "$WORK/of.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must be silent"; fail=1; }
done

# (5) diagnostics are emitted in SOURCE ORDER (top-to-bottom), not validator order.
printf 'let a = (1\nvar b = {2\n' > "$WORK/ord.nim"
lines="$("$NP" check "$WORK/ord.nim" 2>&1)"
first_line="$(head -1 <<<"$lines" | sed -E 's/.*:([0-9]+):[0-9]+:.*/\1/')"
[ "$first_line" = "1" ] || { echo "FAIL: diagnostics not source-ordered (first at line $first_line)"; fail=1; }

if [ "$fail" -eq 0 ]; then echo "diag: all checks passed"; else echo "diag: FAILURES above"; fi
exit "$fail"
