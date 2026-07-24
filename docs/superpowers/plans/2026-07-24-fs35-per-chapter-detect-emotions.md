# fs-35 Per-chapter Detect-emotions Trigger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let "Detect emotions" run its two prosody passes scoped to the current chapter, alongside the existing whole-book trigger.

**Architecture:** Add an optional `chapterId` filter to the two prosody SSE routes (`annotate-emotion`, `instruct-annotation`), thread it through the api layer + `runProsodyPasses`, and reshape the manuscript-header button into a split button (per-chapter primary, whole-book behind a `⌄` disclosure) mirroring fs-58's "Review Script". The button reads the current chapter from the Redux `ui.stage`/`manuscript` store, so `manuscript.tsx` is untouched.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (frontend); Express SSE routes (server); Vitest (frontend + server); Playwright (e2e). Design of record: `docs/superpowers/specs/2026-07-24-fs35-per-chapter-detect-emotions-design.md`.

## Global Constraints

- **Commit convention:** `<type>(<scope>): <subject>`; allowed scopes: `frontend | server | sidecar | app | scripts | e2e | mocks | openapi | docs | deps | ci | ops`. Multi-scope: `feat(frontend,openapi): …`.
- **OpenAPI is the type source of truth** — after editing `openapi.yaml`, run `npm run openapi:types` to regenerate `src/lib/api-types.ts`; never hand-edit that file.
- **Discriminated-union `ui.stage`** — `currentChapterId` lives *inside* the `ready` variant; read it from there, don't flatten.
- **fill-only-empty is unchanged** — this feature only narrows *which chapters* a pass covers; it never changes how annotations apply.
- **Touch targets ≥44px on touch devices** — reuse the `min-h-11 fine-pointer:min-h-0` pattern already on these buttons.
- **Design tokens only** — no hex literals; reuse existing utility classes (`picker-surface`, `shadow-float`, `text-magenta`, `border-ink/15`).
- **Every PR links its issue** — this work is `Refs #592` (the delivering PR uses `Closes #592`).
- **Per-chapter never writes the `prosodyAnnotated` watermark** — that stays the eager auto-trigger's job (`layout.tsx`), which continues to call `runProsodyPasses` with no `chapterId`.

## Worktree setup (before Task 1)

This plan runs in the existing worktree `.claude/worktrees/feat+fs-35-per-chapter-detect-emotions` on branch `feat/fs-35-per-chapter-detect-emotions`. It has **no `node_modules`** yet. Before running any test/typecheck/build:

- [ ] **S1:** Provide dependencies. Either `npm install` in the worktree root (also activates husky), **or** junction from the main checkout. If junctioning, junction BOTH root and `server` deps (server tests + typecheck need `server/node_modules`):

```powershell
# From the worktree root, PowerShell:
New-Item -ItemType Junction -Path node_modules -Target C:\Claude\Projects\Audiobook-Generator\node_modules
New-Item -ItemType Junction -Path server\node_modules -Target C:\Claude\Projects\Audiobook-Generator\server\node_modules
```

- [ ] **S2:** Verify: `npm run typecheck` runs (compiles) — proves both junctions resolve. If it errors on missing modules, the junction is malformed; recreate it.

> No Python sidecar work here, so the venv is not needed.

---

### Task 1: Server — optional `chapterId` filter on `annotate-emotion`

**Files:**
- Modify: `server/src/routes/annotate-emotion.ts` (the `chapterIds` computation, ~lines 84–94)
- Test: `server/src/routes/annotate-emotion.test.ts`

**Interfaces:**
- Consumes: `req.body.chapterId?: number` (new optional request-body field).
- Produces: unchanged SSE contract. When `chapterId` is present, only that chapter streams `annotation` events and `result.annotatedChapters === 1`. An absent/excluded `chapterId` → the existing `no_attribution` error.

- [ ] **Step 1: Write the failing tests.** Add these two cases inside the existing `describe('POST /api/books/:bookId/annotate-emotion', …)` block in `server/src/routes/annotate-emotion.test.ts` (the file already defines `SENTENCES` = ch1{s1,s2} + ch2{s3}, the `runEmotion` hoisted mock, `parseSse`, and `writeBook`):

