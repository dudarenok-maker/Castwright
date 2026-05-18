/* Server-side mirror of src/lib/chapter-heuristics.ts. Server (NodeNext)
   and client (Bundler) sit in separate tsconfig roots, so the regex is
   duplicated rather than imported. Keep the two in sync — if one
   changes the heuristic, change the other.

   Used by the PDF outline reader to discard outline entries that look
   like front/back-matter (Title page, Copyright, Acknowledgements, …)
   before aligning the remaining entries to parseText chapter splits. */

const FRONT_MATTER_RX =
  /^(dedication|copyright|preface|foreword|acknowledg|about the author|about the publisher|table of contents|contents|epigraph|introduction(?!\s*\(|\s+to\b)|by the same author|also by|praise for|colophon|afterword|appendix|notes\b|bibliograph|index\b|glossary|halftitle|half[- ]title|frontispiece|imprint|publisher's note|publisher’s note|author's note|author’s note|translator's note|translator’s note)/i;

export function isLikelyFrontMatterTitle(title: string): boolean {
  const t = (title ?? '').trim();
  return t.length > 0 && FRONT_MATTER_RX.test(t);
}
