/* #3713 / PR #4004 pass 2 (owner decision) -- the server-side gate on a repaired
   bookId. After the duplicate-bookId sweep repairs a group, the id it was
   repaired FOR (the twin that kept it, and the loser's old id: the same string)
   names a different folder than a client that held it across the restart saw.
   Such a client's next write would land in the twin that kept the id, so the
   server refuses a write on that id unless the request echoes the read token
   `GET /:bookId/state` hands out, and answers 409 `book_repaired_reload`
   otherwise.

   Lifetime (pass 3, owner decision): 7 days from the repair, across restarts. The
   repaired ids, their tokens and repair times are persisted to
   `<workspace>/.repaired-book-gate.json` (atomic write), and the boot re-reads them
   BEFORE the sweep runs, so an old-bundle tab (it knows nothing of the token, so it
   sends none) stays refused until it reloads. A read of the book by a client clears
   that book's PERSISTED entry (this process keeps refusing a tab with no token; the
   next restart does not), and an entry older than 7 days is dropped at load and
   ignored at check. A damaged file fails CLOSED: every entry still readable is kept
   (one with a broken token or time is kept with a fresh one), and the file is
   rewritten whole; it never silently ungates.

   Gate book CONTENT only (pass 3, owner decision): a write that can overwrite the
   twin's content or identity (cast, manuscript, state slices, rename, delete, analysis,
   the body-keyed cast writers) is gated. Per-listener writes are EXEMPT, because none
   carries a snapshot of the slices the gate protects and several clients (the Android
   companion, a fresh tab's mini-player keepalive flush) can never present a token:
     PUT  /api/books/:bookId/listen-progress
     POST /api/books/:bookId/shelf-status
     PUT  /api/books/:bookId/listen-stats

   Writes that name a book OUTSIDE the path are gated by the book they name, through
   `refuseUnreadRepairedBooks` in the handler (pass 4, owner decision: every write that can overwrite a
   repaired book's content or identity). Gated:
     POST   /api/library-cast/override                (sourceBookId, targetBookId)
     POST   /api/voice-library/:uuid/assign           (body bookId)
     DELETE /api/voice-library/:uuid/assign           (query bookId)
     POST   /api/books/:bookId/cast/add-from-roster   (body targetBookId; the path book by the mount)
     POST   /api/books/:bookId/cast/link-prior        (body targetBookId; the path book by the mount)
     PUT    /api/voices/:voiceId/override             (scope 'series': body or query bookId)
     POST   /api/books/:bookId/cast/:characterId/not-linked-to    (body otherBookId; the path book by the mount)
     DELETE /api/books/:bookId/cast/:characterId/not-linked-to    (body otherBookId; the path book by the mount)
   Confirmed safe, not gated: POST /api/voice-library/promote (reads the origin book, writes only the voice
   library); voice-library revoke and DELETE /:uuid, and PUT /api/voices/:id/override with scope 'workspace'
   (keyed by voice, name no book); /api/queue/* (writes the queue); POST /api/books and /api/import (mint a
   new book); library-sync-manifest (a query bookId only selects a manifest). See plan 288, "Every other write".

   A series fan-out SKIPS a repaired mate, it does not refuse (pass 5, owner decision). Series-patch,
   voice-override-linked, cast/tier, the series scope of PUT /api/voices/:id/override, and the design writers that
   propagate a voice or variant across the series (single-design, cast-design, qwen-voice) match their mates by
   voice id or name, so the client never names them and cannot hold their token. Refusing would make the write
   impossible; writing would land on the wrong twin. Each fan-out calls `skipUnreadRepairedBook` per mate (the
   shared `forEachMatchingCastCharacter` walker does it itself): a gated mate this request echoed no token for is
   left byte-identical and reported, the rest of the series updates. `repairedFanOutScope` (mounted once in
   app.ts) holds the request's tokens in an AsyncLocalStorage and stamps the skipped list on the response header
   `x-skipped-repaired-books`; series-patch, voice-override-linked, cast/tier and the series override also put it
   in the body as `skippedBooks` ({ bookId, bookTitle, reason: 'Reopen "<title>" to apply this change there.' }).
   With the mate's token echoed it is written.

   Scope keys are bookIds. The kept twin's manuscriptId, when the sweep had to
   re-mint the loser's because they shared it, is registered too, so
   `/api/manuscripts/:id/analysis*` (which resolves a book by manuscriptId) is
   gated by the SAME token.

   Mounted once, in app.ts, ahead of every `/api/books/:bookId` router. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';
import { repairedBookGateJsonPath } from './paths.js';
import { writeJsonAtomic } from './state-io.js';

export const BOOK_REPAIRED_RELOAD = 'book_repaired_reload';
export const BOOK_READ_TOKEN_HEADER = 'x-book-read-token';
export const REPAIRED_GATE_TTL_MS = 7 * 24 * 3600 * 1000;

const BOOK_REPAIRED_MESSAGE =
  'This book was repaired after a duplicate id was found, and this page was opened before the repair. Your change was not saved: reload the book and try again.';

interface BookEntry {
  token: string;
  repairedAt: number;
  /** false once a client has read the book: this process keeps gating, the file forgets it. */
  persist: boolean;
}
interface ManuscriptScope {
  bookId: string;
  repairedAt: number;
  persist: boolean;
}

