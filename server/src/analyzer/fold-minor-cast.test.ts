/* Pairs with docs/features/archive/06-analyzer-gemini.md — minor-cast fold pass.
   Protected-role-exemption coverage added per
   docs/features/archive/97-narrator-only-named-characters.md. */

import { describe, it, expect } from 'vitest';
import {
  foldMinorCast,
  isDescriptorName,
  makeBucket,
  matchesProtectedRole,
  MALE_BUCKET_ID,
  FEMALE_BUCKET_ID,
  PROTECTED_ROLES_DEFAULT,
} from './fold-minor-cast.js';
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
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('marlow', { name: 'Marlow Halden', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, 'narrator'],
      [1, 'narrator'],
      [1, 'wren'],
      [1, 'wren'],
      [2, 'wren'],
      [2, 'wren'],
      [1, 'marlow'],
      [2, 'marlow'],
      [3, 'marlow'],
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
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('unknown-jogger', { name: 'Unknown Jogger', gender: 'male' }),
    ];
    /* Jogger speaks 10 lines but is still rolled up — the "Unknown" name
       trigger is independent of line count, since the analyzer flagged
       them as nameless. */
    const joggerLines = Array.from({ length: 10 }, () => [1, 'unknown-jogger'] as [number, string]);
    const sentences = makeSentences([
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
      ...joggerLines,
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'unknown-jogger': 'unknown-male' });
    expect(result.characters.map((c) => c.id)).toEqual(['narrator', 'wren', 'unknown-male']);
    const bucket = result.characters.find((c) => c.id === 'unknown-male')!;
    expect(bucket.name).toBe('Unknown male');
    expect(bucket.aliases).toEqual(['Unknown Jogger']);
    expect(bucket.lines).toBe(10);
    expect(bucket.scenes).toBe(1);
    /* No remaining references to the folded source. */
    expect(result.sentences.some((s) => s.characterId === 'unknown-jogger')).toBe(false);
    expect(result.sentences.filter((s) => s.characterId === 'unknown-male').length).toBe(10);
  });

  it('folds an Unknown with no gender into unknown-male (default bias — narrator is never a fold target)', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('unknown-intruder', { name: 'Unknown Intruder' }), // no gender
    ];
    const sentences = makeSentences([
      [3, 'narrator'],
      [3, 'narrator'],
      [3, 'unknown-intruder'],
      [3, 'unknown-intruder'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'unknown-intruder': 'unknown-male' });
    expect(result.characters.map((c) => c.id)).toEqual(['narrator', 'unknown-male']);
    /* The new bucket — NOT the narrator — picks up the alias and the
       rewritten sentence count. Narrator is left alone. */
    const bucket = result.characters.find((c) => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Unknown Intruder']);
    expect(bucket.lines).toBe(2);
    const narrator = result.characters.find((c) => c.id === 'narrator')!;
    expect(narrator.aliases ?? []).toEqual([]);
    expect(narrator.lines).toBe(2);
  });

  it('folds a named character with too few lines into the matching bucket', () => {
    /* "Garrow" is named and not "Unknown", but only speaks once in the
       whole book — not worth a dedicated voice profile. */
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('garrow', { name: 'Garrow', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
      [5, 'garrow'], // single line
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ garrow: 'unknown-male' });
    expect(result.characters.find((c) => c.id === 'garrow')).toBeUndefined();
    const bucket = result.characters.find((c) => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Garrow']);
    expect(bucket.lines).toBe(1);
  });

  it('never folds narrator even with 0 attributed lines', () => {
    const chars = [makeChar('narrator'), makeChar('wren', { name: 'Wren', gender: 'female' })];
    /* Narrator has zero attributions in this synthetic case but must
       still survive — downstream code (stage 2 prompt, voice picker)
       relies on narrator's presence. */
    const sentences = makeSentences([
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.characters.find((c) => c.id === 'narrator')).toBeDefined();
    expect(result.rewrites).toEqual({});
  });

  it('rolls multiple folded sources into a single bucket with aliases preserving each name and any pre-existing aliases', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('unknown-jogger', { name: 'Unknown Jogger', gender: 'male' }),
      makeChar('unknown-shopkeep', {
        name: 'Unknown Shopkeep',
        gender: 'male',
        aliases: ['The Shopkeeper'],
      }),
      makeChar('garrow', { name: 'Garrow', gender: 'male' }), // ≤ minLines
    ];
    const sentences = makeSentences([
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
      [2, 'unknown-jogger'],
      [3, 'unknown-shopkeep'],
      [4, 'garrow'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    const bucket = result.characters.find((c) => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual([
      'Unknown Jogger',
      'Unknown Shopkeep',
      'The Shopkeeper',
      'Garrow',
    ]);
    expect(bucket.lines).toBe(3);
    expect(bucket.scenes).toBe(3); // chapters 2, 3, 4
    expect(result.summary).toEqual({
      foldedCount: 3,
      intoMale: 3,
      intoFemale: 0,
      droppedSilent: 0,
    });
  });

  it('is idempotent — running on already-folded output produces the same result', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('unknown-jogger', { name: 'Unknown Jogger', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
      [1, 'unknown-jogger'],
    ]);
    const first = foldMinorCast(chars, sentences, { minLines: 3 });
    const second = foldMinorCast(first.characters, first.sentences, { minLines: 3 });

    expect(second.rewrites).toEqual({});
    expect(second.characters.map((c) => c.id).sort()).toEqual(
      first.characters.map((c) => c.id).sort(),
    );
    expect(second.characters.find((c) => c.id === 'unknown-male')!.aliases).toEqual([
      'Unknown Jogger',
    ]);
  });

  it('keeps the two buckets distinct: female folds go to unknown-female, male folds to unknown-male', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('marlow', { name: 'Marlow Halden', gender: 'male' }),
      makeChar('unknown-woman', { name: 'Unknown Woman', gender: 'female' }),
      makeChar('edda', { name: 'Edda', gender: 'female' }), // 1 line
      makeChar('unknown-runner', { name: 'Unknown Runner', gender: 'male' }), // 1 line
    ];
    const sentences = makeSentences([
      [1, 'marlow'],
      [1, 'marlow'],
      [1, 'marlow'],
      [2, 'unknown-woman'],
      [3, 'edda'],
      [4, 'unknown-runner'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({
      'unknown-woman': 'unknown-female',
      edda: 'unknown-female',
      'unknown-runner': 'unknown-male',
    });
    /* Two distinct minor-cast survivors. */
    const female = result.characters.find((c) => c.id === 'unknown-female')!;
    const male = result.characters.find((c) => c.id === 'unknown-male')!;
    expect(female.aliases).toEqual(['Unknown Woman', 'Edda']);
    expect(male.aliases).toEqual(['Unknown Runner']);
    expect(female.name).toBe('Unknown female');
    expect(male.name).toBe('Unknown male');
    expect(result.summary).toEqual({
      foldedCount: 3,
      intoMale: 1,
      intoFemale: 2,
      droppedSilent: 0,
    });
  });

  it('minLines: 0 disables the line-count trigger — only Unknown-named characters fold', () => {
    /* User opted out of the sentence-count threshold via the account
       view. Named bystanders with 1 line should stay on the roster. */
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('garrow', { name: 'Garrow', gender: 'male' }), // 1 line
      makeChar('unknown-jogger', { name: 'Unknown Jogger', gender: 'male' }), // 1 line
    ];
    const sentences = makeSentences([
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
      [2, 'garrow'],
      [3, 'unknown-jogger'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 0 });

    /* Garrow stayed; only Unknown Jogger folded. */
    expect(result.rewrites).toEqual({ 'unknown-jogger': 'unknown-male' });
    expect(result.characters.map((c) => c.id).sort()).toEqual([
      'garrow',
      'narrator',
      'unknown-male',
      'wren',
    ]);
  });

  it('honours a custom minLines higher than the default — wider net catches mid-tier speakers', () => {
    /* User cranked minLines up to 5 to be aggressive about pruning the
       cast list down to the principals only. */
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }), // 8 lines — keeps
      makeChar('marlow', { name: 'Marlow Halden', gender: 'male' }), // 4 lines — folds
    ];
    const sentences = makeSentences([
      ...Array.from({ length: 8 }, () => [1, 'wren'] as [number, string]),
      ...Array.from({ length: 4 }, () => [2, 'marlow'] as [number, string]),
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 5 });

    expect(result.rewrites).toEqual({ marlow: 'unknown-male' });
    const bucket = result.characters.find((c) => c.id === 'unknown-male')!;
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
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('marty', { name: 'Marty', gender: 'neutral' }), // pet cat — 0 lines
      makeChar('verminion', { name: 'Verminion', gender: 'neutral' }), // imp — 0 lines
      makeChar('rufus', { name: 'Rufus', gender: 'neutral' }), // pet dinosaur — 0 lines
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, 'narrator'],
      [1, 'narrator'],
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.characters.map((c) => c.id).sort()).toEqual(['narrator', 'wren']);
    expect(result.dropped.sort()).toEqual(['Marty', 'Rufus', 'Verminion']);
    expect(result.summary.droppedSilent).toBe(3);
    expect(result.summary.foldedCount).toBe(0);
    /* No unknown-male / unknown-female bucket — these aren't background
       speakers, they're non-speakers, so the narrator handles them. */
    expect(result.characters.find((c) => c.id === 'unknown-male')).toBeUndefined();
    expect(result.characters.find((c) => c.id === 'unknown-female')).toBeUndefined();
  });

  it('keeps a 0-line character whose name the prose explicitly tags (#537 — stage-2 stranded their line on narrator)', () => {
    /* A `"…," Behnam noted.` tag means Behnam genuinely speaks; if stage-2 left
       his quote on the narrator he has 0 attributed lines, but he must NOT be
       dropped — the fold treats a prose-tagged 0-line speaker as a stage-2
       failure, not a non-speaker. */
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('behnam', { name: 'Behnam Aria', gender: 'male' }), // 0 lines, but tagged
    ];
    const sentences: SentenceOutput[] = [
      { id: 1, chapterId: 1, characterId: 'wren', text: '“Hi there,”' },
      { id: 2, chapterId: 1, characterId: 'wren', text: 'Wren said brightly.' },
      { id: 3, chapterId: 1, characterId: 'wren', text: '“Anyone home?”' },
      { id: 4, chapterId: 1, characterId: 'narrator', text: '“That would be easier to believe,”' },
      { id: 5, chapterId: 1, characterId: 'narrator', text: 'Behnam noted.' },
    ];
    const result = foldMinorCast(chars, sentences, { minLines: 3 });
    expect(result.characters.map((c) => c.id)).toContain('behnam');
    expect(result.dropped).not.toContain('Behnam Aria');
    expect(result.summary.droppedSilent).toBe(0);
  });

  it('keeps an "Unknown <descriptor>" entry with 0 lines as a fold (analyzer-flagged minor speaker, not a non-speaker)', () => {
    /* "Unknown Jogger" with 0 attributed lines still folds rather than
       drops — the "Unknown" naming convention is a signal from the
       analyzer that this is a one-off speaker whose lines may have been
       missed during stage 2 attribution. The user-facing behaviour
       stays "fold into unknown-male" not "drop entirely". */
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('unknown-passer', { name: 'Unknown Passer', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'unknown-passer': 'unknown-male' });
    expect(result.summary.droppedSilent).toBe(0);
    const bucket = result.characters.find((c) => c.id === 'unknown-male')!;
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
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('the-jogger', { name: 'The Jogger', gender: 'male' }),
      makeChar('drooly-boy', { name: 'Drooly Boy', gender: 'male' }),
      makeChar('old-man', { name: 'Old Man', gender: 'male' }),
      makeChar('tall-lady', { name: 'Tall Lady', gender: 'female' }),
    ];
    /* Each descriptor speaks 5 lines — past the minLines=3 threshold,
       so without the descriptor-pattern rule they'd survive. */
    const sentences = makeSentences([
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
      ...Array.from({ length: 5 }, () => [2, 'the-jogger'] as [number, string]),
      ...Array.from({ length: 5 }, () => [3, 'drooly-boy'] as [number, string]),
      ...Array.from({ length: 5 }, () => [4, 'old-man'] as [number, string]),
      ...Array.from({ length: 5 }, () => [5, 'tall-lady'] as [number, string]),
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({
      'the-jogger': 'unknown-male',
      'drooly-boy': 'unknown-male',
      'old-man': 'unknown-male',
      'tall-lady': 'unknown-female',
    });
    const male = result.characters.find((c) => c.id === 'unknown-male')!;
    const female = result.characters.find((c) => c.id === 'unknown-female')!;
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
      makeChar('lady-wick', { name: 'Lady Wick', gender: 'female' }),
      makeChar('sir-astin', { name: 'Sir Astin', gender: 'male' }),
      makeChar('dame-linnet', { name: 'Dame Linnet', gender: 'female' }),
    ];
    const sentences = makeSentences([
      [1, 'lady-wick'],
      [1, 'lady-wick'],
      [1, 'lady-wick'],
      [2, 'sir-astin'],
      [2, 'sir-astin'],
      [2, 'sir-astin'],
      [3, 'dame-linnet'],
      [3, 'dame-linnet'],
      [3, 'dame-linnet'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({});
    expect(result.characters.map((c) => c.id).sort()).toEqual([
      'dame-linnet',
      'lady-wick',
      'narrator',
      'sir-astin',
    ]);
  });

  it('isDescriptorName matrix', () => {
    /* Lock the patterns down individually so the matcher's contract is
       readable from the test file. */
    expect(isDescriptorName('Unknown Jogger')).toBe(true);
    expect(isDescriptorName('UNKNOWN Intruder')).toBe(true);
    expect(isDescriptorName('The Jogger')).toBe(true);
    expect(isDescriptorName('the stranger')).toBe(true);
    expect(isDescriptorName('The Old Man')).toBe(true); // The <Word> <Word>
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
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('the-jogger', { name: 'The Jogger', gender: 'male' }),
      makeChar('drooly-boy', { name: 'Drooly Boy', gender: 'male' }),
      makeChar('pib', { name: 'Pib', gender: 'neutral' }), // pet, 0 stage-2 lines but must SURVIVE in nameOnly mode
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
    expect(result.characters.map((c) => c.id).sort()).toEqual([
      'narrator',
      'pib',
      'unknown-male',
      'wren',
    ]);
    const male = result.characters.find((c) => c.id === 'unknown-male')!;
    expect(male.aliases).toEqual(['The Jogger', 'Drooly Boy']);
    expect(result.summary.droppedSilent).toBe(0);
  });

  it("dedups bucket aliases case-insensitively and never adds the bucket's own name", () => {
    const chars = [
      makeChar('narrator'),
      makeChar('unknown-a', { name: 'Garrow', gender: 'male' }),
      makeChar('unknown-b', { name: 'GARROW', gender: 'male' }),
      makeChar('unknown-c', { name: 'Unknown male', gender: 'male' }), // pathological — collides with bucket title
    ];
    const sentences = makeSentences([
      [1, 'unknown-a'],
      [1, 'unknown-b'],
      [1, 'unknown-c'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    const bucket = result.characters.find((c) => c.id === 'unknown-male')!;
    /* First-name-wins, case-insensitive dedup against the survivor's
       aliases AND own name. */
    expect(bucket.aliases).toEqual(['Garrow']);
  });

  /* ── Protected-role narrator-mention exemption (plan 97) ──────────────── */

  it('protects a narrator-mention character with a protected role from the zero-line drop', () => {
    /* Sela-in-Saltgrave worked example: detected with detectionSource:
       narrator-mention, role: 'Bodyguard', 0 attributed dialogue lines.
       Without the exemption she would be dropped by the zero-line rule. */
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('sela', {
        name: 'Sela',
        gender: 'female',
        role: 'Bodyguard',
        detectionSource: 'narrator-mention',
      }),
    ];
    const sentences = makeSentences([
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({});
    expect(result.summary.droppedSilent).toBe(0);
    expect(result.dropped).toEqual([]);
    /* Sela survives intact, no fold. Referential identity preserved
       on the no-op path (same as the existing "no character qualifies"
       case at line 47) — caller still sees the original char, line-count
       recomputation only happens when something actually folds. */
    expect(result.characters).toBe(chars);
    expect(result.characters.find((c) => c.id === 'sela')).toBeDefined();
  });

  it('protects a narrator-mention character with a protected role from the line-count fold', () => {
    /* Garrow-in-Saltgrave worked example: 1 chapter of dialogue is below
       the minLines threshold and would normally fold into unknown-male.
       With detectionSource: narrator-mention + Bodyguard role, the
       exemption applies and Garrow survives with his single line. */
    const chars = [
      makeChar('narrator'),
      makeChar('garrow', {
        name: 'Garrow',
        gender: 'male',
        role: 'Goblin Bodyguard',
        detectionSource: 'narrator-mention',
      }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, 'narrator'],
      [1, 'narrator'],
      [5, 'garrow'], // single line — would fold without protection
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({});
    expect(result.characters.find((c) => c.id === 'garrow')).toBeDefined();
    /* No bucket synthesised — nothing folded. The single Garrow sentence
       retains its attribution (no rewrite to unknown-male). */
    expect(result.characters.find((c) => c.id === 'unknown-male')).toBeUndefined();
    expect(result.sentences.filter((s) => s.characterId === 'garrow').length).toBe(1);
  });

  it('still folds a protected-role character with detectionSource: dialogue + too few lines (targeted exemption, not blanket)', () => {
    /* This is the negative case: protection is for narrator-mention only.
       A bodyguard the analyzer detected via real dialogue but who only
       speaks once is still folded by the normal line-count rule. The
       intent of the exemption is to recover characters who would never
       cross the dialogue-detection threshold, NOT to keep every
       protected-role character regardless of line count. */
    const chars = [
      makeChar('narrator'),
      makeChar('garrow', {
        name: 'Garrow',
        gender: 'male',
        role: 'Bodyguard',
        detectionSource: 'dialogue',
      }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, 'narrator'],
      [1, 'narrator'],
      [5, 'garrow'], // single line, detectionSource=dialogue → still folds
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ garrow: 'unknown-male' });
    expect(result.characters.find((c) => c.id === 'garrow')).toBeUndefined();
  });

  it('does NOT protect a narrator-mention character whose role is not in the protected list', () => {
    /* Only Bodyguard / Mentor / Family Member are protected by default.
       A character with detectionSource: narrator-mention + role:
       'Background Speaker' is NOT exempt — they fold/drop normally. */
    const chars = [
      makeChar('narrator'),
      makeChar('extra', {
        name: 'Background Extra',
        gender: 'male',
        role: 'Background Speaker',
        detectionSource: 'narrator-mention',
      }),
    ];
    const sentences = makeSentences([[1, 'narrator']]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    /* 0-line + not-descriptor + not-protected → dropped entirely. */
    expect(result.summary.droppedSilent).toBe(1);
    expect(result.dropped).toEqual(['Background Extra']);
    expect(result.characters.find((c) => c.id === 'extra')).toBeUndefined();
  });

  it('descriptor-name fold still wins over the protected-role exemption', () => {
    /* A character named "Unknown Bodyguard" with detectionSource:
       narrator-mention is still a descriptor and folds. The Unknown
       prefix is a stronger signal that no proper voice profile is
       warranted than the role-based exemption is to keep it. */
    const chars = [
      makeChar('narrator'),
      makeChar('unknown-bodyguard', {
        name: 'Unknown Bodyguard',
        gender: 'male',
        role: 'Bodyguard',
        detectionSource: 'narrator-mention',
      }),
    ];
    const sentences = makeSentences([[1, 'unknown-bodyguard']]);

    const result = foldMinorCast(chars, sentences, { minLines: 3 });

    expect(result.rewrites).toEqual({ 'unknown-bodyguard': 'unknown-male' });
    const bucket = result.characters.find((c) => c.id === 'unknown-male')!;
    expect(bucket.aliases).toEqual(['Unknown Bodyguard']);
  });

  it('honours a custom protectedRoles: [] — disables the exemption entirely', () => {
    /* The fold's default protectedRoles list is overridable. Empty list
       means the exemption never fires; the existing zero-line drop
       rules apply across the board. */
    const chars = [
      makeChar('narrator'),
      makeChar('sela', {
        name: 'Sela',
        gender: 'female',
        role: 'Bodyguard',
        detectionSource: 'narrator-mention',
      }),
    ];
    const sentences = makeSentences([[1, 'narrator']]);

    const result = foldMinorCast(chars, sentences, { minLines: 3, protectedRoles: [] });

    /* With the exemption off, the 0-line drop fires. */
    expect(result.summary.droppedSilent).toBe(1);
    expect(result.dropped).toEqual(['Sela']);
  });

  it('PROTECTED_ROLES_DEFAULT lists the three canonical roles', () => {
    expect(PROTECTED_ROLES_DEFAULT).toEqual(['Bodyguard', 'Mentor', 'Family Member']);
  });

  /* ── plan 122: a bucket id never wears a real character's name ── */

  it('canonicalises a drifted bucket name back to the generic (no named char wears a bucket id)', () => {
    /* A real character that drifted onto the unknown-male id (via an old
       merge / voice-match), plus a genuine minor male that folds this pass. */
    const chars = [
      makeChar('narrator'),
      makeChar('unknown-male', { name: 'Lord Vane', gender: 'male' }),
      makeChar('jogger', { name: 'The Jogger', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, 'unknown-male'],
      [1, 'jogger'],
    ]);
    const result = foldMinorCast(chars, sentences, { minLines: 3 });
    const bucket = result.characters.find((c) => c.id === 'unknown-male');
    expect(bucket?.name).toBe('Unknown male');
    expect(bucket?.gender).toBe('male');
    /* The drifted NAME is deliberately not kept as an alias — otherwise the
       matcher would re-bind Lord Vane to the bucket on the next book. */
    expect(bucket?.aliases ?? []).not.toContain('Lord Vane');
  });

  it('canonicalises a drifted bucket even when nothing folds this pass', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('unknown-female', { name: 'Senna', gender: 'female' }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, 'wren'],
      [1, 'wren'],
      [1, 'wren'],
      [1, 'unknown-female'],
      [1, 'unknown-female'],
      [1, 'unknown-female'],
    ]);
    const result = foldMinorCast(chars, sentences, { minLines: 3 });
    expect(result.summary.foldedCount).toBe(0);
    const bucket = result.characters.find((c) => c.id === 'unknown-female');
    expect(bucket?.name).toBe('Unknown female');
  });

  it('never folds a non-descriptor character with ≥ minLines into a bucket (keeps its own id)', () => {
    const chars = [makeChar('narrator'), makeChar('lord-vane', { name: 'Lord Vane', gender: 'male' })];
    const sentences = makeSentences([
      [1, 'lord-vane'],
      [1, 'lord-vane'],
      [1, 'lord-vane'],
      [2, 'lord-vane'],
    ]);
    const result = foldMinorCast(chars, sentences, { minLines: 3 });
    expect(result.rewrites['lord-vane']).toBeUndefined();
    expect(result.characters.find((c) => c.id === 'lord-vane')?.id).toBe('lord-vane');
  });
});

describe('matchesProtectedRole', () => {
  it('matches case-insensitively', () => {
    expect(matchesProtectedRole('Bodyguard', ['Bodyguard'])).toBe(true);
    expect(matchesProtectedRole('bodyguard', ['Bodyguard'])).toBe(true);
    expect(matchesProtectedRole('BODYGUARD', ['bodyguard'])).toBe(true);
  });

  it('matches via substring — "Goblin Bodyguard" matches "Bodyguard"', () => {
    /* The role string often includes a species/style qualifier
       ('Goblin Bodyguard', 'Ogre Bodyguard'); the protection list keeps
       the base noun and the matcher tolerates qualifiers. */
    expect(matchesProtectedRole('Goblin Bodyguard', ['Bodyguard'])).toBe(true);
    expect(matchesProtectedRole('Ogre Bodyguard', ['Bodyguard'])).toBe(true);
    expect(matchesProtectedRole('Family Member (mother)', ['Family Member'])).toBe(true);
  });

  it('does not match when no entry is a substring', () => {
    expect(matchesProtectedRole('Antagonist', ['Bodyguard', 'Mentor'])).toBe(false);
    expect(matchesProtectedRole('Background Speaker', ['Bodyguard'])).toBe(false);
  });

  it('returns false for missing/empty role', () => {
    expect(matchesProtectedRole(undefined, ['Bodyguard'])).toBe(false);
    expect(matchesProtectedRole('', ['Bodyguard'])).toBe(false);
  });

  it('returns false on empty protected list', () => {
    expect(matchesProtectedRole('Bodyguard', [])).toBe(false);
  });
});

describe('Wave D — localized minor-cast fold buckets', () => {
  it('makeBucket mints localized Russian names for ru', () => {
    expect(makeBucket(MALE_BUCKET_ID, 'male', 'ru').name).toBe('Незнакомый Парень');
    expect(makeBucket(FEMALE_BUCKET_ID, 'female', 'ru').name).toBe('Незнакомая Девушка');
    /* BCP-47 region subtag normalised. */
    expect(makeBucket(MALE_BUCKET_ID, 'male', 'ru-RU').name).toBe('Незнакомый Парень');
  });

  it('makeBucket keeps English names for en / undefined', () => {
    expect(makeBucket(MALE_BUCKET_ID, 'male', 'en').name).toBe('Unknown male');
    expect(makeBucket(FEMALE_BUCKET_ID, 'female', 'en').name).toBe('Unknown female');
    expect(makeBucket(MALE_BUCKET_ID, 'male').name).toBe('Unknown male');
    expect(makeBucket(FEMALE_BUCKET_ID, 'female').name).toBe('Unknown female');
  });

  it('folds a low-line Russian character into a Russian-named bucket', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('anton', { name: 'Антон', gender: 'male' }),
      makeChar('passerby', { name: 'Прохожий', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, 'narrator'],
      [1, 'narrator'],
      [1, 'anton'],
      [1, 'anton'],
      [2, 'anton'],
      [1, 'passerby'], // 1 line → folds
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3, language: 'ru' });

    const male = result.characters.find((c) => c.id === MALE_BUCKET_ID);
    expect(male?.name).toBe('Незнакомый Парень');
  });

  it('is idempotent: re-folding a cast that already has a Russian bucket name keeps it Russian', () => {
    /* Seed a cast that already contains a Russian-named bucket plus a fresh
       low-line character to force the fold path (so the canonicalizer runs). */
    const chars = [
      makeChar('narrator'),
      { ...makeBucket(MALE_BUCKET_ID, 'male', 'ru') },
      makeChar('drifter', { name: 'Прохожий', gender: 'male' }),
    ];
    const sentences = makeSentences([
      [1, 'narrator'],
      [1, MALE_BUCKET_ID],
      [1, 'drifter'], // 1 line → folds into the male bucket
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3, language: 'ru' });

    const male = result.characters.find((c) => c.id === MALE_BUCKET_ID);
    /* The canonicalizer must NOT revert the Russian name to "Unknown male". */
    expect(male?.name).toBe('Незнакомый Парень');
  });

  it('isDescriptorName treats Russian generic nouns as descriptors only when language is Russian', () => {
    expect(isDescriptorName('девушка', 'ru')).toBe(true);
    expect(isDescriptorName('Парень', 'ru')).toBe(true);
    expect(isDescriptorName('Незнакомец', 'ru')).toBe(true);
    expect(isDescriptorName('Старик', 'ru')).toBe(true);
    /* Without the language flag, a Russian noun is NOT recognised. */
    expect(isDescriptorName('девушка')).toBe(false);
    expect(isDescriptorName('Парень')).toBe(false);
    /* A real Russian proper name must not fold. */
    expect(isDescriptorName('Антон', 'ru')).toBe(false);
    expect(isDescriptorName('Борис Игнатьевич', 'ru')).toBe(false);
  });

  it('English descriptor matrix is unchanged when a language is passed', () => {
    expect(isDescriptorName('Unknown Jogger', 'en')).toBe(true);
    expect(isDescriptorName('The Jogger', 'en')).toBe(true);
    expect(isDescriptorName('Old Man', 'en')).toBe(true);
    expect(isDescriptorName('Wren', 'en')).toBe(false);
    /* English descriptors still work under ru too (we only ADD, never remove). */
    expect(isDescriptorName('Unknown Jogger', 'ru')).toBe(true);
  });
});

describe('foldMinorCast — keeps a prose-tagged Spanish minor speaker (#1028)', () => {
  it('keeps a prose-tagged Spanish 0-line speaker (es keep-protection)', () => {
    const characters = [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', gender: 'neutral', description: '', aliases: [] },
      { id: 'berrin', name: 'Berrin', role: 'minor', color: 'narrator', gender: 'male', description: '', aliases: [] },
    ];
    const sentences = [
      { id: 1, chapterId: 1, characterId: 'narrator', text: '—Está bien —dijo Berrin.' },
    ];
    const result = foldMinorCast(characters as any, sentences as any, { language: 'es' });
    expect(result.characters.map((c) => c.id)).toContain('berrin');
  });
  it('does not drop a 0-line speaker whose quote the prose tags (es)', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('wren', { name: 'Wren', gender: 'female' }),
      makeChar('berrin', { name: 'Berrin', gender: 'male' }), // 0 attributed lines
    ];
    const sentences = makeSentences([
      [1, 'narrator'], [1, 'wren'], [1, 'wren'], [2, 'wren'],
    ]);
    // A narrator-attributed sentence whose TEXT tags Berrin (stage-2 stranded the quote).
    sentences.push({ id: sentences.length + 1, chapterId: 1, characterId: 'narrator', text: '«Está bien», dijo Berrin.' });

    const result = foldMinorCast(chars, sentences, { minLines: 3, language: 'es' });

    expect(result.characters.find((c) => c.id === 'berrin')).toBeDefined(); // kept
    expect(result.dropped).not.toContain('Berrin');
  });
});

