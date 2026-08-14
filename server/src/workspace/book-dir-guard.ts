/* Issue #2196 — guard every book-directory write against a stale path.

   An out-of-process move/rename of a book folder leaves the in-memory
   ManuscriptRecord.bookDir pointing at a dead path. Because `writeJsonAtomic`
   does `mkdir(dirname, { recursive: true })` before writing, the next write
   through that stale path silently RE-CREATES the directory at the old
   location, resurrecting a folder the user believed they had moved away.

   This module is the gate: before ANY caller writes into a book folder it
   resolves a *verified* bookDir. It never creates a directory — it only
   reads (identity checks), removes the stale in-memory record, and re-hydrates
   from the workspace tree. On an unresolvable path it refuses (throw or
   drop) so nothing is written to a path we cannot prove is the right book.

   Deliberately structural: it does NOT import AnalysisJob from
   routes/analysis.ts (that route imports THIS guard — a static import would
   be a cycle). Callers pass `{ manuscriptId, candidateBookDir }` where
   candidateBookDir is the live `bookDir` from the in-memory record (or the
   job's copy when the record is gone). */

import { existsSync } from 'node:fs';
import { readJson } from './state-io.js';
import { stateJsonPath } from './paths.js';
import { getOrHydrateManuscript, removeManuscript } from '../store/manuscripts.js';
import type { BookStateJson } from './scan.js';

/** Thrown when a write target cannot be proven to be this manuscript's book.
    The code is a stable marker callers can switch on (e.g. to surface the
    stale-folder state to the UI instead of a generic ENOENT). */
export class BookDirUnresolvedError extends Error {
  readonly code = 'STALE_BOOK_DIR';
  constructor(message?: string) {
    super(message ?? 'Book directory is stale or unresolvable; refusing to write.');
    this.name = 'BookDirUnresolvedError';
  }
}

export type VerifyBookDirResult =
  | { status: 'ok'; bookDir: string }
  | { status: 'unresolved'; invalidated: boolean };

export interface VerifyBookDirForWriteOpts {
  manuscriptId: string;
  candidateBookDir: string | null;
  /** Default true — require a matching state.json identity before trusting
      the candidate path. identityBearing:false is the delete/cleanup-only
      fast path (see `resolveVerifiedBookDir`) where mere existence is enough. */
  identityBearing?: boolean;
  /** Optional bookId the verified state.json must also carry. Only meaningful
      from a freshly re-hydrated record (guards cross-book contamination). */
  expectedBookId?: string;
}

/** Throw-variant opts merged with the drop/throw mode selector for
    `withVerifiedBookDir`. */
export interface WithVerifiedBookDirOpts extends VerifyBookDirForWriteOpts {
  /* When the path is unresolvable: 'throw' (default) surfaces a
     BookDirUnresolvedError; 'drop' skips the callback entirely so a
     cleanup/aggregate passes silently over a dead book. */
  mode?: 'throw' | 'drop';
}

/* ------------------------------------------------------------------ *
 * Core resolution. Shared by all three public entry points so the    *
 * fast/full/slow decision tree is defined in exactly one place.      *
 * ------------------------------------------------------------------ */

async function resolveVerifiedBookDir(
  opts: VerifyBookDirForWriteOpts,
): Promise<VerifyBookDirResult> {
  const manuscriptId = opts.manuscriptId;
  const candidate = opts.candidateBookDir;

  /* FAST PATH (identityBearing:false, deletes/cleanup only): mere existence
     of the candidate dir is enough. The caller has already decided this write
     is non-identity (e.g. deleting a stale analysis-state file), so we trust
     an on-disk dir and only divert when the dir is gone entirely. */
  if (opts.identityBearing === false) {
    if (candidate && existsSync(candidate)) {
      return { status: 'ok', bookDir: candidate };
    }
    /* Missing → fall through to the slow path. */
  } else if (candidate && existsSync(candidate)) {
    /* FULL PATH (identityBearing, default true): the candidate dir must carry
       this manuscript's identity in .audiobook/state.json (and, when supplied,
       the expected bookId too). Any failure — missing dir, unreadable/missing
       state.json, or an identity mismatch (incl. a stale A-path now holding
       book B) — refuses the candidate and diverts to the slow path. */
    const state = await readJson<BookStateJson>(stateJsonPath(candidate)).catch(() => null);
    if (
      state &&
      state.manuscriptId === manuscriptId &&
      (opts.expectedBookId === undefined || state.bookId === opts.expectedBookId)
    ) {
      return { status: 'ok', bookDir: candidate };
    }
  }

  /* SLOW PATH — invalidate + re-hydrate from the workspace tree. Removing the
     stale in-memory record forces `getOrHydrateManuscript` to re-locate the
     book on disk (findBookByManuscriptId) and register the fresh bookDir. */
  removeManuscript(manuscriptId);
  const rehydrated = await getOrHydrateManuscript(manuscriptId);
  const freshDir = rehydrated?.bookDir;
  if (typeof freshDir === 'string' && freshDir.length > 0) {
    return { status: 'ok', bookDir: freshDir };
  }
  return { status: 'unresolved', invalidated: true };
}

/* ------------------------------------------------------------------ *
 * Public API                                                          *
 * ------------------------------------------------------------------ */

/** Verify a write target, invalidating + re-hydrating on a miss. THROWS
    BookDirUnresolvedError when the path can't be proven (the 'throw' variant);
    callers doing cleanup that tolerates a dead book should use
    `tryResolveVerifiedBookDir` instead. */
export async function verifyBookDirForWrite(
  opts: VerifyBookDirForWriteOpts,
): Promise<VerifyBookDirResult> {
  const result = await resolveVerifiedBookDir(opts);
  if (result.status === 'unresolved') {
    throw new BookDirUnresolvedError();
  }
  return result;
}

/** Resolve a verified bookDir, or return null when the path is unresolvable
    (the 'drop'/nullable variant — never throws). Returns the fresh re-hydrated
    path when the candidate was stale but the book still lives in the workspace. */
export async function tryResolveVerifiedBookDir(ctx: {
  manuscriptId: string;
  candidateBookDir: string | null;
  identityBearing?: boolean;
}): Promise<string | null> {
  const result = await resolveVerifiedBookDir(ctx);
  return result.status === 'ok' ? result.bookDir : null;
}

/** Run `fn(bookDir)` only against a verified bookDir. On an unresolvable path,
    mode:'throw' (default) throws BookDirUnresolvedError and mode:'drop' skips
    the callback so the caller can sweep a library without halting on a dead book. */
export async function withVerifiedBookDir(
  ctx: WithVerifiedBookDirOpts,
  fn: (bookDir: string) => Promise<void>,
): Promise<void> {
  const result = await resolveVerifiedBookDir(ctx);
  if (result.status === 'unresolved') {
    if (ctx.mode === 'drop') return;
    throw new BookDirUnresolvedError();
  }
  await fn(result.bookDir);
}

