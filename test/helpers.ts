import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Every directory the tests create goes under <repo>/.tmp */
const ROOT = resolve(import.meta.dirname, "..", ".tmp");

/** Paths returned by tmpdir(), kept so cleanup() knows what to delete. */
const handedOut: string[] = [];

/**
 * Creates a new empty directory and returns its path.
 * Call cleanup() when the tests are done to delete it.
 */
export async function tmpdir(): Promise<string> {
  await mkdir(ROOT, { recursive: true });
  const dir = await mkdtemp(join(ROOT, "bc-"));
  handedOut.push(dir);
  return dir;
}

/**
 * Returns a path to a directory that does not exist yet.
 * Used to check that open() creates the directory itself.
 */
export async function unusedPath(): Promise<string> {
  return join(await tmpdir(), "nested", "store");
}

/** Deletes every directory that tmpdir() created. */
export async function cleanup(): Promise<void> {
  await Promise.all(handedOut.map((d) => rm(d, { recursive: true, force: true })));
  handedOut.length = 0;
}

/**
 * Makes a Buffer.
 * Pass a string to get its UTF-8 bytes, or an array of numbers to get those
 * exact bytes.
 */
export function b(s: string | number[]): Buffer {
  return typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s);
}
