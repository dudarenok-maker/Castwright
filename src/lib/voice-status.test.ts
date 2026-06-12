/* resolveVoiceStatus — the two-dimension Status resolver shared by the cast
   view's Status column and the profile drawer's Voice-profile header. Locks
   (a) the split that lets a reused Qwen voice read "Designed/Generated · Reused"
   instead of collapsing to a lone "Reused" pill, and (b) the effective-engine
   contract: a DEFAULT-engine character on a Qwen project follows the Qwen
   lifecycle ("Needs voice" when undesigned), not a stale preset pill. */

import { describe, it, expect } from 'vitest';
import {
  resolveVoiceStatus,
  statusFilterKeys,
  usedEmotionsByCharacter,
  countMissingVariants,
} from './voice-status';
import type { Character, Voice, TtsEngine, Sentence } from './types';

function char(partial: Partial<Character>): Character {
  return {
    id: 'c1',
    name: 'Char',
    role: 'role',
    color: 'narrator',
    lines: 1,
    scenes: 1,
    attributes: [],
    ...partial,
  } as Character;
}

function voice(partial: Partial<Voice>): Voice {
  return {
    id: 'v1',
    character: 'Char',
    bookTitle: 'Book',
    bookId: 'b1',
    attributes: [],
    gradient: ['#000', '#fff'],
    usedIn: 1,
    source: 'library',
    ttsVoice: { provider: 'coqui', name: 'Aaron Dreschner', description: 'Mid' },
    ...partial,
  } as Voice;
}

const matchedFrom = {
  bookTitle: 'Prior Book',
  bookId: 'b0',
  characterId: 'c0',
  confidence: 0.9,
};

/* Convenience: the caller passes the EFFECTIVE engine (the character's own
   override folded over the project default). `KOKORO` exercises the preset
   branch; `QWEN` the bespoke lifecycle. */
const KOKORO: TtsEngine = 'kokoro';
const QWEN: TtsEngine = 'qwen';

describe('resolveVoiceStatus — lifecycle pill (preset engine)', () => {
  it('maps preset voiceState values to their lifecycle pills', () => {
    expect(resolveVoiceStatus(char({ voiceState: 'generated' }), undefined, KOKORO).lifecycle).toEqual({
      label: 'Matched',
      color: 'success',
    });
    expect(resolveVoiceStatus(char({ voiceState: 'tuned' }), undefined, KOKORO).lifecycle).toEqual({
      label: 'Tuned',
      color: 'warning',
    });
    expect(resolveVoiceStatus(char({ voiceState: 'locked' }), undefined, KOKORO).lifecycle).toEqual({
      label: 'Locked',
      color: 'neutral',
    });
  });

  it('treats a reused preset voiceState as "Matched" (provenance moves to the badge)', () => {
    expect(resolveVoiceStatus(char({ voiceState: 'reused' }), undefined, KOKORO).lifecycle).toEqual({
      label: 'Matched',
      color: 'success',
    });
  });

  it('returns null lifecycle for a stateless preset row', () => {
    expect(resolveVoiceStatus(char({}), undefined, KOKORO).lifecycle).toBeNull();
  });
});

