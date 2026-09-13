/**
 * Why the keydir exists.
 *
 * Two ways to answer "what is the value for this key", over the same data file:
 *
 *   keydir  one hash lookup, then read the value bytes at a known offset
 *   scan    read the file from the start, decode every record, keep the last
 *           one that matches
 *
 * Both are correct. Only one of them is still usable at 50,000 keys.
 *
 *   bun run bench/scan-vs-keydir.ts
 */

import { readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Bitcask } from "../src/bitcask.ts";
import { decode } from "../src/record.ts";

const SIZES = [1_000, 5_000, 20_000, 50_000];
const VALUE_BYTES = 200;

const KEYDIR_GETS = 20_000;
const SCAN_GETS = 20;

const ROOT = join(import.meta.dirname, "..", ".tmp", "bench");

/**
 * A get with no index: read the whole file, decode every record, and keep the
 * last one whose key matches. Last, not first -- the newest record wins.
 */
async function scanGet(path: string, key: Buffer): Promise<Buffer | undefined> {
  const buf = await readFile(path);
  let found: Buffer | undefined;
  let offset = 0;

  while (offset < buf.length) {
    const record = decode(buf, offset);
    if (record.key.equals(key)) found = record.value;
    offset += record.length;
  }
  return found;
}

/** Runs `fn` n times and returns the average in microseconds. */
async function timePerOp(n: number, fn: (i: number) => Promise<unknown>) {
  const start = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  return ((performance.now() - start) * 1000) / n;
}

async function main() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  const value = Buffer.alloc(VALUE_BYTES, 0x61);

  console.log(`\n  ${VALUE_BYTES}-byte values, average over many gets\n`);
  console.log("  keys      keydir        scan       scan is");
  console.log("  " + "-".repeat(46));

  for (const n of SIZES) {
    const dir = join(ROOT, `n${n}`);
    const db = await Bitcask.open(dir);
    for (let i = 0; i < n; i++) await db.put(Buffer.from(`key-${i}`), value);

    const dataFile = join(dir, "1.data");
    const keyAt = (i: number) => Buffer.from(`key-${i % n}`);

    const keydirUs = await timePerOp(KEYDIR_GETS, (i) => db.get(keyAt(i)));
    const scanUs = await timePerOp(SCAN_GETS, (i) => scanGet(dataFile, keyAt(i)));

    console.log(
      `  ${String(n).padEnd(9)} ${(keydirUs.toFixed(1) + " us").padEnd(12)}` +
        `${(scanUs.toFixed(0) + " us").padEnd(12)}${(scanUs / keydirUs).toFixed(0)}x slower`,
    );

    await db.close();
  }

  console.log(
    "\n  The keydir column is flat: one lookup plus one read, whatever the\n" +
      "  store holds. The scan column tracks the size of the file, because\n" +
      "  that is what it reads. That gap is the whole reason for the index.\n",
  );

  await rm(ROOT, { recursive: true, force: true });
}

await main();
