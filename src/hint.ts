import { encode, decode } from "./record.ts";

/**
 * A hint file is the index for one data file with the values left out: one
 * entry per record, holding what the keydir needs and nothing more. Rebuilding
 * from hints reads a few percent of the bytes that replaying the data file does.
 *
 * An entry is an ordinary record whose value is the bookkeeping, so the walk,
 * the key length prefix and the checksum all come from the record format:
 *
 *   crc(4) timestamp(8) keySize(2) valueSize(4) | key | offset(8) totalSize(4)
 *
 * The record's timestamp field carries the record's timestamp. `fileId` is not
 * stored because it is the name of the file the hint sits next to.
 */
const PAYLOAD_SIZE = 12;

/** One entry of a hint file, as returned by decodeHintFile(). */
export interface HintEntry {
  key: Buffer;
  offset: number;
  totalSize: number;
  timestamp: number;
}

/** Serialises the keydir entry for one record. */
export function encodeHintEntry(
  key: Buffer,
  metadata: { offset: number; totalSize: number; timestamp: number },
): Buffer {
  const payload = Buffer.alloc(PAYLOAD_SIZE);
  payload.writeBigUInt64LE(BigInt(metadata.offset), 0);
  payload.writeUInt32LE(metadata.totalSize, 8);
  return encode(key, payload, metadata.timestamp);
}

/**
 * Reads a whole hint file.
 *
 * A hint file is a cache, never a source of truth, so anything wrong with it
 * returns null and the caller reads the data file instead. Wrong means junk,
 * empty, cut short, or ending anywhere but on an entry boundary.
 */
export function decodeHintFile(bytes: Buffer): HintEntry[] | null {
  if (bytes.length === 0) return null;

  const entries: HintEntry[] = [];
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const record = decode(bytes, offset);

      // A record that decodes but carries the wrong payload is not a hint.
      if (record.value.length !== PAYLOAD_SIZE) return null;

      entries.push({
        key: record.key,
        offset: Number(record.value.readBigUInt64LE(0)),
        totalSize: record.value.readUInt32LE(8),
        timestamp: record.timestamp,
      });
      offset += record.length;
    }
  } catch {
    // Truncated or corrupt: the whole file is unusable, not just the tail.
    return null;
  }

  return entries;
}
