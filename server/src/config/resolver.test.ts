import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

vi.mock('../gpu/gpu-device-list-state.js', () => ({
  getLastKnownGpuDevices: vi.fn(() => []),
}));

import {
  resolveKnob,
  resolveKnobForSidecarEnv,
  coerceAndValidate,
  configValue,
} from './resolver.js';
import { getKnob } from './registry.js';
import * as us from '../workspace/user-settings.js';
import * as gds from '../gpu/gpu-device-list-state.js';

const KEY = 'analyzer.stage2.minCoverage'; // number, env STAGE2_MIN_COVERAGE, default 0.6

describe('resolver precedence', () => {
  beforeEach(() => {
    delete process.env.STAGE2_MIN_COVERAGE;
    (us.readConfigOverrides as any).mockReturnValue({});
  });

  it('falls back to shipped default', () => {
    const s = resolveKnob(getKnob(KEY)!);
    expect(s).toMatchObject({ effective: 0.6, source: 'default', locked: false, overridden: false });
  });

  it('app override beats default', () => {
    (us.readConfigOverrides as any).mockReturnValue({ [KEY]: 0.55 });
    const s = resolveKnob(getKnob(KEY)!);
    expect(s).toMatchObject({ effective: 0.55, source: 'override', locked: false, overridden: true });
  });

  it('env beats override and locks', () => {
    (us.readConfigOverrides as any).mockReturnValue({ [KEY]: 0.55 });
    process.env.STAGE2_MIN_COVERAGE = '0.7';
    const s = resolveKnob(getKnob(KEY)!);
    expect(s).toMatchObject({ effective: 0.7, source: 'env', locked: true, overridden: false });
  });

  it('coerceAndValidate enforces type and range', () => {
    const knob = getKnob(KEY)!;
    expect(coerceAndValidate(knob, '0.5')).toEqual({ ok: true, value: 0.5 });
    expect(coerceAndValidate(knob, '2').ok).toBe(false); // > max 1
    expect(coerceAndValidate(knob, 'nope').ok).toBe(false);
  });

  it('an invalid env value is ignored — falls through to override/default', () => {
    (us.readConfigOverrides as any).mockReturnValue({ [KEY]: 0.55 });
    process.env.STAGE2_MIN_COVERAGE = 'not-a-number';
    const s = resolveKnob(getKnob(KEY)!);
    expect(s).toMatchObject({ effective: 0.55, source: 'override', locked: false });
  });

  it('coerces boolean env values', () => {
    const knob = getKnob('qa.asr.enabled')!; // boolean, env SEG_ASR_ENABLED
    expect(coerceAndValidate(knob, 'true')).toEqual({ ok: true, value: true });
    expect(coerceAndValidate(knob, '1')).toEqual({ ok: true, value: true });
    expect(coerceAndValidate(knob, 'off')).toEqual({ ok: true, value: false });
    expect(coerceAndValidate(knob, 'maybe').ok).toBe(false);
  });

  it('validates enum options', () => {
    // tts.accelerator stays an enum exemplar (tts.coqui.device widened to string in Wave 1)
    expect(coerceAndValidate(getKnob('tts.accelerator')!, 'nvidia')).toEqual({ ok: true, value: 'nvidia' });
    expect(coerceAndValidate(getKnob('tts.accelerator')!, 'tpu').ok).toBe(false);
  });

  it('configValue throws on an unknown key', () => {
    expect(() => configValue('no.such.knob')).toThrow(/unknown config key/);
  });

  // #2180 correction 1 — qa.asr.device is free-form `type: 'string'` with no
  // `options` array, so `cuda`, `cuda:1`, and a typo like `cuda1` were all
  // equally "valid" at the coercion layer. Constrained to
  // cpu | auto | cuda | cuda:<n> via a new general `pattern` capability on
  // the knob shape (coerceAndValidate's string/default case).
  it('qa.asr.device is constrained to cpu | auto | cuda | cuda:<n> via a pattern', () => {
    const knob = getKnob('qa.asr.device')!;
    expect(coerceAndValidate(knob, 'cpu')).toEqual({ ok: true, value: 'cpu' });
    expect(coerceAndValidate(knob, 'auto')).toEqual({ ok: true, value: 'auto' });
    expect(coerceAndValidate(knob, 'cuda')).toEqual({ ok: true, value: 'cuda' });
    expect(coerceAndValidate(knob, 'cuda:1')).toEqual({ ok: true, value: 'cuda:1' });
    expect(coerceAndValidate(knob, 'CUDA:1')).toEqual({ ok: true, value: 'CUDA:1' }); // case-insensitive
    expect(coerceAndValidate(knob, 'cuda1').ok).toBe(false); // the typo shape named in the decision comment
    expect(coerceAndValidate(knob, 'gpu').ok).toBe(false);
  });
});

describe('resolveKnob — device UUID reconcile (Plan 2 §2.1)', () => {
  beforeEach(() => {
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
  });

  it('translates a stored cuda-uuid override back to cuda:N when the card is currently visible', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GPU-1' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([{ uuid: 'GPU-1', idx: 1 }]);
    const st = resolveKnob(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('cuda:1');
    expect(st.staleReason).toBeUndefined();
  });

  it('flags uuid_unresolved when the stored uuid matches no currently-visible card', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GONE' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
    const st = resolveKnob(getKnob('tts.qwen.device')!);
    expect(st.staleReason).toBe('uuid_unresolved');
  });
});

describe('resolveKnobForSidecarEnv — deliberately does NOT reconcile (#1857)', () => {
  beforeEach(() => {
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
    (us.readConfigOverrides as any).mockReturnValue({});
    delete process.env.QWEN_DEVICE;
  });

  /* The sidecar resolves 'cuda-uuid:' itself against LIVE enumeration on every
     spawn (main.py:1873 _read_device_env). Handing it a pre-translated index
     instead freezes a mapping that buildOpts re-emits on every respawn, which a
     vanished or renumbered card can no longer correct. So this entry point must
     emit the uuid form even when the cache COULD translate it. */
  it('passes a cuda-uuid override through even when the card IS visible', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GPU-1' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([{ uuid: 'GPU-1', idx: 1 }]);
    const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('cuda-uuid:GPU-1');
    expect(st.staleReason).toBeUndefined();
  });

  it('passes a cuda-uuid override through when no card matches, WITHOUT flagging stale', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GONE' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
    const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('cuda-uuid:GONE');
    // staleReason is a UI concept; the sidecar decides liveness for itself.
    expect(st.staleReason).toBeUndefined();
  });

  it('is identical to resolveKnob for a non-uuid device value', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda:1' });
    const knob = getKnob('tts.qwen.device')!;
    expect(resolveKnobForSidecarEnv(knob)).toEqual(resolveKnob(knob));
  });

  it('is identical to resolveKnob for a non-device knob', () => {
    (us.readConfigOverrides as any).mockReturnValue({ [KEY]: 0.9 });
    const knob = getKnob(KEY)!;
    expect(resolveKnobForSidecarEnv(knob)).toEqual(resolveKnob(knob));
  });

  it('still honours an env-locked value', () => {
    process.env.QWEN_DEVICE = 'cpu';
    try {
      const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
      expect(st.effective).toBe('cpu');
      expect(st.source).toBe('env');
      expect(st.locked).toBe(true);
    } finally {
      delete process.env.QWEN_DEVICE;
    }
  });

  it('still falls through to the registry default when nothing is set', () => {
    const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('auto');
    expect(st.source).toBe('default');
  });
});
