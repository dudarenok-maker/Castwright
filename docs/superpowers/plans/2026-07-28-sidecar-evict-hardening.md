# Sidecar idle-evict hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four defects the #1894 pre-merge review filed against the sidecar's VRAM admission path — non-atomic in-flight counters (#1917), the unlocked model publish (#1918), the evict's missing "enough freed" notion (#1920), and the Stop button's spurious 2 s timeout (#1921).

**Architecture:** Four independent behaviour fixes on one branch, because three of them edit overlapping regions of `server/tts-sidecar/main.py`. Each fix lands as its own task with its own paired tests. Nothing here changes the shape of admission — the framework (`PlacementController` → `_idle_evict` → re-probe → retry) stays; what changes is that eviction becomes step-wise and reservation-aware, the counters become thread-safe, the model publish becomes atomic, and the Stop route gets a realistic budget.

**Tech Stack:** Python 3.12 + Starlette/FastAPI (sidecar), pytest; TypeScript + Express (server), Vitest; React 18 + Redux Toolkit (frontend), Vitest + RTL.

**Design of record:** [`docs/superpowers/specs/2026-07-28-sidecar-evict-hardening-design.md`](../specs/2026-07-28-sidecar-evict-hardening-design.md). Predecessor: [`2026-07-28-coqui-residency-eviction-design.md`](../specs/2026-07-28-coqui-residency-eviction-design.md) (#1894, PR #1924).

## Global Constraints

- **Never `git commit --no-verify`.** If a hook fails, triage (related → fix; pre-existing → report and stop).
- **`_synth_lock` / `_infer_lock` stay NON-REENTRANT.** Do not convert either to `RLock`. A holder calls `_drop_model_locked()`, never `unload()`.
- **Never hold an engine lock across a model load or a forward.** The whole point of #1894's design is that a ~90 s cold XTTS pull happens with the lock released so the Stop button stays responsive.
- **The `> 0` in-flight predicate stays `> 0`,** never `!= 0`. It is a deliberate choice so a drifted-negative counter cannot wedge eviction off.
- **`_last_used` is stamped BEFORE `_tts` is published,** never after (#1894 fix-round-1). Any thread that observes a live model must observe a fresh timestamp.
- **On the way OUT of a forward, the `_last_used` re-stamp must happen BEFORE the in-flight count drops** — the mirror of the rule above, and equally load-bearing. Decrementing first leaves a window where the count reads 0 while the timestamp is still the pre-forward value, which `maybe_free_idle*` (called with `ttl=0.0` from the admission path) will happily evict on. Every existing site already gets this right by accident of statement order; a careless `with counter.claim(): yield` rewrite reintroduces the race, because the context manager's decrement runs after the block body ends. Put the final stamp in an inner `finally` **inside** the claim.
- **`_drop_model_locked()` must keep restoring `self._device = self._requested_device`** (the #1730 gap-3 fix). Losing it means the next lazy cold load bypasses placement.
- **`engine != "coqui"` self-eviction guard stays.** A starved Coqui op must never evict the model it is about to reload.
- **Every new test must fail against the wrong implementation.** Before marking a task done, state for each new test which wrong implementation it catches. A test that passes against the unfixed code is a finding, not coverage. Watch for the three shapes that got through on #1894: a timing assertion a merely-slow bug satisfies; a fixture that stamps the field under test; an assertion read after the call instead of during it.
- **Windows clock granularity:** `time.monotonic()` has ~15.6 ms granularity on Python 3.12/Windows. Never assert a strict `>` against a freshly sampled clock — zero the field and assert non-zero instead.
- Do NOT run `npm run test:sidecar` or the full server suite — they exceed a subagent's tool timeout. Run only the targeted test files. The controller runs the full suites.

---

### Task 1: `InFlightCounter` — thread-safe in-flight counters (#1917)

**Files:**
- Modify: `server/tts-sidecar/main.py` — new helper class; `CoquiEngine`, `WhisperEngine`, `SpeakerEngine`, `QwenEngine` (×2 counters)
- Test: `server/tts-sidecar/tests/test_in_flight_counter.py` (create)
- Test: `server/tts-sidecar/tests/test_coqui_idle_evict.py`, `test_asr_spk_idle_evict.py`, `test_qwen3.py` (update the direct-attribute pokes)

**Interfaces:**
- Produces: `InFlightCounter` with `.claim()` (context manager), `.busy` (bool property), `.value` (int property, tests only). Tasks 2–4 read `.busy` where the old code read `_x_in_flight > 0`.

- [ ] **Step 1: Write the failing tests**

Create `server/tts-sidecar/tests/test_in_flight_counter.py`:

```python
"""InFlightCounter (#1917) — the counter guarding each engine's forward.

`x += 1` on an attribute is LOAD_ATTR / BINARY_OP / STORE_ATTR, and CPython can
switch threads between any two of them. Two concurrent forwards can therefore
lose a decrement, leaving the counter stuck above zero — and because the evict
predicate is `> 0`, that disables that engine's eviction for the rest of the
process lifetime, silently.
"""
import sys
import threading

import main


def test_the_mutation_happens_between_acquire_and_release():
    """THE GATE. Deterministic, single-threaded, no timing.

    Reads the counter's RAW `_n` at each lock boundary — not `.value` / `.busy`,
    which re-acquire and would deadlock against a real inner lock.

    Fails against the wrong implementation: with `self._n += 1` outside the
    `with`, the enter/exit pair reads (0, 0) instead of (0, 1) — or there are no
    events at all, because a lock-free version never touches `_lock`.

    Note what this catches that a weaker spy would not: asserting merely that
    "one acquire/release pair happened per claim" passes against an
    implementation that takes the lock for nothing and mutates outside it.
    The VALUE at the boundary is the discriminator.
    """
    events: list[tuple[str, int]] = []

    class Spy:
        def __enter__(self):
            events.append(("enter", c._n))
            return self

        def __exit__(self, *a):
            events.append(("exit", c._n))
            return False

    c = main.InFlightCounter(lock=Spy())
    with c.claim():
        pass
    assert events == [("enter", 0), ("exit", 1), ("enter", 1), ("exit", 0)]


def test_the_mutation_is_guarded_by_the_lock_not_merely_adjacent_to_it():
    """Stronger companion to the test above: hold the counter's own lock, then
    prove a concurrent claim BLOCKS on it rather than racing past.

    Fails against the wrong implementation: a lock-free `+=` completes
    immediately, so the thread is dead and `_n` is 1.
    """
    c = main.InFlightCounter()
    started = threading.Event()

    def worker():
        started.set()
        with c.claim():
            pass

    with c._lock:
        t = threading.Thread(target=worker)
        t.start()
        assert started.wait(2)
        t.join(0.5)
        assert t.is_alive()      # blocked on the lock we hold
        assert c._n == 0         # and it has NOT mutated
    t.join(2)
    assert c._n == 0


def test_concurrent_claims_return_to_zero():
    """Realism check: heavy contention must leave the counter at exactly 0.

    Fails against the wrong implementation reliably (not certainly) with the
    switch interval dialled down — a lost decrement leaves a positive residue.
    Paired with the deterministic test above, which is the real gate.
    """
    c = main.InFlightCounter()
    barrier = threading.Barrier(8)
    old_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        def worker():
            barrier.wait()
            for _ in range(5000):
                with c.claim():
                    pass

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        sys.setswitchinterval(old_interval)
    assert c.value == 0
    assert c.busy is False


def test_busy_reflects_an_outstanding_claim():
    c = main.InFlightCounter()
    assert c.busy is False
    with c.claim():
        assert c.busy is True
    assert c.busy is False


def test_claim_releases_on_exception():
    c = main.InFlightCounter()
    try:
        with c.claim():
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert c.busy is False
    assert c.value == 0
```

**NOTE for the implementer:** the first two tests are the #1917 gate and the
stress test is a realism check. `test_busy_reflects_an_outstanding_claim` and
`test_claim_releases_on_exception` **pass against the broken implementation
too** — they are contract tests for the new helper, not coverage of the defect.
Keep them, but do not count them toward "this task is tested"; say so in your
report.

The injectable lock (`InFlightCounter(lock=...)`, defaulting to
`threading.Lock()`) exists for the spy test and is part of the required
interface.

- [ ] **Step 2: Run to verify they fail**

Run: `server\tts-sidecar\.venv\Scripts\python.exe -m pytest tests/test_in_flight_counter.py -v` (cwd `server/tts-sidecar`)
Expected: FAIL — `AttributeError: module 'main' has no attribute 'InFlightCounter'`.

- [ ] **Step 3: Add the helper**

Place it next to the other small module-level utilities in `main.py`, above `class CoquiEngine`:

```python
class InFlightCounter:
    """Thread-safe in-flight counter for an engine's forward (#1917).

    Each engine's `maybe_free_idle` uses this as a fast-out so admission never
    blocks on a forward that may run for seconds. The count therefore has to be
    readable WITHOUT the engine's forward lock — but `x += 1` on a plain
    attribute is LOAD_ATTR / BINARY_OP / STORE_ATTR, and CPython can switch
    threads between any two of those. Two concurrent forwards can lose a
    decrement, and because every caller's predicate is `> 0`, a counter stuck
    above zero disables that engine's eviction for the remaining process
    lifetime — silently, with no error and no log line.

    The lock here is held for the mutation only, never across a forward, so the
    fast-out stays non-blocking with respect to the work it exists to avoid
    waiting on.
    """

    def __init__(self, lock: Optional[Any] = None) -> None:
        self._lock = lock if lock is not None else threading.Lock()
        self._n = 0

    @contextmanager
    def claim(self):
        """Bracket one forward. Decrements in a `finally`, so a raising forward
        cannot leave the guard stuck above zero."""
        with self._lock:
            self._n += 1
        try:
            yield
        finally:
            with self._lock:
                self._n -= 1

    @property
    def busy(self) -> bool:
        """True while at least one forward is in flight. `> 0`, never `!= 0` —
        a drifted-negative count must not wedge eviction off."""
        with self._lock:
            return self._n > 0

    @property
    def value(self) -> int:
        """Raw count. For tests and diagnostics; production reads `busy`."""
        with self._lock:
            return self._n
```

- [ ] **Step 4: Run to verify they pass**

Run: `server\tts-sidecar\.venv\Scripts\python.exe -m pytest tests/test_in_flight_counter.py -v`
Expected: PASS.

- [ ] **Step 5: Convert all five counters**

Each site: replace the `int` attribute with an `InFlightCounter`, replace the manual `+= 1` / `try` / `finally: -= 1` bracketing with `with self._<counter>.claim():`, and replace every `> 0` read with `.busy`.

1. **`CoquiEngine`** — `self._synth_in_flight = 0` → `self._in_flight = InFlightCounter()`. In `synthesize`, the claim currently wraps `self._last_used = time.monotonic()` and the `with self._synth_lock:` block; keep that exact ordering (claim first, then stamp, then acquire — the TOCTOU pair). In `maybe_free_idle`, both the lock-free fast-out and the under-lock re-validation read `.busy`.
2. **`WhisperEngine`** — `self._infer_in_flight` → `self._in_flight`. `transcribe`'s manual bracket becomes `with self._in_flight.claim():` around the stamp + `with self._infer_lock:` block. `maybe_free_idle`: both reads.
3. **`SpeakerEngine`** — identical to Whisper. `embed`'s bracket wraps the stamp + `with self._infer_lock, torch.no_grad():` block. `maybe_free_idle`: both reads.
4. **`QwenEngine._design_in_flight`** → `self._design_in_flight = InFlightCounter()`. `design_voice` brackets manually (`+= 1`, big `try`, `finally: -= 1`); convert to `with self._design_in_flight.claim():`. `maybe_free_idle_design`: both reads.
5. **`QwenEngine._base17_in_flight`** → `InFlightCounter()`. `_base17_activity()` is already a `@contextmanager`. **Its exit ordering is load-bearing** — see the Global Constraint on exit ordering. The current body is stamp → increment → `yield` → stamp → decrement. The naive rewrite

   ```python
   self._base17_last_used = time.monotonic()
   with self._base17_in_flight.claim():
       yield
   self._base17_last_used = time.monotonic()   # WRONG — runs AFTER the decrement
   ```

   reintroduces the exact TOCTOU `_base17_in_flight` exists to close: the claim's
   `finally` decrements when the block ends, so between the decrement and the
   re-stamp the count reads 0 with a stale timestamp, and `maybe_free_idle_base17`
   (reached with `ttl=0.0` from the admission path) evicts. Write it as:

   ```python
   self._base17_last_used = time.monotonic()
   with self._base17_in_flight.claim():
       try:
           yield
       finally:
           self._base17_last_used = time.monotonic()
   ```

   `maybe_free_idle_base17`: both reads become `.busy`. Apply the same
   inner-`finally` shape to **every** converted site whose original code
   re-stamped `_last_used` after the decrement — Coqui's `synthesize`, Whisper's
   `transcribe`, Speaker's `embed`, and Qwen's `design_voice`. Check each one; do
   not assume.

**Delete the false claim** in `_base17_activity`'s docstring: *"The int inc/dec is GIL-atomic — same rationale as `_design_in_flight`."* Replace with a pointer to `InFlightCounter`.

- [ ] **Step 6: Update the tests that poke the counters directly**

These set or read the raw int and will break. Convert each to the counter API:

- `tests/test_coqui_idle_evict.py:102` — `observed_in_flight.append(eng._synth_in_flight)` → `.value`
- `tests/test_coqui_idle_evict.py:104,117` — `assert eng._synth_in_flight == 0` → `assert eng._in_flight.value == 0`
- `tests/test_coqui_idle_evict.py:181` — `eng._synth_in_flight = 1` → enter a real claim, or set `eng._in_flight._n = 1` with a comment. **Prefer a real `claim()`** held open by the test.
- `tests/test_coqui_idle_evict.py:234-241` — the negative-counter test pinning `> 0` over `!= 0`. Keep it: set `eng._in_flight._n = -1` directly (that is the point — it simulates drift) and assert the evict still fires. Update its docstring to say the drift is now much harder to reach but the predicate is still deliberately `> 0`.
- `tests/test_asr_spk_idle_evict.py:84,97,108,209,222,233` — same treatment.
- `tests/test_qwen3.py:375-387,536-564,1329` — same treatment.

- [ ] **Step 7: Run the touched suites**

Run, from `server/tts-sidecar`:
`.venv\Scripts\python.exe -m pytest tests/test_in_flight_counter.py tests/test_coqui_idle_evict.py tests/test_asr_spk_idle_evict.py tests/test_qwen3.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/
git commit -m "fix(sidecar): make the engine in-flight counters thread-safe"
```

---

### Task 2: atomic model publish in `CoquiEngine._ensure_loaded` (#1918)

**Files:**
- Modify: `server/tts-sidecar/main.py` — `CoquiEngine.__init__`, `_ensure_loaded`, `_drop_model_locked`, `synthesize`
- Test: `server/tts-sidecar/tests/test_coqui_publish_race.py` (create)

**Interfaces:**
- Consumes: Task 1's `self._in_flight`.
- Produces: `_ensure_loaded(model, device=None, *, lock_held: bool = False)`; `CoquiEngine._load_epoch: int`.

- [ ] **Step 1: Write the failing test**

Create `server/tts-sidecar/tests/test_coqui_publish_race.py`. The shape: a fake `TTS` whose construction blocks on an `Event`, so the loader can be parked mid-load while a second thread calls `unload()`.

```python
"""CoquiEngine._ensure_loaded publish race (#1918).

`_ensure_loaded` writes seven fields with no lock; `unload()` takes
`_synth_lock` and resets exactly those fields, including restoring
`_device = _requested_device` (#1730 gap 3). A Stop pressed during a cold load
interleaves: the unload's resets are overwritten by the still-running loader,
leaving a live `_tts` pinned to the last admitted card.
"""
import threading

import main


def test_an_unload_during_a_cold_load_wins(monkeypatch):
    """Park the loader mid-load, unload from another thread, release the loader.

    Fails against the wrong implementation: without the epoch check the loader
    publishes on top of the unload's resets, so `_tts` ends non-None with
    `_device == "cuda:0"` (the admitted card) instead of the requested pref.
    Both halves are asserted — the torn state IS `_tts` live + `_device` pinned,
    so asserting only one of them would pass against a partial fix.
    """
    eng = main.CoquiEngine()
    eng._device = "auto"
    eng._requested_device = "auto"

    in_load = threading.Event()
    release = threading.Event()

    class _FakeTts:
        def __init__(self, *a, **k):
            in_load.set()
            release.wait(5)

        def to(self, device):
            return self

    # ... monkeypatch the TTS import + torch so _ensure_loaded reaches the
    #     publish without real weights (mirror the fixture style already in
    #     tests/test_coqui_idle_evict.py and tests/test_runtime_wiring.py).

    loader = threading.Thread(target=lambda: eng._ensure_loaded("xtts_v2", device="cuda:0"))
    loader.start()
    assert in_load.wait(5)
    eng.unload()          # Stop pressed mid-load
    release.set()
    loader.join(5)

    assert eng._tts is None
    assert eng._device == "auto"
    assert eng._resolved_device == "cpu"
    assert eng._speakers == []


def test_a_normal_load_still_publishes_every_field():
    """Guard against the epoch check being too eager — an uncontended load must
    publish all seven fields. Fails against a fix that always discards."""
    # drive _ensure_loaded with no concurrent unload; assert _tts is not None,
    # _device == the admitted card, _speakers populated, _last_used non-zero.


def test_the_reensure_under_the_lock_does_not_deadlock():
    """`synthesize` calls `_ensure_loaded` while HOLDING `_synth_lock`; a publish
    that unconditionally acquires that non-reentrant lock self-deadlocks.

    MUST drive `_ensure_loaded(..., lock_held=True)` DIRECTLY on a cold engine
    while holding `_synth_lock`. Going through `synthesize` instead proves
    NOTHING: its pre-lock ensure at main.py:1472 already loads and publishes, so
    the in-lock re-ensure at :1487 hits the `_tts is not None` fast-out and never
    reaches the publish at all — that version passes identically against an
    implementation that unconditionally acquires the lock.

    Fails against the wrong implementation by hanging. Bounded join only, never
    an unbounded one.
    """
    eng = main.CoquiEngine()
    # ... same fake TTS/torch monkeypatching as above, no blocking Event ...
    done = threading.Event()

    def run():
        with eng._synth_lock:
            eng._ensure_loaded("xtts_v2", device="cuda:0", lock_held=True)
        done.set()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    assert done.wait(10), "publish self-deadlocked on the non-reentrant _synth_lock"
    assert eng._tts is not None
```

**NOTE for the implementer:** the fixture scaffolding above is elided. Reuse the
existing fake-TTS + fake-torch monkeypatch pattern from
`tests/test_coqui_idle_evict.py` / `tests/test_runtime_wiring.py` rather than
inventing a new one — those already know how to get `_ensure_loaded` to the
publish without real weights. Fill in all three tests completely.

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest tests/test_coqui_publish_race.py -v`
Expected: FAIL — `_tts` is non-`None` and `_device == "cuda:0"` after the unload.

- [ ] **Step 3: Add the epoch**

In `CoquiEngine.__init__`, beside `_synth_lock`:

```python
        # Bumped by every teardown (`_drop_model_locked`, which both unload()
        # and maybe_free_idle go through). `_ensure_loaded` snapshots it before
        # the load and re-checks it at the publish: a teardown that landed in
        # between means the load lost the race and must be discarded rather than
        # written on top of the unload's field resets (#1918).
        self._load_epoch = 0
```

**The epoch must be bumped in TWO places, and getting this wrong makes the whole
task inert.** It is a *"a teardown was requested"* counter, not a *"a model was
dropped"* counter.

1. In `_drop_model_locked`, immediately before `return (True, torch_module)`:

```python
        self._load_epoch += 1
```

2. In `unload()`, **unconditionally, inside `with self._synth_lock:`**, beside
   the `_drop_model_locked()` call:

```python
        with self._synth_lock:
            self._load_epoch += 1   # a Stop was requested — see below
            dropped, torch_module = self._drop_model_locked()
```

**Why (2) is mandatory and (1) alone is not enough.** `_drop_model_locked`
early-returns `(False, None)` when `self._tts is None` (`main.py:1390-1391`) —
*before* the bump in (1). And `_ensure_loaded` only ever runs a load when
`self._tts is None` (`:1230-1231`). So during a cold load `_tts` is `None`,
`unload()` finds nothing to drop, and with only (1) **the epoch never moves** —
the publish then sees an unchanged epoch, publishes on top of the Stop, and
`test_an_unload_during_a_cold_load_wins` cannot pass. Bumping unconditionally in
`unload()` makes a Stop genuinely cancel an in-flight cold load, which is what
the user asked for and what the test asserts. Keep (1) as well, for the
`maybe_free_idle` path, which reaches `_drop_model_locked` without going through
`unload()`.

Note the scope this clarifies: the atomic publish alone closes the *narrow*
window — the ~30 lines after `self._tts = tts` at `:1325` where `_tts` is live
but `_device` / `_speakers` are not yet written. The epoch closes the *wide* one:
Stop pressed at any point during the ~90 s load. Both are wanted; do not drop
either half.

If the implementer is tempted to weaken
`test_an_unload_during_a_cold_load_wins` because it will not go green — stop.
That means (2) is missing.

- [ ] **Step 4: Extract the publish**

Add to `CoquiEngine`:

```python
    def _publish_loaded_locked(
        self, epoch: int, tts: Any, torch_module: Any, device: str,
        use_half: bool, speakers: list[str],
    ) -> bool:
        """Publish a freshly loaded model as ONE atomic step. CALLER MUST HOLD
        `_synth_lock`. Returns False when `epoch` is stale — a teardown landed
        during the load, so this load lost and is discarded.

        `_last_used` is stamped FIRST (#1894 fix-round-1): any thread that
        observes a live `_tts` must observe a fresh timestamp, or an
        admission-path `maybe_free_idle` can drop the model mid-publish.

        The `_tts is not None` half of the guard covers a second loser: two
        threads can both pass `_ensure_loaded`'s `_tts is None` fast-out (a
        `/load` and `synthesize`'s pre-lock ensure are serialised by different
        primitives — an asyncio `_load_lock` and nothing respectively), both
        load, and both arrive here with the same unchanged epoch. Without it the
        second publish overwrites the first and orphans ~3 GB.
        """
        if epoch != self._load_epoch or self._tts is not None:
            return False
        self._last_used = time.monotonic()
        self._tts = tts
        self._torch = torch_module
        self._resolved_device = device
        # Keep the shared `self._device` in step with the card the model is
        # ACTUALLY on (#1730 gap 3).
        self._device = device
        self._use_half = use_half
        self._speakers = speakers
        return True
```

- [ ] **Step 5: Rewrite `_ensure_loaded`'s tail**

Signature becomes:

```python
    def _ensure_loaded(self, model: str, device: Optional[str] = None, *, lock_held: bool = False) -> None:
```

Docstring addition:

> `lock_held=True` means the caller already holds `_synth_lock` (the re-ensure
> inside `synthesize`), so the publish assigns directly instead of acquiring —
> `_synth_lock` is non-reentrant and acquiring it here would self-deadlock.

Immediately after the `if self._tts is not None: return` fast-out, snapshot:

```python
        epoch = self._load_epoch
```

Then, at the current publish point (`self._last_used = time.monotonic()` /
`self._tts = tts` / …), replace the whole tail with:

1. Enumerate the speaker manifest **from the local `tts`**, not `self._tts` —
   move that entire `try/except` block up so it runs before the publish and
   assigns to a local `speakers`.
2. Compute `use_half = bool(want_half and _parse_device(device)[0] == "cuda")`
   into a local (keep the `log.info("fp16 autocast enabled…")` alongside it).
3. Publish:

```python
        if lock_held:
            published = self._publish_loaded_locked(
                epoch, tts, torch, device, use_half, speakers
            )
        else:
            with self._synth_lock:
                published = self._publish_loaded_locked(
                    epoch, tts, torch, device, use_half, speakers
                )
        if not published:
            # A teardown (Stop, or an admission evict) landed during the load,
            # or another thread published first. Discard rather than overwrite —
            # publishing here would leave a live model with `_device` pinned to
            # the admitted card, bypassing placement on the next lazy load
            # (#1730 gap 3).
            log.info("Coqui load discarded — unloaded or superseded while loading.")
            # `del` BEFORE the reclaim, or it does nothing: this frame still
            # holds a reference to the ~3 GB model, so gc.collect() cannot
            # collect it.
            del tts
            if not lock_held:
                self._reclaim_after_drop(torch)
            # When `lock_held` is True the caller holds `_synth_lock`, and
            # `_reclaim_after_drop` documents that it MUST run with that lock
            # released. Skipping it is safe rather than merely convenient: the
            # epoch only ever moves under `_synth_lock`, and `_tts` is only ever
            # published under it, so neither failure condition can arise while
            # the caller holds it — this branch is unreachable on that path. The
            # guard is here so a future caller cannot make it reachable silently.
            return
        log.info("Coqui ready — %d speakers in manifest.", len(speakers))
```

- [ ] **Step 6: Update the in-lock re-ensure**

In `CoquiEngine.synthesize`, the call inside `with self._synth_lock:` becomes:

```python
                self._ensure_loaded(model, lock_held=True)
```

Leave the pre-lock call at the default. **The full caller audit is already done —
this is the verified answer, not a starting point:**

| Site | Holds `_synth_lock`? | `lock_held` |
|---|---|---|
| `main.py:1472` — `synthesize`, pre-lock ensure | no | default |
| `main.py:1487` — `synthesize`, in-lock re-ensure | **yes** | `True` |
| `main.py:6307` — `PRELOAD_COQUI` eager preload (`to_thread`) | no | default |
| `main.py:7119`, `:7121` — `POST /load` (`to_thread`) | no — holds only the *asyncio* `_load_lock`, a different primitive | default |

`:1670` / `:1825` are `KokoroEngine._ensure_loaded`; `:4958` / `:5024` / `:5033`
are `WhisperEngine`'s — neither is this method. Coqui never uses
`/synthesize-batch` (Qwen-only), so there is no batch path. **Exactly one caller
takes `lock_held=True`.** Re-run the grep to confirm nothing has moved, and
report if the table no longer matches.

- [ ] **Step 7: Run to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest tests/test_coqui_publish_race.py tests/test_coqui_idle_evict.py tests/test_runtime_wiring.py tests/test_synthesize.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_coqui_publish_race.py
git commit -m "fix(sidecar): publish a loaded Coqui model atomically under the synth lock"
```

---

### Task 3: engine attribution on the reservation ledger (#1920B)

**Files:**
- Modify: `server/tts-sidecar/main.py` — `ReservationLedger.hold`, `try_hold`, new `engines_holding`; `PlacementController.reservation` (the two `try_hold` call sites)
- Test: `server/tts-sidecar/tests/test_placement.py`

**Interfaces:**
- Produces: `ReservationLedger.hold(device_key, mb, engine)`, `try_hold(candidates, peak, reserve_cap, engine)`, `engines_holding(device_key) -> set[str]`. Task 4 consumes `engines_holding`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_placement.py`:

```python
def test_ledger_reports_which_engines_hold_a_device():
    """Fails against the wrong implementation: a ledger that stores only
    (token -> mb) has no engine to report, so this cannot even be written."""
    ledger = main.ReservationLedger()
    a = ledger.hold("cuda:0", 3000, "coqui")
    ledger.hold("cuda:0", 400, "asr")
    ledger.hold("cuda:1", 6000, "qwen")
    assert ledger.engines_holding("cuda:0") == {"coqui", "asr"}
    assert ledger.engines_holding("cuda:1") == {"qwen"}
    ledger.release(a)
    assert ledger.engines_holding("cuda:0") == {"asr"}
    assert ledger.engines_holding("cuda:2") == set()


def test_try_hold_records_the_admitting_engine():
    ledger = main.ReservationLedger()
    tok = ledger.try_hold([("cuda:0", 8000, 8000)], 3000, 768, "coqui")
    assert tok is not None
    assert ledger.engines_holding("cuda:0") == {"coqui"}
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest tests/test_placement.py -v -k "engines_holding or admitting_engine"`
Expected: FAIL — `TypeError: hold() takes 3 positional arguments but 4 were given`.

- [ ] **Step 3: Implement**

Change the ledger's storage from `dict[str, dict[int, int]]` (device → token → mb) to `dict[str, dict[int, tuple[int, str]]]` (device → token → (mb, engine)).

- `_headroom` sums `mb for mb, _ in ...values()`.
- `reserved_mb` likewise.
- `hold(self, device_key: str, mb: int, engine: str)` stores `(mb, engine)`.
- `try_hold(self, candidates, peak, reserve_cap, engine)` stores `(peak, engine)`.
- New:

```python
    def engines_holding(self, device_key: str) -> set[str]:
        """Engine keys with a live reservation on `device_key`.

        The authority for "this engine's operation is already admitted" (#1920B).
        A reservation spans the WHOLE op — taken before the handler offloads to a
        worker thread, released after it returns — whereas the engine's in-flight
        counter only covers the forward itself. The gap between the two is
        exactly the window in which an admission-path evict could throw away a
        model whose op was already admitted.
        """
        with self._lock:
            return {engine for _, engine in self._by_device.get(device_key, {}).values()}
```

- `PlacementController.reservation` passes `engine` at both `try_hold` sites.
- `best_fit` is read-only and unchanged.

- [ ] **Step 4: Run to verify they pass, and fix the existing callers**

`tests/test_placement.py:94,116,146` call `ledger.hold(...)` with two args and `:187` calls `try_hold` with three.

`:94` and `:187` take the engine argument straightforwardly (`"qwen"`).

**`:116` and `:146` need a modelling change, not just an argument — and getting
this wrong will delete #1920B.** Those two
(`test_starved_qwen_admits_after_coqui_is_evicted` and
`test_starved_qwen_reservation_admits_after_coqui_is_evicted`) model *idle Coqui
residency* as a ledger hold. That was always a shortcut: in production an
idle-but-resident Coqui holds **no** reservation — its token is released when
`reservation()` exits. Tag those holds `"coqui"` and Task 4's ledger check will
skip the Coqui step, both tests go red, and the obvious repair is to weaken the
ledger check, which is exactly the fix #1920B consists of.

Convert both to the model production actually uses: **occupied VRAM in the probe
(low `freeMb`), not a ledger hold**, with the injected evict step raising
`freeMb`. That is the same `freeMb`-mutation model Task 4's new tests use, so
the two tasks stop fighting. If you cannot make that conversion cleanly, stop
and report — do NOT relax the ledger check.

Run: `.venv\Scripts\python.exe -m pytest tests/test_placement.py tests/test_devices.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_placement.py
git commit -m "fix(sidecar): attribute VRAM reservations to their engine"
```

---

### Task 4: step-wise eviction with a real re-probe (#1920A + wiring 1920B)

**Files:**
- Modify: `server/tts-sidecar/main.py` — replace `_idle_evict` with `_idle_evict_steps`; `PlacementController.__init__`, `admit`, `reservation`; the `_placement` construction
- Test: `server/tts-sidecar/tests/test_devices.py`, `tests/test_placement.py`

**Interfaces:**
- Consumes: Task 3's `ReservationLedger.engines_holding`.
- Produces: `EvictStep` NamedTuple; `_idle_evict_steps(device_key, engine) -> list[EvictStep]`; `PlacementController(idle_evict_steps=…)`.

- [ ] **Step 1: Write the failing tests**

In `tests/test_placement.py` — the two acceptance cases, both driving
**`reservation()`**, not `admit()` (`admit` has no production callers; a test
that only exercises it proves nothing about the shipped path):

```python
def test_a_small_op_satisfied_by_the_first_step_leaves_coqui_resident():
    """A 400 MB ASR op on a full card: freeing the cheap engine is enough, so the
    ~90 s-to-reload Coqui must never be touched.

    Fails against the wrong implementation: today every branch runs
    unconditionally, so `evicted` ends as ['spk', 'asr', 'qwen', 'coqui'].
    """


def test_a_large_op_the_first_step_cannot_satisfy_still_reaches_coqui():
    """The guard against over-correcting. A 6 GB op is NOT satisfied by freeing
    200 MB, so the loop must keep going and still reach Coqui.

    Fails against the naive `if not freed: ...` one-liner, which stops after the
    first success and never frees enough.
    """


def test_an_engine_holding_a_reservation_is_not_evicted():
    """#1920B. Hold a Coqui reservation on cuda:0, then admit a starved Qwen op.

    Fails against the wrong implementation: without the ledger check the Coqui
    step runs and the reserved model is thrown away.
    """


def test_steps_run_cheapest_reload_first():
    """Ordering is load-bearing BECAUSE of the short-circuit: with it, the first
    sufficient step is the only one that runs, so the cheapest must be first."""
```

Model the freed VRAM by having each injected step mutate the fake probe's
`freeMb` — a step that returns True without changing capacity would let a
broken short-circuit pass. Use the existing `make(...)` helper in that file.

In `tests/test_devices.py` there are **ten** `main._idle_evict(...) is True/False`
assertions across **nine** test functions (`:382, 392, 403, 412, 414, 421, 428,
438, 460, 479`) — not seven.

**Assert on the step list AND run the steps.** `_idle_evict_steps` is a pure
builder that never invokes its lambdas, so a names-only conversion silently
deletes real coverage:

- `:423` `assert coqui.ttls == [main._coqui_idle_ttl()]` is the **only** test
  pinning that the Coqui step uses the real 30 s TTL rather than the siblings'
  `0.0` — a shipped design decision (predecessor spec §4.3).
- `:383-385, 393-395, 404-405, 413, 415, 461-462, 480` are `design_freed` /
  `base17_freed` / `asr.freed` / `spk.freed` counters, pinning that a step calls
  the right engine's method rather than merely being *named* after it.

So the shape is:

```python
def _run(device_key, engine):
    """Build the steps, assert on their names, then RUN them — the builder
    never invokes the lambdas, so the existing per-engine call counters and
    the TTL assertion only mean anything if we drive them here."""
    steps = main._idle_evict_steps(device_key, engine)
    names = [s.name for s in steps]
    freed = any([s.run() for s in steps])   # list, not generator — no short-circuit
    return names, freed
```

Keep every existing counter/TTL assertion verbatim alongside the new name
assertions. That is strictly stronger than either alone.

- `test_idle_evict_only_frees_engines_on_target_card` → `assert "qwen" in _names("cuda:0", "qwen")`
- `test_idle_evict_targets_the_other_card`, `_skips_cpu_resident_engines`, `_unindexed_cuda_is_card_zero`, `_frees_an_idle_coqui_on_the_target_card`, `_skips_coqui_on_another_card` → same treatment
- `test_idle_evict_never_evicts_coqui_for_a_coqui_op` → `assert "coqui" not in _names("cuda:0", "coqui")` — **keep this test, it pins the self-eviction guard**
- `test_idle_evict_coqui_declining_does_not_clobber_an_earlier_free` and `test_idle_evict_survives_a_raising_coqui` → these pinned the `or freed` composition and the `except Exception` swallow, which now live in the controller loop. Move them to `test_placement.py` as controller-level tests: a raising step must not abort the loop, and a step returning False must not stop it.

- [ ] **Step 2: Run to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest tests/test_placement.py tests/test_devices.py -v`
Expected: FAIL — `module 'main' has no attribute '_idle_evict_steps'`.

- [ ] **Step 3: Define the step type and builder**

**First: `NamedTuple` is not imported.** `main.py:41` reads
`from typing import Any, Callable, Optional`. Add `NamedTuple` to it, or the
module raises `NameError` on import.

Replace `_idle_evict` wholesale:

```python
class EvictStep(NamedTuple):
    """One candidate eviction on the admission path.

    `name` is for logs and tests. `reserved_key` is the engine key the
    reservation ledger would record for an op using this model, or None when
    the ledger's engine granularity is the WRONG granularity for this step
    (see the Qwen steps below). `run` frees it and reports whether it did.
    """

    name: str
    reserved_key: Optional[str]
    run: Callable[[], bool]


def _idle_evict_steps(device_key: str, engine: str) -> list[EvictStep]:
    """The eviction candidates that apply on `device_key` for an op belonging to
    `engine`, ORDERED CHEAPEST-RELOAD-FIRST.

    Ordering is load-bearing because `PlacementController` re-probes after each
    step and stops as soon as the starved request fits (#1920A): the first
    sufficient step is the only one that runs, so the cheapest must be tried
    first. Reload costs: ECAPA ~200 MB / ~1 s, ASR ~400 MB / ~1 s, Qwen
    VoiceDesign + 1.7B-Base seconds, Coqui XTTS ~3 GB / ~90 s.

    Device-targeted (#1721): an engine whose resident card is not `device_key`
    yields no step — freeing it could not admit this op. An engine on cpu is
    likewise skipped.

    Coqui (#1894) is the only PRIMARY synth engine on the list, so it is omitted
    entirely when the admitting op is itself Coqui: evicting would unload the
    model that op is about to reload. It also uses a real idle TTL rather than
    the 0.0 the transient models take.
    """
    steps: list[EvictStep] = []
    if _same_card(getattr(SPK, "device", None), device_key):
        steps.append(EvictStep("spk", "spk", lambda: SPK.maybe_free_idle(0.0)))
    if _same_card(getattr(ASR, "_device", None), device_key):
        steps.append(EvictStep("asr", "asr", lambda: ASR.maybe_free_idle(0.0)))
    qwen = ENGINES.get("qwen")
    if isinstance(qwen, QwenEngine) and _same_card(qwen._device, device_key):
        # `reserved_key=None` deliberately. EVERY Qwen route reserves under the
        # bare key "qwen" — /load base (:7071), /load 1.7b (:7046),
        # /design_voice (:7284), /clone (:7406), /mint (:7502), /synthesize
        # (:7693) — so the ledger cannot tell Qwen's three models apart. With
        # reserved_key="qwen", one Qwen op holding a reservation would make a
        # SECOND starved Qwen op skip both cheap Qwen steps and fall through to
        # evicting Coqui: a ~90 s XTTS reload taken to avoid freeing an idle
        # 5 GB design model. Qwen's per-model in-flight guards
        # (`_design_in_flight`, `_base17_in_flight`) are the right granularity
        # and already cover the forward itself.
        #
        # KNOWN RESIDUAL: this leaves #1920B open for Qwen specifically — a
        # /design_voice admitted but not yet at its `_design_in_flight` claim
        # can have a warm VoiceDesign model evicted underneath it, the same
        # window the ledger closes for Coqui/ASR/ECAPA. Recorded in the design's
        # Known limitations. Closing it properly means recording
        # FootprintTable._key(...) (`qwen.1.7b.design` / `.mint` / `qwen.1.7b` /
        # `qwen`) in the ledger instead of the bare engine — out of scope here.
        steps.append(EvictStep("qwen.design", None, lambda: qwen.maybe_free_idle_design(0.0)))
        steps.append(EvictStep("qwen.base17", None, lambda: qwen.maybe_free_idle_base17(0.0)))
    if engine != "coqui":
        coqui = ENGINES.get("coqui")
        if isinstance(coqui, CoquiEngine) and _same_card(getattr(coqui, "_device", None), device_key):
            steps.append(EvictStep("coqui", "coqui", lambda: coqui.maybe_free_idle(_coqui_idle_ttl())))
    return steps
```

Update the `_placement = PlacementController(...)` construction to pass
`idle_evict_steps=_idle_evict_steps`.

- [ ] **Step 4: Drive the loop from the controller**

`PlacementController.__init__`: replace the `idle_evict` parameter with

```python
        idle_evict_steps: Optional[Callable[[str, str], list["EvictStep"]]] = None,
```
defaulting to `lambda device_key, engine: []`.

**Five test constructions pass the old keyword and will all `TypeError`:**
`tests/test_placement.py:57` (inside the `make(...)` helper the new tests use),
`:101`, `:132`, `:162`, `:242`. `make`'s own signature at `:50`
(`idle_evict=None`) changes too. Update all five plus the helper — the plan's
Files list names the file, this is the enumeration.

Add the shared driver:

```python
    def _evict_until(
        self, device_key: str, engine: str, fits: Callable[[], Any]
    ) -> Any:
        """Run eviction steps one at a time, re-probing after each, and stop the
        moment `fits()` reports success (#1920A).

        `fits` is the caller's own retry — `try_hold` for `reservation()` (which
        holds), `best_fit` for `admit()` (which does not) — so "enough freed" is
        decided by LIVE capacity, never by a boolean 'something was freed'.
        Returns whatever `fits()` returned on success, or None.

        A step that raises is skipped, not fatal: eviction is best-effort, and
        one engine's teardown failing must not deny the whole admission.
        """
        held_by = self.ledger.engines_holding(device_key)
        for step in self.idle_evict_steps(device_key, engine):
            if step.reserved_key is not None and step.reserved_key in held_by:
                # This engine's op is already admitted and holds VRAM for it
                # (#1920B) — the reservation spans the whole op, including the
                # window before its worker thread claims the in-flight counter.
                continue
            try:
                if not step.run():
                    continue
            except Exception:
                continue
            got = fits()
            if got is not None:
                return got
        return None
```

In `admit()`, replace the evict block with:

```python
        worst = self._worst_device_key(devices)
        if worst is not None:
            def _fits():
                probed = self.probe()
                return self.ledger.best_fit(
                    self._gpu_candidates(probed, constraint), peak, reserve_cap
                )

            key = self._evict_until(worst, engine, _fits)
            if key is not None:
                return {"device": key}
            worst = self._worst_device_key(self.probe())
```

In `reservation()`, replace the evict block with:

```python
        if held is None and not (cpu_capable and not heavy):
            worst = self._worst_device_key(devices)
            if worst is not None:
                def _fits():
                    probed = self.probe()
                    return self.ledger.try_hold(
                        self._gpu_candidates(probed, constraint), peak, reserve_cap, engine
                    )

                held = self._evict_until(worst, engine, _fits)
            if held is None:
                devices = self.probe()
```

(The trailing re-probe keeps the `noCapacity` payload's `deviceKey` honest after
a partial eviction.)

- [ ] **Step 5: Run to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest tests/test_placement.py tests/test_devices.py tests/test_coqui_idle_evict.py tests/test_asr_spk_idle_evict.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/
git commit -m "fix(sidecar): stop evicting once the starved request actually fits"
```

---

### Task 5: give `/api/sidecar/unload` its own timeout budget (#1921, server half)

**Files:**
- Modify: `server/src/routes/sidecar-health.ts:391-440`
- Test: `server/src/routes/sidecar-health.test.ts:649+`

- [ ] **Step 1: Write the failing test**

In the existing `describe('POST /api/sidecar/unload')` block:

**Two tests. The first is the cheap deterministic gate; write it first.**

```ts
  it('reports the unload budget, not the probe budget, when the sidecar never answers', async () => {
    /* Zero wall-clock, fully deterministic, and it pins the constant directly.
       Fails against the wrong implementation: the message quotes 2000ms. */
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    const res = await request(makeApp()).post('/api/sidecar/unload');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('90000ms');
    expect(res.body.error).not.toContain('2000ms');
  });

  it('waits past the 2s probe budget for an unload blocked on a forward', async () => {
    /* #1921: `CoquiEngine.unload()` waits for an in-flight forward, so a Stop
       pressed mid-render takes far longer than PROBE_TIMEOUT_MS. Before the fix
       this aborted at 2s and returned 503 while the model unloaded anyway a
       moment later — the user saw a failure for something that worked.

       The mock MUST honour `init.signal`. The route aborts via AbortController
       (sidecar-health.ts:411-412, :417); a mock that ignores the signal lets
       `controller.abort()` fire into the void, the promise resolves anyway, and
       the test passes against the UNFIXED 2s budget. That is the exact placebo
       shape this branch exists to stop shipping. */
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ status: 'idle' }), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                }),
              ),
            2_500,
          );
          init.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const res = await request(makeApp()).post('/api/sidecar/unload');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'idle' });
  }, 10_000);
