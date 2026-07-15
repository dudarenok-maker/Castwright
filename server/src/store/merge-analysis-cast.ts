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

import { normaliseForMatch } from '../util/text-match.js';
import { normaliseNameKey } from '../util/safe-id.js';
import { isDefaultNarratorName } from '../tts/language-registry.js';

/** Per-character fields owned by voice design / reuse, not by the analyzer. */
export const PRESERVED_VOICE_FIELDS = [
  'voiceId',
  'voiceUuid',
  'voiceState',
  'matchedFrom',
  'overrideTtsVoices',
  'overrideTtsVoice',
  'ttsEngine',
  'voiceStyle',
  'notLinkedTo',
] as const;

type CastRecord = { id: string } & Record<string, unknown>;

/** Reuse-continuity fields — a voice matched/linked from ANOTHER book or the
    library, plus the "not the same person" guard. A `fresh: true` ("Start
    fresh") re-analysis re-derives these from scratch. The bespoke DESIGNED-voice
    fields (`overrideTtsVoices` / `voiceUuid` / `ttsEngine` / `voiceStyle`) are
    deliberately NOT here — a fresh run must never discard them (the 2026-07-14
    Coalfall voice-strip incident: `fresh` set the merge's prior to `[]` and so
    overwrote cast.json voiceless). */
const REUSE_CONTINUITY_FIELDS = ['voiceId', 'matchedFrom', 'notLinkedTo'] as const;

/** Strip reuse continuity from a prior cast while KEEPING each character's
    bespoke designed voice — the transform applied to the prior cast before a
    `fresh: true` re-analysis overlays it. Reuse-derived `voiceState: 'reused'` is
    cleared too (the fresh run re-derives lifecycle state); a bespoke 'tuned' /
    'locked' pin is kept. Returns a new array; the input is not mutated. */
export function dropReuseContinuityKeepDesignedVoice<T extends CastRecord>(
  cast: ReadonlyArray<T>,
): T[] {
  return cast.map((c) => {
    const next: CastRecord = { ...c };
    for (const field of REUSE_CONTINUITY_FIELDS) delete next[field];
    if (next.voiceState === 'reused') delete next.voiceState;
    return next as T;
  });
}

/** A character carries continuity worth rescuing when it has a non-generated
    voice state or any concrete voice/reuse field. */
