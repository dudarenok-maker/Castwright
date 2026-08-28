/* Advanced settings view — group headers, OverrideRow dispatch, and restart
   banner tests. Mirrors the pattern of model-manager.test.tsx: a lightweight
   configureStore with only the slices the view reads, plus vi.mock for api. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configSlice } from '../store/config-slice';
import { uiSlice } from '../store/ui-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { AdvancedView } from './advanced';
import { api } from '../lib/api';
import type { ConfigResponse, GpuDevicesResponse } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getConfig: vi.fn(),
    putConfig: vi.fn(),
    resetConfig: vi.fn(),
    getPrompt: vi.fn(),
    putPrompt: vi.fn(),
    resetPrompt: vi.fn(),
    restartSidecar: vi.fn(),
    cleanupEnvKnobs: vi.fn(),
    getGpuDevices: vi.fn(),
    getAnalyzerDevice: vi.fn(),
    getAnalyzerGpuSplit: vi.fn(),
  },
}));

const mockGetConfig = vi.mocked(api.getConfig);
const mockPutConfig = vi.mocked(api.putConfig);
const mockResetConfig = vi.mocked(api.resetConfig);
const mockCleanupEnvKnobs = vi.mocked(api.cleanupEnvKnobs);
const mockGetGpuDevices = vi.mocked(api.getGpuDevices);
const mockGetAnalyzerDevice = vi.mocked(api.getAnalyzerDevice);
const mockGetAnalyzerGpuSplit = vi.mocked(api.getAnalyzerGpuSplit);

const FIXTURE_GPU_DEVICES: GpuDevicesResponse = {
  devices: [
    { uuid: 'GPU-0', idx: 0, name: 'RTX 4070 Laptop', total_mb: 8000, free_mb: 6000 },
    { uuid: 'GPU-1', idx: 1, name: 'RTX 5070 Ti', total_mb: 16000, free_mb: 14000 },
  ],
  cpu: true,
};

/* Small fixture: two groups, three knobs — a live number knob, a
   restart-sidecar boolean knob, and a prompt knob. The GROUP shape ('tts'/
   'analyzer-prompts' ids, collapsedByDefault, risk) is fixture-local and
   deliberately does NOT mirror the real registry's tts-engine group (which
   is risk:'high' and therefore starts collapsed, per SettingsSection) — the
   tests below need the section open on render without an extra expand
   step. The two real descriptor KEYS below (tts.qwen.codecChunkSize,
   prompt.castDetection) do carry their real per-key registry metadata
   (apply/risk/default) so a reader can't copy a wrong fact off them; only
   their `group` placement is fixture-local. */
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
      key: 'tts.qwen.codecChunkSize',
      group: 'tts',
      label: 'Qwen codec chunk size',
      help: 'Codec decode chunk size (time-axis frames).',
      type: 'integer',
      min: 1,
      apply: 'restart-sidecar',
      risk: 'high',
      isPrompt: false,
      default: 300,
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
      key: 'prompt.castDetection',
      group: 'analyzer-prompts',
      label: 'Cast detection prompt',
      help: 'Prompt used for per-chapter cast detection.',
      type: 'string',
      apply: 'live',
      risk: 'high',
      isPrompt: true,
      default: 'skills/audiobook-character-detection-per-chapter.md',
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
    'tts.qwen.codecChunkSize': {
      key: 'tts.qwen.codecChunkSize',
      effective: 300,
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
    'prompt.castDetection': {
      key: 'prompt.castDetection',
      effective: 'skills/audiobook-character-detection-per-chapter.md',
      source: 'default',
      locked: false,
      overridden: false,
    },
  },
  restartPending: false,
  cudaEnvShadow: false,
  envCleanupCandidates: [],
};

