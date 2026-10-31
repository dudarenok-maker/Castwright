/* #3713 step 3 -- DETECTION half of the duplicate-bookId sweep (read-only).
   Plan: docs/features/288-book-op-lock.md, "Repair of existing duplicate bookIds
   (#3713)".

   Owner decision 1, REVISED 2026-10-31 (#3713 comment 6540314515): the twin with
   the WORK keeps the id, replacing "current first match". Ranking, in order:
     1. most chapters whose `audioRenderedAt` is a non-empty string;
     2. then most cast rows (`cast.json` `characters.length`; absent file = 0);
     3. then the older `createdAt` (missing / unparseable ranks after any valid);
     4. then walk order (the sorted path, dir-order.ts).

   This writes nothing; child 4 adds the repair and re-checks `bookId` under the
   `state-json` lock before writing. The reads here are unlocked on purpose: the
   sweep runs before the server listens.

   FAIL CLOSED: an unreadable state.json anywhere means its id is unknown (it
   could be a twin with more work), so the whole result is `[]` and the next
   startup retries. One twin's cast.json failing for any reason but absence skips
   just that group. */

import { relative, sep } from 'node:path';
import {
  BOOK_GONE,
  bookDirsInWalkOrder,
  mintBookId,
  readBookStateOrThrow,
  withBookOp,
  withBookPathClaim,
} from './book-op-lock.js';
import { updateStateAtDir } from './book-state-update.js';
import { BOOKS_ROOT, castJsonPath } from './paths.js';
import { readJson } from './state-io.js';

export interface DuplicateBookIdGroup {
  bookId: string;
  winnerDir: string;
  loserDirs: string[];
}

export interface TwinRankInput {
  dir: string;
  walkIndex: number;
  renderedChapters: number;
  castRows: number;
  createdAt: string | undefined;
}

