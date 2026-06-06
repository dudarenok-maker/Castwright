---
status: stable
shipped: null
owner: null
---

# 179 — Pre-assembly per-sentence QA gate + auto re-record

> Status: active
> Key files: `server/src/tts/segment-qa.ts`, `server/src/tts/synthesise-chapter.ts`, `server/src/routes/generation.ts`, `server/src/routes/chapter-qa-repair.ts`
> URL surface: `POST /api/books/{bookId}/chapters/{chapterId}/audio-qa-repair` (SSE)
> OpenAPI ops: `POST /api/books/{bookId}/chapters/{chapterId}/audio-qa-repair` (`audioQaRepairChapter`)
> Issues: closes #509 (bug — bad generations ship undetected); ASR follow-up srv-31 (#508)

## Benefit / Rationale

While listening to *The Drowning Bell* the user hit bad generations and silence gaps
that shipped in the final audiobook (e.g. story chapter 17). The existing
chapter-level QA (`audio-qa.ts`, srv-27) only sees whole-chapter loudness + total
duration, so a single dropped / silent / runaway **sentence** inside a long
chapter sails through — verified: ch17's `.lufs.json` reads a healthy `i =
-16.04` and no segment timing is abnormal.

- **User:** bad sentences are caught and re-recorded *before* the chapter
  assembles, so fewer defects ship; already-rendered chapters can be scanned and
  repaired in place without a full regen.
- **Technical:** per-sentence QA runs on the int16 PCM already in memory in
  `synthesise-chapter.ts`'s `results[]` array, before the concat — no decode, no
  extra synth except for the sentences that actually fail. Signal-based only (no
  ASR), so zero new model/GPU dependencies.
- **Architectural:** adds a QA seam (`evaluateSegmentPcm`) reused by both the
  live gate and the repair route; per-segment `qa`/`suspect` ride into
  `segments.json` and roll up into the existing chapter "Suspect" badge.

## Architectural impact

- **New seams:** `evaluateSegmentPcm(pcm, sampleRate, text, thresholds?)` in
  `server/src/tts/segment-qa.ts` (dead-RMS, internal-silence-run, duration-drift).
  New `SynthesiseChapterOpts` fields `maxSegmentRerecords` / `segmentQaThresholds`
  / `onSegmentRerecord`. New `ChapterSegment.qa` / `ChapterSegment.suspect`
  (both optional — back-compatible with pre-gate `segments.json`).
- **Invariants preserved:** the single index-order concat pass
  (`synthesise-chapter.ts`) is unchanged and still the ONLY place audio is
  concatenated — the gate only swaps `results[index]` contents *before* it runs.
  Assembly still happens exactly once. Title beats are never QA'd / re-recorded
  (mirrors `isRerecordableSegment`). The fs-26 splice engine + `finalizeChapter
  AudioWrite` tail (incl. `.previous.*` rollback) is reused verbatim by the
  repair route.
- **Migration story:** none. `qa`/`suspect` are additive optional fields; the gate
  defaults OFF in the library (`maxSegmentRerecords = 0`) and is turned on only
  by `generation.ts` (env `SEG_QA_MAX_RERECORDS`, default 2).
- **Reversibility:** `SEG_QA_MAX_RERECORDS=0` disables the gate entirely
  (byte-identical to pre-gate generation). The repair route is opt-in per request.

## Invariants to preserve

- The gate runs AFTER `await Promise.all(workers)` and BEFORE the index-order
  concat loop in `synthesise-chapter.ts` — re-records mutate `results[group.index]`
  only; the concat is untouched.
- `maxSegmentRerecords = 0` is the default in `SynthesiseChapterOpts` and is the
  kill-switch (no QA eval, no stamp, no extra calls).
- On exhausted re-records the BEST take is kept and the segment is stamped
  `suspect` — the chapter never blocks completion.
- `segment-qa.ts` is pure (no I/O, ffmpeg, timers, randomness) and reads its
  thresholds lazily per call (env override pattern from `audio-qa.ts`).

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/segment-qa.test.ts`) — one case per signal:
  dead/near-silent, long internal silence run, runaway + truncated duration,
  healthy, empty-text skip, env-override, explicit thresholds (8 cases).
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`, "pre-assembly QA
  gate") — re-records a bad segment in place and keeps the good retake; keeps
  best + stamps `suspect` after exhausting retries and still assembles; disabled
  by default (back-compat).
- Vitest server (`server/src/routes/chapter-qa-repair.test.ts`) — dry-run scan
  flags the dead segment + leaves audio untouched; repair degrades gracefully
  with no cached analysis; unknown-book rejection.
- Vitest server (`server/src/routes/generation.test.ts`) — unchanged-green (the
  per-sentence suspect rollup into chapter `audioQa`).

### Manual acceptance walkthrough (live GPU — owed)

1. Regenerate The Drowning Bell ch17 with the gate on (`SEG_QA_MAX_RERECORDS=2`).
   Expect SSE progress to show any re-records; the new `segments.json` carries
   no `suspect` flags (or far fewer); spot-listen the previously-bad spots.
2. Dry-run scan the EXISTING ch17 audio:
   `POST …/chapters/20/audio-qa-repair {"dryRun":true}` → confirm it flags real
   defects (no GPU, no write, no `.previous.mp3`).
3. Repair: `{"dryRun":false}` → re-records flagged sentences, splices, writes
   `.previous.mp3` rollback; `silencedetect` + a listen pass confirm the fix.

## Out of scope

- **ASR content verification** — catching "fluent but wrong/garbled" generations
  that have normal length/loudness needs transcription, which signal-based checks
  can't see. Filed as a backlog item (`srv-31`); see `docs/BACKLOG.md`.
- Frontend "Scan & repair" affordance — v1 drives the repair route directly; a
  Listen/Generate-view button is a follow-up.

## Ship notes

Shipped 2026-06-06 (merge 174c796, PR #513, closes #509). Live acceptance
confirmed: the pre-assembly QA gate ran during The Drowning Bell regenerations — SSE
showed re-records and the new `segments.json` carried fewer `suspect` flags.
