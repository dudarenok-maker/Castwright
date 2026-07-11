/* BCP-47 book language ↔ sidecar language-name mapping (fs-2).

   The book data model stores a BCP-47 string (`'en'`, `'ru'`, open-ended);
   the Qwen sidecar's `design_voice` expects the language *word* (`'English'`,
   `'Russian'`). This module is the single place that bridges the two so the
   never-cross-language invariant has one source of truth. Only `en`+`ru` are
   wired in v1 — adding a language is a one-line table entry here, not a
   contract migration (the field stays an open string everywhere else). */

import { getLanguageEntry } from './language-registry.js';
import { ENGINE_LANGUAGE_SUPPORT } from './voice-mapping.js';
import type { TtsEngine } from './model-keys.js';

export const DEFAULT_LANGUAGE = 'en';

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

/** The sidecar's language word for a BCP-47 book language.
    Throws for any language code not present in the registry — an unsupported
    language must never silently default to English and ship cross-language garbage.
    The confirm-screen support gate blocks unsupported languages before they reach
    the voice pipeline, so a throw here is a fail-loud safety net for the cases
    where that gate was bypassed or the registry is out of sync. */
export function sidecarLanguageName(bcp47: string): string {
  const primary = normaliseBookLanguage(bcp47);
  const entry = getLanguageEntry(primary);
  if (!entry) {
    throw new Error(
      `[language] unsupported language reached the voice pipeline: bcp47="${bcp47}" primary="${primary}". ` +
        `Add it to the language registry or block it at the confirm-screen support gate.`,
    );
  }
  return entry.sidecarName;
}

/** True when the book is not English (primary subtag ≠ `'en'`). Drives the
    never-cross-language enforcement: a non-English book forces every character
    onto a designed Qwen voice and blocks the Kokoro fallback. */
export function isNonEnglish(bcp47: string): boolean {
  return normaliseBookLanguage(bcp47) !== DEFAULT_LANGUAGE;
}

/** fs-60 — which engines from `installedEngines` are eligible to render
    `bookLanguage`, per ENGINE_LANGUAGE_SUPPORT. Pure data-driven filter — no
    per-language branching. Replaces the scattered isNonEnglish/forbidKokoroFallback
    derivations at the three server enforcement sites (generation.ts,
    chapter-splice.ts, chapter-qa-repair.ts) and backs the eligibleTtsEngines
    API field frontend callers read. */
export function resolveEligibleEngines(
  bookLanguage: string,
  installedEngines: TtsEngine[],
): TtsEngine[] {
  const lang = normaliseBookLanguage(bookLanguage);
  return installedEngines.filter((engine) => {
    const support = ENGINE_LANGUAGE_SUPPORT[engine];
    return support === '*' || support.includes(lang);
  });
}
