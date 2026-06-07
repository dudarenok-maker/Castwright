import { describe, it, expect } from 'vitest';
import {
  TTS_ENGINES,
  TTS_MODEL_OPTIONS,
  ttsModelLabel,
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

  it('exposes qwen in the flat option list with a label', () => {
    expect(TTS_MODEL_OPTIONS.map((m) => m.id)).toContain('qwen3-tts-0.6b');
    expect(ttsModelLabel('qwen3-tts-0.6b')).toBe('Qwen3-TTS 0.6B');
  });

  it('routes the qwen model key to the qwen engine + the local group', () => {
    expect(engineForModelKey('qwen3-tts-0.6b')).toBe('qwen');
    expect(engineGroupForModelKey('qwen3-tts-0.6b')).toBe('local');
  });

  it('keeps the existing engine routing intact', () => {
    expect(engineForModelKey('kokoro-v1')).toBe('kokoro');
    expect(engineForModelKey('coqui-xtts-v2')).toBe('coqui');
    expect(engineForModelKey('gemini-2.5-flash')).toBe('gemini');
    expect(engineGroupForModelKey('gemini-2.5-flash')).toBe('gemini');
  });
});
