# Tier-3 Alias Coreference Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge a character detected under multiple display names (`шеф` = `Борис Игнатьевич` = `Гесер`) into one cast row when the analyzer's own alias evidence is strong, and surface weaker distinctive overlaps as cast-page merge suggestions.

**Architecture:** A new **Tier-3 pass** inside `dedupeRosterByName` (`server/src/analyzer/roster-dedup.ts`), running after Tier-2a and before the transitive-rewrite collapse. It builds a union-find over **strong** alias edges (mutual, or one-directional via a multi-token name), merges each connected component into a real-name-preferring survivor, then emits **weak** suggestions for one-sided bare-word links and shared third-party aliases that are on exactly two rows. No schema, prompt, API, or function-signature change — suggestions ride the existing `MergeSuggestion` → cast-page pipeline unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (node env), existing helpers `normaliseNameKey`/`safeId` (`server/src/util/safe-id.ts`), `mergeCharacterFields` (`server/src/analyzer/roster-merge-fields.ts`).

## Global Constraints

- **Reuse existing module-scope helpers** in `roster-dedup.ts`: `tokens(name)` (whitespace-split → per-token `normaliseNameKey`), `gendersConflict(a,b)`, `NARRATOR_ID`, `mergeCharacterFields`, `lineCounts`/`lines`. Do not reimplement them.
- **Token counting MUST use `tokens(name).length`, never `normaliseNameKey(wholeName)`** — `normaliseNameKey` strips whitespace (`normaliseNameKey('Борис Игнатьевич') === 'борисигнатьевич'`, a single token). Alias *membership* comparisons DO use `normaliseNameKey` on the whole string (both sides).
- **No signature change** to `dedupeRosterByName(characters, sentences, { language })` and no change to its return contract `{ characters, rewrites, suggestions }`. Both `analysis.ts` call sites (`:4264`, `:5360`) stay untouched.
- **Hard ordering invariant (already satisfied, must not regress):** Tier-3 runs *before* `foldMinorCast` (call order in `analysis.ts`: `dedupAndPrepare` at `:4264`, then `foldMinorCast` at `:4305`). Never move Tier-3 after the fold — the fold rolls folded names into the `Unknown male/female` bucket aliases, which would become strong-edge magnets.
- **`notLinkedTo` is NOT consulted** (it is cross-book only and absent on the fresh dedup roster — see spec Guards).
- **Gender gate is PER EDGE (pair-level), not per component.** A cross-gender candidate link is dropped so a same-gender merge elsewhere in the same component still proceeds — matches the spec's "two rows … produce neither a merge nor a suggestion" wording. Never skip a whole component because one cross-gender edge exists (that silently blocks valid merges).
- **Weak-suggestion alias evidence is the PRE-MERGE snapshot** (`t3aliases`, built before any strong merge), so a suggestion reflects the model's annotation, not aliases a strong merge accumulated onto a survivor.
- **Test dependency (verified against the current table):** the exact-array `toEqual` suggestion assertions assume Tier-2b emits nothing for the chosen names. That holds today — `шеф/Анна/Рекс/Пёс/Алекс/Боб/Карл/Мэри` are absent from `ru-diminutives.ts`, and `Мария/Борис` only ever pair with a non-table name (so `!db` short-circuits). If a future table entry breaks this, relax the affected assertion to `length` + `objectContaining`, don't weaken the code.
- **Never merge or remap onto `narrator`** — exclude `NARRATOR_ID` from all Tier-3 candidate sets.
- **RTK/Immer & style:** match the surrounding file — inline tiers, module-scope pure helpers, `const`-first, no new deps.
- **TDD, frequent commits.** Commit type `fix(server)` / `test(server)` (scope `server`); this fixes the duplicate-roster bug #1662.

---

## File Structure

- **Modify:** `server/src/analyzer/roster-dedup.ts` — insert the Tier-3 strong-merge block (Task 1) and weak-suggestion block (Task 2) between Tier-2a's roster filter and the transitive-collapse loop; move the `suggestions` array declaration up so Tier-3 and Tier-2b share it.
- **Modify (tests):** `server/src/analyzer/roster-dedup.test.ts` — add a `Tier-3 (alias coreference — strong merge)` describe (Task 1) and a `Tier-3 (alias coreference — weak suggestions)` describe (Task 2).
- **Modify (docs, Task 3):** `docs/release-notes-next.md`, `RELEASE_NOTES.md`, and a one-line comment-accuracy fix in `src/views/cast.tsx`.

