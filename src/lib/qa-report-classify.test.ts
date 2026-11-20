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

  /* The report buildAudioQaReport emits for a never-scored book (pinned by the server test
     'a never-scored book reports every roster character as checked AND pending ...'): the roster
     counts as fully "checked", every id is pending. */
  const neverScored = (over: Partial<BookQaReport['voiceDrift']> = {}) =>
    off({
      chaptersEligible: 1,
      chaptersScored: 0,
      chaptersEmbedFailed: 0,
      charactersOnRoster: 2,
      charactersChecked: 2,
      charactersPending: ['narrator', 'ren'],
      mismatches: [],
      inconclusiveCount: 0,
      ...over,
    });

  it('(a) gate off + never scored (builder shape) -> gateOff, export says the check is off', () => {
    const r = neverScored();
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

  it('(b) gate off + a never-scored book with no roster pending data still reads gateOff', () => {
    expect(classifyVoiceMatch(neverScored({ charactersOnRoster: 0, charactersChecked: 0, charactersPending: [] })).kind).toBe('gateOff');
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
    const r = neverScored({ charactersNeedingRerender: ['c1'] });
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

  /* The report buildAudioQaReport emits for one eligible chapter where narrator is checked with a
     voice-mismatch verdict and ren has no centroids row yet (pinned by the server test
     'a pending character in every eligible chapter zeroes ...'): both chapter counts are 0. */
  const builderPending = (over: Partial<BookQaReport['voiceDrift']> = {}) =>
    off({
      chaptersEligible: 1,
      chaptersScored: 0,
      chaptersEmbedFailed: 0,
      charactersOnRoster: 2,
      charactersChecked: 2,
      charactersPending: ['ren'],
      mismatches: [{ characterId: 'narrator', fixable: true }] as BookQaReport['voiceDrift']['mismatches'],
      ...over,
    });

  it('(j) gate off + a pending character in every eligible chapter keeps the checked-so-far result and its mismatch, no gateOff', () => {
    const r = builderPending();
    expect(classifyVoiceMatch(r)).toEqual({
      kind: 'checkedSoFar',
      charactersChecked: 2,
      charactersOnRoster: 2,
      mismatchCount: 1,
      inconclusiveCount: 0,
    });
    expect(line(r)).toBe('· Voice match — 2 of 2 characters checked so far, 1 mismatches (Render-integrity QA is now off)');
    expect(needsRerenderIds(builderPending({ charactersNeedingRerender: ['narrator'] }))).toEqual([]);
  });

  it('(k) gate off + pending + only a mismatch or only an inconclusive count (nothing checked) is still evidence', () => {
    expect(classifyVoiceMatch(builderPending({ charactersChecked: 0, inconclusiveCount: 2, mismatches: [] })).kind).toBe('checkedSoFar');
    expect(classifyVoiceMatch(builderPending({ charactersChecked: 0 })).kind).toBe('checkedSoFar');
  });

  it('(l) gate on + the same builder shape is not checkedSoFar', () => {
    const r: BookQaReport = { ...MOCK_QA_REPORT, voiceDrift: { ...builderPending().voiceDrift, speakerCheckEnabled: true } };
    expect(classifyVoiceMatch(r).kind).not.toBe('checkedSoFar');
  });
});
