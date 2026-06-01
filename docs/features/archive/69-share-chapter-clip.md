---
status: stable
shipped: 2026-05-19
owner: null
---

# Share a 30-second chapter clip as MP3

> Status: stable
> Key files: `src/modals/share-clip.tsx`, `src/components/listen/listen-player-region.tsx`, `server/src/routes/clip.ts`, `openapi.yaml`
> URL surface: indirect — Share-clip button in each chapter row of `#/books/<id>/listen` opens the modal; on confirm a one-shot anchor click downloads from `GET /api/books/{bookId}/chapters/{chapterId}/clip?start=<sec>&duration=<sec>`.
> OpenAPI ops: `GET /api/books/{bookId}/chapters/{chapterId}/clip`

## Benefit / Rationale

- **User:** viral-loop / share-with-a-friend path becomes a single click. Today the only sharing path is the whole chapter MP3 (5–30 min of audio, often dozens of MB). A 30-second clip is shareable in any chat / social tool and respects the listener's first-touch budget.
- **Technical:** the slicing path re-uses the source MP3 frame-aligned — `ffmpeg -ss <start> -i <mp3> -t <duration> -c copy` produces a byte-exact slice in <1 s with no decode. No re-encode quality drift, no extra Coqui/Kokoro round-trip, no GPU contention.
- **Architectural:** introduces a generic chapter-byte-slice seam (`server/src/routes/clip.ts`) keyed on `bookId + chapterId + (start, duration)`. The same path can power future use cases (sample-of-the-day, audiogram preview) without re-bolting the chapter-audio router.

## Architectural impact

- **New seams / extension points:**
  - `GET /api/books/{bookId}/chapters/{chapterId}/clip` — first OpenAPI route that produces a streamed download with `Content-Disposition: attachment`. Pattern is reusable for plan-33-style streaming-link tile if/when that ships.
  - `src/modals/share-clip.tsx` exports `MAX_CLIP_DURATION_SEC` (= 60) and `DEFAULT_CLIP_HALF_WINDOW_SEC` (= 15) so future consumers (per-character preview, social-card generator) can mirror the caps without re-deriving them.
  - `onShareClip` prop on `ChapterListenRow` keeps the modal-owning state at the region level (no per-row modal mount), preserving the rule that only one Share-clip modal can be open at a time.
- **Invariants preserved:**
  - Plan 24 OpenAPI source of truth: the new route is in `openapi.yaml` and `src/lib/api-types.ts` is regenerated.
  - Plan 28 chapter-audio format: the route reads the existing `<slug>.mp3` via `findChapterAudio` (no parallel format discovery code path).
  - Plan 60 listen decomposition: edits land in `listen-player-region.tsx`, not the slimmed `listen.tsx` orchestrator. The orchestrator gains zero new props.
- **Migration story:** none — the route reads existing chapter MP3s, no on-disk state shape changes.
- **Reversibility:** removing the route + modal + button reverts to pre-plan-69 surface. The chapter MP3s on disk are untouched (the slice is streamed straight from ffmpeg to the response, never persisted).

## Invariants to preserve

1. **Server enforces the 60 s duration cap.** `server/src/routes/clip.ts` rejects `duration > 60` with 400 before spawning ffmpeg, so even a hand-crafted request can't extract longer slices. The modal mirrors the cap (`MAX_CLIP_DURATION_SEC` in `src/modals/share-clip.tsx`) for UX clamping; the server is the source of truth.
2. **No re-encode.** The ffmpeg invocation is `-ss <start> -i <mp3> -t <duration> -c copy -f mp3 pipe:1`. Any future PR that adds bitrate-shifting / loudnorm / mp3-to-mp3 transcoding to this route must add a feature flag (default off) and a new test asserting the `-c copy` path stays default.
3. **Fast-seek (`-ss` before `-i`).** Documented trade-off: precision is MP3-frame-granular (~26 ms boundary error), throughput is sub-second. For frame-perfect cuts the placement would flip to `-ss` after `-i`, which decodes from time zero — unnecessary for a 30 s social clip.
4. **bookId is URL-encoded in the route path.** The route is mounted under `app.use('/api/books', clipRouter)`; the modal builds the URL via `encodeURIComponent(bookId)` so reserved characters (space, ampersand) in `Author With Spaces__series__title` survive the round-trip. The frontend Vitest pins this — `confirm URL encodes the bookId so reserved characters survive`.
5. **Streaming response: header send is gated on the first stdout chunk.** If ffmpeg exits non-zero before producing any output (start past chapter end, corrupt MP3) the response is still JSON 500 — not a half-written MP3. After the first chunk lands, response headers are flushed and the body streams; a later ffmpeg failure ends the response cleanly without re-sending headers.

## Test plan

### Automated coverage

