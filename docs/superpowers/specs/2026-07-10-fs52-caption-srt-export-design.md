# fs-52 — Caption/SRT export design

> Spec (validated design) · 2026-07-10 · fs-52 / [#975](https://github.com/dudarenok-maker/Castwright/issues/975)

## 1. Goal & scope

Emit `.srt` / `.vtt` captions in **line**, **sentence**, and **word** granularity from a
finished book's rendered audio, reusing the per-sentence alignment already produced during
synthesis (plan 70d). Table-stakes parity feature (abogen's headline capability) that also
feeds future demo/social-clip tooling. Out of scope for v1: manual caption-cue editing,
burned-in/hardsub video generation (this ships caption *files* only).

## 2. Timing sources

- **Line and sentence granularity need no new data.** Since plan 70d, every rendered
  chapter's `<slug>.segments.json` carries one segment per sentence (`ChapterSegmentsFile`,
  `server/src/audio/finalize-chapter-write.ts`) with chapter-relative `startSec`/`endSec` +
  `characterId`. Sentence text is joined in from the analysis cache
  (`analysis.chapters[chapterId]`, keyed by sentence id) — the same join `generation.ts`
  already performs at render time.
- **Word granularity has no existing data and needs a new sidecar capability.** The
  existing `/transcribe` endpoint (Whisper, srv-31) returns only a whole-segment transcript
  + confidence signals, never per-word timestamps. `faster-whisper` (already vendored in
  `server/tts-sidecar/`) natively supports `word_timestamps=True` — a bounded, additive
  sidecar change: an opt-in `X-Word-Timestamps: 1` request header on `/transcribe`, adding a
  `words: [{word, start, end}] | null` field to the JSON response. The existing QA caller
  (`segment-asr-qa.ts`) never sets the header, so its behaviour and tests are unaffected.
  `transcribeSegment` (`server/src/tts/transcribe-client.ts`) gains a `wordTimestamps?:
  boolean` option and a typed `words` field on `TranscribeResult`.
- **Word timing procedure, at export time only:** for each sentence segment, ffmpeg-trim
  the *finalized* chapter audio (`<slug>.<ext>`, whatever `audioFormat` the book rendered
  under) to `[startSec, endSec]`, decode to 16 kHz mono PCM, POST to `/transcribe` with word
  timestamps requested, then offset the returned (segment-local) word times by the
  segment's `startSec` — and, for whole-book scope, by the chapter's cumulative start
  offset, using the same running-cursor arithmetic `build-m4b.ts`'s `buildFfmetadata`
  already uses for its `[CHAPTER]` markers.
- Word cues use Whisper's own transcribed word text at its aligned timestamp — not the
  manuscript word. This is genuine forced alignment, not an estimate: on the rare TTS
  mispronunciation, the caption shows what was actually *heard*, which is the correct
  behaviour for a caption track.
- ASR always passes the book's language via `X-Language`, same as `segment-asr-qa.ts`
  already does for non-English books.

## 3. Export-job integration

Extends the existing `BookExportRequest` / `BookExportJob` pair
(`/api/books/{bookId}/exports`, format enum currently `mp3-zip | m4b | mp3-folder |
aac-m4a-zip | opus-ogg-zip`) rather than a new subsystem — reuses the job queue, progress
polling, download endpoint, cancel endpoint, and `download`/`sync-folder` destinations
as-is.

- New `format: 'captions'`, plus three new request fields, required only when
  `format === 'captions'`:
  - `captionFileFormat: 'srt' | 'vtt'`
  - `captionGranularity: 'line' | 'sentence' | 'word'`
  - `captionScope: 'whole-book' | 'per-chapter'`
- **`whole-book`** scope produces a single `.srt`/`.vtt` file with cumulative
  cross-chapter offsets — pairs with the M4B tile's single-file model.
- **`per-chapter`** scope produces a `.zip` of one caption file per chapter, each
  zero-based (timings reset to chapter start) — pairs with the MP3 ZIP/folder model.
- Line/sentence jobs are metadata-only (no audio decode) → effectively instant; still
  modeled as a job (goes `queued` → `done` in one tick) so the UI/queue-rail code path is
  uniform regardless of granularity. Word jobs report per-chapter progress the same way
  the M4B encode step does today.
- **No silent fallback.** If `captionGranularity: 'word'` is requested and the sidecar's
  Whisper model isn't available (mirrors the existing `PRELOAD`/engine-availability
  telemetry the frontend already reads for Coqui/Kokoro/Qwen), the job fails with a clear
  `errorReason` naming line/sentence as the available alternative. It never silently
  degrades to an estimated/proportional timing — that approach was considered and
  explicitly rejected in favour of real ASR alignment.