/* Build a minimal store with config + ui + notifications slices. */
function makeStore() {
  return configureStore({
    reducer: {
      config: configSlice.reducer,
      ui: uiSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
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
    id: 'prompt.castDetection',
    text: 'Detect every speaking character introduced or recurring in this chapter.',
    isForked: false,
    defaultText: 'Detect every speaking character introduced or recurring in this chapter.',
  });
  vi.mocked(api.restartSidecar).mockResolvedValue({ ok: true });
  mockCleanupEnvKnobs.mockResolvedValue({ cleaned: [] });
  mockGetGpuDevices.mockResolvedValue(FIXTURE_GPU_DEVICES);
  mockGetAnalyzerDevice.mockResolvedValue({ device: 'idle' });
  mockGetAnalyzerGpuSplit.mockResolvedValue({
    reachable: true,
    split: false,
    deviceIndices: [0],
    totalUsedMb: 4200,
    wouldFitSingleDevice: false,
    dataUnavailable: false,
  });
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
    expect(await screen.findByText('Qwen codec chunk size')).toBeInTheDocument();
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
      applied: ['tts.qwen.codecChunkSize'],
      values: {
        ...FIXTURE_CONFIG.values,
        'tts.qwen.codecChunkSize': {
          key: 'tts.qwen.codecChunkSize',
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
      expect(mockPutConfig).toHaveBeenCalledWith({ 'tts.qwen.codecChunkSize': 16000 }),
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

  /* #2221 — clicking "Restart sidecar" when the request rejects used to
     clear the spinner (the `finally` block runs regardless of outcome)
     with nothing else on screen to say it failed — the banner reverts to
     the exact same idle "Restart sidecar" state a SUCCESS leaves it in,
     and the failure surfaced only as an unhandled promise rejection in
     the console. Page-level (no single row it's attributable to), so it
     toasts — the same pattern handleResetAll/onResetSection already use. */
  it('pushes an error toast when "Restart sidecar" is rejected, and re-enables the button', async () => {
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
    vi.mocked(api.restartSidecar).mockRejectedValueOnce(
      new Error('Sidecar restart failed (503): sidecar unreachable'),
    );

    const { store } = renderView();
    const restartButton = await screen.findByRole('button', { name: /restart sidecar/i });
    fireEvent.click(restartButton);

    await waitFor(() => expect(store.getState().notifications.toasts).toHaveLength(1));
    expect(store.getState().notifications.toasts[0]).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('sidecar unreachable'),
    });

    // The button must not be left disabled/stuck as if a restart were
    // still in flight — the user can retry.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /restart sidecar/i })).not.toBeDisabled(),
    );
  });

  it('does not push a toast when "Restart sidecar" succeeds', async () => {
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
    vi.mocked(api.restartSidecar).mockResolvedValueOnce({ ok: true });

    const { store } = renderView();
    const restartButton = await screen.findByRole('button', { name: /restart sidecar/i });
    fireEvent.click(restartButton);

    await waitFor(() => expect(api.restartSidecar).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().notifications.toasts).toHaveLength(0);
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

/* CONFIG_WITH_ANALYZER_MODELS_GROUP adds the analyzer-models section (where
   the analyzer device row now renders). Used by analyzer device and GPU-split
   warning tests that need to verify the row/warning render. */
const CONFIG_WITH_ANALYZER_MODELS_GROUP: ConfigResponse = {
  ...CONFIG_WITH_TTS_ENGINE_GROUP,
  groups: [
    ...CONFIG_WITH_TTS_ENGINE_GROUP.groups,
    {
      id: 'analyzer-models',
      label: 'Analyzer models & endpoints',
      help: 'Which model/endpoint runs the analysis.',
      risk: 'medium',
      collapsedByDefault: false,
    },
  ],
};

describe('AdvancedView — analyzer read-only row (Plan 2 §2.4, issue #1225)', () => {
  it('shows the analyzer GPU/CPU/idle/unreachable placement, not editable', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_ANALYZER_MODELS_GROUP);
    mockGetAnalyzerDevice.mockResolvedValue({ device: 'cuda' });

    renderView();
    await screen.findByText(/Analyzer \(Ollama\) device/i);
    expect(screen.getByText(/GPU — not app-pinnable/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /analyzer/i })).not.toBeInTheDocument();
  });

  it('shows "Idle" (not "Unknown") when Ollama has nothing resident', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_ANALYZER_MODELS_GROUP);
    mockGetAnalyzerDevice.mockResolvedValue({ device: 'idle' });

    renderView();
    expect(await screen.findByText(/Idle \(no model currently loaded\)/)).toBeInTheDocument();
  });

  it('shows "Unreachable" when the daemon never answers', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_ANALYZER_MODELS_GROUP);
    mockGetAnalyzerDevice.mockRejectedValue(new Error('network error'));

    renderView();
    expect(await screen.findByText(/Unreachable — not app-pinnable/)).toBeInTheDocument();
  });

  it('links to the documented OS-env path', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_ANALYZER_MODELS_GROUP);
    mockGetAnalyzerDevice.mockResolvedValue({ device: 'cpu' });

    renderView();
    const link = await screen.findByRole('link', { name: /change.*analyzer.*device/i });
    expect(link).toHaveAttribute('href', expect.stringMatching(/local-llm/));
  });

  it('hides the row entirely when the analyzer engine is gemini (§2.4 gate)', async () => {
    mockGetConfig.mockResolvedValue({
      ...CONFIG_WITH_ANALYZER_MODELS_GROUP,
      values: {
        ...CONFIG_WITH_ANALYZER_MODELS_GROUP.values,
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
    await screen.findAllByText('Text-to-speech');
    expect(screen.queryByText(/Analyzer \(Ollama\) device/i)).not.toBeInTheDocument();
  });
});

/* ── Analyzer GPU-split warning (#2367 Task 3) ───────────────────────────── */

describe('AdvancedView — analyzer GPU-split warning (#2367 Task 3)', () => {
  it('renders the warning, including both device indices, when split and avoidable', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_ANALYZER_MODELS_GROUP);
    mockGetAnalyzerGpuSplit.mockResolvedValue({
      reachable: true,
      split: true,
      deviceIndices: [0, 1],
      totalUsedMb: 9000,
      wouldFitSingleDevice: true,
      dataUnavailable: false,
    });

    renderView();
    const warning = await screen.findByText(/Model split across GPUs 0, 1/);
    expect(warning).toBeInTheDocument();
  });

  it('shows no warning when the split genuinely does not fit on one device', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_ANALYZER_MODELS_GROUP);
    mockGetAnalyzerGpuSplit.mockResolvedValue({
      reachable: true,
      split: true,
      deviceIndices: [0, 1],
      totalUsedMb: 20000,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });

    renderView();
    await screen.findByText(/Analyzer \(Ollama\) device/i);
    expect(screen.queryByText(/Model split across GPUs/)).not.toBeInTheDocument();
  });

  it('shows no warning when there is no split', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_ANALYZER_MODELS_GROUP);
    mockGetAnalyzerGpuSplit.mockResolvedValue({
      reachable: true,
      split: false,
      deviceIndices: [0],
      totalUsedMb: 4200,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });

    renderView();
    await screen.findByText(/Analyzer \(Ollama\) device/i);
    expect(screen.queryByText(/Model split across GPUs/)).not.toBeInTheDocument();
  });

  it('hides the whole block, including the split warning, when the analyzer engine is not local', async () => {
    mockGetConfig.mockResolvedValue({
      ...CONFIG_WITH_ANALYZER_MODELS_GROUP,
      values: {
        ...CONFIG_WITH_ANALYZER_MODELS_GROUP.values,
        'analyzer.engine': {
          key: 'analyzer.engine',
          effective: 'gemini',
          source: 'default',
          locked: false,
          overridden: false,
        },
      },
    });
    mockGetAnalyzerGpuSplit.mockResolvedValue({
      reachable: true,
      split: true,
      deviceIndices: [0, 1],
      totalUsedMb: 9000,
      wouldFitSingleDevice: true,
      dataUnavailable: false,
    });

    renderView();
    expect(screen.queryByText(/Analyzer \(Ollama\) device/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Model split across GPUs/)).not.toBeInTheDocument();
  });
});

