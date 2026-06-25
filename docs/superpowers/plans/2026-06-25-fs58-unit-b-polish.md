# fs-58 Unit B polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four deferred fs-58 Unit B polish items in #1122 — disable split/drag edit affordances on excluded lines, surface a toast on a failed character-create, harden the reattribute-to-existing test, and drop two trivia (button `type`, dead param).

**Architecture:** Pure-frontend chore. Item 1 gates two existing manuscript edit affordances behind an `excludeFromSynthesis` check (one extracted pure predicate + two call-site guards) and is verified by a new Playwright e2e because jsdom can't drive `getSelection`/`elementFromPoint`. Items 2–4 are localized component/lib changes with colocated Vitest tests.

**Tech Stack:** Vite + React 18 + TypeScript, Redux Toolkit, Vitest + React Testing Library (jsdom), Playwright (chromium).

**Spec:** `docs/superpowers/specs/2026-06-25-fs58-unit-b-polish-design.md`

## Global Constraints

- Branch: `chore/frontend-fs58-unit-b-polish` (already cut from `main`; spec committed on it).
- No analyzer, server, or OpenAPI-contract changes — frontend only.
- Toast API: `notificationsActions.pushToast({ kind: 'error' | 'warn', message: string, dedupeKey?: string })` from `src/store/notifications-slice.ts`.
- Commit subjects MUST match `<type>(<scope>): <subject>` (scope `frontend`); the commit-msg hook rejects otherwise.
- Tests colocate next to the unit (`*.test.ts(x)`); e2e under `e2e/`.
- `pre-commit` runs `verify:fast:scoped` (skips out-of-scope legs). Do NOT use `--no-verify`.
- Each task ends green and is committed before the next starts.

---

### Task 1: CreateCharacterForm — explicit button `type` + reattribute-vs-create test

Covers Item 2 (reattribute-to-existing test) and Item 4a (`type="button"`).

**Files:**
- Modify: `src/components/create-character-form.tsx` (the two `<button>`s in the action row)
- Test: `src/components/create-character-form.test.tsx`

**Interfaces:**
- Consumes: `CreateCharacterForm({ initial?, rosterByName, onSubmit, onReattributeExisting?, onCancel })` (existing, unchanged).
- Produces: nothing new — behaviour-preserving plus explicit `type="button"` on both buttons.

- [ ] **Step 1: Write the failing test**

Append to `src/components/create-character-form.test.tsx`:

```tsx
it('routes a roster-name match to onReattributeExisting and never onSubmit', () => {
  const onSubmit = vi.fn();
  const onReattributeExisting = vi.fn();
  render(
    <CreateCharacterForm
      initial={{ name: 'Halloran' }}
      rosterByName={new Map([['halloran', { id: 'halloran', name: 'Halloran' }]])}
      onSubmit={onSubmit}
      onReattributeExisting={onReattributeExisting}
      onCancel={() => {}}
    />,
  );
  const submit = screen.getByTestId('create-character-submit');
  expect(submit).toHaveTextContent(/Reattribute to «Halloran»/);
  fireEvent.click(submit);
  expect(onReattributeExisting).toHaveBeenCalledWith('halloran');
  expect(onSubmit).not.toHaveBeenCalled();
});

it('routes a novel name to onSubmit and never onReattributeExisting', () => {
  const onSubmit = vi.fn();
  const onReattributeExisting = vi.fn();
  render(
    <CreateCharacterForm
      rosterByName={new Map([['halloran', { id: 'halloran', name: 'Halloran' }]])}
      onSubmit={onSubmit}
      onReattributeExisting={onReattributeExisting}
      onCancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ferra' } });
  const submit = screen.getByTestId('create-character-submit');
  expect(submit).toHaveTextContent('Create character');
  fireEvent.click(submit);
  expect(onSubmit).toHaveBeenCalledWith({ name: 'Ferra', gender: undefined, ageRange: undefined });
  expect(onReattributeExisting).not.toHaveBeenCalled();
});

it('gives both action buttons an explicit type="button"', () => {
  render(<CreateCharacterForm rosterByName={new Map()} onSubmit={() => {}} onCancel={() => {}} />);
  expect(screen.getByTestId('create-character-submit')).toHaveAttribute('type', 'button');
  expect(screen.getByRole('button', { name: /cancel/i })).toHaveAttribute('type', 'button');
});
```

- [ ] **Step 2: Run the tests to verify the new ones' state**

