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
for bad in 'let x == 5' 'const C == 5' 'let x: int == 5' 'let (a, b) == p' 'var v == 5'; do
  printf '%s\n' "$bad" > "$WORK/cb.nim"
  grep -q 'comparison-in-binding' <<<"$("$NP" check "$WORK/cb.nim" 2>&1)" || {
    echo "FAIL: '$bad' should flag comparison-in-binding"; fail=1; }
done
# (4f2b) walrus-in-binding — the Pascal/Go ':=' assignment in a binding
# ('let x := 5'). Found via the nifler differential (nifler rejects it, aowlparser
# was silent). ':=' lexes as one operator, distinct from a ':' type annotation.
for bad in 'let x := 5' 'const C := 5' 'var v := 5'; do
  printf '%s\n' "$bad" > "$WORK/cb.nim"
  grep -q 'walrus-in-binding' <<<"$("$NP" check "$WORK/cb.nim" 2>&1)" || {
    echo "FAIL: '$bad' should flag walrus-in-binding"; fail=1; }
done
for ok in 'let x: int = 5' 'let x = 5'; do
  printf '%s\n' "$ok" > "$WORK/cb.nim"
  grep -q 'walrus-in-binding' <<<"$("$NP" check "$WORK/cb.nim" 2>&1)" && {
    echo "FAIL: '$ok' must NOT flag walrus-in-binding"; fail=1; }
done

# 'var' as a TYPE MODIFIER (not a binding) must never flag — it is only a binding
# when it starts its line.
for ok in 'let x = a == b' 'const C = (1 == 1)' 'let ok = f(x == y)' 'let z = 1' \
          'proc f(x: var int) = discard' 'proc g(): var int = q'; do
  printf '%s\n' "$ok" > "$WORK/cb.nim"
  grep -q 'comparison-in-binding' <<<"$("$NP" check "$WORK/cb.nim" 2>&1)" && {
    echo "FAIL: '$ok' must NOT flag comparison-in-binding"; fail=1; }
done

# (4f3) else-if-not-elif — the C/Python 'else if' habit ('else' must be
# followed by ':'; the chain keyword is 'elif'). Fires on adjacent 'else if',
# silent on the valid 'else:' block that merely CONTAINS an 'if'.
printf 'if a:\n  discard\nelse if b:\n  discard\n' > "$WORK/ei.nim"
grep -q 'else-if-not-elif' <<<"$("$NP" check "$WORK/ei.nim" 2>&1)" || {
  echo "FAIL: 'else if b:' should flag else-if-not-elif"; fail=1; }
for ok in 'else:\n  if b:\n    discard' 'elif b:\n  discard' 'else:\n  discard'; do
  printf 'if a:\n  discard\n%b\n' "$ok" > "$WORK/ei.nim"
  grep -q 'else-if-not-elif' <<<"$("$NP" check "$WORK/ei.nim" 2>&1)" && {
    echo "FAIL: valid else/elif must NOT flag else-if-not-elif ($ok)"; fail=1; }
done

# (4f3b) arrow-return-type — the Rust/Python-3/C++ '->' return arrow
# ('proc f() -> int'). Found via the nifler differential. Flagged ONLY in a
# routine header; the std/sugar lambda operator '(x) -> y' and a proc returning a
# lambda type ('proc f(): (int) -> int') must stay clean.
printf 'proc g() -> int = 2\n' > "$WORK/ar.nim"
grep -q 'arrow-return-type' <<<"$("$NP" check "$WORK/ar.nim" 2>&1)" || {
  echo "FAIL: 'proc g() -> int' should flag arrow-return-type"; fail=1; }
for ok in 'proc f(): int = 1' 'let f = (x: int) -> x + 1' 'proc f(): (int) -> int = nil'; do
  printf 'import std/sugar\n%b\n' "$ok" > "$WORK/ar.nim"
  grep -q 'arrow-return-type' <<<"$("$NP" check "$WORK/ar.nim" 2>&1)" && {
    echo "FAIL: valid '->' use must NOT flag arrow-return-type ($ok)"; fail=1; }
done

# (4f3c) double-colon — the C++ scope-resolution habit ('std::vector'). Nim
# qualifies with '.'. '::' lexes as one operator; a '::' inside a string (IPv6
# "::1", doc "a::b") is part of the string token and must stay clean.
printf 'let v = std::vector\n' > "$WORK/dc.nim"
grep -q 'double-colon' <<<"$("$NP" check "$WORK/dc.nim" 2>&1)" || {
  echo "FAIL: 'std::vector' should flag double-colon"; fail=1; }
