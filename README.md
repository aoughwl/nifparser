# nifparser

A pure-**nimony** recursive-descent parser that turns Nim source into the
parse-dialect NIF (`.p.nif`) the compiler frontend consumes — the same job as the
classic compiler's `nifler`, but self-hosted and free of the classic Nim compiler,
so it can be compiled to JavaScript and run in the browser.

Its output is **byte-for-byte identical** to native `nifler`: the entire nimony
standard library round-trips structurally, and 46 of 47 corpus programs match to
the byte.

**📖 Full docs → [aoughwl.github.io/docs/nifparser](https://aoughwl.github.io/docs/nifparser)**

- [Architecture](https://aoughwl.github.io/docs/nifparser/architecture) — fused parse + emit, the range-splitter, the module map, the oracle
- [Grammar coverage](https://aoughwl.github.io/docs/nifparser/grammar) — every construct reproduced
- [Differential testing](https://aoughwl.github.io/docs/nifparser/testing) — the `nifler` oracle harness
- [Configuration](https://aoughwl.github.io/docs/nifparser/configuration) — `--curly`, `--tabs`, `--tab-width`, `--indent-width`
- [Known gaps](https://aoughwl.github.io/docs/nifparser/known-gaps) — the honest edge-case catalog

```sh
nifparser p in.nim out.p.nif      # parse Nim source -> nifler-compatible NIF
```

Everything is off by default, so a plain run is byte-compatible with `nifler`.
