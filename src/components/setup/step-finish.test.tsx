/* StepFinish spec — fs-21 wave 3.
   Verifies the two-tier smoke test UI and the "Finish setup" button. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SetupReadiness, SmokeTestResult } from '../../lib/api';
import { StepFinish } from './step-finish';

// ── api mock ─────────────────────────────────────────────────────────────────

vi.mock('../../lib/api', () => ({
  api: {
    runSmokeTest: vi.fn(),
  },
}));

// Import after mock so the component sees the stub.
import { api } from '../../lib/api';
const mockRunSmokeTest = vi.mocked(api.runSmokeTest);

// ── helpers ───────────────────────────────────────────────────────────────────

function makeReadiness(overrides: Partial<SetupReadiness> = {}): SetupReadiness {
  return {
    ready: true,
    completedAt: null,
    blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
    info: { gpu: 'cuda · 1.2 / 8.0 GB' },
    ...overrides,
  };
}

function okResult(overrides: Partial<SmokeTestResult> = {}): SmokeTestResult {
  return { ok: true, url: 'http://localhost/smoke.wav', analyzerDetail: 'gemma-4-31b-it', ...overrides };
}

function failResult(overrides: Partial<SmokeTestResult> = {}): SmokeTestResult {
  return { ok: false, stage: 'tts', error: 'sidecar unreachable', ...overrides };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('StepFinish', () => {
  beforeEach(() => {
    mockRunSmokeTest.mockReset();
  });

  it('renders a "Finish" heading', () => {
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /finish/i })).toBeInTheDocument();
  });

  it('renders an ENABLED "Run smoke test" button (not the placeholder disabled state)', () => {
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    const smokeBtn = screen.getByTestId('smoke-test-placeholder');
    expect(smokeBtn).not.toBeDisabled();
  });

  it('does NOT render the old "next release" placeholder copy', () => {
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(
      screen.queryByText(/arrives in the next release/i),
    ).not.toBeInTheDocument();
  });

  it('renders a "Finish setup" button', () => {
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeInTheDocument();
  });

  it('calls onFinish when "Finish setup" is clicked', () => {
    const onFinish = vi.fn();
    render(<StepFinish readiness={makeReadiness()} onFinish={onFinish} />);
    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('clicking "Run smoke test" calls api.runSmokeTest', async () => {
    mockRunSmokeTest.mockResolvedValue(okResult());
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    fireEvent.click(screen.getByTestId('smoke-test-placeholder'));
    await waitFor(() => expect(mockRunSmokeTest).toHaveBeenCalledTimes(1));
  });

  it('shows an <audio> element and analyzer detail on ok result', async () => {
    mockRunSmokeTest.mockResolvedValue(okResult());
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    fireEvent.click(screen.getByTestId('smoke-test-placeholder'));
    await waitFor(() =>
      expect(screen.getByTestId('smoke-audio')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('smoke-audio')).toHaveAttribute('src', 'http://localhost/smoke.wav');
    expect(screen.getByText(/gemma-4-31b-it/i)).toBeInTheDocument();
  });

  it('shows the error and stage on a failed result', async () => {
    mockRunSmokeTest.mockResolvedValue(failResult());
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    fireEvent.click(screen.getByTestId('smoke-test-placeholder'));
    await waitFor(() =>
      expect(screen.getByText(/smoke test failed at tts/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/sidecar unreachable/i)).toBeInTheDocument();
  });

  it('does NOT render "Hear the demo book" button when onTryDemoBook is absent', () => {
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /hear the demo book/i })).not.toBeInTheDocument();
  });

  it('renders "Hear the demo book" button when onTryDemoBook is provided and calls it on click', () => {
    const onTryDemoBook = vi.fn();
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} onTryDemoBook={onTryDemoBook} />);
    const btn = screen.getByRole('button', { name: /hear the demo book/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onTryDemoBook).toHaveBeenCalledTimes(1);
  });
});
