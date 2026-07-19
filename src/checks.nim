## checks.nim - the pure diagnostic layer shared by the CLI driver and the
## browser/JS entry (`webmain.nim`).
##
## This is the SAME recoverable-diagnostics surface `aowlparser check` exposes,
## with NO file/stdout I/O, so it compiles cleanly through the nimony-web JS
## backend and runs in the playground. The three producers are:
##
##   * the lexer's own `gLexDiags` (unknown bytes, unterminated literals, style
##     warnings) - collected by `tokenize`;
##   * `checkBrackets` - unbalanced / mismatched `()[]{}`, with a related
##     "opened here" location and a suggested fix;
##   * `checkGrammar` - grammar errors the range-splitter copes with but a real
##     front end rejects (identifier-expected, assignment-in-condition, empty
##     condition, trailing operator), each with a fix hint.
##
## The parser ALSO records grammar diagnostics as it copes (`ps.diags`); the
## caller merges those in and calls `sortBySourceOrder` before rendering.
## `diagsToJson` is the machine-readable shape the editor consumes, carrying the
## optional `fix` and `related` fields.
##
## Kept byte-faithful to the canonical driver (aowlparser.nim) so the two never
## drift: the playground gets exactly the CLI's error coverage.

import tokens, lexer

# --- structural bracket validation ------------------------------------------

proc closerFor(k: TokKind): char =
  ## The `)`/`]`/`}` character for a bracket kind. Accepts BOTH the open and the
  ## close kind: checkBrackets reports on the offending CLOSE token, so leaving
  ## `tkParRi`/`tkBracketRi` out of the match made every mismatched close print
  ## as `}` regardless of what it actually was.
  case k
  of tkParLe, tkParRi: ')'
  of tkBracketLe, tkBracketRi: ']'
  else: '}'

proc openerFor(k: TokKind): char =
  ## The `(`/`[`/`{` character for a bracket kind (either open or close kind).
  case k
  of tkParLe, tkParRi: '('
  of tkBracketLe, tkBracketRi: '['
  else: '{'

proc matchesClose(open, close: TokKind): bool =
  (open == tkParLe and close == tkParRi) or
  (open == tkBracketLe and close == tkBracketRi) or
  (open == tkCurlyLe and close == tkCurlyRi)

proc checkBrackets*(toks: seq[Token]): seq[Diagnostic] =
  ## Structural check the range-splitter itself never reports: unbalanced or
  ## mismatched `()`/`[]`/`{}`. A stack of opens is matched against each close;
  ## a wrong or surplus close, and every open left unclosed at EOF, becomes a
  ## `sevError` diagnostic with the offending token's span. Purely a validator  - 
  ## it does not affect the emitted AIF (the parser stays best-effort).
  result = @[]
  var stack: seq[Token] = @[]
  for t in toks:
    case t.kind
    of tkParLe, tkBracketLe, tkCurlyLe:
      stack.add t
    of tkParRi, tkBracketRi, tkCurlyRi:
      if stack.len == 0:
        result.add Diagnostic(severity: sevError, code: "unmatched-close",
          message: "unmatched '" & closerFor(t.kind) & "'",
          line: t.line, col: t.col, endCol: t.col + 1)
      elif not matchesClose(stack[stack.len - 1].kind, t.kind):
        let top = stack[stack.len - 1]
        result.add Diagnostic(severity: sevError, code: "mismatched-bracket",
          message: "'" & closerFor(t.kind) & "' does not match '" &
                   openerFor(top.kind) & "'",
          line: t.line, col: t.col, endCol: t.col + 1,
          fix: "change it to '" & closerFor(top.kind) & "' or fix the opener",
          relMsg: "'" & openerFor(top.kind) & "' opened here",
          relLine: top.line, relCol: top.col)
        stack.setLen(stack.len - 1)
      else:
        stack.setLen(stack.len - 1)
    else: discard
  for t in stack:
    result.add Diagnostic(severity: sevError, code: "unclosed-bracket",
      message: "unclosed '" & openerFor(t.kind) & "'",
      line: t.line, col: t.col, endCol: t.col + 1,
      fix: "add a matching '" & closerFor(t.kind) & "'")

