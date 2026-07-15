proc `==`(a, b: int): bool = true
proc `$`(x: int): string = ""
proc `[]=`(a, b, c: int) = discard
var `type` = 3
type T = object
  `end`: int
type E = enum
  `object`
let z = system.`==`(a, b)
