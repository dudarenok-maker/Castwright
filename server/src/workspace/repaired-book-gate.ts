/* #3713 / PR #4004 (owner decision after pass 5) -- the server-side gate on a repaired bookId.
   After the duplicate-bookId sweep repairs a group, the id it was repaired FOR (the twin that kept it,
   and the loser's old id: the same string) names a different folder than a page loaded before the
   repair saw. Such a page's next write would land in the twin that kept the id.

   The rule is blunt on purpose. From a repair until the book is deleted, every book-content write that names a
   repaired id is refused with 409 `book_repaired_reload` UNLESS it carries `x-repair-epoch` equal to
   the CURRENT repair epoch. The epoch is a random value minted when the registry gains an entry (once
   per process: only the boot sweep registers), persisted with it, and served by `GET /api/info`
   (`repairEpoch`). The client reads it once, when the page loads, and sends it on every write. A page
   loaded before the repair cannot hold it, and an old bundle never sends it. The client answers the
   409 with a full page reload, which discards every slice, cache, queue and modal the stale page held,
   so no client-side bookkeeping decides what is stale (the per-tab read-token design it replaces kept
   finding caches it did not cover: PR #4004 passes 3 to 5).

   Lifetime: NO EXPIRY (owner decision, PR #4004 pass 6). An entry lasts until the gated book is deleted
   (`forgetRepairedBook`), across restarts: a tab opened before the repair can first write on any later
   day and must still be refused, and a fresh page always holds the epoch, so a gate that never lapses
   costs only an old bundle or an operator script. A later repair rotates the epoch (every open page
   reloads once). The repaired ids, their repair times (kept for the record) and the epoch are persisted to
   `<workspace>/.repaired-book-gate.json` (atomic write), and the boot re-reads them BEFORE the sweep runs. A damaged
   file fails CLOSED: every entry still readable is kept (one with a broken time is gated from now),
   a lost epoch is replaced by a fresh one (every open page reloads once more), and the file is
   rewritten whole. A file that cannot be READ at boot (anything but "absent") is retried, and if it
   stays unreadable it is never overwritten by a fresh one: this boot gates what it can learn and
   refuses to persist (see `loadRepairedBookGate`).

   Gate book CONTENT only: a write that can overwrite the twin's content or identity (cast, manuscript,
   state slices, rename, delete, analysis, the body-keyed cast writers) is gated. Per-listener writes
   are EXEMPT, because none carries a snapshot of the book and some clients (the Android companion)
   never send the epoch:
     PUT  /api/books/:bookId/listen-progress
     POST /api/books/:bookId/shelf-status
     PUT  /api/books/:bookId/listen-stats

   Writes that name a book OUTSIDE the path are gated by the book they name, through
   `refuseUnreadRepairedBooks` in the handler. Gated:
     POST   /api/library-cast/override                (sourceBookId, targetBookId)
     POST   /api/voice-library/:uuid/assign           (body bookId)
     DELETE /api/voice-library/:uuid/assign           (query bookId)
     POST   /api/books/:bookId/cast/add-from-roster   (body targetBookId; the path book by the mount)
     POST   /api/books/:bookId/cast/link-prior        (body targetBookId; the path book by the mount)
     PUT    /api/voices/:voiceId/override             (scope 'series': body or query bookId)
     POST   /api/books/:bookId/cast/:characterId/not-linked-to    (body otherBookId; the path book by the mount)
     DELETE /api/books/:bookId/cast/:characterId/not-linked-to    (body otherBookId; the path book by the mount)
     POST   /api/queue/enqueue                                    (every entry's bookId)
     POST   /api/queue/:entryId/{start,retry,confirm-fallback,complete,skip-fallback} and DELETE /api/queue/:entryId
                                                                  (the entry's own bookId; an id naming no entry is a no-op)
   Confirmed safe, not gated: POST /api/voice-library/promote (reads the origin book, writes only the voice
   library); voice-library revoke and DELETE /:uuid; the queue routes that name no book and no entry (reorder, pause, clear); POST /api/books and /api/import (mint a new book); library-sync-manifest (a query bookId only selects a manifest). See plan 288, "Every other write".

   A series fan-out is REFUSED whole, never partly applied. Series-patch, voice-override-linked, cast/tier,
   the series (and workspace) scope of PUT /api/voices/:id/override, and the design writers that propagate a
   voice or variant across the series (single-design, cast-design, qwen-voice) match their mates by voice
   id or name, so the client never names them. When such a request would write a gated repaired mate and
   does not carry the current epoch, it answers 409 `book_repaired_reload` BEFORE anything is written (the
   page reloads, the user repeats the change, and the repeat carries the epoch and writes every mate,
   the repaired one included). A long design job decides at START: a request without the epoch is refused
   before any job exists, so a running job never has to report a skip and re-attaching to one checks
   nothing new. `refuseGatedSeriesFanOut` (workspace/repaired-series-refusal.ts) is the series-level check;
   the body-named mates of series-patch and voice-override-linked go through `refuseUnreadRepairedBooks`.

   The kept twin's manuscriptId, when the sweep had to re-mint the loser's because they shared it, is
   registered too, so `/api/manuscripts/:id/analysis*` (which resolves a book by manuscriptId) is gated by
   the same rule.

   Mounted once, in app.ts, ahead of every `/api/books/:bookId` router. */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';
