# Sidecar idle-evict hardening — design

**Status:** approved
**Issues:** #1917, #1918, #1920, #1921
**Predecessor:** [2026-07-28-coqui-residency-eviction-design.md](2026-07-28-coqui-residency-eviction-design.md) (#1894, PR #1924)

## 1. Why these four together

All four were filed by the final pre-merge review of #1894, and all four sit on
the same surface: the sidecar's VRAM admission path and the lock discipline the
Coqui/ASR/ECAPA engines use to make eviction safe. Three of them (#1917, #1918,
#1920) edit overlapping regions of `server/tts-sidecar/main.py`; splitting them
into separate branches would produce three-way conflicts in that file for no
review benefit. #1921 is the Node-side half of a behaviour trade #1894 made
deliberately, and is meaningless without the sidecar context.

They ship as one PR. The four fixes are independent in behaviour, so each lands
as its own task with its own tests.

## 2. #1917 — in-flight counters are non-atomic

### The defect

`x += 1` on an attribute compiles to `LOAD_ATTR` / `BINARY_OP` / `STORE_ATTR`,
and CPython can switch threads at any bytecode boundary. Every engine's
in-flight counter is incremented and decremented **outside** the lock that
serialises its forward, so two concurrent forwards can lose a decrement. Because
`maybe_free_idle`'s fast-out predicate is `> 0`, a counter that sticks above zero
**disables that engine's eviction for the remaining process lifetime** — silently,
with no error and no log line.

### The fix

One shared `InFlightCounter` helper: an `int` guarded by its own
`threading.Lock`, exposing a `claim()` context manager and a `busy` property.
The counter lock is only ever held for the few bytecodes of the mutation —
never across a forward — so `maybe_free_idle`'s fast-out stays non-blocking with
respect to the work it is trying to avoid waiting on.

### Scope: five counters, not three

The issue names three (`CoquiEngine._synth_in_flight`,
`WhisperEngine._infer_in_flight`, `SpeakerEngine._infer_in_flight`).
`QwenEngine._design_in_flight` and `QwenEngine._base17_in_flight` have the
identical defect and identical consequence, and the comment above
`_base17_activity` asserts *"inc/dec is GIL-atomic — same rationale as
`_design_in_flight`"*, which is false. Introducing a safe helper while leaving
two counters on the broken pattern — under a comment claiming the broken pattern
is safe — would be worse than not fixing it at all. All five convert; the false
comment is deleted.

### What stays

The `> 0` predicate stays. It is still correct, and it is no longer the only
thing standing between a lost decrement and permanently-disabled eviction.

## 3. #1918 — `_ensure_loaded` publishes without the lock

### The defect

`CoquiEngine._ensure_loaded` writes six fields (`_last_used`, `_tts`, `_torch`,
`_resolved_device`, `_device`, `_use_half`) plus `_speakers` ~35 lines later,
none of it under `_synth_lock`. `unload()` *does* take that lock and resets
exactly those fields — including restoring `self._device = self._requested_device`
(the #1730 gap-3 fix). A Stop pressed during a ~90 s cold load can interleave, and
the still-running loader then overwrites the unload's resets: a live `_tts` with
`_device` pinned to the last admitted card, bypassing placement on the next lazy
load.

#1894 closed the *automatic* variant (an admission-path `maybe_free_idle` now
declines, because the `_last_used` stamp moved ahead of the publish).
`unload()` ignores the timestamp entirely, so the user-initiated variant is open.

### The fix: atomic publish + load epoch

The load itself stays outside the lock — that is the whole point, and holding
`_synth_lock` for 90 s would make the Stop button useless. What moves inside the
lock is only the **publish**, which is seven field assignments:

- **`unload()` increments `self._load_epoch` unconditionally, under
  `_synth_lock`** — it is a *"a teardown was requested"* counter, not a *"a model
  was dropped"* one. This distinction is the whole fix: `_drop_model_locked`
  early-returns when `_tts is None`, and during a cold load `_tts` **is** `None`,
  so bumping only inside the drop would leave the epoch untouched for exactly
  the scenario #1918 is about.
- `_drop_model_locked()` increments it too, for the `maybe_free_idle` path, which
  reaches the teardown without going through `unload()`.

The two halves close different windows. The atomic publish closes the *narrow*
one — the ~30 lines after `self._tts = tts` where the model is visible but
`_device` / `_speakers` are not yet written, which is where a concurrent
`unload()` can have its resets overwritten. The epoch closes the *wide* one: a
Stop pressed at any point during the ~90 s load now cancels it.
- `_ensure_loaded` snapshots `epoch = self._load_epoch` **before** starting the
  load, keeps every loaded value in locals, and hands them to
  `_publish_loaded_locked(...)`.
- The publish compares the snapshot against the live epoch. Unchanged → assign
  all seven fields (`_last_used` first, preserving the #1894 ordering).
  Changed → a teardown won the race; discard the freshly loaded model and leave
  the engine unloaded.
- The speaker-manifest enumeration **moves ahead of the publish** and reads the
  local `tts` rather than `self._tts`, so `_speakers` is part of the atomic
  publish rather than landing ~35 lines after it.

### Reentrancy

`_synth_lock` is non-reentrant by deliberate choice (#1894), and `synthesize`
calls `_ensure_loaded` a second time *while holding it* (the TOCTOU pair). So
the publish cannot unconditionally acquire the lock — that self-deadlocks.

`_ensure_loaded` gains a keyword-only `lock_held: bool = False`. When True the
caller already holds `_synth_lock`, so the publish assigns directly; when False
it takes the lock around the publish. The re-ensure inside `synthesize` (and the
matching one in the batch path, if any) passes `lock_held=True`; every other
caller keeps the default.

This is preferred over making `_synth_lock` an `RLock`: reentrancy would silently
permit a nested `maybe_free_idle` from inside a forward, which is exactly the
deadlock the non-reentrant choice is there to make loud.

### Discard semantics

When the epoch moved, the load is thrown away and `_tts` stays `None`. The
caller that raced (`synthesize`'s pre-lock ensure) then takes the lock and
re-ensures, which loads again. That is correct: Stop unloads, and a synth that
still needs a model reloads it. Failing the synth instead would kill a chapter,
which is the outcome #1894 exists to prevent.

## 4. #1920 — the evict has no notion of "enough freed"

Two defects, one design.

### A. No short-circuit

`_idle_evict` runs four engine branches in sequence accumulating
`freed = X or freed`, and nothing stops after the first success. A `/transcribe`
needing 400 MB can free 5 GB of Qwen VoiceDesign at step 2 and still unload XTTS
at step 4 — a ~90 s reload for nothing.

The obvious one-liner (`if not freed and …`) is wrong: *something was freed* is
not *enough was freed*. Freeing 5 GB does not satisfy a 6 GB request, and that
version would decline the only eviction that could have admitted the op.

**Fix — step list driven by a real re-probe.** `_idle_evict` becomes
`_idle_evict_steps(device_key, engine) -> list[tuple[str, Callable[[], bool]]]`,
returning the eviction candidates that apply to this device and this admitting
engine, **ordered cheapest-reload-first**: `spk` (~200 MB, ~1 s) → `asr`
(~400 MB, ~1 s) → `qwen` design → `qwen` base-1.7B → `coqui` (~3 GB, ~90 s) last.

`PlacementController` drives the loop, and after each step that actually freed
something it re-probes and retries the fit — `try_hold` in `reservation()`,
`best_fit` in `admit()` — stopping the moment the request fits. "Fits" is
therefore decided by live capacity, never by a boolean.

Ordering matters precisely because of the short-circuit: with it, the first
sufficient step is the only one that runs, so the cheapest one must be tried
first.

### B. The evict ignores the reservation ledger

`_idle_evict` consults residency and the in-flight counter, but the in-flight
counter is claimed on the worker thread *after* `reservation()` has yielded. In
that gap a resident, **already-reserved** model can be evicted:

1. `/synthesize {engine:"coqui"}` takes its hold; the handler awaits
   `to_thread(engine.synthesize, …)` and yields.
2. Before the worker reaches its counter claim, the event loop admits a starved
   Qwen op → the Coqui step runs → XTTS is evicted.
3. The worker resumes and cold-loads XTTS for ~90 s.

Correctness holds (the re-ensure under the lock reloads) but a reserved model was
thrown away.

**Fix — attribute reservations to their engine.** `ReservationLedger.try_hold`
and `hold` take the engine key and record it alongside the token; a new
`engines_holding(device_key) -> set[str]` reports which engines currently hold a
reservation on that device. `PlacementController` skips any step whose name is in
that set.

Each step carries the engine key the ledger would record for an op using it —
or `None` where the ledger's engine granularity is the *wrong* granularity. The
filtering lives entirely in the controller; the step builder stays a pure "what
could be evicted here" function. The ledger is the right authority because the
hold spans the whole op, from before the worker thread starts until after it
finishes; the in-flight counter only covers the forward.

The two Qwen steps declare `None`. Every Qwen route reserves under the bare key
`"qwen"`, so the ledger cannot tell its three models apart — and with a `"qwen"`
key, one Qwen op holding a reservation would make a second starved Qwen op skip
both cheap Qwen steps and fall through to a ~90 s XTTS reload instead. Qwen's
per-model in-flight guards are the correct granularity there. The cost is
recorded under Known limitations.

`ledger.hold()` has no production callers today (tests only), so the signature
change touches `try_hold`'s two production sites and the tests.

### What does not change

The `engine != "coqui"` self-eviction guard stays. The admitting Coqui op holds
no reservation yet — `try_hold` just failed — so the ledger cannot protect it.
The two guards cover different windows.

## 5. #1921 — Stop reports a 2 s timeout, then unloads anyway

### The defect

`CoquiEngine.unload()` now waits for an in-flight forward (#1894, and correctly
so — it previously killed the chapter being rendered). Node's
`POST /api/sidecar/unload` runs under `PROBE_TIMEOUT_MS = 2_000`, so during a
render the user presses Stop, sees a 503, and the model unloads a minute later
anyway.

### The fix: give `/unload` its own budget

`UNLOAD_TIMEOUT_MS = 90_000`, mirroring the `LOAD_TIMEOUT_MS = 90_000` that
already exists on the sibling `/load` route for exactly the same reason. Chosen
over the "return 202 queued, unload in the background" alternative because it
**preserves the contract that when the call returns, the VRAM is actually free**.
The Analysing screen's auto-evict depends on that: it unloads TTS and then loads
the analyzer, and a queued response would have it loading against VRAM that is
still occupied. Making that safe needs a poll-until-freed helper on both callers
— materially more machinery, and a new OOM path if the polling is wrong.

### The UI half

`doStop` in `use-tts-lifecycle.ts` currently sets the optimistic pending state to
`'idle'` the instant Stop is pressed, so the pill immediately reads "Voice engine
idle · Load model" while the model is still resident for up to a minute — and the
Load button is live, inviting a load against a model that has not gone yet.

A new `ModelControlState` variant `'unloading'` fixes it, exactly parallel to the
existing `'loading'`: label "Stopping <noun>…", action label "Stopping…",
disabled. `doStop` sets `'unloading'` and clears it on completion. This is the
whole of the "accurate, non-alarming UI result" the issue asks for — the pill now
tells the truth for the entire duration of the wait.

The analyzer auto-evict path reports honestly for free: it shares this route, and
the route now returns the real outcome instead of a timeout.

## 6. Files

| File | Change |
|---|---|
| `server/tts-sidecar/main.py` | `InFlightCounter`; five counters converted; `_publish_loaded_locked` + `_load_epoch`; `_idle_evict_steps`; `PlacementController` step loop; `ReservationLedger` engine attribution |
| `server/src/routes/sidecar-health.ts` | `UNLOAD_TIMEOUT_MS`; the stale #1894 comment block |
| `src/components/ModelControlPill.tsx` | `'unloading'` state |
| `src/lib/use-tts-lifecycle.ts` | `doStop` sets `'unloading'` |
| `server/tts-sidecar/tests/` | new `test_in_flight_counter.py`, `test_coqui_publish_race.py`; extended `test_devices.py` / `test_placement.py` |
| `server/src/routes/sidecar-health.test.ts` | the unload budget |
| `src/components/ModelControlPill.test.tsx`, `src/lib/use-tts-lifecycle.test.ts(x)` | the new state |

## 7. Testing

Every test must **fail against the wrong implementation**, not merely exist —
three placebo tests survived self-review on #1894 and were caught only by an
independent reviewer asked "name the wrong implementation this catches". The
recurring shapes are recorded in that PR's review notes; the ones that bite here:

- **#1917** — a pure "N threads, assert zero at the end" stress test is
  probabilistic. It ships as a realism check, paired with a **deterministic**
  test that replaces the counter's lock with a spy and asserts the mutation
  happens between acquire and release. The spy version fails against `+=`
  every run.
- **#1918** — an `Event`-gated fake `TTS` that blocks mid-load, with `unload()`
  driven from a second thread while the loader is parked. Assert the engine ends
  unloaded **and** `_device == _requested_device` — the torn state is precisely
  `_tts` non-`None` with `_device` pinned, so both halves are needed.
- **#1920A** — a small op satisfied by the first step must leave Coqui resident;
  a large op that the first step does not satisfy must still reach Coqui. Both
  drive `reservation()`, not `admit()` — `admit()` has no production callers
  (found by #1894's final review), so a test that only exercises it proves
  nothing about the shipped path.
- **#1920B** — hold a Coqui reservation on the device, then admit a starved Qwen
  op, and assert Coqui survives.
- **#1921** — server-side: the unload route survives past 2 s and returns the
  upstream body. Frontend: pressing Stop renders "Stopping…" with the action
  disabled, and the Load button is not reachable until the call resolves.

## 8. Known limitations (carried forward)

- **Multi-GPU:** `_worst_device_key` returns the card with the most headroom, so
  an idle engine on a *different* card is still skipped and the starved op still
  fails. Pre-existing since #1721, unchanged here.
- **Kokoro is not a beneficiary:** it is CPU-capable, so a starved Kokoro op is
  placed on CPU before the evict is consulted.
- **The 90 s unload budget is a ceiling, not a promise.** A forward longer than
  90 s still reports a timeout. Coqui sentence forwards are seconds; this is the
  same bet `LOAD_TIMEOUT_MS` already makes.
- **#1920B stays open for Qwen.** The ledger records reservations under the bare
  engine key, and every Qwen route reserves as `"qwen"`, so the two Qwen evict
  steps cannot use the ledger guard (see §4B). A `/design_voice` that has been
  admitted but whose worker thread has not yet claimed `_design_in_flight` can
  still have a warm VoiceDesign model evicted underneath it — the same window
  the ledger closes for Coqui, ASR and ECAPA. Closing it means recording
  `FootprintTable._key(engine, model, cfg)` (which already yields
  `qwen.1.7b.design` / `qwen.1.7b.mint` / `qwen.1.7b` / `qwen`) in the ledger
  instead of the engine, and threading that key through both `try_hold` sites.
  Deliberately out of scope here; file it if the design work is wanted.
- **A discarded cold load can now make a second Stop block for the length of a
  fresh ~90 s reload** ([#1925](https://github.com/dudarenok-maker/Castwright/issues/1925)).
  §3's atomic publish means a load that loses the epoch race is thrown away
  rather than published, so `synthesize`'s in-lock re-ensure — which has always
  been allowed to reload — can now run a full cold load **while holding
  `_synth_lock`**, narrowing the window in which a second Stop is responsive.
  The *shape* (the re-ensure reloading under the lock) is pre-existing; what
  this branch changed is the trigger set — previously the losing loader
  published anyway, which was the #1918 bug, so the re-ensure hit its fast-out
  instead. This is a narrow Stop-responsiveness regression traded against the
  torn state / placement bypass §3 closes, which was worse. Deliberately not
  fixed here — it needs a design decision (retry outside the lock vs.
  fail-as-cancelled vs. publish-or-bail) — filed as #1925 rather than folded in.

## 9. Owed acceptance

Row **A20** (#1894) already asks the tester to record what the Stop control
reports during a render. That row's criteria are updated rather than duplicated:
the expected observation changes from "records whatever it reports" to
"Stop shows *Stopping…* and then completes, with no 2 s error". No new row.

## Ship notes

Shipped: TBD (filled at merge). Merge SHA: TBD. Closes #1917, #1918, #1920, #1921.