```

**There is no `jsonResponse` helper in this file** — every existing mock inlines
`new Response(JSON.stringify(...), { status, headers })`, as above. The fetch
double is a bare `vi.fn()` (`sidecar-health.test.ts:40`, stubbed at `:45`), so
signal handling is entirely on you. **The file uses no fake timers**, so the
2.5 s wait is real; that is why the first test exists and carries the actual
gate. Do not introduce fake timers into this file just for this.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts -t "waits past"`
Expected: FAIL — 503.

- [ ] **Step 3: Implement**

Beside `LOAD_TIMEOUT_MS`:

```ts
/* `/unload` is not a probe. Since #1894 `CoquiEngine.unload()` waits for any
   in-flight forward before dropping the model, so a Stop pressed mid-render
   blocks for the length of that sentence. The 2s PROBE_TIMEOUT_MS aborted and
   returned 503 while the unload completed anyway a moment later — the user saw
   a failure for something that worked (#1921). Same budget as LOAD_TIMEOUT_MS,
   for the same reason: this is a model-lifecycle call, not a health check. */
const UNLOAD_TIMEOUT_MS = 90_000;
```

Use it for the unload route's `setTimeout(...)` and in its timeout message.

Then **rewrite the route's comment block** (lines ~391-403). It currently ends
*"That behaviour trade is filed separately; not changed here"* — which is now
false. Say instead that the budget matches `/load`'s, that the caller's contract
is "when this returns, the VRAM is free" (which the Analysing screen's auto-evict
depends on), and that a forward longer than 90 s still reports a timeout.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/sidecar-health.ts server/src/routes/sidecar-health.test.ts
git commit -m "fix(server): give /api/sidecar/unload its own 90s budget"
```

---

### Task 6: an `unloading` state on the model pill (#1921, UI half)

**Files:**
- Modify: `src/components/ModelControlPill.tsx`
- Modify: `src/lib/use-tts-lifecycle.ts` (`doStop`)
- Test: `src/components/ModelControlPill.test.tsx`
- Test: `src/lib/use-tts-lifecycle.test.ts` — it exists (400+ lines). **`:353`, in `'Kokoro pending state does not bleed into Coqui pill'`, asserts `expect(result.current.kokoro.state).toBe('idle')` immediately after `onStop()`. That becomes `'unloading'`.** Update the test's docstring alongside the assertion — it states the old semantics, so changing only the expected value leaves a comment that contradicts the code. A working precedent for asserting inside a pending window already lives at `:339-360`.

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders a Stopping state with the action disabled', () => {
  /* #1921: `doStop` used to flip the optimistic state straight to 'idle', so
     the pill read "Voice engine idle · Load model" while the model was still
     resident for up to a minute — and the Load button was live, inviting a load
     against a model that had not gone yet.

     Fails against the wrong implementation: with state='unloading' unhandled,
     actionFor() falls through and the button renders 'Load model', enabled. */
  render(<ModelControlPill kind="tts" state="unloading" onLoad={noop} onStop={noop} />);
  expect(screen.getByText(/stopping voice engine/i)).toBeInTheDocument();
  const button = screen.getByRole('button');
  expect(button).toBeDisabled();
});
```

