/* Build the spoken phrase the narrator says at the top of each chapter.

   The display title on disk (set by `server/src/parsers/text.ts:284–304`)
   co-encodes the chapter number and an optional name into one string via
   `:` / `—` / `–` / `-` separators — e.g. "Chapter 3 — The Beginning" or
   "Chapter 2". The narrator must speak number and name as a clean
   two-clause utterance ("Chapter 3. The Beginning.") rather than reading
   the punctuation aloud. This module re-emits the title as TTS-friendly
   prose; the caller in `synthesise-chapter.ts` then prepends one TTS call
   with this string spoken by the narrator voice. */

const CHAPTER_PREFIX_AND_NUMBER = (() => {
  const word = '(?:Chapter|Ch\\.?|Part|Book)';
  const arabic = '\\d+';
  const roman = '[IVXLCDM]+';
  const spelled =
    '(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)';
  const num = `(?:${arabic}|${roman}|${spelled})`;
  const sep = '\\s*[:\\-–—]\\s*';
  return new RegExp(`^(${word}\\s+${num})(?:${sep}(.+))?$`, 'i');
})();

/* Trailing separator/whitespace stripper. A parser output like "Chapter 5:"
   (the author wrote `Chapter 5:` followed by an empty subtitle line) should
   render as "Chapter 5." — without this, the regex below treats the trailing
   colon as bare-name content and emits "Chapter 5:." which TTS reads as
   "Chapter five colon period." */
const TRAILING_SEPARATORS = /[\s:\-–—]+$/;

export function buildChapterTitleNarration(chapter: {
  id: number;
  title: string | null | undefined;
}): string | null {
  const raw = (chapter.title ?? '').trim().replace(TRAILING_SEPARATORS, '');
  if (!raw) {
    if (!Number.isFinite(chapter.id)) return null;
    return `Chapter ${chapter.id}.`;
  }

  const m = CHAPTER_PREFIX_AND_NUMBER.exec(raw);
  if (m) {
    const chapterPart = m[1].trim();
    const namePart = m[2]?.trim();
    return namePart ? `${chapterPart}. ${namePart}.` : `${chapterPart}.`;
  }

  /* Manuscript labelled this chapter purely by name (e.g. "Prologue",
     "Day One", "Moolark"). Speak it verbatim — do NOT auto-inject
     "Chapter N." because that mispronounces front-matter like Prologue
     as "Chapter 1. Prologue." The user can rename the chapter via the
     existing rename UI if they want a numbered announcement. */
  return `${raw}.`;
}
