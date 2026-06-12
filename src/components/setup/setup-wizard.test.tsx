/* fs-21 wave 2 — C5: SetupWizard orchestrator tests.
   The 5 step components are stubbed (lightweight divs with testids) so this
   suite tests ORCHESTRATION — step paging, Back/Next, progress, mode split —
   not the steps themselves. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SetupReadiness } from '../../lib/api';

// ── stub the 5 step components ────────────────────────────────────────────────

vi.mock('./step-environment', () => ({
  StepEnvironment: () => <div data-testid="step-environment-stub">env</div>,
}));
vi.mock('./step-ffmpeg', () => ({
  StepFfmpeg: () => <div data-testid="step-ffmpeg-stub">ffmpeg</div>,
}));
vi.mock('./step-models', () => ({
  StepModels: () => <div data-testid="step-models-stub">models</div>,
}));
vi.mock('./step-defaults', () => ({
  StepDefaults: () => <div data-testid="step-defaults-stub">defaults</div>,
}));
vi.mock('./step-finish', () => ({
  StepFinish: ({ onFinish }: { onFinish: () => void }) => (
    <div data-testid="step-finish-stub">
      <button type="button" onClick={onFinish}>
        Finish setup
      </button>
    </div>
  ),
}));

import { SetupWizard } from './setup-wizard';

const READINESS: SetupReadiness = {
  ready: false,
  completedAt: null,
  blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'fail', analyzer: 'fail' },
  info: { gpu: 'CPU — no GPU detected' },
};

const STEP_TESTIDS = [
  'step-environment-stub',
  'step-ffmpeg-stub',
  'step-models-stub',
  'step-defaults-stub',
  'step-finish-stub',
];

describe('SetupWizard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the "Set up Castwright" heading in guided mode', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /set up castwright/i }),
    ).toBeInTheDocument();
  });

  it('shows the "Set up Castwright" heading in checklist mode', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(
      screen.getByRole('heading', { name: /set up castwright/i }),
    ).toBeInTheDocument();
  });

  it('guided mode renders ONE step at a time, starting on the first', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.getByTestId('step-environment-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('step-ffmpeg-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-finish-stub')).not.toBeInTheDocument();
  });

  it('guided mode shows a "Step N of 5" progress indicator', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.getByText(/step 1 of 5/i)).toBeInTheDocument();
  });

  it('guided mode: Next is always enabled (no blocker gating) and advances', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    const next = screen.getByRole('button', { name: /next/i });
    // even with failing blockers, Next is NOT disabled
    expect(next).not.toBeDisabled();
    fireEvent.click(next);
    expect(screen.getByTestId('step-ffmpeg-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('step-environment-stub')).not.toBeInTheDocument();
    expect(screen.getByText(/step 2 of 5/i)).toBeInTheDocument();
  });

  it('guided mode: Back returns to the previous step', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByTestId('step-ffmpeg-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByTestId('step-environment-stub')).toBeInTheDocument();
    expect(screen.getByText(/step 1 of 5/i)).toBeInTheDocument();
  });

  it('guided mode: Back is disabled on the first step', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
  });

  it('guided mode: the Finish step renders on the last step (no Next there)', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    // advance through all 4 transitions to the last (finish) step
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
    }
    expect(screen.getByTestId('step-finish-stub')).toBeInTheDocument();
    expect(screen.getByText(/step 5 of 5/i)).toBeInTheDocument();
    // Finish lives inside StepFinish; the wizard's own Next is gone
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });

  it('guided mode: the finish step button calls onFinish', () => {
    const onFinish = vi.fn();
    render(
      <SetupWizard
        readiness={READINESS}
        mode="guided"
        onRefetch={() => {}}
        onFinish={onFinish}
      />,
    );
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
    }
    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('checklist mode renders all 5 steps stacked, with no Back/Next', () => {
    render(
      <SetupWizard
        readiness={READINESS}
        mode="checklist"
        onRefetch={() => {}}
        onFinish={() => {}}
      />,
    );
    for (const id of STEP_TESTIDS) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument();
  });
});
