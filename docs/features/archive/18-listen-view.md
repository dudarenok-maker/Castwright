---
status: stable
shipped: 2026-05-18
owner: null
---

# Listen view

> Status: stable — header, metadata editor, chapter playback, cover Replace/Regenerate, export-queue Copy/Remove/Retry/Download, and five of seven listener-app tiles wired end-to-end. Remaining gaps (download tiles, Apple Books, Plex, real waveform peaks) tracked as discrete BACKLOG Could entries. Retry + Download row actions shipped 2026-05-21 via plan 82.
> Key files: `src/views/listen.tsx`, `src/views/listen.test.tsx`, `src/store/book-meta-slice.ts`, `src/store/book-meta-slice.test.ts`, `src/components/waveform.tsx`, `src/components/mini-player.tsx`, `src/lib/api.ts` (`getChapterAudio`), `src/data/export-queue.ts`, `src/data/listener-apps.ts`, `server/src/routes/chapter-audio.ts`
> URL surface: `#/books/:bookId/listen`
> OpenAPI ops: `GET /api/books/:bookId/chapters/:chapterId/audio` (JSON meta) + `audio.mp3` (file with range support, served via `server/src/routes/chapter-audio.ts`); `PUT /api/books/:bookId/state` slice='state' carries editable metadata

## What this covers

The "ready to listen" view shows the cover, audiobook metadata, chapter list with play buttons, a mini-player for the active track, "Listen on your favourite app" cards, an export queue, three download tiles, and a metadata editor.

**Wired (real backend or store-driven):**

- The header (cover, title, author, narrator, runtime/chapter/voice stats, action strip).
- The metadata editor: edits flow through `book-meta-slice` and persist via `PUT /api/books/:bookId/state` slice='state'.
- Chapter playback: `api.getChapterAudio` calls `GET /api/books/:bookId/chapters/:chapterId/audio` for the JSON meta (url + durationSec + segments), and the `<audio>` element in `MiniPlayer` streams the returned `audio.mp3` URL with range-request support for `<audio>` seeking.

**Intentionally mocked (with "Coming soon" affordances on every interactive surface):**

- All six listener-app cards (Audiobookshelf, BookPlayer, Smart AudioBook Player, Apple Books, Plex, PocketBook).
- All three download tiles (m4b chaptered, MP3 ZIP, streaming link).
- The export queue rows (the table renders from the demo fixture; no row actions fire).
- Cover replace/regenerate buttons in the metadata editor.
- The "Download" and "Share" buttons in the header strip.

## Invariants to preserve

### Header / metadata wiring

