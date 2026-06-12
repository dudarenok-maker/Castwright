/* Unit tests for the shared text-match helpers. Companions to the
   verifier integration tests in routes/analysis.test.ts — the the Hollow Tide
   regression cases here pin the false-positive shapes that motivated
   the three-tier match (see Phase-0 dropped-quotes ledger 2026-05-15). */

import { describe, it, expect } from 'vitest';
import {
  normaliseForMatch,
  stripTerminalSentencePunct,
  splitSentenceSegments,
  matchQuoteInSource,
} from './text-match.js';

describe('stripTerminalSentencePunct', () => {
  it.each([
    ['hello world.', 'hello world'],
    ['hello world,', 'hello world'],
    ['hello world!?!', 'hello world'],
    ['hello world', 'hello world'],
    ['hello, world', 'hello, world'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(stripTerminalSentencePunct(input)).toBe(expected);
  });
});

describe('splitSentenceSegments', () => {
  it('splits on sentence-final punctuation followed by whitespace', () => {
    expect(splitSentenceSegments('keep moving forward. then turn left now.')).toEqual([
      'keep moving forward',
      'then turn left now',
    ]);
  });

  it('filters out segments shorter than the minLen threshold (default 8)', () => {
    /* "yeah" (4) and "no" (2) are below the cutoff — only the long
       segment survives. */
    expect(splitSentenceSegments('yeah. some longer sentence here. no.')).toEqual([
      'some longer sentence here',
    ]);
  });

  it('respects a caller-supplied minLen', () => {
    expect(splitSentenceSegments('hi there. bye now.', 3)).toEqual(['hi there', 'bye now']);
  });

  it('returns an empty array when no segment clears the threshold', () => {
    expect(splitSentenceSegments('a. b. c.')).toEqual([]);
  });
});

describe('matchQuoteInSource — three-tier verifier', () => {
  const source = normaliseForMatch(
    '"Hard to starboard," Halloran said, watching the gulls scatter. ' +
      'Hours later, by the binnacle, he muttered: "Cold supper it is, then." ' +
      'Marcus shrugged. "Aye." ' +
      '"Mammoths are extinct," she interrupted.',
  );

  it('returns "verbatim" when the candidate appears as a contiguous run', () => {
    expect(matchQuoteInSource(normaliseForMatch('Hard to starboard'), source)).toBe('verbatim');
  });

  it('returns "terminal_punct" for period-for-comma drift before a dialogue tag', () => {
    /* The signature the Hollow Tide false positive: source has `extinct,` (comma
       because a dialogue tag follows), model emits `extinct.` (period
       because the line is a complete utterance). */
    expect(matchQuoteInSource(normaliseForMatch('Mammoths are extinct.'), source)).toBe(
      'terminal_punct',
    );
  });

  it('returns "segments" for stitched same-speaker quotes with narration removed', () => {
    expect(
      matchQuoteInSource(normaliseForMatch('Hard to starboard. Cold supper it is, then.'), source),
    ).toBe('segments');
  });

  it('returns null when at least one segment is genuinely fabricated', () => {
    expect(
      matchQuoteInSource(
        normaliseForMatch('Cold supper it is, then. He winked at the parrot.'),
        source,
      ),
    ).toBeNull();
  });

  it('returns null when only one segment clears the ≥ 8-char filter (single-segment cannot rescue tier 1/2 failure)', () => {
    expect(
      matchQuoteInSource(
        normaliseForMatch('A wholly fabricated long sentence never seen. No.'),
        source,
      ),
    ).toBeNull();
  });

  it('returns null for empty normalised input', () => {
    expect(matchQuoteInSource('', source)).toBeNull();
  });

  it('matches a quote stitched across an INTERRUPTING mid-sentence dialogue tag', () => {
    /* Coalfall regression (2026-06-09): source interrupts a single
       sentence with the tag — `"If I douse the fire," Oduvan said, "I
       lose the weld..."`. The model returns the two halves joined by the
       comma the tag replaced. There is only ONE sentence-final period, so
       the sentence-split `segments` tier yields a single fragment and
       cannot fire; the clause split (on the interrupting comma) rescues
       it. Both halves are genuine contiguous runs in the source. */
    const interrupted = normaliseForMatch(
      '"If I douse the fire," Oduvan said, "I lose the weld I have been nursing since noon."',
    );
    expect(
      matchQuoteInSource(
        normaliseForMatch('If I douse the fire, I lose the weld I have been nursing since noon.'),
        interrupted,
      ),
    ).toBe('segments');
  });

  it('does NOT clause-rescue when an interrupting-stitch half is fabricated', () => {
    /* Guard the looser clause split: the first half is real, the second is
       invented and never appears in the source, so the quote stays dropped. */
    const interrupted = normaliseForMatch(
      '"If I douse the fire," Oduvan said, "I lose the weld I have been nursing since noon."',
    );
    expect(
      matchQuoteInSource(
        normaliseForMatch('If I douse the fire, I will summon the town guard at once.'),
        interrupted,
      ),
    ).toBeNull();
  });
});

describe('matchQuoteInSource — the Hollow Tide ledger regression', () => {
  /* The user pasted these as `not in source` after a Gemma 4 run on
     2026-05-15. Each is a verbatim or near-verbatim Marlow / Wren
     line that the old strict-substring matcher dropped. The minimal
     source fragment below preserves the punctuation pattern that
     defeated each tier — keep these in this single block so future
     regressions surface here, not on the user's next analysis run. */
  const sourceFragments = [
    /* Stitched: "Kick his butt, Wren!" Marlow cheered. "It's about time..." */
    '"Kick his butt, Wren!" Marlow cheered. "It\'s about time someone took Brann down."',
    /* Stitched + terminal-punct: ","Marlow said behind her. He flashed... */
    '"A Level Two making it to the top ten," Marlow said behind her. He flashed a crooked smile. "And you said you weren\'t mysterious."',
    /* Stitched with narration block between halves */
    '"Makeovers?" Marlow scoffed behind them. "You girls sure know how to have fun. Maybe you can braid each other\'s hair and giggle about boys while you\'re at it."',
    /* Terminal-punct drift: source has `,"` before dialogue tag */
    'whispered, "Told you so," when his dad wasn\'t looking.',
    /* Terminal-punct drift on a long quote */
    '"Sorry, I forgot you\'re worse at this stuff than me," Hart said smugly.',
    /* Stitched across two paragraphs of source */
    '"I promise I\'ll be careful," Wren said. "You don\'t have to worry."',
  ].join('\n\n');
  const normSource = normaliseForMatch(sourceFragments);

  it.each([
    ["Kick his butt, Wren! It's about time someone took Brann down.", 'segments'],
    ["A Level Two making it to the top ten. And you said you weren't mysterious.", 'segments'],
    [
      "Makeovers? You girls sure know how to have fun. Maybe you can braid each other's hair and giggle about boys while you're at it.",
      'segments',
    ],
    ['Told you so.', 'terminal_punct'],
    ["Sorry, I forgot you're worse at this stuff than me.", 'terminal_punct'],
    ["I promise I'll be careful. You don't have to worry.", 'segments'],
  ])('keeps real the Hollow Tide quote %s via %s tier', (quote, expectedTier) => {
    expect(matchQuoteInSource(normaliseForMatch(quote), normSource)).toBe(expectedTier);
  });
});