for ok in 'let ip = "::1"' 'let s = "a::b"' 'let x: int = 5' 'proc f(): int = 1'; do
  printf '%b\n' "$ok" > "$WORK/dc.nim"
  grep -q 'double-colon' <<<"$("$NP" check "$WORK/dc.nim" 2>&1)" && {
    echo "FAIL: '$ok' must NOT flag double-colon"; fail=1; }
done

# (4f3d) angle-bracket-generics — the C++/Java/Rust/TS habit ('proc f<T>()').
# Nim generics use '[T]'. Flagged only right after a routine NAME; defining the
# '<' operator ('proc `<`') and ordinary comparisons must stay clean.
printf 'proc f<T>(x: T) = discard\n' > "$WORK/ag.nim"
grep -q 'angle-bracket-generics' <<<"$("$NP" check "$WORK/ag.nim" 2>&1)" || {
  echo "FAIL: 'proc f<T>()' should flag angle-bracket-generics"; fail=1; }
for ok in 'proc f[T](x: T) = discard' 'proc `<`(a, b: int): bool = a < b' 'let z = a < b' 'func cmp[T](a: T): int = 0'; do
  printf '%b\n' "$ok" > "$WORK/ag.nim"
  grep -q 'angle-bracket-generics' <<<"$("$NP" check "$WORK/ag.nim" 2>&1)" && {
    echo "FAIL: '$ok' must NOT flag angle-bracket-generics"; fail=1; }
done

# (4f3e) stray-end — the Ruby/Pascal/Lua block terminator ('end' on its own
# line). 'end' is a reserved Nim keyword with no statement form.
printf 'proc f() =\n  discard\nend\n' > "$WORK/se.nim"
grep -q 'stray-end' <<<"$("$NP" check "$WORK/se.nim" 2>&1)" || {
  echo "FAIL: a trailing 'end' should flag stray-end"; fail=1; }
# valid code must not flag
printf 'proc f() =\n  discard\n' > "$WORK/se.nim"
grep -q 'stray-end' <<<"$("$NP" check "$WORK/se.nim" 2>&1)" && {
  echo "FAIL: valid code must NOT flag stray-end"; fail=1; }

# (4f3e2) mut-not-a-keyword — the Rust 'let mut x' habit. Nim has no 'mut'
# keyword; a mutable binding is 'var'. Flag 'let/var/const mut <name>' only.
# Must NOT flag 'let mut = 5' (a variable NAMED mut) or 'x: var int' modifier.
for bad in 'let mut x = 5' 'var mut y = 1' 'const mut z = 2'; do
  printf '%b\n' "$bad" > "$WORK/mk.nim"
  grep -q 'mut-not-a-keyword' <<<"$("$NP" check "$WORK/mk.nim" 2>&1)" || {
    echo "FAIL: '$bad' should flag mut-not-a-keyword"; fail=1; }
done
for ok in 'let mut = 5' 'let mutable = 5' 'let mut_x = 5' 'proc f(x: var int) = discard'; do
  printf '%b\n' "$ok" > "$WORK/mk.nim"
  grep -q 'mut-not-a-keyword' <<<"$("$NP" check "$WORK/mk.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must NOT flag mut-not-a-keyword"; fail=1; }
done

# (4f3e3) go-var-notype — the Go/Java/C#/Swift 'name type' binding, missing the
# ':'. Nim writes 'var x: int'. Must NOT flag ':'-typed, '='-init, comma-list,
# pragma or 'var' type-modifier forms.
for bad in 'var x int' 'let y string' 'const z float' 'var p* int'; do
  printf '%b\n' "$bad" > "$WORK/gv.nim"
  grep -q 'go-var-notype' <<<"$("$NP" check "$WORK/gv.nim" 2>&1)" || {
    echo "FAIL: '$bad' should flag go-var-notype"; fail=1; }
done
for ok in 'var x: int' 'let y = 5' 'const z = 3.0' 'var a, b: int' 'var x* = 5' \
          'var x {.global.}: int' 'let (a, b) = t' 'proc f(): var int = x'; do
  printf '%b\n' "$ok" > "$WORK/gv.nim"
  grep -q 'go-var-notype' <<<"$("$NP" check "$WORK/gv.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must NOT flag go-var-notype"; fail=1; }
done

