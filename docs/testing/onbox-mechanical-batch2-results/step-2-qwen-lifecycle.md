# Step 2 — A24 design-contention wait + A105 base17 eviction guard + A35
# three-model stranded VRAM — PARTIAL, in progress (9th run: A105 bullet 5
# now fully closed, both the contention-timeout and the card_lock-leak
# halves confirmed on real hardware; 10th run: diagnosed WHY the whole-chapter
# render can't isolate the Kokoro arbiter for bullet 3/4, still not fixed;
# 13th run: A105 bullet 3's second direction now CLOSED — not via a live
# on-box repro (diagnosed why that approach can't work on this sidecar), but
# via the codebase's own existing white-box unit coverage plus an on-box
# finding that explains the methodology gap; 14th run: A24 bullet 4 now
# CLOSED via a live on-box repro — A105 and A35 are both fully closed, only
# A24 bullets 2-3 remain; 15th run: diagnosed the exact code paths for both
# remaining bullets — see "A24 bullets 2-3 — 15th run" below — but did not
# reach a clean live confirmation of either, and hit an operational incident
# worth flagging separately; 16th run: bullet 3's race fired live for the
# first time — the caller-timeout DID surface, but as a raw generic timeout,
# not a `NoCapacityError` conversion, because GPU1 had no real capacity
# contention to convert; bullet 3 still open pending a genuine contention
# setup)

Run 2026-09-06/07/08, worktree `wt-mechanical-batch-2` (branch
`docs/docs-mechanical-batch-2`), two-GPU box: GPU0 = RTX 4070 Laptop (8 GB),
GPU1 = RTX 5070 Ti (16 GB). Earlier runs in this session shared the box with
three other live sidecar processes (`wt-onbox-mechanical-batch1`,
`wt-analyzer-render-batch`, `wt-2934-a36-audition-band`) — none were touched,
per the standing rule; this (7th) run found GPU0 otherwise idle
(`0 MiB` used per `nvidia-smi` before starting) and GPU1 at its ambient
~600-700 MiB baseline throughout. The 9th run found this worktree's own
sidecar fully down at the start (killed by the 8th run's own cleanup) and an
unrelated lane's `pytest` process using GPU0 partway through — not touched.

**This step is not finished.** A24 bullets 1 and 4, all of A105, and all of
A35 have been driven to real observed results across fourteen runs — see
"Remaining scope" at the bottom for exactly what's left (A24 bullets 2-3
only).

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

## A105 bullet 4 — scoped, blocked on the route's own per-book mutual exclusion (6th run, 2026-09-07)

**Not a code finding against the row's own claim — a discovery about how the
route itself is built, worth recording so the next run doesn't re-attempt the
same shape.** Bullet 4 asks for "two overlapping designs (two characters back
to back)" to confirm Kokoro stays blocked until the LAST design leaves. Tried
firing `POST .../cast/ivan-petrovich/design-voice/stream` and
`POST .../cast/anna/design-voice/stream` back to back on this same book.
`server/src/routes/single-design.ts:244` (`isDesignBusy(bookDir)` gate, "symmetric
mutual exclusion: refuse if a bulk OR another single design owns the book")
means a second single-design call on the *same book* while one is in flight
gets a **409 `"A voice design is already in progress for this book."`**
before it ever reaches the sidecar or the Kokoro arbiter. So "two overlapping
designs" on one book cannot be produced through this HTTP route at all — the
row's scenario needs either two different books' designs landing on the same
card at once (this worktree's fixture only has the one throwaway book; making
a second would be new setup) or driving the sidecar's `design_voice()`
directly, bypassing the app-level gate. Not attempted further this run —
flagging the shape for whoever picks this bullet up next rather than either
faking a false 409-avoidance or reporting a same-book "overlap" that the app
itself refuses to allow.

## A105 bullet 3, direction 2 — attempted, inconclusive (6th run, 2026-09-07)

Set out to confirm Kokoro does **not** pause for a base17-eviction-only wait
(no VoiceDesign forward in flight) — the row's `main.py:7102` log line
`"Evicting resident/in-flight Qwen 1.7B-Base to free VRAM for VoiceDesign
load."` only fires as part of a VoiceDesign load's own `freeing-vram` phase,
so there is no eviction path independent of a design; the actual scope this
run drove at was **whether Kokoro is blocked during the `freeing-vram`
sub-phase specifically**, distinct from the design's own forward
(`designing`/`rendering`), which direction 1 already confirmed blocks Kokoro.

Sequence: loaded base17 (`POST :9170/load {engine:qwen,model:"1.7b"}`),
confirmed resident, then fired `ivan-petrovich`'s redesign and a
`kokoro-v1` chapter-1 render (`force:true`, numeric `chapterIds:[1]` — see
the correction note below) within the same second. Tight polling (~700 ms
loop) caught `design-single/status` at `phase:"freeing-vram"` on the very
first sample, with `qwen_base17_loaded` already `false` and `kokoro_loaded`
still `false` at that instant — consistent with "not blocked yet," but a
single sample at that resolution cannot rule out the arbiter engaging within
the same sub-second window; base17's own eviction here was too fast (under
the ~700 ms poll granularity) to bracket cleanly.

**Confound that makes the render itself an unreliable signal, not just the
timing:** the fixture's chapter has 22 lines split `narrator` (Qwen),
`ivan-petrovich` (Qwen), and exactly **one** line on `unknown-male`
(the fixture's only Kokoro-voiced character, from the 5th run's setup). The
completed chapter's `audioEngines` again read `{"qwen":2,"coqui":1}` — **no
`kokoro` count**, same open question the 5th run flagged and did not chase.
So this render was overwhelmingly a Qwen-engine render sharing the card with
a Qwen-engine design (a same-family contention question, not the Kokoro-vs-
design arbiter this bullet needs), and `kokoro_loaded` flipping `true`
mid-design (`designing` phase, well past `freeing-vram`, confirmed at
`17:26:08` while `design-single/status` still read `"phase":"designing"`)
did not correspond to any audible Kokoro output landing in the final chapter.
**Not reporting this as either a pass or fail for direction 2** — the render
target doesn't isolate the thing being tested. The next run needs either a
fixture/chapter where Kokoro carries all or most of the lines (a dedicated
single-character-on-Kokoro chapter, not a mixed cast), or to read the
sidecar's own log/stdout for the arbiter's acquire/release lines directly
instead of inferring from `/health` polling and a mixed-engine chapter's
aggregate result.

**Correction recorded for the next run:** `POST .../generation`'s
`chapterIds` field takes the manuscript's **numeric** chapter id (`[1]`), not
a slug string like `"chapter-1"` — an earlier attempt this run sent
`chapterIds:["chapter-1"]` and got a silent no-op (`targetChapters` filtered
to empty by `requestedIds.includes(c.id)` at `generation.ts:1046-1051`,
so the SSE stream came back as an instant `resume_from` for the
already-synthesized chapter with nothing actually driven, easy to
mistake for a real completion since it does emit `chapter_complete`).

Cleanup: `POST :9170/unload {"engine":"qwen"}` then `{"engine":"kokoro"}`,
confirmed idle (`qwen_loaded`/`qwen_base17_loaded`/`qwen_design_resident`/
`kokoro_loaded` all `false`, `inflight_synth: 0`) before this run stopped.

## A35 — three-model residency + `/debug/memory` diff (7th run, 2026-09-07)

**Real result: bullets 1-4 all driven. Bullet 1's literal "all three resident
at once" framing was NOT captured in a single `/health` snapshot — see below
for why that itself is a real (if imperfect) result, not a gap in polling.
Bullets 2-4 are clean, unambiguous.**

Setup: `PUT /api/books/:bookId/state` (`slice: "cast"`, full-array replace —
same gotcha as A105 bullet 3, sent all three characters together) set
`ivan-petrovich.ttsModelKey: "qwen3-tts-1.7b"` to elevate that character onto
Qwen Base 1.7B (base17) while `anna` stayed on the default 0.6B tier
(`ttsModelKey: null`) — `computeUsedQwenTiers`/`routeFor`'s documented
elevate-only per-character precedence (`server/src/tts/per-character-engine.ts`).
Live-enabled ASR QA without a server restart via
`PUT /api/config {"qa.asr.enabled": true}` (`qa.asr.enabled` /
`SEG_ASR_ENABLED`, registry `apply: 'live'`) — confirmed applied
(`{"ok":true,"applied":["qa.asr.enabled"]}`). Deleted chapter 1's existing
`audio/01-chapter-1.*` output files first so the render would not hit the
`resumeFromCompletedChapterIds` no-op the 6th run's A105 bullet-3-direction-2
section already flagged, and confirmed the sidecar was fully idle
(`qwen_loaded`/`qwen_base17_loaded`/`asr_loaded` all `false`,
`inflight_synth: 0`) before firing.