proc checkGrammar*(toks: seq[Token]; opts: LexOptions): seq[Diagnostic] =
  ## Grammar-level errors the range-splitter silently copes with but nifler
  ## rejects. Purely a validator  -  never changes the emitted AIF. Conservative:
  ## every case here is UNAMBIGUOUSLY malformed (zero false positives on valid
  ## Nim), so `check` can flag it the way a real front end would.
  result = @[]
  # OPT-IN advisory: the C boolean operators `&&`/`||` (Nim uses `and`/`or`).
  # These ARE definable operators, so this fires ONLY under --c-operators:warn,
  # and it carries a suggestion, never an auto-fix  -  `and`/`or` bind at a
  # different precedence, so the rewrite needs a human's eye.
  if opts.cOperatorsWarn:
    for ci in 0 ..< toks.len:
      let t = toks[ci]
      if t.kind == tkOperator and (t.s == "&&" or t.s == "||"):
        let word = if t.s == "&&": "and" else: "or"
        result.add Diagnostic(severity: sevWarn, code: "c-style-operator",
          message: "'" & t.s & "' is not a Nim boolean operator  -  use '" & word & "'",
          line: t.line, col: t.col, endCol: t.endCol,
          fix: "use '" & word & "' (mind operator precedence)")
  # OPT-IN advisory: a redundant trailing `;`. Nim separates statements by
  # newline; a STATEMENT-LEVEL (depth-0) `;` that is the LAST significant token on
  # its line (ignoring a trailing comment) separates from nothing and is safely
  # removable. Crucially we track bracket depth: a `;` INSIDE `()`/`[]`/`{}` is a
  # parameter / generic / tuple separator (`proc f(a: int;\n b: int)`) and is NOT
  # redundant even when it ends a line  -  flagging it would be a false positive. A
  # `;` BETWEEN two statements on one line (`a; b`) is not last, so never flagged.
  if opts.semicolonWarn:
    var sdepth = 0
    for si in 0 ..< toks.len:
      let t = toks[si]
      if t.kind == tkParLe or t.kind == tkBracketLe or t.kind == tkCurlyLe:
        inc sdepth
      elif t.kind == tkParRi or t.kind == tkBracketRi or t.kind == tkCurlyRi:
        if sdepth > 0: dec sdepth
      elif t.kind == tkSemicolon and sdepth == 0:
        var n = si + 1
        while n < toks.len and toks[n].kind == tkComment: inc n
        if n >= toks.len or toks[n].kind == tkEof or toks[n].line != t.line:
          result.add Diagnostic(severity: sevWarn, code: "redundant-semicolon",
            message: "redundant trailing ';'  -  Nim separates statements by newline",
            line: t.line, col: t.col, endCol: t.endCol,
            fix: "remove the ';'")
  # OPT-IN idiomatic lints on VALID code (`--idioms:warn`). These never change the
  # emitted AIF and default OFF, so the zero-FP corpus stays clean. Each is a HINT:
  # the code compiles, it just isn't how a Nim programmer would write it.
  if opts.idiomsWarn or opts.floatEqWarn or opts.nilStyleWarn or opts.yodaWarn:
    # A single scan over the `==`/`!=` operators feeds several INDEPENDENTLY-gated
    # lints: the bool-literal compare (idiomsWarn), float-equality (floatEqWarn),
    # nil-comparison (nilStyleWarn), and the yoda condition (yodaWarn). Any flag
    # alone activates only its own branch.
    for oi in 0 ..< toks.len:
      let op = toks[oi]
      if op.kind != tkOperator or (op.s != "==" and op.s != "!="): continue
      # significant neighbours
      var np = oi + 1
      while np < toks.len and toks[np].kind == tkComment: inc np
      var pp = oi - 1
      while pp >= 0 and toks[pp].kind == tkComment: dec pp
      # `x == true` / `x == false` / `x != true` / `x != false`  -  comparing to a
      # bool LITERAL is always redundant (it only type-checks when x is a bool).
      # `true`/`false` lex as identifiers, so match on the ident text.
      var litTok = -1
      if np < toks.len and toks[np].kind == tkIdent and
         (toks[np].s == "true" or toks[np].s == "false"):
        litTok = np
      elif pp >= 0 and toks[pp].kind == tkIdent and
         (toks[pp].s == "true" or toks[pp].s == "false"):
        litTok = pp
      if opts.idiomsWarn and litTok >= 0:
        let lit = toks[litTok].s
        # `== true` / `!= false` reduce to the expression; the other two need `not`.
        let identity = (op.s == "==" and lit == "true") or
                       (op.s == "!=" and lit == "false")
        let advice =
          if identity: "drop the '" & op.s & " " & lit & "'  -  use the expression itself"
          else: "rewrite as 'not <expr>'"
        result.add Diagnostic(severity: sevHint, code: "redundant-bool-literal",
          message: "comparing to the bool literal '" & lit & "' is redundant",
          line: op.line, col: op.col, endCol: op.endCol,
          fix: advice)
      # `x == 3.14`  -  exact float equality is unreliable. Gated SEPARATELY (it is
      # noisier: exact-value math tests legitimately use it), so it rides its own
      # flag and only fires when floatEqWarn is on.
      elif opts.floatEqWarn and
           ((np < toks.len and toks[np].kind == tkFloatLit) or
            (pp >= 0 and toks[pp].kind == tkFloatLit)):
        result.add Diagnostic(severity: sevHint, code: "float-equality",
          message: "'" & op.s & "' on a float literal is unreliable  -  floats rarely compare exactly",
          line: op.line, col: op.col, endCol: op.endCol,
          fix: "compare with a tolerance, e.g. abs(a - b) < 1e-9, or use 'almostEqual'")
      # `x == nil` / `x != nil`  -  an OPINION (off by default, config-gated). Many
      # projects prefer `x.isNil` / `not x.isNil`. `nil` is a keyword, so the match
      # is unambiguous. Independent branch (co-fires with nothing else here).
      if opts.nilStyleWarn and
         ((np < toks.len and toks[np].kind == tkKeyword and toks[np].s == "nil") or
          (pp >= 0 and toks[pp].kind == tkKeyword and toks[pp].s == "nil")):
        let repl = if op.s == "==": "x.isNil" else: "not x.isNil"
        result.add Diagnostic(severity: sevHint, code: "nil-comparison",
          message: "'" & op.s & " nil'  -  this project prefers 'isNil'",
          line: op.line, col: op.col, endCol: op.endCol,
          fix: "use '" & repl & "'")
      # Yoda condition  -  a LITERAL on the left of the compare (`0 == x`). An OPINION
      # (off by default): Nim has no `if x = 0` foot-gun to guard against, so the
      # natural `x == 0` reads better. Fires only when the LEFT is a number/string/
      # char literal and the RIGHT is NOT a literal (so `1 == 2` and the bool/nil
      # cases handled above are excluded).
      if opts.yodaWarn and pp >= 0 and np < toks.len:
        let lp = toks[pp].kind
        let leftLit = lp == tkIntLit or lp == tkFloatLit or lp == tkStrLit or
                      lp == tkRStrLit or lp == tkTripleStrLit or lp == tkCharLit
        let rk = toks[np].kind
        let rightLit = rk == tkIntLit or rk == tkFloatLit or rk == tkStrLit or
                       rk == tkRStrLit or rk == tkTripleStrLit or rk == tkCharLit or
                       (rk == tkKeyword and toks[np].s == "nil") or
                       (rk == tkIdent and (toks[np].s == "true" or toks[np].s == "false"))
        if leftLit and not rightLit:
          result.add Diagnostic(severity: sevHint, code: "yoda-condition",
            message: "a literal on the left of '" & op.s & "' (a 'yoda' compare)  -  put the value first",
            line: op.line, col: op.col, endCol: op.endCol,
            fix: "write '<expr> " & op.s & " " & toks[pp].s & "'")
    # `not not x`  -  a double negation. `not` is a keyword; two adjacent (ignoring
    # comments) collapse to identity. Only doc-comment prose ever says "not not",
    # and that lexes as tkComment, so it is never matched here. idiomsWarn only.
    if opts.idiomsWarn:
     for ni in 0 ..< toks.len:
      let n1 = toks[ni]
      if n1.kind != tkKeyword or n1.s != "not": continue
      var nn = ni + 1
      while nn < toks.len and toks[nn].kind == tkComment: inc nn
      if nn < toks.len and toks[nn].kind == tkKeyword and toks[nn].s == "not":
        result.add Diagnostic(severity: sevHint, code: "double-negation",
          message: "'not not' is a redundant double negation",
          line: n1.line, col: n1.col, endCol: toks[nn].endCol,
          fix: "remove both 'not's (the value is unchanged)")
        continue
      # `not x in y`  -  a precedence trap. Unary `not` binds tighter than the `in`
      # operator, so this parses as `(not x) in y`, almost never what a Python
      # migrant means (`x notin y`). We fire ONLY on the unambiguous shape
      # `not <primary> in`, where <primary> is an identifier and its `.field`,
      # `[i]`, `(args)` postfixes  -  never on `not (...)` (correctly grouped) nor when
      # a binary operator (`and`, `==`, ...) sits before the `in`. Zero corpus hits.
      if nn < toks.len and toks[nn].kind == tkIdent:
        var k = nn                              # last token of the primary so far
        var walking = true
        while walking:
          var m = k + 1
          while m < toks.len and toks[m].kind == tkComment: inc m
          if m >= toks.len: break
          let t = toks[m]
          if t.kind == tkDot:                   # .field
            var n = m + 1
            while n < toks.len and toks[n].kind == tkComment: inc n
            if n < toks.len and toks[n].kind == tkIdent: k = n
            else: walking = false
          elif t.kind == tkBracketLe or t.kind == tkParLe:   # [i] / (args)
            var d = 1
            var n = m + 1
            while n < toks.len and d > 0:
              let tk = toks[n].kind
              if tk == tkBracketLe or tk == tkParLe or tk == tkCurlyLe: inc d
              elif tk == tkBracketRi or tk == tkParRi or tk == tkCurlyRi: dec d
              inc n
            k = n - 1
          else:
            walking = false
        var af = k + 1
        while af < toks.len and toks[af].kind == tkComment: inc af
        if af < toks.len and toks[af].kind == tkKeyword and toks[af].s == "in":
          result.add Diagnostic(severity: sevHint, code: "not-in-precedence",
            message: "'not " & toks[nn].s & " in ...' means '(not " & toks[nn].s &
                     ") in ...'  -  you likely want 'notin'",
            line: n1.line, col: n1.col, endCol: toks[af].endCol,
            fix: "use 'x notin y' (or parenthesize: 'not (x in y)')")
        elif af < toks.len and toks[af].kind == tkOperator and
             (toks[af].s == "==" or toks[af].s == "!="):
          # `not x == y` parses as `(not x) == y`; the migrant means `not (x == y)`,
          # i.e. the OTHER comparison. Same unary-binds-tighter trap as `not ... in`.
          let want = if toks[af].s == "==": "!=" else: "=="
          result.add Diagnostic(severity: sevHint, code: "not-compare-precedence",
            message: "'not " & toks[nn].s & " " & toks[af].s & " ...' means '(not " &
                     toks[nn].s & ") " & toks[af].s & " ...'  -  you likely want '" &
                     want & "'",
            line: n1.line, col: n1.col, endCol: toks[af].endCol,
            fix: "use '" & want & "' (or parenthesize: 'not (x " & toks[af].s & " y)')")
     # `if cond: return true else: return false`  -  the simplify-boolean-return
     # smell (return/assign the condition directly). Structural: fires ONLY on the
     # exact two-branch shape where each branch is a SINGLE `return <bool>` (or
     # `result = <bool>`) of the SAME kind with OPPOSITE bools. Statement-level
     # `if` only (indent >= 0, so `let x = if ...` is skipped), `else` must dedent to
     # the `if`'s own column, and the else body must not continue  -  so any richer
     # branch is never matched. Every match is genuinely simplifiable -> zero FP.
     for i in 0 ..< toks.len:
      let kw = toks[i]
      if kw.kind != tkKeyword or kw.s != "if": continue
      if kw.indent < 0: continue
      # condition -> first depth-0 ':'
      var depth = 0
      var colon1 = -1
      var j = i + 1
      while j < toks.len:
        let t = toks[j]
        if t.kind == tkEof: break
        if t.kind == tkParLe or t.kind == tkBracketLe or t.kind == tkCurlyLe: inc depth
        elif t.kind == tkParRi or t.kind == tkBracketRi or t.kind == tkCurlyRi:
          if depth > 0: dec depth
        elif depth == 0 and t.kind == tkColon: colon1 = j; break
        inc j
      if colon1 < 0 or colon1 == i + 1: continue
      # then branch: `return <bool>` or `result = <bool>`
      var p = colon1 + 1
      while p < toks.len and toks[p].kind == tkComment: inc p
      if p >= toks.len: continue
      var thenKind = ""
      var thenBool = ""
      var afterThen = -1
      if toks[p].kind == tkKeyword and toks[p].s == "return":
        var q = p + 1
        while q < toks.len and toks[q].kind == tkComment: inc q
        if q < toks.len and toks[q].kind == tkIdent and
           (toks[q].s == "true" or toks[q].s == "false"):
          thenKind = "return"; thenBool = toks[q].s; afterThen = q + 1
      elif toks[p].kind == tkIdent and toks[p].s == "result":
        var q = p + 1
        while q < toks.len and toks[q].kind == tkComment: inc q
        if q < toks.len and toks[q].kind == tkOperator and toks[q].s == "=":
          var r = q + 1
          while r < toks.len and toks[r].kind == tkComment: inc r
          if r < toks.len and toks[r].kind == tkIdent and
             (toks[r].s == "true" or toks[r].s == "false"):
            thenKind = "result"; thenBool = toks[r].s; afterThen = r + 1
      if thenKind.len == 0: continue
      # the then body must end immediately at `else` (at the if's own column)
      var e = afterThen
      while e < toks.len and toks[e].kind == tkComment: inc e
      if e >= toks.len or toks[e].kind != tkKeyword or toks[e].s != "else": continue
      if toks[e].indent != kw.indent: continue
      var ec = e + 1
      while ec < toks.len and toks[ec].kind == tkComment: inc ec
      if ec >= toks.len or toks[ec].kind != tkColon: continue
      # else branch: same kind, a bool
      var ep = ec + 1
      while ep < toks.len and toks[ep].kind == tkComment: inc ep
      if ep >= toks.len: continue
      var elseKind = ""
      var elseBool = ""
      var afterElse = -1
      if toks[ep].kind == tkKeyword and toks[ep].s == "return":
        var q = ep + 1
        while q < toks.len and toks[q].kind == tkComment: inc q
        if q < toks.len and toks[q].kind == tkIdent and
           (toks[q].s == "true" or toks[q].s == "false"):
          elseKind = "return"; elseBool = toks[q].s; afterElse = q + 1
      elif toks[ep].kind == tkIdent and toks[ep].s == "result":
        var q = ep + 1
        while q < toks.len and toks[q].kind == tkComment: inc q
        if q < toks.len and toks[q].kind == tkOperator and toks[q].s == "=":
          var r = q + 1
          while r < toks.len and toks[r].kind == tkComment: inc r
          if r < toks.len and toks[r].kind == tkIdent and
             (toks[r].s == "true" or toks[r].s == "false"):
            elseKind = "result"; elseBool = toks[r].s; afterElse = r + 1
      if elseKind.len == 0 or elseKind != thenKind: continue
      if thenBool == elseBool: continue            # opposite bools only
      # the else body must END here: next significant token is EOF, or a
      # first-on-line token that dedents to <= the if's column (not a 2nd stmt,
      # not a same-line continuation).
      var af2 = afterElse
      while af2 < toks.len and toks[af2].kind == tkComment: inc af2
      if af2 < toks.len and toks[af2].kind != tkEof:
        if toks[af2].indent < 0 or toks[af2].indent > kw.indent: continue
      let lead = if thenKind == "result": "result = " else: "return "
      let advice =
        if thenBool == "true": "replace the whole if/else with '" & lead & "<condition>'"
        else: "replace the whole if/else with '" & lead & "not (<condition>)'"
      result.add Diagnostic(severity: sevHint, code: "simplify-boolean-return",
        message: "this 'if ...: " & thenKind & " " & thenBool & " else: " & thenKind &
                 " " & elseBool & "' just returns the condition  -  " & lead & "it directly",
        line: kw.line, col: kw.col, endCol: kw.endCol,
        fix: advice)
  # OPINION: `if (cond):`  -  a condition wrapped in parens that span the WHOLE
  # condition. Nim needs no parens around a control-flow condition, so this is a
  # C/Java/Python habit. We fire ONLY when the `(` immediately follows the keyword
  # and its MATCHING `)` is immediately followed by `:` (or `,`/`do`-less) at
  # depth 0  -  i.e. the parens wrap the entire condition, not a sub-expression like
  # `if (a or b) and c:`. Zero-FP as a detection (the parens are provably
  # redundant); an OPINION because some prefer them for clarity.
  if opts.redundantParensWarn:
    for i in 0 ..< toks.len:
      let kw = toks[i]
      if kw.kind != tkKeyword or
         (kw.s != "if" and kw.s != "elif" and kw.s != "while" and kw.s != "when"):
        continue
      # next significant token must be `(`
      var op = i + 1
      while op < toks.len and toks[op].kind == tkComment: inc op
      if op >= toks.len or toks[op].kind != tkParLe: continue
      # find its match  -  and note whether the parens are LOAD-BEARING: a stmt-list
      # expr `(a; b)`, a declaration `(let x = e; ...)`, or a tuple `(a, b)` all NEED
      # the parens, so a `;`/`,`/`let`/`var`/`const` at the paren's OWN depth means
      # "not redundant" and we must not advise dropping them.
      var depth = 1
      var m = op + 1
      var loadBearing = false
      while m < toks.len and depth > 0:
        let tk = toks[m].kind
        if tk == tkParLe or tk == tkBracketLe or tk == tkCurlyLe: inc depth
        elif tk == tkParRi or tk == tkBracketRi or tk == tkCurlyRi: dec depth
        elif depth == 1 and (tk == tkSemicolon or tk == tkComma): loadBearing = true
        elif depth == 1 and tk == tkKeyword and
             (toks[m].s == "let" or toks[m].s == "var" or toks[m].s == "const"):
          loadBearing = true
        if depth == 0: break
        inc m
      if depth != 0 or m >= toks.len or loadBearing: continue
      # the `)` must be immediately followed by `:`  -  then the parens wrapped the
      # entire condition. (A call like `if (f)(x):` has a token between `)` and `:`.)
      var af = m + 1
      while af < toks.len and toks[af].kind == tkComment: inc af
      if af >= toks.len or toks[af].kind != tkColon: continue
      result.add Diagnostic(severity: sevHint, code: "redundant-parens-condition",
        message: "'" & kw.s & "' needs no parentheses around its condition in Nim",
        line: toks[op].line, col: toks[op].col, endCol: toks[op].endCol,
        fix: "drop the outer '(' ... ')'")
  # OPINION: `s & ""` or `"" & s`  -  concatenating an empty string literal is a
  # no-op. `&` is the string/seq concat operator; an empty `""` on either side of
  # it contributes nothing. Zero-FP: an empty string literal is unambiguous.
  if opts.emptyStrWarn:
    for i in 0 ..< toks.len:
      let o = toks[i]
      if o.kind != tkOperator or o.s != "&": continue
      var np = i + 1
      while np < toks.len and toks[np].kind == tkComment: inc np
      var pp = i - 1
      while pp >= 0 and toks[pp].kind == tkComment: dec pp
      let emptyR = np < toks.len and toks[np].kind == tkStrLit and toks[np].s.len == 0
      let emptyL = pp >= 0 and toks[pp].kind == tkStrLit and toks[pp].s.len == 0
      if emptyR or emptyL:
        result.add Diagnostic(severity: sevHint, code: "empty-string-concat",
          message: "concatenating an empty string \"\" with '&' is a no-op",
          line: o.line, col: o.col, endCol: o.endCol,
          fix: "drop the empty \"\" (and the '&')")
  # OPINION: a bare `echo` statement  -  a debug print a project may want out of
  # committed code. `echo` lexes as an identifier; we fire only when it BEGINS a
  # statement (first significant token on its line  -  `indent >= 0`), so `discard
  # echo ...` or `x = echo` (never valid, but) and mid-expression uses don't match.
  if opts.echoWarn:
    for i in 0 ..< toks.len:
      let e = toks[i]
      if e.kind != tkIdent or e.s != "echo" or e.indent < 0: continue
      result.add Diagnostic(severity: sevHint, code: "debug-echo",
        message: "'echo' statement  -  a debug print; consider a logging facility",
        line: e.line, col: e.col, endCol: e.endCol,
        fix: "remove the 'echo' or route it through your logger")
  # OPINION: `0 .. n - 1`  -  an inclusive range whose end is `<expr> - 1`. Nim's
  # half-open `0 ..< n` says exactly the same with no off-by-one to get wrong. We
  # fire only when the range end (from `..` to its depth-0 terminator `:`/`,`/`]`/
  # `)`/`}`/newline) ENDS in a binary `- 1`. Zero-FP: `..` then `... - 1` at the end
  # is provably equal to `..< ...`.
  if opts.rangeIndexWarn:
    for i in 0 ..< toks.len:
      let o = toks[i]
      if o.kind != tkOperator or o.s != "..": continue
      # collect the range-end tokens (depth-aware) until a depth-0 terminator
      var depth = 0
      var lastSig = -1        # last significant token index
      var prevSig = -1        # the one before it
      var j = i + 1
      var scanning = true
      while j < toks.len and scanning:
        let t = toks[j]
        if t.kind == tkComment:
          inc j
        elif t.kind == tkEof:
          scanning = false
        elif depth == 0 and lastSig >= 0 and t.line != o.line:
          scanning = false
        elif t.kind == tkParLe or t.kind == tkBracketLe or t.kind == tkCurlyLe:
          inc depth
          prevSig = lastSig; lastSig = j; inc j
        elif t.kind == tkParRi or t.kind == tkBracketRi or t.kind == tkCurlyRi:
          if depth == 0: scanning = false
          else:
            dec depth
            prevSig = lastSig; lastSig = j; inc j
        elif depth == 0 and (t.kind == tkColon or t.kind == tkComma):
          scanning = false
        else:
          prevSig = lastSig; lastSig = j; inc j
      # last two significant tokens must be `-` (binary op) then `1` (int literal)
      if lastSig >= 0 and prevSig >= 0 and
         toks[lastSig].kind == tkIntLit and toks[lastSig].s == "1" and
         toks[prevSig].kind == tkOperator and toks[prevSig].s == "-":
        result.add Diagnostic(severity: sevHint, code: "manual-range-index",
          message: "'.. n - 1'  -  Nim's half-open '..< n' avoids the off-by-one",
          line: o.line, col: o.col, endCol: o.endCol,
          fix: "use '..<' and drop the '- 1'")
  # OPINION: catching or raising the base `Exception`  -  too broad (it also catches
  # Defects, which signal bugs you should not swallow). `except Exception` and
  # `newException(Exception, ...)` both name it explicitly, so this is zero-FP as a
  # detection; the recommended base is `CatchableError` (or a specific type).
  if opts.broadExceptWarn:
    for i in 0 ..< toks.len:
      let t = toks[i]
      # `except Exception`
      if t.kind == tkKeyword and t.s == "except":
        var n = i + 1
        while n < toks.len and toks[n].kind == tkComment: inc n
        if n < toks.len and toks[n].kind == tkIdent and toks[n].s == "Exception":
          result.add Diagnostic(severity: sevHint, code: "broad-exception",
            message: "'except Exception' is too broad  -  it also catches Defects",
            line: toks[n].line, col: toks[n].col, endCol: toks[n].endCol,
            fix: "catch 'CatchableError' or a specific exception type")
      # `newException(Exception, ...)`
      elif t.kind == tkIdent and t.s == "newException":
        var n = i + 1
        while n < toks.len and toks[n].kind == tkComment: inc n
        if n < toks.len and toks[n].kind == tkParLe:
          var a = n + 1
          while a < toks.len and toks[a].kind == tkComment: inc a
          if a < toks.len and toks[a].kind == tkIdent and toks[a].s == "Exception":
            result.add Diagnostic(severity: sevHint, code: "broad-exception",
              message: "raising the base 'Exception' is too broad  -  use a specific type",
              line: toks[a].line, col: toks[a].col, endCol: toks[a].endCol,
              fix: "raise a specific exception type (e.g. ValueError)")
  # OPINION: a BARE `except:` (no type)  -  catches everything, Defects included, and
  # silently swallows bugs. `except` immediately followed by `:` is unambiguous.
  if opts.bareExceptWarn:
    for i in 0 ..< toks.len:
      let t = toks[i]
      if t.kind != tkKeyword or t.s != "except": continue
      var n = i + 1
      while n < toks.len and toks[n].kind == tkComment: inc n
      if n < toks.len and toks[n].kind == tkColon:
        result.add Diagnostic(severity: sevHint, code: "bare-except",
          message: "a bare 'except:' catches everything, including Defects",
          line: t.line, col: t.col, endCol: t.endCol,
          fix: "name the exception(s) you handle, e.g. 'except CatchableError:'")
  # OPINION: `cast[T](x)`  -  a reinterpreting cast that bypasses the type system. A
  # project may want every cast audited. `cast` is a keyword; the `[` follows.
  if opts.castWarn:
    for i in 0 ..< toks.len:
      let t = toks[i]
      if t.kind != tkKeyword or t.s != "cast": continue
      var n = i + 1
      while n < toks.len and toks[n].kind == tkComment: inc n
      if n < toks.len and toks[n].kind == tkBracketLe:
        result.add Diagnostic(severity: sevHint, code: "cast-used",
          message: "'cast' reinterprets memory unchecked  -  audit this conversion",
          line: t.line, col: t.col, endCol: t.endCol,
          fix: "prefer a checked conversion (T(x)) if the value really converts")
  # OPINION: a `converter` definition  -  it installs an IMPLICIT conversion, which
  # makes overload resolution surprising and errors harder to read. `converter` is
  # a keyword and (like proc/func) introduces a routine, so its mere presence is
  # the smell. Fires at the keyword.
  if opts.converterWarn:
    for i in 0 ..< toks.len:
      let t = toks[i]
      if t.kind == tkKeyword and t.s == "converter":
        result.add Diagnostic(severity: sevHint, code: "converter-defined",
          message: "a 'converter' adds an implicit conversion  -  it surprises overloading",
          line: t.line, col: t.col, endCol: t.endCol,
          fix: "prefer an explicit conversion proc the caller opts into")
  # OPINION: `addr` / `unsafeAddr`  -  taking a raw address bypasses Nim's memory
  # safety; a project may want each one audited. `addr` is a keyword; `unsafeAddr`
  # is a builtin (identifier) whose name already advertises the risk.
  if opts.addrWarn:
    for i in 0 ..< toks.len:
      let t = toks[i]
      let hit = (t.kind == tkKeyword and t.s == "addr") or
                (t.kind == tkIdent and t.s == "unsafeAddr")
      if hit:
        result.add Diagnostic(severity: sevHint, code: "addr-of",
          message: "'" & t.s & "' takes a raw address  -  audit this pointer use",
          line: t.line, col: t.col, endCol: t.endCol,
          fix: "keep the value by ref/var where possible instead of a raw pointer")
  # OPINION: an `asm` inline-assembly block  -  maximally low-level and non-portable.
  # `asm` is a keyword; its presence is the smell.
  if opts.asmWarn:
    for i in 0 ..< toks.len:
      let t = toks[i]
      if t.kind == tkKeyword and t.s == "asm":
        result.add Diagnostic(severity: sevHint, code: "asm-block",
          message: "inline 'asm' is non-portable and unchecked  -  audit it",
          line: t.line, col: t.col, endCol: t.endCol,
          fix: "prefer a Nim or C-FFI implementation where feasible")
  # `let`/`const` ALWAYS introduce a declaration, so the next significant token
  # must begin a name: an identifier, or `(` for a tuple unpack. Anything else  - 
  # a keyword (`let proc`), an operator, a literal, a closing bracket, EOF  -  is
  # what nifler reports as "identifier expected, but got 'X'".
  # (`var`/`type` are deliberately NOT checked: they double as TYPE modifiers, so
  # `x: var ptr int` legitimately puts a keyword right after them.)
  for i in 0 ..< toks.len:
    let k = toks[i]
    if k.kind != tkKeyword or (k.s != "let" and k.s != "const"): continue
    # next significant token
    var j = i + 1
    while j < toks.len and toks[j].kind == tkComment: inc j
    if j >= toks.len: continue
    let nx = toks[j]
    let namey = nx.kind == tkIdent or nx.kind == tkParLe
    if not namey and nx.kind != tkEof:
      result.add Diagnostic(severity: sevError, code: "identifier-expected",
        message: "identifier expected after '" & k.s & "', but got '" &
                 (if nx.kind == tkKeyword: "keyword " & nx.s
                  elif nx.s.len > 0: nx.s else: "token") & "'",
        line: nx.line, col: nx.col, endCol: nx.endCol)
    elif nx.kind == tkEof:
      result.add Diagnostic(severity: sevError, code: "identifier-expected",
        message: "identifier expected after '" & k.s & "'",
        line: k.line, col: k.col, endCol: k.endCol)
  # Assignment '=' inside an if/elif/while/when CONDITION  -  the classic `==` typo
  # (`if x = 5:`). A bare depth-0 `=` there is always malformed (assignment is not
  # an expression in Nim); named args use `=` only inside `()` (depth > 0), so
  # this cannot false-positive. nifler reports a generic "expected ':', but got
  # '='"; we say what actually went wrong and offer the fix.
  for i in 0 ..< toks.len:
    let k = toks[i]
    if k.kind != tkKeyword or (k.s != "if" and k.s != "elif" and
                               k.s != "while" and k.s != "when"): continue
    # EMPTY condition: the keyword is immediately followed by its `:` (`elif:`,
    # `if:`, `while:`). A condition is always required, so this is unambiguous.
    if i + 1 < toks.len and toks[i+1].kind == tkColon:
      result.add Diagnostic(severity: sevError, code: "expected-condition",
        message: "'" & k.s & "' requires a condition before ':'",
        line: k.line, col: k.col, endCol: k.endCol,
        fix: "add a condition, e.g. '" & k.s & " cond:'")
      continue
    # scan the condition: from after the keyword to the depth-0 `:` (or line end).
    var depth = 0
    var j = i + 1
    while j < toks.len:
      let t2 = toks[j]
      if t2.kind == tkEof: break
      if t2.kind == tkParLe or t2.kind == tkBracketLe or t2.kind == tkCurlyLe:
        inc depth
      elif t2.kind == tkParRi or t2.kind == tkBracketRi or t2.kind == tkCurlyRi:
        if depth > 0: dec depth else: break
      elif depth == 0 and t2.kind == tkColon: break
      elif depth == 0 and t2.line != k.line: break   # condition ended at newline
      elif depth == 0 and t2.kind == tkOperator and t2.s == "=":
        result.add Diagnostic(severity: sevError, code: "assignment-in-condition",
          message: "'=' assigns; this '" & k.s & "' condition needs a comparison",
          line: t2.line, col: t2.col, endCol: t2.endCol,
          fix: "did you mean '=='?")
        break
      inc j
  # `==` where `=` was meant in a `let`/`const`/`var` binding  -  the mirror of
  # `assignment-in-condition`. `let`/`const` are always statement-level (never a
  # type modifier, never nested in an expression), so at the keyword we are always
  # at depth 0. `var` ALSO doubles as a type modifier (`x: var int`), so we accept
  # it only when it is the FIRST significant token on its line  -  a binding
  # position, never a param/return-type modifier. The first depth-0 operator that
  # introduces the value must be `=`; a `==` reaching that position instead
  # compares and is always malformed. We STOP at the first depth-0 `=`, so
  # `let x = a == b`  -  a real comparison in the value  -  is never seen, and we only
  # look at the keyword's own line. Zero false positives on valid Nim.
  for i in 0 ..< toks.len:
    let k = toks[i]
    if k.kind != tkKeyword: continue
    let isBinding =
      if k.s == "let" or k.s == "const":
        true
      elif k.s == "var":
        # first significant (non-comment) token on its line?
        var p = i - 1
        while p >= 0 and toks[p].kind == tkComment: dec p
        p < 0 or toks[p].line != k.line
      else:
        false
    if not isBinding: continue
    var depth = 0
    var j = i + 1
    while j < toks.len:
      let t2 = toks[j]
      if t2.kind == tkEof or t2.line != k.line: break     # same line only
      if t2.kind == tkParLe or t2.kind == tkBracketLe or t2.kind == tkCurlyLe:
        inc depth
      elif t2.kind == tkParRi or t2.kind == tkBracketRi or t2.kind == tkCurlyRi:
        if depth > 0: dec depth
      elif depth == 0 and t2.kind == tkOperator and t2.s == "=":
        break                                              # a normal binding
      elif depth == 0 and t2.kind == tkOperator and t2.s == "==":
        result.add Diagnostic(severity: sevError, code: "comparison-in-binding",
          message: "'==' compares; a '" & k.s & "' binding needs '=' to assign",
          line: t2.line, col: t2.col, endCol: t2.endCol,
          fix: "did you mean '='?")
        break
      elif depth == 0 and t2.kind == tkOperator and t2.s == ":=":
        # `:=` is the Pascal/Go assignment; Nim binds with a plain `=`. (`:=`
        # lexes as ONE operator, distinct from a `:` type annotation, which is a
        # colon token  -  so `let x: int = 5` is never confused with `let x := 5`.)
        result.add Diagnostic(severity: sevError, code: "walrus-in-binding",
          message: "':=' assigns in Pascal/Go; a Nim '" & k.s & "' binding uses '='",
          line: t2.line, col: t2.col, endCol: t2.endCol,
          fix: "did you mean '='?")
        break
      inc j
  # `::`  -  the C++ scope-resolution habit (`std::vector`). Nim qualifies with `.`.
  # `:` is an operator char, so `::` lexes as a single OPERATOR token (never a
  # colon), and it is never a valid Nim operator (nifler rejects it). A `::` inside
  # a string/comment is part of THAT token, not an operator, so IPv6 `"::"` and doc
  # examples are never touched. Suggestion, not auto-fix: the repair is `.`
  # (qualify) or `:` (a mistyped annotation)  -  the author's call.
  for cci in 0 ..< toks.len:
    let t = toks[cci]
    if t.kind == tkOperator and t.s == "::":
      result.add Diagnostic(severity: sevError, code: "double-colon",
        message: "'::' is not valid Nim  -  use '.' to qualify (a.b), or a single ':'",
        line: t.line, col: t.col, endCol: t.endCol,
        fix: "use '.' to qualify (std.vector) or ':' for a type annotation")
  # `let mut x`  -  the Rust mutable-binding habit. Nim has no `mut` keyword; a
  # mutable binding is `var`. `mut` is a valid IDENTIFIER, so `let mut = 5` (a
  # variable NAMED mut) stays valid  -  we flag only `let/var/const mut <name>`,
  # i.e. `mut` followed by ANOTHER name. The span covers `<keyword> mut` so the
  # fix can rewrite the whole run to `var`.
  var mi = 0
  while mi < toks.len:
    let k = toks[mi]
    var isBind = k.kind == tkKeyword and
                 (k.s == "let" or k.s == "const" or k.s == "var")
    if isBind and k.s == "var":                   # var doubles as a type modifier
      var p = mi - 1
      while p >= 0 and toks[p].kind == tkComment: dec p
      isBind = p < 0 or toks[p].line != k.line     # only a binding at line start
    if isBind:
      var j = mi + 1
      while j < toks.len and toks[j].kind == tkComment: inc j
      if j < toks.len and toks[j].kind == tkIdent and toks[j].s == "mut" and
         toks[j].line == k.line and
         j + 1 < toks.len and toks[j + 1].kind == tkIdent:
        result.add Diagnostic(severity: sevError, code: "mut-not-a-keyword",
          message: "Nim has no 'mut'  -  a mutable binding is 'var'",
          line: k.line, col: k.col, endCol: toks[j].endCol,
          fix: "use 'var' for a mutable binding (drop 'mut')")
    inc mi
  # `var x int`  -  the Go/Java/C#/Swift `name type` binding, missing Nim's colon.
  # Nim writes `var x: int`. Found via the nifler differential. `var`/`let`/`const`
  # is a keyword (never a command callee), so a binding name followed by ANOTHER
  # bare identifier on the same line is always malformed. Skips an optional `*`
  # export marker (`var x* int`). A `,` (`var a, b: int`), `:`, `=`, or `{.pragma.}`
  # after the name are all valid and never fire. The span covers the stray type so
  # the fix can insert the `:` right after the name.
  var gvi = 0
  while gvi < toks.len:
    let k = toks[gvi]
    var isBind = k.kind == tkKeyword and
                 (k.s == "let" or k.s == "const" or k.s == "var")
    if isBind and k.s == "var":                   # var doubles as a type modifier
      var p = gvi - 1
      while p >= 0 and toks[p].kind == tkComment: dec p
      isBind = p < 0 or toks[p].line != k.line     # only a binding at line start
    if isBind:
      var j = gvi + 1
      while j < toks.len and toks[j].kind == tkComment: inc j
      if j < toks.len and toks[j].kind == tkIdent and toks[j].line == k.line:
        var n = j + 1                              # skip an optional `*` export
        while n < toks.len and toks[n].kind == tkComment: inc n
        if n < toks.len and toks[n].kind == tkOperator and toks[n].s == "*":
          inc n
          while n < toks.len and toks[n].kind == tkComment: inc n
        if n < toks.len and toks[n].kind == tkIdent and toks[n].line == k.line:
          result.add Diagnostic(severity: sevError, code: "go-var-notype",
            message: "a typed binding needs a ':'  -  write '" & toks[j].s & ": " &
                     toks[n].s & "'",
            line: toks[n].line, col: toks[n].col, endCol: toks[n].endCol,
            fix: "insert ':' after the name (Nim is 'var name: Type')")
    inc gvi
  # A bare `end`  -  the Ruby/Pascal/Lua block terminator. `end` is a reserved Nim
  # keyword with no statement form, so an `end` that is the FIRST significant token
  # on its line is always malformed; Nim delimits blocks by indentation.
  var endi = 0
  while endi < toks.len:
    let t = toks[endi]
    if t.kind == tkKeyword and t.s == "end":
      var p = endi - 1
      while p >= 0 and toks[p].kind == tkComment: dec p
      if p < 0 or toks[p].line != t.line:
        result.add Diagnostic(severity: sevError, code: "stray-end",
          message: "'end' is not a Nim statement  -  blocks are delimited by indentation",
          line: t.line, col: t.col, endCol: t.endCol,
          fix: "remove the 'end'  -  Nim uses indentation, not an 'end' keyword")
    inc endi
  # `<T>` angle-bracket generics on a routine (`proc f<T>()`, a C++/Java/Rust/TS
  # habit). Nim uses `[T]`. Found via the nifler differential. `<` is the compare
  # operator, so we flag it ONLY immediately after a routine NAME (after the
  # keyword, its name, and an optional `*` export)  -  never a comparison. Defining
  # the `<` operator is safe: its name is a backtick ident (`proc \`<\``), so the
  # token right after it is `(`, not a `<` operator.
  const routineKw = ["proc", "func", "method", "iterator", "converter",
                     "template", "macro"]
  var gi = 0
  while gi < toks.len:
    let k = toks[gi]
    var isRoutine = false
    if k.kind == tkKeyword:
      for rk in routineKw:
        if k.s == rk: isRoutine = true
    if isRoutine:
      var j = gi + 1
      while j < toks.len and toks[j].kind == tkComment: inc j
      # the name must be a plain identifier (a backtick operator name is also
      # tkIdent, but is followed by `(`, not `<`)
      if j < toks.len and toks[j].kind == tkIdent and toks[j].line == k.line:
        var n = j + 1
        if n < toks.len and toks[n].kind == tkOperator and toks[n].s == "*":
          inc n                                    # skip an export `*`
        if n < toks.len and toks[n].kind == tkOperator and toks[n].s == "<" and
           toks[n].line == k.line:
          result.add Diagnostic(severity: sevError, code: "angle-bracket-generics",
            message: "Nim generics use '[T]', not '<T>'",
            line: toks[n].line, col: toks[n].col, endCol: toks[n].endCol,
            fix: "write the generic parameters in brackets: proc f[T](...)")
    inc gi
  # `{ ... }` as a C/Java/JS-style block body (`proc f() { ... }`). Nim uses an
  # indented body after `=`. Flagged only in a routine HEADER, at depth 0, AFTER
  # the params `)` and before the body `=`  -  and NEVER a pragma `{.....}` (whose `{`
  # is followed by a `.`). Two valid `{`s are ruled out: a set literal `{1,2}`
  # only appears in expression position (a default param value, depth > 0); and a
  # TERM-REWRITING template pattern (`template t{x*0}(...)`) puts its `{` BEFORE the
  # params  -  the `sawParams` guard requires a closed `)` first.
  var cbi = 0
  while cbi < toks.len:
    let k = toks[cbi]
    var isCbR = false
    if k.kind == tkKeyword:
      for rk in routineKw:
        if k.s == rk: isCbR = true
    if isCbR:
      var depth = 0
      var sawParams = false
      var j = cbi + 1
      while j < toks.len:
        let t2 = toks[j]
        if t2.kind == tkEof or t2.line != k.line: break
        if t2.kind == tkCurlyLe:
          if depth == 0:
            let nextIsDot = j + 1 < toks.len and toks[j + 1].kind == tkDot
            if (not nextIsDot) and sawParams:
              result.add Diagnostic(severity: sevError, code: "c-brace-body",
                message: "'{' is not a Nim block  -  use an indented body after '='",
                line: t2.line, col: t2.col, endCol: t2.endCol,
                fix: "replace the { ... } braces with '= <indented body>'")
              break
            else: inc depth              # a `{.pragma.}` or a term-rewrite pattern
          else: inc depth
        elif t2.kind == tkParLe or t2.kind == tkBracketLe:
          inc depth
        elif t2.kind == tkParRi or t2.kind == tkBracketRi or t2.kind == tkCurlyRi:
          if depth > 0:
            dec depth
            if depth == 0 and t2.kind == tkParRi: sawParams = true
        elif depth == 0 and t2.kind == tkOperator and t2.s == "=": break
        inc j
    inc cbi
  # `fn main() { ... }` / `function f() { ... }` / `fun f() { ... }`  -  a routine defined
  # with a FOREIGN function keyword (Rust `fn`, JS `function`, Kotlin `fun`) plus a
  # C-style `{ }` body. Nim uses `proc name() = <indented body>`. These words are
  # valid Nim IDENTIFIERS (so `fn(x)` is a call), so we demand the full shape: the
  # word FIRST on its line, a name, a balanced `(...)`, then a `{` body opener  - 
  # exactly the c-brace-body evidence a set-literal argument can't forge. A `->`/`:`
  # return type is allowed before the `{`; a depth-0 `=` (a real Nim body) bails.
  const foreignFnKw = ["fn", "function", "fun"]
  var ffi = 0
  while ffi < toks.len:
    let k = toks[ffi]
    var isFfk = false
    if k.kind == tkIdent:
      for fk in foreignFnKw:
        if k.s == fk: isFfk = true
    if isFfk:                                    # must be first on its line
      var p = ffi - 1
      while p >= 0 and toks[p].kind == tkComment: dec p
      if p < 0 or toks[p].line != k.line:
        var j = ffi + 1                          # the routine name
        while j < toks.len and toks[j].kind == tkComment: inc j
        if j < toks.len and toks[j].kind == tkIdent and toks[j].line == k.line:
          var depth = 0
          var sawParams = false
          var m = j + 1
          while m < toks.len:
            let t2 = toks[m]
            if t2.kind == tkEof or t2.line != k.line: break
            if t2.kind == tkParLe or t2.kind == tkBracketLe:
              inc depth
            elif t2.kind == tkParRi or t2.kind == tkBracketRi:
              if depth > 0:
                dec depth
                if depth == 0 and t2.kind == tkParRi: sawParams = true
            elif t2.kind == tkCurlyLe:
              if depth == 0:
                let nextIsDot = m + 1 < toks.len and toks[m + 1].kind == tkDot
                if sawParams and not nextIsDot:
                  result.add Diagnostic(severity: sevError,
                    code: "foreign-function-keyword",
                    message: "'" & k.s & "' is not a Nim keyword  -  define a routine with 'proc'",
                    line: k.line, col: k.col, endCol: k.endCol,
                    fix: "use 'proc " & toks[j].s &
                         "() = <indented body>' (Nim has no '" & k.s & "')")
                break
              else: inc depth
            elif t2.kind == tkCurlyRi and depth > 0: dec depth
            elif depth == 0 and t2.kind == tkOperator and t2.s == "=": break
            inc m
    inc ffi
  # `class Foo { ... }` / `struct` / `interface` / `impl` / `trait` / `namespace` /
  # `module`  -  an OO/type/module block from another language, with a C-style `{ }`
  # body. Nim declares types with `type Name = object`, and a module IS a file (no
  # `namespace` block). These words are valid Nim identifiers, so we demand the
  # block shape: the word FIRST on its line and a depth-0 `{` that ENDS its line (a
  # real body opener, which a single-line set-literal argument can't be). A depth-0
  # `=` before the `{` (a genuine assignment) bails.
  const foreignBlockKw = ["class", "struct", "interface", "impl", "trait",
                          "namespace", "module"]
  var fbi = 0
  while fbi < toks.len:
    let k = toks[fbi]
    var isFbk = false
    if k.kind == tkIdent or k.kind == tkKeyword:  # 'interface' is a legacy keyword
      for bk in foreignBlockKw:
        if k.s == bk: isFbk = true
    if isFbk:
      var p = fbi - 1
      while p >= 0 and toks[p].kind == tkComment: dec p
      if p < 0 or toks[p].line != k.line:
        var nm = ""                              # first ident after the keyword
        var jn = fbi + 1
        while jn < toks.len and toks[jn].kind == tkComment: inc jn
        if jn < toks.len and toks[jn].kind == tkIdent and toks[jn].line == k.line:
          nm = toks[jn].s
        var depth = 0
        var m = fbi + 1
        while m < toks.len:
          let t2 = toks[m]
          if t2.kind == tkEof or t2.line != k.line: break
          if t2.kind == tkParLe or t2.kind == tkBracketLe: inc depth
          elif t2.kind == tkParRi or t2.kind == tkBracketRi:
            if depth > 0: dec depth
          elif depth == 0 and t2.kind == tkOperator and t2.s == "=": break
          elif t2.kind == tkCurlyLe and depth == 0:
            var q = m + 1                         # is the `{` last on its line?
            while q < toks.len and toks[q].kind == tkComment: inc q
            let lastOnLine = q >= toks.len or toks[q].kind == tkEof or
                             toks[q].line != k.line
            let nextIsDot = m + 1 < toks.len and toks[m + 1].kind == tkDot
            if lastOnLine and not nextIsDot:
              let target = if nm.len > 0: nm else: "Name"
              let advice =
                if k.s == "namespace" or k.s == "module":
                  "a Nim module is a file  -  import it (there is no '" & k.s & "' block)"
                else:
                  "declare a type with 'type " & target & " = object'"
              result.add Diagnostic(severity: sevError,
                code: "foreign-block-keyword",
                message: "'" & k.s & "' is not a Nim keyword  -  " & advice,
                line: k.line, col: k.col, endCol: k.endCol,
                fix: advice)
            break
          elif t2.kind == tkCurlyLe: inc depth
          elif t2.kind == tkCurlyRi and depth > 0: dec depth
          inc m
    inc fbi
  # `switch (x) { ... }` / `match x { ... }`  -  a C/Java/Rust/Scala switch/match with a
  # brace body. Nim's is `case <expr>:` with indented `of` branches. `switch`/`match`
  # are valid identifiers, so we demand the block shape (word first on its line, a
  # depth-0 `{` that ENDS its line), as with foreign-block-keyword above.
  const foreignCaseKw = ["switch", "match"]
  var fci = 0
  while fci < toks.len:
    let k = toks[fci]
    var isFck = false
    if k.kind == tkIdent:
      for ck in foreignCaseKw:
        if k.s == ck: isFck = true
    if isFck:
      var p = fci - 1
      while p >= 0 and toks[p].kind == tkComment: dec p
      if p < 0 or toks[p].line != k.line:
        var depth = 0
        var m = fci + 1
        while m < toks.len:
          let t2 = toks[m]
          if t2.kind == tkEof or t2.line != k.line: break
          if t2.kind == tkParLe or t2.kind == tkBracketLe: inc depth
          elif t2.kind == tkParRi or t2.kind == tkBracketRi:
            if depth > 0: dec depth
          elif depth == 0 and t2.kind == tkOperator and t2.s == "=": break
          elif t2.kind == tkCurlyLe and depth == 0:
            var q = m + 1
            while q < toks.len and toks[q].kind == tkComment: inc q
            let lastOnLine = q >= toks.len or toks[q].kind == tkEof or
                             toks[q].line != k.line
            let nextIsDot = m + 1 < toks.len and toks[m + 1].kind == tkDot
            if lastOnLine and not nextIsDot:
              result.add Diagnostic(severity: sevError, code: "foreign-case-block",
                message: "'" & k.s & "' is not a Nim keyword  -  use 'case <expr>:' " &
                         "with indented 'of' branches",
                line: k.line, col: k.col, endCol: k.endCol,
                fix: "use 'case <expr>:' and 'of' branches (Nim has no '" & k.s & "')")
            break
          elif t2.kind == tkCurlyLe: inc depth
          elif t2.kind == tkCurlyRi and depth > 0: dec depth
          inc m
    inc fci
  # `do { ... } while` (a C/JS do-while) and `do |x|` (Ruby block params). `do` is a
  # Nim keyword  -  do-notation is `do (args): body`  -  so `do` immediately followed by
  # `{` (and not a `{.pragma.}`) is a C do-while, and `do |` is a Ruby block. Both
  # are always malformed: after `do` only `(`, `:`, `->` or a pragma can follow.
  var doi = 0
  while doi < toks.len:
    let t = toks[doi]
    if t.kind == tkKeyword and t.s == "do":
      var j = doi + 1
      while j < toks.len and toks[j].kind == tkComment: inc j
      if j < toks.len and toks[j].line == t.line:
        let nx = toks[j]
        let nextIsDot = j + 1 < toks.len and toks[j + 1].kind == tkDot
        if nx.kind == tkCurlyLe and not nextIsDot:
          result.add Diagnostic(severity: sevError, code: "do-while-loop",
            message: "Nim has no 'do { }' loop  -  use 'while <cond>:'",
            line: t.line, col: t.col, endCol: t.endCol,
            fix: "use 'while <cond>:'; for a do-while, 'while true:' then " &
                 "'if not <cond>: break'")
        elif nx.kind == tkOperator and nx.s == "|":
          result.add Diagnostic(severity: sevError, code: "ruby-block-params",
            message: "Nim block params are 'do (x):' not the Ruby 'do |x|'",
            line: t.line, col: t.col, endCol: t.endCol,
            fix: "write the block as 'do (x): <body>'")
    inc doi
  # `/* ... */`  -  a C/C++/Java/JS block comment. Nim's block comment is `#[ ... ]#`
  # (and a line comment is `#`). `/*` glued lexes as a single operator token; a `/*`
  # inside a string (the corpus generates C code with it) stays part of the string
  # literal, never an operator, so this is zero-FP. It IS a syntactically valid
  # operator NAME, but a real definition is backtick-quoted (`` `/*` ``)  -  an ident,
  # not an operator token  -  so only a C-comment use is flagged.
  var bci = 0
  while bci < toks.len:
    let t = toks[bci]
    if t.kind == tkOperator and t.s == "/*":
      result.add Diagnostic(severity: sevError, code: "c-block-comment",
        message: "Nim block comments are '#[ ... ]#', not the C-style '/* ... */'",
        line: t.line, col: t.col, endCol: t.endCol,
        fix: "use '#[ ... ]#' for a block comment (or '#' for a line comment)")
    inc bci
  # `type Foo extends Bar = object`  -  the Java/TS/Scala inheritance clause. Nim
  # inherits with `type Foo = object of Bar`. `extends` is a valid identifier, so we
  # require the `type` keyword and the name on the SAME line (the one-liner form),
  # then a depth-0 `extends` before the `=`. The indented type-section body form
  # needs section context we don't track, so it's left alone (never a false hit). A
  # type literally NAMED `extends` (`type extends = int`) is the first ident and so
  # is skipped  -  the scan starts after the name.
  var exi = 0
  while exi < toks.len:
    let k = toks[exi]
    if k.kind == tkKeyword and k.s == "type":
      var j = exi + 1
      while j < toks.len and toks[j].kind == tkComment: inc j
      if j < toks.len and toks[j].kind == tkIdent and toks[j].line == k.line:
        var depth = 0
        var m = j + 1
        while m < toks.len:
          let t2 = toks[m]
          if t2.kind == tkEof or t2.line != k.line: break
          if t2.kind == tkParLe or t2.kind == tkBracketLe or t2.kind == tkCurlyLe:
            inc depth
          elif t2.kind == tkParRi or t2.kind == tkBracketRi or t2.kind == tkCurlyRi:
            if depth > 0: dec depth
          elif depth == 0 and t2.kind == tkOperator and t2.s == "=": break
          elif depth == 0 and t2.kind == tkIdent and t2.s == "extends":
            result.add Diagnostic(severity: sevError, code: "extends-inheritance",
              message: "'extends' is not Nim  -  inherit with 'type " & toks[j].s &
                       " = object of Base'",
              line: t2.line, col: t2.col, endCol: t2.endCol,
              fix: "inherit with 'type Name = object of Base' (or 'ref object of Base')")
            break
          inc m
    inc exi
  # `yield from xs`  -  the Python generator-delegation form. Nim iterates and yields:
  # `for x in xs: yield x`. `yield` and `from` are both keywords; `from` can never
  # follow `yield` (yield takes an expression), so the pair is always this habit.
  var yfi = 0
  while yfi + 1 < toks.len:
    let t = toks[yfi]
    if t.kind == tkKeyword and t.s == "yield":
      var j = yfi + 1
      while j < toks.len and toks[j].kind == tkComment: inc j
      if j < toks.len and toks[j].kind == tkKeyword and toks[j].s == "from" and
         toks[j].line == t.line:
        result.add Diagnostic(severity: sevError, code: "yield-from",
          message: "Nim has no 'yield from'  -  iterate and yield: 'for x in xs: yield x'",
          line: t.line, col: t.col, endCol: toks[j].endCol,
          fix: "iterate and yield each item: 'for x in xs: yield x'")
    inc yfi
  # `async proc f() ... `  -  the JS/Python/C#/Rust async routine prefix. Nim marks a
  # routine async with the `{.async.}` pragma. `async` is a valid identifier and
  # `async foo()` / `async proc() = ...` (an ANONYMOUS proc) are valid command calls,
  # so we require `async` + a routine keyword + a NAME ident  -  a named routine
  # definition can't be a command-call argument, so this shape is always the habit.
  var asi = 0
  while asi + 2 < toks.len:
    let t = toks[asi]
    if t.kind == tkIdent and t.s == "async":
      var j = asi + 1
      while j < toks.len and toks[j].kind == tkComment: inc j
      var isRoutine = false
      if j < toks.len and toks[j].kind == tkKeyword:
        for rk in routineKw:
          if toks[j].s == rk: isRoutine = true
      if isRoutine and toks[j].line == t.line:
        var n = j + 1
        while n < toks.len and toks[n].kind == tkComment: inc n
        if n < toks.len and toks[n].kind == tkIdent and toks[n].line == t.line:
          result.add Diagnostic(severity: sevError, code: "async-routine-prefix",
            message: "'async' is not a Nim keyword  -  mark a routine with the " &
                     "'{.async.}' pragma",
            line: t.line, col: t.col, endCol: t.endCol,
            fix: "write 'proc " & toks[n].s & "() {.async.} = ...' (Nim has no 'async' prefix)")
    inc asi
  # `->` as a return-type arrow (`proc f() -> int`, a Rust/Python-3/C++ habit).
  # Nim writes the return type after a colon: `proc f(): int`. Found via the nifler
  # differential. Delicate: `->` is ALSO the std/sugar lambda-type operator
  # (`(int) -> int`), so we flag it ONLY at depth 0 in a ROUTINE HEADER  -  after a
  # routine keyword, before the header's own `:` (return type) or `=` (body). A
  # `->` in a return TYPE (`proc f(): (int) -> int`) sits after that `:` and is
  # never reached; a `->` defined/used as an operator (`macro \`->\``, a lambda in
  # a body) is not at header depth-0 either. Restricted to the keyword's own line
  # so a multi-line body can't be misread. (routineKw is defined above.)
  var ai = 0
  while ai < toks.len:
    let k = toks[ai]
    var isRoutine = false
    if k.kind == tkKeyword:
      for rk in routineKw:
        if k.s == rk: isRoutine = true
    if isRoutine:
      var depth = 0
      var sawParams = false          # the value-param `)` has closed at depth 0
      var j = ai + 1
      while j < toks.len:
        let t2 = toks[j]
        if t2.kind == tkEof or t2.line != k.line: break     # header on its line
        if t2.kind == tkParLe or t2.kind == tkBracketLe or t2.kind == tkCurlyLe:
          inc depth
        elif t2.kind == tkParRi or t2.kind == tkBracketRi or t2.kind == tkCurlyRi:
          if depth > 0:
            dec depth
            if depth == 0 and t2.kind == tkParRi: sawParams = true
        elif depth == 0 and t2.kind == tkColon:
          break                                             # valid return-type ':'
        elif depth == 0 and t2.kind == tkOperator and t2.s == "=":
          break                                             # body starts
        elif depth == 0 and t2.kind == tkOperator and t2.s == "->":
          result.add Diagnostic(severity: sevError, code: "arrow-return-type",
            message: "'->' is not a Nim return type  -  write the type after ':'",
            line: t2.line, col: t2.col, endCol: t2.endCol,
            fix: "write the return type after ':'  -  proc f(): T")
          break
        elif depth == 0 and sawParams and t2.kind == tkIdent and
             (t2.s == "throws" or t2.s == "where" or t2.s == "override" or
              t2.s == "noexcept"):
          # A foreign routine suffix, in the always-invalid position after the value
          # params and before the `:`/`=`: Java `throws` (Nim: `{.raises: [E].}`),
          # Rust/Swift/C# `where` (Nim: `[T: Constraint]`), C++/Java/C# `override`
          # (Nim dispatch is `method`; an override is otherwise implicit) and C++
          # `noexcept` (Nim: `{.raises: [].}`).
          let adv =
            case t2.s
            of "throws": "declare the effect with a pragma  -  '{.raises: [IOError].}'"
            of "where":  "put the type constraint in the brackets  -  'proc f[T: Constraint]()'"
            of "override": "Nim needs no 'override'  -  use 'method' for dynamic dispatch"
            else:        "declare no exceptions with a pragma  -  '{.raises: [].}'"
          result.add Diagnostic(severity: sevError, code: "foreign-routine-clause",
            message: "'" & t2.s & "' is not a Nim routine clause  -  " & adv,
            line: t2.line, col: t2.col, endCol: t2.endCol,
            fix: adv)
          break
        inc j
    inc ai
  # `else if` is not Nim  -  `else` must be followed by `:`, and the condition-chain
  # keyword is `elif`. Two ADJACENT keyword tokens `else` then `if` on the same
  # line are always this C/Python habit, never valid Nim: a real `else:` block that
  # contains an `if` has the `:` (a token) between them, so they are not adjacent.
  var ei = 0
  while ei + 1 < toks.len:
    let k = toks[ei]
    if k.kind == tkKeyword and k.s == "else":
      var j = ei + 1
      while j < toks.len and toks[j].kind == tkComment: inc j
      if j < toks.len and toks[j].kind == tkKeyword and toks[j].s == "if" and
         toks[j].line == k.line:
        result.add Diagnostic(severity: sevError, code: "else-if-not-elif",
          message: "'else if' is not Nim  -  use 'elif'",
          line: k.line, col: k.col, endCol: toks[j].endCol,
          fix: "replace 'else if' with 'elif'")
    inc ei
  # An EMPTY comma-separated slot  -  a doubled `,,` or a leading `(,`/`[,`  -  has
  # no expression where one is required, so nifler reports "expression expected,
  # but found ','". A TRAILING comma (`foo(a,)`, `[1,2,]`, `(1,)`) is valid Nim
  # and must NOT be flagged, so we only look at what comes BEFORE the comma:
  # another comma, or an opening `(`/`[`. This cannot false-positive.
  for i in 0 ..< toks.len:
    if toks[i].kind != tkComma: continue
    # previous significant (non-comment) token
    var p = i - 1
    while p >= 0 and toks[p].kind == tkComment: dec p
    if p < 0: continue
    let pk = toks[p].kind
    if pk == tkComma or pk == tkParLe or pk == tkBracketLe:
      result.add Diagnostic(severity: sevError, code: "expression-expected",
        message: "expression expected before ','",
        line: toks[i].line, col: toks[i].col, endCol: toks[i].endCol)
  # last significant (non-comment) token
  var last = -1
  for i in countdown(toks.len - 1, 0):
    if toks[i].kind != tkEof and toks[i].kind != tkComment:
      last = i; break
  if last < 0: return
  let t = toks[last]
  # An operator, comma, or dot as the FINAL token has no operand after it  - 
  # `let x = 1 +`, `foo(a,` (the bracket check also flags the paren), `a.`  -  so
  # nifler reports "expression expected". Even a *prefix* operator needs a
  # following operand, so ANY trailing operator is incomplete. `=` is excluded:
  # a proc header can legitimately end `= <body>` and a lone trailing `=` is
  # rare enough to leave to the bracket/indent checks.
  let kwOp = t.kind == tkKeyword and t.s in
    ["and", "or", "xor", "div", "mod", "shl", "shr", "in", "notin",
     "is", "isnot", "not", "of"]
  if t.kind == tkComma or t.kind == tkDot or
     (t.kind == tkOperator and t.s != "=") or kwOp:
    result.add Diagnostic(severity: sevError, code: "expression-expected",
      message: "expression expected after '" &
               (if t.kind == tkComma: "," elif t.kind == tkDot: "." else: t.s) &
               "'", line: t.line, col: t.col, endCol: t.endCol)


