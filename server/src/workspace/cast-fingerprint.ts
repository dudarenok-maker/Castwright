/* #2015 — the single-read primitive behind `readPriorCastLockFree`.
   Deliberately knows nothing about locks, routes or SSE: it reads bytes,
   hashes them and parses them in one `readFile`. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** "No file is expected to exist right now" — a POSITIVE observation, not an
    absence of information. Distinct from `null`, which means "I cannot check".
    Collapsing the two disables detection on every Start-fresh run (design
    §1a), which is the single most important case.

    The NUL prefix makes collision with a real sha256 hex digest impossible by
    construction. */
export const ABSENT = '\0ABSENT' as const;

/** "The read failed for a reason that says nothing about the file's
    contents" — a NOT-CHECKABLE result, distinct from `ABSENT` (the file
    is confirmed missing). An `EBUSY`/`EPERM`/`EACCES`/`EMFILE` mid-analysis (an AV
    scanner, OneDrive, or the Windows indexer briefly locking `cast.json`)
    says "I cannot check right now" — collapsing it into `ABSENT` would turn a
    transient I/O blip into "no prior cast" (#2185 review); the reader throws
    instead.

    Same NUL-prefix collision guard as `ABSENT`, with a distinct suffix so the
    two can never be confused with each other either. */
export const UNREADABLE = '\0UNREADABLE' as const;

export function hashBytes(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Read a JSON file ONCE and return both the parsed value and the hash of the
    exact bytes that were parsed.

    Never two reads: `readJson` parses and discards the bytes, so hashing after
    a `readJson` would mean a second `readFile` — and a second read outside the
    same syscall pair reintroduces the very gap the caller's lock closes
    (design §1, implementation note).

    Unparseable bytes still get a hash. A malformed cast.json is a real on-disk
    state, and a later write must be able to notice it changing. */
export async function readJsonWithFingerprint<T>(
  path: string,
): Promise<{ value: T | null; fingerprint: string | typeof ABSENT | typeof UNREADABLE }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    /* Only a confirmed-missing file is ABSENT. Anything else (EBUSY, EPERM,
       EACCES, EMFILE, ...) on a file that may well be perfectly intact is
       UNREADABLE — "I cannot check", not "nothing is there". See the
       UNREADABLE doc comment above for why conflating the two is a bug, not
       a simplification. */
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { value: null, fingerprint: ABSENT };
    }
    return { value: null, fingerprint: UNREADABLE };
  }
  const fingerprint = hashBytes(raw);
  /* Strip a leading UTF-8 BOM (U+FEFF) if present — mirrors state-io.ts's
     readJson — but ONLY for the parse. The fingerprint above is computed
     over `raw` unmodified: it must hash exactly what writeJsonAtomic would
     have produced, and must not depend on whether a caller's own read strips
     a BOM before hashing. Windows editors and PowerShell 5.1's -Encoding
     utf8 write a BOM, so a hand-edited cast.json would otherwise fail to
     parse here and be treated as an empty prior cast. */
  const stripped = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
  try {
    return { value: JSON.parse(stripped) as T, fingerprint };
  } catch {
    return { value: null, fingerprint };
  }
}
