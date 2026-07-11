import type { BookQaReport } from './types';
import { classifyHeadline, classifyVoiceMatch } from './qa-report-classify';

function acousticLine(r: BookQaReport): string {
  return `Acoustic — ${r.acoustic.linesChecked} lines checked, ${r.acoustic.linesRerecorded} needed a second take`;
}

function asrLine(r: BookQaReport): string {
  if (r.asr.linesVerified === 0 && r.totalLines > 0) return 'Transcript — not run for this book';
  return `Transcript — ${r.asr.linesVerified} lines verified, ${r.asr.linesFlaggedDrift} flagged`;
}

function voiceMatchLine(r: BookQaReport): string {
  const c = classifyVoiceMatch(r);
  if (c.kind === 'noEligible') return 'Voice match — no stochastic-voiced characters in this book';
  if (c.kind === 'notRun') return 'Voice match — not run for this book';
  const inconclusiveSuffix = c.inconclusiveCount > 0 ? `, ${c.inconclusiveCount} chapters inconclusive` : '';
  if (c.kind === 'embedShortfall') {
    return `Voice match — ${c.chaptersScored} of ${c.chaptersEligible} eligible chapters scored (${c.chaptersEmbedFailed} couldn't be embedded), ${c.mismatchCount} mismatches${inconclusiveSuffix}`;
  }
  return `Voice match — ${c.charactersChecked} of ${c.charactersOnRoster} characters checked, ${c.mismatchCount} mismatches${inconclusiveSuffix}`;
}

function castContinuityLine(r: BookQaReport): string {
  const total = r.configDrift.counts.mild + r.configDrift.counts.moderate + r.configDrift.counts.severe;
  return `Cast continuity — ${total} changes since render`;
}

function headline(r: BookQaReport): string {
  const c = classifyHeadline(r);
  switch (c.kind) {
    case 'rerecorded':
      return `${c.linesRerecorded} lines needed a second take.`;
    case 'otherIssues':
      return 'Some lines need a second look.';
    case 'clean':
      return 'Every line held.';
  }
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
