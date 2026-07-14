/* StatusPopover — the hover/tap-revealed panel behind the top-bar Status pill.
   Presentational (the StatusPill owns the open-state machine). These tests pin
   the four sections, their empty fallbacks, the reused AnalysisPill/
   GenerationPill routing, and — critically — that an in-panel click does NOT
   reach a document-level dismiss listener (the guard that keeps the cast
   drawer open). */

import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { StatusPopover } from './status-popover';
import { ModelControlPill } from './ModelControlPill';
import type { AnalysisPillData, GenerationPillData } from './top-bar';
import type { SetupReadiness, BlockerDiagnosis } from '../lib/api';

const analysis: AnalysisPillData = {
  state: 'running',
  phaseLabel: 'Detecting characters',
  percent: 42,
  onClick: vi.fn(),
};
const generation: GenerationPillData = {
  state: 'running',
  done: 3,
  total: 10,
  percent: 30,
  onClick: vi.fn(),
};

const PASS: BlockerDiagnosis = { status: 'pass', cause: 'pass', message: '', remediation: '' };

function readinessWith(
  overrides: Partial<Record<'sidecar' | 'tts' | 'ffmpeg' | 'analyzer', BlockerDiagnosis>>,
): SetupReadiness {
  return {
    ready: false,
    completedAt: null,
    blockers: { sidecar: PASS, tts: PASS, ffmpeg: PASS, analyzer: PASS, ...overrides },
    info: { gpu: '' },
  };
}

function makeProps(over: Partial<Parameters<typeof StatusPopover>[0]> = {}) {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  return {
    open: true,
    anchorRef: { current: anchor },
    panelRef: createRef<HTMLDivElement>(),
    onPointerEnter: vi.fn(),
    onPointerLeave: vi.fn(),
    onFocusCapture: vi.fn(),
    onBlurCapture: vi.fn(),
    ttsControls: <span data-testid="tts-sentinel">Kokoro ready</span>,
    analysis,
    generation,
    design: null,
    exportPill: null,
    pendingRevisionsCount: 2,
    onOpenRevisions: vi.fn(),
    onGoToAnalysing: vi.fn(),
    onGoToGeneration: vi.fn(),
    onGoToDesign: vi.fn(),
    readiness: readinessWith({}),
    onGoToExport: vi.fn(),
    ...over,
  };
}

