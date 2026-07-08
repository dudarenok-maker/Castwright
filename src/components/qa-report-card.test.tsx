import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { QaReportCard } from './qa-report-card';
import { MOCK_QA_REPORT } from '../data/qa-report';
import { api } from '../lib/api';

describe('QaReportCard', () => {
  it('shows the clean-book headline and all four rows when fully covered', () => {
    render(<QaReportCard report={MOCK_QA_REPORT} loading={false} error={false} bookTitle="Test Book" bookId="demo-book" />);
    expect(screen.getByText(/Every line/)).toBeInTheDocument();
    expect(screen.getByText(/held/)).toBeInTheDocument();
    expect(screen.getByText(/342 lines checked/)).toBeInTheDocument();
    expect(screen.getByText(/18 of 18 characters checked/)).toBeInTheDocument();
  });

  it('shows the not-enabled invitation copy for a gate that never ran', () => {
    const report = { ...MOCK_QA_REPORT, asr: { linesVerified: 0, linesFlaggedDrift: 0 } };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" bookId="demo-book" />);
    expect(screen.getByText(/turn on transcript verification/i)).toBeInTheDocument();
  });

  it('shows the no-stochastic-characters state distinctly from not-run', () => {
    const report = { ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 0, chaptersScored: 0, charactersOnRoster: 0, charactersChecked: 0 } };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" bookId="demo-book" />);
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
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" bookId="demo-book" />);
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
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" bookId="demo-book" />);
    expect(screen.getByText(/0 of 12 eligible chapters scored/i)).toBeInTheDocument();
    expect(screen.queryByText(/flip on render-integrity checking/i)).not.toBeInTheDocument();
  });

  it('shows the inconclusive-chapter count on the voice-match row when nonzero', () => {
    const report = { ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, inconclusiveCount: 2 } };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" bookId="demo-book" />);
    expect(screen.getByText(/2 chapters inconclusive/i)).toBeInTheDocument();
  });

  it('shows an inline unavailable state on fetch error, without throwing', () => {
    render(<QaReportCard report={null} loading={false} error={true} bookTitle="Test Book" bookId="demo-book" />);
    expect(screen.getByText(/qa report unavailable/i)).toBeInTheDocument();
  });

  it('triggers a text download when the export button is clicked', () => {
    render(<QaReportCard report={MOCK_QA_REPORT} loading={false} error={false} bookTitle="Test Book" bookId="demo-book" />);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    screen.getByRole('button', { name: /download as text/i }).click();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});

describe('VoiceMatchRow — srv-36 hardening states', () => {
  it('shows live progress copy when scoringProgress is present', () => {
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12 },
    };
    render(
      <QaReportCard
        report={report}
        loading={false}
        error={false}
        bookTitle="Test"
        bookId="b1"
        scoringProgress={{ charactersChecked: 3, charactersOnRoster: 13 }}
      />,
    );
    expect(screen.getByText(/3 of 13 done/i)).toBeInTheDocument();
  });

  it('shows a Resume scoring button when charactersPending is non-empty and no live progress', () => {
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: {
        ...MOCK_QA_REPORT.voiceDrift,
        chaptersEligible: 12,
        chaptersScored: 6,
        charactersPending: ['ren'],
      },
    };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test" bookId="b1" />);
    expect(screen.getByRole('button', { name: /resume scoring/i })).toBeInTheDocument();
  });

  it('does NOT show a Resume button when charactersPending is empty, even if some characters are permanently unchecked', () => {
    // Regression for the round-2/round-3 review finding: this fixture must
    // keep charactersChecked < charactersOnRoster (a permanent shortfall,
    // NOT an interrupted-mid-run signal) while charactersPending stays [].
    // If VoiceMatchRow ever regressed to gating on
    // `charactersChecked < charactersOnRoster` instead of on
    // `charactersPending.length > 0`, this fixture would make that bug
    // visible — a fixture with charactersChecked === charactersOnRoster
    // can't distinguish the two gating strategies.
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: {
        ...MOCK_QA_REPORT.voiceDrift,
        chaptersEligible: 12,
        charactersChecked: 15,
        charactersOnRoster: 18,
        charactersPending: [],
        uncheckedCharacterIds: ['pell-hollis'],
      },
    };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test" bookId="b1" />);
    expect(screen.queryByRole('button', { name: /resume scoring/i })).not.toBeInTheDocument();
  });

  it('clicking Resume calls api.resumeScoring with the bookId', async () => {
    const resumeSpy = vi.spyOn(api, 'resumeScoring').mockResolvedValue();
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: {
        ...MOCK_QA_REPORT.voiceDrift,
        chaptersEligible: 12,
        chaptersScored: 6,
        charactersPending: ['ren'],
      },
    };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test" bookId="b1" />);
    await userEvent.click(screen.getByRole('button', { name: /resume scoring/i }));
    expect(resumeSpy).toHaveBeenCalledWith('b1');
    resumeSpy.mockRestore();
  });

  it('re-enables the Resume button after a failed resumeScoring call, so the user can retry', async () => {
    // Regression coverage for the catch branch — the one place the row could
    // get permanently stuck (button disabled forever showing "Resuming…")
    // if a bug crept into the failure path.
    const resumeSpy = vi.spyOn(api, 'resumeScoring').mockRejectedValue(new Error('network error'));
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: {
        ...MOCK_QA_REPORT.voiceDrift,
        chaptersEligible: 12,
        chaptersScored: 6,
        charactersPending: ['ren'],
      },
    };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test" bookId="b1" />);
    const button = screen.getByRole('button', { name: /resume scoring/i });
    await userEvent.click(button);
    expect(resumeSpy).toHaveBeenCalledWith('b1');
    const retryButton = await screen.findByRole('button', { name: /resume scoring/i });
    expect(retryButton).not.toBeDisabled();
    resumeSpy.mockRestore();
  });
});