```ts
it('scopes the pass to a single chapter when chapterId is provided', async () => {
  writeBook(SENTENCES);
  runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> =>
    Promise.resolve({
      annotations:
        chapterId === 1
          ? [{ sentenceId: 2, emotion: 'angry' }]
          : [{ sentenceId: 3, emotion: 'sad' }],
    }),
  );

  const res = await request(app)
    .post(`/api/books/${bookId}/annotate-emotion`)
    .send({ chapterId: 2 });
  expect(res.status).toBe(200);

  // Only chapter 2 was analyzed.
  expect(runEmotion.mock.calls.map((c) => c[1])).toEqual([2]);

  const events = parseSse(res.text);
  expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 2)).toBe(true);
  expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(false);
  expect(events.find((e) => e.kind === 'result')).toMatchObject({ annotatedChapters: 1 });
});

it('emits no_attribution when the requested chapterId is absent/excluded', async () => {
  writeBook(SENTENCES);
  const res = await request(app)
    .post(`/api/books/${bookId}/annotate-emotion`)
    .send({ chapterId: 999 });
  const events = parseSse(res.text);
  expect(events.some((e) => e.kind === 'error' && e.code === 'no_attribution')).toBe(true);
  expect(runEmotion).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify they fail.**

Run: `npm run test:server -- annotate-emotion`
Expected: FAIL — the scoped test sees chapters `[1, 2]` (both analyzed) because the filter doesn't exist yet.

- [ ] **Step 3: Implement the filter.** In `server/src/routes/annotate-emotion.ts`, replace the `chapterIds` computation:

```ts
    const excludedChapterIds = new Set<number>(
      located.state.chapters.filter((c) => c.excluded).map((c) => c.id),
    );
    /* fs-35 — optional per-chapter scope. When the client sends a chapterId,
       narrow the pass to that single chapter (still respecting `excluded`). An
       absent/excluded chapter yields an empty set → the existing
       no_attribution path below. Deliberately NOT a distinct no_such_chapter
       code (see the fs-35 design doc): the UI disables the per-chapter trigger
       on empty chapters, so this is unreachable through the button. */
    const scopeChapterId =
      typeof req.body?.chapterId === 'number' ? req.body.chapterId : null;
    const chapterIds = [...byChapter.keys()]
      .filter((id) => !excludedChapterIds.has(id))
      .filter((id) => scopeChapterId == null || id === scopeChapterId)
      .sort((a, b) => a - b);
```

- [ ] **Step 4: Run to verify they pass.**

Run: `npm run test:server -- annotate-emotion`
Expected: PASS (all cases, including the pre-existing ones).

- [ ] **Step 5: Commit.**

```bash
git add server/src/routes/annotate-emotion.ts server/src/routes/annotate-emotion.test.ts
git commit -m "feat(server): scope annotate-emotion to an optional chapterId"
```

---

### Task 2: Server — optional `chapterId` filter on `instruct-annotation`

**Files:**
- Modify: `server/src/routes/instruct-annotation.ts` (the `chapterIds` computation, ~lines 88–92)
- Test: `server/src/routes/instruct-annotation.test.ts`

**Interfaces:** identical contract to Task 1, on the instruct route. This route uses the `runStage3` hoisted mock and `Stage3ChapterOutput` type (already defined in its test), and the same `SENTENCES` fixture.

- [ ] **Step 1: Write the failing tests.** Add to `describe('POST /api/books/:bookId/instruct-annotation', …)` in `server/src/routes/instruct-annotation.test.ts`. Use that file's existing `runStage3` mock and mirror the annotation shape its first test already returns (e.g. `{ sentenceId, instruct }`):

```ts
it('scopes the pass to a single chapter when chapterId is provided', async () => {
  writeBook(SENTENCES);
  runStage3.mockImplementation((_m, chapterId): Promise<Stage3ChapterOutput> =>
    Promise.resolve({
      annotations:
        chapterId === 1
          ? [{ sentenceId: 2, instruct: 'sharp' }]
          : [{ sentenceId: 3, instruct: 'soft' }],
    }),
  );

  const res = await request(app)
    .post(`/api/books/${bookId}/instruct-annotation`)
    .send({ chapterId: 2 });
  expect(res.status).toBe(200);

  expect(runStage3.mock.calls.map((c) => c[1])).toEqual([2]);
  const events = parseSse(res.text);
  expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 2)).toBe(true);
  expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(false);
  expect(events.find((e) => e.kind === 'result')).toMatchObject({ annotatedChapters: 1 });
});

it('emits no_attribution when the requested chapterId is absent/excluded', async () => {
  writeBook(SENTENCES);
  const res = await request(app)
    .post(`/api/books/${bookId}/instruct-annotation`)
    .send({ chapterId: 999 });
  const events = parseSse(res.text);
  expect(events.some((e) => e.kind === 'error' && e.code === 'no_attribution')).toBe(true);
  expect(runStage3).not.toHaveBeenCalled();
});
```

> If `Stage3ChapterOutput`'s annotation type rejects `{ sentenceId, instruct }`, mirror exactly the object the file's existing first test returns from `runStage3` — the point is only *which chapter* is annotated, not the field shape.

- [ ] **Step 2: Run to verify they fail.**

Run: `npm run test:server -- instruct-annotation`
Expected: FAIL — both chapters analyzed.

- [ ] **Step 3: Implement the filter.** In `server/src/routes/instruct-annotation.ts`, apply the identical change as Task 1 Step 3 (same `scopeChapterId` const + `.filter`), with the same explanatory comment.

- [ ] **Step 4: Run to verify they pass.**

Run: `npm run test:server -- instruct-annotation`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/src/routes/instruct-annotation.ts server/src/routes/instruct-annotation.test.ts
git commit -m "feat(server): scope instruct-annotation to an optional chapterId"
```

