import { describe, test, expect, afterAll } from "bun:test";
import { readFile, readdir, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { Bitcask, KeyNotFoundError, ClosedError } from "../src/bitcask.ts";
import { CorruptRecordError } from "../src/errors.ts";
import { decode, HEADER_SIZE, type DecodedRecord } from "../src/record.ts";
import { tmpdir, cleanup, b } from "./helpers.ts";

afterAll(cleanup);

/** Names of the store's data files, in id order -- 2.data before 10.data. */
async function dataFiles(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => /^\d+\.data$/.test(n));
  return names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/** Names of the store's hint files, in id order. */
async function hintFiles(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => /^\d+\.hint$/.test(n));
  return names.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/** Size of one file in bytes. */
async function sizeOf(dir: string, name: string): Promise<number> {
  return (await stat(join(dir, name))).size;
}

/** Bytes held by every data file in the store. */
async function totalBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await dataFiles(dir)) total += await sizeOf(dir, name);
  return total;
}

/** Walks a buffer of records. Throws if it lands anywhere but a boundary. */
function walk(buf: Buffer): DecodedRecord[] {
  const records: DecodedRecord[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const record = decode(buf, offset);
    records.push(record);
    offset += record.length;
  }
  return records;
}

/** Every record in one data file, in file order. */
async function readFileLog(dir: string, name: string): Promise<DecodedRecord[]> {
  return walk(await readFile(join(dir, name)));
}

/** Every record in the store, oldest file first. */
async function readLog(dir: string): Promise<DecodedRecord[]> {
  const records: DecodedRecord[] = [];
  for (const name of await dataFiles(dir)) {
    records.push(...(await readFileLog(dir, name)));
  }
  return records;
}

/** A 100-byte value, so record sizes are easy to reason about. */
const PADDING = "p".repeat(100);

/**
 * Twenty keys written once, then the first ten written again.
 *
 * Thirty records of 18 + 3 + 100 = 121 bytes, ten of which are now dead. At a
 * 500-byte threshold that is four records per file: eight files, the last of
 * which holds two records and is the active one.
 */
async function churn(db: Bitcask): Promise<void> {
  for (let i = 10; i < 30; i++) await db.put(b(`k${i}`), b(PADDING));
  for (let i = 10; i < 20; i++) await db.put(b(`k${i}`), b(PADDING));
}

/** A distinct value per key and round, so it is clear which write won. */
function value(i: number, round: number): Buffer {
  return b(`r${round}-v${i}-${"x".repeat(i % 37)}`);
}

/** The active file's name, which merge is not allowed to touch. */
async function activeName(db: Bitcask): Promise<string> {
  return `${(await db.stats()).activeFileId}.data`;
}

