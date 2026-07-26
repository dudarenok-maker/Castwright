/* Resolve a REUSED character's bespoke voice from its source book.

   The bug this fixes: a reused Qwen character carries `voiceId` + `matchedFrom`
   but NOT `ttsEngine` / `overrideTtsVoices` — those live on the SOURCE book's
   character that originally designed the voice. The reuse write paths
   (voice-match.ts, cast-link-prior.ts) only propagate the identity key
   (voiceId/aliases), so at generation time `pickVoiceForEngine('qwen', …)` —
   which reads ONLY `overrideTtsVoices.qwen.name` — returns '' and the chapter
   falls back to Kokoro instead of the designed voice (see
   tts/voice-mapping.ts:pickVoiceForEngine + synthesise-chapter.ts:applyQwenFallback).

   This helper, given a character with `matchedFrom` and no own qwen override,
   walks the matchedFrom chain back to the book that actually carries the
   override and returns a character enriched with that book's `ttsEngine` +
   `overrideTtsVoices`. Runtime-only resolution: it consults the cast.json of
   sibling books, never the on-disk voices/qwen/*.pt files (that file-existence
   fallback is reserved for the one-time data-recovery migration).

   The cast loader is injected so the resolution logic is unit-testable without
   a real workspace; `hydrateReusedVoice` wires the default workspace loader. */

import type { TtsEngine } from './index.js';
import { characterHasClonedSlot } from './clone-engines.js';

/* fs-25 — the per-engine override slot, carrying optional Qwen emotion
   `variants`. Declared here so the reuse-carry path is type-honest: a reused
   character must inherit the source's variants alongside its base voice (plan
   177 Wave 6a), mirroring how `voiceStyle` already travels (plan 150).

   [ADV-C3][EX-10] — also carries `libraryUuid`/`provenance`, mirroring the
   canonical shape in voice-mapping.ts. Omitting these here was exactly why
   the compiler couldn't flag a cloned slot being laundered through this
   reuse path: type-checking a cloned slot's fields as if they didn't exist
   let the merge/engine logic below treat it as an ordinary designed slot. */
type OverrideSlot = {
  name: string;
  libraryUuid?: string;
  provenance?: 'designed' | 'cloned' | 'imported';
  variants?: Partial<Record<string, { name: string }>>;
};
type OverrideMap = Partial<Record<TtsEngine, OverrideSlot>>;

/** The reuse-relevant slice of a cast.json character this resolver reads. Kept
    structural (not the full CastCharacter) so callers can pass either a server
    CastCharacter or a migration's raw record. */
export interface ReuseHydratable {
  id: string;
  ttsEngine?: TtsEngine | null;
  /** srv-43 — immutable per-voice identity (nanoid) minted at design time. */
  voiceUuid?: string;
  overrideTtsVoices?: OverrideMap | null;
  /** The Qwen voice-design persona (plan 108). Like the override, it lives on
      the SOURCE book's character; reuse paths denormalise it onto the reused
      row alongside the override (srv-18) so cast.json stays self-complete. */
  voiceStyle?: string;
  matchedFrom?: {
    bookId?: string;
    characterId?: string;
  } | null;
}

/** Loads a book's cast characters by bookId, or null when the book / cast is
    absent. Injected for testability. */
export type CastLoader = (bookId: string) => Promise<ReuseHydratable[] | null>;

/** True when the character already carries a usable bespoke (qwen) voice on its
    own record — nothing to hydrate. A slot counts if it has a `name` OR a
    `libraryUuid` — a cloned qwen slot can legitimately carry a libraryUuid
    with an empty/missing name (see voice-mapping.ts's storage-key fallback),
    so name-only was a fail-unsafe test for that case. */
function hasOwnVoice(c: ReuseHydratable): boolean {
  const slot = c.overrideTtsVoices?.qwen;
  return !!slot?.name || !!slot?.libraryUuid;
}

/** The voice fields a reused character should inherit from its source, or null
    when none can be resolved (no chain, missing books, or the source itself
    never carried an override). Follows the `matchedFrom` chain so a multi-hop
    reuse (book C reused from B reused from A, where A holds the override)
    still resolves. Guards against cycles + a sane depth cap. */
