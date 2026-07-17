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

# (5) diagnostics are emitted in SOURCE ORDER (top-to-bottom), not validator order.
printf 'let a = (1\nvar b = {2\n' > "$WORK/ord.nim"
lines="$("$NP" check "$WORK/ord.nim" 2>&1)"
first_line="$(head -1 <<<"$lines" | sed -E 's/.*:([0-9]+):[0-9]+:.*/\1/')"
[ "$first_line" = "1" ] || { echo "FAIL: diagnostics not source-ordered (first at line $first_line)"; fail=1; }

if [ "$fail" -eq 0 ]; then echo "diag: all checks passed"; else echo "diag: FAILURES above"; fi
exit "$fail"
