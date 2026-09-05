/* Plan 276 (fs-cast-readiness), Decision 5 — the adapter + selector that turn
   redux state into per-character `CloneReadinessInput` (Decision 3) and
   collect the `cloneReadiness` verdicts. Feeds `startGenerationFlow`'s clone
   gate and Task 7's `clone-readiness-gate.tsx` modal.

   `cloneReadiness`/`clone-engines.ts` are server modules imported into the
   browser bundle by value — the same production precedent as
   `src/data/help-failures.ts` (see plan 276 Decision 3, "One implementation,
   imported by both sides" + the Task-1 build-gate probe). Do NOT reimplement
   the predicate here.

   Five traps this file exists to avoid (plan 276 task-6 brief):

   1. `characterHasSlot` (the field `cloneReadiness` reads) MUST be
      `hasClonedProvenance(character, engine)` — the CHARACTER's own cast
      slot for THIS engine — never the library entry's slot (a Qwen clone has
      no `xtts` library slot, so reading the library slot makes the ordinary
      Coqui-routed case misreport `wrong-engine`) and never the engine-
      agnostic `characterHasClonedSlot` (which would make rule 3 true for
      every cloned character, reinstating the generic-substitution trap).
   2. Library slot lookup goes through `manifestSlotFor` — `coqui` maps to
      manifest slot `xtts`. Never index `entry.engines.coqui`.
   3. `slotStatus` is read AS-RECEIVED from `GET /api/voice-library` — that
      route already applies `withComputedStaleness` server-side (and no
      longer overwrites a persisted `'failed'`, plan 276 Decision 2 [R3]) —
      never re-derived or "corrected" client-side.
   4. Engine resolution is `character.ttsEngine ?? engineForModelKey(ui.ttsModelKey)`
      — the SAME two-tier resolution `resolveCharacterEngine`
      (server/src/tts/per-character-engine.ts:22-27) uses, reading the same
      session value the generation POST will carry. Must not fork it.
   5. The entry condition is `characterHasClonedSlot(character)` (engine-
      agnostic — routing is what the check evaluates, never what gates it)
      PLUS the legacy bare-uuid shape below (#1891) — omitting the legacy
      shape leaves it permanently unchecked even though
      `synthesise-chapter.ts`'s `legacyQwenLibraryRequests` hard-fails it at
      render like any other cloned voice. */

import { createSelector } from '@reduxjs/toolkit';
import {
  cloneReadiness,
  type CloneReadinessInput,
  type CloneUnready,
} from '../../server/src/tts/clone-readiness';
import {
  characterHasClonedSlot,
  hasClonedProvenance,
  manifestSlotFor,
  isCloneEngine,
  CLONE_ENGINE_LIST,
  type CloneEngine,
} from '../../server/src/tts/clone-engines';
import { engineForModelKey } from '../lib/tts-models';
import type { RootState } from './index';
import type { Character, TtsEngine } from '../lib/types';
import type { VoiceLibraryEntry } from './voice-library-slice';

export interface CloneCharacterVerdict {
  characterId: string;
  characterName: string;
  /** The engine this character will actually render on this run — Decision 4. */
  engine: TtsEngine;
  reason: CloneUnready;
  /** The clone-capable engine to offer as "Cast on <engine>" for a
      `wrong-engine` verdict, or null when no re-cast would fix it. Always
      null for any other reason; callers should only read it when
      `reason === 'wrong-engine'`. */
  castOnEngine: CloneEngine | null;
}

/** [R3] Legacy bare-uuid shape (#1891) — a qwen slot carrying a `libraryUuid`
    with NO `provenance` field at all (pre-dates the provenance dimension).
    `characterHasClonedSlot` deliberately requires `provenance: 'cloned'` and
    so is false for this shape, yet `synthesise-chapter.ts`'s
    `legacyQwenLibraryRequests` (`:1598-1615`) still builds a resolver
    request for it and hard-fails it exactly like a real cloned voice.
    Scoped to qwen only, mirroring the render (there is no coqui analogue). */
function isLegacyBareQwenSlot(character: Character): boolean {
  const qwenSlot = character.overrideTtsVoices?.qwen;
  return (
    typeof qwenSlot?.libraryUuid === 'string' &&
    qwenSlot.libraryUuid.length > 0 &&
    qwenSlot.provenance === undefined
  );
}

/** Decision 5 entry condition — trap 5 above. */
export function characterNeedsCloneCheck(character: Character): boolean {
  return characterHasClonedSlot(character) || isLegacyBareQwenSlot(character);
}

