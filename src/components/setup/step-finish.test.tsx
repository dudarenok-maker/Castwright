/* StepFinish spec — fs-21 wave 2.
   Verifies the placeholder smoke-test card and the "Finish setup" button. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SetupReadiness } from '../../lib/api';
import { StepFinish } from './step-finish';

function makeReadiness(overrides: Partial<SetupReadiness> = {}): SetupReadiness {
  return {
    ready: true,
    completedAt: null,
    blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
    info: { gpu: 'cuda · 1.2 / 8.0 GB' },
    ...overrides,
  };
}

describe('StepFinish', () => {
  it('renders a "Finish" heading', () => {
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /finish/i })).toBeInTheDocument();
  });

  it('renders the smoke-test placeholder text', () => {
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(
      screen.getByText(/full audible end-to-end smoke test arrives in the next release/i),
    ).toBeInTheDocument();
  });

  it('renders a disabled smoke-test affordance', () => {
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    const smokeBtn = screen.getByTestId('smoke-test-placeholder');
    expect(smokeBtn).toBeDisabled();
  });

  it('renders a "Finish setup" button', () => {
    render(<StepFinish readiness={makeReadiness()} onFinish={vi.fn()} />);
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeInTheDocument();
  });

  it('calls onFinish when "Finish setup" is clicked', () => {
    const onFinish = vi.fn();
    render(<StepFinish readiness={makeReadiness()} onFinish={onFinish} />);
    const btn = screen.getByRole('button', { name: /finish setup/i });
    btn.click();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