---

### Task 3: API layer — thread `chapterId` through detect-emotions / detect-instruct + mocks + openapi

**Files:**
- Modify: `src/lib/api.ts` — `DetectEmotionsOpts`, `DetectInstructOpts`, `realDetectEmotions`, `realDetectInstruct`, `mockDetectEmotions`, `mockDetectInstruct`
- Modify: `openapi.yaml` — `annotate-emotion` requestBody
- Regenerate: `src/lib/api-types.ts` (via `npm run openapi:types`)
- Test: `src/lib/api-detect-emotions.test.ts`

**Interfaces:**
- Produces: `DetectEmotionsOpts.chapterId?: number` and `DetectInstructOpts.chapterId?: number`. When set, `real*` sends it in the POST body; `mock*` emits annotations for only that chapter and returns `annotatedChapters: 1`.

- [ ] **Step 1: Write the failing test.** In `src/lib/api-detect-emotions.test.ts`, add a case to the existing `describe('api.detectEmotions', …)`. This file stubs `fetch` via `fetchMock = vi.fn()` + `vi.stubGlobal('fetch', fetchMock)` and drives the *real* `api.detectEmotions` (unit env has mocks off), returning a stream via its own `sseResponse(frames)` helper. Assert on the fetch body:

```ts
it('forwards chapterId in the request body when provided', async () => {
  const { api } = await import('./api');
  fetchMock.mockResolvedValueOnce(
    sseResponse([JSON.stringify({ kind: 'result', done: true, annotatedChapters: 1, totalAnnotations: 0 })]),
  );
  await api.detectEmotions('b1', { chapterId: 7 });
  const [, init] = fetchMock.mock.calls.at(-1)!;
  expect(JSON.parse(init!.body as string)).toMatchObject({ chapterId: 7 });
});

it('omits chapterId from the body when not provided', async () => {
  const { api } = await import('./api');
  fetchMock.mockResolvedValueOnce(
    sseResponse([JSON.stringify({ kind: 'result', done: true, annotatedChapters: 0, totalAnnotations: 0 })]),
  );
  await api.detectEmotions('b1', {});
  const [, init] = fetchMock.mock.calls.at(-1)!;
  expect(JSON.parse(init!.body as string)).not.toHaveProperty('chapterId');
});
```

> `realDetectEmotions` is NOT exported — go through `api.detectEmotions`, which in the unit env resolves to the real fetch-based impl.

- [ ] **Step 2: Run to verify it fails.**

Run: `npm run test -- api-detect-emotions`
Expected: FAIL — body has no `chapterId`.

- [ ] **Step 3: Add `chapterId` to the opts interfaces.** In `src/lib/api.ts`:

```ts
export interface DetectEmotionsOpts {
  signal?: AbortSignal;
  model?: string;
  chapterId?: number; // fs-35 — scope the pass to one chapter
  onPhase?: (e: SubstagePhaseEvent) => void;
  // …rest unchanged
}
```

Apply the same one-line addition to `DetectInstructOpts`.

- [ ] **Step 4: Send `chapterId` in the real fetch bodies.** In `realDetectEmotions`, destructure `chapterId` and build the body so it's omitted when undefined:

```ts
async function realDetectEmotions(
  bookId: string,
  { signal, model, chapterId, onPhase, onThrottle, onAnnotation, onChapterFailed }: DetectEmotionsOpts = {},
): Promise<DetectEmotionsResult> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/annotate-emotion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(model !== undefined ? { model } : {}),
      ...(chapterId !== undefined ? { chapterId } : {}),
    }),
    signal,
  });
  // …rest unchanged
```

Apply the identical change to `realDetectInstruct` (its endpoint is `/instruct-annotation`).

- [ ] **Step 5: Make the mocks honor `chapterId`.** Rewrite `mockDetectEmotions` to scope when `chapterId` is set:

```ts
async function mockDetectEmotions(
  _bookId: string,
  { onPhase, onAnnotation, chapterId }: DetectEmotionsOpts = {},
): Promise<DetectEmotionsResult> {
  await wait(60);
  if (typeof chapterId === 'number') {
    onPhase?.({ progress: 0.5, label: 'Detecting emotions', chapterId, chapterIndex: 1, totalChapters: 1 });
    onAnnotation?.({ chapterId, annotations: [{ sentenceId: 1, emotion: 'excited' }] });
    await wait(300);
    onPhase?.({ progress: 1, label: 'Done' });
    return { annotatedChapters: 1, totalAnnotations: 1 };
  }
  // …existing whole-book 2-chapter simulation, unchanged…
}
```

