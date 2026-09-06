# Step 2 — A24 design-contention wait + A105 base17 eviction guard + A35
# three-model stranded VRAM — PARTIAL, in progress

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

## Remaining scope — not attempted this session

- **A24 bullets 2-4**: forcing a genuinely wedged design (bullet 2), the
  2-card cross-device negative control (bullet 3, needs the box's second
  card deliberately targeted — this worktree's Qwen pin did not reliably
  land on GPU0 in step 1's own findings, so this needs the same
  investigation step 1 already flagged as owed), and the
  `POST /api/sidecar/load` 90 s abort-budget conversion to `NoCapacityError`
  vs. a plain synthesis-path `AbortError` (bullet 4) — none were driven.
- **A105 (5 bullets)**: base17-vs-design co-residency, the mid-load
  `/unload` 200 vs 500 check, the Kokoro/VoiceDesign mutual-exclusion
  arbiter in both directions, the two-overlapping-designs case, and driving
  `Base17ContentionTimeoutError` deliberately — none were driven.
- **A35 (4 bullets)**: the three-model (Qwen Base + base17 + Whisper)
  residency scenario, its two real 120 s idle-TTL waits
  (`ASR_IDLE_TTL`, `QWEN_BASE17_IDLE_TTL`), and the `/debug/memory`
  before/after diff — none were driven.

**Why stopped here:** each of the remaining bullets needs its own precisely
timed real race (or, for A35, two back-to-back 120 s real waits) against a
sidecar this box is already sharing with three other live lanes — the same
class of multi-hour, contention-sensitive real-hardware work the ledger's
#2993 entry hit for the same reason. Continuing past bullet 1 inside this
run's remaining budget would mean either rushing the timing (an unreliable
pass/fail read, indistinguishable from a false pass) or reporting results
never actually observed. Neither is acceptable, so the claim is being left
parked (Agent Working, still assigned, no AGENT DONE/BLOCKED/FAILED) rather
than closed. Setup above (fixture book already in place, unload sequence
already known to work, exact endpoints already traced) should let the next
run start directly on A24 bullet 2 instead of repeating this
reconnaissance.

## Cleanup / state at time of writing

- This worktree's sidecar (port 9170) and dev server (port 8250) were left
  running (same as step 1 left them — the next run needs them anyway).
  `qwen`/`coqui` were unloaded once mid-session to free VRAM for the design
  test; both reload on demand.
- The `Onbox Test` fixture book now has `anna` genuinely designed
  (`qwen-uIRjRzpfDUZqLX_0eVctR`) in this worktree's own throwaway workspace
  copy — expected and fine, it is a disposable fixture, not real book data.
- No other lane's process was touched.
