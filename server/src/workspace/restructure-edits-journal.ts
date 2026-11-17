/* The restructure edits journal (#4227).

   The gap. `applyRestructureClaimed` writes state.json and then
   manuscript-edits.json. A crash between the two writes, or a throw from the
   edits write, leaves the new chapter list in state.json beside sentences still
   keyed to the OLD chapter ids, and nothing re-keys them.

   The journal. `<book>/.audiobook/restructure-edits-journal.json`:
     { schema: 1, editsSha256, chapters: [{ id, uuid }], remap }
   `editsSha256` is the sha of the manuscript-edits.json bytes the restructure
   read, `chapters` the NEW chapter list in order, `remap` the transform's
   `result.remap` verbatim. The edits rewrite is a pure function of (old edits,
   remap), so that is all a replay needs; it carries no sentence text.

   Replay guards. Applying the remap to anything but its own input would corrupt
   the edits, so every other case discards the journal:
     c. state.json's `[id, uuid]` chapter sequence must equal `chapters`. It
        proves the restructured list is the one on disk now: if the state write
        never landed the old list is there, and a legacy book's old list had no
        uuids, so it never matches.
     d. the edits file's sha must equal `editsSha256`. It proves the edits are
        byte-for-byte the input the remap was computed from: a rewrite that
        already landed, or a client save since, changes the sha.

   Triggers: the start of every restructure, and server boot (both added by later
   children of #4227). Reads never replay a journal.

   Lock order (CLAUDE.md): book-op -> restructure-gate -> book -> state-json. The
   caller already holds book-op and the gate; replay takes `book` (re-entrant)
   then `state-json`, under which it does plain file operations only.

   This is separate from #3456's planned relabel journal (spec
   docs/superpowers/specs/2026-11-13-chapter-take-lifecycle-design.md section
   5.A) and adds no state.json field.

   Accepted residual: an in-process edits-write failure WITHOUT a crash leaves
   the old-keyed edits until the next restructure of that book or the next
   server start. A client save of manuscript-edits.json in that window changes
   the sha, so the journal is then discarded rather than applied. */

import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { withBookLock } from './book-lock.js';
import { BOOK_GONE, bookJobKinds, readBookStateOrThrow, withBookOp } from './book-op-lock.js';
import { beginRestructure, endRestructure, isRestructuring } from './restructure-gate.js';
import { collectBooks } from './scan.js';
import { withStateJsonLock } from './file-lock.js';
import { readEditsForHintsCheck } from './hints-proof-io.js';
import { manuscriptEditsJsonPath, restructureEditsJournalPath, stateJsonPath } from './paths.js';
import {
  applySentenceRemap,
  carryMergedAwayKeys,
  type RestructureSentence,
  type SentenceRemap,
} from './restructure.js';
import { writeJsonAtomic } from './state-io.js';
import { refreshCacheFromEdits } from '../store/analysis-cache-rebuild.js';
import type { BookStateJson } from './scan.js';

export interface RestructureEditsJournal {
  schema: 1;
  editsSha256: string;
  chapters: Array<{ id: number; uuid: string }>;
  remap: SentenceRemap[];
}

/** Persist the journal. Throws on failure, so the caller never reaches the
    state.json write without it. */
export async function writeRestructureEditsJournal(
  bookDir: string,
  entry: Omit<RestructureEditsJournal, 'schema'>,
): Promise<void> {
  await writeJsonAtomic(restructureEditsJournalPath(bookDir), { schema: 1, ...entry });
}

/** Best-effort unlink. ENOENT is ignored; any other error is logged and not
    thrown (a leftover is discarded by the next replay's sha guard). */
export async function clearRestructureEditsJournal(bookDir: string): Promise<void> {
  try {
    await unlink(restructureEditsJournalPath(bookDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
    console.warn('[restructure-edits-journal] could not clear the journal', err);
  }
}

function isRemapEntry(r: unknown): r is SentenceRemap {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.oldChapterId === 'number' &&
    typeof o.oldSentenceId === 'number' &&
    typeof o.newChapterId === 'number' &&
    typeof o.newSentenceId === 'number'
  );
}

function parseJournal(text: string): RestructureEditsJournal | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const j = raw as Record<string, unknown>;
  if (j.schema !== 1 || typeof j.editsSha256 !== 'string') return null;
  if (!Array.isArray(j.chapters) || !Array.isArray(j.remap)) return null;
  const chaptersOk = j.chapters.every(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as { id?: unknown }).id === 'number' &&
      typeof (c as { uuid?: unknown }).uuid === 'string',
  );
  if (!chaptersOk || !j.remap.every(isRemapEntry)) return null;
  return raw as RestructureEditsJournal;
}

