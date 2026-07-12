# `voices_pending` Book Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `voices_pending` book stage — cast confirmed but generation not started — so reopening such a book from the library lands on the Cast view (for voice design) instead of jumping to the Generate tab.

**Architecture:** Server derives the new status purely from disk (`castConfirmed && !generationStarted && not-complete`, where `generationStarted = completedChapters > 0 || any chapter failed`); no new state.json field, no migration. The client adds the status to its type union + `STATUS_UI` badge map, routes it to the Cast view, and hardens the badge lookup against server/client enum skew.

**Tech Stack:** TypeScript, Node/Express (server), React + Redux Toolkit (client), Vitest (unit), Playwright (e2e), OpenAPI (contract).

## Global Constraints

- **Design tokens only** — no hex literals in component code; badge colours are the `StatusMeta` union (`'library' | 'warning' | 'peach' | 'success' | 'danger'`).
- **OpenAPI is the type source of truth** — the status enum lives in `openapi.yaml`; `src/lib/api-types.ts` is regenerated via `npm run openapi:types`, never hand-edited. `src/lib/types.ts` hand-mirrors it (per its own doc comment) until regeneration.
- **Trigger semantics (locked):** `voices_pending` ≡ cast confirmed AND generation-not-started AND not complete. "Generation started" is **derived from disk** — never a persisted flag.
- **Do not fork** the client's `resolveVoiceStatus` "Needs voice" logic onto the server. The server never computes voice-designed-ness.
- Reference spec: `docs/superpowers/specs/2026-07-12-voices-pending-stage-design.md`.

---

### Task 1: Server status derivation + enum + `isConfirmed`

**Files:**
- Modify: `server/src/workspace/scan.ts` (union ~37, `isConfirmed` ~442, status ladder ~728-735)
- Test: `server/src/workspace/scan.test.ts`

**Interfaces:**
- Consumes: existing `computeBookStatus`/scan internals — `state.castConfirmed`, `activeChapters` (`state.chapters.filter(c => !c.excluded)`), `completedChapters` (audio files on disk), `chapterCount`, per-chapter `generationState?: 'failed'`.
- Produces: `LibraryBookStatus` now includes `'voices_pending'`; the scan result's `status` field can be `'voices_pending'`. `isConfirmed(b)` returns true for `voices_pending` in addition to `generating`/`complete`.

- [ ] **Step 0 (prerequisite): teach `bookSkeleton` to persist `generationState`**

The existing `bookSkeleton` helper (`scan.test.ts:32`) maps chapters to `{ id, title, slug }` **only** — it drops any `generationState`. The failed-chapter case below needs it, so extend that one `.map`:

```ts
chapters: chapters.map((c) => ({
  id: c.id,
  title: `Chapter ${c.id}`,
  slug: c.slug,
  ...(c.generationState ? { generationState: c.generationState } : {}),
})),
```

and widen the helper's `chapters` param type to allow `generationState?: 'failed'`.

- [ ] **Step 1: Write the failing tests**

Use the file's REAL fixture helpers (verified against `scan.test.ts`): `bookSkeleton(title, opts)` → `{ bookId, bookDir, audioRoot }`; `writeCast(bookDir, characters)`; `seedAnalysisCache(\`m_${bookId}\`, chapterIds)`; `writeSegments(audioRoot, slug, sec)` + an empty `<slug>.mp3`; `flatten()` for the flat book list. **Critical:** a `voices_pending` book must ALSO seed the cast (`writeCast`) AND a complete analysis cache (`seedAnalysisCache`) — without both, `scanBook` classifies it `'analysing'` (`scan.ts:732` `!hasUsableCast || !analysisComplete`), never reaching the confirmed branches. Add to `scan.test.ts`, mirroring the existing "Partial Book" status test:

