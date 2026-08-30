/** Base class for every error this store throws. Lets callers do one catch. */
export class BitcaskError extends Error {}

/** Thrown by `get` when the key has never been written, or has been deleted. */
export class KeyNotFoundError extends BitcaskError {
  constructor(key: Buffer) {
    super(`key not found: ${JSON.stringify(key.toString("latin1"))}`);
    this.name = "KeyNotFoundError";
  }
}

/** Thrown when a key or value violates the limits in LIMITS (see bitcask.ts). */
export class InvalidArgumentError extends BitcaskError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

/** Thrown when any operation is attempted on a store that has been closed. */
export class ClosedError extends BitcaskError {
  constructor() {
    super("store is closed");
    this.name = "ClosedError";
  }
}