describe("stage 5 - merge and hint files", () => {
  describe("merge reclaims the garbage", () => {
    test("merge reclaims exactly the garbage", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(db);

      const before = await db.stats();
      expect(before.keys).toBe(20);
      expect(before.liveBytes).toBe(2420);
      expect(before.totalBytes).toBe(3630);

      await db.merge();

      const after = await db.stats();
      expect(after.keys).toBe(20);
      expect(after.liveBytes).toBe(2420);
      expect(after.totalBytes).toBe(2420);
      expect(after.files).toBeLessThan(before.files);
      expect(await totalBytes(dir)).toBe(2420);
      await db.close();
    });

    test("every record left is one the keydir points at", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(db);
      await db.merge();

      const keys = (await db.keys()).map((k) => k.toString("latin1")).sort();
      const written = (await readLog(dir))
        .map((r) => r.key.toString("latin1"))
        .sort();
      await db.close();

      // One record per live key, and nothing else: no stale copies, no
      // tombstones, no duplicates.
      expect(written).toEqual(keys);
    });

    test("one frozen file merges as happily as eight", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 14; i++) await db.put(b(`k${i}`), b(PADDING));
      await db.put(b("k10"), b(PADDING));

      // 1.data is full and frozen; 2.data is active and holds the rewrite.
      expect((await dataFiles(dir)).length).toBe(2);

      await db.merge();

      const s = await db.stats();
      expect(s.keys).toBe(4);
      expect(s.totalBytes).toBe(484);
      expect(s.liveBytes).toBe(484);
      await db.close();
    });

    test("every value is still there right after a merge", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 512 });
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 300; i++) await db.put(b(`key-${i}`), value(i, round));
      }

      const before = await db.stats();
      await db.merge();
      const after = await db.stats();

      expect(after.keys).toBe(300);
      expect(after.totalBytes).toBeLessThan(before.totalBytes / 2);
      for (let i = 0; i < 300; i++) {
        expect(await db.get(b(`key-${i}`))).toEqual(value(i, 2));
      }
      await db.close();
    });

    test("and still there after a reopen", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 512 });
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 300; i++) {
          await first.put(b(`key-${i}`), value(i, round));
        }
      }
      await first.merge();
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 512 });
      expect((await second.keys()).length).toBe(300);
      for (let i = 0; i < 300; i++) {
        expect(await second.get(b(`key-${i}`))).toEqual(value(i, 2));
      }
      await second.close();
    });

    test("no file merge writes is bigger than the threshold", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 1024 });
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 200; i++) {
          await db.put(b(`key-${i}`), b("v".repeat((i * 13) % 97)));
        }
      }
      await db.merge();
      await db.close();

      for (const name of await dataFiles(dir)) {
        expect(await sizeOf(dir, name)).toBeLessThanOrEqual(1024);
      }
    });

    test("merging an empty store does nothing much", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });

      await db.merge();

      expect(await db.keys()).toEqual([]);
      await db.put(b("k"), b("v"));
      expect(await db.get(b("k"))).toEqual(b("v"));
      await db.close();
    });

    test("a key that only exists in the active file is not lost", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(db);

      // The last two records written are still in the active file, so merge
      // never reads them.
      await db.merge();
      expect(await db.get(b("k18"))).toEqual(b(PADDING));
      expect(await db.get(b("k19"))).toEqual(b(PADDING));
      await db.close();

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      expect(await second.get(b("k18"))).toEqual(b(PADDING));
      expect(await second.get(b("k19"))).toEqual(b(PADDING));
      await second.close();
    });
  });

  describe("what merge leaves alone", () => {
    test("the active file comes out byte for byte the same", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(db);

      const before = await db.stats();
      const name = `${before.activeFileId}.data`;
      const bytes = await readFile(join(dir, name));

      await db.merge();

      const after = await db.stats();
      expect(after.activeFileId).toBe(before.activeFileId);
      expect(await readFile(join(dir, name))).toEqual(bytes);
      await db.close();
    });

    test("a store with nothing frozen yet is left as it is", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      for (let i = 0; i < 50; i++) await db.put(b("k"), b(PADDING));

      const before = await db.stats();
      expect(before.files).toBe(1);

      await db.merge();

      const after = await db.stats();
      expect(after.files).toBe(1);
      expect(after.totalBytes).toBe(before.totalBytes);
      expect(await db.get(b("k"))).toEqual(b(PADDING));
      await db.close();
    });

    test("files that are not the store's are left alone", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(db);
      await writeFile(join(dir, "notes.txt"), "not mine");

      await db.merge();
      await db.close();

      expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("not mine");
    });

    test("values come through a merge byte for byte", async () => {
      const dir = await tmpdir();
      const values: Buffer[] = [
        Buffer.alloc(0),
        b("bitcask_tombstone"),
        b("__tombstone__"),
        b("TOMBSTONE"),
        b("deleted"),
        b("<deleted>"),
        b([0x00]),
        b([0xff, 0xff, 0xff, 0xff]),
      ];

      const first = await Bitcask.open(dir, { maxFileSize: 300 });
      for (const [i, v] of values.entries()) await first.put(b(`k${i}`), v);
      // Filler, so everything above is frozen by the time merge runs.
      for (let i = 0; i < 20; i++) await first.put(b(`filler${i}`), b(PADDING));
      await first.merge();
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 300 });
      for (const [i, v] of values.entries()) {
        expect(await second.get(b(`k${i}`))).toEqual(v);
      }
      await second.close();
    });

    test("keys that are not text come through a merge too", async () => {
      const dir = await tmpdir();
      const keys: Buffer[] = [
        b([0x00, 0x01, 0xff]),
        b("with\nnewline"),
        b("with,comma"),
        b("with space"),
        b([0x0d, 0x0a]),
        b([0xff]),
        b("1.data"),
      ];

      const first = await Bitcask.open(dir, { maxFileSize: 300 });
      for (const [i, k] of keys.entries()) await first.put(k, b(`v${i}`));
      for (let i = 0; i < 20; i++) await first.put(b(`filler${i}`), b(PADDING));
      await first.merge();
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 300 });
      expect((await second.keys()).length).toBe(keys.length + 20);
      for (const [i, k] of keys.entries()) {
        expect(await second.get(k)).toEqual(b(`v${i}`));
      }
      await second.close();
    });
  });

  describe("merge and the order of the log", () => {
    test("a write after a merge beats the merged copy", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(first);
      await first.merge();

      await first.put(b("k20"), b("fresh"));
      expect(await first.get(b("k20"))).toEqual(b("fresh"));
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      expect(await second.get(b("k20"))).toEqual(b("fresh"));
      expect((await second.keys()).length).toBe(20);
      expect(await second.get(b("k21"))).toEqual(b(PADDING));
      await second.close();
    });

    test("a delete after a merge stays a delete", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(first);
      await first.merge();

      await first.delete(b("k20"));
      await expect(first.get(b("k20"))).rejects.toThrow(KeyNotFoundError);
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      await expect(second.get(b("k20"))).rejects.toThrow(KeyNotFoundError);
      expect((await second.keys()).length).toBe(19);
      await second.close();
    });

    test("writing on past a merge keeps rolling and still replays", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(first);
      await first.merge();
      for (let i = 100; i < 150; i++) await first.put(b(`k${i}`), b(PADDING));
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      expect((await second.keys()).length).toBe(70);
      for (let i = 10; i < 30; i++) {
        expect(await second.get(b(`k${i}`))).toEqual(b(PADDING));
      }
      for (let i = 100; i < 150; i++) {
        expect(await second.get(b(`k${i}`))).toEqual(b(PADDING));
      }
      await second.close();
    });

    test("a merge in the middle of a store's life changes nothing visible", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 400 });
      for (let i = 0; i < 100; i++) await db.put(b(`key-${i}`), value(i, 0));
      for (let i = 0; i < 100; i += 3) await db.delete(b(`key-${i}`));
      for (let i = 0; i < 100; i += 5) await db.put(b(`key-${i}`), value(i, 1));

      const expected = new Map<string, Buffer>();
      for (let i = 0; i < 100; i++) expected.set(`key-${i}`, value(i, 0));
      for (let i = 0; i < 100; i += 3) expected.delete(`key-${i}`);
      for (let i = 0; i < 100; i += 5) expected.set(`key-${i}`, value(i, 1));

      await db.merge();
      await db.close();

      const second = await Bitcask.open(dir, { maxFileSize: 400 });
      expect((await second.keys()).length).toBe(expected.size);
      for (let i = 0; i < 100; i++) {
        const want = expected.get(`key-${i}`);
        if (want === undefined) {
          await expect(second.get(b(`key-${i}`))).rejects.toThrow(KeyNotFoundError);
        } else {
          expect(await second.get(b(`key-${i}`))).toEqual(want);
        }
      }
      await second.close();
    });
  });

  describe("merge and tombstones", () => {
    test("a deleted key does not come back", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 30; i++) await first.put(b(`k${i}`), b(PADDING));
      await first.delete(b("k15"));
      for (let i = 30; i < 40; i++) await first.put(b(`k${i}`), b(PADDING));

      await first.merge();
      await expect(first.get(b("k15"))).rejects.toThrow(KeyNotFoundError);
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      await expect(second.get(b("k15"))).rejects.toThrow(KeyNotFoundError);
      expect((await second.keys()).length).toBe(29);
      await second.close();
    });

    test("emptying a rolled store and merging leaves only the active file", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 400 });
      for (let i = 0; i < 60; i++) await first.put(b(`k${i}`), b(PADDING));
      for (let i = 0; i < 60; i++) await first.delete(b(`k${i}`));

      const before = await first.stats();
      await first.merge();
      const after = await first.stats();

      expect(after.keys).toBe(0);
      expect(after.liveBytes).toBe(0);
      expect(after.files).toBe(1);
      expect(after.totalBytes).toBeLessThan(before.totalBytes);
      expect(after.totalBytes).toBe(
        await sizeOf(dir, `${after.activeFileId}.data`),
      );
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 400 });
      expect(await second.keys()).toEqual([]);
      await second.close();
    });

    test("a key deleted and put again survives a merge", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      await first.put(b("k"), b("first"));
      await first.delete(b("k"));
      await first.put(b("k"), b("reborn"));
      for (let i = 0; i < 20; i++) await first.put(b(`filler${i}`), b(PADDING));

      await first.merge();
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      expect(await second.get(b("k"))).toEqual(b("reborn"));
      await second.close();
    });
  });

  describe("merge is repeatable", () => {
    test("merging twice changes nothing the second time", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(db);

      await db.merge();
      const first = await db.stats();
      await db.merge();
      const second = await db.stats();
      await db.close();

      expect(second.keys).toBe(first.keys);
      expect(second.files).toBe(first.files);
      expect(second.liveBytes).toBe(first.liveBytes);
      expect(second.totalBytes).toBe(first.totalBytes);
    });

    test("merge, write, merge again", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(first);
      await first.merge();
      for (let i = 10; i < 30; i++) await first.put(b(`k${i}`), b("second"));
      await first.merge();

      const s = await first.stats();
      expect(s.keys).toBe(20);
      expect(s.totalBytes).toBe(s.liveBytes);
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      expect((await second.keys()).length).toBe(20);
      for (let i = 10; i < 30; i++) {
        expect(await second.get(b(`k${i}`))).toEqual(b("second"));
      }
      await second.close();
    });

    test("merge throws once the store is closed", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.close();

      await expect(db.merge()).rejects.toThrow(ClosedError);
    });
  });

  describe("hint files", () => {
    test("merge writes a hint beside every file it produces", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(db);
      await db.merge();

      const active = await activeName(db);
      const frozen = (await dataFiles(dir)).filter((n) => n !== active);
      await db.close();

      expect(frozen.length).toBeGreaterThan(0);
      for (const name of frozen) {
        expect(existsSync(join(dir, name.replace(".data", ".hint")))).toBe(true);
      }
    });

    test("the file still being written to has no hint", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(db);
      await db.merge();

      const active = await activeName(db);
      await db.close();

      expect(existsSync(join(dir, active.replace(".data", ".hint")))).toBe(false);
    });

    test("a hint file is a fraction of the data file's size", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 64 * 1024 });
      const big = Buffer.alloc(1000, 0x61);
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 200; i++) await db.put(b(`key-${i}`), big);
      }
      await db.merge();

      const active = await activeName(db);
      await db.close();

      const hints = await hintFiles(dir);
      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) {
        const data = hint.replace(".hint", ".data");
        expect(data).not.toBe(active);
        const hintSize = await sizeOf(dir, hint);
        expect(hintSize).toBeGreaterThan(0);
        // The values are the bulk of the data file and a hint holds none of
        // them, so a hint cannot be anywhere near the same size.
        expect(hintSize * 10).toBeLessThan(await sizeOf(dir, data));
      }
    });

    test("open reads the hint file and not the values", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 4096 });
      const big = Buffer.alloc(500, 0x62);
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 60; i++) await first.put(b(`key-${i}`), big);
      }
      await first.merge();
      const active = await activeName(first);
      await first.close();

      // Rot one byte inside a value in a merged file. Nothing that reads the
      // values on the way past can miss it; nothing that reads the hint can
      // see it.
      const files = await dataFiles(dir);
      const victim = files[0]!;
      expect(victim).not.toBe(active);
      const bytes = await readFile(join(dir, victim));
      const record = decode(bytes, 0);
      const valueAt = HEADER_SIZE + record.key.length + 10;
      bytes[valueAt] = bytes[valueAt]! ^ 0xff;
      await writeFile(join(dir, victim), bytes);

      const second = await Bitcask.open(dir, { maxFileSize: 4096 });
      expect((await second.keys()).length).toBe(60);
      const rotted = record.key;
      for (let i = 0; i < 60; i++) {
        if (b(`key-${i}`).equals(rotted)) continue;
        expect(await second.get(b(`key-${i}`))).toEqual(big);
      }
      // The damage is found on the read instead, where the CRC still runs.
      await expect(second.get(rotted)).rejects.toThrow(CorruptRecordError);
      await second.close();
    });

    test("a store whose hint files are gone opens from the data files", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 512 });
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 100; i++) await first.put(b(`key-${i}`), value(i, round));
      }
      await first.merge();
      await first.close();

      const hints = await hintFiles(dir);
      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) await unlink(join(dir, hint));

      const second = await Bitcask.open(dir, { maxFileSize: 512 });
      expect((await second.keys()).length).toBe(100);
      for (let i = 0; i < 100; i++) {
        expect(await second.get(b(`key-${i}`))).toEqual(value(i, 1));
      }
      await second.close();
    });

    test("a hint file full of junk is ignored", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 512 });
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 100; i++) await first.put(b(`key-${i}`), value(i, round));
      }
      await first.merge();
      await first.close();

      const hints = await hintFiles(dir);
      expect(hints.length).toBeGreaterThan(0);
      await writeFile(join(dir, hints[0]!), Buffer.alloc(64, 0xff));

      const second = await Bitcask.open(dir, { maxFileSize: 512 });
      expect((await second.keys()).length).toBe(100);
      for (let i = 0; i < 100; i++) {
        expect(await second.get(b(`key-${i}`))).toEqual(value(i, 1));
      }
      await second.close();
    });

    test("a hint file that stops halfway is ignored in full", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 512 });
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 100; i++) await first.put(b(`key-${i}`), value(i, round));
      }
      await first.merge();
      await first.close();

      const hints = await hintFiles(dir);
      expect(hints.length).toBeGreaterThan(0);
      const cut = Math.floor((await sizeOf(dir, hints[0]!)) / 2);
      await truncate(join(dir, hints[0]!), cut);

      const second = await Bitcask.open(dir, { maxFileSize: 512 });
      expect((await second.keys()).length).toBe(100);
      for (let i = 0; i < 100; i++) {
        expect(await second.get(b(`key-${i}`))).toEqual(value(i, 1));
      }
      await second.close();
    });

    test("merge leaves no hint file without a data file", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(db);
      await db.merge();
      for (let i = 10; i < 30; i++) await db.put(b(`k${i}`), b("again"));
      await db.merge();
      await db.close();

      const hints = await hintFiles(dir);
      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) {
        expect(existsSync(join(dir, hint.replace(".hint", ".data")))).toBe(true);
      }
    });

    test("a torn tail in the active file still recovers after a merge", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      await churn(first);
      await first.merge();
      const active = await activeName(first);
      await first.close();

      // An interrupted append: three bytes short of a whole record.
      await truncate(join(dir, active), (await sizeOf(dir, active)) - 3);

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      expect((await second.keys()).length).toBe(19);
      await expect(second.get(b("k19"))).rejects.toThrow(KeyNotFoundError);
      expect(await second.get(b("k10"))).toEqual(b(PADDING));
      await second.put(b("after"), b("recovery"));
      await second.close();

      const third = await Bitcask.open(dir, { maxFileSize: 500 });
      expect(await third.get(b("after"))).toEqual(b("recovery"));
      await third.close();
    });
  });
});
