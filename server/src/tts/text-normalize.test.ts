/* Unit coverage for the TTS-bound text normalizer.

   Each case here is anchored to a concrete failure mode we saw end-to-end
   with XTTS v2: chapter openers spelled as letters, em-dash repetition
   loops, and the cumulative ~60s of garbled audio at the top of chapter 2.
   The composed `normaliseForTts` is the single entry point used by
   `synthesiseChapter`; the named exports are tested individually so a
   future refactor that splits or reorders the transforms can pin which
   half regressed. */

import { describe, it, expect } from 'vitest';
import { denormaliseAllCaps, softenDashes, normaliseForTts } from './text-normalize.js';

describe('denormaliseAllCaps', () => {
  it('title-cases a multi-word all-caps chapter opener', () => {
    expect(denormaliseAllCaps('THE NEXT SECOND WAS A BLUR.'))
      .toBe('The Next Second Was A Blur.');
  });

  it('title-cases an all-caps run with an apostrophe (e.g. Marrow’S), leaving the 2-letter MR. abbreviation intact', () => {
    /* `MR` is a 2-letter caps run — the regex requires >=3 so it stays.
       That's deliberate: XTTS pronounces "MR." fine as "mister"; only the
       multi-word ALL-CAPS run is the hazard. */
    expect(denormaliseAllCaps("MR. Marrow'S NASAL voice cut through."))
      .toBe("MR. Marrow's Nasal voice cut through.");
  });

  it('leaves 2-letter caps (initials, abbreviations) untouched so MR/DR stay intact', () => {
    /* `MR` on its own (no following caps) is a 2-letter run — XTTS pronounces
       it as "mister" already. The regex requires >=3 caps in a row, so this
       must round-trip unchanged. */
    expect(denormaliseAllCaps('Mr. Smith met OK at AC.'))
      .toBe('Mr. Smith met OK at AC.');
  });

  it('leaves single capitals (sentence starts, "A", "I") untouched', () => {
    expect(denormaliseAllCaps('A car. I drive. The lantern fell.'))
      .toBe('A car. I drive. The lantern fell.');
  });

  it('is idempotent — running twice produces the same output as once', () => {
    const once = denormaliseAllCaps('THE NEXT SECOND WAS A BLUR.');
    expect(denormaliseAllCaps(once)).toBe(once);
  });

  it('leaves lowercase audio tags like [shouting] intact', () => {
    expect(denormaliseAllCaps('[shouting] Help me!'))
      .toBe('[shouting] Help me!');
  });
});

describe('softenDashes', () => {
  it('replaces a flanked em-dash (the `right—missing` pattern) with a comma', () => {
    expect(softenDashes('right—missing Wren by inches—then jumped the curb'))
      .toBe('right, missing Wren by inches, then jumped the curb');
  });

  it('replaces a spaced em-dash with a single comma (no double spaces)', () => {
    expect(softenDashes('he paused — then ran'))
      .toBe('he paused, then ran');
  });

  it('replaces an en-dash the same way', () => {
    expect(softenDashes('pages 12–15'))
      .toBe('pages 12, 15');
  });

  it('is idempotent', () => {
    const once = softenDashes('a—b');
    expect(softenDashes(once)).toBe(once);
  });

  it('leaves regular hyphens alone', () => {
    expect(softenDashes('well-known cold-eyed boy'))
      .toBe('well-known cold-eyed boy');
  });
});

describe('normaliseForTts (composed)', () => {
  it('cleans the chapter-2 opener (the real regression case)', () => {
    /* This is the literal text that produced ~60s of garbled audio at the
       top of `04-chapter-two.mp3` in the canonical e2e manuscript. The fix
       must leave it with no all-caps run AND no em-dashes. */
    const input =
      'THE NEXT SECOND WAS A BLUR. ' +
      'The car swerved right—missing Wren by inches—then jumped the curb and sideswiped a streetlight. ' +
      'The heavy steel lantern cracked from its base and plummeted toward Wren.';
    const output = normaliseForTts(input);

    expect(output).not.toMatch(/[A-Z]{3,}/);
    expect(output).not.toMatch(/[—–]/);
    expect(output).toBe(
      'The Next Second Was A Blur. ' +
      'The car swerved right, missing Wren by inches, then jumped the curb and sideswiped a streetlight. ' +
      'The heavy steel lantern cracked from its base and plummeted toward Wren.'
    );
  });

  it('is idempotent across the composed pipeline', () => {
    const once = normaliseForTts('THE BLUR—then.');
    expect(normaliseForTts(once)).toBe(once);
  });
});
