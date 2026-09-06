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

/** Byte offsets of the record header fields. */
export const OFFSETS = {
  CRC: 0,
  TIMESTAMP: 4,
  KEY_SIZE: 12,
  VALUE_SIZE: 14,
} as const;
