type
  ProgressProc*[R] =
    proc (a: int):
      R {.closure, gcsafe.}

  Other* = ref object
