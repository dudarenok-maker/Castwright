# Group C step 3 — C1 free-tier Gemma cloud pass, primary-checkout exception

Ref: [Castwright#2894](https://github.com/dudarenok-maker/Castwright/issues/2894), row **C1**
([#1685](https://github.com/dudarenok-maker/Castwright/issues/1685)), parent
[#2616](https://github.com/dudarenok-maker/Castwright/issues/2616), campaign
[#2435](https://github.com/dudarenok-maker/Castwright/issues/2435).

## VERDICT: **BLOCKED**

The re-analysis does **not** complete. On two independent, real, live-API attempts the run
died in Phase 0 (cast detection) on **Chapter 1**, before any chapter's attribution, before
script-review, and before any real per-minute 429 could be exercised. The failure is a genuine
`PROHIBITED_CONTENT` content-filter block from Google's own API — not a mock, not a timeout,
not a local bug — and the code's own design treats this class of error as **deterministic and
whole-book-fatal by construction** (it does not retry or fall back). A third identical attempt
would not be informative; this is recorded as BLOCKED rather than re-run into the ground.

This falsifies the row's own premise. #1685/#2894 assume `gemma-4-31b-it` is safe for this book
because it is "RECITATION-filter-immune." That is apparently true only for the `RECITATION`
stop-reason specifically — Google's separate `PROHIBITED_CONTENT` classifier still fired against
this exact book's Chapter 1 text on `gemma-4-31b-it`, live, twice, byte-for-byte reproducibly.

## What was NOT touched, and why this is safe evidence

- **The primary checkout's dev server was already running** — both halves, `npm run dev`
  (Vite on `:5173`, PID 31212; the Node server on `:8443` via `LAN_HTTPS=1`, PID 30752, both
  children of one `concurrently` process, PID 27008). Verified via
  `Get-CimInstance Win32_Process` command lines, not assumed from the port number alone.
- **It was not idle — another live session was actively using it.** `logs/server.log` carries
  a cover-lookup for a book titled `"QA2937 Coalfall RU Throwaway"` at `06:56:48`, minutes before
  this step started. This ruled out both a restart **and** any global settings/`.env` mutation:
  either would have risked interfering with that other in-flight work.
- **No restart, no `.env` edit, no global/user-settings change was made.** `git -C
  C:\Claude\Projects\Audiobook-Generator diff --stat -- server/.env` is empty — the file was
  never opened for writing. Confirmed: `server/.env` still reads
  `GEMINI_MODEL=gemini-3.5-flash-lite` untouched, exactly as found.
- **The mechanism used instead: a genuine per-request override**, `model` in the JSON body of
  both `POST /api/manuscripts/:id/analysis` and `POST /api/books/:bookId/script-review`
  (`server/src/routes/analysis.ts:3300`, `server/src/routes/script-review.ts:314-315`). Per
  `server/src/analyzer/select-analyzer.ts`'s documented precedence, `opts.model` is priority 2
  (below only an ops env var this run never set) and is resolved through
  `inferEngineFromModelId` — a bare model id with no `:` routes straight to the Gemini engine,
  independent of the box's persisted `analyzer.engine`/`ANALYZER` setting. This is scoped to
  **one request for one manuscript**; it cannot have touched the concurrent session's work.
- The GEMINI_API_KEY in `server/.env` was confirmed **present** without ever being printed,
  copied, or logged: `grep -c 'GEMINI_API_KEY=' server/.env` → `1`; the key line itself was only
  ever piped through a `sed` redaction, never displayed.

## Throwaway book

Imported fresh (not the library entry) per §0.3's three-mechanism argument in
`docs/testing/night-watch-reanalysis-onbox-acceptance.md` (fresh `manuscriptId`, cache keyed by
id only, distinct-title collision-safe):

| | |
|---|---|
| Source | `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch Tetralogy\Ночной дозор\manuscript.epub` (416,002 bytes, EPUB) |
| Title used | `Ночной дозор (C1 cloud throwaway 2894)` |
| `bookId` | `сергей-лукьяненко__the-night-watch-tetralogy__ночной-дозор-c1-cloud-throwaway-2894` |
| `manuscriptId` | `mns_KwZCcqh6JG` |
| Chapters | 9 (103,751 words / 650,932 characters) |
| Workspace dir | `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch Tetralogy\Ночной дозор (C1 cloud throwaway 2894)\` |

Imported via `POST /api/import` (multipart) + `POST /api/books` (confirm) against the
already-running server at `https://localhost:8443` — the same two-phase flow the UI uses. The
library book (`mns_oyK7Po6BiT`) was never opened, read, or written by this session.

**Note for cleanup**: this throwaway book directory and its (empty — see below) cache are still
present. Nothing here overwrote or touched the library entry.

## Model actually used — confirmed from logs, not assumed

```
2026-09-07 07:03:59.048 [analysis] manuscript=mns_KwZCcqh6JG engine=gemini model=gemma-4-31b-it
2026-09-07 07:03:59.299 [analysis] mns=mns_KwZCcqh6JG phase=0 Detecting cast chapter-by-chapter across 9 chapters via Gemma 4 31B…
2026-09-07 07:03:59.300 [analysis] mns=mns_KwZCcqh6JG phase=0 Chapter 1/9 cast — Chapter 1 (112,093 chars) via Gemma 4 31B…
```

and identically on the second attempt:

```
2026-09-07 07:05:38.277 [analysis] manuscript=mns_KwZCcqh6JG engine=gemini model=gemma-4-31b-it
2026-09-07 07:05:38.901 [analysis] mns=mns_KwZCcqh6JG phase=0 Detecting cast chapter-by-chapter across 9 chapters via Gemma 4 31B…
```

`server/.env`'s `GEMINI_MODEL=gemini-3.5-flash-lite` line was in effect the whole time and was
never consulted for this manuscript — the per-request override won, exactly as designed.

## The failure — real, live, reproduced twice

**Attempt 1** (`fresh: true`, `model: "gemma-4-31b-it"`), wall-clock **07:03:59.048 →
07:04:00.909** (≈1.9 s to failure):

```
2026-09-07 07:04:00.909 [gemini] generate failed {
  model: 'gemma-4-31b-it',
  status: undefined,
  name: 'GeminiContentBlockedError',
  message: 'Gemini gemma-4-31b-it returned an empty response (reason=PROHIBITED_CONTENT). A content filter blocked the text — gemini-* models block copyrighted source via RECITATION. Switch GEMINI_MODEL to a gemma-* model or set ANALYZER=local (Ollama).',
  userTurnLength: 12451,
  userTurnHead: '---\n' +
    'manuscriptId: mns_KwZCcqh6JG\n' +
    'stage: 1-ch1\n' +
    '---\n' +
    '\n' +
    '# Phase 0a — Per-chapter cast detection\n' +
    '\n' +
    'Identify every speaking character that appears in the chapter below — new and\n' +
    'recurring — and return them as'
}
```

SSE terminal event delivered to the client:

```
data: {"kind":"error","code":"analyzer-content-blocked","message":"Gemini blocked this chapter — its recitation filter refused the source text. The gemini-* models reject text they recognise as copyrighted, and a published book's opening chapter is the classic trigger.","remediation":"Switch the analyzer to a gemma-* model (set GEMINI_MODEL=gemma-4-31b-it in server/.env — the gemma family is not subject to the recitation filter) or to the local Ollama analyzer (ANALYZER=local). Restart, then click Retry."}
```

**Attempt 2** — a deliberate immediate retry (`fresh: true` again, same manuscript, same
model), to test whether the block was a one-off vs. deterministic. Wall-clock **07:05:38.277 →
07:06:01.293** (≈23 s — the extra time is the section-1 chunk of Chapter 1 being resent, not a
different outcome):

```
2026-09-07 07:06:01.293 [gemini] generate failed {
  model: 'gemma-4-31b-it',
  status: undefined,
  name: 'GeminiContentBlockedError',
  message: 'Gemini gemma-4-31b-it returned an empty response (reason=PROHIBITED_CONTENT). A content filter blocked the text — gemini-* models block copyrighted source via RECITATION. Switch GEMINI_MODEL to a gemma-* model or set ANALYZER=local (Ollama).',
  userTurnLength: 12451,
  userTurnHead: '---\n' +
    'manuscriptId: mns_KwZCcqh6JG\n' +
    'stage: 1-ch1\n' + ...
}
2026-09-07 07:06:01.294 [analysis] failed {
  manuscriptId: 'mns_KwZCcqh6JG',
  lastStep: 'phase=1 Running 9 chapters with up to 2 in parallel.',
  model: 'gemma-4-31b-it',
  name: 'GeminiContentBlockedError',
  ...
}
```

Byte-identical failure signature (`reason=PROHIBITED_CONTENT`, same `stage: 1-ch1`, same
`userTurnLength: 12451`) on both attempts. This matches the design comment at
`server/src/analyzer/errors.ts:46-47`, which states in so many words that a
`GeminiContentBlockedError` is "a DETERMINISTIC, WHOLE-BOOK-FATAL condition: the same filter
blocks every chapter identically, so retrying or splitting is futile." Empirically confirmed,
not merely quoted. Chapter 1 of this book (a famous, heavily-anthologised prologue) trips
Google's `PROHIBITED_CONTENT` classifier on `gemma-4-31b-it` just as `gemini-3.5-flash-lite`
tripped `RECITATION` on the same book in the original 2026-08-06 incident
(`docs/testing/onbox-acceptance-register.md`'s C1 section) — a different stop-reason, same
underlying cause (Google's copyright-content classifiers recognising this exact bestseller).

No cache file, no `analysisProvenance`, and no chapter progress was ever persisted for
`mns_KwZCcqh6JG` — its `.audiobook/state.json` carries only the confirm-time metadata (9
chapters, no `analysisProvenance` key at all), and `server/handoff/cache/` has no file for this
manuscript id. **Zero of nine chapters completed on either attempt.**

## Acceptance criteria — scored against #1685's own checklist

- **"Re-analysis completes, no dropped chapters, no hang."** — **FAIL.** The run does not
  complete; it is not merely slow or partially degraded — it never gets past Chapter 1 of 9,
  on either attempt. This is not a hang (both attempts terminated within seconds with a clear
  error), so specifically: no hang, but a hard failure with 9/9 chapters dropped.
- **"The script-review pass specifically completes."** — **NOT REACHED.** Script-review runs
  only after the main analysis produces a roster and attributed sentences; neither exists for
  this manuscript. Not exercised at all.
- **"A per-minute 429 observed being retried, not misclassified as daily-quota."** — **NOT
  OBSERVED, either way.** The run never got far enough into real request volume to hit Google's
  actual per-minute cap. The only internal rate-limiter event seen was a proactive **TPM**
  throttle wait before Chapter 2's call even went out:
  ```
  data: {"kind":"throttle","phaseId":0,"chapterIndex":2,"model":"gemma-4-31b-it","waitMs":60196,"reason":"tpm"}
  ```
  correctly tagged `"reason":"tpm"` (per-minute), not `"daily"` — so the classifier that exists
  *is* behaving correctly on the one throttle signal this run produced — but this is the app's
  own local rate-limiter pacing itself under budget, not a live HTTP 429 response from Google
  being retried. No real 429 (`grep -n '429\|quota\|RESOURCE_EXHAUSTED'` across both
  `logs/server.log` and `logs/server.err.log` for the whole session) came back from the Gemini
  API itself during either attempt — the only 429 in the logs at all belongs to an unrelated
  Google Custom Search cover-lookup for a *different* concurrent book
  (`2026-09-07 06:56:48.089 [cover] google search failed: google search returned HTTP 429.`),
  not this row's Gemini analyzer calls.

**Net: two of three criteria fail outright (one on a real, reproduced, deterministic content
block); the third is simply unreachable from where the run stopped.** This is not a "still
owed, try again later" situation — a third identical attempt would reproduce the identical
`PROHIBITED_CONTENT` block, per the code's own stated design. Something about the row's
premise or the corpus needs to change before this can pass (e.g., a different chapter-1
section boundary, an even-less-recognisable free-tier model, or accepting that Google's
content-safety net is broader than "RECITATION" alone for `gemma-*`) — that decision is out of
this step's scope to make.

## #2306 cross-reference — narrated-speech-share

**Unavailable for this run.** The #2306 metric (share of dash-opening dialogue lines
attributed to `narrator`, computed and logged per chapter as `[analysis] phase=1 Chapter N/M
— narrated-speech check: X/Y spoken lines attributed to the narrator (Z%)`) requires completed
stage-2 sentence attribution. This run produced **zero** attributed sentences for any of the 9
chapters — the job died in Phase 0 on Chapter 1 before Phase 1 ever attributed a single
sentence for this manuscript. There is no per-chapter table to report; fabricating one would
violate the run's own evidence.

For calibration, the log format this metric uses (observed live during this session, on a
**different, unrelated concurrent manuscript** `mns_5X2HdsCPHd` — cited only to show the
mechanism exists and works, not as this row's data):

```
2026-09-07 07:04:09.605 [analysis] mns=mns_5X2HdsCPHd phase=1 Chapter 1/2 — narrated-speech check: 0/0 spoken lines attributed to the narrator (0.0%) — attributed population below the 20-line floor, too small to judge; source has 0 dash-opening speech lines.
2026-09-07 07:04:38.779 [analysis] mns=mns_5X2HdsCPHd phase=1 Chapter 2/2 — narrated-speech check: 1/3 spoken lines attributed to the narrator (33.3%) — attributed population below the 20-line floor, too small to judge; source has 0 dash-opening speech lines.
```

The only real figures that exist for *Ночной дозор* against this metric remain the ones already
recorded in #2306 and `docs/testing/night-watch-reanalysis-onbox-acceptance.md` (local
`qwen36-cw-iq4-32k`, 2026-08-12/13 run, book-wide 87.4%/4131 of 4725, per-chapter 15.4–95.5%) —
those are **not** re-litigated here per #2894's own instruction, and are not this row's numbers;
they are cited only so the absence of a cloud figure is legible as "genuinely never measured,"
not "forgotten."

## Anything found broken in passing (not fixed, not widened — noted only)

1. **`GeminiContentBlockedError`'s message is wrong/circular once the model is already a
   `gemma-*` model.** `server/src/analyzer/errors.ts:66-73` hardcodes the same hint text for
   every block reason (`RECITATION`, `SAFETY`, *and* `PROHIBITED_CONTENT`):
   > "A content filter blocked the text — gemini-\* models block copyrighted source via
   > RECITATION. Switch GEMINI_MODEL to a gemma-\* model or set ANALYZER=local (Ollama)."

   This session hit it *while already running `gemma-4-31b-it`* — the remediation it printed
   ("switch to a gemma-\* model") was the exact model already in use, and the reason
   (`PROHIBITED_CONTENT`) isn't `RECITATION` at all. The same stale text is duplicated verbatim
   in the route-level `analyzer-content-blocked` SSE error
   (`server/src/routes/failure-remediations.ts:85`, and the literal string embedded directly in
   the error payload seen above). The type comment at `errors.ts:62-64` already knows the reason
   can be `PROHIBITED_CONTENT` — the user-facing text just never branches on it. Recorded here
   per this row's "report, don't fix" instruction; not fixed, no issue filed (that judgment call
   belongs to whoever owns the incidental-findings protocol for this campaign, not this step).
2. **This EPUB's chapters all parsed with generic titles** (`"Chapter 1"` … `"Chapter 9"`,
   confirmed in the throwaway's `.audiobook/state.json`) rather than the source's actual
   Cyrillic chapter headings. Noted as an observation only — not confirmed as a regression (no
   comparison against the library import's chapter titles was done, and doing so would have
   required touching the library book, which is out of bounds for this step), and not
   investigated further.
3. **The primary checkout has one pre-existing untracked file**,
   `docs/testing/onbox-a-series-audit-2026-09-05.md`, unrelated to this step (never created,
   opened, or touched by this session — confirmed via `git status --porcelain` before and after).
   Left exactly as found; flagged only so it isn't mistaken for something this step left behind.

## Primary-checkout cleanliness

- `server/.env` — byte-for-byte untouched (`git diff --stat -- server/.env` empty). No revert
  needed because no edit was ever made.
- No user-settings / Advanced-Settings global config was changed.
- No process was started, stopped, or restarted in the primary checkout. Frontend (`:5173`,
  PID 31212) and server (`:8443`, PID 30752) are the same PIDs at the end of this session as at
  the start.
- This step's own scratch files (`scratch-2894/` — the copied-out EPUB, curl request/response
  bodies) were created under `C:\Claude\Projects\Audiobook-Generator\scratch-2894\` for the
  duration of the run and deleted before finishing. `git -C
  C:\Claude\Projects\Audiobook-Generator status --porcelain` at the end shows only the
  pre-existing untracked file noted above — nothing from this step.
- The throwaway book (`mns_KwZCcqh6JG`, see above) is left on disk under
  `C:\AudiobookWorkspace\books\...\Ночной дозор (C1 cloud throwaway 2894)\` — it is not tracked
  by git, holds no analysis data (Phase 0 never completed), and does not touch the library
  entry. Left for the operator to delete or reuse.
- **The `GEMINI_API_KEY` value was never printed, logged, copied, or committed** at any point in
  this session — only its presence was confirmed (`grep -c`), and the confirmation output was a
  redacted placeholder, never the raw value.

## What the next step's automation needs to know

- **Do not re-run this row as-is expecting a different result.** The block is deterministic and
  book-specific (Chapter 1's exact text), confirmed by two independent live attempts with
  byte-identical failure signatures. A bare re-run burns real free-tier quota for the same
  outcome.
- If C1 is retried, the two live options actually available (not evaluated further here, out of
  this step's scope) are: (a) exclude/reshape Chapter 1's opening section before sending it to
  Gemini (structural change to the analyzer, not a settings tweak), or (b) accept that this
  criterion can only be measured starting from Chapter 2 onward on this particular book, and
  amend the row's acceptance text accordingly — a decision, not a fix, and not this step's to
  make.
- The safe per-request `model` override mechanism documented above (§"What was NOT touched")
  is reusable for any future cloud-model row that needs to run against this same shared,
  concurrently-used server without a restart or a global settings change.
