# Stage 2 — The log and the keydir

**Goal:** the file becomes the truth. Values live on disk; memory holds only
where to find them.

**Done when:** `bun test stage02` passes all 20 tests, and `bun test` still
passes Stages 0 and 1 — all 57 of them.

You edit `src/bitcask.ts` only. `record.ts` is finished and does not change.

---

## Why this stage

Read **[concepts.md](concepts.md) sections 2 and 3** first. This is the stage
those two sections are about, and it is the one that actually teaches the paper.

**Stage 0 was a lie you agreed to.** `Map<string, Buffer>` holds every value in
RAM and forgets all of it when the process exits. That was fine — it pinned the
API so the next six stages have something to keep working. Now the values move
to disk and the API stays exactly as it was. Stage 0's 28 tests must keep
passing while the entire storage layer changes underneath them. That is what
they were for.

**A log alone would be uselessly slow.** Appending is easy and fast: every
write goes to the end of one file, sequentially, at whatever speed the device
can take. But a log has no index. Finding a key means reading the file from byte
0, decoding every record, and remembering the last one that matched. Every read
costs the size of the database. `bench/scan-vs-keydir.ts` measures exactly this,
and you will run it at the end of the stage.

**So the reads get an index: the keydir.** An in-memory hash map from key to
*where that key's newest record is*:

```
keydir: key -> { fileId, valuePos, valueSize, timestamp }
```

Read that shape carefully, because it is the whole idea and it is easy to skim
past. **There is no value in it.** The map holds a location — a file, a byte
offset, a length. A read is one hash lookup to get those numbers, then one
positional read of exactly those bytes. One seek. Always one, regardless of
whether the store holds a thousand keys or a hundred million.

**That split is the trade the paper makes.** Keys and their bookkeeping — call
it 30-odd bytes each — stay in memory forever. Values, which are almost always
the bulk of the data, never occupy memory at all. You buy single-seek reads by
spending RAM on the index only. It is also the design's hard limit: the keyspace
must fit in memory, and when it does not, Bitcask is simply the wrong engine
(concepts.md §7).

**Writes update both halves.** A `put` appends a record to the file, and then
points the keydir at where that record landed. Both, every time, or the two
disagree and the store is wrong. Note the ordering question this raises: which
of the two happens first, and what is true if the process dies between them.
Stage 3 is where that gets interesting.

---

## What this stage deliberately does not do

Each of these is a later stage. Do not build them now, and do not let the
absence of them worry you.

| Not yet | Stage | Why it can wait |
|---|---|---|
| Rebuilding the keydir on `open` | 3 | Reopening a store still finds an empty index. Nothing in Stage 2's tests reopens anything. |
| Tombstones — `delete` writing a record | 4 | For now a delete only removes the key from the index. The old record stays in the file, unmarked. |
| More than one data file | 4 | One file, always `1.data`. `maxFileSize` stays ignored. |
| Reclaiming space | 5 | The file grows forever. One of the tests asserts that it does. |
| `fsync` policy | — | Cut from this project. See Stage 5's brief for where it would go. |

---

## Contract

The signatures do not change. The behaviour Stage 0 pinned does not change
either — same errors, same rules about buffer ownership, same `ClosedError`
after `close()`. What changes is where the bytes are.

| | Behaviour at this stage |
|---|---|
| **The data file** | `<dir>/1.data`. Exactly one, created by the store. |
| `put` | Appends one record — the bytes `encode` produces — to the end of the file, and records where it went. The bytes are on disk before the returned promise resolves. |
| `get` | Returns the value for the key, read out of the file. Nothing is served from a memory copy of the value. |
| `delete` | Removes the key from the index. The file is not touched. |
| `keys` | Every live key, from the index. |
| `close` | Everything written is complete on disk, and the file handle is released. |

Two invariants the tests lean on hard:

- **The file is append-only.** No byte that has been written is ever
  overwritten, moved, or removed. An overwrite of a key appends a second record;
  the first one stays exactly where it was.
