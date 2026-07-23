/* projectToChars projects attributed sentence-level units onto chapter-body
   character positions — the foundation of a segmentation-invariant
   attribution metric (unlike scorer.ts's line-level scoreAttribution, which
   collapses whitespace/brackets via normalise() and has no positional
   correspondence back to chapterText). */
import { describe, it, expect } from 'vitest';
import { projectToChars, stripInlineTags } from './char-project.js';

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

describe('stripInlineTags', () => {
  it('removes a mid-text [..] tag and maps every kept char back to its original index', () => {
    // 'say [excited] hi' : s0 a1 y2 ' '3 [excited]=4..12 ' '13 h14 i15
    const { stripped, map } = stripInlineTags('say [excited] hi');
    expect(stripped).toBe('say hi'); // the tag + its flanking double space collapse to one
    expect(map.slice(0, stripped.length)).toEqual([0, 1, 2, 3, 14, 15]);
    expect(map[stripped.length]).toBe('say [excited] hi'.length); // exclusive-end sentinel
  });

  it('keeps a legit leading space when a tag sits at the very start (only the unit path trims it)', () => {
    expect(stripInlineTags('[excited] Help!').stripped).toBe(' Help!');
  });

  it('collapses the double space a mid-sentence tag would leave, keeping a single separator', () => {
    const { stripped } = stripInlineTags('A [emphatic] cat');
    expect(stripped).toBe('A cat'); // not "A  cat"
  });

  it('preserves newlines (paragraph breaks are not collapsed) and leaves tag-free text untouched (identity map)', () => {
    const plain = 'Line one.\n\nLine two.';
    const { stripped, map } = stripInlineTags(plain);
    expect(stripped).toBe(plain);
    expect(map).toEqual([...Array(plain.length).keys(), plain.length]); // identity + sentinel
  });

  it('leaves a lone "[" with no closing bracket as a literal char', () => {
    expect(stripInlineTags('a [ b').stripped).toBe('a [ b');
  });
});

describe('projectToChars (stripTags option)', () => {
  it('(i) with stripTags, locates a unit whose spoken text is split by an inline tag; span covers the spoken chars, tag positions stay null', () => {
    // chapterText carries the inline tag (the raw body); the truth unit is the
    // corrected form WITHOUT it. The tag sits INSIDE the spoken run, so the unit
    // is not a verbatim substring — default (no stripTags) drops it.
    const chapterText = 'Before. Help [hesitant] me now. After.';
    const units = [{ text: 'Help me now.', speakerId: 'bob' }];

    expect(projectToChars(chapterText, units).dropped).toBe(1); // baseline: unlocated
    const res = projectToChars(chapterText, units, { stripTags: true });
    expect(res.dropped).toBe(0);
    const start = chapterText.indexOf('Help'); // 8
    const end = chapterText.indexOf('now.') + 'now.'.length; // after the final '.'
    expect(res.spans).toEqual([{ start, end, speakerId: 'bob' }]);
    // spoken chars on BOTH sides of the tag are painted…
    for (const frag of ['Help', 'me now.']) {
      const at = chapterText.indexOf(frag);
      for (let i = at; i < at + frag.length; i++) expect(res.speakerByChar[i]).toBe('bob');
    }
    // …but chars inside the tag are not.
    const tagAt = chapterText.indexOf('[hesitant]');
    for (let i = tagAt; i < tagAt + '[hesitant]'.length; i++)
      expect(res.speakerByChar[i]).toBe(null);
  });

  it('(j) index-map lock across a stripped tag: a later unit still resolves to its true ORIGINAL offsets', () => {
    const chapterText = 'A [emphatic] big cat. "Meow," said Tom.';
    const secondUnit = '"Meow," said Tom.';
    const expectedStart = chapterText.indexOf(secondUnit);
    const expectedEnd = expectedStart + secondUnit.length;
    expect(expectedStart).toBeGreaterThan(0);

    const res = projectToChars(
      chapterText,
      [
        { text: 'A big cat.', speakerId: 'narr' }, // tag-stripped form of the first sentence
        { text: secondUnit, speakerId: 'tom' },
      ],
      { stripTags: true },
    );
    expect(res.dropped).toBe(0);
    expect(res.spans[1]).toEqual({ start: expectedStart, end: expectedEnd, speakerId: 'tom' });
    for (let i = expectedStart; i < expectedEnd; i++) expect(res.speakerByChar[i]).toBe('tom');
  });

  it('(k) a tag-only unit strips to empty and is dropped (never a zero-length match)', () => {
    const chapterText = 'Real words here.';
    const res = projectToChars(chapterText, [{ text: '[emphatic]', speakerId: 'ghost' }], {
      stripTags: true,
    });
    expect(res.dropped).toBe(1);
    expect(res.speakerByChar.every((s) => s === null)).toBe(true);
  });

  it('(l) stripTags is opt-in: default behavior is byte-identical to no options (tag-free corpus)', () => {
    const chapterText = 'Hello there. General Kenobi.';
    const units = [
      { text: 'Hello there.', speakerId: 'anakin' },
      { text: 'General Kenobi.', speakerId: 'obiwan' },
    ];
    expect(projectToChars(chapterText, units, { stripTags: true })).toEqual(
      projectToChars(chapterText, units),
    );
  });
});