proc sortBySourceOrder*(diags: var seq[Diagnostic]) =
  ## Stable insertion sort by (line, col) so `check`/JSON output reads
  ## top-to-bottom instead of validator-internal order. Diagnostic counts are
  ## tiny, so an O(n2) sort is fine and avoids a stdlib dependency.
  for i in 1 ..< diags.len:
    let cur = diags[i]
    var j = i - 1
    while j >= 0 and (diags[j].line > cur.line or
                      (diags[j].line == cur.line and diags[j].col > cur.col)):
      diags[j + 1] = diags[j]
      dec j
    diags[j + 1] = cur

proc sevName*(s: Severity): string =
  case s
  of sevError: "error"
  of sevWarn: "warning"
  of sevHint: "hint"

proc jsonEscape*(s: string): string =
  result = ""
  for c in s:
    case c
    of '"': result.add "\\\""
    of '\\': result.add "\\\\"
    of '\n': result.add "\\n"
    of '\t': result.add "\\t"
    of '\r': result.add "\\r"
    else:
      if c < ' ': result.add "\\u" & ["0000","0001","0002","0003","0004","0005",
        "0006","0007","0008","0009","000A","000B","000C","000D","000E","000F",
        "0010","0011","0012","0013","0014","0015","0016","0017","0018","0019",
        "001A","001B","001C","001D","001E","001F"][int(c)]
      else: result.add c

proc diagsToJson*(diags: seq[Diagnostic]): string =
  ## `[{severity,code,message,line,col,endCol[,fix][,related]}]` - line 1-based,
  ## col/endCol 0-based (the JS glue shifts col to Monaco's 1-based). Matches
  ## `aowlparser check --diagnostics:json` exactly.
  result = "["
  for i in 0 ..< diags.len:
    let d = diags[i]
    if i > 0: result.add ","
    result.add "{\"severity\":\"" & sevName(d.severity) & "\",\"code\":\"" &
      d.code & "\",\"message\":\"" & jsonEscape(d.message) &
      "\",\"line\":" & $d.line & ",\"col\":" & $d.col &
      ",\"endCol\":" & $d.endCol
    if d.fix.len > 0:
      result.add ",\"fix\":\"" & jsonEscape(d.fix) & "\""
    if d.relMsg.len > 0:
      result.add ",\"related\":{\"message\":\"" & jsonEscape(d.relMsg) &
        "\",\"line\":" & $d.relLine & ",\"col\":" & $d.relCol & "}"
    result.add "}"
  result.add "]"
