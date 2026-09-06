# Step 2 — A24 design-contention wait + A105 base17 eviction guard + A35
# three-model stranded VRAM — PARTIAL, in progress (3rd run adds A105 bullet 2)

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
- **A105 bullets 1, 3, 4, 5**: base17-vs-design co-residency (bullet 1), the
  Kokoro/VoiceDesign mutual-exclusion arbiter in both directions (bullet 3),
  the two-overlapping-designs case (bullet 4), and driving
  `Base17ContentionTimeoutError` deliberately (bullet 5) — none were driven.
  Bullet 2 (mid-load `/unload` 200 vs 500) was driven this session — see its
  own section above — with one open sub-question (log-line vs. race-timing
  distinction) flagged for whoever picks up bullet 1/3/4/5 next, since they
  all touch the same `_ensure_base17_loaded`/arbiter code path.
- **A35 (4 bullets)**: the three-model (Qwen Base + base17 + Whisper)
  residency scenario, its two real 120 s idle-TTL waits
  (`ASR_IDLE_TTL`, `QWEN_BASE17_IDLE_TTL`), and the `/debug/memory`
  before/after diff — none were driven.

**Why stopped here:** each of the remaining bullets needs its own precisely
timed real race (or, for A35, two back-to-back 120 s real waits) against a
sidecar this box is already sharing with other live lanes — the same class
of multi-hour, contention-sensitive real-hardware work the ledger's #2993
entry hit for the same reason. Continuing past A105 bullet 2 inside this
run's remaining budget would mean either rushing the timing (an unreliable
pass/fail read, indistinguishable from a false pass) or reporting results
never actually observed. Neither is acceptable, so the claim is being left
parked (Agent Working, still assigned, no AGENT DONE/BLOCKED/FAILED) rather
than closed. Setup above (fixture book already in place, unload sequence
already known to work, exact endpoints already traced, A105 bullet 2's
`/load`+`/unload` race pattern now demonstrated directly against the raw
sidecar) should let the next run start directly on A24 bullet 2 or A105
bullet 1 instead of repeating this reconnaissance.

## Cleanup / state at time of writing

- This worktree's sidecar (port 9170) and dev server (port 8250) were left
  running (same as step 1 left them — the next run needs them anyway).
  `qwen`/`coqui` were unloaded once mid-session (twice, across the two runs
  that have now touched this row) to free VRAM for design tests; both reload
  on demand.
- The `Onbox Test` fixture book now has both `anna`
  (`qwen-uIRjRzpfDUZqLX_0eVctR`) and `ivan-petrovich`
  (`qwen-F-lKfWgmxmPoLNK7nfUkk`) genuinely designed, in this worktree's own
  throwaway workspace copy — expected and fine, it is a disposable fixture,
  not real book data. Chapter 1 is now fully synthesized end-to-end (via
  `coqui-xtts-v2` from an earlier pass in this same session) — this is
  exactly what blocks bullet 4 above; the next run needs a fresh chapter or
  a book/chapter reset before attempting bullet 4 again, or should switch to
  a different, never-synthesized fixture entirely.
- No other lane's process was touched.
- This run's own base17 load/unload cycles left this worktree's sidecar back
  at idle (`qwen_base17_loaded: false`, `qwen_loaded: false`) — no lingering
  residency from the A105 bullet 2 race above.

**Still not finished after three runs.** A24 bullets 2-4, A105 bullets 1 and
3-5, and A35 (4 bullets) remain undriven — same reasoning as above: forcing
each race and waiting out A35's two real 120 s idle TTLs needs sustained,
carefully sequenced real-hardware time this run's own budget did not stretch
to either. Parking again (Agent Working, still assigned) rather than
reporting AGENT DONE against unfinished scope.