# (4f3f) c-brace-body — the C/Java/JS-style '{ }' block body ('proc f() { }').
# Nim uses an indented body after '='. Must NOT flag a pragma '{.….}', a set
# literal, or a term-rewriting template pattern ('template t{pat}(…)').
for bad in 'proc f() {\n  discard\n}' 'proc g(): int {\n  discard\n}'; do
  printf '%b\n' "$bad" > "$WORK/cb2.nim"
  grep -q 'c-brace-body' <<<"$("$NP" check "$WORK/cb2.nim" 2>&1)" || {
    echo "FAIL: C-brace body should flag c-brace-body ($bad)"; fail=1; }
done
for ok in 'proc f() {.inline.} = discard' 'proc f(): int {.inline.} = 1' \
          'proc f(x = {1, 2}) = discard' 'template optZero{x * 0}(x: int): int = 0'; do
  printf '%b\n' "$ok" > "$WORK/cb2.nim"
  grep -q 'c-brace-body' <<<"$("$NP" check "$WORK/cb2.nim" 2>&1)" && {
    echo "FAIL: valid '{' use must NOT flag c-brace-body ($ok)"; fail=1; }
done

# (4f3g) foreign-function-keyword — a routine defined with a FOREIGN function
# keyword (Rust 'fn', JS 'function', Kotlin 'fun') and a C-style '{ }' body. Nim
# uses 'proc name() = <body>'. Must NOT flag a call 'fn(x)', a variable named
# 'function'/'fun', or a command-call chain.
for bad in 'fn main() {\n  discard\n}' 'function f() {\n  return 1\n}' 'fun greet() {\n  echo 1\n}'; do
  printf '%b\n' "$bad" > "$WORK/ff.nim"
  grep -q 'foreign-function-keyword' <<<"$("$NP" check "$WORK/ff.nim" 2>&1)" || {
    echo "FAIL: '$(echo "$bad"|head -1)' should flag foreign-function-keyword"; fail=1; }
done
for ok in 'fn(x)' 'let function = 5' 'echo fun(x)' 'result = fn(a, b)' 'fun(a) + g(b)'; do
  printf '%b\n' "$ok" > "$WORK/ff.nim"
  grep -q 'foreign-function-keyword' <<<"$("$NP" check "$WORK/ff.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must NOT flag foreign-function-keyword"; fail=1; }
done

# (4f3h) foreign-block-keyword — an OO/type/module block from another language
# (class/struct/interface/impl/trait/namespace/module) with a C-style '{ }' body.
# Nim declares types with 'type Name = object'. Must NOT flag a variable/call use
# of those words, or a real 'type … = object'.
for bad in 'class Foo {\n  discard\n}' 'struct P {\n  x: int\n}' 'interface I {\n  discard\n}' \
           'impl Foo {\n  discard\n}' 'trait T {\n  discard\n}' 'namespace N {\n  discard\n}' \
           'module M {\n  discard\n}'; do
  printf '%b\n' "$bad" > "$WORK/fb.nim"
  grep -q 'foreign-block-keyword' <<<"$("$NP" check "$WORK/fb.nim" 2>&1)" || {
    echo "FAIL: '$(echo "$bad"|head -1)' should flag foreign-block-keyword"; fail=1; }
done
for ok in 'type Foo = object' 'let class = 5' 'echo struct(x)' 'var impl = f()' \
          'namespace(a, b)' 'module.foo()'; do
  printf '%b\n' "$ok" > "$WORK/fb.nim"
  grep -q 'foreign-block-keyword' <<<"$("$NP" check "$WORK/fb.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must NOT flag foreign-block-keyword"; fail=1; }
done

# (4f3i) foreign-case-block — a C/Java/Rust/Scala 'switch'/'match' with a brace
# body. Nim's is 'case <expr>:' with 'of' branches. Must NOT flag a variable/call.
for bad in 'switch (x) {\n  discard\n}' 'switch x {\n  discard\n}' \
           'match x {\n  discard\n}' 'match (x) {\n  discard\n}'; do
  printf '%b\n' "$bad" > "$WORK/fc.nim"
  grep -q 'foreign-case-block' <<<"$("$NP" check "$WORK/fc.nim" 2>&1)" || {
    echo "FAIL: '$(echo "$bad"|head -1)' should flag foreign-case-block"; fail=1; }
done
for ok in 'let switch = 5' 'echo match(x)' 'result = switch and y'; do
  printf '%b\n' "$ok" > "$WORK/fc.nim"
  grep -q 'foreign-case-block' <<<"$("$NP" check "$WORK/fc.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must NOT flag foreign-case-block"; fail=1; }
