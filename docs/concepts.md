# Bitcask: the concepts

Read the section for a stage before you start it. This file is about *why*
Bitcask is shaped the way it is. The stage briefs are about *what* to build.

---

## 1. The problem

A key-value store has to answer two questions fast: "store this" and "give me
that back." The obvious design is a hash table written to disk — but a hash
table updates entries in place, and updating in place means **random writes**.

Random writes are the slowest thing a storage device does. On a spinning disk
the head physically moves: a seek costs around 10 ms, so a few hundred random
writes per second is the ceiling. Sequential writes have no seek at all and run
in the hundreds of MB/s. Even on an SSD, where nothing moves, the gap is real —
flash erases in large blocks, so a small write into the middle of a file makes
the drive read, modify and rewrite a whole block behind your back.

B-trees, which most databases use, pay this cost. They keep data sorted and
update pages in place, which buys range scans and bounded memory use, at the
price of random I/O and a lot of machinery to keep the tree balanced.

Bitcask makes the opposite trade.

---

## 2. The one rule: only ever append

**Records are never modified in place. Every write goes to the end of a file.**

- Store a key: append a record.
- Update the key: append *another* record. The old one stays where it is.
- Delete the key: append a record that means "deleted."

The newest record for a key is the truth. Everything older is history.

Three things fall out of this immediately.

**Writes are fast and stay fast.** Every write is sequential, whether you have
a thousand keys or a billion. There is no tree to rebalance and no page to
locate — the write position is always "the end."

**A crash can only damage the tail.** You are never part-way through rewriting
existing data, because you never rewrite existing data. If the machine dies
mid-write, the only thing that can be broken is the last record. Everything
before it is untouched and still correct.

**The file grows forever.** Overwrite one key a million times and you have a
million records, 999,999 of them garbage. This is the bill for the other two,
and sections 4 and 5 are about paying it.

*Stage 1 builds the record. Stage 2 builds the append.*

---

## 3. Reads, and why an index is not optional

Appending is easy. Reading is where the design almost falls apart.

If all you have is a log, finding a key means scanning the whole file from the
start, remembering the last record you saw for that key. That is O(size of
database) per read. For a 10 GB store, every single `get` reads 10 GB.

So Bitcask keeps an index in memory, called the **keydir**: a hash map from a
key to the location of that key's newest record.

```
keydir: key -> { fileId, valueSize, valuePos, timestamp }
```

A read becomes:

1. One hash lookup in memory. You now know which file, which byte offset, and
   how many bytes.
2. One positional read of exactly those bytes.

**One seek. Always one.** Not one on average, not one if the cache is warm. The
keydir is complete — every live key is in it — so the read path never searches,
never walks a tree, never touches a byte it does not need.

That is the whole trick of the paper: put the *index* in RAM and leave the
*data* on disk. The index is small (a key plus about 30 bytes of bookkeeping).
The values, which are usually the bulk, never occupy memory at all.

*Stage 2 builds the keydir.*

---

## 4. Why the store is a directory

The log has to be split across many files, and garbage collection is what
forces it.

You cannot delete the middle of a file. No filesystem lets you say "remove
bytes 4096 to 8192 and shift the rest down" — and if it did, the shift would
mean rewriting everything after the hole anyway. The only deletion that is
genuinely cheap is `unlink()`: remove an entire file, instantly, whatever its
size.

So for garbage to be removable, garbage has to be **whole files**.

```
mystore/
├── 1.data      full, immutable, never written again
├── 2.data      full, immutable
├── 3.data      the ACTIVE file - appends land here
└── 3.hint      the index for 3.data, without the values
```

When the active file passes a size threshold it is closed and a new one is
opened. A closed file is frozen forever.

Splitting the log this way pays for itself several times over:

- **Compaction becomes possible at all.** You can rewrite old files and unlink
  the originals (section 5).
- **Concurrency is free.** Compaction only touches frozen files; writes only
  touch the active file. They never contend, so nothing needs locking between
  them.
- **Ordering comes from the filenames.** File IDs increase over time, so when
  the same key appears in file 2 and file 7, file 7 is newer. Sorting the
  directory listing gives you replay order on startup.
- **There is somewhere to put non-data files.** Hint files, and a lock file
  that stops two processes appending to the same active file.

The directory is the database, the way `.git/` is a repository. That is why
`open()` takes a directory and creates it.

*Stage 4 builds rollover.*

---

## 5. Deletes, garbage and merge

**A delete is an append.** You cannot erase a record from a file you only ever
append to, so a delete writes a **tombstone**: a record marking the key dead. A
later read finds the tombstone as the newest record for that key and reports it
missing.

This has the consequence that surprises people. **Deleting keys makes the store
bigger.** You added records. You removed nothing.

The tombstone cannot be discarded casually either. Drop it while an older
record for the same key still sits in an earlier file, and the next restart
replays that old record — the key comes back from the dead.

Reclaiming space is a separate, periodic job: **merge**, also called
compaction.

1. Read the frozen data files.
2. For each record, ask the keydir whether it is still the newest one for its
   key. Most are not.
3. Write only the survivors into a fresh file.
4. Point the keydir at the new locations, then `unlink()` the old files.

A store holding a million overwrites of one key merges down to a single record.

**Hint files** are merge's other output. On startup the keydir has to be
rebuilt, and rebuilding it from data files means reading every byte — including
every value, none of which the index needs. A hint file holds the same records
with the values left out: key, size, position, timestamp. Rebuilding from hints
reads a small fraction of the bytes, which takes startup on a large store from
minutes to seconds.

*Stage 5 builds merge and hints.*

---

## 6. Crash recovery

Because writes only append, a crash can leave exactly one thing broken: a
partial record at the end of the last file. Everything before it was already
complete.

Each record carries a **CRC**, a checksum of its own bytes. On startup you
replay the log and check every record's CRC. A torn trailing record fails its
check, and the recovery is to truncate the file at that point and carry on. The
write was never acknowledged, so losing it is correct.

This is why the checksum lives inside the record rather than somewhere central:
the record has to be self-verifying, because verifying it is how you find where
the good data ends.

*Stage 1 builds the CRC. Stage 3 builds recovery.*

---

## 7. What it costs

Bitcask is a real design with real limits, and both limits come from the
keydir.

**Every key must fit in RAM.** Not the values — the keys, plus about 30 bytes
of bookkeeping each. A million 32-byte keys is roughly 60-80 MB, which is fine.
A billion keys is not. If the keyspace outgrows memory, Bitcask is the wrong
engine, and no amount of tuning changes that.

**No ordered iteration.** A hash map has no order, so there are no range scans.
"Every key between `user:1000` and `user:2000`" cannot be answered without
reading every key. Ordered access needs a B-tree or an LSM tree.

What you get in exchange: predictable single-seek reads, sequential writes at
device speed, crash recovery that amounts to a truncate, and an engine small
enough to hold in your head — which is why it is worth building one.

---

## Stage map

| Stage | Concept | Section |
|---|---|---|
| 0 | The API and the directory | 4 |
| 1 | The record, and self-verification | 2, 6 |
| 2 | The append-only log and the keydir | 2, 3 |
| 3 | Replay and torn records | 6 |
| 4 | Tombstones and rollover | 4, 5 |
| 5 | Merge and hint files | 5 |
| 6 | Proving crash safety | 6 |

---

Sheehy & Smith, *Bitcask: A Log-Structured Hash Table for Fast Key/Value Data*
(Basho, 2010). Six pages. Read it after Stage 3.
