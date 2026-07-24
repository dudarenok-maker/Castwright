/* Advanced settings view — group headers, OverrideRow dispatch, and restart
   banner tests. Mirrors the pattern of model-manager.test.tsx: a lightweight
   configureStore with only the slices the view reads, plus vi.mock for api. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configSlice } from '../store/config-slice';
import { uiSlice } from '../store/ui-slice';
import { AdvancedView } from './advanced';
import { api } from '../lib/api';
import type { ConfigResponse, GpuDevicesResponse } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    /* fs-38 Wave 1, Task 14 — `src/store/index.ts` now dispatches
       `fetchConfig()` once at store-module-import time (boot hydrate for
       the `voices.library.enabled` gate). Because `vi.mock` factories are
       hoisted above every import — including the transitive `../store`
       import `AdvancedView` pulls in below — that boot call reaches this
       mock before any of this file's own `beforeEach`/`mockResolvedValueOnce`
       setup has run. A bare `vi.fn()` would resolve `undefined` for that
       stray call and crash `fetchConfig.fulfilled`'s reducer
       (config-slice.ts) with an unhandled rejection. Giving the mock a
       harmless default implementation here covers it; every test below
       still layers its own `mockResolvedValueOnce`/`mockResolvedValue` on
       top for its own mount-triggered fetch. */
    getConfig: vi.fn(() =>
      Promise.resolve({ groups: [], descriptors: [], values: {}, cudaEnvShadow: false }),
    ),
    putConfig: vi.fn(),
    resetConfig: vi.fn(),
    getPrompt: vi.fn(),
    putPrompt: vi.fn(),
    resetPrompt: vi.fn(),
    restartSidecar: vi.fn(),
    getGpuDevices: vi.fn(),
    getAnalyzerDevice: vi.fn(),
  },
}));

const mockGetConfig = vi.mocked(api.getConfig);
const mockPutConfig = vi.mocked(api.putConfig);
const mockGetGpuDevices = vi.mocked(api.getGpuDevices);
const mockGetAnalyzerDevice = vi.mocked(api.getAnalyzerDevice);

const FIXTURE_GPU_DEVICES: GpuDevicesResponse = {
  devices: [
    { uuid: 'GPU-0', idx: 0, name: 'RTX 4070 Laptop', total_mb: 8000, free_mb: 6000 },
    { uuid: 'GPU-1', idx: 1, name: 'RTX 5070 Ti', total_mb: 16000, free_mb: 14000 },
  ],
  cpu: true,
};

/* Small fixture: two groups, three knobs — a live number knob, a
   restart-sidecar boolean knob, and a prompt knob. */
const FIXTURE_CONFIG: ConfigResponse = {
  groups: [
    {
      id: 'tts',
      label: 'Text-to-speech',
      help: 'TTS settings.',
      risk: 'low',
      collapsedByDefault: false,
    },
    {
      id: 'analyzer-prompts',
      label: 'Analyzer prompts',
      help: 'Prompt templates.',
      risk: 'medium',
      collapsedByDefault: true,
    },
  ],
  descriptors: [
    {
      key: 'KOKORO_SAMPLE_RATE',
      group: 'tts',
      label: 'Kokoro sample rate',
      help: 'PCM output sample rate in Hz.',
      type: 'integer',
      min: 8000,
      max: 48000,
      step: 1000,
      apply: 'live',
      risk: 'low',
      isPrompt: false,
      default: 24000,
    },
    {
      key: 'SEG_ASR_ENABLED',
      group: 'tts',
      label: 'ASR content QA',
      help: 'Enable ASR-based QA.',
      type: 'boolean',
      apply: 'restart-sidecar',
      risk: 'medium',
      isPrompt: false,
      default: false,
    },
    {
      key: 'ANALYZER_STAGE1_PROMPT',
      group: 'analyzer-prompts',
      label: 'Stage 1 prompt',
      help: 'Prompt used for stage-1 analysis.',
      type: 'string',
      apply: 'live',
      risk: 'medium',
      isPrompt: true,
      default: 'Attribute each sentence to its speaker.',
    },
    {
      key: 'QWEN_DEVICE',
      group: 'tts',
      label: 'Qwen device',
      help: 'Pin Qwen to a specific GPU.',
      type: 'device',
      apply: 'restart-sidecar',
      risk: 'high',
      isPrompt: false,
      default: 'auto',
    },
  ],
  values: {
    KOKORO_SAMPLE_RATE: {
      key: 'KOKORO_SAMPLE_RATE',
      effective: 24000,
      source: 'default',
      locked: false,
      overridden: false,
    },
    SEG_ASR_ENABLED: {
      key: 'SEG_ASR_ENABLED',
      effective: false,
      source: 'default',
      locked: false,
      overridden: false,
    },
    ANALYZER_STAGE1_PROMPT: {
      key: 'ANALYZER_STAGE1_PROMPT',
      effective: 'Attribute each sentence to its speaker.',
      source: 'default',
      locked: false,
      overridden: false,
    },
  },
  restartPending: false,
  cudaEnvShadow: false,
};