import { repairedBookGateJsonPath } from './paths.js';
import { writeJsonAtomic } from './state-io.js';

export const BOOK_REPAIRED_RELOAD = 'book_repaired_reload';
export const REPAIR_EPOCH_HEADER = 'x-repair-epoch';

const BOOK_REPAIRED_MESSAGE =
  'This book was repaired after a duplicate id was found, and this page was opened before the repair. Your change was not saved: reload Castwright and try again.';

/** bookId -> when it was repaired. */
const books = new Map<string, number>();
/** manuscriptId -> the bookId it is scoped to, and when. */
const manuscriptScopes = new Map<string, { bookId: string; repairedAt: number }>();
/** The value a write must echo. Null only while nothing has ever been registered. */
let epoch: string | null = null;
/** This process already minted the epoch: a second registration in the same boot reuses it. */
let mintedThisProcess = false;
/** Ids deleted in this process: a later merge of an unreadable file must not bring them back. */
const forgotten = new Set<string>();

const isGatedBook = (bookId: string): boolean => books.has(bookId);

/** The epoch a write must carry; minted if an entry exists without one (fail closed: no page holds it). */
function requiredEpoch(): string {
  if (epoch === null) epoch = randomUUID();
  return epoch;
}

/** The registry gained an entry: the first gain of this process rotates the epoch. */
function rotateEpoch(): void {
  if (mintedThisProcess) return;
  epoch = randomUUID();
  mintedThisProcess = true;
}

/** True while any id or manuscript id is gated. */
function anyActive(): boolean {
  return books.size > 0 || manuscriptScopes.size > 0;
}

/** `GET /api/info`'s `repairEpoch`: the value a page loaded now sends on its writes, or null when nothing is
 *  gated (a page then sends nothing, and needs nothing). */
export function currentRepairEpoch(): string | null {
  return anyActive() ? requiredEpoch() : null;
}

/** Every id that is gated now. */
export function gatedBookIds(): string[] {
  return [...books.keys()];
}

/** True while `bookId` is a gated repaired id. */
export function isRepairedBook(bookId: string): boolean {
  return isGatedBook(bookId);
}

/* ---- persistence ---- */

let writing: Promise<void> = Promise.resolve();

/** True while the persisted file exists but could not be READ (anything but "absent"). Its entries are
 *  unknown, so the file is never overwritten with this process's own, and a gated write retries the read. */
let unreadable = false;
let lastReadAttempt = 0;
let retrying: Promise<void> | null = null;
const READ_RETRY_DELAYS_MS = [100, 300];
const READ_RETRY_INTERVAL_MS = 1000;

/** Write the live entries and the epoch. Serialised; never rejects (the in-memory gate holds
 *  either way, and a failure is logged). A file that could not be read is retried first and, if it still
 *  cannot be, left untouched: overwriting it would drop every id it names (PR #4004 pass 4). */
