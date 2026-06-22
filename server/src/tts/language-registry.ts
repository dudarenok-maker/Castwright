/* language-registry — the single source of truth for per-language data
   (fs-41/fs-50). Seam 1 (foundation) holds only the fields `language.ts`
   reads today: `code`, `sidecarName`, `supported`. Later seams EXTEND
   LanguageEntry with the detection slice, text-pipeline lexicons, and
   `refText` (see the fs-41/fs-50 spec §2) and add es/fr/de entries — each
   gated `supported:false` until its validation gate passes.

   `en` and `ru` are seeded `supported:true`: ru shipped validated under
   fs-2, so it is grandfathered past the per-language gate. */

export interface LanguageEntry {
  /** BCP-47 primary subtag, lower-cased (e.g. 'en', 'ru'). */
  code: string;
  /** Sidecar/analyzer language word — Qwen design + the analyzer preamble. */
  sidecarName: string;
  /** True only once the language has passed its validation gate. */
  supported: boolean;
}

const ENTRIES: readonly LanguageEntry[] = [
  { code: 'en', sidecarName: 'English', supported: true },
  { code: 'ru', sidecarName: 'Russian', supported: true },
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
