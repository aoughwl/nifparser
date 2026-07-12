import std/syncio

var xs = @[3, 1, 4, 1, 5, 9, 2, 6]
var total = 0
for x in xs:
  total = total + x
echo "sum of ", xs.len, " numbers = ", total
