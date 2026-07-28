/* fs-38 Wave 1, Task 16 — VoiceProvenanceBadge.

   ONE shared badge for a character's/voice's per-engine override SLOT
   (`overrideTtsVoices[engine]`), rendered by two surfaces so they read the
   same provenance the same way: the In-use Designed cards footer in
   `src/views/voices.tsx`, and (as of Wave 3c) the cloned-entry provenance
   marker on the "My voices" library card in
   `src/components/voices/voice-library-card.tsx`. `voice-library-panel.tsx`
   and `profile-drawer.tsx` render `VoiceLibraryEntry` objects directly
   (inherently "My voice") rather than an override slot, so they don't
   consume this component — despite `voice-library-panel.tsx` name-dropping
   it in a comment. Landing this once here is what lets Wave 3's cloned/
   imported treatments (spec §4 "shared voice-card treatment") extend a
   single component instead of drifted copies.

   Reads exactly `voice.overrideTtsVoices[engine]` — pinned via the
   `VoiceProvenanceSlot` type below, derived from `Voice['overrideTtsVoices']`
   (the OpenAPI-generated shape) rather than hand-typed, so a schema change
   there surfaces here as a type error instead of silent drift.

   Four branches, derived from the slot alone:
     - `slot.libraryUuid` set        → "My voice" (pulled from / saved to the
       standalone voice library — outranks `provenance` since a promoted
       character's slot can carry both).
     - `slot.provenance === 'designed'` (no libraryUuid) → "Designed" (a
       bespoke voice designed for this character specifically).
     - `slot.provenance === 'cloned'` (no libraryUuid) → "Cloned" (Wave 3 —
       a voice cloned from a sample recording; the My-voices library surface
       is where a cloned slot has no libraryUuid to outrank it).
     - anything else (no slot, or a preset engine's plain override) →
       "Catalogue" (a stock/prebuilt speaker). */

import type { Voice } from '../../lib/types';
import { Pill } from '../primitives';

export type VoiceProvenanceSlot = NonNullable<Voice['overrideTtsVoices']>[string];

interface Props {
  slot: VoiceProvenanceSlot | undefined;
}

export function VoiceProvenanceBadge({ slot }: Props) {
  if (slot?.libraryUuid) {
    return (
      <Pill color="library">
        <span data-testid="voice-provenance-badge">My voice</span>
      </Pill>
    );
  }
  if (slot?.provenance === 'designed') {
    return (
      <Pill color="peach">
        <span data-testid="voice-provenance-badge">Designed</span>
      </Pill>
    );
  }
  if (slot?.provenance === 'cloned') {
    return (
      <Pill color="library">
        <span data-testid="voice-provenance-badge">Cloned</span>
      </Pill>
    );
  }
  return (
    <Pill color="neutral">
      <span data-testid="voice-provenance-badge">Catalogue</span>
    </Pill>
  );
}
