import { describe, test, expect, afterAll } from "bun:test";
import { readFile, writeFile, stat, truncate } from "node:fs/promises";
import { join } from "node:path";

import { Bitcask, KeyNotFoundError } from "../src/bitcask.ts";
import { encode, decode, type DecodedRecord } from "../src/record.ts";
import { tmpdir, cleanup, b } from "./helpers.ts";

afterAll(cleanup);

/** The one data file a store writes to until Stage 4. */
const DATA = "1.data";

/** A fixed clock, so records built by hand have known timestamps. */
const TS = 1_700_000_000_000;

/** Writes `bytes` into the store's data file, replacing whatever was there. */
async function writeRaw(dir: string, bytes: Buffer): Promise<void> {
  await writeFile(join(dir, DATA), bytes);
}

/** Returns the raw bytes of the store's data file. */
async function readRaw(dir: string): Promise<Buffer> {
  return readFile(join(dir, DATA));
}

/** Size of the data file in bytes. */
async function fileSize(dir: string): Promise<number> {
  return (await stat(join(dir, DATA))).size;
}

/** Walks the data file and returns every record in it, in file order. */
async function readLog(dir: string): Promise<DecodedRecord[]> {
  const buf = await readRaw(dir);
  const records: DecodedRecord[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const record = decode(buf, offset);
    records.push(record);
    offset += record.length;
  }
  return records;
}

/** Builds a log out of [key, value] pairs, each one millisecond apart. */
function buildLog(pairs: [string, string][]): Buffer {
  return Buffer.concat(
    pairs.map(([k, v], i) => encode(b(k), b(v), TS + i)),
  );
}