/** bookId -> the read token that proves a read since the repair. */
const books = new Map<string, BookEntry>();
/** manuscriptId -> the bookId whose token gates it. */
const manuscriptScopes = new Map<string, ManuscriptScope>();

const isExpired = (repairedAt: number, now: number): boolean => now - repairedAt >= REPAIRED_GATE_TTL_MS;

function activeBook(bookId: string, now = Date.now()): BookEntry | undefined {
  const e = books.get(bookId);
  if (e && isExpired(e.repairedAt, now)) {
    books.delete(bookId);
    return undefined;
  }
  return e;
}

/* ---- persistence ---- */

let writing: Promise<void> = Promise.resolve();

/** Write the live, unexpired, not-yet-read entries. Serialised; never rejects (the in-memory gate
 *  holds either way, and a failure is logged). */
export function persistRepairedBookGate(): Promise<void> {
  const write = async (): Promise<void> => {
    const now = Date.now();
    const iso = (t: number): string => new Date(t).toISOString();
    const entries = [...books]
      .filter(([, e]) => e.persist && !isExpired(e.repairedAt, now))
      .map(([bookId, e]) => ({ bookId, token: e.token, repairedAt: iso(e.repairedAt) }));
    const manuscripts = [...manuscriptScopes]
      .filter(([, s]) => s.persist && !isExpired(s.repairedAt, now))
      .map(([manuscriptId, s]) => ({ manuscriptId, bookId: s.bookId, repairedAt: iso(s.repairedAt) }));
    try {
      await writeJsonAtomic(repairedBookGateJsonPath(), { version: 1, entries, manuscripts });
    } catch (err) {
      console.warn('[repaired-book-gate] could not persist the gate; it holds for this process only', err);
    }
  };
  writing = writing.then(write, write);
  return writing;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Candidate records out of a file that did not parse whole: every flat `{...}` object in the text that
 *  parses on its own. A record holds no nested braces, so a cut-off tail costs only itself. */
function salvageRecords(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of raw.match(/\{[^{}]*\}/g) ?? []) {
    try {
      const v: unknown = JSON.parse(m);
      if (isRecord(v)) out.push(v);
    } catch {
      /* a half-written object */
    }
  }
  return out;
}

/** Fail closed: a record with a readable id but a broken time is gated from NOW. */
function readTime(v: unknown, now: number): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? now : t;
}

