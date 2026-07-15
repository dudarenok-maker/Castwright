/* StepVoice — one models-status fetch feeds the runtime badge/liveness pill AND
   the controlled install cards. Regression cases (fe-49 / wizard-models-status):
   the card wording matches the badge, a transient 'starting' shows a neutral pill
   (not amber), and a broken engine surfaces on its own card while the aggregate
   stays green. The cards are rendered for real (they're controlled — no fetch);
   only api.getModelsStatus is stubbed.

   fe-51: StepVoice now reads/dispatches the account slice (Task 5), so a redux
   Provider is mandatory for every render — see renderStepVoice below. The
   module mock + store-preload pattern is copied verbatim from
   step-defaults.test.tsx (importActual so getModelsStatus stays real for the
   per-test spies; only putUserSettings is stubbed to echo the patch). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';
import type { SetupReadiness, ModelsStatus } from '../../lib/api';

const putUserSettingsMock = vi.fn();
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      putUserSettings: (patch: unknown) => {
        putUserSettingsMock(patch);
        return Promise.resolve({
          ...accountSlice.getInitialState(),
          ...(patch as Record<string, unknown>),
        });
      },
    },
  };
});

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
    recommendation: {
      expressiveOrMultilingual: {
        engine: 'qwen',
        modelKey: 'qwen3-tts-0.6b',
        reason: 'Expressive and multilingual — the multi-cast default.',
        // keep in sync with server CAVEAT_VRAM (server/src/tts/engine-recommendation.ts)
        caveat:
          "May not fit this GPU's memory — you can run Qwen on CPU (slower) via the voice-engine device setting, or pick Kokoro below for fast English-only voices.",
        alternate: 'coqui',
      },
      simpleEnglish: {
        engine: 'kokoro',
        modelKey: 'kokoro-v1',
        reason: 'Fast and light — runs comfortably on low VRAM or CPU.',
        caveat: null,
        alternate: null,
      },
    },
    ...overrides,
  };
}

function renderStepVoice(
  opts: {
    readiness?: SetupReadiness;
    account?: Partial<ReturnType<typeof accountSlice.getInitialState>>;
  } = {},
) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        ...opts.account,
      } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
  const utils = render(
    <Provider store={store}>
      <StepVoice readiness={opts.readiness ?? allPassReadiness} onRefetch={() => {}} />
    </Provider>,
  );
  return { ...utils, store };
}

beforeEach(() => {
  vi.restoreAllMocks();
  putUserSettingsMock.mockReset();
});

describe('StepVoice', () => {
  it('renders the voice-engine controls once models-status resolves', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(modelsStatus());
    renderStepVoice();
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
    renderStepVoice();
    expect(await screen.findByText(/voice weights not downloaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/Kokoro is not installed/i)).not.toBeInTheDocument();
  });

  it('starting: runtime shows a neutral pill, not an amber blocker, over the installed card', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(
      modelsStatus({ runtime: { installedOnDisk: true, pythonFound: true, process: 'starting' } }),
    );
    renderStepVoice();
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
    renderStepVoice();
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
    renderStepVoice({ readiness });
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
    renderStepVoice({ readiness });
    await screen.findByTestId('runtime-liveness-pill');
    expect(screen.queryByTestId('runtime-fix-action')).not.toBeInTheDocument();
  });

  it('shows the guided question and, once answered "yes", leads with the recommended engine', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(modelsStatus());
    renderStepVoice(); // mock getModelsStatus returns the Task-3 recommendation (qwen lead, CPU caveat)
    expect(await screen.findByText(/expressive and\/or multilingual/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /yes — expressive/i }));

    const badge = await screen.findByText(/recommended for you/i);
    // The recommended (Qwen) card leads: the badge sits on the qwen card wrapper.
    expect(badge.closest('[data-engine-card="qwen"]')).not.toBeNull();
    // CPU-only mock → Qwen caveat shown, neutral (sky) not an amber blocker.
    expect(screen.getByTestId('recommendation-caveat')).toHaveTextContent(/may not fit/i);
  });

  it('answering "no" recommends Kokoro', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(modelsStatus());
    renderStepVoice();
    await userEvent.click(await screen.findByRole('radio', { name: /no — simple english/i }));
    const badge = await screen.findByText(/recommended for you/i);
    expect(badge.closest('[data-engine-card="kokoro"]')).not.toBeNull();
  });

  it('seeds defaultTtsModelKey when the recommendation is answered', async () => {
    vi.spyOn(api, 'getModelsStatus').mockResolvedValue(modelsStatus()); // qwen-lead recommendation
    const { store } = renderStepVoice();
    await userEvent.click(await screen.findByRole('radio', { name: /yes — expressive/i }));
    await waitFor(() => {
      expect(putUserSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({ defaultTtsModelKey: 'qwen3-tts-0.6b', defaultTtsModelKeyExplicit: true, defaultTtsEngine: 'local' }),
      );
      expect(store.getState().account.defaultTtsModelKey).toBe('qwen3-tts-0.6b');
    });
  });
});
