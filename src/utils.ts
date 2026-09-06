import { LIMITS } from "./constants.ts";

/**
 * Validates that the supplied key is a valid buffer and within defined limits
 * @param key : The input key to be validated
 * @returns true if the key is a valid buffer, otherwise false
 */
export function isValidBufferKey(key: unknown): boolean {
  return (
    Buffer.isBuffer(key) && key.length > 0 && key.length <= LIMITS.MAX_KEY_SIZE
  );
}

/**
 * Validates that the supplied value is a valid buffer and within defined limits
 * @param value : The value to be validated
 * @returns true if the value is a valid buffer, otherwise false
 */
export function isValidValueBuffer(value: unknown): boolean {
  return Buffer.isBuffer(value) && value.length <= LIMITS.MAX_VALUE_SIZE;
}
