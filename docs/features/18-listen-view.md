# Listen view

> Status: KNOWN: scaffolded (chapter-audio backend pending)
> Key files: `src/views/listen.tsx`, `src/components/waveform.tsx`, `src/components/mini-player.tsx`, `src/lib/api.ts` (`getChapterAudio`), `src/data/export-queue.ts`
> URL surface: `#/books/:bookId/listen`
> OpenAPI ops: `GET /api/books/:bookId/chapters/:chapterId` (frontend present, real backend stub)

## What this covers

The "ready to listen" view: shows the cover, audiobook metadata, chapter list with play buttons, a mini-player for the active track, a "Send to app" handoff queue, and an export queue. Today the audio fetch returns `url: null` in mock mode and the real endpoint throws "not wired yet" — the UI is intentionally scaffolded.

## Invariants to preserve

- `mockGetChapterAudio` returns `{ url: null, durationSec, peaks: float[240], sampleRate: 44100, segments: [] }` (`src/lib/api.ts:259-274`). Null `url` is the documented signal for "no live audio."
- `realGetChapterAudio` currently throws "Chapter audio not wired yet" (`src/lib/api.ts:612-614`). Treat this as the contract until the backend lands.
- `MiniPlayer` reads `ui.currentTrack` (a chapter index, not chapter id) and renders prev/next/close controls. `setCurrentTrack(null)` closes the player; the value is overlay-flat (not stage-guarded).
- Waveform peaks array length is fixed at 240 floats in mock mode for consistent rendering across chapters of different durations. Real backend may return any length; renderer scales to the available count.
- `ChapterAudio` shape: `{ url, durationSec, peaks, sampleRate, segments }`. `url` is `string | null`; UI must handle null without crashing.
- Listener app handoff modal is opened by `setHandoffApp(app)` and closed by `setHandoffApp(null)` (`src/store/ui-slice.ts:24, 112`). Apps come from `SUPPORTED_APPS` fixture.
- Export queue items render from `EXPORT_QUEUE` fixture; the queue is read-only today.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to a complete book.

1. **Land on `#/books/<id>/listen`** → cover, metadata, chapter list render. Each chapter row shows title, duration, and a play button.
2. **Click play on a chapter** → `setCurrentTrack(chapterIndex)`; mini-player slides up showing the chapter title and duration. No audio plays (mock `url: null`); UI does not crash.
3. **Click mini-player next / prev** → `ui.currentTrack` increments/decrements; mini-player reflects the new chapter.
4. **Click close on mini-player** → `setCurrentTrack(null)`; mini-player hides.
5. **Click "Send to app"** → handoff modal opens listing supported apps from the fixture. Each app shows tagline + `sendVerb` (e.g. "Send to Audible"). Closing returns to listen view.
6. **Export queue** → renders pending/in-progress/done/failed items from fixture; statuses, formats, sizes, timestamps display correctly. Items are not interactive in v1.
7. **Real-mode regression check** — switch to `VITE_USE_MOCKS=false`. The listen view loads (chapter metadata from book state hydration works) but `getChapterAudio` throws on play. UI must surface this error gracefully, not crash.

## KNOWN: scaffolded

- `mockGetChapterAudio` returns `url: null`; no audio plays in mock mode by design.
- `realGetChapterAudio` throws "Chapter audio not wired yet" — real-backend playback is not yet wired.
- Export queue is hardcoded fixture; "Download" buttons are visual stubs.
- "Send to app" handoff is a stub modal; no real deeplink/API/file-write integration.

## Out of scope

- Real audio playback wiring (separate backend plan).
- Skipping silence / variable playback speed / sleep timer.
- Live transcript sync with playback.
