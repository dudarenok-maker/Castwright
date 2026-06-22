import { describe, expect, it } from 'vitest';
import { chapterSlug } from './chapter-heuristics';

/* isLikelyFrontMatter and FRONT_MATTER_RX were removed in seam 3b (fs-41/fs-50):
   front-matter detection is now server-computed per chapter (isLikelyFrontMatterTitle
   + wordCount ≤ 150) and returned in POST /api/import. Tests for that logic live
   in server/src/routes/import.test.ts and server/src/parsers/front-matter.test.ts. */

describe('chapterSlug — must match the server (paths.ts) derivation', () => {
  /* Slugs are the wire key between confirm-stage exclusion and the
     server. If these drift apart the server silently fails to mark the
     chapter excluded. */
  it('produces id-padded + slugified title', () => {
    expect(chapterSlug(1, 'Dedication')).toBe('01-dedication');
    expect(chapterSlug(2, 'Chapter One')).toBe('02-chapter-one');
    expect(chapterSlug(10, 'About the Author')).toBe('10-about-the-author');
  });

  it('strips accents and non-alphanumerics', () => {
    expect(chapterSlug(3, 'Café au Lait!')).toBe('03-cafe-au-lait');
  });

  it('falls back to "untitled" for an empty title', () => {
    expect(chapterSlug(4, '')).toBe('04-untitled');
    expect(chapterSlug(5, '   ')).toBe('05-untitled');
  });
});