- Header title/author/series/narratorCredit/genre/publicationDate read through `selectEffectiveMeta(bookId)` from `book-meta-slice`. The cover gradient comes from `library.books.find(b => b.bookId === bookId)?.coverGradient`. No hardcoded "Northern Star" / "Mike Dudarenok" / "Anders Vale" literals may live in `listen.tsx`.
- Narrator-credit precedence (`src/views/listen.tsx` and `narratorNameFromCast` in `src/store/book-meta-slice.ts`): explicit `bookMeta.narratorCredit` → cast character with `id === 'narrator'` → first character → null (the "narrated by …" phrase is suppressed).
- `book-meta-slice` shape: `{ draft: Partial<EditableBookMeta> | null, saved: Record<bookId, EditableBookMeta> }`. The draft is the in-flight edit buffer; `selectEffectiveMeta` overlays it on top of `saved[bookId]` so the header updates live as the user types.
- Save button: `disabled` until `selectIsDirty` is true. On click, dispatches `bookMeta/commitDraft({ bookId })` which folds the draft into `saved[bookId]` and clears the draft. The persistence-middleware watches that action and fires a debounced `PUT /api/books/:bookId/state` with slice='state'.
- Cancel button: also disabled until dirty; dispatches `bookMeta/cancelDraft` which discards the draft without persisting.
- New `BookStateJson` optional fields: `narratorCredit?`, `genre?`, `publicationDate?` (ISO 'YYYY-MM-DD'). State.json files written before these landed continue to load — missing fields fall back to library/cast defaults on the frontend.
- Server PUT slice='state' whitelist (`server/src/routes/book-state.ts`): widened to accept `title`, `author`, `series`, `narratorCredit`, `genre`, `publicationDate` alongside the existing `castConfirmed` and `chapters`. Identity fields (`bookId`, `manuscriptId`, `manuscriptFile`, paths) remain non-editable and any attempt to overwrite them is ignored.
- Empty-draft commit is a no-op write but still clears the draft buffer (`book-meta-slice.ts` `commitDraft`). This keeps the persistence-middleware logic simple — it fires on `commitDraft` regardless of whether anything actually changed.
- `narratorCredit`, `genre`, and `publicationDate` are nullable strings. The editor maps empty input to `null` via `v || null` (the field renders the empty string when null is stored) so clearing a field round-trips as JSON `null`, not `""`.
- Mocked-mode gate: when `VITE_USE_MOCKS=true`, the persistence-middleware short-circuits before fetching the rule and no `PUT /api/books/:bookId/state` fires. The metadata-editor still flows through the slice, so the header preview updates live; nothing reaches the server.
- Loading skeleton: when `selectEffectiveMeta(bookId)` returns null (book opened before the on-disk fetch / library hydration finished), the editor card renders a "Loading metadata…" placeholder instead of empty inputs.
- Hydration: `layout.tsx`'s per-book hydrate dispatches `bookMeta/hydrateFromBookState` after the on-disk fetch lands. A separate fallback effect seeds `bookMeta` from the matching `library.books` entry when the on-disk fetch is unavailable (mock mode, fresh import before state.json exists). The on-disk fetch overwrites it on arrival.

### Chapter playback / mini-player

