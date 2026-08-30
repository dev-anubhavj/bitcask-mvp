/** Parent of every error below. Catch this one to catch all of them. */
export class BitcaskError extends Error {}

/** Thrown when a key is not in the store. */
export class KeyNotFoundError extends BitcaskError {
  constructor(key: Buffer) {
    super(`key not found: ${JSON.stringify(key.toString("latin1"))}`);
    this.name = "KeyNotFoundError";
  }
}

/** Thrown when a key or value is the wrong type, empty, or too big. */
export class InvalidArgumentError extends BitcaskError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

/** Thrown when a method is called after the store was closed. */
export class ClosedError extends BitcaskError {
  constructor() {
    super("store is closed");
    this.name = "ClosedError";
  }
}
