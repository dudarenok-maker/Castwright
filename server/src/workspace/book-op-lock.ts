/* #3711 — the per-book operation lock (`book-op:<bookId>`), the only sanctioned
   book-folder movers, and the workspace-wide path claim. Design of record:
   docs/features/288-book-op-lock.md.

   WHY: a folder-renaming `PUT /api/books/:bookId/state` could queue behind a
   per-book operation and, the moment that operation released its state-json
   lock, run while the operation was still writing to the folder it resolved
   earlier. `writeJsonAtomic` creates parent directories, so every such write to
   the vacated path RECREATED the old folder and split the book in two. A folder
   move or delete therefore holds `book-op:<bookId>` exclusively; every QUICK
   operation on a book holds it for its whole span; every LONG job registers in
   `book-jobs.ts` (`runBookJob`) instead and a move is REFUSED while one is
   registered.

   RULES (CLAUDE.md "cast.json writes" bullet carries the full order):
     - Lock order: design -> library-voice -> book-op -> book-path-claim ->
       cast -> book -> state-json, with cast -> cast-id-history. `revision-op ->
       revisions`, `listen-stats` and `script-review-ledger` nest UNDER book-op.
       `book` is #3594's per-book state.json / manuscript-edits lock
       (book-lock.ts): always taken INSIDE book-op, and no `book` holder ever
       takes book-op.
     - NEVER nest `withBookOp`; two or more books always go through
       `withBookOps`. Re-entry fails at the 10s acquisition budget with the key in
       the log (a diagnostic, not a licence).
     - NEVER call `runBookJob` while holding book-op -- it takes book-op itself.
     - One level only: lock at the route handler / the `runBookJob` call / a
       walker's per-book step, never inside a shared helper.
     - No resolve before the lock: `peekBook` is the ONLY sanctioned pre-lock
       resolve (the two-span pattern) and nothing it returns may feed a write.

   The movers take a `BookHandle` and throw if `held` is false -- a capability
   token (the handle is only ever created inside `withBookOp*`, and a mover also
   requires it to be in a module-private WeakSet of live handles, so a copy or a
   hand-built object is refused), replacing an AsyncLocalStorage order tracker. */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { sortDirNames } from './dir-order.js';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  LOCK_ACQUISITION_TIMEOUT_CODE,
  LOCK_CONTENTION_REQUEST_ERROR,
  isLockAcquisitionTimeout,
  withKeyLock,
  withStateJsonLock,
} from './file-lock.js';
import { BOOKS_ROOT, STANDALONES_SERIES, ensureWorkspace, makeBookId, parseBookId, stateJsonPath } from './paths.js';
import { readStateJsonWithRecovery, writeStateJsonAtomic } from './state-migrate.js';
import { renameWithRetry } from './atomic-rename.js';
import { getManuscript, putManuscript } from '../store/manuscripts.js';
import { withBookLock } from './book-lock.js';
import { backfillAudioModelKeysFromSegments, type BookStateJson } from './scan.js';

/** Returned by `withBookOp*` / `runBookJob` when the book no longer exists. */
export const BOOK_GONE: unique symbol = Symbol('BOOK_GONE');

/** What a `withBookOp*` callback receives. `held` is true only while the callback
 *  runs; `bookDir`/`state` track the folder across an in-callback move. The
 *  movers also check a private registry, so only the object handed out counts. */
export interface BookHandle {
  bookId: string;
  bookDir: string;
  state: BookStateJson;
  held: boolean;
}

/** The kinds of long job `runBookJob` registers (see book-jobs.ts). */
export type BookJobKind = 'render' | 'scoring' | 'analysis' | 'design' | 'script-review' | 'export';

/* ---- errors raised by the movers ------------------------------------------ */

/** A move or delete was refused because a long job is registered for the book. */
export class BookBusyError extends Error {
  readonly kinds: BookJobKind[];
  constructor(kinds: BookJobKind[]) {
    super(`book is busy (${kinds.join(', ')})`);
    this.name = 'BookBusyError';
    this.kinds = kinds;
  }
}