/** Re-read the persisted gate (boot calls this BEFORE the sweep). Never throws. */
export async function loadRepairedBookGate(now = Date.now()): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(repairedBookGateJsonPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[repaired-book-gate] could not read the persisted gate; repaired ids are gated from this boot only', err);
    }
    return;
  }
  let records: Record<string, unknown>[];
  let damaged = false;
  try {
    const data: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!isRecord(data) || !Array.isArray(data.entries)) throw new SyntaxError('unexpected shape');
    records = [...data.entries, ...(Array.isArray(data.manuscripts) ? data.manuscripts : [])].filter(isRecord);
  } catch {
    damaged = true;
    records = salvageRecords(raw);
  }
  for (const r of records) {
    if (!nonEmpty(r.bookId)) continue;
    const repairedAt = readTime(r.repairedAt, now);
    if (isExpired(repairedAt, now)) continue;
    if (nonEmpty(r.manuscriptId)) {
      manuscriptScopes.set(r.manuscriptId, { bookId: r.bookId, repairedAt, persist: true });
    } else {
      books.set(r.bookId, { token: nonEmpty(r.token) ? r.token : randomUUID(), repairedAt, persist: true });
    }
  }
  /* A scope whose book entry was lost still gates: give that book an entry too. */
  for (const s of manuscriptScopes.values()) {
    if (!books.has(s.bookId)) books.set(s.bookId, { token: randomUUID(), repairedAt: s.repairedAt, persist: true });
  }
  if (damaged) {
    console.warn(`[repaired-book-gate] the persisted gate file was damaged; kept ${books.size} id(s) and rewrote it`);
    await persistRepairedBookGate();
  }
}

/* ---- registry ---- */

/** Gate `bookId` for 7 days (and `sharedManuscriptId`, when the sweep re-minted the other twin's). Persists. */
export function registerRepairedBook(bookId: string, sharedManuscriptId: string | null): Promise<void> {
  const now = Date.now();
  books.set(bookId, { token: activeBook(bookId, now)?.token ?? randomUUID(), repairedAt: now, persist: true });
  if (sharedManuscriptId) manuscriptScopes.set(sharedManuscriptId, { bookId, repairedAt: now, persist: true });
  return persistRepairedBookGate();
}

/** Re-scope a gated manuscriptId to the book that carries it after the sweep (a book that is not the one the id
 *  was registered under): that book is gated too, so a read of it issues the token the id's writes ask for. */
export function scopeManuscriptToBook(manuscriptId: string, bookId: string): Promise<void> {
  const now = Date.now();
  manuscriptScopes.set(manuscriptId, { bookId, repairedAt: now, persist: true });
  if (!activeBook(bookId, now)) books.set(bookId, { token: randomUUID(), repairedAt: now, persist: true });
  return persistRepairedBookGate();
}

/** The token a read of `bookId` returns, or undefined when the id is not gated. */
export function repairedReadToken(bookId: string): string | undefined {
  return activeBook(bookId)?.token;
}

/** A client read `bookId`: its persisted entry (and any manuscript scope on it) is forgotten, so the
 *  NEXT restart no longer gates it. This process keeps gating a tab that sends no token. */
export function markRepairedBookRead(bookId: string): void {
  const e = books.get(bookId);
  if (!e || !e.persist) return;
  e.persist = false;
  for (const s of manuscriptScopes.values()) if (s.bookId === bookId) s.persist = false;
  void persistRepairedBookGate();
}

/** What a process restart does to the in-memory gate (the file stays). */
export function __clearRepairedBookGateMemoryForTest(): void {
  books.clear();
  manuscriptScopes.clear();
}

export function __resetRepairedBookGateForTest(): void {
  __clearRepairedBookGateMemoryForTest();
  rmSync(repairedBookGateJsonPath(), { force: true });
}

/* ---- the gate ---- */

/** Paths under `/api/books/:bookId` whose writes are per-listener records, not book content. */
const LISTENER_WRITE_PATHS: ReadonlySet<string> = new Set(['/listen-progress', '/shelf-status', '/listen-stats']);

/** The tokens a request echoes: the header may carry several, comma-joined, for a write that names two books. */
const echoedTokens = (req: Request): string[] => (req.get(BOOK_READ_TOKEN_HEADER) ?? '').split(',').map((t) => t.trim());

function refuseUnlessRead(scopeBookId: string | undefined, req: Request, res: Response, next: NextFunction): void {
  const token = scopeBookId === undefined ? undefined : activeBook(scopeBookId)?.token;
  if (token === undefined || echoedTokens(req).includes(token)) {
    next();
    return;
  }
  /* `bookId`: the book the refusal is scoped to (an id, never a path), so a client that does not know which
     book a manuscriptId-keyed or body-keyed write belongs to can re-read the right one. */
  res.status(409).json({ error: BOOK_REPAIRED_MESSAGE, code: BOOK_REPAIRED_RELOAD, bookId: scopeBookId });
}

