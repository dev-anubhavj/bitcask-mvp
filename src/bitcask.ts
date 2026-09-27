import {
  mkdir,
  truncate,
  readdir,
  stat,
  open,
  readFile,
  writeFile,
  unlink,
  rename,
} from "node:fs/promises";
import {
  KeyNotFoundError,
  InvalidArgumentError,
  ClosedError,
  FileHandleError,
  TruncatedRecordError,
  CorruptRecordError,
} from "./errors.ts";
import { LIMITS, TOMB, DEFAULT_FIRST_DATAFILE_NAME } from "./constants.ts";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { isValidBufferKey, isValidValueBuffer } from "./utils.ts";
import { decode, encode } from "./record.ts";
import { encodeHintEntry, decodeHintFile, type HintEntry } from "./hint.ts";

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

  /** fileId of the activeFile */
  #activeFileId: number;

  /** The file handle for the active file. */
  #fileHandle: FileHandle | null = null;

  /** The in-memory KV index
   * Keys are strings (latin1 encoding, since its cheaper and keeps distinct bytes distinct),
   * so comparison is value based */
  #keydir = new Map<string, RecordMetadata>();

  /** cached file handles for files that are touched */
  #cachedFileHandles = new Map<number, FileHandle>();

  // Store's state
  #closed: boolean = false;

  /** Maintain the running count of offset where the records get written in the active file */
  #writeOffset: number;

  /** maximum file size of a data file */
  #maxFileSize: number | undefined;

  /**
   * Private because opening a store has to await mkdir, and a constructor
   * cannot be async. Call Bitcask.open() instead.
   */
  private constructor(
    dir: string,
    fileHandle: FileHandle,
    writeOffset: number,
    activeFileId: number,
    _opts: Options,
  ) {
    this.dir = dir;
    this.#fileHandle = fileHandle;
    this.#writeOffset = writeOffset;
    this.#activeFileId = activeFileId;
    this.#maxFileSize = _opts.maxFileSize;
  }

  /** Opens the store at `dir`, creating the directory if it does not exist. */
  static async open(dir: string, opts: Options = {}): Promise<Bitcask> {
    // create the directory, if it does not exist, including parent directories.
    await mkdir(dir, { recursive: true });

    // read all the filename from the dir
    const fileNames = await readdir(dir);
    // filter all the data files
    const dataFileNames = fileNames.filter(
      (file, _) =>
        path.extname(file) === ".data" &&
        !Number.isNaN(Number(path.parse(file).name)),
    );

    // If no data files, create the first one
    if (dataFileNames.length === 0)
      dataFileNames.push(DEFAULT_FIRST_DATAFILE_NAME);

    // Sort them by ids
    const sortedDataFileNames = dataFileNames.sort(
      (file1, file2) =>
        Number(path.parse(file1).name) - Number(path.parse(file2).name),
    );

    // Get the largest fileId
    const activeFileId = Number(
      path.parse(sortedDataFileNames[sortedDataFileNames.length - 1]).name,
    );
    // Create a file handle over the active file (append mode)
    const activeFileHandle = await open(
      path.join(dir, sortedDataFileNames[sortedDataFileNames.length - 1]),
      "a+",
    );

    // Get the write offset on the active file
    const activeWriteOffset = (await activeFileHandle.stat()).size;

    // Construct bitcask instance
    const bitcaskInstance = new Bitcask(
      dir,
      activeFileHandle,
      activeWriteOffset,
      activeFileId,
      opts,
    );

    // Walk through the active file and rebuild the keyDir
    await bitcaskInstance.#rebuildKeyDir(sortedDataFileNames);
    return bitcaskInstance;
  }

  /** Returns the value stored under `key`, or throws KeyNotFoundError. */
  async get(key: Buffer): Promise<Buffer> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // Validation: Reject invalid or empty key buffers
    if (!isValidBufferKey(key))
      throw new InvalidArgumentError(
        "The supplied key is either empty or invalid",
      );

    const recordMetadata = this.#keydir.get(key.toString("latin1"));
    if (recordMetadata === undefined) throw new KeyNotFoundError(key);

    // Allocate a read buffer to read the bytes from file
    const readBuf = Buffer.alloc(recordMetadata.totalSize);

    const readFileHandle =
      recordMetadata.fileId === this.#activeFileId
        ? this.#fileHandle
        : (this.#cachedFileHandles.get(recordMetadata.fileId) ??
          (await open(
            path.join(this.dir, recordMetadata.fileId.toString() + ".data"),
            "r",
          )));

    if (readFileHandle === null || readFileHandle === undefined)
      throw new FileHandleError("File handle unavailable");

    if (recordMetadata.fileId !== this.#activeFileId)
      this.#cachedFileHandles.set(recordMetadata.fileId, readFileHandle);

    // Read the bytes from file
    await readFileHandle.read(
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

    // check and rollover
    await this.#checkAndRollover(record);

    // write to the file
    await this.#fileHandle.write(record);

    // Create object to record metadata for the record written to active file.
    const recordMetadata: RecordMetadata = {
      fileId: this.#activeFileId,
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

    // Fail early if file handle unavailable
    if (this.#fileHandle === null)
      throw new FileHandleError("file handle unavailable");

    // Validation: Reject invalid or empty key buffers
    if (!isValidBufferKey(key))
      throw new InvalidArgumentError(
        "The supplied key is either empty or invalid",
      );

    const keyString = key.toString("latin1");
    // Only create a tombstone if the key is present in keydir
    if (this.#keydir.has(keyString)) {
      // Get the timestamp to be recorded
      const timestamp = Date.now();

      // Encode the data to be written to file
      const record = encode(key, TOMB, timestamp);

      // check and rollover
      await this.#checkAndRollover(record);

      // append tombstone to the file
      await this.#fileHandle.write(record);

      // Update the write offset
      this.#writeOffset += record.length;

      // Finally delete the key from keydir
      this.#keydir.delete(keyString);
    }
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

  /** Performs compaction */
  async merge(): Promise<void> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // get all the frozen data files
    const frozenDataFileNames = (await this.#getAllDataFileName()).filter(
      (fileName, _) => Number(path.parse(fileName).name) !== this.#activeFileId,
    );

    // Sort them by ids
    const sortedFrozenDataFileNames = frozenDataFileNames.sort(
      (file1, file2) =>
        Number(path.parse(file1).name) - Number(path.parse(file2).name),
    );

    // If no frozen file, nothing to do
    if (sortedFrozenDataFileNames.length === 0) return;

    // Initialize merge file metadata
    let activeMergeFileId = 1;
    let activeMergeOffset = 0;
    let activeMergeFileHandle = await open(
      path.join(this.dir, activeMergeFileId.toString() + ".merge"),
      "a+",
    );

    // Hint entries for the merge file currently being written
    let activeMergeHintEntries: Buffer[] = [];

    /**
     * Closes the merge file being written and writes its hint file, then moves
     * the id on. A file that got no records is thrown away instead, and keeps
     * its id, so merge never leaves an empty data file or a hint for one.
     */
    const finishActiveMergeFile = async () => {
      await activeMergeFileHandle.close();

      if (activeMergeOffset === 0) {
        await unlink(
          path.join(this.dir, activeMergeFileId.toString() + ".merge"),
        );
        return;
      }

      await writeFile(
        path.join(this.dir, activeMergeFileId.toString() + ".hintmerge"),
        Buffer.concat(activeMergeHintEntries),
      );
      activeMergeFileId += 1;
    };
    let activeHintOffset = 0;
    let activeHintFileHandle = await open(
      path.join(this.dir, activeMergeFileId.toString() + ".hint"),
      "a+",
    );

    // iterate over each of them and create merge files
    for (const fileName of sortedFrozenDataFileNames) {
      const filePath = path.join(this.dir, fileName);

      // Reads the entire file in-memory (NOT OPTIMAL)
      const fileBytes = await readFile(filePath);
      const fileId = Number(path.parse(filePath).name);

      let offset = 0;
      try {
        while (offset < fileBytes.length) {
          const decodedRecord = decode(fileBytes, offset);
          const keyString = decodedRecord.key.toString("latin1");
          const recordMetadata = this.#keydir.get(keyString);

          // check if this record is in keyDir
          if (
            recordMetadata !== undefined &&
            recordMetadata.fileId === fileId &&
            recordMetadata.offset === offset &&
            recordMetadata.timestamp === decodedRecord.timestamp
          ) {
            // this record needs to be preserved
            const preservedRecord = Buffer.from(
              fileBytes.subarray(offset, offset + decodedRecord.length),
            );

            // check and rollover -- a record is never split, so a single
            // record bigger than the threshold stays where it is
            if (
              activeMergeOffset > 0 &&
              activeMergeOffset + preservedRecord.length > this.#maxFileSize!
            ) {
              // close existing file and write its hint file
              await finishActiveMergeFile();

              // initialize new file
              activeMergeFileHandle = await open(
                path.join(this.dir, activeMergeFileId.toString() + ".merge"),
                "a+",
              );
              activeMergeOffset = 0;
              activeMergeHintEntries = [];
            }

            // write to the merge file
            await activeMergeFileHandle.write(preservedRecord);

            // update keyDir with update metadata
            const updateRecordMetadata: RecordMetadata = {
              fileId: activeMergeFileId,
              offset: activeMergeOffset,
              timestamp: decodedRecord.timestamp,
              totalSize: preservedRecord.length,
            };

            this.#keydir.set(keyString, updateRecordMetadata);

            // the same entry, for the hint file of this merge file
            activeMergeHintEntries.push(
              encodeHintEntry(decodedRecord.key, updateRecordMetadata),
            );

            activeMergeOffset += preservedRecord.length;
          }

          // increment offset
          offset += decodedRecord.length;
        }
      } catch (error) {
        throw error;
      }

      // close any active read handles over this frozen data file
      if (this.#cachedFileHandles.has(fileId)) {
        await this.#cachedFileHandles.get(fileId)?.close();
        this.#cachedFileHandles.delete(fileId);
      }

      // safely unlink this data file, and the hint file that described it --
      // a hint that outlives its data file would describe whatever file turns
      // up next under that name
      await unlink(filePath);
      await unlink(path.join(this.dir, fileId.toString() + ".hint")).catch(
        () => undefined,
      );
    }

    // close the last merge file and write its hint file
    await finishActiveMergeFile();

    const fileNames = await readdir(this.dir);

    // rename the merged data files into place
    for (const mergeFile of fileNames.filter(
      (file, _) => path.extname(file) === ".merge",
    )) {
      await rename(
        path.join(this.dir, mergeFile),
        path.join(this.dir, path.parse(mergeFile).name + ".data"),
      );
    }

    // then their hint files: a data file with no hint is a state open already
    // handles, a hint file describing the wrong data file is not
    for (const hintMergeFile of fileNames.filter(
      (file, _) => path.extname(file) === ".hintmerge",
    )) {
      await rename(
        path.join(this.dir, hintMergeFile),
        path.join(this.dir, path.parse(hintMergeFile).name + ".hint"),
      );
    }
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

    // close all cached file handles
    for (const handle of this.#cachedFileHandles.values()) {
      await handle.close();
    }

    // clear the cache
    this.#cachedFileHandles.clear();
  }

  /** Returns statistics about the store */
  async stats(): Promise<Stats> {
    // Validation: Reject any operation once the store is closed
    if (this.#closed) throw new ClosedError();

    // calculate live bytes of the records in keydir
    const liveBytes = this.#keydir
      .values()
      .reduce(
        (liveBytes, recordMetadata) => liveBytes + recordMetadata.totalSize,
        0,
      );

    // get all data files
    const dataFileNames = await this.#getAllDataFileName();

    // calculate totalBytes on disk for .data files
    let totalBytes = 0;
    for (const fileName of dataFileNames) {
      const filePath = path.join(this.dir, fileName);
      totalBytes += (await stat(filePath)).size;
    }

    return {
      keys: this.#keydir.size,
      files: dataFileNames.length,
      activeFileId: this.#activeFileId,
      liveBytes: liveBytes,
      totalBytes: totalBytes,
    };
  }

  /** Rebuilds keyDir during open */
  async #rebuildKeyDir(sortedDataFileNames: string[]) {
    // Iterate over all data files in sorted order
    for (const fileName of sortedDataFileNames) {
      const filePath = path.join(this.dir, fileName);
      const fileId = Number(path.parse(filePath).name);

      // A frozen file with a usable hint file does not need reading: the hint
      // holds every keydir entry this file would have produced, and none of
      // the values. The active file is always replayed -- it is still being
      // appended to, and it is the one file whose tail can be torn.
      if (fileName !== sortedDataFileNames[sortedDataFileNames.length - 1]) {
        const hintEntries = await this.#readHintFile(fileId);

        if (hintEntries !== null) {
          for (const hintEntry of hintEntries) {
            this.#keydir.set(hintEntry.key.toString("latin1"), {
              fileId: fileId,
              offset: hintEntry.offset,
              totalSize: hintEntry.totalSize,
              timestamp: hintEntry.timestamp,
            });
          }
          continue;
        }
      }

      // Reads the entire file in-memory (NOT OPTIMAL)
      const fileBytes = await readFile(filePath);

      // Offset at which the file is read to decode the record
      let offset = 0;
      try {
        while (offset < fileBytes.length) {
          // Get the decodedRecord
          const decodedRecord = decode(fileBytes, offset);

          if (decodedRecord.value.equals(TOMB)) {
            // If the decoded record is tombstone, delete the key from keyDir if it exists
            this.#keydir.delete(decodedRecord.key.toString("latin1"));
          } else {
            // construct the recordMetadata to store in keyDir
            const recordMetadata: RecordMetadata = {
              offset: offset,
              timestamp: decodedRecord.timestamp,
              fileId: fileId,
              totalSize: decodedRecord.length,
            };

            // Update the keyDir with the updated value of the record
            this.#keydir.set(
              decodedRecord.key.toString("latin1"),
              recordMetadata,
            );
          }

          // update offset
          offset += decodedRecord.length;
        }
      } catch (error) {
        // Truncate and clean file on encountering truncated or corrupted records
        if (
          error instanceof TruncatedRecordError ||
          error instanceof CorruptRecordError
        ) {
          if (fileName === sortedDataFileNames[sortedDataFileNames.length - 1])
            // Truncate the active file after the offset
            await truncate(filePath, offset);
        } else {
          throw error;
        }
      } finally {
        // Update write offset for the active file
        if (fileName === sortedDataFileNames[sortedDataFileNames.length - 1])
          this.#writeOffset = offset;
      }
    }
  }

  /**
   * Reads the hint file for a data file, or returns null when there is not one
   * that can be trusted. Either way the caller has one thing to do about it:
   * replay the data file instead.
   */
  async #readHintFile(fileId: number): Promise<HintEntry[] | null> {
    const hintBytes = await readFile(
      path.join(this.dir, fileId.toString() + ".hint"),
    ).catch(() => null);

    return hintBytes === null ? null : decodeHintFile(hintBytes);
  }

  /** Gets all data file names from the directory */
  async #getAllDataFileName(): Promise<string[]> {
    // Read the dir
    const fileNames = await readdir(this.dir);
    return fileNames.filter(
      (file, _) =>
        path.extname(file) === ".data" &&
        !Number.isNaN(Number(path.parse(file).name)),
    );
  }

  /** Checks if the record to be written will overflow
   * and if so, rolls over to a new data file
   */
  async #checkAndRollover(record: Buffer) {
    if (this.#writeOffset + record.length > this.#maxFileSize!) {
      // release handle to existing active file
      await this.#fileHandle?.close();

      // rollover to new file
      this.#activeFileId += 1;
      const newFilePath = path.join(
        this.dir,
        this.#activeFileId.toString() + ".data",
      );
      this.#fileHandle = await open(newFilePath, "a+");
      this.#writeOffset = 0;
    }
  }
}

export { LIMITS };
export { KeyNotFoundError, InvalidArgumentError, ClosedError, FileHandleError };
