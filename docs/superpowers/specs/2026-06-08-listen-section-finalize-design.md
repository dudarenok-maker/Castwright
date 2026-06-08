# Listen tab — download/handoff section finalize (design)

- **Date:** 2026-06-08
- **Scope:** `frontend` + `server` (one cohesive change)
- **Branch:** `feat/frontend-listen-finalize-exports`
- **Related:** Listen-view decompose `docs/features/archive/60-listen-view-decompose.md`;
  download tiles `docs/features/archive/57-download-tiles.md`; export queue retry/download
  `docs/features/archive/82-export-queue-retry-download.md`; companion banner
  `docs/superpowers/specs/2026-06-08-listen-companion-app-design.md`

## Context

The Listen tab's download/handoff region (`src/components/listen/listen-download-section.tsx`)
renders four sub-regions: the Castwright Companion banner, the "Listen on your favourite app"
grid, the Export queue rail, and the "Or download a file" tiles.

A review found most of it is already real (export queue, all four download tiles, five of six
app tiles, the companion APK download), but several pieces are stale-mock or dead, and the
**export progress bars are not truthful and desync between the modal and the queue rail**.

This change finalizes the section: de-mocks the remaining surface, deletes a dead handoff path,
and fixes the export-progress architecture so the modal and queue rail are one synced, truthful
view of real server progress — including recovery after a page reload.

## Review findings (state before this change)

