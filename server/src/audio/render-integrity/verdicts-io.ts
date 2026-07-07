import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../../workspace/state-io.js';
import { audioDir } from '../../workspace/paths.js';

export type Verdict = 'voice-match' | 'voice-mismatch' | 'inconclusive';

export interface VerdictRow {
  characterId: string;
  sentenceIds: number[];
  verdict: Verdict;
  cosine: number;
  severity: 'severe' | 'inconclusive' | null;
  fixable: boolean;
  expectedEngine: string;
  renderedEngine: string;
  referenceKind: 'in-book' | 'audition' | 'too-short';
  windowed: boolean;
  /** fs-51 — the chapter this row belongs to. Absent on files written before
      this field existed (a legacy book); the qa-report aggregator uses that
      absence to set `voiceDrift.attribution: 'legacy-unattributed'`. */
  chapterId?: number;
}

/** Write verdict rows atomically. */
export async function writeVerdicts(path: string, rows: VerdictRow[]): Promise<void> {
  await writeJsonAtomic(path, rows);
}

/** Read verdict rows from disk. Returns null on ENOENT (torn-write tolerant). */
export async function readVerdicts(path: string): Promise<VerdictRow[] | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw) as VerdictRow[];
}

/** Path for a chapter's attempted-sentinel file, sibling to its
 *  `<slug>.render-integrity.json` verdict file. Exported so `scoreBook`'s
 *  per-chapter loop (the writer, in aggregate.ts) and `deriveBookOutline`
 *  (the reader, below) can't drift on the naming convention. */
export function attemptedPath(root: string, slug: string): string {
  return join(root, `${slug}.render-integrity-attempted.json`);
}

/** Write an "attempted" sentinel for a chapter's render-integrity pass.
 *  Written unconditionally by `scoreBook`'s per-chapter loop, BEFORE the
 *  missing-embeddings skip, so its presence proves scoreBook actually began
 *  processing this chapter — independent of whether it went on to produce a
 *  `<slug>.render-integrity.json` verdict file. This is what lets
 *  `deriveBookOutline`/qa-report.ts tell "the gate never ran" (no sentinel
 *  anywhere) apart from "the gate ran and failed for every eligible chapter"
 *  (sentinels present, chaptersScored stays 0). */
export async function writeAttempted(path: string): Promise<void> {
  await writeJsonAtomic(path, { attemptedAt: new Date().toISOString() });
}

/** Returns true iff an attempted-sentinel exists at `path` (ENOENT → false). */
export async function readAttempted(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Cheap book-level outline derive — reads ONLY the per-chapter
 * `<slug>.render-integrity.json` verdict files, never the embeddings.
 *
 * Mirrors the `loadSegmentsFiles` rollup pattern (`segments-io.ts`).
 *
 * @param bookDir  The book's root directory on disk.
 * @param chapters Array of `{ id, slug }` identifying the book's chapters.
 */
export async function deriveBookOutline(
  bookDir: string,
  chapters: { id: number; slug: string }[],
): Promise<{
  issues: VerdictRow[];
  counts: { suspect: number; fixable: number; uncheckedCharacters: string[] };
  scoredChapterIds: number[];
  inconclusiveChapterIds: number[];
  /** fs-51 correctness fix — chapters where `scoreBook` actually began
   *  per-chapter processing (attempted sentinel present), regardless of
   *  whether that chapter went on to produce a verdict file. Lets callers
   *  distinguish "gate never ran" (empty) from "gate ran but every eligible
   *  chapter's embeddings failed" (non-empty, yet scoredChapterIds is still
   *  empty) — see qa-report.ts's `chaptersEmbedFailed` computation. */
  attemptedChapterIds: number[];
}> {
  const root = audioDir(bookDir);
  const issues: VerdictRow[] = [];
  const uncheckedSet = new Set<string>();
  const scoredChapterIds = new Set<number>();
  const inconclusiveChapterIds = new Set<number>();
  const attemptedChapterIds = new Set<number>();

  for (const ch of chapters) {
    if (await readAttempted(attemptedPath(root, ch.slug))) {
      attemptedChapterIds.add(ch.id);
    }

    const path = join(root, `${ch.slug}.render-integrity.json`);
    const rows = await readVerdicts(path);
    if (!rows) continue;
    scoredChapterIds.add(ch.id);

    for (const row of rows) {
      if (row.verdict === 'voice-mismatch') {
        issues.push(row);
      }
      if (row.verdict === 'inconclusive') {
        inconclusiveChapterIds.add(ch.id);
      }
      if (row.referenceKind === 'too-short') {
        uncheckedSet.add(row.characterId);
      }
    }
  }

  const uncheckedCharacters = Array.from(uncheckedSet).sort();

  return {
    issues,
    counts: {
      suspect: issues.length,
      fixable: issues.filter((r) => r.fixable).length,
      uncheckedCharacters,
    },
    scoredChapterIds: Array.from(scoredChapterIds).sort((a, b) => a - b),
    inconclusiveChapterIds: Array.from(inconclusiveChapterIds).sort((a, b) => a - b),
    attemptedChapterIds: Array.from(attemptedChapterIds).sort((a, b) => a - b),
  };
}
