/* StatusPopover — the hover/tap-revealed panel behind the top-bar Status pill.
   Presentational (the StatusPill owns the open-state machine). These tests pin
   the four sections, their empty fallbacks, the reused AnalysisPill/
   GenerationPill routing, and — critically — that an in-panel click does NOT
   reach a document-level dismiss listener (the guard that keeps the cast
   drawer open). */

import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusPopover } from './status-popover';
import type { AnalysisPillData, GenerationPillData } from './top-bar';

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
    pendingRevisionsCount: 2,
    onOpenRevisions: vi.fn(),
    onGoToAnalysing: vi.fn(),
    onGoToGeneration: vi.fn(),
    onGoToDesign: vi.fn(),
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
    expect(screen.getByText(/Voice engine controls appear once a manuscript is open/)).toBeInTheDocument();
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
});
