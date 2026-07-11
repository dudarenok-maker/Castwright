import { describe, it, expect } from 'vitest';
import { classifyHeadline, classifyVoiceMatch } from './qa-report-classify';
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
