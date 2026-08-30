import { describe, test, expect, afterAll } from "bun:test";
import { stat } from "node:fs/promises";

import {
  Bitcask,
  LIMITS,
  KeyNotFoundError,
  InvalidArgumentError,
  ClosedError,
} from "../src/bitcask.ts";
import { tmpdir, unusedPath, cleanup, b } from "./helpers.ts";

afterAll(cleanup);

describe("stage 0 - the API", () => {
  describe("open", () => {
    test("creates the directory if it does not exist", async () => {
      const dir = await unusedPath();
      const db = await Bitcask.open(dir);
      expect((await stat(dir)).isDirectory()).toBe(true);
      await db.close();
    });

    test("accepts a directory that already exists", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.close();
    });
  });

  describe("put / get", () => {
    test("reads back what it wrote", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("lang"), b("typescript"));
      expect(await db.get(b("lang"))).toEqual(b("typescript"));
      await db.close();
    });

    test("rejects with KeyNotFoundError for an unknown key", async () => {
      const db = await Bitcask.open(await tmpdir());
      await expect(db.get(b("nope"))).rejects.toThrow(KeyNotFoundError);
      await db.close();
    });

    test("overwrites an existing key", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("counter"), b("1"));
      await db.put(b("counter"), b("2"));
      await db.put(b("counter"), b("3"));
      expect(await db.get(b("counter"))).toEqual(b("3"));
      await db.close();
    });

    test("stores an empty value, which is not the same as no key", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("empty"), Buffer.alloc(0));
      expect((await db.get(b("empty"))).length).toBe(0);
      await db.close();
    });

    test("handles a value much larger than its key", async () => {
      const db = await Bitcask.open(await tmpdir());
      const big = Buffer.alloc(1 << 20, 0xab);
      await db.put(b("big"), big);
      expect(await db.get(b("big"))).toEqual(big);
      await db.close();
    });
  });

  describe("delete", () => {
    test("makes the key unreadable", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("temp"), b("value"));
      await db.delete(b("temp"));
      await expect(db.get(b("temp"))).rejects.toThrow(KeyNotFoundError);
      await db.close();
    });

    test("is a no-op for a key that is not present", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.delete(b("never-existed"));
      await db.close();
    });

    test("leaves other keys alone", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("a"), b("1"));
      await db.put(b("b"), b("2"));
      await db.delete(b("a"));
      expect(await db.get(b("b"))).toEqual(b("2"));
      await db.close();
    });

    test("allows a key to be written again after deletion", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("phoenix"), b("v1"));
      await db.delete(b("phoenix"));
      await db.put(b("phoenix"), b("v2"));
      expect(await db.get(b("phoenix"))).toEqual(b("v2"));
      await db.close();
    });
  });

  describe("keys", () => {
    test("is empty for a fresh store", async () => {
      const db = await Bitcask.open(await tmpdir());
      expect(await db.keys()).toEqual([]);
      await db.close();
    });

    test("lists live keys only", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("a"), b("1"));
      await db.put(b("b"), b("2"));
      await db.put(b("c"), b("3"));
      await db.delete(b("b"));

      const got = (await db.keys()).map((k) => k.toString("latin1")).sort();
      expect(got).toEqual(["a", "c"]);
      await db.close();
    });

    test("does not double-count an overwritten key", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("x"), b("1"));
      await db.put(b("x"), b("2"));
      expect((await db.keys()).length).toBe(1);
      await db.close();
    });
  });

  describe("binary safety", () => {
    test("round-trips arbitrary bytes in keys and values", async () => {
      const db = await Bitcask.open(await tmpdir());
      const key = b([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
      const val = b([0xde, 0xad, 0x00, 0xbe, 0xef]);
      await db.put(key, val);
      expect(await db.get(key)).toEqual(val);
      await db.close();
    });

    test("keeps distinct byte sequences distinct", async () => {
      const db = await Bitcask.open(await tmpdir());
      // Neither 0xFF nor 0xFE is valid UTF-8. Decoding either one as UTF-8
      // gives back the same replacement character, so a store that uses UTF-8
      // to build its Map keys will treat these two keys as the same key.
      const k1 = b([0xff]);
      const k2 = b([0xfe]);
      await db.put(k1, b("first"));
      await db.put(k2, b("second"));
      expect(await db.get(k1)).toEqual(b("first"));
      expect(await db.get(k2)).toEqual(b("second"));
      expect((await db.keys()).length).toBe(2);
      await db.close();
    });

    test("treats a NUL byte as an ordinary byte in a key", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b([0x61, 0x00, 0x62]), b("with-nul"));
      await db.put(b([0x61]), b("just-a"));
      expect(await db.get(b([0x61, 0x00, 0x62]))).toEqual(b("with-nul"));
      expect(await db.get(b([0x61]))).toEqual(b("just-a"));
      await db.close();
    });
  });

  describe("ownership of buffers", () => {
    test("does not alias the caller's value buffer", async () => {
      const db = await Bitcask.open(await tmpdir());
      const val = b("original");
      await db.put(b("k"), val);
      // Overwrite the caller's buffer after the put. The stored value must not change.
      val.fill(0x58);
      expect(await db.get(b("k"))).toEqual(b("original"));
      await db.close();
    });

    test("does not alias the caller's key buffer", async () => {
      const db = await Bitcask.open(await tmpdir());
      const key = b("stable");
      await db.put(key, b("v"));
      key.fill(0x58);
      expect(await db.get(b("stable"))).toEqual(b("v"));
      await db.close();
    });

    test("does not hand out a reference to stored state", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("k"), b("original"));
      const got = await db.get(b("k"));
      // Overwrite the Buffer that get() returned. The stored value must not change.
      got.fill(0x58);
      expect(await db.get(b("k"))).toEqual(b("original"));
      await db.close();
    });
  });

  describe("validation", () => {
    test("rejects a non-Buffer key", async () => {
      const db = await Bitcask.open(await tmpdir());
      const bad = "a string, not a Buffer" as unknown as Buffer;
      await expect(db.put(bad, b("v"))).rejects.toThrow(InvalidArgumentError);
      await expect(db.get(bad)).rejects.toThrow(InvalidArgumentError);
      await expect(db.delete(bad)).rejects.toThrow(InvalidArgumentError);
      await db.close();
    });

    test("rejects an empty key", async () => {
      const db = await Bitcask.open(await tmpdir());
      await expect(db.put(Buffer.alloc(0), b("v"))).rejects.toThrow(InvalidArgumentError);
      await expect(db.get(Buffer.alloc(0))).rejects.toThrow(InvalidArgumentError);
      await db.close();
    });

    test("rejects a key larger than MAX_KEY_SIZE", async () => {
      const db = await Bitcask.open(await tmpdir());
      const huge = Buffer.alloc(LIMITS.MAX_KEY_SIZE + 1, 0x6b);
      await expect(db.put(huge, b("v"))).rejects.toThrow(InvalidArgumentError);
      await db.close();
    });

    test("accepts a key of exactly MAX_KEY_SIZE", async () => {
      const db = await Bitcask.open(await tmpdir());
      const max = Buffer.alloc(LIMITS.MAX_KEY_SIZE, 0x6b);
      await db.put(max, b("v"));
      expect(await db.get(max)).toEqual(b("v"));
      await db.close();
    });

    test("rejects a non-Buffer value", async () => {
      const db = await Bitcask.open(await tmpdir());
      const bad = 42 as unknown as Buffer;
      await expect(db.put(b("k"), bad)).rejects.toThrow(InvalidArgumentError);
      await db.close();
    });

    test("reports a malformed key as invalid, not as missing", async () => {
      const db = await Bitcask.open(await tmpdir());
      await expect(db.get(Buffer.alloc(0))).rejects.toThrow(InvalidArgumentError);
      await db.close();
    });
  });

  describe("close", () => {
    test("rejects every operation once closed", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.put(b("k"), b("v"));
      await db.close();

      await expect(db.get(b("k"))).rejects.toThrow(ClosedError);
      await expect(db.put(b("k"), b("v"))).rejects.toThrow(ClosedError);
      await expect(db.delete(b("k"))).rejects.toThrow(ClosedError);
      await expect(db.keys()).rejects.toThrow(ClosedError);
    });

    test("is idempotent", async () => {
      const db = await Bitcask.open(await tmpdir());
      await db.close();
      await db.close();
    });
  });
});
