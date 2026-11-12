/* srv-1 — per-book deterministic merge journal.

   Every operation that folds one cast member into another AND rolls the
   source's name into the survivor's `aliases` records an entry here, so the
   unlink-alias route (server/src/routes/cast-aliases.ts) can later surface
   EXACTLY the sentences that merge rewrote — instead of reconstructing
   "impacted chapters" from the chapterCast roster, which over-reports.

   Three write sites, mirroring how the alias gets created in the first place:
     - manual merge (cast-merge.ts)         → appendManualEntry      (append-only)
     - post-stage-2 auto-fold (analysis.ts) → replaceFoldEntries     (idempotent)
     - dedup pass (analysis.ts)            → replaceDedupEntries    (idempotent)

   Lifecycle: a `fresh: true` re-analysis keeps the file's merges but clears
   every entry's `affected` refs (`clearAffectedRefs`, plan 291 rule 8); each fold pass replaces all `kind:'fold'` entries with that
   pass's set while preserving `kind:'manual'`; manual merges append.

   Only these three paths rewrite THIS book's per-sentence `characterId`. The
   stage-1 roster merge happens before sentence attribution exists, and
   cast-link-prior / voice-match / add-alias only attach a recognition label —
   none of them move sentences, so the unlink route correctly falls back to the
   chapterCast heuristic for aliases they produced. See the design doc.

   Same atomic-write + empty-on-missing contract as store/dropped-quotes.ts. */

import { existsSync } from 'node:fs';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { castMergesJsonPath } from '../workspace/paths.js';

/** A chapter-qualified sentence reference. Sentence ids are unique only within
    a chapter (stage2-chunk.ts assigns `id: i + 1` per chapter), so lineage
    MUST carry the chapterId — a bare id list is ambiguous across chapters. */
export interface AffectedSentence {
  chapterId: number;
  sentenceId: number;
}

export interface CastMergeEntry {
  /** ISO timestamp the entry was recorded. */
  ts: string;
  kind: 'manual' | 'fold' | 'dedup';
  /** Character id that disappeared in the merge. */
  sourceId: string;
  /** The name that became the alias on the target — the match key the unlink
      route uses, since the alias chip carries a name, not an id. */
  sourceName: string;
  /** Survivor that absorbed the source. */
  targetId: string;
  /** The exact sentences this merge rewrote source → target. */
  affected: AffectedSentence[];
}

export interface CastMergesFile {
  entries: CastMergeEntry[];
}

/* ── Pure transforms (no IO) ───────────────────────────────────────────── */

/** Append a manual-merge entry. Returns a new envelope. */
export function appendManualEntry(file: CastMergesFile, entry: CastMergeEntry): CastMergesFile {
  return { entries: [...file.entries, entry] };
}

/** Replace ALL fold entries with `foldEntries`, preserving every manual entry.
    Idempotent across resume / partial re-analysis — a re-fold can't accumulate
    duplicates. */
export function replaceFoldEntries(
  file: CastMergesFile,
  foldEntries: CastMergeEntry[],
): CastMergesFile {
  return { entries: [...file.entries.filter((e) => e.kind !== 'fold'), ...foldEntries] };
}

/** Turn a fold's `rewrites` map (old id → new id) into one journal entry per
    source. `affected` for each source = the (chapterId, sentenceId) of every
    PRE-FOLD sentence still attributed to that source; `sourceName` is looked up
    from the pre-fold roster (which still contains the folded sources). */
