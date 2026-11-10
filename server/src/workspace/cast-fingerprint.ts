/* #2015 — the single-read primitive behind `readPriorCastLockFree`.
   Deliberately knows nothing about locks, routes or SSE: it reads and parses
   in one `readFile`, and says whether the file was read, confirmed missing,
   or could not be read. (Plan 291 deleted the compare-and-set merge base that
   the bytes' hash fed, so the hash is gone; the file keeps its name.) */
import { readFile } from 'node:fs/promises';

/** "No file is expected to exist right now" — a POSITIVE observation, not an
    absence of information. Distinct from `UNREADABLE`, which means "I cannot
    check". The NUL prefix keeps it apart from any ordinary status string. */
export const ABSENT = '\0ABSENT' as const;

/** "The read failed for a reason that says nothing about the file's
    contents" — a NOT-CHECKABLE result, distinct from `ABSENT` (the file
    is confirmed missing). An `EBUSY`/`EPERM`/`EACCES`/`EMFILE` mid-analysis (an AV
    scanner, OneDrive, or the Windows indexer briefly locking `cast.json`)
    says "I cannot check right now" — collapsing it into `ABSENT` would turn a
    transient I/O blip into "no prior cast" (#2185 review); the reader throws
    instead.

    Same NUL-prefix guard as `ABSENT`, with a distinct suffix so the two can
    never be confused with each other either. */
export const UNREADABLE = '\0UNREADABLE' as const;

/** The file was read (its bytes may still fail to parse: `value` is then null). */
export const READ = 'read' as const;

/** Read a JSON file ONCE and return the parsed value and the read's status.
    Unparseable bytes are `READ` with a null value: a malformed cast.json is a
    real on-disk state, distinct from a missing or unreadable one. */
export async function readJsonWithStatus<T>(
  path: string,
): Promise<{ value: T | null; status: typeof READ | typeof ABSENT | typeof UNREADABLE }> {
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
      return { value: null, status: ABSENT };
    }
    return { value: null, status: UNREADABLE };
  }
  /* Strip a leading UTF-8 BOM (U+FEFF) if present — mirrors state-io.ts's
     readJson. Windows editors and PowerShell 5.1's -Encoding utf8 write a BOM,
     so a hand-edited cast.json would otherwise fail to parse here and be
     treated as an empty prior cast. */
  const stripped = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
  try {
    return { value: JSON.parse(stripped) as T, status: READ };
  } catch {
    return { value: null, status: READ };
  }
}
