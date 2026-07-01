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
    getConfig: vi.fn(),
    putConfig: vi.fn(),
    resetConfig: vi.fn(),
    getPrompt: vi.fn(),
    putPrompt: vi.fn(),
    resetPrompt: vi.fn(),
    restartSidecar: vi.fn(),
    getGpuDevices: vi.fn(),
  },
}));

const mockGetConfig = vi.mocked(api.getConfig);
const mockPutConfig = vi.mocked(api.putConfig);
const mockGetGpuDevices = vi.mocked(api.getGpuDevices);

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
    fireEvent.change(input, { target: { value: '16000' } });

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
    expect(optionValues).toEqual(['auto', 'cpu', 'cuda:0', 'cuda:1']);
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
