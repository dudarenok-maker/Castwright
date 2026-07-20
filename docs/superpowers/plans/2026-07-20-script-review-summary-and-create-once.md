# Script-review summary + create-once speakers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a whole-book script-review run reviewable — a collapsed per-chapter/per-type summary with group-level approve — and create a newly-discovered speaker once instead of once per line.

**Architecture:** Evolve the existing `ScriptReviewDiff` overlay in place. Add pure aggregation (`selectReviewSummary`) + one bulk-tick reducer (`toggleKeys`) + a single-sourced taxonomy (`BULK_APPROVABLE`/`EXPAND_ONLY`) to the slice — no bucket **shape** change. Replace the flat op-class body with a chapter→type accordion whose group-approve controls tick `selected` (Apply stays the one explicit action). Replace the per-op create-character confirm queue with a per-unique-name one, reusing `applyProposedReattributions`'s existing name-dedupe/roster-seed.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (Immer). Vitest + jsdom + React Testing Library (colocated `*.test.ts(x)`). Playwright (chromium) for e2e in mock mode.

## Global Constraints

- **No `scriptReview` slice shape change** — `ScriptReviewBucket` fields stay as-is; only additive selector/reducer/exports.
- **Design tokens only** — no hex literals; use CSS custom properties / Tailwind vars already in `styles.css`.
- **Touch targets** — every new interactive control ≥44×44px on touch: `min-h-[44px] fine-pointer:min-h-0` (icon-only also `min-w-[44px] fine-pointer:min-w-0`), matching the existing controls in this file.
- **Testing discipline** — every task ships paired tests; a bug-shaped change ships a regression test that fails before / passes after.
- **Mock imports only** — components import from `api.*`; never branch on mock vs real.
- **Run commands from** the worktree root `C:\Claude\Projects\Audiobook-Generator\.claude\worktrees\feat+frontend-script-review-summary` (node_modules is junctioned there). Frontend Vitest: `npx vitest run <file>`.
- **Taxonomy is single-sourced** — the mechanical-vs-expand-only split lives in `script-review-slice.ts` exports; the component and selector both consume it; no second copy.

---

## File structure

- **Modify** `src/store/script-review-slice.ts` — export `BULK_APPROVABLE`/`EXPAND_ONLY`; refactor `setReview`'s local `DEFAULT_OFF` to consume `EXPAND_ONLY`; add `selectReviewSummary` selector + its result types; add `toggleKeys` reducer. (Tasks 1–3)
- **Modify** `src/store/script-review-slice.test.ts` — new unit tests. (Tasks 1–3)
- **Modify** `src/lib/apply-proposed.ts` — add pure `consolidateProposedByName`. (Task 4)
- **Modify** `src/lib/apply-proposed.test.ts` — new unit tests. (Task 4)
- **Modify** `src/components/script-review-diff.tsx` — accordion body + group-approve (Tasks 5–6); partial-apply toast (Task 7); per-name confirm queue (Task 8).
- **Modify** `src/components/script-review-diff.test.tsx` — new component tests. (Tasks 5–8)
- **Create** `e2e/script-review-summary.spec.ts` — one browser golden path. (Task 9)
- **Modify** `src/mocks/canned-data.ts` — ensure a multi-chapter review bucket exists for the e2e/mock path. (Task 9)
- **Modify** `docs/release-notes-next.md`, `RELEASE_NOTES.md`; flip the spec `status:`; touch `docs/features/INDEX.md` only if a plan doc is indexed. (Task 10)

**Interfaces produced (referenced across tasks):**

```ts
// script-review-slice.ts
export const BULK_APPROVABLE: ReadonlySet<ReviewOp['op']>;   // merge, strip_tag, split, extract_dialogue, fix_emotion, validate_instruct
export const EXPAND_ONLY: ReadonlySet<ReviewOp['op']>;       // reattribute, flag_nonstory
export interface ReviewTypeGroup { op: ReviewOp['op']; count: number; selectableKeys: string[] }
export interface ReviewChapterSummary { chapterId: number; total: number; selectableKeys: string[]; toReview: number; byType: ReviewTypeGroup[] }
export interface ReviewSummary { totalOps: number; chapters: ReviewChapterSummary[] }
export function selectReviewSummary(bucket: ScriptReviewBucket | undefined): ReviewSummary;
// reducer: toggleKeys({ bookId: string; keys: string[]; value: boolean })

// apply-proposed.ts
export interface ProposedNameGroup { name: string; proposed: { name: string; gender?: string; ageRange?: string }; ops: ReviewOpWithChapter[] }
export function consolidateProposedByName(
  proposed: ReviewOpWithChapter[],
  rosterNames: ReadonlySet<string>,      // normalized (trim+lowercase) names already in the live cast
): { newGroups: ProposedNameGroup[]; rosterMatchedOps: ReviewOpWithChapter[] };
```

---

## Task 1: Single-source the taxonomy (`BULK_APPROVABLE` / `EXPAND_ONLY`)

**Files:**
- Modify: `src/store/script-review-slice.ts` (add exports near `opKey`, line ~31; refactor `setReview` line ~140)
- Test: `src/store/script-review-slice.test.ts`

**Interfaces:**
- Produces: `BULK_APPROVABLE`, `EXPAND_ONLY` (both `ReadonlySet<ReviewOp['op']>`).
- Consumes: `ReviewOp` from `../lib/script-review-apply`.

- [ ] **Step 1: Write the failing test**

Add to `src/store/script-review-slice.test.ts`:

```ts
import { BULK_APPROVABLE, EXPAND_ONLY } from './script-review-slice';

describe('script-review taxonomy', () => {
  it('splits the 8 op classes into exactly the mechanical six and the high-stakes two', () => {
    expect([...EXPAND_ONLY].sort()).toEqual(['flag_nonstory', 'reattribute']);
    expect([...BULK_APPROVABLE].sort()).toEqual(
      ['extract_dialogue', 'fix_emotion', 'merge', 'split', 'strip_tag', 'validate_instruct'],
    );
    // no overlap
    for (const op of BULK_APPROVABLE) expect(EXPAND_ONLY.has(op)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/script-review-slice.test.ts -t "taxonomy"`
Expected: FAIL — `BULK_APPROVABLE`/`EXPAND_ONLY` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/store/script-review-slice.ts`, after `opKey` (line ~31):

```ts
/** The high-stakes op classes: opt-in / unchecked by default, and never
    bulk-approvable from the summary (identity + story-exclusion edits). */
export const EXPAND_ONLY: ReadonlySet<ReviewOp['op']> = new Set(['reattribute', 'flag_nonstory']);
/** The mechanical op classes: checked by default and bulk-approvable per
    chapter/type from the summary. The complement of EXPAND_ONLY. */
export const BULK_APPROVABLE: ReadonlySet<ReviewOp['op']> = new Set([
  'strip_tag', 'split', 'extract_dialogue', 'merge', 'fix_emotion', 'validate_instruct',
]);
```

Then refactor `setReview` — replace the local `DEFAULT_OFF` (line ~140) so the default-off logic reads from the shared set:

```ts
      const newSelected: Record<string, boolean> = {};
      for (const o of ops) {
        newSelected[opKey(o.chapterId, o.id, o.op)] = !EXPAND_ONLY.has(o.op);
      }
