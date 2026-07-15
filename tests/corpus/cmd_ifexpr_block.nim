proc g() =
  addUIntTypedOp dest, if kind == InclS: BitorX else: BitandX, 8, info:
    addLhs()
    if kind == ExclS:
      dest.addParLe BitnotX, info
      dest.addUIntType(8, info)
    addUIntTypedOp dest, ShlX, 8, info:
      dest.addUIntLit(1, info)
