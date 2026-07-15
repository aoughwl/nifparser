proc run() =
  try:
    writeFile(src, "x")
  except OSError, IOError:
    return
  except ValueError:
    discard

proc walk(n: Cursor) =
  var skipDepth = -1
    ## trailing doc on the var, dropped
  result = 0
