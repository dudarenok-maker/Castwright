/* fs-2 / fs-32c — never-cross-language enforcement for a reused designed voice.

   A designed Qwen voice bakes its language into the on-disk sidecar manifest at
   design time. When such a voice is reused on a DIFFERENT-language book, reading
   the new book's text through it would produce wrong-language audio. This helper
   walks the (already engine-forced) cast and, for every character carrying a
   designed Qwen voice whose manifest language ≠ the book's expected language,
   clears the override so the voice reads as UNDESIGNED — which the
   `forbidKokoroFallback` gate then blocks (the user re-designs it in the book's
   language).

   Extracted from generation.ts so both the full-chapter generate path AND the
   fs-26 splice re-record path apply the identical re-check (fs-32c). */

import { readJson } from '../workspace/state-io.js';
import { qwenVoiceSidecarPath } from '../workspace/paths.js';
import type { CastCharacter } from './synthesise-chapter.js';
import { qwenStorageKey } from './voice-mapping.js';

/** Clear any reused designed Qwen voice whose baked manifest language doesn't
    match the book's. `expectedLang` is the sidecar language WORD
    (`sidecarLanguageName(bookLanguage)`); `bookLanguage` is the raw BCP-47 tag,
    used only for the warning text. Mutates the cast in place. No-op for English
    books (callers gate this behind `isNonEnglish`). */
export async function clearMismatchedDesignedVoices(
  cast: CastCharacter[],
  expectedLang: string,
  bookLanguage: string,
): Promise<void> {
  for (const c of cast) {
    const designedName = c.overrideTtsVoices?.qwen?.name;
    if (!designedName) continue;
    const manifest = await readJson<{ language?: string }>(
      qwenVoiceSidecarPath(qwenStorageKey(c, c.id)),
    ).catch(() => null);
    if (!manifest || manifest.language !== expectedLang) {
      if (c.overrideTtsVoices?.qwen) delete c.overrideTtsVoices.qwen;
      console.warn(
        `[generation] ${c.name ?? c.id}: designed Qwen voice "${designedName}" ` +
          `is not ${expectedLang} (manifest: ${manifest?.language ?? 'missing'}) — ` +
          `treating as undesigned, re-design required for this ${bookLanguage} book.`,
      );
    }
  }
}
