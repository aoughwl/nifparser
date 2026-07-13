#!/usr/bin/env bash
# stress.sh — differential fuzz over real .nim files.
# Usage: stress.sh <dir-or-file>...   (defaults to a set of nimony source dirs)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NIFLER="${NIFLER:-/home/savant/nimony/bin/nifler}"
NIFPARSER="${NIFPARSER:-$ROOT/bin/nifparser}"
CANON="$ROOT/tests/canon.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

inputs=()
if [ "$#" -eq 0 ]; then
  set -- /home/savant/nimony/src/lib
fi
for arg in "$@"; do
  if [ -d "$arg" ]; then
    while IFS= read -r f; do inputs+=("$f"); done < <(find "$arg" -name '*.nim')
  else
    inputs+=("$arg")
  fi
done

total=0; oraclefail=0; ourfail=0; mismatch=0; pass=0
mfiles=""; ofiles=""
for nim in "${inputs[@]}"; do
  total=$((total+1))
  ref="$WORK/r.nif"; our="$WORK/o.nif"
  rm -f "$ref" "$our"
  timeout 10 "$NIFLER"    p "$nim" "$ref" >/dev/null 2>"$WORK/r.err"
  if [ ! -s "$ref" ]; then oraclefail=$((oraclefail+1)); ofiles="$ofiles $nim"; continue; fi
  timeout 10 "$NIFPARSER" p "$nim" "$our" >/dev/null 2>"$WORK/o.err"
  if [ ! -s "$our" ]; then ourfail=$((ourfail+1)); mfiles="$mfiles CRASH:$nim"; continue; fi
  python3 "$CANON" "$ref" > "$WORK/r.canon"
  python3 "$CANON" "$our" > "$WORK/o.canon"
  if diff -q "$WORK/r.canon" "$WORK/o.canon" >/dev/null; then
    pass=$((pass+1))
  else
    mismatch=$((mismatch+1)); mfiles="$mfiles $nim"
  fi
done
echo "stress: total=$total  pass=$pass  mismatch=$mismatch  our-crash=$ourfail  oracle-skip=$oraclefail"
[ -n "$mfiles" ] && { echo "MISMATCH/CRASH files:"; for f in $mfiles; do echo "  $f"; done; }
