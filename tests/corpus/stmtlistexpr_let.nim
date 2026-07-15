proc f(n: int): bool =
  if (let pk = compute(n); pk != 0):
    result = true