done

# (4f3j) do-while-loop ('do { } while') + ruby-block-params ('do |x|'). 'do' is a
# Nim keyword; 'do (x):' block params and a bare 'do:' must stay clean.
printf 'do {\n  discard\n} while (x)\n' > "$WORK/dw.nim"
grep -q 'do-while-loop' <<<"$("$NP" check "$WORK/dw.nim" 2>&1)" || {
  echo "FAIL: 'do { } while' should flag do-while-loop"; fail=1; }
printf 'xs.each do |i|\n  discard\n' > "$WORK/dw.nim"
grep -q 'ruby-block-params' <<<"$("$NP" check "$WORK/dw.nim" 2>&1)" || {
  echo "FAIL: 'do |i|' should flag ruby-block-params"; fail=1; }
for ok in 'xs.map do (i: int):\n  echo i' 'proc f() =\n  do:\n    echo 1'; do
  printf '%b\n' "$ok" > "$WORK/dw.nim"
  grep -qE 'do-while-loop|ruby-block-params' <<<"$("$NP" check "$WORK/dw.nim" 2>&1)" && {
    echo "FAIL: valid '$(echo "$ok"|head -1)' must NOT flag a do-block habit"; fail=1; }
done

# (4f3k) c-block-comment — a C/Java/JS '/* … */' block comment. Nim uses '#[ … ]#'.
# Must NOT flag '/*' inside a string or a '#' line comment, or real division 'a / b'.
for bad in '/* comment */\nlet x = 5' 'let x = 5 /* c */' '/*multi\nline*/\nlet y = 1'; do
  printf '%b\n' "$bad" > "$WORK/bc.nim"
  grep -q 'c-block-comment' <<<"$("$NP" check "$WORK/bc.nim" 2>&1)" || {
    echo "FAIL: '$(echo "$bad"|head -1)' should flag c-block-comment"; fail=1; }
done
for ok in 'let s = "/* not a comment */"' 'let c = "a/*b"' 'let x = a / b' 'let y = a div b'; do
  printf '%b\n' "$ok" > "$WORK/bc.nim"
  grep -q 'c-block-comment' <<<"$("$NP" check "$WORK/bc.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must NOT flag c-block-comment"; fail=1; }
done

# (4f3l) foreign-routine-clause — a Java 'throws' / Rust-Swift-C# 'where' clause on
# a routine header. Nim uses a '{.raises.}' pragma and '[T: Constraint]' generics.
# Must NOT flag a routine NAMED throws/where, a real return type, or a constraint.
for bad in 'proc f() throws IOError = discard' 'proc f[T](x: T) where T: int = discard' \
           'proc f() override = discard' 'proc f() noexcept = discard'; do
  printf '%b\n' "$bad" > "$WORK/rc.nim"
  grep -q 'foreign-routine-clause' <<<"$("$NP" check "$WORK/rc.nim" 2>&1)" || {
    echo "FAIL: '$bad' should flag foreign-routine-clause"; fail=1; }
done
for ok in 'proc f() = discard' 'proc f(): int = 1' 'proc throws() = discard' \
          'proc where(x: int) = discard' 'proc f[T: int](x: T) = discard' \
          'proc f() {.raises: [].} = discard' 'let where = 5' \
          'proc override() = discard' 'proc noexcept(x: int) = discard'; do
  printf '%b\n' "$ok" > "$WORK/rc.nim"
  grep -q 'foreign-routine-clause' <<<"$("$NP" check "$WORK/rc.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must NOT flag foreign-routine-clause"; fail=1; }
done

# (4f3m) extends-inheritance — the Java/TS/Scala 'type Foo extends Bar' clause.
# Nim inherits with 'type Foo = object of Bar'. Must NOT flag 'object of Bar', a
# generic, or a type/variable literally named 'extends'.
for bad in 'type Foo extends Bar = object' 'type Dog extends Animal = ref object'; do
  printf '%b\n' "$bad" > "$WORK/ex.nim"
  grep -q 'extends-inheritance' <<<"$("$NP" check "$WORK/ex.nim" 2>&1)" || {
    echo "FAIL: '$bad' should flag extends-inheritance"; fail=1; }
done
for ok in 'type Foo = object' 'type Foo = object of Bar' 'type Foo = ref object of RootObj' \
          'type Foo[T] = object' 'type extends = int' 'let extends = 5'; do
  printf '%b\n' "$ok" > "$WORK/ex.nim"
  grep -q 'extends-inheritance' <<<"$("$NP" check "$WORK/ex.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must NOT flag extends-inheritance"; fail=1; }
