/**
 * What merge and hint files buy.
 *
 * Builds a store with a realistic amount of garbage in it, merges it, and times
 * three cold opens: the unmerged store, the merged store with its hint files,
 * and the merged store with the hints deleted. The last two read the same data
 * files, so the difference between them is the hint files and nothing else.
 *
 *   bun run bench/merge.ts
 */

import { rm, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Bitcask } from "../src/bitcask.ts";

const KEYS = 1_000;
const OVERWRITES = 4;
const VALUE_BYTES = 16384;
const MAX_FILE_SIZE = 1024 * 1024;

const ROOT = join(import.meta.dirname, "..", ".tmp", "merge");

/** "1.08 MiB" */
function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/** "12.3 ms" */
function ms(millis: number): string {
  return `${millis.toFixed(1)} ms`;
}

async function report(db: Bitcask, phase: string) {
  const s = await db.stats();
  const garbage = s.totalBytes - s.liveBytes;
  const share = s.totalBytes === 0 ? 0 : (garbage / s.totalBytes) * 100;

  console.log(
    `  ${phase.padEnd(22)}` +
      `${String(s.keys).padStart(6)}  ` +
      `${String(s.files).padStart(5)}  ` +
      `${mib(s.totalBytes).padStart(10)}  ` +
      `${mib(s.liveBytes).padStart(10)}  ` +
      `${(share.toFixed(1) + "%").padStart(7)}`,
  );
}

/** Opens the store, times it, and closes it again. */
async function timeOpen(): Promise<number> {
  const started = performance.now();
  const db = await Bitcask.open(ROOT, { maxFileSize: MAX_FILE_SIZE });
  const elapsed = performance.now() - started;
  await db.close();
  return elapsed;
}

/** Names and total size of the store's hint files. */
async function hints(): Promise<{ names: string[]; bytes: number }> {
  const names = (await readdir(ROOT)).filter((n) => /^\d+\.hint$/.test(n));
  let bytes = 0;
  for (const name of names) bytes += (await stat(join(ROOT, name))).size;
  return { names, bytes };
}

async function main() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  const value = Buffer.alloc(VALUE_BYTES, 0x61);
  const key = (i: number) => Buffer.from(`key-${i}`);

  console.log(
    `\n  ${KEYS} keys, ${VALUE_BYTES}-byte values, ` +
      `${OVERWRITES} overwrites each, ${mib(MAX_FILE_SIZE)} per file\n`,
  );
  console.log("  phase                   keys  files      on disk        live  garbage");
  console.log("  " + "-".repeat(70));

  const db = await Bitcask.open(ROOT, { maxFileSize: MAX_FILE_SIZE });
  for (let round = 0; round <= OVERWRITES; round++) {
    for (let i = 0; i < KEYS; i++) await db.put(key(i), value);
  }
  await report(db, "written and churned");
  await db.close();

  const scanUnmerged = await timeOpen();

  const merging = await Bitcask.open(ROOT, { maxFileSize: MAX_FILE_SIZE });
  const started = performance.now();
  await merging.merge();
  const mergeTook = performance.now() - started;
  await report(merging, "merged");
  const merged = await merging.stats();
  await merging.close();

  const withHints = await timeOpen();

  const hintFiles = await hints();
  for (const name of hintFiles.names) await unlink(join(ROOT, name));

  const scanMerged = await timeOpen();

  console.log(`\n  merge took ${ms(mergeTook)}\n`);
  console.log("  open                                          reads          time");
  console.log("  " + "-".repeat(70));
  console.log(
    `  the unmerged store, scanned       ${mib(merged.totalBytes * (OVERWRITES + 1)).padStart(12)}  ${ms(scanUnmerged).padStart(12)}`,
  );
  console.log(
    `  the merged store, scanned         ${mib(merged.totalBytes).padStart(12)}  ${ms(scanMerged).padStart(12)}`,
  );
  console.log(
    `  the merged store, from ${String(hintFiles.names.length).padStart(2)} hints    ${mib(hintFiles.bytes).padStart(12)}  ${ms(withHints).padStart(12)}`,
  );

  const fewer = (merged.totalBytes / Math.max(hintFiles.bytes, 1)).toFixed(0);
  console.log(
    `\n  The bottom two opens rebuild the same keydir from the same store.\n` +
      `  One reads every value back off disk and checksums it; the other\n` +
      `  reads the keys and their locations, which is all the keydir ever\n` +
      `  held -- ${fewer}x fewer bytes. The time does not fall by ${fewer}x because at\n` +
      `  ${KEYS} keys what is left is per-key work rather than I/O. Make the\n` +
      `  values bigger, or the store larger, and the gap goes with them.\n`,
  );

  await rm(ROOT, { recursive: true, force: true });
}

await main();
