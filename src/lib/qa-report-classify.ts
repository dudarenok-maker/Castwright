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
  | { kind: 'gateOff' }
  | {
      kind: 'checkedSoFar';
      charactersChecked: number;
      charactersOnRoster: number;
      mismatchCount: number;
      inconclusiveCount: number;
    }
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

/** #3680 — the ids the "needs re-render" listing shows, `[]` when it is hidden. Shared by the
 *  QA card and the text export so the two can never disagree. Hidden in the `notRun` row with
 *  nothing pending: no pass has settled, so the card reports nothing about characters yet.
 *  (The `noEligible` row needs no case: a listed id comes from a MARKED roster key, and a
 *  key only joins the roster by naming an eligible chapter in the same pass, so a non-empty
 *  list implies at least one eligible chapter. The listed id itself may be a merge target
 *  that is not a roster key.) */
export function needsRerenderIds(report: BookQaReport): string[] {
  const ids = report.voiceDrift.charactersNeedingRerender ?? [];
  if (ids.length === 0) return [];
  /* #4454 — with the speaker check off a re-render writes no embeddings and starts no score pass,
     so the listing could never clear: hide it in every row, not just `gateOff` (#3680 — don't
     offer work that can't be done). */
  if (isSpeakerCheckOff(report)) return [];
  if (classifyVoiceMatch(report).kind === 'notRun' && report.voiceDrift.charactersPending.length === 0) return [];
  return ids;
}

/** #3680 — the chapters holding the lines that keep `id` on the needs-re-render listing
 *  (`[]` when the server sent none). Re-rendering one removes it from the list. */
export function needsRerenderChapters(report: BookQaReport, id: string): number[] {
  return report.voiceDrift.charactersNeedingRerenderChapters?.[id] ?? [];
}

/** #4454 — true when the speaker check is switched off. Strict `=== false`: e2e specs seed untyped
 *  report objects through `window.__mockQaReportOverride` and may omit the field, and an absent
 *  field must keep today's behaviour. */
export function isSpeakerCheckOff(report: BookQaReport): boolean {
  return report.voiceDrift.speakerCheckEnabled === false;
}

export function classifyVoiceMatch(report: BookQaReport): VoiceMatchClassification {
  const vd = report.voiceDrift;
  if (vd.chaptersEligible === 0) return { kind: 'noEligible' };
  /* #4454 — gate off with no chapter scored or attempted. With no other evidence either, say the
     check is off. The server's chapter counts skip any chapter whose roster holds a pending
     character, so a pending character in every eligible chapter zeroes both however much was
     checked: a roster character with a centroids row (only a score pass writes one, so
     `charactersPending` is shorter than the roster) or a standing mismatch / inconclusive count
     is a past result and stays, as `checkedSoFar` (the pending row's wording, no Resume).
     `charactersChecked` is NOT evidence: the server counts the roster minus too-short verdicts, so
     a never-scored book reports it as the whole roster. Past
     results with chapters counted (`embedShortfall` / `scored`) below stay, pending characters or
     not. Strict `=== false` via isSpeakerCheckOff — an absent field keeps today's behaviour. */
  if (isSpeakerCheckOff(report) && vd.chaptersScored === 0 && vd.chaptersEmbedFailed === 0) {
    if (vd.charactersPending.length >= vd.charactersOnRoster && vd.mismatches.length === 0 && vd.inconclusiveCount === 0) {
      return { kind: 'gateOff' };
    }
    return {
      kind: 'checkedSoFar',
      charactersChecked: vd.charactersChecked,
      charactersOnRoster: vd.charactersOnRoster,
      mismatchCount: vd.mismatches.length,
      inconclusiveCount: vd.inconclusiveCount,
    };
  }
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
