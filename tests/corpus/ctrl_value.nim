let a = (when defined(windows): "win"
         else: "other")
let b = q & (when cond: "y" else: "z")
let c = (case k
  of 1: "a"
  of 2, 3: "b"
  else: "c")
let d = (if p: 1 else: 2)
