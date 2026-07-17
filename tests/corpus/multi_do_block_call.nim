proc f() =
  withData(p.selector, fd.SocketHandle, adata) do:
    adata.readList.add(cb)
    newEvents.incl(Event.Read)
  do:
    raise newException(ValueError, "not registered")
