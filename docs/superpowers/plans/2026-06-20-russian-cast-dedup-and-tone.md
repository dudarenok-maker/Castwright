# Russian Cast De-duplication + Tone Population — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse same-person duplicate cast entries that arise from the analyzer model emitting divergent transliterated character ids, and guarantee every character ends analysis with a populated tone profile.

**Architecture:** A pure, finalization-stage `dedupeRosterByName` pass (Tier-1 exact-name + Tier-2a gated full-vs-short auto-merge + Tier-2b diminutive suggestions) mirrors `foldMinorCast`'s `{ characters, rewrites }` shape and runs *before* the fold; its rewrites are applied to sentences, threaded into the prior-cast voice carry-forward (so designed voices follow id remaps), and journalled under a new `kind:'dedup'`. Tone is handled by a two-schema `runStage` (grammar requests tone, validation tolerates its absence) plus a deterministic `fillToneFromAttributes` backstop.

**Tech Stack:** TypeScript (Node 20 ESM), Zod v4, Vitest (server, node env), React 18 + RTK (frontend), Playwright (e2e).

**Source spec:** `docs/superpowers/specs/2026-06-20-russian-cast-dedup-and-tone-design.md` (approved, 3× adversarially reviewed).

## Global Constraints

- **No hex literals in component code** — design tokens are CSS custom properties (`src/styles.css`).
- **OpenAPI is the type source of truth** — character/sentence types come from generated `src/lib/api-types.ts`; never hand-write them. After any `openapi.yaml` edit run `npm run openapi:types`.
- **RTK reducers mutate via Immer drafts** — do not rewrite to spreads.
- **Every change ships paired automated tests** (CLAUDE.md testing discipline). Bug-shaped changes ship a regression test that fails before, passes after.
- **Commit convention:** `<type>(<scope>): <subject>` (validated by husky `commit-msg`). Scope here is mostly `server`, with `frontend` for the UI task.
- **Branch:** all work lands on `fix/server-ru-cast-dedup-tone` (already cut from `main`).
- **Server tests:** `cd server && npm run test` (Vitest, node env, colocated `*.test.ts`). The Gemini analyzer + routes test files are the slow tier (`npm run test:server-slow`).
- **Persisted `characterSchema.tone` stays `optional()`** — never make it required (old `cast.json` files must validate). Only a *new* analyzer-grammar schema marks tone required.
- **Narrator is `id === 'narrator'`** — never `color === 'narrator'` (that mis-matches both ways).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `server/src/store/cast-merges.ts` | add `kind:'dedup'`, `replaceDedupEntries`, `buildDedupJournalEntries` | 1 |
| `server/src/analyzer/roster-merge-fields.ts` (new) | shared character field-merge helper (extracted from `mergeRosterChapter`) | 2 |
| `server/src/analyzer/ru-diminutives.ts` (new) | curated Russian diminutive↔canonical table + lookup | 3 |
| `server/src/analyzer/roster-dedup.ts` (new) | `dedupeRosterByName` (Tier-1/2a/2b) + `MergeSuggestion` | 4 |
| `server/src/analyzer/fill-tone.ts` (new) | `fillToneFromAttributes` (bilingual keyword→axis) | 5 |
| `server/src/handoff/schemas.ts` | `requiredToneSchema`, `analyzerCharacterSchema`, stage-1 grammar-wrapper variants | 6 |
| `server/src/analyzer/ollama.ts` + `gemini.ts` | two-schema `runStage(grammarSchema, validationSchema)` | 7 |
| `server/src/store/merge-analysis-cast.ts` | apply rewrite to prior ids + voiced-collision policy | 8 |
| `server/src/workspace/paths.ts` + new `server/src/store/cast-merge-suggestions.ts` | sibling-file path + IO + fresh clear | 9 |
| `server/src/routes/analysis.ts` | wire dedup + tone-fill + journal + transitive closure at the two finalization sites | 10 |
| `server/src/routes/cast-merge-suggestions.ts` (new) + `openapi.yaml` | GET/accept/dismiss routes | 11 |
| `src/store/...`, `src/components/listen/...` or cast view, `e2e/` | suggestion card + redux + e2e | 12 |

---

### Task 1: Journal — add `kind:'dedup'`

**Files:**
- Modify: `server/src/store/cast-merges.ts`
- Test: `server/src/store/cast-merges.test.ts`

**Interfaces:**
- Consumes: existing `CastMergeEntry`, `replaceFoldEntries`, `buildFoldJournalEntries`.
- Produces: `replaceDedupEntries(file, dedupEntries) → CastMergesFile`; `buildDedupJournalEntries(rewrites, preDedupSentences, characters, ts) → CastMergeEntry[]`; widened `kind: 'manual' | 'fold' | 'dedup'`.

- [ ] **Step 1: Write the failing test**

```ts
// in cast-merges.test.ts
import { replaceDedupEntries, buildDedupJournalEntries, replaceFoldEntries, appendManualEntry } from './cast-merges.js';

describe('dedup journal entries', () => {
  it('replaceDedupEntries swaps dedup entries but preserves fold + manual', () => {
    const base = { entries: [
      { ts: 't', kind: 'manual' as const, sourceId: 'a', sourceName: 'A', targetId: 'b', affected: [] },
      { ts: 't', kind: 'fold' as const, sourceId: 'c', sourceName: 'C', targetId: 'd', affected: [] },
      { ts: 't', kind: 'dedup' as const, sourceId: 'olga', sourceName: 'Ольга', targetId: 'ольга', affected: [] },
    ]};
    const next = replaceDedupEntries(base, [
      { ts: 't2', kind: 'dedup' as const, sourceId: 'ilya', sourceName: 'Илья', targetId: 'илья', affected: [] },
    ]);
    expect(next.entries.filter((e) => e.kind === 'manual')).toHaveLength(1);
    expect(next.entries.filter((e) => e.kind === 'fold')).toHaveLength(1);
    expect(next.entries.filter((e) => e.kind === 'dedup')).toEqual([
      { ts: 't2', kind: 'dedup', sourceId: 'ilya', sourceName: 'Илья', targetId: 'илья', affected: [] },
    ]);
  });

  it('buildDedupJournalEntries records pre-dedup affected sentences + sourceName', () => {
    const rewrites = { olga: 'ольга' };
    const preDedupSentences = [
      { id: 1, chapterId: 3, characterId: 'olga' },
      { id: 2, chapterId: 3, characterId: 'antonio' },
      { id: 5, chapterId: 4, characterId: 'olga' },
    ];
    const chars = [{ id: 'olga', name: 'Ольга' }, { id: 'ольга', name: 'Ольга' }];
    const entries = buildDedupJournalEntries(rewrites, preDedupSentences, chars, 'TS');
    expect(entries).toEqual([
      { ts: 'TS', kind: 'dedup', sourceId: 'olga', sourceName: 'Ольга', targetId: 'ольга',
        affected: [{ chapterId: 3, sentenceId: 1 }, { chapterId: 4, sentenceId: 5 }] },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/store/cast-merges.test.ts -t "dedup journal"`
