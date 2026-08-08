/* Durable guard against stripping designed voices on a cast write.

   Every frontend cast write goes through the PUT /api/books/:id/state
   slice:'cast' handler — the persistence middleware's auto-save, manual cast
   edits, and the cast-confirm/rebaseline screen. That handler overwrites
   cast.json with whatever the UI sends. If the UI's in-memory cast lost a
   character's designed Qwen voice (a stale bundle, an analyzer cast-update, the
   confirm screen), the write erases it from disk — the 2026-06-05 The Drowning Bell
   incident, where the analysing→cast-confirm flow stripped Berrin/Sela/Quill.

   This fills each incoming character's missing voice-DESIGN fields from the
   existing on-disk character. INCOMING WINS when present (a deliberate
   re-design still writes its new value); the existing value fills only the gap.
   Reuse-link fields (`voiceId` / `matchedFrom` / `voiceState`) are deliberately
   NOT preserved — those have legitimate clear flows (unlink) and are hydrated
   separately by `denormaliseCastReusedVoices`. */

import {
  CLONE_ENGINE_LIST,
  hasClonedProvenance,
  isCloneEngine,
  manifestSlotFor,
  type CloneEngine,
} from '../tts/clone-engines.js';
import type { TtsEngine } from '../tts/index.js';

/** A cast write this module REFUSED on consent grounds — as opposed to one
    that failed. GATE 2 (owner-directed): the #1899 refusal used to throw a
    plain `Error` into the route's generic catch and surface as HTTP 500, so a
    client could not tell "we refused you" from "we broke". The route maps this
    class to 409, matching the other deliberate refusals it already sends
    (the empty-sentence-list overwrite and the Author/Series/Title collision),
    and matching the consent refusals the dedicated voice routes send
    (`voices.ts`'s cloned-clear 409, `voice-library.ts`'s revoked-consent 409). */
export class CastVoiceConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CastVoiceConsentError';
  }
}

/** Voice-DESIGN fields the analyzer / persistence never legitimately clears, so
    a write that omits them is an accidental strip, not an intentional change. */
const PRESERVED_DESIGN_FIELDS = ['overrideTtsVoices', 'ttsEngine', 'voiceStyle'] as const;

export function preserveDesignedVoicesOnCastWrite<T extends { id: string }>(
  existing: ReadonlyArray<{ id: string } & Record<string, unknown>>,
  incoming: T[],
): T[] {
  if (!existing.length) return incoming;
  const byId = new Map(existing.map((c) => [c.id, c]));
  return incoming.map((inc) => {
    const old = byId.get(inc.id);
    if (!old) return inc;
    const merged = { ...(inc as Record<string, unknown>) };
    for (const key of PRESERVED_DESIGN_FIELDS) {
      if (merged[key] === undefined && old[key] !== undefined) merged[key] = old[key];
    }
    /* [#1899] — `voiceUuid` (srv-43) is an immutable per-voice identity minted
       server-side ONLY (qwen-voice.ts::ensureCharacterVoiceUuid at design
       time, or the reuse/link-prior routes at link time). This generic
       wholesale cast write is never the authoritative writer of a NEW
       voiceUuid — a legitimate client round-trip only ever echoes back the
       value the server already minted (mirrored into redux by
       cast-slice.ts's setCharacterVoiceUuid, itself downstream of that same
       server mint), so the on-disk value always wins here, unlike
       PRESERVED_DESIGN_FIELDS' fill-the-gap semantics above (which let an
       explicit incoming value win). Without this an existing character's
       identity could be restamped to an arbitrary value with no consent
       check at all. Scoped to characters that already exist on disk (`old`
       found) — same scope PRESERVED_DESIGN_FIELDS already uses. */
    if (old.voiceUuid !== undefined) merged.voiceUuid = old.voiceUuid;
    return merged as T;
  });
}

/* #2166 — `notLinkedTo` is server-owned. Unlike PRESERVED_DESIGN_FIELDS above,
   which fill only a GAP and let an explicit incoming value win, this field is
   taken from disk unconditionally: the whole-roster cast PUT
   (persistence-middleware.ts fires it on nine ordinary cast actions) is never
   its authoritative writer — the reject-orphan and not-linked-to routes are.
   Without this, cast-slice.ts's `existing.notLinkedTo ?? inc.notLinkedTo`
   merge (redux's array beats the server's) lets a stale client re-PUT an edge
   that analysis.ts's reconciliation just repaired, and the two oscillate.

   Same scope as its siblings: characters that already exist on disk. A row the
   incoming write is introducing has no on-disk value to be authoritative, so
   it passes through. */
export function preserveNotLinkedToOnCastWrite<T extends { id: string }>(
  existing: ReadonlyArray<{ id: string } & Record<string, unknown>>,
  incoming: T[],
): T[] {
  if (!existing.length) return incoming;
  const byId = new Map(existing.map((c) => [c.id, c]));
  return incoming.map((inc) => {
    const old = byId.get(inc.id);
    if (!old) return inc;
    const merged = { ...(inc as Record<string, unknown>) };
    if (old.notLinkedTo === undefined) delete merged.notLinkedTo;
    else merged.notLinkedTo = old.notLinkedTo;
    return merged as T;
  });
}

