---
status: stable
shipped: 2026-05-21
owner: dudarenok@gmail.com
---

# 82 — Export queue Retry + Download row actions

> Status: stable
> Key files: `src/components/export-queue-row.tsx`, `src/components/listen/listen-download-section.tsx`, `src/views/listen.tsx`, `src/store/exports-middleware.ts`, `src/lib/types.ts`, `src/lib/export-queue-adapter.ts`
> URL surface: `#/book/<id>/listen` (Export queue rail)
> OpenAPI ops: `POST /api/books/{bookId}/exports`, `GET /api/books/{bookId}/exports/{exportId}/download` (both pre-existing — no contract change)

## Benefit / Rationale

- **User:** failed export rows now offer Retry (one click re-fires the original request); done rows that didn't return a signed `url` now offer Download (one click streams the artifact). Closes the last two disabled stubs in `ExportQueueRow` after plan 18a shipped Copy + Remove. Closes BACKLOG Could #3.
- **Technical:** the wire context (`bookId`, `exportId`, `wireFormat`, `wireDestination`, `syncPath`) lives on `ExportQueueItem` so the row click can act without a re-fetch. The retry path stays thin: dismiss + `api.createBookExport` (reuses the modal's existing path, no new server route). The download path is a `window.location.assign` against the already-existing `/api/books/{bookId}/exports/{exportId}/download` route.
- **Architectural:** no new redux state, no new server route, no openapi change. The new wire fields on `ExportQueueItem` are optional only to accommodate the fixture-based mock rows in `src/data/export-queue.ts` — every live `bookExportJobToQueueItem` row carries them.

## Architectural impact

- `ExportQueueItem` interface (`src/lib/types.ts:519`) gains five optional wire-context fields. Adapter `bookExportJobToQueueItem` (`src/lib/export-queue-adapter.ts:26`) propagates them from the wire `BookExportJob`.
- New thunk `retryExport({ bookId, exportId, format, destination, syncPath? })` in `src/store/exports-middleware.ts` — composes `exportDismissed` + `api.createBookExport` + `exportStarted`. Returns the new job so callers can chain.
- `ExportQueue` (the local wrapper inside `src/components/listen/listen-download-section.tsx:321`) gains `onRetry` + `onDownload` props and passes them through to the existing `ExportQueueRow`.
- `src/views/listen.tsx` wires the two handlers: `onRetryExport` dispatches the thunk; `onDownloadExport` prefers `item.url` when present (cloud-mediated) and falls back to the `/download` route.
- Plan 18a's `ExportQueueRow` already accepted `onRetry`/`onDownload` props as optional and rendered enabled vs disabled accordingly — no row component changes.

## Invariants to preserve

1. `ExportQueueItem.bookId` + `exportId` are populated for every adapter-generated row (`src/lib/export-queue-adapter.ts:44-49`). Without them the retry/download buttons stay disabled.
2. `retryExport` dispatches `exportDismissed` BEFORE `api.createBookExport` — so a transient retry that succeeds replaces the failed row, not duplicates it (`src/store/exports-middleware.ts:30-36`).
3. The retry POST body carries only `format` + `destination` — `syncPath` is informational on the row; the server determines the actual sync folder from user settings (`BookExportRequest` schema in OpenAPI).
4. Download prefers `item.url` (signed cloud URL) over `/api/books/.../download` to avoid an unnecessary server round-trip (`src/views/listen.tsx` `onDownloadExport`).
5. The fixture-based queue rows in `src/data/export-queue.ts` continue to work — wire context is optional on `ExportQueueItem`.

## Test plan

### Automated coverage

- `src/store/exports-middleware.test.ts` — 2 cases:
  - `retryExport` dispatches `exportDismissed`, then `exportStarted` with the new job; `api.createBookExport` called with the original wire params.
  - Thunk returns the new job for callers that want to chain.
- Existing `src/store/exports-slice.test.ts` cases continue to pass (slice reducers unchanged).
- Existing `src/components/listen/*` tests continue to pass (only prop signatures extended, no behavior changed for previously-tested paths).

### Manual acceptance walkthrough

1. Start the app in mock mode, open a book → navigate to Listen → Export queue rail.
2. Trigger an export that fails (e.g. cancel mid-flight in mock mode) → row shows status `failed` with a Retry button (enabled, not greyed).
3. Click Retry → failed row vanishes; a new `in_progress` row appears at the top with the same format + destination.
4. Complete an export → status `done`; row shows Download button (enabled) when `url` is absent, OR Copy link button when `url` is present.
5. Click Download → file downloads via `/api/books/.../exports/.../download` (or `item.url` directly when present).
6. Existing Copy link + Remove rows continue to work unchanged.

## Out of scope

- Server route changes — `POST /api/books/.../exports` and `GET .../download` already exist and accept the necessary contracts.
- Retry-with-new-params — the retry button always re-fires with the original format/destination; users wanting a different format use the Export modal.
- New e2e spec — covered by the existing `e2e/exports-sync-folder.spec.ts` plus the new Vitest coverage on the thunk. Plan 18 already e2e-covers the queue rail's render shape; the retry/download buttons surface via the same DOM path. A dedicated e2e is **deferred** (low value vs. existing coverage); reopen if the buttons regress.

## Ship notes

Shipped 2026-05-21 — closes BACKLOG Could #3. Bundles the bump-version test fix from plan 85 (so this branch's pre-commit hook passes; the fix landed first in PR #94 / plan 85's branch and is duplicated here defensively until that PR merges). No openapi change, no new server route. Plan 18 archive doc updated to remove the "Coming soon" status on Retry + Download.
