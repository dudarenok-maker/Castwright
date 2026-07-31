---
status: stable
shipped: 2026-07-31
owner: null
---

# Sidecar engine-lock contention (#1919 + #1925)

**Phase-1 design pass. No code was changed.**
Repo state verified at `main` @ `31c5b096` (clean tree).
Key file: `server/tts-sidecar/main.py` (9486 lines).

**Revision 2** — reworked after the adversarial review gate. Changes from rev 1
are listed in §9 so a reader of the first version can diff quickly.

---

## 0. Executive summary

The two issues were bundled because they share one architectural question:
*what does the sidecar do when an engine lock is contended?* Verifying both
issues against the code first changed the shape of the work twice:

- **#1919's premise HOLDS**, including its correction comment — and it is
  **worse than the issue states**. The issue frames the ASR/ECAPA path as the
  worst case; in fact `_idle_evict_steps` also emits two **Qwen** steps, and
  Qwen is the default GPU generation engine. **The stall is reachable in the
  default configuration, with no opt-in env var.** It is not theoretical.
- **#1925's premise DOES NOT HOLD on `main`.** The interleaving it describes
  was real on the `fix/sidecar-evict-hardening` branch it was filed from, but
  the fs-38 Wave 3c merge (#1936), which landed *after* #1930, moved Coqui's
  in-lock re-ensure out of `_synth_lock`. The ~90 s dead-Stop window no longer
  exists — **and nothing pins that.** The defect shape did not disappear; it
  relocated to `QwenEngine` and `WhisperEngine`, where nobody had filed it.

Deliverable: pin #1925's already-landed fix, fix #1919 properly (both stall
sources, all five eviction steps), and **fix the relocated residual on Qwen
and Whisper in this same branch** (repo-owner decision, §6 D1 — overriding
rev 2's recommendation to file it). There is therefore **no follow-up issue to
file** for the Qwen/Whisper half.

> **Post-ship correction (2026-07-31, independent review of PR #1968):** this
> was wrong. T8 fixed only `_guarded_base_synth` — the single-utterance
> `synthesize` path (title beat, audition, clone). Three more `QwenEngine`
> sites have the identical in-lock-cold-load shape and were missed entirely:
> `design_voice`'s audition forward (`main.py:5336-5337`) and **both**
> `synthesize_batch` paths (`main.py:6028-6030`, `:6096-6099`).
> `synthesize_batch` is the actual per-chapter render path — the hotter half
> of Qwen, not a corner case — so this plan fixed the colder path and left the
> hotter one untouched. A follow-up issue was filed after all:
> [#1975](https://github.com/dudarenok-maker/Castwright/issues/1975) (Refs
> #1919). Every other "no follow-up issue" / "`:5666` is the only line T8
> moves" claim in this document should be read against this correction.

**Revision 3** applies that decision. The design work it needs — how the fix
interacts with Qwen's degeneracy-guard reload loop — is resolved in §1.3
below with file:line evidence, so the implementer does not have to make that
call mid-branch.

---

## 1. Premise verification

### 1.1 #1919 — VERIFIED, and the exposure is WIDER than the issue says

| Claim | Verdict | Evidence |
|---|---|---|
| All engines' `maybe_free_idle` have a lock-free fast-out then a blocking `acquire()` to re-validate | **TRUE** | `CoquiEngine` `:1887-1925`; `WhisperEngine` `:6184-6212`; `SpeakerEngine` `:6355-6387`; **`QwenEngine.maybe_free_idle_design` `:4975-5013`**; **`maybe_free_idle_base17` `:4507-4531`** |
| Check and acquire are not atomic | **TRUE** | Nothing between the fast-out and `with self._synth_lock:` / `with self._infer_lock:` in any of the five |
| The evict is reached synchronously on the asyncio event loop | **TRUE** | All 11 `_placement.reservation(...)` call sites are `with` (not `async with`) inside `async def` route handlers. `reservation` is a plain `@contextmanager` (`:3590`), so its whole `__enter__` — probe → `try_hold` → `_evict_until` → `step.run()` → `maybe_free_idle` → drop → reclaim — runs on the loop. |
| **Correction comment:** two stall sources; releasing the lock before the reclaim does not protect the loop | **TRUE** | `_reclaim_after_drop` (`:1741`) runs `gc.collect()` + `empty_cache()` after the lock is released but still inside the same synchronous `__enter__`. Its own docstring says exactly this (`:1743-1748`), as do the ASR/SPK twins (`:6159-6165`, `:6329-6336`) and `test_coqui_idle_evict.py:267-277`. Qwen's two methods inline the same `gc.collect()` + `empty_cache()` after their lock release (`:5002-5011`). |
| Coqui gets a real TTL; ASR/ECAPA get `0.0` | **TRUE** | `_idle_evict_steps` `:3751-3782`. With `ttl=0.0` the ASR/SPK TTL guard `(now - _last_used) < 0.0` is **always False** — it can never decline on TTL. |

#### The correction the issue needs: five steps, not three

`_idle_evict_steps` (`:3751-3782`) emits **five** candidate steps, not three:

| Step | TTL passed | `reserved_key` | Lock it blocks on |
|---|---|---|---|
| `spk` | `0.0` | `"spk"` | `SpeakerEngine._infer_lock` |
| `asr` | `0.0` | `"asr"` | `WhisperEngine._infer_lock` |
| **`qwen.design`** | **`0.0`** | **`None`** | **`QwenEngine._synth_lock`** |
| **`qwen.base17`** | **`0.0`** | **`None`** | **`QwenEngine._synth_lock`** |
| `coqui` | `_coqui_idle_ttl()` (30 s) | `"coqui"` | `CoquiEngine._synth_lock` |

Three consequences, and they invalidate the "currently theoretical" framing:

1. **`reserved_key=None` on both Qwen steps means #1920B's ledger skip can
   never fire for them.** That is deliberate and documented at `:3758-3775`
   (every Qwen route reserves under the bare key `"qwen"`, so the ledger cannot
   tell Qwen's three models apart). The consequence is that the Qwen steps are
   the *least* protected of the five.
2. **`QwenEngine._synth_lock` is the same lock `_guarded_base_synth` holds
   across an entire Base forward** (`:5662-5669`) — *and* across an in-lock
   cold load, since `ensure_loaded()` is called inside that block. So an evict
   that loses the race waits for a whole Qwen forward, or a whole Qwen cold
   load, on the event loop.
3. **`maybe_free_idle_design`'s fast-out checks `_design_in_flight`, not the
   Base forward** (`:4989`). So with VoiceDesign warm-resident and a *Base*
   render in flight, the fast-out **passes** — nothing is designing — and the
   step proceeds straight to `with self._synth_lock:`, which the Base forward
   holds. This is the #1919 race, reached on the default path, with no opt-in.

**Qwen is the default GPU generation engine** (CLAUDE.md: "Qwen is the
default/main generation engine"). VoiceDesign is kept warm across a
cast-review session by design. So the sequence *design a voice → render a
chapter → any admission on the same card* is an ordinary user session, not a
contrived one. §7's acceptance recipe is built on exactly this.

**Does T2 mechanically cover the two Qwen methods?** **Yes, and explicitly.**
`_evict_until` invokes every step uniformly as `step.run()` (`:3495`); the Qwen
steps are `lambda: qwen.maybe_free_idle_design(0.0)` and
`lambda: qwen.maybe_free_idle_base17(0.0)` (`:3776-3777`). Moving that one
call site to `await asyncio.to_thread(step.run)` carries all five steps —
including both Qwen ones and their inlined `gc.collect()`/`empty_cache()` —
onto a worker thread. **No per-engine change is required, and none should be
made.** T3 exists to prove this rather than assume it.

#### Correction: `admit()` is not on the production path

`PlacementController.admit` (`:3505`) has **zero** production call sites; its
only 12 callers are in `tests/test_placement.py`. `test_placement.py:154`
already records this. Every real route goes through `reservation()`. This
should be corrected on the issue, which names both.

### 1.2 #1925 — PREMISE DOES NOT SURVIVE

The issue's step 4 is:

> `synthesize` acquires `_synth_lock` and calls `_ensure_loaded(model,
> lock_held=True)`, which runs the FULL cold load while holding the lock.

**That call site no longer exists.** On `main`:

- `CoquiEngine.synthesize` (`:1927-1983`) calls `_ensure_loaded(model)` at
  `:1934` and `:1980`. **Both are outside `_synth_lock`, both default
  `lock_held=False`.**
- A `grep` for `lock_held` across the whole sidecar finds **no production
  caller passing `True`**. The only one is
  `tests/test_coqui_publish_race.py:272`, which drives it directly *because*
  going through `synthesize` "would prove nothing".
- The code comment at `:1959-1971` states the change: *"On `main` this call
  sits INSIDE `with self._synth_lock:` with `lock_held=True`. On THIS branch it
  cannot…"* — "this branch" being fs-38 Wave 3c, merged as #1936 (`6a2e4e17`),
  **after** #1930 (`321f702b`).

Re-derived against current code:

| Step | Current behaviour |
|---|---|
| 1. `synthesize` on a cold engine starts the pre-lock ensure | Holds `_cold_load_lock` only. `_synth_lock` free. |
| 2. Stop → `unload()` | Takes the **free** `_synth_lock`, bumps epoch, `_drop_model_locked` early-outs (`_tts is None`), returns. **Fast.** |
| 3. Loader reaches publish | Epoch stale → discard → reclaim outside the lock. `_tts` stays `None`. |
| 4. `synthesize` claims `_in_flight`, re-ensures at `:1980` | Full cold load holding `_cold_load_lock`, **not `_synth_lock`.** |
| 5. Second Stop → `unload()` | `_synth_lock` **free**. Returns immediately. **Stop is not dead.** |

**#1925's symptom is already fixed, incidentally, by the Wave 3c merge — and
nothing pins it.** No test asserts a second Stop stays responsive. T1 fixes
that.

### 1.3 What #1925 actually describes, correctly located — and how it resolves

*"A cold model load runs while holding the engine's forward lock"* is now a
property of two **other** engines. Both are fixed in this branch (T7, T8).

#### 1.3.1 Whisper — the simpler half. CONFIRMED simpler.

`WhisperEngine.transcribe` (`:6094-6108`):

```
self._ensure_loaded(device=device)      # :6094  — OUTSIDE _infer_lock (pre-ensure)
with self._in_flight.claim():
    ...
    with self._infer_lock:              # :6102
        self._ensure_loaded(...)        # :6106  — INSIDE the lock. The defect.
        model = self._model
        assert model is not None        # :6108
```

**Confirmed genuinely simpler, on four counts.** (a) There is already a
pre-ensure outside the lock at `:6094`, so the in-lock call at `:6106` is a
no-op on the warm path — exactly the shape Coqui had before Wave 3c, and the
fix is the same one Wave 3c applied. (b) There is no retry loop, no
degeneracy guard, no second model, and no `_cold_load_lock` — `_ensure_loaded`
(`:6028-6053`) takes no lock at all. (c) Only one caller. (d) `unload()`
(`:6178`) waits on `_infer_lock`, so the blast radius is one lock and two
methods.

It is nevertheless **the worse bug in worst-case duration**:
`_ensure_loaded` constructs `WhisperModel(...)` (`:6053`), which **downloads
the weights from HuggingFace on first use.** "~1 s" is the *warm-cache* figure
only; cold, this is an unbounded network fetch held inside `_infer_lock`.

**Incidental defect in the same lines (clears the fix-now bar).** `:6108` is a
bare `assert`, which `python -O` strips — the identical defect
`_synthesize_claimed`'s docstring already calls out for Coqui (`:2003-2005`,
"a loud `RuntimeError` rather than main's bare `assert`, which `-O` strips").
Moving the ensure out of the lock makes that gap *reachable*, so the assert
must become a loud raise in the same edit. Declared in the PR body as an
incidental fix.

#### 1.3.2 Qwen — the degeneracy-guard entanglement, RESOLVED

The method is **`_guarded_base_synth`** (`:5634`) — note rev 2 (and the issue
discussion) called it `_guarded_base_forward`; that name does not exist.
Tracing the loop in full (`:5660-5717`):

```
for attempt in 1.._QWEN_DEGEN_SYNTH_ATTEMPTS:
    with self._synth_lock:                       # :5662
        ensure_loaded()                          # :5666  — INSIDE the lock. The defect.
        wavs, sr = getattr(self, base_attr).generate_voice_clone(...)   # :5667
    ... if not degenerate: return                # :5677
    if attempt < ATTEMPTS:
        with self._synth_lock:                   # :5689
            setattr(self, base_attr, None)       # :5690  — drop under the lock
        _reclaim_host_and_vram()                 # :5691  — OUTSIDE the lock
        ensure_loaded()                          # :5692  — OUTSIDE the lock
        continue
    ... schedule recycle; raise                  # :5705-5714
```

**The entanglement resolves cleanly — the reload path already obeys the
rule.** The four questions asked, answered:

1. **Does the reload path re-enter `_ensure_loaded`?** Yes, at `:5692` — but
   **already outside `_synth_lock`.** The `with` block at `:5689-5690` closes
   before the reclaim and the reload. So the degeneracy-guard reload is
   *already* compliant and T8 does not touch it.
2. **Can a reload be triggered while the lock is held?** Only at `:5666`, and
   only when the pre-ensure's model was freed in the gap. `synthesize` already
   pre-ensures outside the lock — `:5743` (`_ensure_base17_loaded` inside
   `_base17_activity()`) and `:5770` (`_ensure_base_loaded`) — so `:5666` is a
   no-op on the warm path, exactly like Whisper's `:6106` and pre-Wave-3c
   Coqui. **`:5666` is the only violation _in `_guarded_base_synth`_, and it
   is the only line T8 moves — it is NOT the only violation in `QwenEngine`.**
   `design_voice`'s audition forward (`:5336-5337`) and both
   `synthesize_batch` paths (`:6028-6030`, `:6096-6099`) have the identical
   shape and were missed by this analysis; see the executive summary's
   post-ship correction and issue #1975.
3. **Does each retry get its own load?** Yes — one drop (`:5690`) + one
   reclaim + one `ensure_loaded()` (`:5692`) per retry, all outside the lock,
   bounded by `_QWEN_DEGEN_SYNTH_ATTEMPTS`. Unchanged by T8.
4. **Lock-order effect.** Today `:5666` takes `_synth_lock` → then
   `_cold_load_lock` (inside `_ensure_base_loaded` `:4408` /
   `_ensure_base17_loaded` `:4435`). Everywhere else `_cold_load_lock` is
   taken standalone, so no inversion exists today — but the edge is real.
   Moving `:5666` out removes **one instance** of the `_synth_lock` →
   `_cold_load_lock` edge — **it does not delete the edge entirely**, as this
   revision claimed. The same edge survives at the three sites #1975 tracks
   (`design_voice`'s audition forward and both `synthesize_batch` paths),
   each of which still takes `_synth_lock` and then calls into an
   `_ensure_*_loaded` that can reach `_cold_load_lock` while holding it.
   Simplifying the lock graph for `_guarded_base_synth` alone is still a
   benefit; it is a partial one, not a total one.

**So the same single rule applies to both engines, with no per-engine
mechanism and no special-casing.** Rev 2's recommendation to defer Qwen was
over-cautious: it assumed the retry loop's reload was inside the lock. It is
not (`:5691-5692`). Stated plainly because the recommendation was wrong.

### 1.4 Stale documentation found in passing

- `test_coqui_publish_race.py:243`: *"`synthesize` calls `_ensure_loaded` while
  HOLDING `_synth_lock`"* — **false on `main`.**
- `main.py:1295` — same stale claim in the `_synth_lock` non-reentrancy note.
- `lock_held` is **dead production code**: the parameter, the `nullcontext()
  if lock_held else self._cold_load_lock` branch (`:1470`), the `if lock_held:`
  publish branch (`:1573-1581`), and the `if not lock_held:` reclaim guard
  (`:1593-1602`) are reachable only from one test.
  **Disposition (decided, not deferred): keep the parameter, correct the
  docs.** It is not code this request touches, "remove what YOUR changes
  orphaned" does not apply, and the branch documents a real lock-order
  constraint. Deleting it would be taste, which the surgical-changes rule puts
  off-limits.

---

## 2. The rule

> **An engine lock is never acquired from the asyncio event loop. Contention
> is resolved by *waiting*, but the wait — and everything downstream of it,
> including the reclaim — happens on a worker thread via `asyncio.to_thread`.
> The caller, not the callee, owns "am I on the loop?"**
>
> **Corollary (the #1925 half): a cold model load is never performed while
> holding an engine's forward lock. The forward lock is taken around the
> forward and the publish, never around the pull.**

All five `maybe_free_idle*` methods therefore keep their blocking `acquire()`
and their existing re-validate legs, byte for byte. The contract — `True` iff
it actually freed — is untouched, which is #1919's stated acceptance
criterion.

### 2.1 Why waiting-on-a-thread, and not `acquire(blocking=False)`

**This is the option I reject.** Four reasons, in descending weight:

1. **It fixes one of the two sources, and the issue's correction says both
   must be fixed.** `blocking=False` removes the lock wait and does nothing
   about `gc.collect()` + `empty_cache()`, which is *downstream* of the lock,
   inside the same synchronous `__enter__`. That fires on the **success**
   path — every time an evict actually works, which is more often than the
   race it is meant to fix.
2. **It trades a stall for real render failures.** The forward case is already
   handled by the `_in_flight` fast-out; what is left to contend on is short (a
   publish, a drop, another evict). `blocking=False` declines exactly those — a
   ~50 ms wait becomes "decline" → no step frees enough → `noCapacity` → **503
   and a failed chapter render.**
3. **It manufactures two placebo tests.**
   `test_asr_maybe_free_idle_reevaluates_the_counter_under_the_lock`
   (`test_asr_spk_idle_evict.py:145`) and its SPK twin (`:336`) gate on a
   holder thread owning `_infer_lock` and assert `not done.wait(timeout=0.3)`
   — they *require* blocking, precisely so the re-validate-under-lock leg is
   provably exercised. With `blocking=False` that leg becomes undrivable and
   both tests degrade into assertions that pass either way.
4. **It creates a second rule inside one file.** The idle watchdogs already
   call the *same* methods via `asyncio.to_thread` (`:6455`, `:6458`, `:6516`,
   `:6592`) with the comment *"so the event loop and /health stay live"*.
   `blocking=False` would mean the watchdog blocks and the admission path
   declines — same method, two contention policies.

### 2.2 Why "just defer the reclaim" does not work

Leaving everything sync but firing the reclaim as
`asyncio.create_task(asyncio.to_thread(reclaim))` is **wrong, not merely
inelegant.** `_evict_until` re-probes after each step and stops when `fits()`
succeeds (`:3478-3503`). If the reclaim has not completed, `probe_capacity()`
still reports the VRAM as allocated, `fits()` fails, and the admission either
evicts *more* models than needed or reports `noCapacity` for headroom it just
freed. The reclaim must complete synchronously with respect to the evict step;
it just must not do so on the loop.

### 2.3 Why the async conversion is forced, not chosen

There is no way to `await` from inside a synchronous `@contextmanager` entered
from an `async def`, and blocking the loop on an executor future is the same
stall with extra steps. "Get the evict off the loop" therefore *requires*
`reservation()` to become an `@asynccontextmanager`. The only genuine
alternative is `blocking=False`, rejected above.

`asynccontextmanager` is already imported (`main.py:40`) — no new dependency.

### 2.4 The failure mode the fix itself introduces

Converting `reservation()` to async inserts `await` points into what is
currently atomic by virtue of the loop. Two concurrent handlers could then
interleave probe → evict → `try_hold` and **over-evict**, or decide against a
stale probe. `ReservationLedger.try_hold` is atomic so the *hold* is safe; the
*evict decision* is not. Mitigation is part of the fix, not optional: an
`asyncio.Lock` around the admission phase only (T4).

---

## 3. Task breakdown

Nine tasks. **Ordering is load-bearing:** T1 is independent of everything else
and green on `main` before any production change, so it goes first. T2→T6 are
strictly sequential. T7–T9 can run once T6 is green.

Branch: `fix/sidecar-evict-off-event-loop` (worktree per CLAUDE.md).
Structurally a `refactor` of a hot admission path → `code-review` effort
**high**.

---

### T1 — pin #1925's already-landed fix (do this FIRST)

**Why first.** It touches no production code and must be green on `main`
*before* T2–T6 exist, which is only checkable if it lands first. Running it
after the refactor cannot distinguish "the fix was already there" from "the
refactor fixed it".

**Change.** No production code. Add the deterministic `Event`-gated regression
test #1925's acceptance calls for, in `test_coqui_publish_race.py`'s style.

**Verify.** New test green on `main` with no other change on the branch.
Record that in the PR body — it is the evidence for closing #1925 as
superseded.

**Paired test — `test_coqui_publish_race.py::test_a_second_stop_during_the_retry_reload_is_not_blocked_by_the_synth_lock`.**
Using the file's `_install_fake_tts_torch` harness with a `_FakeTts` whose
`__init__` sets an entry `Event` and blocks on a release `Event` (with a
construction counter, so load #1 and load #2 are distinguishable):

1. Thread A runs `eng.synthesize("xtts_v2", …)`.
2. Wait for load #1's entry event.
3. Main thread: `eng.unload()` (Stop 1) — assert it returns within 0.5 s.
4. Release load #1; it discards on the stale epoch.
5. Wait for load #2's entry event (the in-claim re-ensure at `:1980`).
6. Main thread, **while load #2 is still parked**: `eng.unload()` (Stop 2) —
   assert it returns within 0.5 s.
7. Release; join thread A bounded; assert the discard branch logged
   (`caplog`, mirroring `:141-143`) so a load that took some other path
   cannot make step 6 pass vacuously.

**Mutation that must fail it:** restore the pre-Wave-3c shape — change
`synthesize`'s in-claim `self._ensure_loaded(model)` (`:1980`) to
`with self._synth_lock: self._ensure_loaded(model, lock_held=True)`. Stop 2
then queues behind the parked load and the 0.5 s assertion fails. This is a
faithful reconstruction of the code #1925 describes, which is what makes the
test a guard rather than a description of current behaviour.

---

### T2 — `_evict_until` runs each eviction step on a worker thread

**Change.** `PlacementController._evict_until` (`:3464`) becomes `async def`;
`if not step.run(): continue` becomes
`if not await asyncio.to_thread(step.run): continue`. The `try/except`
(`:3494-3499`) stays — a raising step is skipped, not fatal. `fits()` stays
synchronous on the loop (one probe + one lock-guarded set comprehension).

The comment at `:3479-3487` already anticipates this ("keeps the #1920B guard
correct even if a future step becomes async or is offloaded to a thread") — the
per-iteration `engines_holding` re-read is already correct. **Confirm it; do
not touch it.**

**Verify.** `npm run test:sidecar` green; `_evict_until` contains exactly one
`await asyncio.to_thread` and no other awaits.

**Paired test — `test_placement.py::test_an_eviction_step_does_not_stall_the_event_loop`.**
Inside a running loop, enter `reservation()` with an `idle_evict_steps` whose
single step blocks on a `threading.Event`. Concurrently run a heartbeat task
ticking every 10 ms. The step signals entry via a second `Event`; the test
waits for that, asserts the heartbeat advanced by ≥ 3 ticks, then releases.

**Mutation that must fail it:** revert to `step.run()`. The heartbeat records
**0** ticks and the `>= 3` assertion fails. Fails closed: if the step never
enters, the entry `Event.wait` times out and the test errors rather than
passing vacuously.

---

### T3 — prove the reclaim moved too, and that all five steps are covered

**Change.** None beyond T2. This is a *verification* task, and it is its own
task because the reclaim is the half the issue's correction says gets missed,
and because the Qwen steps were missing from rev 1 of this plan.

**Verify.** Trace the call chain and confirm no reclaim path escapes
`step.run()` for any of the five steps.

**Paired test A — `test_placement.py::test_the_post_evict_reclaim_does_not_stall_the_event_loop`.**
Same heartbeat harness, but the step is a **real `CoquiEngine.maybe_free_idle`**
on an engine with a fake resident model, with `_reclaim_after_drop`
monkeypatched to block on an `Event` (standing in for a multi-GB
`gc.collect()`). Assert the heartbeat advances while the reclaim is parked and
that `maybe_free_idle` still returned `True` (contract intact).

**Mutation that must fail it:** implement the *half fix* — offload only the
lock acquire and run the drop + reclaim on the loop. That build passes T2's
test and **fails this one**. This is the discriminator the task exists for.

**Paired test B — `test_placement.py::test_a_qwen_eviction_step_does_not_stall_the_event_loop`.**
The Qwen twin, because Qwen is the default engine and carries
`reserved_key=None`. Build a `QwenEngine` with a fake `_design` resident,
`_design_in_flight` at 0, and `_design_last_used` long past; hold
`_synth_lock` from a separate thread (standing in for an in-flight Base
forward); drive `maybe_free_idle_design(0.0)` as the eviction step and assert
the heartbeat advances while it is queued on that lock.

**Mutation that must fail it:** the same `step.run()` revert. This test is
what makes the "all five steps, not three" correction structural rather than a
comment.

---

### T4 — `reservation()` and `admit()` become async; admission phase serialised

**Change.**
- Extract the admission-resolution body of `reservation` into
  `async def _resolve_admission(...) -> tuple[dict, Optional[tuple]]` — probe →
  `try_hold` → `await self._evict_until(...)` → resolve `admission`/`held`.
  **`_resolve_admission` does NOT take the lock.**
- `reservation` (`:3590`): `@contextmanager` → `@asynccontextmanager`, `def` →
  `async def`. Body becomes
  `async with self._admit_lock: admission, held = await self._resolve_admission(...)`,
  then `yield admission`, then the existing `finally` release. **The `yield`
  and the `finally` are OUTSIDE the lock** — wrapping them would serialise
  every op against every other op.
- `admit()` (`:3505`) → `async def`, `await self._evict_until(...)`.
- Add `self._admit_lock = asyncio.Lock()` in `__init__`.

**Hazard (a) — `admit()` must NOT take `_admit_lock`.**
`test_placement.py:70` calls `pc.admit(...)` from *inside* an open
`with pc.reservation(...)` block. `asyncio.Lock` is non-reentrant, so adding
the lock to `admit()` symmetrically **deadlocks**. It is also unnecessary:
`admit()` is a pure decision that holds nothing, so it cannot double-book.
**This must be stated as a code comment on `admit()`**, or the next reader
"fixes" the asymmetry and reintroduces the deadlock.

**Hazard (b) — `asyncio.Lock` binds to the first loop that awaits it.**
Reusing one `PlacementController` across two `asyncio.run(...)` calls raises
*"is bound to a different event loop"*. In production this cannot happen
(uvicorn owns one loop for the process lifetime); it is a **test-only**
hazard, and T6 resolves it by mandating exactly one `asyncio.run` per test
function. A lazily-rebinding lock was considered and **rejected** — it is
speculative complexity for a constraint the tests can simply honour.

**Verify.** `npm run test:sidecar`; zero remaining synchronous `_evict_until`
callers; `admit()` carries the no-lock comment.

**Paired test — `test_placement.py::test_two_concurrent_admissions_do_not_interleave_their_eviction_phase`.**
Two `reservation()` entries as concurrent tasks in **one** loop. The eviction
step appends `(admission_id, "enter"/"exit")` to a shared list and blocks
briefly. Assert the sequence contains no `A-enter, B-enter` interleaving —
each admission's evict phase is contiguous.

**Mutation that must fail it:** delete `async with self._admit_lock:`. The two
interleave and the assertion fails. Without this test, T4 ships a new
concurrency bug behind a green suite.

---

### T5 — convert the 11 production call sites to `async with`

**Its own task because rev 1 of this plan omitted it entirely.** Without this
edit every admitting route raises at runtime, and `_evict_until`-only greps do
not catch it.

**Change.** Convert `with _placement.reservation(` → `async with
_placement.reservation(` at **all 11 sites across 8 route handlers**:

| Line | Handler |
|---|---|
| `:8189` | `load_model` (`:8135`) — kokoro |
| `:8224` | `load_model` — qwen 1.7B |
| `:8249` | `load_model` — qwen base |
| `:8290` | `load_model` — coqui |
| `:8468` | `qwen_design_voice` (`:8401`) |
| `:8590` | `qwen_clone_voice` (`:8531`) |
| **`:8686`** | **`qwen_mint_variant` (`:8630`)** |
| `:8877` | `xtts_clone_voice` (`:8788`) |
| `:9098` | `synthesize` (`:9009`) |
| `:9251` | `transcribe` (`:9203`) |
| `:9326` | `embed` (`:9283`) |

All 8 handlers are already `async def`, so no signature changes are needed.

**Verify.**
1. `grep -c "with _placement.reservation" main.py` returns **11**, and
   `grep -c "async with _placement.reservation" main.py` returns **11** — i.e.
   **zero** remaining bare `with`.
2. `npm run test:sidecar` — in particular `test_load_admission.py`,
   `test_design_mint_admission.py`, `test_transcribe_embed_admission.py`,
   `test_capacity.py`, which exercise these routes end-to-end.

**Paired test.** No new test — the four existing admission route suites above
are the coverage, and a missed conversion makes them raise. Confirm each of the
four is actually collected and passing, not skipped.

---

### T6 — port `test_placement.py` to the async API without weakening it

**Change.** 11 `with pc.reservation(...)` and 12 `pc.admit(...)` sites in
`tests/test_placement.py` become async. The sidecar suite has **no
pytest-asyncio and no conftest**; the established pattern is a sync test
calling `asyncio.run(...)` (`test_lifespan_order.py`, `test_memory.py`,
`test_speaker_embed.py`, `test_transcribe_embed_admission.py`). Follow it —
do not add a test dependency.

**Constraint from T4 hazard (b): exactly ONE `asyncio.run` per test
function.** The whole test body becomes a single async function.
`test_reserves_peak_so_second_op_cannot_double_book` (`:62-73`) is the
concrete case — it uses one `pc` for a `reservation` and two `admit`s, which
must all live in one loop.

**This is the highest placebo risk in the plan.** A port that stops driving
its assertions (an un-awaited coroutine whose body never runs) leaves the
suite green and the coverage gone.

**Verify — the primary control is a per-test POSITIVE control.**
1. **Positive control (mandatory).** Every ported async body ends with
   `return _RAN`, and the module-local helper asserts it:
   ```
   _RAN = object()
   def run_case(coro):
       assert asyncio.run(coro) is _RAN, "async test body did not run to completion"
   ```
   Each ported test is `run_case(body())`. This proves the body executed **to
   its last line**, which count-parity cannot and which an un-awaited
   coroutine cannot fake.
   *Rationale for not relying on `-W error::RuntimeWarning`:* "coroutine was
   never awaited" is raised from the coroutine's `__del__`; under `-W error`
   CPython prints and **ignores** an exception in a finaliser. It fails a test
   only if GC happens to land in scope and pytest's unraisable plugin
   escalates. It is a useful secondary signal, not a control.
2. **Secondary.** Run once with `-W error::RuntimeWarning` and read the
   output — informational only.
3. **Count parity.** Collected and passed counts identical before and after.
   Necessary, not sufficient.
4. **Mutation re-runs across the ported set, not a sample of two.** For each
   of the four invariants below, apply the mutation and record **which**
   ported tests go red; if a test that covered the invariant before the port
   no longer goes red, the port broke it:
   - (a) delete `if got is not None: return got` (`:3500-3502`) → the #1920A
     stop-at-first-sufficient-step tests must fail;
   - (b) delete the `step.reserved_key in held_by` skip (`:3489-3493`) → the
     #1920B tests must fail;
   - (c) delete the `try/except` around `step.run()` (`:3494-3499`) → the
     raising-step-is-skipped test must fail;
   - (d) make `_gpu_candidates` ignore the residency constraint (`:3440-3441`)
     → the residency/pin tests must fail.

**Paired test.** None new — this task's deliverable *is* the evidence that the
ported tests still discriminate.

---

### T7 — Whisper: move the re-ensure out of `_infer_lock`

**Change** (`WhisperEngine.transcribe`, `:6094-6108`):
- Move `self._ensure_loaded(device=device)` from inside `with
  self._infer_lock:` (`:6106`) to immediately **before** the acquire, still
  inside the `_in_flight.claim()` block — mirroring `CoquiEngine.synthesize`
  `:1980`.
- Keep `model = self._model` captured **under** the lock (`:6107`).
- Replace the bare `assert model is not None` (`:6108`) with a loud
  `RuntimeError` naming the race (`-O` strips asserts; §1.3.1).
- Update the `:6103-6105` comment to state the new rule.

Nothing else moves. `_ensure_loaded` (`:6028`) is untouched.

**Verify.** `npm run test:sidecar`, notably `test_transcribe.py` and
`test_transcribe_embed_admission.py`. Confirm `with self._infer_lock:` no
longer encloses any `_ensure_loaded` call.

**Paired test — `test_transcribe.py::test_unload_is_not_blocked_by_a_cold_asr_load`.**
Event-gated fake injection in `test_coqui_publish_race.py`'s style — **no real
weights download.** Inject a fake `faster_whisper` module into `sys.modules`
whose `WhisperModel.__init__` sets an entry `Event` and blocks on a release
`Event` (mirroring `_install_fake_tts_torch`, `test_coqui_publish_race.py:59-71`).
Thread A calls `eng.transcribe(...)` on a cold engine; wait for the entry
event; from the main thread call `eng.unload()` and assert it returns within
0.5 s while the load is still parked; release and join bounded.

**Mutation that must fail it — breaks the PRODUCER, not the consumer:** revert
the change, i.e. move `self._ensure_loaded(device=device)` back inside `with
self._infer_lock:`. `unload()` (`:6178`) then queues on `_infer_lock` behind
the parked construction and the 0.5 s assertion fails. The test drives the
real `transcribe` → real `unload` pair, so no consumer-side stub can mask it.

**Second paired test —
`test_transcribe.py::test_a_model_freed_in_the_ensure_gap_raises_loudly`.**
Run under `python -O` semantics by asserting the raise type directly: null
`_model` from a thread holding `_infer_lock`, release, and assert
`transcribe` raises `RuntimeError` (not `AssertionError`, and not
`AttributeError` from a `None` deref).
**Mutation:** restore the bare `assert` → the test sees `AssertionError` and
fails.

---

### T8 — Qwen: move the re-ensure out of `_synth_lock` in `_guarded_base_synth`

**Change** (`:5660-5669`) — **one line moves**, per §1.3.2:
- Hoist `ensure_loaded()` (`:5666`) to immediately **before** `with
  self._synth_lock:` (`:5662`), inside the `for attempt` loop so each attempt
  still re-ensures.
- Inside the lock, capture `model = getattr(self, base_attr)` and raise a loud
  `RuntimeError` if it is `None`, then call
  `model.generate_voice_clone(...)` on the local — mirroring
  `_synthesize_claimed`'s local-capture invariant (`:1998-2005`).
- Update the `:5663-5665` comment and the docstring's "re-ensure the model
  UNDER `_synth_lock`" claim (`:5655-5657`), which becomes false.

**Do NOT touch** the degeneracy-guard reload at `:5689-5692` — it is already
compliant (§1.3.2 Q1). Do not touch `_ensure_base_loaded` (`:4400`) or
`_ensure_base17_loaded` (`:4425`).

**Verify.** `npm run test:sidecar`, notably `test_qwen3.py`,
`test_qwen_degeneracy_guard.py`, `test_qwen_evict.py`,
`test_qwen_load_reclaim.py`, `test_batch_synthesis.py`. Confirm no
`_ensure_*_loaded` call remains inside a `with self._synth_lock:` block, and
that `madge`-equivalent reasoning holds: the `_synth_lock` → `_cold_load_lock`
edge is gone.

**Paired test — `test_qwen_evict.py::test_unload_is_not_blocked_by_a_cold_base_load`.**
Event-gated: monkeypatch `_load_qwen_model` so it sets an entry `Event` and
blocks on a release `Event`. Drive `_guarded_base_synth("_base",
eng._ensure_base_loaded, …)` on a cold engine from thread A; wait for entry;
call `eng.unload()` from the main thread and assert it returns within 0.5 s.

**Mutation that must fail it — breaks the PRODUCER:** move `ensure_loaded()`
back inside `with self._synth_lock:`. `unload()` (`:4917`, which takes
`_synth_lock`) then blocks behind the parked load and the assertion fails.

**Second paired test —
`test_qwen_degeneracy_guard.py::test_the_retry_reload_still_runs_outside_the_synth_lock`.**
The guard against T8 accidentally *pulling* the retry reload into the lock
while moving the re-ensure out. Force one degenerate result, then assert —
from inside the patched `_load_qwen_model` invoked by the retry's
`ensure_loaded()` (`:5692`) — that `_synth_lock.acquire(blocking=False)`
**succeeds**, i.e. nobody holds it. Mirrors
`test_coqui_idle_evict.py:267-294`'s spy technique.
**Mutation:** wrap `:5691-5692` in `with self._synth_lock:` → the
non-blocking acquire fails and the test fails.

**Third paired test —
`test_qwen_degeneracy_guard.py::test_each_retry_attempt_reloads_exactly_once`.**
Pins §1.3.2 Q3 — the retry budget is unchanged by T8. Count
`_load_qwen_model` invocations across a forced two-attempt run; assert the
count matches `_QWEN_DEGEN_SYNTH_ATTEMPTS`-derived expectation exactly.
**Mutation:** hoist `ensure_loaded()` out of the `for` loop (a plausible
"simplification" of T8) → later attempts stop reloading and the count drops.

---

### T9 — correct the stale record

**Change.** Documentation only, all in files the branch already touches:
- `test_coqui_publish_race.py:243` — the "`synthesize` … while HOLDING
  `_synth_lock`" docstring is false; say the branch is now reachable only from
  that test and why it is still guarded.
- `main.py:1295` — same correction in the `_synth_lock` non-reentrancy note.
  Keep the `lock_held` parameter (§1.4).
- `_evict_until` / `reservation` / `admit` docstrings — state the §2 rule,
  including that `maybe_free_idle*` deliberately still blocks, and both T4
  hazards.
- The three `_reclaim_after_drop` docstrings (`:1743`, `:6159`, `:6329`) say
  the released lock is "NOT because it protects the event loop
  (`reservation()` is a plain @contextmanager entered synchronously…)". That
  parenthetical becomes **false** after T4. Update all three.
- `test_coqui_idle_evict.py:267-277` carries the same now-false parenthetical.

**Verify.** No behaviour change; suite green; each edited claim re-checked
against post-T4 code.

**Paired test.** None — doc-only. Stated explicitly rather than silently
skipped.

---

### T10 — docs, register, notes

- Plan doc `docs/features/273-sidecar-lock-event-loop.md` from
  `TEMPLATE.md`, `status: active`. Cross-link
  `docs/superpowers/specs/2026-07-28-sidecar-evict-hardening-design.md` and
  `docs/features/264-vram-aware-gpu-placement.md`.
- `docs/features/INDEX.md` entry.
- `docs/release-notes-next.md` + `RELEASE_NOTES.md` — operator-visible
  (`/health` stays responsive during a VRAM-starved admission), so **not**
  exempt.
- On-box register row — §7.
- PR body: `Closes #1919`; `Closes #1925` **citing `6a2e4e17` / PR #1936 (the
  fs-38 Wave 3c merge) as the commit that actually removed the reported path**,
  with §1.2's derivation so the closure is auditable, and noting that the
  relocated Qwen/Whisper defect is fixed **in this branch** (T7, T8) rather
  than deferred — **so there is no follow-up issue to file.** Include the T6
  mutation-run results and the incidental `assert`→`RuntimeError` fix (§1.3.1)
  under "Also fixed, found in passing".

  **Post-ship correction:** that last claim was wrong — T7/T8 fixed the
  relocated defect only on `synthesize`/`transcribe`, not on `QwenEngine`'s
  two `synthesize_batch` paths or `design_voice`'s audition forward. A
  follow-up issue for those three sites was filed after independent review:
  [#1975](https://github.com/dudarenok-maker/Castwright/issues/1975).

---

**Task count: 10.
Order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → (T9, T10).**

T7 and T8 are independent of T2–T6 (different methods, different locks) but
touch the same file, so they run sequentially after the async work rather than
in parallel with it — one writer per worktree.

### Scope boundary (exact — another agent is active on this machine)

**Every code file this branch touches lives under `server/tts-sidecar/`.**

| Path | Touched by |
|---|---|
| `server/tts-sidecar/main.py` | T2, T4, T5, T7, T8, T9 |
| `server/tts-sidecar/tests/test_placement.py` | T2, T3, T4, T6 |
| `server/tts-sidecar/tests/test_coqui_publish_race.py` | T1, T9 |
| `server/tts-sidecar/tests/test_coqui_idle_evict.py` | T9 (comment only) |
| `server/tts-sidecar/tests/test_transcribe.py` | T7 |
| `server/tts-sidecar/tests/test_qwen_evict.py` | T8 |
| `server/tts-sidecar/tests/test_qwen_degeneracy_guard.py` | T8 |

**Outside `server/tts-sidecar/`, docs only** (T10): `docs/features/273-*.md`,
`docs/features/INDEX.md`, `docs/testing/onbox-acceptance-register.md`,
`docs/testing/sidecar-evict-latency-onbox-acceptance.md`,
`docs/release-notes-next.md`, `RELEASE_NOTES.md`.

**Explicitly NOT touched: no `server/src/**`, no `src/**`, no `e2e/**`, no
`scripts/**`, no `openapi.yaml`, no config registry.** The Qwen/Whisper
widening adds **no** new file outside the sidecar — it is confined to
`main.py` plus three sidecar test files. No new env var, so no
`config:sync` / `docs/wiki/Advanced-Settings.md` row is owed.

---

## 4. Regression risk against #1894 and #1918

| Risk | Assessment |
|---|---|
| **#1894** (an evict racing a forward must not crash the chapter) | **LOW.** Nothing inside any `maybe_free_idle*`, `_in_flight`, the re-validate legs, `_drop_model_locked`, or `synthesize` changes. The evict is invoked from a different *thread*, not with different *semantics*. |
| **#1894, second-order** | **MEDIUM — the reason T4's lock is mandatory.** Today the loop serialises the whole admission; after T4 other handlers run during the `to_thread` await, so the window between an evict step and the caller's `try_hold` becomes genuinely concurrent. #1920B's ledger guard covers Coqui/ASR/ECAPA and is unchanged — **but it does not cover the two Qwen steps, which carry `reserved_key=None` (§1.1).** For those, T4's `_admit_lock` is the *only* thing keeping the evict decision coherent. **If it is dropped as "not strictly needed", this regresses #1894 on the default engine.** |
| **#1918** (publish race / epoch discard) | **LOW.** `_ensure_loaded`, `_publish_loaded_locked`, `_load_epoch`, `unload` untouched. Coqui's publish still takes `_synth_lock`, now from a worker thread — which it already did on every `/synthesize` path. |
| **T5 omission** | **HIGH if missed** — a bare `with` on an `@asynccontextmanager` raises at runtime on that route. The 11-vs-11 grep is the control. |
| **T6 placebo** | **HIGH if unmanaged** — the per-test positive control and the four mutation re-runs are the control. |
| **NEW (T7/T8): a silent reload becomes a loud raise** | **MEDIUM — the one genuinely new risk the widening introduces, and the only place it can regress #1894.** Today, an `/unload` or analyzer evict landing between the pre-ensure and the forward is absorbed *silently*: the in-lock re-ensure (`:5666` / `:6106`) transparently reloads and the sentence completes. After T7/T8 that gap raises `RuntimeError` instead — **the sentence fails.** On a chapter render that is a failed sentence on the **default** engine. Three things bound it: (a) the admission path cannot reach it — `_idle_evict_steps` emits **no step for Qwen `_base`** at all (`:3751-3782`), and `maybe_free_idle_base17` declines while `_base17_in_flight` is claimed by `_base17_activity()` (`:5742`); (b) so only an **explicit** `/unload` (user Stop, or the analyzer auto-evict) can win the gap — the user asked for it; (c) it is the identical trade Coqui already makes post-Wave-3c and documents at `:1976-1979`. **Accepted deliberately, not overlooked** — but it is a behaviour change on the default engine and must be called out in the PR body and the release note, not buried. |
| **NEW: T7/T8 widen the ensure→forward gap** | **LOW.** The gap grows from ~0 to the duration of the lock acquire. Same window Coqui has carried since Wave 3c; the loud local-capture check is what makes it safe rather than an `AttributeError` after the GPU work already ran. |

---

## 5. Contract invariants that must not move

1. Every `maybe_free_idle*` returns `True` **iff** it actually freed. (#1919
   acceptance.)
2. `_evict_until` stops at the first step after which `fits()` succeeds
   (#1920A) and skips a step whose engine already holds a ledger reservation
   (#1920B).
3. Steps stay ordered cheapest-reload-first (`:3734-3740`).
4. A raising step is skipped, never fatal (`:3494-3499`).
5. Reclaims run with the engine lock **released**.
6. `test_synthesize_survives_an_evict_that_wins_the_ensure_gap`
   (`test_coqui_idle_evict.py:181`) passes **unmodified**. Nothing here touches
   its path; if a task needs to edit it, that task is out of scope and needs
   re-design.

---

## 6. Decisions — ALL CLOSED

No open decisions remain. Recorded here with their reasoning so the
implementer does not re-litigate them.

**D1 — Scope of the relocated #1925: DECIDED — fix Qwen AND Whisper in this
branch (T7, T8). Not filed.**
This **overrides rev 2's recommendation to file**, and rev 2's stated reason
for filing turned out to be wrong: it assumed the degeneracy-guard retry
reload ran inside `_synth_lock`. It does not (`:5691-5692` — the `with` block
at `:5689-5690` closes first). With that corrected, Qwen needs **one line
moved**, not a redesign, and the same single rule covers both engines with no
per-engine mechanism. The design work is resolved in §1.3.2, not left to the
implementer.

**Post-ship correction:** "fix Qwen" turned out to mean "fix
`_guarded_base_synth`" only — the design pass never traced `design_voice`'s
own audition forward or `synthesize_batch`'s two paths, which share the exact
same shape and are the actual per-chapter render path. Those three sites were
**not** fixed by T7/T8 and needed the follow-up issue this decision said
would not be needed: [#1975](https://github.com/dudarenok-maker/Castwright/issues/1975).

**D2 — `PlacementController.admit()`: DECIDED — convert to async (T4), do NOT
delete.**
Pre-existing dead code is a *finding*, not a licence to delete (CLAUDE.md,
"Surgical changes"): it was not orphaned by this change, so removing it is
taste. More concretely, deleting it deletes the 12 tests that cover the
placement decision logic in isolation — and removing tested code in the middle
of a refactor is exactly how coverage vanishes silently while the suite stays
green. **Do not re-open this.**

**D3 — How to close #1925: DECIDED — close as superseded; keep the T1 pin.**
The PR body cites **`6a2e4e17` / PR #1936 (the fs-38 Wave 3c merge)** as the
commit that actually removed the reported path, links §1.2's derivation, and
notes that T1's test now pins the behaviour so it cannot silently regress. T1
stays **first** and must be green on `main` before any production change —
that ordering is what distinguishes "already fixed" from "the refactor fixed
it". Because T7/T8 fix the relocated defect here, **no follow-up issue is
filed.** (Post-ship: that last sentence is false for the residual — see D1's
correction and #1975.)

**Settled earlier, also not open:** delete the dead `lock_held` parameter? —
no, keep it and correct the docs (§1.4). Is #1919 worth fixing at all? — void;
§1.1 shows it is default-reachable on the default engine.

---

## 7. On-box acceptance (real hardware only)

Automated tests prove the evict *runs on a worker thread*. They cannot prove
the user-visible claim — that `/health` stays responsive while a real
multi-GB `gc.collect()` + `empty_cache()` and a real contended engine lock are
in play. That needs the GPU box.

**The recipe uses the DEFAULT Qwen path — no opt-in env var.** Rev 1's recipe
required `SEG_ASR_ENABLED=1` + `ASR_DEVICE=cuda`, which understated the bug.

**Register row — Group A (the GPU box), `docs/testing/onbox-acceptance-register.md`.**

- **Prerequisites:** the dual-GPU dev box (`cuda:0` 4070 8 GB, `cuda:1` 5070 Ti
  16 GB per `r_dev_box_dual_gpu`); `SEG_CAPACITY_ADMISSION=1` (the default);
  Qwen as the generation engine (the default). Pin with `CUDA_VISIBLE_DEVICES`
  per A20's convention; **runnable alongside A20/A19/A5** in one session.
- **What to observe (concretely):**
  1. Run a cast-review **design** so Qwen VoiceDesign is warm-resident
     (`QWEN_DESIGN_IDLE_TTL` keeps it ~120 s).
  2. Start a Qwen **chapter render** — Base forwards hold `_synth_lock`
     across each sentence (`:5662-5669`).
  3. Trigger an admission on the same card (`POST /load` for coqui, or an
     `/xtts/clone-voice`). `_evict_until` reaches the `qwen.design` step; its
     fast-out **passes** (nothing is *designing*), so it blocks on
     `_synth_lock` held by the in-flight Base forward — §1.1 consequence 3.
  4. From a second shell, poll `GET /health` every 250 ms throughout and
     record the **maximum inter-response gap**.
- **Expected:** before the fix, a gap on the order of one Qwen forward
  (seconds); after, bounded by the poll interval (< 500 ms). Record both.
- **Secondary observation:** confirm the evict still actually frees — the
  admission succeeds rather than 503-ing `noCapacity`. This guards against
  "we made it non-blocking by making it not work", the failure mode of the
  rejected `blocking=False` option.
- **Optional second pass** with `SEG_ASR_ENABLED=1` + `ASR_DEVICE=cuda` to
  exercise the `asr` step as well. Not required for the row to clear.
- **Removal condition:** both figures recorded, by whom, when. Not "tests
  pass, presumably fine".

**Bookkeeping (blocks the merge; running does not).** All three surfaces move
in this PR: the register row, a run sheet
`docs/testing/sidecar-evict-latency-onbox-acceptance.md`, and the **live HTML
twin updated via the `url` recorded in the register header** — never
re-published from scratch (`r_register_twin_drift`: the twin has drifted before
by being published from a branch; on a 409, re-fetch and merge, never force).
Re-run `npm run check:onbox-register` after editing.

---

## 8. Verification battery

1. `npm run test:sidecar` — the primary gate.
2. T6's per-test positive control (`run_case` asserting `_RAN`) — the real
   anti-placebo control.
3. `pytest tests/test_placement.py -W error::RuntimeWarning` — secondary
   signal only.
4. Collected/passed count parity across the T6 port.
5. `grep -c "async with _placement.reservation"` == 11 and no bare `with`
   remaining (T5).
6. **Every named mutation actually run and confirmed red**, and the results
   recorded in the PR body: T1's `lock_held=True` restoration; T2's
   `step.run()` revert; T3's half-fix; T4's `_admit_lock` deletion; T6's four
   invariant mutations (a)–(d); **T7's ensure-back-inside-`_infer_lock` and
   its `assert` restoration; T8's ensure-back-inside-`_synth_lock`, its
   wrap-the-retry-reload, and its hoist-ensure-out-of-the-loop.** Every one of
   these mutates the **producer** (the lock discipline in `main.py`), not a
   test-side stub. A mutation that was "obviously going to fail" and was not
   actually run is how this repo shipped placebo tests before.
7. `npm run verify:fast:branch` (scope-gated `test:sidecar` fires on
   `server/tts-sidecar/**`).
8. `npm run check:onbox-register`.
9. Mandatory Premium-tier `code-review` pass, effort **high**.

---

## 9. Changes from revision 1

1. **§1.1 rewritten.** Rev 1 claimed an exposure *narrowing* (ASR/ECAPA are
   cpu-default, so the bug needs an opt-in). Wrong: `_idle_evict_steps` emits
   **five** steps including `qwen.design` and `qwen.base17`, both at `ttl=0.0`,
   both with `reserved_key=None` (so #1920B can never protect them), both
   blocking on the `_synth_lock` that `_guarded_base_synth` holds across a
   whole forward. Qwen is the **default** engine → **default-reachable**. Added
   an explicit statement that T2 covers both mechanically.
2. **T5 added.** The 11 production `with _placement.reservation(` → `async
   with` conversions were missing entirely from rev 1, including
   `qwen_mint_variant` (`:8686`), which rev 1's route list also omitted.
3. **T4 hazards resolved in-plan.** (a) `admit()` must not take `_admit_lock`
   (non-reentrant; `test_placement.py:70` nests it inside `reservation`) →
   deadlock. (b) `asyncio.Lock` loop-binding across multiple `asyncio.run`
   calls → resolved by T6's one-`asyncio.run`-per-test rule.
4. **T6's control replaced.** `-W error::RuntimeWarning` is not a control
   (finaliser exceptions are printed and ignored); replaced with a per-test
   positive control asserting the async body ran to completion, plus mutation
   re-runs across four invariants instead of two.
5. **Ordering fixed.** The #1925 pin was T5 with a verify that required it to
   run first; it is now T1.
6. **D2 (delete `lock_held`?) removed** — decided in §1.4: keep it, correct the
   docs. **D5 (is #1919 worth fixing?) removed** — void, the bug is
   default-reachable.
7. **§7 recipe rewritten** onto the always-on Qwen path.
8. **§1.3 severity corrected** — `WhisperEngine._ensure_loaded` constructs
   `WhisperModel(...)`, which downloads weights on first use inside
   `_infer_lock`; "~1 s" was the warm-cache figure only.

## 10. Changes from revision 2

1. **D1 decided against rev 2's recommendation** — Qwen and Whisper are fixed
   **in this branch** (new T7, T8), not filed. Rev 2's reason for deferring
   was **wrong**: it assumed the degeneracy-guard retry reload ran inside
   `_synth_lock`; `:5689-5692` shows it already runs outside. §1.3 rewritten
   as a full trace answering all four entanglement questions with file:line.
2. **Method name corrected throughout** — `_guarded_base_synth` (`:5634`).
   `_guarded_base_forward`, used in rev 2 and in the issue discussion, does
   not exist in the codebase.
3. **T7 (Whisper) and T8 (Qwen) added** with six new paired tests, each with a
   **producer-side** mutation. Whisper's tests use `sys.modules` fake
   injection — **no real weights download**.
4. **Old T8 ("file the relocated issue") deleted.** No follow-up issue is
   owed. (Post-ship: wrong for three sites this analysis missed — see D1's
   correction and #1975.)
5. **Renumbered:** old T7 → T9, old T9 → T10. Count 9 → **10**.
6. **New risk row added to §4** — the silent-reload→loud-raise behaviour
   change on the default engine, with the three bounds that make it
   acceptable and the requirement to declare it rather than bury it.
7. **§6 closed** — all three decisions recorded with reasoning; D2 marked
   do-not-re-open.
8. **Exact scope boundary added** to §3 — every code file is under
   `server/tts-sidecar/`; docs are the only thing outside it.
9. **Incidental fix declared** — the bare `assert` at `:6108` becomes a loud
   raise (`-O` strips asserts), in code T7 already touches.

## Ship notes

Shipped 2026-07-31 on `fix/sidecar-plan-273-lock-event-loop`, closing #1919
(fixed) and #1925 (closed as superseded — its symptom was already removed by
the fs-38 Wave 3c merge, `6a2e4e17`/PR #1936, before this branch existed; T1
pins that fix with the regression test the issue itself was missing).

Commits, in task order: `0245e4b7` (T1), `6ae80fc8` (T2), `c601b165` (T3),
`091383a1` (T4), `2225e266` (T5), `9f56c0e4` + `d5665d88` (T6), `0419e0e6`
(T7), `55bcfb8d` (T8), `2470cae6` (T9), `89799cdf` (T10).

Behaviour delta vs. the plan: **not none, contrary to what this section
originally said.** The production CODE landed exactly as designed (T1–T8) —
nothing below changes runtime behaviour. But the plan's own claims and its
paperwork (T9, T10) turned out to be incomplete, found by independent review
and corrected in a same-branch follow-up round:

1. **The "no follow-up issue for the Qwen/Whisper residual" claim was false**
   (§1.3.2, D1, D3, T10 all made it). T7/T8 fixed only `_guarded_base_synth`
   (the single-utterance `synthesize` path) and `WhisperEngine.transcribe`.
   Three more `QwenEngine` sites have the identical in-lock-cold-load shape
   and were never traced: `design_voice`'s audition forward
   (`main.py:5336-5337`) and **both** `synthesize_batch` paths
   (`main.py:6028-6030`, `:6096-6099`) — `synthesize_batch` is the actual
   per-chapter render path, so this is the hotter half of Qwen, not a corner
   case. Filed as [#1975](https://github.com/dudarenok-maker/Castwright/issues/1975).
2. **T9 (`2470cae6`) itself missed a site its own list should have caught**:
   `main.py:1315-1318`'s "unlike QwenEngine/WhisperEngine whose
   `_ensure_loaded` is lock-free" contrast went stale the moment T7/T8
   landed, and directly contradicted the comment T9 itself wrote at
   `:2016-2021` ("Sibling engines … re-ensure at the same outside-the-lock
   spot. Do NOT 'fix' this into looking asymmetric."). Corrected in this
   round.
3. **Two stale line references introduced earlier in the branch went
   uncorrected until this round**: T2's comment at `main.py:3542-3544` cited
   the idle-watchdog `asyncio.to_thread` offload sites as `:6455`/`:6458`/
   `:6516` (actually `SpeakerEngine.__init__` and a CUDA-demote branch); the
   real sites are `:6703`/`:6706`/`:6764`/`:6840`. T1's docstring and
   mutation recipe in `test_coqui_publish_race.py` cited `CoquiEngine.
   synthesize`'s two re-ensures at `:1934`/`:1980`; the actual current lines
   are `:1978` (pre-lock ensure) and `:2029` (in-claim re-ensure).

The one deliberate, called-out behaviour change on the default engine (§4's
new risk row) still shipped as designed and is unaffected by the above: a
`/unload` or automatic evict landing in the narrow re-ensure→forward gap now
raises a loud `RuntimeError` instead of being silently absorbed, on both
`QwenEngine` (the `synthesize` path only — see point 1) and `WhisperEngine`.

On-box acceptance row A25 recorded in
`docs/testing/onbox-acceptance-register.md` (Group A) — does not block this
merge; run sheet at `docs/testing/sidecar-evict-latency-onbox-acceptance.md`.
