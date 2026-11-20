/* The canonical directory key and the process-local set of UNADDRESSED book
   directories (a book whose state.json carries no `bookId`, so no route can
   resolve it and no `book-op:<bookId>` lock can name it).

   Design of record: docs/superpowers/specs/2026-11-13-chapter-take-lifecycle-design.md
     - R5-7 / R6-6: `withBookOpAtDir`'s no-`bookId` branch registers the folder
       here for the span of its callback; a second holder of the same folder is
       refused, and the take module refuses a `BookHandle` whose folder is in
       the set.
     - R7-11: the key is canonical (resolved, `/`-separated, no trailing
       separator, case-folded on win32 and darwin). Unicode normalisation is out
       of scope by design.
     - R9-6: this is a LEAF. It imports `node:path` and nothing else, so the
       lock module, the take module and the movers can all share one key
       without a cycle. */
import path from 'node:path';

/** The one spelling of a directory every holder compares. Lower-cased only
 *  where the filesystem is case-insensitive by default (win32, darwin). */
export function canonicalDirKey(dir: string): string {
  const BS = String.fromCharCode(92);
  let key = path.resolve(dir).split(BS).join('/');
  /* Collapse any run of separators (a UNC prefix keeps its leading pair), then
     drop a trailing one that is not the root. */
  const unc = key.startsWith('//');
  key = key.replace(/\/{2,}/g, '/');
  if (unc) key = `/${key}`;
  if (key.length > 1 && key.endsWith('/') && !/^[A-Za-z]:\/$/.test(key)) key = key.slice(0, -1);
  if (process.platform === 'win32' || process.platform === 'darwin') key = key.toLowerCase();
  return key;
}

const unaddressedDirs = new Set<string>();

/** Add `dir` to the set. Returns `false` (and changes nothing) when the folder
 *  is already registered: a second unaddressed holder is refused. */
export function registerUnaddressedDir(dir: string): boolean {
  const key = canonicalDirKey(dir);
  if (unaddressedDirs.has(key)) return false;
  unaddressedDirs.add(key);
  return true;
}

export function releaseUnaddressedDir(dir: string): void {
  unaddressedDirs.delete(canonicalDirKey(dir));
}

export function isUnaddressedDir(dir: string): boolean {
  return unaddressedDirs.has(canonicalDirKey(dir));
}
