# bitcask

A from-scratch Bitcask in TypeScript, built in seven small stages over about
two days. Learning project.

## The idea in one paragraph

Bitcask is a **log-structured hash table**. Every write is an append to the end
of a single active file — records are never modified in place. Because appends
alone would make reads O(file), an in-memory index called the **keydir** maps
each key to `{fileId, valuePos, valueSize, timestamp}`, so a read is one hash
lookup plus exactly one seek. Updates and deletes are also appends (a delete
writes a *tombstone*), so garbage accumulates and a periodic **merge** rewrites
the immutable files keeping only live records. Merge also emits **hint files** —
the index without the values — so restart doesn't have to read every byte of
data back. The price of all this is that **every key must fit in RAM**, and
there is no ordered iteration.

## Running

```bash
bun install
bun test              # every stage's suite
bun test stage00      # just one stage
bun test --watch      # re-run on save
bun run typecheck     # tsc --noEmit -- bun test does NOT typecheck for you
```

Tests scribble into `./.tmp/` and clean up after themselves. Comment out the
`afterAll(cleanup)` in a test file when you want to go hexdump a data file:

```bash
xxd .tmp/bc-XXXXXX/1.data | head -40
```

Each stage adds a test file and **keeps all the previous ones**. `bun test`
staying green is the contract: Stage 5's merge must not break Stage 0's API.

Read **[docs/concepts.md](docs/concepts.md)** for why Bitcask is shaped the way
it is — it is organised by concept, and each stage brief points at the section
you need before you start. Then work through the stage briefs
(**[docs/stage-00.md](docs/stage-00.md)** first), which hold the contract and
build order for each stage.

New to TypeScript? **[docs/typescript-notes.md](docs/typescript-notes.md)** is a
lookup table for exactly the TS and Buffer surface this project uses. Read §3
(`undefined`) and §6 (Buffer) before starting Stage 0.

## The stages

### Day one — a working store

| # | Stage | ~Time | You build | You prove |
|---|---|---|---|---|
| 0 | **The API** | 45 min | `open/put/get/delete/keys/close` over an in-memory `Map` | The interface that survives all seven stages |
| 1 | **The record** | 1.5 h | Encode/decode one entry, with a CRC over the bytes | Round-trip any key/value; flip any single byte and the CRC catches it |
| 2 | **Log + keydir** | 2 h | Append-only file, plus the in-memory index. `get` = 1 lookup + 1 positional read | Data survives in a real file; `bun run bench/` shows the index flattening the read curve |
| 3 | **Recovery** | 1.5 h | Rebuild the keydir by replaying the log on `open` | Reopen and everything's there; chop the file mid-record and it *still* opens |

At the end of day one you have a durable key/value store. Everything after this
is about it not falling over as it grows.

### Day two — a storage engine

| # | Stage | ~Time | You build | You prove |
|---|---|---|---|---|
| 4 | **Tombstones + rollover** | 1.5 h | Deletes as appended tombstones; roll to a new file at a size threshold; many files in the keydir; `stats()` | Delete 1000 keys and watch the store *grow*. 10 MiB at a 1 MiB threshold → 10 files, reads still work |
| 5 | **Merge + hints** | 2.5 h | Compact the immutable files to live records only, write hint files, swap the keydir | Stage 4's garbage disappears; reads during merge never break; restart gets much faster |
| 6 | **Prove it** *(optional)* | 1 h | A `kill -9` crash harness and a tiny REPL | Kill it mid-write in a loop and never lose an acked write |

**Stages 2 and 5 are the two that actually teach the paper** — *why an index
exists*, and *why compaction exists*. If you run out of time, cut Stage 6 and
give the hours to Stage 5.

### What I cut to make this fit two days

Honest accounting, so you know what you're not seeing:

- **The deliberately slow version.** The original plan had you build a `get`
  that scans the whole file, feel the pain, and only then add the keydir. It's
  the best way to internalize why the index exists, but it's an hour spent on
  code you throw away. Instead I ship the naive scan for you in
  `bench/scan-vs-keydir.ts` — you'll still see the two curves diverge, you just
  won't have written the loser yourself.
- **Hint files as their own stage.** Folded into Stage 5, since merge is what
  writes them.
- **fsync policy, file locking, reader/writer concurrency.** Dropped. Real
  concerns for a real engine, but thinner on insight per hour than merge, and
  awkward to demonstrate in a single-process Bun script. Notes on where they'd
  go are in Stage 5's brief.

## Layout

```
src/
  bitcask.ts    the store            <- your work
  errors.ts     the error types      <- given
  record.ts     encode/decode        <- your work
  constants.ts  sizes and offsets    <- your work
  utils.ts      shared validation    <- your work
test/
  helpers.ts    tmpdir + `b()` Buffer shorthand
  stageNN.test.ts
bench/
  scan-vs-keydir.ts  the argument for the keydir, measured on your code
  garbage.ts         what append-only costs, measured on your code
docs/
  concepts.md          why Bitcask works the way it does -- read this first
  stage-NN.md          the brief for each stage: why, contract, build order
  typescript-notes.md  TS + Buffer lookup table
```

Source files carry short comments only. Each stage's contract and reasoning
lives in its brief under `docs/`, not in doc comments.

## Reference

Sheehy & Smith, *Bitcask: A Log-Structured Hash Table for Fast Key/Value Data*
(Basho, 2010) — six pages. Worth reading once you've finished Stage 3; it'll
read as obvious by then, which is the point.
