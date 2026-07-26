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

/** Same members as `CLONE_CAPABLE_ENGINES`, typed `CloneEngine[]` instead of
    `ReadonlySet<TtsEngine>` — for callers that need to iterate as
    `CloneEngine` (e.g. to pass each member into a `CloneEngine`-typed
    function like `cloneStorageKey`) without an unchecked cast. Derived from
    the same set literal so the two can never drift. Do NOT change
    `CLONE_CAPABLE_ENGINES`'s own declared type to `ReadonlySet<CloneEngine>`
    — `ReadonlySet<T>.has(T)` would then reject a plain `TtsEngine` at the
    membership-test call sites that need it (e.g. `isCloneEngine`-adjacent
    checks against an arbitrary engine value). */
export const CLONE_ENGINE_LIST: readonly CloneEngine[] = Object.freeze(['qwen', 'coqui']);

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

/** FAIL-SAFE test (whole-character form) — "does this character have a
    cloned voice on ANY clone-capable engine?" Used by destructive guards
    that decide whether to *preserve* a character's voice state. Returns true
    purely on `provenance === 'cloned'`, on any clone-capable engine slot —
    it deliberately does NOT validate `libraryUuid`, so a malformed cloned
    slot (missing/non-string libraryUuid) still counts as cloned. When in
    doubt, preserve. See `hasClonedProvenance` (the single-engine sibling of
    this same fail-safe test) and `clonedSlotForEngine` (the different,
    uuid-validating RESOLUTION test) for the full cloned/designed vocabulary
    and when to use which.

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

/** FAIL-SAFE test (single-engine form) — "might THIS engine's slot be
    cloned?" Used by destructive guards that decide whether to *preserve* a
    specific engine's voice slot (e.g. a per-engine language-mismatch sweep
    that must not delete a cloned voice just because it can't find/match a
    baked-language manifest for it). Tests `provenance === 'cloned'` on that
    one engine's slot and NOTHING else — deliberately does NOT validate
    `libraryUuid`, so a malformed cloned slot (missing/non-string
    libraryUuid) still counts as cloned. When in doubt, preserve.

    Contrast with `clonedSlotForEngine`, the RESOLUTION test ("which clone is
    this, exactly?") for callers that need the uuid to resolve/derive/purge
    an artifact — that one MUST validate libraryUuid, because it returns it.
    Do NOT substitute `clonedSlotForEngine` in for this one in a destructive
    guard: a slot with `provenance: 'cloned'` and a missing/non-string
    libraryUuid would then read as "not cloned" and get deleted — the exact
    silent-deletion defect this function exists to prevent.
*/
export function hasClonedProvenance(c: { overrideTtsVoices?: unknown }, engine: TtsEngine): boolean {
  const slots = c.overrideTtsVoices;
  if (!slots || typeof slots !== 'object') return false;

  const slot = (slots as Record<string, unknown>)[engine];
  return (
    !!slot &&
    typeof slot === 'object' &&
    'provenance' in slot &&
    (slot as Record<string, unknown>).provenance === 'cloned'
  );
}

/** fs-38 Wave 3c — fs-2's non-English force-to-Qwen loop (generation.ts,
    chapter-splice.ts, chapter-qa-repair.ts) used to blindly overwrite
    `ttsEngine = 'qwen'` for any character not already on an eligible engine.
    That force-moved a coqui-cloned character riding the book default onto
    qwen even on a book where coqui itself IS eligible (ru/es/fr/de/zh/ja) —
    stranding the character on an engine that carries no cloned (or designed)
    voice for it.

    This decides which eligible clone-capable engine should carry the
    character instead of the blind 'qwen' force: the eligible clone-capable
    engine (qwen or coqui) whose slot is actually cloned, preferring
    `currentEngine` (the book's request-default engine, NOT the character's
    pre-loop `ttsEngine` — that's the value being replaced) when both
    qualify. Returns undefined when the character has no eligible cloned
    slot at all — the caller's existing `?? 'qwen'` fallback then reproduces
    the historical force for a non-cloned (or cloned-but-ineligible)
    character, so this function only ever ADDS a retarget, never removes the
    fallback.

    FAIL-SAFE by design — built on `hasClonedProvenance`, not
    `clonedSlotForEngine`. This is a routing decision ("which engine should
    carry this character"), not an artifact resolution ("give me the uuid to
    load/derive/purge") — the uuid is never used here, so validating it would
    only add a way for a malformed-but-real cloned slot to be silently
    skipped and forced onto qwen anyway, which is the exact regression this
    function exists to close.

    Tie-break: if the character is cloned+eligible on BOTH qwen and coqui and
    `currentEngine` matches neither (e.g. the book's default is kokoro or
    gemini), this resolves to `candidates[0]` — i.e. whichever engine
    `CLONE_ENGINE_LIST` (above) declares first ('qwen') — mirroring the
    historical unconditional qwen force for that doubly-ambiguous case. */
export function resolveClonedRetargetEngine(
  c: { overrideTtsVoices?: unknown },
  eligibleEngines: readonly TtsEngine[],
  currentEngine: TtsEngine | undefined,
): CloneEngine | undefined {
  const candidates = CLONE_ENGINE_LIST.filter(
    (e) => eligibleEngines.includes(e) && hasClonedProvenance(c, e),
  );
  if (candidates.length === 0) return undefined;
  if (currentEngine && (candidates as readonly TtsEngine[]).includes(currentEngine)) {
    return currentEngine as CloneEngine;
  }
  return candidates[0];
}