export function buildFoldJournalEntries(
  rewrites: Record<string, string>,
  preFoldSentences: ReadonlyArray<{ id: number; chapterId: number; characterId: string }>,
  characters: ReadonlyArray<{ id: string; name: string }>,
  ts: string,
): CastMergeEntry[] {
  const sourceIds = Object.keys(rewrites);
  if (sourceIds.length === 0) return [];
  const nameById = new Map(characters.map((c) => [c.id, c.name]));
  const affectedBySource = new Map<string, AffectedSentence[]>();
  for (const id of sourceIds) affectedBySource.set(id, []);
  for (const s of preFoldSentences) {
    const bucket = affectedBySource.get(s.characterId);
    if (bucket) bucket.push({ chapterId: s.chapterId, sentenceId: s.id });
  }
  return sourceIds.map((sourceId) => ({
    ts,
    kind: 'fold' as const,
    sourceId,
    sourceName: nameById.get(sourceId) ?? sourceId,
    targetId: rewrites[sourceId],
    affected: affectedBySource.get(sourceId) ?? [],
  }));
}

/** Replace ALL dedup entries with `dedupEntries`, preserving fold + manual.
    Idempotent across resume / re-analysis — orthogonal to replaceFoldEntries. */
export function replaceDedupEntries(
  file: CastMergesFile,
  dedupEntries: CastMergeEntry[],
): CastMergesFile {
  return { entries: [...file.entries.filter((e) => e.kind !== 'dedup'), ...dedupEntries] };
}

/** Like buildFoldJournalEntries but stamps kind:'dedup'. `affected` = the
    (chapterId, sentenceId) of every PRE-DEDUP sentence attributed to each source;
    `sourceName` from the pre-dedup roster. */
export function buildDedupJournalEntries(
  rewrites: Record<string, string>,
  preDedupSentences: ReadonlyArray<{ id: number; chapterId: number; characterId: string }>,
  characters: ReadonlyArray<{ id: string; name: string }>,
  ts: string,
): CastMergeEntry[] {
  const sourceIds = Object.keys(rewrites);
  if (sourceIds.length === 0) return [];
  const nameById = new Map(characters.map((c) => [c.id, c.name]));
  const affectedBySource = new Map<string, AffectedSentence[]>();
  for (const id of sourceIds) affectedBySource.set(id, []);
  for (const s of preDedupSentences) {
    const bucket = affectedBySource.get(s.characterId);
    if (bucket) bucket.push({ chapterId: s.chapterId, sentenceId: s.id });
  }
  return sourceIds.map((sourceId) => ({
    ts,
    kind: 'dedup' as const,
    sourceId,
    sourceName: nameById.get(sourceId) ?? sourceId,
    targetId: rewrites[sourceId],
    affected: affectedBySource.get(sourceId) ?? [],
  }));
}

/* ── IO ────────────────────────────────────────────────────────────────── */

/** Load the journal; returns `{ entries: [] }` when the file is absent. */
export async function loadCastMerges(bookDir: string): Promise<CastMergesFile> {
  const existing = await readJson<CastMergesFile>(castMergesJsonPath(bookDir));
  if (existing && Array.isArray(existing.entries)) return existing;
  return { entries: [] };
}

/** Persist atomically (same OneDrive-EPERM retry contract as state-io.ts). */
export async function saveCastMerges(bookDir: string, file: CastMergesFile): Promise<void> {
  await writeJsonAtomic(castMergesJsonPath(bookDir), file);
}

/** Plan 291 rule 8 (#4031) - Start fresh keeps the merges but not their sentence
    refs: every entry's `affected` points at sentences the fresh run regenerates,
    and the unlink-alias route intersects by them. Clears EVERY entry's refs (not
    just the manual ones; a fold or dedup entry names regenerated sentences too),
    so an unlink falls back to alias matching. No write when nothing carries a ref
    or the journal is absent. CALLER HOLDS THE CAST LOCK (manual merges append to
    the journal under it). */
export async function clearAffectedRefs(bookDir: string): Promise<void> {
  const file = await loadCastMerges(bookDir);
  if (!file.entries.some((e) => e.affected.length > 0)) return;
  await saveCastMerges(bookDir, { entries: file.entries.map((e) => ({ ...e, affected: [] })) });
}

/** Test/diagnostic helper — does the journal file exist on disk? */
export function castMergesExists(bookDir: string): boolean {
  return existsSync(castMergesJsonPath(bookDir));
}