export interface ResolvedReusedVoice {
  ttsEngine?: TtsEngine | null;
  /** srv-43 — immutable per-voice identity (nanoid) minted at design time. */
  voiceUuid?: string;
  overrideTtsVoices: OverrideMap;
  voiceStyle?: string;
}

export async function resolveReusedVoiceFields(
  character: ReuseHydratable,
  load: CastLoader,
  maxHops = 8,
): Promise<ResolvedReusedVoice | null> {
  /* A character that already owns a qwen voice needs no hydration. */
  if (hasOwnVoice(character)) return null;

  /* [ADV-C3][EX-10] — a character that already carries a CLONED voice on some
     other clone-capable engine (e.g. coqui) must never inherit or default
     onto qwen here: it already has its own established engine + identity (a
     real person's likeness), and rerouting it would launder the source
     book's designed qwen voice onto it as if it belonged to this character.
     Fail-safe test (provenance only, doesn't require a valid libraryUuid) —
     when in doubt, preserve. This also protects every other caller of this
     resolver (e.g. series-reuse-link.ts), not just hydrateCharacterVoice
     below, since none of them may default `source.ttsEngine ?? 'qwen'`
     for such a character either. */
  if (characterHasClonedSlot(character)) return null;

  const seen = new Set<string>();
  let cursor: ReuseHydratable = character;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const from: ReuseHydratable['matchedFrom'] = cursor.matchedFrom;
    if (!from || !from.bookId || !from.characterId) return null;
    const fromBookId: string = from.bookId;
    const fromCharacterId: string = from.characterId;

    const cycleKey = `${fromBookId}::${fromCharacterId}`;
    if (seen.has(cycleKey)) return null;
    seen.add(cycleKey);

    const sourceCast = await load(fromBookId);
    if (!sourceCast) return null;
    const source: ReuseHydratable | undefined = sourceCast.find(
      (c) => c.id === fromCharacterId,
    );
    if (!source) return null;

    /* Found a source that carries the bespoke voice — inherit its engine +
       override. (Engine may be absent on the source even when the override is
       present — e.g. a source written before the per-character engine field;
       callers fold this over the project default, so undefined is fine.) */
    if (hasOwnVoice(source)) {
      return {
        ttsEngine: source.ttsEngine ?? 'qwen',
        overrideTtsVoices: source.overrideTtsVoices ?? {},
        voiceStyle: source.voiceStyle,
        voiceUuid: source.voiceUuid,
      };
    }

    /* Source is itself a reuse with no override of its own — follow its chain. */
    cursor = source;
  }

  return null;
}

/** Return a shallow copy of `character` enriched with the source book's
    `ttsEngine` + `overrideTtsVoices` + `voiceStyle` when it's a reuse missing
    its own bespoke voice; otherwise return the character unchanged. Merges
    (does not clobber) any existing override slots on the character — its own
    slots win — and keeps the character's own persona when it already has one. */
export async function hydrateCharacterVoice<T extends ReuseHydratable>(
  character: T,
  load: CastLoader,
): Promise<T & Pick<ReuseHydratable, 'ttsEngine' | 'overrideTtsVoices' | 'voiceStyle'>> {
  const resolved = await resolveReusedVoiceFields(character, load);
  if (!resolved) return character;

  /* [ADV-C3][EX-10] — belt-and-suspenders alongside the same guard inside
     resolveReusedVoiceFields: this merge step must never inherit or default
     ttsEngine (nor merge in a foreign engine's slot) for a character that
     already carries a cloned voice on another engine. */
  if (characterHasClonedSlot(character)) return character;

  const mergedOverrides: OverrideMap = {
    ...resolved.overrideTtsVoices,
    ...(character.overrideTtsVoices ?? {}),
  };

  return {
    ...character,
    ttsEngine: character.ttsEngine ?? resolved.ttsEngine ?? null,
    overrideTtsVoices: mergedOverrides,
    voiceStyle: character.voiceStyle ?? resolved.voiceStyle,
  };
}
