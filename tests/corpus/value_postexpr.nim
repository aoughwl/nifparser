let resolvedFile = onRaiseQuit:
  if currentFile.isAbsolute: absolutePath(currentFile)
  else: absolutePath(currentFile)

let handler = build(cfg):
  step one
  step two

let cb = proc (path: string): int = len(path)