/** Epoch ms of a valid ISO `createdAt`, or null (missing / unparseable). */
function createdMs(v: string | undefined): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** The winner, and the losers in WALK order. Pure. */
export function rankTwins(twins: TwinRankInput[]): { winner: TwinRankInput; losers: TwinRankInput[] } {
  if (twins.length === 0) throw new Error('rankTwins: no twins');
  const ranked = [...twins].sort((a, b) => {
    if (a.renderedChapters !== b.renderedChapters) return b.renderedChapters - a.renderedChapters;
    if (a.castRows !== b.castRows) return b.castRows - a.castRows;
    const ca = createdMs(a.createdAt);
    const cb = createdMs(b.createdAt);
    if (ca !== cb) {
      if (ca === null) return 1;
      if (cb === null) return -1;
      return ca - cb; // older wins
    }
    return a.walkIndex - b.walkIndex;
  });
  const winner = ranked[0];
  const losers = twins.filter((t) => t !== winner).sort((a, b) => a.walkIndex - b.walkIndex);
  return { winner, losers };
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Cast-row count; absence is 0, any other failure throws. */
async function castRowCount(dir: string): Promise<number> {
  try {
    const json = await readJson<{ characters?: unknown[] }>(castJsonPath(dir));
    return Array.isArray(json?.characters) ? json.characters.length : 0;
  } catch (err) {
    if (isEnoent(err)) return 0;
    throw err;
  }
}

export async function findDuplicateBookIdGroups(): Promise<DuplicateBookIdGroup[]> {
  const byId = new Map<string, TwinRankInput[]>();
  const dirs = bookDirsInWalkOrder();
  for (let walkIndex = 0; walkIndex < dirs.length; walkIndex++) {
    const dir = dirs[walkIndex];
    let state;
    try {
      state = await readBookStateOrThrow(dir);
    } catch {
      /* readBookStateOrThrow already logged the full error; this line stays path-free. */
      console.warn('[duplicate-bookid-sweep] a state.json is unreadable; skipping the sweep until next startup');
      return [];
    }
    if (!state || typeof state.bookId !== 'string' || state.bookId === '') continue;
    const renderedChapters = (state.chapters ?? []).filter(
      (c) => typeof c.audioRenderedAt === 'string' && c.audioRenderedAt !== '',
    ).length;
    const twin: TwinRankInput = { dir, walkIndex, renderedChapters, castRows: 0, createdAt: state.createdAt };
    const list = byId.get(state.bookId);
    if (list) list.push(twin);
    else byId.set(state.bookId, [twin]);
  }

  const groups: DuplicateBookIdGroup[] = [];
  for (const [bookId, twins] of byId) {
    if (twins.length < 2) continue;
    try {
      for (const t of twins) t.castRows = await castRowCount(t.dir);
    } catch (err) {
      console.warn(`[duplicate-bookid-sweep] cast.json unreadable for duplicate bookId ${bookId}; skipping that group`, err);
      continue;
    }
    const { winner, losers } = rankTwins(twins);
    groups.push({ bookId, winnerDir: winner.dir, loserDirs: losers.map((l) => l.dir) });
  }
  return groups;
}

/* ---- #3713 step 4 -- REPAIR half. Re-mints each loser's bookId; touches nothing
   else (no manuscriptId, no reference remap -- owner decision 2). ---- */

export interface DuplicateBookIdRepair {
  previousBookId: string;
  newBookId: string;
  /** RELATIVE to BOOKS_ROOT, '/'-separated. Never an absolute path: this reaches the client. */
  keptFolder: string;
  reassignedFolder: string;
}

let repairs: DuplicateBookIdRepair[] = [];

export function getDuplicateBookIdRepairs(): readonly DuplicateBookIdRepair[] {
  return repairs;
}

export function __resetDuplicateBookIdRepairsForTest(): void {
  repairs = [];
}

function relFolder(dir: string): string {
  return relative(BOOKS_ROOT, dir).split(sep).join('/');
}

/** Never throws: one failing loser is logged (raw error, server log only) and the rest continue. */
export async function repairDuplicateBookIds(): Promise<DuplicateBookIdRepair[]> {
  const done: DuplicateBookIdRepair[] = [];
  let groups: DuplicateBookIdGroup[] = [];
  try {
    groups = await findDuplicateBookIdGroups();
  } catch (err) {
    console.warn('[duplicate-bookid] detection failed; skipping the repair until next startup', err);
  }
  for (const group of groups) {
    for (const loserDir of group.loserDirs) {
      try {
        /* One withBookOp per loser, never nested. The hint is the only thing that
           aims the resolve at THIS twin rather than the walk-first one. */
        const result = await withBookOp(
          group.bookId,
          async (book) => {
            if (book.bookDir !== loserDir) {
              console.warn(
                `[duplicate-bookid] "${group.bookId}" resolved to ${book.bookDir}, not ${loserDir}; leaving it alone`,
              );
              return null;
            }
            return withBookPathClaim(async () => {
              const [author, series, title] = relative(BOOKS_ROOT, loserDir).split(sep);
              const newId = await mintBookId(author, series, title);
              const wrote = await updateStateAtDir(loserDir, (fresh) =>
                fresh.bookId === group.bookId ? { ...fresh, bookId: newId } : null,
              );
              return wrote ? newId : null;
            });
          },
          { hintDir: loserDir },
        );
        if (result === BOOK_GONE) {
          console.warn(`[duplicate-bookid] ${loserDir} is gone; nothing to repair`);
          continue;
        }
        if (result === null) {
          console.warn(`[duplicate-bookid] ${loserDir} was not rewritten for "${group.bookId}"`);
          continue;
        }
        console.warn(
          `[duplicate-bookid] "${group.bookId}" was carried by both ${group.winnerDir} and ${loserDir}; ` +
            `${group.winnerDir} keeps it (more work), ${loserDir} is now "${result}"`,
        );
        done.push({
          previousBookId: group.bookId,
          newBookId: result,
          keptFolder: relFolder(group.winnerDir),
          reassignedFolder: relFolder(loserDir),
        });
      } catch (err) {
        console.warn(`[duplicate-bookid] repair of "${group.bookId}" failed for one twin; continuing`, err);
      }
    }
  }
  repairs = done;
  return done;
}
