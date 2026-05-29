/* Shared resolver for a cast member's Status display. Two ORTHOGONAL
   dimensions, kept separate so they can render together (the previous single
   `voiceState`-driven pill collapsed them, so "Reused" hid "Generated"):

     1. `lifecycle` — the primary status pill ("tag"): the engine-aware
        Needs-voice / Designed / Sampled / Generated / Tuned / Locked / Matched
        state.
     2. `reused` — a provenance flag rendered as a small badge beside the
        pill, true whenever this character's voice was matched/reused from a
        prior book in the series.

   Consumed by the cast view's Status column (`StatusPill`) and the profile
   drawer's Voice-profile header so both surfaces agree.

   The caller passes the character's EFFECTIVE engine — its per-character
   `ttsEngine` override folded over the project default (cast view) / the live
   engine-picker choice (drawer). This matters because a DEFAULT-engine
   character on a Qwen project still synthesises via Qwen, so it follows the
   bespoke design → sample → generate lifecycle (Needs voice → Designed →
   Sampled → Generated), not the preset `voiceState` pill — without the effective engine the resolver
   can't tell a Qwen project's undesigned character ("Needs voice") from an
   auto-assigned preset one ("Matched"). The Qwen branch also fires when the
   matched library `voice` itself resolves to Qwen (a reused character carries
   its bespoke voice on the matched `Voice`, not its own fields). */

import type { Character, Voice, TtsEngine } from './types';

export type StatusPillColor = 'success' | 'warning' | 'library' | 'neutral' | 'peach';

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

function resolveLifecyclePill(
  c: Character,
  voice: Voice | undefined,
  effectiveEngine: TtsEngine,
  renderedFallbackEngine?: string | null,
): { label: string; color: StatusPillColor } | null {
  /* Qwen lifecycle when the character synthesises via Qwen (its own override
     OR the project default — both folded into `effectiveEngine`), OR when the
     matched library voice itself resolves to Qwen. */
  if (effectiveEngine === 'qwen' || voice?.ttsVoice?.provider === 'qwen') {
    /* Render-time fact wins: if this character's last render actually fell back
       to Kokoro (no designed voice, or Qwen was unavailable), say so — it
       outranks the design-lifecycle labels because it's what the listener
       hears right now. */
    if (renderedFallbackEngine === 'kokoro') {
      return { label: 'Fallback (Kokoro)', color: 'warning' };
    }
    const hasVoice = !!c.overrideTtsVoices?.qwen?.name || voice?.ttsVoice?.provider === 'qwen';
    if (!hasVoice) return { label: 'Needs voice', color: 'warning' };
    if (voice?.generated) return { label: 'Generated', color: 'success' };
    /* A synthesised 12s audition sits between bare design and rendered
       chapter audio. `generated` (rendered) outranks `sampled` above. */
    if (voice?.sampled) return { label: 'Sampled', color: 'peach' };
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

export function resolveVoiceStatus(
  c: Character,
  voice: Voice | undefined,
  effectiveEngine: TtsEngine,
  /** Engine this character ACTUALLY rendered in last generation, when it
      differs from its configured engine (from the segments/characterSnapshots
      `renderedFallbackEngine`). `'kokoro'` surfaces the "Fallback (Kokoro)"
      pill. Omit when no render metadata is available — the design-lifecycle
      pill renders as before. */
  renderedFallbackEngine?: string | null,
): VoiceStatusBadges {
  return {
    lifecycle: resolveLifecyclePill(c, voice, effectiveEngine, renderedFallbackEngine),
    reused: !!c.matchedFrom,
  };
}

/** The status-filter keys a character matches, for the cast view's status
    filter (cast.tsx). Derives from the same `resolveVoiceStatus` the row pills
    use so the chips and the rows can never diverge: the lifecycle label (or
    'Unset' for a character with no resolvable lifecycle yet), plus 'Reused'
    when the voice was matched from a prior book. A character matches a chip if
    ANY of its keys is selected (OR semantics). */
export function statusFilterKeys(
  c: Character,
  voice: Voice | undefined,
  effectiveEngine: TtsEngine,
): string[] {
  const { lifecycle, reused } = resolveVoiceStatus(c, voice, effectiveEngine);
  const keys = [lifecycle?.label ?? 'Unset'];
  if (reused) keys.push('Reused');
  return keys;
}
