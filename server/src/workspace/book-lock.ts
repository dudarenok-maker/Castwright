/* Per-book write lock shared by the chapter-restructure routes and the
   book-state PUT (#3400). A leaf module: imports nothing, so any route can
   take it without closing an import cycle.

   Lock order: this is the OUTERMOST per-book lock. Restructure takes the
   per-book `revisions` lock (a leaf) beneath it; the state PUT takes it only
   around its `state` / `manuscript` slices, which take no other lock. Never
   acquire it while holding `cast`, `design`, `library-voice` or `revisions`,
   and never call a function that takes it from inside `fn` (not re-entrant). */

/* Per-book write lock — serialises concurrent requests on the same book so the
   three-file write order (state.json → manuscript-edits.json → in-memory
   hints) can't interleave between requests. Lock is held for the duration of
   one handler call; releases happen in finally{} so a throw inside the handler
   doesn't leak. */
const bookWriteLock = new Map<string, Promise<void>>();

export async function withBookLock<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
  const prev = bookWriteLock.get(bookId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `mine` is what actually goes in the map. The old code compared the
  // cleanup below against `prev.then(() => next)` called a second time —
  // `.then()` always returns a new Promise object, so that comparison was
  // never equal to what was stored and this delete never ran: the map grew
  // one entry per bookId for the process lifetime.
  const mine = prev.then(() => next);
  bookWriteLock.set(bookId, mine);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Best-effort cleanup: if no further requests queued behind us, drop
    // the entry so the map doesn't grow unboundedly over a long server
    // lifetime.
    if (bookWriteLock.get(bookId) === mine) {
      bookWriteLock.delete(bookId);
    }
  }
}
