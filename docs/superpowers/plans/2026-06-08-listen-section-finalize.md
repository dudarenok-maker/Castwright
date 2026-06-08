# Listen download/handoff section finalize — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize the Listen tab's download/handoff section — wire Apple Books live, remove a stale mock banner, delete a dead mock handoff path, and fix export-progress so the modal and queue rail are one truthful, synced view that survives modal-close, navigation, and page reload.

**Architecture:** Move export-job polling out of the modal into a store-level self-driving Redux middleware (precedent: `broadcast-middleware.ts`), so every non-terminal job in the `exports` slice is polled to completion regardless of which surface (if any) is mounted. Add a server "list exports for a book" endpoint plus an on-mount rehydrate so reload-mid-export resumes. De-mock the rest of the section.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (frontend); Node/Express + Vitest (server); OpenAPI-generated types; Vitest + RTL (frontend tests), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-06-08-listen-section-finalize-design.md`

**Branch:** `feat/frontend-listen-finalize-exports` (already cut)

---

## File map

**Server**
- Modify: `server/src/routes/export.ts` — add `GET /:bookId/exports` (list).
- Test: `server/src/routes/export.test.ts` — list endpoint cases.

**Contract**
- Modify: `openapi.yaml` — add `get` under `/api/books/{bookId}/exports`.
- Regenerate: `src/lib/api-types.ts` (via `npm run openapi:types`).
- Modify: `src/lib/api.ts` — `realListBookExports` + `mockListBookExports` + both registrations.

**Store**
- Modify: `src/store/exports-slice.ts` — `exportsHydrated` action.
- Test: `src/store/exports-slice.test.ts` — `exportsHydrated`.
- Modify: `src/store/exports-middleware.ts` — `createExportPollMiddleware` poller + `exportPollMiddleware` singleton + `hydrateBookExports` thunk.
- Test: `src/store/exports-middleware.test.ts` — poller drives jobs to terminal; no resurrection; Retry advances.
- Modify: `src/store/index.ts` — register `exportPollMiddleware`.

**Modal / view wiring**
- Modify: `src/modals/export-audiobook.tsx` — remove in-modal poll; pure view.
- Modify: `src/views/listen.tsx` — Apple Books handler; drop `onSendApp`.
- Modify: `src/components/listen/listen-download-section.tsx` — Apple Books live; remove `MockedPreviewBanner`; drop `onSendApp`/`onSend`.
- Modify: `src/routes/index.tsx` — on-mount `hydrateBookExports`; drop `setHandoffApp` dispatch.

**Dead-code deletion**
- Delete: `src/modals/app-handoff.tsx`, `src/data/walkthroughs.ts`.
- Modify: `src/lib/types.ts` (remove `WalkthroughStep`), `src/store/ui-slice.ts` (remove `handoffApp`/`setHandoffApp`), `src/components/layout.tsx` (remove `AppHandoffModal` mount).

**Test updates (deletion fallout)**
- `src/store/ui-slice.test.ts`, `src/store/persist-config.test.ts`, `src/lib/use-theme.test.tsx`, `src/components/theme-toggle.test.tsx`, `src/test/a11y.test.tsx`, `src/views/listen.test.tsx`, `src/components/listen/listen-download-section.test.tsx`, `src/components/listen/listen-responsive.test.tsx`.

**E2E**
- Modify/add: an e2e spec asserting an export bar completes after navigating away and back.

---

## Task 1: Server — `GET /api/books/:bookId/exports` (list)

**Files:**
- Modify: `server/src/routes/export.ts` (add handler after the POST handler, ~line 327)
- Test: `server/src/routes/export.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/export.test.ts` (match the file's existing supertest/app setup — reuse the same `app`, `_resetExportJobs`, and book-fixture helpers already used by the POST/GET tests in that file):

```ts
describe('GET /api/books/:bookId/exports (list)', () => {
  it('returns the book’s jobs newest-first', async () => {
    // Create two exports for the same book (reuse the helper the POST tests use).
    const first = await request(app)
      .post(`/api/books/${BOOK_ID}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' })
      .expect(201);
    const second = await request(app)
      .post(`/api/books/${BOOK_ID}/exports`)
      .send({ format: 'm4b', destination: 'download' })
      .expect(201);

    const res = await request(app).get(`/api/books/${BOOK_ID}/exports`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map((j: { id: string }) => j.id);
    expect(ids).toContain(first.body.id);
    expect(ids).toContain(second.body.id);
    // newest-first: second was created after first
    expect(ids.indexOf(second.body.id)).toBeLessThan(ids.indexOf(first.body.id));
  });

  it('404s for an unknown book', async () => {
    await request(app).get('/api/books/does-not-exist/exports').expect(404);
  });
});
```

> If `export.test.ts` uses a different request harness/fixture name, adapt the three identifiers (`app`, `BOOK_ID`, `request`) to match the existing tests in that file — do not invent a new harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:server -- export`
Expected: FAIL — the GET list route 404s (Express falls through) or returns the wrong shape.

- [ ] **Step 3: Add the list handler**

In `server/src/routes/export.ts`, immediately after the POST handler closes (the `});` ending the `exportRouter.post('/:bookId/exports', …)` block, ~line 327), insert:

```ts
exportRouter.get('/:bookId/exports', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });
  await rehydrateBook(located.bookDir, located.state.bookId);
  const list = [...jobs.values()]
    .filter((j) => j.bookId === located.state.bookId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return res.json(list);
});
```

> This sits alongside `GET /:bookId/exports/:exportId` without conflict — Express distinguishes the two by segment count.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:server -- export`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/export.ts server/src/routes/export.test.ts
git commit -m "feat(server): GET /api/books/:bookId/exports list endpoint"
```

---

## Task 2: Contract — OpenAPI + generated types + api client

**Files:**
- Modify: `openapi.yaml` (under `/api/books/{bookId}/exports:`, ~line 1687)
- Regenerate: `src/lib/api-types.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the `get` operation to OpenAPI**

In `openapi.yaml`, the path key `/api/books/{bookId}/exports:` currently has only `post:` (line 1688). Add a `get:` sibling directly under the path key, before `post:`:

```yaml
  /api/books/{bookId}/exports:
    get:
      summary: List all export jobs for a book (newest-first)
      operationId: listBookExports
      description: |
        Returns every in-memory + rehydrated export job for the book,
        newest-first. Used by the Listen view to repopulate the export
        queue rail after a page reload so in-progress exports resume
        polling. Jobs that were mid-build when the server itself
        restarted have no manifest and are not returned.
      parameters:
        - { in: path, name: bookId, required: true, schema: { type: string } }
      responses:
        '200':
          description: Export jobs for this book
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/BookExportJob' }
        '404':
          description: Book not found
    post:
```

> Keep the existing `post:` block exactly as-is — you are only inserting the `get:` block above it.

- [ ] **Step 2: Regenerate types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` updates with a `listBookExports` operation; no errors.

- [ ] **Step 3: Add the API client functions**

In `src/lib/api.ts`, add `realListBookExports` next to `realGetBookExport` (~line 4695):

```ts
async function realListBookExports(bookId: string): Promise<BookExportJob[]> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/exports`);
  if (!res.ok)
    throw new Error(`List exports failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}
