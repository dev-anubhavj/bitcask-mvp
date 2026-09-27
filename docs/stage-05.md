# Stage 5 — Merge and hint files

**Goal:** get the garbage back, and stop reading every byte on startup.

**Done when:** `bun test stage05` passes all 32 tests, and `bun test` still
passes Stages 0 through 4 — all 135 of them, for 167 in total.

You edit `src/bitcask.ts` only.

---

## Why this stage

Read **[concepts.md](concepts.md) section 5** first, all of it this time.

Stage 4 gave you the measurement and the bench made it concrete: empty the
store and it is the biggest it has ever been, 100% garbage. Nothing you have
written so far can ever give a byte back, because the only cheap deletion a
filesystem offers is `unlink()` and every file you have still holds at least one
record somebody wants.

Merge is the job that fixes that. It reads the frozen files, keeps the records
the keydir still points at, writes them somewhere new, and unlinks the
originals. A million overwrites of one key come out the other side as one
record. Nothing about the read path changes — the keydir still names a file and
an offset, it just names different ones afterwards.

The second half is hint files, and they exist because of a number you have not
measured yet. Every `open` so far reads every byte of every data file, values
included, to rebuild an index that contains no values at all. On a store with
200-byte values that is roughly 90% waste; on a store with 1 MB values it is
99.99%. A hint file is the same information with the values left out, written
next to the data file it describes, so a restart reads a few percent of the
bytes instead of all of them. This is the difference between a store that
restarts in seconds and one that restarts in minutes, and it is why merge writes
one for every file it produces.

These two are one stage because merge is what makes a file frozen forever, and a
hint file is only safe for a file nobody will append to again.

---

## What merge does

Four steps, in an order that matters:

1. Read the frozen files, oldest first.
2. For each record, ask the keydir whether this is still the record it points
   at. Most will not be — they are old versions, or tombstones, or keys that
   have since been deleted.
3. Write the survivors into new files, and a hint file beside each one.
4. Repoint the keydir at the new locations, then unlink the old files.

The active file is not in that list. Merge never reads it and never rewrites it:
it is the one file still being appended to, so its contents are not settled and
its hint file would be stale the moment it was written. That also means a store
opened without `maxFileSize` has nothing to merge at all, since everything is in
the active file — which is the real reason rollover came first.

---

## Contract

| | Behaviour at this stage |
|---|---|
| `merge()` | New. `async merge(): Promise<void>`. Rewrites **every** frozen data file in the directory in one pass. Throws `ClosedError` after `close()`, like everything else. Safe to call on an empty store, on a store with nothing frozen, and twice in a row. |
| What survives | Exactly the records the keydir points at. No stale versions, no tombstones, no duplicates. Keys and values come out byte for byte identical, and a key's `timestamp` does not change. |
| The active file | Untouched, byte for byte, and it keeps its id. Records living in it are not merged and must not be lost from the keydir either. |
| Merge's output | New data files that obey `maxFileSize`, same as `put` does. A file with no survivors in it leaves no output file behind — merge does not create empty files. Whatever intermediate files you use, clean them up, and do not name them so that the store mistakes them for data files. |
| After a merge | Reads work immediately, with no reopen: the keydir points at the new files. Writes continue into the active file as though nothing happened. A reopen returns exactly the same keys and values it would have returned before the merge. |
| `<n>.hint` | New. One beside every data file merge produces, holding enough to rebuild that file's keydir entries without reading a single value. The format is yours. The file being appended to has no hint. |
| `open` | For each frozen data file, rebuilds from its hint when there is one and scans the data file when there is not. A hint file that does not read cleanly — junk, short, torn — is ignored **in full**, and that file is scanned instead. The active file is always scanned, so Stage 3's torn-tail recovery still happens. |
| `stats()` | Unchanged, and it is how you watch merge work. `totalBytes - liveBytes` is the garbage, and after a merge of a fully frozen store it should be nearly nothing. |
| Old files | Gone when merge finishes: the data files and their hint files. A `<n>.hint` with no `<n>.data` next to it is a bug. |

---

## Four decisions worth making deliberately

**What makes a record a survivor.** The keydir is the only authority — but "this
key is in the keydir" and "this *record* is the one the keydir points at" are
different questions, and only one of them is right. Work out which before you
write the loop, because the wrong one is a merge that quietly keeps two copies
of everything.

**What ids the new files get.** File ids are not just names; replay order comes
from them, and a reopened store resolves two records for the same key by which
file they are in. Merge is about to add files to a directory that already has
rules about that. Decide what your new files are called and then check what a
reopen does with them — and what the next rollover does, since it is going to
pick a name too.

**The order of write, repoint and unlink, and what a crash in the middle
costs.** You are about to have two copies of the same data on disk for a moment,
and then one. Every arrangement of those steps loses something different if the
process dies halfway; pick the one where the worst case is wasted space rather
than lost records. Stage 6 is where you would actually test this, but the
ordering is decided here.

**What a hint file looks like on disk.** The constraints: you have to be able to
walk it without knowing how many entries it has, it has to survive a key made of
arbitrary bytes (newlines, commas, zeroes, `0xff`), and you have to be able to
tell a real one from a file full of junk or a real one that got cut in half —
because when you cannot, the answer is to ignore it and read the data file. You
have already written something that solves most of that once.

---

