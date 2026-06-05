/* Preserve designed-voice links across a re-analysis (bug #518).

   The analysis pipeline builds a FRESH roster from the analyzer output — which
   carries attribution data (lines, scenes, evidence, attributes, tone) but NO
   voice fields — and overwrites cast.json. On an already-voiced book that
   silently strips every character's designed voice. This helper overlays the
   existing cast's voice-design fields onto the fresh roster, matched by id, so
   re-attribution refreshes the analyzer-owned data while the user's designed /
   reused voices survive.

   Only fields the analyzer never produces are carried forward; everything the
   re-analysis legitimately recomputes (name, role, attributes, evidence, tone,
   lines, scenes, colour) comes from the fresh roster. A field is carried
   forward only when the EXISTING character actually has it — so a fresh
   reuse-link stamped this run (linkSeriesReuseAtAnalysis) on a previously
   voiceless character is left intact. Characters the re-analysis dropped are
   NOT re-added (roster shrink is handled separately by the stage-1 shrink
   guard). */

/** Per-character fields owned by voice design / reuse, not by the analyzer. */
export const PRESERVED_VOICE_FIELDS = [
  'voiceId',
  'voiceState',
  'matchedFrom',
  'overrideTtsVoices',
  'overrideTtsVoice',
  'ttsEngine',
  'voiceStyle',
] as const;

/** Overlay the existing cast's voice-design fields onto the freshly-analysed
    roster (matched by `id`). Returns a new array; inputs are not mutated. */
export function mergeAnalysisResultWithExistingCast<T extends { id: string }>(
  existing: ReadonlyArray<{ id: string } & Record<string, unknown>>,
  fresh: T[],
): T[] {
  if (!existing.length) return fresh;
  const byId = new Map(existing.map((c) => [c.id, c]));
  return fresh.map((f) => {
    const old = byId.get(f.id);
    if (!old) return f;
    const merged = { ...(f as Record<string, unknown>) };
    for (const key of PRESERVED_VOICE_FIELDS) {
      if (old[key] !== undefined) merged[key] = old[key];
    }
    return merged as T;
  });
}
