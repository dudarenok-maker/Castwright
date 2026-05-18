/* Shared HTML helpers for the EPUB and MOBI parsers. Both formats expose
   chapter bodies as HTML strings, so the strip / heading-extract / generic-
   chapter-label logic is identical between them. */

import { tagHtmlEmphasis } from './audio-tags.js';

/* Strip HTML tags from a chapter body, decode common entities, and convert
   block-level breaks to plain-text newlines. Folds `<em>/<i>/<strong>` into
   `[emphasis]…[/emphasis]` tags via tagHtmlEmphasis before stripping so the
   audio-tag information survives the strip. */
export function stripHtml(html: string): string {
  return tagHtmlEmphasis(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Pull the first h1/h2/h3 text from chapter HTML so we have a fallback
   when the NCX / spine title is missing or generic. Strips inline tags
   (`<em>`, `<strong>`, `<span>`) from the heading text and collapses
   whitespace. Returns null when no heading is present in the first ~8 KB
   of the document. */
const FIRST_HEADING_RE = /<h[1-3][^>]*>([\s\S]{0,400}?)<\/h[1-3]>/i;
export function extractFirstHeading(html: string): string | null {
  const m = FIRST_HEADING_RE.exec(html);
  if (!m) return null;
  const raw = m[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (raw.length === 0 || raw.length > 200) return null;
  return raw;
}

/* "Chapter 1" / "Chapter IV" / "Chapter Twelve" with nothing else.
   Used to detect generic NCX titles that should be augmented with the
   body's <h1>. Mirrors the bare-numbered-heading test in text.ts but
   self-contained here to keep the parsers loosely coupled. */
export const GENERIC_NCX_RE =
  /^chapter\s+(?:[ivxlcdm\d]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?\s*$/i;
