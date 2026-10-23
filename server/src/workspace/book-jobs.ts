/* #3711 — the long-job busy registry. A LEAF: imports nothing from `routes/`.
   Design of record: docs/features/288-book-op-lock.md "Busy registry".

   A long job (render, scoring, analysis, design, script-review, export) holds NO
   book-op while it runs; it registers a token keyed by bookId and a folder
   move/delete is REFUSED (BookBusyError -> 409 `book_busy`) while any token is
   held. `runBookJob` is the ONLY way to register, so there is no separate
   `release()` to forget: the token is released in a `finally` around the whole
   job promise, on every exit path (sync throw, early return, rejection, resolve).

   The token storage lives in book-op-lock.ts (so the movers can read it without
   an import cycle); this module owns the registration entry point.

   NO TTL, deliberately: a TTL would release the token under a live job. A hung
   sidecar keeps the job registered until its calls hit their own timeouts; a
   server restart clears the in-memory registry. The 409 names the kind.

   NEVER call `runBookJob` while holding book-op -- it takes book-op itself. */
import {
  BOOK_GONE,
  __addBookJobToken,
  bookJobKinds,
  withBookOp,
  type BookJobKind,
} from './book-op-lock.js';
import type { BookStateJson } from './scan.js';

export type { BookJobKind };
export { bookJobKinds };

/** What a registered job's `fn` receives. */
export interface BookJobLease {
  bookId: string;
  bookDir: string;
  state: BookStateJson;
}

/** Register a long job for `bookId` and run `fn(lease)` exactly once.
 *
 *  1. Under `withBookOp`, adds a unique token for `(bookId, kind)`.
 *  2. Releases book-op.
 *  3. Invokes `fn(lease)` inside an `async` wrapper whose `finally` releases the
 *     token -- so a SYNCHRONOUS throw or an early return is still released.
 *  4. Resolves to `{ done }` as soon as `fn` has been invoked; `done` settles when
 *     `fn`'s promise settles and the token has been released.
 *
 *  A gone book resolves to `BOOK_GONE` (fn never called, nothing registered). A
 *  timed-out registration rethrows the curated contention error. `done` already
 *  has a no-op catch attached, so an un-awaited rejection is not "unhandled". */
export async function runBookJob<T>(
  bookId: string,
  kind: BookJobKind,
  fn: (lease: BookJobLease) => Promise<T>,
  opts: { hintDir?: string; timeoutMs?: number } = {},
): Promise<typeof BOOK_GONE | { done: Promise<T> }> {
  const registered = await withBookOp(
    bookId,
    async (book) => ({
      release: __addBookJobToken(bookId, kind),
      lease: { bookId, bookDir: book.bookDir, state: book.state } satisfies BookJobLease,
    }),
    opts,
  );
  if (registered === BOOK_GONE) return BOOK_GONE;
  const run = async (): Promise<T> => {
    try {
      return await fn(registered.lease);
    } finally {
      registered.release();
    }
  };
  const done = run();
  /* `done` carries a no-op catch so a caller that fires the job and never awaits
     `done` cannot crash the process with an unhandled rejection. A caller that
     DOES await it still sees the rejection (this attaches a handler to `done`,
     it does not swallow it). */
  done.catch(() => undefined);
  return { done };
}
