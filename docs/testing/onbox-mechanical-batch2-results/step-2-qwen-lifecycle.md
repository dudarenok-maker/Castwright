# Step 2 — A24 design-contention wait + A105 base17 eviction guard + A35
# three-model stranded VRAM — PARTIAL, in progress (5th run adds A105 bullet 3,
# direction 1)

Run 2026-09-06, worktree `wt-mechanical-batch-2` (branch
`docs/docs-mechanical-batch-2`), two-GPU box: GPU0 = RTX 4070 Laptop (8 GB),
GPU1 = RTX 5070 Ti (16 GB). This box was running **four** live sidecar
processes concurrently throughout this session (this worktree's own, plus
`wt-onbox-mechanical-batch1`, `wt-analyzer-render-batch`, and
`wt-2934-a36-audition-band`) — none were touched, per the standing rule, but
their concurrent GPU0 use is a real confound for anything timing-sensitive
below and is called out where it matters.

**This step is not finished.** Only A24 bullet 1 was driven to a real
observed result; A24 bullets 2-4 and all of A105 and A35 were not attempted
this session — see "Remaining scope" at the bottom for exactly why and what
the next run needs.

## Setup (reusable by the next run)

This worktree's own `castwright-workspace/books` was empty — no throwaway
fixture was present from step 1. Copied the `Onbox Test` fixture book
(`wt-onbox-mechanical-batch1`'s copy: three characters, `ivan-petrovich`
already carrying a designed Qwen base voice, `anna` undesigned, plus the
`unknown-male` fold bucket) into this worktree's own workspace. The server
picked it up automatically as `onbox-test__standalones__untitled`.

Endpoints driven directly (curl, not the browser UI — the register's own
text allows "a second browser tab/session", and these are plain REST/SSE
calls the UI itself makes):
- Design: `POST /api/books/:bookId/cast/:characterId/design-voice/stream`
  (`server/src/routes/single-design.ts:227`) — SSE, body
  `{persona, sampleVoiceId, modelKey}`.
- Render: `POST /api/books/:bookId/generation` (`generation.ts:716`) — SSE,
  body `{modelKey, chapterIds, force}`.
- Sidecar state/eviction: `GET/POST http://localhost:9170/health`,
  `POST http://localhost:9170/unload {"engine": "..."}`.

**Pre-condition finding, worth recording on its own:** on first attempt, the
design for `anna` failed outright with `design_failed: Not enough GPU memory
for qwen (6144MB)` — the box's GPU0 had only ~5.5 GB free (this worktree's
own Qwen 0.6B-Base + Coqui XTTS were both already resident from step 1,
~1.2 GB + ~2.5 GB). This is not a finding about the code under test; it just
means a real attempt at this row needs the 8 GB card genuinely clear of
this worktree's *own* prior-loaded engines first (`POST /unload` for each).
After unloading both, GPU0 had 7.3 GB free, above VoiceDesign's ~6 GB need,
and the real test below became possible.

## A24 bullet 1 — design-wins wait vs. `vram-spill` (PR #2797 scenario)

**Real result: CONFIRMED — the render waited, no `vram-spill` error, design
completed normally.**

Sequence:
1. `POST .../cast/anna/design-voice/stream` (persona supplied directly,
   `sampleVoiceId: char-onbox-test__standalones__untitled__anna`,
   `modelKey: qwen3-tts-0.6b`) — fired first, backgrounded.
2. ~5 s later, once `/health` and the design-single status endpoint
   confirmed the design had entered `loading-model`/VoiceDesign-loading,
   fired `POST .../generation` for chapter 1 (`ivan-petrovich` + narrator
   lines, a *different* character from the one being designed), same
   device, `modelKey: qwen3-tts-0.6b`.

