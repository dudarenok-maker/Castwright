/* Generic per-key promise-chain mutex. Same idiom as tts/design-lock.ts's
   withDesignLock, but keyed on an arbitrary string so callers (e.g. the
   listen-stats read-modify-write) get isolation without coupling to the
   voice-design busy registry. */
const chains = new Map<string, Promise<unknown>>();

/* #2260 — cast-lock.ts's header documents two rules whose violation deadlocks
   this mutex with no timeout and no diagnostic: rule 1 (a locked function
   re-entering a locked function on the same key) and rule 4 (acquiring an
   earlier lock class while holding a later one -- an AB/BA cycle across
   design -> library-voice -> cast). Either way the request just hangs
   forever. Bound the wait instead.

   WHAT THE BUDGET BOUNDS: queue wait ONLY -- everything ahead of you on this
   key, and nothing else. It does NOT bound your own critical section: the
   timer is cleared the instant you acquire, before fn() is called, so once you
   are in you may run as long as you like (review round 2, N1). The
   longest known holder is NOT a cast.json read-modify-write (sub-second): it
   is voice-library.ts's DELETE, which holds `library-voice:<uuid>` across
   scanLibraryVoiceUsage + clearLibraryVoiceReferences, i.e. two full walks of
   every confirmed book, O(N books x file I/O). A large enough library makes
   that the thing a concurrent /assign on the same uuid is queued behind. If
   this timeout ever starts firing on a healthy install, that is the call site
   to look at first -- raise the budget or shorten that critical section; do
   not assume a lock-rule violation.

   WHY 10s AND NOT 15s: vitest's testTimeout is 15_000 in BOTH server configs.
   At 15s the two deadlines race in the same event-loop turn, and when vitest
   wins, the failure reads `Test timed out in 15000ms` -- no key, no rule
   pointer, i.e. exactly the diagnostic-free hang this change exists to
   remove, delivered in the first place a maintainer would meet it. 10s breaks
   the tie for a SINGLE, un-nested acquisition -- and only for that case
   (review round 2, CB1). Nesting defeats it: each nested withKeyLock starts
   its own fresh 10s timer AFTER the outer one is acquired, so the budgets add
   rather than share a deadline. A 2-deep path whose outer acquisition takes
   9s reaches its inner deadline at ~19s, past vitest's 15s, and the
   diagnostic-free `Test timed out in 15000ms` wins after all. That is a known,
   accepted gap in the tie-break, NOT a reason to raise or lower the budget:
   no value fixes it, because the depth is unbounded (see below).

   NOTE the nesting rule (review round 2, N2 -- this is general, not a
   withCastLocks quirk): every nested acquisition adds one full budget, so the
   effective worst case is depth x this. withCastLocks chains one withKeyLock
   per book, so a two-book route is 2 deep; voice-library.ts's POST /assign
   takes `library-voice:<uuid>` then a cast lock, so it is 2 deep; and its
   DELETE path holds `library-voice:<uuid>` while clearLibraryVoiceReferences
   takes a cast lock per confirmed book, so it is N+1 deep for N books. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;

/** Stable discriminator carried by `LockAcquisitionTimeoutError`. */
export const LOCK_ACQUISITION_TIMEOUT_CODE = 'ELOCKACQUIRETIMEOUT';

/* #2260 review round 2 -- the timeout used to throw a bare `Error`, which gave
   the best-effort `catch` blocks around the cast-identity writes (analysis.ts,
   cast-merge.ts, not-linked-edges.ts) no way to tell an expiry apart from the
   EPERM/ENOSPC/AV-lock they are deliberately scoped to swallow. Swallowing an
   expiry is strictly worse than the hang it replaced: the route returns 200
   with cast.json already written and the retirement never recorded -- the
   exact identity-of-record divergence CLAUDE.md's #2040 convention exists to
   prevent, silently. So the expiry gets a shape those handlers can single out.

   WHY A NAMED SUBCLASS *AND* an exported predicate, rather than either alone:
   the subclass matches the existing precedent in this repo
   (`CastIdHistoryUnreadableError`, store/cast-id-history.ts), keeps the class
   greppable, and carries `key`/`timeoutMs` for a handler that wants them. But
   the swallow sites discriminate through `isLockAcquisitionTimeout`, which
   tests the stable `code` STRING and deliberately NOT `instanceof`. Every
   consumer of this is a `catch` that swallows by default, so an `instanceof`
   that fails to match -- two copies of this module under vitest's per-file
   module registry, or a future dual ESM/CJS load -- fails OPEN: the expiry is
   swallowed again and we are back to the silent 200. A string-`code` check has
   no such failure mode. `code` cannot collide with the fs errors these
   handlers still swallow (`EPERM`, `ENOSPC`, `EBUSY`, ...). */
export class LockAcquisitionTimeoutError extends Error {
  readonly code: string = LOCK_ACQUISITION_TIMEOUT_CODE;
  readonly key: string;
  readonly timeoutMs: number;

