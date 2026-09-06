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

/** Thrown when a record's checksum does not match the bytes it covers. */
export class CorruptRecordError extends BitcaskError {
  constructor(message: string) {
    super(message);
    this.name = "CorruptRecordError";
  }
}

/** Thrown when a buffer ends before the record inside it does. */
export class TruncatedRecordError extends BitcaskError {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedRecordError";
  }
}