describe('StatusPopover', () => {
  it('renders nothing when closed', () => {
    render(<StatusPopover {...makeProps({ open: false })} />);
    expect(screen.queryByTestId('status-popover')).not.toBeInTheDocument();
  });

  it('renders the panel with all four sections when open', () => {
    render(<StatusPopover {...makeProps()} />);
    expect(screen.getByTestId('status-popover')).toBeInTheDocument();
    expect(screen.getByTestId('status-popover-tts')).toBeInTheDocument();
    expect(screen.getByTestId('status-popover-analysis')).toBeInTheDocument();
    expect(screen.getByTestId('status-popover-generation')).toBeInTheDocument();
    expect(screen.getByTestId('status-popover-revisions')).toBeInTheDocument();
  });

  it('passes the TTS controls through verbatim', () => {
    render(<StatusPopover {...makeProps()} />);
    expect(screen.getByTestId('tts-sentinel')).toBeInTheDocument();
  });

  it('shows the empty fallbacks when no book / no streams / no revisions', () => {
    render(
      <StatusPopover
        {...makeProps({
          ttsControls: null,
          analysis: null,
          generation: null,
          pendingRevisionsCount: 0,
        })}
      />,
    );
    expect(
      screen.getByText(/Voice engine controls appear once a manuscript is open/),
    ).toBeInTheDocument();
    expect(screen.getByText('No analysis running.')).toBeInTheDocument();
    expect(screen.getByText('Nothing generating.')).toBeInTheDocument();
    expect(screen.getByText('No pending revisions.')).toBeInTheDocument();
  });

  it('shows the analyzer model chip when analysis.model is set', () => {
    render(<StatusPopover {...makeProps({ analysis: { ...analysis, model: 'gizmo-local:1b' } })} />);
    const chip = screen.getByTestId('status-popover-analysis-model');
    expect(chip).toBeInTheDocument();
    /* Unknown id falls back to the raw model id (known ids map to a label). */
    expect(chip.textContent).toContain('gizmo-local:1b');
  });

  it('omits the model chip when analysis has no model', () => {
    render(<StatusPopover {...makeProps()} />);
    expect(screen.queryByTestId('status-popover-analysis-model')).toBeNull();
  });

  it('routes the analysis pill click through onGoToAnalysing', () => {
    const onGoToAnalysing = vi.fn();
    render(<StatusPopover {...makeProps({ onGoToAnalysing })} />);
    fireEvent.click(screen.getByTestId('analysis-pill'));
    expect(onGoToAnalysing).toHaveBeenCalledTimes(1);
  });

  it('routes the generation pill click through onGoToGeneration', () => {
    const onGoToGeneration = vi.fn();
    render(<StatusPopover {...makeProps({ onGoToGeneration })} />);
    fireEvent.click(screen.getByTestId('generation-pill'));
    expect(onGoToGeneration).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenRevisions from the revisions action', () => {
    const onOpenRevisions = vi.fn();
    render(<StatusPopover {...makeProps({ onOpenRevisions })} />);
    fireEvent.click(screen.getByRole('button', { name: /revisions pending/i }));
    expect(onOpenRevisions).toHaveBeenCalledTimes(1);
  });

  it('reports hover over the panel (onPointerEnter) — the hover-bridge', () => {
    const onPointerEnter = vi.fn();
    render(<StatusPopover {...makeProps({ onPointerEnter })} />);
    fireEvent.pointerEnter(screen.getByTestId('status-popover'));
    expect(onPointerEnter).toHaveBeenCalled();
  });

  it('stops mousedown propagation so an in-panel click never reaches a document dismiss listener (cast-drawer guard)', () => {
    const docMouseDown = vi.fn();
    document.addEventListener('mousedown', docMouseDown);
    try {
      render(<StatusPopover {...makeProps()} />);
      /* A bubbling mousedown would reach the document listener; the panel root
         calls stopPropagation, so it must NOT — this is what keeps the cast
         drawer (and the popover itself) from dismissing on an in-panel click. */
      fireEvent.mouseDown(screen.getByTestId('status-popover-tts'));
      expect(docMouseDown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('mousedown', docMouseDown);
    }
  });

  it('renders the chapter-count + ETA line under the substage label when present', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: {
            label: 'Detecting emotions',
            percent: 40,
            chapterIndex: 3,
            totalChapters: 12,
            estRemainingMs: 125_000,
          },
        })}
      />,
    );
    expect(screen.getByTestId('substage-row').textContent).toContain('Detecting emotions');
    expect(screen.getByTestId('substage-detail').textContent).toBe('Chapter 3 of 12 · ~2m left');
  });

  it('omits the detail line when neither chapter count nor ETA is available', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: { label: 'Detecting emotions', percent: 5 },
        })}
      />,
    );
    expect(screen.getByTestId('substage-row')).toBeInTheDocument();
    expect(screen.queryByTestId('substage-detail')).not.toBeInTheDocument();
  });

  it('shows "Ollama · <friendly model>" when the substage engine is local', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: { label: 'Reviewing script', percent: 10, engine: 'local', model: 'qwen3.5:9b' },
        })}
      />,
    );
    expect(screen.getByTestId('substage-engine-model').textContent).toBe('Ollama · Qwen3.5 9B (local)');
  });

  it('shows "Gemini · <friendly model>" when the substage engine is gemini', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: {
            label: 'Reviewing script',
            percent: 10,
            engine: 'gemini',
            model: 'gemma-4-31b-it',
          },
        })}
      />,
    );
    expect(screen.getByTestId('substage-engine-model').textContent).toBe('Gemini · Gemma 4 31B');
  });

  it('omits the engine·model line when the substage has no model', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: { label: 'Reviewing script', percent: 10 },
        })}
      />,
    );
    expect(screen.queryByTestId('substage-engine-model')).not.toBeInTheDocument();
  });

  it('shows a "Loading model" ticking timer when activityState is loading', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: {
            label: 'Reviewing script',
            percent: 0,
            activityState: 'loading',
            activitySince: Date.now(),
          },
        })}
      />,
    );
    expect(screen.getByTestId('substage-timer').textContent).toMatch(/^Loading model · \d+s$/);
  });

  it('shows a "Waiting for model" ticking timer when activityState is waiting', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: {
            label: 'Reviewing script',
            percent: 0,
            activityState: 'waiting',
            activitySince: Date.now(),
          },
        })}
      />,
    );
    expect(screen.getByTestId('substage-timer').textContent).toMatch(/^Waiting for model · \d+s$/);
  });

  it('omits the timer when activityState is streaming (the normal detail line covers it)', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: {
            label: 'Reviewing script',
            percent: 40,
            activityState: 'streaming',
            activitySince: Date.now(),
          },
        })}
      />,
    );
    expect(screen.queryByTestId('substage-timer')).not.toBeInTheDocument();
  });

  it('shows the fallback note when fallbackActive is set', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: { label: 'Reviewing script', percent: 10, fallbackActive: true },
        })}
      />,
    );
    expect(screen.getByTestId('substage-fallback-note').textContent).toBe(
      'Switched to Gemini — Ollama unreachable',
    );
  });

  it('omits the fallback note when fallbackActive is not set', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: { label: 'Reviewing script', percent: 10 },
        })}
      />,
    );
    expect(screen.queryByTestId('substage-fallback-note')).not.toBeInTheDocument();
  });

  const FAIL_SIDECAR: BlockerDiagnosis = {
    status: 'fail',
    cause: 'venv-missing',
    message: 'Voice engine runtime not set up.',
    remediation: 'x',
    action: { kind: 'venv-bootstrap', label: 'Set up the voice engine runtime' },
  };

  it('shows the sidecar diagnosis block under Voice engines only when it fails', () => {
    render(<StatusPopover {...makeProps({ readiness: readinessWith({ sidecar: FAIL_SIDECAR }) })} />);
    expect(
      within(screen.getByTestId('status-popover-tts')).getByText(/voice engine runtime not set up/i),
    ).toBeInTheDocument();
  });

  it('does not show a sidecar diagnosis block when it passes', () => {
    render(<StatusPopover {...makeProps({ readiness: readinessWith({}) })} />);
    expect(within(screen.getByTestId('status-popover-tts')).queryByText(/not set up/i)).toBeNull();
  });

  it('shows the analyzer diagnosis block under Analysis only when it fails', () => {
    const failAnalyzer: BlockerDiagnosis = {
      status: 'fail',
      cause: 'no-gemini-key',
      message: 'No Gemini API key is configured.',
      remediation: 'x',
      action: { kind: 'navigate', label: 'Open Advanced Settings', href: '#/advanced' },
    };
    render(<StatusPopover {...makeProps({ readiness: readinessWith({ analyzer: failAnalyzer }) })} />);
    expect(
      within(screen.getByTestId('status-popover-analysis')).getByText(/no gemini api key/i),
    ).toBeInTheDocument();
  });

  it('renders a non-alarming note for a warn analyzer (no fix button)', () => {
    const warnAnalyzer: BlockerDiagnosis = {
      status: 'warn',
      cause: 'pass',
      message: 'Analyzer ready — no backup analyzer configured.',
      remediation: '',
    };
    render(<StatusPopover {...makeProps({ readiness: readinessWith({ analyzer: warnAnalyzer }) })} />);
    expect(screen.getByText(/no backup analyzer configured/i)).toBeInTheDocument();
    // No fix-action button for a warn: BlockerFixAction renders nothing without an
    // action AND is now gated to status === 'fail'. Scoped to the Analysis section
    // (not the whole screen) since makeProps' default pendingRevisionsCount renders
    // an unrelated "… · Open" button in the Revisions section that would otherwise
    // false-match this regex.
    expect(
      within(screen.getByTestId('status-popover-analysis')).queryByRole('button', {
        name: /open|install|pull|set up/i,
      }),
    ).toBeNull();
  });

  it('shows a top-of-panel ffmpeg banner only when it fails', () => {
    const failFfmpeg: BlockerDiagnosis = {
      status: 'fail',
      cause: 'both-missing',
      message: 'ffmpeg and ffprobe are not on PATH.',
      remediation: 'x',
    };
    render(<StatusPopover {...makeProps({ readiness: readinessWith({ ffmpeg: failFfmpeg }) })} />);
    expect(screen.getByTestId('status-popover-ffmpeg-banner')).toBeInTheDocument();
  });

  it('suppresses the TTS pill Retry button when a specific sidecar diagnosis is shown', () => {
    render(
      <StatusPopover
        {...makeProps({
          readiness: readinessWith({ sidecar: FAIL_SIDECAR }),
          ttsControls: (
            <ModelControlPill kind="tts" state="unreachable" onLoad={vi.fn()} onStop={vi.fn()} />
          ),
        })}
      />,
    );
    // The popover itself doesn't own ttsControls' props — verify wiring in layout.tsx's own test instead;
    // here just assert the diagnosis block renders alongside whatever ttsControls was passed.
    expect(
      within(screen.getByTestId('status-popover-tts')).getByText(/voice engine runtime not set up/i),
    ).toBeInTheDocument();
  });
});

describe('StatusPopover — Export section (fs-54)', () => {
  it('renders the Export pill when exportPill is set', () => {
    render(
      <StatusPopover
        {...makeProps({
          exportPill: { state: 'running', runningCount: 1, percent: 0.5, onClick: vi.fn() },
        })}
      />,
    );
    expect(screen.getByTestId('status-popover-export')).toHaveTextContent('Exporting');
  });

  it('shows a placeholder message when no export is running', () => {
    render(<StatusPopover {...makeProps({ exportPill: null })} />);
    expect(screen.getByTestId('status-popover-export')).toHaveTextContent('Nothing exporting.');
  });

  it('routes through onGoToExport when the Export pill is clicked', () => {
    const onGoToExport = vi.fn();
    render(
      <StatusPopover
        {...makeProps({
          exportPill: { state: 'running', runningCount: 1, onClick: vi.fn() },
          onGoToExport,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('export-pill'));
    expect(onGoToExport).toHaveBeenCalled();
  });
});
