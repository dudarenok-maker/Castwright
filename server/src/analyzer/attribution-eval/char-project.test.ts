/* projectToChars projects attributed sentence-level units onto chapter-body
   character positions — the foundation of a segmentation-invariant
   attribution metric (unlike scorer.ts's line-level scoreAttribution, which
   collapses whitespace/brackets via normalise() and has no positional
   correspondence back to chapterText). */
import { describe, it, expect } from 'vitest';
import { projectToChars } from './char-project.js';

describe('projectToChars', () => {
  it('(a) projects two contiguous units over a plain chapterText to correct spans + speakerByChar', () => {
    const chapterText = 'Hello there. General Kenobi.';
    const units = [
      { text: 'Hello there.', speakerId: 'anakin' },
      { text: 'General Kenobi.', speakerId: 'obiwan' },
    ];
    const result = projectToChars(chapterText, units);

    expect(result.dropped).toBe(0);
    expect(result.spans).toEqual([
      { start: 0, end: 12, speakerId: 'anakin' },
      { start: 13, end: 28, speakerId: 'obiwan' },
    ]);
    expect(result.speakerByChar.slice(0, 12).every((s) => s === 'anakin')).toBe(true);
    expect(result.speakerByChar[12]).toBe(null); // the space between units
    expect(result.speakerByChar.slice(13, 28).every((s) => s === 'obiwan')).toBe(true);
  });

  it('(b) locates a span despite smart-quote/spacing differences (normalizeForMatch path + index map)', () => {
    const chapterText = '“Hi,” she said.';
    const units = [{ text: '"Hi,"', speakerId: 'jane' }];
    const result = projectToChars(chapterText, units);

    expect(result.dropped).toBe(0);
    // “Hi,” spans original chars [0,5) — the curly quotes fold 1:1 to ASCII.
    expect(result.spans).toEqual([{ start: 0, end: 5, speakerId: 'jane' }]);
    expect(result.speakerByChar.slice(0, 5).every((s) => s === 'jane')).toBe(true);
    expect(result.speakerByChar[5]).toBe(null);
  });

  it('(c) skips a unit whose text is absent, leaving its chars null, others unaffected, dropped === 1', () => {
    const chapterText = 'Hello there. General Kenobi.';
    const units = [
      { text: 'Hello there.', speakerId: 'anakin' },
      { text: 'This text does not appear anywhere.', speakerId: 'ghost' },
      { text: 'General Kenobi.', speakerId: 'obiwan' },
    ];
    const result = projectToChars(chapterText, units);

    expect(result.dropped).toBe(1);
    expect(result.spans).toEqual([
      { start: 0, end: 12, speakerId: 'anakin' },
      { start: 13, end: 28, speakerId: 'obiwan' },
    ]);
    expect(result.speakerByChar.some((s) => s === 'ghost')).toBe(false);
  });

  it('(d) advances the cursor so a second identical-text unit resolves to the second occurrence', () => {
    const chapterText = 'Stop. Stop.';
    const units = [
      { text: 'Stop.', speakerId: 'first' },
      { text: 'Stop.', speakerId: 'second' },
    ];
    const result = projectToChars(chapterText, units);

    expect(result.dropped).toBe(0);
    expect(result.spans).toEqual([
      { start: 0, end: 5, speakerId: 'first' },
      { start: 6, end: 11, speakerId: 'second' },
    ]);
  });

  it('(e) speakerByChar.length === chapterText.length', () => {
    const chapterText = 'Hello there. General Kenobi.';
    const units = [
      { text: 'Hello there.', speakerId: 'anakin' },
      { text: 'General Kenobi.', speakerId: 'obiwan' },
    ];
    const result = projectToChars(chapterText, units);

    expect(result.speakerByChar.length).toBe(chapterText.length);
  });

  it('(f) locks the index map across a length-changing fold (… -> ...): a unit AFTER an earlier … resolves to its true ORIGINAL offsets, not the normalized ones', () => {
    // "…" (U+2026, 1 char) folds to "..." (3 chars) in normalizeForMatch, so
    // original and normalized coordinates diverge by +2 from that point on.
    // A naive implementation that used normalized match offsets directly as
    // original chapterText offsets would place the second unit's span 2
    // chars too late (and 2 chars too long, since the divergence also grows
    // by the match length not being clipped) — this test only passes if the
    // origEndForNormLen index map is actually doing its job.
    const chapterText = 'She paused… then left. "Go on," said Mara.';
    const secondUnitText = '"Go on," said Mara.';
    // Ground truth computed independently of the normalizer/implementation.
    const expectedStart = chapterText.indexOf(secondUnitText);
    const expectedEnd = expectedStart + secondUnitText.length;
    expect(expectedStart).toBeGreaterThan(0); // sanity: substring actually present

    const units = [
      { text: 'She paused...', speakerId: 'anakin' }, // normalized form of the "…" text
      { text: secondUnitText, speakerId: 'mara' },
    ];
    const result = projectToChars(chapterText, units);

    expect(result.dropped).toBe(0);
    expect(result.spans[1]).toEqual({ start: expectedStart, end: expectedEnd, speakerId: 'mara' });
    for (let i = expectedStart; i < expectedEnd; i++) {
      expect(result.speakerByChar[i]).toBe('mara');
    }
    // The first unit's own span crosses the fold too — its end must land on
    // the original "…" index (10) + 1, i.e. 11, not the normalized-length 13.
    expect(result.spans[0]).toEqual({ start: 0, end: 11, speakerId: 'anakin' });
  });

  it('(g) empty units array: speakerByChar all null (length === chapterText.length), spans empty, dropped === 0', () => {
    const chapterText = 'Hello there. General Kenobi.';
    const result = projectToChars(chapterText, []);

    expect(result.dropped).toBe(0);
    expect(result.spans).toEqual([]);
    expect(result.speakerByChar.length).toBe(chapterText.length);
    expect(result.speakerByChar.every((s) => s === null)).toBe(true);
  });

  it('(h) a unit with empty text is skipped (not matched as a zero-length span at the cursor), counts toward dropped, and does not corrupt speakerByChar', () => {
    // char-project.ts guards `nUnit ? norm.indexOf(...) : -1` — an empty
    // string is falsy in JS, so an empty-text unit always takes the -1
    // branch and is treated exactly like a not-located unit (dropped++,
    // chars untouched), never a zero-length match at normCursor.
    const chapterText = 'Hello there. General Kenobi.';
    const units = [
      { text: '', speakerId: 'ghost' },
      { text: 'Hello there.', speakerId: 'anakin' },
    ];
    const result = projectToChars(chapterText, units);

    expect(result.dropped).toBe(1);
    expect(result.spans).toEqual([{ start: 0, end: 12, speakerId: 'anakin' }]);
    expect(result.speakerByChar.some((s) => s === 'ghost')).toBe(false);
  });
});
