/* #3713 step 3 -- DETECTION half of the duplicate-bookId sweep (its reads write nothing;
   the REPAIR half further down does the writes).
   Plan: docs/features/288-book-op-lock.md, "Repair of existing duplicate bookIds
   (#3713)".

   Owner decision 1, REVISED 2026-10-31 (#3713 comment 6540314515): the twin with
   the WORK keeps the id, replacing "current first match". Ranking, in order:
     1. most chapters whose `audioRenderedAt` is a non-empty string;
     2. then most cast rows (`cast.json` `characters.length`; absent file = 0);
     3. then the older `createdAt` (missing / unparseable ranks after any valid);
     4. then walk order (the sorted path, dir-order.ts).

   Detection writes nothing; the repair half below re-checks `bookId` under the
   `state-json` lock before writing. The reads here are unlocked on purpose: the
   sweep runs before the server listens.

   FAIL CLOSED: an unreadable state.json anywhere means its id is unknown (it
   could be a twin with more work), so the whole result is `[]` and the next
   startup retries. So does a directory that exists but cannot be listed (a hidden
   folder could hold a twin or the next id). One twin's cast.json failing for any reason but absence skips
   just that group. */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { nanoid } from 'nanoid';
import {
  BOOK_GONE,
  bookDirsInWalkOrder,
  mintBookIdFrom,
  readBookStateOrThrow,
  takenBookIds,
  withBookOp,
  withBookPathClaim,
} from './book-op-lock.js';
import { updateStateAtDir } from './book-state-update.js';
import {
  BOOKS_ROOT,
  analysisLastOutcomeJsonPath,
  analysisStateJsonPath,
  bookExportManifestsDir,
  castJsonPath,
  droppedQuotesJsonPath,
  manuscriptHintsJsonPath,
  scriptReviewLedgerJsonPath,
} from './paths.js';
import { readJson, writeJsonAtomic } from './state-io.js';

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
  let dirs: string[];
  try {
    dirs = bookDirsInWalkOrder();
  } catch {
    /* A folder that exists but cannot be listed may hold a twin, or the id the
       counter would mint next: a partial walk is not the library. Path-free line. */
    console.warn('[duplicate-bookid-sweep] a directory is unlistable; skipping the sweep until next startup');
    return [];
  }
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

/* ---- #3713 step 4 -- REPAIR half. Re-mints each loser's bookId and re-points its
   export manifests; when the loser shares its manuscriptId with a twin it also
   gets a fresh manuscriptId and its own folder's files are rekeyed (PR #4004
   owner decision). No other reference remap -- owner decision 2. ---- */

export interface DuplicateBookIdRepair {
  previousBookId: string;
  newBookId: string;
  /** RELATIVE to BOOKS_ROOT, '/'-separated. Never an absolute path: this reaches the client. */
  keptFolder: string;
  reassignedFolder: string;
  /** The loser's manuscriptId before the repair, when it differed from every twin's
   *  (so a tab holding it can tell it holds the loser); null when it was shared and
   *  re-minted, which identifies nothing. */
  reassignedManuscriptId: string | null;
}

let repairs: DuplicateBookIdRepair[] = [];

export function getDuplicateBookIdRepairs(): readonly DuplicateBookIdRepair[] {
  return repairs;
}

export function __resetDuplicateBookIdRepairsForTest(): void {
  repairs = [];
}

export function __setDuplicateBookIdRepairsForTest(next: DuplicateBookIdRepair[]): void {
  repairs = next;
}

function relFolder(dir: string): string {
  return relative(BOOKS_ROOT, dir).split(sep).join('/');
}

/** The loser's export manifests embed the old bookId (and a download URL built from
 *  it), and routes/export.ts filters on it, so left alone its exports vanish while
 *  the artifact stays on disk. Called AFTER the state write, inside the same
 *  withBookOp span. Best-effort PER manifest: the state write is the authoritative
 *  one and the book is already reachable under its new id, so a manifest that
 *  cannot be rewritten is logged and left byte-for-byte as it was (its artifact
 *  stays on disk; the sweep does not retry it, the group is no longer a duplicate). */
async function rewriteExportManifests(loserDir: string, oldId: string, newId: string): Promise<void> {
  const dir = bookExportManifestsDir(loserDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return; // no exports dir (the common case)
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      const job = JSON.parse(await readFile(file, 'utf8')) as { bookId?: unknown; downloadUrl?: unknown };
      if (job.bookId !== oldId) continue;
      const oldUrl = `/api/books/${encodeURIComponent(oldId)}/`;
      const downloadUrl =
        typeof job.downloadUrl === 'string' && job.downloadUrl.startsWith(oldUrl)
          ? `/api/books/${encodeURIComponent(newId)}/${job.downloadUrl.slice(oldUrl.length)}`
          : job.downloadUrl;
      await writeJsonAtomic(file, { ...job, bookId: newId, downloadUrl });
    } catch (err) {
      console.warn(`[duplicate-bookid] could not re-point an export manifest of ${loserDir}; leaving it as is`, err);
    }
  }
}