Plus a `doStop` test asserting the pending state is `'unloading'` (not `'idle'`)
while `api.unloadSidecar` is in flight. Model the in-flight window with a
deferred promise — **assert during the pending window, not after**, or the test
passes against the unfixed code.

**And a third test, for the defect that makes the other two only half-true:**

```tsx
it('keeps the Stopping state across a /health poll tick', async () => {
  /* The poll runs on setInterval(probe, 30_000) (use-tts-lifecycle.ts:156) and
     EVERY resolution unconditionally clears all four pending overrides (:125-128,
     and again on reject at :133-136). `doStop` now awaits a call with a 90s
     budget — precisely the mid-render case — so at the 30s tick the probe lands,
     clears pendingCoqui, /health still reports modelLoaded: true, and the pill
     flips back to "Voice engine ready · Stop", ENABLED, while the unload is
     still blocked on the forward. Same lie as #1921, delayed by 30 seconds.

     Fails against the wrong implementation: without the in-flight guard the
     state is 'ready' after the tick. */
  // deferred unloadSidecar; call onStop(); advance fake timers past 30_000;
  // assert result.current.coqui.state is still 'unloading'; then resolve.
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/ModelControlPill.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ModelControlPill.tsx`:
- `export type ModelControlState = 'idle' | 'loading' | 'unloading' | 'ready' | 'streaming' | 'unreachable';`
- The header comment's state list gains: `` - `unloading`   — /unload is in flight → action: spinner, disabled. Since #1894 an unload waits for the in-flight forward, so this can last a whole sentence (#1921). ``
- `labelFor`: `if (state === 'unloading') return \`Stopping ${noun.toLowerCase()}…\`;`
- `actionFor`: `case 'unloading': return { label: 'Stopping…', handler: 'stop', disabled: true };`
- **`TONES: Record<ModelControlState, Tone>` at `ModelControlPill.tsx:85`** needs
  an `unloading` entry. Widening the union without it is a typecheck failure,
  and at runtime `tone.pill` throws before `actionFor` is ever reached. Mirror
  the `loading` entry.
