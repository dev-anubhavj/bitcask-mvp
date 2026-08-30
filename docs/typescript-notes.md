# TypeScript + Bun, only the parts this project needs

Not a tutorial. A lookup table for the things that will actually block you while
building this. Skim it once, then come back when something confuses you.

---

## 1. Running things

```bash
bun test                    # run every *.test.ts
bun test stage00            # only files matching "stage00"
bun test --watch            # re-run on save
bun run src/whatever.ts     # run a .ts file directly, no build step
bun repl                    # a REPL to poke at Buffer methods in
bun run typecheck           # tsc --noEmit -- the actual type errors
```

**Important:** `bun test` does *not* typecheck. Bun strips the types and runs
the JavaScript. So a file with type errors can still pass its tests, and a
green test run does not mean your types are right. Run `bun run typecheck`
separately. Your editor's red squiggles are the same check, live.

---

## 2. Type annotations

A type goes after a colon. That is 90% of the syntax.

```ts
let count: number = 0;
let name: string = "bitcask";
let raw: Buffer = Buffer.from("hi");
let maybe: string | undefined;        // union: one OR the other

function add(a: number, b: number): number {
  return a + b;
}
```

You can usually leave off the type when it's obvious — `let count = 0` is
already `number`. Annotate function parameters and return types; let everything
else infer.

**Generics** are types that take a type argument, in angle brackets:

```ts
Map<string, Buffer>     // a Map whose keys are strings and values are Buffers
Buffer[]                // an array of Buffers (shorthand for Array<Buffer>)
Promise<Buffer>         // a promise that resolves to a Buffer
Promise<void>           // a promise that resolves to nothing
```

**Describing object shapes** — `interface` and `type` are near-interchangeable;
this project uses `interface` for object shapes:

```ts
interface Entry {
  fileId: number;
  valueSize: number;
  valueOffset: number;
  timestamp: number;
  maxFileSize?: number;   // "?" means optional -> number | undefined
}
```

---

## 3. The thing that will annoy you most: `undefined`

`strict` mode is on, which means TypeScript tracks whether something might be
missing and refuses to let you ignore it. This bites hardest with `Map.get`:

```ts
const entries = new Map<string, Buffer>();

const v = entries.get("k");   // v is Buffer | undefined -- ALWAYS
v.length;                     // ✗ error: 'v' is possibly 'undefined'
```

Four ways out, in order of preference:

```ts
// 1. Narrow it with a check. TS understands the if and narrows v to Buffer.
if (v === undefined) throw new KeyNotFoundError(key);
v.length;                     // ✓ TS now knows v is a Buffer

// 2. Provide a default.
const v = entries.get("k") ?? Buffer.alloc(0);

// 3. Optional chaining, when "undefined result" is fine.
const len = entries.get("k")?.length;   // number | undefined

// 4. The non-null assertion "!". Says "trust me, not undefined".
const v = entries.get("k")!;            // ✗ avoid -- it lies silently
```

Option 1 is what you want in `get()`. The check that satisfies the type checker
is the same check that produces the correct error. That is the whole idea:
the types push you toward handling the case you were going to have to handle
anyway.

---

## 4. Classes

```ts
export class Bitcask {
  readonly dir: string;          // public, but cannot be reassigned after init
  #entries = new Map<string, Buffer>();   // truly private (JS-level)
  #closed = false;               // type inferred as boolean

  private constructor(dir: string) {      // can't be called from outside
    this.dir = dir;
  }

  static async open(dir: string): Promise<Bitcask> {   // called on the class
    await mkdir(dir, { recursive: true });
    return new Bitcask(dir);                            // ok: we're inside
  }

  async get(key: Buffer): Promise<Buffer> {             // called on instances
    return this.#entries.get(...) ...
  }
}
```

- `#name` is a real JavaScript private field. Unreachable from outside, at
  runtime, for real. There's also a TS-only `private` keyword that vanishes at
  runtime; prefer `#`.
- `static` = lives on the class (`Bitcask.open(...)`), not on instances.
- **The private-constructor pattern:** constructors can't be `async`, but
  opening a store needs `await mkdir(...)`. So the constructor is private and
  dumb, and a static async `open()` does the awaiting and then constructs.
  You'll see this everywhere in TS.
- Fields must be declared before use. Assigning `this.foo = 1` without
  declaring `foo` is an error.

---

## 5. async / await

```ts
async function f(): Promise<Buffer> { ... }   // async fn ALWAYS returns Promise
const result = await f();                     // unwrap it
```

Rules that matter here:

- `await` only works inside an `async` function. Bun also allows it at the top
  level of a module, which is handy in scratch scripts.
- An `async` function that `throw`s produces a **rejected promise**. It does not
  throw synchronously. So `db.get(k)` never throws at the call site — it returns
  a promise that rejects. That's why the tests say
  `await expect(db.get(k)).rejects.toThrow(...)` rather than
  `expect(() => db.get(k)).toThrow(...)`.
- Forgetting `await` is the classic bug. `const v = db.get(k)` gives you a
  Promise object, not a Buffer, and TS will complain — read the error, it's
  telling you exactly this.
- Catch with ordinary try/catch:

```ts
try {
  await db.get(key);
} catch (err) {
  // err is `unknown` under strict mode -- you must narrow before using it
  if (err instanceof KeyNotFoundError) { /* ... */ }
  else throw err;
}
```

---

## 6. Buffer — the important one

