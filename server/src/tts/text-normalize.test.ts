/* Unit coverage for the TTS-bound text normalizer.

   Each case here is anchored to a concrete failure mode we saw end-to-end
   with XTTS v2: chapter openers spelled as letters, em-dash repetition
   loops, and the cumulative ~60s of garbled audio at the top of chapter 2.
   The composed `normaliseForTts` is the single entry point used by
   `synthesiseChapter`; the named exports are tested individually so a
   future refactor that splits or reorders the transforms can pin which
   half regressed. */

import { describe, it, expect } from 'vitest';
import {
  denormaliseAllCaps,
  softenDashes,
  stripUnsafeForTts,
  normaliseForTts,
} from './text-normalize.js';

describe('denormaliseAllCaps', () => {
  it('title-cases a multi-word all-caps chapter opener', () => {
    expect(denormaliseAllCaps('THE NEXT SECOND WAS A BLUR.')).toBe('The Next Second Was A Blur.');
  });

  it('title-cases an all-caps run with an apostrophe (e.g. SWEENEY’S), leaving the 2-letter MR. abbreviation intact', () => {
    /* `MR` is a 2-letter caps run — the regex requires >=3 so it stays.
       That's deliberate: XTTS pronounces "MR." fine as "mister"; only the
       multi-word ALL-CAPS run is the hazard. */
    expect(denormaliseAllCaps("MR. SWEENEY'S NASAL voice cut through.")).toBe(
      "MR. Sweeney's Nasal voice cut through.",
    );
  });

  it('leaves 2-letter caps (initials, abbreviations) untouched so MR/DR stay intact', () => {
    /* `MR` on its own (no following caps) is a 2-letter run — XTTS pronounces
       it as "mister" already. The regex requires >=3 caps in a row, so this
       must round-trip unchanged. */
    expect(denormaliseAllCaps('Mr. Smith met OK at AC.')).toBe('Mr. Smith met OK at AC.');
  });

  it('leaves single capitals (sentence starts, "A", "I") untouched', () => {
    expect(denormaliseAllCaps('A car. I drive. The lantern fell.')).toBe(
      'A car. I drive. The lantern fell.',
    );
  });

  it('is idempotent — running twice produces the same output as once', () => {
    const once = denormaliseAllCaps('THE NEXT SECOND WAS A BLUR.');
    expect(denormaliseAllCaps(once)).toBe(once);
  });

  it('leaves lowercase audio tags like [shouting] intact', () => {
    expect(denormaliseAllCaps('[shouting] Help me!')).toBe('[shouting] Help me!');
  });
});

describe('softenDashes', () => {
  it('replaces a flanked em-dash (the `right—missing` pattern) with a comma', () => {
    expect(softenDashes('right—missing Wren by inches—then jumped the curb')).toBe(
      'right, missing Wren by inches, then jumped the curb',
    );
  });

  it('replaces a spaced em-dash with a single comma (no double spaces)', () => {
    expect(softenDashes('he paused — then ran')).toBe('he paused, then ran');
  });

  it('replaces an en-dash the same way', () => {
    expect(softenDashes('pages 12–15')).toBe('pages 12, 15');
  });

  it('is idempotent', () => {
    const once = softenDashes('a—b');
    expect(softenDashes(once)).toBe(once);
  });

  it('leaves regular hyphens alone', () => {
    expect(softenDashes('well-known cold-eyed boy')).toBe('well-known cold-eyed boy');
  });
});

