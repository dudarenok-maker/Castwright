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
  higherQwenTier,
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
    expect(modelKeyForEngineChoice('qwen', 'coqui-xtts-v2')).toBe('qwen3-tts-0.6b');
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

  it('carries a Qwen session tier through instead of flattening to 0.6B', () => {
    /* The audition path resolves its tier from the SESSION key (the
       Start-generation modal writes ui.ttsModelKey and the cast pins together —
       layout.tsx:1731-1760), so a 1.7B book must preview at 1.7B. */
    expect(modelKeyForEngineChoice('qwen', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });

  it('elevates to an explicit character tier over a lower session tier', () => {
    expect(modelKeyForEngineChoice('qwen', 'qwen3-tts-0.6b', 'qwen3-tts-1.7b')).toBe(
      'qwen3-tts-1.7b',
    );
  });

  it('never lets a lower character tier drag a higher session tier down', () => {
    /* Mirrors higherQwenTier's contract (server/src/tts/model-keys.ts:118). */
    expect(modelKeyForEngineChoice('qwen', 'qwen3-tts-1.7b', 'qwen3-tts-0.6b')).toBe(
      'qwen3-tts-1.7b',
    );
  });

  it('resolves a non-Qwen engine against a mismatched session key', () => {
    /* The table the retired sampleModelKeyForEngine got wrong: it returned the
       SESSION key for every non-Qwen engine. */
    expect(modelKeyForEngineChoice('kokoro', 'coqui-xtts-v2')).toBe('kokoro-v1');
    expect(modelKeyForEngineChoice('coqui', 'kokoro-v1')).toBe('coqui-xtts-v2');
  });

  it('leaves a matching engine/key pair alone', () => {
    expect(modelKeyForEngineChoice('kokoro', 'kokoro-v1')).toBe('kokoro-v1');
    expect(modelKeyForEngineChoice('coqui', 'coqui-xtts-v2')).toBe('coqui-xtts-v2');
    expect(modelKeyForEngineChoice('gemini', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });

  it('piper falls through to the session key (frontend model-key enum asymmetry)', () => {
    /* The frontend TtsModelKey derives from VoiceSampleRequest.modelKey
       (openapi.yaml:4708), the audition endpoint's enum, which is narrower
       than the server's TtsModelKey and carries no piper key. Piper is also
       unreachable from the UI — it's absent from TTS_ENGINES and from the
       engine picker's installedEngines. So piper falls through to the session
       key here, and the comment in modelKeyForEngineChoice documents the
       intentional asymmetry. */
    expect(modelKeyForEngineChoice('piper', 'kokoro-v1')).toBe('kokoro-v1');
    expect(modelKeyForEngineChoice('piper', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });
});

describe('higherQwenTier', () => {
  it('picks 1.7B over 0.6B in either argument order', () => {
    expect(higherQwenTier('qwen3-tts-1.7b', 'qwen3-tts-0.6b')).toBe('qwen3-tts-1.7b');
    expect(higherQwenTier('qwen3-tts-0.6b', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });

  it('keeps `a` on a tie', () => {
    expect(higherQwenTier('qwen3-tts-0.6b', 'qwen3-tts-0.6b')).toBe('qwen3-tts-0.6b');
  });
});