```ts
describe('voices_pending status', () => {
  it('castConfirmed + 0 rendered + 0 failed → voices_pending', async () => {
    const { bookDir, bookId } = bookSkeleton('Cast Ready Book', {
      castConfirmed: true,
      chapters: [{ id: 1, slug: 'cr-1' }, { id: 2, slug: 'cr-2' }],
    });
    await seedAnalysisCache(`m_${bookId}`, [1, 2]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    // no audio, no failure → generation not started
    const b = (await flatten()).find((x) => x.title === 'Cast Ready Book')!;
    expect(b.status).toBe('voices_pending');
    expect(b.progress).toBeUndefined();
  });

  it('castConfirmed + 1 rendered → generating (not voices_pending)', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('Started Book', {
      castConfirmed: true,
      chapters: [{ id: 1, slug: 'sb-1' }, { id: 2, slug: 'sb-2' }],
    });
    await seedAnalysisCache(`m_${bookId}`, [1, 2]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'sb-1', 30 * 60);
    writeFileSync(join(audioRoot, 'sb-1.mp3'), '');
    const b = (await flatten()).find((x) => x.title === 'Started Book')!;
    expect(b.status).toBe('generating');
  });

  it('castConfirmed + 0 rendered but a chapter failed → generating (not voices_pending)', async () => {
    const { bookDir, bookId } = bookSkeleton('Failed First Book', {
      castConfirmed: true,
      chapters: [{ id: 1, slug: 'ff-1', generationState: 'failed' }, { id: 2, slug: 'ff-2' }],
    });
    await seedAnalysisCache(`m_${bookId}`, [1, 2]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    const b = (await flatten()).find((x) => x.title === 'Failed First Book')!;
    expect(b.status).toBe('generating');
  });

  it('castConfirmed + all rendered → complete (not voices_pending)', async () => {
    const { bookDir, audioRoot, bookId } = bookSkeleton('Done Book', {
      castConfirmed: true,
      chapters: [{ id: 1, slug: 'db-1' }],
    });
    await seedAnalysisCache(`m_${bookId}`, [1]);
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'db-1', 20 * 60);
    writeFileSync(join(audioRoot, 'db-1.mp3'), '');
    const b = (await flatten()).find((x) => x.title === 'Done Book')!;
    expect(b.status).toBe('complete');
  });
});
```

> `writeFileSync` and `join` are already imported at the top of `scan.test.ts` (used by the existing runtime tests) — no new imports needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/workspace/scan.test.ts -t "voices_pending"`
Expected: the first case FAILs (`'generating'` received, `'voices_pending'` expected); the other three already pass (no regression baseline).

- [ ] **Step 3: Add `voices_pending` to the server union**

`server/src/workspace/scan.ts` ~line 37:

```ts
export type LibraryBookStatus =
  | 'not_analysed'
  | 'analysing'
  | 'cast_pending'
  | 'voices_pending'
  | 'generating'
  | 'complete'
  | 'unreadable'
  | 'orphaned';
```

- [ ] **Step 4: Insert the derivation + ladder branch**

`server/src/workspace/scan.ts`, just before the status ladder (the `let status: LibraryBookStatus;` block ~728). Add the derivation using the already-computed `activeChapters` and `completedChapters`:

```ts
/* voices_pending — cast confirmed but generation not started. "Started" is
   derived from disk: any audio rendered, or any chapter carrying a durable
   failure marker. No persisted flag (see the design doc's Detection section).
   The single transient window (first chapter mid-render, 0 done / 0 failed)
   self-heals on the next completed-or-failed chapter. */
const generationStarted =
  completedChapters > 0 || activeChapters.some((c) => c.generationState === 'failed');

let status: LibraryBookStatus;
if (unreadable) status = 'unreadable';
else if (hasState && !manuscriptFile) status = 'orphaned';
else if (!hasState && manuscriptFile) status = 'not_analysed';
else if (state && (!hasUsableCast || !analysisComplete)) status = 'analysing';
else if (state && !state.castConfirmed) status = 'cast_pending';
else if (state && state.castConfirmed && !generationStarted && completedChapters < chapterCount)
  status = 'voices_pending';
else if (state && state.castConfirmed && completedChapters < chapterCount) status = 'generating';
else status = 'complete';
```

> Note the ordering invariant (verified in spec review): the new branch's extra `!generationStarted` guard means anything it rejects the next (`generating`) branch catches, and the shared `completedChapters < chapterCount` guard keeps complete/excluded-only books on the `complete` path.

- [ ] **Step 5: Update `isConfirmed`**

`server/src/workspace/scan.ts` ~line 442:

```ts
/** A confirmed cast means `voices_pending`, `generating`, or `complete`
    (LibraryBook has no `castConfirmed` field — only `status` — so this is the
    correct mapping). */
