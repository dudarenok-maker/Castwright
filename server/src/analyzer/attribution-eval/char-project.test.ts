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
});
