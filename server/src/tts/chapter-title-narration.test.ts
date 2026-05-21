import { describe, it, expect } from 'vitest';
import { buildChapterTitleNarration } from './chapter-title-narration.js';

describe('buildChapterTitleNarration', () => {
  it.each<[string, { id: number; title: string | null | undefined }, string | null]>([
    /* Parser's combined-form output → clean two-clause utterance. */
    ['Chapter N + em-dash + name', { id: 3, title: 'Chapter 3 — The Beginning' }, 'Chapter 3. The Beginning.'],
    ['Chapter N + colon + name', { id: 3, title: 'Chapter 3: The Beginning' }, 'Chapter 3. The Beginning.'],
    ['Chapter N + en-dash + name', { id: 3, title: 'Chapter 3 – The Beginning' }, 'Chapter 3. The Beginning.'],
    ['Chapter N + ASCII hyphen + name', { id: 3, title: 'Chapter 3 - The Beginning' }, 'Chapter 3. The Beginning.'],
    ['Chapter N alone', { id: 5, title: 'Chapter 5' }, 'Chapter 5.'],
    ['Chapter N with trailing colon only', { id: 5, title: 'Chapter 5:' }, 'Chapter 5.'],

    /* Bare-name titles — speak verbatim, do NOT auto-inject Chapter N. */
    ['Prologue', { id: 1, title: 'Prologue' }, 'Prologue.'],
    ['Day One (parsed casing)', { id: 1, title: 'Day One' }, 'Day One.'],
    ['DAY ONE (decoration-stripped)', { id: 1, title: 'DAY ONE' }, 'DAY ONE.'],
    ['Moolark (bare name)', { id: 2, title: 'Moolark' }, 'Moolark.'],

    /* Alternate chapter-prefix vocabulary. */
    ['Part N + name', { id: 2, title: 'Part 2: Beyond' }, 'Part 2. Beyond.'],
    ['Book N + name', { id: 4, title: 'Book 4 — The Reckoning' }, 'Book 4. The Reckoning.'],
    ['Ch. abbreviated form', { id: 7, title: 'Ch. 7: The Crossing' }, 'Ch. 7. The Crossing.'],

    /* Roman numerals + spelled-out forms. */
    ['Chapter IV alone', { id: 4, title: 'Chapter IV' }, 'Chapter IV.'],
    ['Chapter Two — spelled', { id: 2, title: 'Chapter Two — Moolark' }, 'Chapter Two. Moolark.'],

    /* Defensive fallbacks. */
    ['Empty string falls back to id', { id: 7, title: '' }, 'Chapter 7.'],
    ['Whitespace-only falls back to id', { id: 7, title: '   ' }, 'Chapter 7.'],
    ['Null title falls back to id', { id: 7, title: null }, 'Chapter 7.'],
    ['Undefined title falls back to id', { id: 7, title: undefined }, 'Chapter 7.'],

    /* Pathological — no usable id AND no usable title → null so caller skips
       the title beat entirely rather than emitting "Chapter NaN." */
    ['Both id and title missing returns null', { id: Number.NaN, title: '' }, null],
  ])('%s', (_label, input, expected) => {
    expect(buildChapterTitleNarration(input)).toBe(expected);
  });
});
