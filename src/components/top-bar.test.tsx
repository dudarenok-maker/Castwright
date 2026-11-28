/* Menu wiring regression: the "Change log" button in the global nav must
   dispatch onOpenChangelog so it actually surfaces the workspace activity
   feed. Pairs with src/lib/router.test.ts (which only covers stage↔hash
   conversion, not the click path).

   Plan 120: the former inline TTS / analysis / generation / revisions pill
   cluster is gone — the top bar now renders a single compact Status pill
   (driven by the pure `summarizeStatus` helper) that opens the Status modal.
   The AnalysisPill / GenerationPill components survive (reused inside the
   modal) and are now exercised directly here. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import type { AppInfo } from '../lib/types';

const appInfoH = vi.hoisted(() => ({
  info: null as AppInfo | null,
  refresh: vi.fn(async () => {}),
}));
vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: appInfoH.info, error: null, refresh: appInfoH.refresh }),
}));

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
  ExportPill,
  summarizeStatus,
  type StatusSummary,
  type AnalysisPillData,
  type DesignPillData,
  type ExportPillData,
} from './top-bar';
import { LABELS } from './theme-toggle';
import { uiSlice } from '../store/ui-slice';
import { accountSlice } from '../store/account-slice';
import { tourSlice } from '../store/tour-slice';

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
    userDisplayName: 'Castwright',
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
      tour: tourSlice.reducer,
    },
  });
  /* #4567 tests assert on the store (theme cycle), so hand the store back
     alongside the RTL helpers. */
  return { store, ...render(<Provider store={store}>{ui}</Provider>) };
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

describe('TopBar — queue chip (#4691)', () => {
  it('renders an icon + the bare count, with the full meaning in the accessible name', () => {
    renderWithStore(
      <TopBar {...makeProps({ stage: 'books', queueCount: 12, onOpenQueue: vi.fn() })} />,
    );
    const chip = screen.getByTestId('topbar-queue-chip');
    expect(chip.textContent).toBe('12');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip).toHaveAttribute('aria-label', 'Generation queue — 12 pending');
    expect(chip).toHaveAttribute('title', 'Generation queue');
    expect(screen.getByRole('button', { name: 'Generation queue — 12 pending' })).toBe(chip);
  });

  it('is absent when nothing is queued', () => {
    renderWithStore(
      <TopBar {...makeProps({ stage: 'books', queueCount: 0, onOpenQueue: vi.fn() })} />,
    );
    expect(screen.queryByTestId('topbar-queue-chip')).not.toBeInTheDocument();
  });
});

