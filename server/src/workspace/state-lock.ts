/* Per-book state.json write lock (#3625).
 *
 * WHAT IT PROTECTS: every state.json read-modify-write, for ONE book. The
 * writers read the whole file, change one thing (e.g. one chapter's stamp) and
 * write it all back through `writeStateJsonAtomic`. Two of those overlapping
 * means both read before either writes, and the later atomic rename wins
 * outright — the earlier writer's change is gone, silently. This is the same
 * race cast-lock.ts closes for cast.json (see cast-lock.race.test.ts); an
 * `await`-free window does NOT prevent it, because the read is itself the
 * yield point.
 *
 * THE RULES (keep in sync with cast-lock.ts and CLAUDE.md):
 *
 *   1. Lock the innermost read-through-write: wrap exactly the span from the
 *      state.json read to the state.json write. One level only.
 *   2. The read goes inside the lock, and so does every decision derived from
 *      it. Re-read state.json inside the callback and build the next document
 *      from THAT read, never from a snapshot taken earlier. Wrapping only the
 *      write buys nothing. Slow work (parse, ffmpeg, network, renames) stays
 *      OUTSIDE: do it first, then lock, re-read, apply, write.
 *
 * LOCK ORDER: `revision-op` -> `state` -> `revisions`.
 *   - While holding `state`, acquire no lock except `revisions`. In particular
 *     never call withCastLock/withCastLocks, withLibraryVoiceLock,
 *     withDesignLock, a revision-op lock, or withStateLock again —
 *     `withKeyLock` is not re-entrant, so a nested same-key acquire waits on
 *     itself and throws after its 10s timeout.
 *   - Never take `state` while holding `revisions`.
 *   - `state` MAY be taken while holding `design`, `library-voice`, `cast` or
 *     `revision-op`; the reverse (taking any of those while holding `state`)
 *     is forbidden.
 *   - The `findBookBy*` / scan helpers (findBookByBookId, findBookByManuscriptId,
 *     findBookBy, scanLibrary, scanSeriesBooks, scanBook, collectBooks,
 *     backfillAudioModelKeysFromSegments) must not be called inside a hold:
 *     they take the state lock themselves, so calling one inside a hold
 *     self-deadlocks into the 10s timeout.
 *
 * A TIMEOUT NEVER REACHES A CLIENT AS-IS: `LockAcquisitionTimeoutError`'s
 * message names the lock key, which embeds the ABSOLUTE workspace path. Callers
 * curate what they surface (`requestFailureMessage`, or
 * `classifyAnalysisFailure` for analysis jobs) and log the raw error. Detect
 * the class with `isLockAcquisitionTimeout`, never `instanceof`.
 *
 * Key derivation lives here and ONLY here. A site that derived the key
 * slightly differently would get a second mutex that never contends with the
 * first, and every test would still pass.
 */
import { resolve } from 'node:path';
import { withKeyLock } from './file-lock.js';

/** The lock key for one book's state.json. Normalised with `resolve` so two
 *  spellings of one bookDir can never split the lock (same shape as
 *  `revisionsLockKey`). */
export function stateLockKey(bookDir: string): string {
  return `state:${resolve(bookDir)}`;
}

/** Hold the state.json lock for one book across a read-modify-write. */
export function withStateLock<T>(bookDir: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(stateLockKey(bookDir), fn);
}