/** [#1899] — reject a client-supplied clone-capable engine slot that would
    redirect rendering to an artifact this exact character didn't already
    own on disk. `voice-mapping.ts`'s `pickVoiceForEngine` resolves the
    render key two ways, both reachable through this generic wholesale
    write with zero consent check today:

      1. `libraryUuid` (when present) drives resolution DIRECTLY for every
         clone-capable engine — `qwen-<libraryUuid>` / `xtts-<libraryUuid>` —
         for BOTH `provenance:'cloned'` and `'designed'` (resolution is
         identical; only the failure policy differs downstream). Legitimate
         assignment always happens via `voice-library.ts`'s dedicated
         `/assign` route, which writes cast.json directly — never through
         this route — so the only legitimate `libraryUuid` here is whatever
         is already on disk for this character+engine.
      2. Absent a `libraryUuid`, a NON-qwen clone-capable engine (coqui
         today) falls through to the bare `name` as the literal storage key
         — so a `name` shaped like that engine's own reserved manifest-slot
         prefix (`manifestSlotFor(engine)-`, case-folded — NTFS/APFS
         filename lookups are case-insensitive, so a plain `startsWith`
         would be one shift-key away from bypassable) is just as dangerous
         as a forged `libraryUuid` and gets the same "must already be on
         disk" treatment. Qwen is deliberately EXEMPT from this second check:
         its branch of `pickVoiceForEngine` never uses the bare `name` to
         resolve (only as an existence flag) — absent a `libraryUuid` it
         always re-derives the storage key from the character's OWN
         `voiceUuid`/id via `qwenStorageKey`, which the `voiceUuid` guard
         above already locks to the on-disk value. So an ordinary qwen
         re-design's cosmetic `name` (even one shaped like `qwen-*`) is
         functionally inert for resolution and must keep working — this is
         the existing "deliberate re-design, incoming wins" contract.

    Same threat shape as `voice-override-linked.ts`'s Task 10a fix (a client
    planting a foreign `xtts-<victim-uuid>` key with zero consent check) —
    that route's own comment calls this route's gap out by name: "That gap
    is real, is filed separately, and is NOT this guard's job to close — it
    already exists independently of this route." The allow-rule differs
    deliberately: that route propagates a rebaseline across a whole series,
    so it authenticates against a server-derived `canonicalVoiceUuid`. This
    route has no such propagation, so the only legitimate comparand is the
    target character's own pre-existing value on disk.

    Throws on the first violation found — the whole wholesale write is
    refused, never partially applied, matching Property 1 (a cloned voice
    either renders as itself or fails loud, never a silent substitution). An
    ordinary catalog/hand-typed name (the common case, no reserved prefix,
    no libraryUuid) is untouched by this guard. */
export function rejectForeignCloneKeys(
  existing: ReadonlyArray<{ id: string } & Record<string, unknown>>,
  incoming: ReadonlyArray<{ id: string; name?: unknown; overrideTtsVoices?: unknown }>,
): void {
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const inc of incoming) {
    const slots = inc.overrideTtsVoices;
    if (!slots || typeof slots !== 'object') continue;
    const old = byId.get(inc.id);
    const oldSlots = old?.overrideTtsVoices;

    for (const [engine, slotRaw] of Object.entries(slots as Record<string, unknown>)) {
      if (!isCloneEngine(engine as TtsEngine)) continue;
      if (!slotRaw || typeof slotRaw !== 'object') continue;
      const slot = slotRaw as Record<string, unknown>;
      const oldSlotRaw =
        oldSlots && typeof oldSlots === 'object' ? (oldSlots as Record<string, unknown>)[engine] : undefined;
      const oldSlot = oldSlotRaw && typeof oldSlotRaw === 'object' ? (oldSlotRaw as Record<string, unknown>) : undefined;

      const label = typeof inc.name === 'string' ? inc.name : inc.id;
      const refuse = (reason: string): never => {
        throw new CastVoiceConsentError(
          `Character "${label}" — refusing to write its ${engine} voice: ${reason}`,
        );
      };

      const libraryUuid = slot.libraryUuid;
      if (typeof libraryUuid === 'string' && libraryUuid.length > 0) {
        if (oldSlot?.libraryUuid !== libraryUuid) {
          refuse("it doesn't match this character's own consented voice.");
        }
        continue; // libraryUuid drives resolution — the bare name below is inert once it's set
      }

      if (engine === 'qwen') continue; // bare qwen name never drives resolution — see doc comment
      const name = slot.name;
      if (typeof name !== 'string') continue;
      const prefix = `${manifestSlotFor(engine as CloneEngine)}-`; // manifestSlotFor already lower-case
      const nameLower = name.toLowerCase();
      if (!nameLower.startsWith(prefix)) continue;
      const oldName = oldSlot?.name;
      if (typeof oldName !== 'string' || oldName.toLowerCase() !== nameLower) {
        refuse("it doesn't match this character's own consented voice.");
      }
    }
  }
}

