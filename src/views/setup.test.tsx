import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SetupView } from './setup';

/* The step components pull in the store / sidecar-install surfaces; stub them
   so this thin-wrapper test only asserts SetupView routes to the wizard. */
vi.mock('../components/setup/step-environment', () => ({
  StepEnvironment: () => <div data-testid="step-environment-stub">env</div>,
}));
vi.mock('../components/setup/step-ffmpeg', () => ({
  StepFfmpeg: () => <div data-testid="step-ffmpeg-stub">ffmpeg</div>,
}));
vi.mock('../components/setup/step-models', () => ({
  StepModels: () => <div data-testid="step-models-stub">models</div>,
}));
vi.mock('../components/setup/step-defaults', () => ({
  StepDefaults: () => <div data-testid="step-defaults-stub">defaults</div>,
}));
vi.mock('../components/setup/step-finish', () => ({
  StepFinish: () => <div data-testid="step-finish-stub">finish</div>,
}));

const READINESS = {
  ready: false,
  completedAt: null,
  blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'fail', analyzer: 'fail' },
  info: { gpu: 'CPU — no GPU detected' },
} as const;

describe('SetupView', () => {
  it('renders the wizard heading and (default guided) first step from props', () => {
    render(<SetupView readiness={READINESS} />);
    expect(screen.getByRole('heading', { name: /set up castwright/i })).toBeInTheDocument();
    // default mode is guided → the first step is shown
    expect(screen.getByTestId('step-environment-stub')).toBeInTheDocument();
  });

  it('renders a Checking… state while readiness is null', () => {
    render(<SetupView readiness={null} />);
    expect(screen.getByTestId('setup-checking')).toBeInTheDocument();
  });
});
