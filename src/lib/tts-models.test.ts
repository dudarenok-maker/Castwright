import { describe, it, expect } from 'vitest';
import {
  TTS_ENGINES,
  TTS_MODEL_OPTIONS,
  ttsModelLabel,
  effectiveEngineLabel,
  engineForModelKey,
  engineGroupForModelKey,
  formatEngineBreakdown,
} from './tts-models';

describe('formatEngineBreakdown (mixed-engine chapter caption)', () => {
  it('renders one engine with its voice count', () => {
    expect(formatEngineBreakdown({ qwen: 1 })).toBe('Qwen (1)');
  });

  it('renders a mixed breakdown alphabetically by engine label', () => {
    expect(formatEngineBreakdown({ qwen: 6, kokoro: 1 })).toBe('Kokoro (1), Qwen (6)');
  });

  it('returns an empty string for an empty or missing breakdown', () => {
    expect(formatEngineBreakdown({})).toBe('');
    expect(formatEngineBreakdown(undefined)).toBe('');
  });
});

describe('tts-models catalog includes Qwen3-TTS (plan 108)', () => {
  it('lists qwen3-tts-0.6b under the Local engine group (so it shows in the model dropdowns)', () => {
    const local = TTS_ENGINES.find((g) => g.id === 'local');
    expect(local, 'local engine group exists').toBeTruthy();
    const ids = local!.models.map((m) => m.id);
    expect(ids).toContain('qwen3-tts-0.6b');
    expect(ids).toContain('kokoro-v1'); // unchanged
  });

  it('lists qwen3-tts-1.7b alongside 0.6b under the Local engine group (picker exposes both Qwen tiers)', () => {
    const local = TTS_ENGINES.find((g) => g.id === 'local');
    expect(local, 'local engine group exists').toBeTruthy();
    const ids = local!.models.map((m) => m.id);
    expect(ids).toContain('qwen3-tts-0.6b');
    expect(ids).toContain('qwen3-tts-1.7b');
  });

  it('exposes qwen in the flat option list with a label', () => {
    expect(TTS_MODEL_OPTIONS.map((m) => m.id)).toContain('qwen3-tts-0.6b');
    expect(ttsModelLabel('qwen3-tts-0.6b')).toBe('Qwen3-TTS 0.6B');
  });

  it('routes the qwen model key to the qwen engine + the local group', () => {
    expect(engineForModelKey('qwen3-tts-0.6b')).toBe('qwen');
    expect(engineGroupForModelKey('qwen3-tts-0.6b')).toBe('local');
  });

  it('routes the qwen 1.7B tier to the qwen engine + the local group', () => {
    expect(engineForModelKey('qwen3-tts-1.7b')).toBe('qwen');
    expect(engineGroupForModelKey('qwen3-tts-1.7b')).toBe('local');
  });

  it('keeps the existing engine routing intact', () => {
    expect(engineForModelKey('kokoro-v1')).toBe('kokoro');
    expect(engineForModelKey('coqui-xtts-v2')).toBe('coqui');
    expect(engineForModelKey('gemini-2.5-flash')).toBe('gemini');
    expect(engineGroupForModelKey('gemini-2.5-flash')).toBe('gemini');
  });

  it('labels the 1.7B Quality tier (now exposed in the picker)', () => {
    /* 1.7B is now in TTS_MODEL_OPTIONS (the picker exposes both Qwen tiers);
       ttsModelLabel resolves it via TTS_MODEL_OPTIONS first. */
    expect(TTS_MODEL_OPTIONS.map((m) => m.id)).toContain('qwen3-tts-1.7b');
    expect(ttsModelLabel('qwen3-tts-1.7b')).toBe('Qwen3-TTS 1.7B');
  });
});

describe('effectiveEngineLabel (truthful generation-header tier)', () => {
  it('returns the run-default label when no character is pinned', () => {
    const cast = [{ ttsModelKey: null }, { ttsModelKey: undefined }];
    expect(effectiveEngineLabel(cast, 'qwen3-tts-0.6b')).toBe('Qwen3-TTS 0.6B');
  });

  it('reflects 1.7B when the whole cast is pinned to it (the reported bug)', () => {
    const cast = [{ ttsModelKey: 'qwen3-tts-1.7b' as const }, { ttsModelKey: 'qwen3-tts-1.7b' as const }];
    /* Run default is 0.6B (global picker) but every character renders at 1.7B. */
    expect(effectiveEngineLabel(cast, 'qwen3-tts-0.6b')).toBe('Qwen3-TTS 1.7B');
  });

  it('shows a Mixed label when tiers differ across the cast', () => {
    const cast = [{ ttsModelKey: 'qwen3-tts-1.7b' as const }, { ttsModelKey: null }];
    expect(effectiveEngineLabel(cast, 'qwen3-tts-0.6b')).toBe('Mixed: Qwen3-TTS 0.6B + Qwen3-TTS 1.7B');
  });

  it('collapses to a single label when an un-pinned character matches the run default tier', () => {
    const cast = [{ ttsModelKey: 'qwen3-tts-0.6b' as const }, { ttsModelKey: null }];
    expect(effectiveEngineLabel(cast, 'qwen3-tts-0.6b')).toBe('Qwen3-TTS 0.6B');
  });
});
