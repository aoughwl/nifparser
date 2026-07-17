template eventParser*(pegAst, handlers: untyped): (proc(s: string): int) =
  discard
proc f(): (iterator(): int) = discard
