/* BCP-47 book language ↔ sidecar language-name mapping (fs-2).

   The book data model stores a BCP-47 string (`'en'`, `'ru'`, open-ended);
   the Qwen sidecar's `design_voice` expects the language *word* (`'English'`,
   `'Russian'`). This module is the single place that bridges the two so the
   never-cross-language invariant has one source of truth. Only `en`+`ru` are
   wired in v1 — adding a language is a one-line table entry here, not a
   contract migration (the field stays an open string everywhere else). */

export const DEFAULT_LANGUAGE = 'en';

/* Primary-subtag → sidecar language word. Keep keys lower-cased primary
   subtags; the lookup normalises before indexing. */
const SIDECAR_LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Russian',
};

/** Lower-cased primary subtag of a BCP-47 tag (`'ru-RU'` → `'ru'`). */
function primarySubtag(bcp47: string): string {
  return bcp47.trim().toLowerCase().split('-')[0] ?? '';
}

/** Normalise a raw/absent language value to a BCP-47-ish primary subtag,
    defaulting to `'en'`. Missing, empty, or whitespace → `'en'`. */
export function normaliseBookLanguage(raw: string | undefined | null): string {
  const primary = primarySubtag(raw ?? '');
  return primary || DEFAULT_LANGUAGE;
}

/** The sidecar's language word for a BCP-47 book language. Unknown codes fall
    back to `'English'` with a warning — a stray code must never throw and break
    generation, but it also must never silently mis-route, so we log it. */
export function sidecarLanguageName(bcp47: string): string {
  const primary = normaliseBookLanguage(bcp47);
  const name = SIDECAR_LANGUAGE_NAMES[primary];
  if (!name) {
    console.warn(
      `[language] no sidecar language name for "${bcp47}" (primary "${primary}") — falling back to English`,
    );
    return 'English';
  }
  return name;
}

/** True when the book is not English (primary subtag ≠ `'en'`). Drives the
    never-cross-language enforcement: a non-English book forces every character
    onto a designed Qwen voice and blocks the Kokoro fallback. */
export function isNonEnglish(bcp47: string): boolean {
  return normaliseBookLanguage(bcp47) !== DEFAULT_LANGUAGE;
}