/** The target Author/Series/Title path already exists. */
export class BookPathTakenError extends Error {
  constructor() {
    super('a book already exists at that Author/Series/Title path');
    this.name = 'BookPathTakenError';
  }
}

/** EPERM/EBUSY/EACCES from the rename or the delete, with state.json still
 *  present (so nothing was lost). The message carries no path. */
export class BookFolderInUseError extends Error {
  constructor() {
    super("the book's folder is in use");
    this.name = 'BookFolderInUseError';
  }
}

/** `rm` failed AFTER state.json was already gone: the book left the library but
 *  some files remain. Not retryable. The message carries no path. */
export class BookPartlyDeletedError extends Error {
  readonly title: string;
  constructor(title: string) {
    super('the book was removed but some of its files were left behind');
    this.name = 'BookPartlyDeletedError';
    this.title = title;
  }
}

/** A book's state.json could not be READ (EBUSY / EPERM / EIO ...). That says
 *  nothing about whose book the folder holds, so it is never read as "not this
 *  book" or "id free": the operation fails instead. The raw error (whose message
 *  embeds the absolute path) goes to the log; this message carries no path. */
export class BookStateUnreadableError extends Error {
  constructor() {
    super("The book's state file could not be read right now (it may be open in another program). Retry in a moment.");
    this.name = 'BookStateUnreadableError';
  }
}

const IN_USE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

function isInUse(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && IN_USE_CODES.has(code);
}

/* ---- the busy registry's storage ------------------------------------------ */

/* Lives HERE (not in book-jobs.ts) so the movers can read it without
   book-op-lock <-> book-jobs becoming an import cycle. The ONLY writer is
   `runBookJob` (guard G5 pins that); `__addBookJobToken` is internal. */
const bookJobTokens = new Map<string, Array<{ token: symbol; kind: BookJobKind }>>();

/** INTERNAL -- only book-jobs.ts (and tests) call this. Adds a unique token for
 *  `(bookId, kind)` and returns its release. */
export function __addBookJobToken(bookId: string, kind: BookJobKind): () => void {
  const token = Symbol(kind);
  const list = bookJobTokens.get(bookId) ?? [];
  list.push({ token, kind });
  bookJobTokens.set(bookId, list);
  return () => {
    const cur = bookJobTokens.get(bookId);
    if (!cur) return;
    const next = cur.filter((t) => t.token !== token);
    if (next.length === 0) bookJobTokens.delete(bookId);
    else bookJobTokens.set(bookId, next);
  };
}

/** The kinds of long job currently registered for `bookId` (synchronous read,
 *  insertion order, one entry per live token). */
export function bookJobKinds(bookId: string): BookJobKind[] {
  return (bookJobTokens.get(bookId) ?? []).map((t) => t.kind);
}

/* ---- resolving a book ------------------------------------------------------ */

/* bookId -> bookDir, maintained by an AUTHORITATIVE locked resolve (a walk that
   found exactly one folder) and the movers. A HINT only: every use is verified by
   one state.json read. A bookId two folders carry (a legacy duplicate) is never
   indexed, so resolving it BY ID always walks and gets the first match, the same
   folder `findBookByBookId` (the unlocked GETs) returns. */
const bookDirById = new Map<string, string>();

/* bookIds a walk has seen in two folders. A mover never indexes one of these
   either: after a twin moves, the first match can be the OTHER twin. */
const duplicateBookIds = new Set<string>();

/** Test-only: the in-memory index. */
export function __bookDirIndexForTest(): Map<string, string> {
  return bookDirById;
}

/** Test-only: the duplicate-bookId verdicts. */
export function __duplicateBookIdsForTest(): Set<string> {
  return duplicateBookIds;
}

function listDirNames(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return sortDirNames(
      readdirSync(path, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    );
  } catch {
    return [];
  }
}

