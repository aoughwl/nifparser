type
  Cell = object
    when not UseDestructors:
      zeroField: int
      when sizeof(int) == 4:
        headerAlignPad: array[8, byte]
    else:
      alignment: int

proc clearBit(t: var uint32; u: uint) =
  t = t and not
      (uint(1) shl (u and 0x1f))
