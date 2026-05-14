/* Pairs with docs/features/06-analyzer-gemini.md — minor-cast fold pass. */

import { describe, it, expect } from 'vitest';
import { foldMinorCast } from './fold-minor-cast.js';
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';

function makeChar(id: string, overrides: Partial<CharacterOutput> = {}): CharacterOutput {
  return { id, name: id, role: 'role', color: 'slot-4', ...overrides };
}

function makeSentences(spec: Array<[number, string]>): SentenceOutput[] {
  /* Each tuple is [chapterId, characterId]; ids increment naturally. */
  return spec.map(([chapterId, characterId], i) => ({
    id: i + 1,
    chapterId,
    characterId,
    text: `Sentence ${i + 1}.`,
  }));
}

describe('foldMinorCast', () => {
  it('is a no-op when no character qualifies (everyone speaks ≥ minLines, no Unknown names)', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('sophie', { name: 'Sophie',          gender: 'female' }),
      makeChar('keefe',  { name: 'Keefe Sencen',    gender: 'male'   }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'], [1, 'narrator'], [1, 'narrator'],
      [1, 'sophie'],   [1, 'sophie'],   [2, 'sophie'],   [2, 'sophie'],
      [1, 'keefe'],    [2, 'keefe'],    [3, 'keefe'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({});
    expect(result.summary.foldedCount).toBe(0);
    /* Preserve referential identity on no-op to avoid downstream churn. */
    expect(result.characters).toBe(chars);
    expect(result.sentences).toBe(sentences);
  });

  it('folds an "Unknown Jogger" with male gender into unknown-male regardless of line count', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('sophie',           { name: 'Sophie',          gender: 'female' }),
      makeChar('unknown-jogger',   { name: 'Unknown Jogger',  gender: 'male'   }),
    ];
    /* Jogger speaks 10 lines but is still rolled up — the "Unknown" name
       trigger is independent of line count, since the analyzer flagged
       them as nameless. */
    const joggerLines = Array.from({ length: 10 }, () => [1, 'unknown-jogger'] as [number, string]);
    const sentences = makeSentences([
      [1, 'sophie'], [1, 'sophie'], [1, 'sophie'], [1, 'sophie'],
      ...joggerLines,
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'unknown-jogger': 'unknown-male' });
    expect(result.characters.map(c => c.id)).toEqual([
      'narrator', 'sophie', 'unknown-male',
    ]);
    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    expect(bucket.name).toBe('Unknown male');
    expect(bucket.aliases).toEqual(['Unknown Jogger']);
    expect(bucket.lines).toBe(10);
    expect(bucket.scenes).toBe(1);
    /* No remaining references to the folded source. */
    expect(result.sentences.some(s => s.characterId === 'unknown-jogger')).toBe(false);
    expect(result.sentences.filter(s => s.characterId === 'unknown-male').length).toBe(10);
  });

  it('folds an Unknown with no gender into unknown-male (default bias — narrator is never a fold target)', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('unknown-intruder', { name: 'Unknown Intruder' }),  // no gender
    ];
    const sentences = makeSentences([
      [3, 'narrator'], [3, 'narrator'],
      [3, 'unknown-intruder'], [3, 'unknown-intruder'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'unknown-intruder': 'unknown-male' });
    expect(result.characters.map(c => c.id)).toEqual(['narrator', 'unknown-male']);
    /* The new bucket — NOT the narrator — picks up the alias and the
       rewritten sentence count. Narrator is left alone. */
    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Unknown Intruder']);
    expect(bucket.lines).toBe(2);
    const narrator = result.characters.find(c => c.id === 'narrator')!;
    expect(narrator.aliases ?? []).toEqual([]);
    expect(narrator.lines).toBe(2);
  });

  it('folds a named character with too few lines into the matching bucket', () => {
    /* "Sandor" is named and not "Unknown", but only speaks once in the
       whole book — not worth a dedicated voice profile. */
    const chars = [
      makeChar('narrator'),
      makeChar('sophie', { name: 'Sophie',       gender: 'female' }),
      makeChar('sandor', { name: 'Sandor',       gender: 'male'   }),
    ];
    const sentences = makeSentences([
      [1, 'sophie'], [1, 'sophie'], [1, 'sophie'],
      [5, 'sandor'],  // single line
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'sandor': 'unknown-male' });
    expect(result.characters.find(c => c.id === 'sandor')).toBeUndefined();
    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Sandor']);
    expect(bucket.lines).toBe(1);
  });

  it('never folds narrator even with 0 attributed lines', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('sophie', { name: 'Sophie', gender: 'female' }),
    ];
    /* Narrator has zero attributions in this synthetic case but must
       still survive — downstream code (stage 2 prompt, voice picker)
       relies on narrator's presence. */
    const sentences = makeSentences([
      [1, 'sophie'], [1, 'sophie'], [1, 'sophie'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.characters.find(c => c.id === 'narrator')).toBeDefined();
    expect(result.rewrites).toEqual({});
  });

  it('rolls multiple folded sources into a single bucket with aliases preserving each name and any pre-existing aliases', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('sophie', { name: 'Sophie', gender: 'female' }),
      makeChar('unknown-jogger',  { name: 'Unknown Jogger',  gender: 'male'   }),
      makeChar('unknown-shopkeep',{ name: 'Unknown Shopkeep',gender: 'male', aliases: ['The Shopkeeper'] }),
      makeChar('sandor',          { name: 'Sandor',          gender: 'male' }),  // ≤ minLines
    ];
    const sentences = makeSentences([
      [1, 'sophie'], [1, 'sophie'], [1, 'sophie'], [1, 'sophie'],
      [2, 'unknown-jogger'],
      [3, 'unknown-shopkeep'],
      [4, 'sandor'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Unknown Jogger', 'Unknown Shopkeep', 'The Shopkeeper', 'Sandor']);
    expect(bucket.lines).toBe(3);
    expect(bucket.scenes).toBe(3); // chapters 2, 3, 4
    expect(result.summary).toEqual({ foldedCount: 3, intoMale: 3, intoFemale: 0 });
  });

  it('is idempotent — running on already-folded output produces the same result', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('sophie', { name: 'Sophie', gender: 'female' }),
      makeChar('unknown-jogger', { name: 'Unknown Jogger', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'sophie'], [1, 'sophie'], [1, 'sophie'],
      [1, 'unknown-jogger'],
    ]);
    const first  = foldMinorCast(chars, sentences, { minLines: 3 });
    const second = foldMinorCast(first.characters, first.sentences, { minLines: 3 });

    expect(second.rewrites).toEqual({});
    expect(second.characters.map(c => c.id).sort()).toEqual(first.characters.map(c => c.id).sort());
    expect(second.characters.find(c => c.id === 'unknown-male')!.aliases).toEqual(['Unknown Jogger']);
  });

  it('keeps the two buckets distinct: female folds go to unknown-female, male folds to unknown-male', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('keefe', { name: 'Keefe Sencen', gender: 'male' }),
      makeChar('unknown-woman', { name: 'Unknown Woman', gender: 'female' }),
      makeChar('marella',       { name: 'Marella',       gender: 'female' }),  // 1 line
      makeChar('unknown-runner',{ name: 'Unknown Runner',gender: 'male' }),    // 1 line
    ];
    const sentences = makeSentences([
      [1, 'keefe'], [1, 'keefe'], [1, 'keefe'],
      [2, 'unknown-woman'],
      [3, 'marella'],
      [4, 'unknown-runner'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({
      'unknown-woman':  'unknown-female',
      'marella':        'unknown-female',
      'unknown-runner': 'unknown-male',
    });
    /* Two distinct minor-cast survivors. */
    const female = result.characters.find(c => c.id === 'unknown-female')!;
    const male   = result.characters.find(c => c.id === 'unknown-male')!;
    expect(female.aliases).toEqual(['Unknown Woman', 'Marella']);
    expect(male.aliases).toEqual(['Unknown Runner']);
    expect(female.name).toBe('Unknown female');
    expect(male.name).toBe('Unknown male');
    expect(result.summary).toEqual({ foldedCount: 3, intoMale: 1, intoFemale: 2 });
  });

  it('minLines: 0 disables the line-count trigger — only Unknown-named characters fold', () => {
    /* User opted out of the sentence-count threshold via the account
       view. Named bystanders with 1 line should stay on the roster. */
    const chars = [
      makeChar('narrator'),
      makeChar('sophie',           { name: 'Sophie',          gender: 'female' }),
      makeChar('sandor',           { name: 'Sandor',          gender: 'male' }),  // 1 line
      makeChar('unknown-jogger',   { name: 'Unknown Jogger',  gender: 'male' }),  // 1 line
    ];
    const sentences = makeSentences([
      [1, 'sophie'], [1, 'sophie'], [1, 'sophie'],
      [2, 'sandor'],
      [3, 'unknown-jogger'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 0 });

    /* Sandor stayed; only Unknown Jogger folded. */
    expect(result.rewrites).toEqual({ 'unknown-jogger': 'unknown-male' });
    expect(result.characters.map(c => c.id).sort()).toEqual(
      ['narrator', 'sandor', 'sophie', 'unknown-male'],
    );
  });

  it('honours a custom minLines higher than the default — wider net catches mid-tier speakers', () => {
    /* User cranked minLines up to 5 to be aggressive about pruning the
       cast list down to the principals only. */
    const chars = [
      makeChar('narrator'),
      makeChar('sophie',  { name: 'Sophie',        gender: 'female' }),  // 8 lines — keeps
      makeChar('keefe',   { name: 'Keefe Sencen',  gender: 'male'   }),  // 4 lines — folds
    ];
    const sentences = makeSentences([
      ...Array.from({ length: 8 }, () => [1, 'sophie'] as [number, string]),
      ...Array.from({ length: 4 }, () => [2, 'keefe']  as [number, string]),
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 5 });

    expect(result.rewrites).toEqual({ 'keefe': 'unknown-male' });
    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Keefe Sencen']);
    expect(bucket.lines).toBe(4);
  });

  it('dedups bucket aliases case-insensitively and never adds the bucket\'s own name', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('unknown-a', { name: 'Sandor',         gender: 'male' }),
      makeChar('unknown-b', { name: 'SANDOR',         gender: 'male' }),
      makeChar('unknown-c', { name: 'Unknown male',   gender: 'male' }),  // pathological — collides with bucket title
    ];
    const sentences = makeSentences([
      [1, 'unknown-a'], [1, 'unknown-b'], [1, 'unknown-c'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    /* First-name-wins, case-insensitive dedup against the survivor's
       aliases AND own name. */
    expect(bucket.aliases).toEqual(['Sandor']);
  });
});
