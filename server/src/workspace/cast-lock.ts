/* Per-book cast.json write lock.
 *
 * cast.json carries every character's voice assignment and is the most-written
 * file in the workspace. Its writers are all read-modify-write: read the whole
 * file, change one character, write it all back. Two of those overlapping means
 * both read before either writes, and the later atomic rename wins outright —
 * the earlier mutation is gone, silently. Measured at 200/200 trials
 * (cast-lock.race.test.ts). An `await`-free window does NOT prevent this: the
 * read is itself the yield point.
 *
 * THE RULES (design §4 — keep these in sync with CLAUDE.md):
 *
 *   1. Lock the innermost read-through-write, never the caller. One level only.
 *      A locked function must not call another locked function on the same book.
 *   2. The read goes inside the lock, and so does every decision derived from
 *      it. Wrapping only the write buys nothing at all.
 *   3. Two or more books -> withCastLocks, never nested withCastLocks.
 *   4. Global lock order: design -> library-voice -> cast. Never acquire an
 *      earlier class while holding a later one. The DELETE library-voice path
 *      holds `library-voice:<uuid>` across clearLibraryVoiceReferences, which
 *      takes a cast lock per book — so POST /assign must take library-voice
 *      BEFORE its cast lock, not after. The other order is an AB/BA cycle on a
 *      mutex with no timeout and no diagnostic: both requests hang forever.
 *
 * WHAT THIS DOES NOT COVER: it protects one read-modify-write. It does NOT make
 * a validate-then-write safe when the validation and the write sit in different
 * lock scopes — analysis.ts's merge base (#2015) and the clone-consent gates
 * (#2006). Four designs for that have been attempted and none survived review;
 * do not add a fifth here without reading those issues first.
 *
 * #2015's merge-base half is now DETECTED rather than serialised (see
 * workspace/cast-merge-base.ts) — the validate/write window is deliberately
 * left exactly as wide as before, but a write landing inside it is no longer
 * silent. That is not a fifth attempt at the general problem this section
 * warns about: it does not try to make validate-then-write safe. The warning
 * above still stands, in full, for the #2006 half and for any attempt to
 * actually close the window rather than just see into it.
 *
 * Key derivation lives here and ONLY here. A site that derived the key slightly
 * differently would get a second mutex that never contends with the first, and
 * every test would still pass.
 */
import { castJsonPath } from './paths.js';
import { withKeyLock } from './file-lock.js';

/** Hold the cast.json lock for one book across a read-modify-write. */
export function withCastLock<T>(bookDir: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(castJsonPath(bookDir), fn);
}

/** Hold the cast.json lock for several books at once.
 *
 *  Dedupes, then sorts. Sorting makes AB/BA deadlock impossible by
 *  construction — argument order is caller-determined at the two-book routes.
 *  Deduping matters because library-cast-override can legitimately receive the
 *  same book twice (its guard rejects same-book AND same-character only), and a
 *  promise-chain mutex acquired twice on one key never releases. */
/* `async` deliberately: the empty-list guard below must surface as a REJECTED
   promise, not a synchronous throw. A sync throw fires while evaluating
   `expect()`'s argument, before `.rejects` can catch it, and the test fails
   instead of passing. */
export async function withCastLocks<T>(bookDirs: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(bookDirs.map(castJsonPath))].sort();
  /* reduceRight over an empty array returns `fn` unwrapped, which would run the
     critical section with no lock at all — fail loudly instead. */
  if (keys.length === 0) throw new Error('withCastLocks: no bookDirs given');
  const chained = keys.reduceRight<() => Promise<T>>(
    (next, key) => () => withKeyLock(key, next),
    fn,
  );
  return chained();
}

/** Hold the library-voice lock for one voice uuid.
 *
 *  Sits between `design` and `cast` in the global order (rule 4). Taken by the
 *  DELETE /voice-library/:voiceUuid path across scan -> clear -> erase, and by
 *  POST /:voiceUuid/assign around its own RMW — both sides must take it or it
 *  serialises nothing. */
export function withLibraryVoiceLock<T>(voiceUuid: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`library-voice:${voiceUuid}`, fn);
}
