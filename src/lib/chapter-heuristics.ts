/* Front/back-matter detection for the confirm-stage chapter list.
   Most parser output isn't perfectly clean — a 50,000-word EPUB usually
   includes 4–6 sections the listener doesn't want narrated: Dedication,
   Copyright, About the Author, Acknowledgements, etc. We pre-suggest
   those for exclusion so the user only has to override the false
   positives. */

const FRONT_MATTER_RX =
  /^(dedication|copyright|preface|foreword|acknowledg|about the author|about the publisher|table of contents|contents|epigraph|introduction(?!\s*\(|\s+to\b)|by the same author|also by|praise for|colophon|afterword|appendix|notes\b|bibliograph|index\b|glossary|halftitle|half[- ]title|frontispiece|imprint|publisher's note|publisher’s note|author's note|author’s note|translator's note|translator’s note)/i;

/* Word-count cutoff below which we treat a chapter as likely front- or
   back-matter regardless of title. Real narrative chapters in published
   fiction sit comfortably above 1,000 words; even flash-fiction collections
   tend to be ≥250 per piece. 150 is a conservative floor that catches
   typical Dedication / Copyright / Epigraph pages without snagging a
   short epilogue. */
export const FRONT_MATTER_WORD_THRESHOLD = 150;

export function isLikelyFrontMatter(title: string, wordCount: number | undefined): boolean {
  const t = (title ?? '').trim();
  if (t && FRONT_MATTER_RX.test(t)) return true;
  if (typeof wordCount === 'number' && wordCount > 0 && wordCount <= FRONT_MATTER_WORD_THRESHOLD) {
    return true;
  }
  return false;
}

/* Match the server's slug derivation in server/src/workspace/paths.ts so
   confirm-stage exclusion lists reach `/api/books` with slugs the server
   recognises. The combined form is `${id-pad}-${slug(title)}`. */
function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

export function chapterSlug(id: number, title: string): string {
  return `${String(id).padStart(2, '0')}-${slugify(title)}`;
}
