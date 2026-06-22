/* language-registry — the single source of truth for per-language data
   (fs-41/fs-50). Seam 1 (foundation) holds only the fields `language.ts`
   reads today: `code`, `sidecarName`, `supported`. Later seams EXTEND
   LanguageEntry with the detection slice, text-pipeline lexicons, and
   `refText` (see the fs-41/fs-50 spec §2) and add es/fr/de entries — each
   gated `supported:false` until its validation gate passes.

   `en` and `ru` are seeded `supported:true`: ru shipped validated under
   fs-2, so it is grandfathered past the per-language gate. */

export interface LanguageEntry {
  /** BCP-47 primary subtag, lower-cased (e.g. 'en', 'ru', 'es'). */
  code: string;
  /** Sidecar/analyzer language word — also the confirm-selector label. */
  sidecarName: string;
  /** True only once the language has passed its validation gate. */
  supported: boolean;
  /** Detection routing: the script class + the franc ISO-639-3 code for this language. */
  detect: { script: 'latin' | 'cyrillic'; iso6393: string };
}

const ENTRIES: readonly LanguageEntry[] = [
  { code: 'en', sidecarName: 'English', supported: true,  detect: { script: 'latin',    iso6393: 'eng' } },
  { code: 'ru', sidecarName: 'Russian', supported: true,  detect: { script: 'cyrillic', iso6393: 'rus' } },
  // es/fr/de: detection identifies them, but they are not claimed until their
  // rollout phase's operator gate flips `supported` (not in this seam).
  { code: 'es', sidecarName: 'Spanish', supported: false, detect: { script: 'latin',    iso6393: 'spa' } },
  { code: 'fr', sidecarName: 'French',  supported: false, detect: { script: 'latin',    iso6393: 'fra' } },
  { code: 'de', sidecarName: 'German',  supported: false, detect: { script: 'latin',    iso6393: 'deu' } },
];

const BY_CODE: ReadonlyMap<string, LanguageEntry> = new Map(
  ENTRIES.map((e) => [e.code, e]),
);

/** Look up a registry entry by an already-normalised BCP-47 primary subtag. */
export function getLanguageEntry(code: string): LanguageEntry | undefined {
  return BY_CODE.get(code);
}

/** True when the language has passed its validation gate (registry `supported`). */
export function isSupportedLanguage(code: string): boolean {
  return BY_CODE.get(code)?.supported ?? false;
}

/** All registry entries (e.g. to build the franc `only`-set or the supported-list). */
export function allLanguageEntries(): readonly LanguageEntry[] {
  return ENTRIES;
}

/** Supported languages as {code,label} for the confirm-screen selector. */
export function supportedLanguages(): Array<{ code: string; label: string }> {
  return ENTRIES.filter((e) => e.supported).map((e) => ({ code: e.code, label: e.sidecarName }));
}
