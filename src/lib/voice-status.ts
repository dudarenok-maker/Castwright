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

import type { Character, Voice, TtsEngine, Sentence } from './types';

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
  /** fs-25 — true when the character has ≥1 designed Qwen emotion variant.
      Drives the ADDITIVE "Variants" badge (rendered under the Qwen voice
      label) + the "Has emotion variants" cast filter. Orthogonal to
      `lifecycle`/`reused` — it never alters either. */
  hasEmotionVariants: boolean;
  /** Number of designed emotion variants (for the badge count). */
  variantCount: number;
}

/** fs-25 — count a character's designed Qwen emotion variants. */
function countEmotionVariants(c: Character): number {
  return Object.keys(c.overrideTtsVoices?.qwen?.variants ?? {}).length;
}

/** fs-34 — index the distinct non-neutral emotions each character's quotes use,
    across the whole book. Built ONCE per cast render and shared across rows so
    the "N tags need a variant" count is O(sentences), not O(chars × sentences). */
export function usedEmotionsByCharacter(sentences: Sentence[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const s of sentences) {
    if (!s.emotion || s.emotion === 'neutral') continue;
    let set = map.get(s.characterId);
    if (!set) {
      set = new Set();
      map.set(s.characterId, set);
    }
    set.add(s.emotion);
  }
  return map;
}

/** fs-34 — how many distinct emotions this character's quotes use that DON'T yet
    have a designed Qwen variant. `usedEmotions` comes from
    `usedEmotionsByCharacter`. Engine-agnostic (the caller gates rendering to
    Qwen characters, where a missing variant actually changes the audio). */
export function countMissingVariants(
  c: Character,
  usedEmotions: Set<string> | undefined,
): number {
  if (!usedEmotions || usedEmotions.size === 0) return 0;
  const designed = new Set(Object.keys(c.overrideTtsVoices?.qwen?.variants ?? {}));
  let n = 0;
  for (const e of usedEmotions) if (!designed.has(e)) n += 1;
  return n;
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
    /* "Has a voice" means a real designed voiceId resolves — the character's own
       qwen override OR a matched library Voice that actually carries a name. A
       reused voice whose matched Voice resolves to the qwen provider but has an
       EMPTY name (the designed voiceId was never linked or was lost to a
       persistence bug) is NOT designed → "Needs voice", matching the row's
       "No voice designed yet" sub-line. Checking only the provider let that
       broken-link state mislabel itself "Designed". */
    const hasVoice =
      !!c.overrideTtsVoices?.qwen?.name ||
      (voice?.ttsVoice?.provider === 'qwen' && !!voice.ttsVoice.name);
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
  const variantCount = countEmotionVariants(c);
  return {
    lifecycle: resolveLifecyclePill(c, voice, effectiveEngine, renderedFallbackEngine),
    reused: !!c.matchedFrom,
    hasEmotionVariants: variantCount > 0,
    variantCount,
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
  /** fs-34 — the character's in-use non-neutral emotions
      (`usedEmotionsByCharacter(...).get(c.id)`). When provided, a Qwen-effective
      character with ≥1 in-use emotion lacking a designed variant also matches
      the "Needs variants" chip. Optional so existing callers keep compiling. */
  usedEmotions?: Set<string>,
): string[] {
  const { lifecycle, reused, hasEmotionVariants } = resolveVoiceStatus(c, voice, effectiveEngine);
  const keys = [lifecycle?.label ?? 'Unset'];
  if (reused) keys.push('Reused');
  if (hasEmotionVariants) keys.push('Variants');
  const isQwen = effectiveEngine === 'qwen' || voice?.ttsVoice?.provider === 'qwen';
  if (isQwen && countMissingVariants(c, usedEmotions) > 0) keys.push('Needs variants');
  return keys;
}
