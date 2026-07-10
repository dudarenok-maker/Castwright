---
status: active
shipped: null
owner: null
---

# fs-52 — Caption/SRT export

> Status: active
> Key files: `server/src/export/build-captions.ts`, `server/src/export/caption-cues.ts`, `server/src/export/caption-format.ts`, `server/src/export/manuscript-sentences.ts`, `server/src/routes/export.ts`, `src/modals/export-audiobook.tsx`, `src/components/listen/listen-download-section.tsx`
> URL surface: `#/books/<id>/listen` (Captions download tile)
> OpenAPI ops: `POST /api/books/{id}/exports` (format: captions), `GET /api/books/{id}/exports/{exportId}`, `GET /api/books/{id}/exports/{exportId}/download`

## Benefit / Rationale

- **User:** export `.srt`/`.vtt` captions in line/sentence/word granularity, whole-book or per-chapter, for any finished book — abogen-parity feature that also feeds demo/social clips.
- **Technical:** line/sentence captions are pure metadata reconstructions over data already on disk (`segments.json` + `manuscript-edits.json`) — no new render-time cost. Word captions add one on-demand whole-chapter Whisper pass at export time only.
- **Architectural:** extends the existing `BookExportJob` queue rather than a parallel export subsystem — same progress polling, download endpoint, and queue-rail UI as every other export format.

## Architectural impact

- New sidecar capability: `/transcribe` accepts `X-Word-Timestamps`, gated additively — the existing ASR content-QA caller (`segment-asr-qa.ts`) never sets it, so its decode profile and tests are unaffected. `condition_on_previous_text` flips to `True` only alongside `word_timestamps=True` (`server/tts-sidecar/main.py:WhisperEngine.transcribe`) — a distinct, caption-tuned decode profile from the QA path's deterministic-idempotent one, since captions want cross-window coherence on a long chapter while QA wants no cross-sentence hallucination carryover on an isolated clip.
- `BookExportJob`'s de-dupe (`revokeStaleSameFormat`) and filename derivation (`bookFilename`) are now variant-aware for `format: 'captions'` (keyed on `captionFileFormat`/`captionGranularity`/`captionScope`, not `format` alone — `server/src/routes/export.ts`) — the 12 caption variants no longer collide or clobber each other's queue rows.
- No `segments.json` schema change — the per-sentence shape from plan 70d already carries everything line/sentence captions need. The new `ChapterSegment.textHash` staleness stamp (#1105) is read, not written, by this feature.
- Reversibility: every new file lives under `server/src/export/`; reverting is a multi-file `git revert` of this feature's commits, no data migration involved.

## Invariants to preserve

1. Line-mode cues never exceed `LINE_MAX_DURATION_SEC` (7s) or `LINE_MAX_CHARS` (200 chars) combined, and always close on a speaker change — `server/src/export/caption-cues.ts:30-31` (`LINE_MAX_DURATION_SEC`/`LINE_MAX_CHARS`), enforced in the fold loop around line 118.
2. Word-mode ASR is always one whole-chapter `/transcribe` call, never per-sentence — `server/src/export/caption-cues.ts:buildWordCues`.
3. Sentence text for line/sentence captions comes from `manuscript-edits.json`, never the analysis cache — `server/src/export/manuscript-sentences.ts`.
4. `condition_on_previous_text` is `True` only when `word_timestamps=True` — `server/tts-sidecar/main.py:3549` (`condition_on_previous_text=word_timestamps`).
5. The captions de-dupe key includes `captionFileFormat`/`captionGranularity`/`captionScope`, not just `format` — `server/src/routes/export.ts:165-192` (`revokeStaleSameFormat`).
6. A sentence/line segment whose `textHash` no longer matches its current manuscript text fails the export with a clear "regenerate this chapter" error (`assertNotStale`, `server/src/export/caption-cues.ts:41-43`); a segment with no `textHash` at all (pre-#1105 render, `hasUnverifiableTextHash`, `caption-cues.ts:141-142`) instead sets a non-fatal, persisted `BookExportJob.warning` (`UNVERIFIABLE_STALENESS_WARNING`, `server/src/export/build-captions.ts:53-55`) rather than silently proceeding OR silently blocking. Never set for word mode, which doesn't join manuscript text at all. The warning is set asynchronously during the background job build (`server/src/routes/export.ts:677`: `job.warning = result.warning ?? null`) and only becomes visible via polling `GET` after the job completes; it never appears on the initial POST 201 create response. It surfaces as an amber caption on the export-queue row (`src/components/export-queue-row.tsx:78-79`) in place of the normal destination text.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_transcribe.py`) — word_timestamps decode profile + route header threading.
- Vitest server (`server/src/tts/transcribe-client.test.ts`) — wire contract for `wordTimestamps`.
- Vitest server (`server/src/export/manuscript-sentences.test.ts`, `caption-format.test.ts`, `caption-cues.test.ts`, `build-captions.test.ts`) — pure cue/format logic + orchestration, including the staleness guard and the unverifiable-textHash warning.
- Vitest server (`server/src/routes/export.test.ts`) — end-to-end job creation, MIME type, de-dupe-by-variant, persisted warning surfacing on a completed job.
- Vitest frontend (`src/modals/export-audiobook.test.tsx`, `src/components/listen/listen-download-section.test.tsx`, `src/lib/export-queue-adapter.test.ts`, `src/components/export-queue-row.test.tsx`) — UI + queue badge + warning display.
- Playwright e2e (`e2e/captions-export.spec.ts`) — tile → modal → done job → download link, mock-mode.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`) unless testing word-mode against a real Whisper install.

1. Open `#/books/sb/listen` → Captions tile visible in "Or download a file".
2. Click Download on the Captions tile → export modal opens with Captions pre-selected, granularity/scope/file-format controls visible.
3. Pick Sentence + Whole book + .srt → Build download → job reaches `done` → Download link streams a `.srt` starting `1\n00:00:00,000 --> ...`.
4. Pick Line + Per chapter + .vtt → job reaches `done` → downloaded `.zip` contains one `.vtt` per chapter.
5. Against a real backend with Whisper installed: pick Word + Whole book + .srt on a real rendered book → job completes → resulting `.srt` shows one cue per word with plausible timing.
6. Against a real backend WITHOUT Whisper installed: Word option is disabled with a tooltip; forcing the request via curl returns a clear `errorReason`, never a silent fallback to estimated timing.
7. Against a real backend, on a book rendered before segments carried `textHash` (or a fresh fixture with the field stripped): export Sentence + Whole book → job still reaches `done`, but the queue row shows an amber "couldn't fully verify" caption (the `UNVERIFIABLE_STALENESS_WARNING` text) instead of the normal destination text.

## Out of scope

- Manual caption-cue editing UI.
- Burned-in/hardsub video generation.
- Running word-mode ASR during synthesis (export-time only).

## Ship notes

(Filled in when status flips to `stable`.)
