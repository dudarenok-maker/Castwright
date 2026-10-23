/* #3711 — `<workspace>/.staging/`: where a portable-bundle import lays a book
   down BEFORE it takes the path claim. It lives outside `books/` (so no scan or
   resolve ever sees a half-written book) and on the same volume (so the final
   placement is one directory rename). A crash mid-import leaves an orphan
   `<nonce>` directory behind; `sweepStaleStaging` removes those at startup. */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { WORKSPACE_ROOT } from './paths.js';

export const STAGING_ROOT = join(WORKSPACE_ROOT, '.staging');

/** An entry younger than this may belong to a LIVE import and is kept. */
export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

/** Create and return a fresh, private staging directory. */
export async function makeStagingDir(): Promise<string> {
  const dir = join(STAGING_ROOT, nanoid(12));
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Remove `.staging/` entries older than `maxAgeMs`. One `readdir` when there is
 *  nothing to do; never throws (a sweep must not stop the server booting). It
 *  runs BEFORE the server listens, so no import is in flight to be collateral. */
export async function sweepStaleStaging(
  maxAgeMs: number = STAGING_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(STAGING_ROOT);
  } catch {
    return removed;
  }
  for (const name of names) {
    const entry = join(STAGING_ROOT, name);
    try {
      const { mtimeMs } = await stat(entry);
      if (now - mtimeMs <= maxAgeMs) continue;
      await rm(entry, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      console.warn(`[staging] could not sweep ${name}:`, (err as Error).message);
    }
  }
  return removed;
}
