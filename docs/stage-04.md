# Stage 4 — Tombstones and rollover

**Goal:** a delete is a write, and the log stops being one file.

**Done when:** `bun test stage04` passes all 36 tests, and `bun test` still
passes Stages 0 through 3 — all 99 of them, for 135 in total.

You edit `src/bitcask.ts` only.

---

## Why this stage

Read **[concepts.md](concepts.md) sections 4 and 5** first — 5 down to the line
about merge, which is Stage 5's job.

**Your `delete` is currently the one method that lies.** Everything else in the
store obeys one rule: the file is the truth, memory is a cache of where things
are in it. `delete` does not. It reaches into the index, removes an entry, and
touches nothing on disk — so the log still says the key is alive, and the next
`open` believes it. Stage 3's brief called this a data-correctness bug and it is
still there: tell the store to forget something, and it forgets only until you
restart.

The fix is the one the design forces. You cannot erase a record from a file you
only ever append to, so **you append the fact that it is dead**. That record is
a *tombstone*. Replay meets it after the record it kills and removes the key
instead of adding it, which is the same "later wins" rule you already built —
only now one of the things a record can say is "gone".

**And this is where the cost shows up.** Deleting keys makes the store *bigger*.
You added records; you removed nothing. Overwrites have been doing this since
Stage 2 and you have simply not been able to see it. One of this stage's jobs is
to make it visible — `stats()` exists so the garbage stops being theoretical.

**The second half is why the store is a directory.** Eventually something has to
reclaim that space, and the only cheap deletion a filesystem offers is
`unlink()` — a whole file at a time. There is no syscall for "remove the middle
of this file". So garbage has to be arranged into units that can be deleted
whole, which means the log has to become *many* files.

That gives the store the shape the paper describes: **one active file being
appended to, and behind it a set of frozen files that nobody will ever write to
again.** Immutability is what makes Stage 5's merge safe — it can read the old
files and build replacements while writes keep landing in the active one,
because nothing it is reading can change underneath it.

And `fileId`, which has sat in your keydir as a hardcoded `1` for two stages,
finally has a job.

---

## Two decisions worth making deliberately

**What a tombstone looks like on disk.** There is one hard constraint: replay
finds tombstones with `decode`, the same walk as everything else, so whatever
marks a record as dead has to survive a round trip through the record format you
already have. You are not changing the header — Stage 1's tests pin those 18
bytes, and adding a field would break every record written so far. Inside that
constraint the encoding is yours.

**How a read reaches a file that is not the active one.** Until now there was
one handle and every read used it. Now a record can be in any of the files, and
you have to decide how to get at it: hold a handle open for every file, open one
per read and close it, or keep a cache of the recently used. The trade is real
in both directions — file descriptors are a finite, fairly small OS resource, and
opening a file per read is a syscall you are paying on the hot path that Stage 2
spent a whole stage making a single seek. At this scale any of the three works.
Pick one on purpose, and remember `close()` now has more than one thing to
release.

---

## What this stage deliberately does not do

| Not yet | Stage | Why it can wait |
|---|---|---|
| Reclaiming any of the garbage | 5 | Tombstones and stale records pile up and nothing removes them. `stats()` measures the pile; merge is what shrinks it. |
| Discarding tombstones | 5 | A tombstone cannot be dropped while an older record for the same key still sits in an earlier file — drop it and the key comes back from the dead on the next replay. Merge is the only place that knows it is safe. |
| Hint files | 5 | Replay still reads every byte of every file, values included. |
| Corruption anywhere but the last file | — | A crash can only tear the tail of the file being written. Rot in a frozen file is a different problem and out of scope here. |

---

## Contract

| | Behaviour at this stage |
|---|---|
| **The directory** | `<n>.data`, ids counting from 1 and going up by one. Nothing re-uses an id. Files that are not data files are ignored, not deleted. |
| `open` | Rebuilds the keydir from every data file, in id order, oldest first. Later records win, exactly as within one file. The highest-numbered file becomes the active file and writing continues at its end. |
| `maxFileSize` | Once a store is opened with it, **no data file exceeds it** — except a file holding a single record that is itself bigger, because a record is never split across files. Left unset, the store stays in one file forever, which is Stages 0–3's behaviour and is what keeps their tests green. |
| `put` | Appends to the active file, rolling to a new one first if the record would not fit. |
| `delete` | Appends a tombstone, then drops the key. **A key that is not in the store is not tombstoned** — there is no live record to shadow, so the tombstone would be garbage the instant it was written. |
| `get` | Unchanged from the caller's side. It now has to read from whichever file the keydir names. |
| `close` | Releases every handle the store opened. |
| `stats()` | New. See below. |

