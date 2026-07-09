/* fs-58 follow-up — per-chapter checkpointed script-review ledger.
   Persists RAW findings only, never appliability (that's a client-side,
   live-manuscript-dependent computation — see script-review-apply.ts's
   planApply). `version` is a book-scoped monotonic counter stored at the
   file's top level, not a per-entry counter, so a discard-then-re-review
   of the same chapter can never mint a value the deleted entry already
   used — see the design spec §4.2 for why a per-entry counter would
   defeat the stale-write guard. upsertChapterEntry ALWAYS replaces the
   prior entry (never merges ops into it) — a chapter is checkpointed
   exactly once per job run, so any pre-existing entry it finds is stale
   leftover from an earlier, never-resolved run, not something to append
   to. All mutations are serialized per-book via withKeyLock so the four
   writer paths (upsert, resolve, discard, PATCH) never clobber each other. */

import { readJson, writeJsonAtomic } from './state-io.js';
import { scriptReviewLedgerJsonPath } from './paths.js';
import { withKeyLock } from './file-lock.js';

export interface LedgerEntry {
  manuscriptId: string;
  version: number;
  ops: unknown[];
  selected: Record<string, boolean>;
  completedAt: string;
}

export interface LedgerFile {
  nextVersion: number;
  entries: Record<string, LedgerEntry>;
}

const EMPTY_LEDGER: LedgerFile = { nextVersion: 1, entries: {} };

async function loadRaw(bookDir: string): Promise<LedgerFile> {
  let raw: LedgerFile | null;
  try {
    raw = await readJson<LedgerFile>(scriptReviewLedgerJsonPath(bookDir));
  } catch {
    return { ...EMPTY_LEDGER };
  }
  if (!raw || typeof raw !== 'object' || !raw.entries) return { ...EMPTY_LEDGER };
  return raw;
}

/** Read the ledger, pruning any entry whose manuscriptId no longer matches
    the book's current one (a reparse renumbered its sentence ids — see
    spec §4.2/§7). The prune is read-time only; it isn't written back here,
    the next mutating call naturally persists the smaller entry set. */
export async function readLedger(bookDir: string, manuscriptId: string): Promise<LedgerFile> {
  const ledger = await loadRaw(bookDir);
  const entries: Record<string, LedgerEntry> = {};
  for (const [chapterId, entry] of Object.entries(ledger.entries)) {
    if (entry.manuscriptId === manuscriptId) entries[chapterId] = entry;
  }
  return { nextVersion: ledger.nextVersion, entries };
}

export async function upsertChapterEntry(
  bookDir: string,
  bookId: string,
  params: { chapterId: number; manuscriptId: string; ops: unknown[] },
): Promise<LedgerEntry> {
  return withKeyLock(`script-review-ledger:${bookId}`, async () => {
    const ledger = await loadRaw(bookDir);
    const key = String(params.chapterId);
    const entry: LedgerEntry = {
      manuscriptId: params.manuscriptId,
      version: ledger.nextVersion,
      ops: params.ops,
      selected: {},
      completedAt: new Date().toISOString(),
    };
    ledger.nextVersion += 1;
    ledger.entries[key] = entry;
    await writeJsonAtomic(scriptReviewLedgerJsonPath(bookDir), ledger);
    return entry;
  });
}

export async function resolveOps(
  bookDir: string,
  bookId: string,
  params: { chapterId: number; version: number; appliedOpKeys: string[] },
): Promise<{ ok: boolean }> {
  return withKeyLock(`script-review-ledger:${bookId}`, async () => {
    const ledger = await loadRaw(bookDir);
    const key = String(params.chapterId);
    const entry = ledger.entries[key];
    if (!entry || entry.version !== params.version) return { ok: false };
    const removed = new Set(params.appliedOpKeys);
    entry.ops = (entry.ops as Array<{ id: number; op: string }>).filter(
      (op) => !removed.has(`${params.chapterId}:${op.id}:${op.op}`),
    );
    for (const key2 of params.appliedOpKeys) delete entry.selected[key2];
    if (entry.ops.length === 0) {
      delete ledger.entries[key];
    } else {
      ledger.entries[key] = entry;
    }
    await writeJsonAtomic(scriptReviewLedgerJsonPath(bookDir), ledger);
    return { ok: true };
  });
}

export async function discardChapters(bookDir: string, bookId: string, chapterIds: number[]): Promise<void> {
  await withKeyLock(`script-review-ledger:${bookId}`, async () => {
    const ledger = await loadRaw(bookDir);
    for (const id of chapterIds) delete ledger.entries[String(id)];
    await writeJsonAtomic(scriptReviewLedgerJsonPath(bookDir), ledger);
  });
}

export async function patchSelection(
  bookDir: string,
  bookId: string,
  params: { chapterId: number; version: number; selected: Record<string, boolean> },
): Promise<{ ok: boolean }> {
  return withKeyLock(`script-review-ledger:${bookId}`, async () => {
    const ledger = await loadRaw(bookDir);
    const key = String(params.chapterId);
    const entry = ledger.entries[key];
    if (!entry || entry.version !== params.version) return { ok: false };
    entry.selected = { ...entry.selected, ...params.selected };
    ledger.entries[key] = entry;
    await writeJsonAtomic(scriptReviewLedgerJsonPath(bookDir), ledger);
    return { ok: true };
  });
}
