proc f(e: int) =
  case patKindOf(e)
  of pkInt:    (let v = intVal(p); (if v notin intVals: intVals.add v))
  of pkSymLit: (let s = symName(p); (if s notin symStrs: symStrs.add s))
