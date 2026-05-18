---
status: stable
shipped: 2026-05-18
owner: null
---

# Listening progress / resume bookmarks

> Status: stable
> Key files: `src/store/listen-progress-slice.ts`, `src/components/mini-player.tsx`, `src/views/listen.tsx`, `src/components/layout.tsx`, `src/lib/api.ts`, `server/src/routes/book-state.ts`, `server/src/workspace/paths.ts`, `openapi.yaml`
> URL surface: `#/books/<id>/listen` (no router grammar change)
> OpenAPI ops: `GET /api/books/{bookId}/listen-progress`, `PUT /api/books/{bookId}/listen-progress`

## Benefit / Rationale

- **User:** the single feature audiobook users expect to "just work" — close the app at 1:23 into chapter 3, come back later, get a "Resume at 1:23" pill and one-click playback that picks up where you left off. Pre-plan-47 the mini-player only carried `currentSec` in React state, so a reload reset every chapter to 0 and trained the user not to refresh.
- **Technical:** the bookmark lives in a sibling `.audiobook/listen-progress.json` — separate from `state.json` so plan 27's schema-versioning seam stays load-bearing on the file that actually matters. The new file is cheap to re-derive on loss (worst case: the user loses one chapter's resume point), so it stays on bare `writeJsonAtomic` without the rotating-backup contract.
- **Architectural:** the slice is server-authoritative — frontend never persists it via redux-persist. That keeps a stale rehydrate from clobbering a fresh server write. The defensive `selectListenProgress` selector means existing test stores composed before plan 47 don't need per-test fixups.

## Architectural impact

- **New seams / extension points:**
  - `listenProgressSlice` (`src/store/listen-progress-slice.ts`) — state `{ byBook: Record<bookId, { chapterId, currentSec, updatedAt }> }`; reducers `hydrate / update / clear`; curried defensive `selectListenProgress(bookId)`.
  - `api.getListenProgress(bookId)` + `api.putListenProgress(bookId, { chapterId, currentSec })` on both real and mock surfaces (`src/lib/api.ts`).
  - Server route + path helper: `GET / PUT /api/books/{bookId}/listen-progress` on `bookStateRouter`; `listenProgressJsonPath(bookDir)` in `server/src/workspace/paths.ts`.
  - `openapi.yaml` declares the two operations + a new `ListenProgress` schema; regen via `npm run openapi:types` lands in `src/lib/api-types.ts`.
- **Invariants preserved:**
  - Plan 27 (book-state persistence + schema versioning): unchanged. listen-progress.json is sibling JSON; doesn't touch state.json's rotating-backup contract.
  - Plan 25 (design tokens): the Resume pill uses the existing `<Pill color="library">` primitive — no hex literals.
  - Plan 26 (RTK Immer drafts): slice reducers mutate via Immer.
  - Plan 24 (OpenAPI source of truth): GET / PUT both declared before code lands.
  - Plan 46 (lint baseline): `npm run lint --max-warnings 0` passes; no new eslint-disable comments.
- **Migration story:** none — books with no `listen-progress.json` get a null GET response and the slice carries no entry for them. The Listen view's pill simply doesn't render. First save creates the file.
- **Reversibility:**
  - Delete `src/store/listen-progress-slice.ts` + the API methods + the server route → the mini-player falls back to the legacy "seek to 0" path; the Resume pill goes away.
  - Existing `listen-progress.json` files on disk become inert (no reader); they're cheap to ignore or rm.

## Invariants to preserve

1. **Resume seek MUST happen in `onLoadedMetadata`, not the `audio.url` effect.** `mini-player.tsx:228-248` — setting `el.currentTime` before metadata loads is unreliable across browsers (Chrome queues, Safari sometimes drops, the `el.load()` call resets currentTime to 0 internally). The seek runs once duration is known, capped at `d - 1` so a resume parked near the end of the chapter doesn't immediately fire `onEnded`.
2. **Debounced save fires at most once per 5 s wall-clock AND ignores positions ≤ 5 s.** `mini-player.tsx:200-218` — the 5 s gate (`lastSavedAtRef` throttle) caps the request rate so a 60-min chapter generates ~720 PUTs not 36000; the ≥ 5 s position gate stops accidental click-and-close from polluting the resume point.
3. **Final flush on chapter switch / unmount uses `currentSecRef.current`, not the React `currentSec` state.** `mini-player.tsx:88-103` — the cleanup closure captures variables at render time; reading the state would see whatever value was current when the chapter mounted (often 0). The ref carries the live tick value.
4. **The Listen view's Resume pill renders inline inside the title cell, not as a new grid column.** `listen.tsx:480-490` — `ChapterListenRow`'s grid is fixed at `[40px_60px_1fr_220px_100px_60px]`. Adding a seventh column would re-flow every row's layout.
5. **`selectListenProgress(bookId)` MUST return null when the slice isn't registered.** `listen-progress-slice.ts:73-78` — older test stores composed before plan 47 (cast-slice.test.ts, every component test that builds its own minimal store) shouldn't need updating. The defensive read makes the selector safe to call unconditionally.
6. **The slice MUST NOT be wrapped in `persistReducer`.** `store/index.ts` — the server file is authoritative. Persisting client-side would risk a stale rehydrate clobbering a fresh server-side write.

