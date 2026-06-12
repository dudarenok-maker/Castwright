---
status: stable
shipped: 2026-05-13
owner: null
---

# Audio output format (MP3 VBR V2)

> Status: stable
> Key files: `server/src/tts/mp3.ts`, `server/src/tts/synthesise-chapter.ts`, `server/src/tts/chapter-title-narration.ts`, `server/src/workspace/chapter-audio-file.ts`, `server/src/routes/generation.ts`, `server/src/routes/chapter-audio.ts`, `server/src/routes/voice-sample.ts`, `scripts/start-app.ps1`
> URL surface: `GET /api/books/:bookId/chapters/:chapterId/audio`, `GET …/audio.mp3`, `POST /api/voices/:voiceId/sample`
> OpenAPI ops: `ChapterAudio` (`openapi.yaml`) — `url` is `…/audio.mp3`; `getVoiceSample` returns a URL under `/audio/voices/`.
> Paired tests: `server/src/tts/mp3.test.ts`, `server/src/tts/pcm.test.ts`, `server/src/tts/chapter-title-narration.test.ts`, `server/src/tts/synthesise-chapter.test.ts`, `server/src/workspace/chapter-audio-file.test.ts`, `server/src/routes/chapter-audio.test.ts`, `server/src/routes/voice-sample.test.ts`
> Cross-links: [16 — Generation stream](16-generation-stream.md), [10 — Profile drawer](10-profile-drawer.md), [archive/39 — Purge WAV](archive/39-purge-wav.md)

## What this covers

Both writer paths — full chapter audio and short voice-sample previews —
emit MP3 (LAME VBR V2 ≈ 140–185 kbps mono at the sidecar's native sample
rate, typically 24 kHz). PCM concatenation happens in Node after per-sentence
synthesis returns from the sidecar; the concatenated buffer is then piped
through system `ffmpeg` once per file to avoid MP3 frame-alignment issues
that per-segment encoding would cause.

MP3 is the only audio format the codebase recognises. The locator probes
only `.mp3`; legacy `.wav` files left on disk from before the format
switch (or from before plan 39) are invisible — the user re-renders the
chapter through the UI if they need playback.

## Why MP3

- Size: ~10–12× smaller than 24 kHz / 16-bit mono WAV. An 8-hour audiobook
  drops from ~1.4 GB to ~600 MB.
- Compatibility: every phone audiobook app (Audible imports, Apple Books,
  Plex, Voice, etc.), every browser `<audio>`, every media library.
- The OpenAPI contract at `openapi.yaml:721` already documents
  `Signed MP3/Opus URL` — switching the implementation aligned the writer
  with the spec.

## Invariants to preserve

### Chapter audio

- Each chapter MP3 opens with **1.5 s of silence**, then the narrator
  speaks a constructed title narration (e.g. `'Chapter 2. Moolark.'`)
  built from `chapter.id` + parsed `chapter.title` via
  `buildChapterTitleNarration` (`server/src/tts/chapter-title-narration.ts`),
  then **1.5 s of silence**, then the chapter body. The narration is
  re-emitted from the parsed title pieces so the listener hears a clean
  two-clause utterance regardless of how the source manuscript
  punctuated its heading. Bare-name titles ("Prologue", "Day One",
  "Moolark") are spoken verbatim with no auto-injected `Chapter N`
  prefix — front-matter stays front-matter. Empty/whitespace titles
  fall back to `"Chapter <id>."` so every chapter still gets a header
  beat.
- The title's TTS response anchors the chapter's sample rate (same
  invariant that previously applied to the first body group). Body
  groups at a mismatched rate are resampled to the title anchor.
- `segments[0].kind === 'title'` marks the title segment in
  `segments.json`. Body segments leave `kind` undefined. Title segments
  are filtered out of the `ChapterAudio` API response (`url`/`peaks`/
  `segments`) — the OpenAPI contract types `sentenceId` as a required
  integer and title segments have an empty `sentenceIds[]`. On-disk
  retention lets the writer audit + future timeline UI opt in.
- Every newly-generated chapter lands on disk as `<slug>.mp3`. The MPEG
  frames are MPEG-2 Layer III mono at the sidecar's native sample rate.
- `<slug>.mp3.tmp-<pid>-<ts>` is the atomic-write temp path; `rename(2)`
  promotes it to the final name. A crash mid-write must never leave a
  half-MP3 that the scan code mistakes for a complete chapter.
- `findChapterAudio` returns `{ path, ext: 'mp3', mime: 'audio/mpeg',
urlSuffix: 'audio.mp3' }` when `<slug>.mp3` exists, or null. No probe
  loop; `.wav` on disk is ignored.
- `chapterAudioExists` checks only `<slug>.mp3`.
- The `<chapterId>/audio` JSON endpoint returns `url` ending in
  `audio.mp3`, or 404 when no `.mp3` exists.