/** Rewrite one JSON file in place when `mutate` reports a change. Best-effort:
 *  absent is skipped; unparseable or unwritable is logged and left byte-for-byte as
 *  it was. The state write already landed, so the book is reachable under its new
 *  ids and a file left behind degrades (hints re-parse, ledger entries prune at read
 *  time) rather than aliasing the other twin. */
async function rekeyJsonFile(file: string, mutate: (json: unknown) => boolean): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return; // absent (the common case)
  }
  try {
    const json = JSON.parse(raw) as unknown;
    if (mutate(json)) await writeJsonAtomic(file, json);
  } catch (err) {
    console.warn(`[duplicate-bookid] could not rekey manuscriptId in ${file}; leaving it as is`, err);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Swap `manuscriptId` on `node` when it is `oldId`. */
function swapId(node: unknown, oldId: string, newId: string): boolean {
  if (!isRecord(node) || node.manuscriptId !== oldId) return false;
  node.manuscriptId = newId;
  return true;
}

/** Everything in the loser's OWN folder keyed on its manuscriptId. NOT carried: the
 *  analysis cache (`handoff/cache/{manuscriptId}.json`) is global and shared by
 *  both twins under the old id, so it stays with the winner. Called AFTER the state
 *  write, inside the same withBookOp span. */
async function rekeyManuscriptId(loserDir: string, oldId: string, newId: string): Promise<void> {
  await rekeyJsonFile(manuscriptHintsJsonPath(loserDir), (j) => {
    const entries = isRecord(j) ? j.entries : null;
    if (!Array.isArray(entries)) return false;
    return entries.map((e) => swapId(e, oldId, newId)).some(Boolean);
  });
  await rekeyJsonFile(scriptReviewLedgerJsonPath(loserDir), (j) => {
    const entries = isRecord(j) ? j.entries : null;
    if (!isRecord(entries)) return false;
    return Object.values(entries).map((e) => swapId(e, oldId, newId)).some(Boolean);
  });
  for (const file of [
    droppedQuotesJsonPath(loserDir),
    analysisStateJsonPath(loserDir),
    analysisLastOutcomeJsonPath(loserDir),
  ]) {
    await rekeyJsonFile(file, (j) => swapId(j, oldId, newId));
  }
}

/** True when another member of the group carries `manuscriptId`. One ManuscriptRecord
 *  lives per id and hydrate takes the first match, so a shared id aliases the twins.
 *  An unreadable twin counts as sharing: a spare id costs a cache, an alias costs data. */
async function twinSharesManuscriptId(
  group: DuplicateBookIdGroup,
  loserDir: string,
  manuscriptId: string,
): Promise<boolean> {
  for (const dir of [group.winnerDir, ...group.loserDirs]) {
    if (dir === loserDir) continue;
    try {
      if ((await readBookStateOrThrow(dir))?.manuscriptId === manuscriptId) return true;
    } catch {
      return true;
    }
  }
  return false;
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
            const wrote = await withBookPathClaim(async () => {
              const [author, series, title] = relative(BOOKS_ROOT, loserDir).split(sep);
              const ids = await takenBookIds();
              const newBookId = mintBookIdFrom(ids, author, series, title);
              const oldMs = book.state.manuscriptId;
              let newMs: string | null = null;
              if (oldMs && (await twinSharesManuscriptId(group, loserDir, oldMs))) {
                do newMs = `mns_${nanoid(10)}`;
                while (ids.takenManuscriptIds.has(newMs));
              }
              const written = await updateStateAtDir(loserDir, (fresh) =>
                fresh.bookId === group.bookId
                  ? {
                      ...fresh,
                      bookId: newBookId,
                      ...(newMs && fresh.manuscriptId === oldMs ? { manuscriptId: newMs } : {}),
                    }
                  : null,
              );
              return written ? { newBookId, oldMs, newMs } : null;
            });
            if (wrote === null) return null;
            await rewriteExportManifests(loserDir, group.bookId, wrote.newBookId);
            if (wrote.oldMs && wrote.newMs) await rekeyManuscriptId(loserDir, wrote.oldMs, wrote.newMs);
            return { newBookId: wrote.newBookId, reassignedManuscriptId: wrote.oldMs && !wrote.newMs ? wrote.oldMs : null };
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
            `${group.winnerDir} keeps it (ranked first), ${loserDir} is now "${result.newBookId}"`,
        );
        done.push({
          previousBookId: group.bookId,
          newBookId: result.newBookId,
          keptFolder: relFolder(group.winnerDir),
          reassignedFolder: relFolder(loserDir),
          reassignedManuscriptId: result.reassignedManuscriptId,
        });
      } catch (err) {
        console.warn(`[duplicate-bookid] repair of "${group.bookId}" failed for one twin; continuing`, err);
      }
    }
  }
  repairs = done;
  return done;
}
