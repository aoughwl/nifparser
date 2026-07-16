#!/usr/bin/env bash
#
# tests/diff.sh — DIFFERENTIAL harness for aifparser against native nifler.
#
# For every `tests/corpus/*.nim`, run the native `nifler` oracle and our
# `aifparser`, then compare their AIF output:
#
#   * STRUCTURAL  — line-info / comment suffixes stripped and whitespace
#                   normalised (tests/canon.py). This is the PASS criterion:
#                   the two token trees must be identical.
#   * EXACT       — byte-identical `.p.aif` (reported as a bonus; aifparser
#                   aims for this on supported constructs).
#
# Exit status is non-zero iff any corpus file FAILS the structural check.
#
# Env overrides:
#   NIFLER      path to native nifler   (default /home/savant/nimony/bin/nifler)
#   NIFPARSER   path to aifparser       (default bin/aifparser)
#
# Dependency-light: bash + coreutils + python3.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

NIFLER="${NIFLER:-/home/savant/nimony/bin/nifler}"
NIFPARSER="${NIFPARSER:-$ROOT/bin/aifparser}"
CANON="$HERE/canon.py"
CORPUS="$HERE/corpus"
WORK="$HERE/_work"

if [ ! -x "$NIFLER" ]; then
  echo "ERROR: native nifler oracle not found: $NIFLER" >&2
  exit 2
fi
if [ ! -x "$NIFPARSER" ]; then
  echo "ERROR: aifparser binary not found: $NIFPARSER" >&2
  echo "  Build it first (see README.md 'Build')." >&2
  exit 2
fi

rm -rf "$WORK"; mkdir -p "$WORK"

pass=0; fail=0; exact=0; total=0
fails=""

# Run both tools from the corpus dir so the relative path in line-info matches.
cd "$CORPUS" || exit 2

for nim in *.nim; do
  [ -e "$nim" ] || continue
  total=$((total+1))
  base="${nim%.nim}"
  ref="$WORK/$base.ref.p.aif"
  our="$WORK/$base.our.p.aif"

  "$NIFLER"    p "$nim" "$ref" >/dev/null 2>"$WORK/$base.ref.err"
  "$NIFPARSER" p "$nim" "$our" >/dev/null 2>"$WORK/$base.our.err"

  if [ ! -s "$ref" ]; then
    printf '  %-18s ORACLE-FAIL (native nifler produced no output)\n' "$base"
    fail=$((fail+1)); fails="$fails $base"; continue
  fi
  if [ ! -s "$our" ]; then
    printf '  %-18s FAIL (aifparser produced no output)\n' "$base"
    fail=$((fail+1)); fails="$fails $base"; continue
  fi

  python3 "$CANON" "$ref" > "$WORK/$base.ref.canon"
  python3 "$CANON" "$our" > "$WORK/$base.our.canon"

  # EXACT byte-match, modulo the one intentional divergence: the
  # `(.vendor "…")` header (aifparser stamps "aifparser", nifler "Nifler").
  # Neutralise ONLY that directive on both sides before the byte compare;
  # every other byte must still be identical.
  sed -e 's/^(\.aif27)/(.ver)/' -e 's/^(\.nif27)/(.ver)/' -e 's/^(\.vendor "[^"]*")/(.vendor "<vendor>")/' "$ref" > "$WORK/$base.ref.exact"
  sed -e 's/^(\.aif27)/(.ver)/' -e 's/^(\.nif27)/(.ver)/' -e 's/^(\.vendor "[^"]*")/(.vendor "<vendor>")/' "$our" > "$WORK/$base.our.exact"
  if cmp -s "$WORK/$base.ref.exact" "$WORK/$base.our.exact"; then
    exact_tag="EXACT"; exact=$((exact+1))
  else
    exact_tag="struct"
  fi

  if diff -q "$WORK/$base.ref.canon" "$WORK/$base.our.canon" >/dev/null; then
    printf '  %-18s PASS  (%s)\n' "$base" "$exact_tag"
    pass=$((pass+1))
  else
    printf '  %-18s FAIL  (structural mismatch)\n' "$base"
    fail=$((fail+1)); fails="$fails $base"
    if [ "${VERBOSE:-0}" = "1" ]; then
      diff -u "$WORK/$base.ref.canon" "$WORK/$base.our.canon" | sed 's/^/      /'
    fi
  fi
done

echo "--------------------------------------------------------------"
echo "corpus: $total   PASS: $pass   FAIL: $fail   (exact byte-match: $exact)"
if [ -n "$fails" ]; then
  echo "failing:$fails"
  echo "(re-run with VERBOSE=1 to see per-file canonical diffs)"
fi
[ "$fail" -eq 0 ]
