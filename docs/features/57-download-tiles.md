---
status: active
shipped: null
owner: null
---

# 57 — Listen-view download tiles

> Status: active
> Key files: `src/views/listen.tsx`, `src/modals/export-audiobook.tsx` (unchanged — reused via `prefill`)
> URL surface: indirect — opens the existing `ExportAudiobookModal` from
> the listen view's "Or download a file" section.
> OpenAPI ops: `POST /api/books/{bookId}/export` (unchanged — already
> supports `format: 'm4b'` and `format: 'mp3-zip'`).

## Benefit / Rationale

- **User:** Closes the second-largest "Coming soon" surface on the
  Listen view. Pre-plan-57 the only direct-artifact path goes through
  the per-app tiles (PocketBook / Voice / etc.) which gate on a target
  app. Plan 57 surfaces the same artifacts as plain downloads.
- **Technical:** Zero new server code. The export route + builders
  already support `m4b` and `mp3-zip`; this plan is pure UI wiring +
  one additional `DownloadCard` (the MP3 ZIP tile).
- **Architectural:** Extends the existing `exportModal.prefill` pattern
  (introduced by plan 33 voice export) with a non-app-specific
  `format` channel. Future direct-format tiles (e.g. a "Folder of
  MP3s" tile if anyone wants it) reuse the same hook.

## Architectural impact

- **New seam:** the `exportModal` state in `listen.tsx` gains an
  optional `format` field alongside the existing `tab` + `appHint`.
  When set without `appHint`, the modal opens in its generic two-tab UX
  but with `prefill.format` pre-selecting the format row.
- **DownloadCard:** gains an optional `onDownload?: () => void` +
  `testid?: string`. When `onDownload` is set, the tile is live (button
  enabled, no Coming-Soon badge); when absent, the tile retains the
  legacy "Coming soon" appearance.
- **Invariants preserved:**
  - Plan 23 (mock toggle): components stay neutral — the live tiles
    call `setExportModal`, which routes through the same
    `ExportAudiobookModal` whose backend hits go through the `api`
    module (real vs. mock).
  - Plan 24 (OpenAPI source of truth): no schema changes; existing
    `BookExportJob.format` enum covers both `m4b` and `mp3-zip`.
  - Plan 26 (RTK Immer drafts): no slice changes.

## v1.3.0 scope

- ✅ **M4B chaptered tile (live):** opens modal pre-set to
  `format: 'm4b', destination: 'download'`.
- ✅ **MP3 ZIP tile (NEW, live):** opens modal pre-set to
  `format: 'mp3-zip', destination: 'download'`.
- ⏳ **Streaming link tile (Coming soon):** kept as a non-live tile
  with clarifying copy ("Available in a later release"). Needs a
  server-minted slugged URL endpoint (`/share/:slug` proxying the M4B
  off disk) which is a separate piece of work — parked as BACKLOG
  follow-up.

## Invariants to preserve

1. **`exportModal.format` is non-collapsing.** When the user clicks a
   download tile, the modal opens in the generic two-tab UX (not
   collapsed like the `appHint` path). The format picker is pre-set but
   the user can still flip to a different format or switch to the
   sync-folder tab. `src/views/listen.tsx`.
2. **DownloadCard remains the only entry point for the "Or download a
   file" section.** Listener-app tiles (PocketBook, Voice, etc.) are a
   sibling section and continue to use `appHint` collapsing.
3. **The streaming-link tile stays non-live until the slugged URL
   endpoint exists.** Wiring it before the server endpoint lands would
   surface a broken download. Better to keep the affordance honest.

## Test plan

### Automated coverage

- New e2e `e2e/download-tiles.spec.ts` (3 specs):
  - M4B tile is enabled, click opens the modal with M4B pre-selected.
  - MP3 ZIP tile is enabled, click opens the modal with MP3 ZIP
    pre-selected.
  - Streaming link tile remains disabled.

### Manual acceptance walkthrough

1. Open Solway Bay → Listen view.
2. Scroll to "Or download a file" — three tiles render: Full audiobook
   (M4B), MP3 ZIP, Streaming link.
3. Click M4B → ExportAudiobookModal opens in download mode with the M4B
   format row highlighted. Cancel.
4. Click MP3 ZIP → same modal, MP3 ZIP format row highlighted. Confirm
   → job appears in the export queue (real backend) or rejects with a
   "build incomplete" warning when chapters aren't all rendered.
5. Streaming link tile shows the Coming Soon affordance and its
   Download button is disabled.

## Out of scope

- **Streaming-link slugged URL minting.** Needs a new server endpoint
  (`POST /api/books/:bookId/share` returning a slug + `GET
  /share/:slug` proxying the M4B). Parked as BACKLOG follow-up.
- **Export-queue Retry + Download row actions.** BACKLOG Could #34;
  separate scope, can land independently once Plan 57 is in.

## Ship notes

(Filled in when status flips to `stable`.)
