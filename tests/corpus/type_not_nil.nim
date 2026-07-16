func toCString*(s: var string): cstring not nil =
  result = cast[cstring not nil](rawData(s))
