/* Per-book write lock shared by the chapter-restructure routes and the
   book-state PUT (#3400). A leaf module: imports nothing, so any route can
   take it without closing an import cycle.

   Lock order: this is the OUTERMOST per-book lock. Restructure takes the
   per-book `revisions` lock (a leaf) beneath it; the state PUT takes it only
   around its `state` / `manuscript` slices, which take no other lock. Never
   acquire it while holding `cast`, `design`, `library-voice` or `revisions`,
   and never call a function that takes it from inside `fn` from a DIFFERENT
   async context — but see "held-lock awareness" below.

   Held-lock awareness (scan self-heal): the workspace scan's self-heal writes
   (`backfillAudioModelKeysFromSegments`, the uuid mint) take this lock too, and
   they run both bare AND from inside a handler that already holds it (the
   state PUT, `applyRestructure`). The lock is a promise chain, so a second
   acquisition of the same book from inside `fn` would wait on itself forever.
   An AsyncLocalStorage set of held book ids makes `withBookLock` run `fn`
   inline when the current async context already holds that book — nested
   acquisition is a no-op, never a deadlock. Work detached from the holder's
   async context (not awaited by it) sees no store and queues normally. */

import { AsyncLocalStorage } from 'node:async_hooks';

/* Per-book write lock — serialises concurrent requests on the same book so the
   three-file write order (state.json → manuscript-edits.json → in-memory
   hints) can't interleave between requests. Lock is held for the duration of
   one handler call; releases happen in finally{} so a throw inside the handler
   doesn't leak. */
const bookWriteLock = new Map<string, Promise<void>>();

const heldBooks = new AsyncLocalStorage<ReadonlySet<string>>();

export async function withBookLock<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
  const held = heldBooks.getStore();
  if (held?.has(bookId)) return fn();
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
    return await heldBooks.run(new Set([...(held ?? []), bookId]), fn);
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
