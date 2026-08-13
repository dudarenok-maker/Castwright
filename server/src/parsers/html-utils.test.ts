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

describe('stripHtml — scene-break preservation (#1679)', () => {
  it('converts <hr> to a standalone word-free separator line', () => {
    const body = stripHtml('<p>End of scene one.</p><hr/><p>Scene two begins.</p>');
    const units = body.split(/\n[ \t]*\n/).map((u) => u.trim());
    expect(units).toContain('* * *');
    expect(body).toContain('End of scene one.');
    expect(body).toContain('Scene two begins.');
  });

  it('preserves an existing <p>* * *</p> separator line', () => {
    const body = stripHtml('<p>Before.</p><p>* * *</p><p>After.</p>');
    const units = body.split(/\n[ \t]*\n/).map((u) => u.trim());
    expect(units).toContain('* * *');
  });

  it('handles <hr> with attributes and whitespace', () => {
    const body = stripHtml('<p>A.</p>\n<hr class="scene" />\n<p>B.</p>');
    const units = body.split(/\n[ \t]*\n/).map((u) => u.trim());
    expect(units).toContain('* * *');
  });
});

describe('stripHtml — named character references (#2310)', () => {
  /* Why the complete HTML5 set and not a curated list: the curated list is
     what this repo already tried twice and was bitten by both times — the
     original five-entry set (XML-predefined + &nbsp;, copied wholesale in the
     first server commit), and es/fr `dialogueOpen` carrying &mdash; but not
     &ndash; (#2289). An enumeration of spellings loses a spelling per round. */
  it('#2310: decodes the dash entities that opened this bug', () => {
    expect(stripHtml('<p>&ndash; Un momento &mdash; dijo él.</p>')).toBe(
      '– Un momento — dijo él.',
    );
  });

  it('#2310: decodes accented letters — the case that corrupts whole words', () => {
    expect(stripHtml('<p>&eacute;t&eacute; &agrave; la fen&ecirc;tre</p>')).toBe(
      'été à la fenêtre',
    );
  });

  it('#2310: decodes typographic punctuation and guillemets', () => {
    expect(stripHtml('<p>&laquo;Привет&raquo;&hellip; &rsquo;tis</p>')).toBe(
      '«Привет»… ’tis',
    );
  });

  it('#2310: decodes &apos; — an XML-predefined entity the hand-rolled set dropped', () => {
    expect(stripHtml('<p>&apos;tis</p>')).toBe("'tis");
  });

  /* decodeHTMLStrict vs decodeHTML. decodeHTML implements HTML5's legacy
     semicolon-less rule and would render these `Fish ¬ice this` /
     `Copyright © 2026`. This test is the ONLY thing pinning that choice —
     swapping to decodeHTML turns it red. */
  it('#2310: a bare ampersand in prose is never decoded (decodeHTMLStrict, not decodeHTML)', () => {
    expect(stripHtml('<p>Fish &notice this</p>')).toBe('Fish &notice this');
    expect(stripHtml('<p>Copyright &copy 2026</p>')).toBe('Copyright &copy 2026');
    expect(stripHtml('<p>Smith & Sons, AT&T and R&D</p>')).toBe('Smith & Sons, AT&T and R&D');
  });

  it('#2310: an unknown entity is left literal', () => {
    expect(stripHtml('<p>&unknownentity; stays</p>')).toBe('&unknownentity; stays');
  });

  it('#2310: &amp;ndash; single-passes to &ndash;, never to a dash', () => {
    expect(stripHtml('<p>&amp;ndash;</p>')).toBe('&ndash;');
  });

  it('#2310: &nbsp; still yields U+0020, not U+00A0 — and so do its aliases', () => {
    expect(stripHtml('<p>A&nbsp;B</p>')).toBe('A B');
    expect(stripHtml('<p>A&nbsp;B</p>')).not.toContain('\u00a0');
    expect(stripHtml('<p>A&NonBreakingSpace;B</p>')).not.toContain('\u00a0');
  });

  /* The contract at html-utils.ts:15-16 — documented since the Coalfall fix
     but never pinned by a test until now. decodeHTMLStrict maps these to
     U+FFFD, which stripUnsafeForTts does NOT remove, so a whole-string
     decodeHTMLStrict call would send a replacement char to the TTS engine.

     ONLY these two, and this is measured, not assumed: `codePointOr` guards
     `!Number.isFinite`, `< 0` and `> 0x10ffff`, so `&#0;` and `&#xD800;` DO
     decode today (to NUL and a lone surrogate, both removed later by
     `stripUnsafeForTts`). Adding those two here ships a RED test — an earlier
     draft of this plan did exactly that, and probing is how it was caught. */
  it('#2310: out-of-range numeric references are still left literal', () => {
    for (const ref of ['&#99999999;', '&#x110000;']) {
      const out = stripHtml(`<p>A${ref}B</p>`);
      expect(out).toBe(`A${ref}B`);
      expect(out).not.toContain('\ufffd');
    }
  });

  /* Found by adversarial review: these decode BEFORE the `[ \t]+\n` and
     `\n{3,}` collapses at html-utils.ts:58-59, and the parsers emit one
     paragraph per line — so they can change chapter STRUCTURE, not just
     wording. Vanishingly rare in real ebook output; pinned anyway, because
     "rare" is not "handled". */
  it('#2310: &NewLine; / &Tab; decode without corrupting paragraph structure', () => {
    expect(stripHtml('<p>A&Tab;B</p>')).toBe('A\tB');
    expect(stripHtml('<p>One&NewLine;Two</p>').split('\n').filter(Boolean)).toEqual(['One', 'Two']);
  });
});

describe('extractFirstHeading — named entities (#2310)', () => {
  /* The chapter title is spoken as its own title beat and — unlike body text —
     never passes through the stage-2 model, so this path reproduces #2310
     unconditionally, whatever the model does with dashes. */
  it('#2310: decodes named entities in a heading', () => {
    expect(extractFirstHeading('<h1>L&rsquo;&Eacute;t&eacute; &mdash; Tome I</h1>')).toBe(
      'L’Été — Tome I',
    );
  });
  it('#2310: still leaves a bare ampersand alone', () => {
    expect(extractFirstHeading('<h1>Smith &amp; Sons, AT&T</h1>')).toBe('Smith & Sons, AT&T');
  });
});
