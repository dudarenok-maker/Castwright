/* The run-start prior-cast heal (`dedupePriorCastByName`) and the voice-field
   list the cast PUT preserves (`PRESERVED_VOICE_FIELDS`).

   Plan 291 (#4031) deleted this module's old fresh<->prior overlay
   (`mergeAnalysisResultWithExistingCast` & co): `matchFreshToPrior`
   (`match-fresh-to-prior.ts`) is the only fresh<->prior identity matcher, and
   `single-matcher.guard.test.ts` keeps it so. What is left collapses
   same-normalised-name rows INSIDE the prior cast; it never compares a fresh
   row to a prior one. */

import { normaliseNameKey } from '../util/safe-id.js';
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';
import { notLinkedToId } from './not-linked-to-scope.js';
import { declinesLinkOf, unionNotLinkedTo } from './cast-name-match.js';
import type { NotSamePersonRecord, StoredSuggestion } from './reanalysis-types.js';

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
  'declinedVoiceFrom',
  'declinedVoiceUuids',
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

/** True when the group holds a recorded not-the-same-person decision: a row's
    notLinkedTo naming another member's id, a row's own same-book self-edge (the
    seed's copy of a rejected pair), or one row declining the series link
    another carries in matchedFrom (`declinesLinkOf`). Conservative: any such
    decision blocks collapsing the whole group, mirroring Tier-1's gender-conflict
    skip. The id checks go through the shared book-scoped `notLinkedToId` (#3965):
    a cross-book edge copied onto an id-drifted twin is not a decision between
    these rows, but a same-book edge (reject-orphan's) still blocks. */
function groupHasNotLinkedEdge(
  group: ReadonlyArray<CastRecord>,
  currentBookId: string | undefined,
): boolean {
  for (const c of group) {
    for (const other of group) {
      // `other === c` is deliberate: a row's own same-book self-edge is the
      // seed's surviving record of a rejected pair (reject-orphan writes its edge
      // onto the live character, and the seed's name bridge copies it onto the
      // re-minted orphan), and fusing the pair would delete that rejection.
      // The book scope still drops a cross-book self-id.
      if (notLinkedToId(c as Record<string, unknown>, other.id, currentBookId)) return true;
      if (other !== c && declinesLinkOf(c, other)) return true;
    }
  }
  return false;
}

/** `a` plus the strings of `b` it lacks (a decline-marker list); non-array `b`
    contributes nothing. Never mutates either input. */
function unionStrings(a: string[] | undefined, b: unknown): string[] | undefined {
  if (!Array.isArray(b)) return a;
  const out = [...(a ?? [])];
  for (const e of b) if (typeof e === 'string' && !out.includes(e)) out.push(e);
  return out;
}

/** What the run-start heal must leave alone (#4031 A11): rows with an open
    merge suggestion, member pairs the user dismissed (`a < b`, as
    `recordNotSamePerson` stores them) and rows the run itself added. A degraded
    history read supplies no dismissals — it is "undetermined", so the heal runs
    on the other two refusals rather than refusing every group. */
export interface DedupeHealOpts {
  openSuggestions: ReadonlyArray<StoredSuggestion>;
  notSamePerson: ReadonlyArray<NotSamePersonRecord>;
  skipIds: ReadonlySet<string>;
  /** The suggestions could not be read: no group may be healed this run. */
  healDisabled?: boolean;
}
const NO_HEAL_OPTS: DedupeHealOpts = { openSuggestions: [], notSamePerson: [], skipIds: new Set() };

/** True when two members of the group share a dismissal record (the set holds
    both orders of every record). */
function groupHasDismissal(group: ReadonlyArray<CastRecord>, dismissed: ReadonlySet<string>): boolean {
  for (const x of group) {
    for (const y of group) {
      if (x !== y && dismissed.has(`${x.id}\u0000${y.id}`)) return true;
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
  currentBookId: string | undefined,
  opts: DedupeHealOpts = NO_HEAL_OPTS,
): {
  cast: T[];
  dropped: Array<{ id: string; name?: string; voiceState?: string }>;
  retirements: Retirement[];
} {
  if (priorCast.length < 2 || opts.healDisabled)
    return { cast: [...priorCast], dropped: [], retirements: [] };

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

  // #4031 A11 — an open question about a row (to ANY other row, not only a
  // fellow group member) or a run-ledger row is not the heal's to settle.
  const suggested = new Set<string>();
  for (const s of opts.openSuggestions) {
    for (const id of [s.sourceId, s.targetId, s.a, s.b]) suggested.add(id);
  }
  // Either order: the store writes `a < b`, but a hand-edited or older record
  // must not silently stop protecting its pair.
  const dismissed = new Set(
    opts.notSamePerson.flatMap((r) => [`${r.a}\u0000${r.b}`, `${r.b}\u0000${r.a}`]),
  );

  for (const [key, group] of groups) {
    if (
      group.length < 2 ||
      groupHasNotLinkedEdge(group, currentBookId) ||
      group.some((c) => suggested.has(c.id) || opts.skipIds.has(c.id)) ||
      groupHasDismissal(group, dismissed)
    )
      continue;
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
    // A dropped row's "not the same person" decisions ride onto the survivor:
    // the collapse is the owner's call, losing a user's decline is not (#3965).
    let notLinkedTo: unknown[] | undefined = Array.isArray(best.notLinkedTo)
      ? (best.notLinkedTo as unknown[])
      : undefined;
    // #3992: the decline markers ("not this voice") ride onto the survivor too.
    let declinedVoiceFrom = unionStrings(undefined, best.declinedVoiceFrom);
    let declinedVoiceUuids = unionStrings(undefined, best.declinedVoiceUuids);
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
      if (Array.isArray(row.notLinkedTo)) {
        notLinkedTo = unionNotLinkedTo(notLinkedTo, row.notLinkedTo as unknown[]);
      }
      declinedVoiceFrom = unionStrings(declinedVoiceFrom, row.declinedVoiceFrom);
      declinedVoiceUuids = unionStrings(declinedVoiceUuids, row.declinedVoiceUuids);
      dropped.push({
        id: row.id,
        ...(typeof row.name === 'string' ? { name: row.name } : {}),
        ...(typeof row.voiceState === 'string' ? { voiceState: row.voiceState } : {}),
      });
      if (row.id !== best.id) retirements.push({ from: row.id, to: best.id });
    }
    survivorByKey.set(
      key,
      aliases || notLinkedTo || declinedVoiceFrom?.length || declinedVoiceUuids?.length
        ? ({
            ...best,
            ...(aliases ? { aliases } : {}),
            ...(notLinkedTo ? { notLinkedTo } : {}),
            ...(declinedVoiceFrom?.length ? { declinedVoiceFrom } : {}),
            ...(declinedVoiceUuids?.length ? { declinedVoiceUuids } : {}),
          } as T)
        : best,
    );
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
