# Finished-sync PR 1 — Server manifest fields + Web auto-finish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web app auto-clears a book from "Continue listening" when you reach the end (no manual "Mark as finished" needed), and the sync-manifest index gains additive `finished`/`hidden` fields (consumed by PR 2's companion; harmless until then).

**Architecture:** The server already derives "finished" (`isFinished` from synced resume position) and `buildContinueListening` already excludes finished books, so the web just needs to (a) POST the authoritative `finished:true` on reaching the final *listenable* chapter, (b) optimistically drop the card with a self-terminating flicker guard, and (c) refetch the rail on return to the library (React-Router remount already does this). The server change is two additive booleans on the manifest index row, read from each book's `listen-progress.json` in the route (the pure builder stays I/O-free).

**Tech Stack:** Node/Express + TypeScript (server), Vite + React + Redux Toolkit + TypeScript (web), Vitest + RTL, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-06-20-cross-device-finished-sync-design.md` (v3.1, "PR 1" section).

## Global Constraints

- Branch: `feat/cross-device-finished-sync` (this worktree, off latest main incl. merged Batch-1 PR #953).
- Server is source of truth; do NOT add a new endpoint — finish is signalled via the existing `POST /api/books/{bookId}/shelf-status {finished:true}` (it is NOT subject to the `listenedAt` compare-and-set guard).
- Do NOT add `listenedAt` to any web `putListenProgress` call — that would activate the server PUT guard (`book-state.ts:1395`, `>=`) and can drop web progress. Routine saves stay last-write-wins.
- "Final listenable chapter" = the last chapter satisfying `!c.excluded && c.state === 'done' && parseDuration(c.duration) > 0` (mirror `src/views/listen.tsx:143`-style predicate; "no audio" on the web = `state !== 'done'`). Do NOT use positional `!nextTrackAvailable` (`layout.tsx:363`).
- `SYNC_MANIFEST_SCHEMA` stays `1` (the two new fields are additive/optional).
- No design tokens as hex literals; OpenAPI is the type source of truth (regenerate, don't hand-edit `api-types.ts`).
- TDD: failing test first, then implement, commit per task. Tests: `npm test` (frontend), `cd server && npm test` (server), `npm run test:e2e` (e2e). Match existing test harnesses; adapt the example test code to real fixtures.

---

### Task 1: Manifest index carries `finished` + `hidden` (server)

**Files:**
- Modify: `server/src/workspace/sync-manifest.ts:37-47` (`SyncManifestIndexBook`), `:105-123` (`buildSyncManifestIndex` input row type + push)
- Modify: `server/src/routes/library-sync-manifest.ts:103-110` (index row assembly: read listen-progress per book) + imports
- Test: `server/src/workspace/sync-manifest.test.ts` (pure builder), and the route test if one exists (else cover via the builder)

**Interfaces:**
- Produces: `SyncManifestIndexBook` gains `finished?: boolean` and `hidden?: boolean`; `buildSyncManifestIndex(books, since)` input rows accept optional `finished`/`hidden` and copy them through.

- [ ] **Step 1: Write the failing test** (in `sync-manifest.test.ts`):

```ts
it('carries finished + hidden flags through the index', () => {
  const idx = buildSyncManifestIndex([
    { bookId: 'b1', state: makeState('b1'), finished: true, hidden: false },
    { bookId: 'b2', state: makeState('b2'), hidden: true },
  ]);
  const b1 = idx.books.find((b) => b.bookId === 'b1')!;
  const b2 = idx.books.find((b) => b.bookId === 'b2')!;
  expect(b1.finished).toBe(true);
  expect(b2.hidden).toBe(true);
});
```
> NOTE: reuse the file's existing `makeState`/fixture helper; match its shape.

- [ ] **Step 2: Run test, verify it fails**

Run: `cd server && npx vitest run src/workspace/sync-manifest.test.ts`
Expected: FAIL — `finished`/`hidden` not on the type / not copied.

- [ ] **Step 3a: Extend the type** (`sync-manifest.ts:37-47`): add after `coverUrl?: string;`:

```ts
  /** Explicit "Mark as finished" flag from listen-progress.json (NOT the
   *  derived isFinished — durations aren't reliably loaded on the index path). */
  finished?: boolean;
  /** "Hide from shelf" flag from listen-progress.json. */
  hidden?: boolean;