Run: `npm run test -- src/components/create-character-form.test.tsx`
Expected: the two routing tests PASS (existing behaviour); the `type="button"` test FAILS (`expected attribute type to equal "button"` — buttons have no `type` today).

- [ ] **Step 3: Add `type="button"` to both buttons**

In `src/components/create-character-form.tsx`, the submit button:

```tsx
        <button
          type="button"
          data-testid="create-character-submit"
          disabled={disabled}
```

and the cancel button:

```tsx
        <button type="button" onClick={onCancel} className="px-4 min-h-[44px] sm:min-h-0 text-sm text-ink/50">
          Cancel
        </button>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/components/create-character-form.test.tsx`
Expected: PASS (all, including `type="button"`).

- [ ] **Step 5: Commit**

```bash
git add src/components/create-character-form.tsx src/components/create-character-form.test.tsx
git commit -m "chore(frontend): explicit button type + reattribute-branch test for CreateCharacterForm (#1122)"
```

---

### Task 2: Drop the dead `_roster` param from `dispatchAcceptedOps`

Covers Item 4b. Pure refactor — guarded by `typecheck` + existing suites (no new behaviour to test).

**Files:**
- Modify: `src/lib/script-review-apply.ts` (`dispatchAcceptedOps` signature)
- Modify: `src/components/script-review-diff.tsx` (the call site that passes `roster` as the 5th arg)

**Interfaces:**
- Consumes: nothing new.
- Produces: `dispatchAcceptedOps(dispatch, accepted, live, { onBoundaryMove })` — 4 params (was 5). `planApply(ops, live, roster)` is UNCHANGED (its `roster` is used).

- [ ] **Step 1: Remove the unused param from the signature**

In `src/lib/script-review-apply.ts`, change:

```ts
export function dispatchAcceptedOps(
  dispatch: Dispatch,
  accepted: ReviewOp[],
  live: Array<{ id: number; chapterId: number; text: string; characterId: string; instruct?: string; vocalization?: boolean }>,
  { onBoundaryMove }: { onBoundaryMove: (chapterId: number) => void },
  _roster: Set<string> = new Set(),
): void {
```

to:

```ts
export function dispatchAcceptedOps(
  dispatch: Dispatch,
  accepted: ReviewOp[],
  live: Array<{ id: number; chapterId: number; text: string; characterId: string; instruct?: string; vocalization?: boolean }>,
  { onBoundaryMove }: { onBoundaryMove: (chapterId: number) => void },
): void {
```

- [ ] **Step 2: Remove the 5th argument at the call site**

In `src/components/script-review-diff.tsx`, find the `dispatchAcceptedOps(...)` call (it passes `roster` as the final argument) and delete that final `roster,` argument line. The remaining call passes `dispatch, directOps (or appliable), live, { onBoundaryMove: ... }`. Leave the local `roster` set in place — it is still passed to `planApply(...)`.

- [ ] **Step 3: Verify typecheck + existing tests are green**

Run: `npm run typecheck`
Expected: PASS (no "expected 5 arguments" / unused-symbol errors).

Run: `npm run test -- src/lib/script-review-apply.test.ts src/components/script-review-diff.test.tsx`
Expected: PASS (no behaviour change).

- [ ] **Step 4: Commit**

```bash
git add src/lib/script-review-apply.ts src/components/script-review-diff.tsx
git commit -m "refactor(frontend): drop unused _roster param from dispatchAcceptedOps (#1122)"
```

---

### Task 3: Toast + keep-open on a failed sidebar character-create

Covers Item 3a. On a rejected `api.createCharacter`, the form already stays open (the throw skips `setAddingChar(false)`), but the rejection is unhandled and there is no error surface.

**Files:**
- Modify: `src/views/manuscript.tsx` (`handleCreateCharacter`; the `CreateCharacterForm` `onSubmit` in `SidebarPanels`)
- Test: `src/views/manuscript.test.tsx`

**Interfaces:**
- Consumes: `notificationsActions.pushToast` (already imported at `manuscript.tsx:46`), the `createCharacter` api mock (already wired at `manuscript.test.tsx:34-38`), `notificationsSlice` (already imported in the test file).
- Produces: `handleCreateCharacter` rejects on failure AFTER dispatching an error toast; the sidebar `onSubmit` closes the form only on success.

- [ ] **Step 1: Write the failing test**

Append to the `describe('ManuscriptView — Add character button ...')` block in `src/views/manuscript.test.tsx`. It needs the `notifications` reducer, which the existing `renderAddCharView` store omits — add a local store that includes it:

```tsx
it('on a failed create: shows an error toast and keeps the form open (#1122)', async () => {
  const user = userEvent.setup();
  createCharacter.mockReset();
  createCharacter.mockRejectedValue(new Error('boom'));

  const store = configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      ui: uiSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      cast: castSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    preloadedState: {
      ui: {
        ...uiSlice.getInitialState(),
        stage: { kind: 'ready', bookId: 'bk-addchar', view: 'manuscript', currentChapterId: 1, openProfileId: null } as never,
      },
      cast: { characters: [{ id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' }], renderedFallbackByCharacter: {} },
    },
  });

  render(
    <Provider store={store}>
      <ManuscriptView
        characters={[{ id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' }]}
        chapters={[{ id: 1, title: 'Chapter One', duration: '10:00', state: 'done', progress: 1, characters: { narrator: 'done' } }]}
        currentChapterId={1}
        setCurrentChapterId={() => {}}
        sentencesFromStore={[]}
      />
    </Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: /add character/i }));
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ferra' } });
  await user.click(screen.getByTestId('create-character-submit'));

  // Error toast surfaced.
  await waitFor(() => {
    const toasts: Toast[] = store.getState().notifications.toasts;
    expect(toasts.some((t) => t.kind === 'error' && /create character/i.test(t.message))).toBe(true);
  });
  // Form still open for retry.
  expect(screen.getByTestId('create-character-form')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/views/manuscript.test.tsx -t "failed create"`
Expected: FAIL — no error toast is dispatched (and an unhandled rejection may be logged).

- [ ] **Step 3: Wrap the handler and the parent onSubmit**

In `src/views/manuscript.tsx`, change `handleCreateCharacter`:

```tsx
  const handleCreateCharacter = useCallback(
    async (fields: { name: string; gender?: string; ageRange?: string }) => {
      if (!bookId) return;
      try {
        const result = await api.createCharacter(bookId, fields as Parameters<typeof api.createCharacter>[1]);
        dispatch(castActions.addCharacter(result.character));
      } catch (err) {
        dispatch(
          notificationsActions.pushToast({
            kind: 'error',
            message: "Couldn't create character",
            dedupeKey: 'create-character',
          }),
        );
        throw err;
      }
    },
    [bookId, dispatch],
  );
```

and the sidebar form's `onSubmit` (in `SidebarPanels`) — close only on success, swallow the re-thrown error so there is no unhandled rejection:

```tsx
                onSubmit={async (f) => {
                  try {
                    await onCreateCharacter(f);
                    setAddingChar(false);
                  } catch {
                    /* handler already surfaced a toast; keep the form open for retry */
                  }
                }}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/views/manuscript.test.tsx -t "failed create"`
Expected: PASS. Also re-run the existing happy-path: `npm run test -- src/views/manuscript.test.tsx -t "Add character"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "fix(frontend): toast + keep-open on failed sidebar character-create (#1122)"
```

---

### Task 4: Toast + clean reset on a failed off-roster reattribute batch

Covers Item 3b. On a rejected `api.createCharacter` inside `runProposed`, the confirm machine never resets and the review bucket is never cleared, wedging the modal.

**Files:**
- Modify: `src/components/script-review-diff.tsx` (`runProposed`; add `notificationsActions` import)
- Test: `src/components/script-review-diff.test.tsx`

**Interfaces:**
- Consumes: `notificationsActions.pushToast`; the existing `makeProposedStore` + `createSpy` harness in the test file.
- Produces: `runProposed` catches a create failure, pushes an error toast, calls `setConfirm(null)`, and leaves the review bucket (no `clearReview`) so the operator can re-trigger. Re-run is safe because `setSentenceCharacter` is idempotent.

- [ ] **Step 1: Write the failing test**

In `src/components/script-review-diff.test.tsx`, add the `notifications` reducer to `makeProposedStore` (add `notifications: notificationsSlice.reducer` to its `reducer` map and `import { notificationsSlice, type Toast } from '../store/notifications-slice';` at the top). Then add, inside the off-roster `describe`:

```tsx
it('a failed create surfaces a toast, closes the confirm dialog, and keeps the review for retry (#1122)', async () => {
  createSpy.mockRejectedValueOnce(new Error('boom'));
  const store = makeProposedStore(
    [{ id: 5, chapterId: 1, proposed: { name: 'Ferra' } }],
    [{ id: 5, chapterId: 1, text: 'Line five.', characterId: 'narr' }],
  );
  render(
    <Provider store={store}>
      <ScriptReviewDiff bookId="book-A" />
    </Provider>,
  );

  fireEvent.click(screen.getByTestId('apply-button'));
  expect(screen.getByTestId('confirm-reattribute')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('create-character-submit'));

  // Error toast surfaced.
  await waitFor(() => {
    const toasts: Toast[] = store.getState().notifications.toasts;
    expect(toasts.some((t) => t.kind === 'error' && /create character/i.test(t.message))).toBe(true);
  });
  // Confirm dialog closed.
  expect(screen.queryByTestId('confirm-reattribute')).toBeNull();
  // Review bucket retained for retry (NOT cleared).
  expect(store.getState().scriptReview.byBook['book-A']).toBeDefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/components/script-review-diff.test.tsx -t "failed create"`
Expected: FAIL — no toast; the confirm dialog state is left inconsistent.

- [ ] **Step 3: Wrap `runProposed`**

Add the import at the top of `src/components/script-review-diff.tsx`:

```tsx
import { notificationsActions } from '../store/notifications-slice';
```

Wrap the `applyProposedReattributions` await in `runProposed`. Replace:

```tsx
  async function runProposed(finalized: FinalizedProposed[], startBookId: string) {
    const rosterByName = new Map(cast.map((c) => [c.name.trim().toLowerCase(), { id: c.id }]));
    await applyProposedReattributions(finalized, {
      // ...deps unchanged...
    });
    setConfirm(null);
    dispatch(scriptReviewActions.clearReview({ bookId: startBookId }));
  }
```

with:

```tsx
  async function runProposed(finalized: FinalizedProposed[], startBookId: string) {
    const rosterByName = new Map(cast.map((c) => [c.name.trim().toLowerCase(), { id: c.id }]));
    try {
      await applyProposedReattributions(finalized, {
        // ...deps unchanged...
      });
    } catch {
      // A create failed mid-batch. Reset the confirm machine and surface a toast,
      // but DON'T clearReview — the operator can re-trigger. Re-run is safe because
      // setSentenceCharacter is idempotent for an already-applied reattribute.
      setConfirm(null);
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: "Couldn't create character",
          dedupeKey: 'create-character',
        }),
      );
      return;
    }
    setConfirm(null);
    dispatch(scriptReviewActions.clearReview({ bookId: startBookId }));
  }
```