/* ── Analyzer GPU-split warning: expected-device mismatch (#2367 Task 4) ─── */

/* Adds the expectedDevice knob's descriptor on top of
   CONFIG_WITH_ANALYZER_MODELS_GROUP. The analyzer-models group is already
   included in CONFIG_WITH_ANALYZER_MODELS_GROUP. */
const CONFIG_WITH_EXPECTED_DEVICE_KNOB: ConfigResponse = {
  ...CONFIG_WITH_ANALYZER_MODELS_GROUP,
  descriptors: [
    ...CONFIG_WITH_ANALYZER_MODELS_GROUP.descriptors,
    {
      key: 'analyzer.ollama.expectedDevice',
      group: 'analyzer-models',
      label: 'Expected analyzer GPU',
      help: "Informational only — this app cannot pin an external Ollama daemon's device.",
      type: 'string',
      apply: 'live',
      risk: 'low',
      isPrompt: false,
      default: '',
    },
  ],
};

function withExpectedDevice(effective: string): ConfigResponse {
  return {
    ...CONFIG_WITH_EXPECTED_DEVICE_KNOB,
    values: {
      ...CONFIG_WITH_EXPECTED_DEVICE_KNOB.values,
      'analyzer.ollama.expectedDevice': {
        key: 'analyzer.ollama.expectedDevice',
        effective,
        source: effective ? 'override' : 'default',
        locked: false,
        overridden: Boolean(effective),
      },
    },
  };
}