/** Decision 4 — mirrors `resolveCharacterEngine`
    (server/src/tts/per-character-engine.ts:22-27) exactly. Must not fork. */
function resolveEngine(
  character: Character,
  ttsModelKey: Parameters<typeof engineForModelKey>[0],
): TtsEngine {
  return character.ttsEngine ?? engineForModelKey(ttsModelKey);
}

/** For a character with a REAL cloned slot (`characterHasClonedSlot` true),
    which library uuid backs the check at `engine` — mirrors
    `synthesise-chapter.ts`'s `clonedEngineFor` (`:1513-1533`): prefer
    `engine`'s own slot when it IS cloned, else fall back to whichever
    clone-capable engine (`CLONE_ENGINE_LIST` order) IS cloned. This is what
    lets the entry/consent lookup resolve correctly even when the main
    check is about to report `wrong-engine` — the revoked check must still
    run against the character's REAL cloned entry, not silently skip. */
function libraryUuidForClonedCharacter(character: Character, engine: TtsEngine): string | undefined {
  const chosenEngine: CloneEngine | undefined = hasClonedProvenance(character, engine)
    ? (engine as CloneEngine)
    : CLONE_ENGINE_LIST.find((e) => hasClonedProvenance(character, e));
  if (!chosenEngine) return undefined;
  const slot = character.overrideTtsVoices?.[chosenEngine];
  return typeof slot?.libraryUuid === 'string' && slot.libraryUuid.length > 0
    ? slot.libraryUuid
    : undefined;
}

/** Builds the `CloneReadinessInput` for one character at one engine — shared
    by the real per-character check (`engine` = the character's resolved
    render engine, Decision 4) and `castOnEngine` (`engine` = each
    routed-engine-excluded clone-capable candidate, Decision 5). Returns
    `undefined` only when the character has no cloned (or legacy bare-uuid)
    slot at all — `characterNeedsCloneCheck` is the single source of truth for
    that, so a designed or catalogue slot never reaches the gate regardless of
    what its own uuid-shaped field happens to contain.

    A cloned (or legacy) slot whose `libraryUuid` is missing, empty or
    malformed still gets a real input, with `libraryUuidResolvable: false` —
    `cloneReadiness`'s rule 1 turns that into the `unresolvable-uuid` verdict
    (#2054) so the gate names it instead of going silent while the render
    hard-fails it (`clone-voice-resolver.ts`'s `misconfigured` reason). */
function buildInput(
  character: Character,
  engine: TtsEngine,
  entries: readonly VoiceLibraryEntry[],
): CloneReadinessInput | undefined {
  if (!characterNeedsCloneCheck(character)) return undefined;

  const isLegacy = !characterHasClonedSlot(character) && isLegacyBareQwenSlot(character);
  /* Trap 1 — this is `hasClonedProvenance`, never the library slot and never
     `characterHasClonedSlot`. The legacy shape is the one deliberate
     exception: it carries no `provenance` tag at all, so `hasClonedProvenance`
     is always false for it: `engine === 'qwen'` is the legacy equivalent,
     mirroring the render's `wrongEngine = routeFor(c).engine !== 'qwen'`
     (synthesise-chapter.ts:1613) for `legacyQwenLibraryRequests`. */
  const characterHasSlot = isLegacy ? engine === 'qwen' : hasClonedProvenance(character, engine);

  const libraryUuid = isLegacy
    ? (character.overrideTtsVoices?.qwen?.libraryUuid as string | undefined)
    : libraryUuidForClonedCharacter(character, engine);
  const libraryUuidResolvable = !!libraryUuid;

  const entry = libraryUuid ? entries.find((e) => e.voiceUuid === libraryUuid) : undefined;
  /* Trap 2 + trap 3 — `manifestSlotFor`, never a raw `entry.engines.coqui`
     index; the status is used exactly as `GET /api/voice-library` served it. */
  const slotStatus =
    entry && isCloneEngine(engine) ? entry.engines?.[manifestSlotFor(engine)]?.status : undefined;

  return {
    libraryUuidResolvable,
    entryFound: !!entry,
    consentRevoked: !!entry?.consent?.revokedAt,
    slotStatus,
    hasMaster: !!entry?.master,
    transcript: entry?.master?.transcript,
    engine,
    characterHasSlot,
  };
}

