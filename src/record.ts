import { OFFSETS } from "./constants.ts";
import {
  InvalidArgumentError,
  CorruptRecordError,
  TruncatedRecordError,
} from "./errors.ts";
import { isValidBufferKey, isValidValueBuffer } from "./utils.ts";
import { crc32 } from "node:zlib";

/**
 * On-disk layout of one record. All integers are little-endian.
 *
 *   offset  size  field
 *   0       4     crc         checksum of every byte from offset 4 onwards
 *   4       8     timestamp   milliseconds since the epoch
 *   12      2     keySize
 *   14      4     valueSize
 *   18      ks    key
 *   18+ks   vs    value
 *
 * Total size is HEADER_SIZE + keySize + valueSize.
 */
export const HEADER_SIZE = 18;

/** One record, as returned by decode(). */
export interface DecodedRecord {
  key: Buffer;
  value: Buffer;
  /** Milliseconds since the epoch. */
  timestamp: number;
  /** Total bytes this record occupied, header included. */
  length: number;
}

/**
 * Serialises one record.
 *
 * `timestamp` defaults to now. The spec for this stage is in docs/stage-01.md.
 */
export function encode(
  key: Buffer,
  value: Buffer,
  timestamp: number = Date.now(),
): Buffer {
  // Validate input key buffer
  if (!isValidBufferKey(key))
    throw new InvalidArgumentError(
      "The supplied key is either empty or invalid",
    );

  // Validate input value buffer
  if (!isValidValueBuffer(value))
    throw new InvalidArgumentError("The supplied value is invalid");

  // header = checksum (crc32) + timestamp + keySize + valueSize
  // record = header + key + value
  const totalSizeOfRecord = HEADER_SIZE + key.length + value.length;
  const record = Buffer.alloc(totalSizeOfRecord);

  // write timestamp (8 bytes) to buffer
  record.writeBigUInt64LE(BigInt(timestamp), OFFSETS.TIMESTAMP);
  // write keySize (2 bytes) to buffer
  record.writeUInt16LE(key.length, OFFSETS.KEY_SIZE);
  // write valueSize (4 bytes) to buffer
  record.writeUInt32LE(value.length, OFFSETS.VALUE_SIZE);
  // write key to buffer
  record.set(key, HEADER_SIZE);
  // write value to buffer
  record.set(value, HEADER_SIZE + key.length);

  // Compute and write checksum
  const recordChecksum = crc32(record.subarray(OFFSETS.TIMESTAMP));
  record.writeUInt32LE(recordChecksum, OFFSETS.CRC);

  return record;
}

/**
 * Reads the record that starts at `offset`.
 *
 * `buf` is any slice of a data file. It may hold part of a record, exactly one,
 * or many; only the one beginning at `offset` is read and the rest is ignored.
 *
 * Throws TruncatedRecordError if the buffer ends early, CorruptRecordError if
 * the checksum does not match.
 */
export function decode(buf: Buffer, offset: number = 0): DecodedRecord {
  // Basic Buffer validation
  if (!Buffer.isBuffer(buf))
    throw new InvalidArgumentError("Invalid argument buffer");

  // Validation over basic header bytes
  if (buf.length - offset < HEADER_SIZE)
    throw new TruncatedRecordError("Record is truncated below header");

  // Extract header info
  const checksum = buf.readUInt32LE(offset + OFFSETS.CRC);
  const timestamp = Number(buf.readBigUInt64LE(offset + OFFSETS.TIMESTAMP));
  const keySize = buf.readUInt16LE(offset + OFFSETS.KEY_SIZE);
  const valueSize = buf.readUInt32LE(offset + OFFSETS.VALUE_SIZE);
  const expectedRecordSize = HEADER_SIZE + keySize + valueSize;

  // Total buffer size validation
  if (buf.length - offset < expectedRecordSize)
    throw new TruncatedRecordError("Record is truncated");

  // Data Integrity validation
  if (
    checksum !==
    crc32(buf.subarray(offset + OFFSETS.TIMESTAMP, offset + expectedRecordSize))
  )
    throw new CorruptRecordError("Buffer is corrupted");

  const key = Buffer.from(
    buf.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + keySize),
  );

  const value = Buffer.from(
    buf.subarray(
      offset + HEADER_SIZE + keySize,
      offset + HEADER_SIZE + keySize + valueSize,
    ),
  );

  return {
    key: key,
    value: value,
    timestamp: timestamp,
    length: expectedRecordSize,
  };
}

export { OFFSETS };
export { InvalidArgumentError, CorruptRecordError, TruncatedRecordError };