/** True when the incoming slot is byte-for-byte the same voice identity as the
    stored one. Compares the three fields that decide what actually renders —
    `name` (the literal storage key for a coqui slot with no libraryUuid),
    `libraryUuid` (which drives resolution when present) and `provenance`
    (which is what makes the slot cloned at all). Compared with `===`, NOT
    case-folded: a case-varied storage key resolves to the same artifact on
    NTFS/APFS but hashes to a different audition cache scope and a different
    sidecar latents key, so it is a DIFFERENT value here and gets refused
    rather than normalised through — the same refuse-don't-normalise choice
    the sidecar makes for a case-varied clone-key prefix. */
function sameStoredVoice(oldSlot: unknown, incomingSlot: unknown): boolean {
  if (!oldSlot || typeof oldSlot !== 'object') return false;
  if (!incomingSlot || typeof incomingSlot !== 'object') return false;
  const o = oldSlot as Record<string, unknown>;
  const n = incomingSlot as Record<string, unknown>;
  return o.name === n.name && o.libraryUuid === n.libraryUuid && o.provenance === n.provenance;
}

/** [GATE 2 C-B1] — the erase/replace half of the same threat model #1899's
    `rejectForeignCloneKeys` (above) closed the plant/restamp half of.

    That guard only ever inspects what an incoming write ADDS. It says nothing
    about what a write REMOVES, and `preserveDesignedVoicesOnCastWrite` restores
    `overrideTtsVoices` only when the field is wholly absent — a PRESENT map wins
    slot-by-slot. So an incoming character whose map omits the cloned engine slot,
    or replaces it with an ordinary catalogue name, passed both guards and was
    persisted with a 2xx: the clone marker gone from disk, no refusal, no warning,
    and the next render reading a real person's lines in a catalogue voice. That
    is Property 1's named failure mode verbatim ("never 'handled' by deleting its
    marker upstream so a later stage sees an ordinary character").

    The contract, per the repo owner:

      | incoming map                              | behaviour                    |
      | omits the cloned slot                     | restore the stored slot, 200 |
      | carries a DIFFERENT value for that slot   | refuse (409), persist nothing|
      | carries the SAME value                    | accept, 200                  |

    The rationale for treating an omission as an accident rather than an
    unassign: unassigning a library voice now has its own dedicated route
    (`DELETE /api/voice-library/:voiceUuid/assign`), so a wholesale cast PUT
    never legitimately needs to drop a cloned voice. An omission is a client
    that simply didn't send it (a stale tab, a partial cast, a plain API call);
    an explicit different value is a restamp attempt. Neither is a consent
    decision this funnel is entitled to make.

    Cloned-ness is decided by the FAIL-SAFE `hasClonedProvenance` — provenance
    only, no `libraryUuid` validation — because this is a guard that PRESERVES:
    a malformed cloned slot (missing/non-string libraryUuid) is still a real
    person's consented voice and must be protected too. Do NOT swap in the
    uuid-validating `clonedSlotForEngine`/`libraryVoiceForEngine` here; a
    malformed slot would then read as "not cloned" and be silently erased,
    which is the exact defect this function exists to close.

    Runs on the incoming map only when it is PRESENT — a wholly-absent map is
    `preserveDesignedVoicesOnCastWrite`'s case and is restored there.
    Designed/imported slots are untouched: they keep the existing
    incoming-wins contract. */
export function preserveClonedSlotsOnCastWrite<
  T extends { id: string; name?: unknown; overrideTtsVoices?: unknown },
>(existing: ReadonlyArray<{ id: string } & Record<string, unknown>>, incoming: T[]): T[] {
  if (!existing.length) return incoming;
  const byId = new Map(existing.map((c) => [c.id, c]));
  return incoming.map((inc) => {
    const old = byId.get(inc.id);
    if (!old) return inc;
    const incSlots = inc.overrideTtsVoices;
    if (!incSlots || typeof incSlots !== 'object') return inc;
    const oldSlots = old.overrideTtsVoices as Record<string, unknown> | undefined;

    let merged: Record<string, unknown> | undefined;
    for (const engine of CLONE_ENGINE_LIST) {
      if (!hasClonedProvenance({ overrideTtsVoices: oldSlots }, engine)) continue;
      const oldSlot = oldSlots?.[engine];
      const incSlot = (incSlots as Record<string, unknown>)[engine];
      if (incSlot === undefined) {
        merged = { ...(merged ?? (incSlots as Record<string, unknown>)), [engine]: oldSlot };
        continue;
      }
      if (!sameStoredVoice(oldSlot, incSlot)) {
        const label = typeof inc.name === 'string' ? inc.name : inc.id;
        throw new CastVoiceConsentError(
          `Character "${label}" — refusing to replace its ${engine} voice: it carries a consented ` +
            `cloned voice, and a cast save is not how one is removed. Unassign it explicitly instead.`,
        );
      }
    }
    return merged ? ({ ...(inc as Record<string, unknown>), overrideTtsVoices: merged } as T) : inc;
  });
}