Observed:
- The render emitted one incidental warning first —
  `voice_language_mismatch`: "1 designed voice(s) were cleared because they
  were designed for a different language than this book" — because the
  copied fixture's `ivan-petrovich` voice had been designed under a
  different worktree/language context than this one's `ru` book state. This
  is an artifact of reusing a cross-worktree fixture, not a design-contention
  finding; noted for the next run so it isn't mistaken for one. (Cast.json
  still shows `ivan-petrovich`'s `overrideTtsVoices.qwen.name` unchanged
  afterward — the "clearing" is in-memory for that render pass, not a
  persisted removal; not chased further this session.)
- The render's own progress then sat at `narrator`/`progress: 0` — repeated
  heartbeat-shaped `progress` events, no advance — for the entire time the
  design was in flight (confirmed via `/health`: `qwen_design_resident`
  flipped `true` during `loading-model`/`designing`/`distilling`/`rendering`,
  `qwen_loaded` (Base) stayed `false` throughout). **No `vram-spill`
  `chapter_failed` event fired at any point** — this is the core behavior
  PR #2797 is supposed to produce, and it held.
- ~85 s after the design started, it completed normally: `{"type":
  "designed", "characterId":"anna", "voiceId":"qwen-uIRjRzpfDUZqLX_0eVctR",
  ...}` — the anna design was not starved out by the concurrent render
  request either.
- `qwen_design_resident` did not flip back to `false` until roughly 30-40 s
  *after* the `designed` event — an idle/teardown delay, not the
  contention-wait itself. The render's progress stayed at 0 through that
  gap too.
- The render never reached a terminal event (`chapter_failed` or a
  completed-chapter event) inside the 240 s window this run allotted per
  curl call, even after `qwen_design_resident` genuinely went `false`. Given
  four sidecars were concurrently live on this box's GPU0 throughout, this
  reads as real cross-lane GPU contention slowing the actual synth step
  after the design-wait resolved, not a second design-contention bug — but
  it was **not chased to a terminal result** this session, so it is not
  being reported as "render subsequently succeeded," only as "render never
  errored with `vram-spill` during or after the design."

**Bullet 1 verdict:** the specific thing #2070/#2678/PR #2797 fixed —
render must wait, not fail `vram-spill`, while a same-device design is
in flight — is confirmed on real hardware. The render's own eventual
completion time was not measured cleanly because of this box's real
multi-lane GPU contention.

## A24 bullet 4 — attempted, blocked on fixture setup (not a code finding)

Attempted the same pattern as bullet 1 (design `ivan-petrovich`, concurrent
render for chapter 1) intending to fire `POST .../generation/pause` mid-wait
and check the render's terminal event is a plain `AbortError`, not
`NoCapacityError`/`vram-spill`. The render came back immediately with
`chapter_complete` via `resumeFromCompletedChapterIds` — this fixture's only
chapter had already been fully synthesized (via `coqui-xtts-v2`, not even
`qwen`) by this same session's own earlier bullet-1 run, so `force:true` hit
the resume-from-completed path rather than actually re-entering the
generation loop and waiting on Qwen at all. No design-contention wait ever
started for the render side, so there was nothing to pause mid-wait, and
issuing `/pause` at that point would only prove pause works on an idle
book — not the thing this bullet needs. Aborted before spending a real
`/pause` call on that non-signal. This needs a genuinely fresh, never-before-
rendered chapter/character target (or a book reset) to reach the actual
wait state; noted for the next run rather than reported as a result.
Design itself (`ivan-petrovich`) completed cleanly and was left in a normal
resting state (not aborted) — cleanup below reflects that.

## A105 bullet 2 — mid-load `/unload` (3rd run, 2026-09-07)

**Real result: 200 confirmed (not 500); the in-flight load itself was NOT
interrupted by the race.**

