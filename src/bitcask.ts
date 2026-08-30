import { KeyNotFoundError, InvalidArgumentError, ClosedError } from "./errors.ts";

/**
 * Size limits on keys and values.
 *
 * These look arbitrary right now. They are not. In Stage 1 you will design the
 * on-disk record header, and the key length will live in a uint16 field and the
 * value length in a uint32 field. The limits below are exactly what those two
 * field widths can express. Enforcing them from day one means Stage 1 never has
 * to change the API's contract.
 *
 * TS note: `as const` freezes these into the literal types 65535 and 4294967295
 * instead of widening them to `number`. Not important here, just idiomatic.
 */
export const LIMITS = {
  MAX_KEY_SIZE: 0xffff, // 65,535 bytes  -> uint16 in the record header
  MAX_VALUE_SIZE: 0xffffffff, // ~4 GiB  -> uint32 in the record header
} as const;

/**
 * TS note: `?` means the field is optional, so its type is
 * `number | undefined`. Unused in Stage 0; Stage 4 starts reading it.
 */
export interface Options {
  /** Byte size at which the active file rolls over. Used from Stage 4 on. */
  maxFileSize?: number;
}

/**
 * A Bitcask store.
 *
 * ## Stage 0 contract
 *
 * Back this with a plain in-memory `Map`. No disk I/O yet beyond creating the
 * directory. The point of this stage is to nail down an API surface that will
 * not have to change for the rest of the journey.
 *
 * Every method is async even though nothing here awaits anything. That is
 * deliberate: from Stage 2 onward these all touch the filesystem, and you do
 * not want to rewrite every call site then.
 *
 * ### Semantics you must honour
 *
 * - `open(dir)`   creates `dir` (recursively) if it does not exist, and
 *                 resolves to a usable store.
 * - `put(k, v)`   inserts or overwrites. Must not retain a reference to the
 *                 caller's buffer -- if the caller mutates `v` afterwards, the
 *                 stored value must be unaffected.
 * - `get(k)`      resolves to the value, or rejects with `KeyNotFoundError`.
 *                 Must not hand out a reference to internal state -- if the
 *                 caller mutates the returned buffer, the store must be
 *                 unaffected.
 * - `delete(k)`   removes the key. Deleting a key that is not present is a
 *                 no-op, NOT an error.
 * - `keys()`      resolves to every live key, in any order. Deleted keys are
 *                 not included. Returns `Buffer[]`, not strings.
 * - `close()`     releases resources. Every method above must reject with
 *                 `ClosedError` once close has resolved. `close()` itself is
 *                 idempotent -- calling it twice is fine.
 *
 * ### Validation (applies to `get`, `put`, `delete`)
 *
 * Reject with `InvalidArgumentError` if the key is not a Buffer, is empty, or
 * exceeds `LIMITS.MAX_KEY_SIZE`. Same for a value that is not a Buffer or
 * exceeds `LIMITS.MAX_VALUE_SIZE`. Validate BEFORE the not-found check: a
 * malformed key is an argument error, not a missing key. `Buffer.isBuffer(x)`
 * is how you check at runtime -- a TS type annotation is erased before the code
 * runs and protects you from nothing.
 *
 * ### The one real trap in this stage
 *
 * A JS `Map` keyed by `Buffer` uses reference identity, so
 * `map.get(someOtherBufferWithTheSameBytes)` will essentially never hit. You
 * need a string key. Which encoding you pick is not a detail -- one of the
 * obvious choices silently merges distinct byte sequences into the same key.
 * The `binary safety` tests will tell you if you chose wrong.
 */
export class Bitcask {
  /** The directory this store lives in. `readonly` = cannot be reassigned. */
  readonly dir: string;

  /**
   * Stage 0 storage. `#` makes it genuinely private -- unreachable from
   * outside the class, even at runtime.
   *
   * The value type is Buffer. The KEY type is `string`, not Buffer, for the
   * reason in "the one real trap" above. Encoding and decoding between the two
   * is your job.
   */
  #entries = new Map<string, Buffer>();

  #closed = false;

  /**
   * Private, because opening involves async work (mkdir) and JS constructors
   * cannot be async. The static `open` below is the real entry point. This is
   * a very common TS/JS pattern -- worth recognising.
   */
  private constructor(dir: string, _opts: Options) {
    this.dir = dir;
  }

  static async open(dir: string, opts: Options = {}): Promise<Bitcask> {
    throw new Error("TODO(stage-0): mkdir -p the directory, then return new Bitcask(dir, opts)");
  }

  async get(key: Buffer): Promise<Buffer> {
    throw new Error("TODO(stage-0): implement get");
  }

  async put(key: Buffer, value: Buffer): Promise<void> {
    throw new Error("TODO(stage-0): implement put");
  }

  async delete(key: Buffer): Promise<void> {
    throw new Error("TODO(stage-0): implement delete");
  }

  async keys(): Promise<Buffer[]> {
    throw new Error("TODO(stage-0): implement keys");
  }

  async close(): Promise<void> {
    throw new Error("TODO(stage-0): implement close");
  }
}

// Re-exported so callers only ever import from one module.
export { KeyNotFoundError, InvalidArgumentError, ClosedError };
