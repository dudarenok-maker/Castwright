# Character duplicate-roster fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate duplicate character roster entries — in the live "Cast so far" / interim `cast.json` (Fix 1) and in the final `cast.json` on re-analysis of an already-voiced book (Fix 2).

**Architecture:** Two independent server changes, neither touching the analyzer id-source. Fix 1 runs the existing `dedupeRosterByName` inside the live-preview builder so the preview dedups consistently with the final cast. Fix 2 adds a pure helper that collapses same-normalized-name rows in the prior cast at the two points it is loaded, so carryover stops re-adding voiced duplicates across all five `cast.json` write sites.

**Tech Stack:** TypeScript (Node/Express server), Vitest. Files under `server/src/`.

## Global Constraints

- No change to the analyzer character `id` source (model-emitted id is untouched).
- Merge policy is **gender-only** guarded, matching `dedupeRosterByName` (`roster-dedup.ts:78-79`); do not add a divergent gender algorithm.
- Fix 2 voice precedence must prefer a **bespoke designed voice** over a reuse link (Coalfall voice-strip guard, 2026-07-14).
- Fix 2 must never collapse narrator rows (`id === 'narrator' || id === 'char-narrator'`) or `notLinkedTo`-separated pairs.
- Fix 2 must be applied at **both** `priorCastForMerge` load points (streaming ~`analysis.ts:2567`, subset ~`analysis.ts:4903`).
- Commit message convention (enforced by commit-msg hook): `<type>(<scope>): <subject>`; allowed scopes include `server`; no em-dashes needed. Types: feat|fix|refactor|perf|test|docs|build|ci|chore.
- **Shell:** run all `Run:` commands through the Bash tool (POSIX bash) — they use `&&`, `$(printf ...)`, and forward-slash paths, which are parse errors in this box's default PowerShell 5.1.
- Commit trailers (both lines, every commit):
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Pb5TAwWgGQ3e27ZrSYH6Dj`

## File structure

- `server/src/routes/analysis.ts` — Modify: `previewFoldForLiveView` (Fix 1, ~740-745); two `priorCastForMerge` load sites (Fix 2 wiring, ~2567 & ~4903).
- `server/src/store/merge-analysis-cast.ts` — Create: `dedupePriorCastByName` + private helpers `hasBespokeVoice`, `priorVoiceRank`, `groupHasNotLinkedEdge` (Fix 2 logic). Add import of `normaliseNameKey`.
- `server/src/store/merge-analysis-cast.test.ts` — Test: `dedupePriorCastByName` unit + composition.
- `server/src/routes/analysis.test.ts` — Test: Fix 1 via `buildInterimCast`.
- `RELEASE_NOTES.md` (path via `git ls-files`) — Modify: one user-facing bullet.

---

### Task 1: Fix 1 — dedup the live-view / interim cast

**Files:**
- Modify: `server/src/routes/analysis.ts:740-745` (`previewFoldForLiveView`)
- Test: `server/src/routes/analysis.test.ts`

**Interfaces:**
- Consumes: `dedupeRosterByName(characters, sentences, { language }) => { characters, rewrites, suggestions }` (already imported at `analysis.ts:36`); `buildInterimCast(chapterCast, chapterOrder, language?, author?) => CharacterOutput[]` (exported, calls `previewFoldForLiveView`).
- Produces: no new exports; behavior change only.

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/analysis.test.ts` (inside the existing `describe` that already tests `buildInterimCast`; `buildInterimCast` is imported at line 15):

```ts
it('dedups same-name characters with divergent model ids in the interim cast (Fix 1)', () => {
  const chapterCast: Record<number, CharacterOutput[]> = {
    1: [{ id: 'anton', name: 'Антон', role: 'op', color: 'c' }],
    2: [{ id: 'антон', name: 'Антон', role: 'op', color: 'c' }],
  };
  const cast = buildInterimCast(chapterCast, [1, 2]);
  expect(cast.filter((c) => c.name === 'Антон')).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "divergent model ids in the interim cast"`
Expected: FAIL — receives 2 `Антон` entries (id-keyed merge keeps `anton` and `антон` separate).

