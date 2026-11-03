/* #3713 / PR #4004 pass 2 — the client half of the server's repaired-id write gate
   (server/src/workspace/repaired-book-gate.ts).

   After a duplicate-bookId repair the server refuses any write on a repaired id
   unless the request echoes the token `GET /api/books/:id/state` returned, and
   answers 409 `book_repaired_reload` otherwise. `bookFetch` is `fetch` plus that
   exchange, in one place, so every caller that talks to `/api/books/:id/…` (and
   the manuscriptId-keyed `/api/manuscripts/:id/…`) gets it: it remembers the
   token from a book-state read, attaches it to requests on that book, and tells
   the registered handler when the server refused one so the app can discard the
   stale snapshot and re-read.

   A read only ISSUES the token. It is the caller that applied the read as the
   book's full snapshot (Layout's full hydrate) that COMMITS it: a revisions-only
   read of a book whose slices still hold the other twin must not arm the writes
   that snapshot would make.

   A request on a book with no remembered token is sent untouched (the common
   case: nothing was ever repaired), so callers see exactly the init they passed. */

const BOOK_READ_TOKEN_HEADER = 'X-Book-Read-Token';
export const BOOK_REPAIRED_RELOAD = 'book_repaired_reload';

/** Issued by a book-state read, not yet committed by a full hydrate. */
const issued = new Map<string, string>();
/** Committed: the token this tab echoes on writes to that book. */
const tokens = new Map<string, string>();
/** manuscriptId -> bookId, so a manuscript-keyed write can echo its book's token. */
const manuscriptBooks = new Map<string, string>();
let onRepaired: ((bookId: string) => void) | null = null;

/** The app's reaction to a refused write: toast, mark the book for a full read, refresh the library. */
export function setRepairedBookHandler(handler: ((bookId: string) => void) | null): void {
  onRepaired = handler;
}

/** A series fan-out left a repaired series-mate alone because this tab holds no token for it (PR #4004 pass 5):
 *  the server names it in this response header, whatever the route's body looks like. */
const SKIPPED_BOOKS_HEADER = 'X-Skipped-Repaired-Books';
export interface SkippedRepairedBook {
  bookId: string;
  bookTitle: string;
  reason: string;
}
let onSkipped: ((books: SkippedRepairedBook[]) => void) | null = null;

export function setSkippedBooksHandler(handler: ((books: SkippedRepairedBook[]) => void) | null): void {
  onSkipped = handler;
}

function reportSkippedBooks(res: Response): void {
  const raw = res.headers?.get?.(SKIPPED_BOOKS_HEADER);
  if (!raw || !onSkipped) return;
  try {
    const list: unknown = JSON.parse(decodeURIComponent(raw));
    if (Array.isArray(list) && list.length > 0) onSkipped(list as SkippedRepairedBook[]);
  } catch {
    /* a malformed header is no reason to fail the request */
  }
}

/** A book-state read told us this book's manuscriptId: its writes echo that book's token. */
export function rememberManuscriptBook(manuscriptId: unknown, bookId: string): void {
  if (typeof manuscriptId === 'string' && manuscriptId !== '') manuscriptBooks.set(manuscriptId, bookId);
}

/** The caller just applied a full read of `bookId` as the book's snapshot: its writes may echo the token. */
export function commitBookReadToken(bookId: string): void {
  const token = issued.get(bookId);
  if (token) tokens.set(bookId, token);
}

/** A book-state read issued a token for `bookId` (the book is a repaired id) that nothing has committed yet. */
export function hasIssuedBookReadToken(bookId: string): boolean {
  return issued.has(bookId);
}

export function __resetBookReadTokensForTest(): void {
  issued.clear();
  tokens.clear();
  manuscriptBooks.clear();
  onRepaired = null;
  onSkipped = null;
}

function pathOf(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.pathname : null;
  if (raw === null) return null;
  return raw.split(/[?#]/, 1)[0];
}

/** The bookId a request is scoped to, and whether it is the book-state read. */
function scopeOf(path: string): { bookId: string | null; isStateRead: boolean; tracked: boolean } {
  const book = /^\/api\/books\/([^/]+)(\/.*)?$/.exec(path);
  if (book) {
    const id = decodeURIComponent(book[1]);
    return { bookId: id, isStateRead: book[2] === '/state', tracked: true };
  }
  const ms = /^\/api\/manuscripts\/([^/]+)(\/|$)/.exec(path);
  /* A manuscript-keyed write is tracked even when no book is remembered for the id: the server's 409 names it. */
  if (ms) return { bookId: manuscriptBooks.get(decodeURIComponent(ms[1])) ?? null, isStateRead: false, tracked: true };
  return { bookId: null, isStateRead: false, tracked: false };
}

/** Send `input` scoped to `bookIds`: echo their committed tokens (comma-joined), and on a
 *  `book_repaired_reload` refusal of a write tell the handler about each of them. */
async function send(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  bookIds: readonly string[],
  isStateRead: boolean,
  tracked = bookIds.length > 0,
): ReturnType<typeof fetch> {
  const echo = bookIds.map((id) => tokens.get(id)).filter((t): t is string => !!t).join(',');
  let sent = init;
  if (echo) {
    const headers = new Headers(init?.headers);
    headers.set(BOOK_READ_TOKEN_HEADER, echo);
    sent = { ...init, headers };
  }
  const res = await (sent === undefined ? globalThis.fetch(input) : globalThis.fetch(input, sent));
  reportSkippedBooks(res);
  if (!tracked) return res;

  const method = (init?.method ?? 'GET').toUpperCase();
  if (isStateRead && method === 'GET' && res.ok) {
    const token = res.headers?.get?.(BOOK_READ_TOKEN_HEADER);
    if (token) issued.set(bookIds[0], token);
  } else if (res.status === 409 && method !== 'GET' && typeof res.clone === 'function') {
    try {
      const body = (await res.clone().json()) as { code?: unknown; bookId?: unknown };
      if (body?.code === BOOK_REPAIRED_RELOAD) {
        /* The server names the book the refusal was scoped to; that is the one to re-read. Absent (an
           older server), fall back to the books this request was scoped to. */
        const named = typeof body.bookId === 'string' && body.bookId !== '' ? [body.bookId] : bookIds;
        for (const id of named) onRepaired?.(id);
      }
    } catch {
      /* not JSON: an ordinary 409 */
    }
  }
  return res;
}

export const bookFetch: typeof fetch = (input, init) => {
  const path = pathOf(input);
  const scope = path === null ? null : scopeOf(path);
  return send(input, init, scope?.bookId ? [scope.bookId] : [], scope?.isStateRead ?? false, scope?.tracked ?? false);
};

/** `fetch` for a write that names its book(s) in the body or query, not the path
 *  (`library-cast/override`, `voice-library/:uuid/assign`): the same token exchange,
 *  scoped to the books the caller names. */
export const bookFetchFor =
  (bookIds: readonly string[]): typeof fetch =>
  (input, init) =>
    send(input, init, bookIds, false);
