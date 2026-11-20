import { describe, it, expect } from 'vitest';
import { classifyHeadline, classifyVoiceMatch, needsRerenderIds } from './qa-report-classify';
import { formatQaReportText } from './qa-report-export';
import type { BookQaReport } from './types';
import { MOCK_QA_REPORT } from '../data/qa-report';

describe('classifyHeadline', () => {
  it('classifies rerecorded when linesRerecorded > 0, regardless of other signals', () => {
    const report = { ...MOCK_QA_REPORT, acoustic: { ...MOCK_QA_REPORT.acoustic, linesRerecorded: 3 } };
    expect(classifyHeadline(report)).toEqual({ kind: 'rerecorded', linesRerecorded: 3 });
  });

  it('classifies otherIssues when ASR drift was flagged but no lines were rerecorded', () => {
    const report = { ...MOCK_QA_REPORT, asr: { ...MOCK_QA_REPORT.asr, linesFlaggedDrift: 2 } };
    expect(classifyHeadline(report)).toEqual({ kind: 'otherIssues' });
  });

  it('classifies otherIssues when a voice mismatch exists but no lines were rerecorded', () => {
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, mismatches: [{ characterId: 'ren', fixable: true }] },
    };
    expect(classifyHeadline(report)).toEqual({ kind: 'otherIssues' });
  });

  it('classifies clean when nothing was rerecorded or flagged', () => {
    expect(classifyHeadline(MOCK_QA_REPORT)).toEqual({ kind: 'clean' });
  });
});

describe('classifyVoiceMatch', () => {
  it('classifies noEligible when there are no stochastic-voiced characters', () => {
    const report = { ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 0 } };
    expect(classifyVoiceMatch(report)).toEqual({ kind: 'noEligible' });
  });

  it('classifies notRun when chaptersScored and chaptersEmbedFailed are both 0', () => {
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 0, chaptersEmbedFailed: 0 },
    };
    expect(classifyVoiceMatch(report)).toEqual({ kind: 'notRun' });
  });

  it('classifies embedShortfall for a fleet-wide embed failure (chaptersScored 0 but chaptersEmbedFailed nonzero)', () => {
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 0, chaptersEmbedFailed: 12 },
    };
    expect(classifyVoiceMatch(report)).toEqual({
      kind: 'embedShortfall',
      chaptersScored: 0,
      chaptersEligible: 12,
      chaptersEmbedFailed: 12,
      mismatchCount: 0,
      inconclusiveCount: 0,
    });
  });

  it('classifies embedShortfall for an isolated embed failure even when every character was checked', () => {
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 11, chaptersEmbedFailed: 1 },
    };
    expect(classifyVoiceMatch(report)).toEqual({
      kind: 'embedShortfall',
      chaptersScored: 11,
      chaptersEligible: 12,
      chaptersEmbedFailed: 1,
      mismatchCount: 0,
      inconclusiveCount: 0,
    });
  });

  it('classifies scored with the character-checked fraction once every eligible chapter was scored', () => {
    expect(classifyVoiceMatch(MOCK_QA_REPORT)).toEqual({
      kind: 'scored',
      charactersChecked: 18,
      charactersOnRoster: 18,
      mismatchCount: 0,
      inconclusiveCount: 0,
    });
  });

  it('surfaces inconclusiveCount on the scored branch', () => {
    const report = { ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, inconclusiveCount: 2 } };
    const result = classifyVoiceMatch(report);
    expect(result.kind).toBe('scored');
    expect(result).toMatchObject({ inconclusiveCount: 2 });
  });

  it('surfaces inconclusiveCount on the embedShortfall branch', () => {
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: {
        ...MOCK_QA_REPORT.voiceDrift,
        chaptersEligible: 12,
        chaptersScored: 11,
        chaptersEmbedFailed: 1,
        inconclusiveCount: 2,
      },
    };
    const result = classifyVoiceMatch(report);
    expect(result.kind).toBe('embedShortfall');
    expect(result).toMatchObject({ inconclusiveCount: 2 });
  });
});