/* Build a minimal store with config + ui slices. */
function makeStore() {
  return configureStore({
    reducer: { config: configSlice.reducer, ui: uiSlice.reducer },
  });
}

function renderView() {
  const store = makeStore();
  return {
    store,
    ...render(
      <Provider store={store}>
        <AdvancedView />
      </Provider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue(FIXTURE_CONFIG);
  vi.mocked(api.getPrompt).mockResolvedValue({
    id: 'ANALYZER_STAGE1_PROMPT',
    text: 'Attribute each sentence to its speaker.',
    isForked: false,
    defaultText: 'Attribute each sentence to its speaker.',
  });
  vi.mocked(api.restartSidecar).mockResolvedValue({ ok: true });
  mockGetGpuDevices.mockResolvedValue(FIXTURE_GPU_DEVICES);
  mockGetAnalyzerDevice.mockResolvedValue({ device: 'idle' });
});

/* ── Group headers ────────────────────────────────────────────────────────── */

describe('AdvancedView — group headers', () => {
  it('renders the group section headings after fetchConfig hydrates', async () => {
    renderView();
    /* findAllByText — nav rail + section header both carry the label text;
       at least one must be in the DOM. */
    expect((await screen.findAllByText('Text-to-speech')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Analyzer prompts').length).toBeGreaterThan(0);
  });

  it('renders a knob label inside the tts section', async () => {
    renderView();
    /* The section is open by default (collapsedByDefault: false for tts) */
    expect(await screen.findByText('Kokoro sample rate')).toBeInTheDocument();
  });

  it('shows the heading and subtitle', async () => {
    renderView();
    /* Heading region is rendered before hydration too — just the subtitle
       may differ; but "Advanced" appears in the MixedHeading markup */
    expect(await screen.findByText(/Advanced/)).toBeInTheDocument();
  });
});

/* ── OverrideRow dispatch ─────────────────────────────────────────────────── */

describe('AdvancedView — OverrideRow dispatch', () => {
  it('dispatches saveOverride with the right key+value when a number input changes', async () => {
    mockPutConfig.mockResolvedValue({
      ok: true,
      applied: ['KOKORO_SAMPLE_RATE'],
      values: {
        ...FIXTURE_CONFIG.values,
        KOKORO_SAMPLE_RATE: {
          key: 'KOKORO_SAMPLE_RATE',
          effective: 16000,
          source: 'override',
          locked: false,
          overridden: true,
        },
      },
    });

    renderView();
    const input = (await screen.findByRole('spinbutton')) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '16000' } });
    expect(mockPutConfig).not.toHaveBeenCalled();
    fireEvent.blur(input);

    // Regression: right after blur, the PUT is in flight but hasn't
    // resolved yet (config.status is 'saving', values still hold the
    // pre-edit default) — the field must keep showing what was just typed,
    // not snap back to the old value for the duration of the round-trip.
    expect(input.value).toBe('16000');

    await waitFor(() =>
      expect(mockPutConfig).toHaveBeenCalledWith({ KOKORO_SAMPLE_RATE: 16000 }),
    );
  });
});

/* ── Device-knob picker ───────────────────────────────────────────────────── */

/* The mobile "Jump to section" nav is also a <select role="combobox">, so the
   device-knob select must be picked out by elimination. */
function getDeviceSelect(): HTMLSelectElement {
  const combobox = screen
    .getAllByRole('combobox')
    .find((el) => el.getAttribute('aria-label') !== 'Jump to section');
  if (!combobox) throw new Error('device knob <select> not found');
  return combobox as HTMLSelectElement;
}

