## parser.nim — recursive-descent parser that emits AIF DIRECTLY via nifbuilder,
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
import std/syncio

include parsecore
include parse_expr
include parse_type
include parse_stmt

proc parseModule*(ps: var Parser; b: var Builder) =
  # AIF header. We emit our own `(.aif27)` magic rather than nifbuilder's
  # `addHeader` (which hardcodes `(.nif27)`): aifparser's wire format is a
  # deliberate rebrand of NIF, so the magic, vendor, and `.aif` extension all
  # carry the AIF identity. The body grammar is otherwise identical, so the
  # differential harness normalises the `(.aif27)`↔`(.nif27)` header line before
  # comparing against the nifler oracle.
  b.addRaw "(.aif27)\n"
  b.addRaw "(.vendor "
  b.addStrLit "aifparser"
  b.addRaw ")\n"
  b.addRaw "(.dialect "
  b.addStrLit "nim-parsed"
  b.addRaw ")\n"
  # The module `stmts` node anchors at the FIRST token — nifler's
  # `newNodeP(nkStmtList, p)` takes the current token at parseAll start. A leading
  # `##` doc comment IS that token (our lexer tokenises it and emits `(comment)`,
  # so the anchor stays on line 1); regular `#` comments are never tokenised, so
  # the anchor lands on the first real statement (e.g. line 3 after a header
  # comment + blank). All child line-info is relative to this, so getting the
  # anchor right removes the delta cascade that otherwise breaks every file whose
  # first statement is not on line 1.
  let first = ps.tok(0)
  let sl = if first.kind == tkEof: 1'i32 else: first.line
  let sc = if first.kind == tkEof: 0'i32 else: first.col
  b.addTree "stmts"
  ps.emitInfo(b, sl, sc, 0, 0, true)   # module stmts: absolute (first-token pos, file)
  var i = 0
  while ps.tok(i).kind != tkEof:
    let before = i
    let t = ps.tok(i)
    if t.kind == tkKeyword and t.s == "type":
      # Top-level `type` sections route to parse_type.nim. (Nested type
      # sections in routine bodies re-enter via parseStmt, whose `type`
      # dispatch is owned by parse_stmt.nim.)
      i = ps.parseTypeSection(b, i, sl, sc)
    else:
      i = ps.parseStmt(b, i, sl, sc, -1)
    # A trailing `##` doc comment (indented deeper than the top level) documents
    # the statement just parsed — nifler attaches it, so drop it here.
    i = ps.skipTrailingDoc(i, 0)
    # Safety net for the "never hangs" contract: if a statement parser returned
    # without consuming a token, force progress so a pathological construct
    # surfaces as a (visible) structural mismatch instead of an infinite loop.
    if i <= before: i = before + 1
  b.endTree()
