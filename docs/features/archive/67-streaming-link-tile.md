---
status: stable
shipped: 2026-05-19
owner: null
---

# 67 — Streaming-link download tile

> Status: stable
> Key files: `server/src/routes/share.ts`, `src/modals/share-link.tsx`, `src/components/listen/listen-download-section.tsx`, `src/views/listen.tsx`
> URL surface: `POST /api/books/:bookId/share` (mint), `GET /share/:slug` (public-facing M4B proxy)
> OpenAPI ops: `createBookShareLink`, `getBookShareDownload`

## Benefit / Rationale

- **User:** Closes the last "Coming soon" affordance in the Listen
  view's "Or download a file" section. The viral-loop / share-with-a-
  friend path collapses from "build the M4B, find the file on disk,
  upload to a sharing service" to "click Streaming link, paste URL".
- **Technical:** No new audio pipeline. The route resolves a slug to
  the book's most-recent successful M4B export and proxies the file
  off disk — same artifact path the export-download endpoint already
  serves. Zero re-encode.
- **Architectural:** Introduces the first public-facing `/share/:slug`
  surface (no `/api` prefix). The slug → bookId table lives in a new
  workspace-level file (`<workspace>/.audiobook/share-links.json`)
  so restarts don't invalidate already-pasted URLs.

## Architectural impact

- **New seam:** `server/src/routes/share.ts` carries TWO routers — an
  authenticated POST mounted under `/api/books/:bookId/share` and a
  public GET mounted at the app root (`/share/:slug`). The dual mount
  keeps the user-facing URL chat-paste-friendly while keeping the
  mint behind the same API gate as every other write surface.
- **Persistence:** `<workspace>/.audiobook/share-links.json` carries a
  `{ links: { [slug]: { bookId, createdAt } } }` table written
  atomically via `writeJsonAtomic` (no rotation — the file is cheap
  to re-derive on loss, the book → slug mapping is idempotent).
- **Slug format:** 12 chars from Crockford-style base32 (digits 0-9 +
  uppercase A-Z minus I, L, O, U) — no vowels, no easily-confused
  glyphs, ~60 bits of entropy. Casual share link, not a security
  token; the task brief explicitly capped scope here.
- **Idempotency:** A second POST for a book that already has a slug
  returns the same slug + URL. Keeps a previously-pasted link stable
  across re-clicks of the tile.
- **Invariants preserved:**
  - Plan 23 (mock toggle): the share-link API is wired through `api.*`;
    the mock path mints a deterministic slug client-side so design
    fixtures + e2e (mock mode) both render a copyable URL.
  - Plan 24 (OpenAPI source of truth): `BookShareLink` shape added to
    `openapi.yaml`; `src/lib/api-types.ts` regenerated; the
    `src/lib/types.ts` re-export pulls from `components['schemas']`.
  - Plan 26 (RTK Immer drafts): no slice changes — the share-link
    modal state is component-local on `listen.tsx`.

## Invariants to preserve

1. **`SLUG_RE` is the only gate the GET handler trusts.** Strings
   that don't match the strict pattern get a 404 before the table is
   even read — keeps casual `/share/foo` hits cheap and prevents the
   table from acting as an enumeration oracle. `server/src/routes/share.ts`.
2. **Slug → bookId mapping persists across server restarts.** The
   POST writes to `<workspace>/.audiobook/share-links.json` via
   `writeJsonAtomic` before responding so a crash between mint + use
   never strands a pasted URL.
3. **GET resolves to the MOST-RECENT successful M4B export.** Walks
   the book's `.audiobook/exports/<id>/manifest.json` entries,
   filters to `format === 'm4b' && status === 'done'`, sorts by
   `completedAt ?? createdAt` descending. Older `failed` / `mp3-zip`
   manifests don't shadow the latest M4B.
4. **No M4B yet → 409, not 404.** A 404 reads as "broken link"; the
   `no_m4b_ready` 409 lets the UI render "build an M4B first".
5. **`ShareLinkModal` is a pure presenter.** Mint happens on the
   parent (`listen.tsx`) BEFORE the modal opens; the modal renders
   the URL prop, copies on click, flips a transient "Copied" state.
   Tests pin the four contracts: URL is verbatim, copy calls the
   Clipboard API with that URL, success flips to "Copied", failure
   routes through `onCopyFailed`.