/** Every book folder dir under BOOKS_ROOT, in `findBookBy`'s order. */
function* walkBookDirs(): Generator<string> {
  ensureWorkspace();
  for (const author of listDirNames(BOOKS_ROOT)) {
    for (const series of listDirNames(join(BOOKS_ROOT, author))) {
      for (const title of listDirNames(join(BOOKS_ROOT, author, series))) {
        yield join(BOOKS_ROOT, author, series, title);
      }
    }
  }
}

/** Log a state.json read failure in full (its message embeds the absolute
 *  path) and return the path-free error to throw instead. */
function unreadableState(err: unknown): BookStateUnreadableError {
  console.warn('[book-op-lock] state.json read failed', err);
  return new BookStateUnreadableError();
}

/** The folder's state, or null when it is absent or does not parse (it carries
 *  no bookId anyone can resolve). Any other read failure (EBUSY / EPERM / EIO,
 *  which #3625's reader rethrows on purpose) is NOT absence: it is logged in
 *  full and rethrown as the path-free `BookStateUnreadableError`. */
export async function readBookStateOrThrow(dir: string): Promise<BookStateJson | null> {
  try {
    return await readStateJsonWithRecovery(stateJsonPath(dir));
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw unreadableState(err);
  }
}

async function readOwnedState(dir: string, bookId: string): Promise<BookStateJson | null> {
  const raw = await readBookStateOrThrow(dir);
  return raw && raw.bookId === bookId ? raw : null;
}

/** The ONLY place a resolve mutates shared state, and only for a LOCKED caller
 *  (`heal: true`): an unlocked `peekBook` that read the OLD dir just before a
 *  mover renamed it must not write that dir back into the index or the
 *  ManuscriptRecord (the #2165 split). The index and the record are written only
 *  for an `authoritative` candidate -- the index's own entry, or a walk's ONLY
 *  match. A caller's `hintDir` is not authoritative: a sweep or a walker locks
 *  each walked folder by its hint, and for a duplicated bookId that folder can be
 *  the second twin, which must not become what every later resolve-by-id (and
 *  the live record) points at (PR #3714 review pass 1). */
async function accept(
  bookId: string,
  bookDir: string,
  state: BookStateJson,
  heal: boolean,
  authoritative: boolean,
): Promise<{ bookDir: string; state: BookStateJson }> {
  if (!heal) return { bookDir, state };
  if (authoritative) healIndexAndRecord(bookId, bookDir, state);
  /* The same lazy engine-drift upgrade `findBookBy` applies, so a route that
     moved from `findBookByBookId` to `book.state` does not lose it. */
  const upgraded = await backfillAudioModelKeysFromSegments(bookDir, state);
  return { bookDir, state: upgraded.state };
}

function healIndexAndRecord(bookId: string, bookDir: string, state: BookStateJson): void {
  if (!duplicateBookIds.has(bookId)) bookDirById.set(bookId, bookDir);
  /* Heal a live ManuscriptRecord only when it is THIS book's: twin books can
     share a manuscriptId (twins that predate #3823's fresh-id mint on import, or a
     hand-copied folder), and healing the other twin's record would repoint it. */
  if (state.manuscriptId) {
    const rec = getManuscript(state.manuscriptId);
    if (rec && rec.bookId === bookId && rec.bookDir !== bookDir) {
      rec.bookDir = bookDir;
      putManuscript(rec);
    }
  }
}

