// Harness driver: node /bot/main.ts reads every case from
// /input/cases.json and writes the answers to /output/answers.json.
// The heavy work is done by a small WebAssembly transducer (built
// from rust/src/lib.rs, embedded base64 in wasm-bytes.js) whose
// block-mask state machine turns the cases.json bytes directly
// into answers.json bytes, answering each case exactly as
// csv-reader 1.0.0 does. The input file is read straight into the
// transducer's memory, so the bytes are never copied in Node. If
// the transducer is unavailable, or declines a file, the same
// answers are produced by the plain JavaScript solver in
// solve.js. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The house baseline runs with V8's incremental marking off; this
// entry does the same, and compiles its WebAssembly with the fast
// baseline compiler only, as the rules allow flags to be set
// before the module is built.
setFlagsFromString('--no-incremental-marking --liftoff-only');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

let done = false;
try {
  const { WASM_B64 } = await import(new URL('./wasm-bytes.js', import.meta.url).href);
  const bytes = Buffer.from(WASM_B64 as string, 'base64');
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  const mem = inst.exports.memory as WebAssembly.Memory;
  const alloc = inst.exports.alloc as (n: number) => number;
  const transduce = inst.exports.transduce as (p: number, l: number) => bigint;
  const fd = openSync(join(inputDir, 'cases.json'), 'r');
  const size = fstatSync(fd).size;
  const ptr = alloc(size);
  const view = new Uint8Array(mem.buffer, ptr, size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, view, off, size - off, off);
    if (n === 0) break;
    off += n;
  }
  closeSync(fd);
  const res = transduce(ptr, off);
  if (res !== 0n) {
    const outPtr = Number(res >> 32n);
    const outLen = Number(res & 0xffffffffn);
    writeFileSync(join(outputDir, 'answers.json'), Buffer.from(mem.buffer, outPtr, outLen));
    done = true;
  }
} catch {
  done = false;
}

if (!done) {
  const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
    run: (input: unknown) => unknown;
  };
  const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
    id: string;
    input: unknown;
  }[];
  const answers = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i]!.input);
  writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
}
