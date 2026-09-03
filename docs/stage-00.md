# Stage 0 — The API

**Goal:** make the store work in memory. No log file, no keydir, no disk access
except creating the directory.

This stage settles the method signatures. Later stages change what happens
inside these six methods, but not the methods themselves.

**Done when:** `bun test` passes all 28 tests.

You edit `src/bitcask.ts` only. The tests and `src/errors.ts` stay as they are.

---

## Why this stage

Read **[concepts.md](concepts.md) section 4** first. Short version:

**A Bitcask store is a directory, not a file.** Writes only ever append, so the
log grows forever and garbage has to be reclaimed. But you cannot delete the
middle of a file — the only cheap deletion a filesystem offers is `unlink()`,
which removes a whole file. So the log gets split across many files: one active
file taking appends, and a pile of frozen ones that compaction can rewrite and
delete. Plus hint files and a lock file, which also need somewhere to live. The
directory is the database. That is what `open(dir)` is creating.

**`close()` is where a database becomes durable.** From Stage 2 there are open
file descriptors and buffered writes behind them; closing flushes what is
pending and releases the handles. It also marks the store dead: once closed, the
descriptors are invalid, so calling `get` would fail somewhere deep in the OS
with a confusing error. Reporting `ClosedError` instead turns a mystery into a
sentence. And it has to survive being called twice, because close lives in
cleanup paths — `finally` blocks, signal handlers, test teardown — that can
plausibly run more than once. A double cleanup should not become a crash.

None of that is true yet in Stage 0. There is nothing to flush and no handle to
release. What you are building now is the *state transition*, so that when
Stage 2 gives it teeth, every method is already checking.

**Why bother with a Map stage at all?** Because these six signatures do not
move again. Stages 1-6 replace everything underneath them — record encoding,
an append-only log, an in-memory index, crash recovery, compaction — and no
caller ever changes. Getting the contract right now means the later stages are
about storage engineering rather than refactoring.

---

## Contract

| Method | Behaviour |
|---|---|
| `open(dir)` | Creates `dir` and any missing parent directories. Returns a usable store. |
| `put(k, v)` | Stores `v` under `k`, replacing any existing value. Must copy `v`: if the caller changes their Buffer afterwards, the stored value stays the same. |
| `get(k)` | Returns the value, or throws `KeyNotFoundError`. Must return a copy: if the caller changes the returned Buffer, the stored value stays the same. |
| `delete(k)` | Removes the key. Deleting a key that is not there does nothing and is not an error. |
| `keys()` | Returns every key as `Buffer[]`, in any order. Deleted keys are not included. |
| `close()` | Can be called more than once. Every other method throws `ClosedError` afterwards. |

**Validation** on `get`, `put` and `delete`. Throw `InvalidArgumentError` if the
key is not a Buffer, is empty, or is longer than `LIMITS.MAX_KEY_SIZE`, or if
the value is not a Buffer.

TypeScript types are removed before the code runs, so a `key: Buffer`
annotation does not stop anyone passing a string at runtime. `Buffer.isBuffer(x)`
checks at runtime.

---

## Why the API looks like this

**Every method is async even though nothing here waits on anything.** From
Stage 2 onward all of them read or write files. Making them async now means the
code that calls them does not have to change later.

**`LIMITS` comes from the file format, not from this stage.** In Stage 1 the key
length is written into a 2-byte field and the value length into a 4-byte field.
65535 and 4294967295 are the largest numbers those fields can hold.

**Values are copied on the way in and on the way out.** Here you have to do that
by hand. From Stage 2 the value lives in a file, so `get` allocates a new Buffer
anyway and the copy is free.

**An empty value is a real value and is different from a missing key.** This
matters in Stage 4, where a deleted key is recorded as a special record rather
than by removing anything.

---

## Suggested order

Run `bun test` after each step and watch the number of passing tests go up.

1. `open` and `close` — until `open` works, every test fails on the same line
   and you cannot see anything else.
2. `put` and `get` for keys that exist.
3. Validation.
4. `delete` and `keys`.
5. The `binary safety` and `ownership of buffers` groups.

Steps 2 and 5 are the ones with something to learn in them. If a test in those
groups fails and the reason is not obvious, that is the point of the test — sit
with it before asking.

---

**Next:** Stage 1 — the record format and CRC.