/** Resolve a bookId to its folder. A candidate is accepted only if its
 *  `.audiobook/state.json` carries `bookId`. Tried in order: `hintDir`, the
 *  in-memory index, then a full tree walk with today's first-match behaviour
 *  (a second match is logged, server-log only, and the first wins). `heal`
 *  (locked callers only) lets an authoritative resolve write the index and the
 *  record. Without a hint, a duplicated bookId therefore always resolves to the
 *  first match.
 *
 *  A read failure (`BookStateUnreadableError`) is never "not this book", but it
 *  fails only what it can change (PR #3714 review pass 3, owner decision
 *  2026-10-18):
 *    - on the hint or the index entry (where the book is believed to live) it
 *      fails the resolve;
 *    - the walk skips PAST an unreadable folder. A later match is returned NON-
 *      authoritatively (no index write, no verdict change) -- the same folder the
 *      unlocked `findBookBy` returns at that moment, as it skips the fault too;
 *    - unless the id is a KNOWN duplicate (or this walk finds a second match):
 *      the unreadable folder may be the first twin, so the resolve fails;
 *    - no match at all after an unreadable folder fails ("gone" is unproved).
 *  Accepted residual: a duplicate nobody has detected yet whose FIRST twin is
 *  unreadable resolves to the second twin for as long as the fault lasts. */
async function resolveBook(
  bookId: string,
  hintDir: string | undefined,
  heal: boolean,
  skipHints = false,
): Promise<{ bookDir: string; state: BookStateJson } | null> {
  if (!skipHints) {
    for (const [candidate, authoritative] of [
      [hintDir, false],
      [bookDirById.get(bookId), true],
    ] as const) {
      if (!candidate) continue;
      const state = await readOwnedState(candidate, bookId);
      if (state) return accept(bookId, candidate, state, heal, authoritative);
    }
  }
  if (heal) bookDirById.delete(bookId);
  let first: { bookDir: string; state: BookStateJson } | null = null;
  let duplicate = false;
  let unreadable = false;
  let unreadableBeforeFirst = false;
  for (const dir of walkBookDirs()) {
    let state: BookStateJson | null;
    try {
      state = await readOwnedState(dir, bookId);
    } catch (err) {
      if (!(err instanceof BookStateUnreadableError)) throw err;
      unreadable = true;
      if (!first) unreadableBeforeFirst = true;
      continue;
    }
    if (!state) continue;
    if (!first) {
      first = { bookDir: dir, state };
    } else {
      duplicate = true;
      if (heal) duplicateBookIds.add(bookId);
      if (heal) bookDirById.delete(bookId);
      console.warn(
        `[book-op-lock] duplicate bookId "${bookId}" found at both ${first.bookDir} and ${dir}; using the first`,
      );
      break;
    }
  }
  /* A full walk that found ONE folder, and read every other one, clears an
     earlier duplicate verdict (the other twin was deleted or renamed to a
     different id). Only a LOCKED resolve may add to or clear the verdict: an
     unlocked peek can see one twin while a mover has the other mid-rename. */
  if (heal && first && !duplicate && !unreadable) duplicateBookIds.delete(bookId);
  if (unreadableBeforeFirst && (!first || duplicate || duplicateBookIds.has(bookId))) {
    throw new BookStateUnreadableError();
  }
  return first ? accept(bookId, first.bookDir, first.state, heal, !unreadable) : null;
}

/** A read-only resolve that takes NO lock and writes nothing a later resolve
 *  trusts (no index update, no record heal, no backfill, and no change to the
 *  duplicate-bookId verdict -- a peek can see one twin while a mover has the
 *  other mid-rename, so only a locked resolve may add to or clear it). The only sanctioned pre-lock
 *  resolve, for the two-span pattern; nothing it returns may feed a write. */
export async function peekBook(
  bookId: string,
  hintDir?: string,
): Promise<{ bookDir: string; state: BookStateJson } | null> {
  return resolveBook(bookId, hintDir, false);
}

/* ---- unforgeable handles ----------------------------------------------------- */

/* A module-private set of the handles `withBookOp*` handed out and has not yet
   released. A mover accepts a handle only if it is IN this set, so a spread copy
   (`{ ...book }`, which keeps `held: true`) or a hand-built object is refused. */
const liveHandles = new WeakSet<BookHandle>();

function makeHandle(bookId: string, resolved: { bookDir: string; state: BookStateJson }): BookHandle {
  const book: BookHandle = { bookId, ...resolved, held: true };
  liveHandles.add(book);
  return book;
}

