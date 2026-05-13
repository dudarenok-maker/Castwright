# Chapter audio format (MP3 VBR V2)

> Status: stable
> Key files: `server/src/tts/mp3.ts`, `server/src/tts/wav.ts`, `server/src/workspace/chapter-audio-file.ts`, `server/src/routes/generation.ts`, `server/src/routes/chapter-audio.ts`, `scripts/start-app.ps1`
> URL surface: `GET /api/books/:bookId/chapters/:chapterId/audio`, `GET …/audio.mp3`, `GET …/audio.wav`
> OpenAPI ops: `ChapterAudio` (`openapi.yaml:714`) — `url` is the format-specific suffix the locator resolved to.
> Paired tests: `server/src/tts/mp3.test.ts`, `server/src/tts/wav.test.ts`, `server/src/routes/chapter-audio.test.ts`
> Cross-links: [16 — Generation stream](16-generation-stream.md)

## What this covers

Chapter audio is generated as MP3 (LAME VBR V2 ≈ 140–185 kbps mono at the
sidecar's native sample rate, typically 24 kHz). PCM concatenation happens
in Node after per-sentence synthesis returns from the sidecar; the
concatenated buffer is then piped through system `ffmpeg` once per chapter
to avoid MP3 frame-alignment issues that per-segment encoding would cause.

Legacy chapters generated as `.wav` before this switch keep playing without
re-render — the locator probes `.mp3` first, falls back to `.wav`. Voice
sample previews (`server/src/routes/voice-sample.ts`) deliberately stay WAV
for now; samples are short and in-browser only.

## Why MP3

- Size: ~10–12× smaller than 24 kHz / 16-bit mono WAV. An 8-hour audiobook
  drops from ~1.4 GB to ~600 MB.
- Compatibility: every phone audiobook app (Audible imports, Apple Books,
  Plex, Voice, etc.), every browser `<audio>`, every media library.
- The OpenAPI contract at `openapi.yaml:721` already documents
  `Signed MP3/Opus URL` — switching the implementation aligned the writer
  with the spec.

## Invariants to preserve

- Every newly-generated chapter lands on disk as `<slug>.mp3`. The MPEG
  frames are MPEG-2 Layer III mono at the sidecar's native sample rate.
- `<slug>.mp3.tmp-<pid>-<ts>` is the atomic-write temp path; `rename(2)`
  promotes it to the final name. A crash mid-write must never leave a
  half-MP3 that the scan code mistakes for a complete chapter.
- Legacy `<slug>.wav` files keep playing. `chapterAudioExists` returns true
  for either extension; `findChapterAudio` prefers `.mp3` when both exist.
- The `<chapterId>/audio` JSON endpoint returns a `url` whose suffix matches
  the file that actually exists on disk (`audio.mp3` or `audio.wav`).
- `<chapterId>/audio.mp3` and `<chapterId>/audio.wav` are independent: each
  serves only its file and 404s otherwise (so a stale `.wav` left next to a
  regenerated `.mp3` does not shadow the new file).
- `Content-Type` matches the served extension (`audio/mpeg` ↔ `.mp3`,
  `audio/wav` ↔ `.wav`).
- Range requests (`Range: bytes=…`) return 206 partial content from both
  endpoints — `<audio>` seeking depends on this.
- The wire protocol between Node and the Python sidecar stays **raw PCM**.
  Encoding is a Node-side concern; do not push it into `tts-sidecar/main.py`.
- `ffmpeg` is a hard runtime dep. `scripts/start-app.ps1` fails fast with a
  `winget install Gyan.FFmpeg` hint if it isn't on PATH. The
  `encodePcmToMp3` helper additionally surfaces the same hint on spawn
  ENOENT.

## Acceptance walkthrough

Use the canonical end-to-end manuscript at
`C:\Users\dudar\Downloads\Bonus Keefe Story.txt` — see the recipe below.
Run with `VITE_USE_MOCKS=false`, sidecar up, ffmpeg on PATH.

### End-to-end recipe (canonical, cite from other plans)

1. `npm run start` (or `scripts/start-app.ps1`) — preflight should pass
   silently when ffmpeg is installed.
2. App opens. From Books, **Upload** the canonical manuscript:
   `C:\Users\dudar\Downloads\Bonus Keefe Story.txt`.
3. Confirm metadata; let analysis run. Expected cast includes at minimum
   Keefe, Elwin, Ro, and a narrator.
4. Confirm cast → **Generate** chapter 1.
5. On-disk: `<workspace>\books\<Author>\<Series>\<Title>\audio\<slug>.mp3`
   exists. No `<slug>.wav` for this chapter.
6. `ffprobe <slug>.mp3` reports `Audio: mp3, 24000 Hz, mono`, bitrate
   ≈ 140–185 kbps VBR, duration close to `state.json` chapter duration.
7. MiniPlayer plays the chapter, seeks past the midpoint without glitches.
   Network panel: `GET …/audio` returns 200 JSON; `GET …/audio.mp3` with a
   `Range` header returns 206.
8. (Backwards-compat) drop a hand-made `<slug>.wav` for an *old* chapter
   back into the audio dir; the JSON endpoint returns its `/audio.wav` URL
   and the file plays.
9. (Optional) change a voice assignment for one character and re-generate
   chapter 1. The new MP3 replaces the old one atomically — no half-file
   ever observable on disk, the file size and `state.json` duration update,
   playback in MiniPlayer reflects the new voice.

## Canonical e2e fixture

`C:\Users\dudar\Downloads\Bonus Keefe Story.txt` — Keeper of the Lost
Cities bonus story by Shannon Messenger. Multi-character (Keefe, Elwin,
Ro, narrator). **Do not commit** — copyrighted. Future regression plans
that need a full pipeline run should cite this file and the recipe above
rather than inventing new fixtures.

## Out of scope (follow-ups)

- AAC/M4A or Opus output. The encoder boundary in `encodePcmToMp3` is
  small enough that swapping `libmp3lame` for `aac`/`libopus` is the only
  change needed; left for a future PR with a deliberate codec choice.
- Batch transcode of historical `.wav` chapters into `.mp3`. Users can
  re-generate the chapter through the UI; no migration script in v1.
- Voice samples (`server/src/routes/voice-sample.ts`) still write `.wav`.
  Same encoder boundary, marginal size win because samples are short and
  in-browser only. Tracked in CLAUDE.md "Suggested follow-ups".
- Gapless concatenation across chapters. Each chapter is independent;
  inter-chapter playback is the player's concern.
- Sidecar-side encoding. The PCM wire protocol is intentionally lossless
  to keep the Python boundary simple; revisit only if Node-side encoding
  becomes a measurable bottleneck.
