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
NP="${NIFPARSER:-$ROOT/bin/aifparser}"
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

if [ "$fail" -eq 0 ]; then echo "diag: all checks passed"; else echo "diag: FAILURES above"; fi
exit "$fail"