describe("stage 3 - replay and torn records", () => {
  describe("reopening a store", () => {
    test("a value written before the close is there after the reopen", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.put(b("lang"), b("typescript"));
      await first.close();

      const second = await Bitcask.open(dir);
      expect(await second.get(b("lang"))).toEqual(b("typescript"));
      await second.close();
    });

    test("every key comes back", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      for (let i = 0; i < 100; i++) {
        await first.put(b(`key-${i}`), b(`value-${i}-${"x".repeat(i % 29)}`));
      }
      await first.close();

      const second = await Bitcask.open(dir);
      expect((await second.keys()).length).toBe(100);
      for (let i = 0; i < 100; i++) {
        expect(await second.get(b(`key-${i}`))).toEqual(
          b(`value-${i}-${"x".repeat(i % 29)}`),
        );
      }
      await second.close();
    });

    test("binary keys and values survive the round trip through replay", async () => {
      const dir = await tmpdir();
      const key = b([0x00, 0xff, 0x0a, 0x1b, 0x00]);
      const value = b([0xde, 0xad, 0x00, 0xbe, 0xef, 0xff]);

      const first = await Bitcask.open(dir);
      await first.put(key, value);
      await first.close();

      const second = await Bitcask.open(dir);
      expect(await second.get(key)).toEqual(value);
      await second.close();
    });

    test("an empty value is still an empty value after a reopen", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.put(b("empty"), Buffer.alloc(0));
      await first.close();

      const second = await Bitcask.open(dir);
      expect((await second.get(b("empty"))).length).toBe(0);
      await second.close();
    });

    test("a store that was never written to opens empty", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.close();

      const second = await Bitcask.open(dir);
      expect(await second.keys()).toEqual([]);
      await second.close();
    });

    test("surviving three separate sessions", async () => {
      const dir = await tmpdir();
      for (const round of [0, 1, 2]) {
        const db = await Bitcask.open(dir);
        await db.put(b(`round-${round}`), b(`written in ${round}`));
        await db.close();
      }

      const db = await Bitcask.open(dir);
      expect((await db.keys()).length).toBe(3);
      expect(await db.get(b("round-0"))).toEqual(b("written in 0"));
      expect(await db.get(b("round-2"))).toEqual(b("written in 2"));
      await db.close();
    });
  });

  describe("the newest record wins", () => {
    test("an overwritten key replays to its last value", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.put(b("counter"), b("1"));
      await first.put(b("counter"), b("2"));
      await first.put(b("counter"), b("3"));
      await first.close();

      const second = await Bitcask.open(dir);
      expect(await second.get(b("counter"))).toEqual(b("3"));
      expect((await second.keys()).length).toBe(1);
      await second.close();
    });

    test("a key overwritten across two sessions keeps the later value", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.put(b("k"), b("old"));
      await first.close();

      const second = await Bitcask.open(dir);
      await second.put(b("k"), b("new"));
      await second.close();

      const third = await Bitcask.open(dir);
      expect(await third.get(b("k"))).toEqual(b("new"));
      await third.close();
    });

    test("later in the file wins, whatever the timestamps say", async () => {
      const dir = await tmpdir();
      // Two records for one key, the newer one written with an older clock.
      await writeRaw(
        dir,
        Buffer.concat([
          encode(b("k"), b("first"), TS + 5000),
          encode(b("k"), b("second"), TS),
        ]),
      );

      const db = await Bitcask.open(dir);
      expect(await db.get(b("k"))).toEqual(b("second"));
      await db.close();
    });
  });

  describe("a torn tail", () => {
    test("opens instead of throwing when the last record is cut short", async () => {
      const dir = await tmpdir();
      const log = buildLog([["a", "1"], ["b", "2"], ["c", "3"]]);
      await writeRaw(dir, log.subarray(0, log.length - 4));

      const db = await Bitcask.open(dir);
      expect(await db.get(b("a"))).toEqual(b("1"));
      expect(await db.get(b("b"))).toEqual(b("2"));
      await expect(db.get(b("c"))).rejects.toThrow(KeyNotFoundError);
      await db.close();
    });

    test("opens when the tail is too short to even hold a header", async () => {
      const dir = await tmpdir();
      const log = buildLog([["a", "1"], ["b", "2"]]);
      await writeRaw(dir, Buffer.concat([log, Buffer.alloc(7, 0x41)]));

      const db = await Bitcask.open(dir);
      expect((await db.keys()).length).toBe(2);
      await db.close();
    });

    test("opens when the last record's bytes were mangled", async () => {
      const dir = await tmpdir();
      const log = buildLog([["a", "1"], ["b", "2"], ["c", "3"]]);
      const torn = Buffer.from(log);
      torn[torn.length - 1] ^= 0xff;
      await writeRaw(dir, torn);

      const db = await Bitcask.open(dir);
      expect(await db.get(b("a"))).toEqual(b("1"));
      await expect(db.get(b("c"))).rejects.toThrow(KeyNotFoundError);
      await db.close();
    });

    test("the bad bytes are cut off the file, not just skipped", async () => {
      const dir = await tmpdir();
      const good = buildLog([["a", "1"], ["b", "2"]]);
      await writeRaw(dir, Buffer.concat([good, Buffer.alloc(9, 0x41)]));

      const db = await Bitcask.open(dir);
      await db.close();

      expect(await fileSize(dir)).toBe(good.length);
    });

    test("a file holding nothing but garbage opens as an empty store", async () => {
      const dir = await tmpdir();
      await writeRaw(dir, Buffer.alloc(11, 0x41));

      const db = await Bitcask.open(dir);
      expect(await db.keys()).toEqual([]);
      await db.close();

      expect(await fileSize(dir)).toBe(0);
    });

    test("a zero byte data file opens as an empty store", async () => {
      const dir = await tmpdir();
      await writeRaw(dir, Buffer.alloc(0));

      const db = await Bitcask.open(dir);
      expect(await db.keys()).toEqual([]);
      await db.close();
    });

    test("a real crash mid-write loses only the unfinished record", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      for (let i = 0; i < 30; i++) await first.put(b(`key-${i}`), b(`v-${i}`));
      await first.close();

      // Chop three bytes off, as an interrupted append would.
      await truncate(join(dir, DATA), (await fileSize(dir)) - 3);

      const second = await Bitcask.open(dir);
      expect((await second.keys()).length).toBe(29);
      expect(await second.get(b("key-28"))).toEqual(b("v-28"));
      await expect(second.get(b("key-29"))).rejects.toThrow(KeyNotFoundError);
      await second.close();
    });
  });

  describe("damage before the end", () => {
    test("replay stops at the first bad record and drops what follows", async () => {
      const dir = await tmpdir();
      const log = buildLog([["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
      const first = decode(log, 0);
      const second = decode(log, first.length);

      // Flip a byte inside the second record.
      const damaged = Buffer.from(log);
      damaged[first.length + 2] ^= 0xff;
      await writeRaw(dir, damaged);

      const db = await Bitcask.open(dir);
      expect(await db.get(b("a"))).toEqual(b("1"));
      await expect(db.get(b("b"))).rejects.toThrow(KeyNotFoundError);
      await expect(db.get(b("d"))).rejects.toThrow(KeyNotFoundError);
      await db.close();

      expect(await fileSize(dir)).toBe(first.length);
      expect(second.key).toEqual(b("b"));
    });

    test("the file is left walkable after the damage is cut away", async () => {
      const dir = await tmpdir();
      const log = buildLog([["a", "1"], ["b", "2"], ["c", "3"]]);
      const damaged = Buffer.from(log);
      damaged[decode(log, 0).length + 5] ^= 0xff;
      await writeRaw(dir, damaged);

      const db = await Bitcask.open(dir);
      await db.close();

      const records = await readLog(dir);
      expect(records.map((r) => r.key.toString())).toEqual(["a"]);
    });
  });

  describe("writing after recovery", () => {
    test("a put after a torn tail lands where the good data ended", async () => {
      const dir = await tmpdir();
      const good = buildLog([["a", "1"], ["b", "2"]]);
      await writeRaw(dir, Buffer.concat([good, Buffer.alloc(6, 0x41)]));

      const db = await Bitcask.open(dir);
      await db.put(b("c"), b("3"));
      await db.close();

      const records = await readLog(dir);
      expect(records.map((r) => r.key.toString())).toEqual(["a", "b", "c"]);
    });

    test("keys written after recovery survive the next reopen", async () => {
      const dir = await tmpdir();
      await writeRaw(dir, Buffer.concat([buildLog([["a", "1"]]), Buffer.alloc(4)]));

      const first = await Bitcask.open(dir);
      await first.put(b("b"), b("2"));
      await first.close();

      const second = await Bitcask.open(dir);
      expect(await second.get(b("a"))).toEqual(b("1"));
      expect(await second.get(b("b"))).toEqual(b("2"));
      await second.close();
    });

    test("a reopened store appends rather than overwriting", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.put(b("a"), b("1"));
      const sizeAfterFirst = await fileSize(dir);
      await first.close();

      const second = await Bitcask.open(dir);
      await second.put(b("b"), b("2"));
      await second.close();

      expect(await fileSize(dir)).toBeGreaterThan(sizeAfterFirst);
      expect((await readLog(dir)).length).toBe(2);
    });

    test("an overwrite after a reopen wins over the replayed value", async () => {
      const dir = await tmpdir();
      const first = await Bitcask.open(dir);
      await first.put(b("k"), b("old"));
      await first.close();

      const second = await Bitcask.open(dir);
      expect(await second.get(b("k"))).toEqual(b("old"));
      await second.put(b("k"), b("new"));
      expect(await second.get(b("k"))).toEqual(b("new"));
      await second.close();

      const third = await Bitcask.open(dir);
      expect(await third.get(b("k"))).toEqual(b("new"));
      await third.close();
    });
  });
});
