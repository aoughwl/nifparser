template hasItems(iter: untyped): bool =
  when compiles((for _ in items(iter): discard)):
    true
  else:
    false

proc f(iter: untyped): auto =
  result = typeof((block: init))

proc g(xs: seq[(int, string)]) =
  for (a, b) in xs:
    discard