describe('speaker check off (#4454)', () => {
  const vd = MOCK_QA_REPORT.voiceDrift;
  const off = (over: Partial<BookQaReport['voiceDrift']>): BookQaReport => ({
    ...MOCK_QA_REPORT,
    voiceDrift: { ...vd, speakerCheckEnabled: false, ...over },
  });
  const line = (r: BookQaReport) => formatQaReportText(r, 'Book').split('\n').find((l) => l.includes('Voice match —'));

  it('(a) gate off + pending non-empty -> gateOff, export says the check is off', () => {
    const r = off({ charactersPending: ['ren'], chaptersScored: 0 });
    expect(classifyVoiceMatch(r).kind).toBe('gateOff');
    expect(line(r)).toContain('Voice match — Render-integrity QA is off');
  });

  it('(a2) gate off + pending + partial scoring keeps embedShortfall and the mismatch count in the export', () => {
    const r = off({
      chaptersEligible: 12,
      chaptersScored: 11,
      chaptersEmbedFailed: 0,
      charactersPending: ['newcomer'],
      mismatches: [{ characterId: 'ren', fixable: true }, { characterId: 'mo', fixable: true }] as BookQaReport['voiceDrift']['mismatches'],
    });
    expect(classifyVoiceMatch(r).kind).toBe('embedShortfall');
    expect(line(r)).toContain('11 of 12 eligible chapters scored');
    expect(line(r)).toContain('2 mismatches');
    expect(line(r)).toMatch(/\(Render-integrity QA is now off\)$/);
  });

  it('(b) gate off + notRun condition + nothing pending -> gateOff', () => {
    expect(classifyVoiceMatch(off({ chaptersScored: 0, chaptersEmbedFailed: 0, charactersPending: [] })).kind).toBe('gateOff');
  });

  it('(c) gate off + scored keeps scored and notes the check is now off', () => {
    const r = off({});
    expect(classifyVoiceMatch(r).kind).toBe('scored');
    expect(line(r)).toMatch(/\(Render-integrity QA is now off\)$/);
  });

  it('(d) gate on + pending is not gateOff', () => {
    const r: BookQaReport = { ...MOCK_QA_REPORT, voiceDrift: { ...vd, charactersPending: ['ren'], chaptersScored: 0 } };
    expect(classifyVoiceMatch(r).kind).not.toBe('gateOff');
  });

  it('(e) field absent + pending is not gateOff', () => {
    const { speakerCheckEnabled: _omit, ...rest } = vd;
    const r = { ...MOCK_QA_REPORT, voiceDrift: { ...rest, charactersPending: ['ren'], chaptersScored: 0 } } as unknown as BookQaReport;
    expect(classifyVoiceMatch(r).kind).not.toBe('gateOff');
  });

  it('(f) needsRerenderIds is empty for a gateOff report carrying charactersNeedingRerender', () => {
    const r = off({ charactersPending: ['ren'], chaptersScored: 0, charactersNeedingRerender: ['c1'] });
    expect(needsRerenderIds(r)).toEqual([]);
  });

  it('(g) needsRerenderIds is empty with the check off even in the scored row, and the export omits the line', () => {
    const r = off({ charactersPending: [], charactersNeedingRerender: ['ren'], charactersNeedingRerenderChapters: { ren: [2] } });
    expect(classifyVoiceMatch(r).kind).toBe('scored');
    expect(needsRerenderIds(r)).toEqual([]);
    expect(formatQaReportText(r, 'Book')).not.toContain('needs re-render');
  });

  it('(h) needsRerenderIds is empty with the check off in the embedShortfall row', () => {
    const r = off({ chaptersEligible: 12, chaptersScored: 11, charactersNeedingRerender: ['ren'] });
    expect(classifyVoiceMatch(r).kind).toBe('embedShortfall');
    expect(needsRerenderIds(r)).toEqual([]);
  });

  it('(i) needsRerenderIds still lists ids when the field is absent (check on)', () => {
    const r: BookQaReport = { ...MOCK_QA_REPORT, voiceDrift: { ...vd, charactersNeedingRerender: ['ren'] } };
    expect(needsRerenderIds(r)).toEqual(['ren']);
  });
});