type Outcome = 'none' | 'replayed' | 'discarded';

export async function replayRestructureEditsJournal(bookDir: string, bookId: string): Promise<Outcome> {
  if (!existsSync(restructureEditsJournalPath(bookDir))) return 'none';

  return withBookLock(bookId, async () => {
    let landedState: BookStateJson | null = null;

    const discard = async (reason: string): Promise<Outcome> => {
      console.warn(`[restructure-edits-journal] discarding the journal for ${bookDir}: ${reason}`);
      await clearRestructureEditsJournal(bookDir);
      return 'discarded';
    };

    const outcome = await withStateJsonLock(stateJsonPath(bookDir), async (): Promise<Outcome> => {
      // a. read and validate the journal
      let text: string;
      try {
        text = await readFile(restructureEditsJournalPath(bookDir), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 'none';
        return discard('journal unreadable');
      }
      const journal = parseJournal(text);
      if (!journal) return discard('journal unreadable');

      // b. state.json
      const state = await readBookStateOrThrow(bookDir);
      if (!state) return 'none';

      // c. did the restructured state land, and is it still that state?
      const landed =
        state.chapters.length === journal.chapters.length &&
        state.chapters.every((c, i) => c.id === journal.chapters[i]!.id && c.uuid === journal.chapters[i]!.uuid);
      if (!landed) return discard('state.json did not land or chapters changed');

      // d. are the edits still the pre-restructure ones?
      const editsRead = await readEditsForHintsCheck(bookDir);
      if (editsRead.kind !== 'ok' || editsRead.sha256 !== journal.editsSha256) {
        return discard('edits rewritten or replaced since');
      }

      // e. redo the rewrite (same shape as chapters-restructure.ts), then clear
      const old = editsRead.value as { sentences?: RestructureSentence[]; mergedAwayKeys?: string[] } | null;
      await writeJsonAtomic(manuscriptEditsJsonPath(bookDir), {
        sentences: applySentenceRemap(old?.sentences ?? [], journal.remap),
        ...(old?.mergedAwayKeys ? { mergedAwayKeys: carryMergedAwayKeys(old.mergedAwayKeys, journal.remap) } : {}),
      });
      await clearRestructureEditsJournal(bookDir);
      landedState = state;
      return 'replayed';
    });

    // 3. the interrupted restructure never rebuilt the cache; best-effort like the route
    if (outcome === 'replayed' && landedState) {
      await refreshCacheFromEdits(landedState, manuscriptEditsJsonPath(bookDir), { mode: 'replace' }).catch((e) => {
        console.error('[restructure-edits-journal] cache rebuild failed', e);
      });
    }
    return outcome;
  });
}

export interface ReplayAllResult {
  replayed: string[];
  discarded: string[];
  /** bookIds: a job or the restructure gate was busy */
  skipped: string[];
  errors: Array<{ bookId: string; message: string }>;
}

/** Boot sweep (#4227): replay every book's pending edits journal once at server
    start. Covers the crash case: the process died between the restructure's
    state.json write and its manuscript-edits.json write. A book with a running
    job or a held restructure gate is skipped and its journal left for the next
    start or the next restructure of that book. Lock order (CLAUDE.md):
    book-op -> restructure-gate -> book -> state-json; a throw for one book is
    recorded and the walk continues. */
export async function replayAllRestructureEditsJournals(): Promise<ReplayAllResult> {
  const out: ReplayAllResult = { replayed: [], discarded: [], skipped: [], errors: [] };
  for (const { bookDir, state } of await collectBooks()) {
    const bookId = state.bookId;
    const manuscriptId = state.manuscriptId;
    if (!bookId || !manuscriptId) continue;
    if (!existsSync(restructureEditsJournalPath(bookDir))) continue;
    try {
      const res = await withBookOp(bookId, async (book) => {
        if (bookJobKinds(bookId).length > 0) return 'skipped' as const;
        // a held gate is a restructure in flight; beginRestructure alone only refuses for analysis
        if (isRestructuring(manuscriptId) || !beginRestructure(manuscriptId)) return 'skipped' as const;
        try {
          return await replayRestructureEditsJournal(book.bookDir, bookId);
        } finally {
          endRestructure(manuscriptId);
        }
      });
      if (res === BOOK_GONE || res === 'none') continue;
      out[res].push(bookId);
    } catch (e) {
      out.errors.push({ bookId, message: (e as Error).message });
    }
  }
  return out;
}