function releaseHandle(book: BookHandle): void {
  book.held = false;
  liveHandles.delete(book);
}

/* ---- the locks -------------------------------------------------------------- */

/** Same curation as `withStateJsonLock`: the raw timeout (whose message embeds
 *  the lock key, hence an absolute path) goes to the log; the caller gets the
 *  curated sentence with the stable `code` kept so the fail-loud sites still
 *  recognise the class. */
async function curated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isLockAcquisitionTimeout(err)) {
      console.warn('[book-op-lock]', err);
      throw Object.assign(new Error(LOCK_CONTENTION_REQUEST_ERROR), {
        code: LOCK_ACQUISITION_TIMEOUT_CODE,
      });
    }
    throw err;
  }
}

export interface BookOpOptions {
  /** Where to look first (walkers and sweeps already know the folder). */
  hintDir?: string;
  /** Test-only override for the acquisition budget -- no production caller passes this. */
  timeoutMs?: number;
}

/** Hold `book-op:<bookId>` across `fn`, with the book resolved UNDER the lock.
 *  Returns `BOOK_GONE` (without calling `fn`) if the book no longer exists. */
export function withBookOp<T>(
  bookId: string,
  fn: (book: BookHandle) => Promise<T>,
  opts: BookOpOptions = {},
): Promise<T | typeof BOOK_GONE> {
  return curated(() =>
    withKeyLock(
      `book-op:${bookId}`,
      async () => {
        const resolved = await resolveBook(bookId, opts.hintDir, true);
        if (!resolved) return BOOK_GONE;
        const book = makeHandle(bookId, resolved);
        try {
          return await fn(book);
        } finally {
          releaseHandle(book);
        }
      },
      opts.timeoutMs,
    ),
  );
}

/** Hold several books' locks at once. Dedupes and sorts the ids (AB/BA cannot
 *  deadlock), chains one lock per id, hands `fn` the handles in sorted order,
 *  and returns `BOOK_GONE` if any book is gone. Rejects an empty list. */
export async function withBookOps<T>(
  bookIds: string[],
  fn: (books: BookHandle[]) => Promise<T>,
  opts: Pick<BookOpOptions, 'timeoutMs'> = {},
): Promise<T | typeof BOOK_GONE> {
  const ids = [...new Set(bookIds)].sort();
  /* An empty chain would run fn with no lock at all -- fail loudly instead. */
  if (ids.length === 0) throw new Error('withBookOps: no bookIds given');
  const step = (i: number, held: BookHandle[]): Promise<T | typeof BOOK_GONE> =>
    withKeyLock(
      `book-op:${ids[i]}`,
      async () => {
        const resolved = await resolveBook(ids[i], undefined, true);
        if (!resolved) return BOOK_GONE;
        const book = makeHandle(ids[i], resolved);
        try {
          const all = [...held, book];
          return i === ids.length - 1 ? await fn(all) : await step(i + 1, all);
        } finally {
          releaseHandle(book);
        }
      },
      opts.timeoutMs,
    );
  return curated(() => step(0, []));
}

/** A startup sweep's per-book step: lock the book found at `dir` and run `fn`
 *  against the folder it lives in NOW (a rename that queued ahead of the sweep
 *  moves it). A book whose state.json carries no `bookId` cannot be resolved by
 *  any route, so the API cannot move it: `fn` runs on `dir` unlocked. A state that
 *  cannot be READ (EBUSY / EPERM / EIO) is not "no bookId": the folder is skipped
 *  (`BOOK_GONE`, logged; the next startup retries) rather than run unlocked. A book that
 *  vanished while the sweep queued is skipped (`BOOK_GONE`). */
