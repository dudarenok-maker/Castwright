import { describe, it, expect } from 'vitest';
import { formatQaReportText } from './qa-report-export';
import { MOCK_QA_REPORT } from '../data/qa-report';

describe('formatQaReportText', () => {
  it('renders a clean, fully-covered report as a proof-receipt block', () => {
    const text = formatQaReportText(MOCK_QA_REPORT, 'The Coalfall Commission');
    expect(text).toContain('The Coalfall Commission');
    expect(text).toContain('Every line held.');
    expect(text).toContain('Acoustic — 342 lines checked, 0 needed a second take');
    expect(text).toContain('Voice match — 18 of 18 characters checked, 0 mismatches');
    expect(text).toContain('Cast continuity — 0 changes since render');
  });

  it('states coverage plainly when a gate never ran', () => {
    const report = { ...MOCK_QA_REPORT, asr: { linesVerified: 0, linesFlaggedDrift: 0 }, totalLines: 342 };
    const text = formatQaReportText(report, 'Book');
    expect(text).toContain('Transcript — not run for this book');
  });

  it('leads with the embed-failure fraction even when every character was checked', () => {
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 11, chaptersEmbedFailed: 1 },
    };
    const text = formatQaReportText(report, 'Book');
    expect(text).toContain("11 of 12 eligible chapters scored (1 couldn't be embedded)");
    expect(text).not.toContain('18 of 18 characters checked');
  });

  it('surfaces a fleet-wide embed failure instead of "not run" when chaptersScored is 0 but chaptersEmbedFailed is nonzero', () => {
    // fs-51 correctness fix — see the matching qa-report-card.test.tsx case.
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 0, chaptersEmbedFailed: 12 },
    };
    const text = formatQaReportText(report, 'Book');
    expect(text).toContain("0 of 12 eligible chapters scored (12 couldn't be embedded)");
    expect(text).not.toContain('Voice match — not run for this book');
  });

  it('appends the inconclusive-chapter count to the voice-match line when nonzero', () => {
    const report = { ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, inconclusiveCount: 2 } };
    const text = formatQaReportText(report, 'Book');
    expect(text).toContain('2 chapters inconclusive');
  });
});