Apply the analogous change to `mockDetectInstruct` (its annotation shape is `{ sentenceId, text?, instruct?, vocalization? }` — emit e.g. `{ sentenceId: 1, instruct: 'warm' }` for the scoped branch).

- [ ] **Step 6: Update `openapi.yaml`.** In the `annotate-emotion` `requestBody` schema, add the property (leave `instruct-annotation` undocumented — it has no openapi path today; adding one is out of scope):

```yaml
              properties:
                model:
                  {
                    type: string,
                    description: 'Optional analyzer model id override (matches the analysis endpoints).',
                  }
                chapterId:
                  {
                    type: integer,
                    description: 'fs-35 — scope the pass to a single chapter id. Omit for whole-book.',
                  }
```

Also append one sentence to the operation `description`: `When an optional chapterId is provided, only that chapter is annotated.`

- [ ] **Step 7: Regenerate types + run tests.**

Run: `npm run openapi:types && npm run test -- api-detect-emotions`
Expected: `api-types.ts` regenerates with no unrelated diff; tests PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/lib/api.ts src/lib/api-detect-emotions.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(frontend,openapi): thread chapterId through detect-emotions api layer"
```

---

### Task 4: Thunk — forward `chapterId` through `runProsodyPasses`

**Files:**
- Modify: `src/store/prosody-thunk.ts` — `RunProsodyPassesOpts` + the two `api.*` calls
- Test: `src/store/prosody-thunk.test.ts`

**Interfaces:**
- Produces: `RunProsodyPassesOpts.chapterId?: number`, forwarded verbatim to both `api.detectEmotions` and `api.detectInstruct`.

- [ ] **Step 1: Write the failing test.** Add to `describe('runProsodyPasses', …)` in `src/store/prosody-thunk.test.ts` (this file already mocks `api.detectEmotions`/`api.detectInstruct` and inspects their opts):

```ts
it('forwards chapterId to both passes when provided', async () => {
  const seen: Array<number | undefined> = [];
  vi.mocked(api.detectEmotions).mockImplementation(async (_id, opts: DetectEmotionsOpts = {}) => {
    seen.push(opts.chapterId);
    return EMPTY_EMOTIONS;
  });
  vi.mocked(api.detectInstruct).mockImplementation(async (_id, opts: DetectInstructOpts = {}) => {
    seen.push(opts.chapterId);
    return EMPTY_INSTRUCT;
  });

  await runProsodyPasses('book-1', { dispatch: vi.fn(), chapterId: 4 });
  expect(seen).toEqual([4, 4]);
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npm run test -- prosody-thunk`
Expected: FAIL — `seen` is `[undefined, undefined]`.

- [ ] **Step 3: Add + forward the field.** In `src/store/prosody-thunk.ts`, add `chapterId?: number;` to `RunProsodyPassesOpts`, destructure it in the function signature, and pass `chapterId` into both `api.detectEmotions(bookId, { … })` and `api.detectInstruct(bookId, { … })` opts objects (alongside `signal`).

- [ ] **Step 4: Run to verify it passes.**

Run: `npm run test -- prosody-thunk`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/store/prosody-thunk.ts src/store/prosody-thunk.test.ts
git commit -m "feat(frontend): forward chapterId through runProsodyPasses"
```

---

### Task 5: Component — per-chapter split button + adapted component tests

**Files:**
- Modify (full rewrite): `src/components/detect-emotions-button.tsx`
- Test: `src/components/detect-emotions-button.test.tsx`
- `src/views/manuscript.tsx` — **unchanged** (verify it still passes only `disabled={sentences.length === 0}`).

**Interfaces:**
- Consumes: `ui.stage.bookId`, `ui.stage.currentChapterId` (ready variant), `manuscript.sentences`, `runProsodyPasses({ chapterId })` (Task 4).
- Produces: test-ids `detect-emotions-button` (primary, per-chapter), `detect-emotions-menu-toggle`, `detect-emotions-wholebook`, plus unchanged `detect-emotions-confirm|progress|done|error`.

- [ ] **Step 1: Write/adapt the failing tests.** In `src/components/detect-emotions-button.test.tsx`:

  1. **Run tests — drop the confirm click.** In the four tests that currently do `fireEvent.click(getByTestId('detect-emotions-button'))` **then** `fireEvent.click(getByTestId('detect-emotions-confirm'))` — namely *"confirms, runs, applies…"*, *"Cancel aborts…"*, *"clears the prosody stream in finally…"*, and *"renders chapter count + …ETA…"* — **delete the `detect-emotions-confirm` click line**. The primary click alone now starts the (per-chapter) run.
  2. **Confirm-dialog test — go via the menu.** In *"confirm dialog mentions that text will change"*, replace the single `click(detect-emotions-button)` with:

```ts
fireEvent.click(screen.getByTestId('detect-emotions-menu-toggle'));
fireEvent.click(screen.getByTestId('detect-emotions-wholebook'));
```
then keep the existing `getByRole('dialog', { name: /Detect emotions/i })` assertion.

  3. **Add two new tests:**

```ts
it('primary runs the current chapter only (forwards its chapterId to both passes)', async () => {
  const chapterIds: Array<number | undefined> = [];
  detectEmotions.mockImplementation((_id: string, opts?: any) => {
    if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
    chapterIds.push(opts.chapterId);
    return Promise.resolve({ annotatedChapters: 1, totalAnnotations: 1 });
  });
  detectInstruct.mockImplementation((_id: string, opts?: any) => {
    if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
    chapterIds.push(opts.chapterId);
    return Promise.resolve({ annotatedChapters: 1, totalAnnotations: 1 });
  });
  const store = makeStore(); // ui.stage.currentChapterId === 1, one sentence in ch1
  render(<Provider store={store}><DetectEmotionsButton /></Provider>);

  fireEvent.click(screen.getByTestId('detect-emotions-button'));
  await waitFor(() => expect(screen.getByTestId('detect-emotions-done')).toBeTruthy());
  expect(chapterIds).toEqual([1, 1]);
  expect(screen.getByTestId('detect-emotions-done').textContent).toMatch(/in this chapter/i);
});

it('whole book (via the menu) runs with no chapterId', async () => {
  const chapterIds: Array<number | undefined> = [];
  detectEmotions.mockImplementation((_id: string, opts?: any) => {
    if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
    chapterIds.push(opts.chapterId);
    return Promise.resolve({ annotatedChapters: 2, totalAnnotations: 2 });
  });
  detectInstruct.mockResolvedValue({ annotatedChapters: 2, totalAnnotations: 0 });
  const store = makeStore();
  render(<Provider store={store}><DetectEmotionsButton /></Provider>);

  fireEvent.click(screen.getByTestId('detect-emotions-menu-toggle'));
  fireEvent.click(screen.getByTestId('detect-emotions-wholebook'));
  fireEvent.click(screen.getByTestId('detect-emotions-confirm'));
  await waitFor(() => expect(screen.getByTestId('detect-emotions-done')).toBeTruthy());
  expect(chapterIds[0]).toBeUndefined();
});

it('primary is disabled when the current chapter has no sentences', () => {
  const store = configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer, ui: uiSlice.reducer,
      chapters: chaptersSlice.reducer, prosody: prosodySlice.reducer,
      scriptReview: scriptReviewSlice.reducer,
    },
    preloadedState: {
      manuscript: { ...manuscriptSlice.getInitialState(), sentences: [
        { id: 1, chapterId: 1, characterId: 'wren', text: 'Get down!' } as never,
      ] },
      // current chapter 2 has NO sentences
      ui: { ...uiSlice.getInitialState(), stage: { kind: 'ready', bookId: 'b1', view: 'manuscript', currentChapterId: 2 } as never },
    },
  });
  render(<Provider store={store}><DetectEmotionsButton /></Provider>);
  expect((screen.getByTestId('detect-emotions-button') as HTMLButtonElement).disabled).toBe(true);
});
```

- [ ] **Step 2: Run to verify the new/adapted tests fail.**

Run: `npm run test -- detect-emotions-button`
Expected: FAIL — no `detect-emotions-menu-toggle`; primary still opens a confirm.

- [ ] **Step 3: Rewrite the component.** Replace the entire body of `src/components/detect-emotions-button.tsx` with:

```tsx
/* fs-33 / fs-57 / fs-35 — "Detect emotions" split trigger for the manuscript
   header. Mirrors fs-58 "Review Script":
   - PRIMARY runs BOTH prosody passes (emotion backfill + instruct/vocalization)
     scoped to the CURRENT chapter, immediately — cheap/targeted, no confirm.
   - The ⌄ disclosure opens a menu whose "Detect whole book" runs both passes
     over the whole book behind the existing cost/consequence confirm popover.

   Scope comes from the store (ui.stage.currentChapterId + manuscript.sentences),
   as bookId already does — so manuscript.tsx needs no new props. Both scopes
   share one AbortController + the bookId-keyed prosody substage lock, so only
   one runs at a time. Per-chapter is manual only and never writes the
   prosodyAnnotated watermark (that stays the layout.tsx auto-trigger's job). */

import { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { DetectEmotionsError, DetectInstructError } from '../lib/api';
import {
  runProsodyPasses,
  buildProsodyProgressPayload,
  type SubstageDetail,
} from '../store/prosody-thunk';
import { prosodyActions } from '../store/prosody-slice';
import { selectAnalysisBusyForBook } from '../store/analysis-substage-selectors';
import { IconSparkle, IconArrowDn } from '../lib/icons';
import { formatSubstageDetail } from '../lib/substage-progress-text';
import { SubstageProgressPill } from './substage-progress-pill';

type Phase = 'idle' | 'confirm' | 'running';

export function DetectEmotionsButton({ disabled = false }: { disabled?: boolean }) {
  const dispatch = useAppDispatch();
  const stage = useAppSelector(
    (s) => s.ui?.stage as { bookId?: string; currentChapterId?: number | null } | undefined,
  );
  const bookId = stage?.bookId ?? null;
  const currentChapterId = stage?.currentChapterId ?? null;
  const currentChapterHasSentences = useAppSelector((s) =>
    currentChapterId == null
      ? false
      : s.manuscript.sentences.some((x) => x.chapterId === currentChapterId),
  );
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [detail, setDetail] = useState<SubstageDetail | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const busy = useAppSelector((s) => (bookId ? selectAnalysisBusyForBook(s, bookId) : false));

  // Close the ⌄ menu on an outside click (mirrors the Review Script menu).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  if (!bookId) return null;

  const run = async (scope: { chapterId?: number }) => {
    setMenuOpen(false);
    setPhase('running');
    setProgress(0);
    setDetail(undefined);
    setError(null);
    setStatus('Starting…');
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch(prosodyActions.setActive({ bookId, progress: 0, label: 'Detecting emotions' }));
    try {
      const { totalAnnotations, totalChapters } = await runProsodyPasses(bookId, {
        dispatch,
        signal: controller.signal,
        chapterId: scope.chapterId,
        onProgress: (fraction, d) => {
          setProgress(fraction);
          setDetail(d);
          dispatch(prosodyActions.updateProgress(buildProsodyProgressPayload(bookId, fraction, d)));
        },
        onStatus: (label) => setStatus(label),
        onThrottle: () => setStatus('Waiting on the analyzer rate limit…'),
      });
      const lines = `${totalAnnotations} line${totalAnnotations === 1 ? '' : 's'}`;
      setStatus(
        scope.chapterId != null
          ? `Tagged ${lines} in this chapter.`
          : `Tagged ${lines} across ${totalChapters} chapter${totalChapters === 1 ? '' : 's'}.`,
      );
      setPhase('idle');
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setStatus(null);
        setPhase('idle');
      } else if (e instanceof DetectEmotionsError && e.code === 'no_attribution') {
        setError('Run analysis first — there are no attributed lines to tag.');
        setPhase('idle');
      } else if (e instanceof DetectInstructError) {
        setError(e.message);
        setPhase('idle');
      } else {
        setError((e as Error).message);
        setPhase('idle');
      }
    } finally {
      dispatch(prosodyActions.clear({ bookId }));
      abortRef.current = null;
    }
  };

  if (phase === 'running') {
    const detailText = detail ? formatSubstageDetail(detail) : null;
    return (
      <SubstageProgressPill
        testId="detect-emotions-progress"
        detailTestId="detect-emotions-progress-detail"
        status={status ?? 'Detecting…'}
        detailText={detailText}
        percent={Math.round(progress * 100)}
        labelClassName="text-ink/70 max-w-[14rem] truncate"
        onCancel={() => abortRef.current?.abort()}
      />
    );
  }

  const primaryDisabled =
    disabled || busy || currentChapterId == null || !currentChapterHasSentences;
  const wholeBookDisabled = disabled || busy;

  return (
    <div ref={menuRef} className="relative shrink-0 inline-flex items-stretch">
      <button
        type="button"
        data-testid="detect-emotions-button"
        disabled={primaryDisabled}
        onClick={() => void run({ chapterId: currentChapterId ?? undefined })}
        title={
          primaryDisabled
            ? 'Analyse this chapter first to detect emotions'
            : 'Detect per-quote delivery emotions and natural reactions in this chapter'
        }
        className="inline-flex items-center gap-2 px-4 min-h-11 fine-pointer:min-h-0 rounded-l-full border border-ink/15 text-sm font-semibold text-ink hover:bg-ink/5 disabled:opacity-40"
      >
        <IconSparkle className="w-4 h-4 text-magenta" />
        Detect emotions
      </button>
      <button
        type="button"
        data-testid="detect-emotions-menu-toggle"
        disabled={wholeBookDisabled}
        aria-label="Detect emotions options"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
        className="inline-flex items-center justify-center px-2 min-h-11 fine-pointer:min-h-0 rounded-r-full border border-l-0 border-ink/15 text-ink/60 hover:bg-ink/5 hover:text-ink disabled:opacity-40"
      >
        <IconArrowDn className="w-4 h-4" />
      </button>

      {error && (
        <span data-testid="detect-emotions-error" className="ml-2 self-center text-xs text-magenta">
          {error}
        </span>
      )}
      {status && phase === 'idle' && !error && (
        <span data-testid="detect-emotions-done" className="ml-2 self-center text-xs text-ink/55">
          {status}
        </span>
      )}

      {menuOpen && (
        <div className="absolute top-full left-0 mt-2 z-50 w-72 rounded-2xl border border-ink/10 bg-white picker-surface shadow-float p-3 space-y-2">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/50">
            Detect scope
          </p>
          <button
            type="button"
            data-testid="detect-emotions-wholebook"
            disabled={wholeBookDisabled}
            onClick={() => {
              setMenuOpen(false);
              setPhase('confirm');
            }}
            className="w-full text-left px-3 min-h-11 fine-pointer:min-h-0 py-2 rounded-xl hover:bg-ink/5 text-sm font-medium text-ink disabled:opacity-50"
          >
            Detect whole book
            <span className="block text-xs font-normal text-ink/50">
              All included chapters — uses more analyzer quota
            </span>
          </button>
        </div>
      )}

      {phase === 'confirm' && (
        <span
          role="dialog"
          aria-label="Detect emotions"
          className="absolute z-50 left-0 top-full mt-2 w-72 rounded-xl border border-ink/10 bg-white picker-surface shadow-lg p-3 text-left"
        >
          <p className="text-xs text-ink/70 leading-snug">
            Run an LLM pass over all included chapters to detect per-quote delivery emotions and
            add natural reactions — a gasp, sigh, or laugh — to the text where the scene calls
            for it. This uses your analyzer quota and can take a few minutes on a long book.
            Hand-set emotions are never overwritten; sentences you have edited are skipped.
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPhase('idle')}
              className="px-3 py-1.5 text-xs text-ink/60 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="detect-emotions-confirm"
              onClick={() => void run({})}
              className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink/90"
            >
              Detect emotions
            </button>
          </div>
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify tests pass.**

Run: `npm run test -- detect-emotions-button`
Expected: PASS (adapted + new tests).

- [ ] **Step 5: Verify `IconArrowDn` is exported.** `grep -n "IconArrowDn" src/lib/icons.tsx` — it is already used by the Review Script menu in `manuscript.tsx`, so the import resolves. If somehow absent, use the same icon `manuscript.tsx` imports for that menu.

- [ ] **Step 6: Commit.**

```bash
git add src/components/detect-emotions-button.tsx src/components/detect-emotions-button.test.tsx
git commit -m "feat(frontend): per-chapter Detect emotions split button"
```

---

### Task 6: e2e — cover per-chapter path + adapt the five confirm-flow specs

**Files:**
- Modify: `e2e/manuscript-detect-emotions.spec.ts` (per-chapter primary + whole-book-via-menu)
- Modify: `e2e/manuscript-detect-emotions-instruct.spec.ts`, `e2e/detect-emotions-pill-progress.spec.ts`, `e2e/generate-disabled-while-analysing.spec.ts`, `e2e/prosody-auto-trigger-guard.spec.ts` (drop the now-unneeded confirm click)

**Interfaces:** in mock mode the primary click starts a per-chapter run (updated `mockDetectEmotions`/`mockDetectInstruct` from Task 3 emit for the current chapter).

> **Primary-enabled precondition:** the per-chapter primary is now disabled unless the *current* chapter has sentences (it used to gate on the whole book). `confirmCastAndReachManuscript` lands on the canned manuscript's first real chapter, which has sentences — so `toBeEnabled()` should hold. If a spec ever lands on an empty/front-matter chapter and the primary is disabled, first click a chapter row with content (the chapter list is in the sticky stats bar) before asserting enablement.

- [ ] **Step 1: Rewrite `manuscript-detect-emotions.spec.ts`.** Replace the single test with a per-chapter test (no confirm) plus a whole-book-via-menu test:

```ts
import { test, expect } from '@playwright/test';
import { goToConfirm, confirmCastAndReachManuscript } from './helpers';

test.describe('manuscript — Detect emotions (fs-33 / fs-35)', () => {
  test('primary runs the current chapter with no confirm, and the done summary shows', async ({ page }) => {
    await goToConfirm(page);
    await confirmCastAndReachManuscript(page);

    const button = page.getByTestId('detect-emotions-button');
    await expect(button).toBeVisible({ timeout: 5_000 });
    await expect(button).toBeEnabled();
    await button.click();

    // No confirm popover on the per-chapter primary — it runs immediately.
    const done = page.getByTestId('detect-emotions-done');
    await expect(done).toBeVisible({ timeout: 5_000 });
    await expect(done).toContainText(/in this chapter/i);
  });

  test('whole book via the ⌄ menu keeps the confirm popover', async ({ page }) => {
    await goToConfirm(page);
    await confirmCastAndReachManuscript(page);

    await page.getByTestId('detect-emotions-menu-toggle').click();
    await page.getByTestId('detect-emotions-wholebook').click();
    const confirm = page.getByTestId('detect-emotions-confirm');
    await expect(confirm).toBeVisible();
    await confirm.click();

    const done = page.getByTestId('detect-emotions-done');
    await expect(done).toBeVisible({ timeout: 5_000 });
    await expect(done).toContainText(/across \d+ chapter/i);
  });
});
```

- [ ] **Step 2: Adapt the four "start a run" specs.** In each of `manuscript-detect-emotions-instruct.spec.ts`, `detect-emotions-pill-progress.spec.ts`, `generate-disabled-while-analysing.spec.ts`, and `prosody-auto-trigger-guard.spec.ts`, **delete the line that clicks `detect-emotions-confirm`** (and any assertion that the confirm popover is visible). The `detect-emotions-button` click alone now starts the run; the rest of each spec's assertions (pill appears, button disabled while busy, button detaches, etc.) are unchanged. Do **not** change the disabled/not-attached assertions — they still target `detect-emotions-button`.

- [ ] **Step 3: Run the affected e2e specs.**

Run:
```bash
npx playwright test manuscript-detect-emotions manuscript-detect-emotions-instruct detect-emotions-pill-progress generate-disabled-while-analysing prosody-auto-trigger-guard --project=chromium
```
Expected: all PASS. (Requires `npx playwright install chromium` once.)

- [ ] **Step 4: Commit.**

```bash
git add e2e/manuscript-detect-emotions.spec.ts e2e/manuscript-detect-emotions-instruct.spec.ts e2e/detect-emotions-pill-progress.spec.ts e2e/generate-disabled-while-analysing.spec.ts e2e/prosody-auto-trigger-guard.spec.ts
git commit -m "test(e2e): cover per-chapter Detect emotions + adapt confirm-flow specs"
```

---

### Task 7: Docs — regression plan, release notes, INDEX

**Files:**
- Regression plan: update the active prosody / detect-emotions plan under `docs/features/` if one covers this surface (check `docs/features/INDEX.md` — e.g. the fs-33/fs-57 "Detect emotions" or prosody plan); otherwise create `docs/features/<n>-fs35-per-chapter-detect-emotions.md` from `docs/features/TEMPLATE.md`.
- `docs/features/INDEX.md` — add/adjust the entry if a plan was created/moved.
- `docs/release-notes-next.md` — technical entry, PR-refed.
- `RELEASE_NOTES.md` — one user-facing, brand-voice line in the in-progress version section at the top.

- [ ] **Step 1: Regression plan.** Document the fs-35 invariant: "Detect emotions" has a per-chapter primary (both passes scoped to the current chapter) and a whole-book option behind the `⌄` menu; the server routes accept an optional `chapterId`; per-chapter never writes the prosody watermark. Add a short manual-acceptance walkthrough (open a chapter → primary → "Tagged N in this chapter"; menu → whole book → confirm → "across M chapters").

- [ ] **Step 2: Release notes.** Append to `docs/release-notes-next.md`:

```md
- Detect emotions can now be scoped to the current chapter — the header button runs the emotion + reaction passes on just the chapter you're viewing, with whole-book still available from its ⌄ menu. (fs-35, #592)
```

And a user-facing line at the top of `RELEASE_NOTES.md`'s in-progress section, e.g.:

```md
- **Re-detect one chapter, not the whole book.** Edited a single chapter? "Detect emotions" now works on just the chapter you're reading — the whole-book pass is one click away in its menu.
```

- [ ] **Step 3: INDEX.** If a new plan file was created, add its entry under the right area in `docs/features/INDEX.md`.

- [ ] **Step 4: Commit.**

```bash
git add docs/
git commit -m "docs(docs): fs-35 regression plan + release notes"
```

---

## Final verification (before PR)

- [ ] **V1:** `npm run verify:fast:branch` (same battery pre-push runs) — lint, typecheck, config:check, test:hooks, test, test:server, build, each scope-gated to the branch diff. Expected: green.
- [ ] **V2:** Confirm `manuscript.tsx` is unchanged in the diff (`git diff main --stat -- src/views/manuscript.tsx` → empty) — the store-selector design means it must not appear.
- [ ] **V3:** Open the PR with `Closes #592`, fill Summary + Test plan, link the regression plan. Then run the mandatory `code-review` pass (medium effort — multi-scope `feat`) and fold findings before merge.

## Self-review notes (author)

- **Spec coverage:** server filter (Tasks 1–2), api+mocks+openapi (Task 3), thunk (Task 4), split-button UI + store-selector scope + scope-aware copy (Task 5), the five broken specs + per-chapter coverage (Task 6), docs (Task 7) — every spec section maps to a task.
- **Type consistency:** `chapterId?: number` is the single new field name across `DetectEmotionsOpts`, `DetectInstructOpts`, `RunProsodyPassesOpts`, the request bodies, and `openapi.yaml`. `run({ chapterId })` in the component matches the thunk opt. Test-ids `detect-emotions-menu-toggle` / `detect-emotions-wholebook` are used identically in the component (Task 5) and the e2e/unit tests (Tasks 5–6).
- **No placeholders:** every code step carries real code; test-fixture adaptations (instruct annotation shape, fetch-mock name) are flagged with the one concrete token to adjust.