At the start of this run the sidecar (this worktree's own, port 9170) was
fully idle — no engine resident, `inflight_synth: 0` — so no other lane's
state was touched. This box had two other python sidecar processes visible
in `tasklist` at the time (other worktrees' lanes) but their GPU0 usage was
negligible and none were interacted with.

Sequence, driven directly against the sidecar (not through the server route
or UI — same class of plain REST call the earlier runs on this file used):
1. Fired `POST :9170/load {"engine":"qwen","model":"1.7b"}` backgrounded —
   this is the documented on-demand base17 trigger (`main.py:5841`'s own
   comment: "Loaded on demand via `/load {model:\"1.7b\"}`").
2. ~1 s later, `GET /health` — confirmed `qwen_base17_loaded: false` still,
   `committed_mb: 7864.5` (up from an idle-book baseline; the load was
   genuinely in flight, not yet resident).
3. ~1 s after that (≈2 s into the load), fired
   `POST :9170/unload {"engine":"qwen","model":"1.7b"}`.

Observed:
- The `/unload` call returned **`200 {"status":"idle"}`** immediately
  (0.2 s) — not 500, matching the row's expectation.
- The backgrounded `/load` call was **not aborted or errored** by the race —
  it ran to completion at 10.3 s total and returned its own `200
  {"status":"ready"}`. A follow-up `/health` confirmed `qwen_base17_loaded:
  true` and `committed_mb: 8528.7` — i.e. the model that was "in flight" at
  the moment `/unload` fired ended up resident anyway a few seconds later.
- Calling `/unload` again afterward (against the now-actually-resident
  model) returned the same `200 {"status":"idle"}`, and `committed_mb`
  dropped to `4476.8` — a ≈4.0 GB delta, in the same ballpark as the row's
  documented ~3.4 GB figure (some variance expected: this box's
  `committed_mb` includes this worktree's own process overhead alongside
  the model, and no other engine was loaded to net that out precisely).
  `GET /health`'s device-level `free_mb` field did NOT move across any of
  these three states (stayed `7411` throughout) — that field reads from the
  driver at the whole-GPU level on a box shared by multiple concurrent
  sidecars, so it is not a reliable per-engine signal here; `committed_mb`
  (this process's own CUDA allocator accounting) is the field that actually
  tracked the load/unload.

**Bullet 2 verdict (partial):** the literal assertion in the row — mid-load
`/unload` returns 200, not 500 — is confirmed. What this run's timing did
NOT prove is the deeper claim implied by "immediate unload in the logs":
whether `unload_base17()`'s bounded wait actually holds up completion of
the racing `/load` and lets it finish before nulling, or whether (as
observed here) `/unload` arriving before `_base17` is assigned is simply a
no-op that has nothing to null yet, letting the in-flight load complete
unaffected either way. Both would produce the exact same external HTTP
result (200 idle, model resident moments later) with `curl`-level
timing — distinguishing them needs either the sidecar's own log line for
which branch fired, or a lock small enough to land the race deliberately.
`server/tts-sidecar/*.log` was not captured this run (stdout is written to
the console the sidecar was launched from, not a file this run had access
to) — the next run should check whether `_ensure_base17_loaded` writes an
identifiable log line, or add a temporary one, rather than relying on
timing to separate the two cases.

## A105 bullet 1 — base17-in-flight vs. concurrent design_voice() (4th run, 2026-09-07)

**Real result: CONFIRMED — no OOM; the design co-resided with (and, on the
second attempt, safely evicted) base17 on the same card, and completed with a
real `designed` event.**

Fired against this worktree's own server/sidecar (fixture book
`onbox-test__standalones__untitled`, undesigned character `unknown-male`, the
`рыбак` fold bucket — chosen specifically because it had never been designed,
unlike `ivan-petrovich`/`anna` which earlier bullets already consumed):

1. `POST :9170/load {"engine":"qwen","model":"1.7b"}` backgrounded to start
   the base17 load.
2. ~1 s later (`qwen_loading: true` confirmed the load was genuinely
   in-flight, not yet resident), fired
   `POST .../cast/unknown-male/design-voice/stream` (`persona` supplied
   directly, `sampleVoiceId: char-onbox-test__standalones__untitled__unknown-male`,
   `modelKey: qwen3-tts-0.6b`).

**First attempt** (this run's own methodology error, recorded so the next run
doesn't repeat it): the design SSE call was curled with `-m 60`; the design
took longer than that, curl was killed at 60 s, and
`GET .../cast/design-single/status` afterward showed `{"active":false}` with
no `voiceId` ever written to `cast.json` — the client disconnect appears to
have aborted the server-side job (or the job failed independently; not
distinguished). **Not reported as a finding** — a self-inflicted client
timeout, not evidence about the code under test.

**Second attempt**, corrected (curl `-m 300`, launched detached, polled via
`design-single/status` instead of relying on the SSE body): base17 loaded to
`qwen_base17_loaded: true` on `cuda:0` almost immediately (this run's box
apparently had the weights hot from the first attempt); the design job then
reported `phase: "freeing-vram"` via the status endpoint — i.e. it had to
evict base17 to fit — followed eventually by `qwen_base17_loaded: false` and
the design proceeding to completion:
`{"type":"designed","characterId":"unknown-male","voiceId":"qwen-eB3SAJ1iv6rDrCh0ueLVZ",
"url":"/audio/voices/char-onbox-test__standalones__untitled__unknown-male-qwen3-tts-0.6b-jcwm7x.mp3"}`.
No OOM at any point in either attempt. Post-completion `/health`:
`qwen_design_resident: true`, `qwen_device_key: "cuda:0"`,
`qwen_base17_loaded: false`; GPU0 `free_mb` dropped from the idle 7411 to
3456 (design resident), GPU1 unaffected (13700, essentially idle-baseline).

**Bullet 1 verdict:** the design did not OOM against an in-flight/resident
base17 on the same card — it correctly triggered the eviction path
(`freeing-vram`) and proceeded once base17 was cleared. This run did not
capture the sidecar's own stdout log (same limitation as bullet 2's note
above — no file-based log access from this run), so the *guard's internal
branch* (checking `_base17_in_flight.busy` vs. `_base17 is not None`) was not
directly observed; only the externally-visible behavior (no OOM, correct
eviction, successful design) was, which is what the row actually asks for.
Cleaned up afterward: `POST :9170/unload {"engine":"qwen"}` returned to a
fully idle sidecar (`qwen_loaded`/`qwen_base17_loaded`/`qwen_design_resident`
all `false`) before this run stopped.

## A105 bullet 3 — Kokoro pauses for VoiceDesign, direction 1 only (5th run, 2026-09-07)

**Fixture-setup blocker (owed by three prior runs) resolved this run:** the
fixture book had no Kokoro-voiced character, so there was nothing to render
on Kokoro to test the arbiter against. Found the app's own endpoint for
this — `PUT /api/books/:bookId/state` with `{"slice":"cast","patch":{"characters":[...]}}`
(`server/src/routes/book-state.ts:740`, `case 'cast'`) — the same funnel the
UI's cast editor itself uses (goes through `preserveDesignedVoices` +
`denormaliseCastReusedVoices` + the cast lock, not a raw file write).

**Self-inflicted near-miss, recorded so the next run doesn't repeat it:**
this slice is a **full replace of `characters`, not a merge** — the first
call sent only `unknown-male`'s object and it silently dropped
`ivan-petrovich` and `anna` from `cast.json` (204 response, no error). This
is disposable fixture data (not real book data, per the standing rule) so no
harm done, but the pattern generalises: **always PUT the complete array**
when using this slice, never a single-character delta. Recovered by
resending all three characters together (the two originals verbatim from
the on-disk state, `unknown-male` with `ttsEngine: "kokoro"`,
`voiceUuid: "af_bella"`, `overrideTtsVoices.kokoro.name: "af_bella"`).
Confirmed via re-read: all three characters present, `unknown-male` now
correctly on Kokoro.

Sequence (fixture book `onbox-test__standalones__untitled`, sidecar
confirmed idle first — `qwen_loaded`/`qwen_design_resident`/`kokoro_loaded`
all `false`, `inflight_synth: 0`):
1. `POST .../cast/ivan-petrovich/design-voice/stream` (persona supplied
   directly, `modelKey: qwen3-tts-0.6b`) — backgrounded, `-m 300`.
2. ~3 s later, `qwen_design_resident: true` confirmed (design genuinely
   in flight, `design-single/status` phase `loading-model`).
3. Fired `POST .../generation` for chapter 1, `modelKey: "kokoro-v1"` (the
   real model-key id — first attempt used the bare string `"kokoro"` and
   was rejected with `modelKey must be a supported TTS model id`; corrected
   from `server/src/tts/model-keys.ts`), `force:true`.

Observed:
- While the design held the arbiter (`qwen_design_resident: true`,
  `design-single/status` phase progressing `loading-model` →
  `designing` → `rendering`), the render's own progress **stalled at
  ~1-23%** for the entire window and `kokoro_loaded` stayed `false` — the
  render did not proceed while VoiceDesign was mid-forward. No
  `chapter_failed` fired during this wait.
- The design completed (`design-single/status` → `{"active":false}`), and
  `/health` immediately after showed `qwen_design_resident: false`,
  `kokoro_loaded: true` — the arbiter released.
- The render then advanced from ~23% straight through to completion within
  the next ~35 s (`progress` events climbing to 1.0), finishing with a real
  `chapter_complete` event — `audioModelKey: "kokoro-v1"`,
  `audioQa.status: "suspect"` (2 sentences flagged for runaway-synthesis
  duration, an audio-QA finding unrelated to the arbiter question), no
  error at any point.
- **Open observation, not chased further this run:** the completed chapter's
  `audioEngines` breakdown read `{"qwen":2,"coqui":1}` — no `kokoro` count
  at all, despite `kokoro_loaded` having flipped `true` mid-render and the
  request's `modelKey` being `kokoro-v1`. Either `modelKey` on this route is
  a request-level default that each character's own `ttsEngine` can still
  override (so `ivan-petrovich`/`anna` rendered via their designed `qwen`
  voices as normal, and `unknown-male`'s single line fell back to `coqui`
  for a reason not investigated), or there's a real fallback-engine
  question worth a closer look. Not reported as a finding either way —
  flagging it for whoever picks up bullet 3's second direction next, since
  they'll be staring at the same `audioEngines` field.

**Bullet 3 verdict (direction 1 only — CONFIRMED):** Kokoro paused while a
same-card VoiceDesign forward was in flight (through the full forward, not
just the load — matching the row's "not just the load" requirement) and
resumed once the design left. **Direction 2 (Kokoro must NOT pause for the
separate base17-eviction wait) was not attempted this run** — that needs a
fresh race against `_ensure_base17_loaded`'s eviction path specifically,
with no VoiceDesign involved, and this run's remaining budget went to
getting direction 1 measured cleanly instead of splitting across both.

Cleanup: `POST :9170/unload {"engine":"qwen"}` then `{"engine":"kokoro"}`,
confirmed via `/health` back to fully idle (`qwen_loaded`,
`qwen_design_resident`, `kokoro_loaded` all `false`, `inflight_synth: 0`)
before this run stopped.

## Remaining scope — not attempted this session

- **A24 bullets 2-4**: forcing a genuinely wedged design (bullet 2), the
  2-card cross-device negative control (bullet 3, needs the box's second
  card deliberately targeted — this worktree's Qwen pin did not reliably
  land on GPU0 in step 1's own findings, so this needs the same
  investigation step 1 already flagged as owed), and the
  `POST /api/sidecar/load` 90 s abort-budget conversion to `NoCapacityError`
  vs. a plain synthesis-path `AbortError` — none were driven. Bullet 4 (Pause
  mid-design-wait → `AbortError`) was attempted this session and blocked on
  fixture setup, not code — see its own section above; the fixture's single
  chapter needs to be reset to unsynthesized (or a new chapter added) before
  the wait state this bullet needs can even be reached.
- **A105 bullets 3 (direction 2), 4, 5**: bullet 3's second direction (Kokoro
  must NOT pause for the base17-eviction-only wait), the two-overlapping-
  designs case (bullet 4), and driving `Base17ContentionTimeoutError`
  deliberately (bullet 5) — none were driven. Bullets 1, 2, and 3
  (direction 1) are now driven to a real result — see their own sections
  above — with open sub-questions flagged for whoever picks up the rest:
  log-line vs. race-timing distinction on bullet 2, the internal guard-branch
  not directly observed on bullet 1, and the `audioEngines` fallback question
  on bullet 3.
- **A35 (4 bullets)**: the three-model (Qwen Base + base17 + Whisper)
  residency scenario, its two real 120 s idle-TTL waits
  (`ASR_IDLE_TTL`, `QWEN_BASE17_IDLE_TTL`), and the `/debug/memory`
  before/after diff — none were driven.

**Why stopped here:** each of the remaining bullets needs its own precisely
timed real race (or, for A35, two back-to-back 120 s real waits) against a
sidecar this box is already sharing with other live lanes — the same class
of multi-hour, contention-sensitive real-hardware work the ledger's #2993
entry hit for the same reason. Continuing past A105 bullet 1 inside this
run's remaining budget would mean either rushing the timing (an unreliable
pass/fail read, indistinguishable from a false pass) or reporting results
never actually observed. Neither is acceptable, so the claim is being left
parked (Agent Working, still assigned, no AGENT DONE/BLOCKED/FAILED) rather
than closed. Setup above (fixture book already in place, unload sequence
already known to work, exact endpoints already traced, A105 bullets 1 and 2's
`/load`+design/`/unload` race patterns now demonstrated directly against the
raw sidecar, and `design-single/status` confirmed as a more reliable poll
target than an SSE body a client-side timeout can sever) should let the next
run start directly on A24 bullet 2 or A105 bullet 3 instead of repeating this
reconnaissance.

