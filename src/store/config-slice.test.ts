/* config-slice.test.ts — covers fetchConfig hydration, saveOverride
   round-trip, and the selectRestartPending selector. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import {
  configSlice,
  fetchConfig,
  saveOverride,
  resetKnob,
  selectRestartPending,
  selectRestartServerPending,
} from './config-slice';
import type { ConfigGroup, KnobDescriptor, ConfigValues } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getConfig: vi.fn(),
    putConfig: vi.fn(),
    resetConfig: vi.fn(),
    putPrompt: vi.fn(),
    resetPrompt: vi.fn(),
    restartSidecar: vi.fn(),
  },
}));

import { api } from '../lib/api';

/* ── fixtures ───────────────────────────────────────────────────────────── */

const MOCK_GROUPS: ConfigGroup[] = [
  { id: 'tts', label: 'Text-to-speech', help: 'TTS settings.', risk: 'low', collapsedByDefault: false },
];

const MOCK_DESCRIPTORS: KnobDescriptor[] = [
  {
    key: 'KOKORO_SAMPLE_RATE',
    group: 'tts',
    label: 'Sample rate',
    help: 'Hz.',
    type: 'integer',
    min: 8000,
    max: 48000,
    step: 1000,
    apply: 'restart-sidecar',
    risk: 'low',
    isPrompt: false,
    default: 24000,
  },
  {
    key: 'SEG_ASR_ENABLED',
    group: 'tts',
    label: 'ASR QA',
    help: 'Enable ASR.',
    type: 'boolean',
    apply: 'live',
    risk: 'low',
    isPrompt: false,
    default: false,
  },
  {
    key: 'SERVER_PORT',
    group: 'server',
    label: 'Port',
    help: 'HTTP port.',
    type: 'integer',
    min: 1024,
    max: 65535,
    step: 1,
    apply: 'restart-server',
    risk: 'high',
    isPrompt: false,
    default: 8080,
  },
];

const MOCK_VALUES: ConfigValues = {
  KOKORO_SAMPLE_RATE: { key: 'KOKORO_SAMPLE_RATE', effective: 24000, source: 'default', locked: false, overridden: false },
  SEG_ASR_ENABLED: { key: 'SEG_ASR_ENABLED', effective: false, source: 'default', locked: false, overridden: false },
  SERVER_PORT: { key: 'SERVER_PORT', effective: 8080, source: 'default', locked: false, overridden: false },
};

const MOCK_CONFIG_RESPONSE = {
  groups: MOCK_GROUPS,
  descriptors: MOCK_DESCRIPTORS,
  values: MOCK_VALUES,
  restartPending: false,
};

/* ── helpers ────────────────────────────────────────────────────────────── */