describe('AdvancedView — device-knob picker', () => {
  it('renders the Qwen device knob as a select populated from getGpuDevices', async () => {
    renderView();
    await screen.findByText('Qwen device');
    const select = getDeviceSelect();
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) =>
      o.getAttribute('value'),
    );
    expect(optionValues).toEqual(['auto', 'cpu', 'mps', 'cuda:0', 'cuda:1']);
    expect(screen.getByText(/RTX 5070 Ti/)).toBeInTheDocument();
  });

  it('dispatches saveOverride with the selected cuda:N value', async () => {
    mockPutConfig.mockResolvedValue({
      ok: true,
      applied: ['QWEN_DEVICE'],
      values: {
        ...FIXTURE_CONFIG.values,
        QWEN_DEVICE: {
          key: 'QWEN_DEVICE',
          effective: 'cuda:1',
          source: 'override',
          locked: false,
          overridden: true,
        },
      },
    });
    renderView();
    await screen.findByText('Qwen device');
    const select = getDeviceSelect();
    fireEvent.change(select, { target: { value: 'cuda:1' } });

    await waitFor(() => expect(mockPutConfig).toHaveBeenCalledWith({ QWEN_DEVICE: 'cuda:1' }));
  });
});

/* ── Per-row staleReason derivation (Task 13, Plan 2 §2.2) ───────────────── */

describe('AdvancedView — per-row staleReason derivation', () => {
  it('shows the cpu_fallback badge on the Qwen device row when its engine resident entry reports cpu_fallback', async () => {
    mockGetConfig.mockResolvedValue({
      ...FIXTURE_CONFIG,
      descriptors: [
        ...FIXTURE_CONFIG.descriptors,
        {
          key: 'tts.qwen.device',
          group: 'tts',
          label: 'Qwen device (real key)',
          help: 'Pin Qwen to a specific GPU.',
          type: 'device',
          apply: 'restart-sidecar',
          risk: 'high',
          isPrompt: false,
          default: 'auto',
        },
      ],
    });
    mockGetGpuDevices.mockResolvedValue({
      devices: [
        {
          uuid: 'GPU-0',
          idx: 0,
          name: 'RTX 4070 Laptop',
          total_mb: 8000,
          free_mb: 6000,
          resident: [{ engine: 'qwen', actual_card: 0, stale_reason: 'cpu_fallback' }],
        },
      ],
      cpu: true,
    });

    renderView();
    await screen.findByText('Qwen device (real key)');

    expect(screen.getByTestId('stale-reason-badge')).toHaveTextContent('fell back to CPU');
  });
});

/* ── Restart banner ───────────────────────────────────────────────────────── */

describe('AdvancedView — restart banner', () => {
  it('shows the restart banner when a restart-sidecar knob is overridden', async () => {
    /* Override the getConfig mock so the mount fetch returns an overridden
       restart-sidecar knob — the selector fires as soon as hydration lands. */
    mockGetConfig.mockResolvedValue({
      ...FIXTURE_CONFIG,
      values: {
        ...FIXTURE_CONFIG.values,
        SEG_ASR_ENABLED: {
          key: 'SEG_ASR_ENABLED',
          effective: true,
          source: 'override',
          locked: false,
          overridden: true,
        },
      },
    });

    renderView();

    expect(
      await screen.findByText(/Voice-engine setting changed/i),
    ).toBeInTheDocument();
  });

  it('does NOT show the restart banner when no restart-sidecar knob is overridden', async () => {
    renderView();
    /* Wait for hydration — findAllByText because nav rail also has the label. */
    await screen.findAllByText('Text-to-speech');
    expect(screen.queryByText(/Voice-engine setting changed/i)).not.toBeInTheDocument();
  });
});

/* ── Back-to-Admin breadcrumb ─────────────────────────────────────────────── */

describe('AdvancedView — back-to-Admin breadcrumb', () => {
  it('renders the back-to-Admin button', async () => {
    renderView();
    const btn = screen.getByTestId('advanced-back-to-admin');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('← Admin');
  });

  it('dispatches openAdmin when the back button is clicked', async () => {
    const { store } = renderView();
    const btn = screen.getByTestId('advanced-back-to-admin');
    fireEvent.click(btn);
    expect(store.getState().ui.stage).toMatchObject({ kind: 'admin' });
  });
});

/* ── Analyzer read-only device row (Plan 2 §2.4) ─────────────────────────── */

/* The `analyzer.engine` knob (server group 'analyzer-models') is deliberately
   left OUT of `descriptors` here — only its live `values` entry is fixtured.
   Adding it to `descriptors` would render a second, genuinely-editable
   "Analyzer engine" <select>, which would collide with the
   `queryByRole('combobox', { name: /analyzer/i })` assertion below (that
   query is meant to prove THIS row — the read-only one — renders no
   combobox at all). */
