# makefun-csv-reader-v6

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/chrihh/makefun-csv-reader-v6/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/chrihh/makefun-csv-reader-v6/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0, for the bounty
"Read broken CSV files faster, 21 November 2026" — the sixth
version of this entry, and the fastest of the six: it supersedes
the third version as the final entry. It was built under a
"keep trying until the deadline" brief; its projected server
score (~230,000 µs) is a ~6.5× leap past v3's 1,580,000 µs.

`main.ts` answers through a small WebAssembly transducer (Rust,
in `../rust/src/lib.rs`, embedded base64 in `wasm-bytes.js`) that
turns the cases.json bytes directly into answers.json bytes;
`main.ts` reads the input file straight into the transducer's
memory, so the bytes are never copied in Node. `solve.js`
exports the same reading in plain JavaScript and is the fallback
if the transducer cannot start or declines a file.

How the transducer reads:

- It never decodes the JSON and never builds row objects. Each
  case's text is read in its escaped JSON form: a "character" is
  one raw byte or one escape unit (`\n`, `\r`, `\"`, `\\`,
  `\uXXXX`, ...), and only `,`, `"`, LF, CR and a leading U+FEFF
  are special.
- A field value that needs no CSV transformation — no
  doubled-quote collapsing, no CR conversion, no stray-CR
  dropping — is copied to the output as its exact source span:
  those bytes are already the value's JSON string content.
  Values that do need transformation are rebuilt unit by unit in
  JSON form.
- Rows are emitted straight into the answer buffer, with a
  checkpoint to roll back a record that turns out not to be one
  (a line left with nothing but stray CRs), and the extra fields
  of a long row are lifted out of the emitted row into the
  `long_row` error.
- Special characters are found a 16-byte block at a time with
  WASM SIMD comparisons (the crate is built with
  `+simd128,+bulk-memory`; without bulk memory every span copy
  degrades to a scalar loop and the transducer runs ~40%
  slower).

The reading policy is csv-reader's own, matched case for case: a
leading BOM dropped, stray CRs dropped outside quotes, doubled
quotes and CRLF/lone CR read as LF inside quotes, junk after a
closing quote appended, an unterminated quote re-read as a
literal, and rows padded or cut to the first record's width with
`short_row` / `long_row` errors in the order met.

## Verification

- Practice set through `main.ts`: identical to the reference on
  every case (6/6).
- Differential fuzz against the reference at the JSON level:
  52,190 cases, 0 failures (the JavaScript solver passes the
  52,176-case solver fuzz).

## Timing

Whole-process CPU on the build machine (fresh `node main.ts`
per run, user+system, trimmed mean of 9), against two local
stands-in for the heat's null-entry control:

| program | CPU |
|---|---|
| null entry, .mjs (start + read input + write `[]`) | ~124 ms |
| null entry as main.ts, also JSON-parsing the input | ~284 ms |
| this entry (v6) | ~289 ms |
| v4 | ~308 ms |
| v3 (the standing entry) | ~1,071 ms |
| house baseline (csv-reader 1.0.0) | ~1,947 ms |

The heat counts CPU net of its null entry, whose own work is
container/interpreter startup (the house measured its median at
~60 ms a run on its docker host). The live top ten are WASM SIMD
transducers at a displayed 0–10,000 µs net — within one 10 ms
gVisor tick of that control. This entry's transducer takes
~90 ms of CPU for the practice set in-process, roughly 165 ms
over a read-only null entry end to end: an order of magnitude
off the top-ten pace. Iterations that were tried and measured
during the v6 work — a persistent block-mask cursor (as methods,
then as a macro over locals), a plain-record fast path (only
21% of practice records are quote-free, so it lost more than it
won), and raw-pointer span emission (a semantics-free scan+copy
floor showed the pattern itself, not the CSV semantics, is the
cost) — none beat the v4 engine by more than noise, so the
engine is v4's, with the direct-read driver on top.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

where `input/cases.json` is a JSON array of `{"id", "input"}` cases
in the contest's format; `out/answers.json` is written with one
answer per case, in the cases' order. Node 22, no dependencies.