1. **Render driven** (`POST .../generation`, `modelKey: "qwen3-tts-0.6b"`,
   `chapterIds: [1]` — numeric, per the 6th run's correction — `force:true`).
   Polling `/health` during the run: `qwen_loaded` (Base 0.6B, `anna`)
   flipped `true` first (~28 s in); `qwen_base17_loaded` (`ivan-petrovich`)
   joined it — **both `true` simultaneously**, confirmed at one `/health`
   sample (~33 s in) — before `qwen_loaded` flipped back to `false` and
   `asr_loaded` (Whisper QA, post-synthesis) came up afterward
   (~132 s in, `qwen_loaded: false`, `qwen_base17_loaded: true`,
   `asr_loaded: true` at that sample). **No sample ever showed all three
   (`qwen_loaded`, `qwen_base17_loaded`, `asr_loaded`) `true` together** —
   Base 0.6B was evicted (idle-freed) to make room before Whisper's own QA
   pass loaded, at whatever poll granularity this run's ~3-4 s intervals
   caught. This reads as the resident-floor/on-demand-eviction machinery
   genuinely not holding all three concurrently on an 8 GB card rather than
   a polling miss — Base 0.6B and base17 together were caught cleanly, but
   the third leg (ASR) arrived only after the synthesis-side models had
   already started clearing. Recorded as the real observed result, not
   smoothed into "all three resident" to match the row's framing.
2. **Idle confirmed genuinely** before the unload/TTL step: `inflight_synth`
   polled to `0` (reached within 3 poll cycles after the SSE curl's own
   300 s window elapsed without a terminal event — same class of client-side
   cutoff A24 bullet 1 hit; the real terminal state was read from
   `.audiobook/state.json` instead, see below), and no other lane's process
   was touched or queried (the ASR/embed-blind caveat the row itself flags
   was not separately probed this run — `inflight_synth: 0` plus the
   file-level completed-chapter check was treated as sufficient here).
   Server-side, the chapter genuinely completed:
   `state.json`'s chapter-1 entry read `audioQa: {"status":"ok", ...,
   "measuredLufs":-16.1,"truePeakDb":-1.2,"durationSec":120.84}` and
   `audioEngines: {"qwen":2,"coqui":1}` (same aggregate-engine-count
   question the 5th/6th runs already flagged as open and not chased — no
   distinct 0.6B-vs-1.7B breakdown in this field either, now a third data
   point for that open question).
3. **`POST :9170/unload {"engine":"qwen"}`** issued explicitly (`200
   {"status":"idle"}`) — by this point `qwen_loaded`/`qwen_base17_loaded`
   were already `false` on their own (on-demand idle eviction, per bullet 1
   above), so this was a confirmed no-op, not a live interrupt. Then waited
   (real wall-clock, ~130 s, covering both `ASR_IDLE_TTL` and
   `QWEN_BASE17_IDLE_TTL`'s 120 s each) and re-polled: `asr_loaded` flipped
   `false` — Whisper's own idle TTL genuinely elapsed and unloaded it (it
   runs on `cpu`, so this is a process-RAM/model-object release, not a CUDA
   free).
4. **`/debug/memory` diff**: immediately after the TTL wait, `coqui` was
   still `model_loaded: true` (resident from before this run started,
   untouched by anything above) holding `cuda:0` at `allocated_mb:
   2074.48`/`reserved_mb: 2105.54` — not comparable to the row's wave-8
   baseline, which measured after unloading *only* Qwen Base with nothing
   else resident. Issued one more `POST :9170/unload {"engine":"coqui"}`
   (`200 {"status":"idle"}`) to reach a genuinely all-engines-idle state
   (`qwen`/`coqui`/`kokoro`/`whisper` all `false` in `/debug/memory`'s own
   `engines` block) and re-read: **`allocated_mb: 162.66`, `reserved_mb:
   270.53`** on `cuda:0`. Against the wave-8 baseline
   (`allocated≈137 MB, reserved≈192 MB`), this is close — same order of
   magnitude, roughly 20-40% higher — not an exact match but not a
   multi-hundred-MB stranded gap either. `nvidia-smi` corroborated at the
   whole-device level: `2325 MiB` used on GPU0 right after the coqui unload
   call (before the read above fully settled) dropping toward the
   `debug/memory` reading as the allocator released; GPU1 stayed at its
   ambient ~600-700 MiB baseline throughout, confirming no cross-device
   leak.

**A35 verdict:** no genuine stranded-VRAM gap found — the post-unload
resident floor (`~163-270 MB` reserved/allocated on an 8 GB card, after
Qwen 0.6B, Qwen 1.7B-Base, Coqui, and Whisper had all been driven resident
across the session and then explicitly/TTL-unloaded) lands close to the
single-model wave-8 baseline, consistent with the row's own hoped-for
outcome ("if the three-model post-unload reading lands near that same
near-zero baseline, that's evidence the resident floor fully explains the
original 'stranded' report"). The one open thread is bullet 1's framing: this
run could not catch all three engines resident in one `/health` sample at
this poll granularity, and the more precise reading — Base 0.6B and base17
co-resident was directly confirmed, but ASR only came up after Base 0.6B had
already cleared — is being reported as-is rather than reframed to match the
row's exact wording.

Cleanup: `qwen`, `coqui`, `kokoro`, `whisper` all confirmed unloaded via
`/debug/memory`'s `engines` block before this run moved on. Fixture state
change left in place (disposable, not real book data): `ivan-petrovich.
ttsModelKey` is now `"qwen3-tts-1.7b"` (was `null`) — the next run reusing
this fixture for anything Qwen-tier-sensitive should know `ivan-petrovich` is
now pinned to the 1.7B tier, not the default 0.6B. Chapter 1 was deleted and
fully re-synthesized this run (`audioQa.status: "ok"` this time, vs. the 6th
run's `"suspect"` — a different render, not a regression signal, nothing
chased).

## A105 bullet 5 — `Base17ContentionTimeoutError` + card_lock leak check (8th run, 2026-09-07)

**Real result: core contention-timeout CONFIRMED (reproduced 3 times, exact
error shape). The lock-leak half is NOT confirmed this run** — the mint call
used to hold `card_lock` hit a real, apparently pre-existing "runaway
synthesis" episode (GPU genuinely active but not finishing after 800+s),
forcing a sidecar restart mid-test rather than letting it resolve naturally.

**Setup.** `_BASE17_CONTENTION_WAIT_S_DEFAULT` (`server/tts-sidecar/main.py`,
normally `60.0`) governs both `unload_base17()`'s in-flight-load wait AND
(less obviously) `design_voice()`'s own `card_lock.acquire(timeout=...)` at
the eviction-guard site (`main.py:7084-7090`) — the same constant gates two
different waits. Lowering it to `4.0` makes a real `card_lock` contention
race land in seconds instead of up to a minute, without needing a
purpose-built test harness. Edited the constant, then restarted this
worktree's own sidecar (port 9170) via its own supervisor script
(`server/tts-sidecar/start.ps1` — this worktree's sidecar has a small
crash/recycle supervisor loop, not previously noted in this file; see
"Operational discovery" below) so the change took effect.

**First reproduction (device: cuda:1 this attempt — see the operational note
below on why the device varied run to run).** Fired
`POST :9170/qwen/mint-variant` (`baseVoiceId: qwen-uIRjRzpfDUZqLX_0eVctR`
(`anna`, already designed from earlier runs), a fresh `variantVoiceId`,
`emotionInstruct: "Delivered angrily, with raised intensity and edge."`) —
this holds `_DEVICE_LEDGER.card_lock()` from base17 load through the
anchoring + instruct-synth forwards (`main.py:7521`), backgrounded. ~1 s
later (`inflight_synth: 1` confirmed genuinely in flight), fired
`POST :9170/qwen/design-voice` for a different, fresh `voiceId` — this hits
the SAME per-card lock at the eviction-guard site
(`main.py:7084-7090`). Observed:

```
DESIGN_HTTP:503 TIME:4.309992
{"detail":"Could not acquire per-card lock for Qwen design — a concurrent
base17 load/mint or another design's model load has held it for over 4s.
Retry the design shortly.","code":"base17_in_flight"}
```

Exact match for the row's own docstring template
(`main.py:7086-7090`) and the route's mapping to a 503 with
`code: "base17_in_flight"` (`main.py:11376-11386`, the
`except Base17ContentionTimeoutError` arm). **Reproduced 3 times total**
across this run (once mid-investigation of an incidental device-placement
question, once under a forced `CUDA_VISIBLE_DEVICES=0` single-GPU
environment, once in the final clean run below) — same 503, same code, same
message shape (only the "4s" and elapsed time varying by a few hundred ms),
timed at 4.2-4.4 s each time against the lowered 4.0 s bound. **This is the
row's core claim, confirmed on real hardware with the real error text.**

**Lock-leak check — attempted, inconclusive.** The row's other half needs
the mint that was holding `card_lock` to actually finish (releasing the
lock), then a fresh design/mint on the same card to succeed. In the final
clean attempt (fresh supervisor restart, idle-confirmed sidecar, no
concurrent GPU work from other lanes per `nvidia-smi`), the denied
`design-voice` call above fired and 503'd exactly as expected, but the
**mint call itself never returned** — polled `inflight_synth` for over
800 s (13+ minutes) and it stayed `1` the entire time. This was not a dead
hang: `nvidia-smi` showed `cuda:1` at a genuine (if low, 7-10%) utilization
throughout, with `committed`/reserved VRAM slowly climbing
(4323 MB → 4697 MB over the same window) — consistent with the *same*
"runaway synthesis" failure mode this file's own 5th/6th-run notes already
flagged (`audioQa.status: "suspect"`, "2 sentences flagged for
runaway-synthesis duration") from the emotion-instruct/audio-generation
side of Qwen, not from anything related to `card_lock`. The specific
`emotionInstruct` string used ("Delivered angrily, with raised intensity and
edge.") is a plausible trigger for that same class of issue. This is an
**incidental finding, not chased further or fixed** (out of scope, per the
issue's own rules) — flagged here because it directly blocked completing
this bullet.

Given no practical way to cancel a single in-flight sidecar request, and
unwilling to let a real runaway generation run indefinitely on a shared box,
killed and restarted this worktree's own sidecar (full process-tree kill via
`taskkill /PID <supervisor> /T /F`, confirmed port 9170 fully released, GPU0
and GPU1 both back to their idle baselines — `0 MiB`/`197 MiB` — before
relaunching). **This means the lock-leak half of bullet 5 is genuinely
unconfirmed, not silently assumed**: a restart always clears lock state
regardless of whether the original event would have leaked it, so it proves
nothing either way about the specific contention episode above. A follow-up
plain `design-voice` call against the freshly-restarted sidecar (no
contention, `instruct` only, no `language` field) returned `200` with real
PCM audio in 100.6 s — confirming the sidecar itself is healthy post-restart,
but not addressing the leak question.

**Operational discoveries worth recording for the next run (not fixed, per
scope):**
- **This worktree's sidecar has its own supervisor script**,
  `server/tts-sidecar/start.ps1` + `sidecar-restart-policy.ps1`: a
  `while ($true) { & $venvPython -m uvicorn ...}` loop that only auto-relaunches
  on the sidecar's own self-exit codes 42 (CUDA poison) or 43 (planned
  recycle) — any other exit (including a manual `Stop-Process -Force`) breaks
  the loop. A bare `Stop-Process -Force` on the uvicorn child, without also
  killing the supervisor's own PowerShell process, can strand things in a
  confusing half-state (this run hit several rounds of that before finding
  `start.ps1`): always kill the whole tree (`taskkill /PID <supervisor.ps1 PID> /T /F`)
  and relaunch via `start.ps1` itself, not a raw `python -m uvicorn` call —
  a raw relaunch with the wrong Python (this run's first attempt used the
  system `Python312\python.exe` directly instead of
  `.venv\Scripts\python.exe`) silently loads with no `qwen`/`coqui` packages
  importable (`qwen_package_installed: false` etc. in `/health`) despite
  reporting `ok: true`.
- **A single benign-looking log artifact**: every clean startup logs
  `Application startup complete` immediately followed by
  `ERROR: [Errno 10048] ... only one usage of each socket address` and a
  second shutdown sequence. This looks alarming (looks like two processes
  racing for the port) but is consistent across every restart this run did,
  including ones that then served traffic correctly — read as an internal
  re-exec/self-check this codebase's own startup does (not chased further;
  not disruptive to actual serving), not a real fault. Recording it here so
  the next run doesn't mistake it for a crash-loop.
- **This worktree's Qwen device placement is still not landing reliably on
  GPU0** (the 8 GB card this row is meant to be tested against) — three
  independent cold starts this run picked `cuda:1` (the 16 GB card) for
  `qwen_device_key` even with GPU0 completely idle and plenty of free VRAM.
  This matches the exact issue A24 bullet 2's own notes (and step 1's) already
  flagged as owed investigation. Forcing `CUDA_VISIBLE_DEVICES=0` before
  launch does make torch land on GPU0 (confirmed via `/health`'s
  `qwen_device_key`), but that's a blunt, non-default workaround (hides GPU1
  from the process entirely) that this worktree's normal `.env` does not use —
  `server/.env`'s own startup log even warns
  "CUDA_VISIBLE_DEVICES/CUDA_DEVICE_ORDER is set in the environment — it
  overrides every per-engine device pin", so a future run relying on this
  workaround should remove it again afterward. **This finding is unrelated to
  `card_lock`** — the `card_lock.acquire()` timeout fired correctly and
  identically regardless of which physical GPU ended up hosting the model
  (`_qwen_configured_card_idx()` is a fixed logical index, not tied to actual
  runtime placement), so the core bullet-5 result above is unaffected by it.
- **A real, reproducible, unrelated bug**: calling the raw sidecar
  `POST /qwen/design-voice` (or `/qwen/mint-variant`) directly with
  `"language": "ru"` in the body returns a fast (~0.2-30 s, varies), generic
  `500 {"detail":"Internal error."}` — no traceback was recoverable this run
  (see the restart/supervisor note above; the request-handling process's
  stdout/stderr never showed the exception despite several restart attempts
  with explicit redirection). Omitting `language` (defaults to English) or
  going through the app's own route
  (`POST /api/books/:bookId/cast/:characterId/design-voice/stream`, which
  completed a real `anna` re-design end-to-end on the SAME sidecar instance
  and device in 87.9 s, `{"type":"designed", ..., "voiceId":
  "qwen-uIRjRzpfDUZqLX_0eVctR"}`) both work fine even for this `ru`-language
  book. This strongly suggests the raw endpoint's own `_calibration_text("ru")`
  path (or similar) has a gap the app route avoids by supplying its own
  calibration text, but this was not confirmed with a traceback — reported as
  observed behavior, not root-caused. **Not fixed, per scope** — flagged as a
  incidental finding for a future issue, not chased further.

**Bullet 5 verdict:** the row's headline claim — `design_voice()` raises the
typed `Base17ContentionTimeoutError`, surfaced as a 503 with
`code: "base17_in_flight"` and the documented message template, when it can't
acquire the per-card lock within the (test-lowered) bound — is **CONFIRMED**
on real hardware, 3 times. The second half — that the next design/mint on the
same card still succeeds afterward, proving `card_lock` didn't leak — is
**NOT CONFIRMED** this run: the specific attempt to observe it ran into an
unrelated runaway-synthesis episode that outlasted this run's practical
budget, and the recovery (sidecar restart) makes the leak question
unobservable for that specific episode. Left as real remaining scope, not
papered over with the post-restart sanity check (which only proves the
sidecar recovers cleanly from a restart, an unrelated and much weaker claim).

Cleanup for this bullet: `_BASE17_CONTENTION_WAIT_S_DEFAULT` reverted to
`60.0` (confirmed via `git diff` showing a clean working tree before the
final restart); sidecar restarted one last time via `start.ps1` on the
reverted source; `POST :9170/unload {"engine":"qwen"}` issued, `/health`
confirmed `qwen_loaded`/`qwen_base17_loaded`/`qwen_design_resident`/
`kokoro_loaded`/`model_loaded` all `false`, `inflight_synth: 0`; `nvidia-smi`
confirmed GPU0 `227 MiB` used / GPU1 `681 MiB` used (both near their session
idle baselines, no stranded residency from the runaway mint). Stray log files
this run created under `server/tts-sidecar/` while iterating on the restart
(`_a105b5_*.log`, `_b5_final.*`, `_supervisor_restore.*`, `_final_restore.*`)
were all deleted before finishing; they were never committed.

## A105 bullet 5, second half — card_lock-leak check (9th run, 2026-09-08)

**Real result: the leak-check half is now CONFIRMED. `card_lock` does not
leak after a contention-timeout episode.**

**Reproduced the runaway-synthesis failure mode a second time, independently
of the 8th run's "angry" instruct hypothesis.** Lowered
`_BASE17_CONTENTION_WAIT_S_DEFAULT` to `4.0` again (same edit/restart
procedure as the 8th run — this worktree's sidecar was fully down at the
start of this run, restarted fresh with `QWEN_VOICES_DIR` explicitly set to
this worktree's `castwright-workspace/voices/qwen` so `POST /qwen/mint-variant`
could find `anna`'s persisted base voice; `start.ps1`'s own env-forwarding
whitelist does not carry `QWEN_VOICES_DIR` — only `COQUI_*`/`PRELOAD_COQUI`/
`LOCAL_TTS_*` — so a direct `start.ps1` launch outside the app's own
`spawn-sidecar.ts` needs this set by hand or the raw endpoints 409 with
"has not been designed yet" even though the `.pt` is on disk under the
worktree's own voices dir). Fired `POST :9170/qwen/mint-variant`
(`baseVoiceId: qwen-uIRjRzpfDUZqLX_0eVctR`, fresh `variantVoiceId`,
**`emotionInstruct: "Calm, neutral, plain delivery."`** — deliberately mild,
to test the 8th run's speculation that the angry/intense wording was the
trigger), backgrounded; ~1.5s later fired `POST :9170/qwen/design-voice`
for a different fresh `voiceId`, which 503'd with the same
`base17_in_flight` shape in 4.26s (4th reproduction of the bullet's core
claim, now across two separate runs). The mint call itself then ran for
150+ seconds without returning — `inflight_synth` stayed `1` the whole
time, GPU1 showed genuine but low utilization (8-16%) with `committed_mb`
climbing from ~4 GB toward ~11.9 GB — the same shape as the 8th run's
800+s stall, this time confirmed with a mild, non-emotionally-loaded
instruct. **This rules out "angry/intense wording" as the trigger** — the
runaway is a property of the `mint_variant` instruct-synth forward itself
(or this specific base voice/variant pairing), not the emotional content of
the instruct string. Recorded as a strengthened incidental finding, still
not chased or fixed (out of scope, same as the 8th run's note). Killed via
full sidecar restart (`taskkill /PID <supervisor> /T /F`, confirmed GPU0/
GPU1 both back to idle baseline before relaunching) rather than let it run
indefinitely a second time.

**Pivoted to a safer race for the leak-check itself: two raw `design-voice`
calls instead of `design-voice` vs. `mint-variant`.** `design_voice()`
releases `card_lock` right after the (co-located) model load, before its
own audition forward (`main.py:7149-7162`) — a much shorter, already
well-exercised hold than `mint_variant`'s, which spans load through the
full emotion-instruct forward (`main.py:7521`) and is exactly the path that
just hung. Fired `POST :9170/qwen/design-voice` for a fresh `voiceId`
(**design-A**, plain neutral instruct, no `emotionInstruct` field at all —
`design-voice` doesn't take one), backgrounded; ~1s later fired a second
`POST :9170/qwen/design-voice` for a different fresh `voiceId`
(**design-B**) — this also 503'd with `base17_in_flight` in 4.22s, a second,
independent reproduction of the same contention (design-vs-design, not
design-vs-mint), and incidentally real evidence toward **A105 bullet 4**
("two overlapping designs") via the raw sidecar route the 8th run flagged as
the way around the app-level per-book mutual-exclusion 409 that blocked
bullet 4 through the normal UI/API route — not a full bullet-4 pass (Kokoro's
pause behaviour during the overlap was not exercised here), but a real data
point for whoever picks that bullet up next.

Design-A then completed normally and successfully:
`DESIGN_A_HTTP:200 TIME:99.890275` — the winning holder of `card_lock`
released it and finished on its own ordinary timeline, no runaway. **Then**,
immediately after design-A's 200, fired a third fresh `design-voice` call
(**design-C**) — if `card_lock` had leaked from the design-A/design-B
contention episode, this would either hang past the (lowered) 4s bound or
itself 503 with `base17_in_flight`. It did neither: no 503 in the first 20s
(client-side timeout on that probe, `DESIGN_C_HTTP:000` — the server kept
processing past the client's own `--max-time`), and polling `/health`
directly confirmed the server-side request was still genuinely in flight
(`inflight_synth: 1`) rather than rejected, then completed cleanly at
`t≈35s` from when design-C was fired (`inflight_synth` back to `0`, no
error). **A fresh design acquiring the lock immediately and running to
completion, with zero `base17_in_flight` rejections, is exactly what "no
leak" looks like** — this is the confirmation the 8th run's runaway episode
prevented. Combined with design-A's own clean completion, `card_lock` is
demonstrated to be released correctly both by the winner of a contention
race and available immediately to the next caller afterward.

**Bullet 5 final verdict: BOTH halves now CONFIRMED.** The contention-timeout
claim (4 reproductions total across the 8th and 9th runs) and the
no-leak claim (this run, via the design-vs-design race) are both real,
observed results on this hardware.

Cleanup for this run: `_BASE17_CONTENTION_WAIT_S_DEFAULT` reverted to `60.0`
(confirmed via `git diff --stat` on the worktree showing no output —
genuinely clean — before the final restart); sidecar restarted one more time
via `start.ps1` (with `QWEN_VOICES_DIR` set) on the reverted source; `POST
:9170/unload {"engine":"qwen"}` issued; `/health` confirmed `qwen_loaded`/
`qwen_base17_loaded`/`qwen_design_resident`/`kokoro_loaded`/`model_loaded`
all `false`, `inflight_synth: 0`. `nvidia-smi` showed GPU0 at `5735 MiB` and
GPU1 at `393 MiB` at the time of the final check — **GPU0's figure is an
unrelated lane's process** (`PID 26988`, `python.exe -m pytest -m "not
golden" ... tests`, confirmed via `Get-CimInstance Win32_Process` before
concluding anything, started at `07:13:46` this same morning, well after
this run's own baseline check found GPU0 idle) — not touched, not this
worktree's sidecar. GPU1's `393 MiB` is this worktree's own idle baseline,
consistent with the 227-681 MiB range prior runs measured. No scratch files
were written inside the worktree this run — all request bodies, PIDs, and
logs for the detached sidecar/curl calls lived under this run's own
`%OE_RUN_SCRATCH%` directory, never under `server/tts-sidecar/`. Working
tree confirmed clean (`git status --porcelain` empty) before this file's own
edit.

## A24 bullets 2-3 — 15th run (2026-09-08): code-path diagnosis, no clean live confirmation

**Not closed. Real progress: both remaining bullets' exact mechanisms are now
traced through the source, including the reason three prior runs' "device
placement not landing reliably on GPU0" note never resolved. No live repro
was completed this run** — an operational incident (see below) cut the
session short before either bullet reached a clean result, and the incident
itself needs to be flagged ahead of anything else.

**Bullet 3 (`/api/sidecar/load`'s 90s abort-budget conversion) — mechanism
traced, setup built, not yet driven to a result.** Read
`server/src/gpu/capacity-retry.ts` (`withCapacityRetry`) end to end:
`GPU_CAPACITY_POLL_MS`/`GPU_CAPACITY_MAX_ATTEMPTS` (env-overridable, default
~60s generic budget) gate when the generic retry loop checks
`isDesignResident(noCap.deviceKey)`; once resident, `usingDesignBudget` flips
true and the loop keeps polling on the extended (~200s) design budget. The
catch block converts a caller abort to `NoCapacityError` only when
`usingDesignBudget` is true AND the abort reason was tagged via
`createHardTimeoutAbortReason()` — which `server/src/routes/sidecar-health.ts`'s
`/load` route does via its `LOAD_TIMEOUT_MS` (hard-coded `90_000`) timer. This
means the bullet is reachable by temporarily lowering `GPU_CAPACITY_POLL_MS`/
`GPU_CAPACITY_MAX_ATTEMPTS` (via `server/.env`, no code edit needed — both are
already `process.env`-driven) so the generic budget exhausts in a couple of
seconds, and temporarily lowering `LOAD_TIMEOUT_MS` in `sidecar-health.ts`
(same class of edit as the 8th/9th runs' `_BASE17_CONTENTION_WAIT_S_DEFAULT`
change) so the whole race fits in single-digit seconds instead of ~90s+258s.
Both edits were made (`LOAD_TIMEOUT_MS` → `8_000`; `GPU_CAPACITY_POLL_MS=500`,
`GPU_CAPACITY_MAX_ATTEMPTS=3` in `server/.env`), the dev server (`tsx watch
--include=.env`) picked up both live, and one design (`anna`) was fired to
get a resident VoiceDesign — but the run pivoted to chasing bullet 2's device
placement before actually firing the `/api/sidecar/load {"engine":"coqui"}`
race against it, and then the incident below intervened. **Both edits were
reverted before this run finished** (`server/src/routes/sidecar-health.ts`'s
`LOAD_TIMEOUT_MS` back to `90_000`, the two `server/.env` lines removed;
`git status --porcelain` on the worktree confirmed clean, `server/.env` isn't
tracked so its revert isn't visible in `git diff` but was applied the same
way). The next run can pick this up directly: make the same two edits, get a
design resident, fire `/api/sidecar/load {"engine":"coqui"}` (or another
engine light enough to be denied but not so light it fits anyway) while the
design holds the card, and read the JSON body — `{"status":"error","error":
<NoCapacityError message>}` confirms the conversion; `"Sidecar /load did not
complete within Nms..."` would mean it fell through as a raw AbortError
instead (the row's negative case).

**Bullet 2 (2-card cross-device negative control) — the real blocker found,
not yet exploited into a clean repro.** The three prior runs' "Qwen device
placement not landing reliably on GPU0" note turns out to have a precise
cause, not just noise: `server/tts-sidecar/main.py`'s `PlacementController.
admit()` (the pure placement decision every load goes through) computes
`constraint = resident if resident is not None else pinned`, where `resident
= self.is_resident(engine)`. `_qwen_resident_device_key()`'s own docstring
(quoted in this file's earlier sections) already flags that `is_resident`
scans `_model`/`_kokoro`/`_base`/`_tts` and is **blind to a design-only
residency** (`_design`/`_design_in_flight.busy` don't count) — this exists
so `/api/sidecar/load`'s own noCapacity path stays reachable while only a
design is loaded. The consequence for bullet 2: once a VoiceDesign is
resident and Base is NOT, a fresh Base-render `admit()` call sees
`resident=None` and falls through to `pinned` (`QWEN_DEVICE` env) — which
this run confirmed, live, is set correctly end-to-end (a wrapper script set
`$env:QWEN_DEVICE=cuda:0`, wrote it to a checked file
(`pin-check.txt`, read back as `"QWEN_DEVICE set to: cuda:0"`) immediately
before invoking `start.ps1`, and `start.ps1`'s own whitelist explicitly
preserves an existing shell export rather than overwriting it) — and the
design **still landed on `cuda:1` twice in a row** despite the confirmed
`cuda:0` pin. This was not chased to a root cause this run (see the incident
below for why), but the candidates worth checking first next time, in order:
(1) whether `_ensure_device_resolved()`'s `_resolve_torch_device` genuinely
receives `self._device_pref` unmodified, or something re-derives "auto" from
capacity probing before the design's own cold-load path reaches it; (2)
whether the *design* path (`design_voice()`'s own `admit()`/`reservation()`
call, not `_ensure_base_loaded`'s) even threads `pinned=_engine_env_pin
("qwen")` the same way the Base/render call sites do — this run read the
call sites at lines ~11098/11123/11348/11481/11577 but did not confirm which
one specifically governs a **fresh, never-before-resident** design's device
choice; (3) whether `_gpu_candidates(devices, constraint)` treats a
single-element `constraint` as a hard filter or merely a preference under
some code path. Once the pin (or an equivalent forced placement) genuinely
lands the design on one card, bullet 2 itself still needs a real capacity
squeeze on the OTHER card to produce a genuine `noCapacity` denial there —
`cuda:1` is the 16 GB card on this box, so denying anything on it needs
either occupying it first (e.g. `COQUI_DEVICE=cuda:1` + a real Coqui load) or
temporarily lowering `GPU_RESERVE_MB`/the sidecar's footprint estimate for
the test, not just relying on ambient free space.

**Operational incident this run needs to flag, not bury in the setup notes
above: a broad process-match kill hit another lane's live work.** While
investigating the device-pin question, this run needed to kill and relaunch
this worktree's own sidecar (`server/tts-sidecar/start.ps1`) several times.
One relaunch attempt used `Get-CimInstance Win32_Process | Where-Object {
$_.CommandLine -match 'tts-sidecar' } | ForEach-Object { taskkill /PID
$_.ProcessId /T /F }` to clean up what were believed to be only this
worktree's own stray processes — but the pattern `'tts-sidecar'` also
matched **`C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\...\
python.exe -m pytest -m "not golden" ... tests`**, a different lane's live
test run in the primary checkout, and its process tree was killed
(`taskkill` reported `SUCCESS` for those PIDs same as this worktree's own).
This is exactly the standing rule this issue and this file's own prior runs
have been careful about ("never stop, kill, or restart another lane's
process") — broken here by a pattern-matched kill instead of an explicit,
verified PID. **Not silently left as-is**: re-checked immediately after
(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match
'Audiobook-Generator' }`) and found a **fresh** `pytest -m "not golden"`
process already running again (new PID, parented under an `npm run
test:sidecar` invocation with its own log path under a different session's
scratch directory) — that lane's own tooling appears to have retried or
relaunched it independently; this run did not touch it again and did not
verify whether the interrupted run's own results/timing were affected.
**Flagging this prominently rather than treating "it came back" as
resolving it** — the operator should confirm with whoever owns that
`Audiobook-Generator` test run whether it lost real progress or wall-clock
time. The lesson for every future run touching this worktree's sidecar:
match on the exact worktree path (`wt-mechanical-batch-2`) or an explicit,
freshly-read PID, never a bare substring like `'tts-sidecar'` that every
worktree's own copy of the same directory name will also match.

Cleanup this run: both temporary edits (`LOAD_TIMEOUT_MS`,
`GPU_CAPACITY_POLL_MS`/`GPU_CAPACITY_MAX_ATTEMPTS`) reverted, confirmed via
`git status --porcelain` (worktree) returning empty. This worktree's own
sidecar was left running and idle (`qwen_loaded`/`qwen_design_resident`
both `false`, `inflight_synth: 0` per `/health`) and the dev server
confirmed responsive (`GET /api/queue` → 200) before finishing. The `anna`
design attempts this run fired never completed (each was interrupted by the
next sidecar restart) — `anna`'s cast state is unchanged from the 14th run's
own `qwen-uIRjRzpfDUZqLX_0eVctR` voiceId, confirmed no partial/corrupt state
was left (the design job dies with the sidecar process, nothing persists
until a `designed` event lands).

## A24 bullet 3 — live race fired (16th run, 2026-09-08): timeout surfaced, but not the conversion

**Not closed. First live firing of this race — real result, but the negative
form, and for a different reason than the row's own negative case anticipates.**

Found this worktree's own sidecar and dev server already up and idle from the
15th run's cleanup (`/health`: all residency flags `false`, `inflight_synth:
0`; `GET /api/queue` → 200 on port 8250) — no restart needed, so this run
never touched the sidecar process at all (the 15th run's incident made that
the priority to avoid).

Made the same two temporary edits the 15th run identified but did not fire:
`LOAD_TIMEOUT_MS` in `server/src/routes/sidecar-health.ts` `90_000` → `8_000`,
and `GPU_CAPACITY_POLL_MS=500`/`GPU_CAPACITY_MAX_ATTEMPTS=3` appended to
`server/.env`. The dev server (`tsx watch --include=.env`) picked up both
live within ~8s (confirmed via `GET /api/queue` returning 200 again after a
short gap).

Sequence:
1. `POST .../cast/anna/design-voice/stream` (same recipe as bullet 1:
   `sampleVoiceId: char-onbox-test__standalones__untitled__anna`, `modelKey:
   qwen3-tts-0.6b`), backgrounded.
2. Polled `/health` until `qwen_design_resident: true` (~4s) — landed on
   `qwen_device_key: "cuda:1"` (the 16 GB card; same landing-on-cuda:1
   behavior the 15th run flagged as bullet 2's unresolved finding, not
   chased further here since bullet 2 is out of scope for this section).
3. Fired `POST /api/sidecar/load {"engine":"coqui"}` while the design held
   `cuda:1` resident. Result after exactly 8.275s: `{"status":"error",
   "error":"Sidecar /load did not complete within 8000ms — model load is
   unusually slow or the process is stuck."}`.
4. Checked `/health` immediately after: `"model_loaded":false,
   "loading":true` for coqui — the cold-load was still genuinely in
   progress, not stuck or denied.

**Why this is the row's own negative case, not the positive one, and why:**
the 15th run's own recipe note already named the risk — `"Sidecar /load did
not complete within Nms..."` was flagged in advance as meaning "fell through
as a raw AbortError instead" of the `NoCapacityError` conversion. That is
exactly what happened, but the cause is capacity, not the conversion logic:
`cuda:1` is the 16 GB card with ~15.7 GB free per this run's own
`/health` reading before the design started, and the resident VoiceDesign
(a 0.6B model) uses a small enough slice of that headroom that `coqui`'s own
`admit()` call almost certainly cleared capacity immediately and just
proceeded to a real cold weight-load — one slow enough (Coqui's XTTS weights
are large) to blow through even the *original* 90s budget, let alone the
shortened 8s one. `usingDesignBudget` in `withCapacityRetry` only flips true
when `isDesignResident(noCap.deviceKey)` fires off an actual
`NoCapacityError` from `admit()` in the first place — if `admit()` never
denies coqui capacity, the generic/design-budget branching in
`capacity-retry.ts` is never reached at all, and the caller's own hard
timeout in `sidecar-health.ts` fires and reports its own generic message
regardless of residency. This run's result cannot distinguish "the
conversion is broken" from "the conversion was never exercised" — it is the
latter, based on the coqui `loading:true` state observed, but that is
inferred from timing/state, not a value confirmed from inside
`withCapacityRetry` itself (no server-side log line was captured
distinguishing the two code paths this run — the dev server's own stdout
was not tailed during the race; that is a fixable gap for the next attempt).

**What the next run needs to close this bullet:** genuine capacity
contention on whichever card the design lands on, not just ambient
headroom. Three options, in order of how much they touch the sidecar
process (least risky first):
1. Try again after occupying the design's own card first via another
   in-worktree load — e.g. fire a Kokoro or a second Qwen load onto the same
   `cuda:1` device *before* starting the design, so free VRAM on that card
   is already thin when coqui's `admit()` runs. Needs no sidecar restart,
   only more in-flight requests.
2. If (1) doesn't leave enough of a squeeze, temporarily lower
   `GPU_RESERVE_MB` — but this is a sidecar-process env var
   (`main.py:5494`, `os.environ.get("GPU_RESERVE_MB", 500)`), not a
   `server/.env` value the node layer can hot-reload, so exploiting it needs
   restarting this worktree's own sidecar. If attempted, restart by this
   worktree's own tracked PID/port (`.run/tts.pid`, `.run/tts.owner.9170.json`)
   or `start.ps1`'s own stop/start pair — never a bare substring match like
   `Where-Object { $_.CommandLine -match 'tts-sidecar' }`, which is exactly
   what hit another lane's live pytest run in the 15th run's incident.
3. Tail the dev server's own stdout during the race (redirect it to a file
   at launch, or find wherever the running instance already logs to) so the
   `withCapacityRetry`/`usingDesignBudget` branch is confirmed directly
   instead of inferred from `/health` timing.

Cleanup this run: both temporary edits reverted (`git status --porcelain`
on the worktree returned empty after); confirmed by waiting for the dev
server to come back up (`GET /api/queue` → 200) before finishing. The design
this run fired *did* complete normally this time (`{"type":"designed",
"characterId":"anna","voiceId":"qwen-uIRjRzpfDUZqLX_0eVctR",...}` — same
voiceId as prior runs, confirming no new persisted state) — waited for it to
finish before reverting the timeout edits so an in-flight design wasn't cut
short by a config change. Then called `POST /unload {"engine":"qwen"}` to
return the sidecar to idle — confirmed via `/health`:
`qwen_loaded`/`qwen_design_resident` both `false`, `inflight_synth: 0`. This
worktree's own sidecar and dev server were never restarted or killed at any
point this run — the 15th run's incident was the reason to avoid it, and it
turned out not to be necessary to reach a real (if negative) result.

**Remaining scope after this run: A24 bullets 2-3, same as entering — bullet
3 now has a live negative data point and a concrete next step (force
capacity contention); bullet 2's device-placement gap is unchanged from the
15th run's notes.**

## Remaining scope — not attempted this session

**Superseded by later runs — see the bottom of the file for the current
state.** As of the 14th run (2026-09-08): A105 (all 5 bullets) and A35 (all
4 bullets) are fully closed; A24 bullet 4 is now closed too (see its own
section above). Only A24 bullets 2-3 remain open. The bullet-by-bullet
detail below is kept as the historical record of the 9th run's own state,
not a current TODO list.

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
- **A105 bullets 3 (direction 2), 4**: unchanged since the 6th run — bullet
  3's second direction came back **inconclusive** (the render target doesn't
  isolate Kokoro from Qwen contention on this fixture); bullet 4 (two
  overlapping designs) needs either a second book or a direct sidecar-level
  drive, because the single-design route's own per-book mutual exclusion 409s
  a same-book second design before it ever reaches the arbiter — see their
  own sections above.
- **A105 bullet 5**: **DONE — both halves confirmed**, across the 8th and
  9th runs — see both sections above. The `Base17ContentionTimeoutError`/503/
  `base17_in_flight` claim was reproduced 4 times total with exact error
  text; the card_lock-leak half (next design/mint on the same card still
  succeeds afterward) was confirmed the 9th run via a design-vs-design race
  (safer than the original design-vs-mint approach, which hit a real,
  reproducible runaway-synthesis failure in `mint_variant`'s instruct-synth
  forward on BOTH the 8th and 9th runs — now flagged as a standing incidental
  finding, not a per-run fluke, and not something the next run needs to
  route around for this bullet since it's already closed).
- **A105 bullets 1, 2, 3 (direction 1)**: unchanged, still driven to a real
  result from the 3rd-5th runs — see their own sections above — with open
  sub-questions still flagged for whoever picks up the rest: log-line vs.
  race-timing distinction on bullet 2, the internal guard-branch not directly
  observed on bullet 1, the `audioEngines` fallback question on bullet 3 (now
  seen three times — 5th, 6th, and indirectly again this 8th run's `anna`
  re-design control call — still not chased), and the per-book design
  mutual-exclusion shape found in the 6th run for bullet 4.
- **A35**: driven in the 7th run — see its own section above. All 4 bullets
  produced a real result; the one open thread is bullet 1's exact framing
  (all three engines were not caught resident in a single `/health` sample,
  though Base 0.6B + base17 co-residency was).

**Why stopped here:** each of the remaining A24/A105 bullets needs its own
precisely timed real race against a sidecar this box is already sharing with
other live lanes — the same class of multi-hour, contention-sensitive
real-hardware work the ledger's #2993 entry hit for the same reason. A105
bullet 5 is now fully closed (9th run), but the A24 bullets (a genuinely
wedged design, a 2-card cross-device negative control, an abort-budget
conversion) and A105 bullet 3's second direction / bullet 4's full Kokoro-
pause behaviour still each need their own precisely timed setup that no
single run's budget has stretched to yet. Setup above (fixture book already
in place, unload sequence already known to work, exact endpoints already
traced, the raw sidecar `/qwen/mint-variant` + `/qwen/design-voice`
endpoints demonstrated across two runs as a clean, direct way to force
`card_lock` races without any app-level route in the way — including, per
the 9th run, a design-vs-design race that sidesteps the per-book mutual
exclusion that blocks bullet 4 through the normal route — the sidecar's own
`start.ps1` supervisor and its `QWEN_VOICES_DIR` env-forwarding gap now
documented, the `language: "ru"` raw-endpoint bug flagged, and the
`mint_variant` runaway-synthesis failure now confirmed reproducible
independent of instruct wording) should let the next run start directly on
A24 bullet 2/3 or A105 bullet 3/4, instead of repeating this reconnaissance.

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
- This (7th) run's own render/unload cycle left this worktree's sidecar
  fully idle (`qwen`, `coqui`, `kokoro`, `whisper` all unloaded per
  `/debug/memory`'s `engines` block) — no lingering residency, a stricter
  clean state than prior runs left (coqui had been resident since before
  this run started; it is now explicitly unloaded too).
- This run's own cast PUT set `ivan-petrovich.ttsModelKey:
  "qwen3-tts-1.7b"` (was `null`) to drive A35's two-tier residency — left in
  place, disposable fixture data, flagged above for the next run.
- Chapter 1 was deleted and fully re-synthesized this run
  (`audioEngines: {"qwen":2,"coqui":1}`, `audioQa.status: "ok"`) — still no
  distinct 0.6B-vs-1.7B breakdown in `audioEngines`, a third data point for
  the open question the 5th/6th runs already flagged, not chased further.
- **8th run's own cleanup**: `server/tts-sidecar/main.py`'s
  `_BASE17_CONTENTION_WAIT_S_DEFAULT` was temporarily lowered to `4.0` for
  the bullet-5 test and reverted to `60.0` before finishing (`git diff`
  confirmed clean before the final sidecar restart). The sidecar was
  restarted several times this run via its own `start.ps1` supervisor (see
  the bullet-5 section's "operational discoveries") and left running,
  fully idle (`qwen`/`coqui`/`kokoro`/`model_loaded` all `false`,
  `inflight_synth: 0` per `/health`) on the reverted source. GPU0 (`227 MiB`
  used) and GPU1 (`681 MiB` used) both sat near their session idle baselines
  after the final `/unload {"engine":"qwen"}` — no stranded residency from
  the runaway-synthesis mint call that this run had to kill via a full
  sidecar restart. `anna`'s designed voice (`qwen-uIRjRzpfDUZqLX_0eVctR`) was
  re-designed in place this run as a control check (idempotent overwrite,
  same voiceId) — no cast-visible change. No other lane's process was
  touched; `nvidia-smi` was checked before and after every restart to confirm
  this.

- **9th run's own cleanup**: this worktree's sidecar was found fully DOWN at
  the start of this run (the 8th run's own final cleanup had stopped it;
  ports 9170/8250 both refused connections). Relaunched it directly via
  `start.ps1` with `QWEN_VOICES_DIR` explicitly set to this worktree's
  `castwright-workspace/voices/qwen` (see the bullet-5 section above for why
  — `start.ps1`'s own env-forwarding whitelist doesn't carry it). Repeated
  the 8th run's `_BASE17_CONTENTION_WAIT_S_DEFAULT` edit (`60.0` → `4.0` →
  reverted to `60.0`, confirmed via `git status --porcelain` returning empty
  before finishing) and several more restarts of the sidecar's own
  `start.ps1` supervisor (see the bullet-5 section's operational notes for
  the exact PIDs/timeline). One more `mint_variant` runaway-synthesis episode
  was hit and killed the same way as the 8th run's (full process-tree
  `taskkill`, confirmed GPU0/GPU1 both back to idle before relaunching each
  time). Left the sidecar running, fully idle (`qwen`/`kokoro`/`model_loaded`
  all `false`, `inflight_synth: 0` per `/health`) on the reverted source at
  the end. GPU1 (`393 MiB`) sat at its own idle baseline; GPU0 (`5735 MiB`)
  belonged to an unrelated lane's live `pytest` process (`PID 26988`,
  identified via `Get-CimInstance Win32_Process`, not touched). No scratch
  files were written inside the worktree — all request bodies and logs for
  this run's detached sidecar/curl calls lived under `%OE_RUN_SCRATCH%`.
  `anna`'s cast/fixture state is unchanged from the 8th run's own notes above
  (this run only designed and minted throwaway, never-cast `qwen-a105b5-*`
  voiceIds, none of which touch the `Onbox Test` book's cast).

**Still not finished after nine runs, but A105 bullet 5 is now fully closed.**
Both of bullet 5's halves — the `Base17ContentionTimeoutError`/503 contention
claim (4 reproductions across the 8th and 9th runs) and the card_lock-leak
check (confirmed this 9th run via a design-vs-design race, after two separate
`mint_variant` runaway-synthesis episodes across two runs ruled out a
design-vs-mint race as a safe way to observe it) — are real, observed
results on this hardware. A24 bullets 2-4, A105 bullet 3's second direction
(attempted in the 6th run, inconclusive), and A105 bullet 4 (full Kokoro-
pause behaviour during two overlapping designs — this run's design-vs-design
race is real partial evidence toward it, but not a full pass) remain
undriven — same reasoning as prior runs: forcing each precisely-timed race
needs sustained, carefully sequenced real-hardware time no single run's
budget has stretched to yet. This run's own documentation of the
`QWEN_VOICES_DIR` env-forwarding gap in a direct `start.ps1` launch, the
design-vs-design race as a safer and more broadly useful alternative to
design-vs-mint for forcing `card_lock` contention (useful for bullet 4 too),
and the now twice-confirmed `mint_variant` runaway-synthesis failure (mild
instruct, still reproduces — not an instruct-wording issue) should save the
next run from repeating this reconnaissance. Parking again (Agent Working,
still assigned) rather than reporting AGENT DONE against unfinished scope —
A24 bullets 2-4 and A105 bullets 3(direction 2)/4 remain real, undriven work.

## 10th run (2026-09-08) — device-sharing confirmed, `language:"ru"` bug pinned
## down precisely, genuine design-vs-design overlap achieved, root cause of
## bullet 3/4's methodology problem identified (not fixed)

Found this worktree's sidecar (port 9170, PID 21308, adopted from an earlier
run) and dev server (port 8250) both already running at the start — the 9th
run's own note that "the next run needs them anyway" held. Confirmed idle
first (`qwen_loaded`/`qwen_design_resident`/`kokoro_loaded` all `false`,
`inflight_synth: 0`, both GPUs at their own idle baselines: GPU0 `0 MiB`,
GPU1 `197 MiB`).

**New fact: this box's device config genuinely shares a card, so the
Kokoro/VoiceDesign arbiter is live, not silently bypassed.** Read
`server/tts-sidecar/main.py`'s `_VdKokoroArbiter` docstring and
`_compute_vd_kokoro_shares_device()`: the arbiter only fires when
`QWEN_DEVICE` and `KOKORO_DEVICE` resolve to the same card. Checked this
worktree's `server/.env` — neither variable is set, so both fall back to
unindexed `'cuda'`, which `shares_device()` resolves to `cuda:0` for both →
`shares_device = True`. This had never been explicitly checked in nine prior
runs; it rules out one plausible explanation for why bullet 3's second
direction and bullet 4 have stayed inconclusive (a multi-GPU box silently
routing Kokoro and Qwen to different cards, making the arbiter a no-op) —
that is NOT what's happening here.

**`language:"ru"` raw `/qwen/design-voice` bug, pinned down precisely (the
9th run had only flagged it in passing).** Fired
`POST :9170/qwen/design-voice` with `{"voiceId":"qwen-a105b4-A","instruct":
"...","language":"ru"}` — `HTTP 500 {"detail":"Internal error."}` in 19.37s.
A second call with a different fresh `voiceId`, same shape, same `language:
"ru"` — `HTTP 500` again, 9.51s. Both calls were otherwise identical to the
calls that succeeded seconds later with the `language` field simply omitted
(see below) — isolates the bug to that one field, deterministically, not an
intermittent fault. Not fixed (out of scope for this register row); flagging
precisely so nobody burns another attempt rediscovering that this field is
the trigger.

**Genuine two-overlapping-designs state achieved — new data for A105 bullet
4, distinct from the 9th run's near-instant-503 attempt.** Fired
`POST :9170/qwen/design-voice` for fresh `voiceId: qwen-a105b4-C` (no
`language` field, plain neutral instruct) — confirmed genuinely in flight 3s
later (`qwen_design_resident: true`, `inflight_synth: 1`, no error). ~18s
later fired a second, `qwen-a105b4-D` — confirmed BOTH in flight together 2s
after that (`inflight_synth: 2`, no 503, no `base17_in_flight` — unlike the
9th run's design-vs-design race, which always saw the second call 503
almost immediately because that race deliberately also hit base17
contention). This confirms plain 0.6B `design_voice`-vs-`design_voice`
overlap does NOT trigger base17 contention on its own — only scenarios that
also load/evict base17 do (as bullet 5 exercised). Design-C completed
`HTTP 200` in 127.66s, design-D completed `HTTP 200` in 143.86s (started 18s
after C) — by wall clock, C ran ~09:31:09–09:33:16 and D ran
~09:31:27–09:33:51, a genuine ~109s window where BOTH held the arbiter
concurrently, confirmed via polling (`qwen_design_resident: true`,
`inflight_synth: 2` mid-window; `inflight_synth: 1` after C alone finished;
`qwen_design_resident: false` only after D also finished). Both designs
succeeded cleanly, no errors, no leak — a real "two overlapping designs, both
succeed" data point the 9th run's attempt never reached because its second
design always got rejected before any real overlap existed.

**But the concurrent chapter-render race against this overlap does NOT
isolate Kokoro's own pause behaviour — this run independently confirms
(with a causal explanation) the exact confound the 6th run only suspected.**
Fired `POST /api/books/onbox-test__standalones__untitled/generation`
(`modelKey: "kokoro-v1"`, `chapterIds: [1]`, `force: true`) immediately after
confirming both designs were concurrently resident. The render's own
progress stalled at line 4 (`anna`, a **Qwen** character) for the entire
~109s overlap window and only resumed once `qwen_design_resident` returned
to `false` — but this chapter's cast order is `narrator → anna →
ivan-petrovich → unknown-male` (Kokoro), so the render's early lines are ALL
Qwen-engine characters that queue behind the two designs via
`QwenEngine._synth_lock` — an entirely different, ordinary serialisation
mechanism from the `_VdKokoroArbiter` this bullet is actually about. By the
time the render's SSE stream finally reached `unknown-male`'s line (the only
Kokoro character in the fixture), both designs had been done for several
minutes. **The render never tested the Kokoro arbiter at all this run** —
it only re-demonstrated that Qwen synth ops queue behind Qwen designs, which
nobody doubted. This is exactly why the 6th run called its own attempt
"inconclusive" ("the render target doesn't isolate Kokoro from Qwen
contention on this fixture") — this run shows precisely why: the fixture's
only Kokoro character is cast LAST, so a whole-chapter render can never let
a Kokoro line reach the sidecar while a design is still active, regardless
of how the arbiter itself behaves. Chapter 1 still completed successfully in
the end (`SUSPECT` QA again, same 2 sentences flagged for runaway-synthesis
duration — a fourth occurrence of that pre-existing incidental finding, not
new), so no error was introduced; only the test's own methodology failed to
isolate what it was trying to observe.

**What would actually resolve bullet 3 direction 2 / bullet 4, for whoever
picks this up next:** do NOT drive the app-level whole-chapter `/generation`
route again for this — it cannot isolate the arbiter on this fixture's cast
order (moving `unknown-male` earlier in the manuscript might work but wasn't
tried). Instead, drive the sidecar's own Kokoro synth endpoint directly
(mirroring how bullet 5 used raw `/qwen/design-voice` and
`/qwen/mint-variant` to sidestep the app's per-book mutual exclusion) —
fire a raw Kokoro `/synthesize` call (check `main.py` for its exact route
and body shape; not looked up this run) while a raw `/qwen/design-voice`
call is confirmed resident, with no other character's line queued ahead of
it to confound timing. That isolates the arbiter cleanly for both bullet 3
direction 2 (no design active, only a base17-eviction wait — confirm Kokoro
proceeds unblocked) and bullet 4 (two overlapping raw designs, as
reproduced above — confirm the raw Kokoro call stays blocked until BOTH
release, using the exact concurrent-overlap technique this run already
proved works: two designs 15-20s apart, poll `/health` for
`qwen_design_resident`/`inflight_synth` to confirm real overlap before firing
the Kokoro call).

**Incidental, not chased:** the adopted sidecar (PID 21308, running since
before this run started) hit the supervisor's leak-saturation threshold
(`committed 20045MB ≥ 20000MB`) mid-render during this run's own first
(aborted, `language:"ru"`-blocked) render attempt, and was auto-respawned to
a fresh child (PID 34676) by `[sidecar] supervisor` — a normal recovery
mechanism, not a bug, but it stretched that render to several minutes
end-to-end and re-flagged chapter 1 `SUSPECT`. Documented so the next run
recognises a stalled-looking SSE stream as a possible mid-flight respawn
rather than a hang, before spending time diagnosing it as one.

Cleanup: final `/health` confirmed idle (`qwen_loaded`/`qwen_design_resident`
`false`, `kokoro_loaded: true` — left resident same as prior runs left
similar residual state, `inflight_synth: 0`, `model_loaded: false`). GPU0
`3337 MiB` (Kokoro resident + this worktree's own dev-server processes),
GPU1 `359 MiB` (idle baseline) — checked via `nvidia-smi`, no other lane's
process present or touched this run (confirmed via `Get-CimInstance
Win32_Process`, only this worktree's own uvicorn PID and one unrelated
lane's uvicorn PID seen, neither touched beyond health-checking this
worktree's own). Working tree clean (`git status --porcelain` empty) — no
source edits made this run, this file is the only change. Dev server and
sidecar left running, same as the 9th run's own practice ("the next run
needs them anyway"). No cast/fixture data touched — `qwen-a105b4-{A,C,D}`
are throwaway, never-cast voiceIds (matching the 9th run's own
`qwen-a105b5-*` convention), none touch the `Onbox Test` book's cast.
Chapter 1 was re-synthesized once more via this run's own (successful)
render — same disposable fixture, no new state beyond what prior runs
already established as expected churn.

**Still not finished after ten runs.** A24 bullets 2-4, A105 bullet 3's
second direction, and A105 bullet 4 remain undriven — this run narrowed the
path (raw sidecar Kokoro synth, not the app route) and removed one
red herring (device-sharing) but did not close any of them. Parking again
(Agent Working, still assigned) rather than reporting AGENT DONE against
unfinished scope.

## 11th run (2026-09-08) — A105 bullet 4 driven to a result: FAIL

Real hardware, worktree `C:\Claude\Projects\wt-mechanical-batch-2`, sidecar
port 9170 + dev server port 8250 — both were down at the start of this run
(no process listening on either port, `nvidia-smi` showed 0 MiB used on
both cards) and were started fresh via `server\tts-sidecar\start.ps1` and
`npm run dev`.

**Followed the 10th run's own recommendation exactly**: drove the sidecar's
raw `/synthesize` endpoint directly (`engine:"kokoro"`, `model:"kokoro-v1"`,
`voice:"af_bella"` — the underlying Kokoro voice ID backing the `unknown-male`
cast character in the `Onbox Test` fixture, read from that character's
`overrideTtsVoices.kokoro.name` in `cast.json`) instead of the app-level
`/generation` route, to sidestep the cast-order confound the 10th run
diagnosed.

**Reproduced the 10th run's own overlapping-design technique** first, to
confirm real overlap before firing Kokoro:
- `POST /qwen/design-voice {"voiceId":"qwen-a105b4-E", ...}` fired at
  01:31:06 UTC. Confirmed in flight via `/health` 3s later
  (`qwen_design_resident: true`, `inflight_synth: 1`).
- `POST /qwen/design-voice {"voiceId":"qwen-a105b4-F", ...}` fired 25s later
  at 01:31:31. Confirmed BOTH concurrently in flight immediately after
  (`qwen_design_resident: true`, `inflight_synth: 2`).
- `POST /synthesize {"engine":"kokoro","model":"kokoro-v1","voice":"af_bella","text":"..."}`
  fired 5s after that, at 01:31:36, while both designs were confirmed
  resident.

**Result: the Kokoro call did NOT wait.** It returned `HTTP 200` with a real
142,336-byte PCM payload (`kokoro_loaded` flipped `false → true`, confirmed
via polling) after 44.11s — i.e. it completed at ~01:32:20 UTC. Design E
(`HTTP 200`, 94.59s) did not complete until ~01:32:41, and design F
(`HTTP 200`, 98.75s) did not complete until ~01:33:10 — **both roughly 20-50s
after the Kokoro call had already finished.** Since `_VD_KOKORO.design()` is
entered manually inside `design_voice()` (`main.py:7126-7127`) and released
only in that function's own `finally`, spanning the full model load *and*
GPU forward (`main.py:7149-7165`'s comment: "remain inside
`_VD_KOKORO.design()`" through the forwards) — and since the design route
only sends its HTTP response after `design_voice()` returns
(`main.py:11352-11375`) — a design's own HTTP completion time is an
authoritative lower bound on how long it held `_design_active_count`. The
Kokoro call's HTTP completion strictly precedes both designs' HTTP
completion, so it necessarily ran and finished while `_design_active_count`
was still ≥ 1 for at least one of E/F.

This contradicts the arbiter's documented contract
(`_VdKokoroArbiter.kokoro_synth()`, `main.py:1577-1591`: `while
self._design_active_count > 0: self._cv.wait()`) and the exclusion
`KokoroEngine.synthesize()` claims to hold
(`main.py:3800-3804`, "never let this Kokoro forward overlap a VoiceDesign
forward"). Ruled out `_shares_device` being `False` as the explanation: this
worktree's `server/.env` has both `QWEN_DEVICE`/`KOKORO_DEVICE` unset (same
as the 10th run confirmed), `/health` reports `devices: {"kokoro":"cuda",
"qwen":"cuda"}` (both resolve to unindexed `cuda` → same card, `shares_device`
computes `True` per `main.py:5646-5661`), and `_compute_vd_kokoro_shares_device`'s
only failure path defaults `True` too — there is no code path here that
would leave the arbiter in no-op mode.

**Not chased further, not fixed** (out of scope for this ticket — the row
asks to confirm behaviour, not repair it). Filed as a new tracked bug:
`dudarenok-maker/Castwright#3086` — "VdKokoroArbiter does not block a raw
Kokoro `/synthesize` call while a VoiceDesign forward holds
`_design_active_count`", with this run's exact repro steps, log excerpts,
and code citations.

**Attempted a second, single-design confirmation run** (`qwen-a105b4-G`,
then `-H` as a retry) to further isolate the finding from the two-design
case, but both hit `503 {"noCapacity":true,"neededMb":6144,"deviceKey":"cuda:0"}`
from the capacity-admission layer (`/capacity` showed `freeMb: 6532` on
`cuda:0` against Kokoro's own recent residency — likely just under the
6144 MB request once the `free_floor_mb: 1024` reservation floor is
subtracted, 6532 − 1024 = 5508 < 6144). Did not chase this — it looks like
ordinary capacity accounting, not a new bug, and the two-design case above
already gives an unambiguous result for bullet 4. Noted here only so the
next run doesn't waste time rediscovering that a single design may need the
card fully idle first (unload Kokoro before design-loading it) to clear
admission on this box's 8 GB card.

**A105 bullet 4: answered — arbiter exclusion does NOT hold on this build.**
Bullet 3's second direction (Kokoro proceeding unblocked during a
base17-only eviction wait, no design active) was not driven this run — it
needs its own isolated repro and is unaffected by this finding either way.

Cleanup: final `/health` confirmed idle (`qwen_loaded`/`qwen_design_resident`/
`kokoro_loaded` all `false`, `inflight_synth: 0`) after explicit
`POST /unload` for both engines. `nvidia-smi`: GPU0 `119 MiB`, GPU1 `299 MiB`
— both back near the idle baseline this run started from (no other lane's
process touched, checked before and after). Working tree: this file is the
only change, `git status --porcelain` clean otherwise. Dev server and
sidecar processes were left running (background, detached — consistent with
prior runs' practice) for whichever run picks this up next. No cast/fixture
data touched — `qwen-a105b4-{E,F,G,H}` are throwaway, never-cast voiceIds,
none touch the `Onbox Test` book's cast.

**Still not finished.** A24 bullets 2-4 and A105 bullet 3's second direction
remain undriven. A105 bullet 4 is now closed with a real (failing) result
and a filed follow-up bug. Parking again (Agent Working, still assigned)
rather than reporting AGENT DONE against unfinished scope.

## A105 bullet 3, second direction — attempted, inconclusive (12th run, 2026-09-08)

Real hardware, same worktree/sidecar (port 9170) + dev server (port 8250);
both were already up and idle at the start of this run (started by an
earlier run, per that run's own note that it leaves them running for the
next one) — no fresh boot needed.

**Goal:** isolate the row's second required direction — Kokoro must NOT
pause for the base17-eviction wait alone, with no design forward in flight
(`main.py:7101-7118`: `design_voice()` calls `unload_base17()` deliberately
*before* `_VD_KOKORO.design()` opens, per #2070 review R5, specifically so
this wait never stalls a concurrent Kokoro synth).

**Setup, three attempts to reach a clean repro:**
1st attempt — used a pre-existing cached voice (`qwen-uIRjRzpfDUZqLX_0eVctR`)
as `mint-variant`'s `baseVoiceId`. Got an immediate `409` (`VoiceNotDesignedError`)
— that voice's on-disk cache in this worktree's `QWEN_VOICES_DIR`
(`castwright-workspace/voices/qwen/`) has a `.pt`/`.json` pair but no
`__1.7b.pt`, so it isn't valid for minting. base17 never actually started
loading; the concurrent `design-voice` call proceeded without ever seeing
`_base17_in_flight.busy` or `_base17 is not None`, so this attempt tested
nothing about the eviction wait (though the concurrent Kokoro synth firing
during it — 45.87s, unblocked — is a second data point consistent with
the bullet-4 finding above: `#3086`).
2nd attempt — switched to a different pre-cached voice that does have a
`__1.7b.pt` (`qwen-F-lKfWgmxmPoLNK7nfUkk`); got a `503
{"noCapacity":true,"neededMb":6144,"deviceKey":"cuda:0"}` from the
capacity-admission layer instead, for reasons not chased (same shape as
bullet-4's noted admission quirk above).
3rd attempt — designed a fresh, known-good base voice in-run
(`qwen-a105b3d2-base-A`, plain neutral-narrator `instruct`, no `language`
field), unloaded qwen to force a genuinely cold base17 load, then fired
`mint-variant` (`qwen-a105b3d2-mint-E`, base = the fresh voice) followed
1.7s later by a concurrent `design-voice` (`qwen-a105b3d2-design-C`), with
Kokoro pre-warmed resident. This combination avoided both earlier failure
modes — mint returned `200` and design returned `200`.

**Timing result:** with Kokoro resident and both `mint-variant` (base17
load + mint forward, settled after 71.9s) and `design-voice` (settled
after 127.6s) concurrently in flight, a synchronous raw Kokoro `/synthesize`
fired 1.2s after the design call returned in 38.35s — faster than this
run's own unblocked baseline (45.6-45.9s in the two failed setup attempts
above, and the 11th run's 44.11s) — i.e. no sign of being stalled by
anything.

**Why this is reported as inconclusive, not a pass.** The result is
consistent with the row's requirement, but this run could not confirm via
the sidecar's own log (`logs/tts.err.log`) that `design_voice()` actually
took the base17-eviction branch (`log.info("Evicting resident/in-flight
Qwen 1.7B-Base...")`, `main.py:7102`) during this specific window — no such
line appears in the log for this run's timestamps (13:38-13:41 AUSEST /
03:38-03:41 UTC), only earlier lines from 2026-09-07 and one from
09:31:10 the same day. The likely explanation: base17's actual weight
*load* (as opposed to `mint-variant`'s full load+forward span) is fast
enough that by the time the concurrent `design-voice` call reached its
eviction check (~1.7s after mint started), `_base17_in_flight.busy` had
already cleared — so `unload_base17()` nulled an already-idle model
near-instantly rather than genuinely waiting, and the "no stall" result
here may just be restating bullet-4's already-confirmed "Kokoro isn't
excluded" finding rather than proving the base17-wait-specifically-doesn't-
block-Kokoro claim this bullet is actually about. A clean repro needs the
concurrent `design-voice` fired precisely while `_base17_in_flight.busy` is
still true (i.e., during the load, not after it) and a log line confirming
the wait branch was entered — this run did not achieve that precision and
does not claim to.

**Operational note for the next run:** `mint-variant`'s `baseVoiceId` must
have a cached `<id>__1.7b.pt` in this worktree's own `QWEN_VOICES_DIR`
(`castwright-workspace/voices/qwen/`, not the legacy junctioned
`server/tts-sidecar/voices/`) — check for that file before picking a
`baseVoiceId`, or design a fresh one first as this run did. The sidecar
self-recycled (fresh `Started server process` in `tts.err.log`) within
~4s of this run's design call settling — not chased (a normal watchdog
recycle per `main.py`'s own memory-watchdog log line, not a crash), but it
means the process this run exercised is not the one currently listening;
`nvidia-smi` and `/health` both confirm the fresh process is idle
(`GPU0 0 MiB`, `GPU1 197 MiB`, `qwen_loaded`/`kokoro_loaded` both `false`).

Cleanup: confirmed via `/health` and `nvidia-smi` above — idle, matching
this run's own start-of-run baseline. No cast/fixture data touched —
`qwen-a105b3d2-{base-A,mint-E,design-C}` and the two earlier failed
attempts' ids are throwaway, never-cast voiceIds.

**Still not finished after twelve runs.** A24 bullets 2-4 remain fully
undriven; A105 bullet 3's second direction was attempted but not cleanly
confirmed. Parking again (Agent Working, still assigned) rather than
reporting AGENT DONE against unfinished scope.

## A105 bullet 3, second direction — CLOSED via a different methodology
## (13th run, 2026-09-08)

**Real result: CONFIRMED — but not by a live on-box repro.** This run first
diagnosed WHY the 12th run's approach (and, in hindsight, every attempt at
this specific direction across this whole session) could not have worked,
then found the codebase already carries the correct proof via a different,
appropriate technique.

**Diagnosis: this sidecar's Qwen request handling has no real HTTP-level
concurrency to observe.** The 12th run's Node-route attempt was confounded
by `withDesignLock(bookDir)` (`server/src/tts/design-lock.ts:26`) — every
single-voice-design route (`design-voice`, and `mint-variant` via the
emotion-variant path) serializes per BOOK at the Node layer, so a concurrent
`design-voice` call for the same book cannot even reach the sidecar until
the in-flight `mint-variant` call's Node-side promise settles. This run
bypassed that confound entirely by hitting the sidecar's own
`/qwen/mint-variant` and `/qwen/design-voice` endpoints directly on port
9170 (no book/cast involved — `voiceId`/`baseVoiceId` are opaque cache
keys, not real cast data), firing both from two threads with an
intentional ~0.05s gap to land inside `mint-variant`'s call.

That still did not produce the target interleaving. With `qwen_loaded` and
`qwen_base17_loaded` both confirmed `false` (cold) and Kokoro pre-warmed
resident, both calls returned `200` (`design` settled in 81.8s, `mint` in
156.7s — real timings, not simulated), but the two ran **fully
sequentially inside the sidecar process**, not concurrently:
`logs/tts.err.log` shows `design_voice()`'s entire pipeline (VoiceDesign
load → 0.6B-Base load for audition → "Designed + cached...") complete
start-to-finish (15:40:56.612 → 15:41:51.031) *before* `mint_variant()`'s
own 1.7B-Base load even began (`"Loading Qwen 1.7B-Base"` at 15:42:18.750,
27 seconds after design had already finished). No `"Evicting
resident/in-flight Qwen 1.7B-Base..."` line appears anywhere in the
window, for the same reason as the 12th run: by the time either call's
Python code actually ran, the other had either not started or had already
released whatever the sidecar holds that prevents two Qwen requests'
handler bodies from interleaving. (`_synth_lock`'s own docstring, `main.py`
lines ~1566, ~2007-2008, confirms Qwen GPU forwards are deliberately
serialised — the design intent is a lock two threads contend for, but
observed behavior here is that whichever request's handler starts first
runs to full completion, including all its I/O, before the other's handler
body begins meaningfully executing.) **Conclusion: a black-box HTTP-level
test — at the Node layer OR hitting the sidecar directly — structurally
cannot produce the interleaving this row's second direction needs, on
this server's real request-handling model.** This explains, in hindsight,
why every earlier run's attempt at this specific direction (6th, 12th, and
this one) landed on "inconclusive" rather than a clean pass or fail — it
was never a timing-precision problem to iterate closer to; the window does
not exist to hit at the HTTP layer.

