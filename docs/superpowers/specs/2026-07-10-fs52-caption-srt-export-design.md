# fs-52 — Caption/SRT export design

> Spec (validated design) · 2026-07-10 · fs-52 / [#975](https://github.com/dudarenok-maker/Castwright/issues/975)
> Revised after two Opus-tier `assumption-checker` passes (2026-07-10) — see the two
> "Revision note" sections at the end for what changed each round and why.

## 1. Goal & scope

Emit `.srt` / `.vtt` captions in **line**, **sentence**, and **word** granularity from a
finished book's rendered audio, reusing the per-sentence alignment already produced during
synthesis (plan 70d). Table-stakes parity feature (abogen's headline capability) that also
feeds future demo/social-clip tooling. Out of scope for v1: manual caption-cue editing,
burned-in/hardsub video generation (this ships caption *files* only).

## 2. Timing sources

- **Line and sentence granularity need no new data — but the sentence-text source is
  `manuscript-edits.json`, not the analysis cache (revised).** Since plan 70d, every
  rendered chapter's `<slug>.segments.json` carries one segment per sentence
  (`ChapterSegmentsFile`, `server/src/audio/finalize-chapter-write.ts`) with
  chapter-relative `startSec`/`endSec` + `characterId`. The original draft proposed
  joining sentence text from the analysis cache (`analysis.chapters[chapterId]`), the same
  join `generation.ts` performs at render time. The round-2 assumption-checker pass flagged
  this as the single most dangerous assumption in the spec: that cache lives at
  `server/handoff/cache/{manuscriptId}.json` — an install-relative path, outside the
  per-book workspace, whose documented purpose is resumable in-flight analysis, not durable
  post-render storage. It can be evicted, and doesn't travel with the book if the workspace
  moves to another machine (a portability the export code already supports). **Fix:** join
  sentence text from `manuscript-edits.json` instead (`manuscriptEditsJsonPath(bookDir)`,
  `server/src/workspace/paths.ts` — lives under the book's own `.audiobook/` directory, so
  it's durable and portable with the book). It already carries `{ id, chapterId,
  characterId, text }` per sentence — the exact shape needed, and the exact file
  `rebuildCacheFromEdits` (`server/src/store/analysis-cache-rebuild.ts`) already uses
  elsewhere as the source of truth when the analysis cache itself is stale/absent. No
  schema change, and no dependency on the analysis cache's lifecycle at all.
- **Word granularity has no existing data and needs a new sidecar capability.** The
  existing `/transcribe` endpoint (Whisper, srv-31) returns only a whole-segment transcript
  + confidence signals, never per-word timestamps. `faster-whisper` (already vendored in
  `server/tts-sidecar/`) natively supports `word_timestamps=True` — a bounded, additive
  sidecar change: an opt-in `X-Word-Timestamps: 1` request header on `/transcribe`, adding a
  `words: [{word, start, end}] | null` field to the JSON response. The existing QA caller
  (`segment-asr-qa.ts`) never sets the header, so its behaviour and tests are unaffected.
  `transcribeSegment` (`server/src/tts/transcribe-client.ts`) gains a `wordTimestamps?:
  boolean` option and a typed `words` field on `TranscribeResult`.
- **Word timing procedure, at export time only — one pass per CHAPTER, not per sentence
  (revised).** The original draft proposed ffmpeg-trimming and transcribing each sentence
  segment individually. The assumption-checker pass flagged this as both expensive (one
  ffmpeg spawn + one serial HTTP round-trip per sentence — 300+ for a long book) and
  accuracy-risking (trimming at exact segment boundaries can clip a word's onset/offset,
  and denies Whisper the surrounding context that improves recognition; the existing
  `vad_filter=True` decode setting is also more likely to shift/clip timing on an isolated
  1-2s clip than on a full chapter). The revised procedure: decode the *whole* finalized
  chapter audio (`<slug>.<ext>`) to 16 kHz mono PCM once, and call `/transcribe` **once per
  chapter** with word timestamps requested — `WhisperEngine.transcribe` already accepts
  arbitrary-length PCM (faster-whisper internally windows long audio), so this is the same
  call signature as today, just fed the whole chapter instead of a per-sentence trim.
  Returned word times are already chapter-relative, so no per-segment offset math is
  needed; for whole-book scope, offset by the chapter's cumulative start (see the
  offset-drift fix below).
- **Decode profile diverges from the QA path when word timestamps are requested (round-2
  decision).** The QA path's `condition_on_previous_text=False` was a deliberate
  anti-hallucination choice for independently-verified single sentences — but applied to a
  whole chapter it removes cross-window context at every ~30s boundary, which measurably
  hurts transcription coherence/punctuation exactly where captions want it most. Rather
  than reuse the QA call unmodified, `WhisperEngine.transcribe` gains the `word_timestamps`
  parameter as the switch for a distinct, caption-tuned decode profile: whenever
  `word_timestamps=True`, it also passes `condition_on_previous_text=True` (kept `False`
  only for the existing QA call, which never requests word timestamps). This is a
  consciously separate, separately-justified profile — not a shared one — since captions
  are a listener-facing artifact where coherence matters more than the QA gate's
  determinism goal, and the two call sites never overlap.
- **Title-beat handling in word mode:** the `kind: 'title'` segment has no manuscript
  sentence to align ASR output against. Any returned words whose timestamp falls before the
  first body segment's `startSec` are dropped from the word stream and replaced with a
  single fixed-timing cue showing the chapter title text (spanning the title segment's own
  `[startSec, endSec)`) — matching how sentence/line mode already treat the title beat.
- Word cues use Whisper's own transcribed word text at its aligned timestamp — not the
  manuscript word. This is genuine forced alignment, not an estimate: on the rare TTS
  mispronunciation, the caption shows what was actually *heard*, which is the correct
  behaviour for a caption track. (Whole-chapter context also reduces — though doesn't
  eliminate — the accuracy risk of transcribing short isolated clips in non-English books.)
- ASR always passes the book's language via `X-Language`, same as `segment-asr-qa.ts`
  already does for non-English books.
- **Whole-book offset-drift fix:** cumulative cross-chapter offsets must be computed from
  the *same* per-chapter duration source `build-m4b.ts` uses for its `[CHAPTER]` markers —
  `probeDurationSec` (an ffprobe of the actual encoded chapter file), not
  `segments.json`'s stored `durationSec` — so whole-book caption timings never drift against
  the M4B's chapter boundaries even by rounding.
- **Missing `manuscript-edits.json` (rare):** on the small chance the file is absent
  (e.g. a book rendered before it existed, or manual workspace tampering), the export fails
  with a clear error rather than emitting blank cues — mirroring the existing "No analysed
  sentences cached for this book" pattern (`generation.ts`). This should be far rarer than
  the original analysis-cache-eviction failure mode, since the file is written on every
  successful analysis run and lives durably in the book's own workspace.

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
- **De-dupe/filename key fix (revised).** `server/src/routes/export.ts`'s stale-job
  de-dupe (`revokeStaleSameFormat`) and filename derivation currently key on `format`
  alone — correct when each format has one shape, but captions have 12 variant
  combinations (2 `captionFileFormat` × 3 `captionGranularity` × 2 `captionScope`) all
  under `format: 'captions'`. The assumption-checker pass confirmed that, as originally
  spec'd, requesting a new caption variant would revoke a *different* previously-completed
  caption export, and a `.srt` + `.vtt` of the same book/granularity/scope would clobber
  each other's staged file. Fix: both the de-dupe key and the derived filename must
  include `captionFileFormat`/`captionGranularity`/`captionScope` whenever
  `format === 'captions'`, not just `format`. **Persistence requirement (round 2):** the
  de-dupe check reads `prior` from the persisted job manifest, and jobs rehydrate from disk
  across a server restart — so the three caption fields must be persisted on the
  `BookExportJob` record itself (not just accepted on the request DTO), or the de-dupe key
  can't be reconstructed after a restart.
- **MIME type for whole-book single-file captions (round 2 fix).** The existing
  `mimeForFormat` helper returns `audio/mp4` for `m4b`, else `application/zip` — correct
  for every existing format (all zips or one m4b) but wrong for `captionScope:
  'whole-book'`, which downloads a single `.srt`/`.vtt`, not an archive. Fix:
  `mimeForFormat` returns `application/x-subrip` for a whole-book `.srt` and `text/vtt` for
  a whole-book `.vtt`; `captionScope: 'per-chapter'` keeps `application/zip` like every
  other per-chapter format.
- **No silent fallback.** If `captionGranularity: 'word'` is requested and the sidecar's
  Whisper isn't available, the job fails with a clear `errorReason` naming line/sentence as
  the available alternative. It never silently degrades to an estimated/proportional
  timing — that approach was considered and explicitly rejected in favour of real ASR
  alignment. **Availability signal (revised):** the assumption-checker pass found that
  Whisper is deliberately excluded from the sidecar's `ENGINES` map (it doesn't share the
  synth-engine load/unload contract) — the spec's original "reuses existing
  Coqui/Kokoro/Qwen telemetry" claim doesn't hold as stated. The real, already-existing
  signal is `server/src/routes/sidecar-health.ts`'s `whisperPackageInstalled` /
  `asrLoaded` fields (sourced from the sidecar's `/health` response,
  `main.py`'s `whisper_package_installed` / `asr_loaded`). This is independent of the
  `SEG_ASR_ENABLED` flag (`asrEnabled()`), which gates the *automatic* ASR content-QA
  pass during generation — caption export readiness must check
  `whisperPackageInstalled`, not `asrEnabled()`, since a user may have QA-time ASR
  switched off yet still want an on-demand word-caption export. **Known gap, accepted for
  v1 (round 2):** unlike Qwen, Whisper has no separate "weights present" signal —
  `whisperPackageInstalled` only means the Python package is importable, not that the model
  weights are cached locally. On a package-installed-but-never-loaded box, the UI enables
  Word and `faster-whisper` downloads weights on first load — a one-time latency, not a
  failure, in the common case. A genuine failure (no network, disk error) still surfaces
  via the same clear `errorReason` path. Adding a real weights-present probe (mirroring
  Qwen's `qwen_weights_present`) is a reasonable follow-up, not v1-blocking.
- **OpenAPI/validation surface (round 2 checklist item).** Per CLAUDE.md, OpenAPI is the
  type source of truth. Adding `format: 'captions'` must land in every place the format
  enum is hand-synced: `export.ts`'s `ALLOWED_FORMATS`, its POST validator's 400 message,
  the `BookExportJob.format` TypeScript union, and both the `BookExportRequest` and
  `BookExportJob` schemas in `openapi.yaml` — a plain enumeration, not a design decision,
  but worth calling out explicitly so it isn't missed at implementation time.

## 4. Caption generation logic

New `server/src/export/build-captions.ts`, sibling to `build-m4b.ts` / `build-mp3-zip.ts`:

- **Sentence mode:** one cue per segment, including the `kind: 'title'` beat when present
  (shows the chapter title text). The title beat is conditional, not universal — it's
  gated on `chapterTitleNarration` being non-blank at synthesis time
  (`synthesise-chapter.ts`); when absent, sentence/line/word mode alike simply start their
  cues from the true first body sentence with no title cue.
- **Line mode (bounded fold — revised):** consecutive segments sharing the same
  `characterId` are folded into one cue, but the fold is capped — a cue closes (and a new
  one starts at the next sentence) whenever it hits **~7 seconds** of combined duration or
  **~200 characters**, whichever comes first, in addition to always closing on a speaker
  change. Unbounded, this degenerates badly: the assumption-checker pass pointed out that a
  single-narrator book (the common case) has one `characterId` for the entire chapter, so
  an unbounded fold would collapse a whole chapter into one unusable multi-minute cue. The
  duration/character ceilings mirror common subtitle max-cue-duration convention and keep
  the "one cast member's beat" intent while guaranteeing a readable cue. This reconstruction
  happens only at export time from the already-per-sentence segments — rendering itself is
  unaffected, no schema change to `segments.json`. **Edge cases (round 2, explicit v1
  behaviour):** a single sentence that already exceeds the cap on its own (a long run-on
  line) still emits as one cue — line mode doesn't split *within* a sentence, since
  sub-sentence splitting is word mode's job, not line mode's. Closing a fold early at the
  cap can leave a short trailing fragment as its own cue rather than merging it backward —
  there's no minimum-cue-duration rule in v1; this is accepted, not a bug.
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
  Word option is disabled with a tooltip when `whisperPackageInstalled` is false on the
  book's sidecar-health poll (§3) — a real, already-existing signal, not a new detection
  mechanism.

## 6. Testing

- **Vitest (frontend + server, pure logic):** SRT/VTT formatter output (including
  multi-line-text escaping and format-specific timestamp syntax), line-merge fold
  correctness (same-speaker runs, the duration/character cap closing a cue early, the
  lone-over-cap-sentence and trailing-fragment edge cases, title-beat handling including
  the no-title-beat path), whole-book cumulative-offset arithmetic (using
  `probeDurationSec` values, not `segments.json`'s stored `durationSec`), per-chapter
  zero-basing, the captions-aware de-dupe/filename key including its persistence across a
  simulated restart (§3), and `mimeForFormat`'s whole-book-vs-per-chapter branching.
- **Server integration test:** a fixture `segments.json` + fixture `manuscript-edits.json`
  produces an exact golden-file `.srt`/`.vtt`, using The Coalfall Commission canonical
  fixture per project convention. Include a single-narrator fixture chapter specifically to
  exercise the line-mode cap (regression coverage for the assumption-checker's
  degenerate-cue finding).
- **Sidecar pytest:** extend `server/tts-sidecar/tests/test_transcribe.py` with a
  `word_timestamps=True` case (whole-clip, not per-sentence) asserting the `words[]`
  shape/ordering and that `condition_on_previous_text=True` is passed only on that path,
  plus a case confirming the default (`False`) path is byte-identical to pre-change
  behaviour.
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

## Revision note, round 1 (2026-07-10)

An Opus-tier `assumption-checker` pass (mandatory pre-approval gate) reviewed the initial
draft and found every load-bearing data-shape/API claim confirmed against the actual code,
but flagged five design-judgment gaps, all addressed above: the line-mode fold's degenerate
multi-minute-cue case for single-narrator books (§4, now bounded — resolved via user
decision), the per-sentence word-mode ASR procedure's cost/accuracy risk (§2, now a
whole-chapter pass), the export-job queue's format-only de-dupe/filename key colliding
across the 12 caption variants (§3, now keyed on the full caption tuple), the assumed
ASR-availability telemetry surface that didn't actually exist as described (§3/§5, now
named precisely), and the whole-book offset source needing to match `build-m4b.ts`'s
`probeDurationSec` to avoid drift (§2).

## Revision note, round 2 (2026-07-10)

A second Opus-tier `assumption-checker` pass re-verified the round-1 fixes against the
actual code and found the most dangerous assumption in the whole spec: that line/sentence
caption text could reliably be joined from the analysis cache at export time. That cache
is install-relative and transient-by-design (resumable-analysis scratch space, not durable
storage), so an export run any real time after render — or on a workspace moved to another
machine, which the export code already supports — could hard-fail the feature's two default
granularities. Fixed by sourcing sentence text from `manuscript-edits.json` instead (§2),
which already lives durably in the book's own workspace and already carries the exact
shape needed — no schema change, no analysis-cache dependency at all.

The pass also found four smaller but real follow-on gaps from the round-1 fixes, all
addressed above: the QA decode params being wrong-for-purpose on a whole-chapter caption
pass (§2, now a distinct caption-tuned profile — resolved via user decision), the
export-job de-dupe/filename fix needing the caption fields persisted on the job record
itself, not just the request, to survive a restart (§3), a MIME-type gap serving a
whole-book single-file caption as `application/zip` (§3), and the `whisperPackageInstalled`
availability signal being real but not a complete readiness guarantee (no weights-present
signal exists for Whisper the way it does for Qwen — accepted as a known v1 gap, §3). It
also surfaced and confirmed-sound the title-beat drop logic in word mode, and flagged two
minor edge cases in the line-mode cap (a lone over-cap sentence, a trailing fragment cue)
that are now explicit accepted v1 behaviour rather than unstated gaps (§4).
