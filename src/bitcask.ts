import { KeyNotFoundError, InvalidArgumentError, ClosedError } from "./errors.ts";

/**
 * Largest key and value the store accepts.
 *
 * These numbers come from the record header in Stage 1: the key length is
 * stored in 2 bytes and the value length in 4 bytes, so a key cannot be longer
 * than 65535 bytes and a value cannot be longer than 4294967295.
 */
export const LIMITS = {
  MAX_KEY_SIZE: 0xffff, // 65535
  MAX_VALUE_SIZE: 0xffffffff, // 4294967295
} as const;

export interface Options {
  /**
   * Once the file being written to reaches this many bytes, close it and start
   * a new one. Ignored until Stage 4.
   */
  maxFileSize?: number;
}

/**
 * A key-value store.
 *
 * In Stage 0 the data is held in memory and nothing is written to disk.
 * The full spec for this stage is in docs/stage-00.md.
 */
export class Bitcask {
  /** Directory the store was opened on. */
  readonly dir: string;

  /**
   * The stored data.
   *
   * The Map key is a string, not a Buffer, because Map compares Buffers by
   * identity. Two Buffers holding the same bytes are two different Map keys,
   * so looking up a key would never find anything. Turning the Buffer into a
   * string and back is your job.
   */
  #entries = new Map<string, Buffer>();

  /** Set to true by close(). Every method checks it. */
  #closed = false;

  /**
   * Private because opening a store has to await mkdir, and a constructor
   * cannot be async. Call Bitcask.open() instead.
   */
  private constructor(dir: string, _opts: Options) {
    this.dir = dir;
  }

  /** Opens the store at `dir`, creating the directory if it does not exist. */
  static async open(dir: string, opts: Options = {}): Promise<Bitcask> {
    throw new Error("TODO(stage-0): mkdir -p, then return new Bitcask(dir, opts)");
  }

  /** Returns the value stored under `key`, or throws KeyNotFoundError. */
  async get(key: Buffer): Promise<Buffer> {
    throw new Error("TODO(stage-0)");
  }

  /**
   * Stores `value` under `key`, replacing any value already there.
   *
   * Copy `value` before storing it. If you keep the caller's Buffer and they
   * change it later, the stored value changes with it.
   */
  async put(key: Buffer, value: Buffer): Promise<void> {
    throw new Error("TODO(stage-0)");
  }

  /** Removes `key`. Does nothing if the key is not in the store. */
  async delete(key: Buffer): Promise<void> {
    throw new Error("TODO(stage-0)");
  }

  /** Returns every key in the store, in no particular order. */
  async keys(): Promise<Buffer[]> {
    throw new Error("TODO(stage-0)");
  }

  /**
   * Closes the store. Calling it a second time does nothing.
   * Every other method throws ClosedError after this.
   */
  async close(): Promise<void> {
    throw new Error("TODO(stage-0)");
  }
}

export { KeyNotFoundError, InvalidArgumentError, ClosedError };
