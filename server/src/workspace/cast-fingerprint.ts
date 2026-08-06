/* #2015 — the compare-and-set primitive for cast.json's merge base.
   Deliberately knows nothing about locks, routes or SSE: it reads bytes and
   hashes them, and predicts the hash writeJsonAtomic will produce. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** "No file is expected to exist right now" — a POSITIVE observation, not an
    absence of information. Distinct from `null`, which means "I cannot check".
    Collapsing the two disables detection on every Start-fresh run (design
    §1a), which is the single most important case.

    The NUL prefix makes collision with a real sha256 hex digest impossible by
    construction, so `observed !== baseline` needs no special-casing at the
    comparison sites. */
export const ABSENT = '\0ABSENT' as const;

/** "The read failed for a reason that says nothing about the file's
    contents" — a NOT-CHECKABLE result, distinct from both `ABSENT` (the file
    is confirmed missing) and `null` (detection disabled for this run, see
    `CastMergeBase`). An `EBUSY`/`EPERM`/`EACCES`/`EMFILE` mid-analysis (an AV
    scanner, OneDrive, or the Windows indexer briefly locking `cast.json`)
    says "I cannot check right now" — collapsing it into `ABSENT` turns a
    transient I/O blip into a false "someone else edited your cast" advisory
    (#2185 review). A comparison site must skip the comparison entirely on
    this value, never treat it as a mismatch against the baseline.

    Same NUL-prefix collision guard as `ABSENT`, with a distinct suffix so the
    two can never be confused with each other either. */
export const UNREADABLE = '\0UNREADABLE' as const;

/** Three states, never two — see design §1a. */
export type CastFingerprint = string | typeof ABSENT | null;

/** Render a fingerprint value for a log line. The NUL-prefixed `ABSENT`
    encoding exists purely as an internal collision guard (see the comment
    above) — it must never reach a log consumer raw, since a leading 0x00
    byte truncates some log pipelines right after `expected=`/`observed=`.
    Everything else is a real sha256 hex digest; a 12-char prefix is enough
    to eyeball a match without spamming the log line. Takes a plain `string`
    (not `CastFingerprint`) because callers here already hold the
    `String(...)`-converted conflict fields, not the typed union. */
export function describeFingerprintForLog(value: string): string {
  return value === ABSENT ? 'ABSENT' : value.slice(0, 12);
}

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
  try {
    return { value: JSON.parse(raw) as T, fingerprint };
  } catch {
    return { value: null, fingerprint };
  }
}

/** The fingerprint `writeJsonAtomic` will produce for `value` — mirrors its
    `JSON.stringify(value, null, 2)` serialisation exactly (state-io.ts:111).

    Computed from the payload rather than by re-reading the file, so advancing
    the baseline after a write costs no syscall and cannot observe a THIRD
    party's write as if it were our own. `cast-fingerprint.test.ts` pins the
    two serialisations together; if writeJsonAtomic changes, that test fails
    rather than this silently drifting. */
export function fingerprintOfWrite(value: unknown): string {
  return hashBytes(JSON.stringify(value, null, 2));
}
