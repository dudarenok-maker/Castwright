import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

import { resolveKnob, coerceAndValidate, configValue } from './resolver.js';
import { getKnob } from './registry.js';
import * as us from '../workspace/user-settings.js';

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
});