- `labelFor`'s if-chain has no exhaustiveness check, so a missing branch falls
  silently through to `streaming`. Add the `unloading` branch explicitly.

`use-tts-lifecycle.ts` — in `doStop`:
- `setPending(engine, 'idle')` → `setPending(engine, 'unloading')`
- **Do NOT add a clear-on-success.** `doLoad` does not clear on success
  (`:245-259`) — it clears only on the error paths and relies on
  `setHealthProbeKey((k) => k + 1)` (`:259`) to re-run the effect, whose fresh
  probe clears all pendings in its `.then` (`:125-128`). `doStop` already does
  the same at `:280`. Clearing explicitly would drop the override before the new
  `/health` lands, so the pill renders from the stale `modelLoaded: true` and
  flashes "Voice engine ready · Stop" between "Stopping…" and idle.
- **Guard the poll's clear against an in-flight op** (the third test above). Add
  a `useRef<number>` counter incremented at the top of `doLoad` and `doStop` and
  decremented in a `finally`; check it is zero before the four `setPendingX(null)`
  calls in **both** the probe's `.then` (`:125-128`) and its `.catch`
  (`:133-136`). Without this the 90 s budget from Task 5 and the `'unloading'`
  state contradict each other after 30 seconds.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/components/ModelControlPill.test.tsx src/lib/ src/views/generation.test.tsx`
Expected: PASS. Also run `npx tsc --noEmit` — the widened union may force
exhaustive `switch`/`if` chains elsewhere; fix every one.

- [ ] **Step 5: Commit**

```bash
git add src/components/ModelControlPill.tsx src/components/ModelControlPill.test.tsx src/lib/use-tts-lifecycle.ts
git commit -m "fix(frontend): show a Stopping state while the voice engine unloads"
```

---

### Task 7: docs, release notes, acceptance

**Files:**
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`
- Modify: `docs/testing/onbox-acceptance-register.md` (row A20 criteria)
- Modify: `docs/superpowers/specs/2026-07-28-coqui-residency-eviction-design.md` (§6, the criteria home A20 points at)
- Modify: `docs/superpowers/specs/2026-07-28-sidecar-evict-hardening-design.md` (Ship notes)
- Check: `docs/wiki/Advanced-Settings.md` — only if a task added a registry knob (none should have)