- **Server Vitest** (`server/src/routes/clip.test.ts`) — 11 cases:
  - Validation: `duration > 60` → 400; negative `start` → 400; zero / missing / non-numeric `duration` → 400.
  - Not-found: unknown bookId / non-integer chapterId / unknown chapterId / chapter exists but no MP3 on disk → 404.
  - Happy path (skips when ffmpeg isn't on PATH): returns 200 + `audio/mpeg` + `Content-Disposition: attachment; filename="<chapter-slug>-clip-<start>s.mp3"` + non-zero body bytes; `Math.floor(start)` rounds the filename label.
- **Frontend Vitest** (`src/modals/share-clip.test.tsx`) — 10 cases:
  - Closed-state null-render and null-chapter null-render.
  - Default window = ±15 s around the playhead → 30 s clip; falls back to chapter-midpoint when `playheadSec` is null.
  - Drag start-range to 80 s + end-range to 110 s → confirm fires `onDownload` with a URL containing `start=80.00&duration=30.00` and the right bookId / chapterId path segments.
  - Typing into the start input clamps below the end (start can't pass end-1).
  - End input clamps to `start + MAX_CLIP_DURATION_SEC` (60 s cap).
  - +5 / −5 step buttons increment by 5 s.
  - Backdrop click invokes `onClose`.
  - URL-encoding survives a bookId with spaces.
- **Playwright e2e** (`e2e/mini-player-features.spec.ts`) — new `plan 69 — Share clip` describe block: chapter-row Share-clip button is visible, modal opens, sliders drag to 1:20 / 1:50, confirm closes the modal AND the intercepted anchor-click URL matches `/api/books/<id>/chapters/2/clip?start=80.00&duration=30.00`.

### Manual acceptance walkthrough

Run with `npm run dev` (or any mock-mode build).

1. **Cold boot at `#/books/sb/listen`** → Listen view for Solway Bay loads. Chapter rows visible.
2. **Click chapter 2's play button** → mini-player mounts, audio starts.
3. **Click chapter 2's Share-clip button** (Share icon next to Regenerate in the row's trailing actions) → the share-clip modal opens. Default window centred on the current playhead.
4. **Drag the Start slider to 1:20, the End slider to 1:50** → Start input shows `1:20`, End input shows `1:50`, clip-length summary shows `0:30`.
5. **Click Download clip** → modal closes; browser downloads `chapter-2-clip-80s.mp3` (filename varies with chapter slug). Open in any audio player → plays the requested 30 s of audio. No quality drop vs. the source chapter.
6. **Re-open Share-clip, drag End beyond +60 s** → End handle clamps; clip-length stays at 1:00. The over-cap warning never shows under normal slider use (slider min/max enforce); typing `10:00` into the End input triggers the clamp + length stays at 1:00.

## Out of scope

- **Frame-perfect cut precision.** The `-ss` before `-i` fast-seek path lands within ~26 ms of a frame boundary; a future "Studio clip" mode that wants accurate-seek would flip placement and pay the decode cost. Not in v1.
- **Re-encode to a smaller bitrate for social uploads.** The slice is the same VBR rate as the source MP3 (LAME V2, ~190 kbps avg). Future: `?bitrate=` query param.
- **Share-clip from the global mini-player.** Only the chapter-row button is wired. The mini-player is global (lives outside the listen view) and doesn't carry chapter context; adding a button there would need to read the active chapter via `selectListenProgress` and dispatch a region-level modal-open action.
- **Clip preview before download.** Today: confirm → download. Could-have: an inline `<audio>` player in the modal that previews the slice before commit. Costs an extra round-trip and a temp blob; not worth it for the v1 share path.
- **Share-link (URL someone else can open).** Plan 33 ([BACKLOG #33](../../BACKLOG.md)) carries the slugged-share-URL flow; the Share-clip download is local-only.
- **Ungenerated-chapter gating.** This plan's spec had no invariant about chapters without audio — the Share-clip button rendered active on a `queued`/`in_progress`/`failed` row, opening a modal that couldn't cut a clip (zero-length window). [Plan 159](../159-listen-ungenerated-chapter-affordances.md) disables the button (and the row's Play button) unless `chapter.state === 'done'`.

## Ship notes

Shipped 2026-05-19 on branch `feat/frontend+server-share-chapter-clip`. Commit SHA filled in post-merge.

Wave 3.S6 of the v1.4.0 alpha-launch pre-cutover slate. Sibling Wave-3 features (S3 streaming-link tile, S4 editorial notes) ran in parallel worktrees touching different `src/components/listen/listen-*.tsx` sub-components — no merge conflicts expected.

Behaviour delta vs. the BACKLOG spec:

- The BACKLOG bullet says "next to the play affordance" — implemented as a per-row Share icon in the existing trailing-actions span (next to Regenerate). The previously-disabled Download button is replaced by Share-clip; the chapter-download story moves to BACKLOG #34 (export-queue Retry / Download row actions) where it has always belonged.
- Default ±15 s window is centred on the listen-progress bookmark for the currently-playing chapter, falling back to chapter midpoint for chapters the user hasn't started yet (rather than always defaulting to chapter midpoint as the BACKLOG entry implies for the "current playhead" framing). This matches the manual acceptance walkthrough's "play chapter 2, click Share clip" expectation.
