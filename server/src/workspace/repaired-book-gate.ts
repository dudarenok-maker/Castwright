/* #3713 / PR #4004 pass 2 (owner decision) -- the server-side gate on a repaired
   bookId. After the duplicate-bookId sweep repairs a group, the id it was
   repaired FOR (the twin that kept it, and the loser's old id: the same string)
   names a different folder than a client that held it across the restart saw.
   Such a client's next write would land in the twin that kept the id, so the
   server refuses any non-GET request on that id unless the request echoes the
   read token `GET /:bookId/state` hands out, and answers 409
   `book_repaired_reload` otherwise.

   In memory, per process, on purpose: the sweep runs at boot, so a client that
   has read the book since is a client that read it from this process; a restart
   (no duplicate left to repair) ends the gate, and a client that held the id
   across TWO restarts is outside it. An old bundle that has never heard of the
   token sends none, so it is refused too -- absence of a token is the refusal.

   Scope keys are bookIds. The kept twin's manuscriptId, when the sweep had to
   re-mint the loser's because they shared it, is registered too, so
   `/api/manuscripts/:id/analysis*` (which resolves a book by manuscriptId) is
   gated by the SAME token.

   Gate book CONTENT only (PR #4004 pass 3, owner decision): a write that can overwrite the
   twin's content or identity (cast, manuscript, state slices, rename, delete, analysis, the
   body-keyed cast writers) is gated. Per-listener writes are EXEMPT, because none carries a
   snapshot of the slices the gate protects and several clients (the Android companion, a
   fresh tab's mini-player keepalive flush) can never present a token:
     PUT  /api/books/:bookId/listen-progress
     POST /api/books/:bookId/shelf-status
     PUT  /api/books/:bookId/listen-stats

   Mounted once, in app.ts, ahead of every `/api/books/:bookId` router. */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const BOOK_REPAIRED_RELOAD = 'book_repaired_reload';
export const BOOK_READ_TOKEN_HEADER = 'x-book-read-token';

const BOOK_REPAIRED_MESSAGE =
  'This book was repaired after a duplicate id was found, and this page was opened before the repair. Your change was not saved: reload the book and try again.';

/** bookId -> the read token that proves a read since the repair. */
const tokens = new Map<string, string>();
/** manuscriptId -> the bookId whose token gates it. */
const manuscriptScopes = new Map<string, string>();

/** Gate `bookId` (and `sharedManuscriptId`, when the sweep re-minted the other twin's). */
export function registerRepairedBook(bookId: string, sharedManuscriptId: string | null): void {
  if (!tokens.has(bookId)) tokens.set(bookId, randomUUID());
  if (sharedManuscriptId) manuscriptScopes.set(sharedManuscriptId, bookId);
}

/** The token a read of `bookId` returns, or undefined when the id is not gated. */
export function repairedReadToken(bookId: string): string | undefined {
  return tokens.get(bookId);
}

export function __resetRepairedBookGateForTest(): void {
  tokens.clear();
  manuscriptScopes.clear();
}

function refuseUnlessRead(scopeBookId: string | undefined, req: Request, res: Response, next: NextFunction): void {
  const token = scopeBookId === undefined ? undefined : tokens.get(scopeBookId);
  if (token === undefined || req.get(BOOK_READ_TOKEN_HEADER) === token) {
    next();
    return;
  }
  res.status(409).json({ error: BOOK_REPAIRED_MESSAGE, code: BOOK_REPAIRED_RELOAD });
}

/** Paths under `/api/books/:bookId` whose writes are per-listener records, not book content. */
const LISTENER_WRITE_PATHS: ReadonlySet<string> = new Set(['/listen-progress', '/shelf-status', '/listen-stats']);

const isRead = (req: Request): boolean => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';

/** `app.use('/api/books/:bookId', …)`: every write, rename and delete on a repaired id. */
export function repairedBookGate(req: Request, res: Response, next: NextFunction): void {
  if (isRead(req) || LISTENER_WRITE_PATHS.has(req.path)) return next();
  refuseUnlessRead(String(req.params.bookId), req, res, next);
}

/** `app.use('/api/manuscripts/:id', …)`: the manuscriptId-keyed analysis writes. */
export function repairedManuscriptGate(req: Request, res: Response, next: NextFunction): void {
  if (isRead(req)) return next();
  refuseUnlessRead(manuscriptScopes.get(String(req.params.id)), req, res, next);
}