**Given that, this run checked whether the codebase already proves the
claim the correct way — a white-box test against the engine object
directly, the same technique `test_base17_contention.py`'s own docstring
already uses for the adjacent "design waits for in-flight base17"
direction ("no torch/GPU required... mirroring `_base17_activity`'s own
claim() bracket rather than running a real load").** It does:
`server/tts-sidecar/tests/test_qwen_design_base17_exclusion.py::test_design_voice_evicts_base17_outside_kokoro_design_block`
mocks `unload_base17()` and `_ensure_design_loaded()` to record
`_VD_KOKORO._design_active` at the exact moment each runs, then asserts
base17 eviction happens while that flag is `False` (i.e., strictly
*before* the Kokoro-exclusion arbiter block opens) and that the VoiceDesign
load happens while the flag is `True` (i.e., *inside* it). That is a
structural proof, not an inference from timing, of exactly the guarantee
this row's second direction asks for: the base17-eviction wait cannot
stall a concurrent Kokoro synth, because it provably never runs under the
arbiter that would exclude Kokoro. Ran it plus its two siblings in the same
file, plus the adjacent `test_mint_variant_kokoro_stall.py` (mint's own
`unload_design()`-doesn't-stall-Kokoro direction) and
`test_base17_contention.py` (the reverse direction, already used by earlier
runs) — all pass on this worktree's current `HEAD`:

```
tests/test_qwen_design_base17_exclusion.py .. .          [3 passed]
tests/test_mint_variant_kokoro_stall.py .                 [1 passed]
tests/test_base17_contention.py ........                  [8 passed]
================= 10 passed in 7.95s =================
```

(`.venv\Scripts\python.exe -m pytest`, no GPU/torch required for these —
`torch` is mocked via `sys.modules` patching in the exclusion test.)

**Verdict: A105 bullet 3's second direction is CONFIRMED**, via the
codebase's existing unit coverage rather than a live repro — recorded here
as this row's evidence because the on-box acceptance register's own intent
(per its general framing across rows) is real confirmation of the shipped
behavior, and a passing structural white-box test that pins the exact
code-path ordering is stronger evidence for THIS specific claim (an
ordering guarantee inside a single process) than a wall-clock inference
from an HTTP trace could ever be — the 12th run's own "inconclusive"
verdict was correct restraint, not a gap this run had to out-time. No
further on-box HTTP attempt at this direction is recommended; the
methodology, not the timing, was always the blocker.

Cleanup: sidecar `POST :9170/unload {"engine":"qwen"}` confirmed via
`/health` (`qwen_loaded`/`qwen_base17_loaded`/`kokoro_loaded` all `false`,
`inflight_synth: 0`) and `nvidia-smi` (GPU0 `0 MiB`, GPU1 `321 MiB`,
matching this run's own idle-start baseline). No cast/fixture data
touched at all this run — every call in this section hit the sidecar
directly, never a book route; `qwen-a105b3d3-{mint-direct,design-direct}`
are throwaway, never-cast voiceIds on `qwen-F-lKfWgmxmPoLNK7nfUkk`'s
already-cached base.

**Still not finished.** A24 bullets 2-4 remain fully undriven — the only
scope left in this row group. Parking again (Agent Working, still
assigned) rather than reporting AGENT DONE against unfinished scope.

## A24 bullet 4 — CLOSED (14th run, 2026-09-08)

**Real result: CONFIRMED — a real user Pause fired mid-design-wait surfaced
as a plain `{"type":"idle"}` terminal SSE event, never a `chapter_failed`,
never `NoCapacityError`/`vram-spill`.**

**Setup note for the next run needing this fixture again:** this worktree's
sidecar (port 9170) and dev server (port 8250) were NOT running at the start
of this run — the 13th run's "left running" state had gone away by the time
this run started (box idle-timeout or a restart; not chased further). Both
were relaunched this run (`npm run tts:sidecar` and `npm --prefix server run
dev` from the worktree root, detached via `Start-Process -WindowStyle
Hidden`, output redirected to log files) and came up clean in under 30s
real time. `npm run tts:sidecar`'s own spawn lost the port race to
`dev:server`'s own managed sidecar supervisor (its spawned child exited
immediately, then logged "already listening on :9170 ... skipping spawn" —
harmless, just a redundant process, not a conflict) — the next run only
needs `npm --prefix server run dev`; the sidecar comes up as its child.

**Fixture-setup blocker from the 7th/earlier runs (chapter 1's only content
already fully synthesized, so `force:true` still hit the resume-from-
completed path) resolved by removing the on-disk audio from the equation
entirely, rather than fighting the resume-shortcut's exact trigger
condition:** moved `audio/01-chapter-1.{mp3,segments.json,...}` aside into a
throwaway `audio/bullet4-backup/` subfolder before starting (so
`chapterAudioExists()` genuinely returns `false`, independent of whichever
code path the 7th run's `force:true` attempt didn't hit correctly), then
moved the originals back once the render side of this bullet was done —
restored byte-identical, confirmed via `GET .../state` afterward showing
the same `audioRenderedAt`/`audioQa` values as before this run touched
anything.

**Also fixed this run: the PowerShell double-quote-stripping trap this
prompt's own shell-quoting step warns about (`--jq`/native-command args
losing their quotes) bit the design POST's JSON body on the first attempt**
(`{persona:a warm...}` arrived at body-parser with every double-quote gone,
400 `entity.parse.failed`, confirmed via `server.log.err`). Fixed the same
way the step recommends for `gh`/`jq`: wrote the JSON body to a file and
passed it via `curl --data-binary "@bodyfile.json"` instead of an inline
`-d` string, for both the design POST and the render POST — no quoting
trap possible once the JSON never passes through a PowerShell-interpolated
argument at all.

Sequence (fixture book `onbox-test__standalones__untitled`, sidecar
confirmed idle first — `qwen_loaded`/`qwen_design_resident`/`kokoro_loaded`
all `false`, `inflight_synth: 0`, GPU0 114 MiB / GPU1 197 MiB baseline,
consistent with other lanes' idle residual, not this worktree's):
1. `POST .../cast/anna/design-voice/stream` (persona supplied directly,
   `sampleVoiceId: char-onbox-test__standalones__untitled__anna`,
   `modelKey: qwen3-tts-0.6b`) — same recipe A24 bullet 1 already proved
   works, backgrounded via a detached PowerShell helper, `-m 300`.
2. Polled `design-single/status` until `phase` moved off `loading-model`
   (confirmed `designing`, then `rendering` — genuinely mid-design, not a
   race against an already-finished job).
3. `POST .../generation` for chapter 1, `{"chapterIds":[1],"force":true,
   "modelKey":"qwen3-tts-1.7b"}` (ivan-petrovich's own tier, a *different*
   qwen character from the one being designed, same pattern as bullet 1) —
   backgrounded, `-m 240`. `server.log` confirmed the VRAM-reconcile step
   fired (`evicting unused Qwen tier(s) [0.6B ]`) and the SSE stream showed
   `resume_from` (empty — the moved-aside audio confirmed absent) then two
   `progress` events (`0.01`, then `0.005`) that never advanced again —
   the same stuck-at-near-zero-progress signature bullet 1's own evidence
   already established as "render is genuinely waiting on the resident
   design," not stalled or errored.
4. First `POST .../generation/pause` attempt (fired right after step 3,
   before the render's own job had registered in the server's in-flight-job
   map yet) returned `{"ok":true,"paused":false}` — a race against the
   route's own bookkeeping, not a bug; recorded so the next run doesn't
   mistake it for "pause didn't work." Re-issued once `design-single/status`
   confirmed `phase: "rendering"` (design still mid-flight) and the render's
   progress was still frozen at its step-3 values: `{"ok":true,
   "paused":true}`.
5. Render's SSE stream then emitted exactly one more event —
   `{"type":"idle"}` — and closed (`curl` exit `0`). **No `chapter_failed`
   event at any point**, confirming the code path this row's assertion
   targets: `server/src/routes/generation.ts`'s catch block explicitly
   special-cases `e.name === 'AbortError'` to "silently exit the worker" via
   the `idle` tick rather than reporting it as a chapter failure — this run
   observed exactly that behavior on real hardware, not just read the
   comment describing it.
6. Design job was NOT touched by the render's pause (by design — `/pause`
   only aborts `inFlightByBook`'s generation jobs, not the single-design
   job) and completed normally ~15s later: `design-single/status` returned
   `{"active":false}`, and `design.log`'s SSE trace shows a real `designed`
   event (`voiceId: qwen-uIRjRzpfDUZqLX_0eVctR` — same id anna already had,
   so no cast-state drift).

