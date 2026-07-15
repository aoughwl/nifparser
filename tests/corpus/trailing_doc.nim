const LocalSigKinds = {LetY, VarY, GletY}
  ## trailing doc line one
  ## trailing doc line two

proc signaturesMatch(a: int): bool =
  ## body doc kept as a statement
  discard

## standalone comment kept

var y = 2
  ## trailing on var dropped
