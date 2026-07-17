template mapIt*(s: typed, op: untyped): untyped =
  block:
    let f = proc (x: InType): OutType =
              let it {.inject.} = x
              op
    map(s, f)