## 4. Caption generation logic

New `server/src/export/build-captions.ts`, sibling to `build-m4b.ts` / `build-mp3-zip.ts`:

- **Sentence mode:** one cue per segment, including the `kind: 'title'` beat (shows the
  chapter title text).
- **Line mode:** consecutive segments sharing the same `characterId` are folded into one
  cue spanning their combined start/end. This reconstruction happens only at export time
  from the already-per-sentence segments — rendering itself is unaffected, no schema change
  to `segments.json`.
- **Word mode:** one cue per ASR-recognised word (§2).
- Two pure formatter functions, `writeSrt(cues: CaptionCue[]): string` and
  `writeVtt(cues: CaptionCue[]): string`, sharing one `CaptionCue { startSec, endSec, text,
  speaker? }` intermediate shape — independently unit-testable with no I/O.
- Line/sentence cues get a `SPEAKER: text` prefix (multi-cast disambiguation); word cues
  don't (would be noisy at that granularity).
- `assembleBookCaptions(bookDir, chapters, opts)` orchestrates whole-book (cumulative
  offsets, single output) vs. per-chapter (zero-based per file, zipped via the same
  archiver dependency `build-mp3-zip.ts` already uses).

## 5. Frontend

- New **"Captions"** tile in the "Or download a file" grid in
  `src/components/listen/listen-download-section.tsx` (5th tile, alongside M4B / MP3 ZIP /
  Streaming link / Portable bundle), wired the same way the existing tiles open the shared
  export modal (`onOpenCaptionsExport` handler prop, following the existing
  `onOpenM4bExport`/`onOpenMp3ZipExport` pattern).
- The shared export modal gains a captions section: file-format toggle (.srt/.vtt),
  granularity radio (Line / Sentence / Word), scope radio (Whole book / Per chapter). The
  Word option is disabled with a tooltip when the server reports Whisper/ASR unavailable —
  reusing the existing engine-availability telemetry surfaced elsewhere in the app, not a
  new detection mechanism.

## 6. Testing

- **Vitest (frontend + server, pure logic):** SRT/VTT formatter output (including
  multi-line-text escaping and format-specific timestamp syntax), line-merge fold
  correctness (same-speaker runs, title-beat handling), whole-book cumulative-offset
  arithmetic, per-chapter zero-basing.
- **Server integration test:** a fixture `segments.json` + fixture analysis-cache
  sentences produces an exact golden-file `.srt`/`.vtt`, using The Coalfall Commission
  canonical fixture per project convention.
- **Sidecar pytest:** extend `server/tts-sidecar/tests/test_transcribe.py` with a
  `word_timestamps=True` case asserting the `words[]` shape/ordering, plus a case
  confirming the default (`False`) path is byte-identical to pre-change behaviour.
- **Playwright e2e:** new spec covering the Captions tile → modal → export-queue row →
  (mock-mode) polls to `done` → download link, per the project's "UI-visible behaviour
  crossing router/redux/layout seams gets an e2e test" rule. Word-mode ASR is mocked in the
  e2e's mock-API mode — no real Whisper model needed to exercise the UI flow.

## 7. Out of scope (v1)

- Manual caption-cue editing UI.
- Burned-in/hardsub video generation — this ships caption files; a social-clip tool is a
  separate future consumer of them.
- Running word-mode ASR during synthesis — it only ever runs on-demand at export time, so
  no cost is added to every render.