## What this stage deliberately does not do

| Not yet | Why it can wait |
|---|---|
| Deciding *when* to merge | Real Bitcask has a merge policy — thresholds on garbage ratio, dead bytes, file count, and a trigger that runs it in the background. `merge()` is something you call. The policy is a tuning problem, not a design one. |
| Merging while another process writes | Single process, single thread, and `merge()` is awaited. The design is what makes concurrency possible (merge reads frozen files, writes touch the active one, so they never contend), but nothing here proves it. |
| `fsync` | Every write in this project is at the mercy of the OS page cache. `FileHandle.sync()` is where durability would come from, and a real engine makes it a policy: sync every write, sync every N, sync on a timer. It belongs with Stage 6's crash harness, because without a way to kill the process there is nothing to prove. |
| A lock file | Nothing stops two processes opening the same directory and both appending to the active file. Riak keeps a `bitcask.write.lock` naming the process that owns writes. |
| Corruption in the middle of a frozen file | Stage 4 left this skipping the rest of the file. Merge reads those files now, so it meets the same problem — reading what it can and dropping the rest is fine here. Deciding what *should* happen is a real engine's problem and a bigger conversation than this stage. |

---

## The mechanics you have not used yet

### Removing and renaming files

```ts
import { unlink, rename } from "node:fs/promises";

await unlink(join(dir, "3.data"));            // throws if it is not there
await rename(tmpPath, join(dir, "3.data"));   // atomic on the same filesystem
```

`rename` replacing an existing file works on both POSIX and Windows. `unlink`
on a file you still hold an open handle to also works on both, including
Windows — I checked, because Windows historically did not allow it. The name
disappears from the directory immediately and reads through the old handle keep
returning the old contents, which is a good reason to close a handle you are
about to unlink rather than rely on that.

### Turning a missing file into a value instead of a throw

```ts
const bytes = await readFile(hintPath).catch(() => null);
if (bytes === null) { /* no hint, scan the data file */ }
```

`.catch()` on a promise hands back whatever the callback returns, so the
`await` produces `null` instead of throwing. `try/catch` around the `await` does
the same thing in more lines. Either is fine; what you should not do is check
whether the file exists first and then read it, because that is two syscalls and
a race.

### Writing a file in one go

```ts
import { writeFile } from "node:fs/promises";

await writeFile(path, Buffer.concat(chunks));   // creates or truncates
```

`Buffer.concat` takes an array of Buffers and copies them into one. Collecting
chunks in an array and concatenating at the end is usually faster than
repeatedly allocating a bigger Buffer, and much simpler than tracking offsets
into one you sized up front.

For the data files, `open(path, "w")` gives you a handle to a new empty file
(`"w"` truncates, `"a"` appends, `"r"` reads — you have used the last two).

### A number that is never exceeded

```ts
this.#maxFileSize = opts.maxFileSize ?? Infinity;
```

Worth doing now if you have not. `Infinity` is an ordinary `number` in
JavaScript and every comparison against it behaves, so "no limit" needs no
special case. Merge has to honour the threshold too, and `x > undefined` being
`false` is not a thing to lean on in two places.

### Slicing a record back out of a buffer

```ts
const raw = bytes.subarray(offset, offset + record.length);
```

`subarray` is a view — no copy, no allocation, and it shares memory with
`bytes`. That is exactly what you want for handing bytes straight to `write`,
and exactly what you do not want if you are going to keep it after `bytes` goes
away. `Buffer.from(view)` copies.

---

## Suggested order

1. **Merge, ignoring hints entirely.** Find the frozen files, walk them, keep
   the survivors, write them out, repoint the keydir, unlink the old files. Get
   `merge reclaims the garbage`, `what merge leaves alone`, `merge and the order
   of the log`, `merge and tombstones` and `merge is repeatable` green — 23 of
   the 32 tests. This is the part that teaches the paper; do not rush it.
   `bun test -t "merge reclaims"` and so on.
2. **Write hint files.** Merge emits one beside each file it produces. Nothing
   reads them yet, which turns on the first three of the hint tests.
3. **Read hint files in `open`.** Frozen file with a readable hint, use it;
   otherwise scan. Turns on the rest.
4. **Then break them on purpose.** Delete a hint, fill one with junk, cut one in
   half. All three have to leave the store correct, which is the difference
   between a hint file as a cache and a hint file as a second source of truth.

Stages 0 to 4 are your safety net again, and a sharp one: Stage 4's last test
puts a junk `1.hint` in the directory and expects the store to open anyway.

---

## Then run the bench

```bash
bun run bench/merge.ts
```

It builds a store with a realistic amount of garbage in it, then prints three
things: how much of the disk was garbage before and after a merge, and how long
`open` takes in three situations — scanning the unmerged store, reading hints,
and scanning the merged store with the hints deleted. The last two are the same
bytes of data, so the gap between them is the hint files and nothing else.

---

## Where you are after this

The store is now the engine the paper describes, all of it: appends at device
speed, one seek per read, a delete that is a write, a log that is a directory of
immutable files, a compactor that gives the space back, and a restart that reads
the index instead of the data.

What is left is not design, it is proof. Stage 6 kills the process mid-write in
a loop and checks that no acknowledged write was ever lost — which is where
`fsync` stops being a footnote.

---

**Next:** Stage 6 — proving crash safety, optional.
