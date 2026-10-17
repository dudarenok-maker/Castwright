/* Locked read-modify-write of a book's state.json (#3400, pass 7).

   Every writer of `state.json` that derives its write from a read of it must
   hold the per-book lock (`book-lock.ts`) across locate -> decide -> write, or
   it can land after a chapter restructure with the pre-restructure chapter
   list (the restructure holds the same lock across its writes). The same four
   rules as the `cast.json` lock apply: lock the innermost read-through-write,
   the read and every decision derived from it go INSIDE, never nest by hand
   (the lock is re-entrant per async context, so a nested call is a no-op),
   and respect the global order in book-lock.ts's header.

   Two entry points, for the two shapes a writer has:
     - `withLocatedBook(bookId, fn)` — a route that knows the bookId: lock,
       locate, then run `fn` (which writes) before releasing.
     - `updateStateAtDir(bookDir, mutate)` — a helper that only knows the
       folder (the cover writers): lock by the book's id, re-read, mutate,
       write.
   `state-lock.guard.test.ts` fails the build on a `state.json` write outside
   both (or a bare `withBookLock`). */

import { withBookLock } from './book-lock.js';
import { stateJsonPath } from './paths.js';
import { findBookByBookId, type BookStateJson } from './scan.js';
import { readJson } from './state-io.js';
import { readStateJsonWithRecovery, writeStateJsonAtomic } from './state-migrate.js';

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

/** Locked read-modify-write of `<bookDir>/.audiobook/state.json`. `mutate`
 *  receives the freshly-read state and returns the state to write, or `null`
 *  for "nothing to write". Resolves true iff a write happened. A missing /
 *  unreadable file is a no-op (never recreates a folder a rename moved). */
export async function updateStateAtDir(
  bookDir: string,
  mutate: (state: BookStateJson) => BookStateJson | null | Promise<BookStateJson | null>,
): Promise<boolean> {
  /* Peek only for the lock key; the state the decision is made from is the
     re-read under the lock. */
  const peek = await readJson<BookStateJson>(stateJsonPath(bookDir));
  if (!peek) return false;
  return withBookLock(peek.bookId ?? bookDir, async () => {
    const fresh = await readStateJsonWithRecovery(stateJsonPath(bookDir)).catch(() => null);
    if (!fresh) return false;
    const next = await mutate(fresh);
    if (!next) return false;
    await writeStateJsonAtomic(stateJsonPath(bookDir), { ...next, language: next.language ?? null });
    return true;
  });
}