describe('resolveVoiceStatus — Qwen lifecycle', () => {
  it('reads "Needs voice" for a Qwen effective engine with no designed voice', () => {
    expect(resolveVoiceStatus(char({}), undefined, QWEN).lifecycle).toEqual({
      label: 'Needs voice',
      color: 'warning',
    });
  });

  it('reads "Fallback (Kokoro)" when the character actually rendered in Kokoro', () => {
    /* Render-time fact outranks the design lifecycle: a Qwen character that
       fell back to Kokoro (undesigned voice, or Qwen unavailable) shows the
       fallback pill rather than "Needs voice" / "Designed". */
    expect(resolveVoiceStatus(char({}), undefined, QWEN, 'kokoro').lifecycle).toEqual({
      label: 'Fallback (Kokoro)',
      color: 'warning',
    });
  });

  it('reads "Needs voice" for a DEFAULT-engine character on a Qwen project (the Lady Thorne bug)', () => {
    /* Effective engine is the project default (Qwen) even though the character
       carries no per-character `ttsEngine`. A stale preset pill ("Matched")
       from the default voiceState must NOT win here. */
    const c = char({ voiceState: 'generated' }); // no ttsEngine, no override
    expect(resolveVoiceStatus(c, undefined, QWEN).lifecycle).toEqual({
      label: 'Needs voice',
      color: 'warning',
    });
  });

  it('reads "Designed" for a designed Qwen voice that has not rendered audio', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'qwen-x' } } });
    expect(resolveVoiceStatus(c, voice({ generated: false }), QWEN).lifecycle).toEqual({
      label: 'Designed',
      color: 'library',
    });
  });

  it('reads "Generated" once the matched voice is flagged generated', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'qwen-x' } } });
    expect(resolveVoiceStatus(c, voice({ generated: true }), QWEN).lifecycle).toEqual({
      label: 'Generated',
      color: 'success',
    });
  });

  it('reads "Sampled" for a designed Qwen voice with a cached audition but no rendered chapter', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'qwen-x' } } });
    expect(resolveVoiceStatus(c, voice({ sampled: true }), QWEN).lifecycle).toEqual({
      label: 'Sampled',
      color: 'peach',
    });
  });

  it('lets "Generated" outrank "Sampled" when both flags are set', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'qwen-x' } } });
    expect(
      resolveVoiceStatus(c, voice({ sampled: true, generated: true }), QWEN).lifecycle,
    ).toEqual({ label: 'Generated', color: 'success' });
  });

  it('keeps "Needs voice" ahead of a stray sample flag on an undesigned voice', () => {
    /* A sample file could exist for a scope whose voice was later un-designed;
       the design gate still wins so the row reads "Needs voice", not "Sampled". */
    expect(resolveVoiceStatus(char({}), voice({ sampled: true }), QWEN).lifecycle).toEqual({
      label: 'Needs voice',
      color: 'warning',
    });
  });

  it('reads "Needs voice" for a reused voice whose matched Qwen Voice has an EMPTY name', () => {
    /* Regression: the matched Voice resolves to the qwen provider but carries no
       designed name (voiceId never linked, or the referenced Voice was lost to a
       persistence bug). Before the fix this fell through to "Designed"; it must
       read "Needs voice", matching the row's "No voice designed yet" sub-line. */
    const c = char({ voiceState: 'reused', matchedFrom });
    const v = voice({ ttsVoice: { provider: 'qwen', name: '', description: '' } });
    expect(resolveVoiceStatus(c, v, KOKORO).lifecycle).toEqual({
      label: 'Needs voice',
      color: 'warning',
    });
  });

  it('treats a REUSED voice whose matched Voice is Qwen as a Qwen lifecycle even when the effective engine is a preset', () => {
    /* The reuse path leaves the character's own ttsEngine/override empty and
       carries the Qwen voice on the matched Voice — so the Qwen branch must
       also fire off `voice.ttsVoice.provider`, regardless of project engine. */
    const c = char({ voiceState: 'reused', matchedFrom });
    const v = voice({
      generated: true,
      ttsVoice: { provider: 'qwen', name: 'qwen-narrator', description: 'Designed voice' },
    });
    expect(resolveVoiceStatus(c, v, KOKORO).lifecycle).toEqual({
      label: 'Generated',
      color: 'success',
    });
  });
});

describe('resolveVoiceStatus — Reused badge (provenance)', () => {
  it('is true whenever matchedFrom is set', () => {
    expect(resolveVoiceStatus(char({ matchedFrom }), undefined, KOKORO).reused).toBe(true);
  });

  it('survives a later tune/lock (keyed off matchedFrom, not voiceState)', () => {
    expect(
      resolveVoiceStatus(char({ voiceState: 'tuned', matchedFrom }), undefined, KOKORO).reused,
    ).toBe(true);
    expect(
      resolveVoiceStatus(char({ voiceState: 'locked', matchedFrom }), undefined, KOKORO).reused,
    ).toBe(true);
  });

  it('is false for a character with no match provenance', () => {
    expect(resolveVoiceStatus(char({ voiceState: 'generated' }), undefined, KOKORO).reused).toBe(
      false,
    );
  });

  it('coexists with the lifecycle pill — a reused Qwen voice yields both', () => {
    const c = char({ voiceState: 'reused', matchedFrom });
    const v = voice({
      generated: true,
      ttsVoice: { provider: 'qwen', name: 'qwen-narrator', description: 'Designed voice' },
    });
    const status = resolveVoiceStatus(c, v, QWEN);
    expect(status.lifecycle).toEqual({ label: 'Generated', color: 'success' });
    expect(status.reused).toBe(true);
  });
});

