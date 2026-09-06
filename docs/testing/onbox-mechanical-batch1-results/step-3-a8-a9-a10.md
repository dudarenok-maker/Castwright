# Mechanical batch 1 — step 3: A8 (batch QA re-record RTF) + A9 (per-character
# re-record/splice) + A10 (structured failure taxonomy)

Run 2026-09-06, worktree `C:\Claude\Projects\wt-onbox-mechanical-batch1`, branch
`docs/docs-onbox-mechanical-batch1`. A production server for this worktree was
already running on entry (`node scripts/start-app-prod.mjs`, `NODE_ENV=production`,
`LAN_HTTPS=0`, `http://localhost:8220`, sidecar `http://127.0.0.1:9140`) — this
step did not start or stop either process, per the standing instruction, and left
both running on exit. Driven end-to-end via the Playwright MCP browser tools
against the real running app, cross-checked against `logs/server.log`,
`logs/server.err.log`, `logs/tts.log`, `logs/tts.err.log`, and `ffprobe`/`ffmpeg`
measurements of the actual rendered `.mp3` files on disk — no simulated results.

Book under test: "The Coalfall Commission" (`castwright__standalones__the-coalfall-
commission`), reused from steps 1–2, 14 characters. On entry, per step 2's own
"what this leaves owed" note, only 4 of 14 characters were designed
(`narrator`, `maerin`, `master-oduvan`, `coalfall-dragon`) and no chapter had ever
been rendered on this worktree's server (empty `audio/` dir).

## Session-opening findings that shaped the run (read before the per-row sections)

