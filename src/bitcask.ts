import { mkdir } from "node:fs/promises";
import {
  KeyNotFoundError,
  InvalidArgumentError,
  ClosedError,
  FileHandleError,
} from "./errors.ts";
import { LIMITS } from "./constants.ts";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { open } from "node:fs/promises";
import { isValidBufferKey, isValidValueBuffer } from "./utils.ts";
import { decode, encode, HEADER_SIZE } from "./record.ts";

export interface Options {
  /**
   * Once the file being written to reaches this many bytes, close it and start
   * a new one. Ignored until Stage 4.
   */
  maxFileSize?: number;
}

export interface RecordMetadata {
  /** Id of the file in which record is written */
  fileId: number;

  /** byte offset in the file, where the record starts */
  offset: number;

  /** totalSize of the record  */
  totalSize: number;

  /** Milliseconds since the epoch. */
  timestamp: number;
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

  /** The file handle for the active file. */
  #fileHandle: FileHandle | null = null;

  // The in-memory KV index
  // Keys are strings (latin1 encoding, since its cheaper and keeps distinct bytes distinct),
  // so comparison is value based
  #keydir = new Map<string, RecordMetadata>();

  // Store's state
  #closed: boolean = false;

  // maintain the running count of offset where the records get written in the file
  #writeOffset: number;

  /**
   * Private because opening a store has to await mkdir, and a constructor
   * cannot be async. Call Bitcask.open() instead.
   */
  private constructor(
    dir: string,
    fileHandle: FileHandle,
    writeOffset: number,
    _opts: Options,
  ) {
    this.dir = dir;
    this.#fileHandle = fileHandle;
    this.#writeOffset = writeOffset;
  }

  /** Opens the store at `dir`, creating the directory if it does not exist. */
  static async open(dir: string, opts: Options = {}): Promise<Bitcask> {
    // create the directory, if it does not exist, including parent directories.
    await mkdir(dir, { recursive: true });
    const fileHandle = await open(path.join(dir, "1.data"), "a+");
    const writeOffset = (await fileHandle.stat()).size;
    return new Bitcask(dir, fileHandle, writeOffset, opts);
  }

  /** Returns the value stored under `key`, or throws KeyNotFoundError. */
  async get(key: Buffer): Promise<Buffer> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // Fail early if file handle unavailable
    if (this.#fileHandle === null)
      throw new FileHandleError("file handle unavailable");

    // Validation: Reject invalid or empty key buffers
    if (!isValidBufferKey(key))
      throw new InvalidArgumentError(
        "The supplied key is either empty or invalid",
      );

    const recordMetadata = this.#keydir.get(key.toString("latin1"));
    if (recordMetadata === undefined) throw new KeyNotFoundError(key);

    // Allocate a read buffer to read the bytes from file
    const readBuf = Buffer.alloc(recordMetadata.totalSize);

    // Read the bytes from file
    await this.#fileHandle.read(
      readBuf,
      0,
      recordMetadata.totalSize,
      recordMetadata.offset,
    );

    // Decode the record
    const decodedRecord = decode(readBuf, 0);
    return decodedRecord.value;
  }

  /** Stores `value` under `key`, replacing any value already there. */
  async put(key: Buffer, value: Buffer): Promise<void> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // Fail early if file handle unavailable
    if (this.#fileHandle === null)
      throw new FileHandleError("file handle unavailable");

    // Validation: Reject invalid, empty key buffers
    if (!isValidBufferKey(key))
      throw new InvalidArgumentError(
        "The supplied key is either empty or invalid",
      );

    // Validation: Reject invalid value buffers
    if (!isValidValueBuffer(value))
      throw new InvalidArgumentError("The supplied value is invalid");

    // Get the timestamp to be recorded
    const timestamp = Date.now();

    // Encode the data to be written to file
    const record = encode(key, value, timestamp);

    // write to the file
    await this.#fileHandle.write(record);

    // Create object to record metadata for the record written to active file.
    const recordMetadata: RecordMetadata = {
      fileId: 1,
      offset: this.#writeOffset,
      totalSize: record.length,
      timestamp: timestamp,
    };

    // Update the write offset
    this.#writeOffset += record.length;

    // update keydir
    this.#keydir.set(key.toString("latin1"), recordMetadata);
  }

  /** Removes `key`. Does nothing if the key is not in the store. */
  async delete(key: Buffer): Promise<void> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // Validation: Reject invalid or empty key buffers
    if (!isValidBufferKey(key))
      throw new InvalidArgumentError(
        "The supplied key is either empty or invalid",
      );

    this.#keydir.delete(key.toString("latin1"));
  }

  /** Returns every key in the store, in no particular order. */
  async keys(): Promise<Buffer[]> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // convert all the string keys back to Buffer type
    const keys = this.#keydir
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
    // Mark closed first,
    // so any other operation is avoided while handle is still being released
    this.#closed = true;

    // idempotency over file handle close operation
    if (this.#fileHandle !== null) {
      await this.#fileHandle.close();
      this.#fileHandle = null;
    }
  }
}

export { LIMITS };
export { KeyNotFoundError, InvalidArgumentError, ClosedError, FileHandleError };
