# Stage 3 — Replay, and surviving a torn write

**Goal:** `open` rebuilds the keydir by reading the log, and a crash mid-append
costs you the unfinished record and nothing else.

**Done when:** `bun test stage03` passes all 22 tests, and `bun test` still
passes Stages 0 through 2 — all 77 of them.

You edit `src/bitcask.ts` only.

---

## Why this stage

Read **[concepts.md](concepts.md) section 6** first.

**Stage 2 made the data durable and left it unreachable.** The bytes are in
`1.data` and they outlive the process. But reopen the store and the keydir is
empty, so every key is gone as far as anyone can tell. A perfect copy of your
data that nothing can find is not durability. This stage closes that gap, and it
is the last piece of a working store.

**The keydir is derived state.** This is the sentence to hold on to. The log is
the truth; the index is a cache of where things are in it, and it can always be
thrown away and rebuilt by reading the log from the start. Nothing in the keydir
is information the file does not already contain — which is exactly why it can
live in RAM and vanish on exit without costing you anything but startup time.

That property is what makes the rest of the design possible. Merge can move
records between files in Stage 5 and just repoint the index. A crash can lose
the whole index and lose nothing.

**Replay is the same walk the tests have been doing all along.** Start at byte
0, `decode`, act on the record, add `length`, repeat. Later records overwrite
earlier ones in the index, so when the walk finishes, each key maps to its newest
record. `length` has been earning its place since Stage 1 for precisely this.

**And then there is the tail.** The store appends. If the process dies halfway
through a write, the file ends with a partial record — a header claiming a
length the file does not have, or a complete-looking record whose bytes are
half-written. Nothing outside the record can tell you which records were
finished, because there is no manifest, no commit log, nothing but the records
themselves.

So the record tells you. The CRC you built in Stage 1 has been waiting three
stages for this job: **a record that verifies was written completely, and the
first one that does not is where the good data ends.** That is the entire crash
recovery story. No journal, no two-phase anything, no repair tool.

---

## Two decisions worth making deliberately

**Stop, or skip?** You hit a bad record with three more after it that happen to
verify. Do you keep those?

No — and the reason is worth internalising. A "valid" record after a bad one is
not evidence of anything. If a length field got mangled, the walk is now landing
at arbitrary byte positions, and a CRC matching by chance at a wrong offset is
possible. More importantly, the writes after a crash point were never
acknowledged to anybody, so nothing is owed to them. **Replay stops at the first
record that fails.** Everything after it is wreckage, whatever it looks like.

**Stop, or truncate?** Having found where the good data ends, do you leave the
bad bytes in the file and just start appending after them?

You cannot. The next append would land after the garbage, and the log would no
longer be a clean sequence of records — the next replay would hit the same bad
bytes and stop there, losing everything written since. **The file gets cut back
to the end of the last good record.** Recovery is a truncate, which is also
convenient: the cheapest repair a filesystem offers.

---

## What this stage deliberately does not do

| Not yet | Stage | Why it can wait |
|---|---|---|
| Deletes surviving a reopen | 4 | `delete` still only drops the key from the index. The record stays in the file with nothing marking it dead, so replay brings the key back. Tombstones fix this, and Stage 3's tests never delete. |
| More than one data file | 4 | Still `1.data`, always. Replay walks one file. |
| Hint files | 5 | Replay reads every byte of every value it does not need. That is the problem hint files exist to solve. |

**The delete gap is real, and it is worth sitting with for a second.** Right now
a store can be told to forget a key, agree, and then remember it again after a
restart. That is a data-correctness bug, not a missing feature — and it exists
because deletes are the one operation that does not append. Stage 4 fixes it by
making them append too.

---

## Contract

| | Behaviour at this stage |
|---|---|
| `open` | Reads `1.data` and rebuilds the keydir from it. For each key, the **last** record in the file wins. Never throws because of damaged data. |
| | Stops at the first record that fails to decode, and truncates the file to the end of the last good record. |
| | The store is immediately writable: the next `put` appends at the recovered end. |
| everything else | Unchanged from Stage 2. |

Three properties the tests check hard:

- **Last in the file wins, not the newest timestamp.** One test writes two
  records for the same key with the timestamps deliberately inverted, and expects
  file order to decide. Position in the log is the authority; the timestamp is
  bookkeeping for Stage 5.
- **`open` never throws over corruption.** Garbage tail, garbage middle, a file
  that is nothing but garbage, a zero-byte file — all of these open. A store that
  refuses to start because of a crash is a store you cannot recover.
- **The file is walkable afterwards.** `readLog` in the test file walks the data
  file after recovery and expects to land exactly on the end.

---

## The mechanics you have not used yet

### Cutting a file back

```ts
await truncate(path, size);           // from "node:fs/promises"
await fh.truncate(size);              // on an open handle
```

Both discard everything past `size`. Growing a file this way is also legal and
fills with zeros, which is not what you want here.

**The handle form does not work on Windows if the handle was opened for
appending.** `ftruncate` on an `O_APPEND` descriptor fails with `EPERM` there,
though it is fine on Linux. The path form works regardless, including while you
still hold the handle open. Use the path form.

Both return promises. An un-awaited one fails silently -- the rejection goes
nowhere and the file simply does not change.

### Reading the file to walk it

```ts
const buf = await readFile(path);     // "node:fs/promises"
const buf = await fh.readFile();      // on the handle you already have
```

**One honest limitation:** this pulls the entire file into memory. Fine for this
project, wrong for a real one — a 10 GB data file is not a 10 GB `Buffer`. Real
implementations stream the log in fixed-size chunks and deal with records that
straddle a chunk boundary, which is fiddly and teaches nothing new. Read it whole
and know that you are taking the shortcut.

### Telling the failures apart

```ts
import { CorruptRecordError, TruncatedRecordError } from "./errors.ts";

try {
  ...
} catch (e) {
  if (e instanceof CorruptRecordError) { ... }
}
```

`catch (e)` types `e` as `unknown`, so TypeScript will not let you touch
`e.message` until you have narrowed it. `instanceof` is the narrowing — and both
of these extend `BitcaskError`, so one check catches the pair if you do not care
which happened.

Whether you need to distinguish them is a design question. Both mean the same
thing here.

### Where replay has to happen

`open()` is `static async`, and the constructor is not async — which is why the
handle is already built before `new Bitcask(...)` runs. Replay has the same
constraint. Whether you walk the log in the static method and hand the finished
keydir to the constructor, or give the instance a private method it awaits after
construction, is your call; both are ordinary shapes.

---

## Suggested order

1. **Replay the happy path.** Walk a clean file, fill the keydir, set the write
   offset to the file's size. Turns on `reopening a store` and
   `the newest record wins` — nine tests, no error handling yet.
   `bun test -t "reopening a store"`.
2. **Catch the failure and stop.** Turns on most of `a torn tail`.
3. **Truncate.** Two tests check the file's size afterwards, and
   `damage before the end` checks the file is still walkable.
4. **`writing after recovery`** last. If the write offset came from the file's
   size rather than from where replay actually stopped, this is the group that
   notices.

Stages 0 to 2 stay green throughout. Stage 2's tests never reopen a store, so
replay should not be able to affect them — if one breaks, you have changed
something other than `open`.

---

## Where you are after this

A durable key-value store: writes survive the process, a crash costs at most the
last unfinished write, and startup rebuilds everything from the log. That is the
end of day one, and the end of the parts that are strictly necessary.

Everything after this is about the store not falling over as it grows — deletes
that actually delete, more than one file, and reclaiming the space that
append-only keeps spending.

---

**Next:** Stage 4 — tombstones and rollover.
