---
status: active
shipped: null
owner: null
---

# Cross-device finished sync — PR1: web auto-finish + manifest index fields; PR2: companion pull + push

> Status: active
> Key files: `src/store/continue-listening-slice.ts`, `src/components/layout.tsx`, `src/components/mini-player.tsx`, `src/views/book-library.tsx`, `server/src/workspace/sync-manifest.ts`, `server/src/routes/library-sync-manifest.ts`, `openapi.yaml`, `src/lib/api-types.ts`
> URL surface: `#/` (Books view Continue-listening rail) — indirect; `#/<bookId>/listen` (player)
> OpenAPI ops: `GET /api/library/sync-manifest` (index mode); `POST /api/books/{bookId}/shelf-status` (existing — now called by auto-finish)

Related plans: [213 — Continue-listening shelf controls](213-continue-listening-shelf-controls.md) (upstream fs-15); [app-14 — Companion finished shelf](app-14-continue-listening-finished.md) (companion side); [188 — Android companion app](188-android-companion-app.md) (umbrella). Refs [#952](https://github.com/dudarenok-maker/Castwright/issues/952).

## Benefit / Rationale

- **User:** finishing a book on the web automatically removes it from the Continue-listening rail without any manual action. It does not flicker back (optimistic dismiss guard). On the next library visit, a phone-finished book also leaves the web shelf (best-effort, server-derived).
- **Technical:** auto-finish fires a single `POST /shelf-status` with `{finished:true}`, reusing the existing shelf-status endpoint from plan 213 — no new endpoint, no `listenedAt` write. The dismiss guard makes the optimistic remove durable even if the POST fails.
- **Architectural:** the manifest index now carries additive `finished?`/`hidden?` booleans that future companion consumers can use to exclude finished/hidden books from their own shelves without a separate API call. `SYNC_MANIFEST_SCHEMA` stays `1` (additive fields are optional, not a schema bump). PR2 wires the companion to consume and push these fields.

## Architectural impact

**New seams / extension points:**

- `dismissedIds: string[]` on `ContinueListeningState` — an optimistic in-memory exclude list populated by `dismiss(bookId)` and cleared by `undismiss(bookId)`. `selectContinueListening` filters both `items` and `dismissedIds` in one selector.
- `undismiss(bookId)` action — added to the continue-listening slice purely as a recovery path when `setShelfStatus` POST fails; fires inside `handleShelfStatus` on the catch branch.
- `onCrossedFinish` callback on `MiniPlayer` — called once per chapter when the player crosses the final-10-second threshold OR the `ended` event fires (whichever comes first). A `useRef` de-dupes double-fire within the same chapter open.
- `SyncManifestIndexEntry.finished?` / `.hidden?` — additive optional booleans on the index row. Both are omitted (not `false`) when falsy.
- Route (`library-sync-manifest.ts`) reads `listen-progress.json` per book during the index walk, extracts `finished`/`hidden`, and passes them to `buildSyncManifestIndex`.

**Invariants preserved:**

- `SYNC_MANIFEST_SCHEMA = 1` is unchanged. Additive optional fields are not a schema version bump (the companion's schema-version guard passes unchanged).
- `listen-progress.json` is not written by any PR1 code path — `finished`/`hidden` are read from the existing `POST /shelf-status` side effect (plan 213). PR1 adds no new writes.
- `dismissedIds` is in-memory only (not persisted to Redux Persist / local storage). A page reload re-hydrates the rail from the server, which by then reflects the POST result.
- The auto-finish check is guarded to the **final listenable chapter** only — defined as the last chapter in the book's chapter list where `!excluded && state === 'done' && parseDuration(duration) > 0`. Non-final chapters crossing the tail do NOT trigger dismiss or the `setShelfStatus` call.

**Migration story:**

- No data shape change. `listen-progress.json` schema is unchanged; `finished`/`hidden` already existed as plan-213 fields that the new route reads additively.
- OpenAPI `SyncManifestIndexEntry` gains two optional boolean fields (`finished`, `hidden`). Clients that ignore unknown fields are unaffected; the companion's existing sync contract is unchanged until PR2.

**Reversibility:**

- Remove `dismissedIds` + `undismiss` from the slice, remove `onCrossedFinish` from `MiniPlayer`, remove the auto-finish effect from `Layout` → behavior reverts to manual-only shelf management. The manifest index fields remain (additive, backward-compatible).

## Invariants to preserve

- `selectContinueListening` in `src/store/continue-listening-slice.ts` filters `items` to exclude entries whose `bookId` is in `dismissedIds`; a book whose dismiss POST succeeds stays excluded on next hydrate via the server's `finished` flag.
- `undismiss(bookId)` removes the id from `dismissedIds`; it is the only action that does so. Called exclusively in the `catch` of `handleShelfStatus` in `src/views/book-library.tsx`.
- The auto-finish check in `src/components/layout.tsx` fires only when `event.chapterId === lastListenableChapterId` (where `lastListenableChapterId` is derived from the book's chapter list with the final-listenable predicate). Non-final chapters are explicitly skipped.
- `onCrossedFinish` in `src/components/mini-player.tsx` fires at most once per `openBook` call — guarded by a `useRef` (`crossedFinishRef.current`) that is reset when the chapter changes.
- `buildSyncManifestIndex` in `server/src/workspace/sync-manifest.ts` only spreads `{ finished: true }` / `{ hidden: true }` when the flag is truthy; falsy values are omitted (not emitted as `false`).
- `SYNC_MANIFEST_SCHEMA` in `server/src/workspace/sync-manifest.ts` remains `1`.

## Test plan

### Automated coverage

- **Vitest server** (`server/src/workspace/sync-manifest.test.ts`) — asserts `finished`/`hidden` carry through the index when truthy; asserts falsy fields are omitted from the entry (`'hidden' in b1` is `false` etc.).
- **Vitest frontend** (`src/store/continue-listening-slice.test.ts`) — asserts `dismiss` removes the matching book and records its id in `dismissedIds`; asserts `undismiss` removes the id; asserts `selectContinueListening` excludes dismissed books; asserts `hydrate` replaces items but preserves `dismissedIds` (self-terminating: a dismissed book that appears in the next hydrated list is still excluded).
- **Vitest frontend** (`src/views/book-library.test.tsx`) — asserts the `applyShelfStatus` failure recovery: after a failed `POST /shelf-status`, `undismiss` fires and the card reappears on the shelf; `dismissedIds` is empty after recovery.
- **Vitest frontend** (`src/components/mini-player.test.tsx`) — asserts `onCrossedFinish` fires when the player crosses the final-10-second tail (`timeupdate`); asserts it also fires on the `ended` event if the tail did not trigger first; asserts it does NOT double-fire when both the tail and `ended` occur.
- **Vitest frontend** (`src/components/layout.test.tsx`) — asserts that reaching the final listenable chapter's tail dispatches `continueListeningActions.dismiss(bookId)` AND calls `api.setShelfStatus(bookId, { finished: true })` exactly once; asserts that the same tail event on a NON-final chapter dispatches neither.
- **Playwright e2e** (`e2e/finish-last-chapter-clears-rail.spec.ts`) — in mock mode: plays to the end of a book's last chapter via a `timeupdate` event, asserts the Continue-listening rail card for that book disappears, and asserts `api.setShelfStatus` was called with `{ finished: true }`.

### Manual acceptance walkthrough

Run against the full stack (`npm start`) with at least one book that has a generated last chapter.

1. **Cold boot at `#/`** — the Continue-listening rail shows the in-progress book. Note the book card.

2. **Navigate to the listen view for that book** → `#/<bookId>/listen`. Select the last chapter.

3. **Play to the final 10 seconds** (or seek there). Within those 10 s:
   - The `onCrossedFinish` callback fires in `MiniPlayer`.
   - `Layout` dispatches `dismiss(bookId)` → the book card disappears from the Continue-listening rail optimistically.
   - `POST /api/books/{bookId}/shelf-status` with `{ finished: true }` fires once (visible in browser DevTools network tab or server logs).

4. **Navigate back to `#/`** — the book card is gone from the rail. It does not flicker back.

5. **Cross-device note (best-effort, server-derived):** if a phone finishes a book via the companion (Branch 1 / app-14), the server's `listen-progress.json` gains `finished: true`. On the next web library visit, `GET /api/library/continue-listening` reads that flag (plan 213 `isFinished`/`isEffectivelyComplete`) and excludes the book from the rail. No real-time push — the exclusion lands on next page load/poll.

6. **Failure recovery (optional manual check):** in DevTools, throttle network to Offline. Mark a book as finished via the ⋯ menu → **Mark as finished**. The card disappears optimistically. Re-enable network. After the POST fails (observe error in DevTools), the card reappears and `dismissedIds` is empty (verify via Redux DevTools).

## Out of scope

- **Cross-device real-time push:** finishing on the web does not push via WebSocket or SSE to other devices. The companion learns about it on the next delta sync.
- **Companion consuming `finished`/`hidden` from the manifest index:** the companion's sync loop does not yet read these fields to update its local Drift DB. That is PR2 (see follow-up below).
- **Companion pushing finish/hide to the server:** calling `POST /shelf-status` from the companion on book completion or long-press remove is PR2. Branch 1 (app-14) keeps this on-device only.
- **`listenedAt` field:** the web auto-finish signals via `POST /shelf-status`, NOT via `PUT /listen-progress`. No `listenedAt` timestamp is written by PR1. The companion's `listenedAt` reconcile (plan 188 `srv-34`) is unchanged.

---

## PR2: Companion pull + push (cross-device finished sync)

> Key files (companion): `apps/android/lib/data/database.dart` (schema 6→7, `Books.finished` column), `apps/android/lib/data/book_repository.dart` (`setBookSyncState`, `listBooks`, `markPlayed`, `markBookFinished`, `clearBookFinished`), `apps/android/lib/sync/library_sync.dart` (manifest index parse, `_refresh`), `apps/android/lib/data/api_client.dart` (`setShelfStatus`), `apps/android/lib/player/player_controller.dart` (`bookCompletedStream`, `bookReplayedStream`), `apps/android/lib/sync/resume_reconcile.dart` (UTC timestamp compare).
> OpenAPI ops: `POST /api/books/{bookId}/shelf-status` (called from companion on auto-finish, long-press remove, and replay un-finish).

### Companion architectural impact

**Pull (server → companion):**

- `Books` Drift table gains a `finished` boolean column (schema version 6 → 7, migration in `database.dart`). `BookSummary` and `ShelfBook` expose `finished`.
- `setBookSyncState(bookId, {finished, hidden})` persists both flags atomically into Drift, called from the manifest index walk in `library_sync.dart`.
- During manifest index load, `library_sync.dart` parses `finished` and `hidden` from each `SyncManifestIndexBook` entry and calls `setBookSyncState`. The Continue-listening shelf filter in `listBooks()` excludes books where `inProgress && !hidden && !finished`.
- After the server pull completes, `_refresh` re-queries `listBooks()` and rebuilds the shelf, so pulled finished/hidden state is visible on the next library visit without a separate trigger.
- `markPlayed` clears `hidden` on open — a manually-removed book that is reopened will not spuriously un-finish on later replay.

**Push (companion → server):**

- `ApiClient.setShelfStatus(bookId, {finished, hidden})` issues `POST /api/books/{bookId}/shelf-status` best-effort (errors are swallowed; the local Drift state is the source of truth).
- On auto-finish (`PlayerController.bookCompletedStream`), the companion POSTs `{finished: true}`.
- On long-press "remove from shelf", the companion POSTs `{hidden: true}`.

**Un-finish on genuine replay:**

- `PlayerController.bookReplayedStream` emits only on a genuine **backward** chapter navigation — not on initial restore, not on forward auto-advance. This is the un-finish signal.
- The runtime gates un-finish on `isBookFinished`, defined as `books.finished || books.hidden`. The `hidden` flag is the **local-finish signal** that `markBookFinished` writes before any server pull, so a same-device "finish then replay" cycle un-finishes correctly without first round-tripping through a server pull.
- `clearBookFinished` clears **both** `finished` and `hidden` so a replayed book returns to the Continue-listening shelf.
- The companion then POSTs `{finished: false}` to the server.

**Reconcile fix:**

- `resume_reconcile.dart` previously compared `listenedAt`/`updatedAt` as raw ISO 8601 strings. Timezone suffix and sub-second formatting differences silently dropped valid pushes. The fix parses both sides as UTC instants (`DateTime.parse(...).toUtc().compareTo(...)`) before comparing.
- The companion now stamps `listenedAt` as UTC (`DateTime.now().toUtc().toIso8601String()`), so future comparisons are always timezone-consistent.

### PR2 invariants to preserve

- `listBooks()` shelf filter excludes books where `inProgress && !hidden && !finished`; books that are `finished` or `hidden` do not appear on the Continue-listening shelf.
- `isBookFinished` uses `books.finished || books.hidden` (not `books.finished` alone) so that a same-device finish (which writes `hidden` before a server pull arrives) gates the un-finish check correctly.
- `clearBookFinished` clears both `finished` and `hidden` columns atomically; after a genuine backward replay the book is neither finished nor hidden locally and returns to the shelf.
- `markPlayed` clears `hidden` on open so a long-press-removed book that is reopened is not treated as finished.
- `bookReplayedStream` fires ONLY on backward chapter navigation (initial restore and forward auto-advance must not emit).
- `setShelfStatus` failures are swallowed; local Drift state is not rolled back on POST failure.
- UTC timestamp comparison in `resume_reconcile.dart` uses `DateTime.parse(...).toUtc().compareTo(...)` for both sides.

### PR2 automated coverage

- **Flutter unit tests** (`apps/android/test/`) — schema migration 6→7 round-trip; `setBookSyncState` persists both flags; `listBooks` excludes `finished` and `hidden` books from the shelf; `markBookFinished` writes `hidden: true`; `clearBookFinished` clears both flags; `markPlayed` clears `hidden`; `isBookFinished` returns true for both `finished` and `hidden`; `bookReplayedStream` emits only on backward navigation, not on restore or forward advance; `resume_reconcile` UTC parse comparison correctly orders timestamps that differ only by timezone suffix.

### PR2 manual acceptance walkthrough

Run against the full stack (`npm start`) with a real Android device or emulator running the companion, connected to the server over LAN.

1. **Web → phone (pull):** finish a book on the web (play the final listenable chapter to its last ~10 s and let it auto-dismiss). On the phone, open the Library. The book is gone from the Continue-listening shelf. (The pull happens on library entry via `_refresh`.)

2. **Phone → web (push):** long-press a book on the phone to "remove from shelf". The companion POSTs `{hidden: true}` best-effort. On the next web library visit (or page reload), the book is absent from the Continue-listening rail.

3. **Replay un-finish (either device):** open a finished book on either device and jump **back** to an earlier chapter (genuine backward navigation). The book returns to the Continue-listening shelf on the local device and the server receives `POST /shelf-status {finished: false}`. On the next sync/visit on the other device, the book reappears on its shelf.

4. **Reinstall / fresh device:** after a fresh install and first sync, the companion shelf correctly reflects the `finished`/`hidden` state pulled from the server manifest index — books finished on the web are absent; books in progress appear.

---

## Ship notes

(Filled in when status flips to `stable`.)
