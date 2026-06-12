---
status: active
---

# Plan 148 — Don't queue (and never hang on) non-narration chapters

## Problem

On the 2026-05-31 the Hollow Tide full-book Qwen run, the generation queue **stalled for
~1 hour, 4 chapters from done**. Root cause was a chain of two defects, both
around EPUB **back-matter** that the parser admits as ordinary chapters:

1. **Back-matter is queued in the first place.** The book's `state.json` has 59
   chapter entries, but the story ends at id 51 ("Chapter Forty-Nine"); ids
   52–59 are parser-captured back-matter — `Acknowledgments`, a next-book sneak
   peek + that book's `PREFACE`/`ONE`, `About the Author`, `Copyright`,
   `CONTENTS`. The front/back-matter detector `isLikelyFrontMatterTitle`
   (`server/src/parsers/front-matter.ts`) was wired **only** into the PDF
   outline reader (`pdf.ts:42`); the EPUB/text/mobi paths never applied it, and
   the `excluded` flag was "set by the user, not the parser". So every EPUB
   back-matter section became a normal, queueable chapter.

2. **A degenerate chapter can hang synthesis indefinitely.** Some of those
   sections are degenerate TTS input — a table of contents, a copyright block.
   Qwen's open-ended decode ran away on them (one batch logged 261 s of compute
   for 51 s of audio, RTF > 5), and with the queue tail running 4-wide the whole
   queue went silent for an hour with no chapter ever reaching `failed`. Neither
   the prior Kokoro run nor this Qwen run ever produced 52–59 — they're not
   narration.

The acute harm is #2 (the silent hour-long stall); #1 is the upstream cause that
keeps non-narration content out of the pipeline entirely.

## Fix — two defensive layers

### Layer A — auto-exclude back-matter at import / re-parse (prevention)

Apply the existing `isLikelyFrontMatterTitle` heuristic at the two sites where a
chapter's `excluded` flag is finalised into book state, so detected front/back-
matter defaults to excluded (the user can always re-include a chapter via the
existing per-chapter exclude toggle — their choice wins):

- `server/src/routes/import.ts` (initial import): `isExcluded =
  excludedSet.has(slug) || isLikelyFrontMatterTitle(title)`.
- `server/src/store/manuscripts.ts` (re-parse / re-hydrate): `excluded =
  userExcluded(id) || isLikelyFrontMatterTitle(title) || undefined` — the user's
  prior exclusions still win, and re-parse no longer silently re-admits
  Acknowledgments/Copyright/CONTENTS to the queue.

Excluded chapters are already skipped by analysis Phase 0a, generation, and every
exporter, so flagging them is sufficient — no new skip logic needed.

**Known limitation:** the heuristic is title-based and won't catch every case
("ONE", "Keep reading for a sneak peek…", "The Hollow Tide Book Two",
"About <author name>"). That is *why* Layer B exists — detection is best-effort;
the pipeline must be robust regardless.

### Layer B — per-call synth timeout (the real safety net)

`server/src/tts/synthesise-chapter.ts`: bound every provider synth/batch call
with a generous ceiling (`SYNTH_CALL_TIMEOUT_MS`, env `SIDECAR_CALL_TIMEOUT_MS`,
default **600 000 ms / 10 min**, `0` disables — far above any legitimate single
batch, ~250 s for 32 sentences). `withCallTimeout` races the call against a
timer; on timeout it aborts a derived `AbortController` (chained to the parent
signal, so it cancels the in-flight fetch) and rejects with a **non-transient**
`ChapterSynthTimeoutError`. Because it is thrown *outside* `withTtsRetry`, it is
never replayed — it bubbles out as a normal chapter failure, so the queue
**advances past** a runaway/degenerate chapter instead of hanging forever.

This converts the worst case from "silent hour-long stall, manual intervention"
to "one chapter fails, queue keeps going" — regardless of whether Layer A's
title heuristic caught the chapter.

## Acceptance

- Importing an EPUB whose chapter list includes `Acknowledgments` / `Copyright` /
  `Contents` / `Preface` writes `excluded: true` for those chapters in
  `state.json`; story chapters stay included. (automated)
- Re-parse preserves a user's explicit exclusions AND keeps the parser default
  for untouched back-matter. (automated)
- A provider call that never resolves causes the chapter to fail with
  `ChapterSynthTimeoutError` within `callTimeoutMs` (driven by fake timers), the
  derived signal is aborted, and the error is not retried. (automated)
- Manual: re-import the Hollow Tide EPUB → chapters 52–59 land pre-excluded; a forced
  generation of an excluded degenerate chapter fails fast instead of hanging.

## Test plan

- `server/src/routes/import.test.ts` — back-matter titles import as `excluded`.
- `server/src/store/manuscripts.test.ts` — re-parse exclusion precedence.
- `server/src/tts/synthesise-chapter.test.ts` — `callTimeoutMs` fires →
  `ChapterSynthTimeoutError`, abort propagated, no retry.

## Ship notes

_(to fill on merge: date + commit SHA)_

Origin: the 2026-05-31 the Hollow Tide stall (monitoring session). See memory
`project_multiworker_qwen_final_batch_stall`. Sibling fixes: plan 146 (Kokoro
pre-warm / fallback gate), plan 147 (sidecar readiness gate, srv-17b).
