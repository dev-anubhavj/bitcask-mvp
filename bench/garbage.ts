/**
 * What append-only costs.
 *
 * The store never overwrites and never erases, so every update leaves the old
 * record where it was and every delete adds a record rather than removing one.
 * This writes a store, churns it, empties half of it, and prints stats() after
 * each phase.
 *
 * Nothing here is clever. It is just the same three methods you already have,
 * pointed at the one number Stage 5 exists to fix.
 *
 *   bun run bench/garbage.ts
 */

import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Bitcask } from "../src/bitcask.ts";

const KEYS = 5_000;
const OVERWRITES = 4;
const VALUE_BYTES = 200;
const MAX_FILE_SIZE = 1024 * 1024;

const ROOT = join(import.meta.dirname, "..", ".tmp", "garbage");

/** "1.4 MiB" */
function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
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

async function main() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  const db = await Bitcask.open(ROOT, { maxFileSize: MAX_FILE_SIZE });
  const value = Buffer.alloc(VALUE_BYTES, 0x61);
  const key = (i: number) => Buffer.from(`key-${i}`);

  console.log(
    `\n  ${KEYS} keys, ${VALUE_BYTES}-byte values, ` +
      `${mib(MAX_FILE_SIZE)} per file\n`,
  );
  console.log("  phase                   keys  files      on disk        live  garbage");
  console.log("  " + "-".repeat(70));

  for (let i = 0; i < KEYS; i++) await db.put(key(i), value);
  await report(db, "written once");

  for (let round = 0; round < OVERWRITES; round++) {
    for (let i = 0; i < KEYS; i++) await db.put(key(i), value);
    await report(db, `overwritten x${round + 1}`);
  }

  for (let i = 0; i < KEYS; i += 2) await db.delete(key(i));
  await report(db, "half deleted");

  for (let i = 1; i < KEYS; i += 2) await db.delete(key(i));
  await report(db, "emptied");

  await db.close();

  console.log(
    "\n  The store is empty and it is the biggest it has ever been. Every\n" +
      "  byte on disk is now garbage: old versions nobody will read, and\n" +
      "  tombstones for keys nobody will ask for.\n\n" +
      "  Merge is the job that reads those files, keeps the records the\n" +
      "  keydir still points at, and unlinks the rest. That is Stage 5.\n",
  );

  await rm(ROOT, { recursive: true, force: true });
}

await main();
