#!/usr/bin/env node
/* Repair a book whose re-analysis loop dropped narration data.

   The 2026-06-05 The Drowning Bell incident: navigating a confirmed book into the
   analysing -> cast-confirm flow re-parsed the manuscript and re-ran analysis,
   which (a) cleared the `excluded` flags on non-narration chapters (Cover,
   Dedication, back-matter) so the book's status flipped back to 'analysing',
   and (b) dropped a chapter that had been added post-hoc via the Generate
   screen (the Preface, ch3) from BOTH manuscript-edits.json and the analysis
   cache — even though its audio was already rendered. With one narration
   chapter missing from the cache, `analysisComplete` (server/src/workspace/
   scan.ts) never reaches true, so the book is stranded on the strip-prone
   analysing flow.

   This restores, from a known-good UPGRADE BACKUP of the same book:
     1. `excluded: true` flags present in the backup but missing in live
        state.json (only ADDS flags — never removes a live one).
     2. manuscript-edits.json sentences for any NON-EXCLUDED chapter present in
        the backup but absent in live (inserted in ascending chapterId order;
        per-chapter sentence ids are preserved, nothing is renumbered).
     3. cache.chapters[<id>] for each such restored chapter, rebuilt as the
        sentence-index map the analyzer writes ({ "0": {id:1,...}, ... }) from
        the backup sentences — the cache itself is never backed up, so it is
        reconstructed from the backup manuscript-edits (identical sentence
        shape: id/chapterId/characterId/text/confidence).

   Live chapters that already have data are left untouched (idempotent). Every
   written file is copied to `<file>.bak-repair-<ts>` first.

   Dry-run by default. Pass --apply to write.

   Config via env (defaults target the The Drowning Bell incident):
     BOOK_DIR        live book dir (contains .audiobook/, audio/)
     BACKUP_BOOK_DIR known-good backup of the same book dir
     CACHE_FILE      analysis cache json (server/handoff/cache/<manuscriptId>.json)

   Usage:
     node scripts/repair-reanalysis-dropped-chapters.mjs           # dry-run
     node scripts/repair-reanalysis-dropped-chapters.mjs --apply    # write
*/

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APPLY = process.argv.includes('--apply');

const BOOK_DIR =
  process.env.BOOK_DIR ??
  'C:/AudiobookWorkspace/books/Della Renwick/The Hollow Tide/The Drowning Bell';
const BACKUP_BOOK_DIR =
  process.env.BACKUP_BOOK_DIR ??
  'C:/AudiobookWorkspace/.upgrade-backups/from-1.5.1-to-1.6.0-2026-06-03T08-50-28-849Z/books/Della Renwick/The Hollow Tide/The Drowning Bell';
const CACHE_FILE =
  process.env.CACHE_FILE ?? 'server/handoff/cache/mns_SrHkwRVFEu.json';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function backupThenWrite(path, value) {
  if (!APPLY) return;
  if (existsSync(path)) copyFileSync(path, `${path}.bak-repair-${stamp()}`);
  writeFileSync(path, JSON.stringify(value, null, 2));
}

const liveStatePath = join(BOOK_DIR, '.audiobook', 'state.json');
const liveEditsPath = join(BOOK_DIR, '.audiobook', 'manuscript-edits.json');
const bupStatePath = join(BACKUP_BOOK_DIR, '.audiobook', 'state.json');
const bupEditsPath = join(BACKUP_BOOK_DIR, '.audiobook', 'manuscript-edits.json');

for (const p of [liveStatePath, liveEditsPath, bupStatePath, bupEditsPath, CACHE_FILE]) {
  if (!existsSync(p)) {
    console.error(`MISSING required file: ${p}`);
    process.exit(1);
  }
}

const liveState = readJson(liveStatePath);
const bupState = readJson(bupStatePath);
const liveEdits = readJson(liveEditsPath);
const bupEdits = readJson(bupEditsPath);
const cache = readJson(CACHE_FILE);

console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);
console.log(`Book:   ${BOOK_DIR}`);
console.log(`Backup: ${BACKUP_BOOK_DIR}`);
console.log(`Cache:  ${CACHE_FILE}\n`);

/* --- 1. Restore missing `excluded` flags ------------------------------- */
const bupExcluded = new Set(
  (bupState.chapters ?? []).filter((c) => c.excluded).map((c) => c.id),
);
const liveById = new Map((liveState.chapters ?? []).map((c) => [c.id, c]));
const flagsToRestore = [];
for (const id of bupExcluded) {
  const live = liveById.get(id);
  if (live && !live.excluded) {
    flagsToRestore.push(`${id}:${live.title}`);
    live.excluded = true;
  }
}
console.log(`[1] excluded flags to restore (${flagsToRestore.length}): ${flagsToRestore.join(', ') || 'none'}`);

/* --- 2 & 3. Restore dropped NON-EXCLUDED chapters --------------------- */
const liveExcludedNow = new Set(
  (liveState.chapters ?? []).filter((c) => c.excluded).map((c) => c.id),
);
const liveEditChapterIds = new Set(liveEdits.sentences.map((s) => s.chapterId));
const bupByChapter = new Map();
for (const s of bupEdits.sentences) {
  if (!bupByChapter.has(s.chapterId)) bupByChapter.set(s.chapterId, []);
  bupByChapter.get(s.chapterId).push(s);
}

const restoredChapters = [];
for (const [chId, sentences] of [...bupByChapter].sort((a, b) => a[0] - b[0])) {
  if (liveExcludedNow.has(chId)) continue; // non-narration — flag only
  if (liveEditChapterIds.has(chId)) continue; // already present in live
  // (a) insert sentences into manuscript-edits, keeping ascending chapterId order
  const insertAt = liveEdits.sentences.findIndex((s) => s.chapterId > chId);
  const idx = insertAt === -1 ? liveEdits.sentences.length : insertAt;
  liveEdits.sentences.splice(idx, 0, ...sentences);
  // (b) rebuild cache.chapters[chId] as an ARRAY of sentence objects, ascending
  //     by id — the analyzer cache shape is Record<number, SentenceOutput[]>
  //     (server/src/store/analysis-cache.ts: chapters[n].map(...)), NOT an
  //     index-keyed object. Writing an object here makes the cache load throw
  //     "sentences.map is not a function".
  cache.chapters ??= {};
  if (!cache.chapters[String(chId)]) {
    cache.chapters[String(chId)] = [...sentences].sort((a, b) => a.id - b.id);
  }
  restoredChapters.push(`${chId} (${sentences.length} sentences)`);
}
console.log(`[2] manuscript-edits chapters restored (${restoredChapters.length}): ${restoredChapters.join(', ') || 'none'}`);
console.log(`[3] cache.chapters keys restored: ${restoredChapters.length ? restoredChapters.map((c) => c.split(' ')[0]).join(', ') : 'none'}`);

/* --- write ------------------------------------------------------------- */
if (flagsToRestore.length) backupThenWrite(liveStatePath, liveState);
if (restoredChapters.length) {
  backupThenWrite(liveEditsPath, liveEdits);
  backupThenWrite(CACHE_FILE, cache);
}

console.log(
  `\n${APPLY ? 'Done — files written (originals backed up to .bak-repair-*).' : 'Dry-run complete. Re-run with --apply to write.'}`,
);
