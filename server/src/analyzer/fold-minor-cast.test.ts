/* Pairs with docs/features/06-analyzer-gemini.md — minor-cast fold pass. */

import { describe, it, expect } from 'vitest';
import { foldMinorCast, isDescriptorName } from './fold-minor-cast.js';
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
      makeChar('Wren', { name: 'Wren',          gender: 'female' }),
      makeChar('Marlow',  { name: 'Marlow Halden',    gender: 'male'   }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'], [1, 'narrator'], [1, 'narrator'],
      [1, 'Wren'],   [1, 'Wren'],   [2, 'Wren'],   [2, 'Wren'],
      [1, 'Marlow'],    [2, 'Marlow'],    [3, 'Marlow'],
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
      makeChar('Wren',           { name: 'Wren',          gender: 'female' }),
      makeChar('unknown-jogger',   { name: 'Unknown Jogger',  gender: 'male'   }),
    ];
    /* Jogger speaks 10 lines but is still rolled up — the "Unknown" name
       trigger is independent of line count, since the analyzer flagged
       them as nameless. */
    const joggerLines = Array.from({ length: 10 }, () => [1, 'unknown-jogger'] as [number, string]);
    const sentences = makeSentences([
      [1, 'Wren'], [1, 'Wren'], [1, 'Wren'], [1, 'Wren'],
      ...joggerLines,
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'unknown-jogger': 'unknown-male' });
    expect(result.characters.map(c => c.id)).toEqual([
      'narrator', 'Wren', 'unknown-male',
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
    /* "Garrow" is named and not "Unknown", but only speaks once in the
       whole book — not worth a dedicated voice profile. */
    const chars = [
      makeChar('narrator'),
      makeChar('Wren', { name: 'Wren',       gender: 'female' }),
      makeChar('Garrow', { name: 'Garrow',       gender: 'male'   }),
    ];
    const sentences = makeSentences([
      [1, 'Wren'], [1, 'Wren'], [1, 'Wren'],
      [5, 'Garrow'],  // single line
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'Garrow': 'unknown-male' });
    expect(result.characters.find(c => c.id === 'Garrow')).toBeUndefined();
    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Garrow']);
    expect(bucket.lines).toBe(1);
  });

  it('never folds narrator even with 0 attributed lines', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('Wren', { name: 'Wren', gender: 'female' }),
    ];
    /* Narrator has zero attributions in this synthetic case but must
       still survive — downstream code (stage 2 prompt, voice picker)
       relies on narrator's presence. */
    const sentences = makeSentences([
      [1, 'Wren'], [1, 'Wren'], [1, 'Wren'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.characters.find(c => c.id === 'narrator')).toBeDefined();
    expect(result.rewrites).toEqual({});
  });

  it('rolls multiple folded sources into a single bucket with aliases preserving each name and any pre-existing aliases', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('Wren', { name: 'Wren', gender: 'female' }),
      makeChar('unknown-jogger',  { name: 'Unknown Jogger',  gender: 'male'   }),
      makeChar('unknown-shopkeep',{ name: 'Unknown Shopkeep',gender: 'male', aliases: ['The Shopkeeper'] }),
      makeChar('Garrow',          { name: 'Garrow',          gender: 'male' }),  // ≤ minLines
    ];
    const sentences = makeSentences([
      [1, 'Wren'], [1, 'Wren'], [1, 'Wren'], [1, 'Wren'],
      [2, 'unknown-jogger'],
      [3, 'unknown-shopkeep'],
      [4, 'Garrow'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Unknown Jogger', 'Unknown Shopkeep', 'The Shopkeeper', 'Garrow']);
    expect(bucket.lines).toBe(3);
    expect(bucket.scenes).toBe(3); // chapters 2, 3, 4
    expect(result.summary).toEqual({ foldedCount: 3, intoMale: 3, intoFemale: 0, droppedSilent: 0 });
  });

  it('is idempotent — running on already-folded output produces the same result', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('Wren', { name: 'Wren', gender: 'female' }),
      makeChar('unknown-jogger', { name: 'Unknown Jogger', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'Wren'], [1, 'Wren'], [1, 'Wren'],
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
      makeChar('Marlow', { name: 'Marlow Halden', gender: 'male' }),
      makeChar('unknown-woman', { name: 'Unknown Woman', gender: 'female' }),
      makeChar('Edda',       { name: 'Edda',       gender: 'female' }),  // 1 line
      makeChar('unknown-runner',{ name: 'Unknown Runner',gender: 'male' }),    // 1 line
    ];
    const sentences = makeSentences([
      [1, 'Marlow'], [1, 'Marlow'], [1, 'Marlow'],
      [2, 'unknown-woman'],
      [3, 'Edda'],
      [4, 'unknown-runner'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({
      'unknown-woman':  'unknown-female',
      'Edda':        'unknown-female',
      'unknown-runner': 'unknown-male',
    });
    /* Two distinct minor-cast survivors. */
    const female = result.characters.find(c => c.id === 'unknown-female')!;
    const male   = result.characters.find(c => c.id === 'unknown-male')!;
    expect(female.aliases).toEqual(['Unknown Woman', 'Edda']);
    expect(male.aliases).toEqual(['Unknown Runner']);
    expect(female.name).toBe('Unknown female');
    expect(male.name).toBe('Unknown male');
    expect(result.summary).toEqual({ foldedCount: 3, intoMale: 1, intoFemale: 2, droppedSilent: 0 });
  });

  it('minLines: 0 disables the line-count trigger — only Unknown-named characters fold', () => {
    /* User opted out of the sentence-count threshold via the account
       view. Named bystanders with 1 line should stay on the roster. */
    const chars = [
      makeChar('narrator'),
      makeChar('Wren',           { name: 'Wren',          gender: 'female' }),
      makeChar('Garrow',           { name: 'Garrow',          gender: 'male' }),  // 1 line
      makeChar('unknown-jogger',   { name: 'Unknown Jogger',  gender: 'male' }),  // 1 line
    ];
    const sentences = makeSentences([
      [1, 'Wren'], [1, 'Wren'], [1, 'Wren'],
      [2, 'Garrow'],
      [3, 'unknown-jogger'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 0 });

    /* Garrow stayed; only Unknown Jogger folded. */
    expect(result.rewrites).toEqual({ 'unknown-jogger': 'unknown-male' });
    expect(result.characters.map(c => c.id).sort()).toEqual(
      ['narrator', 'Garrow', 'Wren', 'unknown-male'],
    );
  });

  it('honours a custom minLines higher than the default — wider net catches mid-tier speakers', () => {
    /* User cranked minLines up to 5 to be aggressive about pruning the
       cast list down to the principals only. */
    const chars = [
      makeChar('narrator'),
      makeChar('Wren',  { name: 'Wren',        gender: 'female' }),  // 8 lines — keeps
      makeChar('Marlow',   { name: 'Marlow Halden',  gender: 'male'   }),  // 4 lines — folds
    ];
    const sentences = makeSentences([
      ...Array.from({ length: 8 }, () => [1, 'Wren'] as [number, string]),
      ...Array.from({ length: 4 }, () => [2, 'Marlow']  as [number, string]),
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 5 });

    expect(result.rewrites).toEqual({ 'Marlow': 'unknown-male' });
    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Marlow Halden']);
    expect(bucket.lines).toBe(4);
  });

  it('drops zero-line non-narrator characters entirely (no voice profile, narrator covers them)', () => {
    /* Per-chapter detection sometimes slips pets, animals, or magical
       creatures onto the roster because the narrator describes their
       behaviour ("Marty purred"). Stage 2 attributes those onomatopoeic
       lines to the narrator, leaving the pet with zero attributed
       sentences. The fold pass drops such characters entirely so the
       cast doesn't accumulate non-speaking entries. */
    const chars = [
      makeChar('narrator'),
      makeChar('Wren',   { name: 'Wren',   gender: 'female' }),
      makeChar('marty',    { name: 'Marty',    gender: 'neutral' }),  // pet cat — 0 lines
      makeChar('verminion',{ name: 'Verminion',gender: 'neutral' }),  // imp — 0 lines
      makeChar('Rufus',    { name: 'Rufus',    gender: 'neutral' }),  // pet dinosaur — 0 lines
    ];
    const sentences = makeSentences([
      [1, 'narrator'], [1, 'narrator'], [1, 'narrator'],
      [1, 'Wren'],   [1, 'Wren'],   [1, 'Wren'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.characters.map(c => c.id).sort()).toEqual(['narrator', 'Wren']);
    expect(result.dropped.sort()).toEqual(['Marty', 'Rufus', 'Verminion']);
    expect(result.summary.droppedSilent).toBe(3);
    expect(result.summary.foldedCount).toBe(0);
    /* No unknown-male / unknown-female bucket — these aren't background
       speakers, they're non-speakers, so the narrator handles them. */
    expect(result.characters.find(c => c.id === 'unknown-male')).toBeUndefined();
    expect(result.characters.find(c => c.id === 'unknown-female')).toBeUndefined();
  });

  it('keeps an "Unknown <descriptor>" entry with 0 lines as a fold (analyzer-flagged minor speaker, not a non-speaker)', () => {
    /* "Unknown Jogger" with 0 attributed lines still folds rather than
       drops — the "Unknown" naming convention is a signal from the
       analyzer that this is a one-off speaker whose lines may have been
       missed during stage 2 attribution. The user-facing behaviour
       stays "fold into unknown-male" not "drop entirely". */
    const chars = [
      makeChar('narrator'),
      makeChar('Wren',         { name: 'Wren',         gender: 'female' }),
      makeChar('unknown-passer', { name: 'Unknown Passer', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, 'Wren'], [1, 'Wren'], [1, 'Wren'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'unknown-passer': 'unknown-male' });
    expect(result.summary.droppedSilent).toBe(0);
    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Unknown Passer']);
  });

  it('folds descriptor-named characters even when they speak ≥ minLines (The Jogger, Drooly Boy, Old Man)', () => {
    /* The Stage-1 prompt asks for "Unknown <descriptor>" but the model
       routinely emits the descriptor forms it sees in the manuscript
       ("The Jogger", "Drooly Boy", "Old Man"). Those are still
       descriptors — they shouldn't get their own voice profile even
       if they happen to clear the line-count threshold. */
    const chars = [
      makeChar('narrator'),
      makeChar('Wren',     { name: 'Wren',     gender: 'female' }),
      makeChar('the-jogger', { name: 'The Jogger', gender: 'male'   }),
      makeChar('drooly-boy', { name: 'Drooly Boy', gender: 'male'   }),
      makeChar('old-man',    { name: 'Old Man',    gender: 'male'   }),
      makeChar('tall-lady',  { name: 'Tall Lady',  gender: 'female' }),
    ];
    /* Each descriptor speaks 5 lines — past the minLines=3 threshold,
       so without the descriptor-pattern rule they'd survive. */
    const sentences = makeSentences([
      [1, 'Wren'], [1, 'Wren'], [1, 'Wren'],
      ...Array.from({ length: 5 }, () => [2, 'the-jogger'] as [number, string]),
      ...Array.from({ length: 5 }, () => [3, 'drooly-boy'] as [number, string]),
      ...Array.from({ length: 5 }, () => [4, 'old-man']    as [number, string]),
      ...Array.from({ length: 5 }, () => [5, 'tall-lady']  as [number, string]),
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({
      'the-jogger': 'unknown-male',
      'drooly-boy': 'unknown-male',
      'old-man':    'unknown-male',
      'tall-lady':  'unknown-female',
    });
    const male   = result.characters.find(c => c.id === 'unknown-male')!;
    const female = result.characters.find(c => c.id === 'unknown-female')!;
    expect(male.aliases).toEqual(['The Jogger', 'Drooly Boy', 'Old Man']);
    expect(female.aliases).toEqual(['Tall Lady']);
    expect(male.lines).toBe(15);
    expect(female.lines).toBe(5);
  });

  it('does NOT fold proper names that happen to share a tail word with a generic role ("Lady Wick", "Sir Astin")', () => {
    /* "Lady Wick" has "Lady" at the START — a title prefix, not the
       trailing role-word pattern. Same shape as "Sir Astin", "Dame
       Linnet", "Lord Vane". These are proper names and must NOT
       fold. */
    const chars = [
      makeChar('narrator'),
      makeChar('lady-Wick', { name: 'Lady Wick', gender: 'female' }),
      makeChar('sir-astin',   { name: 'Sir Astin',   gender: 'male'   }),
      makeChar('dame-Linnet',  { name: 'Dame Linnet',  gender: 'female' }),
    ];
    const sentences = makeSentences([
      [1, 'lady-Wick'], [1, 'lady-Wick'], [1, 'lady-Wick'],
      [2, 'sir-astin'],   [2, 'sir-astin'],   [2, 'sir-astin'],
      [3, 'dame-Linnet'],  [3, 'dame-Linnet'],  [3, 'dame-Linnet'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({});
    expect(result.characters.map(c => c.id).sort()).toEqual(
      ['dame-Linnet', 'lady-Wick', 'narrator', 'sir-astin'],
    );
  });

  it('isDescriptorName matrix', () => {
    /* Lock the patterns down individually so the matcher's contract is
       readable from the test file. */
    expect(isDescriptorName('Unknown Jogger')).toBe(true);
    expect(isDescriptorName('UNKNOWN Intruder')).toBe(true);
    expect(isDescriptorName('The Jogger')).toBe(true);
    expect(isDescriptorName('the stranger')).toBe(true);
    expect(isDescriptorName('The Old Man')).toBe(true);    // The <Word> <Word>
    expect(isDescriptorName('Drooly Boy')).toBe(true);
    expect(isDescriptorName('Ponytail Boy')).toBe(true);
    expect(isDescriptorName('Old Man')).toBe(true);
    expect(isDescriptorName('Tall Woman')).toBe(true);
    expect(isDescriptorName('Shy Girl')).toBe(true);
    /* Proper names — must NOT match. */
    expect(isDescriptorName('Wren')).toBe(false);
    expect(isDescriptorName('Lady Wick')).toBe(false);
    expect(isDescriptorName('Sir Astin')).toBe(false);
    expect(isDescriptorName('Dame Linnet')).toBe(false);
    expect(isDescriptorName('Mr. Marrow')).toBe(false);
    expect(isDescriptorName('Garwin Chang')).toBe(false);
    expect(isDescriptorName('Garrow')).toBe(false);
    /* Capped at two words after "The" so place-style names ("The
       Council of Twelve") don't fold. */
    expect(isDescriptorName('The Council of Twelve')).toBe(false);
    expect(isDescriptorName('')).toBe(false);
  });

  it('nameOnly: true folds descriptor names without any sentence data and skips the zero-line drop', () => {
    /* Preview-fold path used by the interim cast.json + live SSE
       cast-update. Stage-2 sentences don't exist yet, so the
       line-count fold and the zero-line drop have to stay off —
       otherwise every character would either fold or get dropped
       just because their `lines` count is 0. */
    const chars = [
      makeChar('narrator'),
      makeChar('Wren',     { name: 'Wren',         gender: 'female' }),
      makeChar('the-jogger', { name: 'The Jogger',     gender: 'male'   }),
      makeChar('drooly-boy', { name: 'Drooly Boy',     gender: 'male'   }),
      makeChar('Pib',       { name: 'Pib',           gender: 'neutral' }), // pet, 0 stage-2 lines but must SURVIVE in nameOnly mode
    ];
    const sentences: never[] = [];

    const result = foldMinorCast(chars, sentences, { nameOnly: true });

    expect(result.rewrites).toEqual({
      'the-jogger': 'unknown-male',
      'drooly-boy': 'unknown-male',
    });
    /* Pib and Wren both survive — nameOnly skips the zero-line
       drop so a pet that the verifier will later kill (Phase 0b) is
       still visible on the live roster until that point. */
    expect(result.characters.map(c => c.id).sort()).toEqual(
      ['Pib', 'narrator', 'Wren', 'unknown-male'],
    );
    const male = result.characters.find(c => c.id === 'unknown-male')!;
    expect(male.aliases).toEqual(['The Jogger', 'Drooly Boy']);
    expect(result.summary.droppedSilent).toBe(0);
  });

  it('dedups bucket aliases case-insensitively and never adds the bucket\'s own name', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('unknown-a', { name: 'Garrow',         gender: 'male' }),
      makeChar('unknown-b', { name: 'Garrow',         gender: 'male' }),
      makeChar('unknown-c', { name: 'Unknown male',   gender: 'male' }),  // pathological — collides with bucket title
    ];
    const sentences = makeSentences([
      [1, 'unknown-a'], [1, 'unknown-b'], [1, 'unknown-c'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    const bucket = result.characters.find(c => c.id === 'unknown-male')!;
    /* First-name-wins, case-insensitive dedup against the survivor's
       aliases AND own name. */
    expect(bucket.aliases).toEqual(['Garrow']);
  });
});
