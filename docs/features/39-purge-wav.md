---
status: draft
shipped: null
owner: null
---

# Purge WAV — MP3 is the only audio format

> Status: draft
> Key files: `server/src/workspace/chapter-audio-file.ts`, `server/src/routes/chapter-audio.ts`, `server/src/workspace/preserve-previous-audio.ts`, `server/src/workspace/scan.ts`, `server/src/routes/book-state.ts`, `server/src/tts/wav.ts`, `server/src/routes/voice-sample.ts`, `server/src/tts/synthesise-chapter.ts`, `server/src/routes/generation.ts`, `server/src/export/build-mp3-zip.ts`, `server/src/index.ts`, `server/tts-sidecar/main.py`, `src/views/generation.tsx`, `src/lib/api.ts`, `src/lib/use-sample-playback.test.ts`, `src/mocks/audio/stub-a.wav`, `src/mocks/audio/stub-b.wav`, `openapi.yaml`
> URL surface: removes `GET …/audio.wav` and `GET …/audio/previous.wav`; live surface collapses to `GET …/audio.mp3` and `GET …/audio/previous.mp3`.
> OpenAPI ops: `ChapterAudio` (drop `.wav` URL variant from description), `streamGeneration` (drop legacy-fallback narrative), `delete previous audio` (scope narrows to `.previous.mp3`).
> Paired tests: `server/src/routes/chapter-audio.test.ts`, `server/src/workspace/preserve-previous-audio.test.ts`, `server/src/tts/pcm.test.ts` (renamed from `wav.test.ts`), `server/src/export/build-mp3-zip.test.ts`, `server/src/export/build-mp3-folder.test.ts`, `server/src/export/build-m4b.test.ts`, `src/lib/use-sample-playback.test.ts`
> Cross-links: [28 — Audio output format](28-chapter-audio-format.md) (this plan retires the legacy-WAV fallback documented there).

## Benefit / Rationale

- **User:** removes the misleading "Output: WAV (16-bit PCM)" label in
  the Generation view footer (`src/views/generation.tsx:627`) that
  contradicts the actual MP3 output. No other user-visible behaviour
  change.
- **Technical:** deletes ~150 lines of branching code paths (probe-both
  loops, dual-extension route handlers, dual-extension test fixtures).
  Locator becomes a single `existsSync` call; preserve-previous returns
  a boolean instead of an extension. `server/src/tts/wav.ts` and its
  test file disappear entirely.
- **Architectural:** locks "chapter audio is MP3" as a one-format
  invariant. Future contributors can no longer accidentally re-introduce
  WAV branches because there are no remaining `'wav'` literals to copy
  from.

## Architectural impact

- **No new seams.** This is a subtraction.
- **Invariants preserved:** the OpenAPI-source-of-truth contract
  ([24](24-openapi-source-of-truth.md)) — every shape change goes
  through `openapi.yaml` first, then `npm run openapi:types` regenerates
  `src/lib/api-types.ts`. The mock toggle
  ([23](23-mock-toggle.md)) and RTK immer
  ([26](26-rtk-immer.md)) are untouched.
- **Migration story:** none. Legacy on-disk `audio/<slug>.wav` and
  `audio/<slug>.previous.wav` files become unreferenced. The user
  re-renders affected chapters through the UI if they hit one.
- **Reversibility:** revert the PR. The deleted endpoints, probe order,
  and dead-code helpers come back from git. No data migration to undo.

## Scope decisions

1. **No on-disk migration.** Legacy `audio/<slug>.wav` is invisible to
   the locator post-purge. User regenerates if needed.
2. **`m4a` and `opus` stay in audio-file regexes.** The
   `/\.(mp3|m4a|wav|opus)$/i` filter at `scan.ts:252` and
   `book-state.ts:201,721` loses only `wav` — `m4a`/`opus` are unrelated
   import flows out of scope here.
3. **Mock fixtures transcode in place.**
   `ffmpeg -i stub-a.wav -c:a libmp3lame -q:a 2 stub-a.mp3` (and stub-b),
   then delete the `.wav` originals. ffmpeg is on PATH per the
   `scripts/start-app.ps1` preflight gate.
4. **`pcmDurationSec` survives**, relocated. Move to
   `server/src/tts/pcm.ts`. Delete `pcmToWav` and `wav.ts` entirely.
5. **Plan 28 is edited in place**, not re-archived. Its invariants
   section drops every backwards-compat clause; "Out of scope" drops
   the "Batch transcode" and "Cleanup orphan `.wav` samples" bullets.
6. **`force?: boolean` semantics unchanged.** `chapterAudioExists` stays
   format-agnostic in name but probes only `.mp3` post-purge — that
   matches the new "only mp3 counts as a complete chapter" invariant.

## Implementation outline

### Server runtime