Expected: FAIL — `replaceDedupEntries`/`buildDedupJournalEntries` not exported; `kind:'dedup'` not assignable.

- [ ] **Step 3: Implement**

In `cast-merges.ts`, widen the union (line ~41) and add the two functions next to `replaceFoldEntries`/`buildFoldJournalEntries`:

```ts
// CastMergeEntry.kind:
  kind: 'manual' | 'fold' | 'dedup';
```

```ts
/** Replace ALL dedup entries with `dedupEntries`, preserving fold + manual.
    Idempotent across resume / re-analysis — orthogonal to replaceFoldEntries. */
export function replaceDedupEntries(
  file: CastMergesFile,
  dedupEntries: CastMergeEntry[],
): CastMergesFile {
  return { entries: [...file.entries.filter((e) => e.kind !== 'dedup'), ...dedupEntries] };
}

/** Like buildFoldJournalEntries but stamps kind:'dedup'. `affected` = the
    (chapterId, sentenceId) of every PRE-DEDUP sentence attributed to each source;
    `sourceName` from the pre-dedup roster. */
export function buildDedupJournalEntries(
  rewrites: Record<string, string>,
  preDedupSentences: ReadonlyArray<{ id: number; chapterId: number; characterId: string }>,
  characters: ReadonlyArray<{ id: string; name: string }>,
  ts: string,
): CastMergeEntry[] {
  const sourceIds = Object.keys(rewrites);
  if (sourceIds.length === 0) return [];
  const nameById = new Map(characters.map((c) => [c.id, c.name]));
  const affectedBySource = new Map<string, AffectedSentence[]>();
  for (const id of sourceIds) affectedBySource.set(id, []);
  for (const s of preDedupSentences) {
    const bucket = affectedBySource.get(s.characterId);
    if (bucket) bucket.push({ chapterId: s.chapterId, sentenceId: s.id });
  }
  return sourceIds.map((sourceId) => ({
    ts, kind: 'dedup' as const, sourceId,
    sourceName: nameById.get(sourceId) ?? sourceId,
    targetId: rewrites[sourceId],
    affected: affectedBySource.get(sourceId) ?? [],
  }));
}
```

Also update the module header comment's "Two write sites" note to mention the dedup pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/store/cast-merges.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/store/cast-merges.ts server/src/store/cast-merges.test.ts
git commit -m "feat(server): add kind:'dedup' journal entries + replaceDedupEntries"
```

---

### Task 2: Shared character field-merge helper

**Files:**
- Create: `server/src/analyzer/roster-merge-fields.ts`
- Test: `server/src/analyzer/roster-merge-fields.test.ts`
- Modify: `server/src/routes/analysis.ts` (`mergeRosterChapter` delegates to the helper)

**Interfaces:**
- Produces: `mergeCharacterFields(existing: CharacterOutput, incoming: CharacterOutput): void` — mutates `existing` in place, combining fields exactly as `mergeRosterChapter` does today (longest description; union attributes/aliases/evidence; first-wins gender/ageRange; incoming name/aliases → existing aliases, never the display name; tone field-merge).

- [ ] **Step 1: Write the failing test**

```ts
// roster-merge-fields.test.ts
import { mergeCharacterFields } from './roster-merge-fields.js';

const base = (over) => ({ id: 'a', name: 'Anton', role: 'r', color: 'c', ...over });

