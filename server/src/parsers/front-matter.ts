/* Server-side mirror of src/lib/chapter-heuristics.ts. Server (NodeNext)
   and client (Bundler) sit in separate tsconfig roots, so the regex is
   duplicated rather than imported. Keep the two in sync — if one
   changes the heuristic, change the other.

   Used by the PDF outline reader to discard outline entries that look
   like front/back-matter (Title page, Copyright, Acknowledgements, ...)
   before aligning the remaining entries to parseText chapter splits.

   seam 3b (fs-41/fs-50): English alternation kept inline; non-English
   terms pulled from the language-registry union so any new language only
   needs a `frontMatterKeywords` entry in the registry. Apostrophes in
   registry terms are normalised to match both straight (U+0027) and
   curly (U+2019) forms. */

import { nonEnglishFrontMatterKeywords } from '../tts/language-registry.js';

/* Word-count floor below which a chapter is treated as likely front-/back-matter
   (e.g. a short Dedication or Copyright page). Mirrored in
   src/lib/chapter-heuristics.ts for the client-side reparse-dialog fallback. */
export const FRONT_MATTER_WORD_THRESHOLD = 150;

/* CJK (Han/Kana) scripts don't use inter-word whitespace, so a whitespace
   split yields ~1 "word" per paragraph — a full CJK chapter then reads as
   ~30-60 "words" and trips the front-matter word-count floor (fs-59 W2
   task 2.7). Self-detects on Han/Kana presence: absent CJK chars, this is
   byte-identical to the original whitespace-split behaviour. When present,
   CJK chars are stripped to whitespace first (so they aren't ALSO counted
   as a Latin token) and re-added as char-equivalents at ~1.7 chars/word —
   the same ratio used elsewhere for CJK reading-time estimates. Exported
   (moved from routes/import.ts, #2263) so the chapter-aware language
   detector's own front-matter selection counts words the same way the
   confirm screen's `isLikelyFrontMatter` flag does — a chapter can't be
   selected as a detection body chapter by one measure and flagged
   front-matter by the other. */
const HAN_RE = /\p{Script=Han}/gu;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const CJK_CHARS_PER_WORD = 1.7;

export function countWords(s: string): number {
  const cjkCharCount = (s.match(HAN_RE)?.length ?? 0) + (s.match(KANA_RE)?.length ?? 0);
  if (cjkCharCount === 0) {
    return s.trim().split(/\s+/).filter(Boolean).length;
  }
  const latinWordCount = s
    .replace(HAN_RE, ' ')
    .replace(KANA_RE, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return latinWordCount + Math.round(cjkCharCount / CJK_CHARS_PER_WORD);
}

/* English alternation -- kept as a literal string so it reads exactly as
   it did in the original literal regex. The character class ['’]
   matches both straight and curly apostrophes in publisher/author/translator
   note entries. */
const EN_FRONT_MATTER =
  'dedication|copyright|preface|foreword|acknowledg|about the author|about the publisher|' +
  'table of contents|contents|epigraph|introduction(?!\\s*\\(|\\s+to\\b)|by the same author|' +
  'also by|praise for|colophon|afterword|appendix|notes\\b|bibliograph|index\\b|glossary|' +
  'halftitle|half[- ]title|frontispiece|imprint|' +
  "publisher['\\u2019]s note|author['\\u2019]s note|translator['\\u2019]s note";

/* Regex-escape a registry term and normalise any apostrophe (straight U+0027
   or curly U+2019) to the character class ['’] so both forms match in
   real EPUB/typeset titles. */
function escapeAndNormalise(term: string): string {
  // Escape all regex special chars, then replace any apostrophe variant
  // with a character class matching both straight and curly forms.
  const APOSTROPHE_CLASS = "['\\u2019]";
  return term
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/['’]/g, APOSTROPHE_CLASS);
}

const FRONT_MATTER_RX = new RegExp(
  `^(?:${EN_FRONT_MATTER}|${nonEnglishFrontMatterKeywords().map(escapeAndNormalise).join('|')})`,
  'iu',
);

export function isLikelyFrontMatterTitle(title: string): boolean {
  const t = (title ?? '').trim();
  return t.length > 0 && FRONT_MATTER_RX.test(t);
}