export async function withBookOpAtDir<T>(
  dir: string,
  fn: (bookDir: string) => Promise<T>,
): Promise<T | typeof BOOK_GONE> {
  let raw: BookStateJson | null;
  try {
    raw = await readStateJsonWithRecovery(stateJsonPath(dir));
  } catch (err) {
    if (!(err instanceof SyntaxError)) {
      console.warn('[book-op-lock] state.json read failed; skipping this folder', err);
      return BOOK_GONE;
    }
    raw = null;
  }
  if (!raw?.bookId) return fn(dir);
  return withBookOp(raw.bookId, ({ bookDir }) => fn(bookDir), { hintDir: dir });
}

/** One workspace-wide key held across "is this Author/Series/Title path free ->
 *  mkdir parents -> create or rename into it". Held by the movers and the book
 *  creators; closes the empty-parent `rmdir` race and the creator-vs-rename path
 *  collision with one primitive. Nests inside book-op, outside cast. */
export function withBookPathClaim<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
  return curated(() => withKeyLock('book-path-claim', fn, timeoutMs));
}

/* ---- the sanctioned movers ---------------------------------------------------- */

function assertHeld(book: BookHandle, what: string): void {
  if (!book.held || !liveHandles.has(book)) {
    throw new Error(`${what}: book handle is not held -- a mover must run inside withBookOp`);
  }
}

function assertNotBusy(bookId: string): void {
  const kinds = bookJobKinds(bookId);
  if (kinds.length > 0) throw new BookBusyError(kinds);
}

/** Rename a book's folder to `newDir`, writing `buildNext(fresh)` as its new
 *  state.json. Refuses (BookBusyError) while a long job is registered, and
 *  (BookPathTakenError) if `newDir` exists. EPERM/EBUSY/EACCES from the rename
 *  becomes BookFolderInUseError. On success the handle tracks the new folder.
 *
 *  Takes the per-book `book` lock (book-lock.ts, #3594) itself, INSIDE the path
 *  claim: book-op -> book-path-claim -> book -> state-json. A writer that holds
 *  only `book` (the workspace scan's self-heal, `updateStateAtDir`) therefore
 *  cannot run between this move's read and its write, and one queued behind it
 *  re-resolves to the new folder. The caller must NOT already hold `book` for
 *  this book in a different async context (re-entry in the same context is a
 *  no-op, per book-lock.ts). */
export async function moveBookFolder(
  book: BookHandle,
  newDir: string,
  buildNext: (fresh: BookStateJson) => BookStateJson,
): Promise<BookStateJson> {
  assertHeld(book, 'moveBookFolder');
  assertNotBusy(book.bookId);
  /* A mover is a capability: it must never be steered outside the library. */
  const relToRoot = relative(BOOKS_ROOT, newDir);
  if (!relToRoot || relToRoot === '..' || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
    throw new Error('moveBookFolder: newDir is not under the books root');
  }
  const oldDir = book.bookDir;
  return withBookPathClaim(() =>
    withBookLock(book.bookId, () =>
    withStateJsonLock(stateJsonPath(oldDir), async () => {
      /* A read failure here would put the raw fs error (with its absolute
         path) in the route's 500 body: curate it (PR #3714 review pass 3). */
      const fresh = await readStateJsonWithRecovery(stateJsonPath(oldDir)).catch((err: unknown) => {
        if (err instanceof SyntaxError) throw err;
        throw unreadableState(err);
      });
      if (!fresh) throw new Error('moveBookFolder: state.json is missing');
      const next = buildNext(fresh);
      if (existsSync(newDir)) throw new BookPathTakenError();
      await mkdir(dirname(newDir), { recursive: true });
      /* The moved file is addressed by a DIFFERENT state-json key from the one
         held (the old path): take the new key too so any writer of either path
         serialises. Old-held-then-new is the only nesting any caller does. */
      await withStateJsonLock(stateJsonPath(newDir), async () => {
        try {
          await renameWithRetry(oldDir, newDir);
        } catch (err) {
          if (isInUse(err)) throw new BookFolderInUseError();
          throw err;
        }
        if (duplicateBookIds.has(book.bookId)) bookDirById.delete(book.bookId);
        else bookDirById.set(book.bookId, newDir);
        book.bookDir = newDir;
        if (fresh.manuscriptId) {
          const rec = getManuscript(fresh.manuscriptId);
          if (rec && rec.bookId === book.bookId) {
            rec.bookDir = newDir;
            putManuscript(rec);
          }
        }
        /* Write the new state.json BEFORE pruning empty parents. */
        await writeStateJsonAtomic(stateJsonPath(newDir), { ...next, language: next.language ?? null });
      });
      book.state = next;
      /* Best-effort empty-parent prune, still inside the claim so it cannot race
         a creator's mkdir+rename into the same series directory. */
      const oldSeriesDir = dirname(oldDir);
      await rmdir(oldSeriesDir).catch(() => undefined);
      await rmdir(dirname(oldSeriesDir)).catch(() => undefined);
      return next;
    }),
    ),
  );
}

