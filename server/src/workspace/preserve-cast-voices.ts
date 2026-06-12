/* Durable guard against stripping designed voices on a cast write.

   Every frontend cast write goes through the PUT /api/books/:id/state
   slice:'cast' handler — the persistence middleware's auto-save, manual cast
   edits, and the cast-confirm/rebaseline screen. That handler overwrites
   cast.json with whatever the UI sends. If the UI's in-memory cast lost a
   character's designed Qwen voice (a stale bundle, an analyzer cast-update, the
   confirm screen), the write erases it from disk — the 2026-06-05 The Drowning Bell
   incident, where the analysing→cast-confirm flow stripped Berrin/Sela/Trix.

   This fills each incoming character's missing voice-DESIGN fields from the
   existing on-disk character. INCOMING WINS when present (a deliberate
   re-design still writes its new value); the existing value fills only the gap.
   Reuse-link fields (`voiceId` / `matchedFrom` / `voiceState`) are deliberately
   NOT preserved — those have legitimate clear flows (unlink) and are hydrated
   separately by `denormaliseCastReusedVoices`. */

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
    return merged as T;
  });
}
