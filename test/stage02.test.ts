import { describe, test, expect, afterAll } from "bun:test";
import { readFile, stat, truncate } from "node:fs/promises";
import { join } from "node:path";

import { Bitcask, KeyNotFoundError } from "../src/bitcask.ts";
import { decode, type DecodedRecord } from "../src/record.ts";
import { tmpdir, cleanup, b } from "./helpers.ts";

afterAll(cleanup);

/** The one data file a Stage 2 store writes to. */
const DATA = "1.data";

/** Reads the data file and returns every record in it, in file order. */
async function readLog(dir: string): Promise<DecodedRecord[]> {
  const buf = await readFile(join(dir, DATA));
  const records: DecodedRecord[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const record = decode(buf, offset);
    records.push(record);
    offset += record.length;
  }
  return records;
}

/** Size of the data file in bytes, or 0 if it does not exist yet. */
async function fileSize(dir: string): Promise<number> {
  try {
    return (await stat(join(dir, DATA))).size;
  } catch {
    return 0;
  }
}

describe("stage 2 - the log and the keydir", () => {
  describe("the data file", () => {
    test("put writes 1.data into the store directory", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("lang"), b("typescript"));
      expect(await fileSize(dir)).toBeGreaterThan(0);
      await db.close();
    });

    test("the file holds the record for what was put", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("lang"), b("typescript"));

      const log = await readLog(dir);
      expect(log.length).toBe(1);
      expect(log[0]!.key).toEqual(b("lang"));
      expect(log[0]!.value).toEqual(b("typescript"));
      await db.close();
    });

    test("records carry a wall-clock timestamp", async () => {
      const dir = await tmpdir();
      const before = Date.now();
      const db = await Bitcask.open(dir);
      await db.put(b("lang"), b("typescript"));
      const after = Date.now();

      const log = await readLog(dir);
      expect(log[0]!.timestamp).toBeGreaterThanOrEqual(before);
      expect(log[0]!.timestamp).toBeLessThanOrEqual(after);
      await db.close();
    });

    test("appends records in the order they were written", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("one"), b("1"));
      await db.put(b("two"), b("22"));
      await db.put(b("three"), b("333"));

      const log = await readLog(dir);
      expect(log.map((r) => r.key.toString())).toEqual(["one", "two", "three"]);
      expect(log.map((r) => r.value.toString())).toEqual(["1", "22", "333"]);
      await db.close();
    });

    test("an overwrite appends a second record and leaves the first alone", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("counter"), b("1"));
      await db.put(b("counter"), b("2"));

      const log = await readLog(dir);
      expect(log.length).toBe(2);
      expect(log.map((r) => r.value.toString())).toEqual(["1", "2"]);
      expect(await db.get(b("counter"))).toEqual(b("2"));
      await db.close();
    });

    test("the file only ever grows", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      const sizes: number[] = [await fileSize(dir)];

      await db.put(b("a"), b("aaaa"));
      sizes.push(await fileSize(dir));
      await db.put(b("b"), b("bbbb"));
      sizes.push(await fileSize(dir));
      await db.delete(b("a"));
      sizes.push(await fileSize(dir));
      await db.put(b("b"), b("shorter"));
      sizes.push(await fileSize(dir));

      for (let i = 1; i < sizes.length; i++) {
        expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
      }
      await db.close();
    });

    test("every byte in the file belongs to a record", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      for (let i = 0; i < 50; i++) {
        await db.put(b(`key-${i}`), b("v".repeat(i)));
      }

      // readLog throws if the walk ever lands anywhere but a record boundary.
      expect((await readLog(dir)).length).toBe(50);
      await db.close();
    });
  });

  describe("reads come from the file", () => {
    test("get fails once the bytes are gone from disk", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("lang"), b("typescript"));

      // Empty the file behind the store's back. Nothing is cached in memory,
      // so the read has nowhere left to get the value from.
      await truncate(join(dir, DATA), 0);
      await expect(db.get(b("lang"))).rejects.toThrow();
      await db.close();
    });

    test("get finds the right value among many records", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      for (let i = 0; i < 200; i++) {
        await db.put(b(`key-${i}`), b(`value-${i}-${"x".repeat(i % 37)}`));
      }
      for (let i = 0; i < 200; i++) {
        expect(await db.get(b(`key-${i}`))).toEqual(
          b(`value-${i}-${"x".repeat(i % 37)}`),
        );
      }
      await db.close();
    });

    test("get returns the newest value after repeated overwrites", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      for (let i = 0; i < 100; i++) {
        await db.put(b("counter"), b(String(i)));
      }

      expect(await db.get(b("counter"))).toEqual(b("99"));
      expect((await readLog(dir)).length).toBe(100);
      await db.close();
    });

    test("an unknown key still rejects when the file is full of others", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("a"), b("1"));
      await db.put(b("b"), b("2"));

      await expect(db.get(b("nope"))).rejects.toThrow(KeyNotFoundError);
      await db.close();
    });
  });

  describe("through the file, unchanged", () => {
    test("an empty value round trips", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("empty"), Buffer.alloc(0));

      expect((await db.get(b("empty"))).length).toBe(0);
      expect((await readLog(dir))[0]!.value.length).toBe(0);
      await db.close();
    });

    test("arbitrary bytes survive, including nulls and 0xff", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      const key = b([0x00, 0xff, 0x0a, 0x00, 0x1b]);
      const value = b([0xde, 0xad, 0x00, 0xbe, 0xef, 0xff, 0x00]);
      await db.put(key, value);

      expect(await db.get(key)).toEqual(value);
      await db.close();
    });

    test("a one megabyte value round trips", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      const big = Buffer.alloc(1024 * 1024, 0x5a);
      await db.put(b("big"), big);

      expect(await db.get(b("big"))).toEqual(big);
      await db.close();
    });

    test("a value written after a big one is still found", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("big"), Buffer.alloc(1024 * 1024, 0x5a));
      await db.put(b("small"), b("after"));

      expect(await db.get(b("small"))).toEqual(b("after"));
      await db.close();
    });
  });

  describe("concurrent writes", () => {
    test("puts issued together do not interleave in the file", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);

      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          db.put(b(`key-${i}`), b(`value-${i}-${"y".repeat(i * 3)}`)),
        ),
      );

      // If two appends compute the same offset, the walk lands on garbage.
      expect((await readLog(dir)).length).toBe(25);
      for (let i = 0; i < 25; i++) {
        expect(await db.get(b(`key-${i}`))).toEqual(
          b(`value-${i}-${"y".repeat(i * 3)}`),
        );
      }
      await db.close();
    });
  });

  describe("the keydir", () => {
    test("keys() lists what is live, not what was written", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("a"), b("1"));
      await db.put(b("b"), b("2"));
      await db.put(b("a"), b("3"));
      await db.delete(b("b"));

      const keys = (await db.keys()).map((k) => k.toString()).sort();
      expect(keys).toEqual(["a"]);
      await db.close();
    });

    test("a deleted key is gone even though its record is not", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      await db.put(b("doomed"), b("value"));
      const before = await fileSize(dir);

      await db.delete(b("doomed"));
      await expect(db.get(b("doomed"))).rejects.toThrow(KeyNotFoundError);
      expect(await fileSize(dir)).toBeGreaterThanOrEqual(before);
      await db.close();
    });
  });

  describe("close", () => {
    test("everything written is on disk once close resolves", async () => {
      const dir = await tmpdir();
      const db = await Bitcask.open(dir);
      for (let i = 0; i < 20; i++) {
        await db.put(b(`key-${i}`), b(`value-${i}`));
      }
      await db.close();

      const log = await readLog(dir);
      expect(log.length).toBe(20);
      expect(log[19]!.value).toEqual(b("value-19"));
    });

    test("two stores in different directories do not share a file", async () => {
      const dirA = await tmpdir();
      const dirB = await tmpdir();
      const storeA = await Bitcask.open(dirA);
      const storeB = await Bitcask.open(dirB);

      await storeA.put(b("k"), b("from-a"));
      await storeB.put(b("k"), b("from-b"));

      expect(await storeA.get(b("k"))).toEqual(b("from-a"));
      expect(await storeB.get(b("k"))).toEqual(b("from-b"));
      expect((await readLog(dirA)).length).toBe(1);
      expect((await readLog(dirB)).length).toBe(1);

      await storeA.close();
      await storeB.close();
    });
  });
});