/** Delete a book's folder. Refuses (BookBusyError) while a long job is
 *  registered. EPERM/EBUSY/EACCES with the book's state still readable is
 *  BookFolderInUseError; an `rm` that fails after the state is already gone is
 *  BookPartlyDeletedError (the book has left the library).
 *
 *  Out-of-process defence (#3706): once the state-json lock is held, the folder
 *  is judged by the RECOVERING reader (#3625), never by main's existence: a
 *  rotating write leaves `state.json` absent for a window and a crash there
 *  strands the book on `.bak.1`, which is still this book and is removed. A
 *  state that no longer parses at all is still the folder resolved under
 *  book-op and is removed. Only a state that is GONE (no main, no backup) or
 *  names a DIFFERENT bookId means the folder was moved or replaced by something
 *  that does not take book-op while this call queued: re-resolve by bookId (a
 *  full walk) and delete the book where it now lives; if it is nowhere, resolve
 *  `'gone'` (the caller answers an idempotent 204). */
export async function removeBookFolder(book: BookHandle): Promise<'removed' | 'gone'> {
  assertHeld(book, 'removeBookFolder');
  assertNotBusy(book.bookId);
  const dir = book.bookDir;
  /* Called under `dir`'s state-json lock, so no in-process rotation is mid-flight. */
  const holdsThisBook = async (target: string): Promise<boolean> => {
    const fresh = await readStateJsonWithRecovery(stateJsonPath(target)).catch((err: unknown) => {
      if (err instanceof SyntaxError) return undefined;
      /* Curated: the raw fs error embeds the absolute path (review pass 3). */
      throw unreadableState(err);
    });
    if (fresh === null) return false;
    return fresh === undefined || fresh.bookId === book.bookId;
  };
  const rmFolder = async (target: string): Promise<void> => {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      const left = await readStateJsonWithRecovery(stateJsonPath(target)).catch(() => undefined);
      if (left === null) {
        bookDirById.delete(book.bookId);
        throw new BookPartlyDeletedError(book.state.title);
      }
      if (isInUse(err)) throw new BookFolderInUseError();
      throw err;
    }
  };
  const outcome = await withStateJsonLock(stateJsonPath(dir), async (): Promise<'removed' | 'gone'> => {
    if (await holdsThisBook(dir)) {
      await rmFolder(dir);
      return 'removed';
    }
    /* `heal = false` on purpose: this runs while holding `state-json`, and a
       healing resolve reaches `backfillAudioModelKeysFromSegments` (accept()),
       whose write takes the `book` lock -- `book` under `state-json` would
       invert the order (book -> state-json). A non-healing resolve takes no lock. */
    const moved = await resolveBook(book.bookId, undefined, false, true);
    if (!moved || moved.bookDir === dir) return 'gone';
    book.bookDir = moved.bookDir;
    book.state = moved.state;
    return withStateJsonLock(stateJsonPath(moved.bookDir), async () => {
      if (!(await holdsThisBook(moved.bookDir))) return 'gone';
      await rmFolder(moved.bookDir);
      return 'removed';
    });
  });
  bookDirById.delete(book.bookId);
  return outcome;
}