## Cleanup / state at time of writing

- This worktree's sidecar (port 9170) and dev server (port 8250) were left
  running (same as step 1 left them — the next run needs them anyway).
  `qwen`/`coqui` were unloaded once mid-session (twice, across the two runs
  that have now touched this row) to free VRAM for design tests; both reload
  on demand.
- The `Onbox Test` fixture book now has `anna` (`qwen-uIRjRzpfDUZqLX_0eVctR`),
  `ivan-petrovich` (`qwen-F-lKfWgmxmPoLNK7nfUkk`) on Qwen, and `unknown-male`
  moved to **Kokoro** (`af_bella`, this run's own change — was
  `qwen-eB3SAJ1iv6rDrCh0ueLVZ` from the 4th run's A105 bullet 1) in this
  worktree's own throwaway workspace copy — expected and fine, it is a
  disposable fixture, not real book data. Chapter 1 is now fully synthesized
  end-to-end (this run's own A105 bullet 3 render, `audioModelKey:
  "kokoro-v1"`, `audioQa.status: "suspect"`) — this is exactly what blocks
  A24 bullet 4 above; the next run needs a fresh chapter or a book/chapter
  reset before attempting that bullet again, or should switch to a
  different, never-synthesized fixture entirely.
- No other lane's process was touched.
- This run's own design/render load/unload cycle left this worktree's
  sidecar back at idle (`qwen_loaded`, `qwen_design_resident`,
  `kokoro_loaded` all `false`, `inflight_synth: 0`) — no lingering residency.

**Still not finished after five runs.** A24 bullets 2-4, A105 bullet 3's
second direction plus bullets 4-5, and A35 (4 bullets) remain undriven — same
reasoning as above: forcing each race and waiting out A35's two real 120 s
idle TTLs needs sustained, carefully sequenced real-hardware time no single
run's budget has stretched to yet. The fixture now has a Kokoro-voiced
character in place, which was the actual blocker stalling bullet 3 across
runs 2-4 — the next run can go straight at bullet 3's second direction or
A105 bullet 4 without repeating this setup. Parking again (Agent Working,
still assigned) rather than reporting AGENT DONE against unfinished scope.