  constructor(key: string, timeoutMs: number) {
    super(
      `withKeyLock: timed out after ${timeoutMs}ms waiting to acquire "${key}" -- ` +
        'either a cast-lock.ts rule 1 (locked fn re-entering a locked fn on the ' +
        'same key) or rule 4 (lock-order cycle across design/library-voice/cast) ' +
        'violation, OR ordinary contention behind a legitimately long holder on ' +
        'this key (see the budget note above). Check for a long holder before ' +
        'hunting a rule violation -- both reach here',
    );
    this.name = 'LockAcquisitionTimeoutError';
    this.key = key;
    this.timeoutMs = timeoutMs;
  }
}

/** True for a `withKeyLock` acquisition expiry. Checks the `code` string, not
 *  `instanceof` -- see `LockAcquisitionTimeoutError`'s comment for why that
 *  distinction is load-bearing at a swallow site. */
export function isLockAcquisitionTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === LOCK_ACQUISITION_TIMEOUT_CODE
  );
}

export async function withKeyLock<T>(
  key: string,
  fn: () => Promise<T>,
  /** Test-only override for DEFAULT_ACQUIRE_TIMEOUT_MS -- no production
      caller passes this. */
  timeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  /* `mine` is what goes in the map. The old code compared against `gate`, which
     is never what was stored, so this delete never ran and the map grew one
     entry per key for the process lifetime. */
  const mine = prior.then(() => gate, () => gate);
  chains.set(key, mine);

  let timer!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new LockAcquisitionTimeoutError(key, timeoutMs));
    }, timeoutMs);
    /* A pending timer keeps the event loop (and vitest) alive; unref so a
       cleared-on-happy-path timer is never the reason a process hangs at
       teardown (this repo already fights `Worker exited unexpectedly`).
       The other direction is worth knowing too: this is a real setTimeout, so
       it IS faked under vi.useFakeTimers(). A test that fakes timers, contends
       a lock and advances past the budget will now see the waiter reject where
       it previously just waited. Nothing does that today (cast-design.test.ts
       advances 7000ms, under the budget). */
    timer.unref();
  });

  try {
    await Promise.race([prior.catch(() => undefined), timedOut]);
  } catch (err) {
    /* Never fall through to fn() on expiry -- that would run the critical
       section without ever having held the lock, defeating the mutex
       outright. Do release the gate -- our own critical section never ran,
       so nothing depends on us holding it open -- but do NOT delete `mine`
       from `chains`: whoever is still ahead of us (the actual holder, or an
       earlier waiter) is still the current tail as far as the map is
       concerned, and deleting it would let the NEXT caller read `undefined`
       from `chains.get(key)`, skip waiting entirely, and run concurrently
       with whoever is still inside `fn()` -- the exact unlocked-write race
       this mutex exists to prevent (cast-lock.race.test.ts). A late waiter
       just chains onto `mine` the same way it would have chained onto us;
       IF the actual holder finishes, the chain still resolves through us
       (our `gate` is already released) and everyone downstream proceeds
       normally. If it never finishes, everyone downstream now waits their
       own budget and throws -- one key degraded loudly, which is the trade
       this change is making against a permanent silent hang.

       On the map entry, precisely (it is NOT self-cleaning, and an earlier
       version of this comment claimed it was): the holder ahead of us will
       NOT remove our entry when it finishes, because its own `finally`
       guards on `chains.get(key) === its mine` and the map now holds ours.
       So `mine` stays until some later caller overwrites it and runs `fn()`
       to completion. If no later caller ever takes this key, it stays for
       the process lifetime.

       What "bounded" does and does not mean here (review round 2, CB4 -- an
       earlier version of this said "one resolved, inert entry", and BOTH of
       those words were wrong in the case that matters). The MAP is bounded at
       one entry per key, but that is a property of `Map`, not of anything this
       code does. The entry itself is only resolved and inert in the BENIGN
       branch, where the holder ahead eventually finishes: `prior` settles,
       `mine` resolves, and nothing is left attached to it. In the DEADLOCK
       branch -- the case this timeout exists for -- `prior` never settles, so
       `mine` stays PENDING for the process lifetime and every further caller
       on this key chains another reaction record onto it before timing out in
       turn. Those records accumulate, unbounded in the number of callers,
       even though the map still shows one entry. That is a slow leak on an
       already-broken key, and we accept it: deleting the entry is what breaks
       mutual exclusion, and the two are not both available. Pinned (benign
       branch only) by the `__chainsSizeForTest` case in file-lock.test.ts. */
    clearTimeout(timer);
    release();
    throw err;
  }
  clearTimeout(timer);

  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === mine) chains.delete(key);
  }
}

/** Test-only: the number of live chain entries. Used to pin the cleanup in
 *  Task 3 — NOT a partition detector (design §10.3 explains why that idea was
 *  rejected). */
export function __chainsSizeForTest(): number {
  return chains.size;
}
