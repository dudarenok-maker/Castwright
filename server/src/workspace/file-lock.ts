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
   forever. Bound the wait instead. A cast.json read-modify-write is
   sub-second, and clearLibraryVoiceReferences takes one cast lock per book,
   serially, each also sub-second -- 15s is generous headroom above the
   longest legitimate critical section in this codebase while still firing
   long before anyone watching a hung request would give up and go looking
   for a log line. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;

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
      reject(new Error(
        `withKeyLock: timed out after ${timeoutMs}ms waiting to acquire "${key}" -- ` +
          'likely a cast-lock.ts rule 1 (locked fn re-entering a locked fn on the ' +
          'same key) or rule 4 (lock-order cycle across design/library-voice/cast) violation',
      ));
    }, timeoutMs);
    /* A pending timer keeps the event loop (and vitest) alive; unref so a
       cleared-on-happy-path timer is never the reason a process hangs at
       teardown (this repo already fights `Worker exited unexpectedly`). */
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
       once the actual holder finishes, the chain still resolves through us
       (our `gate` is already released) and everyone downstream proceeds
       normally. The entry is not a permanent leak either: the next caller
       to actually run `fn()` to completion deletes it in the `finally`
       below, same as always. */
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
