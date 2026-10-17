/* Locked read-modify-write of a book's state.json (#3400, pass 7; layered with
   #3700's `state-json` leaf lock).

   Every writer of `state.json` that derives its write from a read of it must
   hold the per-book lock (`book-lock.ts`) across locate -> decide -> write, or
   it can land after a chapter restructure with the pre-restructure chapter
   list (the restructure holds the same lock across its writes). Inside it the
   fresh re-read + write is `updateStateJsonLocked` (state-migrate.ts): the
   `state-json` leaf lock, which also stops a sibling chapter render's stamp
   (which holds only that one) being reverted. The same four rules as the
   `cast.json` lock apply: lock the innermost read-through-write, the read and
   every decision derived from it go INSIDE, never nest by hand (the book lock
   is re-entrant per async context, so a nested call is a no-op), and respect
   the global order in book-lock.ts's header.

   Two entry points, for the two shapes a writer has:
     - `withLocatedBook(bookId, fn)` -- a route that knows the bookId: lock,
       locate, then run `fn` before releasing. `fn` writes state.json through
       `updateStateJsonLocked` / `withStateJsonLock`, never bare.
     - `updateStateAtDir(bookDir, mutate, opts?)` -- a helper that only knows the
       folder (the cover writers, the analysis persist): book lock by the book's
       id, then the leaf-locked re-read, mutate, write.
   `state-lock.guard.test.ts` fails the build on a `state.json` write outside
   both (or a bare `withBookLock`); `state-json-lock.guard.test.ts` fails it on a
   write outside `withStateJsonLock`. */

import { withBookLock } from './book-lock.js';
import { stateJsonPath } from './paths.js';
import { findBookByBookId, type BookStateJson } from './scan.js';
import { readJson } from './state-io.js';
import { updateStateJsonLocked } from './state-migrate.js';

export type LocatedBook = NonNullable<Awaited<ReturnType<typeof findBookByBookId>>>;

/** Run `fn` holding the book's lock, with the book located INSIDE it (so the
 *  state `fn` decides from is the post-wait state, never a pre-wait snapshot).
 *  Resolves `null` when the book does not exist, else `{ value }`. */
export async function withLocatedBook<T>(
  bookId: string,
  fn: (located: LocatedBook) => Promise<T>,
): Promise<{ value: T } | null> {
  return withBookLock(bookId, async () => {
    const located = await findBookByBookId(bookId);
    if (!located) return null;
    return { value: await fn(located) };
  });
}

/** Locked read-modify-write of `<bookDir>/.audiobook/state.json`: the book lock
 *  (outer, operation-level) then the `state-json` leaf lock (inner, around
 *  the fresh re-read + write -- `updateStateJsonLocked`, #3700). `mutate`
 *  receives the freshly-read state and returns the state to write, or `null`
 *  for "nothing to write". Resolves true iff a write happened. A missing file
 *  is a no-op (never recreates a folder a rename moved).
 *
 *  `mutate` and `beforeWrite` (which runs once state.json is known present and
 *  `mutate` produced a change) run under the `state-json` leaf lock, so they
 *  must not take another lock or call something that does. `underBookLock`
 *  runs inside the book lock but BEFORE the leaf lock is taken -- for a
 *  pre-check that may itself reach the workspace scan (whose heals take both
 *  locks) or is only meaningful while a rename is excluded. A `state-json`
 *  acquisition timeout propagates as the curated lock-timeout error. */
export async function updateStateAtDir(
  bookDir: string,
  mutate: (state: BookStateJson) => BookStateJson | null | Promise<BookStateJson | null>,
  opts: { beforeWrite?: () => Promise<void>; underBookLock?: () => Promise<void> } = {},
): Promise<boolean> {
  const path = stateJsonPath(bookDir);
  /* Peek only for the lock key; the state the decision is made from is the
     re-read under the locks. */
  const peek = await readJson<BookStateJson>(path);
  if (!peek) return false;
  return withBookLock(peek.bookId ?? bookDir, async () => {
    await opts.underBookLock?.();
    let wrote = false;
    await updateStateJsonLocked(
      path,
      async (fresh) => {
        const next = await mutate(fresh);
        if (next) wrote = true;
        return next;
      },
      opts.beforeWrite,
    );
    return wrote;
  });
}