describe('TopBar — persistent Help affordance (fe-29)', () => {
  it('renders the Help menu trigger and opens a popover with the three actions', () => {
    renderWithStore(<TopBar {...makeProps()} />);
    const trigger = screen.getByTestId('topbar-help');
    expect(trigger.tagName).toBe('BUTTON');
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: /^help$/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /take the tour/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /show me this screen/i })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /account.*castwright/i }));
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

  it('keeps the pill outside the horizontally-scrolling nav strip so a wide breadcrumb cannot clip it', () => {
    /* Regression: on the listen view the long book-title breadcrumb starved
       the `overflow-x-auto` middle strip and scrolled the right-anchored pill
       off-screen, clipping it to "Revis". The pill must live in an
       always-visible shrink-0 slot, never inside an overflow-x-auto ancestor. */
    renderWithStore(
      <TopBar
        {...makeProps({ stage: 'ready', view: 'listen', projectTitle: 'The Drowning Bell' })}
      />,
    );
    const pill = screen.getByTestId('status-pill');
    expect(pill.closest('.overflow-x-auto')).toBeNull();
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

  it('needs-action analysis (no run, no loading) → neutral "Needs action"', () => {
    const s = summarizeStatus({
      analysis: running({ state: 'needs-action' }),
      generation: null,
      pendingRevisionsCount: 0,
      design: null,
      anyModelLoading: false,
    });
    expect(s).toEqual({ label: 'Needs action', tone: 'neutral', icon: 'clock' });
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

  it('shows an Analysing rung for an active analysis sub-stage', () => {
    const base = {
      analysis: null,
      generation: null,
      design: null,
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    };
    expect(
      summarizeStatus({ ...base, analysisSubstage: { kind: 'prosody', percent: 40 } }),
    ).toMatchObject({
      label: 'Analysing',
      detail: '40%',
      icon: 'spinner',
    });
  });

  it('sub-stage rung goes amber while the analyzer model is loading', () => {
    const base = {
      analysis: null,
      generation: null,
      design: null,
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    };
    expect(
      summarizeStatus({
        ...base,
        analysisSubstage: { kind: 'review', percent: 2, activityState: 'loading' },
      }),
    ).toMatchObject({ label: 'Analysing', tone: 'amber' });
  });

  it('sub-stage rung goes amber when the Gemini fallback is active', () => {
    const base = {
      analysis: null,
      generation: null,
      design: null,
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    };
    expect(
      summarizeStatus({
        ...base,
        analysisSubstage: { kind: 'review', percent: 55, fallbackActive: true },
      }),
    ).toMatchObject({ label: 'Analysing', tone: 'amber' });
  });

  it('sub-stage rung stays the default peach tone while streaming normally', () => {
    const base = {
      analysis: null,
      generation: null,
      design: null,
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    };
    expect(
      summarizeStatus({
        ...base,
        analysisSubstage: { kind: 'review', percent: 55, activityState: 'streaming' },
      }),
    ).toMatchObject({ label: 'Analysing', tone: 'peach' });
  });

  it('sub-stage rung still surfaces (not outranked) when a paused main-analysis rung is also present', () => {
    const result = summarizeStatus({
      analysis: { state: 'paused', percent: 12, kind: 'full' } as never,
      generation: null,
      design: null,
      pendingRevisionsCount: 0,
      anyModelLoading: false,
      analysisSubstage: { kind: 'review', percent: 30, activityState: 'loading' },
    });
    expect(result).toMatchObject({ label: 'Analysing', tone: 'amber', detail: '30%' });
  });

  it('voice-engine states (Generating, Loading model) outrank Analysis and the sub-stage', () => {
    const base = {
      analysis: null,
      generation: null,
      design: null,
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    };
    // Generating is the heaviest — always wins:
    expect(
      summarizeStatus({
        ...base,
        generation: { state: 'running', percent: 10 } as never,
        analysisSubstage: { kind: 'review', percent: 90 },
      }),
    ).toMatchObject({ label: 'Generating' });
    // Loading model now outranks a real analysis pass AND a sub-stage (regrouped ladder):
    expect(
      summarizeStatus({
        ...base,
        anyModelLoading: true,
        analysis: { state: 'running', percent: 12, kind: 'full' } as never,
      }),
    ).toMatchObject({ label: 'Loading model' });
    expect(
      summarizeStatus({
        ...base,
        anyModelLoading: true,
        analysisSubstage: { kind: 'review', percent: 90 },
      }),
    ).toMatchObject({ label: 'Loading model' });
    // Real analysis still outranks its own sub-stage:
    expect(
      summarizeStatus({
        ...base,
        analysis: { state: 'running', percent: 12, kind: 'full' } as never,
        analysisSubstage: { kind: 'review', percent: 90 },
      }),
    ).toMatchObject({ detail: '12%' });
  });

  it('shows "Exporting" with a rounded percent while an export runs and nothing else outranks it', () => {
    const result = summarizeStatus({
      analysis: null,
      generation: null,
      design: null,
      exportPill: { state: 'running', runningCount: 1, percent: 0.42, onClick: () => {} },
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    });
    expect(result).toEqual({ label: 'Exporting', tone: 'peach', icon: 'spinner', detail: '42%' });
  });

  it('folds an export stall into the shared "Stalled" rung', () => {
    const result = summarizeStatus({
      analysis: null,
      generation: null,
      design: null,
      exportPill: { state: 'stalled', runningCount: 1, onClick: () => {} },
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    });
    expect(result.label).toBe('Stalled');
  });

  it('does not surface an export "done"/"failed" linger on the compact pill (popover-only, like Design)', () => {
    const result = summarizeStatus({
      analysis: null,
      generation: null,
      design: null,
      exportPill: { state: 'done', onClick: () => {} },
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    });
    expect(result.label).toBe('Status');
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

  it('surfaces the failure count inline while running (not just in the terminal summary)', () => {
    render(
      <DesignPill
        data={{
          state: 'running',
          done: 2,
          total: 6,
          percent: 83,
          skipped: 3,
          failureCount: 1,
          onClick: vi.fn(),
        }}
      />,
    );
    expect(screen.getByTestId('design-pill')).toHaveTextContent('2/6 · 1 failed · 83%');
  });

  it('omits the failed segment when nothing has failed', () => {
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
    expect(screen.getByTestId('design-pill')).toHaveTextContent('3/8 · 38%');
    expect(screen.getByTestId('design-pill')).not.toHaveTextContent('failed');
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
    render(
      <DesignPill
        data={{
          state: 'running',
          done: 0,
          total: 1,
          percent: 30,
          skipped: 0,
          failureCount: 0,
          currentName: 'Aria',
          phase: 'rendering',
          onClick: () => {},
        }}
      />,
    );
    expect(screen.getByText(/Aria/)).toBeInTheDocument();
    expect(screen.getByText(/rendering audition/i)).toBeInTheDocument();
  });
});

/* fs-54 — the fourth status pill, "Export" progress/linger. Same direct-render
   pattern as GenerationPill/DesignPill above. */
describe('ExportPill', () => {
  const renderPill = (data: ExportPillData) => render(<ExportPill data={data} />);

  it('renders the running summary with runningCount and percent', () => {
    renderPill({ state: 'running', runningCount: 2, percent: 0.45, onClick: vi.fn() });
    const pill = screen.getByTestId('export-pill');
    expect(pill.textContent).toContain('Exporting');
    expect(pill.textContent).toContain('2 running');
    expect(pill.textContent).toContain('45%');
  });

  it('renders the "Stalled" label for the stalled state', () => {
    renderPill({ state: 'stalled', runningCount: 1, percent: 0.1, onClick: vi.fn() });
    const pill = screen.getByTestId('export-pill');
    expect(pill.textContent).toContain('Stalled');
    expect(pill.textContent).toContain('1 running');
    expect(pill.textContent).toContain('10%');
  });

  it('renders "Export done" for the done state (no running detail)', () => {
    renderPill({ state: 'done', onClick: vi.fn() });
    const pill = screen.getByTestId('export-pill');
    expect(pill.textContent).toBe('Export done');
  });

  it('renders "Export failed" for the failed state (no running detail)', () => {
    renderPill({ state: 'failed', onClick: vi.fn() });
    const pill = screen.getByTestId('export-pill');
    expect(pill.textContent).toBe('Export failed');
  });

  it('fires onClick when clicked', () => {
    const onClick = vi.fn();
    renderPill({ state: 'running', runningCount: 3, percent: 0.5, onClick });
    fireEvent.click(screen.getByTestId('export-pill'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

/* AnalysisPill / GenerationPill now live inside the Status modal. They no
   longer need the TopBar (or its store) — render them directly. */
describe('AnalysisPill (B3 sticky analysis)', () => {
  it('renders the running variant with the phase label and percent', () => {
    render(
      <AnalysisPill
        data={{
          state: 'running',
          phaseLabel: 'Detecting characters',
          percent: 42,
          onClick: vi.fn(),
        }}
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

  it('renders the needs-action variant for cast_incomplete / stage1_shrink_refused halts (#3203)', () => {
    render(
      <AnalysisPill
        data={{
          state: 'needs-action',
          phaseLabel: 'Detecting characters',
          percent: 0,
          haltReason: 'cast shrunk from 20 → 4',
          onClick: vi.fn(),
        }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Needs action');
    expect(pill.textContent).toContain('cast shrunk from 20 → 4');
  });

  it("renders the paused variant without a percent (paused work doesn't tick)", () => {
    render(
      <AnalysisPill
        data={{
          state: 'paused',
          phaseLabel: 'Detecting characters',
          percent: 30,
          onClick: vi.fn(),
        }}
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
        data={{
          state: 'running',
          phaseLabel: 'Detecting characters',
          percent: 30,
          onClick: vi.fn(),
        }}
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

  /* #3435 - a subset run that ended in a not-a-failure stop is a needs-action
     pill that says why (the server's message), not "Retrying N chapters" and not
     the stale phase label of a run that is no longer going. */
  it('a subset in needs-action shows its haltReason instead of the retry copy or the phase label', () => {
    render(
      <AnalysisPill
        data={{
          state: 'needs-action',
          phaseLabel: 'Detecting characters',
          percent: 0,
          kind: 'subset',
          subsetChapterCount: 2,
          haltReason: 'Cast detection failed',
          onClick: vi.fn(),
        }}
      />,
    );
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Needs action');
    expect(pill.textContent).toContain('Cast detection failed');
    expect(pill.textContent).not.toContain('Retrying');
    expect(pill.textContent).not.toContain('Detecting characters');
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
    render(<GenerationPill data={{ state: 'running', done: 1, total: 5, percent: 20, onClick }} />);
    fireEvent.click(screen.getByTestId('generation-pill'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('TopBar — responsive nav drawer (<xl hamburger)', () => {
  it('renders the hamburger trigger on a book stage and on global stages', () => {
    const { unmount } = renderWithStore(
      <TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />,
    );
    const toggle = screen.getByTestId('topbar-nav-toggle');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.className).toMatch(/xl:hidden/);
    unmount();
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    expect(screen.getByTestId('topbar-nav-toggle')).toBeInTheDocument();
  });

  it('renders the hamburger on no-nav stages (upload/analysing/confirm) phone-only — sm:hidden, not xl:hidden (#4567)', () => {
    for (const stage of ['upload', 'analysing', 'confirm'] as const) {
      const { unmount } = renderWithStore(<TopBar {...makeProps({ stage, view: null })} />);
      const toggle = screen.getByTestId('topbar-nav-toggle');
      expect(toggle.className).toMatch(/sm:hidden/);
      expect(toggle.className).not.toMatch(/xl:hidden/);
      unmount();
    }
  });

  it('no-nav stage: the drawer Admin row has no divider/top padding (it is the first child, #4567)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'analysing', view: null })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const admin = screen.getByTestId('nav-drawer-link-admin');
    expect(admin.className).not.toMatch(/border-t/);
    expect(admin.className).not.toMatch(/\bpt-3\b/);
  });

  it('nav stage: the drawer Admin row keeps the divider above it (#4567)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    expect(screen.getByTestId('nav-drawer-link-admin').className).toMatch(/border-t/);
  });

  it('keeps the drawer unmounted until the trigger is clicked (duplicate-selector safety)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
  });

  it('opens the drawer with the six per-book tabs when a book is open, active one marked', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const drawer = screen.getByTestId('topbar-nav-drawer');
    const d = within(drawer);
    expect(d.getByTestId('nav-drawer-link-manuscript')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-cast')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-library')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-generate')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-listen')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-log')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-cast')).toHaveAttribute('aria-current', 'page');
    expect(d.getByTestId('nav-drawer-link-manuscript')).not.toHaveAttribute('aria-current');
  });

  /* fe-46 — the per-book tabs read in workflow order: Cast (voice design)
     precedes Manuscript review, then Generate → Listen, and the cross-cutting
     Log + Voices trail at the end (Voices last — it's the cross-book library,
     a global destination, not a per-book step). Locks BOTH surfaces the single
     TABS array feeds: the inline xl strip and the hamburger drawer. */
  it('renders the per-book tabs in workflow order (Cast · Manuscript · Generate · Listen · Log · Voices)', () => {
    const expected = ['Cast', 'Manuscript', 'Generate', 'Listen', 'Log', 'Voices'];
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);

    // Inline strip (hidden xl:flex, but present in the DOM under jsdom).
    const inlineNav = screen.getByRole('button', { name: 'Cast' }).closest('nav')!;
    expect(
      within(inlineNav)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(expected);

    // Hamburger drawer follows the same order — the first six menuitems (the
    // seventh is the phone-only Admin row, #916).
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const rows = within(screen.getByTestId('topbar-nav-drawer')).getAllByRole('menuitem');
    expect(rows.slice(0, 6).map((r) => r.textContent)).toEqual(expected);
  });

  it('opens the drawer with the global nav on a global stage', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const d = within(screen.getByTestId('topbar-nav-drawer'));
    expect(d.getByTestId('nav-drawer-link-books')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-voices')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-changelog')).toBeInTheDocument();
  });

  it('every drawer row meets the 44px touch target', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'listen' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const rows = within(screen.getByTestId('topbar-nav-drawer')).getAllByRole('menuitem');
    /* 6 per-book tabs + the phone-only Admin row (#916) + the five phone-only
       Help/Tour/Screen-tour/Theme/Account rows (#4567). */
    expect(rows.length).toBe(12);
    for (const r of rows) expect(r.className).toMatch(/min-h-\[44px\]/);
  });

  it('clicking a per-book row calls setView and closes (unmounts) the drawer', () => {
    const setView = vi.fn();
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'listen', setView })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('nav-drawer-link-cast'));
    expect(setView).toHaveBeenCalledWith('cast');
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
  });

  it('clicking the global Books / Voices / Change log rows calls the right handlers', () => {
    const onHome = vi.fn();
    const onOpenVoices = vi.fn();
    const onOpenChangelog = vi.fn();
    renderWithStore(
      <TopBar {...makeProps({ stage: 'books', onHome, onOpenVoices, onOpenChangelog })} />,
    );
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('nav-drawer-link-changelog'));
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('nav-drawer-link-voices'));
    expect(onOpenVoices).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('nav-drawer-link-books'));
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the drawer; outside-click (scrim) closes it too', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    expect(screen.getByTestId('topbar-nav-drawer')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
    /* Escape returns focus to the trigger (spec — HelpMenu parity). */
    expect(screen.getByTestId('topbar-nav-toggle')).toHaveFocus();
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('topbar-nav-scrim'));
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
  });

  it('the inline desktop nav strip is gated behind hidden xl:flex', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    const inlineNav = screen.getByRole('button', { name: 'Manuscript' }).closest('nav')!;
    expect(inlineNav.className).toMatch(/hidden/);
    expect(inlineNav.className).toMatch(/xl:flex/);
  });
});

/* #916 — phone inline-chrome trim. The responsive nav's 44px hamburger pushed
   the right cluster (Help / Theme / Account) ~120px past the 412px phone
   viewport, where overflow-x-clip hid them. The fix reclaims width by hiding the
   wordmark text on phone and moving the Admin pill into the drawer on every
   stage (#4567: the drawer now exists on no-nav stages too; inline at sm+). jsdom can't see
   the pixel clip, so these lock the responsive-class intent + drawer reachability;
   the geometry itself is gated by e2e/responsive/topbar-nav.spec.ts at Pixel-7. */
describe('TopBar — #916 phone inline-chrome trim', () => {
  it('hides the Castwright wordmark text on phone (the mark stays as the home affordance)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    const home = screen.getByRole('button', { name: 'Castwright — home' });
    const wordmark = within(home).getByText('Castwright');
    expect(wordmark.className).toMatch(/hidden/);
    expect(wordmark.className).toMatch(/2xl:inline/);
  });

  /* #4691 decision A — Help / Theme / Account stay inline from sm up, so the
     bar sheds width elsewhere: the wordmark text and version pill are 2xl+ (owner
     decision 2026-11-28), and the book title truncates (full text kept in `title`)
     down to a 44px / few-character floor instead of holding its width. */
  it('hides the version pill below 2xl', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    expect(screen.getByTestId('version-pill').parentElement!.className).toMatch(
      /hidden 2xl:inline-flex/,
    );
  });

  it('truncates a long book title with an ellipsis and keeps the full text in title', () => {
    const long = 'The Coalfall Commission: A Very Long Subtitle That Cannot Fit';
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'listen', projectTitle: long })} />);
    const button = screen.getByTitle(long);
    expect(button.className).toMatch(/min-w-\[44px\]/);
    expect(button.className).not.toMatch(/min-w-0\b/);
    expect(button.className).not.toMatch(/shrink-0/);
    const text = within(button).getByText(long);
    expect(text.className).toMatch(/truncate/);
    expect(text.className).toMatch(/min-w-\[3ch\]/);
    expect(text.className).toMatch(/max-w-\[/);
  });

  it('hides the inline Admin pill on phone for a nav stage (it lives in the drawer there)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    const wrap = screen.getByTestId('topbar-admin-link').parentElement!;
    expect(wrap.className).toMatch(/hidden/);
    expect(wrap.className).toMatch(/sm:inline-flex/);
  });

  it.each(['upload', 'analysing', 'confirm'] as const)(
    'hides the inline Admin pill below sm on the no-nav %s stage (the drawer carries it, #4567)',
    (kind) => {
      renderWithStore(<TopBar {...makeProps({ stage: kind, view: null })} />);
      const wrap = screen.getByTestId('topbar-admin-link').parentElement!;
      expect(wrap.className).toMatch(/\bhidden\b/);
      expect(wrap.className).toMatch(/sm:inline-flex/);
    },
  );

  it.each(['books', 'upload', 'analysing'] as const)(
    'hides the inline Help / Theme / Account below sm on the %s stage (#4567)',
    (kind) => {
      renderWithStore(
        <TopBar
          {...makeProps({ stage: kind, view: kind === 'books' ? makeProps().view : null })}
        />,
      );
      const help = screen.getByTestId('topbar-help').closest('span.hidden');
      const theme = screen.getByTestId('theme-toggle').closest('span.hidden');
      const account = screen.getByRole('button', { name: /^Account/ }).closest('span.hidden');
      for (const wrap of [help, theme, account]) {
        expect(wrap).not.toBeNull();
        expect(wrap!.className).toMatch(/\bhidden\b/);
        expect(wrap!.className).toMatch(/sm:inline-flex/);
      }
    },
  );

  it('surfaces Admin as a phone-only drawer row that fires onOpenAdmin and closes the drawer', () => {
    const onOpenAdmin = vi.fn();
    renderWithStore(<TopBar {...makeProps({ stage: 'books', onOpenAdmin })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const row = screen.getByTestId('nav-drawer-link-admin');
    expect(row.className).toMatch(/sm:hidden/);
    fireEvent.click(row);
    expect(onOpenAdmin).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
  });
});

/* #4567 — the drawer exists on EVERY stage below `sm` so the three controls
   overflow-x-clip hides at the 412px phone viewport (Help, Theme, Account)
   stay reachable from the drawer on upload/analysing/confirm too. jsdom
   cannot evaluate sm:/xl: media, so these assert on classes, testids and
   DOM presence; the geometry itself is #4654's paired e2e at Pixel-7. */
describe('TopBar — #4567 drawer on every stage (phone-only Help/Theme/Account)', () => {
  const PHONE_ROWS = ['help', 'tour', 'screen-tour', 'theme', 'account'] as const;

  it('keeps the trigger xl:hidden on nav stages (ready/books unchanged)', () => {
    const { unmount } = renderWithStore(
      <TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />,
    );
    expect(screen.getByTestId('topbar-nav-toggle').className).toMatch(/xl:hidden/);
    unmount();
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    expect(screen.getByTestId('topbar-nav-toggle').className).toMatch(/xl:hidden/);
  });

  it.each(['analysing', 'confirm'] as const)(
    'opening the drawer on %s shows the five phone rows plus a phone-only Admin row, and no nav rows',
    (kind) => {
      renderWithStore(<TopBar {...makeProps({ stage: kind, view: null })} />);
      fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
      const d = within(screen.getByTestId('topbar-nav-drawer'));
      for (const id of PHONE_ROWS) {
        expect(d.getByTestId(`nav-drawer-link-${id}`)).toBeInTheDocument();
      }
      expect(d.getByTestId('nav-drawer-link-admin').className).toMatch(/sm:hidden/);
      /* no Cast/Books destination rows leak onto a no-nav stage */
      expect(d.queryByTestId('nav-drawer-link-cast')).not.toBeInTheDocument();
      expect(d.queryByTestId('nav-drawer-link-books')).not.toBeInTheDocument();
    },
  );

  it('on ready the drawer shows the nav rows, the Admin row, and the five phone rows', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const d = within(screen.getByTestId('topbar-nav-drawer'));
    expect(d.getByTestId('nav-drawer-link-cast')).toBeInTheDocument();
    expect(d.getByTestId('nav-drawer-link-admin')).toBeInTheDocument();
    for (const id of PHONE_ROWS) {
      expect(d.getByTestId(`nav-drawer-link-${id}`)).toBeInTheDocument();
    }
  });

  it('Help row links to #/help and closes the drawer', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'analysing', view: null })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const row = screen.getByTestId('nav-drawer-link-help');
    expect(row).toHaveAttribute('href', '#/help');
    fireEvent.click(row);
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
  });

  it('Take-the-tour row starts the linear tour and closes the drawer', async () => {
    const { store } = renderWithStore(
      <TopBar {...makeProps({ stage: 'analysing', view: null })} />,
    );
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    fireEvent.click(screen.getByTestId('nav-drawer-link-tour'));
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
    await waitFor(() => expect(store.getState().tour.active).toBe(true), { timeout: 5000 });
  });

  it('Show-me-this-screen row is disabled on a stage screenForStage cannot map (analysing)', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'analysing', view: null })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    expect(screen.getByTestId('nav-drawer-link-screen-tour')).toBeDisabled();
  });

  it('Show-me-this-screen row starts the screen tour when screenForStage resolves (ready)', () => {
    const { store } = renderWithStore(
      <TopBar {...makeProps({ stage: 'ready', view: 'manuscript' })} />,
    );
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const row = screen.getByTestId('nav-drawer-link-screen-tour');
    expect(row).toBeEnabled();
    fireEvent.click(row);
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
    expect(store.getState().tour.active).toBe(true);
    expect(store.getState().tour.tourId).toBe('manuscript');
  });

  it('Theme row cycles ui.themeOverride, keeps the drawer open, and its label tracks the mode', () => {
    const { store } = renderWithStore(
      <TopBar {...makeProps({ stage: 'analysing', view: null })} />,
    );
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const row = screen.getByTestId('nav-drawer-link-theme');
    expect(store.getState().ui.themeOverride).toBeNull();
    fireEvent.click(row);
    /* system → light (same cycle + LABELS as the inline toggle, plan 41) */
    expect(store.getState().ui.themeOverride).toBe('light');
    expect(screen.getByTestId('topbar-nav-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('nav-drawer-link-theme').textContent).toMatch(/light/i);
  });

  it('Theme row shows the short label as text, keeps the full LABELS string as aria-label, and both track a click', () => {
    renderWithStore(<TopBar {...makeProps({ stage: 'analysing', view: null })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    const row = () => screen.getByTestId('nav-drawer-link-theme');
    expect(row().textContent).toBe('Theme: System');
    expect(row()).toHaveAttribute('aria-label', LABELS.system);
    fireEvent.click(row());
    expect(row().textContent).toBe('Theme: Light');
    expect(row()).toHaveAttribute('aria-label', LABELS.light);
  });

  it('Account row fires onOpenAccount, closes the drawer, and is aria-current on the account stage', () => {
    const onOpenAccount = vi.fn();
    const { unmount } = renderWithStore(
      <TopBar {...makeProps({ stage: 'analysing', view: null, onOpenAccount })} />,
    );
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    expect(screen.getByTestId('nav-drawer-link-account')).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByTestId('nav-drawer-link-account'));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('topbar-nav-drawer')).not.toBeInTheDocument();
    unmount();
    renderWithStore(<TopBar {...makeProps({ stage: 'account', view: null })} />);
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    expect(screen.getByTestId('nav-drawer-link-account')).toHaveAttribute('aria-current', 'page');
  });

  it('Account row carries the display name (same labelling as the avatar)', () => {
    renderWithStore(
      <TopBar
        {...makeProps({ stage: 'analysing', view: null, userDisplayName: 'Captain Picard' })}
      />,
    );
    fireEvent.click(screen.getByTestId('topbar-nav-toggle'));
    expect(screen.getByTestId('nav-drawer-link-account').textContent).toMatch(
      /account — captain picard/i,
    );
  });
});

import { __resetForTests } from '../lib/update-notice';

const infoWith = (over: Partial<AppInfo>): AppInfo => ({
  appVersion: '1.8.0',
  sidecarVersion: '1.8.0',
  schemas: {},
  lastSeenAppVersion: null,
  showWhatsNew: false,
  releaseNotes: '',
  ...over,
});

describe('VersionPill update dot (fe-27)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTests();
    appInfoH.info = null;
  });

  it('shows a dot when an undismissed update is available', () => {
    appInfoH.info = infoWith({ updateAvailable: true, latestVersion: '1.9.0' });
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    expect(screen.getByTestId('version-pill-dot')).toBeInTheDocument();
  });

  it('hides the dot when up to date', () => {
    appInfoH.info = infoWith({ updateAvailable: false, latestVersion: null });
    renderWithStore(<TopBar {...makeProps({ stage: 'books' })} />);
    expect(screen.queryByTestId('version-pill-dot')).not.toBeInTheDocument();
  });
});
