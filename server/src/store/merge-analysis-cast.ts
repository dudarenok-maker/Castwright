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
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';

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

/** A single character-id retirement: `from` is no longer live and has been
    superseded by `to`. Callers record these via `retireCharacterId`
    (`store/cast-id-history.ts`) at the route level, where `bookDir` is in
    scope — these functions stay pure/synchronous and never touch disk. */
export interface Retirement {
  from: string;
  to: string;
}

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

/** True when `row.notLinkedTo` names `targetId`, in either shape the field is
    written in: a bare string (defensive; nothing mints this shape today) or
    the real on-disk `{ bookId, characterId }` shape `POST /not-linked-to`
    writes (`server/src/routes/cast-not-linked-to.ts:238`; typed in
    `voices.ts:104`/`voice-override-linked.ts:65`). Matches on `characterId`
    alone, ignoring `bookId` — the identical trade `remap-fresh-to-prior.ts`'s
    own `notLinkedToId` helper makes (§2040 Task 10/11), for the same reason:
    a false "linked" is silent data corruption (two people collapsed into
    one), a false "not linked" only costs a match a user can still do by
    hand. */
function notLinkedToId(row: Record<string, unknown>, targetId: string): boolean {
  const nl = row.notLinkedTo;
  if (!Array.isArray(nl)) return false;
  return nl.some((entry) => {
    if (typeof entry === 'string') return entry === targetId;
    if (entry && typeof entry === 'object') {
      return (entry as { characterId?: unknown }).characterId === targetId;
    }
    return false;
  });
}

/** True when an already-built id is stable ASCII kebab-case: lowercase `a-z`,
    `0-9`, and single `-` separators (e.g. `oduvan`, `brann-wire`). Driver for
    the established-id survival rule (#2584): when the name-fallback matches a
    dropped existing row whose id is already ASCII-kebab, that established id is
    the stable one and survives the drift — a freshly-minted non-ASCII id (e.g.
    the Cyrillic kebab `одуван`) is retired TO it. */