- `mockGetChapterAudio` returns `{ url: null, durationSec, peaks: float[240], sampleRate: 44100, segments: [] }`. Null `url` is the documented signal for "no live audio" and the UI must handle it without crashing.
- `realGetChapterAudio` does a real `GET /api/books/:bookId/chapters/:chapterId/audio` fetch (`src/lib/api.ts:1577-1584`); the server route at `server/src/routes/chapter-audio.ts` resolves the chapter's on-disk MP3 and returns the JSON meta `{ url, durationSec, peaks: [], sampleRate, segments }`. Non-2xx throws an `Error("Chapter audio fetch failed (status): detail")` that the mini-player surfaces via `setError`.
- The meta endpoint's `url` is itself a route on the same server (`audio.mp3`); the server `sendFile`s with `Accept-Ranges: bytes` so the `<audio>` element can seek via 206 partial-content responses. `findChapterAudio` (`server/src/workspace/chapter-audio-file.ts`) is the single-format probe.
- `MiniPlayer` reads `ui.currentTrack` (a chapter id) and renders prev/next/close controls. `setCurrentTrack(null)` closes the player. On chapter swap it resets the `<audio>` src synchronously so the prior chapter stops immediately even if the next meta fetch is slow.
- Waveform peaks array length is fixed at 240 floats in mock mode for consistent rendering across chapters of different durations. The real meta endpoint returns `peaks: []` deliberately (the MiniPlayer doesn't draw them; the Listen-view waveform card is still mock-driven and is the next thread of work if you want a fully live waveform).
- `ChapterAudio` shape: `{ url, durationSec, peaks, sampleRate, segments }`. `url` is `string | null`; UI must handle null without crashing.
- Server-side regression coverage: `server/src/routes/chapter-audio.test.ts` pins the meta endpoint, the MP3 file endpoint, range requests, and 404s (including `audio.wav` → 404 since the route isn't registered).

### Coming-soon affordances

- Every still-mocked interactive surface (six listener-app cards + their "Send to …" buttons; three download tiles + their Download buttons; export-queue per-row actions; header "Download" + "Share"; cover Replace + Regenerate) is rendered `disabled` with muted styling and a `<ComingSoonBadge/>` (`src/components/primitives.tsx`).
- Each mocked section carries a `<MockedPreviewBanner>` (also in primitives) above the cards/rows so a smoke pass can tell the section apart from a shipped one at a glance. Three banners total: listener-apps, export-queue, downloads.
- PocketBook is present as the sixth listener-app entry (`src/data/listener-apps.ts`) and will be the first to flip from mocked to live when real handoff lands.
- `setHandoffApp` is no longer dispatched from listener-app card clicks (the button is disabled). The `AppHandoffModal` infrastructure remains in place for the future flip-over but is unreachable from the Listen view today.

## Acceptance walkthrough

Run against the canonical e2e manuscript (`server/src/__fixtures__/the-coalfall-commission.md`, see project CLAUDE.md).

### Top section reads from the store

1. Open a confirmed book; URL ends in `#/books/<id>/listen`.
2. The h1 in the header shows the book's _actual_ title (the one entered at confirm), not "The Northern Star". The cover-art h2 in the corner shows the same string. The "By X" line shows the actual author. The "narrated by Y" suffix shows the cast's narrator character (or whatever you set in the metadata editor — see below).
3. The cover-art panel is painted with `library.books.<this book>.coverGradient`, not the fallback peach.

### Metadata editor end-to-end

4. Scroll to the "Edit the audiobook details" card. Every field is a controlled input pre-filled from the current saved snapshot.
5. Edit the **Title** field. The h1 at the top of the page updates live as you type (the draft is overlaid via `selectEffectiveMeta`). The Save button enables.
6. Click **Cancel** → the field reverts to the saved value, the h1 reverts, Save disables.
7. Re-edit **Title**, **Author**, **Series**, **Narrator credit**, **Genre**, and **Publication date**. Click **Save changes**.
8. Refresh the page. All six edits survive — the persistence middleware fired a `PUT /api/books/:bookId/state` with slice='state' and the body included all six editable fields; the server wrote `.audiobook/state.json` and on reload the hydration seeded the slice from disk.

### Coming-soon affordances

9. The "Listen on your favourite app" section shows a single peach-tinted "Mocked preview" banner. Six cards (incl. PocketBook) each carry a "SOON" badge next to the app name and a disabled "Send to …" button. Hovering the button shows the "— coming soon" tooltip; clicking does **not** open the walkthrough modal.
10. The "Export queue" section shows its own banner. Per-row action icons (copy, download, retry, remove) are all disabled.
11. The "Or download a file" section shows the third banner. All three Download buttons are disabled with the SOON badge in the tile header.
12. In the metadata editor, **Replace cover** and **Regenerate cover** are disabled with SOON badges.

### Chapter playback (mock mode)

13. Click play on a chapter → `setCurrentTrack(chapterId)`; mini-player slides up showing the chapter title and duration. No audio plays (mock `url: null`); UI does not crash.
14. Click mini-player next / prev → `ui.currentTrack` increments/decrements.
15. Click close on mini-player → `setCurrentTrack(null)`; mini-player hides.

### Chapter playback (real mode regression)

16. With `VITE_USE_MOCKS=false`, server + sidecar running, generate at least one chapter end-to-end first so an MP3 lives on disk under `<bookDir>/audio/<slug>.mp3`. Open the Listen view, click play on that chapter. The mini-player slides up, the `<audio>` element's `src` points at `/api/books/:bookId/chapters/:chapterId/audio.mp3`, audio plays, the scrubber advances in real time. Click somewhere mid-bar → `<audio>.currentTime` jumps and playback resumes from there (range request returns 206). Click next / prev to swap chapters → previous chapter's audio stops synchronously; new chapter loads.
17. Negative regression: click play on a chapter that has no audio yet. The mini-player surfaces "Chapter audio fetch failed (404): Chapter audio not found." via the `setError` path; the rest of the Listen view continues to work.

## Listener-app integration status (corrected 2026-05-18)

The original plan 18 KNOWN-scaffolded section claimed "All six listener-app cards disabled" — that prediction is stale. Live integrations shipped piecemeal across plans 32 / 33 / 34. Current state:

**Live (5 of 7 tiles):**

- **PocketBook** — `appHint: 'pocketbook'`, opens export modal on Download-to-phone tab (plan 32).
- **Voice** — `appHint: 'voice'`, opens export modal forced to M4B + sync-folder (plan 33).
- **Smart AudioBook Player** — `appHint: 'smart_audiobook'`, opens export modal forced to MP3-folder + sync-folder (plan 34 B2).
- **BookPlayer** — `appHint: 'bookplayer'`, opens export modal forced to MP3-folder + sync-folder (plan 34 B3).
- **Audiobookshelf** — `appHint: 'audiobookshelf'`, opens export modal forced to MP3-folder + sync-folder (plan 34 B4).

**Coming soon (2 of 7 tiles):**

- **Apple Books** — `[BACKLOG Could #31]`. Closed-library API requires Mac drag-into-Books or iOS AirDrop / Files import.
- **Plex** — `[BACKLOG Could #32]`. Self-hosted; either manual library upload or direct API push with a stored Plex token.

**`AppHandoffModal` infrastructure:** still mounted in `src/components/layout.tsx` (line 737) and the walkthrough fixtures live in `src/data/walkthroughs.ts`, but **none of the live tiles dispatch `setHandoffApp(app)`** — they go through the export modal (`setExportModal({ tab, appHint })`) which is the simpler "configure-then-export" path. The handoff-walkthrough infrastructure is kept for future per-app rich-walkthrough flows (Apple Books / Plex may want it) but is not load-bearing today.

## KNOWN: still scaffolded after plan 18b (2026-05-18)

- `mockGetChapterAudio` returns `url: null`; no audio plays in mock mode by design.
- Listen-view waveform card still derives from the mock `peaks: float[240]`; the real chapter-audio meta endpoint returns `peaks: []`. Tracked as `[BACKLOG Could #35]`.
- Download tiles (m4b chaptered, MP3 ZIP, streaming link) and the header Download/Share buttons remain non-functional stubs. Tracked as `[BACKLOG Could #33]`.
- Export queue Retry + Download row actions remain disabled. Tracked as `[BACKLOG Could #34]`. Copy link + Remove are wired (plan 18a).
- Apple Books + Plex listener-app tiles remain Coming Soon — `[BACKLOG Could #31, #32]`.

Shipped in plan 18a (2026-05-18):

- Metadata-editor cover Replace + Regenerate buttons. Replace opens `CoverPicker` on Upload tab; Regenerate opens it on Search tab. The existing per-card cover-tile click was already wired; the editor buttons now route through the same modal via a new `initialTab` prop on `CoverPicker`.
- Export-queue row actions: **Copy link** writes the row's URL to `navigator.clipboard` + pushes an `info` toast via the plan 48 notification surface; **Remove** dispatches `exportsActions.exportDismissed({ bookId, exportId })`. Mock-fallback fixture rows (synthetic IDs) accept the dispatch as a no-op since they don't live in `byBookId` — acceptable mock-mode degradation. Pinned by `src/views/listen.test.tsx` "metadata-editor cover buttons" + "export-queue per-row actions" describes.

## Out of scope (architectural, unchanged)

- Skipping silence / variable playback speed / sleep timer — listening-UX cluster; tracked as BACKLOG Should #1 (playback speed) + Could (markers, sleep timer, share clip).
- Live transcript sync with playback — not on the v1 roadmap.

## Ship notes

- **v1 partial shipped 2026-05-17**: header, metadata editor, chapter playback, range-request audio streaming.
- **Plan 18a slice shipped 2026-05-18**: cover Replace + Regenerate buttons; export-queue Copy + Remove row actions.
- **Plan 18b correction shipped 2026-05-18**: documented that 5 of 7 listener-app tiles are live (via the export modal, not the AppHandoffModal walkthrough); remaining 2 (Apple Books, Plex) filed as BACKLOG Could #31/#32; download tiles + queue Retry/Download + waveform peaks filed as Could #33/#34/#35. Plan flips to stable with all remaining gaps trackable through BACKLOG entries.