A `Buffer` is a fixed-length array of bytes (0–255). It's Node's binary type
and Bun implements it fully. This whole project is Buffer manipulation.

### Making them

```ts
Buffer.from("hello")            // 5 bytes, UTF-8 encoded
Buffer.from("hello", "utf8")    // same, explicit
Buffer.from([0xde, 0xad])       // 2 raw bytes
Buffer.from(otherBuffer)        // a COPY of another buffer
Buffer.alloc(16)                // 16 zero-filled bytes
Buffer.allocUnsafe(16)          // 16 bytes of garbage -- faster, you MUST
                                // overwrite every byte before reading
Buffer.concat([a, b, c])        // join several into one new buffer
```

### Reading and writing numbers

This is how you'll build the record header in Stage 1. Fixed-width, explicit
endianness (LE = little-endian; pick one and be consistent):

```ts
buf.writeUInt32LE(value, offset);   // write 4 bytes at offset
buf.writeUInt16LE(value, offset);   // write 2 bytes
buf.readUInt32LE(offset);           // read 4 bytes back
buf.readUInt16LE(offset);
buf.writeBigUInt64LE(BigInt(ms), offset);   // 8 bytes, for timestamps
```

Each of these returns/consumes a plain `number`, and each throws if the offset
would run past the end of the buffer — which is a feature, not a nuisance:
it's how a truncated record announces itself in Stage 3.

### Slicing — the sharp edge

```ts
const view = buf.subarray(4, 12);   // NO COPY. Shares memory with buf.
view[0] = 0xff;                     // ...this also modified buf!

const copy = Buffer.from(buf.subarray(4, 12));   // an independent copy
```

`subarray` is a **view**, not a copy. This is fast and usually what you want
when parsing, but it is exactly the bug behind the `ownership of buffers` tests
in Stage 0: if `get()` returns a subarray of internal state, the caller can
reach in and corrupt your store. (`buf.slice()` is a deprecated alias for
`subarray` and behaves the same way — do not be fooled by the name.)

### Comparing

```ts
a === b            // ✗ reference identity. Two buffers with identical bytes
                   //   are NOT ===. This will burn you.
a.equals(b)        // ✓ content comparison
a.compare(b)       // -1 / 0 / 1, for sorting
```

### Buffer to string, for Map keys

```ts
buf.toString("utf8")     // ✗ lossy. Invalid byte sequences all collapse to the
                         //   same replacement character, so different keys
                         //   become the same string.
buf.toString("latin1")   // ✓ lossless. Every byte 0-255 maps to exactly one
                         //   character and back again. Also called "binary".
buf.toString("hex")      // ✓ also lossless, but 2x the memory
```

Since the keydir must be keyed by a string, and keys are arbitrary bytes, this
choice is load-bearing. `latin1` is what you want.

---

## 7. Imports

```ts
import { Bitcask, LIMITS } from "./bitcask.ts";   // note the .ts extension
import type { Options } from "./bitcask.ts";      // types only, erased at build
import { mkdir } from "node:fs/promises";         // node: prefix for builtins
import { test, expect } from "bun:test";          // bun's own modules
```

- The `.ts` extension in imports is required by this project's tsconfig
  (`allowImportingTsExtensions`). Bun handles it natively.
- `import type` is for things that only exist in the type system. Required here
  because `verbatimModuleSyntax` is on. If TS tells you to add `type`, add it.
- Node's built-in modules are available under `node:` — Bun implements them.

---

## 8. Decoding common error messages

| Message | What it means |
|---|---|
| `'x' is possibly 'undefined'` | See §3. Narrow it with an `if`. |
| `Type 'X \| undefined' is not assignable to type 'X'` | Same thing, other direction. |
| `Property 'foo' does not exist on type 'Bitcask'` | You forgot to declare the field. |
| `'await' expressions are only allowed within async functions` | Add `async` to the enclosing function. |
| `Argument of type 'string' is not assignable to parameter of type 'Buffer'` | You passed `"key"` where `b("key")` was wanted. |
| `Object is of type 'unknown'` | A caught `err`. Narrow with `instanceof`. |
| `Cannot find name 'Buffer'` | `@types/bun` isn't loading — check tsconfig `types`. |

---

## 9. Escape hatches (and when they're OK)

```ts
value as unknown as Buffer   // force a cast. Used in the tests deliberately,
                             // to pass a bad type past the compiler so the
                             // RUNTIME check can be tested. That's legitimate.
value!                       // "not null/undefined, trust me"
let x: any                   // turn off checking entirely
```

In test code, forcing a bad value through a cast is fine and intentional — the
point is to prove your runtime validation works. In `src/`, if you find
yourself reaching for `any` or `!`, that's usually a sign the design wants a
narrowing check instead.

---

## 10. `bun:test` cheat sheet

```ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test";

describe("group", () => {
  test("does the thing", async () => {
    expect(2 + 2).toBe(4);                       // Object.is, for primitives
    expect(bufA).toEqual(bufB);                  // deep/content equality
    expect(arr.length).toBe(3);
    expect(x).not.toEqual(y);                    // negate anything with .not

    // async rejection -- note the await on the OUTSIDE
    await expect(db.get(k)).rejects.toThrow(KeyNotFoundError);

    // sync throw
    expect(() => decode(bad)).toThrow(CorruptRecordError);
  });
});
```

`toBe` is identity, `toEqual` is structural. For Buffers you want `toEqual`.
