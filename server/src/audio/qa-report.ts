/* fs-51 — per-book QA report aggregation. Reads existing per-chapter files
   (never a new persisted book-level aggregate) and computes one honest
   summary. See docs/superpowers/specs/2026-07-05-fs51-qa-report-design.md
   for the "never a false pass" constraint this module is built around —
   in particular, voiceDrift.chaptersEligible is computed HERE, directly
   from segments.json, rather than derived from scoreBook's output, because
   scoreBook's own early-return control flow can't distinguish "nothing to
   check" from "never ran" (see the spec's round-3 finding). */

import { loadSegmentsFiles } from './segments-io.js';
import { deriveBookOutline } from './render-integrity/verdicts-io.js';
import { STOCHASTIC_ENGINES } from './render-integrity/aggregate.js';

export interface AudioQaReport {
  chaptersRendered: number;
  totalLines: number;
  acoustic: { linesChecked: number; linesRerecorded: number; chaptersFlagged: number };
  asr: { linesVerified: number; linesFlaggedDrift: number };
  voiceDrift: {
    attribution: 'full' | 'legacy-unattributed';
    chaptersEligible: number;
    chaptersScored: number;
    chaptersEmbedFailed: number;
    charactersOnRoster: number;
    charactersChecked: number;
    mismatches: Array<{ characterId: string; chapterId?: number; fixable: boolean }>;
    inconclusiveCount: number;
    uncheckedCharacterIds: string[];
  };
}

export async function buildAudioQaReport(
  bookDir: string,
  chapters: { id: number; slug: string }[],
): Promise<AudioQaReport> {
  const segFiles = await loadSegmentsFiles(bookDir, chapters);

  let totalLines = 0;
  let linesChecked = 0;
  let linesRerecorded = 0;
  let linesVerified = 0;
  let linesFlaggedDrift = 0;
  const chaptersFlaggedSet = new Set<number>();
  const eligibleChapterIds = new Set<number>();
  const stochasticCharacterIds = new Set<string>();

  for (const seg of segFiles) {
    let chapterHasSuspect = false;
    for (const s of seg.segments ?? []) {
      const lineCount = Array.isArray(s.sentenceIds) ? s.sentenceIds.length : 0;
      totalLines += lineCount;
      const anySeg = s as unknown as {
        qa?: unknown; suspect?: boolean; qaRetries?: number;
        asr?: unknown; asrSuspect?: boolean;
      };
      if (anySeg.qa != null) linesChecked += lineCount;
      if ((anySeg.qaRetries ?? 0) > 0) linesRerecorded += lineCount;
      if (anySeg.suspect) chapterHasSuspect = true;
      if (anySeg.asr != null) linesVerified += lineCount;
      if (anySeg.asrSuspect) linesFlaggedDrift += lineCount;
    }
    if (chapterHasSuspect) chaptersFlaggedSet.add(seg.chapterId);

    for (const [charId, snap] of Object.entries(seg.characterSnapshots ?? {})) {
      if (snap.voiceEngine && STOCHASTIC_ENGINES.has(snap.voiceEngine)) {
        stochasticCharacterIds.add(charId);
        eligibleChapterIds.add(seg.chapterId);
      }
    }
  }

  const outline = await deriveBookOutline(bookDir, chapters);
  const attribution: 'full' | 'legacy-unattributed' = outline.issues.some((r) => r.chapterId == null)
    ? 'legacy-unattributed'
    : 'full';
  const uncheckedSet = new Set(outline.counts.uncheckedCharacters);
  const chaptersScored = outline.scoredChapterIds.filter((id) => eligibleChapterIds.has(id)).length;
  /* fs-51 — an eligible chapter with no verdict file is either "gate off"
     (chaptersScored is 0 everywhere) or an isolated embeddings failure
     (the gate demonstrably ran, since something else in the book WAS
     scored). Only attribute to embed-failure when there's evidence the
     gate is on — otherwise this would misreport "gate off" as "embed
     failed" for the same reason presence-based detection failed for the
     whole-book case (see the spec's round-3 finding). */
  const chaptersEmbedFailed = chaptersScored > 0 ? eligibleChapterIds.size - chaptersScored : 0;

  return {
    chaptersRendered: segFiles.length,
    totalLines,
    acoustic: {
      linesChecked,
      linesRerecorded,
      chaptersFlagged: chaptersFlaggedSet.size,
    },
    asr: {
      linesVerified,
      linesFlaggedDrift,
    },
    voiceDrift: {
      attribution,
      chaptersEligible: eligibleChapterIds.size,
      chaptersScored,
      chaptersEmbedFailed,
      charactersOnRoster: stochasticCharacterIds.size,
      charactersChecked: Array.from(stochasticCharacterIds).filter((id) => !uncheckedSet.has(id)).length,
      mismatches: outline.issues.map((r) => ({
        characterId: r.characterId,
        chapterId: r.chapterId,
        fixable: r.fixable,
      })),
      inconclusiveCount: outline.inconclusiveChapterIds.length,
      uncheckedCharacterIds: outline.counts.uncheckedCharacters,
    },
  };
}