describe('stripUnsafeForTts', () => {
  /* Each of these cases corresponds to a class of byte that has, end-to-end,
     produced a `CUDA error: device-side assert triggered` from XTTS v2's
     embedding lookup — once that fires the CUDA context is corrupted for
     the rest of the sidecar process and every subsequent chapter fails
     with the same 500 until the user manually restarts the sidecar. The
     fix is to never let these bytes reach the model. */

  it('strips zero-width spaces and joiners that survived a PDF / HTML copy-paste', () => {
    const input = 'The​car‌swerved‍right.';
    expect(stripUnsafeForTts(input)).toBe('Thecarswervedright.');
  });

  it('strips the BOM and word-joiner that some Windows editors prepend', () => {
    expect(stripUnsafeForTts('﻿Once upon a time⁠.')).toBe('Once upon a time.');
  });

  it('strips bidi format chars (LRM, RLM, embedding overrides)', () => {
    const input = 'left‎to‏right‪and‮back';
    expect(stripUnsafeForTts(input)).toBe('lefttorightandback');
  });

  it('strips C0 control chars (except TAB and LF) and C1 control chars', () => {
    const input = 'line1\nline2\tindented\x01\x07\x1Bend\x7F\x9F.';
    /* TAB (\\t) and LF (\\n) are preserved; everything else is wiped. */
    expect(stripUnsafeForTts(input)).toBe('line1\nline2\tindentedend.');
  });

  it('strips unpaired surrogates from a busted UTF-16 round-trip', () => {
    /* U+D800 alone (no low surrogate after) is invalid. */
    const input = 'broken\uD800text';
    expect(stripUnsafeForTts(input)).toBe('brokentext');
  });

  it('preserves valid surrogate pairs (emoji etc.) — only unpaired halves are stripped', () => {
    /* 🎙 is U+1F399 → high D83C + low DF99; a valid pair must round-trip. */
    expect(stripUnsafeForTts('hello 🎙 world')).toBe('hello 🎙 world');
  });

  it('composes NFD diacritics to NFC so the tokenizer sees the trained form', () => {
    /* "é" as U+0065 + U+0301 (NFD) → "é" as U+00E9 (NFC). */
    const nfd = 'café';
    const nfc = 'café';
    expect(stripUnsafeForTts(nfd)).toBe(nfc);
  });

  it('is idempotent on clean ASCII', () => {
    const clean = 'A quick brown fox.';
    expect(stripUnsafeForTts(clean)).toBe(clean);
    expect(stripUnsafeForTts(stripUnsafeForTts(clean))).toBe(clean);
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
        'The heavy steel lantern cracked from its base and plummeted toward Wren.',
    );
  });

  it('is idempotent across the composed pipeline', () => {
    const once = normaliseForTts('THE BLUR—then.');
    expect(normaliseForTts(once)).toBe(once);
  });

  it('strips unsafe bytes AND title-cases AND softens dashes in a single pass', () => {
    /* The integration regression: a PDF copy-paste that smuggled a
       zero-width space into the middle of a SHOUTED word, with an em-dash
       chaser. Each transform individually fixes its slice; the composed
       pipeline has to deliver clean text to XTTS in one go. */
    const input = 'HE​LLO—world.';
    expect(normaliseForTts(input)).toBe('Hello, world.');
  });

  /* ── plan 70d — audio-tag stripping ─────────────────────────────── */

  it('strips the analyzer vocabulary tags so Kokoro / Coqui do not read them aloud', () => {
    /* No current engine in this app interprets bracket markup as prosody.
       The user reported "[emphatic] is being read not being used in voice"
       on the canonical Keeper book — this is the regression. */
    expect(normaliseForTts('She said [emphatic] hello.')).toBe('She said hello.');
    expect(normaliseForTts('[shouting] HELP!')).toBe('Help!');
    expect(normaliseForTts('Stay still, [whispers] he murmured.')).toBe(
      'Stay still, he murmured.',
    );
  });

  it('preserves arbitrary bracketed prose that is NOT in the audio-tag vocabulary', () => {
    /* Closed-vocabulary stripping is load-bearing — naive `\[[^\]]+\]`
       removal would swallow proper nouns, footnotes, stage directions. */
    expect(normaliseForTts('See [Citation Needed] for sources.')).toBe(
      'See [Citation Needed] for sources.',
    );
    expect(normaliseForTts('Enter [stage left] cautiously.')).toBe(
      'Enter [stage left] cautiously.',
    );
  });

  it('collapses the whitespace where a tag used to sit', () => {
    expect(normaliseForTts('A [laughs] B')).toBe('A B');
    expect(normaliseForTts('[sighs] Then she spoke.')).toBe('Then she spoke.');
  });

  it('is idempotent on tag stripping (no leftover brackets on second pass)', () => {
    const once = normaliseForTts('I am [hesitant] about this.');
    expect(normaliseForTts(once)).toBe(once);
    expect(once).toBe('I am about this.');
  });
});
