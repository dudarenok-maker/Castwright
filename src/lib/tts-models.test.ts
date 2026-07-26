import { describe, it, expect } from 'vitest';
import {
  TTS_ENGINES,
  TTS_MODEL_OPTIONS,
  ttsModelLabel,
  effectiveEngineLabel,
  effectiveModelKey,
  engineForModelKey,
  engineGroupForModelKey,
  formatEngineBreakdown,
  modelKeyForEngineChoice,
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

describe('effectiveModelKey (the key behind effectiveEngineLabel, for comparisons like engine drift)', () => {
  it('returns the run-default key when no character is pinned', () => {
    const cast = [{ ttsModelKey: null }, { ttsModelKey: undefined }];
    expect(effectiveModelKey(cast, 'qwen3-tts-0.6b')).toBe('qwen3-tts-0.6b');
  });

  it('returns 1.7B when the whole cast is pinned to it, even though the run default is 0.6B', () => {
    const cast = [{ ttsModelKey: 'qwen3-tts-1.7b' as const }, { ttsModelKey: 'qwen3-tts-1.7b' as const }];
    expect(effectiveModelKey(cast, 'qwen3-tts-0.6b')).toBe('qwen3-tts-1.7b');
  });

  it('falls back to the run-default key when tiers differ across the cast (no single key to give)', () => {
    const cast = [{ ttsModelKey: 'qwen3-tts-1.7b' as const }, { ttsModelKey: null }];
    expect(effectiveModelKey(cast, 'qwen3-tts-0.6b')).toBe('qwen3-tts-0.6b');
  });

  it('ignores a stale ttsModelKey on a character who has since moved to a non-Qwen engine', () => {
    /* ttsModelKey is documented as "Ignored for non-Qwen characters" — a
       character moved off Qwen can carry a leftover value from before the
       move. Folding it into the comparison anyway reintroduces a false
       "Mixed" tier and falls back to the raw run-default, which is exactly
       the false-drift bug this helper exists to fix. */
    const cast = [
      { ttsModelKey: 'qwen3-tts-1.7b' as const, ttsEngine: 'qwen' as const },
      { ttsModelKey: 'qwen3-tts-1.7b' as const, ttsEngine: 'qwen' as const },
      { ttsModelKey: 'qwen3-tts-0.6b' as const, ttsEngine: 'kokoro' as const },
    ];
    expect(effectiveModelKey(cast, 'qwen3-tts-0.6b')).toBe('qwen3-tts-1.7b');
    expect(effectiveEngineLabel(cast, 'qwen3-tts-0.6b')).toBe('Qwen3-TTS 1.7B');
  });
});

describe('modelKeyForEngineChoice (fs-38 Wave 3b2, T6b review — resolves a drawer-style engine CHOICE to a concrete modelKey for the assign-guard fix)', () => {
  it("'default' returns the session model key as-is, whatever it is", () => {
    expect(modelKeyForEngineChoice('default', 'kokoro-v1')).toBe('kokoro-v1');
    expect(modelKeyForEngineChoice('default', 'gemini-3.1-flash')).toBe('gemini-3.1-flash');
  });

  it("'kokoro' always resolves to the single Kokoro model key, regardless of the session key", () => {
    expect(modelKeyForEngineChoice('kokoro', 'gemini-2.5-flash')).toBe('kokoro-v1');
  });

  it("'qwen' falls back to the 0.6B tier when no qwenTier is given", () => {
    expect(modelKeyForEngineChoice('qwen', 'kokoro-v1')).toBe('qwen3-tts-0.6b');
    expect(modelKeyForEngineChoice('qwen', 'kokoro-v1', null)).toBe('qwen3-tts-0.6b');
  });

  it("'qwen' carries through a pinned 1.7B qwenTier", () => {
    expect(modelKeyForEngineChoice('qwen', 'kokoro-v1', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });

  it("'coqui' always resolves to the single Coqui model key, regardless of the session key", () => {
    expect(modelKeyForEngineChoice('coqui', 'gemini-2.5-flash')).toBe('coqui-xtts-v2');
  });

  it("'gemini' keeps the session key when it's already a Gemini model, else falls back to the default Gemini model", () => {
    expect(modelKeyForEngineChoice('gemini', 'gemini-3.1-flash')).toBe('gemini-3.1-flash');
    expect(modelKeyForEngineChoice('gemini', 'kokoro-v1')).toBe('gemini-2.5-flash');
  });

  it("'piper' has no UI-stable model key yet, so it falls back to the session key like 'default'", () => {
    expect(modelKeyForEngineChoice('piper', 'kokoro-v1')).toBe('kokoro-v1');
    expect(modelKeyForEngineChoice('piper', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });
});
