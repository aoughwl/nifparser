# aifparser

A pure-**nimony** recursive-descent parser that turns Nim source into the
parse-dialect AIF (`.p.aif`) the compiler frontend consumes — the same job as the
classic compiler's `nifler`, but self-hosted and free of the classic Nim compiler,
so it can be compiled to JavaScript and run in the browser.

Its output is **byte-for-byte identical** to native `nifler` — save for one line
it owns on purpose, the `(.vendor "aifparser")` header (aifparser stamps its own
identity rather than impersonating `nifler`). The entire nimony standard library
round-trips structurally, and 46 of 47 corpus programs match to the byte apart
from that header; the differential harness neutralizes it and holds the rest
strict.

**📖 Full docs → [aoughwl.github.io/docs/aifparser](https://aoughwl.github.io/docs/aifparser)**

- [Architecture](https://aoughwl.github.io/docs/aifparser/architecture) — fused parse + emit, the range-splitter, the module map, the oracle
- [Grammar coverage](https://aoughwl.github.io/docs/aifparser/grammar) — every construct reproduced
- [Differential testing](https://aoughwl.github.io/docs/aifparser/testing) — the `nifler` oracle harness
- [Configuration](https://aoughwl.github.io/docs/aifparser/configuration) — brace blocks (`--curly`), indentation/whitespace policy, lint checks, `--strict`/`--max-depth`, and stdio I/O
- [Known gaps](https://aoughwl.github.io/docs/aifparser/known-gaps) — the honest edge-case catalog

```sh
aifparser p in.nim out.p.aif      # parse Nim source -> nifler-compatible AIF
```

Everything is off by default, so a plain run is byte-compatible with `nifler`.
