/* Menu wiring regression: the "Change log" button in the global nav must
   dispatch onOpenChangelog so it actually surfaces the workspace activity
   feed. Pairs with src/lib/router.test.ts (which only covers stage↔hash
   conversion, not the click path).

   Plan 120: the former inline TTS / analysis / generation / revisions pill
   cluster is gone — the top bar now renders a single compact Status pill
   (driven by the pure `summarizeStatus` helper) that opens the Status modal.
   The AnalysisPill / GenerationPill components survive (reused inside the
   modal) and are now exercised directly here. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';

/* TopBar now always renders the <AdminPill>, which self-polls
   api.getGenerationStats + api.getDiagnostics. Stub just those two so the pill
   stays quiet (no real fetch in jsdom) without disturbing the rest of api. */
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getGenerationStats: vi.fn().mockResolvedValue({ chapters: 0, rtf: null, liveBatchRtf: null }),
      getDiagnostics: vi.fn().mockResolvedValue({ ts: '', overall: 'ok', checks: [] }),
    },
  };
});
import {
  TopBar,
  AnalysisPill,
  GenerationPill,
  DesignPill,
  summarizeStatus,
  type StatusSummary,
  type AnalysisPillData,
  type DesignPillData,
} from './top-bar';
import { uiSlice } from '../store/ui-slice';
import { accountSlice } from '../store/account-slice';

const IDLE_SUMMARY: StatusSummary = { label: 'Status', tone: 'neutral', icon: 'clock' };

const STATUS_DETAIL: Parameters<typeof TopBar>[0]['statusDetail'] = {
  ttsControls: <span data-testid="tts-sentinel">Kokoro ready</span>,
  analysis: null,
  generation: null,
  design: null,
  pendingRevisionsCount: 0,
  onOpenRevisions: vi.fn(),
  onGoToAnalysing: vi.fn(),
  onGoToGeneration: vi.fn(),
  onGoToDesign: vi.fn(),
};

function makeProps(
  overrides: Partial<Parameters<typeof TopBar>[0]> = {},
): Parameters<typeof TopBar>[0] {
  return {
    stage: 'books',
    view: null,
    setView: vi.fn(),
    onHome: vi.fn(),
    onOpenVoices: vi.fn(),
    onOpenChangelog: vi.fn(),
    onOpenAccount: vi.fn(),
    onOpenAdmin: vi.fn(),
    userDisplayName: 'Mike Dudarenok',
    statusSummary: IDLE_SUMMARY,
    statusDetail: STATUS_DETAIL,
    ...overrides,
  };
}

/* TopBar embeds the ThemeToggleButton (plan 41), which reads from the ui
   and account slices. Wrap every render with a Provider so those hooks
   can resolve their state — tests that don't care about the toggle
   still need the wrapper. */
function renderWithStore(ui: React.ReactElement) {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      account: accountSlice.reducer,
    },
  });
  return render(<Provider store={store}>{ui}</Provider>);
}