function makeStore() {
  return configureStore({ reducer: { config: configSlice.reducer } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ── fetchConfig ────────────────────────────────────────────────────────── */

describe('fetchConfig', () => {
  it('hydrates groups, descriptors, and values; sets hydrated:true', async () => {
    vi.mocked(api.getConfig).mockResolvedValue(MOCK_CONFIG_RESPONSE);
    const store = makeStore();

    const promise = store.dispatch(fetchConfig());
    expect(store.getState().config.status).toBe('loading');

    await promise;
    const s = store.getState().config;
    expect(s.status).toBe('idle');
    expect(s.hydrated).toBe(true);
    expect(s.groups).toEqual(MOCK_GROUPS);
    expect(s.descriptors).toEqual(MOCK_DESCRIPTORS);
    expect(s.values).toEqual(MOCK_VALUES);
    expect(s.error).toBeNull();
  });

  it('sets status:error and captures the message on rejection', async () => {
    vi.mocked(api.getConfig).mockRejectedValue(new Error('network error'));
    const store = makeStore();

    await store.dispatch(fetchConfig());
    const s = store.getState().config;
    expect(s.status).toBe('error');
    expect(s.error).toBe('network error');
    expect(s.hydrated).toBe(false);
  });
});

/* ── saveOverride ────────────────────────────────────────────────────────── */

describe('saveOverride', () => {
  it('calls api.putConfig with the key/value pair and re-hydrates values', async () => {
    const updatedValues: ConfigValues = {
      ...MOCK_VALUES,
      KOKORO_SAMPLE_RATE: { key: 'KOKORO_SAMPLE_RATE', effective: 16000, source: 'override', locked: false, overridden: true },
    };
    vi.mocked(api.putConfig).mockResolvedValue({ ok: true, applied: ['KOKORO_SAMPLE_RATE'], values: updatedValues });

    const store = makeStore();
    const promise = store.dispatch(saveOverride({ key: 'KOKORO_SAMPLE_RATE', value: 16000 }));
    expect(store.getState().config.status).toBe('saving');

    await promise;
    expect(api.putConfig).toHaveBeenCalledWith({ KOKORO_SAMPLE_RATE: 16000 });
    const s = store.getState().config;
    expect(s.status).toBe('idle');
    expect(s.values.KOKORO_SAMPLE_RATE.effective).toBe(16000);
    expect(s.values.KOKORO_SAMPLE_RATE.overridden).toBe(true);
  });

  it('sets status:error on rejection', async () => {
    vi.mocked(api.putConfig).mockRejectedValue(new Error('save failed'));
    const store = makeStore();

    await store.dispatch(saveOverride({ key: 'KOKORO_SAMPLE_RATE', value: 16000 }));
    expect(store.getState().config.status).toBe('error');
    expect(store.getState().config.error).toBe('save failed');
  });
});

/* ── resetKnob ──────────────────────────────────────────────────────────── */

describe('resetKnob', () => {
  it('calls api.resetConfig with the key and re-hydrates values', async () => {
    const resetValues: ConfigValues = {
      ...MOCK_VALUES,
      KOKORO_SAMPLE_RATE: { key: 'KOKORO_SAMPLE_RATE', effective: 24000, source: 'default', locked: false, overridden: false },
    };
    vi.mocked(api.resetConfig).mockResolvedValue({ ok: true, values: resetValues });

    const store = makeStore();
    await store.dispatch(resetKnob('KOKORO_SAMPLE_RATE'));
    expect(api.resetConfig).toHaveBeenCalledWith({ keys: ['KOKORO_SAMPLE_RATE'] });
    expect(store.getState().config.values.KOKORO_SAMPLE_RATE.overridden).toBe(false);
  });
});

/* ── selectRestartPending ────────────────────────────────────────────────── */

describe('selectRestartPending', () => {
  it('returns false when no restart-sidecar knob is overridden', () => {
    const store = makeStore();
    store.dispatch(fetchConfig.fulfilled(MOCK_CONFIG_RESPONSE, '', undefined));
    expect(selectRestartPending(store.getState())).toBe(false);
  });

  it('returns true when a restart-sidecar knob is overridden', () => {
    const store = makeStore();
    const overriddenValues: ConfigValues = {
      ...MOCK_VALUES,
      KOKORO_SAMPLE_RATE: { key: 'KOKORO_SAMPLE_RATE', effective: 16000, source: 'override', locked: false, overridden: true },
    };
    store.dispatch(
      fetchConfig.fulfilled({ ...MOCK_CONFIG_RESPONSE, values: overriddenValues }, '', undefined),
    );
    expect(selectRestartPending(store.getState())).toBe(true);
  });

  it('returns false when a live knob is overridden (not restart-sidecar)', () => {
    const store = makeStore();
    const liveOverriddenValues: ConfigValues = {
      ...MOCK_VALUES,
      SEG_ASR_ENABLED: { key: 'SEG_ASR_ENABLED', effective: true, source: 'override', locked: false, overridden: true },
    };
    store.dispatch(
      fetchConfig.fulfilled({ ...MOCK_CONFIG_RESPONSE, values: liveOverriddenValues }, '', undefined),
    );
    expect(selectRestartPending(store.getState())).toBe(false);
  });

  it('returns false when a restart-sidecar knob is env-locked (not a user override)', () => {
    const store = makeStore();
    const envLockedValues: ConfigValues = {
      ...MOCK_VALUES,
      // restart-sidecar knob driven by an env var: source='env', overridden=false
      KOKORO_SAMPLE_RATE: { key: 'KOKORO_SAMPLE_RATE', effective: 16000, source: 'env', locked: true, overridden: false },
    };
    store.dispatch(
      fetchConfig.fulfilled({ ...MOCK_CONFIG_RESPONSE, values: envLockedValues }, '', undefined),
    );
    expect(selectRestartPending(store.getState())).toBe(false);
  });
});

/* ── selectRestartServerPending ─────────────────────────────────────────── */

describe('selectRestartServerPending', () => {
  it('returns false when no restart-server knob is overridden', () => {
    const store = makeStore();
    store.dispatch(fetchConfig.fulfilled(MOCK_CONFIG_RESPONSE, '', undefined));
    expect(selectRestartServerPending(store.getState())).toBe(false);
  });

  it('returns true when a restart-server knob is overridden', () => {
    const store = makeStore();
    const overriddenValues: ConfigValues = {
      ...MOCK_VALUES,
      SERVER_PORT: { key: 'SERVER_PORT', effective: 9090, source: 'override', locked: false, overridden: true },
    };
    store.dispatch(
      fetchConfig.fulfilled({ ...MOCK_CONFIG_RESPONSE, values: overriddenValues }, '', undefined),
    );
    expect(selectRestartServerPending(store.getState())).toBe(true);
  });
});