/** RESOLUTION test — "which clone is this, exactly?" Used by anything that
    needs the uuid in order to resolve, derive, or purge an artifact (it
    RETURNS the libraryUuid, so it MUST validate it — an undefined or
    non-string libraryUuid is treated as "no usable clone" and returns
    undefined). Non-clone engines, designed/imported slots, or a cloned slot
    with a missing/malformed libraryUuid all return undefined.

    Do NOT use this as a fail-safe presence check for a destructive guard —
    a malformed cloned slot (missing/non-string libraryUuid) returns
    undefined here, which a guard could misread as "not cloned" and delete
    the slot. That is the opposite of fail-safe. Use `hasClonedProvenance`
    (or `characterHasClonedSlot` for the whole-character form) for that case
    instead — those deliberately skip uuid validation because they only ever
    answer "might this be cloned?", never "give me the uuid".
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

/** RESOLUTION test that spans BOTH voice-library provenances — "which
    library voice backs this engine's slot, whatever put it there?" Unlike
    `clonedSlotForEngine` (which only recognises `provenance: 'cloned'`),
    this also accepts `provenance: 'designed'`, because *resolution* — which
    artifact does this uuid point to — is identical for a cloned and a
    designed voice-library slot. Only the *failure policy* when that
    artifact turns out to be missing differs between the two, and that is
    enforced downstream, in the pre-pass (Task 20a), never here — this
    function is pure and synchronous and has no way to check whether the
    artifact actually exists on disk.

    Like `clonedSlotForEngine`, this is a RESOLUTION test: it validates
    `libraryUuid` (must be a non-empty string) because it RETURNS it. A
    non-clone engine, an `imported` slot, a slot with no `provenance` at all
    (legacy drift — a bare `libraryUuid` with nothing to say what put it
    there), or a missing/empty/non-string `libraryUuid` all return
    undefined.

    Do NOT use this as a fail-safe presence check for a destructive guard —
    same caveat as `clonedSlotForEngine`: a malformed-but-real slot reads as
    "nothing here" and a guard could delete it. Use `hasClonedProvenance` /
    `characterHasClonedSlot` for that. Purely additive alongside the
    existing FAIL-SAFE vs RESOLUTION vocabulary above — it does not modify,
    delegate to, or get delegated to by either `clonedSlotForEngine` or the
    fail-safe helpers. */
export function libraryVoiceForEngine(
  c: { overrideTtsVoices?: unknown },
  e: TtsEngine,
): { libraryUuid: string; provenance: 'cloned' | 'designed' } | undefined {
  if (!isCloneEngine(e)) return undefined;

  const slots = c.overrideTtsVoices;
  if (!slots || typeof slots !== 'object') return undefined;

  const slot = (slots as Record<string, unknown>)[e];
  if (!slot || typeof slot !== 'object' || !('provenance' in slot)) {
    return undefined;
  }

  const provenance = (slot as Record<string, unknown>).provenance;
  if (provenance !== 'cloned' && provenance !== 'designed') {
    return undefined;
  }

  const libraryUuid = (slot as Record<string, unknown>).libraryUuid;
  if (typeof libraryUuid !== 'string' || libraryUuid.length === 0) {
    return undefined;
  }

  return { libraryUuid, provenance };
}

/** fs-38 Wave 3c, Task 18 — the shared staleness comparand, used by BOTH
    `clone-voice-resolver.ts`'s classifier (the per-chapter pre-pass) and
    `routes/voice-library.ts`'s `withComputedStaleness` (the list route), so
    the two can never independently drift on what "stale" means. Compares a
    STORED artifact-version stamp (`baseModel` for qwen, `coquiVersion` for
    coqui) against the engine's CURRENT expected version.

    Both sides of the comparison default to the empty string somewhere in
    this codebase — `derive-engine-artifact.ts` stamps `baseModel`/
    `coquiVersion` as `''` when the sidecar's response is missing the header,
    and coqui has no live "currently installed coqui-tts version" oracle yet
    (unlike qwen's `currentQwenBaseModel()`, an env-configured Node-side
    constant — nothing analogous exists for coqui, which has no
    per-deployment model-repo choice to track). Both an unknown STORED and an
    unknown CURRENT version read as "not stale" here — deliberately:

    - Unknown STORED (`''`/missing) never stale: there is nothing to compare
      against, so claiming staleness would be a guess, not a fact. This was
      qwen's existing behaviour pre-3c; extended to coqui unchanged.
    - Unknown CURRENT (`''`) never stale: for a CLONED voice specifically, the
      alternative (unknown current => always stale) would force a real GPU
      re-derive against the sidecar on every single classify call for any
      voice whose stored version happens to be non-empty — including every
      already-healthy coqui-cloned voice today, since coqui's current is
      always `''` until a real oracle exists. Repeated, needless re-derives
      cost real GPU time and risk flipping a perfectly good voice to
      Broken/derive-failed on a transient sidecar hiccup, which is a worse
      outcome for a consent-scoped cloned voice than temporarily under-
      detecting a genuine staleness this codebase has no way to observe yet
      (see the module-level "never substitute" invariant). */
export function isArtifactVersionStale(stored: string | undefined, current: string): boolean {
  return Boolean(stored) && Boolean(current) && stored !== current;
}
