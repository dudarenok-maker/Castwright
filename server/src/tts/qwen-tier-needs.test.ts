/* chapterQwenTierNeeds, cases H1-H11 of plan 293 §5.1 (#1393).
   The parity test against the real `synthesiseChapter` is task #4551 and is
   outside this file by design. */
import { describe, it, expect } from 'vitest';
import { chapterQwenTierNeeds, type ChapterQwenTierNeedsInput } from './qwen-tier-needs.js';
import { computeQwenKokoroFallbackSet } from './qwen-fallback-set.js';
import type { CastCharacter } from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';

const T06 = 'qwen3-tts-0.6b';
const T17 = 'qwen3-tts-1.7b';
const NONE = { keep06: false, keep17: false };

const designed = { qwen: { name: 'qwen-voice' } };
const chr = (id: string, over: Partial<CastCharacter> = {}): CastCharacter => ({
  id,
  name: id,
  ttsEngine: 'qwen',
  overrideTtsVoices: designed,
  ...over,
});
let nextId = 1;
const sent = (characterId: string, over: Partial<SentenceOutput> = {}): SentenceOutput => ({
  id: nextId++,
  chapterId: 1,
  characterId,
  text: 'Hello there, said the voice.',
  ...over,
});
const needs = (over: Partial<ChapterQwenTierNeedsInput>) =>
  chapterQwenTierNeeds({
    sentences: [],
    cast: [],
    defaultEngine: 'qwen',
    runQwenModelKey: T17,
    qwenUnavailable: false,
    includesTitleBeat: false,
    ...over,
  });

describe('chapterQwenTierNeeds', () => {
  it('H1: a silent unpinned Qwen character does not pin its tier', () => {
    const cast = [chr('narrator', { ttsModelKey: T17 }), chr('ghost')];
    expect(needs({ cast, runQwenModelKey: T06, sentences: [sent('narrator')] })).toEqual({
      keep06: false,
      keep17: true,
    });
  });

  it('H2: the only Qwen speaker has no designed voice and no variants', () => {
    const cast = [chr('narrator', { overrideTtsVoices: undefined })];
    expect(needs({ cast, sentences: [sent('narrator')] })).toEqual(NONE);
  });

  it('H3: qwenUnavailable keeps nothing', () => {
    const cast = [chr('narrator')];
    expect(needs({ cast, sentences: [sent('narrator')], qwenUnavailable: true })).toEqual(NONE);
  });

  it('H4: a Qwen narrator with no sentences counts only with the title beat', () => {
    const cast = [chr('narrator')];
    expect(needs({ cast, runQwenModelKey: T06, includesTitleBeat: true })).toEqual({
      keep06: true,
      keep17: false,
    });
    expect(needs({ cast, runQwenModelKey: T06, includesTitleBeat: false })).toEqual(NONE);
  });

  it('H5: a group id not in the cast falls back to the narrator tier', () => {
    const cast = [chr('narrator', { ttsModelKey: T17 })];
    expect(needs({ cast, runQwenModelKey: T06, sentences: [sent('stranger')] })).toEqual({
      keep06: false,
      keep17: true,
    });
  });

  it('H6: a retired id mapped to a live 1.7B character resolves through castIdHistory', () => {
    const cast = [chr('narrator', { ttsEngine: 'kokoro' }), chr('wren', { ttsModelKey: T17 })];
    expect(
      needs({
        cast,
        runQwenModelKey: T06,
        castIdHistory: { supersededBy: { 'old-wren': 'wren' } },
        sentences: [sent('old-wren')],
      }),
    ).toEqual({ keep06: false, keep17: true });
  });

  it('H7: a character pinned 0.6B in a 1.7B run renders on 1.7B (elevate-only)', () => {
    const cast = [chr('narrator', { ttsModelKey: T06 })];
    expect(needs({ cast, runQwenModelKey: T17, sentences: [sent('narrator')] })).toEqual({
      keep06: false,
      keep17: true,
    });
  });

  it('H8: a 1.7B character whose only sentences are excluded is not kept', () => {
    const cast = [chr('narrator', { ttsEngine: 'kokoro' }), chr('wren', { ttsModelKey: T17 })];
    const sentences = [sent('wren', { excludeFromSynthesis: true })];
    expect(needs({ cast, runQwenModelKey: T06, sentences })).toEqual(NONE);
  });

  it('H9: a Kokoro-default run with one Qwen character keeps 0.6B', () => {
    const cast = [chr('narrator', { ttsEngine: undefined }), chr('wren')];
    expect(
      needs({ cast, defaultEngine: 'kokoro', runQwenModelKey: T06, sentences: [sent('wren')] }),
    ).toEqual({ keep06: true, keep17: false });
  });

  const variantOnly = (id: string, over: Partial<CastCharacter> = {}) =>
    chr(id, {
      overrideTtsVoices: { qwen: { name: '', variants: { angry: { name: 'qwen-v-angry' } } } },
      ...over,
    });

  it('H10: a 0.6B speaker with an empty base voice and one variant slot is kept', () => {
    const cast = [variantOnly('narrator')];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen').map((c) => c.id)).toEqual(['narrator']);
    expect(needs({ cast, runQwenModelKey: T06, sentences: [sent('narrator')] })).toEqual({
      keep06: true,
      keep17: false,
    });
  });

  it('H11: a 1.7B speaker with an empty base voice and one variant slot is not kept', () => {
    const cast = [variantOnly('narrator')];
    expect(computeQwenKokoroFallbackSet(cast, 'qwen').map((c) => c.id)).toEqual(['narrator']);
    expect(needs({ cast, runQwenModelKey: T17, sentences: [sent('narrator')] })).toEqual(NONE);
  });
});
