/* StepEnvironment spec — fs-21 wave 2.
   Asserts the step renders the DevicePanel region and surfaces the
   readiness.info.gpu string passed in via props. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/* Stub useAppInfo so DevicePanel renders without a Redux store. */
vi.mock('../../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: null, error: null, refresh: vi.fn() }),
}));

import { StepEnvironment } from './step-environment';
import type { SetupReadiness } from '../../lib/api';

function makeReadiness(overrides: Partial<SetupReadiness> = {}): SetupReadiness {
  return {
    ready: true,
    completedAt: null,
    blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
    info: { gpu: 'cuda · 1.2 / 8.0 GB reserved' },
    ...overrides,
  };
}

describe('StepEnvironment', () => {
  it('renders an Environment heading', () => {
    render(<StepEnvironment readiness={makeReadiness()} onRefetch={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /environment/i })).toBeInTheDocument();
  });

  it('renders the gpu string from readiness.info.gpu', () => {
    const readiness = makeReadiness({ info: { gpu: 'Apple GPU (Metal)' } });
    render(<StepEnvironment readiness={readiness} onRefetch={vi.fn()} />);
    expect(screen.getByText(/Apple GPU \(Metal\)/)).toBeInTheDocument();
  });

  it('renders a Re-check button that calls onRefetch', () => {
    const onRefetch = vi.fn();
    render(<StepEnvironment readiness={makeReadiness()} onRefetch={onRefetch} />);
    const btn = screen.getByRole('button', { name: /re-check/i });
    btn.click();
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });

  it('renders the DevicePanel sentinel text', () => {
    render(<StepEnvironment readiness={makeReadiness()} onRefetch={vi.fn()} />);
    /* DevicePanel always renders its "Will it run on my machine?" heading. */
    expect(screen.getByText(/will it run on my machine/i)).toBeInTheDocument();
  });
});
