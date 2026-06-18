/* Shared HTML helpers for the EPUB and MOBI parsers. Both formats expose
   chapter bodies as HTML strings, so the strip / heading-extract / generic-
   chapter-label logic is identical between them. */

import { tagHtmlEmphasis } from './audio-tags.js';

/* Decode numeric character references — both hex (`&#x27;`) and decimal
   (`&#39;`). EPUB serializers very commonly emit the HEX apostrophe
   `&#x27;`; decoding only the named set plus the decimal `&#39;` left the
   hex form literal in the parsed source text, which silently broke
   evidence-quote matching: every apostrophe-bearing quote failed the
   verifier's substring check, so a speaker whose evidence all carried
   apostrophes lost the cast entirely and his lines folded to the narrator
   (the Coalfall / Master Oduvan regression, 2026-06-09). Invalid or out-of-
   range references are left untouched rather than dropped. */
export function decodeNumericEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => codePointOr(m, parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => codePointOr(m, parseInt(dec, 10)));
}

function codePointOr(original: string, codePoint: number): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return original;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return original;
  }
}

/* Strip HTML tags from a chapter body, decode common entities, and convert
   block-level breaks to plain-text newlines. Folds `<em>/<i>/<strong>` into
   `[emphasis]…[/emphasis]` tags via tagHtmlEmphasis before stripping so the
   audio-tag information survives the strip. */
export function stripHtml(html: string): string {
  let s = tagHtmlEmphasis(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n');
  // Replace-until-stable: a single `<[^>]+>` pass can leave a reconstructed tag.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^>]+>/g, '');
  } while (s !== prev);
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  return decodeNumericEntities(s)
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
  const raw = decodeNumericEntities(
    m[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&'),
  )
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
