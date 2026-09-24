import { describe, test, expect, afterAll } from "bun:test";
import { readFile, readdir, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Bitcask, KeyNotFoundError, ClosedError } from "../src/bitcask.ts";
import { decode, type DecodedRecord } from "../src/record.ts";
import { tmpdir, cleanup, b } from "./helpers.ts";

afterAll(cleanup);

/** Names of the store's data files, in id order -- 2.data before 10.data. */
async function dataFiles(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => /^\d+\.data$/.test(n));
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

describe("stage 4 - tombstones and rollover", () => {
  describe("a delete leaves a mark", () => {
    test("a delete appends to the log", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("k"), b("v"));
      const before = await totalBytes(dir);

      await db.delete(b("k"));
      expect(await totalBytes(dir)).toBeGreaterThan(before);
      await db.close();
    });

    test("what a delete appends is a record like any other", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("k"), b("v"));
      await db.delete(b("k"));
      await db.close();

      // readLog throws if the walk lands anywhere but a record boundary.
      const log = await readLog(dir);
      expect(log.length).toBe(2);
      expect(log[0]!.key).toEqual(b("k"));
      expect(log[1]!.key).toEqual(b("k"));
    });

    test("a deleted key is still deleted after a reopen", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.put(b("doomed"), b("value"));
      await first.delete(b("doomed"));
      await first.close();

      const second = await Bitcask.open(dir);
      await expect(second.get(b("doomed"))).rejects.toThrow(KeyNotFoundError);
      expect(await second.keys()).toEqual([]);
      await second.close();
    });

    test("deleting one key of many leaves the rest alone across a reopen", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      for (let i = 0; i < 20; i++) await first.put(b(`k${i}`), b(`v${i}`));
      for (const i of [3, 7, 11, 19]) await first.delete(b(`k${i}`));
      await first.close();

      const second = await Bitcask.open(dir);
      expect((await second.keys()).length).toBe(16);
      expect(await second.get(b("k0"))).toEqual(b("v0"));
      expect(await second.get(b("k18"))).toEqual(b("v18"));
      await expect(second.get(b("k7"))).rejects.toThrow(KeyNotFoundError);
      await expect(second.get(b("k19"))).rejects.toThrow(KeyNotFoundError);
      await second.close();
    });

    test("a key put again after a delete comes back", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.put(b("k"), b("one"));
      await first.delete(b("k"));
      await first.put(b("k"), b("two"));
      await first.close();

      const second = await Bitcask.open(dir);
      expect(await second.get(b("k"))).toEqual(b("two"));
      await second.close();
    });

    test("a long alternating history replays to its last state", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      for (let i = 0; i < 10; i++) {
        await first.put(b("k"), b(`v${i}`));
        await first.delete(b("k"));
      }
      await first.put(b("k"), b("final"));
      await first.delete(b("k"));
      await first.close();

      const second = await Bitcask.open(dir);
      await expect(second.get(b("k"))).rejects.toThrow(KeyNotFoundError);
      await second.close();
    });

    test("deleting a key that was never there writes nothing", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("here"), b("v"));
      const before = await totalBytes(dir);

      await db.delete(b("absent"));
      expect(await totalBytes(dir)).toBe(before);
      await db.close();
    });

    test("deleting the same key twice writes one tombstone", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("k"), b("v"));
      await db.delete(b("k"));
      const before = await totalBytes(dir);

      await db.delete(b("k"));
      expect(await totalBytes(dir)).toBe(before);
      await db.close();
    });

    test("emptying the store makes the store bigger", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      for (let i = 0; i < 200; i++) await first.put(b(`k${i}`), b(PADDING));
      const full = await totalBytes(dir);

      for (let i = 0; i < 200; i++) await first.delete(b(`k${i}`));
      const empty = await totalBytes(dir);
      await first.close();

      expect(empty).toBeGreaterThan(full);

      const second = await Bitcask.open(dir);
      expect(await second.keys()).toEqual([]);
      await second.close();
    });

    test("a value is bytes, whatever those bytes happen to spell", async () => {
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

      const first = await Bitcask.open(dir);
      for (const [i, value] of values.entries()) {
        await first.put(b(`k${i}`), value);
      }
      await first.close();

      const second = await Bitcask.open(dir);
      expect((await second.keys()).length).toBe(values.length);
      for (const [i, value] of values.entries()) {
        expect(await second.get(b(`k${i}`))).toEqual(value);
      }
      await second.close();
    });
  });

  describe("rolling over", () => {
    test("without maxFileSize the store stays in one file", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      for (let i = 0; i < 500; i++) await db.put(b(`k${i}`), b(PADDING));
      await db.close();

      expect(await dataFiles(dir)).toEqual(["1.data"]);
    });

    test("a store with a threshold rolls into a second file", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 0; i < 10; i++) await db.put(b(`k${i}`), b(PADDING));
      await db.close();

      const files = await dataFiles(dir);
      expect(files.length).toBeGreaterThan(1);
      expect(files[0]).toBe("1.data");
      expect(files[1]).toBe("2.data");
    });

    test("a file is filled before the next one is started", async () => {
      const dir = await tmpdir();
      // Records are 18 + 3 + 100 = 121 bytes, so four fit under 500 and five
      // do not. Twenty writes should land as five files of four records.
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 30; i++) await db.put(b(`k${i}`), b(PADDING));
      await db.close();

      const files = await dataFiles(dir);
      expect(files.length).toBe(5);
      for (const name of files) {
        expect((await readFileLog(dir, name)).length).toBe(4);
      }
    });

    test("no file grows past the threshold", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 1024 });
      for (let i = 0; i < 300; i++) {
        await db.put(b(`k${i}`), b("v".repeat(i % 71)));
      }
      await db.close();

      for (const name of await dataFiles(dir)) {
        expect(await sizeOf(dir, name)).toBeLessThanOrEqual(1024);
      }
    });

    test("a record too big for the threshold gets a file to itself", async () => {
      const dir = await tmpdir();
      const big = Buffer.alloc(4096, 0x5a);
      const db = await Bitcask.open(dir, { maxFileSize: 256 });
      await db.put(b("small-before"), b("a"));
      await db.put(b("big"), big);
      await db.put(b("small-after"), b("b"));
      await db.close();

      // Whichever file the oversized record landed in holds only that record.
      for (const name of await dataFiles(dir)) {
        const log = await readFileLog(dir, name);
        if (log.some((r) => r.key.equals(b("big")))) {
          expect(log.length).toBe(1);
        } else {
          expect(await sizeOf(dir, name)).toBeLessThanOrEqual(256);
        }
      }
    });

    test("every file is a whole number of records", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 700 });
      for (let i = 0; i < 200; i++) {
        await db.put(b(`key-${i}`), b("v".repeat((i * 13) % 97)));
      }
      await db.delete(b("key-5"));
      await db.delete(b("key-150"));
      await db.close();

      // Each file walks cleanly on its own: no record straddles a boundary.
      let seen = 0;
      for (const name of await dataFiles(dir)) {
        seen += (await readFileLog(dir, name)).length;
      }
      expect(seen).toBe(202);
    });

    test("reads still work once the data is spread over many files", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 512 });
      for (let i = 0; i < 300; i++) {
        await db.put(b(`key-${i}`), b(`value-${i}-${"x".repeat(i % 53)}`));
      }

      expect((await dataFiles(dir)).length).toBeGreaterThan(10);
      for (let i = 0; i < 300; i++) {
        expect(await db.get(b(`key-${i}`))).toEqual(
          b(`value-${i}-${"x".repeat(i % 53)}`),
        );
      }
      await db.close();
    });

    test("an overwrite appends to the active file and leaves the old record alone", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 30; i++) await db.put(b(`k${i}`), b(PADDING));
      const firstFileSize = await sizeOf(dir, "1.data");

      await db.put(b("k10"), b("rewritten"));

      expect(await db.get(b("k10"))).toEqual(b("rewritten"));
      expect(await sizeOf(dir, "1.data")).toBe(firstFileSize);
      expect((await readFileLog(dir, "1.data")).length).toBe(4);
      await db.close();
    });
  });

  describe("past the tenth file", () => {
    test("the newest value wins when there are more than ten files", async () => {
      const dir = await tmpdir();
      // Records are 18 + 1 + 3 or 4 bytes, so each one gets its own file.
      const db = await Bitcask.open(dir, { maxFileSize: 30 });
      for (let i = 0; i < 15; i++) await db.put(b("k"), b(`v-${i}`));

      expect((await dataFiles(dir)).length).toBe(15);
      expect(await db.get(b("k"))).toEqual(b("v-14"));
      await db.close();
    });

    test("and still wins after a reopen", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 30 });
      for (let i = 0; i < 15; i++) await first.put(b("k"), b(`v-${i}`));
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 30 });
      expect(await second.get(b("k"))).toEqual(b("v-14"));
      await second.close();
    });

    test("a delete in a late file is not undone by an early one", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 30 });
      for (let i = 0; i < 12; i++) await first.put(b("k"), b(`v-${i}`));
      await first.delete(b("k"));
      await first.close();

      expect((await dataFiles(dir)).length).toBeGreaterThan(10);

      const second = await Bitcask.open(dir, { maxFileSize: 30 });
      await expect(second.get(b("k"))).rejects.toThrow(KeyNotFoundError);
      await second.close();
    });
  });

  describe("reopening a rolled store", () => {
    test("every key across every file comes back", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 512 });
      for (let i = 0; i < 250; i++) {
        await first.put(b(`key-${i}`), b(`value-${i}-${"x".repeat(i % 41)}`));
      }
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 512 });
      expect((await second.keys()).length).toBe(250);
      for (let i = 0; i < 250; i++) {
        expect(await second.get(b(`key-${i}`))).toEqual(
          b(`value-${i}-${"x".repeat(i % 41)}`),
        );
      }
      await second.close();
    });

    test("a reopened store keeps writing where it left off", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 22; i++) await first.put(b(`k${i}`), b(PADDING));
      const filesBefore = (await dataFiles(dir)).length;
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      await second.put(b("k99"), b(PADDING));
      await second.close();

      // Twelve records at four per file fills three files exactly, so the
      // thirteenth starts a fourth.
      expect(filesBefore).toBe(3);
      expect((await dataFiles(dir)).length).toBe(4);
      expect((await readLog(dir)).length).toBe(13);
    });

    test("a reopened store fills the last file before rolling again", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 16; i++) await first.put(b(`k${i}`), b(PADDING));
      await first.close();
      expect((await dataFiles(dir)).length).toBe(2);

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      await second.put(b("k99"), b(PADDING));
      await second.close();

      // The second file held two of four; the new record goes in beside them.
      expect((await dataFiles(dir)).length).toBe(2);
      expect((await readFileLog(dir, "2.data")).length).toBe(3);
    });

    test("deletes and rollover together survive a reopen", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 400 });
      for (let i = 0; i < 60; i++) await first.put(b(`k${i}`), b(PADDING));
      for (let i = 0; i < 60; i += 2) await first.delete(b(`k${i}`));
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 400 });
      expect((await second.keys()).length).toBe(30);
      expect(await second.get(b("k1"))).toEqual(b(PADDING));
      await expect(second.get(b("k0"))).rejects.toThrow(KeyNotFoundError);
      await second.close();
    });
  });

  describe("a torn tail, with files behind it", () => {
    test("only the last file is cut back", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 30; i++) await first.put(b(`k${i}`), b(PADDING));
      await first.close();

      const files = await dataFiles(dir);
      const last = files[files.length - 1]!;
      const sizesBefore = await Promise.all(
        files.slice(0, -1).map((n) => sizeOf(dir, n)),
      );

      // An interrupted append: three bytes short of a whole record.
      await truncate(join(dir, last), (await sizeOf(dir, last)) - 3);

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      expect((await second.keys()).length).toBe(19);
      await expect(second.get(b("k29"))).rejects.toThrow(KeyNotFoundError);
      expect(await second.get(b("k10"))).toEqual(b(PADDING));
      await second.close();

      const sizesAfter = await Promise.all(
        files.slice(0, -1).map((n) => sizeOf(dir, n)),
      );
      expect(sizesAfter).toEqual(sizesBefore);
    });

    test("the store is walkable and writable after the cut", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 30; i++) await first.put(b(`k${i}`), b(PADDING));
      await first.close();

      const files = await dataFiles(dir);
      const last = files[files.length - 1]!;
      await truncate(join(dir, last), (await sizeOf(dir, last)) - 5);

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      await second.put(b("after"), b("recovery"));
      await second.close();

      const log = await readLog(dir);
      expect(log[log.length - 1]!.key).toEqual(b("after"));

      const third = await Bitcask.open(dir, { maxFileSize: 500 });
      expect(await third.get(b("after"))).toEqual(b("recovery"));
      await third.close();
    });
  });

  describe("stats", () => {
    test("a fresh store reports one file and no keys", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      const s = await db.stats();

      expect(s.keys).toBe(0);
      expect(s.files).toBe(1);
      expect(s.activeFileId).toBe(1);
      expect(s.liveBytes).toBe(0);
      expect(s.totalBytes).toBe(0);
      await db.close();
    });

    test("keys counts what is live, not what was written", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("a"), b("1"));
      await db.put(b("b"), b("2"));
      await db.put(b("a"), b("3"));
      await db.delete(b("b"));

      expect((await db.stats()).keys).toBe(1);
      await db.close();
    });

    test("totalBytes is what is on disk", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 30; i++) await db.put(b(`k${i}`), b(PADDING));

      const s = await db.stats();
      expect(s.totalBytes).toBe(await totalBytes(dir));
      expect(s.files).toBe((await dataFiles(dir)).length);
      expect(s.activeFileId).toBe(s.files);
      await db.close();
    });

    test("liveBytes is what the keydir points at", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("k1"), b(PADDING));
      await db.put(b("k2"), b(PADDING));

      // Two records of 18 + 2 + 100 bytes, and nothing dead yet.
      const s = await db.stats();
      expect(s.liveBytes).toBe(240);
      expect(s.totalBytes).toBe(240);
      await db.close();
    });

    test("overwriting leaves garbage behind", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      for (let i = 0; i < 50; i++) await db.put(b("k"), b(PADDING));

      const s = await db.stats();
      expect(s.keys).toBe(1);
      expect(s.totalBytes).toBeGreaterThan(s.liveBytes * 40);
      await db.close();
    });

    test("deleting grows the store and shrinks what is live", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      for (let i = 0; i < 100; i++) await db.put(b(`k${i}`), b(PADDING));
      const before = await db.stats();

      for (let i = 0; i < 100; i++) await db.delete(b(`k${i}`));
      const after = await db.stats();
      await db.close();

      expect(after.totalBytes).toBeGreaterThan(before.totalBytes);
      expect(after.liveBytes).toBe(0);
      expect(after.keys).toBe(0);
    });

    test("stats survives a reopen", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir, { maxFileSize: 500 });
      for (let i = 10; i < 28; i++) await first.put(b(`k${i}`), b(PADDING));
      const before = await first.stats();
      await first.close();

      const second = await Bitcask.open(dir, { maxFileSize: 500 });
      expect(await second.stats()).toEqual(before);
      await second.close();
    });

    test("stats throws once the store is closed", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.close();

      await expect(db.stats()).rejects.toThrow(ClosedError);
    });
  });

  describe("the directory", () => {
    test("files that are not data files are left alone", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.put(b("k"), b("v"));
      await first.close();

      await writeFile(join(dir, "notes.txt"), "not mine");
      await writeFile(join(dir, "1.hint"), "not yet either");

      const second = await Bitcask.open(dir);
      expect(await second.get(b("k"))).toEqual(b("v"));
      expect((await second.stats()).files).toBe(1);
      await second.close();
    });
  });
});
