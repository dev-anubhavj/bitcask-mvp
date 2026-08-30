# Stage 0 — The API

**Goal:** make the store work using an in-memory `Map`. No log file, no keydir,
no disk access except creating the directory.

This stage settles the method signatures. Later stages change what happens
inside these six methods, but not the methods themselves.

**Done when:** `bun test stage00` passes all 28 tests.

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
the value is not a Buffer. Do this check before looking the key up, so a bad key
gives an argument error rather than a not-found error.

Use `Buffer.isBuffer(x)` for the type check. TypeScript types are removed before
the code runs, so a `key: Buffer` annotation does not stop anyone passing a
string at runtime.

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

Run `bun test stage00` after each step and watch the number of passing tests go up.

1. `open` and `close` — 3 tests pass. `open` is two lines: `await mkdir(dir, { recursive: true })` from `node:fs/promises`, then `return new Bitcask(dir, opts)`. `close` sets `#closed = true`.
2. `put` and `get` for keys that exist — this is where the Map key problem shows up.
3. Validation — 6 more tests.
4. `delete` and `keys` — 7 more tests.
5. The `binary safety` and `ownership of buffers` groups.

---

## Three things that will trip you up

**Map keys.** `map.get(aDifferentBufferWithTheSameBytes)` returns `undefined`,
because Map compares Buffers by identity, not by content. So the Map key has to
be a string. Which encoding you use to build that string matters: UTF-8 turns
different byte sequences into the same string. → TS notes §6, "Buffer to string"

**Copying Buffers.** `subarray()` does not copy. It returns a second Buffer
pointing at the same memory, so writing through one changes the other. Use
`Buffer.from(buf)` to get a real copy. → TS notes §6, "Slicing"

**Errors from async methods.** A `throw` inside an `async` method does not throw
where it is called. It returns a rejected promise, and the error surfaces at the
`await`. That is why the tests are written as
`await expect(db.get(k)).rejects.toThrow(...)`. → TS notes §5

---

**Next:** Stage 1 — the record format and CRC.
