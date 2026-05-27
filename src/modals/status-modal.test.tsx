/* Plan 120 — Status modal. Presentational (no redux): Layout wires the
   ttsControls node + the navigate-then-close handlers. These tests pin the
   four sections, their empty fallbacks, and that the reused AnalysisPill /
   GenerationPill route through the navigate-and-close handlers. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusModal } from './status-modal';
import type { AnalysisPillData, GenerationPillData } from '../components/top-bar';

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

function makeProps(over: Partial<Parameters<typeof StatusModal>[0]> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    ttsControls: <span data-testid="tts-sentinel">Kokoro ready</span>,
    analysis,
    generation,
    pendingRevisionsCount: 2,
    onOpenRevisions: vi.fn(),
    onGoToAnalysing: vi.fn(),
    onGoToGeneration: vi.fn(),
    ...over,
  };
}

describe('StatusModal', () => {
  it('renders nothing when closed', () => {
    render(<StatusModal {...makeProps({ open: false })} />);
    expect(screen.queryByRole('dialog', { name: 'Status' })).not.toBeInTheDocument();
  });

  it('renders the dialog with all four sections when open', () => {
    render(<StatusModal {...makeProps()} />);
    expect(screen.getByRole('dialog', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByTestId('status-modal-tts')).toBeInTheDocument();
    expect(screen.getByTestId('status-modal-analysis')).toBeInTheDocument();
    expect(screen.getByTestId('status-modal-generation')).toBeInTheDocument();
    expect(screen.getByTestId('status-modal-revisions')).toBeInTheDocument();
  });

  it('passes the TTS controls through verbatim', () => {
    render(<StatusModal {...makeProps()} />);
    expect(screen.getByTestId('tts-sentinel')).toBeInTheDocument();
  });

  it('shows the empty fallbacks when no book / no streams / no revisions', () => {
    render(
      <StatusModal
        {...makeProps({
          ttsControls: null,
          analysis: null,
          generation: null,
          pendingRevisionsCount: 0,
        })}
      />,
    );
    expect(screen.getByText(/TTS controls appear once a manuscript is open/)).toBeInTheDocument();
    expect(screen.getByText('No analysis running.')).toBeInTheDocument();
    expect(screen.getByText('Nothing generating.')).toBeInTheDocument();
    expect(screen.getByText('No pending revisions.')).toBeInTheDocument();
  });

  it('routes the analysis pill click through onGoToAnalysing (navigate + close)', () => {
    const onGoToAnalysing = vi.fn();
    render(<StatusModal {...makeProps({ onGoToAnalysing })} />);
    fireEvent.click(screen.getByTestId('analysis-pill'));
    expect(onGoToAnalysing).toHaveBeenCalledTimes(1);
  });

  it('routes the generation pill click through onGoToGeneration (navigate + close)', () => {
    const onGoToGeneration = vi.fn();
    render(<StatusModal {...makeProps({ onGoToGeneration })} />);
    fireEvent.click(screen.getByTestId('generation-pill'));
    expect(onGoToGeneration).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenRevisions from the revisions action', () => {
    const onOpenRevisions = vi.fn();
    render(<StatusModal {...makeProps({ onOpenRevisions })} />);
    fireEvent.click(screen.getByRole('button', { name: /revisions pending/i }));
    expect(onOpenRevisions).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click and on the close button', () => {
    const onClose = vi.fn();
    render(<StatusModal {...makeProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('status-modal-backdrop'));
    fireEvent.click(screen.getByRole('button', { name: 'Close status' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
