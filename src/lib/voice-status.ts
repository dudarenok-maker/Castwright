/* Shared resolver for a cast member's Status display. Two ORTHOGONAL
   dimensions, kept separate so they can render together (the previous single
   `voiceState`-driven pill collapsed them, so "Reused" hid "Generated"):

     1. `lifecycle` — the primary status pill ("tag"): the engine-aware
        Designed / Generated / Tuned / Locked / Matched state.
     2. `reused` — a provenance flag rendered as a small badge beside the
        pill, true whenever this character's voice was matched/reused from a
        prior book in the series.

   Consumed by the cast view's Status column (`StatusPill`) and the profile
   drawer's Voice-profile header so both surfaces agree. The Qwen branch
   mirrors `resolveDisplayTtsVoice` in `src/views/cast.tsx`: a reused character
   carries its bespoke Qwen voice on the matched library `Voice`, not on its
   own `ttsEngine`/`overrideTtsVoices`, so the lifecycle must look at the
   matched voice too — otherwise a reused Qwen character reads "Matched"
   instead of "Designed/Generated". */

import type { Character, Voice } from './types';

export type StatusPillColor = 'success' | 'warning' | 'library' | 'neutral';

export interface VoiceStatusBadges {
  /** Primary status pill, or null when the character has no resolvable state
      yet (e.g. a freshly-added blank row). */
  lifecycle: { label: string; color: StatusPillColor } | null;
  /** True when the voice was reused/matched from a prior book. Keyed off
      `matchedFrom` (not `voiceState === 'reused'`) so the badge survives a
      later tune/lock, which flips `voiceState` away from 'reused' but keeps
      the match provenance. */
  reused: boolean;
}

/* Does this character resolve to a bespoke Qwen voice? Either it's pinned to
   the Qwen engine per-character, OR it reused a library voice that itself
   resolves to Qwen (the reuse path leaves `ttsEngine` unset on the character
   and carries the Qwen voice on the matched Voice). */
function resolvesToQwen(c: Character, voice: Voice | undefined): boolean {
  return c.ttsEngine === 'qwen' || voice?.ttsVoice?.provider === 'qwen';
}

function resolveLifecyclePill(
  c: Character,
  voice: Voice | undefined,
): { label: string; color: StatusPillColor } | null {
  if (resolvesToQwen(c, voice)) {
    const hasVoice = !!c.overrideTtsVoices?.qwen?.name || voice?.ttsVoice?.provider === 'qwen';
    if (!hasVoice) return { label: 'Needs voice', color: 'warning' };
    if (voice?.generated) return { label: 'Generated', color: 'success' };
    return { label: 'Designed', color: 'library' };
  }
  switch (c.voiceState) {
    case 'generated':
      return { label: 'Matched', color: 'success' };
    case 'tuned':
      return { label: 'Tuned', color: 'warning' };
    case 'reused':
      /* Provenance now lives on the Reused badge; the lifecycle for a reused
         preset voice is "matched to a library voice" = ready. */
      return { label: 'Matched', color: 'success' };
    case 'locked':
      return { label: 'Locked', color: 'neutral' };
    default:
      return null;
  }
}

export function resolveVoiceStatus(c: Character, voice: Voice | undefined): VoiceStatusBadges {
  return {
    lifecycle: resolveLifecyclePill(c, voice),
    reused: !!c.matchedFrom,
  };
}
