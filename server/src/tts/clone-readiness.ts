/* Plan 276 (fs-cast-readiness), Decision 3 — a purpose-built predicate that
   answers: "if this character renders on engine E, will its cloned voice
   resolve — assuming the machine is up?"

   This is NOT `classifyClonedVoice` (clone-voice-resolver.ts) reused or
   wrapped. Two earlier revisions of the design borrowed a predicate written
   for an adjacent question and inherited its policy by accident:

   - Rev 1 borrowed `classifyClonedVoice`, which never inspects
     `master.transcript` — it only tests `entry.master` truthiness — so a
     master with no transcript classified as `repairable` with no reason.
   - Rev 2 borrowed `clonedAssignBlock`, which short-circuits on
     `status: 'ready'` *before* checking clip or transcript (a deliberate
     loosening that is correct for assign, wrong for this question), so a
     stale-but-`ready` slot with a blank transcript read as fine and then
     hard-failed at render.

   This module is pure — no I/O, no node builtins — because it is imported by
   BOTH the server and the browser bundle (see plan 276 Decision 3, "One
   implementation, imported by both sides"; the Task-1 build-gate probe
   confirmed `vite build` resolves a value import of `./clone-engines.js`
   into the bundle). Its only import is `isCloneEngine` from `./clone-engines.js`
   plus type-only imports. Do NOT import `VoiceLibraryEntry` or anything from
   `server/src/workspace/` here — `CloneReadinessInput` is deliberately
   structural so each call site (server route, browser selector) adapts its
   own shape without pulling node-only types into the browser bundle. */

import { isCloneEngine } from './clone-engines.js';
import type { TtsEngine } from './model-keys.js';

export type CloneUnready =
  | 'unresolvable-uuid'
  | 'revoked'
  | 'wrong-engine'
  | 'derive-failed'
  | 'missing-master'
  | 'no-transcript'
  | 'missing-entry';

export interface CloneReadinessInput {
  /** false when the character's cloned slot carries no libraryUuid at all,
      or the value is empty or malformed — so there is nothing to look up.
      Distinct from `entryFound` (below): that flag means a UUID WAS present
      but resolved to no voice-library entry. This one fires earlier, and
      the render classifies both as `misconfigured` (clone-voice-resolver.ts
      `!libraryUuid` check). */
  libraryUuidResolvable: boolean;
  /** false when the character's libraryUuid resolves to no voice-library
      entry at all. */
  entryFound: boolean;
  consentRevoked: boolean;
  /** POST-`withComputedStaleness` status of
      `entry.engines[manifestSlotFor(engine)]`. Both the server and the
      client MUST apply that transform before computing this input — a raw
      on-disk `'failed'` status must never reach here already overwritten to
      `'stale'` (see plan 276 Decision 2 [R3]). */
  slotStatus: string | undefined;
  hasMaster: boolean;
  transcript: string | undefined;
  engine: TtsEngine;
  /** `hasClonedProvenance(character, engine)` — the CHARACTER's own cast
      slot for THIS engine (single-engine), NOT the voice-library entry's
      slot and NOT the engine-agnostic `characterHasClonedSlot`. A voice
      cloned on Qwen has no `xtts` library slot, so reading the library slot
      here would make the ordinary Coqui-routed case return `wrong-engine`
      even when the character's own coqui cast slot is present and healthy —
      rev 1's exact fatal bug. See plan 276 Decision 3, "The
      `characterHasSlot` trap". */
  characterHasSlot: boolean;
}

/* Rules, in order — the order is the contract (plan 276 Decision 3):

   1. !libraryUuidResolvable   -> 'unresolvable-uuid'  (#2912)
   2. !entryFound              -> 'missing-entry'
   3. consentRevoked           -> 'revoked'
   4. !isCloneEngine(engine)
      || !characterHasSlot     -> 'wrong-engine'
   5. slotStatus === 'failed'  -> 'derive-failed'
   6. slotStatus !== 'ready'
      && !hasMaster            -> 'missing-master'
   7. slotStatus !== 'ready'
      && engine === 'qwen'
      && !transcript?.trim()   -> 'no-transcript'
   8. otherwise                -> null (ready, or needs a derive that will succeed)

   Rules 6 and 7 are gated on `slotStatus !== 'ready'` because a `ready` slot
   with a live artifact and no master (or a blank transcript) is a HEALTHY,
   explicitly supported state (voice-library.ts:1249-1251) — ungated, rule 6
   would warn on a working voice with no CTA, and rule 7 would tell the user
   to "fix" a voice that already renders. Do not simplify this gate away. */
export function cloneReadiness(input: CloneReadinessInput): CloneUnready | null {
  const { libraryUuidResolvable, entryFound, consentRevoked, slotStatus, hasMaster, transcript, engine, characterHasSlot } =
    input;

  if (!libraryUuidResolvable) return 'unresolvable-uuid';
  if (!entryFound) return 'missing-entry';
  if (consentRevoked) return 'revoked';
  if (!isCloneEngine(engine) || !characterHasSlot) return 'wrong-engine';
  if (slotStatus === 'failed') return 'derive-failed';
  if (slotStatus !== 'ready' && !hasMaster) return 'missing-master';
  if (slotStatus !== 'ready' && engine === 'qwen' && !transcript?.trim()) return 'no-transcript';

  return null;
}
