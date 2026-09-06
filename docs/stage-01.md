# Stage 1 — The record

**Goal:** turn one key/value pair into a block of bytes, and turn it back.

No files yet. This stage is a pure function in, a pure function out. Stage 2
takes what you build here and starts appending it to disk.

**Done when:** `bun test stage01` passes all 29 tests, and `bun test` still
passes Stage 0's 28.

You edit `src/record.ts` only.

---

## Why this stage

Read **[concepts.md](concepts.md) sections 2 and 6** first.

**The record is the unit of the log.** A Bitcask data file is nothing but
records laid end to end, in the order they were written. There is no index in
the file, no header, no page table, no footer. Just records. So the record has
to carry everything needed to make sense of it.

**It has to say how long it is.** When you read a data file you start at byte 0
and walk forward, and to find where record 2 begins you must know where record 1
ends. You cannot use a separator byte — values are arbitrary binary, so any byte
you picked as a separator could appear inside a value and split it in half.
There is no byte that is safe. The only correct approach is **length-prefixing**:
write the sizes into the header, before the data they describe, so a reader
always knows how far to go before it reads anything variable.

That is why `keySize` and `valueSize` sit in the header rather than being
implied. It is what makes the log walkable.

**It has to verify itself.** A crash can leave a half-written record at the end
of a file. On restart you replay the log, and you need to tell "this record is
real" from "this is the wreckage of a write that never finished." Nothing
outside the record can tell you — there is no separate manifest of what got
written. So the record carries a **CRC**, a checksum of its own bytes. If the
checksum matches, the record was written completely. If it does not, you have
found the end of the good data.

That is the whole crash-recovery story, and Stage 3 is just applying it in a
loop. It only works because the checksum is *inside* the thing it protects.

**It has to carry a timestamp.** Two data files can both hold a record for the
same key. When the keydir is rebuilt at startup, or when merge decides which
copy of a key survives, something has to say which one is newer. File ordering
mostly answers this, but the timestamp makes each record independently
self-dating, which merge relies on.

---

## The format

All integers little-endian.

```
offset  size  field       covered by crc?
0       4     crc         no  -- it is the crc
4       8     timestamp   yes
12      2     keySize     yes
14      4     valueSize   yes
18      ks    key         yes
18+ks   vs    value       yes
```

`HEADER_SIZE` is 18. Total record size is `18 + keySize + valueSize`.

**Use `crc32` from `node:zlib`.** Computing CRC32 by hand is polynomial
arithmetic, not storage engineering, and every real implementation calls a
library. The test pins your checksum to `crc32(record.subarray(4))`, so the
algorithm and the covered range are both fixed.

---

## Contract

```ts
encode(key: Buffer, value: Buffer, timestamp = Date.now()): Buffer

decode(buf: Buffer, offset = 0): {
  key: Buffer
  value: Buffer
  timestamp: number   // milliseconds since the epoch
  length: number      // total bytes this record occupied
}
```

| | Behaviour |
|---|---|
| `encode` | Returns one complete record. Throws `InvalidArgumentError` if key or value is not a Buffer, or if either is too large for its size field. |
| `decode` | Reads the record starting at `offset`. Throws `TruncatedRecordError` if the buffer ends before the record does, `CorruptRecordError` if the checksum does not match. |
| `length` | Lets a caller walk a log: `offset += r.length` lands on the next record. |

**What `buf` is.** Any slice of a data file: it may hold part of a record,
exactly one, or many. `decode` reads the single record beginning at `offset` and
ignores everything else. Two things follow, and they are the easiest mistakes to
make in this stage:

- **The record ends where its header says it ends** -- at
  `offset + HEADER_SIZE + keySize + valueSize`. Not at `buf.length`. The buffer
  may well continue for another megabyte.
- **`buf.length` answers exactly one question:** is there enough room left from
  `offset` for the record the header claims? Available space is
  `buf.length - offset`, never `buf.length`.

This is why the log-walking test exists. In Stage 3 you will read a data file and
walk it record by record, and `decode` cannot require a buffer holding exactly
one record -- knowing where a record ends is the thing decoding tells you.

Neither function may alias its input. `decode`'s output must survive the source
buffer being overwritten, and `encode`'s output must survive the caller mutating
the key or value it passed in.

---

## Why the format looks like this

**The crc goes first.** You have to read the checksum before you can check
anything, so it needs to be at a position you know without parsing. Byte 0 is
the only such position. Everything after it is what it covers.

**Sizes come before the data.** A reader must know how many bytes to take
before it takes them. Length first, payload second — the same reason every
network protocol does it.

**2 bytes for the key, 4 for the value.** Keys live in RAM forever
(`concepts.md` §7), so they are meant to be small — 65535 bytes is already
generous. Values only touch disk, so they get a wider field. This asymmetry is
where `LIMITS.MAX_KEY_SIZE` and `LIMITS.MAX_VALUE_SIZE` in `bitcask.ts` came
from: those constants were never arbitrary, they are what these two fields can
hold.

**8 bytes for the timestamp.** Milliseconds since 1970 passed 2^32 in 1970 plus
49 days, so 4 bytes is nowhere near enough. 8 bytes lasts longer than the
species.

**Little-endian.** x86 and ARM are little-endian, so this is the machine's
native order and needs no conversion. The choice is arbitrary — what matters is
that encode and decode agree, forever, because these bytes end up in files that
outlive the process.

---

## Suggested order

1. `encode`, then check the `layout` group — it asserts each field lands at the
   right offset, so it will tell you exactly which part is wrong.
2. `decode` for the happy path, which turns on the whole `round trip` group.
3. The checksum failures.
4. Truncation.
5. `offset`, `length`, and the ownership tests.

Run `bun test stage01` while you work, or `bun test -t "layout"` for one group.

---

## TypeScript you have not used yet

Reading and writing fixed-width integers in a Buffer:

```ts
buf.writeUInt16LE(value, offset)     buf.readUInt16LE(offset)
buf.writeUInt32LE(value, offset)     buf.readUInt32LE(offset)
buf.writeBigUInt64LE(value, offset)  buf.readBigUInt64LE(offset)
```

The 64-bit pair is the awkward one: it works in `BigInt`, not `number`. A
`BigInt` is a separate numeric type written `123n`, and it does not mix with
ordinary numbers in arithmetic. Convert with `BigInt(n)` going in and `Number(x)`
coming out. This is safe for timestamps — `Number` holds integers exactly up to
2^53, and milliseconds will not reach that for 285,000 years.

Also useful: `Buffer.alloc(size)` for a zeroed buffer, `Buffer.concat([...])` to
join, and `buf.copy(target, targetStart)` to write one buffer into another.
`docs/typescript-notes.md` §6 has the rest.

---

**Next:** Stage 2 — the append-only log and the keydir.
