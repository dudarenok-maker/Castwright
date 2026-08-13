/* #2310 — the end-to-end guard. `stripHtml` decodes the entity (Task 2) and
   the dash pipeline (`dialogueOpen`, LEADING_DASH, softenDashes) then treats it
   exactly like a literal dash. This test spans BOTH layers on purpose: a future
   change to either one that reopens the bug turns it red, which a unit test at
   one layer alone would not catch.

   Asserted as EQUALITY AGAINST THE GLYPH FORM, never against a hardcoded
   string — the point is that the two forms agree, whatever `softenDashes`
   renders a leading dash as. A hardcoded expectation would drift. */
import { describe, expect, it } from 'vitest';
import { extractFirstHeading, stripHtml } from '../parsers/html-utils.js';
import { normaliseForTts } from './text-normalize.js';

describe('#2310 — an entity-opened dialogue line reaches the engine as the glyph does', () => {
  const cases = [
    { lang: 'es', entity: '&ndash; Un momento &mdash; dijo él.', glyph: '– Un momento — dijo él.' },
    { lang: 'es', entity: '&mdash; Un momento.', glyph: '— Un momento.' },
    { lang: 'fr', entity: '&ndash; Un instant &mdash; dit-il.', glyph: '– Un instant — dit-il.' },
    { lang: 'ru', entity: '&mdash; Кто там?', glyph: '— Кто там?' },
    { lang: 'ru', entity: '&ndash; Стой.', glyph: '– Стой.' },
  ];

  for (const { lang, entity, glyph } of cases) {
    it(`${lang}: ${entity.slice(0, 12)}… normalises identically to the glyph form`, () => {
      const fromEntity = normaliseForTts(stripHtml(`<p>${entity}</p>`), lang);
      const fromGlyph = normaliseForTts(stripHtml(`<p>${glyph}</p>`), lang);
      expect(fromEntity).toBe(fromGlyph);
      /* Non-vacuity: equality alone would hold if BOTH sides were broken (e.g.
         if stripHtml stopped decoding and softenDashes stopped firing). Pin
         that the marker actually became a pause and no entity text survives. */
      expect(fromEntity).not.toMatch(/&[a-zA-Z]+;/);
      expect(fromEntity.startsWith('... ')).toBe(true);
    });
  }

  it('the accented-letter case — the one that corrupts whole words, not just openers', () => {
    const out = normaliseForTts(stripHtml('<p>&ndash; C&rsquo;est l&rsquo;&eacute;t&eacute;.</p>'), 'fr');
    expect(out).not.toMatch(/&[a-zA-Z]+;/);
    expect(out).toContain('été');
  });

  /* Closes the vacuity hole review found: LEADING_DASH (matches a leading
     en/em dash, optionally surrounded by whitespace) collapses en AND em
     dash to the same '... ', so the equality assertions above pass even if
     the decode produced the WRONG dash. Assert on the pre-normalisation
     stripHtml output, where the two are still distinguishable. */
  it('the decoded dash is the RIGHT codepoint, not merely dash-like', () => {
    expect(stripHtml('<p>&ndash; x</p>')).toBe('– x'); // U+2013 en
    expect(stripHtml('<p>&mdash; x</p>')).toBe('— x'); // U+2014 em
  });

  /* The model-independent path (spec Finding 0). Chapter titles never reach
     stage-2, so this reproduces regardless of what the model does — it is the
     assertion to trust when the body-path symptom is model-conditional. */
  it('the chapter-title beat: an entity-laden heading is spoken clean', () => {
    const title = extractFirstHeading('<h1>L&rsquo;&Eacute;t&eacute; &mdash; Tome I</h1>')!;
    const spoken = normaliseForTts(title, 'fr');
    expect(spoken).not.toMatch(/&[a-zA-Z]+;/);
    expect(spoken).toContain('L’Été');
  });
});