- `<chapterId>/audio.mp3` is the only file-serving route. There is no
  `audio.wav` route; a `GET …/audio.wav` returns 404 because nothing
  matches.
- `Content-Type` is always `audio/mpeg`.
- Range requests (`Range: bytes=…`) return 206 partial content —
  `<audio>` seeking depends on this.
- The wire protocol between Node and the Python sidecar stays **raw PCM**.
  Encoding is a Node-side concern; do not push it into `tts-sidecar/main.py`.
- `ffmpeg` is a hard runtime dep. `scripts/start-app.ps1` fails fast with a
  `winget install Gyan.FFmpeg` hint if it isn't on PATH. The
  `encodePcmToMp3` helper additionally surfaces the same hint on spawn
  ENOENT.

### Voice samples

- Cache filename is `${voiceId}-${modelKey}-${paramHash}.mp3` under
  `server/audio/voices/`. The `paramHash` covers `(text, voiceName)` so any
  attribute edit that picks a different prebuilt voice or evidence line
  busts the cache automatically.
- Served via `app.use('/audio', express.static(AUDIO_DIR))` in
  `server/src/index.ts` — no hand-rolled handler. `Content-Type: audio/mpeg`
  comes from express.static's built-in `.mp3` mapping.
- No range-request contract. Samples are ~12 seconds; `<audio>` plays them
  end-to-end without seeking, so the static middleware's defaults are fine.
- The route honours an `encoder_unavailable` 503 error code when ffmpeg
  fails to spawn (separate from `sidecar_down` which means the TTS engine
  is unreachable). The UI can act on the codes independently.
- `AUDIO_DIR` is overridable via `VOICE_SAMPLE_AUDIO_DIR` so the test suite
  writes into a tmpdir instead of the dev server's real audio dir.

## Acceptance walkthrough

Use the canonical end-to-end manuscript at
`server/src/__fixtures__/the-coalfall-commission.md` — see the recipe below.
Run with `VITE_USE_MOCKS=false`, sidecar up, ffmpeg on PATH.

### End-to-end recipe (canonical, cite from other plans)

1. `npm run start` (or `scripts/start-app.ps1`) — preflight should pass
   silently when ffmpeg is installed.
2. App opens. From Books, **Upload** the canonical manuscript:
   `server/src/__fixtures__/the-coalfall-commission.md`.
3. Confirm metadata; let analysis run. Expected cast includes at minimum
   Marlow, Oduvan, Ro, and a narrator.
4. Confirm cast → **Generate** chapter 1.
5. On-disk: `<workspace>\books\<Author>\<Series>\<Title>\audio\<slug>.mp3`
   exists. No `<slug>.wav` for this chapter.
6. `ffprobe <slug>.mp3` reports `Audio: mp3, 24000 Hz, mono`, bitrate
   ≈ 140–185 kbps VBR, duration close to `state.json` chapter duration.
7. MiniPlayer plays the chapter, seeks past the midpoint without glitches.
   The chapter opens with 1.5 s of silence, the narrator announces the
   chapter (e.g. `"Chapter 1."` or `"Chapter 2. Moolark."`), then 1.5 s
   of silence, then the body begins. Listener can audibly distinguish
   the chapter boundary across the chapter-1 → chapter-2 hand-off.
   Network panel: `GET …/audio` returns 200 JSON; `GET …/audio.mp3`
   with a `Range` header returns 206.
8. (Optional) change a voice assignment for one character and re-generate
   chapter 1. The new MP3 replaces the old one atomically — no half-file
   ever observable on disk, the file size and `state.json` duration update,
   playback in MiniPlayer reflects the new voice.

## Canonical e2e fixture

`server/src/__fixtures__/the-coalfall-commission.md` — Keeper of the Lost
Cities bonus story by Shannon Messenger. Multi-character (Marlow, Oduvan,
Ro, narrator). **Do not commit** — copyrighted. Future regression plans
that need a full pipeline run should cite this file and the recipe above
rather than inventing new fixtures.

## Out of scope (follow-ups)

- AAC/M4A or Opus output. The encoder boundary in `encodePcmToMp3` is
  small enough that swapping `libmp3lame` for `aac`/`libopus` is the only
  change needed; left for a future PR with a deliberate codec choice.
- Configurable silence durations per book or per cast preference. Today
  the 1.5 s leading + 1.5 s post-title constants live next to
  `synthesiseChapter` (`server/src/tts/synthesise-chapter.ts`). The
  inter-chapter break itself is no longer the player's concern — the
  producer now bakes the leading pause into each chapter file.
- Sidecar-side encoding. The PCM wire protocol is intentionally lossless
  to keep the Python boundary simple; revisit only if Node-side encoding
  becomes a measurable bottleneck.
