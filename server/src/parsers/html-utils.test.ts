/* Unit tests for the shared HTML helpers. The numeric-entity cases pin the
   root cause of the Coalfall attribution bug (2026-06-09): an EPUB that
   encodes apostrophes as the HEX numeric reference `&#x27;` left literal
   `&#x27;` in the parsed source text, so every apostrophe-bearing evidence
   quote failed the verifier's substring match → the speaker (Master Oduvan)
   lost all evidence and was pruned from the cast, his lines folding to the
   narrator. stripHtml decoded only the DECIMAL `&#39;`, never the hex form. */

import { describe, it, expect } from 'vitest';
import {
  stripHtml,
  extractFirstHeading,
  stripTitleHeading,
  GENERIC_NCX_RE,
} from './html-utils.js';

describe('stripHtml — tag stripping', () => {
  it('still strips tags and reaches a fixed point (replace-until-stable)', () => {
    const once = stripHtml('<p>a <em>b</em></p>');
    expect(once).not.toMatch(/<[^>]+>/); // all tags removed
    expect(stripHtml(once)).toBe(once); // idempotent — no second-pass change
  });
});

describe('stripHtml — numeric character references', () => {
  it('decodes the hex apostrophe &#x27; (the Coalfall regression)', () => {
    expect(stripHtml('<p>You&#x27;ll have to make do with the second.</p>')).toBe(
      "You'll have to make do with the second.",
    );
  });

  it('still decodes the decimal apostrophe &#39;', () => {
    expect(stripHtml('<p>I&#39;m not crying.</p>')).toBe("I'm not crying.");
  });

  it('decodes hex curly punctuation (&#x2019; &#x201C; &#x201D;)', () => {
    expect(stripHtml('<p>&#x201C;I&#x2019;ve been nursing it,&#x201D; he said.</p>')).toBe(
      '“I’ve been nursing it,” he said.',
    );
  });

  it('decodes the hex double-quote &#x22; and uppercase hex digits', () => {
    expect(stripHtml('<p>&#x22;Begin,&#x22; said the dragon &#x2014; tired.</p>')).toBe(
      '"Begin," said the dragon — tired.',
    );
  });

  it('decodes a decimal reference above the named set (&#8217; right quote)', () => {
    expect(stripHtml('<p>don&#8217;t</p>')).toBe('don’t');
  });

  it('leaves real text and the existing named entities intact', () => {
    expect(stripHtml('<p>Smith &amp; Sons &lt;forge&gt; &quot;open&quot;</p>')).toBe(
      'Smith & Sons <forge> "open"',
    );
  });
});

describe('extractFirstHeading — numeric character references', () => {
  it('decodes a hex apostrophe in the heading text', () => {
    expect(extractFirstHeading('<h1>Oduvan&#x27;s Forge</h1>')).toBe("Oduvan's Forge");
  });
});

/* The chapter's <h1> is promoted to the title (spoken by synthesise-chapter's
   title beat) AND, because stripHtml flattens the whole document, it also
   survives as the body's opening line — so the listener hears the chapter name
   twice (the EPUB/MOBI duplicate-title bug). stripTitleHeading removes that one
   leading heading element when its text is already represented in the resolved
   title, but leaves a heading carrying content the title doesn't cover. */
describe('stripTitleHeading — drop the leading heading already spoken as the title', () => {
  it('removes the leading <h1> when it equals the resolved title', () => {
    const html = '<h1>The Berth at Liverpool</h1><p>It was cold.</p>';
    expect(stripHtml(stripTitleHeading(html, 'The Berth at Liverpool'))).toBe('It was cold.');
  });

  it('removes the heading when the title is the merged "Chapter N — Heading" form', () => {
    const html = '<h2>The Berth at Liverpool</h2><p>It was cold.</p>';
    expect(stripHtml(stripTitleHeading(html, 'Chapter 1 — The Berth at Liverpool'))).toBe(
      'It was cold.',
    );
  });

  it('matches case- and punctuation-insensitively (and through hex entities)', () => {
    const html = "<h1>Oduvan&#x27;s Forge</h1><p>Body.</p>";
    expect(stripHtml(stripTitleHeading(html, "ODUVAN'S FORGE"))).toBe('Body.');
  });

  it('leaves the body untouched when the heading is content the title does not cover', () => {
    // NCX title won outright; the body heading is a different string → keep it.
    const html = '<h1>Part One: Beginnings</h1><p>Body.</p>';
    expect(stripTitleHeading(html, 'The Arrival')).toBe(html);
  });

  it('does not strip on a partial within-word match', () => {
    const html = '<h1>Arr</h1><p>Body.</p>';
    expect(stripTitleHeading(html, 'The Arrival')).toBe(html);
  });

  it('is a no-op when there is no heading', () => {
    const html = '<p>Just prose, no heading.</p>';
    expect(stripTitleHeading(html, 'Chapter 1')).toBe(html);
  });

  it('removes only the first heading, leaving later section headings in the body', () => {
    const html = '<h1>The Title</h1><p>Intro.</p><h2>A Section</h2><p>More.</p>';
    const out = stripHtml(stripTitleHeading(html, 'The Title'));
    expect(out.startsWith('The Title')).toBe(false);
    expect(out).toContain('A Section');
  });
});

describe('GENERIC_NCX_RE — English (existing behaviour)', () => {
  it('matches English "Chapter N" patterns', () => {
    for (const s of ['Chapter 1', 'Chapter IV', 'Chapter Twelve', 'chapter twenty']) {
      expect(GENERIC_NCX_RE.test(s)).toBe(true);
    }
  });

  it('does not match a descriptive chapter title', () => {
    expect(GENERIC_NCX_RE.test('The Berth at Liverpool')).toBe(false);
    expect(GENERIC_NCX_RE.test('Chapter')).toBe(false); // no number
  });
});

describe('GENERIC_NCX_RE — non-English generic chapter labels (seam 3b)', () => {
  it('matches non-English generic chapter labels', () => {
    for (const s of [
      'Capítulo 3',   // Spanish
      'Kapitel 5',    // German
      'Глава 2',      // Russian
      'Chapitre IV',  // French
    ]) {
      expect(GENERIC_NCX_RE.test(s)).toBe(true);
    }
  });

  it('does not match a descriptive non-English chapter title', () => {
    expect(GENERIC_NCX_RE.test('El Comienzo del Fin')).toBe(false);
  });
});
