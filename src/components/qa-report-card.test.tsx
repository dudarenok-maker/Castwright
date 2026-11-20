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
    // fraction, not the "not run for this book yet" copy
    // that implies the gate never ran.
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 0, chaptersEmbedFailed: 12 },
    };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test Book" bookId="demo-book" />);
    expect(screen.getByText(/0 of 12 eligible chapters scored/i)).toBeInTheDocument();
    expect(screen.queryByText(/not run for this book yet/i)).not.toBeInTheDocument();
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

  describe('speaker check off (#4454)', () => {
    const OFF_COPY = 'Render-integrity QA (voice match) is off. Turn it on in Advanced settings → Per-sentence QA gates to check character voices.';
    const renderWith = (voiceDrift: Partial<typeof MOCK_QA_REPORT.voiceDrift>) =>
      render(
        <QaReportCard
          report={{ ...MOCK_QA_REPORT, voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, ...voiceDrift } }}
          loading={false}
          error={false}
          bookTitle="Test"
          bookId="b1"
        />,
      );

    it('(a) pending + gate off: says so and offers no Resume', () => {
      /* the shape buildAudioQaReport emits for a never-scored book (server qa-report.test.ts): the
         whole roster counts as "checked" and every id is pending */
      renderWith({
        speakerCheckEnabled: false,
        chaptersEligible: 1,
        chaptersScored: 0,
        chaptersEmbedFailed: 0,
        chaptersWithVerdicts: 0,
        charactersOnRoster: 2,
        charactersChecked: 2,
        charactersPending: ['narrator', 'ren'],
        mismatches: [],
        inconclusiveCount: 0,
      });
      expect(screen.queryByRole('button', { name: 'Resume scoring' })).toBeNull();
      expect(screen.getByTestId('qa-speaker-check-off')).toHaveTextContent(OFF_COPY);
    });

    it('(a3) the builder shape (pending character in every chapter, both chapter counts 0, a mismatch standing) + gate off: keeps the result, no gate-off row, no Resume', () => {
      renderWith({
        speakerCheckEnabled: false,
        chaptersEligible: 1,
        chaptersScored: 0,
        chaptersEmbedFailed: 0,
        chaptersWithVerdicts: 1,
        charactersOnRoster: 2,
        charactersChecked: 2,
        charactersPending: ['ren'],
        mismatches: [{ characterId: 'narrator', fixable: true }] as typeof MOCK_QA_REPORT.voiceDrift.mismatches,
      });
      expect(screen.getByText('1 of 1 eligible chapters checked so far, 1 mismatches · Render-integrity QA is now off')).toBeInTheDocument();
      expect(screen.queryByTestId('qa-speaker-check-off')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Resume scoring' })).toBeNull();
    });

    it('(a2) pending + partial scoring + gate off: keeps the past result and mismatch count, no Resume', () => {
      renderWith({
        speakerCheckEnabled: false,
        charactersPending: ['newcomer'],
        chaptersScored: 11,
        chaptersEmbedFailed: 0,
        mismatches: [{ characterId: 'ren', fixable: true }, { characterId: 'mo', fixable: true }] as typeof MOCK_QA_REPORT.voiceDrift.mismatches,
      });
      expect(screen.getByText(/11 of 12 eligible chapters scored.*2 mismatches.*Render-integrity QA is now off/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Resume scoring' })).toBeNull();
      expect(screen.queryByTestId('qa-speaker-check-off')).toBeNull();
    });

    it('(b) restructured and re-rendered with the check off (nothing pending, no verdict on a current chapter): gate-off copy, not a checked-so-far line', () => {
      /* the shape buildAudioQaReport emits once a chapter restructure deleted the verdicts while the
         book-level centroids file survived (server qa-report.test.ts) */
      renderWith({
        speakerCheckEnabled: false,
        chaptersEligible: 1,
        chaptersScored: 0,
        chaptersEmbedFailed: 0,
        chaptersWithVerdicts: 0,
        charactersOnRoster: 2,
        charactersChecked: 2,
        charactersPending: [],
        mismatches: [],
        inconclusiveCount: 0,
      });
      expect(screen.getByTestId('qa-speaker-check-off')).toHaveTextContent(OFF_COPY);
      expect(screen.queryByText(/checked so far/)).toBeNull();
      expect(screen.queryByText(/Not run for this book/)).toBeNull();
    });

    it('(c) scored shape + gate off: keeps the result and appends the note, no Resume', () => {
      renderWith({ speakerCheckEnabled: false, chaptersScored: 12, charactersPending: [] });
      expect(screen.getByText(/18 of 18 characters checked.*Render-integrity QA is now off/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Resume scoring' })).toBeNull();
    });

    it('(d) control: gate on + pending still offers Resume', () => {
      renderWith({ speakerCheckEnabled: true, charactersPending: ['ren'], chaptersScored: 6 });
      expect(screen.getByRole('button', { name: 'Resume scoring' })).toBeInTheDocument();
    });
  });

  it('disables Resume scoring with the reason visible while a job start is blocked (#3774)', async () => {
    const resumeSpy = vi.spyOn(api, 'resumeScoring').mockResolvedValue();
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 6, charactersPending: ['ren'] },
    };
    render(
      <QaReportCard
        report={report}
        loading={false}
        error={false}
        bookTitle="Test"
        bookId="b1"
        jobStartBlockedReason="A chapter is being included and analysed."
      />,
    );
    const btn = screen.getByRole('button', { name: /resume scoring/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText('A chapter is being included and analysed.')).toBeVisible();
    expect(btn).toHaveAccessibleDescription('A chapter is being included and analysed.');
    await userEvent.click(btn);
    expect(resumeSpy).not.toHaveBeenCalled();
    resumeSpy.mockRestore();
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
    // A network error is not a server refusal: no sentence is shown beside the button.
    expect(screen.queryByRole('status')).toBeNull();
    resumeSpy.mockRestore();
  });

  it("shows the server's refusal sentence when a splice or repair blocks Resume (#4235)", async () => {
    const reason = 'A chapter fix or repair is running for this book — resume scoring once it finishes.';
    const resumeSpy = vi
      .spyOn(api, 'resumeScoring')
      .mockRejectedValue(Object.assign(new Error(reason), { code: 'resume-scoring-refused' }));
    const report = {
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, chaptersEligible: 12, chaptersScored: 6, charactersPending: ['ren'] },
    };
    render(<QaReportCard report={report} loading={false} error={false} bookTitle="Test" bookId="b1" />);
    await userEvent.click(screen.getByRole('button', { name: /resume scoring/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(reason);
    expect(screen.getByRole('button', { name: /resume scoring/i })).not.toBeDisabled();
    resumeSpy.mockRestore();
  });

  describe('needs re-render listing (#3680)', () => {
    const withRerender = (extra = {}) => ({
      ...MOCK_QA_REPORT,
      voiceDrift: { ...MOCK_QA_REPORT.voiceDrift, charactersNeedingRerender: ['c1', 'c2'], ...extra },
    });
    const bare = (report: typeof MOCK_QA_REPORT, props = {}) =>
      render(<QaReportCard report={report} loading={false} error={false} bookTitle="T" bookId="b1" {...props} />);

    it('lists names, falling back to the id when a name is missing', () => {
      bare(withRerender(), { characterNames: { c1: 'Alice' } });
      const el = screen.getByTestId('qa-needs-rerender');
      expect(el).toHaveTextContent('Needs re-render: Alice, c2.');
      // The exact sentence: it names no cause, because the cause differs (voice changed,
      // fallback engine, merged key) and a fallback-only character's voice never changed.
      expect(el).toHaveTextContent(
        "Some of their lines weren't recorded in their current voice, so those can't be checked — re-render a chapter named here to check them.",
      );
      expect(el).not.toHaveTextContent(/No lines are recorded/);
      // The headline property of #3680: nothing is pending, so the listing is NOT a Resume offer.
      expect(screen.queryByRole('button', { name: /resume scoring/i })).not.toBeInTheDocument();
    });

    it('a fallback-only character (voice never changed) gets the same cause-neutral sentence (#3680 pass 3)', () => {
      bare(withRerender({ charactersNeedingRerender: ['thurid'], charactersNeedingRerenderChapters: { thurid: [1] } }), {
        characterNames: { thurid: 'Thurid' },
      });
      const el = screen.getByTestId('qa-needs-rerender');
      expect(el).toHaveTextContent('Needs re-render: Thurid (chapter 1).');
      expect(el).not.toHaveTextContent(/earlier voice/i);
    });

    it('names the chapters holding the marked key lines, per character (#3680 pass 2)', () => {
      bare(withRerender({ charactersNeedingRerenderChapters: { c1: [4], c2: [1, 3] } }), { characterNames: { c1: 'Alice' } });
      expect(screen.getByTestId('qa-needs-rerender')).toHaveTextContent('Needs re-render: Alice (chapter 4), c2 (chapters 1, 3).');
    });

    it('is absent when the gate never ran and nothing is pending (nothing was settled)', () => {
      bare(withRerender({ chaptersScored: 0, chaptersEmbedFailed: 0, charactersPending: [] }));
      // notRun is reachable with the check ON (or the field absent), so the copy must not ask the
      // user to turn on a setting that may already be on.
      expect(screen.getByText('Not run for this book yet — no voice match has been scored.')).toBeInTheDocument();
      expect(screen.queryByText(/flip on|turn on/i)).not.toBeInTheDocument();
      expect(screen.queryByTestId('qa-needs-rerender')).not.toBeInTheDocument();
    });

    it('is absent when the list is empty', () => {
      bare(MOCK_QA_REPORT);
      expect(screen.queryByTestId('qa-needs-rerender')).not.toBeInTheDocument();
    });

    it('is absent while a scoring pass is live', () => {
      bare(withRerender(), { scoringProgress: { charactersChecked: 1, charactersOnRoster: 5 } });
      expect(screen.queryByTestId('qa-needs-rerender')).not.toBeInTheDocument();
    });

    it('shows alongside the Resume button when characters are also pending', () => {
      bare(withRerender({ charactersPending: ['c3'] }));
      expect(screen.getByRole('button', { name: /resume scoring/i })).toBeInTheDocument();
      expect(screen.getByTestId('qa-needs-rerender')).toBeInTheDocument();
    });
  });
});
