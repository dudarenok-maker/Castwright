/* Apply a chapter restructure's audio-side plan: rename slug-named files
   for chapters that just renumbered, delete files for chapters whose
   content changed.

   Files involved per chapter (any subset may exist):
     <slug>.mp3         the audio itself
     <slug>.segments.json  per-segment timing + chapter metadata
     <slug>.peaks.json     waveform peaks summary (plan 35-related)

   Rename strategy is two-pass via a temp slug to avoid collisions on
   permutations (chapter 3 → 1, chapter 1 → 3 would otherwise clobber
   the second file with the just-renamed first).

   Failures within a batch don't throw — every op is best-effort and the
   returned summary surfaces what didn't apply. An orphan `.relabel-*`
   file left behind by a partial pass is recoverable by manual rename or
   a future fsck (see plan 51 follow-up); we prefer that over half-
   clobbering source files.

   See docs/features/archive/51-restructure-chapters.md. */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';

/** Suffixes of the three companion files per chapter audio. Kept in one
    array so add-a-new-companion changes touch one site. */
const COMPANION_SUFFIXES = ['mp3', 'segments.json', 'peaks.json'] as const;
type CompanionSuffix = (typeof COMPANION_SUFFIXES)[number];

export type ChapterAudioOp =
  | { kind: 'delete'; from: string }
  | {
      kind: 'rename';
      from: string;
      to: string;
      newChapterId: number;
      newChapterTitle: string;
    };

export interface AudioSlugRewriteSummary {
  /** Companion files moved to their new slugs. Each entry is one rename
      pair, surfaced per-companion-suffix for granular trace. */
  renamed: Array<{ from: string; to: string; suffix: CompanionSuffix }>;
  /** Companion files deleted. */
  deleted: Array<{ slug: string; suffix: CompanionSuffix }>;
  /** Errors caught during the batch — string `message` plus context for
      diagnosis. The op is otherwise reported as not-done; downstream
      regen still works because the audio file is either gone or stale. */
  errors: Array<{ op: ChapterAudioOp; message: string; suffix?: CompanionSuffix }>;
}

function suffixPath(audioRoot: string, slug: string, suffix: CompanionSuffix): string {
  return join(audioRoot, `${slug}.${suffix}`);
}

/** Apply a batch of audio ops against the book's audio/ directory. */
export async function rewriteChapterSlugs(
  audioRoot: string,
  ops: ChapterAudioOp[],
): Promise<AudioSlugRewriteSummary> {
  const summary: AudioSlugRewriteSummary = {
    renamed: [],
    deleted: [],
    errors: [],
  };

  if (!existsSync(audioRoot)) return summary;

  const renames = ops.filter((op): op is Extract<ChapterAudioOp, { kind: 'rename' }> => op.kind === 'rename');
  const deletes = ops.filter((op): op is Extract<ChapterAudioOp, { kind: 'delete' }> => op.kind === 'delete');

  // Phase 1: rename each source slug's companion files to a unique temp slug.
  // Tracking which (op, suffix, tempSlug) tuples succeeded lets phase 2 only
  // try to finalise the ones it owns.
  interface StagedRename {
    op: Extract<ChapterAudioOp, { kind: 'rename' }>;
    tempSlug: string;
    /** Suffixes that successfully moved to the temp slug. */
    stagedSuffixes: CompanionSuffix[];
  }
  const staged: StagedRename[] = [];

  for (const op of renames) {
    const tempSlug = `${op.from}.relabel-${randomUUID()}`;
    const stagedSuffixes: CompanionSuffix[] = [];
    for (const suffix of COMPANION_SUFFIXES) {
      const src = suffixPath(audioRoot, op.from, suffix);
      if (!existsSync(src)) continue;
      const tmp = suffixPath(audioRoot, tempSlug, suffix);
      try {
        await renameWithRetry(src, tmp);
        stagedSuffixes.push(suffix);
      } catch (e) {
        summary.errors.push({
          op,
          message: `phase 1 rename to temp failed: ${(e as Error).message}`,
          suffix,
        });
      }
    }
    staged.push({ op, tempSlug, stagedSuffixes });
  }

  // Phase 2: finalise temp slugs to their target slugs.
  for (const { op, tempSlug, stagedSuffixes } of staged) {
    for (const suffix of stagedSuffixes) {
      const tmp = suffixPath(audioRoot, tempSlug, suffix);
      const dest = suffixPath(audioRoot, op.to, suffix);
      try {
        await renameWithRetry(tmp, dest);
        summary.renamed.push({ from: op.from, to: op.to, suffix });
      } catch (e) {
        summary.errors.push({
          op,
          message: `phase 2 rename to dest failed: ${(e as Error).message}`,
          suffix,
        });
      }
    }
  }

  // Phase 3: rewrite each finalised segments.json's embedded chapter
  // metadata. (Peaks.json carries no chapter id / title per plan 35;
  // skip.) Best-effort — a corrupt file leaves stale metadata behind
  // but doesn't fail the op, since the audio still plays and the
  // frontend reads chapter metadata from state.json, not the segments
  // file.
  for (const { op } of staged) {
    const segPath = suffixPath(audioRoot, op.to, 'segments.json');
    if (!existsSync(segPath)) continue;
    try {
      const seg = await readJson<{ chapterId?: number; chapterTitle?: string }>(segPath);
      if (!seg) continue;
      const next = {
        ...seg,
        chapterId: op.newChapterId,
        chapterTitle: op.newChapterTitle,
      };
      await writeJsonAtomic(segPath, next);
    } catch (e) {
      summary.errors.push({
        op,
        message: `segments.json metadata rewrite failed: ${(e as Error).message}`,
        suffix: 'segments.json',
      });
    }
  }

  // Phase 4: deletes. Run after renames so a delete op targeting a slug
  // that was just renamed AWAY is a no-op (ENOENT tolerated).
  for (const op of deletes) {
    for (const suffix of COMPANION_SUFFIXES) {
      const path = suffixPath(audioRoot, op.from, suffix);
      if (!existsSync(path)) continue;
      try {
        await rm(path, { force: true });
        summary.deleted.push({ slug: op.from, suffix });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'ENOENT') continue;
        summary.errors.push({
          op,
          message: `delete failed: ${(e as Error).message}`,
          suffix,
        });
      }
    }
  }

  return summary;
}
