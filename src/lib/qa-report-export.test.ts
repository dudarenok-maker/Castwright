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

  it('adds a needs-re-render line right after the voice-match line when non-empty', () => {
    const report = { ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, charactersNeedingRerender: ['c1', 'c2'] } };
    const lines = formatQaReportText(report, 'Book').split('\n');
    const i = lines.findIndex((l) => l.includes('Voice match — 18 of 18'));
    expect(lines[i + 1]).toBe('· Voice match — needs re-render: c1, c2');
  });

  it('names the characters, not their ids, when a name map is given (#3680 pass 1)', () => {
    const report = { ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, charactersNeedingRerender: ['c1', 'c2'] } };
    const text = formatQaReportText(report, 'Book', { c1: 'Alice' });
    expect(text).toContain('· Voice match — needs re-render: Alice, c2');
  });

  it('omits the line where the card hides the listing: the gate never ran and nothing is pending (#3680 pass 1)', () => {
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersScored: 0, chaptersEmbedFailed: 0, charactersPending: [], charactersNeedingRerender: ['c1'] },
    };
    const text = formatQaReportText(report, 'Book');
    expect(text).toContain('Voice match — not run for this book');
    expect(text).not.toContain('needs re-render');
  });

  it('omits the needs-re-render line when the list is empty', () => {
    expect(formatQaReportText(MOCK_QA_REPORT, 'Book')).not.toContain('needs re-render');
  });
});