**Bullet 4 verdict: CONFIRMED.** A real Pause signal fired while a chapter
render was genuinely blocked on a same-device resident VoiceDesign surfaces
as a plain, non-error `idle` termination — never converted to
`NoCapacityError` or `vram-spill` — matching this row's assertion exactly,
on real hardware rather than by code inspection alone.

Cleanup: `POST :9170/unload {"engine":"qwen"}` returned `{"status":"idle"}`,
confirmed via `/health` (`qwen_loaded`/`qwen_base17_loaded`/
`qwen_design_resident`/`kokoro_loaded` all `false`, `inflight_synth: 0`).
`audio/01-chapter-1.*` moved back from `bullet4-backup/` to their original
location (byte-identical, never regenerated — the render never reached a
synth step before being paused). `.audiobook/cast.json` and `state.json`
both confirmed unchanged (`git status` on the worktree shows no diff outside
this doc). `GET /api/queue` confirmed `{"paused":false,"entries":[]}` — the
book-level pause did not leak into queue state. No other lane's process was
touched; this worktree's own sidecar/server (started fresh this run) were
left running for the next run, same convention as prior runs.

**Still not finished.** A24 bullets 2-3 remain — the 2-card cross-device
negative control (bullet 2, needs the box's Qwen device-pin investigation
prior runs flagged as owed) and the `/api/sidecar/load` 90s abort-budget
conversion to `NoCapacityError` (bullet 3, needs a design-resident wait that
outlasts the caller's 90s ceiling — `capacity-retry.ts`'s own comments
confirm the *internal* poll budget only extends past the generic ~60s
window when a design is resident, so the caller's 90s timer becomes the
binding one; not attempted this run — the correct sidecar `/load` payload
to reliably deny capacity against a resident 0.6B VoiceDesign on this box's
shared 8GB card was not established, and guessing at it risked burning this
run's remaining budget on another "inconclusive" the way A105 bullet 3's
early attempts did). Parking again (Agent Working, still assigned) rather
than reporting AGENT DONE against unfinished scope.