- [ ] **Step 3: Write minimal implementation**

Replace `previewFoldForLiveView` (`server/src/routes/analysis.ts:740-745`):

```ts
function previewFoldForLiveView(
  characters: CharacterOutput[],
  language?: string,
): CharacterOutput[] {
  // Fix 1 — dedup by name BEFORE the fold (mirroring finalization order at
  // dedupAndPrepare) so the live "Cast so far" SSE and the interim cast.json
  // dedup consistently with the final cast. Empty sentences: Tier-1 is
  // name/gender-only; Tier-2a survivor degrades to deterministic snapshot order.
  const deduped = dedupeRosterByName(characters, [], { language }).characters;
  return foldMinorCast(deduped, [], { nameOnly: true, language }).characters;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t "divergent model ids in the interim cast"`
Expected: PASS. Also run the whole file to catch regressions:
Run: `cd server && npx vitest run src/routes/analysis.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "$(printf 'fix(server): dedup live-view/interim cast so it matches the final cast\n\nRun dedupeRosterByName in previewFoldForLiveView so the live Cast so far SSE\nand interim cast.json collapse same-name/different-model-id entries the same\nway the final cast does.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Pb5TAwWgGQ3e27ZrSYH6Dj')"
```

---

### Task 2: Fix 2 logic — `dedupePriorCastByName` helper

**Files:**
- Modify: `server/src/store/merge-analysis-cast.ts` (add helper + import)
- Test: `server/src/store/merge-analysis-cast.test.ts`