6. **Streaming-link tile lives on `listen-download-section.tsx`.**
   The R1 decomposition (plan 60) moved the download tiles out of
   `listen.tsx`; the new `onOpenStreamingLink` prop threads through
   from the orchestrator alongside the M4B / MP3-ZIP handlers.

## Test plan

### Automated coverage

- Server Vitest (`server/src/routes/share.test.ts`) — covers:
  - POST mints a 12-char Crockford base32 slug.
  - POST persists the slug → bookId mapping to
    `<workspace>/.audiobook/share-links.json` (idempotent file write).
  - Re-POST for the same book returns the same slug (idempotent).
  - POST 404s on an unknown bookId.
  - GET streams the M4B bytes with `Content-Type: audio/mp4` and a
    `Content-Disposition: attachment` header.
  - GET resolves to the MOST RECENT M4B when multiple manifests are
    on disk (older `completedAt` is shadowed by newer).
  - GET 404s on unknown / malformed slugs.
  - GET 409s with `no_m4b_ready` when the book has no completed M4B
    export.
  - GET ignores non-m4b formats and failed-status manifests.
- Frontend Vitest (`src/modals/share-link.test.tsx`) — covers:
  - URL prop renders verbatim into a read-only input.
  - Copy button is disabled while the URL is null (mint in flight).
  - Clicking Copy calls `navigator.clipboard.writeText` with the URL
    and flips the button to "Copied".
  - Clipboard rejections route through `onCopyFailed` and flip to
    "Copy failed".
  - Escape + backdrop click close the modal.
- Playwright e2e (`e2e/download-tiles.spec.ts`) — extends with a
  streaming-link case: tile click opens the share modal, URL field
  shows a `/share/<12-char base32>` value, Copy button is enabled.

### Manual acceptance walkthrough

1. Open any book → Listen view.
2. Scroll to "Or download a file" — three tiles render. The
   Streaming link tile no longer carries the "Coming soon" badge;
   its Download button is enabled.
3. Click Streaming link → ShareLinkModal opens. The URL field
   shows `<origin>/share/<12-char slug>` (e.g.
   `http://localhost:5173/share/A7B9CDEFGHJK`).
4. Click Copy → button flips to "Copied" for ~1.5 s; the URL is in
   the clipboard. Cmd/Ctrl+V into another field — the URL pastes.
5. Open a private/incognito tab, paste the URL → if the book has a
   completed M4B export, the file downloads. If not, the response
   is a JSON `{ error: 'no_m4b_ready' }` 409 (rendered by the
   browser as plain text — a future UX pass could replace this
   with a friendly HTML page).
6. Close + reopen the modal (click Streaming link again) → the URL
   field shows the SAME slug (idempotent mint). The slug → bookId
   mapping is on disk at `<workspace>/.audiobook/share-links.json`.

## Out of scope

- **Slug expiry.** The OpenAPI schema reserves an optional
  `expiresAt` field on `BookShareLink` but the v1 mint emits no
  expiry. Wake when a real "links self-destruct after N days" use
  case lands.
- **Per-link password gate.** BACKLOG #33 mentioned this as
  optional; skipped in v1 — the casual share-link contract doesn't
  need it. Add a `password?` request body field + a header check on
  GET when a real product driver materialises.
- **Range / 206 streaming.** `res.sendFile` already handles ranges
  via Express defaults; not explicitly tested. Streaming clients
  (e.g. a phone audiobook player resuming mid-file via Range) work
  by inheriting the Express transport contract — pin with a test
  if a real player surfaces an issue.
- **Frontend "build M4B first" auto-redirect on 409.** Today the
  share modal renders the URL regardless; the 409 only surfaces on
  the recipient side. A future pass could detect the no-M4B state
  on the share-modal open and pre-emptively open the M4B export
  modal — out of scope for the v1.4.0 cutover.

## Ship notes

Shipped 2026-05-19 as Wave-3 of the v1.4.0 alpha-launch slate
alongside S4 (editorial notes) and S6 (share-chapter-clip). Scope
delta vs the BACKLOG entry: the optional per-link password gate
was deferred (not trivially additive given no UI bucket exists for
"per-share password" today; documented under Out of scope).
Slug-to-bookId persistence file landed at
`<workspace>/.audiobook/share-links.json` (workspace-level, not
per-book — slugs are flat and cross-cut every book).
