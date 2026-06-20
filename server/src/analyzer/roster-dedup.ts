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
  const suggestions: MergeSuggestion[] = [];
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
