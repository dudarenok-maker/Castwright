/* StepVoice — one models-status fetch feeds the runtime badge/liveness pill AND
   the controlled install cards. Regression cases (fe-49 / wizard-models-status):
   the card wording matches the badge, a transient 'starting' shows a neutral pill
   (not amber), and a broken engine surfaces on its own card while the aggregate
   stays green. The cards are rendered for real (they're controlled — no fetch);
   only api.getModelsStatus is stubbed. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SetupReadiness, ModelsStatus } from '../../lib/api';
import { api } from '../../lib/api';
import { StepVoice } from './step-voice';

const allPassReadiness: SetupReadiness = {
  ready: true,
  completedAt: null,
  blockers: {
    sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
  },
  info: { gpu: '' },
};

function modelsStatus(overrides: Partial<ModelsStatus> = {}): ModelsStatus {
  return {
    runtime: { installedOnDisk: true, pythonFound: true, process: 'ready' },
    engines: {
      kokoro: { state: 'ready', packageBroken: false },
      qwen: { state: 'not-installed', packageBroken: false },
      coqui: { state: 'not-installed', packageBroken: false },
    },
    info: { gpu: 'CPU — no GPU detected', vramTotalMb: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('StepVoice', () => {
  it('renders the voice-engine controls once models-status resolves', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(modelsStatus());
    render(<StepVoice readiness={allPassReadiness} onRefetch={() => {}} />);
    expect(await screen.findByText(/voice engine runtime ready/i)).toBeInTheDocument();
    expect(screen.getByText(/more voice engines/i)).toBeInTheDocument();
    expect(screen.getByText(/Kokoro is installed/i)).toBeInTheDocument();
  });

  it('weights-missing: card wording matches the badge (no "not installed")', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(
      modelsStatus({
        engines: {
          kokoro: { state: 'weights-missing', packageBroken: false },
          qwen: { state: 'not-installed', packageBroken: false },
          coqui: { state: 'not-installed', packageBroken: false },
        },
      }),
    );
    render(<StepVoice readiness={allPassReadiness} onRefetch={() => {}} />);
    expect(await screen.findByText(/voice weights not downloaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/Kokoro is not installed/i)).not.toBeInTheDocument();
  });

  it('starting: runtime shows a neutral pill, not an amber blocker, over the installed card', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(
      modelsStatus({ runtime: { installedOnDisk: true, pythonFound: true, process: 'starting' } }),
    );
    render(<StepVoice readiness={allPassReadiness} onRefetch={() => {}} />);
    const pill = await screen.findByTestId('runtime-liveness-pill');
    expect(pill).toHaveAttribute('data-tone', 'neutral');
    expect(pill).toHaveTextContent(/starting/i);
    // The disk badge is GREEN "Runtime installed", never amber "Runtime needed".
    const diskBadge = screen.getByTestId('runtime-disk-badge');
    expect(diskBadge).toHaveAttribute('data-blocker-status', 'pass');
    expect(diskBadge).toHaveTextContent(/runtime installed/i);
  });

  it('broken coqui shows on its own card while the summary stays green (kokoro usable)', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(
      modelsStatus({
        engines: {
          kokoro: { state: 'ready', packageBroken: false },
          qwen: { state: 'not-installed', packageBroken: false },
          coqui: { state: 'ready', packageBroken: true },
        },
      }),
    );
    render(<StepVoice readiness={allPassReadiness} onRefetch={() => {}} />);
    // Coqui's own card surfaces the broken/repair state…
    expect(await screen.findByText(/Coqui XTTS v2 is installed but fails to load/i)).toBeInTheDocument();
    // …while the aggregate "Voice" badge stays green (readiness.tts pass).
    expect(screen.getByText(/^Voice ready$/i)).toBeInTheDocument();
  });

  it('renders the runtime guided fix when installed on disk but the sidecar is blocked (e.g. crashed)', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(
      modelsStatus({ runtime: { installedOnDisk: true, pythonFound: true, process: 'crashed' } }),
    );
    const readiness: SetupReadiness = {
      ...allPassReadiness,
      ready: false,
      blockers: {
        ...allPassReadiness.blockers,
        sidecar: {
          status: 'fail',
          cause: 'supervisor-exhausted',
          message: 'The voice engine crashed repeatedly and stopped trying to restart.',
          remediation: 'Reset and restart the voice engine.',
          action: { kind: 'sidecar-restart', label: 'Reset & restart voice engine' },
        },
      },
    };
    render(<StepVoice readiness={readiness} onRefetch={() => {}} />);
    expect(await screen.findByTestId('runtime-fix-action')).toBeInTheDocument();
    expect(screen.getByText(/crashed repeatedly/i)).toBeInTheDocument();
  });

  it('suppresses the runtime fix-action for a transient starting sidecar (neutral pill instead)', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(
      modelsStatus({ runtime: { installedOnDisk: true, pythonFound: true, process: 'starting' } }),
    );
    const readiness: SetupReadiness = {
      ...allPassReadiness,
      ready: false,
      blockers: {
        ...allPassReadiness.blockers,
        sidecar: {
          status: 'fail',
          cause: 'unreachable-transient',
          message: 'The voice engine is starting up.',
          remediation: 'This usually resolves within a few seconds.',
        },
      },
    };
    render(<StepVoice readiness={readiness} onRefetch={() => {}} />);
    await screen.findByTestId('runtime-liveness-pill');
    expect(screen.queryByTestId('runtime-fix-action')).not.toBeInTheDocument();
  });
});