done

# (4f3n) yield-from ('yield from xs') + async-routine-prefix ('async proc f()').
# Nim iterates+yields and marks async with a '{.async.}' pragma. Must NOT flag a
# bare 'yield x', 'from m import x', 'await'/'async' calls, or an anonymous proc.
printf 'iterator it(): int =\n  yield from xs\n' > "$WORK/y.nim"
grep -q 'yield-from' <<<"$("$NP" check "$WORK/y.nim" 2>&1)" || {
  echo "FAIL: 'yield from' should flag yield-from"; fail=1; }
for bad in 'async proc f() = discard' 'async func g(): int = 1'; do
  printf '%b\n' "$bad" > "$WORK/y.nim"
  grep -q 'async-routine-prefix' <<<"$("$NP" check "$WORK/y.nim" 2>&1)" || {
    echo "FAIL: '$bad' should flag async-routine-prefix"; fail=1; }
done
for ok in 'let x = await foo()' 'async foo()' 'let f = proc() = discard' \
          'proc f() {.async.} = discard' 'let async = 5' 'from m import x'; do
  printf '%b\n' "$ok" > "$WORK/y.nim"
  grep -qE 'yield-from|async-routine-prefix' <<<"$("$NP" check "$WORK/y.nim" 2>&1)" && {
    echo "FAIL: valid '$ok' must NOT flag an async/yield habit"; fail=1; }
done

# (4f4) c-style-operator — OPT-IN only (--c-operators:warn). '&&'/'||' are Nim's
# 'and'/'or'. Off by default (they are definable operators); on, they warn but
# never touch a real 'and'/'or'.
printf 'if a && b or c:\n  discard\n' > "$WORK/co.nim"
grep -q 'c-style-operator' <<<"$("$NP" check "$WORK/co.nim" 2>&1)" && {
  echo "FAIL: && must NOT be flagged by DEFAULT"; fail=1; }
grep -q 'c-style-operator' <<<"$("$NP" check --c-operators:warn "$WORK/co.nim" 2>&1)" || {
  echo "FAIL: --c-operators:warn should flag &&"; fail=1; }
printf 'if a and b or c:\n  discard\n' > "$WORK/co.nim"
grep -q 'c-style-operator' <<<"$("$NP" check --c-operators:warn "$WORK/co.nim" 2>&1)" && {
  echo "FAIL: valid and/or must NOT flag c-style-operator"; fail=1; }

# (4f5) redundant-semicolon — OPT-IN (--semicolons:warn). A statement-level
# trailing ';' is redundant; a ';' INSIDE (...) is a param/tuple separator and
# must NEVER be flagged (the multi-line-proc false positive the corpus caught).
printf 'let x = 5;\n' > "$WORK/sc.nim"
grep -q 'redundant-semicolon' <<<"$("$NP" check "$WORK/sc.nim" 2>&1)" && {
  echo "FAIL: redundant-semicolon must be OFF by default"; fail=1; }
grep -q 'redundant-semicolon' <<<"$("$NP" check --semicolons:warn "$WORK/sc.nim" 2>&1)" || {
  echo "FAIL: --semicolons:warn should flag a trailing ';'"; fail=1; }
# param-separator ';' inside a multi-line proc signature: NEVER flagged
printf 'proc f(a: int;\n       b: int) = discard\n' > "$WORK/sc.nim"
grep -q 'redundant-semicolon' <<<"$("$NP" check --semicolons:warn "$WORK/sc.nim" 2>&1)" && {
  echo "FAIL: a ';' param separator inside () must NOT be flagged"; fail=1; }
# a ';' BETWEEN statements on one line is not trailing: not flagged
printf 'let a = 1; let b = 2\n' > "$WORK/sc.nim"
grep -q 'redundant-semicolon' <<<"$("$NP" check --semicolons:warn "$WORK/sc.nim" 2>&1)" && {
  echo "FAIL: a mid-line separator ';' must NOT be flagged"; fail=1; }

# (4f6) redundant-bool-literal — OPT-IN idiom lint (--idioms:warn). `x == true`,
# `x != false`, `x == false`, `x != true` are all redundant bool compares.
printf 'let z = ok == true\n' > "$WORK/id.nim"
grep -q 'redundant-bool-literal' <<<"$("$NP" check "$WORK/id.nim" 2>&1)" && {
  echo "FAIL: redundant-bool-literal must be OFF by default"; fail=1; }
