#!/usr/bin/env bash
#
# tests/diff.sh — DIFFERENTIAL harness for nifparser against native nifler.
#
# For every `tests/corpus/*.nim`, run the native `nifler` oracle and our
# `nifparser`, then compare their NIF output:
#
#   * STRUCTURAL  — line-info / comment suffixes stripped and whitespace
#                   normalised (tests/canon.py). This is the PASS criterion:
#                   the two token trees must be identical.
#   * EXACT       — byte-identical `.p.nif` (reported as a bonus; nifparser
#                   aims for this on supported constructs).
#
# Exit status is non-zero iff any corpus file FAILS the structural check.
#
# Env overrides:
#   NIFLER      path to native nifler   (default /home/savant/nimony/bin/nifler)
#   NIFPARSER   path to nifparser       (default bin/nifparser)
#
# Dependency-light: bash + coreutils + python3.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

NIFLER="${NIFLER:-/home/savant/nimony/bin/nifler}"
NIFPARSER="${NIFPARSER:-$ROOT/bin/nifparser}"
CANON="$HERE/canon.py"
CORPUS="$HERE/corpus"
WORK="$HERE/_work"

if [ ! -x "$NIFLER" ]; then
  echo "ERROR: native nifler oracle not found: $NIFLER" >&2
  exit 2
fi
if [ ! -x "$NIFPARSER" ]; then
  echo "ERROR: nifparser binary not found: $NIFPARSER" >&2
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
  ref="$WORK/$base.ref.p.nif"
  our="$WORK/$base.our.p.nif"

  "$NIFLER"    p "$nim" "$ref" >/dev/null 2>"$WORK/$base.ref.err"
  "$NIFPARSER" p "$nim" "$our" >/dev/null 2>"$WORK/$base.our.err"

  if [ ! -s "$ref" ]; then
    printf '  %-18s ORACLE-FAIL (native nifler produced no output)\n' "$base"
    fail=$((fail+1)); fails="$fails $base"; continue
  fi
  if [ ! -s "$our" ]; then
    printf '  %-18s FAIL (nifparser produced no output)\n' "$base"
    fail=$((fail+1)); fails="$fails $base"; continue
  fi

  python3 "$CANON" "$ref" > "$WORK/$base.ref.canon"
  python3 "$CANON" "$our" > "$WORK/$base.our.canon"

  # EXACT byte-match, modulo the one intentional divergence: the
  # `(.vendor "…")` header (nifparser stamps "nifparser", nifler "Nifler").
  # Neutralise ONLY that directive on both sides before the byte compare;
  # every other byte must still be identical.
  sed 's/^(\.vendor "[^"]*")/(.vendor "<vendor>")/' "$ref" > "$WORK/$base.ref.exact"
  sed 's/^(\.vendor "[^"]*")/(.vendor "<vendor>")/' "$our" > "$WORK/$base.our.exact"
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