- `server/src/workspace/chapter-audio-file.ts` — narrow
  `ChapterAudioExt` to `'mp3'` (or delete it and inline the literal).
  `findChapterAudio` and `chapterAudioExists` probe only `.mp3`. Drop
  the prefer-mp3-over-wav comment.
- `server/src/routes/chapter-audio.ts` — collapse `EXT_MIME` to a single
  constant. Remove `audio.wav` and `audio/previous.wav` route
  registrations. `findPreviousChapterAudio` probes `.previous.mp3` only.
  Update file-header comment block.
- `server/src/workspace/preserve-previous-audio.ts` — narrow
  `PreserveResult` to `{ preserved: boolean }` (drop `ext`).
  `hasPreviousAudio` checks only `.previous.mp3`.
- `server/src/workspace/scan.ts:252` — regex `/\.(mp3|m4a|opus)$/i`.
- `server/src/routes/book-state.ts:201,721` — same regex/array change.
- `server/src/tts/wav.ts` — **delete file**. Move `pcmDurationSec` and
  its `BYTES_PER_SAMPLE` / `CHANNELS` constants into
  `server/src/tts/pcm.ts`. Delete `pcmToWav`.
- `server/src/tts/synthesise-chapter.ts:13` — import from `./pcm.js`.
- `server/src/routes/voice-sample.ts:22` — same import update.
- `server/src/routes/generation.ts` — strip `.wav` mentions from the
  file-header comment (lines 11, 17, 19) and the preservation comment
  (line 480). No functional code change.
- `server/src/tts/gemini.ts:3` — comment fix ("wraps in WAV" → describe
  raw PCM return).
- `server/src/export/build-mp3-zip.ts` — update lines 15 & 61 comments;
  the `audio.ext !== 'mp3'` check at line 71 simplifies to `!audio`.
- `server/src/index.ts:101` — comment update.

### Sidecar (Python)

- `server/tts-sidecar/main.py`
  - Remove `import wave` (line 30) if dead after helper removal.
  - Update Engine docstring (line 142): "Node wraps PCM in WAV" → "Node
    encodes PCM to MP3".
  - Update line 446 comment block.
  - Remove `_wav_bytes` helper at lines 877–881 if unreferenced.
- `server/tts-sidecar/README.md:346` — wording.
- `server/tts-sidecar/tests/test_synthesize.py:314` — comment wording
  only; the test itself doesn't build a WAV header.

### Frontend

- `src/views/generation.tsx:627` — `Output: WAV (16-bit PCM)` →
  `Output: MP3 (VBR V2)`.
- `src/lib/api.ts:32–33` — imports point at `stub-a.mp3` / `stub-b.mp3`.
- `src/lib/api.ts:190` — comment fix ("Re-synthesise even if a chapter's
  WAV already exists" → "MP3").
- `src/lib/use-sample-playback.test.ts:53,66,87,89` — change four
  `/audio/voices/*.wav` paths to `.mp3`.
- `src/lib/api-types.ts` — DO NOT hand-edit; regenerated via
  `npm run openapi:types` after `openapi.yaml` is updated.

### Mock fixtures

- `src/mocks/audio/stub-a.wav` → transcode to `stub-a.mp3`, delete wav.
- `src/mocks/audio/stub-b.wav` → transcode to `stub-b.mp3`, delete wav.

### OpenAPI

- `openapi.yaml:460` — "caches the WAV" → "caches the MP3".
- `openapi.yaml:529–531` — drop the "Legacy `.wav` files … falls back to
  `.wav`" sentence; simplify to "writes `audio/<chapterSlug>.mp3`".
- `openapi.yaml:599` — "Deletes `audio/<slug>.previous.{mp3,wav}`" →
  "Deletes `audio/<slug>.previous.mp3`".
- `openapi.yaml:1282` — "writes the WAV + segments JSON" → "writes the
  MP3 + segments JSON".
- `openapi.yaml:1514` (`peaks` "Pre-computed waveform envelope") —
  **leave alone**, this is the visualization term, not the format.
- Run `npm run openapi:types` after.

### Tests

- `server/src/routes/chapter-audio.test.ts` — delete the wav-only
  describe (line 206) and the both-files-exist describe (line 227).
  Convert "audio.wav 404s" into an explicit "route does not exist"
  assertion (route not registered → 404). Drop the `writeWav` helper.
- `server/src/workspace/preserve-previous-audio.test.ts` — delete the
  "preserves legacy .wav" (line 54), "prefers mp3 over wav" (line 95),
  and "returns true for .previous.wav" (line 121) tests.
- `server/src/tts/wav.test.ts` — delete file. Move `pcmDurationSec`
  cases into new `server/src/tts/pcm.test.ts`; drop `pcmToWav` block.
- `server/src/export/build-mp3-zip.test.ts`,
  `build-mp3-folder.test.ts`, `build-m4b.test.ts` — rewrite the "only a
  .wav" rejection tests as "no audio file at all" rejections (delete the
  wav fixture write; assert `ExportIncompleteError` for the zero-audio
  slug).