for src in 'let z = ok == true' 'let z = ok != false' 'let z = ok == false' \
           'let z = ok != true' 'let z = true == ok'; do
  printf "$src\n" > "$WORK/id.nim"
  grep -q 'redundant-bool-literal' <<<"$("$NP" check --idioms:warn "$WORK/id.nim" 2>&1)" || {
    echo "FAIL: --idioms:warn should flag '$src'"; fail=1; }
done
# must NOT fire on an identifier that merely STARTS with true/false, or a real compare
for ok in 'let z = a == truthy' 'let z = a == b' 'let z = falsey == a'; do
  printf "$ok\n" > "$WORK/id.nim"
  grep -q 'redundant-bool-literal' <<<"$("$NP" check --idioms:warn "$WORK/id.nim" 2>&1)" && {
    echo "FAIL: '$ok' must NOT be flagged as redundant-bool-literal"; fail=1; }
done

# (4f7) double-negation — OPT-IN (--idioms:warn). `not not x` collapses to x.
printf 'let z = not not ready\n' > "$WORK/dn.nim"
grep -q 'double-negation' <<<"$("$NP" check "$WORK/dn.nim" 2>&1)" && {
  echo "FAIL: double-negation must be OFF by default"; fail=1; }
grep -q 'double-negation' <<<"$("$NP" check --idioms:warn "$WORK/dn.nim" 2>&1)" || {
  echo "FAIL: --idioms:warn should flag 'not not'"; fail=1; }
# a single `not` is fine; 'not not' inside a comment/string is never a token match
printf 'let z = not ready\n## does not not matter\n' > "$WORK/dn.nim"
grep -q 'double-negation' <<<"$("$NP" check --idioms:warn "$WORK/dn.nim" 2>&1)" && {
  echo "FAIL: a single 'not' (and 'not not' in a comment) must NOT be flagged"; fail=1; }

# (4f7b) not-in-precedence — OPT-IN (--idioms:warn). `not x in y` parses as
# `(not x) in y`; the Python migrant wants `x notin y`.
for src in 'let a = not x in y' 'let a = not obj.field in s' 'let a = not f(a) in s'; do
  printf "$src\n" > "$WORK/np.nim"
  grep -q 'not-in-precedence' <<<"$("$NP" check --idioms:warn "$WORK/np.nim" 2>&1)" || {
    echo "FAIL: --idioms:warn should flag '$src'"; fail=1; }
done
printf 'let a = not x in y\n' > "$WORK/np.nim"
grep -q 'not-in-precedence' <<<"$("$NP" check "$WORK/np.nim" 2>&1)" && {
  echo "FAIL: not-in-precedence must be OFF by default"; fail=1; }
# must NOT fire on the CORRECT forms
for ok in 'let a = not (x in y)' 'let a = x notin y' 'let a = not p and q in r' \
          'for i in items:\n  discard'; do
  printf "$ok\n" > "$WORK/np.nim"
  grep -q 'not-in-precedence' <<<"$("$NP" check --idioms:warn "$WORK/np.nim" 2>&1)" && {
    echo "FAIL: correct form '$ok' must NOT be flagged"; fail=1; }
done

# (4f7c) not-compare-precedence — OPT-IN (--idioms:warn). `not x == y` parses as
# `(not x) == y`; the migrant means `not (x == y)`, i.e. `x != y`.
for src in 'let a = not x == y' 'let a = not x != y' 'let a = not obj.f == z'; do
  printf "$src\n" > "$WORK/nc.nim"
  grep -q 'not-compare-precedence' <<<"$("$NP" check --idioms:warn "$WORK/nc.nim" 2>&1)" || {
    echo "FAIL: --idioms:warn should flag '$src'"; fail=1; }
done
printf 'let a = not x == y\n' > "$WORK/nc.nim"
grep -q 'not-compare-precedence' <<<"$("$NP" check "$WORK/nc.nim" 2>&1)" && {
  echo "FAIL: not-compare-precedence must be OFF by default"; fail=1; }
for ok in 'let a = not (x == y)' 'let a = x != y' 'let a = not p and q == r'; do
  printf "$ok\n" > "$WORK/nc.nim"
  grep -q 'not-compare-precedence' <<<"$("$NP" check --idioms:warn "$WORK/nc.nim" 2>&1)" && {
    echo "FAIL: correct form '$ok' must NOT be flagged"; fail=1; }
done

