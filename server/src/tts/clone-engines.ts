/* Shared clone-engine vocabulary — pure helpers for working with cloned voices
   across Qwen and Coqui engines. Imported by six later tasks to avoid
   reimplementing manifest-slot mapping, storage-key prefixing, and cloned-vs-designed
   logic independently.

   Critical domain facts:
   - TtsEngine union includes 'qwen' and 'coqui', among others (kokoro, gemini, piper).
   - Only 'qwen' and 'coqui' support cloned voices.
   - The manifest slot key for 'coqui' is 'xtts'; for 'qwen' it's 'qwen'.
   - A voice slot's provenance ('cloned' | 'designed' | 'imported') determines cloned-ness,
     not a storage-key prefix — qwen-<uuid> carries designed voices too.
   - overrideTtsVoices is a map keyed by engine; each slot can carry name, libraryUuid, and provenance.
*/

import type { TtsEngine } from './model-keys.js';

export type CloneEngine = 'qwen' | 'coqui';

export const CLONE_CAPABLE_ENGINES: ReadonlySet<TtsEngine> = Object.freeze(
  new Set<TtsEngine>(['qwen', 'coqui']),
);

/** Type guard: returns true for clone-capable engines. */
export function isCloneEngine(e: TtsEngine): e is CloneEngine {
  return e === 'qwen' || e === 'coqui';
}

/** Maps a clone engine to its manifest slot key.
    - 'qwen' → 'qwen'
    - 'coqui' → 'xtts' (the XTTS v2 slot on the manifest)
*/
export function manifestSlotFor(e: CloneEngine): 'qwen' | 'xtts' {
  return e === 'coqui' ? 'xtts' : 'qwen';
}

/** Produces a storage key for a cloned voice.
    - 'qwen' + uuid → 'qwen-<uuid>'
    - 'coqui' + uuid → 'xtts-<uuid>'
*/
export function cloneStorageKey(e: CloneEngine, uuid: string): string {
  const prefix = manifestSlotFor(e);
  return `${prefix}-${uuid}`;
}

/** Returns true if a character has a cloned voice on ANY clone-capable engine.
    Critical: returns false for a 'designed' or 'imported' slot, even if it
    carries a libraryUuid. Cloned-ness is determined by provenance, not
    by the presence of libraryUuid or a storage-key prefix.
*/
export function characterHasClonedSlot(c: { overrideTtsVoices?: unknown }): boolean {
  const slots = c.overrideTtsVoices;
  if (!slots || typeof slots !== 'object') return false;

  for (const engine of CLONE_CAPABLE_ENGINES) {
    const slot = (slots as Record<string, unknown>)[engine];
    if (
      slot &&
      typeof slot === 'object' &&
      'provenance' in slot &&
      slot.provenance === 'cloned'
    ) {
      return true;
    }
  }

  return false;
}

/** Returns the cloned slot for a specific engine if it exists and is cloned,
    otherwise undefined. Returns only the libraryUuid field (the critical signal).
    Non-clone engines or designed/imported slots return undefined.
*/
export function clonedSlotForEngine(
  c: { overrideTtsVoices?: unknown },
  e: TtsEngine,
): { libraryUuid: string } | undefined {
  if (!isCloneEngine(e)) return undefined;

  const slots = c.overrideTtsVoices;
  if (!slots || typeof slots !== 'object') return undefined;

  const slot = (slots as Record<string, unknown>)[e];
  if (
    !slot ||
    typeof slot !== 'object' ||
    !('provenance' in slot) ||
    slot.provenance !== 'cloned'
  ) {
    return undefined;
  }

  const libraryUuid = (slot as Record<string, unknown>).libraryUuid;
  if (typeof libraryUuid !== 'string') {
    return undefined;
  }

  return { libraryUuid };
}