describe('mergeCharacterFields', () => {
  it('keeps the longer description and unions attributes', () => {
    const existing = base({ description: 'short', attributes: ['weary'] });
    mergeCharacterFields(existing, base({ description: 'a much longer description', attributes: ['weary', 'wry'] }));
    expect(existing.description).toBe('a much longer description');
    expect(existing.attributes).toEqual(['weary', 'wry']);
  });

  it('records a divergent incoming name as an alias, never the display name', () => {
    const existing = base({ name: 'Антон', aliases: [] });
    mergeCharacterFields(existing, base({ name: 'Антон Городецкий' }));
    expect(existing.name).toBe('Антон');
    expect(existing.aliases).toEqual(['Антон Городецкий']);
  });

  it('first detection wins for gender/ageRange; tone field-merges', () => {
    const existing = base({ gender: 'male', tone: { warmth: 30 } });
    mergeCharacterFields(existing, base({ gender: 'female', ageRange: 'adult', tone: { pace: 70 } }));
    expect(existing.gender).toBe('male');
    expect(existing.ageRange).toBe('adult');
    expect(existing.tone).toEqual({ warmth: 30, pace: 70 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/roster-merge-fields.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — copy the field-combination block out of `mergeRosterChapter` (`analysis.ts:574-637`) verbatim into the helper:

```ts
// roster-merge-fields.ts
import type { CharacterOutput } from './types.js'; // wherever CharacterOutput is declared; analysis.ts imports it today
import { normaliseForMatch } from '../util/text-match.js';

/** Combine `incoming` into `existing` in place — the exact field logic
    mergeRosterChapter uses, factored out so the dedup pass agrees with it. */
export function mergeCharacterFields(existing: CharacterOutput, incoming: CharacterOutput): void {
  if (incoming.description && (!existing.description || incoming.description.length > existing.description.length)) {
    existing.description = incoming.description;
  }
  if (incoming.tone) existing.tone = { ...existing.tone, ...incoming.tone };
  if (incoming.attributes?.length) {
    const seen = new Set(existing.attributes ?? []);
    const next = [...(existing.attributes ?? [])];
    for (const a of incoming.attributes) if (!seen.has(a)) { next.push(a); seen.add(a); }
    existing.attributes = next;
  }
  if (incoming.evidence?.length) {
    const seen = new Set((existing.evidence ?? []).map((e) => normaliseForMatch(e.quote)));
    const next = [...(existing.evidence ?? [])];
    for (const e of incoming.evidence) {
      const norm = normaliseForMatch(e.quote);
      if (norm.length > 0 && !seen.has(norm)) { next.push({ ...e }); seen.add(norm); }
    }
    existing.evidence = next;
  }
  if (!existing.gender && incoming.gender) existing.gender = incoming.gender;
  if (!existing.ageRange && incoming.ageRange) existing.ageRange = incoming.ageRange;
  const aliasCandidates = [incoming.name, ...(incoming.aliases ?? [])];
  const seen = new Set<string>([
    existing.name.trim().toLowerCase(),
    ...(existing.aliases ?? []).map((a) => a.trim().toLowerCase()),
  ]);
  const nextAliases = [...(existing.aliases ?? [])];
  for (const cand of aliasCandidates) {
    const key = cand.trim().toLowerCase();
    if (key.length > 0 && !seen.has(key)) { nextAliases.push(cand); seen.add(key); }
  }
  if (nextAliases.length) existing.aliases = nextAliases;
}
```

Then in `analysis.ts` replace the inline block in `mergeRosterChapter` (the `existing` branch, lines ~574-637) with `mergeCharacterFields(existing, incoming);` and import the helper. Use the exact `CharacterOutput` import path the analyzer already uses (grep `CharacterOutput` in `analysis.ts` for its source module).

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run src/analyzer/roster-merge-fields.test.ts && npx vitest run src/routes/analysis.test.ts -t "mergeRosterChapter"`
Expected: PASS (the existing `mergeRosterChapter` tests still pass — behaviour unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/roster-merge-fields.ts server/src/analyzer/roster-merge-fields.test.ts server/src/routes/analysis.ts
git commit -m "refactor(server): extract mergeCharacterFields from mergeRosterChapter"
```

---

### Task 3: Russian diminutive table

**Files:**
- Create: `server/src/analyzer/ru-diminutives.ts`
- Test: `server/src/analyzer/ru-diminutives.test.ts`

**Interfaces:**
- Produces: `diminutiveCanonical(name: string): { base: string; multiGender: boolean } | null` — returns the canonical base key (a `normaliseNameKey` value) and whether the diminutive maps to both genders; `null` if the name is not in the table (as diminutive or canonical).

- [ ] **Step 1: Write the failing test**

```ts
// ru-diminutives.test.ts
import { diminutiveCanonical } from './ru-diminutives.js';

describe('diminutiveCanonical', () => {
  it('maps a diminutive and its canonical to the same base', () => {
    expect(diminutiveCanonical('Оля')?.base).toBe(diminutiveCanonical('Ольга')?.base);
  });
  it('flags multi-gender diminutives', () => {
    expect(diminutiveCanonical('Саша')?.multiGender).toBe(true);
    expect(diminutiveCanonical('Оля')?.multiGender).toBe(false);
  });
  it('returns null for an unknown name', () => {
    expect(diminutiveCanonical('Завулон')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail.** `cd server && npx vitest run src/analyzer/ru-diminutives.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement.** Keyed on `normaliseNameKey` so matching is script-exact and case-insensitive:

```ts
// ru-diminutives.ts
import { normaliseNameKey } from '../util/safe-id.js';

/* Curated Russian diminutive↔canonical groups. Each group is a set of name
   forms (canonical + diminutives) that denote the same given name. `multiGender`
   marks groups whose forms span male AND female canonicals (Саша→Александр/
   Александра) — those need a stricter gender gate downstream. NOT exhaustive;
   extend from real corpus data. NO transliteration, NO edit-distance. */
interface DimGroup { base: string; forms: string[]; multiGender: boolean }

const GROUPS: DimGroup[] = [
  { base: 'ольга', forms: ['Ольга', 'Оля', 'Оленька'], multiGender: false },
  { base: 'софья', forms: ['Софья', 'Соня'], multiGender: false },
  { base: 'дмитрий', forms: ['Дмитрий', 'Дима', 'Митя'], multiGender: false },
  { base: 'екатерина', forms: ['Екатерина', 'Катя', 'Катюша'], multiGender: false },
  { base: 'михаил', forms: ['Михаил', 'Миша'], multiGender: false },
  { base: 'мария', forms: ['Мария', 'Маша', 'Маня'], multiGender: false },
  { base: 'антон', forms: ['Антон', 'Антоша'], multiGender: false },
  { base: 'светлана', forms: ['Светлана', 'Света'], multiGender: false },
  { base: 'борис', forms: ['Борис', 'Боря'], multiGender: false },
  { base: 'александр', forms: ['Александр', 'Александра', 'Саша', 'Саня', 'Шура'], multiGender: true },
  { base: 'евгений', forms: ['Евгений', 'Евгения', 'Женя'], multiGender: true },
  { base: 'валентин', forms: ['Валентин', 'Валентина', 'Валя'], multiGender: true },
  // …extend as real Russian books surface more (keep single-gender vs multiGender accurate).
];

const BY_KEY = new Map<string, { base: string; multiGender: boolean }>();
for (const g of GROUPS) for (const f of g.forms) BY_KEY.set(normaliseNameKey(f), { base: g.base, multiGender: g.multiGender });

/** Canonical base for a name if it is a known canonical or diminutive; else null. */
export function diminutiveCanonical(name: string): { base: string; multiGender: boolean } | null {
  return BY_KEY.get(normaliseNameKey(name)) ?? null;
}
```

- [ ] **Step 4: Run to verify pass.** `cd server && npx vitest run src/analyzer/ru-diminutives.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/src/analyzer/ru-diminutives.ts server/src/analyzer/ru-diminutives.test.ts
git commit -m "feat(server): curated Russian diminutive↔canonical table"
```

---

### Task 4: `dedupeRosterByName` (Tier-1, Tier-2a, Tier-2b)

**Files:**
- Create: `server/src/analyzer/roster-dedup.ts`
- Test: `server/src/analyzer/roster-dedup.test.ts`

**Interfaces:**
- Consumes: `mergeCharacterFields` (Task 2), `diminutiveCanonical` (Task 3), `safeId`/`normaliseNameKey` (`util/safe-id.ts`).
- Produces:
  - `interface MergeSuggestion { sourceId: string; targetId: string; reason: string }`
  - `dedupeRosterByName(characters: CharacterOutput[], sentences: ReadonlyArray<{ characterId: string }>, opts?: { language?: string }) → { characters: CharacterOutput[]; rewrites: Record<string,string>; suggestions: MergeSuggestion[] }`
  - `rewrites` is the transitively-collapsed old-id→canonical-id map for Tier-1 + Tier-2a (NOT diminutives); narrator never appears as key or value; canonical id is never `'narrator'` for a non-narrator group.

**Behaviour (from spec):** Tier-1 groups by `normaliseNameKey(name)`, gender-gated, canonical id = `safeId(name)`. Tier-2a token-subset, gated (non-narrator, gender-agree, single dominant superset), survivor = more lines (counted from `sentences`; ties → roster order). Tier-2b diminutive → suggestion only (multi-gender rows need both concrete agreeing genders). Narrator (`id==='narrator'`) excluded everywhere.

- [ ] **Step 1: Write the failing tests**

```ts
// roster-dedup.test.ts
import { dedupeRosterByName } from './roster-dedup.js';

const c = (over) => ({ id: over.id, name: over.name, role: over.role ?? 'r', color: over.color ?? 'c', ...over });
const sent = (characterId, n = 1) => Array.from({ length: n }, () => ({ characterId }));

describe('dedupeRosterByName Tier-1 (exact name)', () => {
  it('collapses olga + ольга to one entry with canonical id ольга', () => {
    const chars = [c({ id: 'olga', name: 'Ольга', gender: 'female' }), c({ id: 'ольга', name: 'Ольга', gender: 'female' })];
    const r = dedupeRosterByName(chars, [...sent('olga', 8), ...sent('ольга', 203)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('ольга');
    expect(r.rewrites).toEqual({ olga: 'ольга' });
  });

  it('does NOT merge two same-name people of different gender', () => {
    const chars = [c({ id: 'ivan', name: 'Иван', gender: 'male' }), c({ id: 'ivan2', name: 'Иван', gender: 'female' })];
    const r = dedupeRosterByName(chars, [...sent('ivan'), ...sent('ivan2')]);
    expect(r.characters).toHaveLength(2);
  });

  it('never merges the narrator, even with a non-narrator group named "Narrator"', () => {
    const chars = [c({ id: 'narrator', name: 'Narrator', color: 'unset' }), c({ id: 'narrator-2', name: 'Narrator' })];
    const r = dedupeRosterByName(chars, [...sent('narrator'), ...sent('narrator-2')]);
    // narrator row untouched; the non-narrator "Narrator" group must NOT remap onto id 'narrator'
    expect(r.characters.find((x) => x.id === 'narrator')).toBeDefined();
    expect(Object.values(r.rewrites)).not.toContain('narrator');
  });
});

describe('dedupeRosterByName Tier-2a (full vs short)', () => {
  it('auto-merges Антон into Антон Городецкий, survivor = more lines, short name aliased', () => {
    const chars = [c({ id: 'anton', name: 'Антон', gender: 'male' }), c({ id: 'anton-gorodetsky', name: 'Антон Городецкий', gender: 'male' })];
    const r = dedupeRosterByName(chars, [...sent('anton', 3), ...sent('anton-gorodetsky', 50)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('anton-gorodetsky');
    expect(r.characters[0].aliases).toContain('Антон');
    expect(r.rewrites).toEqual({ anton: 'anton-gorodetsky' });
  });

  it('does NOT merge when two longer names both contain the short name (ambiguous)', () => {
    const chars = [
      c({ id: 'anton', name: 'Антон', gender: 'male' }),
      c({ id: 'ag', name: 'Антон Городецкий', gender: 'male' }),
      c({ id: 'ai', name: 'Антон Иванов', gender: 'male' }),
    ];
    const r = dedupeRosterByName(chars, [...sent('anton'), ...sent('ag'), ...sent('ai')]);
    expect(r.characters).toHaveLength(3);
  });
});

describe('dedupeRosterByName Tier-2b (diminutive suggestions)', () => {
  it('emits a suggestion for Оля + Ольга without merging', () => {
    const chars = [c({ id: 'olya', name: 'Оля', gender: 'female' }), c({ id: 'ольга', name: 'Ольга', gender: 'female' })];
    const r = dedupeRosterByName(chars, [...sent('olya', 4), ...sent('ольга', 30)]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
    expect(r.suggestions).toEqual([{ sourceId: 'olya', targetId: 'ольга', reason: expect.any(String) }]);
  });

  it('does NOT suggest a multi-gender diminutive when genders are unset', () => {
    const chars = [c({ id: 's1', name: 'Саша' }), c({ id: 's2', name: 'Александр' })];
    const r = dedupeRosterByName(chars, [...sent('s1'), ...sent('s2')]);
    expect(r.suggestions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail.** `cd server && npx vitest run src/analyzer/roster-dedup.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement.**

```ts
// roster-dedup.ts
import type { CharacterOutput } from './types.js'; // same import path as Task 2
import { safeId, normaliseNameKey } from '../util/safe-id.js';
import { mergeCharacterFields } from './roster-merge-fields.js';
import { diminutiveCanonical } from './ru-diminutives.js';

export interface MergeSuggestion { sourceId: string; targetId: string; reason: string }

const NARRATOR_ID = 'narrator';
const gendersConflict = (a?: string, b?: string) => !!a && !!b && a !== b;
const tokens = (name: string) => name.trim().split(/\s+/).map((t) => normaliseNameKey(t)).filter(Boolean);

/** Count attributed lines per character id from the sentence array (stage-1
    `lines` is undefined pre-fold). */
function lineCounts(sentences: ReadonlyArray<{ characterId: string }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sentences) m.set(s.characterId, (m.get(s.characterId) ?? 0) + 1);
  return m;
}

export function dedupeRosterByName(
  characters: CharacterOutput[],
  sentences: ReadonlyArray<{ characterId: string }>,
  opts: { language?: string } = {},
): { characters: CharacterOutput[]; rewrites: Record<string, string>; suggestions: MergeSuggestion[] } {
  const lines = lineCounts(sentences);
  const rewrites: Record<string, string> = {};
  // Work on a shallow clone so callers keep their input; preserve insertion order.
  let roster = characters.map((ch) => ({ ...ch }));

  /* ── Tier-1: exact normalised name, gender-gated, never narrator ───────── */
  const byKey = new Map<string, CharacterOutput[]>();
  for (const ch of roster) {
    if (ch.id === NARRATOR_ID) continue;
    const key = normaliseNameKey(ch.name);
    if (!key) continue;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(ch);
  }
  const tier1Survivors = new Map<string, CharacterOutput>(); // canonicalId -> survivor
  const dropped = new Set<string>();
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    // Split off any gender-conflicting members so two different same-name people don't merge.
    const genders = new Set(group.map((g) => g.gender).filter(Boolean));
    if (genders.size > 1) continue; // conflicting genders → leave the whole group un-merged (conservative)
    const canonicalId = safeId(group[0].name);
    if (canonicalId === NARRATOR_ID) continue; // never remap onto the real narrator
    const survivor = { ...group[0], id: canonicalId };
    for (const member of group.slice(1)) {
      mergeCharacterFields(survivor, member);
      if (member.id !== canonicalId) rewrites[member.id] = canonicalId;
      dropped.add(member.id);
    }
    if (group[0].id !== canonicalId) rewrites[group[0].id] = canonicalId;
    tier1Survivors.set(canonicalId, survivor);
  }
  // Rebuild roster: replace each group's members with the single survivor at the first member's slot.
  const emitted = new Set<string>();
  roster = roster.flatMap((ch) => {
    if (ch.id === NARRATOR_ID) return [ch];
    const canonicalId = rewrites[ch.id] ?? ch.id;
    const survivor = tier1Survivors.get(canonicalId);
    if (!survivor) return [ch];
    if (emitted.has(canonicalId)) return [];
    emitted.add(canonicalId);
    return [survivor];
  });

  /* ── Tier-2a: full-vs-short token subset, gated, auto-merge ────────────── */
  const linesOf = (ch: CharacterOutput) => lines.get(ch.id) ?? 0;
  // Iterate a stable copy; a "short" name merges into the single longer superset.
  const current = [...roster];
  for (const short of current) {
    if (short.id === NARRATOR_ID || dropped.has(short.id)) continue;
    const sTok = tokens(short.name);
    if (sTok.length === 0) continue;
    const supersets = current.filter((long) =>
      long !== short && long.id !== NARRATOR_ID && !dropped.has(long.id) &&
      tokens(long.name).length > sTok.length &&
      sTok.every((t, i) => tokens(long.name)[i] === t) && // leading-token subset
      !gendersConflict(short.gender, long.gender),
    );
    if (supersets.length !== 1) continue; // ambiguous or none → skip
    const long = supersets[0];
    // Survivor = more lines; tie → earlier in roster order (current[] is roster order).
    const survivor = linesOf(long) >= linesOf(short) ? long : short;
    const victim = survivor === long ? short : long;
    mergeCharacterFields(survivor, victim);
    rewrites[victim.id] = survivor.id;
    dropped.add(victim.id);
  }
  roster = roster.filter((ch) => !dropped.has(ch.id));
  // Collapse rewrites transitively (victim may have been a Tier-1 canonical).
  for (const k of Object.keys(rewrites)) {
    let v = rewrites[k];
    while (rewrites[v] && rewrites[v] !== v) v = rewrites[v];
    rewrites[k] = v;
  }

  /* ── Tier-2b: diminutive → suggestion only ─────────────────────────────── */
  const suggestions: MergeSuggestion[] = [];
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const a = roster[i], b = roster[j];
      if (a.id === NARRATOR_ID || b.id === NARRATOR_ID) continue;
      const da = diminutiveCanonical(a.name), db = diminutiveCanonical(b.name);
      if (!da || !db || da.base !== db.base) continue;
      if (normaliseNameKey(a.name) === normaliseNameKey(b.name)) continue; // exact handled by Tier-1
      if (gendersConflict(a.gender, b.gender)) continue;
      if (da.multiGender && (!a.gender || !b.gender)) continue; // multi-gender needs both concrete
      const target = linesOf(a) >= linesOf(b) ? a : b;
      const source = target === a ? b : a;
      suggestions.push({ sourceId: source.id, targetId: target.id, reason: `Diminutive of «${target.name}»` });
    }
  }

  return { characters: roster, rewrites, suggestions };
}
```

> Note on `tokens(long.name)` recomputation: fine for clarity; if profiling shows it hot, memoize per row. The `byKey.get(key) ?? byKey.set(...).get(key)!` idiom appears elsewhere in the analyzer — keep it for consistency, or split into an explicit `if (!byKey.has(key)) byKey.set(key, [])` if the reviewer prefers.

- [ ] **Step 4: Run to verify pass.** `cd server && npx vitest run src/analyzer/roster-dedup.test.ts` → PASS. Fix any tie/order edge cases the tests reveal.

- [ ] **Step 5: Commit.**

```bash
git add server/src/analyzer/roster-dedup.ts server/src/analyzer/roster-dedup.test.ts
git commit -m "feat(server): dedupeRosterByName — Tier-1/2a auto-merge + Tier-2b suggestions"
```

---

### Task 5: `fillToneFromAttributes`

**Files:**
- Create: `server/src/analyzer/fill-tone.ts`
- Test: `server/src/analyzer/fill-tone.test.ts`

**Interfaces:**
- Produces: `fillToneFromAttributes(ch: CharacterOutput): CharacterOutput` — returns a clone with all four tone axes populated (0–100). Fires only when an axis is missing; never overwrites a present axis.

- [ ] **Step 1: Write the failing test**

```ts
// fill-tone.test.ts
import { fillToneFromAttributes } from './fill-tone.js';
const c = (over) => ({ id: 'a', name: 'A', role: 'r', color: 'c', ...over });

describe('fillToneFromAttributes', () => {
  it('derives a non-neutral tone from EN + RU descriptors', () => {
    const out = fillToneFromAttributes(c({ attributes: ['weary', 'прагматичный'] }));
    expect(out.tone).toBeDefined();
    expect(out.tone!.pace).toBeLessThan(50);      // weary → slower
    expect(out.tone!.authority).toBeGreaterThan(50); // pragmatic → more authority
    [out.tone!.warmth, out.tone!.pace, out.tone!.authority, out.tone!.emotion]
      .forEach((v) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); });
  });

  it('fills only missing axes; leaves present axes untouched', () => {
    const out = fillToneFromAttributes(c({ tone: { warmth: 80 }, attributes: ['playful'] }));
    expect(out.tone!.warmth).toBe(80);            // preserved
    expect(out.tone!.emotion).toBeGreaterThan(50); // playful → more emotion (was missing)
  });

  it('yields neutral 50s when there are no usable attributes', () => {
    const out = fillToneFromAttributes(c({}));
    expect(out.tone).toEqual({ warmth: 50, pace: 50, authority: 50, emotion: 50 });
  });
});
```

- [ ] **Step 2: Run to verify fail.** `cd server && npx vitest run src/analyzer/fill-tone.test.ts` → FAIL.

- [ ] **Step 3: Implement.**

```ts
// fill-tone.ts
import { normaliseNameKey } from '../util/safe-id.js';
import type { CharacterOutput } from './types.js';

type Axis = 'warmth' | 'pace' | 'authority' | 'emotion';
/* Keyword → axis deltas off a neutral 50 baseline. Keys are normaliseNameKey'd
   (script-exact, case-insensitive) EN + RU descriptors. Extend from corpus. */
const NUDGES: Record<string, Partial<Record<Axis, number>>> = {
  [normaliseNameKey('weary')]: { pace: -15, emotion: -10 },
  [normaliseNameKey('tired')]: { pace: -15, emotion: -10 },
  [normaliseNameKey('усталый')]: { pace: -15, emotion: -10 },
  [normaliseNameKey('устал')]: { pace: -15, emotion: -10 },
  [normaliseNameKey('pragmatic')]: { authority: 15, warmth: -10 },
  [normaliseNameKey('прагматичный')]: { authority: 15, warmth: -10 },
  [normaliseNameKey('playful')]: { emotion: 15, pace: 10 },
  [normaliseNameKey('игривый')]: { emotion: 15, pace: 10 },
  [normaliseNameKey('wise')]: { authority: 15, warmth: 10 },
  [normaliseNameKey('мудрый')]: { authority: 15, warmth: 10 },
  [normaliseNameKey('наставнический')]: { authority: 15, warmth: 10 },
  [normaliseNameKey('silent')]: { pace: -10, emotion: -10 },
  [normaliseNameKey('observant')]: { pace: -10, emotion: -10 },
  [normaliseNameKey('немногословный')]: { pace: -10, emotion: -10 },
  [normaliseNameKey('enigmatic')]: { warmth: -5, authority: 5, emotion: -5 },
  [normaliseNameKey('загадочный')]: { warmth: -5, authority: 5, emotion: -5 },
  // …extend as real runs surface more descriptor words.
};
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function fillToneFromAttributes(ch: CharacterOutput): CharacterOutput {
  const derived: Record<Axis, number> = { warmth: 50, pace: 50, authority: 50, emotion: 50 };
  for (const attr of ch.attributes ?? []) {
    const nudge = NUDGES[normaliseNameKey(attr)];
    if (!nudge) continue;
    for (const axis of Object.keys(nudge) as Axis[]) derived[axis] += nudge[axis]!;
  }
  const existing = ch.tone ?? {};
  const tone = {
    warmth: existing.warmth ?? clamp(derived.warmth),
    pace: existing.pace ?? clamp(derived.pace),
    authority: existing.authority ?? clamp(derived.authority),
    emotion: existing.emotion ?? clamp(derived.emotion),
  };
  return { ...ch, tone };
}
```

- [ ] **Step 4: Run to verify pass.** `cd server && npx vitest run src/analyzer/fill-tone.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/src/analyzer/fill-tone.ts server/src/analyzer/fill-tone.test.ts
git commit -m "feat(server): fillToneFromAttributes deterministic tone backstop"
```

---

### Task 6: Required-tone analyzer grammar schemas

**Files:**
- Modify: `server/src/handoff/schemas.ts`
- Test: `server/src/handoff/schemas.test.ts`

**Interfaces:**
- Produces: `requiredToneSchema` (warmth/pace/authority/emotion all required ints 0–100); `analyzerCharacterSchema` (= `characterSchema` with `tone: requiredToneSchema`); `stage1ChapterGrammarSchema` / `stage1GrammarSchema` (wrappers embedding `analyzerCharacterSchema`, mirroring the existing `stage1ChapterSchema`/`stage1Schema`). The existing `characterSchema`/`stage1ChapterSchema`/`stage1Schema` stay unchanged (validation).

- [ ] **Step 1: Write the failing test**

```ts
// schemas.test.ts
import { stage1ChapterGrammarSchema, stage1ChapterSchema } from './schemas.js';
import { z } from 'zod';

describe('analyzer grammar schema requires tone', () => {
  it('grammar JSON-schema marks tone (and axes) required on a character', () => {
    const json = z.toJSONSchema(stage1ChapterGrammarSchema, { target: 'draft-07', reused: 'inline' });
    const charSchema = JSON.stringify(json);
    // tone required on the character object, axes required on tone:
    expect(charSchema).toContain('"required"');
    // structural assertion: a character missing tone fails the GRAMMAR schema...
    const charGrammar = stage1ChapterGrammarSchema; // walk to .characters element in the real test via parse
  });

  it('validation schema still accepts a character with NO tone', () => {
    const ok = stage1ChapterSchema.safeParse({
      characters: [{ id: 'a', name: 'A', role: 'r', color: 'c' }],
      sentences: [],
    });
    expect(ok.success).toBe(true);
  });
});
```

> The grammar-required assertion is best made against `analyzerCharacterSchema.safeParse({...without tone...})` returning `success:false`, and `characterSchema.safeParse(sameInput)` returning `success:true`. Write both — they are the load-bearing contrast.

- [ ] **Step 2: Run to verify fail.** `cd server && npx vitest run src/handoff/schemas.test.ts -t "grammar"` → FAIL (exports missing).

- [ ] **Step 3: Implement** in `schemas.ts` — add beside the existing definitions (do NOT change `toneSchema`/`characterSchema`/`stage1ChapterSchema`/`stage1Schema`):

```ts
export const requiredToneSchema = z
  .object({
    warmth: z.number().int().min(0).max(100),
    pace: z.number().int().min(0).max(100),
    authority: z.number().int().min(0).max(100),
    emotion: z.number().int().min(0).max(100),
  })
  .strict();

/** Character schema for the analyzer GRAMMAR only — tone required so constrained
    decoding nudges the model to emit it. Never used for validation (that stays
    characterSchema, tone optional). */
export const analyzerCharacterSchema = characterSchema.extend({ tone: requiredToneSchema });

// Mirror the existing wrappers but embed the required-tone character schema.
// (Match the exact field shape of stage1ChapterSchema / stage1Schema — read them
//  at schemas.ts:~101/~113 and reproduce, swapping characterSchema → analyzerCharacterSchema.)
export const stage1ChapterGrammarSchema = z.object({
  characters: z.array(analyzerCharacterSchema),
  sentences: stage1ChapterSchema.shape.sentences, // reuse the existing sentence sub-schema
}).strict();

export const stage1GrammarSchema = z.object({
  characters: z.array(analyzerCharacterSchema),
  // reproduce stage1Schema's other top-level fields verbatim:
  ...{},
}).strict();
```

> Implementer: open `schemas.ts:~101/~113`, copy the exact `stage1ChapterSchema`/`stage1Schema` object shapes, and produce the grammar variants by substituting `analyzerCharacterSchema` for `characterSchema`. Reuse sub-schemas via `.shape` to stay DRY rather than re-declaring sentence/field schemas.

- [ ] **Step 4: Run to verify pass.** `cd server && npx vitest run src/handoff/schemas.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/src/handoff/schemas.ts server/src/handoff/schemas.test.ts
git commit -m "feat(server): required-tone analyzer grammar schemas (validation unchanged)"
```

---

### Task 7: Two-schema `runStage`

**Files:**
- Modify: `server/src/analyzer/ollama.ts`, `server/src/analyzer/gemini.ts`
- Test: `server/src/analyzer/ollama.test.ts` (+ a gemini test in the slow tier)

**Interfaces:**
- Produces: `runStage<T>(manuscriptId, key, skillName, promptMd, grammarSchema: z.ZodType<unknown>, validationSchema: z.ZodType<T>, call)` — `z.toJSONSchema(grammarSchema)` drives the grammar; `parseAndValidate(text, validationSchema)` validates. `runStage1Chapter`/`runStage1` pass `stage1ChapterGrammarSchema`/`stage1GrammarSchema` as grammar and the existing `stage1ChapterSchema`/`stage1Schema` as validation. `runStage2Chapter`/`runEmotionChapter` pass their one schema for both.

- [ ] **Step 1: Write the failing test**

```ts
// ollama.test.ts — add
it('a stage-1 response with NO tone passes validation (non-fatal), grammar still required-tone', async () => {
  // Arrange a fake chat returning a character without tone; assert parseAndValidate succeeds
  // and that the grammar passed to chat() was derived from the required-tone schema.
  // (Use the existing ollama test harness/mock for chat.)
});
```

> Use the existing `ollama.test.ts` mocking style (it already stubs the HTTP `chat`). Assert: (a) the `response_format`/grammar argument equals `z.toJSONSchema(stage1ChapterGrammarSchema, …)`, and (b) the returned parsed object validates and has no `tone` → no throw, no retry.

- [ ] **Step 2: Run to verify fail.** `cd server && npx vitest run src/analyzer/ollama.test.ts -t "non-fatal"` → FAIL.

- [ ] **Step 3: Implement.** In `ollama.ts` change the private `runStage` signature (`~294`) to accept `grammarSchema` + `validationSchema`; feed `z.toJSONSchema(grammarSchema, …)` at `~319` and `parseAndValidate(text, validationSchema)` at `~338` and in the retry path. Update the 4 callers:

```ts
// runStage1Chapter:
return this.runStage(manuscriptId, key, 'per_chapter_stage1', promptMd,
  stage1ChapterGrammarSchema, stage1ChapterSchema, call);
// runStage1: stage1GrammarSchema, stage1Schema
// runStage2Chapter: per_chapter_stage2 schema for BOTH params
// runEmotionChapter: emotionAnnotationSchema for BOTH params
```

Do the identical signature change in `gemini.ts` `runStage` (`~259`); it sends no grammar, so it only uses `validationSchema` for `parseAndValidate` — pass `grammarSchema` through but ignore it (or use it if/when Gemini gains response-schema support). Keep `T` derived from `validationSchema`.

- [ ] **Step 4: Run to verify pass.** `cd server && npx vitest run src/analyzer/ollama.test.ts` and `npm run test:server-slow` (covers gemini). Expected: PASS; existing stage-2/emotion tests unaffected.

- [ ] **Step 5: Commit.**

```bash
git add server/src/analyzer/ollama.ts server/src/analyzer/gemini.ts server/src/analyzer/ollama.test.ts
git commit -m "feat(server): two-schema runStage — grammar requires tone, validation tolerant"
```

---

### Task 8: Voiced-collision-safe rewrite of `priorCastForMerge`

**Files:**
- Modify: `server/src/store/merge-analysis-cast.ts`
- Test: `server/src/store/merge-analysis-cast.test.ts`

**Interfaces:**
- Produces: `applyRewriteToPriorCast(priorCast, rewrites) → { priorCast: typeof priorCast; droppedVoices: Array<{ id: string; voiceState?: string }> }` — remaps each prior row's `id` through `rewrites`; when two voiced rows collide on one canonical id, keep the one with the strongest `voiceState` (`locked` > `tuned` > `reused` > `generated`), tie → more lines if available else first; return the dropped ones for logging. Call this BEFORE `mergeAnalysisResultWithExistingCast`.

- [ ] **Step 1: Write the failing test**

```ts
// merge-analysis-cast.test.ts — add
import { applyRewriteToPriorCast } from './merge-analysis-cast.js';

it('remaps prior ids and keeps the strongest voiceState on collision', () => {
  const prior = [
    { id: 'olga', name: 'Ольга', voiceState: 'generated', overrideTtsVoices: { qwen: { name: 'qwen-gen' } } },
    { id: 'ольга', name: 'Ольга', voiceState: 'tuned', overrideTtsVoices: { qwen: { name: 'qwen-tuned' } } },
  ];
  const { priorCast, droppedVoices } = applyRewriteToPriorCast(prior, { olga: 'ольга' });
  const survivor = priorCast.find((c) => c.id === 'ольга');
  expect(survivor?.overrideTtsVoices?.qwen?.name).toBe('qwen-tuned'); // tuned beats generated
  expect(priorCast.filter((c) => c.id === 'ольга')).toHaveLength(1); // no duplicate id
  expect(droppedVoices).toEqual([{ id: 'olga', voiceState: 'generated' }]);
});
```

- [ ] **Step 2: Run to verify fail.** `cd server && npx vitest run src/store/merge-analysis-cast.test.ts -t "collision"` → FAIL.

- [ ] **Step 3: Implement** `applyRewriteToPriorCast` in `merge-analysis-cast.ts` (rank by `VOICE_STATE_RANK = { locked:3, tuned:2, reused:1, generated:0 }`, undefined → -1; collapse by canonical id; collect drops). Then in `analysis.ts` (Task 10) call it on `priorCastForMerge` with the cumulative dedup rewrite before the existing `mergeAnalysisResultWithExistingCast`, and feed `droppedVoices` to the change-log writer (`logCarriedForwardCharacters` pattern, `analysis.ts:148`).

- [ ] **Step 4: Run to verify pass.** `cd server && npx vitest run src/store/merge-analysis-cast.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/src/store/merge-analysis-cast.ts server/src/store/merge-analysis-cast.test.ts
git commit -m "feat(server): collision-safe prior-cast id remap for dedup voice carry-forward"
```

---

### Task 9: Suggestions sibling file — path + IO + fresh clear

**Files:**
- Modify: `server/src/workspace/paths.ts` (add `castMergeSuggestionsJsonPath`)
- Create: `server/src/store/cast-merge-suggestions.ts` (load/write/clear)
- Test: `server/src/store/cast-merge-suggestions.test.ts`

**Interfaces:**
- Produces: `castMergeSuggestionsJsonPath(bookDir)`; `loadSuggestions(bookDir) → Promise<{ suggestions: MergeSuggestion[] }>`; `writeSuggestions(bookDir, suggestions)`; `clearSuggestions(bookDir)`; `dismissSuggestion(bookDir, sourceId, targetId)`.

- [ ] **Step 1–5:** Mirror `store/cast-merges.ts`'s atomic-write + empty-on-missing pattern. Test: write→load round-trip, `clearSuggestions` removes the file, `dismissSuggestion` drops the matching pair. Commit `feat(server): cast-merge-suggestions sibling-file store`.

> In Task 10, call `clearSuggestions(bookDir)` at the `fresh:true` reset (`analysis.ts:2309`, beside `clearCastMerges`) and `writeSuggestions(bookDir, dedup.suggestions)` (overwrite) at finalization.

---

### Task 10: Wire dedup + tone-fill + journal at the finalization sites

**Files:**
- Modify: `server/src/routes/analysis.ts` (both finalization sites: `~3923` and `~4895`)
- Test: `server/src/routes/analysis.test.ts` (integration over a synthetic two-chapter roster with drifted ids)

**Interfaces:**
- Consumes: `dedupeRosterByName` (4), `fillToneFromAttributes` (5), `buildDedupJournalEntries`/`replaceDedupEntries` (1), `applyRewriteToPriorCast` (8), `writeSuggestions`/`clearSuggestions` (9).

- [ ] **Step 1: Write the failing integration test** — feed a roster `[{id:'olga',name:'Ольга'},{id:'ольга',name:'Ольга'}]` + sentences attributed to both through the finalization path; assert the persisted cast has ONE `Ольга`, sentences all point to the canonical id, every character has a populated `tone`, and a `cast-merges.json` `kind:'dedup'` entry exists.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement the finalization sequence** at BOTH sites, in this order (per the spec):

```ts
// 1. dedup BEFORE fold
const dd = dedupeRosterByName(stage1.characters, recovered.sentences, { language: bookLanguage });
// 2. apply dedup rewrites to sentences
recovered.sentences = recovered.sentences.map((s) =>
  dd.rewrites[s.characterId] ? { ...s, characterId: dd.rewrites[s.characterId] } : s);
// 3. journal the dedup merges against PRE-DEDUP sentences/roster (capture them before step 2!)
const dedupEntries = buildDedupJournalEntries(dd.rewrites, preDedupSentences, stage1.characters, ts);
// 4. fold runs on the deduped roster + rewritten sentences (existing call, now fed dd.characters)
const folded = foldMinorCast(dd.characters, recovered.sentences, { /* existing opts */, language: bookLanguage });
// 5. tone fill on the folded survivors
folded.characters = folded.characters.map(fillToneFromAttributes);
// 6. cumulative transitive rewrite for the voice carry-forward + journal
const cumulative = composeRewrites(dd.rewrites, folded.rewrites); // helper: olga→ольга→unknown-female
const prior = applyRewriteToPriorCast(priorCastForMerge, cumulative);
// …feed prior.priorCast into mergeAnalysisResultWithExistingCast; log prior.droppedVoices
// 7. persist journal: replaceDedupEntries(file, dedupEntries) alongside the existing writeFoldJournal
// 8. writeSuggestions(bookDir, dd.suggestions)
```

Capture `preDedupSentences = recovered.sentences.map(s => ({ id: s.id, chapterId: s.chapterId, characterId: s.characterId }))` BEFORE step 2. Add a small `composeRewrites(a, b)` pure helper (transitive closure) — colocate it in `roster-dedup.ts` and unit-test it in Task 4. Mirror the exact change at the second site (`~4895`).

- [ ] **Step 4: Run → PASS.** Run `cd server && npx vitest run src/routes/analysis.test.ts` and `npm run test:server-slow`.

- [ ] **Step 5: Commit** `feat(server): wire dedup + tone-fill + dedup journal at analysis finalization`.

---

### Task 11: Suggestions routes + OpenAPI

**Files:**
- Create: `server/src/routes/cast-merge-suggestions.ts` (GET list, POST accept → delegates to existing merge route logic + `dismissSuggestion`, POST dismiss)
- Modify: `openapi.yaml` (+ run `npm run openapi:types`), register the router where other cast routes mount
- Test: `server/src/routes/cast-merge-suggestions.test.ts`

- [ ] **Steps:** TDD each route (list returns the sibling-file contents; accept calls the merge with `target=canonical`, then drops the suggestion; dismiss drops it). Reuse the merge implementation from `cast-merge.ts` (extract its core if needed so the accept route doesn't duplicate). Commit `feat(server): cast-merge-suggestions routes (list/accept/dismiss)`.

---

### Task 12: Frontend suggestion card + e2e

**Files:**
- Modify: cast-review UI (the cast view / `src/components/listen/...` is the listen view — the cast roster lives in `src/views/cast.tsx`; confirm the cast-review surface), redux slice for cast, `src/lib/api.ts` (mock + real)
- Create: `e2e/<cast-merge-suggestions>.spec.ts`
- Test: component test (Vitest + RTL) + Playwright e2e

- [ ] **Steps:** fetch suggestions on cast-review mount (keyed to analysis-complete); render a dismissable card per suggestion (`Merge` → accept route, `Dismiss` → dismiss route); ≥44px touch targets; design tokens only. Component test asserts render + button wiring; e2e asserts a seeded suggestion renders, Merge applies, Dismiss removes. Commit `feat(frontend): diminutive merge-suggestion cards in cast review`.

---

## Self-review (completed during authoring)

- **Spec coverage:** Tier-1 (T4), Tier-2a (T4), Tier-2b suggestions (T4 + sibling file T9 + routes T11 + UI T12); narrator id-only guard + computed-canonical guard (T4); gender gate incl. Tier-1 (T4); voiced-collision policy + change-log (T8 + T10); journal `kind:'dedup'` + idempotent replace + reversibility (T1); transitive closure (T4 `composeRewrites` + T10); two-schema tone grammar/validation (T6+T7); `fillToneFromAttributes` (T5); fresh-run clear (T9+T10); live-preview caveat (no task — accepted as-is per spec). All covered.
- **Type consistency:** `MergeSuggestion`, `dedupeRosterByName`, `mergeCharacterFields`, `diminutiveCanonical`, `fillToneFromAttributes`, `applyRewriteToPriorCast`, `replaceDedupEntries`/`buildDedupJournalEntries`, `composeRewrites` — names used identically across tasks.
- **Open implementer note:** Tasks 6/7 require copying the exact existing `stage1ChapterSchema`/`stage1Schema` shapes and the exact `ollama.ts`/`gemini.ts` `runStage` call sites — these are flagged inline; the implementer reads those lines and reproduces faithfully.

## Repair of the existing book (post-merge)

Re-analyse *Ночной дозор* on the fixed pipeline. It has no designed voices yet, so the voiced-collision path (T8) is exercised only by tests here. Note (spec caveat): re-analysis discards the user's manual tone tuning — `tone` is not a preserved field; that pre-existing behaviour is out of scope.
