proc main =
  mixin succ, pred
  bind foo
proc paramless =
  discard
type V = object
  case kind: K
  of A: nil
  of B: discard
  of C:
    x: int