```

(Delete the `const DEFAULT_OFF = new Set(['reattribute', 'flag_nonstory']);` line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/script-review-slice.test.ts`
Expected: PASS — the new test plus all pre-existing `setReview` default-off tests stay green (behaviour is identical; only the source of the set moved).

- [ ] **Step 5: Commit**

```bash
git add src/store/script-review-slice.ts src/store/script-review-slice.test.ts
git commit -m "refactor(frontend): single-source script-review bulk/expand-only taxonomy"
```

---

## Task 2: `selectReviewSummary` aggregation selector

**Files:**
- Modify: `src/store/script-review-slice.ts` (add types + selector near the other selectors, line ~340)
- Test: `src/store/script-review-slice.test.ts`

**Interfaces:**
- Consumes: `BULK_APPROVABLE`/`EXPAND_ONLY` (Task 1), `opKey`, `ScriptReviewBucket`, `ReviewOpWithChapter`.
- Produces: `ReviewSummary`/`ReviewChapterSummary`/`ReviewTypeGroup`, `selectReviewSummary`.

- [ ] **Step 1: Write the failing test**

Add to `src/store/script-review-slice.test.ts`. Helper to fabricate a tagged op:

```ts
import { selectReviewSummary, type ReviewOpWithChapter } from './script-review-slice';

const op = (chapterId: number, id: number, opName: ReviewOpWithChapter['op']): ReviewOpWithChapter =>
  ({ chapterId, id, op: opName, rationale: 'x' }) as ReviewOpWithChapter;

describe('selectReviewSummary', () => {
  it('returns an empty summary for no bucket', () => {
    expect(selectReviewSummary(undefined)).toEqual({ totalOps: 0, chapters: [] });
  });

  it('aggregates appliable ops by chapter then type, chapters ascending', () => {
    const bucket = {
      ops: [
        op(5, 1, 'merge'), op(5, 2, 'merge'), op(5, 3, 'strip_tag'), op(5, 4, 'reattribute'),
        op(3, 9, 'fix_emotion'),
      ],
      unappliable: [{ op: op(5, 99, 'merge'), reason: 'stale' }], // MUST be excluded
      selected: {}, manuscriptId: 'm', versionByChapter: {}, visible: true,
    };
    const summary = selectReviewSummary(bucket as never);
    expect(summary.totalOps).toBe(5); // 5 appliable; the unappliable op is not counted
    expect(summary.chapters.map((c) => c.chapterId)).toEqual([3, 5]); // ascending

    const ch5 = summary.chapters.find((c) => c.chapterId === 5)!;
    expect(ch5.total).toBe(4);
    expect(ch5.toReview).toBe(1); // the reattribute (expand-only)
    // chapter-level selectableKeys = only the mechanical ops (2 merge + 1 strip_tag)
    expect(ch5.selectableKeys.sort()).toEqual(['5:1:merge', '5:2:merge', '5:3:strip_tag'].sort());

    const reattr = ch5.byType.find((t) => t.op === 'reattribute')!;
    expect(reattr.count).toBe(1);
    expect(reattr.selectableKeys).toEqual([]); // expand-only → no bulk keys
    const merge = ch5.byType.find((t) => t.op === 'merge')!;
    expect(merge.selectableKeys.sort()).toEqual(['5:1:merge', '5:2:merge']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/script-review-slice.test.ts -t "selectReviewSummary"`
Expected: FAIL — `selectReviewSummary` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/store/script-review-slice.ts`, near the other selectors (after `unresolvedCountForChapters`, line ~354):

```ts
export interface ReviewTypeGroup {
  op: ReviewOp['op'];
  count: number;
  /** opKeys the type-level "Approve" ticks — empty for EXPAND_ONLY types. */
  selectableKeys: string[];
}
export interface ReviewChapterSummary {
  chapterId: number;
  total: number;
  /** Union of every mechanical op's key in this chapter — the chapter-level
      "Approve all" set. Excludes EXPAND_ONLY ops. */
  selectableKeys: string[];
  /** Count of EXPAND_ONLY ops (reattribute/flag_nonstory) — the "N to review". */
  toReview: number;
  byType: ReviewTypeGroup[];
}
export interface ReviewSummary {
  totalOps: number;
  chapters: ReviewChapterSummary[];
}

/** Deterministic display order for the per-type rows: mechanical types first
    (in a fixed order), then the expand-only types. */
const TYPE_ORDER: ReviewOp['op'][] = [
  'merge', 'strip_tag', 'split', 'extract_dialogue', 'fix_emotion', 'validate_instruct',
  'reattribute', 'flag_nonstory',
];

/** Pure per-chapter/per-type aggregation over the flat appliable ops
    (`bucket.ops`, never `unappliable`) — the summary the accordion renders.
    No slice shape change; safe to recompute on every render. */
export function selectReviewSummary(bucket: ScriptReviewBucket | undefined): ReviewSummary {
  if (!bucket) return { totalOps: 0, chapters: [] };
  const byChapter = new Map<number, Map<string, ReviewOpWithChapter[]>>();
  for (const o of bucket.ops) {
    let types = byChapter.get(o.chapterId);
    if (!types) { types = new Map(); byChapter.set(o.chapterId, types); }
    const arr = types.get(o.op);
    if (arr) arr.push(o); else types.set(o.op, [o]);
  }
  const chapters: ReviewChapterSummary[] = [...byChapter.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chapterId, types]) => {
      const byType: ReviewTypeGroup[] = [...types.entries()]
        .map(([op, ops]) => ({
          op: op as ReviewOp['op'],
          count: ops.length,
          selectableKeys: BULK_APPROVABLE.has(op as ReviewOp['op'])
            ? ops.map((o) => opKey(o.chapterId, o.id, o.op))
            : [],
        }))
        .sort((a, b) => TYPE_ORDER.indexOf(a.op) - TYPE_ORDER.indexOf(b.op));
      const selectableKeys = byType.flatMap((t) => t.selectableKeys);
      const total = byType.reduce((n, t) => n + t.count, 0);
      return { chapterId, total, selectableKeys, toReview: total - selectableKeys.length, byType };
    });
  return { totalOps: bucket.ops.length, chapters };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/script-review-slice.test.ts -t "selectReviewSummary"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/script-review-slice.ts src/store/script-review-slice.test.ts
git commit -m "feat(frontend): add selectReviewSummary per-chapter/per-type aggregation"
```

---

## Task 3: `toggleKeys` bulk-tick reducer

**Files:**
- Modify: `src/store/script-review-slice.ts` (add reducer beside `toggleClass`, line ~256)
- Test: `src/store/script-review-slice.test.ts`

**Interfaces:**
- Produces: action `scriptReviewActions.toggleKeys({ bookId, keys, value })`.

- [ ] **Step 1: Write the failing test**

Add to `src/store/script-review-slice.test.ts`:

```ts
import { scriptReviewSlice, scriptReviewActions } from './script-review-slice';