**Interfaces:**
- Consumes: existing in-file `isVoicedOrReused(c)`, `unionAliases(a, b)`; new import `normaliseNameKey` from `../util/safe-id.js`.
- Produces: `export function dedupePriorCastByName<T extends CastRecord>(priorCast: ReadonlyArray<T>): { cast: T[]; dropped: Array<{ id: string; name?: string; voiceState?: string }> }` — collapses same-`normaliseNameKey(name)` rows to one survivor (bespoke-voice-preferred), narrator + `notLinkedTo`-guarded, aliases unioned; returns collapsed cast + dropped-row log. Input not mutated.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/store/merge-analysis-cast.test.ts` — extend the import at the top:

```ts
import {
  mergeAnalysisResultWithExistingCast,
  seedReuseGuardsFromPriorCast,
  voicedSurvivorsDropped,
  applyRewriteToPriorCast,
  dropReuseContinuityKeepDesignedVoice,
  dedupePriorCastByName,
} from './merge-analysis-cast.js';
```

Add a new describe block:

```ts
describe('dedupePriorCastByName', () => {
  it('collapses two same-name voiced rows to one survivor', () => {
    const prior: C[] = [
      { id: 'anton', name: 'Антон', voiceState: 'tuned', voiceUuid: 'U1', lines: 40 },
      { id: 'антон', name: 'Антон', voiceState: 'generated', lines: 2 },
    ];
    const { cast, dropped } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
    expect(cast[0].id).toBe('anton'); // stronger voiceState survives
    expect(cast[0].voiceUuid).toBe('U1');
    expect(dropped.map((d) => d.id)).toEqual(['антон']);
  });

  it('prefers a bespoke designed voice over a reuse link (Coalfall guard)', () => {
    const prior: C[] = [
      { id: 'a-reused', name: 'Света', voiceState: 'reused', voiceId: 'lib-1' },
      { id: 'a-bespoke', name: 'Света', voiceState: 'generated', overrideTtsVoices: { qwen: { name: 'q-sveta' } } },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
    expect(cast[0].id).toBe('a-bespoke'); // bespoke beats reuse despite weaker voiceState
    expect(cast[0].overrideTtsVoices).toEqual({ qwen: { name: 'q-sveta' } });
  });

  it('folds the dropped row name into the survivor aliases', () => {
    const prior: C[] = [
      { id: 'boris', name: 'Борис Игнатьевич', voiceState: 'tuned', lines: 30, aliases: ['шеф'] },
      { id: 'boris-2', name: 'Борис Игнатьевич', voiceState: 'generated', lines: 1, aliases: ['Гесер'] },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
    expect(cast[0].aliases).toEqual(expect.arrayContaining(['шеф', 'Гесер']));
  });

  it('does NOT collapse a notLinkedTo-separated same-name pair', () => {
    const prior: C[] = [
      { id: 'john-a', name: 'John', voiceState: 'tuned', notLinkedTo: [{ bookId: 'b', characterId: 'john-b' }] },
      { id: 'john-b', name: 'John', voiceState: 'tuned' },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(2);
  });

  it('never collapses narrator rows sharing a name', () => {
    const prior: C[] = [
      { id: 'narrator', name: 'Narrator', voiceState: 'tuned' },
      { id: 'char-narrator', name: 'Narrator', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(2);
  });

  it('leaves distinct names untouched and preserves order', () => {
    const prior: C[] = [
      { id: 'a', name: 'Alice', voiceState: 'tuned' },
      { id: 'b', name: 'Bob', voiceState: 'tuned' },
    ];
    const { cast, dropped } = dedupePriorCastByName(prior);
    expect(cast.map((c) => c.id)).toEqual(['a', 'b']);
    expect(dropped).toEqual([]);
  });

  it('collapses accent-variant spellings (normaliseNameKey deburrs Latin)', () => {
    const prior: C[] = [
      { id: 'cafe', name: 'Cafe', voiceState: 'generated', voiceUuid: 'U2' },
      { id: 'café', name: 'Café', voiceState: 'generated' },
    ];
    const { cast } = dedupePriorCastByName(prior);
    expect(cast).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts -t "dedupePriorCastByName"`
Expected: FAIL — `dedupePriorCastByName is not a function` (not yet exported).

- [ ] **Step 3: Write the implementation**

In `server/src/store/merge-analysis-cast.ts`, add the import near the top (next to the existing `normaliseForMatch` import at line 29):

```ts
import { normaliseNameKey } from '../util/safe-id.js';
```

Then make `isVoicedOrReused` recognise `voiceUuid` so the merge's name-fallback + carry-forward gate agrees with the collapse's `hasBespokeVoice` (a `voiceUuid`-only survivor must still bridge its voice onto the fresh row — otherwise a designed voice is silently dropped). Change `merge-analysis-cast.ts:77` from:

```ts
  return Boolean(c.voiceId || c.matchedFrom || c.overrideTtsVoices || c.overrideTtsVoice);
```

to:

```ts
  return Boolean(c.voiceId || c.matchedFrom || c.overrideTtsVoices || c.overrideTtsVoice || c.voiceUuid);
```

Append these functions (place the private helpers above the exported one; `isVoicedOrReused` and `unionAliases` already exist in the file):

```ts
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
    collapsed; the dropped rows' names/aliases fold onto the survivor. Returns a
    new array (original order, survivor at the first member's slot) + a
    dropped-row log for the change-log. Input is not mutated. */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts`
Expected: PASS (new `dedupePriorCastByName` block + all existing tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/store/merge-analysis-cast.ts server/src/store/merge-analysis-cast.test.ts
git commit -m "$(printf 'feat(server): add dedupePriorCastByName for carryover same-name collapse\n\nPure helper collapsing same-normalised-name rows in a prior cast to one\nsurvivor, preferring a bespoke designed voice over a reuse link, guarding\nnarrator and notLinkedTo pairs, and folding dropped names into aliases.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Pb5TAwWgGQ3e27ZrSYH6Dj')"
```

---

### Task 3: Fix 2 wiring — reconcile the prior cast at both load points

**Files:**
- Modify: `server/src/routes/analysis.ts` (streaming ~2567/2585; subset ~4903/4916)
- Test: `server/src/store/merge-analysis-cast.test.ts` (composition test)

**Interfaces:**
- Consumes: `dedupePriorCastByName` (Task 2); `mergeAnalysisResultWithExistingCast` (existing).
- Produces: no new exports; both `priorCastForMerge` values become the collapsed cast before any consumer reads them.

- [ ] **Step 1: Write the contract-lock composition test** (passes once Task 2's helper is committed; it locks the end-to-end behavior Task 3's wiring depends on — not a red-first TDD test)

Add to the `dedupePriorCastByName` describe block in `server/src/store/merge-analysis-cast.test.ts`:

```ts
it('composition: collapsed prior + merge yields no 0-line duplicate, voice on fresh survivor', () => {
  // Prior cast has the legacy duplicate (both voiced); fresh roster has one
  // canonical Антон (post-dedup). Today merge re-adds the extra as a 0-line dup.
  const prior: C[] = [
    { id: 'anton', name: 'Антон', voiceState: 'tuned', voiceUuid: 'U1', lines: 40 },
    { id: 'антон', name: 'Антон', voiceState: 'generated', overrideTtsVoices: { qwen: { name: 'q2' } }, lines: 2 },
  ];
  const fresh: C[] = [{ id: 'антон', name: 'Антон', lines: 55 }]; // fresh survivor id
  const collapsed = dedupePriorCastByName(prior).cast;
  const merged = mergeAnalysisResultWithExistingCast(collapsed, fresh);
  expect(merged.filter((c) => c.name === 'Антон')).toHaveLength(1);
  expect(merged[0].voiceUuid).toBe('U1'); // strongest bespoke voice rode onto the fresh survivor
  expect(merged[0].lines).toBe(55); // fresh attribution wins
});

it('composition: a voiceUuid-only (generated) survivor whose id differs from fresh still bridges its voice', () => {
  // Regression guard: hasBespokeVoice ranks a voiceUuid-only row as bespoke, so
  // it can win the collapse; the merge's name-fallback must recognise voiceUuid
  // (isVoicedOrReused fix) or the fresh row is written voiceless.
  const prior: C[] = [
    { id: 'anton', name: 'Антон', voiceState: 'generated', voiceUuid: 'U9', lines: 40 },
    { id: 'антон-old', name: 'Антон', voiceState: 'reused', voiceId: 'lib-1', lines: 1 },
  ];
  const fresh: C[] = [{ id: 'антон', name: 'Антон', lines: 50 }]; // id differs from both prior rows
  const collapsed = dedupePriorCastByName(prior).cast;
  expect(collapsed[0].id).toBe('anton'); // voiceUuid (rank 3) beats reused (rank 2)
  const merged = mergeAnalysisResultWithExistingCast(collapsed, fresh);
  expect(merged.filter((c) => c.name === 'Антон')).toHaveLength(1);
  expect(merged[0].voiceUuid).toBe('U9'); // bridged despite voiceState generated + id drift
});
```

- [ ] **Step 2: Run to verify it passes at the unit level, then confirm the pre-collapse dup**

Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts -t "composition"`
Expected: PASS (Task 2 helper already collapses; this locks the end-to-end contract). If it fails, the bridge did not fire — inspect `mergeAnalysisResultWithExistingCast`'s name-fallback (`merge-analysis-cast.ts:156-167`).

- [ ] **Step 3: Wire the streaming load point**

In `server/src/routes/analysis.ts`, change the declaration at line 2567 from `const` to `let`:

```ts
    let priorCastForMerge: Array<{ id: string } & Record<string, unknown>> = recordRef.bookDir
```

Then, immediately AFTER the `pruneStaleReuseLinks` block that ends at line 2585, insert:

```ts
    /* Fix 2 — collapse same-name duplicate rows in the prior cast so the
       carryover merge cannot re-add a voiced duplicate. Applied here, at the
       single load point, so all cast.json write sites AND
       seedReuseGuardsFromPriorCast below see one prior row per name. */
    if (priorCastForMerge.length > 1) {
      const reconciled = dedupePriorCastByName(priorCastForMerge);
      priorCastForMerge = reconciled.cast;
      if (reconciled.dropped.length) {
        log(
          1,
          `Collapsed ${reconciled.dropped.length} duplicate prior-cast row(s) by name (${reconciled.dropped
            .map((d) => d.name ?? d.id)
            .join(', ')}).`,
        );
      }
    }
```

Add `dedupePriorCastByName` to the existing `merge-analysis-cast.js` import block (ends at `analysis.ts:111`).

- [ ] **Step 4: Wire the subset load point**

In `server/src/routes/analysis.ts`, change the declaration at line 4903 from `const` to `let`:

```ts
  let priorCastForMerge: Array<{ id: string } & Record<string, unknown>> = record.bookDir
```

Then, immediately AFTER the `pruneStaleReuseLinks` block that ends at line 4916, insert:

```ts
  /* Fix 2 — same-name prior-cast collapse (see streaming path). Applied here so
     the subset re-analysis path's writes (5088/5568) + seed also see one prior
     row per name. */
  if (priorCastForMerge.length > 1) {
    const reconciled = dedupePriorCastByName(priorCastForMerge);
    priorCastForMerge = reconciled.cast;
    if (reconciled.dropped.length) {
      log(
        1,
        `Collapsed ${reconciled.dropped.length} duplicate prior-cast row(s) by name (${reconciled.dropped
          .map((d) => d.name ?? d.id)
          .join(', ')}).`,
      );
    }
  }
```

(The subset handler has its own `const log` at `analysis.ts:4883`, so the same
progress line works here.)

- [ ] **Step 5: Typecheck + run the touched suites**

Run: `cd server && npx tsc --noEmit`
Expected: PASS (no type errors from the `let` change or the new call).
Run: `cd server && npx vitest run src/store/merge-analysis-cast.test.ts src/routes/analysis.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/analysis.ts server/src/store/merge-analysis-cast.test.ts
git commit -m "$(printf 'fix(server): reconcile prior cast at both load points to stop carryover dupes\n\nCollapse same-name prior-cast rows via dedupePriorCastByName at both\npriorCastForMerge load points (streaming + subset) so re-analysis of an\nalready-voiced book no longer re-adds voiced duplicates at any cast.json\nwrite site.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Pb5TAwWgGQ3e27ZrSYH6Dj')"
```

---

### Task 4: Release note + full server suite

**Files:**
- Modify: `RELEASE_NOTES.md` (locate via `git ls-files`)

- [ ] **Step 1: Locate and update the release notes**

Run: `git ls-files | grep -i release_notes`
Open the file; under the newest (top) `# Castwright <version>` section, add one bullet in the existing brand voice, e.g.:

```markdown
- **Cleaner cast, no more doubles.** Character detection no longer shows the same person twice while a book analyses, and re-analysing an already-voiced book stops quietly duplicating voiced characters.
```

If no `RELEASE_NOTES.md` is tracked, skip this step (the PR body carries the summary).

- [ ] **Step 2: Run the full server test suite**

Run (from repo root, NOT inside `server/` — `test:server` is a root script that does `npm --prefix server run test`): `npm run test:server`
Expected: PASS. If a Windows fs-contention flake appears in `script-review`/`generation.test.ts`, re-run with `LOW_CONCURRENCY=1` (known flake).

- [ ] **Step 3: Commit**

```bash
git add RELEASE_NOTES.md
git commit -m "$(printf 'docs(docs): release note for cast duplicate-roster fix\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Pb5TAwWgGQ3e27ZrSYH6Dj')"
```

---

## Self-review notes

- **Spec coverage:** Fix 1 → Task 1; Fix 2 helper (bespoke precedence, notLinkedTo, narrator, aliases) → Task 2; Fix 2 both-load-point wiring + all-5-sites via read-time collapse → Task 3; accented-Latin residual test → Task 2; release note → Task 4. Mechanism 2 is out of scope (issue #1662).
- **Type consistency:** `dedupePriorCastByName` returns `{ cast, dropped }` — used identically in Task 2 tests and Task 3 wiring. `CastRecord = { id: string } & Record<string, unknown>` is the file's existing type.
- **No analyzer id-source change:** confirmed — only preview dedup (Fix 1) and prior-cast collapse (Fix 2).
- **Shared-behavior note (Task 2):** adding `|| c.voiceUuid` to `isVoicedOrReused` also makes a `voiceUuid`-only prior row carry-forward-eligible (previously it wasn't). This is the correct, consistent behavior (a `voiceUuid` is a designed voice), but it is a shared gate — Task 2 Step 4 and the Task 4 full server suite must stay green; if an existing `merge-analysis-cast` test asserted a `voiceUuid`-only row was NOT carried forward, update it intentionally (it was asserting the latent bug).