export function persistRepairedBookGate(): Promise<void> {
  const write = async (): Promise<void> => {
    if (unreadable) {
      await ingestGateFile(Date.now(), false);
      if (unreadable) {
        console.warn('[repaired-book-gate] the persisted gate is unreadable; not overwriting it (gate holds for this process)');
        return;
      }
    }
    const iso = (t: number): string => new Date(t).toISOString();
    const entries = [...books].map(([bookId, at]) => ({ bookId, repairedAt: iso(at) }));
    const manuscripts = [...manuscriptScopes].map(([manuscriptId, s]) => ({
      manuscriptId,
      bookId: s.bookId,
      repairedAt: iso(s.repairedAt),
    }));
    try {
      await writeJsonAtomic(repairedBookGateJsonPath(), { version: 2, epoch, entries, manuscripts });
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

/** Read the file, retrying a read that fails for any reason but "absent" (a transient EBUSY, a virus scanner
 *  holding it). `'absent'` is the common first-boot case; `null` is a file that stayed unreadable. */
async function readGateFile(retry: boolean): Promise<string | 'absent' | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFile(repairedBookGateJsonPath(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent';
      if (!retry || attempt >= READ_RETRY_DELAYS_MS.length) {
        console.warn('[repaired-book-gate] could not read the persisted gate; it will not be overwritten', err);
        return null;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/** Re-read the persisted gate (boot calls this BEFORE the sweep). Never throws. */
export async function loadRepairedBookGate(now = Date.now()): Promise<void> {
  await ingestGateFile(now, true);
}

/** Merge the file into memory (an id already held in memory keeps its entry: it is newer). Sets `unreadable`. */
async function ingestGateFile(now: number, boot: boolean): Promise<void> {
  lastReadAttempt = Date.now();
  const read = await readGateFile(boot);
  if (read === null) {
    unreadable = true;
    return;
  }
  unreadable = false;
  if (read === 'absent') return;
  const raw = read;
  let records: Record<string, unknown>[];
  let fileEpoch: unknown;
  let damaged = false;
  try {
    const data: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!isRecord(data) || !Array.isArray(data.entries)) throw new SyntaxError('unexpected shape');
    records = [...data.entries, ...(Array.isArray(data.manuscripts) ? data.manuscripts : [])].filter(isRecord);
    fileEpoch = data.epoch;
  } catch {
    damaged = true;
    records = salvageRecords(raw);
    fileEpoch = /"epoch"\s*:\s*"([^"\\]+)"/.exec(raw)?.[1];
  }
  for (const r of records) {
    if (!nonEmpty(r.bookId) || forgotten.has(r.bookId)) continue;
    const repairedAt = readTime(r.repairedAt, now);
    if (nonEmpty(r.manuscriptId)) {
      if (!manuscriptScopes.has(r.manuscriptId)) manuscriptScopes.set(r.manuscriptId, { bookId: r.bookId, repairedAt });
    } else if (!books.has(r.bookId)) {
      books.set(r.bookId, repairedAt);
    }
  }
  /* An epoch this process minted is newer than the file's. A file with entries and no readable epoch (a
     damaged one) gets a fresh one from `requiredEpoch`: every open page reloads once more. */
  if (!mintedThisProcess && nonEmpty(fileEpoch)) epoch = fileEpoch;
  if (anyActive() && epoch === null) {
    requiredEpoch();
    damaged = true;
  }
  /* Only the boot rewrites: a retry from inside a persist is followed by that persist's own whole-file write
     (rewriting here would wait on the very chain that called it). */
  if (damaged && boot) {
    console.warn(`[repaired-book-gate] the persisted gate file was damaged; kept ${books.size} id(s) and rewrote it`);
    await persistRepairedBookGate();
  }
}

/* ---- registry ---- */

/** Gate `bookId` until it is deleted (and `sharedManuscriptId`, when the sweep re-minted the other twin's). Persists. */
export function registerRepairedBook(bookId: string, sharedManuscriptId: string | null): Promise<void> {
  const now = Date.now();
  forgotten.delete(bookId);
  books.set(bookId, now);
  if (sharedManuscriptId) manuscriptScopes.set(sharedManuscriptId, { bookId, repairedAt: now });
  rotateEpoch();
  return persistRepairedBookGate();
}

/** Re-scope a gated manuscriptId to the book that carries it after the sweep (a book that is not the one the
 *  id was registered under), so deleting that book drops the scope with it. */
export function scopeManuscriptToBook(manuscriptId: string, bookId: string): Promise<void> {
  manuscriptScopes.set(manuscriptId, { bookId, repairedAt: Date.now() });
  rotateEpoch();
  return persistRepairedBookGate();
}

/** A gated book was deleted: forget its entry (and its manuscript scopes), in memory and on disk. `mintBookId`
 *  gives a fresh import with the same author, series and title the same id, and that new book must not inherit
 *  the deleted one's refusal. */
export function forgetRepairedBook(bookId: string): Promise<void> {
  const had = books.delete(bookId);
  let hadScope = false;
  for (const [id, s] of manuscriptScopes) {
    if (s.bookId === bookId) {
      manuscriptScopes.delete(id);
      hadScope = true;
    }
  }
  if (had || hadScope) forgotten.add(bookId);
  return had || hadScope ? persistRepairedBookGate() : Promise.resolve();
}

/** What a process restart does to the in-memory gate (the file stays). */
export function __clearRepairedBookGateMemoryForTest(): void {
  books.clear();
  manuscriptScopes.clear();
  forgotten.clear();
  epoch = null;
  mintedThisProcess = false;
  unreadable = false;
  retrying = null;
  lastReadAttempt = 0;
}

export function __resetRepairedBookGateForTest(): void {
  __clearRepairedBookGateMemoryForTest();
  rmSync(repairedBookGateJsonPath(), { force: true });
}

/* ---- the gate ---- */

/** Paths under `/api/books/:bookId` whose writes are per-listener records, not book content. */
const LISTENER_WRITE_PATHS: ReadonlySet<string> = new Set(['/listen-progress', '/shelf-status', '/listen-stats']);

/** True when the request carries the current epoch (a page loaded after the newest repair). */
const carriesEpoch = (header: string | undefined): boolean => header !== undefined && header === requiredEpoch();

/** True when `req` carries the current epoch: nothing it names can be refused. */
export const carriesRepairEpoch = (req: Request): boolean => carriesEpoch(req.get(REPAIR_EPOCH_HEADER));

function refuseUnlessCurrent(gated: boolean, req: Request, res: Response, next: NextFunction): void {
  if (!gated || carriesEpoch(req.get(REPAIR_EPOCH_HEADER))) {
    next();
    return;
  }
  res.status(409).json({ error: BOOK_REPAIRED_MESSAGE, code: BOOK_REPAIRED_RELOAD });
}

const isRead = (req: Request): boolean => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';

/** `app.use('/api/books/:bookId', ...)`: every content write, rename and delete on a repaired id. */
export async function repairedBookGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isRead(req) || LISTENER_WRITE_PATHS.has(req.path)) return next();
  await retryUnreadableGate();
  refuseUnlessCurrent(isGatedBook(String(req.params.bookId)), req, res, next);
}

/** A gate file that could not be read at boot is retried by the next gated write (at most once a second), so the
 *  ids it names are refused again as soon as it can be read instead of staying ungated for the whole boot. A
 *  retry that reads it writes the merge back, so this boot's own repairs survive the next restart. */
export function retryUnreadableGate(): Promise<void> {
  /* One retry at a time: a request that arrives while the read is in flight AWAITS it. Returning at once (the
     attempt time is stamped before the read) would let it pass ungated for a file that is readable right now. */
  if (retrying) return retrying;
  if (!unreadable || Date.now() - lastReadAttempt < READ_RETRY_INTERVAL_MS) return Promise.resolve();
  retrying = (async () => {
    try {
      await ingestGateFile(Date.now(), false);
    } finally {
      retrying = null;
    }
    if (!unreadable) await persistRepairedBookGate();
  })();
  return retrying;
}

/** `app.use('/api/manuscripts/:id', ...)`: the manuscriptId-keyed analysis writes. */
export async function repairedManuscriptGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isRead(req)) return next();
  await retryUnreadableGate();
  const scope = manuscriptScopes.get(String(req.params.id));
  refuseUnlessCurrent(!!scope, req, res, next);
}

/** Gate a write that names its book(s) in the request BODY or query, not the path (the routes listed in the
 *  header comment): if any named book is gated, the request must carry the current epoch. Answers the 409
 *  itself; returns true when it did, so the handler returns. */
export async function refuseUnreadRepairedBooks(bookIds: readonly unknown[], req: Request, res: Response): Promise<boolean> {
  await retryUnreadableGate();
  return refuseGatedBooksNow(bookIds, req, res);
}

/** The check of `refuseUnreadRepairedBooks` without the retry: synchronous, for a handler that has already awaited
 *  `retryUnreadableGate()` and must not await between its read and its write. */
export function refuseGatedBooksNow(bookIds: readonly unknown[], req: Request, res: Response): boolean {
  const gated = bookIds.some((id) => typeof id === 'string' && id !== '' && isGatedBook(id));
  let passed = false;
  refuseUnlessCurrent(gated, req, res, () => {
    passed = true;
  });
  return !passed;
}