describe('TopBar — global nav', () => {
  it('renders the Change log button when no book is open', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    expect(screen.getByRole('button', { name: 'Change log' })).toBeInTheDocument();
  });

  it('fires onOpenChangelog when the Change log button is clicked from the Books page', () => {
    const onOpenChangelog = vi.fn();
    renderWithStore(<TopBar {...makeProps({ stage: 'books', onOpenChangelog })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenChangelog from the Voices page too — the nav stays consistent across global stages', () => {
    const onOpenChangelog = vi.fn();
    renderWithStore(<TopBar {...makeProps({ stage: 'voices', onOpenChangelog })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);
  });

  it('hides the global nav when a book is open (in-book tabs render instead)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    expect(screen.queryByRole('button', { name: 'Change log' })).not.toBeInTheDocument();
    /* The per-book log tab is the lowercase "Log" instead. */
    expect(screen.getByRole('button', { name: 'Log' })).toBeInTheDocument();
  });
});

describe('TopBar — persistent Help affordance (fe-29)', () => {
  it('renders the persistent Help affordance linking to #/help (fe-29)', () => {
    renderWithStore(<TopBar {...makeProps()} />);
    const help = screen.getByRole('link', { name: /^help$/i });
    expect(help).toHaveAttribute('href', '#/help');
  });
});

describe('TopBar — avatar entry to account', () => {
  it('renders the avatar as a button labelled with the display name', () => {
    renderWithStore(<TopBar {...makeProps({ userDisplayName: 'Captain Picard' })} />);
    expect(screen.getByRole('button', { name: /account.*captain picard/i })).toBeInTheDocument();
  });

  it('fires onOpenAccount when the avatar is clicked', () => {
    const onOpenAccount = vi.fn();
    renderWithStore(<TopBar {...makeProps({ onOpenAccount })} />);
    fireEvent.click(screen.getByRole('button', { name: /account.*mike dudarenok/i }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it('falls back to an "unnamed user" label when displayName is empty', () => {
    renderWithStore(<TopBar {...makeProps({ userDisplayName: '' })} />);
    expect(screen.getByRole('button', { name: /account.*unnamed user/i })).toBeInTheDocument();
  });
});

describe('TopBar — StatusPill (hover popover)', () => {
  it('renders the dominant summary label, detail and tone', () => {
    renderWithStore(
      <TopBar
        {...makeProps({
          statusSummary: { label: 'Generating', tone: 'peach', icon: 'spinner', detail: '55%' },
        })}
      />,
    );
    const pill = screen.getByTestId('status-pill');
    expect(pill.textContent).toContain('Generating');
    expect(pill.textContent).toContain('55%');
    expect(pill).toHaveAttribute('data-status-tone', 'peach');
  });

  it('renders just the label (no separator) for the idle summary', () => {
    renderWithStore(<TopBar {...makeProps({ statusSummary: IDLE_SUMMARY })} />);
    const pill = screen.getByTestId('status-pill');
    expect(pill.textContent).toBe('Status');
    expect(pill.textContent).not.toContain('·');
    expect(pill).toHaveAttribute('data-status-tone', 'neutral');
  });

  it('reveals the popover on hover (pointer enter) with the detail sections', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'generate' })} />);
    expect(screen.queryByTestId('status-popover')).not.toBeInTheDocument();
    fireEvent.pointerEnter(screen.getByTestId('status-pill'));
    expect(screen.getByTestId('status-popover')).toBeInTheDocument();
    expect(screen.getByTestId('status-popover-tts')).toBeInTheDocument();
    expect(screen.getByTestId('tts-sentinel')).toBeInTheDocument();
  });

  it('reveals the popover on click/tap (sticky) and reflects aria-expanded', () => {
    renderWithStore(<TopBar {...makeProps()} />);
    const pill = screen.getByTestId('status-pill');
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(pill);
    expect(screen.getByTestId('status-popover')).toBeInTheDocument();
    expect(pill).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the analysis/generation pills out of the bar until the popover opens', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'generate' })} />);
    /* Closed popover → no pills anywhere. */
    expect(screen.queryByTestId('analysis-pill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('generation-pill')).not.toBeInTheDocument();
  });

  it('hides the pill entirely when statusSummary is null (idle global view)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'books', statusSummary: null })} />);
    expect(screen.queryByTestId('status-pill')).not.toBeInTheDocument();
  });
});

describe('summarizeStatus — dominant-state priority ladder (plan 120)', () => {
  const running = (over: Partial<AnalysisPillData> = {}): AnalysisPillData => ({
    state: 'running',
    phaseLabel: 'Detecting characters',
    percent: 55,
    onClick: vi.fn(),
    ...over,
  });

  it('idle → "Status" neutral with no detail when nothing is happening', () => {
    expect(
      summarizeStatus({
        analysis: null,
        generation: null,
        pendingRevisionsCount: 0,
        design: null,
        anyModelLoading: false,
      }),
    ).toEqual({ label: 'Status', tone: 'neutral', icon: 'clock' });
  });

  it('halted (generation) outranks everything → rose "Halted" with no detail', () => {
    const s = summarizeStatus({
      analysis: running(),
      generation: { state: 'halted', done: 0, total: 50, percent: 0, onClick: vi.fn() },
      pendingRevisionsCount: 3,
      design: null,
      anyModelLoading: true,
    });
    expect(s).toEqual({ label: 'Halted', tone: 'rose', icon: 'warning' });
  });

  it('halted (analysis) also wins even while a generation is still running', () => {
    const s = summarizeStatus({
      analysis: running({ state: 'halted' }),
      generation: { state: 'running', done: 1, total: 10, percent: 10, onClick: vi.fn() },
      pendingRevisionsCount: 0,
      design: null,
      anyModelLoading: false,
    });
    expect(s.label).toBe('Halted');
    expect(s.tone).toBe('rose');
  });

  it('stalled outranks running', () => {
    const s = summarizeStatus({
      analysis: running({ state: 'stalled' }),
      generation: { state: 'running', done: 1, total: 10, percent: 10, onClick: vi.fn() },
      pendingRevisionsCount: 0,
      design: null,
      anyModelLoading: false,
    });
    expect(s).toEqual({ label: 'Stalled', tone: 'amber', icon: 'clock' });
  });

  it('generation running outranks analysis running (terminal goal wins the tie)', () => {
    const s = summarizeStatus({
      analysis: running({ percent: 90 }),
      generation: { state: 'running', done: 2, total: 10, percent: 20, onClick: vi.fn() },
      pendingRevisionsCount: 0,
      design: null,
      anyModelLoading: false,
    });
    expect(s).toEqual({ label: 'Generating', tone: 'peach', icon: 'spinner', detail: '20%' });
  });

  it('analysis running → "Analysing · {percent}%"', () => {
    const s = summarizeStatus({
      analysis: running({ percent: 42 }),
      generation: null,
      pendingRevisionsCount: 0,
      design: null,
      anyModelLoading: false,
    });
    expect(s).toEqual({ label: 'Analysing', tone: 'peach', icon: 'spinner', detail: '42%' });
  });

  it('subset analysis running → "Retrying" label', () => {
    const s = summarizeStatus({
      analysis: running({ kind: 'subset', percent: 12 }),
      generation: null,
      pendingRevisionsCount: 0,
      design: null,
      anyModelLoading: false,
    });
    expect(s.label).toBe('Retrying');
    expect(s.detail).toBe('12%');
  });

  it('model loading (no run) → amber "Loading model"', () => {
    const s = summarizeStatus({
      analysis: null,
      generation: null,
      pendingRevisionsCount: 2,
      design: null,
      anyModelLoading: true,
    });
    expect(s).toEqual({ label: 'Loading model', tone: 'amber', icon: 'spinner' });
  });

  it('paused analysis (no run, no loading) → neutral "Paused"', () => {
    const s = summarizeStatus({
      analysis: running({ state: 'paused' }),
      generation: null,
      pendingRevisionsCount: 5,
      design: null,
      anyModelLoading: false,
    });
    expect(s).toEqual({ label: 'Paused', tone: 'neutral', icon: 'clock' });
  });

  it('pending revisions (nothing else active) → peach "Revisions · {n}"', () => {
    const s = summarizeStatus({
      analysis: null,
      generation: null,
      pendingRevisionsCount: 4,
      design: null,
      anyModelLoading: false,
    });
    expect(s).toEqual({ label: 'Revisions', tone: 'peach', icon: 'warning', detail: '4' });
  });

  const designRunning = (over: Partial<DesignPillData> = {}): DesignPillData => ({
    state: 'running',
    done: 3,
    total: 8,
    percent: 38,
    skipped: 0,
    failureCount: 0,
    onClick: vi.fn(),
    ...over,
  });

  it('design running → peach "Designing · {percent}%"', () => {
    const s = summarizeStatus({
      analysis: null,
      generation: null,
      design: designRunning(),
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    });
    expect(s).toEqual({ label: 'Designing', tone: 'peach', icon: 'spinner', detail: '38%' });
  });

  it('generation AND analysis both outrank design running', () => {
    const gen = summarizeStatus({
      analysis: null,
      generation: { state: 'running', done: 1, total: 4, percent: 25, onClick: vi.fn() },
      design: designRunning(),
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    });
    expect(gen.label).toBe('Generating');
    const ana = summarizeStatus({
      analysis: running({ percent: 50 }),
      generation: null,
      design: designRunning(),
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    });
    expect(ana.label).toBe('Analysing');
  });

  it('design halted → rose "Halted"; design stalled → amber "Stalled"', () => {
    expect(
      summarizeStatus({
        analysis: null,
        generation: null,
        design: designRunning({ state: 'halted' }),
        pendingRevisionsCount: 0,
        anyModelLoading: false,
      }),
    ).toMatchObject({ label: 'Halted', tone: 'rose' });
    expect(
      summarizeStatus({
        analysis: null,
        generation: null,
        design: designRunning({ state: 'stalled' }),
        pendingRevisionsCount: 0,
        anyModelLoading: false,
      }),
    ).toMatchObject({ label: 'Stalled', tone: 'amber' });
  });
});

describe('DesignPill', () => {
  it('renders the running summary "Designing · done/total · percent"', () => {
    render(
      <DesignPill
        data={{
          state: 'running',
          done: 3,
          total: 8,
          percent: 38,
          skipped: 0,
          failureCount: 0,
          onClick: vi.fn(),
        }}
      />,
    );
    expect(screen.getByTestId('design-pill')).toHaveTextContent('Designing · 3/8 · 38%');
  });

  it('renders the terminal summary "Designed N · M failed · K skipped"', () => {
    render(
      <DesignPill
        data={{
          state: 'done',
          done: 6,
          total: 9,
          percent: 100,
          skipped: 2,
          failureCount: 1,
          onClick: vi.fn(),
        }}
      />,
    );
    expect(screen.getByTestId('design-pill')).toHaveTextContent(
      'Designed · 6 · 1 failed · 2 skipped',
    );
  });

  it('DesignPill shows the phase for a single design', () => {
    render(<DesignPill data={{ state: 'running', done: 0, total: 1, percent: 30, skipped: 0, failureCount: 0, currentName: 'Aria', phase: 'rendering', onClick: () => {} }} />);
    expect(screen.getByText(/Aria/)).toBeInTheDocument();
    expect(screen.getByText(/rendering audition/i)).toBeInTheDocument();
  });
});

/* AnalysisPill / GenerationPill now live inside the Status modal. They no
   longer need the TopBar (or its store) — render them directly. */
describe('AnalysisPill (B3 sticky analysis)', () => {
  it('renders the running variant with the phase label and percent', () => {
    render(
      <AnalysisPill
        data={{ state: 'running', phaseLabel: 'Detecting characters', percent: 42, onClick: vi.fn() }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Analysing');
    expect(pill.textContent).toContain('Detecting characters');
    expect(pill.textContent).toContain('42%');
  });

  it('renders the halted variant with the trimmed halt reason and a full-message title attribute', () => {
    const longReason =
      'Phase 1 demoted 60% of sentences to narrator — model attribution unreliable.';
    render(
      <AnalysisPill
        data={{
          state: 'halted',
          phaseLabel: 'Parsing and attribution',
          percent: 0,
          haltReason: longReason,
          onClick: vi.fn(),
        }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Halted');
    /* Trimmed to 32 chars + ellipsis on render so a long halt message
       doesn't blow out the layout. */
    expect(pill.textContent).toContain('…');
    /* Full message is preserved on the title attribute for hover. */
    expect(pill).toHaveAttribute('title', longReason);
  });

  it("renders the paused variant without a percent (paused work doesn't tick)", () => {
    render(
      <AnalysisPill
        data={{ state: 'paused', phaseLabel: 'Detecting characters', percent: 30, onClick: vi.fn() }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Paused');
    expect(pill.textContent).not.toContain('30%');
  });

  it('fires onClick when the pill is clicked (routes back to the analysing view)', () => {
    const onClick = vi.fn();
    render(
      <AnalysisPill
        data={{ state: 'running', phaseLabel: 'Detecting characters', percent: 10, onClick }}
      />,
    );
    fireEvent.click(screen.getByTestId('analysis-pill'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('AnalysisPill subset variant (plan 32 D2)', () => {
  it('renders the running variant as "Retrying N chapters · 42%" when kind === subset', () => {
    render(
      <AnalysisPill
        data={{
          state: 'running',
          phaseLabel: 'Detecting characters',
          percent: 42,
          kind: 'subset',
          subsetChapterCount: 3,
          onClick: vi.fn(),
        }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill).toHaveAttribute('data-pill-kind', 'subset');
    expect(pill.textContent).toContain('Retrying');
    expect(pill.textContent).toContain('3 chapters');
    expect(pill.textContent).toContain('42%');
    /* The phase-label fallback must NOT render in subset mode — the
       chapter-count copy is the more useful signal. */
    expect(pill.textContent).not.toContain('Detecting characters');
  });

  it('singularises the chapter count for a one-chapter retry', () => {
    render(
      <AnalysisPill
        data={{
          state: 'running',
          phaseLabel: 'Detecting characters',
          percent: 12,
          kind: 'subset',
          subsetChapterCount: 1,
          onClick: vi.fn(),
        }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('1 chapter');
    expect(pill.textContent).not.toContain('1 chapters');
  });

  it('falls back to the phase label when kind === subset but subsetChapterCount is missing', () => {
    render(
      <AnalysisPill
        data={{
          state: 'running',
          phaseLabel: 'Detecting characters',
          percent: 5,
          kind: 'subset',
          onClick: vi.fn(),
        }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Retrying');
    expect(pill.textContent).toContain('Detecting characters');
  });

  it('renders the main variant ("Analysing") when kind is undefined or "main"', () => {
    render(
      <AnalysisPill
        data={{ state: 'running', phaseLabel: 'Detecting characters', percent: 30, onClick: vi.fn() }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill).toHaveAttribute('data-pill-kind', 'main');
    expect(pill.textContent).toContain('Analysing');
    expect(pill.textContent).toContain('Detecting characters');
  });

  it('subset paused / halted variants keep the standard terminal copy (not the retrying label)', () => {
    render(
      <AnalysisPill
        data={{
          state: 'paused',
          phaseLabel: 'Detecting characters',
          percent: 0,
          kind: 'subset',
          subsetChapterCount: 2,
          onClick: vi.fn(),
        }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Paused');
    expect(pill.textContent).not.toContain('Retrying');
  });
});

describe('GenerationPill', () => {
  it('renders the done/total and percent for a running run', () => {
    render(
      <GenerationPill
        data={{ state: 'running', done: 3, total: 10, percent: 30, onClick: vi.fn() }}
      />,
    );
    const pill = screen.getByTestId('generation-pill');
    expect(pill.textContent).toContain('Generating');
    expect(pill.textContent).toContain('3/10');
    expect(pill.textContent).toContain('30%');
  });

  it('fires onClick when clicked', () => {
    const onClick = vi.fn();
    render(
      <GenerationPill data={{ state: 'running', done: 1, total: 5, percent: 20, onClick }} />,
    );
    fireEvent.click(screen.getByTestId('generation-pill'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
