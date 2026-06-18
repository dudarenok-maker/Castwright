/* Unit tests for the shared HTML helpers. The numeric-entity cases pin the
   root cause of the Coalfall attribution bug (2026-06-09): an EPUB that
   encodes apostrophes as the HEX numeric reference `&#x27;` left literal
   `&#x27;` in the parsed source text, so every apostrophe-bearing evidence
   quote failed the verifier's substring match → the speaker (Master Oduvan)
   lost all evidence and was pruned from the cast, his lines folding to the
   narrator. stripHtml decoded only the DECIMAL `&#39;`, never the hex form. */

import { describe, it, expect } from 'vitest';
import { stripHtml, extractFirstHeading } from './html-utils.js';

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