const isRead = (req: Request): boolean => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';

/** `app.use('/api/books/:bookId', ...)`: every content write, rename and delete on a repaired id. */
export function repairedBookGate(req: Request, res: Response, next: NextFunction): void {
  if (isRead(req) || LISTENER_WRITE_PATHS.has(req.path)) return next();
  refuseUnlessRead(String(req.params.bookId), req, res, next);
}

/** `app.use('/api/manuscripts/:id', ...)`: the manuscriptId-keyed analysis writes. */
export function repairedManuscriptGate(req: Request, res: Response, next: NextFunction): void {
  if (isRead(req)) return next();
  const scope = manuscriptScopes.get(String(req.params.id));
  refuseUnlessRead(scope && !isExpired(scope.repairedAt, Date.now()) ? scope.bookId : undefined, req, res, next);
}

/* ---- series fan-out: skip, don't refuse (pass 5, owner decision) ---- */

/** A series-mate a fan-out left alone, with the sentence the UI shows for it. */
export interface SkippedRepairedBook {
  bookId: string;
  bookTitle: string;
  reason: string;
}
interface FanOutScope {
  tokens: string[];
  skipped: Map<string, SkippedRepairedBook>;
}
const fanOutScope = new AsyncLocalStorage<FanOutScope>();

/** The response header that carries the skipped list (URI-encoded JSON), so the client reports a skip for any
 *  route, whatever its body (a 204, a plain count) looks like. Set when the headers are written. */
export const SKIPPED_BOOKS_HEADER = 'x-skipped-repaired-books';

/** `app.use('/api', ...)`, after the body parser: remembers the tokens THIS request echoed for the whole async
 *  chain it starts (the fan-out walkers, a design job it launches), and stamps the skipped list on the response.
 *  Outside a request (a unit test of a walker, boot code) there is no scope and nothing is ever skipped. */
export function repairedFanOutScope(req: Request, res: Response, next: NextFunction): void {
  const scope: FanOutScope = { tokens: echoedTokens(req), skipped: new Map() };
  const writeHead = res.writeHead as (...args: unknown[]) => Response;
  res.writeHead = function (this: Response, ...args: unknown[]): Response {
    if (scope.skipped.size > 0 && !this.headersSent) {
      this.setHeader(SKIPPED_BOOKS_HEADER, encodeURIComponent(JSON.stringify([...scope.skipped.values()])));
    }
    return writeHead.apply(this, args);
  } as Response['writeHead'];
  fanOutScope.run(scope, next);
}

/** A series-scope fan-out onto a series-mate the client did not name: true when that mate is a gated repaired
 *  book this request holds no token for, so the caller must leave its files alone. The skip is recorded for the
 *  response; the rest of the series updates. A mate whose token the request echoed (or a book that is not
 *  gated) is not skipped. */
export function skipUnreadRepairedBook(bookId: string, bookTitle: string): boolean {
  const scope = fanOutScope.getStore();
  if (!scope) return false;
  const token = activeBook(bookId)?.token;
  if (token === undefined || scope.tokens.includes(token)) return false;
  scope.skipped.set(`${bookId}\u0000${bookTitle}`, { bookId, bookTitle, reason: `Reopen "${bookTitle}" to apply this change there.` });
  return true;
}

/** What this request's fan-outs skipped so far (empty outside a request). */
export function skippedRepairedBooks(): SkippedRepairedBook[] {
  return [...(fanOutScope.getStore()?.skipped.values() ?? [])];
}

/** Gate a write that names its book(s) in the request BODY or query, not the path (the routes listed in the
 *  header comment): every named book that is gated must have its token echoed. Answers the 409
 *  itself; returns true when it did, so the handler returns. */
export function refuseUnreadRepairedBooks(bookIds: readonly unknown[], req: Request, res: Response): boolean {
  for (const id of bookIds) {
    if (typeof id !== 'string' || id === '') continue;
    let passed = false;
    refuseUnlessRead(id, req, res, () => {
      passed = true;
    });
    if (!passed) return true;
  }
  return false;
}