function isAsciiKebabId(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
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
    Returns a new array plus the id retirements the name-fallback performed
    (a dropped-by-id existing row matched to a differently-id'd fresh row);
    inputs are not mutated.

    Delegates to `mergeCore` with the name-fallback ON — this entry point is
    for the two AUTHORITATIVE end-of-run writes, where the fresh roster is
    the whole book and a dropped prior row really is gone. See
    `overlayInterimCastForLiveView` below for the partial-roster counterpart. */
export function mergeAnalysisResultWithExistingCast<T extends { id: string }>(
  existing: ReadonlyArray<CastRecord>,
  fresh: T[],
): { characters: T[]; retirements: Retirement[] } {
  return mergeCore(existing, fresh, true);
}

/** The interim ("Cast so far") overlay used by the three mid-run `cast.json`
    writes — two inside `analysis.ts`'s `runMainAnalyzerJob` and one inside
    `runSubsetAnalyzerJob` (cited by symbol, not line: this comment's own
    line citations were 110 lines stale, F3, #2163). Same as
    `mergeAnalysisResultWithExistingCast` MINUS the id-drift name-fallback: an
    interim roster is partial by construction (`buildInterimCast` only folds
    chapters already analysed), so a prior character who simply hasn't been
    reached yet looks identical to one the analyzer actually dropped — the
    fallback cannot tell them apart and, at an interim write, has repeatedly
    turned that ambiguity into a durably swapped character id with no history
    record (srv-87, #2086). Returns the roster ONLY: there is no
    `retirements` in the return type, so no caller can discard it — the
    defect this closes is structural, not a discipline reminder. */
export function overlayInterimCastForLiveView<T extends { id: string }>(
  existing: ReadonlyArray<CastRecord>,
  fresh: T[],
): T[] {
  return mergeCore(existing, fresh, false).characters;
}

/** Surname-tolerant name comparison for the name-fallback (#2536). Two
    normalised names match when identical (unchanged exact behaviour) OR one is
    a strict token-superset of the other by exactly one TRAILING token — same
    leading token(s), the longer side carrying exactly one extra trailing token.
    That is the shape of a character gaining or losing a surname token between
    analyzer runs ("бранн уир" vs "бранн"): `normaliseForMatch` already
    lowercase/whitespace-collapses, so `split(' ')` yields the token sequence.

    Deliberately token-count-only, never general edit-distance/similarity: a
    similarity measure could weld two genuinely different characters whose names
    merely resemble each other, and token-count + strict-leading-prefix keeps
    that from happening (#2536 decision — surname-aware, not fuzzy). */
function surnameTolerantMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = a.split(' ');
  const tb = b.split(' ');
  const shorter = ta.length < tb.length ? ta : tb;
  const longer = ta.length < tb.length ? tb : ta;
  if (longer.length !== shorter.length + 1) return false;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

/** Shared core for both entry points above. `nameFallback` gates the id-drift
    same-name match (`:401-437`-shaped block below) — when false, `old` is only
    ever resolved by exact id, `claimedByName` stays empty, and the
    carry-forward loop at the end unconditionally rescues every voiced prior
    row instead of treating any of them as already claimed. */
function mergeCore<T extends { id: string }>(
  existing: ReadonlyArray<CastRecord>,
  fresh: T[],
  nameFallback: boolean,
): { characters: T[]; retirements: Retirement[] } {
  if (!existing.length) return { characters: fresh, retirements: [] };
  const retirements: Retirement[] = [];
  const byId = new Map(existing.map((c) => [c.id, c]));
  const freshIds = new Set(fresh.map((f) => f.id));
  const nameOf = (c: { name?: unknown } & Record<string, unknown>): string =>
    typeof c.name === 'string' ? normaliseForMatch(c.name) : '';

  /* Name-fallback for analyzer id drift. The analyzer is non-deterministic about
     a character's id across runs (it relabelled the dragon `coalfall` →
     `coalfall-dragon` between two analyses of the same book). The id-keyed
     overlay then misses: a voiced dropped row would come back voiceless AND
     be re-added below as a 0-line orphan — a visible duplicate — while an
     UNVOICED dropped row would simply vanish with no retirement recorded, so
     a re-analysis could never resolve its history back to the live row
     (#2040 Task 12, RC1 — spec §9/§4.4, "the riskiest single change in the
     design"). Match a dropped existing character to a same-name fresh
     character so any voice fields it carries ride onto the freshly-detected
     row (which carries the lines + the more descriptive, library-unique id)
     and the id is retired either way.

     The precondition that the dropped row be voiced/reused is gone — every
     dropped row is a candidate now, not just voiced ones — so a selection
     rule decides which dropped row wins a shared name, PER normalised name,
     among the rows the fresh roster dropped:
       - exactly one voiced/reused -> that one is the candidate (today's
         behaviour, unchanged even when unvoiced siblings share the name —
         this is what stops the widening from stranding a designed voice as
         a 0-line duplicate, spec §9's named hazard);
       - else exactly one row total -> that one is the candidate (the
         widening's actual benefit: an unvoiced character can now be matched
         too);
       - otherwise -> ambiguous, no match, left to the id-only path (too
         risky to guess).
     A normalised name shared by more than one fresh row is, separately,
     always left to the id-only path regardless of the above. */
  const freshNameCounts = new Map<string, number>();
  for (const f of fresh) {
    const key = nameOf(f as T & Record<string, unknown>);
    if (key) freshNameCounts.set(key, (freshNameCounts.get(key) ?? 0) + 1);
  }
  const droppedByName = new Map<string, CastRecord[]>();
  for (const old of existing) {
    // Never a name-fallback candidate: the reserved narrator id has its own
    // identity mechanism (applyNarratorIdentity), not the generic name match.
    // dedupePriorCastByName's isNarrator exclusion (this file, :659) is the
    // same call for the same reason. Narrator rows were excluded here only
    // incidentally before this task's widening — applyNarratorIdentity seeds
    // voiceStyle/persona but never voiceUuid/voiceState, and isVoicedOrReused
    // doesn't test voiceStyle, so the old isVoicedOrReused precondition kept
    // them out as a side effect. Widening past that precondition newly
    // admits them (via the lone-unvoiced-row branch below), so this explicit
    // exclusion is now load-bearing (#2040 Task 12 follow-up, L1): without
    // it, a fresh roster with no narrator row this run but a REAL character
    // whose name collides with the prior narrator's localized default name
    // would weld the narrator's voice fields onto that character and
    // durably retire the reserved 'narrator' id onto it.
    if (freshIds.has(old.id) || NARRATOR_CHARACTER_IDS.includes(old.id)) continue;
    const key = nameOf(old);
    if (!key) continue;
    const list = droppedByName.get(key);
    if (list) list.push(old);
    else droppedByName.set(key, [old]);
  }
  // No separate "ambiguous names" set: an ambiguous key is simply left OUT of
  // dropMatchCandidateByName below (neither branch calls .set() for it), so
  // .get(key) at the call site already returns undefined for it — a second
  // set tracking the same fact would be redundant by construction, not just
  // in practice (verified: #2040 Task 12 follow-up).
  const dropMatchCandidateByName = new Map<string, CastRecord>();
  for (const [key, rows] of droppedByName) {
    const voiced = rows.filter(isVoicedOrReused);
    if (voiced.length === 1) {
      dropMatchCandidateByName.set(key, voiced[0]);
    } else if (voiced.length === 0 && rows.length === 1) {
      dropMatchCandidateByName.set(key, rows[0]);
    }
  }

  /* Surname-tolerant extension of the SAME selection rule (#2536). A character
     that gained or lost a trailing surname token between runs (prior "Бранн" →
     fresh "Бранн Уир") drops off every EXACT key above, so `nameOf` would never
     match it and the fresh row would mint a near-duplicate id instead of
     resolving to its existing roster row. Run the same voice/reuse selection
     rule again over the dropped rows that surname-tolerantly match each
     still-unresolved fresh name. This widens only HOW a candidate key is found,
     never the selection rule once candidates are found, and never the fresh-
     ambiguity guard (a normalised name shared by >1 fresh row stays on the
     id-only path). An exact match is preferred: a fresh name that already
     resolves via dropMatchCandidateByName is skipped here entirely. An
     ambiguous tolerant key is left OUT of the map (same as the exact path), so
     it still routes to the id-only path rather than being guessed. */
  const tolerantCandidateByName = new Map<string, CastRecord>();
  for (const [key, count] of freshNameCounts) {
    if (count !== 1) continue; // shared by >1 fresh row → id-only path, unchanged
    if (dropMatchCandidateByName.has(key)) continue; // exact match preferred
    const matches: CastRecord[] = [];
    for (const rows of droppedByName.values()) {
      for (const old of rows) {
        if (surnameTolerantMatch(key, nameOf(old))) matches.push(old);
      }
    }
    const voiced = matches.filter(isVoicedOrReused);
    if (voiced.length === 1) {
      tolerantCandidateByName.set(key, voiced[0]);
    } else if (voiced.length === 0 && matches.length === 1) {
      tolerantCandidateByName.set(key, matches[0]);
    }
  }

  // Claim-once guard (#2536 review finding): a dropped row scanned against
  // every unresolved fresh key can otherwise win MORE THAN ONE key — e.g. one
  // dropped "Мэйрин" row tolerant-matching both "Мэйрин Уир" and "Мэйрин
  // Коул" — which would push two retirements FROM the same id and silently
  // lose the first one (retireCharacterId's supersededBy write is last-wins).
  // A row claimed by more than one tolerant key is too risky to guess between —
  // same philosophy as the ambiguous-candidate branches above, just at row
  // granularity instead of key granularity. Drop the tolerant entries (fall
  // through to id-only path); dropMatchCandidateByName entries are never removed.
  // A second instance of the same bug: a dropped row can be BOTH the exact-match
  // candidate for one fresh key AND the tolerant-match candidate for another
  // (e.g. prior "Brann" / fresh "Brann" exact + fresh "Brann Weir" tolerant).
  // Count each dropped row's id only when it would actually be CONSUMED at the
  // call site (the four gates inside the `if (nameFallback && !old) { ... }`
  // block checking freshNameCounts, NARRATOR_CHARACTER_IDS, and isBlockedByNotLinked).
  // A candidate-map presence without actual consumption is a "phantom claim" that inflates counts and causes false-
  // positive refusals: e.g. a dropped row's id is in a map under a key whose
  // fresh row already matches by id (gate 1 below fails), or whose fresh row
  // shares the name with >1 fresh row (gate 2), or whose pair is blocked by
  // notLinkedTo (gate 4) — none of these would ever call the name-fallback,
  // yet the prior raw-presence count included them. Only count pairs where all
  // four gates at the call site would succeed: (1) fresh row has no prior by-id
  // match, (2) fresh name count is exactly 1, (3) fresh id is not narrator,
  // (4) neither notLinkedTo gate blocks the pair.
  const freshByKey = new Map<string, { id: string }>();
  for (const f of fresh) {
    const k = nameOf(f as T & Record<string, unknown>);
    if (k && !freshByKey.has(k)) freshByKey.set(k, f as unknown as { id: string });
  }
  const isBlockedByNotLinked = (cand: CastRecord, f: { id: string }): boolean =>
    notLinkedToId(cand, f.id) ||
    notLinkedToId(f as unknown as Record<string, unknown>, cand.id);
  const consumable = (key: string, cand: CastRecord): boolean => {
    // Mirror the exact four gates from the call site (not-already-id-matched,
    // name-count-exactly-one, not-narrator, not-notLinkedTo-blocked).
    if (freshNameCounts.get(key) !== 1) return false; // gate 2: must be exactly 1
    const f = freshByKey.get(key);
    if (!f) return false; // gate 2: must exist
    if (byId.get(f.id)) return false; // gate 1: no prior by-id match
    if (NARRATOR_CHARACTER_IDS.includes(f.id)) return false; // gate 3: not narrator
    if (isBlockedByNotLinked(cand, f)) return false; // gate 4: no notLinkedTo block
    return true;
  };
  const tolerantCandidateCount = new Map<string, number>();
  for (const [key, cand] of dropMatchCandidateByName) {
    if (consumable(key, cand)) {
      tolerantCandidateCount.set(cand.id, (tolerantCandidateCount.get(cand.id) ?? 0) + 1);
    }
  }
  for (const [key, cand] of tolerantCandidateByName) {
    if (consumable(key, cand)) {
      tolerantCandidateCount.set(cand.id, (tolerantCandidateCount.get(cand.id) ?? 0) + 1);
    }
  }
  const keysToDelete: string[] = [];
  for (const [key, cand] of tolerantCandidateByName) {
    if ((tolerantCandidateCount.get(cand.id) ?? 0) > 1) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    tolerantCandidateByName.delete(key);
  }

  const claimedByName = new Set<string>(); // existing ids whose voice rode onto a fresh row

  const overlaid = fresh.map((f) => {
    let old = byId.get(f.id);
    // #2584: when the name-fallback confirms a dropped established row whose id
    // is already ASCII-kebab, that established id survives (fresh id retired TO
    // it) — `old` is that row, so the merged object must keep old.id.
    let establishedIdSurvives = false;
    if (nameFallback && !old) {
      const key = nameOf(f as T & Record<string, unknown>);
      // A fresh narrator-id row never adopts a name-fallback candidate
      // either. Unlike the droppedByName exclusion above, this direction
      // PRE-DATES Task 12 — a voiced real character already satisfied the
      // pre-Task-12 isVoicedOrReused precondition, so nothing ever excluded
      // narrator here; the widening did not create this exposure. Closed
      // here anyway (fix-now bar: adjacent to, and the exact mirror of, the
      // exclusion just landed) because a real character matched onto the
      // reserved narrator id would retire the REAL character's id to
      // 'narrator' — every frozen segment that character ever rendered
      // would then resolve to the narrator, precisely #2040's original bug.
      // Safe to exclude unconditionally: the narrator id is code-seeded
      // (NARRATOR_CHARACTER_IDS), never analyzer-minted, so there is no
      // legitimate id-drift case here for the fallback to rescue, and
      // :445-455 already carries the narrator name forward on its own path.
      if (key && freshNameCounts.get(key) === 1 && !NARRATOR_CHARACTER_IDS.includes(f.id)) {
        const cand =
          dropMatchCandidateByName.get(key) ?? tolerantCandidateByName.get(key);
        // A notLinkedTo edge between this specific pair is the user's
        // explicit "not the same person" decision — widening the candidate
        // set past isVoicedOrReused must not let the fallback silently
        // override it. A blocked match falls through to the id-only path
        // exactly like an ambiguous one: refusing is always safe, matching
        // wrongly is not (#2040 spec §9 — the match now also retires the id,
        // durably, via retireCharacterId).
        if (
          cand &&
          !notLinkedToId(cand, f.id) &&
          !notLinkedToId(f as unknown as Record<string, unknown>, cand.id)
        ) {
          old = cand;
          claimedByName.add(cand.id);
          // Established-id survival rule (#2584): when the dropped existing
          // row's id is already ASCII-kebab it survives, and the freshly-minted
          // id is retired TO it (retirements keep `from`=retired, `to`=survivor).
          // When it is not ASCII-kebab, today's direction holds — the fresh id
          // may be a genuine improvement.
          establishedIdSurvives = isAsciiKebabId(cand.id);
          if (establishedIdSurvives) {
            retirements.push({ from: f.id, to: cand.id });
          } else {
            retirements.push({ from: cand.id, to: f.id });
          }
        }
      }
    }
    if (!old) return f;
    const merged = { ...(f as Record<string, unknown>) };
    // #2584: when the established ASCII-kebab id won the name-fallback, write it
    // back as the merged row's live id (default above would keep the fresh id).
    if (establishedIdSurvives) merged.id = old.id;
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
      NARRATOR_CHARACTER_IDS.includes(f.id) &&
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
  return { characters: overlaid, retirements };
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
    Returns a new array of remapped rows, a list of dropped rows (original id
    + voiceState) for caller logging, and the id retirements this remap
    performed — one per row whose id actually changed, whether it won or lost
    a collision (a collision loser whose own id already equalled the
    canonical id needs no retirement: that id string stays live, just under
    the winner's data). Inputs are not mutated. */
export function applyRewriteToPriorCast<T extends CastRecord>(
  priorCast: ReadonlyArray<T>,
  rewrites: Record<string, string>,
): {
  priorCast: T[];
  droppedVoices: Array<{ id: string; voiceState?: string }>;
  retirements: Retirement[];
} {
  // Map from canonical id → { row (with remapped id), originalId }
  const winners = new Map<string, { row: T; originalId: string }>();
  const droppedVoices: Array<{ id: string; voiceState?: string }> = [];
  const retirements: Retirement[] = [];

  for (const row of priorCast) {
    const originalId = row.id;
    const canonicalId = rewrites[originalId] ?? originalId;
    if (canonicalId !== originalId) {
      retirements.push({ from: originalId, to: canonicalId });
    }
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

  return {
    priorCast: Array.from(winners.values()).map((w) => w.row),
    droppedVoices,
    retirements,
  };
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
    first member's slot) + a dropped-row log for the change-log + the id
    retirements this collapse performed (each dropped row's id, superseded by
    the survivor's id). Input is not mutated. */
export function dedupePriorCastByName<T extends CastRecord>(
  priorCast: ReadonlyArray<T>,
): {
  cast: T[];
  dropped: Array<{ id: string; name?: string; voiceState?: string }>;
  retirements: Retirement[];
} {
  if (priorCast.length < 2) return { cast: [...priorCast], dropped: [], retirements: [] };

  const nameKeyOf = (c: CastRecord): string =>
    typeof c.name === 'string' ? normaliseNameKey(c.name) : '';
  const isNarrator = (c: CastRecord): boolean => NARRATOR_CHARACTER_IDS.includes(c.id);

  const groups = new Map<string, T[]>();
  for (const c of priorCast) {
    const key = nameKeyOf(c);
    if (!key || isNarrator(c)) continue;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }

  const dropped: Array<{ id: string; name?: string; voiceState?: string }> = [];
  const retirements: Retirement[] = [];
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
      if (row.id !== best.id) retirements.push({ from: row.id, to: best.id });
    }
    survivorByKey.set(key, aliases ? ({ ...best, aliases } as T) : best);
  }

  if (!collapsedKeys.size) return { cast: [...priorCast], dropped: [], retirements: [] };

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
  return { cast: out, dropped, retirements };
}
