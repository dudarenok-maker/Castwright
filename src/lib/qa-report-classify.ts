import type { BookQaReport } from './types';

/* fs-51 round-2 review fix: the headline number must be a genuine line
   count, not a sum of unlike units (a chapter count + a line count + a
   mismatch count, mislabeled "lines" — the bug an earlier draft shipped).
   `acoustic.linesRerecorded` is the one field that's actually a line count;
   when it's zero but other signals still found something, fall back to
   non-numeric copy rather than mislabel a different unit as "lines." */
export type HeadlineClassification =
  | { kind: 'rerecorded'; linesRerecorded: number }
  | { kind: 'otherIssues' }
  | { kind: 'clean' };

export function classifyHeadline(report: BookQaReport): HeadlineClassification {
  const hasOtherIssues = report.asr.linesFlaggedDrift > 0 || report.voiceDrift.mismatches.length > 0;
  if (report.acoustic.linesRerecorded > 0) {
    return { kind: 'rerecorded', linesRerecorded: report.acoustic.linesRerecorded };
  }
  if (hasOtherIssues) return { kind: 'otherIssues' };
  return { kind: 'clean' };
}

export type VoiceMatchClassification =
  | { kind: 'noEligible' }
  | { kind: 'notRun' }
  | {
      kind: 'embedShortfall';
      chaptersScored: number;
      chaptersEligible: number;
      chaptersEmbedFailed: number;
      mismatchCount: number;
      inconclusiveCount: number;
    }
  | {
      kind: 'scored';
      charactersChecked: number;
      charactersOnRoster: number;
      mismatchCount: number;
      inconclusiveCount: number;
    };

export function classifyVoiceMatch(report: BookQaReport): VoiceMatchClassification {
  const vd = report.voiceDrift;
  if (vd.chaptersEligible === 0) return { kind: 'noEligible' };
  /* fs-51 correctness fix: chaptersScored === 0 alone no longer means "the
     gate never ran" — a fleet-wide embedding failure (the gate attempted
     every eligible chapter, but embeddings failed for literally all of
     them) ALSO produces chaptersScored === 0, while chaptersEmbedFailed is
     now correctly nonzero for that case. Only classify as "never ran" when
     chaptersEmbedFailed is ALSO 0 — otherwise fall through to the
     embed-shortfall branch below, which reports the honest fraction. */
  if (vd.chaptersScored === 0 && vd.chaptersEmbedFailed === 0) return { kind: 'notRun' };
  /* fs-51 round-2 review fix: chaptersScored < chaptersEligible (an isolated
     embed failure) must lead, exactly like the character-shortfall case
     below — otherwise a full-roster book with a failed embed still reads as
     a clean "N of N characters checked", the false-clean the
     chaptersEmbedFailed field exists to prevent.
     fs-51 round-3 review fix: also surface inconclusiveCount (short quotes
     below the minimum-duration gate) per the spec. */
  if (vd.chaptersScored < vd.chaptersEligible) {
    return {
      kind: 'embedShortfall',
      chaptersScored: vd.chaptersScored,
      chaptersEligible: vd.chaptersEligible,
      chaptersEmbedFailed: vd.chaptersEmbedFailed,
      mismatchCount: vd.mismatches.length,
      inconclusiveCount: vd.inconclusiveCount,
    };
  }
  return {
    kind: 'scored',
    charactersChecked: vd.charactersChecked,
    charactersOnRoster: vd.charactersOnRoster,
    mismatchCount: vd.mismatches.length,
    inconclusiveCount: vd.inconclusiveCount,
  };
}
