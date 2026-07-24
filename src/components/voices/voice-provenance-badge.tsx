/* fs-38 Wave 1, Task 16 — VoiceProvenanceBadge.

   ONE shared badge for a character's/voice's per-engine override SLOT
   (`overrideTtsVoices[engine]`), rendered by three surfaces so they read the
   same provenance the same way: the In-use Designed cards in
   `src/views/voices.tsx`, the panel cards in `voice-library-panel.tsx`, and
   the drawer rows in `profile-drawer.tsx`. Landing it once here is what lets
   Wave 3's cloned/imported treatments (spec §4 "shared voice-card treatment")
   extend a single component instead of three drifted copies.

   Reads exactly `voice.overrideTtsVoices[engine]` — pinned via the
   `VoiceProvenanceSlot` type below, derived from `Voice['overrideTtsVoices']`
   (the OpenAPI-generated shape) rather than hand-typed, so a schema change
   there surfaces here as a type error instead of silent drift.

   Three branches, derived from the slot alone:
     - `slot.libraryUuid` set        → "My voice" (pulled from / saved to the
       standalone voice library — outranks `provenance` since a promoted
       character's slot can carry both).
     - `slot.provenance === 'designed'` (no libraryUuid) → "Designed" (a
       bespoke voice designed for this character specifically).
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
  return (
    <Pill color="neutral">
      <span data-testid="voice-provenance-badge">Catalogue</span>
    </Pill>
  );
}