const isConfirmed = (b: LibraryBook) =>
  b.status === 'voices_pending' || b.status === 'generating' || b.status === 'complete';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run src/workspace/scan.test.ts`
Expected: all `voices_pending` cases PASS and the rest of the file stays green.

- [ ] **Step 7: Commit**

```bash
git add server/src/workspace/scan.ts server/src/workspace/scan.test.ts
git commit -m "feat(server): derive voices_pending book status"
```

---

### Task 2: Contract + client status plumbing (union, badge, routing, fallback, fixture)

**Files:**
- Modify: `openapi.yaml` (status enum ~3649)
- Regenerate: `src/lib/api-types.ts` (via `npm run openapi:types` — never hand-edit)
- Modify: `src/lib/types.ts` (`LibraryBookStatus` union ~566)
- Modify: `src/components/library/library-status-ui.tsx` (`STATUS_UI` map)
- Modify: `src/components/library/library-grid.tsx` (defensive lookup ~167)
- Modify: `src/views/book-library.tsx` (`IN_PROGRESS_STATUSES` ~95)
- Modify: `src/store/ui-slice.ts` (only a routing test asserts behaviour; reducer already falls through — see step 5)
- Modify: `src/mocks/library.ts` (inline library array)
- Test: `src/components/library/library-status-ui.test.ts`, `src/store/ui-slice.test.ts` (or the nearest existing openBook test file), `src/views/book-library.test.tsx`

**Interfaces:**
- Consumes: server `status: 'voices_pending'` from Task 1 (over the wire / in mocks).
- Produces: client `LibraryBookStatus` includes `'voices_pending'`; `STATUS_UI.voices_pending` exists (`{color:'library', label:'Cast ready', icon:<IconCheckCircle/>}`); `openBook({status:'voices_pending'})` → `{kind:'ready', view:'cast'}`.

Because `STATUS_UI` is typed `Record<LibraryBookStatus, StatusMeta>`, the union edit and the map entry are mutually type-dependent and MUST land together (a union value without a map key, or a map key without the union value, both fail `tsc`). Keep them in one commit.

- [ ] **Step 1: Write the failing client tests**

`src/components/library/library-status-ui.test.ts` — add `'voices_pending'` to the hardcoded `ALL_STATUSES` array:

```ts
const ALL_STATUSES: LibraryBookStatus[] = [
  'not_analysed',
  'analysing',
  'cast_pending',
  'voices_pending',
  'generating',
  'complete',
  'unreadable',
  'orphaned',
];
```

Add a routing test to `src/store/ui-slice.test.ts` (the file already exists and has `openBook` tests — append there; match the file's existing import of the reducer/actions):

```ts
it('openBook routes a voices_pending book to the cast view', () => {
  const state = uiReducer(undefined, uiActions.openBook({ id: 'b1', status: 'voices_pending' }));
  expect(state.stage).toMatchObject({ kind: 'ready', bookId: 'b1', view: 'cast' });
});
```

Add a filter test to `src/views/book-library.test.tsx` using the file's REAL builder `makeLibBook` (verified at `book-library.test.tsx:893`) wrapped in the `LibraryAuthor[]` shape the existing `applyLibraryFilters` tests use:

```ts
it("counts a voices_pending book under the 'in_progress' filter", () => {
  const authors: LibraryAuthor[] = [
    {
      name: 'Marin Vale',
      series: [
        {
          name: 'Northern Coast Trilogy',
          books: [makeLibBook({ bookId: 'b1', title: 'Cast Ready', status: 'voices_pending' })],
        },
      ],
    },
  ];
  const out = applyLibraryFilters(authors, { filter: 'in_progress', search: '', tags: [], languages: [] });
  expect(out.flatMap((a) => a.series.flatMap((s) => s.books))).toHaveLength(1);
});
```

> `applyLibraryFilters`, `makeLibBook`, and the `LibraryAuthor` type are all already in scope in `book-library.test.tsx` — no new imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/library/library-status-ui.test.ts src/views/book-library.test.tsx src/store/ui-slice.test.ts`
Expected: `library-status-ui` FAILs (`STATUS_UI.voices_pending` undefined); the routing + filter tests FAIL (status not yet in union / not counted).

- [ ] **Step 3: Add the status to the contract + regenerate types**

`openapi.yaml` ~line 3649:

```yaml
          enum: [not_analysed, analysing, cast_pending, voices_pending, generating, complete, unreadable, orphaned]
```

Then regenerate:

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` diff adds `voices_pending` to the status union. Do not hand-edit the file.

`src/lib/types.ts` ~line 566 — mirror it:

```ts
export type LibraryBookStatus =
  | 'not_analysed'
  | 'analysing'
  | 'cast_pending'
  | 'voices_pending'
  | 'generating'
  | 'complete'
  | 'unreadable'
  | 'orphaned';