- `server/src/routes/voice-sample.test.ts:86` — comment cleanup.

### New regression coverage

- `server/src/routes/chapter-audio.test.ts` — explicit test that
  `GET …/audio.wav` returns 404 so a future accidental re-introduction
  is caught.
- `server/src/workspace/chapter-audio-file.test.ts` (new if absent) —
  `findChapterAudio` returns null when only a `.wav` file exists on
  disk; proves legacy files are not picked up.

### Docs to update

- `docs/features/28-chapter-audio-format.md` — substantial rewrite to
  remove legacy-WAV fallback narrative. Drop `wav.ts` from "Key files" +
  "Paired tests"; drop `audio.wav` from "URL surface"; rewrite
  Invariants; drop step 8 from the e2e recipe; drop two bullets from
  "Out of scope".
- `docs/features/16-generation-stream.md` — lines 6, 25, 58, 59.
- `docs/features/18-listen-view.md` — lines 6, 15, 42–43, 47, 89.
- `docs/features/32-audiobook-export.md` — lines 24, 57.
- `docs/features/14-tts-sidecar-coqui.md` — lines 10, 16, 29, 33.
- `docs/features/14a-tts-sidecar-kokoro.md:119`.
- `docs/features/15-tts-gemini-cloud.md` — lines 16, 24, 29.
- `docs/features/INDEX.md:70` — drop "legacy `.wav` fallback for
  chapters" from plan 28 summary; ensure the new plan 39 entry stays
  under area F.
- `docs/BACKLOG.md:71` — update wording that mentions
  `src/mocks/audio/stub.wav`.
- `docs/project-narrative.md:83` — drop "legacy WAV fallback for
  pre-format chapters" wording.
- `CLAUDE.md` — verify no remaining references to the deleted
  `wav.test.ts`.

## Invariants to preserve (post-purge)

These replace the analogous clauses in plan 28:

- `server/src/workspace/chapter-audio-file.ts` — `findChapterAudio`
  returns `{ path, ext: 'mp3', mime: 'audio/mpeg', urlSuffix: 'audio.mp3' }`
  or null. No probe loop.
- `server/src/routes/chapter-audio.ts` — route table registers exactly
  `GET …/audio`, `GET …/audio.mp3`, `GET …/audio/previous`,
  `GET …/audio/previous.mp3`, `DELETE …/audio/previous`,
  `POST …/audio/previous/restore`. No `.wav` route exists.
- `ChapterAudio.url` from `GET …/audio` always ends in `audio.mp3`.
- `ChapterAudio.url` for the previous variant always ends in
  `audio/previous.mp3`.

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/chapter-audio.test.ts`) — mp3
  scenarios pass; `audio.wav` 404 lock added.
- Vitest server (`server/src/workspace/preserve-previous-audio.test.ts`)
  — mp3-only preservation passes.
- Vitest server (`server/src/tts/pcm.test.ts`) — `pcmDurationSec` cases
  moved here.
- Vitest server (`server/src/export/build-mp3-zip.test.ts`,
  `build-mp3-folder.test.ts`, `build-m4b.test.ts`) — zero-audio rejection
  passes.
- Vitest frontend (`src/lib/use-sample-playback.test.ts`) — paths
  updated to `.mp3`.
- Playwright (existing) — Generate → Listen golden path; no new spec
  needed (UI behaviour unchanged).
- pytest sidecar (existing) — passes after `import wave` removal.

### Manual acceptance walkthrough

1. Boot dev server with `VITE_USE_MOCKS=true` → `npm run dev`. Open any
   mock book → Generate → footer reads **"Output: MP3 (VBR V2)"**.
2. Listen view plays the mp3 stub fixture from
   `src/mocks/audio/stub-a.mp3`.
3. With `VITE_USE_MOCKS=false` against a real server: regenerate a
   chapter → `audio/<slug>.mp3` lands on disk. `audio/<slug>.wav` is
   never created.
4. Hit `GET …/audio.wav` against the server → 404 with no fallback.
5. `npm run verify` is green (typecheck + all tests + e2e + build).

## Out of scope

- Cleaning up on-disk legacy `audio/<slug>.wav` /
  `audio/<slug>.previous.wav` files in user workspaces. They become dead
  bytes; locator never resolves to them. User can re-render to replace.
- Touching the `Waveform` component or the `peaks` field — those
  describe the audio-peaks visualization, not the WAV container format.
- Changing the Node ↔ sidecar wire protocol (stays raw PCM).
- AAC / Opus output (already listed in plan 28's "Out of scope").

## Ship notes

(Filled when status flips to `stable`.)
