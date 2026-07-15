proc sortStuff(result: var seq[int]) =
  result.sort proc(a, b: int): int = cmp(a, b)
  entries.sort(proc(a, b: (string, int)): int = cmp(a[0], b[0]))
