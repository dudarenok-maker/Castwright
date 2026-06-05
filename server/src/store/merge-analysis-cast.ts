/* Preserve designed-voice links across a re-analysis (bug #518, srv-13).

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
   voiceless character is left intact.

   srv-13 hardening:
     - `notLinkedTo` (the user's "these two are NOT the same person" decision)
       is carried forward like a voice field — the analyzer never emits it.
     - `aliases` are UNIONED (old ∪ fresh) rather than replaced, so a manual
       alias or a Facet-A-unioned alias isn't dropped when the analyzer
       re-derives a sparser set.
     - characters the fresh roster OMITTED but that carry voice/reuse fields are
       re-added (carry-forward), so a transient analyzer miss can't permanently
       lose a designed/reused voice. User deletes/merges already remove the id
       from cast.json, so only analyzer-dropped characters get rescued. */

/** Per-character fields owned by voice design / reuse, not by the analyzer. */
export const PRESERVED_VOICE_FIELDS = [
  'voiceId',
  'voiceState',
  'matchedFrom',
  'overrideTtsVoices',
  'overrideTtsVoice',
  'ttsEngine',
  'voiceStyle',
  'notLinkedTo',
] as const;

type CastRecord = { id: string } & Record<string, unknown>;

/** A character carries continuity worth rescuing when it has a non-generated
    voice state or any concrete voice/reuse field. */
function isVoicedOrReused(c: CastRecord): boolean {
  const state = c.voiceState;
  if (state === 'reused' || state === 'tuned' || state === 'locked') return true;
  return Boolean(c.voiceId || c.matchedFrom || c.overrideTtsVoices || c.overrideTtsVoice);
}

/** Union two alias lists (case-insensitive dedup, original casing preserved,
    first-seen order). Returns undefined when the union is empty so we never
    write an empty array onto a row that had none. */
function unionAliases(a: unknown, b: unknown): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.length ? out : undefined;
}

/** Voiced/reused characters present in `existing` but dropped by the fresh
    roster — i.e. the rows that carry-forward re-adds. Exposed so a caller can
    name them in a change-log entry. */
export function voicedSurvivorsDropped(
  existing: ReadonlyArray<CastRecord>,
  fresh: ReadonlyArray<{ id: string }>,
): Array<{ id: string; name?: string }> {
  if (!existing.length) return [];
  const freshIds = new Set(fresh.map((f) => f.id));
  return existing
    .filter((c) => !freshIds.has(c.id) && isVoicedOrReused(c))
    .map((c) => ({ id: c.id, name: typeof c.name === 'string' ? c.name : undefined }));
}

/** Overlay the existing cast's voice-design fields onto the freshly-analysed
    roster (matched by `id`), union aliases, and re-add voiced characters the
    fresh roster dropped. Returns a new array; inputs are not mutated. */
export function mergeAnalysisResultWithExistingCast<T extends { id: string }>(
  existing: ReadonlyArray<CastRecord>,
  fresh: T[],
): T[] {
  if (!existing.length) return fresh;
  const byId = new Map(existing.map((c) => [c.id, c]));
  const overlaid = fresh.map((f) => {
    const old = byId.get(f.id);
    if (!old) return f;
    const merged = { ...(f as Record<string, unknown>) };
    for (const key of PRESERVED_VOICE_FIELDS) {
      if (old[key] !== undefined) merged[key] = old[key];
    }
    const aliases = unionAliases(old.aliases, (f as Record<string, unknown>).aliases);
    if (aliases) merged.aliases = aliases;
    return merged as T;
  });

  /* Carry forward voiced/reused characters the fresh roster omitted. */
  const freshIds = new Set(fresh.map((f) => f.id));
  for (const old of existing) {
    if (freshIds.has(old.id)) continue;
    if (isVoicedOrReused(old)) overlaid.push(old as unknown as T);
  }
  return overlaid;
}

/** Seed the Facet-A guard fields (`notLinkedTo`, `matchedFrom`) from the prior
    cast onto the fresh roster IN PLACE, by id, before linkSeriesReuseAtAnalysis
    runs. Without this the link pass scores against an empty `notLinkedTo` and
    can re-link a pair the user explicitly separated; pre-seeding `matchedFrom`
    also makes the pass's `if (c.matchedFrom) continue` skip already-linked rows.
    Only fills fields the fresh row lacks (the analyzer never emits either). */
export function seedReuseGuardsFromPriorCast<
  T extends { id: string; notLinkedTo?: unknown; matchedFrom?: unknown },
>(existing: ReadonlyArray<CastRecord>, fresh: T[]): void {
  if (!existing.length) return;
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const f of fresh) {
    const old = byId.get(f.id);
    if (!old) continue;
    if (f.notLinkedTo === undefined && old.notLinkedTo !== undefined)
      f.notLinkedTo = old.notLinkedTo as T['notLinkedTo'];
    if (f.matchedFrom === undefined && old.matchedFrom !== undefined)
      f.matchedFrom = old.matchedFrom as T['matchedFrom'];
  }
}
