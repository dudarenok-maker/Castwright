import { describe, it, expect } from 'vitest';
import {
  selectUndesignedQwenCharacters,
  selectVoiceReadinessGateShouldFire,
  selectHasNoFallbackEngine,
  voiceReadinessGateMessage,
} from './voice-readiness-selectors';
import type { RootState } from './index';
import type { Character, Voice, TtsModelKey } from '../lib/types';

const mk = (opts: {
  characters?: Partial<Character>[];
  voices?: Partial<Voice>[];
  ttsModelKey?: TtsModelKey;
  books?: { bookId: string; language?: string; eligibleTtsEngines?: string[] }[];
}): RootState =>
  ({
    cast: { characters: (opts.characters ?? []) as Character[] },
    voices: { voices: (opts.voices ?? []) as Voice[] },
    ui: { ttsModelKey: opts.ttsModelKey ?? 'qwen3-tts-0.6b' },
    library: { books: opts.books ?? [] },
  }) as unknown as RootState;

const qwenChar = (over: Partial<Character> & { id: string }): Character =>
  ({
    name: over.id,
    role: 'r',
    color: 'narrator',
    lines: 0,
    ttsEngine: 'qwen',
    ...over,
  }) as Character;

describe('selectUndesignedQwenCharacters', () => {
  it('returns empty for an empty cast', () => {
    expect(selectUndesignedQwenCharacters(mk({}), 'b1')).toEqual([]);
  });

  it('excludes a character with a designed Qwen voice', () => {
    const s = mk({
      characters: [
        qwenChar({
          id: 'a',
          name: 'Alice',
          lines: 5,
          overrideTtsVoices: { qwen: { name: 'alice-v1' } },
        }),
      ],
    });
    expect(selectUndesignedQwenCharacters(s, 'b1')).toEqual([]);
  });

  it('includes a 0-line undesigned character in the list', () => {
    const s = mk({ characters: [qwenChar({ id: 'a', name: 'Alice', lines: 0 })] });
    expect(selectUndesignedQwenCharacters(s, 'b1')).toEqual([{ id: 'a', name: 'Alice', lines: 0 }]);
  });

  it('includes a character whose per-character ttsEngine is qwen even when the project default is not', () => {
    const s = mk({
      characters: [
        {
          id: 'a',
          name: 'Alice',
          lines: 3,
          ttsEngine: 'qwen',
          role: 'r',
          color: 'narrator',
        } as Character,
      ],
      ttsModelKey: 'kokoro-v1',
    });
    expect(selectUndesignedQwenCharacters(s, 'b1')).toEqual([{ id: 'a', name: 'Alice', lines: 3 }]);
  });

  it('excludes a non-Qwen character entirely', () => {
    const s = mk({
      characters: [{ id: 'a', name: 'Alice', lines: 3, role: 'r', color: 'narrator' } as Character],
      ttsModelKey: 'kokoro-v1',
    });
    expect(selectUndesignedQwenCharacters(s, 'b1')).toEqual([]);
  });

  it('sorts by compareCastRows (line count descending)', () => {
    const s = mk({
      characters: [
        qwenChar({ id: 'a', name: 'Amy', lines: 5 }),
        qwenChar({ id: 'b', name: 'Bo', lines: 100 }),
      ],
    });
    expect(selectUndesignedQwenCharacters(s, 'b1').map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('returns a stable reference across calls with unchanged state (#1285)', () => {
    /* Unmemoized, this allocated a fresh array on every call — react-redux's
       dev-mode stability check flags exactly this as "returned a different
       result", and `VoiceReadinessGateModal` (a global, always-mounted
       overlay) called this on every render. */
    const s = mk({ characters: [qwenChar({ id: 'a', name: 'Alice', lines: 3 })] });
    expect(selectUndesignedQwenCharacters(s, 'b1')).toBe(selectUndesignedQwenCharacters(s, 'b1'));
  });
});

describe('selectVoiceReadinessGateShouldFire', () => {
  it('is false when only 0-line undesigned characters exist', () => {
    const s = mk({ characters: [qwenChar({ id: 'a', name: 'Alice', lines: 0 })] });
    expect(selectVoiceReadinessGateShouldFire(s, 'b1')).toBe(false);
  });

  it('is true when a speaking undesigned character exists', () => {
    const s = mk({ characters: [qwenChar({ id: 'a', name: 'Alice', lines: 1 })] });
    expect(selectVoiceReadinessGateShouldFire(s, 'b1')).toBe(true);
  });

  it('is false when the whole cast is fully designed', () => {
    const s = mk({
      characters: [
        qwenChar({
          id: 'a',
          name: 'Alice',
          lines: 5,
          overrideTtsVoices: { qwen: { name: 'alice-v1' } },
        }),
      ],
    });
    expect(selectVoiceReadinessGateShouldFire(s, 'b1')).toBe(false);
  });
});

describe('selectHasNoFallbackEngine', () => {
  it('is false for a Coqui-eligible non-English book (ru)', () => {
    const s = mk({ books: [{ bookId: 'b1', language: 'ru', eligibleTtsEngines: ['qwen', 'coqui'] }] });
    expect(selectHasNoFallbackEngine(s, 'b1')).toBe(false);
  });

  it('is true for a still-unsupported non-English language (zh)', () => {
    const s = mk({ books: [{ bookId: 'b1', language: 'zh', eligibleTtsEngines: ['qwen'] }] });
    expect(selectHasNoFallbackEngine(s, 'b1')).toBe(true);
  });

  it('is false for English', () => {
    const s = mk({
      books: [{ bookId: 'b1', language: 'en', eligibleTtsEngines: ['qwen', 'kokoro', 'coqui', 'gemini'] }],
    });
    expect(selectHasNoFallbackEngine(s, 'b1')).toBe(false);
  });

  it('defaults to false (assume every engine eligible) when the book is missing, matching the old missing-book default', () => {
    expect(selectHasNoFallbackEngine(mk({ books: [] }), 'missing')).toBe(false);
  });
});

describe('voiceReadinessGateMessage', () => {
  it('is null when the gate would not fire', () => {
    const s = mk({ characters: [] });
    expect(voiceReadinessGateMessage(s, 'b1')).toBeNull();
  });

  it('returns the soft-gate copy for an English book', () => {
    const s = mk({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 1 })],
      books: [{ bookId: 'b1', language: 'en' }],
    });
    expect(voiceReadinessGateMessage(s, 'b1')).toMatch(/haven't been designed yet/);
  });

  it('returns the hard-block copy for a still-unsupported non-English book', () => {
    const s = mk({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 1 })],
      books: [{ bookId: 'b1', language: 'zh', eligibleTtsEngines: ['qwen'] }],
    });
    expect(voiceReadinessGateMessage(s, 'b1')).toMatch(/can't fall back to a generic voice/);
  });

  it('returns the Coqui-worded soft-gate copy for a Coqui-eligible non-English book (ru)', () => {
    const s = mk({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 1 })],
      books: [{ bookId: 'b1', language: 'ru', eligibleTtsEngines: ['qwen', 'coqui'] }],
    });
    expect(voiceReadinessGateMessage(s, 'b1')).toMatch(/render with a Coqui fallback voice/);
  });
});