function isVoicedOrReused(c: CastRecord): boolean {
  const state = c.voiceState;
  if (state === 'reused' || state === 'tuned' || state === 'locked') return true;
  // voiceUuid counts as a designed voice (srv-43): a voiceUuid-only row must be
  // carry-forward/bridge-eligible so the same-name collapse never routes a
  // bespoke voice through a survivor the merge then drops (Coalfall class).
  return Boolean(
    c.voiceId || c.matchedFrom || c.overrideTtsVoices || c.overrideTtsVoice || c.voiceUuid,
  );
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
    roster (matched by `id`, with a same-name fallback for analyzer id drift),
    union aliases, and re-add voiced characters the fresh roster dropped.
    Returns a new array; inputs are not mutated. */
export function mergeAnalysisResultWithExistingCast<T extends { id: string }>(
  existing: ReadonlyArray<CastRecord>,
  fresh: T[],
): T[] {
  if (!existing.length) return fresh;
  const byId = new Map(existing.map((c) => [c.id, c]));
  const freshIds = new Set(fresh.map((f) => f.id));
  const nameOf = (c: { name?: unknown } & Record<string, unknown>): string =>
    typeof c.name === 'string' ? normaliseForMatch(c.name) : '';

  /* Name-fallback for analyzer id drift. The analyzer is non-deterministic about
     a character's id across runs (it relabelled the dragon `coalfall` →
     `coalfall-dragon` between two analyses of the same book). The id-keyed
     overlay then misses, the fresh row comes up voiceless, AND the dropped
     voiced row is re-added below as a 0-line orphan — a visible duplicate.
     Match a voiced existing character whose id the fresh roster DROPPED to a
     same-name fresh character so its designed voice rides onto the freshly-
     detected row (which carries the lines + the more descriptive, library-
     unique id). Guard against ambiguity: a normalised name shared by more than
     one dropped-voiced existing OR more than one fresh row is left to the
     id-only path (too risky to guess). */
  const freshNameCounts = new Map<string, number>();
  for (const f of fresh) {
    const key = nameOf(f as T & Record<string, unknown>);
    if (key) freshNameCounts.set(key, (freshNameCounts.get(key) ?? 0) + 1);
  }
  const droppedVoicedByName = new Map<string, CastRecord>();
  const ambiguousNames = new Set<string>();
  for (const old of existing) {
    if (freshIds.has(old.id) || !isVoicedOrReused(old)) continue;
    const key = nameOf(old);
    if (!key) continue;
    if (droppedVoicedByName.has(key)) ambiguousNames.add(key);
    else droppedVoicedByName.set(key, old);
  }
  const claimedByName = new Set<string>(); // existing ids whose voice rode onto a fresh row

  const overlaid = fresh.map((f) => {
    let old = byId.get(f.id);
    if (!old) {
      const key = nameOf(f as T & Record<string, unknown>);
      if (key && !ambiguousNames.has(key) && freshNameCounts.get(key) === 1) {
        const cand = droppedVoicedByName.get(key);
        if (cand) {
          old = cand;
          claimedByName.add(cand.id);
        }
      }
    }
    if (!old) return f;
    const merged = { ...(f as Record<string, unknown>) };
    for (const key of PRESERVED_VOICE_FIELDS) {
      if (old[key] !== undefined) merged[key] = old[key];
    }
    const aliases = unionAliases(old.aliases, (f as Record<string, unknown>).aliases);
    if (aliases) merged.aliases = aliases;
    // Narrator name is a code-seeded default/override, not model-derived. The
    // merge recomputes name from the fresh roster for real characters, but for
    // the narrator that would drop a user RENAME. Carry forward a non-default
    // prior name; a default prior name lets the fresh (re-localized) name win.
    if (
      (f.id === 'narrator' || f.id === 'char-narrator') &&
      typeof old.name === 'string' &&
      !isDefaultNarratorName(old.name)
    ) {
      merged.name = old.name;
    }
    return merged as T;
  });

  /* Carry forward voiced/reused characters the fresh roster omitted — UNLESS
     their designed voice already rode onto a same-name fresh row above (id
     drift), which would otherwise re-add them as a 0-line duplicate. */
  for (const old of existing) {
    if (freshIds.has(old.id) || claimedByName.has(old.id)) continue;
    if (isVoicedOrReused(old)) overlaid.push(old as unknown as T);
  }
  return overlaid;
}

/** Strength order for voiceState collision resolution. Higher = stronger. */
const VOICE_STATE_RANK: Record<string, number> = {
  locked: 3,
  tuned: 2,
  reused: 1,
  generated: 0,
};

function voiceStateRank(state: unknown): number {
  return typeof state === 'string' ? (VOICE_STATE_RANK[state] ?? -1) : -1;
}

/** Remap each prior cast row's `id` through `rewrites` (dedup canonical-id
    table). When two rows collide on the same canonical id, keep the one with
    the strongest `voiceState` (locked > tuned > reused > generated, undefined
    weakest); tie-break by more lines if available, else first encountered.
    Returns a new array of remapped rows and a list of dropped rows (original id
    + voiceState) for caller logging. Inputs are not mutated. */
export function applyRewriteToPriorCast<T extends CastRecord>(
  priorCast: ReadonlyArray<T>,
  rewrites: Record<string, string>,
): { priorCast: T[]; droppedVoices: Array<{ id: string; voiceState?: string }> } {
  // Map from canonical id → { row (with remapped id), originalId }
  const winners = new Map<string, { row: T; originalId: string }>();
  const droppedVoices: Array<{ id: string; voiceState?: string }> = [];

  for (const row of priorCast) {
    const originalId = row.id;
    const canonicalId = rewrites[originalId] ?? originalId;
    const remapped: T = canonicalId === originalId ? row : { ...row, id: canonicalId };
    const existing = winners.get(canonicalId);
    if (!existing) {
      winners.set(canonicalId, { row: remapped, originalId });
      continue;
    }
    // Collision — compare strengths
    const incomingRank = voiceStateRank(row.voiceState);
    const existingRank = voiceStateRank(existing.row.voiceState);
    let droppedOriginalId: string;
    let droppedVoiceState: unknown;
    if (incomingRank > existingRank) {
      droppedOriginalId = existing.originalId;
      droppedVoiceState = existing.row.voiceState;
      winners.set(canonicalId, { row: remapped, originalId });
    } else if (incomingRank === existingRank) {
      // tie-break: more lines wins, else first (existing) wins
      const incomingLines = typeof row.lines === 'number' ? row.lines : -1;
      const existingLines = typeof existing.row.lines === 'number' ? existing.row.lines : -1;
      if (incomingLines > existingLines) {
        droppedOriginalId = existing.originalId;
        droppedVoiceState = existing.row.voiceState;
        winners.set(canonicalId, { row: remapped, originalId });
      } else {
        droppedOriginalId = originalId;
        droppedVoiceState = row.voiceState;
        // existing stays in winners
      }
    } else {
      droppedOriginalId = originalId;
      droppedVoiceState = row.voiceState;
      // existing stays in winners
    }
    droppedVoices.push({
      id: droppedOriginalId,
      ...(droppedVoiceState !== undefined ? { voiceState: droppedVoiceState as string } : {}),
    });
  }

  return { priorCast: Array.from(winners.values()).map((w) => w.row), droppedVoices };
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

  /* Name-fallback for dedup id remap (srv-44): on re-analysis the dedup pass
     collapses a legacy prior id onto a canonical survivor, so the prior cast's
     guard row no longer matches the survivor by id. Bridge a SINGLE same-name
     prior row to a SINGLE same-name fresh row, mirroring the ambiguity-guarded
     fallback in mergeAnalysisResultWithExistingCast. Guard against guessing: a
     normalised name shared by >1 prior OR >1 fresh row falls back to id-only. */
  const nameOf = (c: { name?: unknown } & Record<string, unknown>): string =>
    typeof c.name === 'string' ? normaliseForMatch(c.name) : '';
  const freshNameCounts = new Map<string, number>();
  for (const f of fresh) {
    const key = nameOf(f as { name?: unknown } & Record<string, unknown>);
    if (key) freshNameCounts.set(key, (freshNameCounts.get(key) ?? 0) + 1);
  }
  const existingByName = new Map<string, CastRecord>();
  const ambiguousExistingNames = new Set<string>();
  for (const old of existing) {
    const key = nameOf(old);
    if (!key) continue;
    if (existingByName.has(key)) ambiguousExistingNames.add(key);
    else existingByName.set(key, old);
  }

  for (const f of fresh) {
    let old = byId.get(f.id);
    if (!old) {
      const key = nameOf(f as { name?: unknown } & Record<string, unknown>);
      if (key && !ambiguousExistingNames.has(key) && freshNameCounts.get(key) === 1) {
        old = existingByName.get(key);
      }
    }
    if (!old) continue;
    if (f.notLinkedTo === undefined && old.notLinkedTo !== undefined)
      f.notLinkedTo = old.notLinkedTo as T['notLinkedTo'];
    if (f.matchedFrom === undefined && old.matchedFrom !== undefined)
      f.matchedFrom = old.matchedFrom as T['matchedFrom'];
  }
}

/** True when a row carries a concrete bespoke designed voice (not merely a
    reuse link). Used so the same-name collapse never drops a designed voice in
    favour of a reuse-linked sibling (2026-07-14 Coalfall voice-strip class). */
function hasBespokeVoice(c: CastRecord): boolean {
  return Boolean(c.overrideTtsVoices || c.overrideTtsVoice || c.voiceUuid);
}

/** Voice strength for same-name collapse. locked > tuned > any bespoke voice
    (even voiceState generated/absent) > reuse link > other-voiced > none. */
function priorVoiceRank(c: CastRecord): number {
  if (c.voiceState === 'locked') return 5;
  if (c.voiceState === 'tuned') return 4;
  if (hasBespokeVoice(c)) return 3;
  if (c.voiceState === 'reused') return 2;
  if (isVoicedOrReused(c)) return 1;
  return 0;
}

/** True when any two rows in the group are explicitly marked not-the-same-person
    via notLinkedTo (by the other member's id). Conservative: any such edge blocks
    collapsing the whole group, mirroring Tier-1's gender-conflict skip. */
function groupHasNotLinkedEdge(group: ReadonlyArray<CastRecord>): boolean {
  const ids = new Set(group.map((g) => g.id));
  for (const c of group) {
    const nl = c.notLinkedTo;
    if (!Array.isArray(nl)) continue;
    for (const entry of nl) {
      const cid = (entry as { characterId?: unknown })?.characterId;
      if (typeof cid === 'string' && ids.has(cid)) return true;
    }
  }
  return false;
}

/** Collapse same-normalised-name rows in a prior cast to one survivor each so
    the carryover merge cannot re-add a voiced duplicate. Bespoke voice beats a
    reuse link; narrator rows and notLinkedTo-separated pairs are never
    collapsed; the dropped rows' names/aliases fold onto the survivor (never the
    survivor's own name). Returns a new array (original order, survivor at the
    first member's slot) + a dropped-row log for the change-log. Input is not
    mutated. */
export function dedupePriorCastByName<T extends CastRecord>(
  priorCast: ReadonlyArray<T>,
): { cast: T[]; dropped: Array<{ id: string; name?: string; voiceState?: string }> } {
  if (priorCast.length < 2) return { cast: [...priorCast], dropped: [] };

  const nameKeyOf = (c: CastRecord): string =>
    typeof c.name === 'string' ? normaliseNameKey(c.name) : '';
  const isNarrator = (c: CastRecord): boolean =>
    c.id === 'narrator' || c.id === 'char-narrator';

  const groups = new Map<string, T[]>();
  for (const c of priorCast) {
    const key = nameKeyOf(c);
    if (!key || isNarrator(c)) continue;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }

  const dropped: Array<{ id: string; name?: string; voiceState?: string }> = [];
  const survivorByKey = new Map<string, T>();
  const collapsedKeys = new Set<string>();

  for (const [key, group] of groups) {
    if (group.length < 2 || groupHasNotLinkedEdge(group)) continue;
    collapsedKeys.add(key);

    let best = group[0];
    for (const row of group.slice(1)) {
      const rr = priorVoiceRank(row);
      const br = priorVoiceRank(best);
      const rl = typeof row.lines === 'number' ? row.lines : -1;
      const bl = typeof best.lines === 'number' ? best.lines : -1;
      if (rr > br || (rr === br && rl > bl)) best = row;
    }

    const survivorName =
      typeof best.name === 'string' ? best.name.trim().toLowerCase() : '';
    let aliases: string[] | undefined = Array.isArray(best.aliases)
      ? (best.aliases as string[])
      : undefined;
    for (const row of group) {
      if (row === best) continue;
      // Fold the dropped row's alternate names in, but never the survivor's own
      // name (a same-name collapse would otherwise add "Антон" as an alias of Антон).
      const add = [
        ...(typeof row.name === 'string' && row.name.trim().toLowerCase() !== survivorName
          ? [row.name]
          : []),
        ...(Array.isArray(row.aliases) ? (row.aliases as string[]) : []),
      ];
      aliases = unionAliases(aliases, add);
      dropped.push({
        id: row.id,
        ...(typeof row.name === 'string' ? { name: row.name } : {}),
        ...(typeof row.voiceState === 'string' ? { voiceState: row.voiceState } : {}),
      });
    }
    survivorByKey.set(key, aliases ? ({ ...best, aliases } as T) : best);
  }

  if (!collapsedKeys.size) return { cast: [...priorCast], dropped: [] };

  const emitted = new Set<string>();
  const out: T[] = [];
  for (const c of priorCast) {
    const key = nameKeyOf(c);
    if (!key || isNarrator(c) || !collapsedKeys.has(key)) {
      out.push(c);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(survivorByKey.get(key)!);
  }
  return { cast: out, dropped };
}