(Keep the existing `deps` object body of `applyProposedReattributions` exactly as-is inside the `try`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- src/components/script-review-diff.test.tsx -t "failed create"`
Expected: PASS. Re-run the dedupe/cancel tests: `npm run test -- src/components/script-review-diff.test.tsx` → PASS (success path still clears the review).

- [ ] **Step 5: Commit**

```bash
git add src/components/script-review-diff.tsx src/components/script-review-diff.test.tsx
git commit -m "fix(frontend): toast + clean reset on a failed off-roster reattribute batch (#1122)"
```

---

### Task 5: Disable split + drag affordances on excluded lines

Covers Item 1. Extract a pure predicate (unit-tested), wire two call-site guards, and prove the user-facing behaviour with a Playwright e2e (jsdom can't drive `getSelection`/`elementFromPoint`).

**Files:**
- Modify: `src/views/manuscript.tsx` (export `isExcludedSentenceId`; gate `<SelectionPopover>`; guard `assignSelectionTo`; guard the boundary-drag `onMove`; remove the `follow-up:` comment)
- Test: `src/views/manuscript.test.tsx` (predicate unit test)
- Create: `e2e/manuscript-excluded-line-noedit.spec.ts`

**Interfaces:**
- Consumes: the current-chapter `sentences` array and `currentChapterId` (both already in scope in the component body), `selection` from `useSentenceSelection`.
- Produces: `export function isExcludedSentenceId(sentences, chapterId, sentenceId): boolean`.

- [ ] **Step 1: Write the failing predicate unit test**

Append to `src/views/manuscript.test.tsx` (add `isExcludedSentenceId` to the existing `import { ManuscriptView } from './manuscript';` → `import { ManuscriptView, isExcludedSentenceId } from './manuscript';`):

```tsx
describe('isExcludedSentenceId', () => {
  const rows = [
    { chapterId: 1, id: 1, excludeFromSynthesis: true },
    { chapterId: 1, id: 2 },
    { chapterId: 2, id: 1 }, // same id, different chapter, NOT excluded
  ];
  it('is true for an excluded sentence', () => {
    expect(isExcludedSentenceId(rows, 1, 1)).toBe(true);
  });
  it('is false for a non-excluded sentence', () => {
    expect(isExcludedSentenceId(rows, 1, 2)).toBe(false);
  });
  it('is scoped by chapter (no cross-chapter id collision)', () => {
    expect(isExcludedSentenceId(rows, 2, 1)).toBe(false);
  });
  it('is false when the sentence is not found', () => {
    expect(isExcludedSentenceId(rows, 9, 9)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/views/manuscript.test.tsx -t isExcludedSentenceId`
Expected: FAIL — `isExcludedSentenceId is not a function` / import error.

- [ ] **Step 3: Add the predicate**

In `src/views/manuscript.tsx`, near the other module-scope helpers (e.g. just above `function renderSentenceText`):

```tsx
/* fs-58 Unit B — a sentence excluded from synthesis offers no split/reassign
   affordance (it won't be rendered either way). Scoped by chapter because
   sentence ids restart per chapter. */
export function isExcludedSentenceId(
  sentences: ReadonlyArray<{ chapterId: number; id: number; excludeFromSynthesis?: boolean }>,
  chapterId: number,
  sentenceId: number,
): boolean {
  return Boolean(
    sentences.find((s) => s.chapterId === chapterId && s.id === sentenceId)?.excludeFromSynthesis,
  );
}
```

- [ ] **Step 4: Run to verify the predicate test passes**

Run: `npm run test -- src/views/manuscript.test.tsx -t isExcludedSentenceId`
Expected: PASS.

- [ ] **Step 5: Wire the popover gate**

In `src/views/manuscript.tsx`, the `<SelectionPopover sel={selection} ... />` render. Change `sel` to suppress on an excluded line:

```tsx
      <SelectionPopover
        sel={
          selection &&
          currentChapterId != null &&
          isExcludedSentenceId(sentences, currentChapterId, selection.sentenceId)
            ? null
            : selection
        }
        characters={characters}
        onAssign={assignSelectionTo}
      />
```

- [ ] **Step 6: Guard `assignSelectionTo` (belt-and-suspenders)**

In `assignSelectionTo`, broaden the early return:

```tsx
    const sentence = sentences.find(
      (s) => s.chapterId === currentChapterId && s.id === selection.sentenceId,
    );
    if (!sentence || sentence.excludeFromSynthesis) return;
```

- [ ] **Step 7: Guard the boundary-drag `onMove`**

In the `onMove` handler inside the drag `useEffect`, skip an excluded sentence as a drop candidate:

```tsx
    const onMove = (e: globalThis.PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const sentenceEl = el?.closest?.('[data-sentence-idx]') as HTMLElement | null;
      if (sentenceEl) {
        const idx = Number(sentenceEl.dataset.sentenceIdx);
        if (sentences[idx]?.excludeFromSynthesis) return; // fs-58 Unit B — excluded line isn't a drop target
        setDrag((d) =>
          d && d.candidateSentenceIdx !== idx ? { ...d, candidateSentenceIdx: idx } : d,
        );
      }
    };
```

- [ ] **Step 8: Remove the resolved follow-up comment**

Delete the line `follow-up: disable split/drag affordance on excluded lines.` from the excluded-line comment block (keep the rest of that comment describing the re-include toggle).

- [ ] **Step 9: Run the full manuscript unit suite + typecheck**

Run: `npm run test -- src/views/manuscript.test.tsx`
Expected: PASS (predicate test + all pre-existing).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Write the e2e spec**

Create `e2e/manuscript-excluded-line-noedit.spec.ts`. It marks a sentence excluded via the exposed store, then asserts the selection popover is suppressed (with a non-excluded positive control). The selection targets the INNER `[data-text-offset]` text node — that is what `useSentenceSelection` reads.

```ts
/* fs-58 Unit B (#1122) — an excluded (flag_nonstory) line offers no split/
 * reassign affordance. jsdom can't drive getSelection/elementFromPoint, so the
 * gate is proven here. */
import { test, expect } from '@playwright/test';

type Store = { dispatch: (a: unknown) => void };

async function selectSentenceText(page: import('@playwright/test').Page, sentenceId: number) {
  await page.evaluate((id) => {
    const inner = document.querySelector(`[data-sentence-id="${id}"] [data-text-offset]`);
    const textNode = inner?.firstChild;
    if (!textNode) throw new Error(`no text node for sentence ${id}`);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, (textNode as Text).length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, sentenceId);
}

test.describe('fs-58 Unit B — excluded line: no edit affordance', () => {
  test.describe.configure({ mode: 'serial' });

  test('no selection popover on an excluded line; present on a normal line', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({ timeout: 10_000 });

    // Mark sentence id:1 in the current chapter (3) excluded via the store.
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      store.dispatch({ type: 'manuscript/setSentenceExcluded', payload: { chapterId: 3, sentenceId: 1, excluded: true } });
    });
    await expect(page.locator('[data-sentence-id="1"]').first()).toHaveClass(/line-through/);

    // (a) Selecting the excluded line shows NO popover.
    await selectSentenceText(page, 1);
    await expect(page.getByText('Assign selection to')).toHaveCount(0);

    // Positive control: a normal line (id:3 is a seeded ch3 sentence) DOES show it.
    await selectSentenceText(page, 3);
    await expect(page.getByText('Assign selection to')).toBeVisible();
  });
});
```

- [ ] **Step 11: Run the e2e and verify it passes**

Run: `npm run test:e2e -- manuscript-excluded-line-noedit`
Expected: PASS. If the positive control can't find a normal sentence at id:3, inspect the seeded ch3 sentences (`window.__store__.getState().manuscript.sentences`) in headed mode (`--headed --debug`) and pick a present non-excluded id. The drag-candidate half is NOT scripted here (real boundary-drag negative assertions are flaky); it is covered by the predicate unit test (Step 1) plus manual acceptance — see the spec's Testing section.

- [ ] **Step 12: Commit**

```bash
git add src/views/manuscript.tsx src/views/manuscript.test.tsx e2e/manuscript-excluded-line-noedit.spec.ts
git commit -m "fix(frontend): no split/drag affordance on excluded manuscript lines (#1122)"
```

---

### Task 6: Docs, full verify, and ship

**Files:**
- Modify: `docs/superpowers/specs/2026-06-25-fs58-unit-b-polish-design.md` (status + Ship notes)
- Modify: the fs-58 regression plan/feature doc (note the polish items closed) and `docs/features/INDEX.md` if a row needs updating
- Modify: `docs/BACKLOG.md` only if #1122 has a row (it is a `type:chore`; confirm before editing)

- [ ] **Step 1: Run the full pre-push battery**

Run: `npm run verify`
Expected: typecheck + all unit suites + e2e + build all green (e2e includes the new spec).

- [ ] **Step 2: Update the spec status + Ship notes**

Set frontmatter `status: stable` and fill the **Ship notes** section with the date (2026-06-25) and the squash/merge SHA once known. If the fs-58 plan under `docs/features/` references Unit B follow-ups, add a one-line "polish items #1122 closed" note there.

- [ ] **Step 3: Commit docs**

```bash
git add docs/
git commit -m "docs(docs): mark fs-58 Unit B polish shipped (#1122)"
```

- [ ] **Step 4: Open the PR**

Push and open a PR titled `chore(frontend): fs-58 Unit B polish — excluded-line split/drag + minor cleanups`. Body: enumerate the four items as a mini-release-note, link the spec, and put `Closes #1122` in the body. CI is opt-in — add the `run-ci` label if a clean-room cloud check is wanted before merge.

---

## Self-Review

**Spec coverage:**
- Item 1 (split + drag disable) → Task 5 (predicate + popover gate + assignSelectionTo guard + onMove guard + e2e). ✓
- Item 2 (reattribute-to-existing test) → Task 1 (routing tests). ✓
- Item 3 (catch + toast, both create flows) → Task 3 (sidebar) + Task 4 (script-review batch). ✓
- Item 4 (`type="button"` + drop `_roster`) → Task 1 (buttons) + Task 2 (param). ✓
- Spec "extract a pure predicate" + "new Playwright e2e" + "predicate unit test" → Task 5. ✓
- Spec idempotency note for partial failure → Task 4 Step 3 comment. ✓

**Placeholder scan:** No TBD/TODO; every code step shows the exact code. The only deferred detail is the e2e positive-control sentence id, which carries a concrete fallback procedure (Step 11), not a placeholder.

**Type consistency:** `isExcludedSentenceId(sentences, chapterId, sentenceId): boolean` is defined in Task 5 Step 3 and consumed identically in Step 5 and the Task 5 Step 1 test. `notificationsActions.pushToast({ kind, message, dedupeKey })` is used identically in Tasks 3 and 4. `dispatchAcceptedOps` drops to 4 params consistently across signature (Task 2 Step 1) and call site (Step 2).