```

Add `mockListBookExports` next to `mockGetBookExport` (~line 4867):

```ts
async function mockListBookExports(bookId: string): Promise<BookExportJob[]> {
  await wait(40);
  return [...MOCK_EXPORT_JOBS.values()]
    .filter((j) => j.bookId === bookId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
```

- [ ] **Step 4: Register both in the api objects**

In the `real` object, after `getBookExport: realGetBookExport,` (~line 5730) add:

```ts
  listBookExports: realListBookExports,
```

In the `mock` object, after `getBookExport: mockGetBookExport,` (~line 5973) add:

```ts
  listBookExports: mockListBookExports,
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS — `api.listBookExports` is now a typed member of both objects.

- [ ] **Step 6: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts src/lib/api.ts
git commit -m "feat(frontend): listBookExports API client + OpenAPI contract"
```

---

## Task 3: Store — `exportsHydrated` action

**Files:**
- Modify: `src/store/exports-slice.ts`
- Test: `src/store/exports-slice.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `src/store/exports-slice.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { exportsSlice, exportsActions } from './exports-slice';
import type { BookExportJob } from '../lib/types';

const job = (over: Partial<BookExportJob>): BookExportJob => ({
  id: 'exp_1',
  bookId: 'b1',
  format: 'm4b',
  destination: 'download',
  status: 'in_progress',
  filename: 'x.m4b',
  sizeBytes: null,
  progress: 0,
  downloadUrl: null,
  syncPath: null,
  errorReason: null,
  createdAt: '2026-06-08T00:00:00.000Z',
  completedAt: null,
  ...over,
});

describe('exportsHydrated', () => {
  it('sets the book’s job list from a server payload', () => {
    const s0 = exportsSlice.getInitialState();
    const s1 = exportsSlice.reducer(
      s0,
      exportsActions.exportsHydrated({ bookId: 'b1', jobs: [job({ id: 'exp_2' }), job({ id: 'exp_1' })] }),
    );
    expect(s1.byBookId['b1'].map((j) => j.id)).toEqual(['exp_2', 'exp_1']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- exports-slice`
Expected: FAIL — `exportsActions.exportsHydrated` is not a function.

- [ ] **Step 3: Add the reducer**

In `src/store/exports-slice.ts`, inside `reducers`, after `exportDismissed` (line 61) add:

```ts
    /* Replace a book's job list from a server snapshot (Listen-mount
       rehydrate). On a fresh mount the slice is empty so this seeds it;
       on a revisit it reconciles to the server's authoritative set. The
       poll middleware picks up any non-terminal jobs from here. */
    exportsHydrated: (s, a: PayloadAction<{ bookId: string; jobs: BookExportJob[] }>) => {
      s.byBookId[a.payload.bookId] = a.payload.jobs;
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- exports-slice`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/exports-slice.ts src/store/exports-slice.test.ts
git commit -m "feat(frontend): exportsHydrated action for Listen-mount rehydrate"
```

---

## Task 4: Store — self-driving export poll middleware + hydrate thunk

**Files:**
- Modify: `src/store/exports-middleware.ts`
- Test: `src/store/exports-middleware.test.ts` (exists — append)

- [ ] **Step 1: Write the failing test**

Append to `src/store/exports-middleware.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { exportsSlice, exportsActions } from './exports-slice';
import { createExportPollMiddleware } from './exports-middleware';
import type { BookExportJob } from '../lib/types';

const mkJob = (over: Partial<BookExportJob>): BookExportJob => ({
  id: 'exp_1',
  bookId: 'b1',
  format: 'm4b',
  destination: 'download',
  status: 'in_progress',
  filename: 'x.m4b',
  sizeBytes: null,
  progress: 0,
  downloadUrl: null,
  syncPath: null,
  errorReason: null,
  createdAt: '2026-06-08T00:00:00.000Z',
  completedAt: null,
  ...over,
});

function makeStore(getExport: (b: string, e: string) => Promise<BookExportJob>) {
  return configureStore({
    reducer: { exports: exportsSlice.reducer },
    middleware: (gd) => gd().concat(createExportPollMiddleware({ getExport, intervalMs: 100 })),
  });
}

describe('export poll middleware', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls a started in_progress job until it reaches done', async () => {
    const getExport = vi
      .fn()
      .mockResolvedValueOnce(mkJob({ status: 'in_progress', progress: 0.5 }))
      .mockResolvedValueOnce(mkJob({ status: 'done', progress: 1 }));
    const store = makeStore(getExport);

    store.dispatch(exportsActions.exportStarted(mkJob({ status: 'in_progress', progress: 0 })));
    await vi.advanceTimersByTimeAsync(120); // tick 1 → progress 0.5
    expect(store.getState().exports.byBookId['b1'][0].progress).toBe(0.5);
    await vi.advanceTimersByTimeAsync(120); // tick 2 → done
    expect(store.getState().exports.byBookId['b1'][0].status).toBe('done');
    await vi.advanceTimersByTimeAsync(300); // no further polls after terminal
    expect(getExport).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect a job dismissed while a poll was in flight', async () => {
    const getExport = vi.fn().mockResolvedValue(mkJob({ status: 'in_progress', progress: 0.5 }));
    const store = makeStore(getExport);
    store.dispatch(exportsActions.exportStarted(mkJob({ status: 'in_progress' })));
    store.dispatch(exportsActions.exportDismissed({ bookId: 'b1', exportId: 'exp_1' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getState().exports.byBookId['b1'] ?? []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- exports-middleware`
Expected: FAIL — `createExportPollMiddleware` is not exported.

- [ ] **Step 3: Implement the poller + hydrate thunk**

In `src/store/exports-middleware.ts`, update the imports at the top to:

```ts
import type { Dispatch, Middleware, AnyAction } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import type { BookExportJob, BookExportRequest } from '../lib/types';
import { exportsActions } from './exports-slice';
```

Then append the poller + thunk to the end of the file:

```ts
/* ── Self-driving export poll middleware ───────────────────────────────
   The export modal used to be the only poller (a useEffect keyed on the
   active job id). That froze the queue-rail bars whenever the modal was
   closed or the Listen view unmounted, and meant a rail-initiated Retry
   never advanced. This middleware makes polling a store-level concern:
   whenever a non-terminal job lives in `exports.byBookId`, it polls that
   job until terminal, dispatching `exportUpdated`. The modal and the rail
   become pure views of the slice — inherently synced and truthful. */

const TERMINAL: ReadonlySet<BookExportJob['status']> = new Set(['done', 'failed', 'cancelled']);
export const EXPORT_POLL_INTERVAL_MS = 800;

interface ExportsPollableState {
  exports: { byBookId: Record<string, BookExportJob[]> };
}

const POLL_TRIGGER_ACTIONS: ReadonlySet<string> = new Set([
  'exports/exportStarted',
  'exports/exportUpdated',
  'exports/exportsHydrated',
  'exports/exportDismissed',
]);

/** Factory so tests can inject a stub `getExport` + a short interval. */
export function createExportPollMiddleware(opts?: {
  getExport?: (bookId: string, exportId: string) => Promise<BookExportJob>;
  intervalMs?: number;
}): Middleware {
  const getExport = opts?.getExport ?? ((b: string, e: string) => api.getBookExport(b, e));
  const intervalMs = opts?.intervalMs ?? EXPORT_POLL_INTERVAL_MS;

  return (store) => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const findJob = (bookId: string, exportId: string): BookExportJob | undefined =>
      (store.getState() as ExportsPollableState).exports.byBookId[bookId]?.find(
        (j) => j.id === exportId,
      );

    const stop = (exportId: string) => {
      const h = timers.get(exportId);
      if (h !== undefined) {
        clearTimeout(h);
        timers.delete(exportId);
      }
    };

    const ensure = (bookId: string, exportId: string) => {
      if (timers.has(exportId)) return;
      const tick = async () => {
        /* Dismissed between schedule and fire → no-op. */
        if (!findJob(bookId, exportId)) return stop(exportId);
        try {
          const job = await getExport(bookId, exportId);
          /* No-resurrection: dropped while the request was in flight. */
          if (!findJob(bookId, exportId)) return stop(exportId);
          store.dispatch(exportsActions.exportUpdated(job));
          if (TERMINAL.has(job.status)) return stop(exportId);
        } catch {
          /* swallow — reschedule below so a transient failure self-heals */
        }
        const cur = findJob(bookId, exportId);
        if (cur && !TERMINAL.has(cur.status)) {
          timers.set(exportId, setTimeout(tick, intervalMs));
        } else {
          stop(exportId);
        }
      };
      timers.set(exportId, setTimeout(tick, intervalMs));
    };

    const reconcile = () => {
      const byBookId = (store.getState() as ExportsPollableState).exports.byBookId;
      const live = new Set<string>();
      for (const [bookId, list] of Object.entries(byBookId)) {
        for (const job of list) {
          if (!TERMINAL.has(job.status)) {
            live.add(job.id);
            ensure(bookId, job.id);
          }
        }
      }
      for (const id of [...timers.keys()]) {
        if (!live.has(id)) stop(id);
      }
    };

    return (next) => (action) => {
      const result = next(action);
      const type = (action as AnyAction)?.type;
      if (typeof type === 'string' && POLL_TRIGGER_ACTIONS.has(type)) reconcile();
      return result;
    };
  };
}

/** Singleton wired into the store in `src/store/index.ts`. */
export const exportPollMiddleware: Middleware = createExportPollMiddleware();

/** Listen-mount rehydrate: pull the server's job list for a book and seed
    the slice. The poll middleware then advances any non-terminal rows. */
export function hydrateBookExports(bookId: string) {
  return async (dispatch: Dispatch) => {
    try {
      const jobs = await api.listBookExports(bookId);
      dispatch(exportsActions.exportsHydrated({ bookId, jobs }));
    } catch {
      /* swallow — the rail just stays empty if the list fetch fails */
    }
  };
}
```

> Keep the existing `retryExport` thunk in this file unchanged; you are adding alongside it. Update the existing import line (the file currently imports only `Dispatch` from `@reduxjs/toolkit` and `BookExportRequest` from types) — the new import block above supersedes it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- exports-middleware`
Expected: PASS (both new tests + the existing retryExport tests).

- [ ] **Step 5: Register the middleware in the store**

In `src/store/index.ts`, add the import near the other middleware imports (the file already imports from `./exports-slice`; add a sibling import):

```ts
import { exportPollMiddleware } from './exports-middleware';
```

Then in the `.concat(…)` chain (line 187-195), add `exportPollMiddleware` after `spliceRunnerMiddleware()`:

```ts
    ).concat(
      persistenceMiddleware,
      generationStreamMiddleware(getStreamRunner),
      analysisStreamMiddleware,
      castDesignMiddleware,
      broadcastMiddleware,
      queueDispatcherMiddleware(getStreamRunner),
      spliceRunnerMiddleware(),
      exportPollMiddleware,
    ),
```

- [ ] **Step 6: Verify typecheck + tests**

Run: `npm run typecheck && npm run test -- exports`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/exports-middleware.ts src/store/exports-middleware.test.ts src/store/index.ts
git commit -m "feat(frontend): store-level self-driving export poll middleware + hydrate thunk"
```

---

## Task 5: Modal becomes a pure view

**Files:**
- Modify: `src/modals/export-audiobook.tsx`
- Test: `src/modals/export-audiobook.test.tsx`

- [ ] **Step 1: Remove the in-modal poll effect**

In `src/modals/export-audiobook.tsx`, delete the poll block (lines ~229-251) — the comment `/* Poll the active job until terminal. */`, the `pollHandle` ref, and the entire `useEffect` that calls `api.getBookExport` and reschedules. Leave the `activeJob` selector (lines ~253-256) and the `activeJobId` state in place.

The deleted region is exactly:

```ts
  /* Poll the active job until terminal. */
  const pollHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const job = await api.getBookExport(bookId, activeJobId);
        if (cancelled) return;
        dispatch(exportsActions.exportUpdated(job));
        if (job.status === 'in_progress' || job.status === 'queued') {
          pollHandle.current = setTimeout(tick, 800);
        }
      } catch {
        /* keep modal open; user can dismiss manually */
      }
    };
    pollHandle.current = setTimeout(tick, 400);
    return () => {
      cancelled = true;
      if (pollHandle.current) clearTimeout(pollHandle.current);
    };
  }, [activeJobId, bookId, dispatch]);
```

- [ ] **Step 2: Clean up now-orphaned imports**

`useRef` may now be unused — if so, remove it from the React import. `api.getBookExport` is no longer called here, but `api` is still used (`createBookExport`, `cancelBookExport`, `getExportLanUrls`), so keep the `api` import. Verify `useEffect` is still used elsewhere in the file (the LAN-urls + reset + QR effects use it — keep it).

- [ ] **Step 3: Run the modal tests to see what breaks**

Run: `npm run test -- export-audiobook`
Expected: Some tests may FAIL if they relied on the modal's own poll loop. For any failing test that asserted progress advancing, update it to dispatch through a real store with `exportPollMiddleware` OR to assert the modal renders whatever `activeJob` is in the store (the modal is now a pure view). Do not re-add a poll to the modal.

> Concretely: if a test mocked `api.getBookExport` and waited for the bar to move, change it to render the modal inside a store whose `exports` slice already holds the progressing job (dispatch `exportStarted` then `exportUpdated`), and assert the rendered progress reflects the store. The poll behavior itself is now covered by `exports-middleware.test.ts` (Task 4).

- [ ] **Step 4: Run the modal tests to verify they pass**

Run: `npm run test -- export-audiobook`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modals/export-audiobook.tsx src/modals/export-audiobook.test.tsx
git commit -m "refactor(frontend): export modal is a pure view of the exports slice (poll moved to middleware)"
```

---

## Task 6: Listen-mount rehydrate wiring

**Files:**
- Modify: `src/routes/index.tsx` (the `ListenRoute` component, ~line 696)

- [ ] **Step 1: Add the hydrate effect**

In `src/routes/index.tsx`, ensure `useEffect` is imported from `react` (add it if the import list lacks it). Import the thunk near the other store imports:

```ts
import { hydrateBookExports } from '../store/exports-middleware';
```

Inside `ListenRoute` (after the `const dispatch = useAppDispatch();` line, ~line 697), add:

```ts
  /* Repopulate the export queue rail from the server on mount / book
     change so a reload mid-export resumes — the poll middleware then
     advances any non-terminal rows to completion. */
  useEffect(() => {
    void dispatch(hydrateBookExports(bookId));
  }, [dispatch, bookId]);
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the route/listen tests**

Run: `npm run test -- routes listen`
Expected: PASS (no test asserts the absence of the fetch; mock `api.listBookExports` resolves to `[]` by default in mock mode).

- [ ] **Step 4: Commit**

```bash
git add src/routes/index.tsx
git commit -m "feat(frontend): rehydrate export queue on Listen mount"
```

---

## Task 7: Apple Books → live (M4B)

**Files:**
- Modify: `src/components/listen/listen-download-section.tsx`
- Modify: `src/views/listen.tsx`
- Test: `src/components/listen/listen-download-section.test.tsx`, `src/views/listen.test.tsx`

- [ ] **Step 1: Update the section test to expect Apple Books live**

In `src/components/listen/listen-download-section.test.tsx`, add `onOpenAppleBooksExport: vi.fn()` to the `defaultProps` object (alongside the other `onOpen*Export` mocks). Then add a test:

```ts
it('renders Apple Books as a live tile that opens the export modal', async () => {
  const onOpenAppleBooksExport = vi.fn();
  renderSection({ onOpenAppleBooksExport });
  const btn = screen.getByTestId('listener-app-action-apple_books');
  expect(btn).toBeEnabled();
  await userEvent.click(btn);
  expect(onOpenAppleBooksExport).toHaveBeenCalledTimes(1);
});
```

> If `listen-download-section.test.tsx` doesn't already import `userEvent`/`screen`, add them from `@testing-library/user-event` and `@testing-library/react` matching the file's other tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- listen-download-section`
Expected: FAIL — `apple_books` is currently a disabled coming-soon tile; the prop doesn't exist.

- [ ] **Step 3: Wire the prop through the section**

In `src/components/listen/listen-download-section.tsx`:

(a) Add to `ListenDownloadSectionProps` (after `onOpenAudiobookshelfExport`):

```ts
  onOpenAppleBooksExport: () => void;
```

(b) Add to the destructure in `ListenDownloadSection({ … })`:

```ts
  onOpenAppleBooksExport,
```

(c) Pass it into `<ListenerApps …>`:

```tsx
        onOpenAppleBooksExport={onOpenAppleBooksExport}
```

(d) Add to `ListenerAppsProps`:

```ts
  onOpenAppleBooksExport: () => void;
```

(e) Add to the `ListenerApps({ … })` destructure, and to the `liveHandlers` map:

```ts
  const liveHandlers: Record<string, () => void> = {
    pocketbook: onOpenPocketBookExport,
    voice: onOpenVoiceExport,
    smart_audiobook: onOpenSmartAudiobookExport,
    bookplayer: onOpenBookplayerExport,
    audiobookshelf: onOpenAudiobookshelfExport,
    apple_books: onOpenAppleBooksExport,
  };
```

- [ ] **Step 4: Wire the handler in the Listen view**

In `src/views/listen.tsx`, in the `<ListenDownloadSection …>` props (after `onOpenAudiobookshelfExport`), add:

```tsx
        onOpenAppleBooksExport={() => setExportModal({ tab: 'download', format: 'm4b' })}
```

- [ ] **Step 5: Update the Listen view test's deferred-apps expectation**

In `src/views/listen.test.tsx`, the suite asserts which app tiles are coming-soon. Update that expectation so `apple_books` is **no longer** in the deferred/coming-soon set (the grid is now 6/6 live). If a test renders `ListenView`, ensure `onOpenAppleBooksExport` flows (it's created inside `listen.tsx`, so no new `ListenView` prop is needed — confirm the assertion targets the live `listener-app-action-apple_books` button).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- listen-download-section listen`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/listen/listen-download-section.tsx src/views/listen.tsx src/components/listen/listen-download-section.test.tsx src/views/listen.test.tsx
git commit -m "feat(frontend): wire Apple Books tile live (M4B download)"
```

---

## Task 8: Remove the stale MockedPreviewBanner

**Files:**
- Modify: `src/components/listen/listen-download-section.tsx`
- Test: `src/components/listen/listen-download-section.test.tsx` (+ any test asserting the banner copy)

- [ ] **Step 1: Find any test asserting the banner copy**

Run: `git grep -n "direct handoff to other apps"`
Expected: shows the component line + any test referencing it. Remove/replace those test assertions in the next steps.

- [ ] **Step 2: Remove the banner block**

In `src/components/listen/listen-download-section.tsx`, delete the `MockedPreviewBanner` element inside `ListenerApps` (lines ~239-242):

```tsx
      <MockedPreviewBanner>
        direct handoff to other apps is coming soon. PocketBook, Voice, Smart AudioBook Player,
        BookPlayer, and Audiobookshelf are live — click any to sideload.
      </MockedPreviewBanner>
```

Then remove `MockedPreviewBanner` from the import from `'../primitives'` (line ~25) — verify it has no other use in this file with `git grep -n MockedPreviewBanner src/components/listen/listen-download-section.tsx` (expected: no remaining hits after removal).

- [ ] **Step 3: Update / remove banner-copy test assertions**

For any assertion found in Step 1 that lives in `listen-download-section.test.tsx` or `listen.test.tsx`, delete the assertion (the banner is gone by design).

- [ ] **Step 4: Run the tests**

Run: `npm run test -- listen-download-section listen`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/listen/listen-download-section.tsx src/components/listen/listen-download-section.test.tsx src/views/listen.test.tsx
git commit -m "chore(frontend): remove stale mocked-preview banner from listener-apps grid"
```

---

## Task 9: Delete the dead handoff path

**Files:**
- Delete: `src/modals/app-handoff.tsx`, `src/data/walkthroughs.ts`
- Modify: `src/lib/types.ts`, `src/store/ui-slice.ts`, `src/components/layout.tsx`, `src/routes/index.tsx`, `src/views/listen.tsx`, `src/components/listen/listen-download-section.tsx`

- [ ] **Step 1: Map every reference**

Run: `git grep -n "AppHandoffModal\|handoffApp\|setHandoffApp\|WALKTHROUGH_STEPS\|WalkthroughStep\|walkthroughs\|onSendApp\|onSend"`
Expected: a finite list across the files below. Use it as your deletion checklist.

- [ ] **Step 2: Delete the two dead files**

```bash
git rm src/modals/app-handoff.tsx src/data/walkthroughs.ts
```

- [ ] **Step 3: Remove `WalkthroughStep` from types**

In `src/lib/types.ts`, remove the `WalkthroughStep` interface. (Confirm via the Step 1 grep that only the two deleted files referenced it.)

- [ ] **Step 4: Remove handoff state from the ui-slice**

In `src/store/ui-slice.ts`:
- Remove `handoffApp: ListenerApp | null;` from `UiState` (line ~39).
- Remove `handoffApp: null,` from `initialState` (line ~114).
- Remove the `setHandoffApp` reducer (lines ~254-256).
- If `ListenerApp` is now an unused import in this file, remove it from the import.

- [ ] **Step 5: Remove the AppHandoffModal mount**

In `src/components/layout.tsx`:
- Remove the `{ui.handoffApp && (<AppHandoffModal … />)}` block (lines ~1358-1364).
- Remove the `AppHandoffModal` import.

- [ ] **Step 6: Remove the `onSendApp` prop chain**

- `src/routes/index.tsx`: remove `onSendApp={(app) => dispatch(uiActions.setHandoffApp(app))}` (line ~722).
- `src/views/listen.tsx`: remove `onSendApp` from the `Props` interface (line ~35), from the destructure (line ~67), and the `onSendApp={onSendApp}` line passed to `<ListenDownloadSection>` (line ~252). Remove `ListenerApp` from the type import on line ~19 if now unused.
- `src/components/listen/listen-download-section.tsx`: remove `onSendApp` from `ListenDownloadSectionProps`, from the destructure, and the `onSend={onSendApp}` passed to `<ListenerApps>`. Remove `onSend` from `ListenerAppsProps`, the `ListenerApps` destructure, and the `onSend={onSend}` passed to each `<ListenerAppCard>`. Remove `onSend`/`_onSend`/`void _onSend;` from `ListenerAppCardProps` and `ListenerAppCard`.

- [ ] **Step 7: Update deletion-fallout tests**

- `src/store/ui-slice.test.ts`: remove `handoffApp: null,` from the expected initial-state object.
- `src/store/persist-config.test.ts`: remove `'handoffApp',` from the transient-keys array assertion.
- `src/lib/use-theme.test.tsx` and `src/components/theme-toggle.test.tsx`: remove `handoffApp: null,` from their mock `ui` state objects.
- `src/test/a11y.test.tsx`: remove `onSendApp={vi.fn()}`.
- `src/views/listen.test.tsx`: remove `onSendApp: vi.fn(),` from `baseHandlers`.
- `src/components/listen/listen-download-section.test.tsx`: remove `onSendApp: vi.fn(),` from `defaultProps`.
- `src/components/listen/listen-responsive.test.tsx`: remove `onSendApp={vi.fn()}`.

- [ ] **Step 8: Verify nothing dangling**

Run: `git grep -n "AppHandoffModal\|handoffApp\|setHandoffApp\|WALKTHROUGH_STEPS\|WalkthroughStep\|onSendApp"`
Expected: **no matches** (docs/archive references are acceptable but no code/test hits).

- [ ] **Step 9: Typecheck + run affected suites**

Run: `npm run typecheck && npm run test -- ui-slice persist-config use-theme theme-toggle a11y listen`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore(frontend): delete dead mock app-handoff walkthrough path"
```

---

## Task 10: E2E — bar survives navigation, and full verify

**Files:**
- Modify/add: an e2e spec under `e2e/` (extend `e2e/exports-sync-folder.spec.ts` or add a focused spec)

- [ ] **Step 1: Add the e2e assertion**

In a Playwright spec (mock mode, the mock export ticks to `done` in ~2.4 s), add a flow: open the Listen view → click a download tile (e.g. `download-tile-m4b`) → submit the export → close the modal → assert the queue-rail row for that export reaches the "Done" state (e.g. a `done`-status row / Download action appears) without reopening the modal. Use the existing spec's selectors and harness conventions; example shape:

```ts
test('export bar completes from the queue rail after the modal closes', async ({ page }) => {
  await gotoListen(page); // reuse the spec's existing navigation helper
  await page.getByTestId('download-tile-m4b').getByRole('button').click();
  await page.getByTestId('export-audiobook-modal').getByRole('button', { name: /export|download/i }).first().click();
  await page.getByLabel('Close').click();
  // The middleware keeps polling; the rail row reaches done on its own.
  await expect(page.getByText(/done/i)).toBeVisible({ timeout: 10_000 });
});
```

> Adapt selectors/labels to what the spec already uses; the assertion that matters is **the rail completes with the modal closed**.

- [ ] **Step 2: Run the e2e spec**

Run: `npm run test:e2e -- exports`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e
git commit -m "test(e2e): export queue bar completes after modal close"
```

- [ ] **Step 4: Full verify**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green. Fix any fallout in the owning task's files (do not bypass with `--no-verify`).

- [ ] **Step 5: Update docs + ship the spec**

- Add a regression-plan entry or fold this into the section's plan under `docs/features/` if one is warranted (small/localized UI rewiring + a middleware seam — the spec + paired tests are the spec of record; a feature doc is optional). At minimum, leave the spec file in place and reference it from the PR.
- If you add a feature doc, update `docs/features/INDEX.md`.

- [ ] **Step 6: Commit any doc updates**

```bash
git add docs
git commit -m "docs(docs): note Listen section finalize + export-poll middleware"
```

---

## Self-review (completed by plan author)

- **Spec coverage:** A1 Apple Books → Task 7. A2 store buttons (no change) → no task, intentional. A3 remove banner → Task 8. A4 delete handoff → Task 9. B1 poller → Task 4. B2 modal pure view → Task 5. C1 server list → Task 1. C2 contract → Task 2. C3 hydrate (`exportsHydrated` + thunk + mount wiring) → Tasks 3, 4, 6. Testing/verification → Tasks 1-10 + Task 10 verify.
- **Placeholder scan:** no TBD/TODO; every code step shows real code; test-adaptation steps name the exact files and the exact identifiers to change.
- **Type consistency:** `exportsHydrated({ bookId, jobs })` defined in Task 3, dispatched identically in Task 4's `hydrateBookExports`. `createExportPollMiddleware`/`exportPollMiddleware`/`EXPORT_POLL_INTERVAL_MS`/`hydrateBookExports` names are consistent across Tasks 4 and 6. `listBookExports` consistent across Tasks 1, 2, 4. `onOpenAppleBooksExport` consistent across Task 7.