| Piece | State |
|---|---|
| Export queue rail | Real (live jobs from `exports` slice; fixtures only in mock mode with zero live jobs) |
| "Or download a file" tiles (M4B / MP3 ZIP / Streaming / Portable) | Real |
| 5 app tiles (PocketBook, Voice, Smart AudioBook, BookPlayer, Audiobookshelf) | Real — open the real `ExportAudiobookModal` |
| Companion APK download | Real (probes `/api/companion/apk`) |
| Companion store buttons (Google Play / App Store) | Mocked intentionally — disabled "coming soon" until the app is published |
| Apple Books tile | Coming-soon, not wired |
| `MockedPreviewBanner` atop the grid | Stale/misleading — says "handoff coming soon" but 5/6 are live |
| `AppHandoffModal` + `walkthroughs.ts` + `setHandoffApp`/`handoffApp` + the `onSendApp` prop chain | Dead, unreachable, fully-mocked walkthrough with hardcoded fake data |

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Apple Books | **Wire live (M4B)** via the generic download-tab modal, M4B preselected (same path as PocketBook) |
| Companion store buttons | **Keep coming-soon** (no change — can't be real until published; APK covers interim) |
| Stale `MockedPreviewBanner` | **Remove it** (each tile carries its own affordance) |
| Dead handoff path | **Delete all of it** (modal + walkthroughs + ui-slice state + layout mount + prop chain + tests) |
| Export-progress poller | **Store-level self-driving poller** in `exports-middleware` — modal + rail become pure views |
| Reload recovery | **Include now** — new server list endpoint + on-mount rehydrate of the rail |

## Root-cause: why the progress bars lie / desync

The server is correct — every builder streams real `onProgress(ratio)` ticks (ffmpeg `-progress`
for M4B; per-chapter for the zip/folder builders), and both the real and mock APIs report a
truthful incremental `job.progress`. The `exports` slice is shared by the modal and the rail.

**The only poller lives inside the export modal** — a `useEffect` keyed on `activeJobId` in
`src/modals/export-audiobook.tsx` is the sole caller of `getBookExport`. Consequences:

1. **Queue-rail Retry never advances.** `retryExport` dispatches `exportStarted` but starts no
   poll (no modal, no `activeJobId`); the row sits frozen at 0% / "running".
2. **Closing the modal or leaving the Listen view freezes the bar.** Unmounting the modal tears
   down the poll; the rail row freezes and never reaches "Done".
3. **Re-entering Listen doesn't resume.** Nothing re-attaches a poller to an existing in-progress
   job; reopening the modal resets `activeJobId` to null.
4. **"Not synced to the modal."** While the modal is open it's the sole driver, so the two look
   synced; the moment it isn't, they diverge in liveness.

Two confirmed constraints: the `exports` slice is **not persisted**, and there is **no
"list exports for a book" endpoint** (only GET-by-id) — so reload recovery needs a new endpoint.

## A. De-mock the section

### A1. Apple Books → live (M4B)
- `src/views/listen.tsx`: add `onOpenAppleBooksExport={() => setExportModal({ tab: 'download', format: 'm4b' })}`.
- `src/components/listen/listen-download-section.tsx`: thread the new prop into `ListenerApps`
  and add `apple_books` to the `liveHandlers` map.
- No `TILE_HINTS` entry — the generic two-tab modal with M4B preselected keeps the
  download/QR/LAN flow intact and matches the PocketBook wiring (simplicity-first). The tile
  copy already names the "drop the M4B into Books" step; no app-specific modal copy.
- Result: the grid is 6/6 live.

### A2. Companion store buttons
- No change. They remain the disabled "coming soon" pills.

### A3. Remove the stale banner
- Delete the `<MockedPreviewBanner>…</MockedPreviewBanner>` block in `ListenerApps`
  (`listen-download-section.tsx`) and drop the now-unused `MockedPreviewBanner` import (verify
  it isn't used elsewhere in the file before removing the import).

### A4. Delete the dead handoff path
- Remove files: `src/modals/app-handoff.tsx`, `src/data/walkthroughs.ts`, and the
  `WalkthroughStep` type from `src/lib/types.ts` (only walkthroughs consume it — verify).
- `src/store/ui-slice.ts`: remove `handoffApp` field, its initial value, and the `setHandoffApp`
  reducer.
- `src/components/layout.tsx`: remove the `AppHandoffModal` mount + import.
- Remove the `onSendApp` / `onSend` prop chain: `src/routes/index.tsx` (the
  `setHandoffApp` dispatch), `src/views/listen.tsx` (`onSendApp` prop + Props type),
  `listen-download-section.tsx` (`onSendApp` prop + `onSend` passthrough),
  `ListenerApps`/`ListenerAppCard` (`onSend`, the `void _onSend`).
- Update tests referencing the removed state/props: `ui-slice.test`, `persist-config.test`,
  `use-theme.test`, `theme-toggle.test`, `a11y.test`, `views/listen.test`,
  `listen-download-section.test`, `listen-responsive.test`.

## B. Fix export progress — store-level self-driving poller

### B1. Poller (in `src/store/exports-middleware.ts`)
- A custom Redux middleware (precedent: `src/store/broadcast-middleware.ts`) owns a
  module-level `Map<exportId, timer>`.
- After the reducer handles `exportStarted` / `exportUpdated` / `exportsHydrated`, it ensures a
  poller exists for every **non-terminal** job (`queued` | `in_progress`) across all books in
  `exports.byBookId`.
- On `exportDismissed`, or when a job reaches a terminal status (`done` | `failed` |
  `cancelled`), it clears that job's timer.
- Each tick: `await api.getBookExport(bookId, exportId)` → dispatch `exportUpdated` → reschedule
  at **800 ms** if still non-terminal, else clear the timer.
- **Invariant (no resurrection):** a tick that resolves *after* its job was dismissed must
  no-op — check that the job still exists in the store before dispatching `exportUpdated`.
- Polling failures: swallow and reschedule (matches the modal's old tolerance); the user can
  still cancel/dismiss.

### B2. Modal becomes a pure view (`src/modals/export-audiobook.tsx`)
- Remove the in-modal poll `useEffect` (the `activeJobId` → `getBookExport` loop) and the
  `pollHandle` ref.
- `handleSubmit` still dispatches `exportStarted` (the poller takes over).
- The modal still reads `activeJob` from the store and keeps `activeJobId` locally only to know
  which row it is focused on. Cancel (`exportDismissed` + `api.cancelBookExport`) and retry
  behavior unchanged.

Result: rail + modal share one driver → always synced; Retry advances; bars survive modal-close
and navigation; reaching "Done" is guaranteed.

## C. Reload recovery

### C1. Server endpoint
- New `GET /api/books/:bookId/exports` in `server/src/routes/export.ts` → `BookExportJob[]`,
  newest-first. Calls the existing `rehydrateBook` then returns every in-memory job for the book.
- Honest caveat (documented, not fixed here): jobs mid-build when the *server* restarted have no
  manifest and won't resurrect; only a *client* reload against a live server resumes in-progress
  rows.

### C2. Contract
- Add the endpoint to `openapi.yaml`; regenerate `src/lib/api-types.ts` (`npm run openapi:types`).
- `src/lib/api.ts`: add `listBookExports(bookId)` — real (`GET`) + mock (filter
  `MOCK_EXPORT_JOBS` by `bookId`, newest-first).

### C3. Frontend hydrate-on-mount
- Add `exportsHydrated({ bookId, jobs })` to `exports-slice.ts` — seeds/merges the book's job
  list (on a fresh mount the store is empty, so it sets).
- A thunk fetches `listBookExports` on Listen mount and dispatches `exportsHydrated`; the poller
  then advances any in-progress rows to terminal.

## Testing

- **Middleware:** a started job advances to `done` with no modal open; rail Retry advances a
  retried job; `exportDismissed` stops the timer; a tick resolving after dismiss does not
  resurrect the row.
- **Modal:** submitting dispatches `exportStarted`; the modal renders progress off the store
  (no own poll); cancel/retry still work.
- **Apple Books:** the tile is live and opens the modal with M4B preselected (download tab).
- **Deletion:** suites referencing removed handoff state/props updated; the grid renders 6 live
  tiles and no `MockedPreviewBanner`.
- **Server:** `GET /api/books/:bookId/exports` returns jobs newest-first; 404 on unknown book;
  rehydrate path covered.
- **Mock parity:** `listBookExports` mock returns the in-flight + completed jobs for the book.
- **Reload (e2e):** start an export, navigate away and back (and/or reload), the bar still
  reaches completion.
- `npm run verify` green (typecheck + tests + e2e + build).

## Out of scope

- Real store listings / any further companion-app wiring (store buttons stay coming-soon).
- Any change to the live export builders or sync-folder logic.
- Persisting the `exports` slice to storage (the server is the source of truth; on-mount
  rehydrate covers reload).
- Resuming jobs that died with a server restart (no manifest exists for in-progress jobs).

## Verification

1. `npm run verify` green.
2. Listen tab: all six app tiles are live (Apple Books opens the M4B download modal); no
   "coming soon" banner above the grid; companion store buttons remain coming-soon.
3. Start an export from any tile → the queue-rail bar advances in lockstep with the modal, and
   reaches "Done" even after closing the modal or navigating away and back.
4. Retry on a failed rail row advances to completion.
5. Reload mid-export → the in-progress row reappears and completes.
6. No references remain to `AppHandoffModal`, `walkthroughs.ts`, or `handoffApp`/`setHandoffApp`.