describe('Wave E — Russian descriptor phrases (safe tier)', () => {
  /* Background speakers on a Russian book are often named with a multi-word
     DESCRIPTIVE PHRASE ("женщина с двумя овчарками на поводке"), not a bare
     noun — the single-noun rule (Wave D) missed all of these, so they leaked
     into the live cast instead of folding. The safe-tier widening fires only on
     signals a proper Russian name structurally CANNOT have, so it can never
     fold a real character (#938 author-takeover lesson). */

  it('folds a multi-word phrase containing a Russian function word (preposition/conjunction)', () => {
    /* Real cases from the Ночной дозор run (2026-06-19). */
    expect(isDescriptorName('женщина с двумя овчарками на поводке', 'ru')).toBe(true); // с, на
    expect(isDescriptorName('молодой в яркой оранжевой куртке', 'ru')).toBe(true); // в
    expect(isDescriptorName('женщина - с сонным малышом', 'ru')).toBe(true); // dash + с
    expect(isDescriptorName('мужчина у окна', 'ru')).toBe(true); // у
    expect(isDescriptorName('девочка и её собака', 'ru')).toBe(true); // и
  });

  it('folds bare occupational role nouns added to the Russian set', () => {
    expect(isDescriptorName('оператор', 'ru')).toBe(true);
    expect(isDescriptorName('Водитель', 'ru')).toBe(true);
  });

  it('NEVER folds a real Russian proper name (the cardinal guard)', () => {
    expect(isDescriptorName('Антон', 'ru')).toBe(false);
    expect(isDescriptorName('Антон Городецкий', 'ru')).toBe(false);
    expect(isDescriptorName('Сергей Лукьяненко', 'ru')).toBe(false); // byline author — not our job to fold (#938)
    expect(isDescriptorName('Борис Игнатьевич', 'ru')).toBe(false);
    expect(isDescriptorName('Светлана Назарова', 'ru')).toBe(false);
    expect(isDescriptorName('Алиса Донникова', 'ru')).toBe(false);
    expect(isDescriptorName('Завулон', 'ru')).toBe(false);
    expect(isDescriptorName('Полина Васильевна', 'ru')).toBe(false);
  });

  it('safe tier deliberately does NOT fold "<adjective> <role-noun>" — relies on the line-count fold', () => {
    /* "Тёмный маг" can be a meaningful faction role in this universe; the
       safe tier leaves it to the post-stage-2 line-count fold so we never
       swallow a real role character by name. */
    expect(isDescriptorName('Тёмный маг', 'ru')).toBe(false);
    expect(isDescriptorName('Темный маг', 'ru')).toBe(false);
  });

  it('the function-word + role-noun widening is Russian-only (no effect under en / undefined)', () => {
    expect(isDescriptorName('женщина с двумя овчарками на поводке')).toBe(false);
    expect(isDescriptorName('женщина с двумя овчарками на поводке', 'en')).toBe(false);
    expect(isDescriptorName('оператор', 'en')).toBe(false);
  });

  it('foldMinorCast collapses a phrase descriptor regardless of line count, but keeps a real name with ≥ minLines', () => {
    const chars = [
      makeChar('narrator'),
      makeChar('anton', { name: 'Антон Городецкий', gender: 'male' }),
      makeChar('dog-woman', { name: 'женщина с двумя овчарками на поводке', gender: 'female' }),
    ];
    /* The descriptor speaks 6 lines (> minLines) yet still folds — the name
       trigger is line-count-independent. Anton speaks 4 lines and must stay. */
    const sentences = makeSentences([
      [1, 'anton'],
      [1, 'anton'],
      [2, 'anton'],
      [2, 'anton'],
      [1, 'dog-woman'],
      [1, 'dog-woman'],
      [1, 'dog-woman'],
      [2, 'dog-woman'],
      [2, 'dog-woman'],
      [2, 'dog-woman'],
    ]);

    const result = foldMinorCast(chars, sentences, { minLines: 3, language: 'ru' });

    expect(result.rewrites).toEqual({ 'dog-woman': FEMALE_BUCKET_ID });
    /* Anton untouched. */
    expect(result.characters.find((c) => c.id === 'anton')?.name).toBe('Антон Городецкий');
    /* The phrase is rolled into the bucket's aliases for cross-book matching. */
    const female = result.characters.find((c) => c.id === FEMALE_BUCKET_ID);
    expect(female?.name).toBe('Незнакомая Девушка');
    expect(female?.aliases).toContain('женщина с двумя овчарками на поводке');
  });
});