/** Decision 5's `castOnEngine` — which clone-capable engine, if any, "Cast on
    <engine>" should offer for a `wrong-engine` verdict. Iterates
    `CLONE_ENGINE_LIST` (never a hardcoded `['qwen', 'coqui']` pair — see
    `clone-engines.ts`'s own rationale for why) EXCLUDING the character's
    currently routed engine, and returns the first candidate the check comes
    back clean for. `CLONE_ENGINE_LIST`'s declared order ('qwen' before
    'coqui') is the deterministic tie-break when both remaining candidates
    are clean — an arbitrary-but-stable choice, not an accident. This
    subsumes the old binary swap (`otherCloneCapableEngine`, since removed):
    a qwen-routed character has only 'coqui' left once qwen is excluded, so
    behaviour for that case is unchanged.

    Trap 4 (of the plan's revision history, not this file's five): the
    per-candidate `characterHasSlot` MUST be `hasClonedProvenance` (arity 2,
    single-engine) — `characterHasClonedSlot` takes ONE argument and does not
    compile with two; dropping the second argument silently makes this
    always-true for any cloned character.

    `buildInput` already computes `characterHasSlot` correctly for the
    candidate engine — legacy-aware (trap 1's `isLegacy ? engine === 'qwen' :
    hasClonedProvenance(...)`), which is exactly trap 4's requirement on the
    non-legacy path and the ONLY correct answer on the legacy one. Do NOT
    recompute/overwrite it with a bare `hasClonedProvenance(character,
    candidate)` here — `hasClonedProvenance` is false for the legacy
    bare-uuid shape on every engine by definition (it has no `provenance`
    field at all), so overwriting silently self-rejects every candidate for a
    legacy character and `castOnEngine` comes back `null` even when "Cast on
    Qwen" would fix it. */
function castOnEngineFor(
  character: Character,
  mainInput: CloneReadinessInput,
  entries: readonly VoiceLibraryEntry[],
): CloneEngine | null {
  const candidates = CLONE_ENGINE_LIST.filter((candidate) => candidate !== mainInput.engine);
  for (const candidate of candidates) {
    const candidateInput = buildInput(character, candidate, entries);
    if (!candidateInput) continue;
    const verdict = cloneReadiness(candidateInput);
    if (verdict === null) return candidate;
  }
  return null;
}

/* Stable empty array so the closed-gate / no-cloned-cast case (the common
   one) doesn't hand `useSelector` a fresh `[]` on every call — mirrors
   `voice-readiness-selectors.ts`'s `NO_UNDESIGNED_CHARACTERS` and the #1285
   fix it cites (react-redux's dev-mode stability check would otherwise force
   a re-render on every store dispatch for a global always-mounted modal). */
const NO_CLONE_VERDICTS: CloneCharacterVerdict[] = [];

/** All per-character clone-readiness verdicts for the CURRENT book's cast
    (`state.cast.characters` is single-book-scoped today — `bookId` is kept
    for API symmetry with `selectUndesignedQwenCharacters`, don't "clean up"
    the unused param later). Memoised via `createSelector` for the same
    reason cited above. */
export const selectCloneReadinessVerdicts = createSelector(
  [
    (state: RootState) => state.ui.ttsModelKey,
    (state: RootState) => state.cast.characters,
    (state: RootState) => state.voiceLibrary.entries,
    (_state: RootState, bookId: string) => bookId,
  ],
  (ttsModelKey, characters, entries): CloneCharacterVerdict[] => {
    const verdicts: CloneCharacterVerdict[] = [];
    for (const character of characters) {
      if (!characterNeedsCloneCheck(character)) continue;
      const engine = resolveEngine(character, ttsModelKey);
      const input = buildInput(character, engine, entries);
      if (!input) continue;
      const reason = cloneReadiness(input);
      if (!reason) continue;
      verdicts.push({
        characterId: character.id,
        characterName: character.name,
        engine,
        reason,
        castOnEngine: reason === 'wrong-engine' ? castOnEngineFor(character, input, entries) : null,
      });
    }
    return verdicts.length > 0 ? verdicts : NO_CLONE_VERDICTS;
  },
);

/** Whether `startGenerationFlow`'s clone gate should fire for this book. */
export function selectCloneReadinessGateShouldFire(state: RootState, bookId: string): boolean {
  return selectCloneReadinessVerdicts(state, bookId).length > 0;
}

/** Cheap, synchronous pre-check `startGenerationFlow` uses to decide whether
    it's even worth dispatching `fetchVoiceLibrary` — a plain (no cloned/
    legacy characters at all) cast has nothing this check could ever flag. */
export function castNeedsCloneCheck(characters: readonly Character[]): boolean {
  return characters.some(characterNeedsCloneCheck);
}
