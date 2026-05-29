/* resolveVoiceStatus — the two-dimension Status resolver shared by the cast
   view's Status column and the profile drawer's Voice-profile header. Locks
   (a) the split that lets a reused Qwen voice read "Designed/Generated · Reused"
   instead of collapsing to a lone "Reused" pill, and (b) the effective-engine
   contract: a DEFAULT-engine character on a Qwen project follows the Qwen
   lifecycle ("Needs voice" when undesigned), not a stale preset pill. */

import { describe, it, expect } from 'vitest';
import { resolveVoiceStatus, statusFilterKeys } from './voice-status';
import type { Character, Voice, TtsEngine } from './types';

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
});