describe('AdvancedView — analyzer GPU-split warning, expected-device mismatch (#2367 Task 4)', () => {
  it('knob empty + an avoidable split -> Task 3\'s original unqualified warning', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_EXPECTED_DEVICE_KNOB);
    mockGetAnalyzerGpuSplit.mockResolvedValue({
      reachable: true,
      split: true,
      deviceIndices: [0, 1],
      totalUsedMb: 9000,
      wouldFitSingleDevice: true,
      dataUnavailable: false,
    });

    renderView();
    expect(await screen.findByText(/despite fitting on one device/)).toBeInTheDocument();
    expect(screen.queryByText(/expected GPU/)).not.toBeInTheDocument();
  });

  it('knob "0" + deviceIndices [0, 1] (mismatch) -> the sharpened mismatch text, naming both', async () => {
    mockGetConfig.mockResolvedValue(withExpectedDevice('0'));
    mockGetAnalyzerGpuSplit.mockResolvedValue({
      reachable: true,
      split: true,
      deviceIndices: [0, 1],
      totalUsedMb: 20000,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });

    renderView();
    const warning = await screen.findByText(/Model split across GPUs 0, 1/);
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toMatch(/expected GPU 0 only/);
    expect(screen.queryByText(/despite fitting on one device/)).not.toBeInTheDocument();
  });

  it('knob "0" + deviceIndices [0] (no split, matches expectation) -> no warning at all', async () => {
    mockGetConfig.mockResolvedValue(withExpectedDevice('0'));
    mockGetAnalyzerGpuSplit.mockResolvedValue({
      reachable: true,
      split: false,
      deviceIndices: [0],
      totalUsedMb: 4200,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });

    renderView();
    await screen.findByText(/Analyzer \(Ollama\) device/i);
    expect(screen.queryByText(/Model split across GPUs/)).not.toBeInTheDocument();
  });

  it('knob "0" + deviceIndices [1] (no split, wrong single device) -> model on wrong GPU message', async () => {
    mockGetConfig.mockResolvedValue(withExpectedDevice('0'));
    mockGetAnalyzerGpuSplit.mockResolvedValue({
      reachable: true,
      split: false,
      deviceIndices: [1],
      totalUsedMb: 4200,
      wouldFitSingleDevice: false,
      dataUnavailable: false,
    });

    renderView();
    const warning = await screen.findByText(/Analyzer model is on GPU 1/);
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toMatch(/expected GPU 0 only/);
    expect(screen.queryByText(/Model split across GPUs/)).not.toBeInTheDocument();
  });

  it('renders the knob as an editable text row in analyzer-models and round-trips a saved value', async () => {
    mockGetConfig.mockResolvedValue(CONFIG_WITH_EXPECTED_DEVICE_KNOB);
    mockPutConfig.mockResolvedValue({
      ok: true,
      applied: ['analyzer.ollama.expectedDevice'],
      values: {
        ...CONFIG_WITH_EXPECTED_DEVICE_KNOB.values,
        'analyzer.ollama.expectedDevice': {
          key: 'analyzer.ollama.expectedDevice',
          effective: '0',
          source: 'override',
          locked: false,
          overridden: true,
        },
      },
    });

    renderView();
    const input = (await screen.findByRole('textbox', {
      name: 'Expected analyzer GPU',
    })) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(mockPutConfig).toHaveBeenCalledWith({ 'analyzer.ollama.expectedDevice': '0' }),
    );
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

describe('AdvancedView — env-cleanup notice', () => {
  it('renders nothing when envCleanupCandidates is empty', async () => {
    renderView();
    await screen.findAllByText('Text-to-speech');
    expect(screen.queryByRole('button', { name: /clean up/i })).not.toBeInTheDocument();
  });

  it('shows the notice with a count when envCleanupCandidates is non-empty', async () => {
    mockGetConfig.mockResolvedValue({
      ...FIXTURE_CONFIG,
      envCleanupCandidates: ['OLD_KNOB_A', 'OLD_KNOB_B'],
    });

    renderView();
    expect(await screen.findByText(/2 settings look like leftover defaults/i)).toBeInTheDocument();
  });

  it('calls the cleanup API and drops the notice once the refetch reports it resolved', async () => {
    mockGetConfig.mockResolvedValueOnce({
      ...FIXTURE_CONFIG,
      envCleanupCandidates: ['OLD_KNOB_A'],
    });
    mockGetConfig.mockResolvedValueOnce({
      ...FIXTURE_CONFIG,
      envCleanupCandidates: [],
    });

    renderView();
    const cleanupButton = await screen.findByRole('button', { name: /clean up/i });
    fireEvent.click(cleanupButton);

    await waitFor(() => expect(api.cleanupEnvKnobs).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /clean up/i })).not.toBeInTheDocument(),
    );
  });

  it('pushes an error toast when cleanup is rejected', async () => {
    mockGetConfig.mockResolvedValue({
      ...FIXTURE_CONFIG,
      envCleanupCandidates: ['OLD_KNOB_A'],
    });
    mockCleanupEnvKnobs.mockRejectedValueOnce(
      new Error('Config env-cleanup failed (500): {"error":"disk write failed"}'),
    );

    const { store } = renderView();
    const cleanupButton = await screen.findByRole('button', { name: /clean up/i });
    fireEvent.click(cleanupButton);

    await waitFor(() =>
      expect(store.getState().notifications.toasts).toContainEqual(
        expect.objectContaining({
          kind: 'error',
          message: expect.stringContaining('disk write failed'),
        }),
      ),
    );
    await waitFor(() => expect(cleanupButton).not.toBeDisabled());
  });
});

