import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

// import.meta.dirname is the folder this file lives in, so ROOT is <repo>/.tmp
const ROOT = resolve(import.meta.dirname, "..", ".tmp");

// Every directory we hand out, remembered so cleanup() can delete them all.
const handedOut: string[] = [];

/**
 * A brand new empty directory to point a store at.
 * Call cleanup() in an afterAll() to delete them.
 */
export async function tmpdir(): Promise<string> {
  await mkdir(ROOT, { recursive: true });
  const dir = await mkdtemp(join(ROOT, "bc-"));
  handedOut.push(dir);
  return dir;
}

/** A path that does NOT exist yet (its grandparent does). */
export async function unusedPath(): Promise<string> {
  return join(await tmpdir(), "nested", "store");
}

/** Delete every directory tmpdir() handed out. */
export async function cleanup(): Promise<void> {
  await Promise.all(handedOut.map((d) => rm(d, { recursive: true, force: true })));
  handedOut.length = 0;
}

/**
 * Shorthand for making Buffers so the tests stay readable.
 *   b("hello")          -> the 5 UTF-8 bytes of "hello"
 *   b([0xde, 0xad])     -> those 2 raw bytes
 */
export function b(s: string | number[]): Buffer {
  return typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s);
}