- **The file is a clean sequence of records.** Start at 0, `decode`, add
  `length`, repeat — you land exactly on `file size` and never anywhere else. No
  padding, no gaps, no partial writes. `readLog` in the test file does precisely
  this, and it throws if a single byte is off.

Timestamps in the records come from the clock — `encode`'s default is fine.

---

## The mechanics you have not used yet

Design decisions are yours. The file API is not something to guess at, so here
it is.

### Opening a file

```ts
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

const fh: FileHandle = await open(path, "a+");
```

The second argument is the mode, and the choice matters:

| flag | means |
|---|---|
| `"r"` | read only; fails if the file does not exist |
| `"r+"` | read and write; fails if the file does not exist |
| `"w+"` | read and write; **truncates the file to nothing** if it exists |
| `"a"` | append only; creates the file if missing |
| `"a+"` | append and read; creates the file if missing |

`"w+"` is the one that will quietly destroy your data if you reach for it out of
habit.

### Writing

```ts
const { bytesWritten } = await fh.write(buf);                       // whole buffer
const { bytesWritten } = await fh.write(buf, 0, buf.length, pos);   // at a position
```

**With an append flag (`"a"`, `"a+"`), the `pos` argument is ignored.** The
operating system sends every write to the current end of the file, always. This
is a property of `O_APPEND`, not of Node, and it is not overridable — so if you
open in append mode, do not expect a position argument to do anything.

### Reading at a position

```ts
const buf = Buffer.alloc(n);
const { bytesRead } = await fh.read(buf, 0, n, position);
```

Arguments: the buffer to fill, where in *that buffer* to start putting bytes,
how many bytes to ask for, and where in *the file* to read from. It fills `buf`
in place and tells you how many bytes it actually got.

**A short read does not throw.** Ask for 200 bytes 10 bytes before the end of
the file and you get `bytesRead: 10`, no error. Ask for bytes past the end
entirely and you get `bytesRead: 0`, still no error. The rest of `buf` keeps
whatever it had — with `Buffer.alloc` that is zeros, which look exactly like
real data. Nothing tells you this happened except the number you were handed.

### Closing, and sizes

```ts
await fh.close();                   // flush and release the handle
const { size } = await fh.stat();   // bytes currently in the file
```

`Bun.file(path)` and `Bun.write()` also exist and are pleasant for
whole-file work, but there is no positional read on that API, which is the one
operation this stage is built around. Use a `FileHandle`.

### Holding a handle in the class

```ts
#fh: FileHandle | null = null;
```

`FileHandle` is a type, not a value, so import it with `import type`. A field
that is only set later has to admit it can be `null` — and TypeScript will then
make you check for `null` before every use, which is the point.

---

## Suggested order

1. **`open` and `close` first.** Get a handle onto `1.data` and give it back
   again. Nothing to test yet, but everything else needs it.
2. **`put` appends.** Turns on the whole `the data file` group — seven tests
   that read the file back with `decode` and check byte for byte what landed.
   Run `bun test -t "the data file"`.
3. **`get` reads from the file.** Now the keydir has to carry enough to find
   the bytes again. Turns on `reads come from the file` and
   `through the file, unchanged`.
4. **`delete` and `keys` over the index.** Small, once the index exists.
5. **`concurrent writes`** last. One test, and it will either pass immediately
   or tell you something interesting about how you chose to track the end of the
   file.

Stage 0's tests are your safety net the whole way. If one of them breaks you
have changed behaviour, not just implementation.

---

## Then run the bench

```bash
bun run bench/scan-vs-keydir.ts
```

It builds stores of 1,000 to 50,000 keys using your `put`, then times your
`get` against a scan-the-whole-file `get` over the same data. Watch which
column stays flat.

That is the argument for the keydir, measured on your own code. It is worth
sitting with the numbers for a minute before moving on.

---

**Next:** Stage 3 — replay on `open`, and surviving a torn write.