/* ── Unattributable-failure toast (#2209) ─────────────────────────────────
   "Reset all" and "Reset section" span every knob in their scope — there's
   no single row to show the rejection inline next to, so these route
   through the notifications slice instead (the "both" decision's toast
   half). Asserted against store state directly: AdvancedView doesn't
   render <ToastStack/> itself (that's mounted once at app-shell level in
   layout.tsx), so the notifications slice's own state is the seam this
   view's own test can observe. */
describe('AdvancedView — unattributable-failure toast (#2209)', () => {
  it('pushes an error toast with the server message when "Reset all" is rejected', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    // #2209 review B1 — api.resetConfig throws "Config reset failed", not
    // "Config update failed"; the original fixture here hand-wrote the
    // wrong verb and only "passed" because the (buggy) parser it was
    // exercising didn't check the verb either.
    mockResetConfig.mockRejectedValueOnce(
      new Error('Config reset failed (400): {"error":"reset blocked: bad combo"}'),
    );

    const { store } = renderView();
    await screen.findAllByText('Text-to-speech');

    fireEvent.click(screen.getByRole('button', { name: /^reset all$/i }));

    await waitFor(() => expect(store.getState().notifications.toasts).toHaveLength(1));
    expect(store.getState().notifications.toasts[0]).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('reset blocked: bad combo'),
    });

    confirmSpy.mockRestore();
  });

  it('does not push a toast when "Reset all" succeeds', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockResetConfig.mockResolvedValueOnce({ ok: true, values: FIXTURE_CONFIG.values });

    const { store } = renderView();
    await screen.findAllByText('Text-to-speech');

    fireEvent.click(screen.getByRole('button', { name: /^reset all$/i }));

    await waitFor(() => expect(mockResetConfig).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().notifications.toasts).toHaveLength(0);

    confirmSpy.mockRestore();
  });

  it('does not push a toast for a row-level (inline) save rejection — the two paths stay disjoint', async () => {
    mockPutConfig.mockRejectedValueOnce(
      new Error('Config update failed (400): {"error":"bad value"}'),
    );

    const { store } = renderView();
    const input = (await screen.findByRole('spinbutton')) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '16000' } });
    fireEvent.blur(input);

    await waitFor(() => expect(mockPutConfig).toHaveBeenCalled());
    // Give the rejection's row-level .catch a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.getState().notifications.toasts).toHaveLength(0);
  });

  /* #2209 review "also fix" — onResetSection's whole body was untested:
     replacing it with a plain `dispatch(resetGroup(group.id))` (no
     .unwrap().catch(...)) passed 21/21 before this test existed. */
  it('pushes an error toast with the server message when "Reset section" is rejected', async () => {
    mockGetConfig.mockResolvedValue({
      ...FIXTURE_CONFIG,
      values: {
        ...FIXTURE_CONFIG.values,
        'tts.qwen.codecChunkSize': {
          key: 'tts.qwen.codecChunkSize',
          effective: 16000,
          source: 'override',
          locked: false,
          overridden: true,
        },
      },
    });
    mockResetConfig.mockRejectedValueOnce(
      new Error('Config reset failed (400): {"error":"section reset blocked: bad combo"}'),
    );

    const { store } = renderView();
    const resetSectionButton = await screen.findByRole('button', { name: /reset section/i });
    fireEvent.click(resetSectionButton);

    await waitFor(() => expect(store.getState().notifications.toasts).toHaveLength(1));
    expect(store.getState().notifications.toasts[0]).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('section reset blocked: bad combo'),
    });
  });
});

