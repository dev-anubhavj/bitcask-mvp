import { mkdir } from "node:fs/promises";
import {
  KeyNotFoundError,
  InvalidArgumentError,
  ClosedError,
} from "./errors.ts";

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
 * The behaviour each method must have is in docs/stage-00.md and in
 * test/stage00.test.ts. How you get there is up to you: add whatever fields
 * you need to this class.
 */
export class Bitcask {
  /** Directory the store was opened on. */
  readonly dir: string;

  // The in-memory KV index
  // Keys are strings (latin1 encoding, since its cheaper and keeps distinct bytes distinct),
  // so comparison is value based
  #inMemStore = new Map<string, Buffer>();

  // Store's state
  #closed: boolean = false;

  /**
   * Private because opening a store has to await mkdir, and a constructor
   * cannot be async. Call Bitcask.open() instead.
   */
  private constructor(dir: string, _opts: Options) {
    this.dir = dir;
  }

  /** Opens the store at `dir`, creating the directory if it does not exist. */
  static async open(dir: string, opts: Options = {}): Promise<Bitcask> {
    // create the directory, if it does not exist, including parent directories.
    await mkdir(dir, { recursive: true });
    return new Bitcask(dir, opts);
  }

  /** Returns the value stored under `key`, or throws KeyNotFoundError. */
  async get(key: Buffer): Promise<Buffer> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // Validation: Reject invalid or empty key buffers
    if (!this.#isValidBufferKey(key))
      throw new InvalidArgumentError(
        "The supplied key is either empty or invalid",
      );

    const value = this.#inMemStore.get(key.toString("latin1"));
    if (value === undefined) throw new KeyNotFoundError(key);

    return Buffer.from(value);
  }

  /** Stores `value` under `key`, replacing any value already there. */
  async put(key: Buffer, value: Buffer): Promise<void> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // Validation: Reject invalid, empty key buffers
    if (!this.#isValidBufferKey(key))
      throw new InvalidArgumentError(
        "The supplied key is either empty or invalid",
      );

    // Validation: Reject invalid value buffers
    if (!Buffer.isBuffer(value) || value.length > LIMITS.MAX_VALUE_SIZE)
      throw new InvalidArgumentError("The supplied value is invalid");

    this.#inMemStore.set(key.toString("latin1"), Buffer.from(value));
  }

  /** Removes `key`. Does nothing if the key is not in the store. */
  async delete(key: Buffer): Promise<void> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // Validation: Reject invalid or empty key buffers
    if (!this.#isValidBufferKey(key))
      throw new InvalidArgumentError(
        "The supplied key is either empty or invalid",
      );
    this.#inMemStore.delete(key.toString("latin1"));
  }

  /** Returns every key in the store, in no particular order. */
  async keys(): Promise<Buffer[]> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // convert all the string keys back to Buffer type
    const keys = this.#inMemStore
      .keys()
      .map((key, _) => {
        return Buffer.from(key, "latin1");
      })
      .toArray();

    return keys;
  }

  /**
   * Closes the store. Calling it a second time does nothing.
   * Every other method throws ClosedError after this.
   */
  async close(): Promise<void> {
    this.#closed = true;
  }

  /** Check if the key is a valid buffer key
   * a. the key is an actual buffer
   * b. non-empty buffer
   * c. key size less than max
   */
  #isValidBufferKey(key: unknown): boolean {
    return (
      Buffer.isBuffer(key) &&
      key.length > 0 &&
      key.length <= LIMITS.MAX_KEY_SIZE
    );
  }
}

export { KeyNotFoundError, InvalidArgumentError, ClosedError };