const CONFIG_WITH_TTS_ENGINE_GROUP: ConfigResponse = {
  ...FIXTURE_CONFIG,
  groups: [
    ...FIXTURE_CONFIG.groups,
    {
      id: 'tts-engine',
      label: 'Voice engine & device',
      help: 'Voice engine device, language, and preload behaviour.',
      risk: 'high',
      collapsedByDefault: false,
    },
  ],
  values: {
    ...FIXTURE_CONFIG.values,
    'analyzer.engine': {
      key: 'analyzer.engine',
      effective: 'local',
      source: 'default',
      locked: false,
      overridden: false,
    },
  },
};

/* 'tts-engine' is risk:'high' (matches the real registry group), so
   SettingsSection starts it collapsed regardless of collapsedByDefault —
   the row only mounts once the section is expanded. Mirrors how a real
   user would reach the "Voice engine & device" section. */
async function openVoiceEngineSection(): Promise<void> {
  /* Both the nav rail and the section header render a "Voice engine &
     device"-named button; only the section header carries aria-expanded. */
  const toggles = await screen.findAllByRole('button', { name: /Voice engine & device/ });
  const toggle = toggles.find((el) => el.hasAttribute('aria-expanded'));
  if (!toggle) throw new Error('Voice engine & device section toggle not found');
  fireEvent.click(toggle);
}

describe('AdvancedView — analyzer read-only row (Plan 2 §2.4, issue #1225)', () => {
  it('shows the analyzer GPU/CPU/idle/unreachable placement, not editable', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_TTS_ENGINE_GROUP);
    mockGetAnalyzerDevice.mockResolvedValue({ device: 'cuda' });

    renderView();
    await openVoiceEngineSection();
    await screen.findByText(/Analyzer \(Ollama\) device/i);
    expect(screen.getByText(/GPU — not app-pinnable/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /analyzer/i })).not.toBeInTheDocument();
  });

  it('shows "Idle" (not "Unknown") when Ollama has nothing resident', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_TTS_ENGINE_GROUP);
    mockGetAnalyzerDevice.mockResolvedValue({ device: 'idle' });

    renderView();
    await openVoiceEngineSection();
    expect(await screen.findByText(/Idle \(no model currently loaded\)/)).toBeInTheDocument();
  });

  it('shows "Unreachable" when the daemon never answers', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_TTS_ENGINE_GROUP);
    mockGetAnalyzerDevice.mockRejectedValue(new Error('network error'));

    renderView();
    await openVoiceEngineSection();
    expect(await screen.findByText(/Unreachable — not app-pinnable/)).toBeInTheDocument();
  });

  it('links to the documented OS-env path', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_TTS_ENGINE_GROUP);
    mockGetAnalyzerDevice.mockResolvedValue({ device: 'cpu' });

    renderView();
    await openVoiceEngineSection();
    const link = await screen.findByRole('link', { name: /change.*analyzer.*device/i });
    expect(link).toHaveAttribute('href', expect.stringMatching(/local-llm/));
  });

  it('hides the row entirely when the analyzer engine is gemini (§2.4 gate)', async () => {
    mockGetConfig.mockResolvedValue({
      ...CONFIG_WITH_TTS_ENGINE_GROUP,
      values: {
        ...CONFIG_WITH_TTS_ENGINE_GROUP.values,
        'analyzer.engine': {
          key: 'analyzer.engine',
          effective: 'gemini',
          source: 'default',
          locked: false,
          overridden: false,
        },
      },
    });
    mockGetAnalyzerDevice.mockResolvedValue({ device: 'cuda' });

    renderView();
    await openVoiceEngineSection();
    expect(screen.queryByText(/Analyzer \(Ollama\) device/i)).not.toBeInTheDocument();
  });
});

describe('AdvancedView — CUDA env-shadow banner (Plan 2 §2.5)', () => {
  it('shows a banner when cudaEnvShadow is true', async () => {
    mockGetConfig.mockResolvedValue({ ...FIXTURE_CONFIG, cudaEnvShadow: true });

    renderView();
    await screen.findByText(/CUDA_VISIBLE_DEVICES/i);
  });

  it('shows no banner when cudaEnvShadow is false', async () => {
    mockGetConfig.mockResolvedValue({ ...FIXTURE_CONFIG, cudaEnvShadow: false });

    renderView();
    /* Wait for hydration (findAllByText — nav rail + section header both
       carry the label text; matches the "group headers" describe block's
       convention above). */
    await screen.findAllByText('Text-to-speech');
    expect(screen.queryByText(/CUDA_VISIBLE_DEVICES/i)).not.toBeInTheDocument();
  });
});