describe('toggleKeys', () => {
  const seed = () => ({
    byBook: {
      bk: {
        ops: [], unappliable: [], manuscriptId: 'm', versionByChapter: {}, visible: true,
        selected: { '5:1:merge': false, '5:2:merge': false, '5:4:reattribute': false },
      },
    },
    activeStreams: {},
  });

  it('sets only the given known keys to the given value, ignoring unknown keys', () => {
    const next = scriptReviewSlice.reducer(
      seed() as never,
      scriptReviewActions.toggleKeys({ bookId: 'bk', keys: ['5:1:merge', '5:2:merge', '9:9:merge'], value: true }),
    );
    const sel = next.byBook.bk!.selected;
    expect(sel['5:1:merge']).toBe(true);
    expect(sel['5:2:merge']).toBe(true);
    expect(sel['5:4:reattribute']).toBe(false); // untouched
    expect('9:9:merge' in sel).toBe(false);      // unknown key never added
  });

  it('clears keys when value is false', () => {
    const start = seed();
    start.byBook.bk.selected['5:1:merge'] = true;
    const next = scriptReviewSlice.reducer(
      start as never,
      scriptReviewActions.toggleKeys({ bookId: 'bk', keys: ['5:1:merge'], value: false }),
    );
    expect(next.byBook.bk!.selected['5:1:merge']).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/script-review-slice.test.ts -t "toggleKeys"`
Expected: FAIL — `toggleKeys` is not an action.

- [ ] **Step 3: Write minimal implementation**

In `src/store/script-review-slice.ts`, add after `toggleClass` (line ~256), inside `reducers`:

```ts
    /** Set an explicit list of opKeys to `value` in one book's bucket — the
        primitive behind the summary's chapter- and type-level "Approve"
        controls. Only flips keys already present in `selected` (a key absent
        from the bucket is never created). */
    toggleKeys: (s, a: PayloadAction<{ bookId: string; keys: string[]; value: boolean }>) => {
      const bucket = s.byBook[a.payload.bookId];
      if (!bucket) return;
      for (const key of a.payload.keys) {
        if (key in bucket.selected) bucket.selected[key] = a.payload.value;
      }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/script-review-slice.test.ts -t "toggleKeys"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/script-review-slice.ts src/store/script-review-slice.test.ts
git commit -m "feat(frontend): add toggleKeys bulk-selection reducer for script review"
```

---

## Task 4: `consolidateProposedByName` pure helper

**Files:**
- Modify: `src/lib/apply-proposed.ts` (add export at end, line ~50)
- Test: `src/lib/apply-proposed.test.ts`

**Interfaces:**
- Consumes: `ReviewOpWithChapter`.
- Produces: `ProposedNameGroup`, `consolidateProposedByName`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/apply-proposed.test.ts`:

```ts
import { consolidateProposedByName } from './apply-proposed';
import type { ReviewOpWithChapter } from '../store/script-review-slice';

const rop = (chapterId: number, id: number, name: string): ReviewOpWithChapter =>
  ({ chapterId, id, op: 'reattribute', rationale: 'x', proposed: { name } }) as ReviewOpWithChapter;

describe('consolidateProposedByName', () => {
  it('groups off-roster proposals by normalized name and keeps every line', () => {
    const { newGroups, rosterMatchedOps } = consolidateProposedByName(
      [rop(3, 1, 'Guard'), rop(3, 2, ' guard '), rop(12, 8, 'Guard'), rop(4, 5, 'Cook')],
      new Set(), // empty roster → all new
    );
    expect(rosterMatchedOps).toEqual([]);
    expect(newGroups.map((g) => g.name.toLowerCase()).sort()).toEqual(['cook', 'guard']);
    const guard = newGroups.find((g) => g.name.trim().toLowerCase() === 'guard')!;
    expect(guard.ops).toHaveLength(3); // both spellings + ch12, one group
    expect(guard.proposed.name).toBe('Guard'); // first-seen display form
  });

  it('routes names already in the roster to rosterMatchedOps (no form)', () => {
    const { newGroups, rosterMatchedOps } = consolidateProposedByName(
      [rop(3, 1, 'Guard'), rop(4, 5, 'Cook')],
      new Set(['guard']), // Guard already exists
    );
    expect(rosterMatchedOps.map((o) => o.id)).toEqual([1]);
    expect(newGroups.map((g) => g.name)).toEqual(['Cook']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/apply-proposed.test.ts -t "consolidateProposedByName"`
Expected: FAIL — not exported.

- [ ] **Step 3: Write minimal implementation**

At the end of `src/lib/apply-proposed.ts`:

```ts
export interface ProposedNameGroup {
  /** First-seen display form of the name (for the form header). */
  name: string;
  /** The proposed fields to seed the create form with (first op's proposal). */
  proposed: { name: string; gender?: string; ageRange?: string };
  /** Every off-roster reattribute line sharing this normalized name. */
  ops: ReviewOpWithChapter[];
}

/** Split a batch of off-roster `reattribute` ops (each carrying `op.proposed`)
    into (a) one group per NEW normalized name — the names that need a single
    create-character confirm — and (b) the flat list of ops whose proposed name
    already matches a live cast member, which need no form (applied straight
    through the roster-seeded `applyProposedReattributions`). Pure. */
export function consolidateProposedByName(
  proposed: ReviewOpWithChapter[],
  rosterNames: ReadonlySet<string>,
): { newGroups: ProposedNameGroup[]; rosterMatchedOps: ReviewOpWithChapter[] } {
  const groups = new Map<string, ProposedNameGroup>();
  const rosterMatchedOps: ReviewOpWithChapter[] = [];
  for (const op of proposed) {
    if (!op.proposed) continue;
    const key = norm(op.proposed.name);
    if (rosterNames.has(key)) { rosterMatchedOps.push(op); continue; }
    const g = groups.get(key);
    if (g) g.ops.push(op);
    else groups.set(key, { name: op.proposed.name, proposed: op.proposed, ops: [op] });
  }
  return { newGroups: [...groups.values()], rosterMatchedOps };
}
```

(`norm` already exists at the top of the file — reuse it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/apply-proposed.test.ts -t "consolidateProposedByName"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/apply-proposed.ts src/lib/apply-proposed.test.ts
git commit -m "feat(frontend): consolidateProposedByName groups off-roster reattributes"
```

---

## Task 5: Accordion body — chapter → type → op cards, collapsed by default

Replace the flat op-class body (`script-review-diff.tsx` lines ~656–767) with a three-level accordion. **This task keeps today's per-op checkboxes working inside an expanded type; group-approve controls arrive in Task 6.**

**Files:**
- Modify: `src/components/script-review-diff.tsx` (imports ~11–16; body render ~656–767; add local expand state ~281)
- Test: `src/components/script-review-diff.test.tsx`

**Interfaces:**
- Consumes: `selectReviewSummary` (Task 2), `BULK_APPROVABLE` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `src/components/script-review-diff.test.tsx` (follow the existing render harness in that file — a store seeded via `scriptReviewActions.setReview` and `render(<ScriptReviewDiff bookId="bk" />)`; reuse its existing `setup`/`renderDiff` helper). New describe:

```ts
describe('ScriptReviewDiff — summary accordion', () => {
  it('opens collapsed: chapter rows visible, no op cards until expanded', () => {
    renderDiff({ ops: [
      opWithCh(5, 1, 'merge'), opWithCh(5, 2, 'strip_tag'), opWithCh(3, 9, 'fix_emotion'),
    ] });
    // chapter rows
    expect(screen.getByTestId('chapter-row-3')).toBeInTheDocument();
    expect(screen.getByTestId('chapter-row-5')).toBeInTheDocument();
    // no per-op card rendered yet (collapsed)
    expect(screen.queryByTestId('op-toggle-5:1:merge')).not.toBeInTheDocument();
  });

  it('expands a chapter to its type rows, then a type to its op cards', async () => {
    const { user } = renderDiff({ ops: [opWithCh(5, 1, 'merge'), opWithCh(5, 2, 'merge')] });
    await user.click(screen.getByTestId('chapter-row-5'));
    expect(screen.getByTestId('type-row-5-merge')).toBeInTheDocument();
    expect(screen.queryByTestId('op-toggle-5:1:merge')).not.toBeInTheDocument(); // type still collapsed
    await user.click(screen.getByTestId('type-row-5-merge'));
    expect(screen.getByTestId('op-toggle-5:1:merge')).toBeInTheDocument();
    expect(screen.getByTestId('op-toggle-5:2:merge')).toBeInTheDocument();
  });
});
```

**Add these shared helpers** near the existing setup in the test file (they're used by Tasks 5–8):

```ts
// 4th `extra` arg spreads op-specific fields (mergeIds, proposed, newText…) —
// Tasks 7 & 8 rely on it. Default it so 3-arg calls still work.
const opWithCh = (ch: number, id: number, op: ReviewOpWithChapter['op'], extra: Partial<ReviewOpWithChapter> = {}) =>
  ({ chapterId: ch, id, op, rationale: 'x', ...extra }) as ReviewOpWithChapter;

function renderDiff(opts: {
  ops: ReviewOpWithChapter[];
  cast?: { id: string; name: string }[];
  sentences?: Array<{ id: number; chapterId: number; text: string; characterId: string; instruct?: string; vocalization?: boolean }>;
  versionByChapter?: Record<number, number>;
}) {
  const store = makeStore(); // the file's existing store factory
  // NIT-9: seed the ready stage's bookId so runProposed's isSameBook() guard
  // passes (else applyProposedReattributions aborts after the first create).
  store.dispatch(uiActions.openBook({ id: 'bk', status: 'complete' })); // or the file's existing "enter ready stage" helper
  if (opts.cast) for (const c of opts.cast) store.dispatch(castActions.addCharacter(c as never));
  if (opts.sentences) store.dispatch(manuscriptActions.setSentences(opts.sentences as never)); // or the file's manuscript-seed helper
  const chapterIds = [...new Set(opts.ops.map((o) => o.chapterId))];
  store.dispatch(scriptReviewActions.setReview({
    bookId: 'bk', ops: opts.ops, unappliable: [], manuscriptId: 'm',
    versionByChapter: opts.versionByChapter ?? Object.fromEntries(chapterIds.map((c) => [c, 1])),
  }));
  const user = userEvent.setup();
  render(<Provider store={store}><ScriptReviewDiff bookId="bk" /></Provider>);
  return { store, user };
}
```

**Important — the method names above are placeholders; match the file's REAL idioms:** the file's existing `makeStore()` is an unparametrized factory (hardcodes its own book/bucket) and **there is no `manuscriptActions.setSentences` reducer**. So write a small *parametrized* store factory for these tests and seed sentences via `configureStore`'s `preloadedState.manuscript.sentences` (not a dispatch). `uiActions.openBook` and `castActions.addCharacter` are real and correctly shaped. `render` must import `fireEvent` (used by the Task 6 fake-timer test). Expect harmless `act(...)` warnings from the direct `store.dispatch(toggleKeys)` baseline-clear — react-redux still re-renders synchronously before the next query, so results are correct; no fix needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/script-review-diff.test.tsx -t "summary accordion"`
Expected: FAIL — no `chapter-row-*` testids.

- [ ] **Step 3: Write minimal implementation**

Add imports (line ~11–16 block):

```ts
import {
  scriptReviewActions,
  selectActiveReview,
  selectReviewSummary,
  opKey,
  type ReviewOpWithChapter,
} from '../store/script-review-slice';
```

(Do **not** import `BULK_APPROVABLE` into the component — the taxonomy is consumed only inside `selectReviewSummary`; the component reads `summary.*.selectableKeys`. An unused import fails lint/typecheck.)

Add local expand state next to the other `useState` hooks (~line 281):

```ts
  const [expandedChapters, setExpandedChapters] = useState<Set<number>>(new Set());
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set()); // key `${chapterId}:${op}`
  const toggleChapterExpand = (chapterId: number) =>
    setExpandedChapters((prev) => {
      const next = new Set(prev);
      next.has(chapterId) ? next.delete(chapterId) : next.add(chapterId);
      return next;
    });
  const toggleTypeExpand = (chapterId: number, op: string) =>
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      const k = `${chapterId}:${op}`;
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
```

Compute the summary right after `const { ops, selected, unappliable } = bucket;` (line ~301), and **delete** the now-unused `classes`/`byClass` block (lines ~305–309):

```ts
  const summary = selectReviewSummary(bucket);
```

Extract the existing per-op card JSX (lines ~723–761) into a local render helper so both the accordion (here) and its tests reuse one code path — place above the `return` (near `confirmOp`, ~line 538):

```ts
  function renderOpCard(op: ReviewOpWithChapter) {
    const key = opKey(op.chapterId, op.id, op.op);
    const isSelected = !!selected[key];
    const liveSentence = sentences.find((s) => s.chapterId === op.chapterId && s.id === op.id);
    return (
      <div key={key} className="flex items-start gap-3 p-3 rounded-2xl border border-ink/10 bg-canvas/50">
        <label htmlFor={`op-toggle-${key}`} className="flex items-center min-h-[44px] fine-pointer:min-h-0 cursor-pointer">
          <Checkbox
            id={`op-toggle-${key}`}
            data-testid={`op-toggle-${key}`}
            checked={isSelected}
            accent="ink"
            onChange={() => {
              dispatch(scriptReviewActions.toggleOp({ bookId, key }));
              scheduleSelectionSync(op.chapterId, { ...selected, [key]: !selected[key] });
            }}
            aria-label={`Toggle this ${op.op} suggestion`}
          />
        </label>
        <div className="flex-1 min-w-0 space-y-1">
          <OpPreview op={op} before={liveSentence?.text} liveInstruct={liveSentence?.instruct} liveVocalization={liveSentence?.vocalization} />
          <p className="text-xs text-ink/55 leading-relaxed">{op.rationale}</p>
          {op.confidence !== undefined && (
            <p className="text-[10px] text-ink/40 tabular-nums">Confidence: {Math.round(op.confidence * 100)}%</p>
          )}
        </div>
        <span className="text-[10px] text-ink/35 tabular-nums shrink-0 mt-0.5">#{op.id}</span>
      </div>
    );
  }
```

Replace the body's `{classes.map(...)}` block (lines ~681–766) with the accordion. Keep the existing `unappliable` notice (~657) and rewrite the empty state to key off `summary.chapters.length`:

```tsx
            {summary.chapters.length === 0 && (
              <div data-testid="script-review-empty" className="rounded-2xl border border-ink/10 bg-canvas/50 px-6 py-10 text-center">
                <p className="text-sm font-medium text-ink/70">No suggestions found</p>
                <p className="mt-1 text-xs text-ink/50">
                  {unappliable.length > 0
                    ? "All suggestions were stale or invalid and couldn't be applied."
                    : "The reviewer didn't find anything to change in this scope."}
                </p>
              </div>
            )}
            {summary.chapters.map((chapter) => {
              const chapterOpen = expandedChapters.has(chapter.chapterId);
              return (
                <section key={chapter.chapterId} data-testid={`chapter-section-${chapter.chapterId}`} className="space-y-2">
                  <button
                    type="button"
                    data-testid={`chapter-row-${chapter.chapterId}`}
                    onClick={() => toggleChapterExpand(chapter.chapterId)}
                    className="w-full flex items-center gap-3 pb-1 border-b border-ink/10 text-left min-h-[44px] fine-pointer:min-h-0"
                  >
                    <span className="text-xs font-bold uppercase tracking-wider text-ink/60 flex-1">
                      Chapter {chapter.chapterId}
                    </span>
                    <span className="text-xs text-ink/45 tabular-nums">
                      {chapter.total}{chapter.toReview > 0 ? ` · ${chapter.toReview} to review` : ''}
                    </span>
                    <span aria-hidden className="text-ink/40">{chapterOpen ? '▾' : '▸'}</span>
                  </button>

                  {chapterOpen && chapter.byType.map((type) => {
                    const typeOpen = expandedTypes.has(`${chapter.chapterId}:${type.op}`);
                    const typeOps = ops.filter((o) => o.chapterId === chapter.chapterId && o.op === type.op);
                    return (
                      <div key={type.op} data-testid={`type-group-${chapter.chapterId}-${type.op}`} className="pl-3 space-y-2">
                        <button
                          type="button"
                          data-testid={`type-row-${chapter.chapterId}-${type.op}`}
                          onClick={() => toggleTypeExpand(chapter.chapterId, type.op)}
                          className="w-full flex items-center gap-2 text-left min-h-[44px] fine-pointer:min-h-0"
                        >
                          <span className="text-xs font-semibold text-ink/70 flex-1">{classLabel(type.op)}</span>
                          <span className="text-[11px] text-ink/45 tabular-nums">{type.count}</span>
                          <span aria-hidden className="text-ink/40">{typeOpen ? '▾' : '▸'}</span>
                        </button>
                        {typeOpen && <div className="space-y-2">{typeOps.map(renderOpCard)}</div>}
                      </div>
                    );
                  })}
                </section>
              );
            })}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/script-review-diff.test.tsx`
Expected: PASS for the new accordion tests. **Pre-existing tests break because op cards are now behind two collapse levels** — update each (expand its chapter → its type before querying the card), don't `.skip`. The ones to fix (verify line numbers at execution time — they drift):
- `applies selected ops and skips deselected` (~:114, clicks `op-toggle-1:2:fix_emotion`)
- `renders a validate_instruct row` (~:496)
- `renders a reattribute row` (~:558)
- `renders a flag_nonstory row struck` (~:609)
- `toggling a checkbox schedules a debounced PATCH` (~:1236)
- any test asserting the old `class-toggle-*` "Select all" checkbox — that control is gone; rewrite it against `type-approve-*`/`chapter-approve-*` (Task 6).

The `apply-button`, `unappliable-notice`, and empty-state tests survive (those surfaces aren't inside the accordion). All of these depend on the BLOCKER-2 fix (chapter-row testid on the expand button) landing in Task 6 — until then the Task 5 "expands a chapter" test drives expansion via its own button testid.

- [ ] **Step 5: Commit**

```bash
git add src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "feat(frontend): script-review summary accordion (chapter → type → op)"
```

---

## Task 6: Group-approve controls (chapter + type) with post-toggle sync

Add the bulk-approve checkboxes to the chapter and (bulk-type) rows from Task 5, wired to `toggleKeys` + the stale-safe selection sync.

**Files:**
- Modify: `src/components/script-review-diff.tsx` (the accordion from Task 5)
- Test: `src/components/script-review-diff.test.tsx`

**Interfaces:**
- Consumes: `toggleKeys` (Task 3), `summary.*.selectableKeys` (Task 2).

- [ ] **Step 1: Write the failing test**

**Note — mechanical ops are SELECTED by default** (`setReview` seeds `!EXPAND_ONLY.has(op)`). The approve checkbox is a toggle (`checked={allSel}`, sets `!allSel`), so on a fresh bucket clicking it *deselects*. Each test that asserts approve *selects* must first establish a deselected baseline via `toggleKeys(value:false)`.

```ts
import { fireEvent } from '@testing-library/react';

describe('ScriptReviewDiff — group approve', () => {
  it('chapter Approve-all ticks only mechanical ops, leaves reattribute unticked', async () => {
    const { store, user } = renderDiff({ ops: [
      opWithCh(5, 1, 'merge'), opWithCh(5, 2, 'strip_tag'), opWithCh(5, 3, 'reattribute'),
    ] });
    store.dispatch(scriptReviewActions.toggleKeys({ bookId: 'bk', keys: ['5:1:merge', '5:2:strip_tag'], value: false }));
    await user.click(screen.getByTestId('chapter-approve-5'));
    const sel = store.getState().scriptReview.byBook.bk.selected;
    expect(sel['5:1:merge']).toBe(true);
    expect(sel['5:2:strip_tag']).toBe(true);
    expect(sel['5:3:reattribute']).toBe(false); // expand-only never bulk-approved
  });

  it('shows "N to review" when a chapter has expand-only ops', () => {
    renderDiff({ ops: [opWithCh(5, 1, 'merge'), opWithCh(5, 3, 'reattribute')] });
    expect(screen.getByTestId('chapter-row-5')).toHaveTextContent('1 to review');
  });

  it('type Approve ticks just that type', async () => {
    const { store, user } = renderDiff({ ops: [opWithCh(5, 1, 'merge'), opWithCh(5, 2, 'merge')] });
    store.dispatch(scriptReviewActions.toggleKeys({ bookId: 'bk', keys: ['5:1:merge', '5:2:merge'], value: false }));
    await user.click(screen.getByTestId('chapter-row-5')); // expand to reveal type-approve
    await user.click(screen.getByTestId('type-approve-5-merge'));
    const sel = store.getState().scriptReview.byBook.bk.selected;
    expect(sel['5:1:merge']).toBe(true);
    expect(sel['5:2:merge']).toBe(true);
  });

  it('bulk approve schedules a selection sync with the POST-tick keys', () => {
    const patch = vi.spyOn(api, 'patchScriptReviewSelection').mockResolvedValue({ ok: true } as never);
    vi.useFakeTimers();
    try {
      const { store } = renderDiff({ ops: [opWithCh(5, 1, 'merge')], versionByChapter: { 5: 7 } });
      store.dispatch(scriptReviewActions.toggleKeys({ bookId: 'bk', keys: ['5:1:merge'], value: false }));
      // fireEvent (not userEvent) under fake timers — matches the file's existing debounce test
      fireEvent.click(screen.getByTestId('chapter-approve-5'));
      vi.advanceTimersByTime(600);
      expect(patch).toHaveBeenCalledWith('bk', expect.objectContaining({
        chapterId: 5, version: 7, selected: expect.objectContaining({ '5:1:merge': true }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/script-review-diff.test.tsx -t "group approve"`
Expected: FAIL — no `chapter-approve-*` / `type-approve-*` controls.

- [ ] **Step 3: Write minimal implementation**

Add a shared handler above `return` (near `renderOpCard`):

```ts
  /** Tick/untick an explicit key set and mirror the post-toggle snapshot to
      the server (stale-safe: builds nextSelected locally, since `selected` in
      this closure predates the dispatch). All keys here belong to one chapter. */
  function approveKeys(chapterId: number, keys: string[], nextValue: boolean) {
    if (keys.length === 0) return;
    dispatch(scriptReviewActions.toggleKeys({ bookId, keys, value: nextValue }));
    const nextSelected = { ...selected };
    for (const k of keys) if (k in nextSelected) nextSelected[k] = nextValue;
    scheduleSelectionSync(chapterId, nextSelected);
  }
```

In the **chapter row**, add an approve checkbox (only when the chapter has mechanical ops). Put it just before the count `<span>`; make the row a `<div>` with the expand as its own button so the checkbox isn't nested in a button (invalid HTML):

```tsx
                  <div className="flex items-center gap-3 pb-1 border-b border-ink/10">
                    {chapter.selectableKeys.length > 0 && (() => {
                      const allSel = chapter.selectableKeys.every((k) => selected[k]);
                      return (
                        <label className="flex items-center gap-1.5 text-[11px] text-ink/55 cursor-pointer select-none min-h-[44px] fine-pointer:min-h-0">
                          <Checkbox
                            data-testid={`chapter-approve-${chapter.chapterId}`}
                            checked={allSel}
                            accent="ink"
                            onChange={() => approveKeys(chapter.chapterId, chapter.selectableKeys, !allSel)}
                            aria-label={`Approve all mechanical suggestions in chapter ${chapter.chapterId}`}
                          />
                          Approve {chapter.selectableKeys.length}
                        </label>
                      );
                    })()}
                    {/* BLOCKER-2: the testid MUST sit on the clickable expand button,
                        not the wrapper div — the "N to review" text lives inside it so
                        the text-content assertion still resolves. */}
                    <button type="button" data-testid={`chapter-row-${chapter.chapterId}`} onClick={() => toggleChapterExpand(chapter.chapterId)} className="flex-1 flex items-center gap-3 text-left min-h-[44px] fine-pointer:min-h-0">
                      <span className="text-xs font-bold uppercase tracking-wider text-ink/60 flex-1">Chapter {chapter.chapterId}</span>
                      <span className="text-xs text-ink/45 tabular-nums">
                        {chapter.total}{chapter.toReview > 0 ? ` · ${chapter.toReview} to review` : ''}
                      </span>
                      <span aria-hidden className="text-ink/40">{chapterOpen ? '▾' : '▸'}</span>
                    </button>
                  </div>
```

In the **type row**, when `type.selectableKeys.length > 0` render an approve checkbox; the expand-only types (empty `selectableKeys`) get a muted "review" hint instead:

```tsx
                        <div className="w-full flex items-center gap-2">
                          {type.selectableKeys.length > 0 ? (() => {
                            const allSel = type.selectableKeys.every((k) => selected[k]);
                            return (
                              <label className="flex items-center gap-1.5 text-[11px] text-ink/55 cursor-pointer select-none min-h-[44px] fine-pointer:min-h-0">
                                <Checkbox
                                  data-testid={`type-approve-${chapter.chapterId}-${type.op}`}
                                  checked={allSel}
                                  accent="ink"
                                  onChange={() => approveKeys(chapter.chapterId, type.selectableKeys, !allSel)}
                                  aria-label={`Approve ${classLabel(type.op)} in chapter ${chapter.chapterId}`}
                                />
                              </label>
                            );
                          })() : (
                            <span className="text-[10px] uppercase tracking-wider text-magenta/70">review</span>
                          )}
                          <button type="button" data-testid={`type-row-${chapter.chapterId}-${type.op}`} onClick={() => toggleTypeExpand(chapter.chapterId, type.op)} className="flex-1 flex items-center gap-2 text-left min-h-[44px] fine-pointer:min-h-0">
                            <span className="text-xs font-semibold text-ink/70 flex-1">{classLabel(type.op)}</span>
                            <span className="text-[11px] text-ink/45 tabular-nums">{type.count}</span>
                            <span aria-hidden className="text-ink/40">{typeOpen ? '▾' : '▸'}</span>
                          </button>
                        </div>
```

(Replace the Task-5 single-button chapter/type rows with these composite rows.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/script-review-diff.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "feat(frontend): chapter/type group-approve for script-review summary"
```

---

## Task 7: Surface partial application on the bulk path

**Files:**
- Modify: `src/components/script-review-diff.tsx` (`handleApply`, line ~476)
- Test: `src/components/script-review-diff.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
describe('ScriptReviewDiff — partial apply notice', () => {
  it('warns when planApply drops some selected ops', async () => {
    const toast = vi.spyOn(notificationsActions, 'pushToast');
    // Two structural merge ops on the SAME sentence id → planApply keeps one, drops one.
    const { user } = renderDiff({
      ops: [opWithCh(5, 1, 'merge', { mergeIds: [1, 2] }), opWithCh(5, 1, 'strip_tag', { newText: 'x' })],
      sentences: [{ id: 1, chapterId: 5, text: 'a b', characterId: 'c1' }, { id: 2, chapterId: 5, text: 'c', characterId: 'c1' }],
      versionByChapter: { 5: 1 },
    });
    // merge + strip_tag are mechanical → selected by default, so just apply
    // (don't click chapter-approve — on a fresh bucket that would DESELECT).
    await user.click(screen.getByTestId('apply-button'));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("couldn't apply"),
    }));
  });
});
```

(Extend `renderDiff` to seed `s.manuscript.sentences` from a `sentences` option so `planApply` has a live snapshot; a `merge` on id 1 and a `strip_tag` on id 1 conflict per planApply's "strip_tag wins text collisions / one structural op per id" rules.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/script-review-diff.test.tsx -t "partial apply"`
Expected: FAIL — no toast fired.

- [ ] **Step 3: Write minimal implementation**

In `handleApply`, right after `const { appliable } = planApply(selectedOps, live, roster);` (line ~492):

```ts
    const notApplied = selectedOps.length - appliable.length;
    if (notApplied > 0) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message: `${appliable.length} applied · ${notApplied} couldn't apply (conflicting edits)`,
          dedupeKey: `script-review-partial-${startBookId}`,
        }),
      );
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/script-review-diff.test.tsx -t "partial apply"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "feat(frontend): surface partial application on bulk script-review apply"
```

---

## Task 8: Per-name create-once confirm queue

Replace the per-op confirm queue with a per-unique-name one. **This rewrites the five touch-points named in the spec:** the `confirm` state shape, `confirmOp`→`confirmGroup`, the form key/header, `advanceConfirm`→`advanceGroup`, and `handleApply`'s `proposedOps` branch. `applyProposedReattributions` and `runProposed`'s body stay as-is.

**Files:**
- Modify: `src/components/script-review-diff.tsx` (confirm state ~269; handleApply proposed branch ~496–523; advanceConfirm ~425–463; confirm JSX ~550–585)
- Test: `src/components/script-review-diff.test.tsx`

**Interfaces:**
- Consumes: `consolidateProposedByName` (Task 4), `ProposedNameGroup`.

- [ ] **Step 1: Write the failing test**

```ts
describe('ScriptReviewDiff — create-once speakers', () => {
  it('shows ONE create form for a new speaker spanning multiple lines', async () => {
    const create = vi.spyOn(api, 'createCharacter').mockResolvedValue({ character: { id: 'g1', name: 'Guard' } } as never);
    const { user } = renderDiff({
      ops: [
        opWithCh(3, 1, 'reattribute', { proposed: { name: 'Guard' } }),
        opWithCh(3, 2, 'reattribute', { proposed: { name: 'Guard' } }),
      ],
      sentences: [{ id: 1, chapterId: 3, text: 'a', characterId: 'c0' }, { id: 2, chapterId: 3, text: 'b', characterId: 'c0' }],
      versionByChapter: { 3: 1 },
    });
    // reattribute is expand-only → tick each op explicitly
    await user.click(screen.getByTestId('chapter-row-3'));
    await user.click(screen.getByTestId('type-row-3-reattribute'));
    await user.click(screen.getByTestId('op-toggle-3:1:reattribute'));
    await user.click(screen.getByTestId('op-toggle-3:2:reattribute'));
    await user.click(screen.getByTestId('apply-button'));

    // exactly one confirm form, headed with the name + line count
    expect(screen.getByTestId('confirm-reattribute')).toHaveTextContent('Guard');
    expect(screen.getByTestId('confirm-reattribute')).toHaveTextContent('2 lines');
    await user.click(screen.getByTestId('create-character-submit'));
    // one POST, both lines repointed
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a proposed name already in the roster needs no form', async () => {
    const create = vi.spyOn(api, 'createCharacter');
    const { user } = renderDiff({
      ops: [opWithCh(3, 1, 'reattribute', { proposed: { name: 'Existing' } })],
      cast: [{ id: 'e1', name: 'Existing' }],
      sentences: [{ id: 1, chapterId: 3, text: 'a', characterId: 'c0' }],
      versionByChapter: { 3: 1 },
    });
    await user.click(screen.getByTestId('chapter-row-3'));
    await user.click(screen.getByTestId('type-row-3-reattribute'));
    await user.click(screen.getByTestId('op-toggle-3:1:reattribute'));
    await user.click(screen.getByTestId('apply-button'));
    expect(screen.queryByTestId('confirm-reattribute')).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});
```

(Extend `renderDiff` to accept a `cast` option seeding `s.cast.characters`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/script-review-diff.test.tsx -t "create-once"`
Expected: FAIL — the current per-op queue shows a form per op / different header.

- [ ] **Step 3: Write minimal implementation**

Import the helper (top of file):

```ts
import { applyProposedReattributions, consolidateProposedByName, type ProposedNameGroup } from '../lib/apply-proposed';
```

Change the `confirm` state shape (line ~269):

```ts
  const [confirm, setConfirm] = useState<{
    groups: ProposedNameGroup[];   // one per NEW unique name
    index: number;
    finalized: ReviewOpWithChapter[];
    startBookId: string;
  } | null>(null);
```

Rewrite `handleApply`'s proposed branch (lines ~494–523). Replace from the `proposedOps`/`directOps` split's `if (proposedOps.length > 0)` down to its `return`:

```ts
    if (proposedOps.length > 0) {
      const rosterNames = new Set(cast.map((c) => c.name.trim().toLowerCase()));
      const { newGroups, rosterMatchedOps } = consolidateProposedByName(proposedOps, rosterNames);
      if (newGroups.length === 0) {
        // Every proposed name already exists → no form; apply straight through.
        void runProposed(rosterMatchedOps, startBookId);
      } else {
        setConfirm({ groups: newGroups, index: 0, finalized: rosterMatchedOps, startBookId });
      }
      return; // confirm queue / runProposed handle the rest (Task 14 cleanup path)
    }
```

Replace `advanceConfirm` (lines ~425–463) with `advanceGroup`:

```ts
  /* Advance the per-NAME confirm queue by one group's decision. "Create new"
     stamps the (possibly edited) proposed fields onto EVERY line of the group
     and defers them to the dedupe-aware helper; "reattribute to existing"
     applies all the group's lines to that id immediately (on-roster reassign).
     When the last group is decided, hand the collected create-batch to
     runProposed exactly once. */
  function advanceGroup(group: ProposedNameGroup, decision: { characterId?: string; proposed?: { name: string; gender?: string; ageRange?: string } }) {
    if (decision.characterId) {
      for (const op of group.ops) {
        dispatch(manuscriptActions.setSentenceCharacter({ chapterId: op.chapterId, sentenceId: op.id, characterId: decision.characterId }));
        dispatch(changeLogActions.bumpBoundaryMove({ chapterId: op.chapterId, count: 1 }));
      }
      if (bucket) {
        const startBookId = confirm?.startBookId ?? bookId;
        void resolveAppliedOps(dispatch, startBookId, bucket, group.ops);
      }
    }
    setConfirm((prev) => {
      if (!prev) return prev;
      const finalized = decision.characterId
        ? prev.finalized
        : [...prev.finalized, ...group.ops.map((op) => ({ ...op, characterId: undefined, proposed: decision.proposed }))];
      const nextIndex = prev.index + 1;
      if (nextIndex >= prev.groups.length) void runProposed(finalized, prev.startBookId);
      return { ...prev, finalized, index: nextIndex };
    });
  }
```

Replace `confirmOp` (lines ~538–540) with `confirmGroup`:

```ts
  const confirmGroup =
    confirm && confirm.index < confirm.groups.length ? confirm.groups[confirm.index] : null;
```

Rewrite the confirm JSX (lines ~550–585) to be per-name:

```tsx
      {confirmGroup && (
        <>
          <div className="fixed inset-0 bg-ink/50 z-[60]" aria-hidden="true" />
          <div className="fixed inset-0 z-[60] grid place-items-center p-4 pointer-events-none">
            <div data-testid="confirm-reattribute" className="bg-white rounded-3xl shadow-float w-full max-w-md pointer-events-auto p-6 space-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                  New speaker ({(confirm?.index ?? 0) + 1} of {confirm?.groups.length})
                </p>
                <h3 className="text-base font-bold text-ink leading-tight">
                  «{confirmGroup.name}» — {confirmGroup.ops.length} line{confirmGroup.ops.length === 1 ? '' : 's'}
                </h3>
              </div>
              <CreateCharacterForm
                key={confirmGroup.name.trim().toLowerCase()}
                initial={confirmGroup.proposed}
                rosterByName={confirmRosterByName}
                onSubmit={(f) => advanceGroup(confirmGroup, { proposed: f })}
                onReattributeExisting={(characterId) => advanceGroup(confirmGroup, { characterId })}
                onCancel={cancelConfirm}
              />
            </div>
          </div>
        </>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/script-review-diff.test.tsx`
Expected: PASS (new create-once tests + the pre-existing confirm-queue tests, updated for the per-name header/flow — update, don't skip). **Two existing tests break *semantically* (not just cosmetically) and MUST be rewritten** (verify line numbers — they drift):
- `reattribute-to-an-existing-cast-member op resolves server-side` (~:988) expects a confirm form headed "Reattribute to «Ferra»". Under per-name grouping a roster-matched name routes to `rosterMatchedOps` → `runProposed` with **no form**; `getByTestId('confirm-reattribute')` will throw. Rewrite to assert *no* form appears and the op still resolves (spy `manuscriptActions.setSentenceCharacter` / `api.resolveScriptReviewOps`).
- `two same-name proposed ops create EXACTLY one character through the queue` (~:737) clicks `create-character-submit` **twice** (once per op). There is now **one** form for the shared name; the second `waitFor(getByTestId('confirm-reattribute'))` times out. Reduce to a single submit; keep the "createCharacter called once" assertion.

The `#1480` form-reset test (~:806), the failed-create test (~:834), and the two cancel tests use single/distinct names and survive unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "feat(frontend): create-once speaker confirm (one form per unique name)"
```

---

## Task 9: E2E golden path + mock fixture

**Files:**
- Create: `e2e/script-review-summary.spec.ts`
- Modify: `src/mocks/canned-data.ts` (only if no multi-chapter review bucket is already seeded)
- Test: the spec itself

- [ ] **Step 1: Inspect the mock surface**

Run: `npx grep -rn "setReview\|script-review\|ScriptReviewBucket" src/mocks || true`
Confirm whether a review bucket spanning ≥2 chapters is reachable in mock mode (`VITE_USE_MOCKS`). If the review bucket is produced by an in-JS mock (not an HTTP route), the fixture must live in `canned-data.ts` — `page.route` cannot inject it. If none exists, add a minimal multi-chapter bucket (2 chapters, a merge + a strip_tag + a reattribute) behind the same mock entry the modal reads.

- [ ] **Step 2: Write the spec**

```ts
import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' }); // shared mock nav state

test('script-review summary: collapsed → expand → approve → apply drops the count', async ({ page }) => {
  await page.goto('/'); // open the mock book that has a seeded review bucket; follow the pattern in existing e2e specs for navigating to a book's manuscript with a pending review
  // open the review modal (badge / "Review existing")
  await page.getByTestId('review-script-chapter').click();
  // collapsed: chapter rows present, no op cards
  await expect(page.getByTestId(/^chapter-row-/).first()).toBeVisible();
  const firstChapter = page.getByTestId(/^chapter-approve-/).first();
  await firstChapter.click();          // approve all mechanical in that chapter
  await page.getByTestId('apply-button').click();
  // the modal closes or the count shrinks — assert the whole-book badge dropped
  await expect(page.getByTestId('review-script-chapter')).not.toContainText('(0)');
});
```

(Adjust selectors/navigation to the existing e2e helpers — reuse how other specs reach a book's manuscript view in mock mode. Keep it one spec.)

- [ ] **Step 3: Run**

Run: `npx playwright test e2e/script-review-summary.spec.ts --project=chromium`
Expected: PASS (requires `npx playwright install chromium` once).

- [ ] **Step 4: Commit**

```bash
git add e2e/script-review-summary.spec.ts src/mocks/canned-data.ts
git commit -m "test(frontend): e2e golden path for script-review summary approve"
```

---

## Task 10: Release notes, spec status, issue linkage

**Files:**
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`
- Modify: `docs/superpowers/specs/2026-07-20-script-review-summary-and-create-once-design.md` (`status: draft` → `active`; fill Ship notes at merge)

- [ ] **Step 1: Append release notes**

`docs/release-notes-next.md` under `## ✨ Improvements` (or the current in-progress section) — technical register, PR-refed:

```markdown
- Script review now opens as a per-chapter/per-type summary (collapsed) with chapter- and type-level bulk approve, so a whole-book run is reviewable instead of a flat wall of ~1000 cards; a bulk apply that can't fully apply now says how many landed. Newly-discovered speakers are created once and applied to every proposed line instead of prompting per line. (#NN)
```

`RELEASE_NOTES.md` in the in-progress version section — brand voice, user-facing:

```markdown
- **Review a whole book without drowning.** Script review now groups suggestions by chapter and type, approve a chapter (or just its merges) in one tap, and a newly-found character is created once — not once per line.
```

- [ ] **Step 2: Flip the spec status**

Set the spec's front-matter `status:` from `draft` to `active`.

- [ ] **Step 3: Commit**

```bash
git add docs/release-notes-next.md RELEASE_NOTES.md docs/superpowers/specs/2026-07-20-script-review-summary-and-create-once-design.md
git commit -m "docs(frontend): release notes + spec status for script-review summary"
```

- [ ] **Step 4: Issue linkage (at PR time)**

File/confirm a GitHub issue for this feature (title `fs-58 — script-review whole-book summary + create-once speakers`, labels `type:feature` + `area:frontend`); the PR body carries `Closes #NN`. The `#NN` in the release notes above is backfilled with the real number.

---

## Final verification (before PR)

- [ ] `npx vitest run src/store/script-review-slice.test.ts src/lib/apply-proposed.test.ts src/components/script-review-diff.test.tsx` — all green.
- [ ] `npm run verify:fast:branch` from the worktree root — lint + typecheck + scoped tests + build.
- [ ] Manual: at phone width (<640px) the accordion is single-column, chapter/type controls are ≥44px, and expanding works by tap.
- [ ] Open the mandatory `code-review` pass (medium effort — single-scope `feat`) once pushed.

---

## Self-review (author checklist — completed at write time)

- **Spec coverage:** A→Task 5/6; B→Task 6 (`selectableKeys` empty for expand-only) + Task 1 (taxonomy); C→Task 4+8; D-selector→Task 2; D-toggleKeys→Task 3; D-single-source→Task 1; D-post-toggle-sync→Task 6; D2 partial-apply→Task 7; empty/unappliable→Task 5; testing→each task + Task 9; resolved-questions (omit zero-pending / extract_dialogue safe)→Task 2 aggregates `bucket.ops` only, no zero rows possible. All spec sections map to a task.
- **Placeholder scan:** every code step shows real code; test steps show real assertions; the only `#NN` is the genuinely-unknown issue number, backfilled in Task 10.
- **Type consistency:** `selectableKeys` (string[]) named identically in Task 2 types, Task 6 usage; `consolidateProposedByName` signature matches between Task 4 def and Task 8 call; `advanceGroup(group, decision)` shape matches its two call sites; `toggleKeys` payload matches def (Task 3) and use (Task 6).
