/* Per-book write lock shared by the chapter-restructure routes and the
   book-state PUT (#3400). A leaf module: imports nothing, so any route can
   take it without closing an import cycle.

   Lock order (global, reconciled with #3711): `design` -> `library-voice` ->
   `book-op` -> `book-path-claim` -> `cast` -> `book` -> `state-json` (a leaf),
   with `revisions` a separate leaf beside it. `book-op` (book-op-lock.ts) is the
   operation-and-move lock; this one is always taken INSIDE it (or by a path
   that holds no book-op, such as the scan heal), and no holder of this lock
   ever takes `book-op` -- `moveBookFolder` takes this lock itself, inside the
   path claim. `book` is
   taken while holding `cast` (the cast merge's manuscript-edits.json rewrite,
   and the scan heal reached from a cast-lock holder) and NEVER the other way
   round -- no holder of this lock may take `cast`, `design` or `library-voice`
   (the chapter restructure, the state PUT's `state` / `manuscript` slices and
   every `book-state-update.ts` writer take nothing but `state-json` /
   `revisions` beneath it). Never acquire it while holding `state-json` or
   `revisions`, and never call a function that takes it from inside `fn` from a
   DIFFERENT async context -- but see "held-lock awareness" below.
   `state-json` is `withStateJsonLock` (file-lock.ts, #3700): the leaf around the
   fresh re-read + write of one `state.json`, taken INSIDE this lock (or alone by
   the render-finalize paths, which hold no `book`). This lock is the
   operation-level outer one -- it serialises a whole read -> multi-file write
   against a restructure; `state-json` is the bounded (10s) inner one that keeps
   a sibling render's stamp from being reverted.
   Every `state.json` read-modify-write goes through both (`book-state-update.ts`,
   enforced by `state-lock.guard.test.ts` and `state-json-lock.guard.test.ts`).

   Held-lock awareness (scan self-heal): the workspace scan's self-heal writes
   (`backfillAudioModelKeysFromSegments`, the uuid mint) take this lock too, and
   they run both bare AND from inside a handler that already holds it (the
   state PUT, `applyRestructure`). The lock is a promise chain, so a second
   acquisition of the same book from inside `fn` would wait on itself forever.
   An AsyncLocalStorage map of held book ids makes `withBookLock` run `fn`
   inline when the current async context already holds that book — nested
   acquisition is a no-op, never a deadlock. AsyncLocalStorage also flows into
   work the holder spawns and does NOT await (a timer, a floating promise), so
   each hold carries a `live` token cleared when the holder settles: detached
   work that outlives its holder sees a dead token and queues like anyone else
   instead of running its locked section unlocked. */

import { AsyncLocalStorage } from 'node:async_hooks';

/* Per-book write lock — serialises concurrent requests on the same book so the
   three-file write order (state.json → manuscript-edits.json → in-memory
   hints) can't interleave between requests. Lock is held for the duration of
   one handler call; releases happen in finally{} so a throw inside the handler
   doesn't leak. */
const bookWriteLock = new Map<string, Promise<void>>();

interface Hold {
  live: boolean;
}

const heldBooks = new AsyncLocalStorage<ReadonlyMap<string, Hold>>();

export async function withBookLock<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
  const held = heldBooks.getStore();
  if (held?.get(bookId)?.live) return fn();
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
  const hold: Hold = { live: true };
  const mine = prev.then(() => next);
  bookWriteLock.set(bookId, mine);
  try {
    await prev;
    return await heldBooks.run(new Map([...(held ?? []), [bookId, hold]]), fn);
  } finally {
    hold.live = false;
    release();
    // Best-effort cleanup: if no further requests queued behind us, drop
    // the entry so the map doesn't grow unboundedly over a long server
    // lifetime.
    if (bookWriteLock.get(bookId) === mine) {
      bookWriteLock.delete(bookId);
    }
  }
}
