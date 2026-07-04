import { describe, it, expect } from 'vitest';
import {
  selectUndesignedQwenCharacters,
  selectVoiceReadinessGateShouldFire,
  selectIsBookNonEnglish,
  voiceReadinessGateMessage,
} from './voice-readiness-selectors';
import type { RootState } from './index';
import type { Character, Voice, TtsModelKey } from '../lib/types';

const mk = (opts: {
  characters?: Partial<Character>[];
  voices?: Partial<Voice>[];
  ttsModelKey?: TtsModelKey;
  books?: { bookId: string; language?: string }[];
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

describe('selectIsBookNonEnglish', () => {
  it('is false when the book is English', () => {
    expect(selectIsBookNonEnglish(mk({ books: [{ bookId: 'b1', language: 'en' }] }), 'b1')).toBe(
      false,
    );
  });

  it('is true for a non-English book', () => {
    expect(selectIsBookNonEnglish(mk({ books: [{ bookId: 'b1', language: 'ru' }] }), 'b1')).toBe(
      true,
    );
  });

  it('defaults to English (false) when the book is missing', () => {
    expect(selectIsBookNonEnglish(mk({ books: [] }), 'missing')).toBe(false);
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
    expect(voiceReadinessGateMessage(s, 'b1')).toMatch(/still need a designed voice/);
  });

  it('returns the hard-block copy for a non-English book', () => {
    const s = mk({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 1 })],
      books: [{ bookId: 'b1', language: 'ru' }],
    });
    expect(voiceReadinessGateMessage(s, 'b1')).toMatch(/can't fall back to a generic voice/);
  });
});
