import type { CharacterOutput } from '../handoff/schemas.js';
import { safeId, normaliseNameKey } from '../util/safe-id.js';
import { mergeCharacterFields } from './roster-merge-fields.js';
import { diminutiveCanonical } from './ru-diminutives.js';

export interface MergeSuggestion { sourceId: string; targetId: string; reason: string }

const NARRATOR_ID = 'narrator';

const gendersConflict = (a?: string, b?: string): boolean => !!a && !!b && a !== b;

/** Tokenise a name into normalised fragments for the token-subset check. */
const tokens = (name: string): string[] =>
  name.trim().split(/\s+/).map((t) => normaliseNameKey(t)).filter(Boolean);

/** Count attributed lines per character id from the sentence array. */
function lineCounts(sentences: ReadonlyArray<{ characterId: string }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sentences) m.set(s.characterId, (m.get(s.characterId) ?? 0) + 1);
  return m;
}

// ── composeRewrites ──────────────────────────────────────────────────────────

/** Compose two rewrite maps transitively. For every id that is a key in either
    map, returns its FINAL target after applying `first` then `second` (chasing
    the chain once; cycles are guarded). Identity entries (final === original)
    are omitted from the result. */
export function composeRewrites(
  first: Record<string, string>,
  second: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const allKeys = new Set([...Object.keys(first), ...Object.keys(second)]);
  for (const key of allKeys) {
    // Apply first map, then second map once (single transitive step).
    const afterFirst = first[key] ?? key;
    const afterSecond = second[afterFirst] ?? afterFirst;
    // Guard cycles: if we'd loop back to the key itself, stop.
    if (afterSecond !== key) {
      result[key] = afterSecond;
    }
  }
  return result;
}

// ── dedupeRosterByName ───────────────────────────────────────────────────────