```

- [ ] **Step 4: Add the `STATUS_UI` badge entry**

`src/components/library/library-status-ui.tsx` — insert between `cast_pending` and `generating`:

```tsx
  voices_pending: {
    color: 'library',
    label: 'Cast ready',
    icon: <IconCheckCircle className="w-3.5 h-3.5" />,
  },
```

- [ ] **Step 5: Harden the badge lookup (defensive fallback)**

`src/components/library/library-grid.tsx` ~line 167 — guard against a server status the bundled map lacks (version skew), so it degrades to a neutral pill instead of crashing every card:

```tsx
const meta =
  STATUS_UI[book.status] ??
  ({ color: 'library', label: book.status, icon: <IconCheckCircle className="w-3.5 h-3.5" /> } as const);
```

Ensure `IconCheckCircle` is imported in `library-grid.tsx` (add to the existing `../../lib/icons` import if absent).

- [ ] **Step 6: Add `voices_pending` to `IN_PROGRESS_STATUSES`**

`src/views/book-library.tsx` ~line 95:

```ts
const IN_PROGRESS_STATUSES = new Set<LibraryBookStatus>([
  'analysing',
  'cast_pending',
  'voices_pending',
  'generating',
  'not_analysed',
]);
```

- [ ] **Step 7: Add the routing fall-through assertion + mock fixture**

`src/store/ui-slice.ts` `openBook` already routes `voices_pending` to `'cast'` via the existing `else` (it is neither `complete` nor `generating`). Make the intent explicit with a comment so a future refactor can't silently regress it — change the view line (~246):

```ts
const view: View =
  status === 'complete' ? 'listen' : status === 'generating' ? 'generate' : 'cast';
/* 'cast' also covers voices_pending (cast confirmed, not yet generating) — a
   reopened book lands on voice design, not Generate. Asserted in ui-slice.test.ts. */
```

Add a `voices_pending` book to the inline array in `src/mocks/library.ts` (copy a neighbouring entry's shape; omit `progress`/`runtime`, set `completedChapters: 0`):

```ts
{
  bookId: 'vp',
  title: 'The Tidewatcher',
  author: 'Marin Vale',
  series: 'Northern Coast Trilogy',
  seriesPosition: 3,
  isStandalone: false,
  status: 'voices_pending',
  chapterCount: 9,
  completedChapters: 0,
  characterCount: 5,
  voiceCount: 5,
  voiceIds: ['narrator', 'v-carrick', 'v-mara', 'v-tane', 'v-brenna'],
  lastWorkedOn: 'just now',
  coverGradient: ['#243B4A', '#0F0E0D'],
  tags: ['series-1'],
},
```

> Match the exact `LibraryBook` field set the neighbouring entries use — if a required field is missing, `tsc` flags it; add it from the sibling entry.

- [ ] **Step 8: Run tests + typecheck to verify green**

Run: `npx vitest run src/components/library/library-status-ui.test.ts src/views/book-library.test.tsx src/store/ui-slice.test.ts && npm run typecheck`
Expected: all PASS; `tsc` clean (proves union + `STATUS_UI` + fixture are consistent).

- [ ] **Step 9: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts src/lib/types.ts \
  src/components/library/library-status-ui.tsx src/components/library/library-status-ui.test.ts \
  src/components/library/library-grid.tsx src/views/book-library.tsx src/views/book-library.test.tsx \
  src/store/ui-slice.ts src/store/ui-slice.test.ts src/mocks/library.ts
git commit -m "feat(frontend): route voices_pending books to the Cast view"
```

---

### Task 3: E2E — reopen lands on Cast

**Files:**
- Modify: `e2e/cast-first-landing-and-voice-gate.spec.ts`

**Interfaces:**
- Consumes: the `voices_pending` mock book from Task 2 (`src/mocks/library.ts`, bookId `vp`) rendered by Vite in mock mode.
- Produces: a browser-level assertion that opening a `voices_pending` card lands on the Cast view.

- [ ] **Step 1: Read the existing spec + helpers to match the harness**

