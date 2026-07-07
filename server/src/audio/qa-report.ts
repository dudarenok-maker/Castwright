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
    /** Eligible chapters that scoreBook attempted (see the attempted
     *  sentinel in render-integrity/verdicts-io.ts) but never produced a
     *  verdict file for — an embedding failure. Correctly nonzero for BOTH
     *  an isolated failure (some chapters scored, this one didn't) AND a
     *  fleet-wide failure (the gate ran and attempted every eligible
     *  chapter, but embeddings failed for literally all of them, so
     *  chaptersScored is also 0). Stays 0 only when the gate was never
     *  attempted on any eligible chapter at all ("gate off") — see the
     *  computation below. */
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
  /* fs-51 correctness fix — an eligible chapter with no verdict file is
     either "gate off" (never attempted) or an embeddings failure (the gate
     DID attempt it, but no verdict file resulted). The prior heuristic
     (`chaptersScored > 0 ? ... : 0`) used "something else in the book WAS
     scored" as its only evidence the gate ran — which made a FLEET-WIDE
     embedding failure (every eligible chapter attempted, all of them
     failed, so chaptersScored is ALSO 0) indistinguishable from the gate
     never running at all. The attempted sentinel (render-integrity/
     verdicts-io.ts's attemptedPath/writeAttempted, written by scoreBook's
     per-chapter loop regardless of outcome) is real, chapter-level evidence
     of an attempt, so both cases are now distinguishable: chaptersEmbedFailed
     is nonzero whenever an eligible chapter was attempted but unscored,
     whether that's isolated or book-wide. It's 0 only when NO eligible
     chapter was ever attempted — genuinely "gate off". */
  const attemptedEligibleCount = outline.attemptedChapterIds.filter((id) => eligibleChapterIds.has(id)).length;
  const chaptersEmbedFailed = attemptedEligibleCount > 0 ? attemptedEligibleCount - chaptersScored : 0;

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
