import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QaReportCard } from './qa-report-card';
import { MOCK_QA_REPORT } from '../data/qa-report';

describe('QaReportCard', () => {
  it('shows the clean-book headline and all four rows when fully covered', () => {
    render(<QaReportCard report={MOCK_QA_REPORT} loading={false} error={false} bookTitle="Test Book" />);
    expect(screen.getByText(/Every line/)).toBeInTheDocument();
    expect(screen.getByText(/held/)).toBeInTheDocument();
    expect(screen.getByText(/342 lines checked/)).toBeInTheDocument();
    expect(screen.getByText(/18 of 18 characters checked/)).toBeInTheDocument();
  });

  it('shows the not-enabled invitation copy for a gate that never ran', () => {
    const report = { ...MOCK_QA_REPORT, asr: { linesVerified: 0, linesFlaggedDrift: 0 } };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" />);
    expect(screen.getByText(/turn on transcript verification/i)).toBeInTheDocument();
  });

  it('shows the no-stochastic-characters state distinctly from not-run', () => {
    const report = { ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 0, chaptersScored: 0, charactersOnRoster: 0, charactersChecked: 0 } };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" />);
    expect(screen.getByText(/no stochastic-voiced characters/i)).toBeInTheDocument();
  });

  it('leads with the embed-failure fraction even when every character was checked', () => {
    // Regression for the round-2 review finding: a full-roster book (no
    // character shortfall) with one chapter's embeddings failed must NOT
    // render as a clean "N of N characters checked" — chaptersScored <
    // chaptersEligible has to win even though charactersChecked ===
    // charactersOnRoster here.
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 11, chaptersEmbedFailed: 1 },
    };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" />);
    expect(screen.getByText(/11 of 12 eligible chapters scored/i)).toBeInTheDocument();
    expect(screen.queryByText(/18 of 18 characters checked/i)).not.toBeInTheDocument();
  });

  it('shows the fleet-wide embed-failure fraction instead of "not run" when every eligible chapter was attempted and all failed', () => {
    // fs-51 correctness fix: chaptersScored === 0 no longer means "the gate
    // never ran" on its own — a fleet-wide embedding failure (the gate
    // attempted every eligible chapter, all of them failed to embed) also
    // produces chaptersScored === 0, but now surfaces a nonzero
    // chaptersEmbedFailed. The row must lead with the honest "0 of N scored"
    // fraction, not the "flip on render-integrity checking" invitation copy
    // that implies the gate never ran.
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 0, chaptersEmbedFailed: 12 },
    };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" />);
    expect(screen.getByText(/0 of 12 eligible chapters scored/i)).toBeInTheDocument();
    expect(screen.queryByText(/flip on render-integrity checking/i)).not.toBeInTheDocument();
  });

  it('shows the inconclusive-chapter count on the voice-match row when nonzero', () => {
    const report = { ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, inconclusiveCount: 2 } };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" />);
    expect(screen.getByText(/2 chapters inconclusive/i)).toBeInTheDocument();
  });

  it('shows an inline unavailable state on fetch error, without throwing', () => {
    render(<QaReportCard report={null} loading={false} error={true} bookTitle="Test Book" />);
    expect(screen.getByText(/qa report unavailable/i)).toBeInTheDocument();
  });

  it('triggers a text download when the export button is clicked', () => {
    render(<QaReportCard report={MOCK_QA_REPORT} loading={false} error={false} bookTitle="Test Book" />);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    screen.getByRole('button', { name: /download as text/i }).click();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});