- [ ] **Step 1: Release notes, both files**

`docs/release-notes-next.md` — one technical entry per issue, PR-refed
(`(#1917, PR #NNNN)` etc.). `RELEASE_NOTES.md` — ONE user-facing brand-voice line
in the in-progress version section at the top. The only user-visible change is
the Stop button: it now says "Stopping…" and waits, instead of reporting an
error and stopping anyway a minute later. The other three are invisible
correctness fixes — say so in the technical register, not in the user-facing one.

- [ ] **Step 2: Update A20's criteria, in both places it lives**

A20 currently asks the tester to *record what the Stop control reports* during a
render, because the behaviour was unresolved. It is resolved now. Update the row
in `docs/testing/onbox-acceptance-register.md` AND the matching criteria in the
predecessor spec's §6 so the two surfaces agree — that exact drift was a real
finding on #1924. The expected observation becomes: **Stop during an active
Coqui render shows "Stopping…", the button is disabled, and it completes without
an error banner.** Do NOT add a new row; do NOT change the row count.

Then run `npm run check:onbox-register` and confirm exit 0.

- [ ] **Step 3: The live HTML register**

The register's header records the `url` of the published HTML register. Because
this PR only edits an existing row's criteria (no add, no remove, no count
change), re-publish only if the criteria text is rendered there. **Read the
header, follow its instruction, and never publish to a fresh URL.** State in
your report which you did and why.

