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

  it('adds ASR_COMPUTE_TYPE registry knob (enum, restart-sidecar, default sidecar-default) with a closed CTranslate2 option set plus the sidecar sentinel (#2014, PR #2176 review findings 1+2)', () => {
    const k = getKnob('qa.asr.computeType')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['ASR_COMPUTE_TYPE', 'enum', 'restart-sidecar', 'sidecar-default']);
    // 'sidecar-default' MUST be a valid option (it's also the default) — the
    // sentinel meaning "let the sidecar resolve its own device-dependent
    // fallback" (int8 on cpu / int8_float16 on cuda; main.py's
    // _compute_type, #2014). It lives OUTSIDE CTranslate2's own vocabulary
    // on purpose (PR #2176 review finding 1): 'auto' is CT2's own distinct
    // member and must stay a real, pass-through option, not be shadowed by
    // the sentinel.
    //
    // Assert the FULL ordered option set, not membership of a few members —
    // a toContain-only assertion can't fail when six real CT2 values are
    // dropped and a bogus one is added (PR #2176 review finding 2:
    // closedness is the entire safety property, since resolver.ts rejects
    // any value not in this list).
    expect(k.options).toEqual([
      'sidecar-default', 'auto', 'default', 'int8', 'int8_float32',
      'int8_float16', 'int8_bfloat16', 'int16', 'float16', 'bfloat16', 'float32',
    ]);
  });

  // #2177: ASR_CONCURRENCY has never had a consumer anywhere in the repo —
  // no thread pool exists for it to size, and WhisperEngine._infer_lock
  // already serialises the CT2 forward pass. Deleted rather than wired up.
  it('has no qa.asr.concurrency knob (#2177 — deleted, never had a consumer)', () => {
    expect(getKnob('qa.asr.concurrency')).toBeUndefined();
  });
});