/* ---- minting ids ----------------------------------------------------------------- */

/** Every bookId some readable `state.json` under the books root carries, and
 *  whether any state could not be READ. An unreadable state's id is unknown --
 *  and not derivable from its path, since a renamed book keeps its old id -- so
 *  while one exists no id can be PROVED free (PR #3714 review pass 3). The
 *  callers answer that without failing: `isBookIdTaken` says "taken" (the
 *  bundle importer then mints), and `mintBookId` uses a suffix the counter never
 *  produces. One unreadable book therefore never blocks an unrelated import. */
export interface TakenIds {
  taken: Set<string>;
  takenManuscriptIds: Set<string>;
  uncertain: boolean;
}

export async function takenBookIds(): Promise<TakenIds> {
  const taken = new Set<string>();
  const takenManuscriptIds = new Set<string>();
  let uncertain = false;
  for (const dir of walkBookDirs()) {
    let raw: BookStateJson | null;
    try {
      raw = await readBookStateOrThrow(dir);
    } catch (err) {
      if (!(err instanceof BookStateUnreadableError)) throw err;
      uncertain = true;
      continue;
    }
    if (raw?.bookId) taken.add(raw.bookId);
    if (raw?.manuscriptId) takenManuscriptIds.add(raw.manuscriptId);
  }
  return { taken, takenManuscriptIds, uncertain };
}

/** True if `manuscriptId` is carried by a state in the walk -- or if one could not
 *  be read (it might). One ManuscriptRecord lives per manuscriptId, so a creator
 *  of a NEW book that would otherwise reuse an id another book carries (#3823)
 *  mints a fresh one instead. The walk covers `books/` only, so a bundle's own
 *  `.staging/` tree never counts as taken. Pure over a walk made under the path
 *  claim (`takenBookIds`). */
export function manuscriptIdTakenIn(ids: TakenIds, manuscriptId: string): boolean {
  return ids.uncertain || ids.takenManuscriptIds.has(manuscriptId);
}

/** `isBookIdTaken` over a walk the caller already made. */
export function bookIdTakenIn(ids: TakenIds, bookId: string): boolean {
  return ids.uncertain || ids.taken.has(bookId);
}

/** True if any `state.json` in the workspace carries `bookId` -- or if one could
 *  not be read (it might). Called under the path claim by creators that want to
 *  KEEP an incoming id (a portable bundle's) when it is free. */
export async function isBookIdTaken(bookId: string): Promise<boolean> {
  return bookIdTakenIn(await takenBookIds(), bookId);
}

/** A bookId no `state.json` in the workspace carries. Called under the path
 *  claim by NON-sample creators only. `makeBookId(...)` if free; otherwise
 *  `-2`, `-3`, ... is appended to the TITLE slug so `parseBookId` keeps its
 *  three parts. While some state is unreadable (it could carry the base or any
 *  counter id) the suffix is `-u<random hex>` instead, which the counter never
 *  produces. */
export async function mintBookId(author: string, series: string, title: string): Promise<string> {
  return mintBookIdFrom(await takenBookIds(), author, series, title);
}

/** `mintBookId` over a walk the caller already made (one walk answers the bookId
 *  and manuscriptId decisions of a bundle import, under the global claim). */
export function mintBookIdFrom(
  { taken, uncertain }: TakenIds,
  author: string,
  series: string,
  title: string,
): string {
  const base = makeBookId(author, series || STANDALONES_SERIES, title);
  if (!uncertain && !taken.has(base)) return base;
  const parts = parseBookId(base);
  if (!parts) throw new Error('mintBookId: makeBookId produced an unparseable id');
  if (uncertain) {
    for (;;) {
      const candidate = `${parts.authorSlug}__${parts.seriesSlug}__${parts.titleSlug}-u${randomBytes(4).toString('hex')}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  for (let n = 2; ; n++) {
    const candidate = `${parts.authorSlug}__${parts.seriesSlug}__${parts.titleSlug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