describe('statusFilterKeys — cast-view filter keys', () => {
  it('keys an undesigned Qwen character as "Needs voice"', () => {
    expect(statusFilterKeys(char({}), undefined, QWEN)).toEqual(['Needs voice']);
  });

  it('keys a generated Qwen voice as "Generated"', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'qwen-x' } } });
    expect(statusFilterKeys(c, voice({ generated: true }), QWEN)).toEqual(['Generated']);
  });

  it('keys a preset matched character as "Matched"', () => {
    expect(statusFilterKeys(char({ voiceState: 'generated' }), undefined, KOKORO)).toEqual([
      'Matched',
    ]);
  });

  it('keys a stateless preset row as "Unset"', () => {
    expect(statusFilterKeys(char({}), undefined, KOKORO)).toEqual(['Unset']);
  });

  it('appends "Reused" when the voice was matched from a prior book', () => {
    expect(statusFilterKeys(char({ voiceState: 'generated', matchedFrom }), undefined, KOKORO)).toEqual([
      'Matched',
      'Reused',
    ]);
  });

  it('keys a designed Qwen character with an unmet in-use emotion as "Needs variants"', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'qwen-x', variants: {} } } });
    const used = new Set(['angry']);
    expect(statusFilterKeys(c, voice({ generated: true }), QWEN, used)).toEqual([
      'Generated',
      'Needs variants',
    ]);
  });

  it('omits "Needs variants" when every in-use emotion has a designed variant', () => {
    const c = char({
      overrideTtsVoices: { qwen: { name: 'qwen-x', variants: { angry: { name: 'qwen-x-angry' } } } },
    });
    // character has 1 designed variant (→ 'Variants' key) but all in-use emotions are covered
    // (→ no 'Needs variants' key)
    expect(statusFilterKeys(c, voice({ generated: true }), QWEN, new Set(['angry']))).toEqual([
      'Generated',
      'Variants',
    ]);
  });

  it('keys both "Variants" and "Needs variants" for a partially-designed character', () => {
    // Realistic mid-design state: angry/sad designed, surprised still in use but unmet.
    const c = char({
      overrideTtsVoices: {
        qwen: {
          name: 'qwen-x',
          variants: { angry: { name: 'qwen-x-angry' }, sad: { name: 'qwen-x-sad' } },
        },
      },
    });
    expect(
      statusFilterKeys(c, voice({ generated: true }), QWEN, new Set(['angry', 'sad', 'surprised'])),
    ).toEqual(['Generated', 'Variants', 'Needs variants']);
  });

  it('omits "Needs variants" when usedEmotions is undefined', () => {
    const c = char({ overrideTtsVoices: { qwen: { name: 'qwen-x', variants: {} } } });
    expect(statusFilterKeys(c, voice({ generated: true }), QWEN)).toEqual(['Generated']);
  });

  it('never keys "Needs variants" for a non-Qwen character', () => {
    const c = char({ voiceState: 'generated' });
    expect(statusFilterKeys(c, undefined, KOKORO, new Set(['angry']))).toEqual(['Matched']);
  });
});

describe('fs-25 — hasEmotionVariants (additive Variants badge + filter)', () => {
  const withVariants = char({
    overrideTtsVoices: {
      qwen: { name: 'qwen-c1', variants: { angry: { name: 'qwen-c1__angry' } } },
    },
  }) as Character;
  const noVariants = char({ overrideTtsVoices: { qwen: { name: 'qwen-c1' } } }) as Character;

  it('is true only when the qwen slot has ≥1 variant, and reports the count', () => {
    const a = resolveVoiceStatus(withVariants, undefined, QWEN);
    expect(a.hasEmotionVariants).toBe(true);
    expect(a.variantCount).toBe(1);
    const b = resolveVoiceStatus(noVariants, undefined, QWEN);
    expect(b.hasEmotionVariants).toBe(false);
    expect(b.variantCount).toBe(0);
  });

  it('is additive — it does NOT change the lifecycle pill or the reused badge', () => {
    const withVar = resolveVoiceStatus(
      char({
        voiceState: 'generated',
        matchedFrom,
        overrideTtsVoices: { qwen: { name: 'qwen-c1', variants: { sad: { name: 'x' } } } },
      }) as Character,
      undefined,
      QWEN,
    );
    // lifecycle (Designed/Generated…) + reused are unchanged; variants rides alongside.
    expect(withVar.reused).toBe(true);
    expect(withVar.lifecycle).not.toBeNull();
    expect(withVar.hasEmotionVariants).toBe(true);
  });

  it('adds a "Variants" filter key only when variants exist', () => {
    expect(statusFilterKeys(withVariants, undefined, QWEN)).toContain('Variants');
    expect(statusFilterKeys(noVariants, undefined, QWEN)).not.toContain('Variants');
  });
});

describe('fs-34 — usedEmotionsByCharacter + countMissingVariants', () => {
  const sentence = (characterId: string, emotion?: string): Sentence =>
    ({ id: Math.random(), chapterId: 1, characterId, text: 'x', emotion } as unknown as Sentence);

  it('indexes the distinct non-neutral emotions each character uses', () => {
    const map = usedEmotionsByCharacter([
      sentence('wren', 'angry'),
      sentence('wren', 'angry'),
      sentence('wren', 'whisper'),
      sentence('wren', 'neutral'),
      sentence('marlow'),
      sentence('marlow', 'excited'),
    ]);
    expect([...(map.get('wren') ?? [])].sort()).toEqual(['angry', 'whisper']);
    expect([...(map.get('marlow') ?? [])]).toEqual(['excited']);
  });

  it('counts used emotions that lack a designed variant', () => {
    const c = char({
      id: 'wren',
      overrideTtsVoices: { qwen: { name: 'qwen-wren', variants: { angry: { name: 'x' } } } },
    });
    const used = new Set(['angry', 'whisper', 'sad']);
    // angry is designed; whisper + sad are missing.
    expect(countMissingVariants(c, used)).toBe(2);
  });

  it('returns 0 when the character uses no emotions or all are designed', () => {
    const c = char({ id: 'wren' });
    expect(countMissingVariants(c, undefined)).toBe(0);
    expect(countMissingVariants(c, new Set())).toBe(0);
    const allDesigned = char({
      id: 'wren',
      overrideTtsVoices: { qwen: { name: 'q', variants: { angry: { name: 'a' } } } },
    });
    expect(countMissingVariants(allDesigned, new Set(['angry']))).toBe(0);
  });
});