Run: `sed -n '1,60p' e2e/cast-first-landing-and-voice-gate.spec.ts` and `grep -n "export" e2e/helpers.ts`
The spec imports from `./helpers` (`goToConfirm`, `confirmCastAndReachManuscript`, `waitForRouteReady`, …) and runs `test.describe.configure({ mode: 'serial' })`. There is no library-card-open helper here, so borrow the library-open path from a library spec (e.g. `grep -rn "getByText\|card\|#/books/" e2e/library-*.spec.ts` for the click-to-open pattern) rather than inventing a page-object.

- [ ] **Step 2: Add the failing e2e case**

The `vp` mock book (Task 2) lands in the library grid. The ready-stage hash grammar is `#/books/<id>/<view>` (plural "books" — verified in `src/lib/router.ts:65`), so a `voices_pending` reopen must land on `#/books/vp/cast`. Illustrative shape — wire the boot + card-open to the real helpers found in Step 1:

```ts
test('reopening a cast-ready (voices_pending) book lands on the Cast view', async ({ page }) => {
  await page.goto('/');                                   // mock-mode library (match sibling specs' base)
  await waitForRouteReady(page);
  await page.getByText('The Tidewatcher').click();        // open the vp card (use the library spec's exact selector)
  await expect(page).toHaveURL(/#\/books\/vp\/cast/);
  await expect(page.getByRole('heading', { name: /cast/i })).toBeVisible();
});
```

> Correct the base-URL/goto and the card selector to whatever the library e2e specs actually use; keep the `#/books/vp/cast` (plural) URL assertion — that is the verified hash grammar.

- [ ] **Step 3: Run the e2e spec**

Run: `npm run test:e2e -- cast-first-landing-and-voice-gate`
Expected: the new case PASSES (and the pre-existing cases stay green).

- [ ] **Step 4: Commit**

```bash
git add e2e/cast-first-landing-and-voice-gate.spec.ts
git commit -m "test(e2e): voices_pending reopen lands on Cast view"
```

---

### Task 4: Regression plan doc + release notes

**Files:**
- Create: `docs/features/<NN>-voices-pending-stage.md` (from `docs/features/TEMPLATE.md`; pick the next free `NN`)
- Modify: `docs/features/INDEX.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

**Interfaces:**
- Consumes: nothing at runtime.
- Produces: the durable regression doc + release-notes entries required by the Before-shipping checklist.

- [ ] **Step 1: Create the regression plan**

Copy `docs/features/TEMPLATE.md` to `docs/features/<NN>-voices-pending-stage.md`. Fill: `status: active`; the invariant (derivation rule + ladder ordering + `isConfirmed` inclusion); the positive-vs-negative-list audit rule from the spec; and a manual acceptance walkthrough: *confirm a cast, do NOT start generating, return to the library → card reads "Cast ready" → reopen → lands on Cast; then generate one chapter → card reads "Generating" → reopen → lands on Generate.* Link the spec.

- [ ] **Step 2: Index it**

Add an entry under the appropriate area in `docs/features/INDEX.md`.

- [ ] **Step 3: Release notes (both files)**

`docs/release-notes-next.md` — append a technical entry (PR-refed):

```markdown
- **`voices_pending` book stage** — a cast-confirmed book that hasn't started
  generating now reopens on the Cast view (voice design) instead of the
  Generate tab, and shows a "Cast ready" library badge. Derived from disk; no
  state.json change. (#<PR>)
```

`RELEASE_NOTES.md` — add a brand-voice line to the in-progress version section at the top:

```markdown
- Books whose cast you've approved but haven't started narrating now open
  straight to voice design — and wear a “Cast ready” badge in your library.
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/ docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): regression plan + release notes for voices_pending stage"
```

---

## Self-review notes

- **Spec coverage:** every propagation-table row maps to a task — scan.ts + `isConfirmed` (T1); openapi/api-types/types/`STATUS_UI`/`IN_PROGRESS_STATUSES`/routing/`library-grid` fallback/`mocks/library.ts` (T2); `layout.tsx` bgBookIds is reviewed-no-change (no task needed, documented in spec); e2e (T3); regression doc + release notes (T4).
- **Atomicity:** the union edit and `STATUS_UI` entry are in one commit (T2) per the spec's atomicity requirement; the defensive fallback ships alongside.
- **Detection:** implemented exactly as the locked trigger — `completedChapters > 0 || any failed` — no persisted flag.
- **Type consistency:** `LibraryBookStatus` value `'voices_pending'`, `STATUS_UI.voices_pending`, and mock `status: 'voices_pending'` are spelled identically across all tasks.