**Finding 1 — step 2's "bulk design halts after exactly 2 characters" was very
likely a Gemini-quota/auth failure, not a pipeline bug.** Clicking "Design full
cast" (10 remaining characters) failed immediately with a clean, structured SSE
error: `GEMINI_API_KEY is required to generate voice-style personas.` — this
worktree's `server/.env` has no `GEMINI_API_KEY` and no `user-settings.json`
persisting one either. Switching the live config knob
`analyzer.personaGeneration.engine` from its default `gemini` to `local` (Ollama,
already this worktree's analyzer engine) via `PUT /api/config` — a one-line,
no-restart, fully-supported live override — and re-running "Design full cast"
designed **all 10 remaining characters successfully in one run**, no halt, no
retry needed. Given step 2 saw the identical halt-at-2 symptom on this same
book/cast with zero sidecar errors logged, and persona generation is exactly the
step between "character N done" and "character N+1 starts" that a missing/
exhausted Gemini key would silently break, this is the most likely explanation —
though this session did not have step 2's original environment to confirm
byte-for-byte. Filed as a strong lead for whoever owns that regression, not as a
confirmed fix (out of this step's scope to chase further).

**Finding 2 — the "generation queue never dispatches to the sidecar" symptom
from step 1's A14 was, on this occasion, caused by stale queue entries, not a
dead pipeline.** The queue (`castwright-workspace/.queue.json`) held three
leftover `awaiting_confirm` entries from an earlier, unrelated session
(timestamped hours before this run), each parked waiting on a fallback
confirmation that was never answered. Clicking "Generate this chapter" queued a
fourth, real entry *behind* those three — which the FIFO queue processor can
apparently never reach, reproducing exactly step 1's symptom (chapter marked
"Generating"/"Stalled" at 0/N lines, zero `[tts]` activity, sidecar `/health`
never shows `inflight_synth`). Using the Queue modal's "Clear queue" (with
"Also stop generation in progress" checked) to drop all four entries, then
re-clicking "Generate this chapter" on a clean queue, dispatched to the sidecar
immediately and rendered normally. This does not prove step 1's exact stall had
the same root cause (that session's queue state is gone), but it is a strong,
reproducible alternate explanation for the same symptom, worth ruling out first
on any future "queue not dispatching" report before treating it as a dead
pipeline.

Neither finding was this step's job to fix; both are recorded here because they
were load-bearing for reaching A8/A9/A10 at all.

## A8 — batch QA re-record RTF (plan 228)

**PARTIAL.** The specific mechanism plan 228 shipped — batching QA re-records
instead of firing one unbatched `synthesize` call per flagged sentence — is
confirmed working and lands at the target RTF. The row's own literal acceptance
number ("confirm RTF lands near ~1.2") does **not** hold end-to-end on this box
with the full gate stack on, for a reason outside plan 228's scope: ASR-QA's
Whisper pass runs on CPU here (the shipped default), and that CPU-bound
transcription phase alone costs more wall-clock than the entire audio's own
duration.

**Setup.** ASR-QA is off by default (`qa.asr.enabled` → `SEG_ASR_ENABLED`,
default `false`); turned on live via `PUT /api/config`
(`{"qa.asr.enabled": true, "qa.asr.maxRerecords": 2}`) per the row's own
literal acceptance line ("SEG_ASR_ENABLED=1, signal-QA + ASR re-records at 2") —
`qa.seg.maxRerecords` was already at its default of 2. Designed the one missing
character (`wren-sparrow`) via Finding 1's local-persona workaround so Chapter 3
("The Knock", 51 lines, 5 speakers — Narrator, Master Oduvan, Maerin, Wren—Sparrow,
Coalfall) could render with zero undesigned-voice fallback. Rendered via the
ordinary "Generate this chapter" button, full gate stack on, no gate disabled.

**Result — the app's own RTF telemetry (not a hand-estimate):** the Admin pill
read **"per-chapter generation RTF 4.13 — wall ÷ audio"** immediately after this
chapter completed. Audio duration confirmed by `ffprobe`: **195.64 s** (3:16).

**The re-record loop did engage** — this was a genuine QA-flagging chapter, not
a clean single pass:
- Batched initial/re-record body synth (the plan-228 mechanism): three batch
  calls, RTF **0.87**, **0.88**, **1.24** (`tts.err.log`: `qwen batch synth:
  model=1.7b items=18 … rtf=0.87` / `items=18 … rtf=0.88` / `items=32 … rtf=1.24`)
  — squarely at or better than the ~1.2 target, confirming the batching fix
  itself works as designed. The repeated `items=18` batch (same `text_len=1848`
  both times) is itself evidence a full round of signal-QA flags forced a
  re-record round on the initial batch.
- Two **unbatched single-item** re-records (a single flagged sentence with
  nothing else pending that round): RTF **16.38** and, after the ASR pass below
  flagged one more sentence and forced a fresh Qwen reload, RTF **21.23** —
  exactly the "single short sentence is the worst-case Qwen RTF" cost plan 228's
  own writeup describes for the cases batching can't help (a lone straggler).
- The chapter's UI status cycled `Generating → Verifying speech… → Synthesising
  Narrator · line 51 of 51 → Done` — the `Verifying speech…` → back-to-
  `Synthesising` transition is the ASR-QA gate flagging a line and forcing
  exactly one more re-record round, live, in the running app.
- **ASR-QA phase cost, isolated:** first `Detected language` log line
  12:39:13, last 12:46:02 — **~7 minutes of serial CPU Whisper (`small`,
  `device=cpu`) transcription** for a 3:16 chapter, i.e. the ASR pass alone
  cost more wall-clock than the audio's own length. `qa.asr.device` defaults to
  `cpu` ("zero VRAM") on this box and was not touched — this is the shipped
  default configuration, not a misconfiguration introduced by this test.
- Final Quality-gate summary read "Acoustic: 51 lines checked, 0 needed a
  second take" / "Transcript: 51 lines verified, 0 flagged" — a **terminal**
  0/0, because every flagged line was successfully repaired within the retry
  budget; the flags themselves are only visible in the live log trail above, not
  in the settled summary. Do not read the 0/0 final tally as "nothing was ever
  flagged."

**Verdict:** the plan-228 batching mechanism itself is confirmed to work and
measures at ~0.87–1.24 RTF for actual synthesis, matching the ~1.2 target. The
row's literal "confirm RTF lands near ~1.2" acceptance, measured honestly as the
app's own wall-clock/audio-duration figure with the full gate stack the row asks
for, is **4.13**, not ~1.2 — because CPU-bound ASR-QA (not part of plan 228's
fix) dominates wall-clock on this box's default configuration. Whoever owns the
next pass on this row should decide whether the acceptance target was always
meant to exclude ASR-QA's own device cost, or whether `qa.asr.device=cuda` needs
its own on-box RTF acceptance pass (not attempted here — switching it requires a
sidecar restart, and doing so would have moved off the "default settings" this
run was asked to test).

## A9 — per-character re-record/splice, +3 dB gain (plan 176)

**PARTIAL.** Loudness boost, duration preservation, `.previous.*` backup, and
chapter-loudness-holds-at-target are all confirmed with real numbers. The
promised **A/B audition control could not be found working** — the app's own
copy in the Fix-audio dialog explicitly promises one ("review the new takes in
the revisions panel") and neither the Status pill's Revisions panel nor the
on-disk `revisions.json` ever populated for either action taken. Timing
integrity on the follow-up re-record is confirmed clean (no seam, no doubled
content).

**Book/character:** the same Chapter 3 render from A8, character Master Oduvan
(19 lines across the chapter).

### Loudness boost (+3 dB)

Cast → Master Oduvan → "Fix Master's audio" → Loudness mode (dialog default) →
+3 dB (slider default) → CH 03 only → Apply.

- `.previous.mp3` and `.previous.segments.json` written alongside the live
  files — confirmed on disk.
- Chapter-wide integrated loudness (`ffmpeg -af loudnorm`, `input_i`): **-16.47
  LUFS before → -16.09 LUFS after** (whole-chapter average, diluted by the 32
  lines belonging to the other 4 characters, which is expected).
- **Master Oduvan's own lines, isolated** (all 15 of his segments in this
  chapter, per `segments.json`'s `startSec`/`endSec`, concatenated via
  `ffmpeg filter_complex atrim+concat` and measured with `loudnorm` as one
  clip): **-16.03 LUFS before → -14.40 LUFS after — a real, measured +1.63 dB
  increase specific to his lines.** This is genuinely louder, though it is
  **not the full nominal +3 dB** the slider requested — the most likely
  explanation, backed by the numbers, is the mandatory whole-chapter loudnorm
  remastering pass that runs after the per-character gain (see next bullet):
  true-peak on his lines moved from -1.22 dBTP to -0.84 dBTP, i.e. towards the
  configured -1.5 dBTP ceiling, consistent with the limiter shaving part of
  the requested boost to keep the chapter's overall true-peak/LUFS envelope
  in bounds.
- **Chapter loudness stays ≈ −16 LUFS, confirmed exactly**: the app's own
  `03-chapter-one-the-knock.lufs.json` (its own EBU R128 measurement, not
  mine) reads `"i": -16, "target": -16, "twoPass": true,
  "normalizationType": "dynamic"` after the fix — the chapter is pinned to the
  configured target, exactly as the acceptance line asks.
- **Duration unchanged**, as expected for a gain-only, no-re-synthesis fix:
  195.640 s before → 195.649958 s after (a ~10 ms difference, `ffprobe`).

### A/B toggle — not found working

The dialog's own copy ("Tip: apply to one chapter first and audition it in the
revisions panel before doing the rest." / on completion: "Done — 1 chapter
updated. Review the new takes in the revisions panel.") points at the Status
pill's Revisions panel. Checked after **both** the loudness fix and the
re-record below: the Status pill's "Revisions" section read **"No pending
revisions."** both times, and the book's own
`.audiobook/revisions.json` stayed `{"pending": [], "drift": [], "dismissed":
[], "timeline": {}}` throughout — no revision entry was ever created for either
action, despite the `.previous.*` backups (the mechanism an A/B player would
need) being written correctly both times. Traced this in the frontend source
(`src/store/revisions-slice.ts`, `src/components/revision-timeline-modal.tsx`,
`src/components/layout.tsx`): the "Revisions" list the Status pill reads is
populated by a **drift-detection poll** (`pollRevisions`, cast-continuity
mismatches against the manuscript), a genuinely different mechanism from a
manually-triggered Fix-audio action — the dialog's own copy appears to promise
a connection to that panel that this build does not actually wire up. This is a
real, reproducible gap between the in-app promise and the in-app behaviour, not
a test-setup mistake (confirmed twice, once per action, both leaving
`revisions.json` untouched).

### Re-record one chapter's lines (timing integrity)

Same drawer → "Fix Master's audio" → **Re-record** mode → CH 03 only → apply.
All 19 of Master Oduvan's lines in this chapter were re-synthesised
individually (unbatched — same per-line Whisper-verify-then-maybe-retry loop
seen in A8, RTF **9–33×** per single line, `tts.err.log`), taking ~16 minutes
wall-clock for 19 short lines. `.previous.mp3` / `.previous.segments.json` were
refreshed to the *pre-re-record* state (the loudness-boosted version), matching
the "single-previous chain" design documented in `revisions-slice.ts`.

- Chapter duration **before → after re-record: 195.650 s → 200.794 s** — a
  real, expected shift (Qwen's re-synthesised takes for the same lines are not
  byte-identical in length to the originals), not a defect.
- **Timing integrity check** (the actual ask): walked every one of the new
  `segments.json`'s 52 segments end-to-end. **Every segment's `startSec`
  exactly equals the previous segment's `endSec`**, with exactly one
  exception: a 1.5 s gap between the chapter-title segment (`kind: "title"`,
  0:01.5–0:04.62) and the first narrator line — an intentional post-title
  pause present in the original file's own structure too, not an artefact.
  **No overlaps, no gaps elsewhere, no doubled title, no doubled line** —
  every downstream (non-Oduvan) line's timestamp correctly shifted to absorb
  the ~5 s duration change from his re-recorded lines. Spot-played the
  re-recorded region (13.16–14.28 s) via `ffprobe`/`ffmpeg` — decodes cleanly,
  no corruption.

**Net verdict for A9:** loudness/duration/backup/chapter-target and
re-record timing integrity are all clean **PASS**es with real numbers behind
each. The A/B audition control the row's own acceptance line calls out is a
**FAIL** as currently wired — present in the dialog's copy, absent in the
panel it points to.

## A10 — structured failure taxonomy (plan 173, fs-19)

**PARTIAL — one distinct, real failure mode forced and fully captured with the
friendly message + remediation on both the chapter row and the Activity log;
the second (`vram-spill`) was not attempted, by deliberate choice, not by
running out of time.**

### Failure mode 1 — sidecar killed mid-render → `recycle-storm` (CONFIRMED, real)

Started "Generate this chapter" on Chapter 4 ("The Pour", 159 lines, 13
speakers — now fully renderable after Finding 1's cast-completion). While
synthesis was actively in flight (confirmed via `tts.err.log`'s own `qwen
synth` line), issued `POST /api/sidecar/restart` — the exact endpoint the row
names, confirmed against `server/src/routes/sidecar-health.ts` before use —
repeatedly (6 calls total, spaced by that route's own health-poll wait) to
outrun the in-loop recovery budget rather than let a single kill ride out
cleanly.

**First kill alone rode out cleanly** (screenshot:
`a10-sidecar-unreachable-recovering.png`) — the chapter row read "Recovering —
restarting voice engine…" and resumed generating normally once the sidecar
came back, exactly the same graceful ride-out behaviour step 2's A6 confirmed
for the bulk-design path. This is *not* a failure surfaced to the user — it is
the system working as designed, and is recorded here because it is honest
evidence the recovery path is robust, not because it satisfies the row.

**After the 2nd in-loop recovery was also exhausted, the run failed loud, exactly
as designed** — server log (`logs/server.err.log`):
```
13:14:20.635 [generation] chapter 4 (…-the-pour): sidecar unavailable mid-synth (recycle/respawn) — riding out the respawn, re-attempt 1/2 (preserving completed groups).
13:16:23.156 [generation] chapter 4 (…-the-pour): sidecar unavailable mid-synth (recycle/respawn) — riding out the respawn, re-attempt 2/2 (preserving completed groups).
13:20:20.571 [generation] chapter 4 (…-the-pour) RECYCLE STORM: sidecar recycled 2× on one chapter — recorded non-fatal. …
13:20:20.572 [sidecar] forced recycle: chapter 4 hit a recycle storm (2 in-loop recoveries exhausted)
13:20:21.140 [generation] RECYCLE STORM: paused the queue — restart the TTS sidecar / restore headroom, then resume.
```
This is the `recycle-storm` `FailureCode` (`server/src/routes/failure-taxonomy.ts`
— `RecycleStormError`), not literally `sidecar-unreachable` as the row's own
shorthand names it — but it is the real, correct, and arguably *more specific*
classification the codebase actually gives to "the sidecar went unreachable
repeatedly while rendering one chapter" (the taxonomy file's own comment
explains `sidecar-unreachable` is for a single fetch failure, while
`recycle-storm` is deliberately placed ahead of it for exactly this repeated-
mid-chapter case). Both UI surfaces confirmed showing the friendly message +
remediation (screenshot: `a10-recycle-storm-failure.png`):
- **Chapter row** ("Synthesis failed"): *"The TTS sidecar recycled 2× while
  rendering this single chapter — it is likely thrashing (host-memory leak or
  insufficient VRAM/RAM headroom). Stopping so the run doesn't grind. Restart
  the sidecar / lower concurrency, then Retry."* with a "What to do:" line and
  a `#/help?code=recycle-storm` link, plus a `Retry` button.
- **Activity log** (chapter list's own feed, not just the transient toast):
  identical "Chapter 4 failed" entry with the same message, timestamped "Just
  now" — durable evidence surviving past whatever toast fired and
  auto-dismissed before a screenshot could catch it. (The ephemeral toast
  itself was not caught live — by the time the UI was re-polled after the 6th
  `/restart` call finished, it had already auto-dismissed; the identical
  wording persisting in both the chapter row and the Activity feed is treated
  here as equivalent evidence of the same user-facing surface, per the row's
  own intent, but a literal toast screenshot is not included.)
- The generation **queue self-paused** (`"paused": true` in `.queue.json`) with
  the failed entry retained — the correct "stop the run so it doesn't grind"
  behaviour the message itself describes.

### Failure mode 2 — `vram-spill` — NOT ATTEMPTED

The row's own suggestion ("force both Qwen VoiceDesign and Base models
resident simultaneously plus another consumer") requires deliberately pushing
a real GPU past its VRAM ceiling to provoke a genuine `CUDA out of memory`
exception (the actual regex `classifyFailure` matches for this code) —
`capacity-retry.ts`'s whole job is to *prevent* this by queueing/blocking
before a real allocation failure happens, so reliably forcing the real
exception means deliberately defeating a safety system on a GPU this session
does not have exclusive claim to (this box hosts other lanes per the standing
rule against contending for a card another lane is using). Given the session
had already forced one genuine, taxonomy-confirmed failure and the risk a
forced OOM poses to any concurrently-running lane's own resident model, this
was a deliberate stop, not a time-budget failure. Left as owed, same framing
step 1's A4 bullet 4 used for the same underlying risk.

**Net verdict for A10:** one of the two named failure classes is fully forced,
confirmed via server log + UI (chapter row + Activity log) + a friendly
message and remediation matching the taxonomy exactly. The row's own "≥2
distinct real failure modes" bar is not met — this is an honest PARTIAL, not a
PASS.

## What this leaves owed

- A8: an on-box RTF acceptance run with `qa.asr.device=cuda` (requires a
  sidecar restart) to isolate whether CPU-bound ASR-QA, not the synthesis
  batching plan 228 actually fixed, is the whole gap between the measured 4.13
  and the ~1.2 target.
- A9: the Fix-audio dialog's "revisions panel" promise needs either wiring up
  to a real A/B surface or its copy corrected — filed here as a genuine gap,
  not fixed in this step.
- A10: a `vram-spill` forcing pass, ideally on a box (or time window) where
  contending for the full card is safe, or via a test harness that can inject
  a fake `CUDA out of memory` without touching real hardware.
- Both Finding 1 (Gemini-quota-shaped halt) and Finding 2 (stale-queue-shaped
  stall) are worth their own confirmatory passes against the exact conditions
  step 1/step 2 hit, since this step could only offer a plausible alternate
  explanation, not a byte-for-byte reproduction.

## Cleanup / state left behind

- **Cast completion (intentional, kept):** all 14 of "The Coalfall Commission"'s
  characters are now designed (was 4/14 on entry) — the 10 designed this
  session via the local-Ollama-persona workaround (Finding 1). `cast.json`
  reflects this; `cast.json.oe-backup` (from step 2) is untouched beside it.
- **Rendered audio (intentional, kept):** Chapter 3 ("The Knock") is fully
  rendered, then loudness-boosted (+3 dB, Master Oduvan), then re-recorded
  (Master Oduvan, all 19 lines) — final on-disk state is the re-recorded
  version. `03-chapter-one-the-knock.previous.mp3` /
  `.previous.segments.json` hold the pre-re-record (post-+3dB) take, per the
  single-previous-chain design. Chapter 4 ("The Pour") was deliberately driven
  to a `Failed` state for A10 (see below) — never completed.
- **Generation queue — left paused, 1 failed entry, deliberately:** the A10
  recycle-storm test's own queue-pause is the actual evidence a later step or
  the operator may want to inspect first-hand; `.queue.json` holds
  `"paused": true` with the Chapter 4 failure and its exact user-facing
  message. Resume/clear it (Generate page → View queue → Resume, or Clear
  queue) whenever it's no longer needed as evidence.
- **Live config overrides — reverted before finishing:** `qa.asr.enabled`,
  `qa.asr.maxRerecords`, and `analyzer.personaGeneration.engine` were all
  overridden live during this session (via `PUT /api/config`) and explicitly
  reset back to their defaults (`POST /api/config/reset`) before this step
  ended — confirmed via a follow-up `GET /api/config` read. `qa.seg.minRatio`
  and `qa.seg.maxRatio` show `"source": "override"` in this server's config
  but at their *default* values (0.4 / 2.5) — pre-existing from an earlier
  session, not touched or added to by this step.
- **Screenshots** (outside the repo, in this session's scratch dir — copy
  anywhere useful before it's cleaned up):
  `a10-sidecar-unreachable-recovering.png` (the clean single-kill ride-out) and
  `a10-recycle-storm-failure.png` (the terminal failure card) at
  `C:\Users\dudar\AppData\Local\Temp\open-engine-ringer\oe-heartbeat-claude-2967-20260906-020400\oe-heartbeat-claude\`.
- Book 2, "The Coalfall Commission II" (from step 2, series-propagation
  harness), was not touched this session — its "Analysing" state visible at
  session start pre-dates this run and was left exactly as found.