### `stats()`

```ts
export interface Stats {
  /** Live keys -- what keys() would return. */
  keys: number;
  /** Data files in the directory. */
  files: number;
  /** Id of the file currently being appended to. */
  activeFileId: number;
  /** Total size of the records the keydir points at, headers included. */
  liveBytes: number;
  /** Total size of every data file on disk. */
  totalBytes: number;
}

async stats(): Promise<Stats>;
```

It throws `ClosedError` after `close()`, like everything else.

`totalBytes - liveBytes` is the garbage. That number is the whole argument for
Stage 5, and it is the only new thing in this interface that is not bookkeeping
you already have lying around.

Two things the tests lean on:

- **The tests never assume how you encoded a tombstone.** Every delete goes
  through `db.delete()`. What they do assume is that whatever you wrote is a
  record like any other: they walk each file end to end with `decode` and expect
  to land exactly on its size.
- **Stage 0's rule that a value is opaque bytes still holds.** Anything that
  goes in comes back out identical, including after a reopen.

---

## The mechanics you have not used yet

### Listing a directory

```ts
import { readdir } from "node:fs/promises";

const names = await readdir(dir);   // ["1.data", "2.data"] -- names, not paths
```

Names only, so `path.join(dir, name)` before you do anything with one.

To pick the data files out and get the number off the front:

```ts
/^\d+\.data$/.test(name)   // true for "12.data", false for "notes.txt"
parseInt("12.data", 10)    // 12 -- stops at the first character that is not a digit
`${id}.data`               // template literal: "12.data"
```

### Optional options with a default

```ts
this.#maxFileSize = opts.maxFileSize ?? Infinity;
```

`??` is *nullish coalescing*: it takes the right-hand side only when the left is
`null` or `undefined`. `||` would also take it for `0`, which is a different and
usually wrong thing. `Infinity` is a real `number` in JS and compares the way you
would hope, so it works as "no limit" without a separate flag.

Your constructor currently takes `_opts` and throws it away — the underscore is
just a naming convention that tells TypeScript you meant to ignore it. That has
to stop being true.

### Comparing buffer contents

```ts
a.equals(b)       // true if the bytes are the same
a === b           // true only if it is literally the same object
```

`===` on two Buffers holding identical bytes is `false`. This catches everyone
once.

### Holding several handles

```ts
#handles = new Map<number, FileHandle>();

for (const handle of this.#handles.values()) await handle.close();
```

A `Map` keyed by number is fine and does not have the string-coercion problem an
object literal would.

Reading a file you are not appending to wants `"r"`, not `"a+"` — read-only, and
it fails loudly if the file is missing rather than creating an empty one.

---

## Suggested order

1. **Tombstones, still in one file.** No `maxFileSize`, no second file. `delete`
   appends, and replay treats a tombstone as a removal instead of an insert.
   Turns on all ten of `a delete leaves a mark`.
   `bun test -t "a delete leaves a mark"`.
2. **`stats()`.** Mostly numbers you are already holding. Six of its eight tests
   pass without any rollover, and it is the instrument you will want for the
   rest of the stage — run it before and after a few deletes and look at the two
   byte counts.
3. **Rolling on the way in.** Honour `maxFileSize`, start `2.data`, keep the
   keydir's `fileId` honest, and teach `get` to read from a file that is not the
   active one. Turns on `rolling over`.
4. **Rolling on the way back.** `open` finds every file and replays them in
   order; the active file becomes the last one. Turns on `past the tenth file`,
   `reopening a rolled store`, `a torn tail, with files behind it`, and
   `the directory`.

Stages 0 to 3 stay green throughout, and they are a sharper safety net than
usual here: they all run with `maxFileSize` unset and they all hardcode
`1.data`. If one of them breaks, rollover is happening when nobody asked for it.

---

## Then run the bench

```bash
bun run bench/garbage.ts
```

It puts, overwrites and deletes through your store and prints `stats()` after
each phase. Watch `totalBytes` climb while `liveBytes` does not.

---

## Where you are after this

The store now has the shape the paper describes: one active file, a row of
frozen ones behind it, an index that spans all of them, and deletes that are
writes like everything else.

It also has a disease, and for the first time you can measure it. A store that
has been running for a while is mostly garbage — old versions of keys nobody
will read again, and tombstones for keys nobody will ask for. Stage 5 is the
cure, and it is the other stage that actually teaches the paper.

---

**Next:** Stage 5 — merge, and hint files.