```

- [ ] **Step 3b: Thread through the builder** (`sync-manifest.ts:105-123`): widen the input row type and copy:

```ts
export function buildSyncManifestIndex(
  books: ReadonlyArray<{ bookId: string; state: BookStateJson; coverUrl?: string; finished?: boolean; hidden?: boolean }>,
  since?: string,
): SyncManifestIndex {
  // ... inside the for-of, in the rows.push({...}) object, after coverUrl spread:
      ...(coverUrl ? { coverUrl } : {}),
      ...(finished ? { finished: true } : {}),
      ...(hidden ? { hidden: true } : {}),
```
(Destructure `finished`/`hidden` from the loop variable alongside `bookId, state, coverUrl`.)

- [ ] **Step 3c: Read the flags in the route** (`library-sync-manifest.ts`): add import `listenProgressJsonPath` to the existing `paths.js` import (line 21); then in the index row map (`:103-110`) read the file best-effort:

```ts
    const rows = books.map(({ bookDir, state }) => {
      let finished = false;
      let hidden = false;
      try {
        const lp = JSON.parse(readFileSync(listenProgressJsonPath(bookDir), 'utf8')) as {
          finished?: boolean; hidden?: boolean;
        };
        finished = lp.finished === true;
        hidden = lp.hidden === true;
      } catch {
        /* no listen-progress.json yet → both false */
      }
      return {
        bookId: state.bookId,
        state,
        coverUrl:
          state.coverImage && existsSync(coverImagePath(bookDir))
            ? `/api/books/${state.bookId}/cover`
            : undefined,
        ...(finished ? { finished: true } : {}),
        ...(hidden ? { hidden: true } : {}),
      };
    });
```
> `readFileSync` is already imported (line 14). Confirm `listenProgressJsonPath` is exported from `server/src/workspace/paths.js` (~:187).

- [ ] **Step 4: Run test, verify pass**

Run: `cd server && npx vitest run src/workspace/sync-manifest.test.ts`
Expected: PASS. Then `cd server && npm test` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/sync-manifest.ts server/src/routes/library-sync-manifest.ts server/src/workspace/sync-manifest.test.ts
git commit -m "feat(server): carry finished+hidden on sync-manifest index (Refs #952)"
```

---

### Task 2: OpenAPI manifest-index schema + regenerated types

**Files:**
- Modify: `openapi.yaml` (the sync-manifest index book schema — search for the `SyncManifestIndexBook`/manifest index response shape)
- Modify (generated): `src/lib/api-types.ts` (via `npm run openapi:types` — do NOT hand-edit)
- Test: typecheck (`npm run typecheck`)

**Interfaces:**
- Produces: `components['schemas'][...manifest index book...]` gains optional `finished`/`hidden` booleans, usable by PR 2.

- [ ] **Step 1: Add the fields to the schema**

In `openapi.yaml`, locate the manifest index book schema (the object with `bookId`, `updatedAt`, `chapterCount`, `coverUrl`). Add under its `properties:`:

```yaml
        finished:
          type: boolean
          description: Explicit "Mark as finished" flag (additive; absent = false).
        hidden:
          type: boolean
          description: "Hide from shelf" flag (additive; absent = false).
```
(Both optional — do NOT add to `required`.)

- [ ] **Step 2: Regenerate types**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` updated with the two optional booleans on the manifest index book.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): openapi finished+hidden on sync-manifest index (Refs #952)"
```

---

### Task 3: Web slice flicker guard (`dismissedIds`)

**Files:**
- Modify: `src/store/continue-listening-slice.ts:16-40`
- Modify (REQUIRED — won't compile otherwise): `src/store/continue-listening-slice.test.ts` — the existing `empty(): ContinueListeningState` helper (`:21`) and the `selectContinueListening({ continueListening: { items } })` literal (`:76`) must add `dismissedIds: []` once the field is required.
- Modify: `src/views/book-library.tsx:149-166` (fs-15 `applyShelfStatus` error-recovery — see [I1] below)
- Test: `src/store/continue-listening-slice.test.ts`

**Interfaces:**
- Produces: `ContinueListeningState` gains `dismissedIds: string[]`; `dismiss(bookId)` adds to it + filters items; `hydrate(items)` filters its payload through `dismissedIds` AND removes any id whose book is absent from the fresh payload (server-confirmed gone); `undismiss(bookId)` removes an id from `dismissedIds` (for the fs-15 failed-POST recovery, so a failed "Mark as finished" restores the card).

- [ ] **Step 1: Write the failing tests:**

```ts
it('hydrate keeps a dismissed book out until the server confirms it gone', () => {
  let s = reducer(undefined, actions.hydrate([item({ bookId: 'a' }), item({ bookId: 'b' })]));
  s = reducer(s, actions.dismiss('a'));
  // server still returns 'a' (POST not yet reflected) → must stay hidden
  s = reducer(s, actions.hydrate([item({ bookId: 'a' }), item({ bookId: 'b' })]));
  expect(s.items.map((i) => i.bookId)).toEqual(['b']);
  // server now omits 'a' (confirmed finished) → dismissedIds clears
  s = reducer(s, actions.hydrate([item({ bookId: 'b' })]));
  expect(s.dismissedIds).not.toContain('a');
  // and a later re-appearance of 'a' (e.g. replayed) shows again
  s = reducer(s, actions.hydrate([item({ bookId: 'a' }), item({ bookId: 'b' })]));
  expect(s.items.map((i) => i.bookId)).toEqual(['a', 'b']);
});

it('undismiss restores a card (fs-15 failed-POST recovery)', () => {
  let s = reducer(undefined, actions.hydrate([item({ bookId: 'a' })]));
  s = reducer(s, actions.dismiss('a'));
  s = reducer(s, actions.undismiss('a'));
  s = reducer(s, actions.hydrate([item({ bookId: 'a' })])); // failure refetch
  expect(s.items.map((i) => i.bookId)).toEqual(['a']);
});
```
> NOTE: the real factory is `item(over: Partial<ContinueItem>)` called as `item({ bookId: 'a' })` — match the existing test file's factory exactly.

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/store/continue-listening-slice.test.ts`
Expected: FAIL — `dismissedIds` undefined / hydrate doesn't filter.

- [ ] **Step 3: Implement:**

```ts
export interface ContinueListeningState {
  items: ContinueItem[];
  dismissedIds: string[];
}
const initialState: ContinueListeningState = { items: [], dismissedIds: [] };

// reducers:
    hydrate: (s, a: PayloadAction<ContinueItem[]>) => {
      const incomingIds = new Set(a.payload.map((i) => i.bookId));
      // An optimistically-dismissed id clears once the server omits it.
      s.dismissedIds = s.dismissedIds.filter((id) => incomingIds.has(id));
      s.items = a.payload.filter((i) => !s.dismissedIds.includes(i.bookId));
    },
    dismiss: (s, a: PayloadAction<string>) => {
      if (!s.dismissedIds.includes(a.payload)) s.dismissedIds.push(a.payload);
      s.items = s.items.filter((i) => i.bookId !== a.payload);
    },
    /** fs-15 recovery: undo an optimistic dismiss (e.g. the shelf-status POST
        failed) so the next hydrate restores the card. */
    undismiss: (s, a: PayloadAction<string>) => {
      s.dismissedIds = s.dismissedIds.filter((id) => id !== a.payload);
    },
```

Then fix the existing test helpers so the suite still compiles: `src/store/continue-listening-slice.test.ts:21` `empty()` → `({ items: [], dismissedIds: [] })`, and the `:76` literal → `{ continueListening: { items, dismissedIds: [] } }`.

- [ ] **Step 3b ([I1]): fix the fs-15 failure path.** In `src/views/book-library.tsx:149-166` (`applyShelfStatus`), the `.catch` currently re-fetches + `hydrate`s to "restore truth"; because `hydrate` now filters through `dismissedIds`, the dismissed card would stay hidden on a failed POST. Add `dispatch(continueListeningActions.undismiss(bookId))` at the start of the `.catch` (before the error toast / refetch) so the card returns. Add a regression test (in `book-library.test.tsx`) asserting a failed `setShelfStatus` restores the card.

- [ ] **Step 4: Run, verify pass** (+ full `npm test`)

Run: `npx vitest run src/store/continue-listening-slice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/continue-listening-slice.ts src/store/continue-listening-slice.test.ts src/views/book-library.tsx src/views/book-library.test.tsx
git commit -m "feat(frontend): self-terminating dismiss guard + undismiss recovery on continue-listening slice (Refs #952)"
```

---

### Task 4: Web auto-finish on reaching the final listenable chapter

**Files:**
- Modify: `src/components/mini-player.tsx` (add `onCrossedFinish?: () => void`, fire from `onTimeUpdate`/`onEnded` using live `audio.durationSec`)
- Modify: `src/components/layout.tsx` (compute final-listenable-chapter; pass `onCrossedFinish` that, when the current chapter IS the final listenable one, dispatches `continueListeningActions.dismiss(bookId)` and calls `api.setShelfStatus(bookId, { finished: true })`)
- Test: `src/components/mini-player.test.tsx` (callback fires at the tail) + `src/components/layout.test.tsx` or equivalent (dispatch+POST on final chapter only)

**Interfaces:**
- Consumes: `continueListeningActions.dismiss` (Task 3), `api.setShelfStatus` (existing — `src/lib/api.ts` `realSetShelfStatus`/`mockSetShelfStatus`), the finish tail constant (use 10s to match the companion `kFinishThreshold`; the server tail is `max(30s,2%)` so 10s is safely inside it).
- Produces: web emits `POST /shelf-status {finished:true}` exactly once when the final listenable chapter crosses into its last 10s (or `onEnded`).

- [ ] **Step 1: Write the failing tests.**
  - mini-player: simulate `onTimeUpdate` with `currentTime` within 10s of `duration` → `onCrossedFinish` called once (and not again on a second tick); `onEnded` also calls it.
  - layout: when the loaded chapter is the final listenable chapter and `onCrossedFinish` fires → `dispatch(dismiss(bookId))` and `api.setShelfStatus` called with `{finished:true}`; when it's NOT the final listenable chapter → neither fires.

```tsx
// mini-player.test.tsx (sketch — adapt to the file's existing render/util helpers)
it('fires onCrossedFinish once when within the finish tail', () => {
  const onCrossedFinish = vi.fn();
  // render MiniPlayer with onCrossedFinish + a chapter/audio of known duration
  // fire onTimeUpdate at currentTime = duration - 5
  expect(onCrossedFinish).toHaveBeenCalledTimes(1);
  // fire again at duration - 4 → still once (dedup)
  expect(onCrossedFinish).toHaveBeenCalledTimes(1);
});
```
> NOTE: the mini-player reads duration via the audio element (`audio.durationSec`/`currentTarget.duration`); match how existing tests drive `onTimeUpdate` (see the debounced-save tests ~`mini-player.tsx:896-942`). Dedup with a ref like the existing `lastSavedAtRef` pattern.

- [ ] **Step 2: Run, verify fail.**

Run: `npx vitest run src/components/mini-player.test.tsx`
Expected: FAIL — no `onCrossedFinish` prop / not called.

- [ ] **Step 3: Implement.**
  - In `mini-player.tsx`: add `onCrossedFinish?: () => void` to props; add a `crossedFinishRef = useRef(false)` reset when the chapter id changes; in `onTimeUpdate` (after the existing live-playback dispatch), compute `remaining = duration - t`; if `duration > 10 && remaining <= 10 && !crossedFinishRef.current` → set ref + call `onCrossedFinish?.()`. Also call it from `onEnded`.
  - In `layout.tsx`: **add the import** `import { continueListeningActions } from '../store/continue-listening-slice';` (it is NOT currently imported — verified). `parseDuration` is already imported (`layout.tsx:40`), and `dispatch`, `chapters`, the current chapter (`trackChapter`), and `bookId` are in scope. Compute the final listenable chapter once: `const finalListenable = [...chapters].reverse().find((c) => !c.excluded && c.state === 'done' && parseDuration(c.duration) > 0)`. Pass `onCrossedFinish={() => { if (trackChapter?.id === finalListenable?.id) { dispatch(continueListeningActions.dismiss(bookId)); void api.setShelfStatus(bookId, { finished: true }); } }}`.
> NOTE: chapter-state field is `c.state === 'done'` and `!c.excluded` per `src/views/listen.tsx:143-144` (verified); `api.setShelfStatus` is real (`src/lib/api.ts:2041`, `ShelfStatusArgs = {finished?, hidden?}`). Confirm the current-chapter variable name (`trackChapter`) against the file.

- [ ] **Step 4: Run, verify pass** (+ full `npm test`, `npm run typecheck`).

- [ ] **Step 5: Commit**

```bash
git add src/components/mini-player.tsx src/components/layout.tsx src/components/mini-player.test.tsx src/components/layout.test.tsx
git commit -m "feat(frontend): auto-finish on reaching the final listenable chapter (Refs #952)"
```

---

### Task 5: e2e — finishing the last chapter clears the rail

**Files:**
- Create/modify: `e2e/` spec (mock mode) — a Playwright test that plays to the end of the last chapter and asserts the book leaves the Continue-listening rail.
- Test: `npm run test:e2e`

- [ ] **Step 1: Write the spec.** In mock mode, open a book, drive playback to the final listenable chapter's end (seek near the end / fire ended via the mock), return to the library, assert the book's continue-listening card is gone. Mirror an existing `e2e/responsive/*.spec.ts` or listen-view spec for app setup + mock data.
> NOTE: confirm the mock `setShelfStatus` (`mockSetShelfStatus`) + mock continue-listening reflect the finish so the rail updates; if the mock rail is static, assert the optimistic `dismiss` removed the card (the user-visible outcome).

- [ ] **Step 2: Run, verify it fails** on `main`-behaviour (book still present) before Task 4, or passes after Task 4.

Run: `npm run test:e2e -- e2e/<spec>.spec.ts`

- [ ] **Step 3: Commit**

```bash
git add e2e/
git commit -m "test(e2e): finishing last chapter clears the continue-listening rail (Refs #952)"
```

---

### Task 6: Regression doc + INDEX + full verify

**Files:**
- Create: `docs/features/fs-cross-device-finished-sync.md` (from `docs/features/TEMPLATE.md`, `status: active`) — document PR1's web auto-finish + the additive manifest fields + the manual acceptance walkthrough (finish last chapter on web → leaves rail; phone finish → shows on web's next library visit, best-effort). Note PR2 (companion) is the follow-up.
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1:** Write the regression doc + INDEX entry.
- [ ] **Step 2:** Run `npm run verify` (full battery). Expected: green.
- [ ] **Step 3: Commit**

```bash
git add docs/features/fs-cross-device-finished-sync.md docs/features/INDEX.md
git commit -m "docs(docs): regression plan for cross-device finished sync PR1 (Refs #952)"
```

---

## Self-Review
- **Spec coverage (PR1):** Part A (manifest fields) → Tasks 1-2. Part C-i (explicit finish on final listenable chapter) → Task 4. C-ii (optimistic dismiss + flicker guard) → Tasks 3-4. C-iii (rail refetch on return) → relies on existing React-Router remount (`book-library.tsx:125`) — no code task; documented in Task 6. "no `listenedAt` on web" → Global Constraint + Task 4 omits it. ✓
- **Placeholders:** test bodies are sketches with NOTEs to match real harnesses (the only honest unknowns — the web test scaffolding), not vague TODOs. ✓
- **Type consistency:** `finished`/`hidden` (manifest), `dismissedIds`, `onCrossedFinish`, `setShelfStatus({finished:true})` used consistently. ✓
