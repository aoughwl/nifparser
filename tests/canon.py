#!/usr/bin/env python3
"""canon.py — canonicalise a NIF token stream for STRUCTURAL comparison.

Reads NIF text on stdin (or a file arg) and prints one token per line:
  (            tree open
  <tag>        the tree's tag (line-info / comment suffix stripped)
  <atom>       an atom (ident, symbol, number, `.` empty, ...) suffix-stripped
  "<string>"   a string literal, content preserved verbatim
  )            tree close

Line-info (`@...` / bare `~...`) and comment (`#...#`) suffixes are removed from
tags and atoms so two parsers that agree on STRUCTURE but differ only in
line/col diffs compare equal. String-literal contents are never touched (NIF
escapes all control/marker bytes inside strings, so they cannot be confused
with a suffix).

This is the oracle-comparison core of tests/diff.sh.
"""
import sys

# Chars that may follow a raw '@' / '~' as part of a NIF27 line-info suffix,
# or appear in an (escaped) file path segment.
_INFO = set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
            ",~._/\\-")


def _strip_suffix(atom: str) -> str:
    """Cut an atom/tag at the first RAW line-info (@ / ~) or comment (#) marker.

    Escapes appear as `\\HH`; a real '@'/'~'/'#'/'"' byte inside an ident or
    string is always emitted as such an escape, so a bare one here can only be
    a suffix introducer.
    """
    out = []
    i = 0
    n = len(atom)
    while i < n:
        c = atom[i]
        if c == "\\" and i + 2 < n:
            out.append(atom[i:i+3])
            i += 3
            continue
        if c in "@~#":
            break
        out.append(c)
        i += 1
    return "".join(out)


def tokenize(text: str):
    toks = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n":
            i += 1
            continue
        if c == "(":
            toks.append("(")
            i += 1
            # read the tag immediately following '('
            j = i
            while j < n and text[j] not in " \t\r\n()\"":
                if text[j] == "\\":
                    j += 3
                else:
                    j += 1
            tag = text[i:j]
            if tag:
                toks.append(_strip_suffix(tag))
            i = j
            continue
        if c == ")":
            toks.append(")")
            i += 1
            continue
        if c == '"':
            # string literal: copy verbatim including escapes to closing quote
            j = i + 1
            buf = ['"']
            while j < n and text[j] != '"':
                if text[j] == "\\":
                    buf.append(text[j:j+3])
                    j += 3
                else:
                    buf.append(text[j])
                    j += 1
            buf.append('"')
            if j < n:
                j += 1  # consume closing quote
            toks.append("".join(buf))
            i = j
            continue
        # bare atom
        j = i
        while j < n and text[j] not in " \t\r\n()\"":
            if text[j] == "\\":
                j += 3
            else:
                j += 1
        atom = text[i:j]
        toks.append(_strip_suffix(atom))
        i = j
    return toks


def neutralize_vendor(toks):
    """Blank the value of the `(.vendor "…")` header directive.

    nifparser stamps its own vendor identity ("nifparser") where classic nifler
    writes "Nifler". That single header string is the ONE intentional divergence;
    everything else must still match byte-for-byte structurally. We replace only
    the vendor string token with a fixed placeholder so the directive's STRUCTURE
    is still compared, but its identity value is not. Nothing else is touched.
    """
    out = list(toks)
    for i in range(len(out) - 2):
        if out[i] == "(" and out[i + 1] == ".vendor" and out[i + 2].startswith('"'):
            out[i + 2] = '"<vendor>"'
    return out


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    else:
        text = sys.stdin.read()
    for t in neutralize_vendor(tokenize(text)):
        sys.stdout.write(t + "\n")


if __name__ == "__main__":
    main()
