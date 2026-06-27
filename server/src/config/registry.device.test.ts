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

  it('COQUI_DEVICE is a string knob; an override of cuda:1 resolves through', () => {
    expect(getKnob('tts.coqui.device')!.type).toBe('string');
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.coqui.device': 'cuda:1' });
    expect(resolveKnob(getKnob('tts.coqui.device')!).effective).toBe('cuda:1');
  });

  it('SPK_DEVICE is a string knob (was enum cpu|cuda)', () => {
    expect(getKnob('qa.speaker.device')!.type).toBe('string');
    (us.readConfigOverrides as any).mockReturnValue({ 'qa.speaker.device': 'cuda:1' });
    expect(resolveKnob(getKnob('qa.speaker.device')!).effective).toBe('cuda:1');
  });

  it('adds KOKORO_DEVICE (string, restart-sidecar, default auto)', () => {
    const k = getKnob('tts.kokoro.device')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['KOKORO_DEVICE', 'string', 'restart-sidecar', 'auto']);
  });

  it('adds ASR_DEVICE registry knob (string, restart-sidecar, default cpu)', () => {
    const k = getKnob('qa.asr.device')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['ASR_DEVICE', 'string', 'restart-sidecar', 'cpu']);
  });
});