- [ ] **Step 4: Ship notes on this plan's spec**

Fill the new spec's Ship notes with the date and the merge SHA once known
(leave a `TBD` the controller replaces at merge time if it is not yet known).

- [ ] **Step 5: Commit**

```bash
git add docs/ RELEASE_NOTES.md
git commit -m "docs(docs): record the evict-hardening fixes and refresh A20's criteria"
```

---

## Verification before the PR

1. `npm run test:sidecar` — full sidecar battery (controller runs this).
2. `cd server && npm run test` — full server battery (controller runs this).
3. `npm test` — full frontend battery (controller runs this).
4. `npm run typecheck`.
5. `npm run check:onbox-register`.
6. `npm run verify:fast:branch`.
7. `npx madge --circular --extensions ts server/src` — still 15 cycles, no more.

## PR

Title: `fix(sidecar,server,frontend): harden the idle-evict lock and admission accounting`

Body must carry `Closes #1917`, `Closes #1918`, `Closes #1920`, `Closes #1921`
as literal lines (backtick-wrapped refs do NOT autoclose), the design-of-record
link, and a "Things a reviewer would otherwise have to rediscover" section
covering: the five-counter scope decision, the `lock_held` parameter and why not
`RLock`, why the Qwen evict steps carry `reserved_key=None`, and why option 1
(budget) beat option 3 (async ack) for #1921.
