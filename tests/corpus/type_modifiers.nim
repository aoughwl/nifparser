var t: Table[string, ref Foo]
proc f(a: sink seq[string]) = discard
var u: seq[ref Bar]
var v: ptr array[4, byte]
var w: array[succ(low(T))..high(T), int]
proc g[T: HasDefault, L: Keyable and HasDefault](x: T) = discard
proc h(a: varargs[string, `$`]) = discard