# (4f9) nil-comparison — OPINION, own flag (--nil-comparison:warn), default OFF.
printf 'let a = p == nil\n' > "$WORK/nl.nim"
grep -q 'nil-comparison' <<<"$("$NP" check "$WORK/nl.nim" 2>&1)" && {
  echo "FAIL: nil-comparison must be OFF by default"; fail=1; }
for src in 'let a = p == nil' 'let a = p != nil' 'let a = nil == p'; do
  printf "$src\n" > "$WORK/nl.nim"
  grep -q 'nil-comparison' <<<"$("$NP" check --nil-comparison:warn "$WORK/nl.nim" 2>&1)" || {
    echo "FAIL: --nil-comparison:warn should flag '$src'"; fail=1; }
done

# (4f10) yoda-condition — OPINION, own flag (--yoda:warn), default OFF. A literal on
# the LEFT; must NOT fire on two literals, nor on a var on the left.
printf 'let a = 0 == n\n' > "$WORK/yd.nim"
grep -q 'yoda-condition' <<<"$("$NP" check "$WORK/yd.nim" 2>&1)" && {
  echo "FAIL: yoda-condition must be OFF by default"; fail=1; }
for src in 'let a = 0 == n' 'let a = "s" == name' 'let a = 3.5 != x'; do
  printf "$src\n" > "$WORK/yd.nim"
  grep -q 'yoda-condition' <<<"$("$NP" check --yoda:warn "$WORK/yd.nim" 2>&1)" || {
    echo "FAIL: --yoda:warn should flag '$src'"; fail=1; }
done
for ok in 'let a = 1 == 2' 'let a = n == 0' 'let a = x == nil' 'let a = ok == true'; do
  printf "$ok\n" > "$WORK/yd.nim"
  grep -q 'yoda-condition' <<<"$("$NP" check --yoda:warn "$WORK/yd.nim" 2>&1)" && {
    echo "FAIL: '$ok' must NOT be flagged as yoda-condition"; fail=1; }
done

# (4h) DIAGNOSTIC POSITIONING — regression guards for the fixes to imprecise spans.
# expected-colon on a ONE-LINER points after the condition (before the statement
# keyword), not at end-of-line; and the header/body split is handled once.
printf 'if 4 == 2 return false\n' > "$WORK/pos.nim"
out="$("$NP" check --diagnostics:json "$WORK/pos.nim" 2>&1)"
grep -q '"code":"expected-colon"' <<<"$out" || { echo "FAIL: one-liner missing ':' not flagged"; fail=1; }
grep -q '"col":9' <<<"$out" || { echo "FAIL: colon should point after the condition (col 9): $out"; fail=1; }
# a colon-less header with an INDENTED body reports the missing ':' EXACTLY ONCE
# (the duplicate-diagnostic bug), even nested in a routine body — across EVERY
# block form (if/while/for/block/try/case).
for hdr in 'if x' 'while x' 'for x in xs' 'block' 'try'; do
  printf 'proc f() =\n  %s\n    echo 1\n' "$hdr" > "$WORK/pos.nim"
  n="$("$NP" check "$WORK/pos.nim" 2>&1 | grep -c 'expected-colon')"
  [ "$n" = "1" ] || { echo "FAIL: nested colon-less '$hdr' should report ':' ONCE, got $n"; fail=1; }
done
# a colon-less `for` must NOT also raise a bogus expected-in (the `in` is present).
printf 'proc f() =\n  for x in xs\n    echo 1\n' > "$WORK/pos.nim"
grep -q 'expected-in' <<<"$("$NP" check "$WORK/pos.nim" 2>&1)" && {
  echo "FAIL: colon-less 'for' must not report a bogus expected-in"; fail=1; }
# but a genuinely missing 'in' still reports expected-in
printf 'proc f() =\n  for x xs:\n    echo 1\n' > "$WORK/pos.nim"
grep -q 'expected-in' <<<"$("$NP" check "$WORK/pos.nim" 2>&1)" || {
  echo "FAIL: a real missing 'in' should report expected-in"; fail=1; }

# (4f7d) simplify-boolean-return — OPT-IN (--idioms:warn). `if c: return true
# else: return false` (and the result=/swap/inline variants) returns the condition.
printf 'proc f(c: bool): bool =\n  if c:\n    return true\n  else:\n    return false\n' > "$WORK/sb.nim"
grep -q 'simplify-boolean-return' <<<"$("$NP" check "$WORK/sb.nim" 2>&1)" && {
  echo "FAIL: simplify-boolean-return must be OFF by default"; fail=1; }
