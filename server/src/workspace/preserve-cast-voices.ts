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

import { isCloneEngine, manifestSlotFor, type CloneEngine } from '../tts/clone-engines.js';
import type { TtsEngine } from '../tts/index.js';

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
        throw new Error(`Character "${label}" — refusing to write its ${engine} voice: ${reason}`);
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
