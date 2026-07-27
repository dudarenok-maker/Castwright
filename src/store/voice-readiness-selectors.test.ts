import { describe, it, expect } from 'vitest';
import {
  selectUndesignedQwenCharacters,
  selectVoiceReadinessGateShouldFire,
  selectHasNoFallbackEngine,
  selectFallbackEngineName,
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

  it('is true when Qwen is the only eligible engine (zh with no Coqui fallback installed)', () => {
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

describe('selectFallbackEngineName', () => {
  it("is 'Coqui' for a Coqui-eligible non-English book (ru)", () => {
    const s = mk({ books: [{ bookId: 'b1', language: 'ru', eligibleTtsEngines: ['qwen', 'coqui'] }] });
    expect(selectFallbackEngineName(s, 'b1')).toBe('Coqui');
  });

  it("is 'Kokoro' for an English book", () => {
    const s = mk({
      books: [{ bookId: 'b1', language: 'en', eligibleTtsEngines: ['qwen', 'kokoro', 'coqui', 'gemini'] }],
    });
    expect(selectFallbackEngineName(s, 'b1')).toBe('Kokoro');
  });

  /* #1534 — the fs-70 (#1303) state: a non-English language that Kokoro CAN
     read but Coqui can't. Unreachable while ENGINE_LANGUAGE_SUPPORT.kokoro is
     ['en'], but the three consumers must already agree about it — they used to
     each re-derive eligibility, so the button said "Kokoro" while the message
     said "Coqui". */
  it("is 'Kokoro' for a Kokoro-eligible, non-Coqui-eligible non-English book", () => {
    const s = mk({ books: [{ bookId: 'b1', language: 'ru', eligibleTtsEngines: ['qwen', 'kokoro'] }] });
    expect(selectFallbackEngineName(s, 'b1')).toBe('Kokoro');
  });
});

describe('#1534 — the three fallback consumers never disagree', () => {
  /* One shared eligibility derivation, so soft-gate / button / message can't
     drift into a soft-gate-then-server-hard-fail mismatch. */
  const cases: { name: string; language: string; eligible: string[] }[] = [
    { name: 'English, everything eligible', language: 'en', eligible: ['qwen', 'kokoro', 'coqui'] },
    { name: 'Coqui-eligible non-English (ru)', language: 'ru', eligible: ['qwen', 'coqui'] },
    { name: 'Kokoro-eligible non-English (fs-70)', language: 'ru', eligible: ['qwen', 'kokoro'] },
    { name: 'both fallbacks eligible, non-English', language: 'ru', eligible: ['qwen', 'kokoro', 'coqui'] },
  ];

  for (const c of cases) {
    it(`names the same engine in the button and the message — ${c.name}`, () => {
      const s = mk({
        characters: [qwenChar({ id: 'a', name: 'Alice', lines: 1 })],
        books: [{ bookId: 'b1', language: c.language, eligibleTtsEngines: c.eligible }],
      });
      /* A fallback exists, so this is the soft gate, not the hard block. */
      expect(selectHasNoFallbackEngine(s, 'b1')).toBe(false);
      const named = selectFallbackEngineName(s, 'b1');
      expect(voiceReadinessGateMessage(s, 'b1')).toContain(named);
    });
  }

  it('the hard block fires only when neither fallback is eligible', () => {
    const s = mk({
      characters: [qwenChar({ id: 'a', name: 'Alice', lines: 1 })],
      books: [{ bookId: 'b1', language: 'zh', eligibleTtsEngines: ['qwen'] }],
    });
    expect(selectHasNoFallbackEngine(s, 'b1')).toBe(true);
    expect(voiceReadinessGateMessage(s, 'b1')).toMatch(/can't fall back to a generic voice/);
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

  it('returns the hard-block copy when the book has no fallback engine (Qwen-only eligibility)', () => {
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
