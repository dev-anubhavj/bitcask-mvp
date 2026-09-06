import { describe, test, expect } from "bun:test";
import { crc32 } from "node:zlib";

import { encode, decode, HEADER_SIZE, OFFSETS } from "../src/record.ts";
import {
  BitcaskError,
  InvalidArgumentError,
  CorruptRecordError,
  TruncatedRecordError,
} from "../src/errors.ts";
import { b } from "./helpers.ts";

/** A fixed timestamp, so tests do not depend on the clock. */
const TS = 1_700_000_000_000;

describe("stage 1 - the record", () => {
  describe("layout", () => {
    test("header is 18 bytes", () => {
      expect(HEADER_SIZE).toBe(18);
    });

    test("total size is header + key + value", () => {
      const enc = encode(b("abc"), b("wxyz"), TS);
      expect(enc.length).toBe(HEADER_SIZE + 3 + 4);
    });

    test("writes the sizes into the header", () => {
      const enc = encode(b("abc"), b("wxyz"), TS);
      expect(enc.readUInt16LE(OFFSETS.KEY_SIZE)).toBe(3);
      expect(enc.readUInt32LE(OFFSETS.VALUE_SIZE)).toBe(4);
    });

    test("writes the timestamp into the header", () => {
      const enc = encode(b("abc"), b("wxyz"), TS);
      expect(Number(enc.readBigUInt64LE(OFFSETS.TIMESTAMP))).toBe(TS);
    });

    test("writes key then value straight after the header", () => {
      const enc = encode(b("abc"), b("wxyz"), TS);
      expect(enc.subarray(HEADER_SIZE, HEADER_SIZE + 3)).toEqual(b("abc"));
      expect(enc.subarray(HEADER_SIZE + 3)).toEqual(b("wxyz"));
    });

    test("the crc is a crc32 of every byte after the crc field", () => {
      const enc = encode(b("abc"), b("wxyz"), TS);
      expect(enc.readUInt32LE(OFFSETS.CRC)).toBe(crc32(enc.subarray(4)));
    });
  });

  describe("round trip", () => {
    test("returns the key and value it was given", () => {
      const r = decode(encode(b("lang"), b("typescript"), TS));
      expect(r.key).toEqual(b("lang"));
      expect(r.value).toEqual(b("typescript"));
    });

    test("returns the timestamp it was given", () => {
      expect(decode(encode(b("k"), b("v"), TS)).timestamp).toBe(TS);
    });

    test("defaults the timestamp to now", () => {
      const before = Date.now();
      const r = decode(encode(b("k"), b("v")));
      const after = Date.now();
      expect(r.timestamp).toBeGreaterThanOrEqual(before);
      expect(r.timestamp).toBeLessThanOrEqual(after);
    });

    test("reports the total bytes consumed", () => {
      const r = decode(encode(b("abc"), b("wxyz"), TS));
      expect(r.length).toBe(HEADER_SIZE + 3 + 4);
    });

    test("round-trips arbitrary bytes", () => {
      const key = b([0x00, 0xff, 0xfe, 0x80, 0x7f]);
      const value = b([0xde, 0xad, 0x00, 0xbe, 0xef]);
      const r = decode(encode(key, value, TS));
      expect(r.key).toEqual(key);
      expect(r.value).toEqual(value);
    });

    test("round-trips an empty value", () => {
      const r = decode(encode(b("k"), Buffer.alloc(0), TS));
      expect(r.value.length).toBe(0);
      expect(r.key).toEqual(b("k"));
    });

    test("round-trips a 64 KiB value", () => {
      const value = Buffer.alloc(65536, 0xab);
      const r = decode(encode(b("k"), value, TS));
      expect(r.value).toEqual(value);
    });

    test("round-trips a max-size key", () => {
      const key = Buffer.alloc(0xffff, 0x6b);
      const r = decode(encode(key, b("v"), TS));
      expect(r.key).toEqual(key);
    });

    test("round-trips a timestamp beyond 32 bits", () => {
      const far = 4_102_444_800_000; // year 2100
      expect(decode(encode(b("k"), b("v"), far)).timestamp).toBe(far);
    });
  });

  describe("checksum", () => {
    test("rejects a record whose value was altered", () => {
      const enc = encode(b("key"), b("value"), TS);
      enc[HEADER_SIZE + 3] ^= 0xff;
      expect(() => decode(enc)).toThrow(CorruptRecordError);
    });

    test("rejects a record whose key was altered", () => {
      const enc = encode(b("key"), b("value"), TS);
      enc[HEADER_SIZE] ^= 0xff;
      expect(() => decode(enc)).toThrow(CorruptRecordError);
    });

    test("rejects a record whose timestamp was altered", () => {
      const enc = encode(b("key"), b("value"), TS);
      enc[OFFSETS.TIMESTAMP] ^= 0xff;
      expect(() => decode(enc)).toThrow(CorruptRecordError);
    });

    test("rejects a record whose crc field was altered", () => {
      const enc = encode(b("key"), b("value"), TS);
      enc[OFFSETS.CRC] ^= 0xff;
      expect(() => decode(enc)).toThrow(CorruptRecordError);
    });

    test("detects a single flipped bit anywhere in the record", () => {
      const original = encode(b("key"), b("value"), TS);
      for (let i = 0; i < original.length; i++) {
        const copy = Buffer.from(original);
        copy[i] ^= 0x01;
        expect(() => decode(copy)).toThrow(BitcaskError);
      }
    });
  });

  describe("truncation", () => {
    test("rejects a buffer shorter than the header", () => {
      const enc = encode(b("key"), b("value"), TS);
      expect(() => decode(enc.subarray(0, HEADER_SIZE - 1))).toThrow(
        TruncatedRecordError,
      );
    });

    test("rejects an empty buffer", () => {
      expect(() => decode(Buffer.alloc(0))).toThrow(TruncatedRecordError);
    });

    test("rejects a record whose body was cut short", () => {
      const enc = encode(b("key"), b("value"), TS);
      expect(() => decode(enc.subarray(0, enc.length - 1))).toThrow(
        TruncatedRecordError,
      );
    });
  });

  describe("offsets", () => {
    test("reads a record that starts part-way into a buffer", () => {
      const first = encode(b("one"), b("1"), TS);
      const second = encode(b("two"), b("22"), TS);
      const log = Buffer.concat([first, second]);

      const r = decode(log, first.length);
      expect(r.key).toEqual(b("two"));
      expect(r.value).toEqual(b("22"));
    });

    test("walks a log of records using the reported length", () => {
      const inputs = [
        [b("a"), b("1")],
        [b("bb"), b("22")],
        [b("ccc"), Buffer.alloc(0)],
      ] as const;

      const log = Buffer.concat(inputs.map(([k, v]) => encode(k, v, TS)));

      const seen: Buffer[] = [];
      let offset = 0;
      while (offset < log.length) {
        const r = decode(log, offset);
        seen.push(r.key);
        offset += r.length;
      }

      expect(seen).toEqual(inputs.map(([k]) => k));
      expect(offset).toBe(log.length);
    });
  });

  describe("ownership of buffers", () => {
    test("does not alias the buffer it decoded from", () => {
      const enc = encode(b("key"), b("value"), TS);
      const r = decode(enc);
      enc.fill(0x58);
      expect(r.key).toEqual(b("key"));
      expect(r.value).toEqual(b("value"));
    });

    test("does not alias the caller's key and value", () => {
      const key = b("key");
      const value = b("value");
      const enc = encode(key, value, TS);
      key.fill(0x58);
      value.fill(0x58);
      const r = decode(enc);
      expect(r.key).toEqual(b("key"));
      expect(r.value).toEqual(b("value"));
    });
  });

  describe("validation", () => {
    test("rejects a key too large for the size field", () => {
      const key = Buffer.alloc(0x10000, 0x6b);
      expect(() => encode(key, b("v"), TS)).toThrow(InvalidArgumentError);
    });

    test("rejects a non-Buffer key or value", () => {
      const bad = "not a buffer" as unknown as Buffer;
      expect(() => encode(bad, b("v"), TS)).toThrow(InvalidArgumentError);
      expect(() => encode(b("k"), bad, TS)).toThrow(InvalidArgumentError);
    });
  });
});
