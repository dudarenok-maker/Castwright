# Mechanical batch 1 — step 2: A6 (bulk voice-design recycle resilience) + A7 (Design full cast acceptance)

Run 2026-09-06, worktree `C:\Claude\Projects\wt-onbox-mechanical-batch1`, branch
`docs/docs-onbox-mechanical-batch1`, server started via `start-prod.bat`'s own
launcher (`node scripts/start-app-prod.mjs`, `NODE_ENV=production`) so `server/.env`
ceilings are actually in effect — confirmed live via the sidecar's own `/health`:
`mem_restart_mb=47582.76` (≈ the configured 48500 MB ceiling), not the ~14 GB
auto-computed default a dev-mode-spawned sidecar would report. Ran with
`LAN_HTTPS=0` (plain `http://localhost:8220`) rather than the LAN-HTTPS default,
to avoid a self-signed-cert dependency in the browser session and to keep this
worktree's own per-process port (`8220`, `server/.env`) rather than the shared
default LAN port `8443` another worktree's prod launch could collide on.

Book under test: the built-in sample book "The Coalfall Commission"
(`castwright__standalones__the-coalfall-commission`), 14 characters, reused from
step 1. To exercise a genuine **multi-voice bulk run** (this book had only 1
undesigned character left over from step 1's testing), 12 of its 14 characters'
existing Qwen designs were reset to "Needs voice" (`overrideTtsVoices.qwen` /
`voiceUuid` / `voiceState` stripped from `cast.json`, original backed up to
`cast.json.oe-backup` in the same `.audiobook` dir) — this is this worktree's own
`WORKSPACE_DIR` test data, not real book data, per the standing rule.

For A7's series-propagation bullet specifically, this book was converted from a
standalone into book 1 of a new 2-book series (`state.json`: `isStandalone: false`,
`series: "Coalfall Saga"`) and a sibling book, "The Coalfall Commission II", was
created under the same author/series with two characters sharing bare ids with
book 1 (`wren`, `sela`), both starting with no voice designed. This exercises the
real propagation code path (`applyOverrideToCastFiles` with a `seriesFilter`,
matched by `voiceId`/character-id across every non-standalone book sharing
(author, series) — confirmed by reading `server/src/routes/voices.ts` and
`server/src/workspace/series-cast-scan.ts` before relying on it) without needing
a second full manuscript analysis.

## A6 — bulk voice-design recycle resilience

**PARTIAL — the forced-recycle ride-out itself passes; the run did not
complete end to end on the first attempt, for a reason this session could not
cleanly isolate.**

Started "Design full cast" (Base voices, 12 needed) at 01:42:32 UTC. At
01:44:38 the first character (Master Oduvan) finished and cached
successfully. While the second character (Coalfall, the dragon) was in
flight, `POST /api/sidecar/restart` was issued directly against the running
prod server — the exact endpoint the row names, confirmed against
`server/src/routes/sidecar-health.ts` before use. Server log:

```
11:45:20.982 [sidecar] supervisor: child exited (code=1 signal=null); respawning in 2000ms (attempt 1/5).
11:45:23.021 [sidecar] spawned pid=2232 (PRELOAD_COQUI=0, PRELOAD_QWEN=sidecar-default, PRELOAD_KOKORO=sidecar-default, modelKey=qwen3-tts-1.7b)
```

For the ~45 s the new sidecar process took to come back up (`/health` on
:9140 refused connections, from 01:45:20 to 01:46:05), the design job's own
status endpoint never flipped out of `"active": true, "state": "running"` —
it held steady on `"currentName": "Coalfall", "done": 1` throughout the
outage, exactly the ride-out behaviour `200-bulk-design-recycle-resilience.md`
describes (retry the same character, don't halt the job). The in-app top-bar
pill and the Cast page's own button mirrored this live the whole time:
"Designing · 8%" / "Cancel design · 1/12" — never an error state, never
"stalled". Once the sidecar answered `/health` again, the job resumed with no
manual intervention and Coalfall itself finished and cached at 01:47:46. **This
part is a clean PASS** of the row's specific ask (force `/recycle`/`/restart`
mid-run, confirm the pill rides through the respawn).

However, at that same moment a second, unrelated action was also in flight
(see A7's 2nd-tab bullet below): a single, non-bulk "Design & preview" request
against a *different* book's character, started deliberately while this bulk
job was mid-run. Some time after Coalfall's own success — with no further
sidecar crash logged and no synthesis-error text logged to `server.log` or
`server.err.log` — the job's status flipped straight from `"done": 1,
"state": "running"` to `{"active": false}`, and the top bar's Design entry
read **"Halted · 2/12 · 17%"** (`castDesignActions.halt`, the "catastrophic
abort" reducer path in `cast-design-slice.ts`, distinct from the normal
`settle`/"done" terminal state). No further characters were attempted. The
concurrent single-design request itself never resolved either — its
"Design & preview" button stayed in a spinning/active state for the rest of
the session with no toast, even after the bulk job had ended and
`inflight_synth` on the sidecar had returned to `0`.

Because two unusual things were happening at once (a just-recovered sidecar,
plus a concurrent cross-book single-design request contending for the same
GPU-fairness path in `server/src/tts/design-lock.ts`), this run cannot cleanly
attribute the halt to one or the other. **To isolate it**, the same 12
characters were reset to "Needs voice" again and "Design full cast" was
re-run *alone* — no concurrent request, no forced restart — as a control (see
the result folded into A7 below, since it is the same run that produced most
of A7's evidence). That control run is the one to read for whether the
underlying job is stable when nothing else touches the sidecar during it.

**The isolation run resolved the ambiguity, and it is bad news, not good news.**
The same 12 characters were reset to "Needs voice" again and "Design full
cast" was re-launched completely *alone* — sidecar left untouched, no second
browser tab, no forced restart — as a clean control. It **halted again, at the
same place**: Master Oduvan designed and cached normally at 11:56:00, Coalfall
designed and cached normally at 11:57:36 (`logs/tts.err.log` shows a totally
clean synthesis: VRAM reserved only 23 MB, no error, no recycle, no capacity
warning), and then the job simply stopped — `GET .../cast/design/status`
flipped straight to `{"active": false}` with nothing logged to `server.log`,
`server.err.log`, `tts.log`, or `tts.err.log` at that moment. `cast.json`
confirms exactly 2 of 12 got designed, identical to the interfered-with run.

**So the halt is not caused by the forced restart, and not caused by the
concurrent single-design request — "Design full cast" halts after exactly 2
characters on this book even with zero interference, twice in a row.** The
next character in queue both times was `wren-sparrow` ("Wren — Sparrow only to
him, and only when he had forgotten to be stern" — the longest and only
em-dash-containing character name in this cast); whether that specific name is
the trigger or it is simply "the third character, whichever it is" was not
disambiguated in this session (would need a re-order or a rename to test).
This is a genuine, reproducible regression in the bulk pipeline itself,
separate from and more severe than anything either row is actually checking
for — filed as an incidental finding per `CLAUDE.md`, not fixed here (out of
this row's scope, and the fix belongs with whoever owns `cast-design.ts`'s
outer error handling).

**Net verdict for A6:** the forced-`/recycle`-mid-run ride-out behaviour the
row specifically asks for is a clean PASS (confirmed twice — once as the thing
that happened to be in flight when the restart landed, effectively for free).
"Design full cast … completes end to end" is a **FAIL** on this book, for a
reason unrelated to recycling.

## A7 — Design full cast acceptance bullets

Five bullets per the row; the halt above (2 of 12 both times) capped how many
could be exercised, since the queue never reached `wren-sparrow` (3rd) or
`sela`/`wren` (4th/12th, the series-shared characters).

### Bullet 1 — pill survives navigation and a reload mid-run (resumes)

**PASS.** While the first run's bulk job was mid-Master-Oduvan, the browser
was navigated away to the Manuscript tab and back, then hard-reloaded via
`location.reload()` (a genuine full page load, not an SPA route change).
After reload, the top bar read "Designing · 0%" (rounding down from a job
barely underway) and the Cast page's own button read "Cancel design · 0/12" —
the client re-subscribed to the live server-side job (`GET
.../cast/design/status` with a bare body, per `195-design-full-cast.md`'s
"re-subscribes to an in-flight one") and picked its state back up correctly,
with no blank/error state at any point during or after the reload.

### Bullet 2 — terminal summary counts (designed/failed/skipped) are correct

**NOT REACHED.** Both runs ended via the halt path (`castDesignActions.halt`),
not the normal `settle` "done" terminal summary the row is asking about — a
halted job shows no designed/failed/skipped toast at all in this codebase (the
toast is built in the `onDone`/`settle` handler in
`cast-design-stream-middleware.ts`, which the halt path never reaches). This
bullet needs a run that reaches a genuine end (bulk-cancel by the user, or a
job that actually finishes all N), which the pipeline bug above prevented.

### Bullet 3 — series propagation reaches a sibling book

**NOT REACHED**, but the harness for it is real and left in place for
whoever re-runs this once the halt bug is fixed. `castwright__standalones__
the-coalfall-commission` is now book 1 of a 2-book series ("Coalfall Saga")
and `castwright__coalfall-saga__the-coalfall-commission-ii` is book 2, sharing
bare character ids `wren` and `sela` with book 1 — confirmed reachable from
the app (the Cast page's own voice-library sidebar showed "16 voices · 2
books" and listed both `The Coalfall Commission II` characters by name
throughout both runs). Both characters sit 4th (`sela`, 9 lines) and 12th/last
(`wren`, 0 lines) in the bulk queue's most-spoken-first order, so neither was
reached before either run halted at position 2. Book 2's `cast.json` still
shows both as undesigned.

### Bullet 4 — VRAM headroom across a long run (the plan-108 OOM combination)

**PASS, as far as the run went.** Sampled the sidecar's own `/health` every 10
s for the full ~19 minutes of both runs combined (92 samples, logged in this
worktree's scratch dir during the session). `committed_mb` ranged 8.4–18.8 GB
against the configured `mem_restart_mb` ceiling of 47.58 GB — comfortable
headroom, no monotonic growth pattern (each design cycle's load/unload showed
the expected sawtooth, not a leak), and `vram_reserved_mb` on the GPU actually
hosting Qwen (`cuda:1`, the RTX 5070 Ti) never exceeded ~5.8 GB reserved even
with both VoiceDesign and Base models resident simultaneously — matching
`200-bulk-design-recycle-resilience.md`'s own note that reserved VRAM "holds
flat at ~5.8 GB" for this workload. No poison/capacity-refusal signal
(`poisoned: false`, `recycle_pending: false`) at any sampled point. Caveat:
"a long run" per the row's own framing means the full 12-character run this
bug prevented — 2 characters' worth of headroom data is real but short of
what plan-108's OOM needed to reproduce (that needed VoiceDesign 1.7B
co-resident with a resident Ollama instance across a much longer session; no
Ollama was resident during this test).

### Bullet 5 — a 2nd-tab single design serialises against the bulk run

**Inconclusive — no race/corruption observed, but the request never resolved.**
While the first run's bulk job was designing Coalfall, a second browser tab
was opened against the *sibling* book (`…-coalfall-saga…-ii`) and its
character "Wren" was sent through the ordinary per-character "Design &
preview" button — a genuinely concurrent, non-bulk request against a
different book, while the bulk job owned the GPU. The sidecar's own
`inflight_synth` counter stayed at `1` the entire time both requests were
logically pending (never `2`), and the UI never showed any garbled-audition
symptom — consistent with the GPU-fairness serialization the row expects.
However, the single-design button stayed in a spinning "active" state for the
rest of the session and never completed, never errored, and `book2`'s
`cast.json` never picked up a voice for Wren — even well after the bulk job
itself halted and `inflight_synth` returned to `0`. Given the bulk pipeline
was independently confirmed to halt on its own on this same book/cast with no
concurrency involved at all (A6 above), the most likely explanation is that
the single-design request was queued behind the bulk job in a way that never
got serviced once the bulk job died mid-queue, rather than a distinct
concurrency bug — but this session could not fully confirm that this specific
request would have completed normally once its turn came, since the browser
tab was closed after the bulk job's second halt made the book1 test the
priority. **Worth a clean re-check**: single design vs. a bulk job that
actually reaches a normal terminal state.

## What this leaves owed

The bulk-design pipeline in this build halts after exactly 2 successfully
designed characters, reproducibly, with no error surfaced to `server.log`,
`server.err.log`, `tts.log`, or `tts.err.log` — this blocks A7 bullets 2, 3
and (fully) 5, and is the reason A6's "completes end to end" clause fails.
This is a regression worth its own bug report/issue rather than a re-run of
this same row, since re-running against the same halt will reproduce the same
partial result. The recycle-survival behaviour A6 specifically asks about, and
A7's reload-mid-run and VRAM-headroom bullets, are confirmed working.

## Cleanup / state left behind

- `cast.json.oe-backup` sits beside `cast.json` in
  `The Coalfall Commission/.audiobook/` — the pre-this-session state (all 14
  characters as step 1 left them) for anyone who wants to restore it.
- `The Coalfall Commission` is now `isStandalone: false`, `series: "Coalfall
  Saga"` (was `Standalones`) — needed to keep for series-propagation
  re-testing; revert `state.json` if a later row needs it back as a
  standalone.
- `The Coalfall Commission II` is a new throwaway book under the same series,
  intentionally left in place for the same reason.
- Current designed count on book 1: 4 of 14 (`narrator`, `maerin` from step 1;
  `master-oduvan` and `coalfall-dragon` redesigned twice across these two
  runs — final on-disk state is the second run's).