**Reference (read-only, do not modify):** `server/src/util/safe-id.ts` (`normaliseNameKey`), `server/src/analyzer/roster-merge-fields.ts` (`mergeCharacterFields` — already unions names+aliases, longest description, deduped evidence, tone, gender, ageRange).

**Deliberately out of scope (no task):** a new cast-view test. The cast page renders suggestions generically (`src/views/cast.tsx:926` maps any `MergeSuggestion[]` through `MergeSuggestionCard`, fed by `api.listMergeSuggestions`). A Tier-3 suggestion is byte-identical in shape to a Tier-2b one, already covered by `src/components/merge-suggestion-card.test.tsx`. A Tier-3-specific view test would re-prove the unchanged generic pipeline, not Tier-3 behavior. Tier-3's own logic is fully covered by the server tests below.

---

## Task 1: Tier-3 strong auto-merge (union-find + real-name survivor)

**Files:**
- Modify: `server/src/analyzer/roster-dedup.ts` (insert after the Tier-2a filter `roster = roster.filter((ch) => !droppedT2.has(ch.id));`, before the `// Collapse rewrites transitively` loop; and hoist the `suggestions` declaration)
- Test: `server/src/analyzer/roster-dedup.test.ts`

**Interfaces:**
- Consumes: existing module state inside `dedupeRosterByName` — `roster` (post-Tier-2a `CharacterOutput[]`), `rewrites` (`Record<string,string>`), `lines` (`Map<string,number>` from `lineCounts`), and module-scope `tokens`, `mergeCharacterFields`, `normaliseNameKey`, `NARRATOR_ID`.
- Produces: strong-merge `rewrites[victim.id] = survivor.id`; a reduced `roster`; and a hoisted `const suggestions: MergeSuggestion[]` (empty after this task — populated in Task 2). Return contract unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/analyzer/roster-dedup.test.ts` (the `c()` and `sent()` helpers already exist at the top of the file):

```ts
describe('dedupeRosterByName Tier-3 (alias coreference — strong merge)', () => {
  it('collapses шеф ↔ Борис Игнатьевич ↔ Гесер (mutual links) to one row, real name survives', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['Гесер', 'шеф'] }),
      c({ id: 'geser', name: 'Гесер', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    // шеф has the MOST lines, yet the multi-token real name must win the survivor.
    const r = dedupeRosterByName(chars as any, [...sent('boss', 100), ...sent('boris', 10), ...sent('geser', 5)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('boris');
    expect(r.characters[0].name).toBe('Борис Игнатьевич');
    expect(r.characters[0].aliases).toEqual(expect.arrayContaining(['шеф', 'Гесер']));
    expect(r.rewrites).toEqual({ boss: 'boris', geser: 'boris' });
    expect(r.suggestions).toEqual([]);
  });

  it('prefers the real name over a higher-line role word in a 2-way merge', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss', 80), ...sent('boris', 2)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('boris');
  });

  it('auto-merges a one-sided MULTI-token name link (directional)', () => {
    const chars = [
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male' }), // no aliases
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boris', 5), ...sent('boss', 5)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('boris');
    expect(r.rewrites).toEqual({ boss: 'boris' });
  });

  it('does NOT auto-merge a one-sided SINGLE-token (bare-word) link', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male' }), // no alias back
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss', 3), ...sent('boris', 30)]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
  });

  it('auto-merges a MUTUAL single-token link (tokens tie → more lines wins survivor)', () => {
    const chars = [
      c({ id: 'rex', name: 'Рекс', gender: 'male', aliases: ['Пёс'] }),
      c({ id: 'pyos', name: 'Пёс', gender: 'male', aliases: ['Рекс'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('rex', 20), ...sent('pyos', 3)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('rex');
    expect(r.rewrites).toEqual({ pyos: 'rex' });
  });

  it('collapses a component linked only transitively (A↔B, B↔C, no direct A↔C)', () => {
    const chars = [
      c({ id: 'a', name: 'Алекс', gender: 'male', aliases: ['Боб'] }),
      c({ id: 'b', name: 'Боб', gender: 'male', aliases: ['Алекс', 'Карл'] }),
      c({ id: 'k', name: 'Карл', gender: 'male', aliases: ['Боб'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('a', 5), ...sent('b', 40), ...sent('k', 5)]);
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].id).toBe('b');
    expect(r.rewrites).toEqual({ a: 'b', k: 'b' });
  });

  it('picks the same survivor regardless of roster order (stable survivor)', () => {
    const mk = () => [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['Гесер', 'шеф'] }),
      c({ id: 'geser', name: 'Гесер', gender: 'male', aliases: ['Борис Игнатьевич'] }),
    ];
    const lines = [...sent('boss', 100), ...sent('boris', 10), ...sent('geser', 5)];
    const fwd = dedupeRosterByName(mk() as any, lines);
    const rev = dedupeRosterByName([...mk()].reverse() as any, lines);
    expect(fwd.characters[0].id).toBe('boris');
    expect(rev.characters[0].id).toBe('boris');
  });

  it('does NOT merge a cross-gender pair even with a mutual link', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male', aliases: ['Борис Игнатьевич'] }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'female', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss'), ...sent('boris')]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
  });

  it('pair-level gate: merges the same-gender pair, leaves the cross-gender member separate', () => {
    const chars = [
      c({ id: 'a', name: 'Алекс', gender: 'male', aliases: ['Боб'] }),
      c({ id: 'b', name: 'Боб', gender: 'male', aliases: ['Алекс', 'Мэри'] }),
      c({ id: 'm', name: 'Мэри', gender: 'female', aliases: ['Боб'] }),
    ];
    // a↔b (both male) is a mutual strong edge → merge. b↔m is gender-blocked, so
    // one bad cross-gender edge must NOT suppress the valid a↔b merge.
    const r = dedupeRosterByName(chars as any, [...sent('a', 5), ...sent('b', 40), ...sent('m', 5)]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({ a: 'b' });
    expect(r.characters.map((ch) => ch.id).sort()).toEqual(['b', 'm']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/analyzer/roster-dedup.test.ts -t "Tier-3 (alias coreference — strong merge)"`
Expected: FAIL — e.g. `expected length 2 to be 1` (no merge happens yet) and the `suggestions` assertion may pass trivially.

- [ ] **Step 3: Hoist the `suggestions` declaration**

In `server/src/analyzer/roster-dedup.ts`, find the Tier-2b section and **delete** its local declaration:

```ts
  // ── Tier-2b: diminutive → suggestion only ────────────────────────────────
  const suggestions: MergeSuggestion[] = [];   // <-- DELETE this line
  for (let i = 0; i < roster.length; i++) {
```

leaving:

```ts
  // ── Tier-2b: diminutive → suggestion only ────────────────────────────────
  for (let i = 0; i < roster.length; i++) {
```

- [ ] **Step 4: Insert the Tier-3 strong-merge block**

In `server/src/analyzer/roster-dedup.ts`, immediately AFTER the Tier-2a filter line:

```ts
  roster = roster.filter((ch) => !droppedT2.has(ch.id));
```

and BEFORE the `// Collapse rewrites transitively` comment, insert:

```ts
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
    // NOTE: no component-level gender check — the per-edge gate above already
    // prevents a cross-gender pair from ever landing in the same component.
    // Survivor = most name tokens (prefer real name), then most lines, then
    // earliest roster order — deterministic regardless of union order.
    // (Secondary line-count tiebreak can undercount a Tier-2a survivor whose
    // victim's sentences aren't rewritten until dedupAndPrepare; only bites on a
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

```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/roster-dedup.test.ts -t "Tier-3 (alias coreference — strong merge)"`
Expected: PASS (all 8 cases).

- [ ] **Step 6: Run the whole file for no regression**

Run: `cd server && npx vitest run src/analyzer/roster-dedup.test.ts`
Expected: PASS — the existing Tier-1 / Tier-2a / Tier-2b / prune / compose suites stay green.

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/roster-dedup.ts server/src/analyzer/roster-dedup.test.ts
git commit -m "fix(server): Tier-3 strong alias-coreference auto-merge (#1662)"
```

---

## Task 2: Tier-3 weak suggestions (distinctive-only, exactly two rows)

**Files:**
- Modify: `server/src/analyzer/roster-dedup.ts` (insert immediately after `roster = roster.filter((ch) => !droppedT3.has(ch.id));` from Task 1)
- Test: `server/src/analyzer/roster-dedup.test.ts`

**Interfaces:**
- Consumes: the hoisted `suggestions` array, the reduced `roster`, and the Task-1 bindings `nameKeyOf` and `t3aliases` (the pre-merge alias snapshot), plus module-scope `gendersConflict`, `lines`, `NARRATOR_ID`, `normaliseNameKey`.
- Produces: appends `MergeSuggestion` entries (`{ sourceId, targetId, reason }`) to `suggestions` for one-sided single-token name links and shared third-party aliases that appear on exactly two surviving rows. Tier-2b continues appending to the same array afterward.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/analyzer/roster-dedup.test.ts`:

```ts
describe('dedupeRosterByName Tier-3 (alias coreference — weak suggestions)', () => {
  it('suggests (does not merge) a one-sided bare-word link on exactly two rows', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss', 3), ...sent('boris', 30)]);
    expect(r.characters).toHaveLength(2);
    expect(r.rewrites).toEqual({});
    expect(r.suggestions).toEqual([
      { sourceId: 'boss', targetId: 'boris', reason: expect.any(String) },
    ]);
  });

  it('emits NO suggestion when the bare word is on three or more rows', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'male' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
      c({ id: 'ivan', name: 'Иван', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss'), ...sent('boris'), ...sent('ivan')]);
    expect(r.suggestions).toEqual([]);
  });

  it('suggests a shared third-party alias on exactly two rows (neither name-linked)', () => {
    const chars = [
      c({ id: 'a', name: 'Анна', gender: 'female', aliases: ['Жница'] }),
      c({ id: 'b', name: 'Мария', gender: 'female', aliases: ['Жница'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('a', 10), ...sent('b', 4)]);
    expect(r.characters).toHaveLength(2);
    expect(r.suggestions).toEqual([
      { sourceId: 'b', targetId: 'a', reason: expect.stringContaining('Жница') },
    ]);
  });

  it('emits NO suggestion when a shared alias is on three or more rows', () => {
    const chars = [
      c({ id: 'a', name: 'Анна', gender: 'female', aliases: ['Жница'] }),
      c({ id: 'b', name: 'Мария', gender: 'female', aliases: ['Жница'] }),
      c({ id: 'd', name: 'Дарья', gender: 'female', aliases: ['Жница'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('a'), ...sent('b'), ...sent('d')]);
    expect(r.suggestions).toEqual([]);
  });

  it('emits NO suggestion across a gender conflict', () => {
    const chars = [
      c({ id: 'boss', name: 'шеф', gender: 'female' }),
      c({ id: 'boris', name: 'Борис Игнатьевич', gender: 'male', aliases: ['шеф'] }),
    ];
    const r = dedupeRosterByName(chars as any, [...sent('boss'), ...sent('boris')]);
    expect(r.suggestions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/analyzer/roster-dedup.test.ts -t "Tier-3 (alias coreference — weak suggestions)"`
Expected: FAIL — the "suggests..." cases expect one suggestion but get `[]` (weak pass not implemented yet).

- [ ] **Step 3: Insert the weak-suggestion block**

In `server/src/analyzer/roster-dedup.ts`, immediately AFTER Task 1's `roster = roster.filter((ch) => !droppedT3.has(ch.id));` and BEFORE the `// Collapse rewrites transitively` loop, insert:

```ts
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
        // One-sided single-token name link (mutual/multi-token already merged).
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

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/roster-dedup.test.ts -t "Tier-3 (alias coreference — weak suggestions)"`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Run the whole file for no regression**

Run: `cd server && npx vitest run src/analyzer/roster-dedup.test.ts`
Expected: PASS — Tier-3 strong + weak + all pre-existing suites green.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/roster-dedup.ts server/src/analyzer/roster-dedup.test.ts
git commit -m "fix(server): Tier-3 distinctive alias-overlap merge suggestions (#1662)"
```

---

## Task 3: Comment accuracy, release notes, full verification

**Files:**
- Modify: `src/views/cast.tsx` (one comment, `:922`)
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

**Interfaces:** none (docs + comment only).

- [ ] **Step 1: Fix the now-stale cast-view comment**

In `src/views/cast.tsx`, the block comment above the suggestions list (currently around `:922`) says the cards are Tier-2b diminutive-only. Replace:

```tsx
        {/* Tier-2b — diminutive merge-suggestion cards. Rendered when the
            dedup pass detected possible name-alias duplicates (e.g. "Оля" vs
            "Ольга"). One card per suggestion; accept folds the source character
            into the target, dismiss hides the card without merging. */}
```

with:

```tsx
        {/* Merge-suggestion cards from the dedup pass — Tier-2b diminutives
            (e.g. "Оля" vs "Ольга") AND Tier-3 distinctive alias overlaps
            (#1662, e.g. a role word shared by two rows). Rendered generically
            off any MergeSuggestion; accept folds the source character into the
            target, dismiss hides the card without merging. */}
```

- [ ] **Step 2: Append the technical release-note**

Append under the current top (in-progress) version block in `docs/release-notes-next.md`:

```markdown
- **fix(server):** the analyzer now merges a character detected under multiple
  display names into one cast row when the model's alias evidence is strong
  (a mutual alias link, or a full-name link), and suggests weaker distinctive
  overlaps on the cast page. Resolves duplicate roster rows / duplicate designed
  voices for principals known by several names (e.g. Russian name + patronymic +
  a separate proper name). (#1662)
```

- [ ] **Step 3: Append the user-facing release-note**

Open `RELEASE_NOTES.md`, find the top-most in-progress version section, and add a brand-voice line under it:

```markdown
- **One character, one voice — even under many names.** A character the book
  calls by several names (a title, a first name, a nickname) no longer splits
  into duplicate cast rows with duplicate voices — Castwright now recognises
  them as one, and offers a one-tap merge when it's unsure.
```

- [ ] **Step 4: Typecheck + full server suite**

Run: `npm run typecheck`
Expected: PASS (no type errors).

Run: `npm run test:server`
Expected: PASS — `roster-dedup.test.ts` is a fast-lane unit test, covered here.

- [ ] **Step 5: Frontend suite (comment-only change, guard against regression)**

Run: `npm test -- src/views/cast.test.tsx src/components/merge-suggestion-card.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/cast.tsx docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(server): release notes + cast-view comment for Tier-3 alias merge (#1662)"
```

---

## Ship (after all tasks)

1. Push the branch and open a PR titled `fix(server): merge same-character-different-name cast rows (Tier-3 alias coreference)` with `Closes #1662` in the body, linking the spec `docs/superpowers/specs/2026-07-16-character-coreference-alias-merge-design.md`.
2. Run `npm run verify:fast:branch` locally.
3. Mandatory `code-review` gate — single-scope `fix` ⇒ **medium** effort (per model-routing). Triage and fold findings before merge.
4. This is a localized change (one source file + tests); per the Before-shipping checklist, the spec + paired tests are the regression record — no separate `docs/features/` plan doc is required. Note that explicitly in the PR body.

---

## Self-Review

**1. Spec coverage:**
- Strong auto-merge via union-find + multi-token/mutual rule → Task 1 (steps 4). ✅
- Single-token mutuality gate (role-word-as-name defense) → Task 1 tests "does NOT auto-merge one-sided bare-word", "auto-merges MUTUAL single-token". ✅
- Survivor prefers real name → Task 1 tests "real name survives", "prefers real name over higher-line role word". ✅
- Transitive component collapse → Task 1 test "linked only transitively". ✅
- Stable survivor regardless of order → Task 1 test "same survivor regardless of roster order". ✅
- Gender gate (per-edge, merge + suggestion) → Task 1 "does NOT merge a cross-gender pair" + "pair-level gate: merges the same-gender pair, leaves the cross-gender member separate" + Task 2 "NO suggestion across a gender conflict". ✅
- Weak distinctive suggestion, exactly-2-rows, 3+ ⇒ none → Task 2 four cases. ✅
- Shared third-party alias branch → Task 2 "shared third-party alias" + its 3-row negative. ✅
- `notLinkedTo` not consulted / no signature change → Global Constraints + no `analysis.ts` edits. ✅
- Tier-3 before `foldMinorCast` invariant → Global Constraints (call order already correct). ✅
- Suggestions on the cast page → generic path unchanged; comment fixed (Task 3 step 1); rationale for no new view test in File Structure. ✅
- Release notes (both files) → Task 3 steps 2–3. ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows full code; every run step shows an exact command + expected result. The one discovery step (Task 3 step 3, "find the top-most in-progress version section") gives concrete content to insert — the heading is environment-specific and must be located at implementation time, not guessed.

**3. Type consistency:** `nameKeyOf`, `aliasKeysOf`, `find`, `union`, `t3nodes`, `t3aliases`, `parent`, `droppedT3`, and the hoisted `suggestions` are defined in Task 1; Task 2 adds `t3survivors`, `rowCountOfKey`, `displayForKey` and reuses `t3aliases`/`nameKeyOf`/`gendersConflict`/`lines` with identical names/signatures. `parent` is initialized with an explicit `[string, string]` tuple annotation so `new Map<string, string>(...)` type-checks. `MergeSuggestion` shape `{ sourceId, targetId, reason }` matches the existing interface in `roster-dedup.ts`. `tokens`, `gendersConflict`, `mergeCharacterFields`, `normaliseNameKey`, `lines`, `NARRATOR_ID` are consumed exactly as they exist in the file. ✅
