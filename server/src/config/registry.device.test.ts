import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

import { resolveKnob } from './resolver.js';
import { getKnob } from './registry.js';
import * as us from '../workspace/user-settings.js';

describe('multi-GPU device knobs (Wave 1)', () => {
  beforeEach(() => {
    delete process.env.COQUI_DEVICE; delete process.env.SPK_DEVICE;
    delete process.env.KOKORO_DEVICE; delete process.env.ASR_DEVICE;
    (us.readConfigOverrides as any).mockReturnValue({});
  });

  it('COQUI_DEVICE is a device knob; an override of cuda:1 resolves through', () => {
    expect(getKnob('tts.coqui.device')!.type).toBe('device');
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.coqui.device': 'cuda:1' });
    expect(resolveKnob(getKnob('tts.coqui.device')!).effective).toBe('cuda:1');
  });

  it('SPK_DEVICE is a string knob (was enum cpu|cuda)', () => {
    expect(getKnob('qa.speaker.device')!.type).toBe('string');
    (us.readConfigOverrides as any).mockReturnValue({ 'qa.speaker.device': 'cuda:1' });
    expect(resolveKnob(getKnob('qa.speaker.device')!).effective).toBe('cuda:1');
  });

  it('adds KOKORO_DEVICE (device, restart-sidecar, default auto)', () => {
    const k = getKnob('tts.kokoro.device')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['KOKORO_DEVICE', 'device', 'restart-sidecar', 'auto']);
  });

  it('QWEN_DEVICE is a device knob (picker-ready, restart-sidecar, default auto)', () => {
    const k = getKnob('tts.qwen.device')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['QWEN_DEVICE', 'device', 'restart-sidecar', 'auto']);
  });

  it('adds ASR_DEVICE registry knob (string, restart-sidecar, default cpu)', () => {
    const k = getKnob('qa.asr.device')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['ASR_DEVICE', 'string', 'restart-sidecar', 'cpu']);
  });

  it('adds ASR_MODEL registry knob (string, restart-sidecar, default base) alongside ASR_DEVICE', () => {
    const k = getKnob('qa.asr.model')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['ASR_MODEL', 'string', 'restart-sidecar', 'base']);
  });

  it('adds ASR_COMPUTE_TYPE registry knob (enum, restart-sidecar, default auto) with a closed CTranslate2 option set (#2014)', () => {
    const k = getKnob('qa.asr.computeType')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['ASR_COMPUTE_TYPE', 'enum', 'restart-sidecar', 'auto']);
    // 'auto' MUST be a valid option (it's also the default) — the sentinel
    // meaning "let the sidecar resolve its own device-dependent fallback"
    // (int8 on cpu / int8_float16 on cuda; main.py's _compute_type, #2014).
    expect(k.options).toContain('auto');
    expect(k.options).toContain('int8');
    expect(k.options).toContain('int8_float16');
  });

  it('adds ASR_CONCURRENCY registry knob (integer, restart-sidecar, default 2) documented alongside ASR_MODEL (#2014)', () => {
    const k = getKnob('qa.asr.concurrency')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['ASR_CONCURRENCY', 'integer', 'restart-sidecar', 2]);
    expect(k.min).toBe(1);
  });
});
