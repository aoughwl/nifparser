## parser.nim — recursive-descent parser that emits NIF DIRECTLY via nifbuilder,
## matching classic `nifler`'s output.
##
## This module is a THIN aggregator. The grammar is split across include files:
##
##   parsecore.nim   — Parser type, token cursor, line-info, op tables, range scan,
##                     and the cross-file FORWARD DECLS
##   parse_expr.nim  — expressions / operators / constructors
##   parse_type.nim  — type defs, routine/proc defs, params, pragmas
##   parse_stmt.nim  — statements, control flow, var/let/const sections
##
## Splice order matters (forward decls in parsecore bridge the mutual recursion):
##   core → expr → type → stmt.
##
## Fused parse + emit: constructs are written to the `Builder` as recognised, with
## bounded lookahead over the flat token list — no PNode AST (object-variant ref
## trees crash nimony's field magics). Line-info suffixes are emitted relative to
## each node's parent so output matches native nifler byte-for-byte on supported
## constructs.

import tokens
import nifbuilder

include parsecore
include parse_expr
include parse_type
include parse_stmt

proc parseModule*(ps: var Parser; b: var Builder) =
  b.addHeader "nifparser", "nim-parsed"
  b.addTree "stmts"
  ps.emitInfo(b, 1, 0, 0, 0, true)   # module stmts: absolute (col 0, line 1, file)
  var i = 0
  while ps.tok(i).kind != tkEof:
    let t = ps.tok(i)
    if t.kind == tkKeyword and t.s == "type":
      # Top-level `type` sections route to parse_type.nim. (Nested type
      # sections in routine bodies re-enter via parseStmt, whose `type`
      # dispatch is owned by parse_stmt.nim.)
      i = ps.parseTypeSection(b, i, 1, 0)
    else:
      i = ps.parseStmt(b, i, 1, 0, -1)
  b.endTree()
