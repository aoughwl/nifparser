proc f() =
  for name {.inject.} in toDelete:
    discard name