## Test plan

### Automated coverage

- **`server/src/routes/book-state.test.ts`** — 9 new cases on the listen-progress slice: GET returns null when the file is absent, PUT-then-GET round-trips with a server-stamped updatedAt within the request window, PUT overwrites prior records, PUT 400 on missing/non-numeric chapterId, negative currentSec, non-finite currentSec, and GET/PUT 404 when the bookId resolves to no on-disk book. Seeds its own LP_AUTHOR/LP_TITLE so the rename-block teardown doesn't yank the shared bookId.
- **`src/store/listen-progress-slice.test.ts`** — 11 pure-reducer cases: hydrate (record + null = delete), update (fresh write, overwrite, explicit updatedAt echo, multi-book isolation), clear, and `selectListenProgress` defensive paths (null bookId, missing book, absent slice).
- **`src/components/mini-player.test.tsx`** — 6 new cases pin the seek + save loop: onLoadedMetadata seeks to the resume point when the bookmark matches, does NOT seek for a different chapter id, does NOT seek inside the last second of the chapter; debounce save fires at the first onTimeUpdate past 5 s and not before; final flush on chapter switch sends the latest currentSec; no flush when playback stayed under 5 s.
- **`e2e/listen-resume.spec.ts`** — 3 browser-level specs against the Solway Bay fixture book: pill shows when bookmark exists, no pill for a different chapter, no pill under the 5 s noise floor.

### Manual acceptance walkthrough

Run in mock mode (`npm run dev` + `VITE_USE_MOCKS=true`).

1. Cold-boot at `#/` → library cards.
2. Click into a complete book → `#/books/<id>/listen` → cover header + chapter list.
3. Click play on chapter 1 → MiniPlayer appears. Wait ~10 s of mock playback.
4. Close the MiniPlayer (X). The latest position is flushed to the server.
5. Refresh the page → returns to `#/books/<id>/listen`. Chapter 1's row shows `Resume at MM:SS` matching where you closed.
6. Click play on chapter 1 → MiniPlayer remounts; its `<audio>` element seeks to the saved position once metadata loads (visible in the elapsed clock).
7. Click pause near `00:03` (below noise floor) → close → refresh. No pill (the save gate ignored the < 5 s position).
8. With chapter 1 bookmarked, click play on chapter 2 → MiniPlayer's flush fires for chapter 1, then the new chapter loads at 0:00.

## Out of scope

- Cross-device resume sync. Single-workspace assumption holds (BACKLOG Could #26 covers cross-tab `BroadcastChannel`).
- Resume-from-position e2e against real audio playback. The harness fires the resume seek + assertion through the slice, not by polling `audio.currentTime` — Playwright + Chrome's audio-decode pipeline + Windows host load isn't reliable enough for clock-dependent assertions (see the quarantined `listen-playback.spec.ts` flake under BACKLOG Could #20).
- Per-chapter resume points (one bookmark covers many chapters within the book). The plan persists one record per book; switching chapters flushes the prior bookmark before saving the new one.

## Ship notes

- Shipped 2026-05-18 on branch `feat/frontend-plan-47-listen-progress` via PR (commit SHA filled at merge).
- Eleven commits land the change:
  1. `feat(openapi): plan 47 declare listen-progress endpoints`
  2. `chore(deps): plan 47 regenerate api-types from listen-progress`
  3. `feat(server): plan 47 add listen-progress route + path helper`
  4. `test(server): plan 47 cover listen-progress get/put round-trip`
  5. `feat(frontend): plan 47 add listen-progress slice + mock api`
  6. `test(frontend): plan 47 cover listen-progress slice reducers`
  7. `feat(frontend): plan 47 wire mini-player resume seek + debounced save`
  8. `test(frontend): plan 47 cover mini-player resume + save flush`
  9. `feat(frontend): plan 47 surface resume pill on listen view + hydrate`
  10. `test(e2e): plan 47 walk resume across reopen`
  11. `docs(docs): plan 47 ship + archive`
- Hot file overlap with plan 48: both touch `src/components/layout.tsx` (mount + hydrate effect) and `src/store/index.ts` (slice registration). Plan 48 landed first per the round plan; plan 47 rebases on the updated `LayoutContext` shape (no actual context-method conflict — plan 48's `pushToast` and plan 47's slice hydrate live in different parts of the layout file).