for src in 'proc f(c: bool): bool =\n  if c:\n    return true\n  else:\n    return false' \
           'proc f(c: bool): bool =\n  if c: return false\n  else: return true' \
           'proc f(c: bool): bool =\n  if c:\n    result = true\n  else:\n    result = false'; do
  printf "$src\n" > "$WORK/sb.nim"
  grep -q 'simplify-boolean-return' <<<"$("$NP" check --idioms:warn "$WORK/sb.nim" 2>&1)" || {
    echo "FAIL: --idioms:warn should flag boolean-return '$src'"; fail=1; }
done
# must NOT fire: same bool, expr-if, elif chain, richer branch, mixed kind
for ok in 'proc f(c: bool): bool =\n  if c:\n    return true\n  else:\n    return true' \
          'let x = if c: true else: false' \
          'proc f(c: bool): bool =\n  if c:\n    return true\n  elif d:\n    return false\n  else:\n    return true' \
          'proc f(c: bool): bool =\n  if c:\n    echo 1\n    return true\n  else:\n    return false' \
          'proc f(c: bool): bool =\n  if c:\n    result = true\n  else:\n    return false'; do
  printf "$ok\n" > "$WORK/sb.nim"
  grep -q 'simplify-boolean-return' <<<"$("$NP" check --idioms:warn "$WORK/sb.nim" 2>&1)" && {
    echo "FAIL: '$ok' must NOT be flagged as simplify-boolean-return"; fail=1; }
done

# (4f8) float-equality — OPT-IN, own flag (--float-equality:warn), also in pedantic.
printf 'let z = x == 3.14\n' > "$WORK/fe.nim"
grep -q 'float-equality' <<<"$("$NP" check "$WORK/fe.nim" 2>&1)" && {
  echo "FAIL: float-equality must be OFF by default"; fail=1; }
grep -q 'float-equality' <<<"$("$NP" check --idioms:warn "$WORK/fe.nim" 2>&1)" && {
  echo "FAIL: float-equality must NOT ride --idioms:warn (it has its own flag)"; fail=1; }
for src in 'let z = x == 3.14' 'let z = x != 0.5' 'let z = 1.0 == x'; do
  printf "$src\n" > "$WORK/fe.nim"
  grep -q 'float-equality' <<<"$("$NP" check --float-equality:warn "$WORK/fe.nim" 2>&1)" || {
    echo "FAIL: --float-equality:warn should flag '$src'"; fail=1; }
done
# an INTEGER literal compare is NOT float-equality
printf 'let z = x == 3\n' > "$WORK/fe.nim"
grep -q 'float-equality' <<<"$("$NP" check --float-equality:warn "$WORK/fe.nim" 2>&1)" && {
  echo "FAIL: an integer compare must NOT be flagged as float-equality"; fail=1; }

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
  ['let x = 1_']=invalid-number
  ['let x = 1e']=invalid-number
  ['let x = 1.5e']=invalid-number
  ['let x = 1e+']=invalid-number
  ['let x = 100L']=invalid-number
  ['let x = 100LL']=invalid-number
  ['let x = 100n']=invalid-number
  ['let x = 0xFFg']=invalid-number )
for src in "${!badstr[@]}"; do
  printf '%s\n' "$src" > "$WORK/ls.nim"
  grep -q "${badstr[$src]}" <<<"$("$NP" check "$WORK/ls.nim" 2>&1)" || {
    echo "FAIL: '$src' should report ${badstr[$src]}"; fail=1; }
done
for ok in 'let s = "a\nb\t\\x41é"' 'let s = "\x1B"' 'let s = "\u{1F600}"' \
          'let s = """closed"""' 'let s = r"closed"' 'let x = 1_000_000' 'let h = 0xFF_FF' \
          'let x = 1e10' 'let x = 1.5e-3' 'let x = 1E5' 'let x = 1.0f' "let x = 100'i64" \
          'let x = 100u' 'let x = 0xFF'; do
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
  # the PRIMARY marker sits on the signature (line 1, where the '=' belongs), not
  # on the body's first line; the body is the RELATED note.
  grep -qE ':1:[0-9]+: error\[missing-routine-equals\]' <<<"$out" || {
    echo "FAIL: missing '=' should anchor on the signature line (1), got: $out"; fail=1; }
  grep -q 'read as the body' <<<"$out" || {
    echo "FAIL: missing '=' should relate to the body line"; fail=1; }
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
