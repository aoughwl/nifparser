proc outer() =
  setTerminate proc() {.noconv.} =
    setTerminate(nil)
    var msg = "x"
    rawQuit 1