export function dedupeRosterByName(
  characters: CharacterOutput[],
  sentences: ReadonlyArray<{ characterId: string }>,
  _opts: { language?: string } = {},
): { characters: CharacterOutput[]; rewrites: Record<string, string>; suggestions: MergeSuggestion[] } {
  const lines = lineCounts(sentences);
  const rewrites: Record<string, string> = {};
  // Work on shallow clones so callers keep their input; preserve insertion order.
  let roster: CharacterOutput[] = characters.map((ch) => ({ ...ch }));

  // ── Tier-1: exact normalised name, gender-gated, never narrator ──────────
  const byKey = new Map<string, CharacterOutput[]>();
  for (const ch of roster) {
    if (ch.id === NARRATOR_ID) continue;
    const key = normaliseNameKey(ch.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(ch);
  }

  // tier1Survivors: canonicalId → merged survivor node.
  const tier1Survivors = new Map<string, CharacterOutput>();
  // ids that have been consumed (should not appear in the rebuilt roster).
  const dropped = new Set<string>();

  for (const group of byKey.values()) {
    if (group.length < 2) continue;

    // Gender conflict → leave the whole group un-merged (conservative).
    const genders = new Set(group.map((g) => g.gender).filter(Boolean));
    if (genders.size > 1) continue;

    const canonicalId = safeId(group[0].name);
    // Never remap onto the special narrator id.
    if (canonicalId === NARRATOR_ID) continue;

    // Build the survivor: start from the first group member, assign canonical id.
    const survivor: CharacterOutput = { ...group[0], id: canonicalId };

    // Record rewrite for the first member if its id differs from canonical.
    if (group[0].id !== canonicalId) rewrites[group[0].id] = canonicalId;

    // Merge remaining members into survivor.
    for (const member of group.slice(1)) {
      mergeCharacterFields(survivor, member);
      if (member.id !== canonicalId) rewrites[member.id] = canonicalId;
      dropped.add(member.id);
    }

    // Drop the first member too if it was replaced by the canonical id.
    if (group[0].id !== canonicalId) dropped.add(group[0].id);

    tier1Survivors.set(canonicalId, survivor);
  }

  // Rebuild roster: for each original slot, either keep it or replace the
  // first occurrence of its group with the survivor.
  const emittedT1 = new Set<string>();
  roster = roster.flatMap((ch) => {
    if (ch.id === NARRATOR_ID) return [ch];
    const canonicalId = rewrites[ch.id] ?? ch.id;
    const survivor = tier1Survivors.get(canonicalId);
    if (!survivor) return [ch]; // not part of any Tier-1 group
    if (emittedT1.has(canonicalId)) return []; // already emitted this group's survivor
    emittedT1.add(canonicalId);
    return [survivor];
  });

  // ── Tier-2a: full-vs-short token subset, single superset, auto-merge ─────
  const linesOf = (ch: CharacterOutput): number => lines.get(ch.id) ?? 0;

  // Iterate a stable snapshot; track which ids were consumed this tier.
  const snapshot = [...roster];
  const droppedT2 = new Set<string>();

  for (const short of snapshot) {
    if (short.id === NARRATOR_ID || droppedT2.has(short.id)) continue;
    const sTok = tokens(short.name);
    if (sTok.length === 0) continue;

    // Find entries whose token list is a proper superset starting with short's tokens.
    const supersets = snapshot.filter(
      (long) =>
        long !== short &&
        long.id !== NARRATOR_ID &&
        !droppedT2.has(long.id) &&
        tokens(long.name).length > sTok.length &&
        sTok.every((t, i) => tokens(long.name)[i] === t) &&
        !gendersConflict(short.gender, long.gender),
    );

    // Ambiguous (0 or 2+) → skip.
    if (supersets.length !== 1) continue;

    const long = supersets[0];
    // Survivor = more lines; tie → earlier in roster (snapshot) order.
    // When tied, prefer the one that appears earlier in snapshot order.
    const longLines = linesOf(long);
    const shortLines = linesOf(short);
    let survivor: CharacterOutput;
    let victim: CharacterOutput;
    const shortIdx = snapshot.indexOf(short);
    const longIdx = snapshot.indexOf(long);
    if (longLines > shortLines || (longLines === shortLines && longIdx < shortIdx)) {
      survivor = long;
      victim = short;
    } else {
      survivor = short;
      victim = long;
    }

    mergeCharacterFields(survivor, victim);
    rewrites[victim.id] = survivor.id;
    droppedT2.add(victim.id);
  }

  roster = roster.filter((ch) => !droppedT2.has(ch.id));

  // ── Tier-3: alias coreference — strong auto-merge via union-find ──────────
  // A candidate link X→Y := X's normalised name appears in Y's alias set.
  // Strong (auto-merge) when MUTUAL, or one-directional via a MULTI-token name
  // (a full proper name is unlikely to also be a different character's whole
  // name). A one-sided SINGLE-token (bare-word) link is left to the weak pass
  // so a role-word-named minor (`шеф`) is never directionally absorbed into a
  // principal. Hoisted so Tier-3 and Tier-2b share one suggestions array.
  const suggestions: MergeSuggestion[] = [];

  const nameKeyOf = (ch: CharacterOutput): string => normaliseNameKey(ch.name);
  const aliasKeysOf = (ch: CharacterOutput): Set<string> =>
    new Set((ch.aliases ?? []).map((a) => normaliseNameKey(a)).filter(Boolean));

  const t3nodes = roster.filter((ch) => ch.id !== NARRATOR_ID);
  const t3aliases = new Map<string, Set<string>>();
  for (const ch of t3nodes) t3aliases.set(ch.id, aliasKeysOf(ch));

  // Union-find over strong edges (roster is tiny — plain find, no compression).
  // The tuple annotation keeps `new Map<string,string>(...)` type-checking
  // (a bare `[ch.id, ch.id]` infers as string[], not the [string,string] the
  // Map ctor wants).
  const parent = new Map<string, string>(t3nodes.map((ch): [string, string] => [ch.id, ch.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Gender gate is PER EDGE (matches the spec's pair-level wording): a
  // cross-gender candidate link is simply dropped, so an unrelated same-gender
  // merge in the same component still proceeds. (Do NOT skip the whole
  // component on one bad cross-gender edge — that silently blocks valid merges.)
  for (let i = 0; i < t3nodes.length; i++) {
    for (let j = i + 1; j < t3nodes.length; j++) {
      const x = t3nodes[i];
      const y = t3nodes[j];
      if (gendersConflict(x.gender, y.gender)) continue;
      const linkXY = t3aliases.get(y.id)!.has(nameKeyOf(x)); // x's name ∈ y aliases
      const linkYX = t3aliases.get(x.id)!.has(nameKeyOf(y)); // y's name ∈ x aliases
      const mutual = linkXY && linkYX;
      const strong =
        mutual ||
        (linkXY && tokens(x.name).length >= 2) ||
        (linkYX && tokens(y.name).length >= 2);
      if (strong) union(x.id, y.id);
    }
  }

  // Group survivors by component root; merge each ≥2 component into one survivor.
  const t3components = new Map<string, CharacterOutput[]>();
  for (const ch of t3nodes) {
    const root = find(ch.id);
    if (!t3components.has(root)) t3components.set(root, []);
    t3components.get(root)!.push(ch);
  }
  const droppedT3 = new Set<string>();
  for (const members of t3components.values()) {
    if (members.length < 2) continue;
    // Component-consistency guard (defense-in-depth). The per-edge gate only
    // sees pairs: it drops a conflicting edge (male↔female, male↔neutral,
    // female↔neutral — `gendersConflict` treats all three as mutually
    // distinct), but it CANNOT stop an unknown-gender node from linking to two
    // rows of DIFFERENT concrete genders (unknown conflicts with neither).
    // Union-find is transitive, so e.g. male—unknown—female co-land in one
    // component with no conflicting edge ever allowed — and the merge below
    // would then collapse a female into a male row (the Night Watch over-merge).
    // Mirror the per-edge notion of conflict: if a component carries ≥2 distinct
    // CONCRETE genders, it is contradictory — refuse the whole auto-merge and
    // leave the members standing for the user rather than pick a wrong survivor.
    // (Forcing gender required in the analyzer grammar keeps unknown-gender
    // rosters rare, but other engines / pre-fix cast.json can still produce them.)
    const concreteGenders = new Set(
      members.map((m) => m.gender).filter((g) => g === 'male' || g === 'female' || g === 'neutral'),
    );
    if (concreteGenders.size > 1) continue;
    // Survivor = most name tokens (prefer real name), then most lines, then
    // earliest roster order — deterministic regardless of union order.
    // (Secondary line-count tiebreak can undercount a Tier-1/Tier-2a survivor
    // whose id was renamed or whose victim's sentences aren't rewritten until
    // dedupAndPrepare, so `lines.get(id)` can read 0 for it; only bites on a
    // token-count tie, so it never changes which real name wins.)
    const ranked = members
      .map((m) => ({ m, idx: roster.indexOf(m), tok: tokens(m.name).length, ln: lines.get(m.id) ?? 0 }))
      .sort((a, b) => b.tok - a.tok || b.ln - a.ln || a.idx - b.idx);
    const survivor = ranked[0].m;
    // Merge victims in roster order for deterministic field-merge results.
    const victims = ranked
      .slice(1)
      .map((r) => r.m)
      .sort((a, b) => roster.indexOf(a) - roster.indexOf(b));
    for (const victim of victims) {
      mergeCharacterFields(survivor, victim);
      rewrites[victim.id] = survivor.id;
      droppedT3.add(victim.id);
    }
  }
  roster = roster.filter((ch) => !droppedT3.has(ch.id));

  // ── Tier-3 weak suggestions: distinctive overlap on EXACTLY two rows ──────
  // One-sided single-token name links (that failed the mutuality gate) and
  // shared third-party aliases surface as user-confirmable suggestions — but
  // only when the linking string is on exactly two surviving rows (3+ ⇒ generic
  // role word ⇒ nothing), keeping the cast page quiet.
  //
  // Alias sets here are the PRE-MERGE snapshot `t3aliases` (built above, before
  // any strong merge), NOT the mutated survivor rows — so a "shared alias"
  // suggestion reflects the model's own annotation and never fires on an alias
  // a strong merge just accumulated onto a survivor. Dropped victims aren't
  // iterated, so they never count toward rowCountOfKey.
  const t3survivors = roster.filter((ch) => ch.id !== NARRATOR_ID);
  const rowCountOfKey = (key: string): number =>
    t3survivors.filter((ch) => nameKeyOf(ch) === key || t3aliases.get(ch.id)!.has(key)).length;
  const displayForKey = (ch: CharacterOutput, key: string): string | undefined =>
    normaliseNameKey(ch.name) === key
      ? ch.name
      : (ch.aliases ?? []).find((a) => normaliseNameKey(a) === key);

  for (let i = 0; i < t3survivors.length; i++) {
    for (let j = i + 1; j < t3survivors.length; j++) {
      const x = t3survivors[i];
      const y = t3survivors[j];
      if (gendersConflict(x.gender, y.gender)) continue;

      const linkXY = t3aliases.get(y.id)!.has(nameKeyOf(x));
      const linkYX = t3aliases.get(x.id)!.has(nameKeyOf(y));

      let key: string | undefined;
      let display: string | undefined;
      if (linkXY || linkYX) {
        // One-sided single-token name link. This is single-token/non-mutual by
        // construction: a mutual or multi-token link is a STRONG edge, so it
        // would already have unioned the pair and dropped one party from
        // t3survivors — any name-link that survives to here is therefore weak.
        key = linkXY ? nameKeyOf(x) : nameKeyOf(y);
        display = linkXY ? x.name : y.name;
      } else {
        // Shared third-party alias (neither name links the other).
        const shared = [...t3aliases.get(x.id)!].find((k) => t3aliases.get(y.id)!.has(k));
        if (shared) {
          key = shared;
          display = displayForKey(x, shared) ?? displayForKey(y, shared) ?? shared;
        }
      }
      if (!key) continue;
      if (rowCountOfKey(key) !== 2) continue;

      // source = fewer lines, target = more lines (tie → i<j, so y is source).
      const xln = lines.get(x.id) ?? 0;
      const yln = lines.get(y.id) ?? 0;
      const target = xln >= yln ? x : y;
      const source = target === x ? y : x;
      suggestions.push({
        sourceId: source.id,
        targetId: target.id,
        reason: `Both known as «${display}»`,
      });
    }
  }

  // Collapse rewrites transitively (a victim may have been a Tier-1 canonical).
  for (const k of Object.keys(rewrites)) {
    let v = rewrites[k];
    const visited = new Set<string>([k]);
    while (rewrites[v] && rewrites[v] !== v && !visited.has(rewrites[v])) {
      visited.add(v);
      v = rewrites[v];
    }
    rewrites[k] = v;
  }

  // ── Tier-2b: diminutive → suggestion only ────────────────────────────────
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const a = roster[i];
      const b = roster[j];
      if (a.id === NARRATOR_ID || b.id === NARRATOR_ID) continue;

      const da = diminutiveCanonical(a.name);
      const db = diminutiveCanonical(b.name);
      if (!da || !db || da.base !== db.base) continue;

      // Exact same normalised name → already handled by Tier-1.
      if (normaliseNameKey(a.name) === normaliseNameKey(b.name)) continue;

      // Gender conflict → skip.
      if (gendersConflict(a.gender, b.gender)) continue;

      // Multi-gender diminutive requires both sides to have concrete, agreeing gender.
      if (da.multiGender && (!a.gender || !b.gender)) continue;

      // Source = fewer lines; target = more lines (ties → i < j so b is target).
      const target = linesOf(a) >= linesOf(b) ? a : b;
      const source = target === a ? b : a;
      suggestions.push({ sourceId: source.id, targetId: target.id, reason: `Diminutive of «${target.name}»` });
    }
  }

  return { characters: roster, rewrites, suggestions };
}

/** Drop suggestions whose source OR target id is not a standing character in the
    final (post-fold) roster — the fold may have collapsed a low-line diminutive
    into a bucket, which would leave a suggestion pointing at a gone id. */
export function pruneSuggestionsToRoster(
  suggestions: MergeSuggestion[],
  characters: ReadonlyArray<{ id: string }>,
): MergeSuggestion[] {
  const ids = new Set(characters.map((c) => c.id));
  return suggestions.filter((s) => ids.has(s.sourceId) && ids.has(s.targetId));
}
