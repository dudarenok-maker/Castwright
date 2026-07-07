import type { BookQaReport } from './types';

function acousticLine(r: BookQaReport): string {
  return `Acoustic — ${r.acoustic.linesChecked} lines checked, ${r.acoustic.linesRerecorded} needed a second take`;
}

function asrLine(r: BookQaReport): string {
  if (r.asr.linesVerified === 0 && r.totalLines > 0) return 'Transcript — not run for this book';
  return `Transcript — ${r.asr.linesVerified} lines verified, ${r.asr.linesFlaggedDrift} flagged`;
}

function voiceMatchLine(r: BookQaReport): string {
  const vd = r.voiceDrift;
  if (vd.chaptersEligible === 0) return 'Voice match — no stochastic-voiced characters in this book';
  /* fs-51 correctness fix: chaptersScored === 0 alone no longer means "the
     gate never ran" — a fleet-wide embedding failure (every eligible
     chapter attempted, all of them failed) also produces chaptersScored
     === 0, but chaptersEmbedFailed is now correctly nonzero for that case.
     Only report "not run" when chaptersEmbedFailed is ALSO 0; otherwise
     fall through to the embedShortfall branch below. */
  if (vd.chaptersScored === 0 && vd.chaptersEmbedFailed === 0) return 'Voice match — not run for this book';
  /* fs-51 round-3 review fix — the spec requires the inconclusive-chapter
     count to be surfaced on this row (usually short quotes below the
     minimum-duration gate), not silently dropped to the JSON export only.
     Appended to every non-empty branch below rather than duplicated per
     branch. */
  const inconclusiveSuffix = vd.inconclusiveCount > 0 ? `, ${vd.inconclusiveCount} chapters inconclusive` : '';
  const characterShortfall = vd.charactersChecked < vd.charactersOnRoster;
  const embedShortfall = vd.chaptersScored < vd.chaptersEligible;
  if (embedShortfall) {
    return `Voice match — ${vd.chaptersScored} of ${vd.chaptersEligible} eligible chapters scored (${vd.chaptersEmbedFailed} couldn't be embedded), ${vd.mismatches.length} mismatches${inconclusiveSuffix}`;
  }
  const base = characterShortfall
    ? `Voice match — ${vd.charactersChecked} of ${vd.charactersOnRoster} characters checked`
    : `Voice match — ${vd.charactersOnRoster} of ${vd.charactersOnRoster} characters checked`;
  return `${base}, ${vd.mismatches.length} mismatches${inconclusiveSuffix}`;
}

function castContinuityLine(r: BookQaReport): string {
  const total = r.configDrift.counts.mild + r.configDrift.counts.moderate + r.configDrift.counts.severe;
  return `Cast continuity — ${total} changes since render`;
}

/* fs-51 round-2 review fix: the headline number must be a genuine line
   count, not a sum of unlike units (a chapter count + a line count + a
   mismatch count, mislabeled "lines" — the bug an earlier draft shipped).
   `acoustic.linesRerecorded` is the one field that's actually a line count;
   when it's zero but other signals still found something, fall back to
   non-numeric copy rather than mislabel a different unit as "lines." */
function headline(r: BookQaReport): string {
  const hasOtherIssues = r.asr.linesFlaggedDrift > 0 || r.voiceDrift.mismatches.length > 0;
  if (r.acoustic.linesRerecorded > 0) return `${r.acoustic.linesRerecorded} lines needed a second take.`;
  if (hasOtherIssues) return 'Some lines need a second look.';
  return 'Every line held.';
}

export function formatQaReportText(report: BookQaReport, bookTitle: string): string {
  return [
    `${bookTitle} — Castwright quality gate`,
    headline(report),
    `· ${acousticLine(report)}`,
    `· ${asrLine(report)}`,
    `· ${voiceMatchLine(report)}`,
    `· ${castContinuityLine(report)}`,
  ].join('\n');
}

export function formatQaReportJson(report: BookQaReport): string {
  return JSON.stringify(report, null, 2);
}