/* ── Revert seam: advanced.tsx → OverrideRow (#2209 review B3) ────────────
   Every unit test elsewhere in this file (and in override-row.test.tsx)
   stubs onRevert directly — none of them exercise the actual
   `dispatch(resetKnob(d.key)).unwrap()` wiring in advanced.tsx itself.
   Dropping `.unwrap()` there left 70 tests passing and `tsc` green (B3) —
   this is the seam that closes that gap: it renders the REAL AdvancedView,
   clicks a REAL Revert button, and asserts the REAL per-row error region
   the click produces. */
describe('AdvancedView — Revert seam, advanced.tsx → OverrideRow (#2209 review B3)', () => {
  it('surfaces a rejected Revert inline, driven through the real dispatch(resetKnob(...)).unwrap() wiring', async () => {
    mockGetConfig.mockResolvedValue({
      ...FIXTURE_CONFIG,
      values: {
        ...FIXTURE_CONFIG.values,
        'tts.qwen.codecChunkSize': {
          key: 'tts.qwen.codecChunkSize',
          effective: 16000,
          source: 'override',
          locked: false,
          overridden: true,
        },
      },
    });
    mockResetConfig.mockRejectedValueOnce(
      new Error('Config reset failed (400): {"error":"reset blocked: bad combo"}'),
    );

    renderView();
    const revertButton = await screen.findByRole('button', { name: /^revert$/i });
    fireEvent.click(revertButton);

    expect(
      await screen.findByTestId('knob-save-error-tts.qwen.codecChunkSize'),
    ).toHaveTextContent('reset blocked: bad combo');
  });
});
