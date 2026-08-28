# Coqui VRAM Idle-Eviction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the sidecar reclaim an idle, resident Coqui XTTS (~3 GB) when another op is starved for VRAM, instead of failing that op with `NoCapacityError` — and close the unguarded `unload()` race that makes any such eviction unsafe, in all three engines that have it (Coqui, Whisper/ASR, ECAPA).

**Architecture:** Extend the sidecar's existing idle-evict framework rather than adding Node-side machinery. `PlacementController.admit`/`reservation` already call `_idle_evict(device_key)` immediately before returning `noCapacity`, then re-probe and retry the fit. `CoquiEngine` gains the same `_synth_lock` + `maybe_free_idle(ttl)` discipline the two `QwenEngine` methods use, and `_idle_evict` gains a Coqui branch plus awareness of which engine is admitting (so a starved Coqui op never evicts the model it is about to reload). No Node-side eviction logic changes; the only Node edit is a deletion.

**Tech Stack:** Python 3.12 + FastAPI (`server/tts-sidecar/main.py`), pytest (`server/tts-sidecar/tests/`), TypeScript/Node (`server/src/`), Vitest.

**Spec:** [`docs/superpowers/specs/2026-07-28-coqui-residency-eviction-design.md`](../specs/2026-07-28-coqui-residency-eviction-design.md)

**Issue:** #1894 (and the Coqui Stop-button crash folded into its scope — see Task 1).

## Global Constraints

- **Branch:** cut `fix/sidecar-coqui-idle-evict` off latest `main` before Task 1. One branch for all tasks.
- **Never use `git commit --no-verify`.** If a hook fails, triage per CLAUDE.md's "Commit gate" rules.
- **`_synth_lock` is a non-reentrant `threading.Lock`.** Any method that already holds it MUST call `_drop_model_locked()`, never `unload()`. Violating this self-deadlocks the sidecar.
- **The TTL default must match in two places**, per the `srv-47 R2-A` invariant already pinned at `main.py:5178-5181`: `_COQUI_IDLE_TTL_DEFAULT` in `main.py` and `default:` on `sidecar.coquiIdleTtl` in `server/src/config/registry.ts`. Value: **30**.
- **`maybe_free_idle` must route through `_drop_model_locked()`** and must NOT null `self._tts` inline. Inline nulling skips `self._device = self._requested_device` (the #1730 gap-3 restore) and re-introduces a shipped bug. This is the single most important rule in this plan.
- **The reclaim (`gc.collect()` + `empty_cache()`) runs OUTSIDE the lock.** `_idle_evict` is called synchronously from `PlacementController.reservation.__enter__` on the **event loop**, and `main.py:5081-5082` states the principle the watchdogs follow: _"Each free runs in a worker thread … so the event loop and /health stay live."_ A multi-GB `gc.collect()` inline under the lock would stall the loop. This is why the teardown is split into `_drop_model_locked()` (fields, under the lock) and a caller-side reclaim, exactly as `QwenEngine.maybe_free_idle_design` does (`:3773-3788`).
- **The TOCTOU rule.** `_synth_in_flight` must be incremented and `_last_used` stamped **before** taking `_synth_lock`, and `synthesize` must **re-ensure the model under the lock**. Either half alone leaves the race open — `main.py:3835-3838` says so explicitly for Qwen: _"The timestamp alone is a TOCTOU … `_design_in_flight` + the re-ensure under the lock below close that race."_
- **Run sidecar tests with** `npm run test:sidecar` from the repo root (bootstraps/uses the venv at `server/tts-sidecar/.venv`). A single file: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/<file> -v`.
- **Do not add a background watchdog for Coqui.** Unlike Qwen design / Qwen 1.7B / ASR / ECAPA, Coqui gets the admission-path evict only. This is deliberate (spec §4.3) and is why its TTL default is 30 rather than their 120.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `server/tts-sidecar/main.py` | `CoquiEngine` lock + teardown split + `maybe_free_idle`; `_idle_evict` engine-awareness + Coqui branch; `_coqui_idle_ttl()` resolver | 1, 2, 3, 4 |
| `server/tts-sidecar/tests/test_coqui_idle_evict.py` | **New.** All Coqui lock + `maybe_free_idle` coverage | 1, 2 |
| `server/tts-sidecar/tests/test_devices.py` | Existing `_idle_evict` device-targeting tests — arity fixes + Coqui branch cases | 3, 4 |
| `server/tts-sidecar/tests/test_placement.py` | Existing `PlacementController` tests — arity fixes + the end-to-end admission case | 3, 4 |
| `server/src/config/registry.ts` | `sidecar.coquiIdleTtl` knob | 4 |
| `docs/wiki/Advanced-Settings.md` | Knob's user-facing row (§9) | 4 |
| `server/src/gpu/describe-vram-blockers.ts` + `.test.ts` | Drop the now-redundant Coqui blocker entry | 5 |
| `server/tts-sidecar/tests/test_asr_spk_idle_evict.py` | **New.** ASR + ECAPA unload/forward race | 6 |
| `docs/features/249-fs60-xtts-language-eligibility.md` | Cross-reference the new reclaim | 7 |
| `docs/testing/onbox-acceptance-register.md` | New row grouped with A19 | 7 |
| `docs/release-notes-next.md`, `RELEASE_NOTES.md` | Shipping notes | 7 |

Task 6 also touches `main.py` (`WhisperEngine`, `SpeakerEngine`), but in a region no other task goes near — it is independent of Tasks 1-5 and could ship alone.

---

### Task 1: Guard `CoquiEngine.unload()` against a concurrent synth

Fixes a live, user-reachable crash: `unload()` nulls `self._tts` with no lock while `synthesize()` dereferences it, and `/unload` (the UI Stop button) and `/synthesize` both run on the worker pool via `asyncio.to_thread` — so they genuinely overlap. Ships standalone value; everything after depends on it.

**Files:**
- Modify: `server/tts-sidecar/main.py` — `CoquiEngine.__init__` (~`:1148`), `unload` (`:1327-1362`), `synthesize` (`:1364`)
- Test: `server/tts-sidecar/tests/test_coqui_idle_evict.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `CoquiEngine._synth_lock: threading.Lock`, `CoquiEngine._synth_in_flight: int`, `CoquiEngine._last_used: float`, `CoquiEngine._drop_model_locked() -> tuple[bool, Any]` (caller must hold `_synth_lock`; returns `(dropped, torch_module)`), `CoquiEngine._reclaim_after_drop(torch_module: Any) -> None` (caller must NOT hold the lock). Task 2 consumes all five.

- [ ] **Step 1: Write the failing test**

Create `server/tts-sidecar/tests/test_coqui_idle_evict.py`:

```python
"""CoquiEngine synth-lock + idle-evict (#1894).

The lock exists because /unload (the UI Stop button) and /synthesize both run
on the worker pool via asyncio.to_thread, so `unload()` could null `_tts` while
`synthesize()` was mid-forward -> AttributeError, a killed chapter.
"""
import importlib, os, sys, threading, time

import pytest  # for the xfail marker on the evict-gap test (removed in Task 2)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


class _FakeTts:
    """Stands in for the loaded XTTS model. `tts()` signals that it has entered
    the forward, then blocks until released — so a test can hold a forward open
    and race unload() against it deterministically, with no sleeps."""

    def __init__(self, entered=None, release=None):
        self.entered = entered
        self.release = release
        self.synthesizer = type("S", (), {"output_sample_rate": 24000})()

    def tts(self, text, speaker, language):
        if self.entered is not None:
            self.entered.set()
        if self.release is not None:
            self.release.wait(timeout=5)
        return [0.0, 0.1, -0.1]


def _loaded_coqui(monkeypatch, fake_tts):
    """A CoquiEngine with a fake model already 'loaded'. `_ensure_loaded` is
    neutered so no real XTTS is pulled. `_last_used` is stamped because a real
    load stamps it too (see Task 2) — leaving it 0.0 would make the engine look
    infinitely idle and mask TTL bugs."""
    eng = main.CoquiEngine()
    monkeypatch.setattr(eng, "_ensure_loaded", lambda model: None)
    eng._tts = fake_tts
    eng._speakers = ["Claribel Dervla"]
    eng._resolved_device = "cuda:0"
    eng._device = "cuda:0"
    eng._last_used = time.monotonic()
    return eng


def test_unload_waits_for_an_in_flight_synth(monkeypatch):
    """The regression test for the crash: unload() must not null `_tts` while a
    forward is running. Without the lock, `synthesize` raises AttributeError."""
    entered, release = threading.Event(), threading.Event()
    eng = _loaded_coqui(monkeypatch, _FakeTts(entered=entered, release=release))

    errors: list[BaseException] = []
    done = threading.Event()

    def run_synth():
        try:
            eng.synthesize("xtts", "Claribel Dervla", "hello")
        except BaseException as e:  # noqa: BLE001 - we assert on it
            errors.append(e)
        finally:
            done.set()

    t = threading.Thread(target=run_synth)
    t.start()
    # Wait for the forward to actually START rather than sleeping — a sleep
    # flakes on a loaded box, and if the synth hasn't entered yet then unload()
    # completes immediately and the assertion below fails for the wrong reason.
    assert entered.wait(timeout=5), "synth never entered the forward"

    unloaded = threading.Event()

    def run_unload():
        eng.unload()
        unloaded.set()

    u = threading.Thread(target=run_unload)
    u.start()
    # unload must be BLOCKED on the lock while the forward is open.
    assert not unloaded.wait(timeout=0.3), "unload() did not wait for the synth"

    release.set()
    t.join(timeout=5)
    u.join(timeout=5)

    assert errors == [], f"synth raised while unload raced it: {errors!r}"
    assert eng._tts is None  # the unload still happened, just afterwards


def test_synthesize_tracks_in_flight_and_last_used(monkeypatch):
    """`maybe_free_idle` (Task 2) fast-outs on these two fields, so the synth
    path has to maintain them."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    assert eng._synth_in_flight == 0

    before = time.monotonic()
    eng.synthesize("xtts", "Claribel Dervla", "hello")

    assert eng._synth_in_flight == 0  # decremented on the way out
    assert eng._last_used >= before


def test_synthesize_survives_an_evict_that_wins_the_ensure_gap(monkeypatch):
    """The OTHER interleaving, and the one the counter alone does not cover.

    `_ensure_loaded` runs outside the lock (a cold XTTS pull is ~90s and must
    not block the Stop button). If an admission-path evict frees the model in
    the gap between that ensure and the lock acquire, the forward must RELOAD
    rather than assert. This is why `synthesize` re-ensures under the lock —
    exactly what QwenEngine does at main.py:4439-4442."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._last_used = 0.0  # look infinitely idle so the evict will fire

    def ensure_then_evict(model):
        # Simulate the racing evict landing right after the caller's ensure.
        if eng._tts is None:
            eng._tts = _FakeTts()  # the "reload" a real _ensure_loaded performs
            eng._speakers = ["Claribel Dervla"]
            return
        eng.maybe_free_idle(30.0)

    monkeypatch.setattr(eng, "_ensure_loaded", ensure_then_evict)

    # Must not raise. The first ensure triggers the evict; the re-ensure under
    # the lock finds `_tts is None` and reloads.
    eng.synthesize("xtts", "Claribel Dervla", "hello")
    assert eng._tts is not None
```

**Note:** this third test calls `maybe_free_idle`, which Task 2 adds. Write it now but expect it to error with `AttributeError` until Task 2 lands — mark it `@pytest.mark.xfail(raises=AttributeError, strict=False)` for Task 1's commit and **remove the marker in Task 2 Step 3**. (Add `import pytest` to the test file's imports for this.) Leaving it unmarked would make Task 1 un-committable, which breaks the one-task-per-subagent gate.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_coqui_idle_evict.py -v`

Expected:
- `test_unload_waits_for_an_in_flight_synth` FAILS on the `assert not unloaded.wait(...)` line ("unload() did not wait for the synth") — nothing serializes them today.
- `test_synthesize_tracks_in_flight_and_last_used` FAILS with `AttributeError: 'CoquiEngine' object has no attribute '_synth_in_flight'`.
- `test_synthesize_survives_an_evict_that_wins_the_ensure_gap` reports **xfail** (it needs Task 2's `maybe_free_idle`).

- [ ] **Step 3: Add the lock and the tracking fields**

In `CoquiEngine.__init__`, immediately after `self._load_lock: asyncio.Lock = asyncio.Lock()`:

```python
        # Serialises the synth forward against unload() (#1894). A threading
        # .Lock, NOT the asyncio `_load_lock` above: both /synthesize and
        # /unload reach this class through `asyncio.to_thread`, i.e. on worker
        # threads, so an asyncio primitive would not serialise them. Mirrors
        # QwenEngine's `_synth_lock`. NON-REENTRANT — a holder must call
        # `_drop_model_locked()`, never `unload()`.
        self._synth_lock = threading.Lock()
        # Read lock-free by `maybe_free_idle` so a busy engine short-circuits
        # without blocking the admission path on a forward that may run for
        # seconds.
        self._synth_in_flight = 0
        self._last_used = 0.0
```

- [ ] **Step 4: Split the teardown into a locked drop + an unlocked reclaim**

Replace the whole of `unload` (`main.py:1327-1362`) with three methods. The split is two-way on purpose: the **field resets** must happen under the lock, but the **reclaim** must not — `_idle_evict` runs on the event loop, and `main.py:5081-5082` records the rule that these frees keep the loop live.

```python
    def unload(self) -> None:
        """Drop references to the loaded XTTS model and free GPU memory.
        Used by POST /unload when the UI's Stop button fires (or when the
        Analysing screen's Load button auto-evicts the TTS model to make
        room for the analyzer LLM). Idempotent — safe to call when nothing
        is loaded.

        Acquires `_synth_lock` so it cannot null `_tts` out from under an
        in-flight forward (#1894): the route offloads both this and
        /synthesize to the worker pool, so they genuinely overlap. MUST NOT
        be called while already holding `_synth_lock` — it is non-reentrant.
        Internal holders call `_drop_model_locked()` + `_reclaim_after_drop()`.
        """
        with self._synth_lock:
            dropped, torch_module = self._drop_model_locked()
        if dropped:
            self._reclaim_after_drop(torch_module)

    def _drop_model_locked(self) -> tuple[bool, Any]:
        """Reset every field the loaded model owns. CALLER MUST HOLD
        `_synth_lock`. Returns `(dropped, torch_module)` — the torch handle is
        returned rather than used here because the reclaim runs outside the
        lock (see `_reclaim_after_drop`).

        Split out (#1894) so `maybe_free_idle` reuses the FULL teardown rather
        than nulling `_tts` inline the way QwenEngine's
        `maybe_free_idle_design` does. Qwen can null inline because `_design`
        carries no paired state; Coqui's teardown also restores
        `self._device = self._requested_device` (the #1730 gap-3 fix), and
        skipping it would leave the next lazy /synthesize cold-loading onto
        the last admitted card, bypassing placement entirely.
        """
        if self._tts is None:
            return (False, None)
        torch_module = self._torch
        self._tts = None
        self._torch = None
        self._speakers = []
        self._resolved_device = "cpu"
        # Restore the env pref (#1730 gap 3): `_ensure_loaded` overwrote
        # `self._device` with the resolved card, so a later flag-off reload must
        # re-resolve from the ORIGINAL request (e.g. 'auto'), not the last card.
        self._device = self._requested_device
        self._use_half = False
        return (True, torch_module)

    def _reclaim_after_drop(self, torch_module: Any) -> None:
        """Host-RAM + VRAM reclaim for a model just dropped. MUST run with
        `_synth_lock` RELEASED — `gc.collect()` over a multi-GB torch graph is
        slow, and `_idle_evict` calls this path synchronously on the event
        loop, where a stall would freeze /health (main.py:5081-5082).
        """
        # Break the dropped model's reference cycles NOW (see
        # _reclaim_host_and_vram) — nn.Module graphs aren't refcount-freed, and
        # a lagging cyclic GC under load is what leaked host RAM (2026-05-30).
        gc.collect()
        # `torch.cuda.empty_cache()` releases the cached allocator blocks
        # back to the driver, making the freed VRAM visible to other processes
        # immediately — the whole point of the auto-evict-on-load flow.
        if torch_module is not None:
            try:
                if torch_module.cuda.is_available():
                    torch_module.cuda.empty_cache()
            except Exception as e:
                log.warning("torch.cuda.empty_cache() failed (%s) — model is dropped, VRAM will free on GC.", e)
        log.info("Coqui model unloaded.")
```

The bodies of `_drop_model_locked` and `_reclaim_after_drop` are the original `unload` body verbatim, split at the `gc.collect()` line (the old `main.py:1348`) — no logic changes, only the seam. `torch_module = self._torch` is the old `:1335`.

- [ ] **Step 5: Guard the forward in `synthesize()`**

`synthesize` currently opens:

```python
    def synthesize(self, model: str, voice: str, text: str, language: Optional[str] = None) -> SynthResult:
        self._ensure_loaded(model)
        assert self._tts is not None
        effective_language = language or self._language
```

Replace those first three body lines with:

```python
    def synthesize(self, model: str, voice: str, text: str, language: Optional[str] = None) -> SynthResult:
        # Load OUTSIDE the lock: a cold XTTS pull takes ~90s and holding
        # `_synth_lock` across it would block /unload (the Stop button) for
        # that whole window.
        self._ensure_loaded(model)
        # Claim BEFORE the acquire. The counter alone is NOT enough and neither
        # is the timestamp — main.py:3835-3838 spells out the same TOCTOU for
        # Qwen: an evict can read a stale `_last_used` and free the model in the
        # gap between the ensure above and the acquire below. The pair
        # (`_synth_in_flight` set here + the re-ensure under the lock) closes it.
        # Decremented in the finally so a failure can't leave the guard stuck.
        self._synth_in_flight += 1
        self._last_used = time.monotonic()
        try:
            with self._synth_lock:
                # Re-ensure under the lock: a concurrent /unload or admission
                # evict holds `_synth_lock` to null the model, so one ensured
                # before the lock can be gone in the gap. No-op on the warm
                # path (`_ensure_loaded` early-returns when `_tts` is set).
                self._ensure_loaded(model)
                return self._synthesize_locked(model, voice, text, language)
        finally:
            self._synth_in_flight -= 1
            self._last_used = time.monotonic()

    def _synthesize_locked(
        self, model: str, voice: str, text: str, language: Optional[str] = None
    ) -> SynthResult:
        """The forward itself. CALLER MUST HOLD `_synth_lock`.

        Binds `self._tts` to a local up front so the forward never re-reads an
        attribute a concurrent unload could null. The assert is a cheap
        invariant, NOT the race guard — the guard is the caller's
        `_synth_in_flight` claim plus its re-ensure under the lock.
        """
        tts = self._tts
        assert tts is not None
        effective_language = language or self._language
```

Then, in the remainder of the (now `_synthesize_locked`) body, replace **every** `self._tts` with the local `tts`. There are exactly three: `self._tts.tts(...)` in the fp16 autocast branch, `self._tts.tts(...)` in the else branch, and `self._tts.synthesizer` in the `sample_rate` line.

- [ ] **Step 6: Verify `time` and `threading` are imported**

Run: `grep -n "^import threading\|^import time" server/tts-sidecar/main.py`
Expected: both present (they already are — `QwenEngine` uses both). If either is missing, add it to the import block at the top of the file.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_coqui_idle_evict.py -v`
Expected: 2 passed, 1 xfailed (the evict-gap test, which unblocks in Task 2).

- [ ] **Step 8: Run the full sidecar suite for regressions**

Run: `npm run test:sidecar`
Expected: all pass. Pay attention to `test_concurrent_synthesis.py` — its Coqui case uses `_FakeCoquiEngine`, which overrides `synthesize` entirely, so it should be unaffected. If it fails, stop: it means something calls the real method concurrently and the throughput analysis in spec §4.1 needs revisiting.

- [ ] **Step 9: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_coqui_idle_evict.py
git commit -m "fix(sidecar): guard Coqui unload against an in-flight synth"
```

---

### Task 2: `CoquiEngine.maybe_free_idle(ttl_seconds)`

The reclaim method itself, not yet wired to anything. Modelled on `QwenEngine.maybe_free_idle_design` (`main.py:3752-3789`) but routed through `_drop_model_locked()` + `_reclaim_after_drop()`.

**Files:**
- Modify: `server/tts-sidecar/main.py` — `CoquiEngine`, immediately after `_reclaim_after_drop`
- Test: `server/tts-sidecar/tests/test_coqui_idle_evict.py`

**Interfaces:**
- Consumes: `_synth_lock`, `_synth_in_flight`, `_last_used`, `_drop_model_locked()`, `_reclaim_after_drop()` (Task 1).
- Produces: `CoquiEngine.maybe_free_idle(ttl_seconds: float) -> bool` — `True` only when it actually freed. Task 4 calls it.

- [ ] **Step 1: Write the failing tests**

Append to `server/tts-sidecar/tests/test_coqui_idle_evict.py`:

```python
def test_maybe_free_idle_noop_when_nothing_resident():
    eng = main.CoquiEngine()
    assert eng.maybe_free_idle(0.0) is False


def test_maybe_free_idle_does_not_free_a_freshly_loaded_model(monkeypatch):
    """A model loaded but never synthesised must NOT read as infinitely idle.
    `_last_used` starts at 0.0, so without a stamp at load time the engine is
    evictable the instant it finishes the ~90s load the user just paid for."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    assert eng.maybe_free_idle(30.0) is False
    assert eng._tts is not None


def test_maybe_free_idle_respects_the_ttl(monkeypatch):
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._last_used = time.monotonic()  # just used
    assert eng.maybe_free_idle(30.0) is False
    assert eng._tts is not None


def test_maybe_free_idle_frees_past_the_ttl(monkeypatch):
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._last_used = time.monotonic() - 120.0  # idle for two minutes
    assert eng.maybe_free_idle(30.0) is True
    assert eng._tts is None


def test_maybe_free_idle_skips_an_in_flight_synth(monkeypatch):
    """Fast-out must not block the admission path on a forward, and must not
    free a model that is mid-use."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._last_used = time.monotonic() - 120.0
    eng._synth_in_flight = 1
    assert eng.maybe_free_idle(30.0) is False
    assert eng._tts is not None


def test_maybe_free_idle_restores_the_device_preference(monkeypatch):
    """#1730 gap 3. `_ensure_loaded` overwrites `_device` with the ADMITTED
    card; only /load passes an override, so a lazy /synthesize reload reads
    `_device`. If the evict nulls `_tts` inline instead of running the full
    teardown, the next cold load pins itself to the last admitted card and
    bypasses placement entirely."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._requested_device = "auto"
    eng._device = "cuda:1"  # as _ensure_loaded would have left it
    eng._last_used = time.monotonic() - 120.0

    assert eng.maybe_free_idle(30.0) is True
    assert eng._device == "auto"
    assert eng._speakers == []
    assert eng._resolved_device == "cpu"
```

- [ ] **Step 2: Run to verify they fail**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_coqui_idle_evict.py -v -k maybe_free_idle`
Expected: 6 FAIL with `AttributeError: 'CoquiEngine' object has no attribute 'maybe_free_idle'`.

- [ ] **Step 3: Stamp `_last_used` when a model finishes loading**

`_ensure_loaded` (`main.py:1217-1325`) never touches `_last_used`, so a just-`/load`ed engine reads as idle since epoch. At the very end of `_ensure_loaded`, after the `self._speakers = …` assignment (`:1325`):

```python
        # A freshly loaded model has not been "idle since epoch": without this
        # stamp `maybe_free_idle` frees the model the user just spent ~90s
        # loading, before its first synth ever runs (#1894).
        self._last_used = time.monotonic()
```

- [ ] **Step 4: Implement `maybe_free_idle`**

Insert directly after `_reclaim_after_drop` in `CoquiEngine`:

```python
    def maybe_free_idle(self, ttl_seconds: float) -> bool:
        """Free the resident XTTS model when it has been idle longer than
        `ttl_seconds`. Returns True if it freed. Driven by `_idle_evict` on
        the admission path (#1894) — Coqui deliberately has NO background
        watchdog, unlike the Qwen/ASR/ECAPA idle-evicts, so this only ever
        runs when another op is genuinely starved for VRAM.

        The idle test is re-validated UNDER `_synth_lock` and skipped while a
        synth is in flight, so admission can never free the model out from
        under an active forward. Mirrors
        `QwenEngine.maybe_free_idle_design`, with one deliberate difference:
        it calls `_drop_model_locked()` rather than nulling `_tts` inline,
        because Coqui's teardown also restores `_device` (#1730 gap 3) and
        clears the cached speaker manifest.

        The reclaim runs AFTER the lock is released, and this method is called
        synchronously on the event loop by `_idle_evict` — see
        `_reclaim_after_drop`.
        """
        # Cheap, lock-free fast-outs first: nothing loaded, mid-forward, or
        # used recently. Skipping the lock here matters — a forward can run
        # for seconds and admission must not block on it.
        if self._tts is None or self._synth_in_flight > 0:
            return False
        if time.monotonic() - self._last_used <= ttl_seconds:
            return False
        # Re-validate under the lock: `synthesize` claims `_synth_in_flight`
        # and refreshes `_last_used` BEFORE taking the lock, so a check that
        # still finds it idle here cannot be racing a forward.
        with self._synth_lock:
            if self._tts is None or self._synth_in_flight > 0:
                return False
            if time.monotonic() - self._last_used <= ttl_seconds:
                return False
            dropped, torch_module = self._drop_model_locked()
        if not dropped:
            return False
        self._reclaim_after_drop(torch_module)
        return True
```

- [ ] **Step 5: Un-mark the Task 1 xfail**

Remove the `@pytest.mark.xfail(...)` decorator from `test_synthesize_survives_an_evict_that_wins_the_ensure_gap` — `maybe_free_idle` now exists, so it must pass for real. If it still fails, Task 1's TOCTOU fix is wrong: check that `_synth_in_flight` is incremented **before** the `with self._synth_lock:` and that `synthesize` re-ensures **inside** it.

- [ ] **Step 6: Run to verify they pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_coqui_idle_evict.py -v`
Expected: 9 passed, 0 xfailed.

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_coqui_idle_evict.py
git commit -m "feat(sidecar): add CoquiEngine.maybe_free_idle"
```

---

### Task 3: Make `_idle_evict` engine-aware (pure refactor)

No behaviour change — widens the seam so Task 4 can skip the Coqui branch when the admitting op is itself Coqui. Kept separate because it touches 8 existing test call sites and a reviewer should be able to confirm "nothing changed" independently of the new branch.

**Files:**
- Modify: `server/tts-sidecar/main.py` — `PlacementController.__init__` type (`:2287`), default lambda (`:2297`), `admit` call site (`:2375`), `reservation` call site (`:2450`), `_idle_evict` def (`:2544`)
- Modify: `server/tts-sidecar/tests/test_devices.py:360, 370, 381, 390, 392`
- Modify: `server/tts-sidecar/tests/test_placement.py:57, 101, 179`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `_idle_evict(device_key: str, engine: str) -> bool`; `PlacementController.idle_evict: Callable[[str, str], bool]`. Task 4 adds the Coqui branch inside it.

- [ ] **Step 1: Widen the injected callable's type and default**

At `main.py:2287`, change:

```python
        idle_evict: Optional[Callable[[str], bool]] = None,
```
to:
```python
        idle_evict: Optional[Callable[[str, str], bool]] = None,
```

At `:2297`, change:

```python
        self.idle_evict = idle_evict if idle_evict is not None else (lambda device_key: False)
```
to:
```python
        self.idle_evict = idle_evict if idle_evict is not None else (lambda device_key, engine: False)
```

- [ ] **Step 2: Pass the admitting engine at both call sites**

`admit` already has `engine: str` as its first parameter (`:2341`); `reservation` likewise (`:2423`). At `:2375` and `:2450`, change:

```python
        if worst is not None and self.idle_evict(worst):
```
to:
```python
        if worst is not None and self.idle_evict(worst, engine):
```

- [ ] **Step 3: Widen `_idle_evict`'s own signature**

At `:2544`:

```python
def _idle_evict(device_key: str, engine: str) -> bool:
```

Add to its docstring, after the existing "Device-targeted (#1721)" paragraph:

```
    `engine` is the ADMITTING op's engine. The engines evicted here are
    transient or secondary, so freeing them can never be self-defeating —
    except Coqui (#1894), which is a primary synth engine: a starved Coqui op
    must not evict the model it is about to reload. See its branch below.
```

- [ ] **Step 4: Fix the 8 existing test call sites**

In `server/tts-sidecar/tests/test_devices.py`, add the admitting engine to each direct call. Use `"qwen"` throughout — these tests assert device targeting, not engine identity:

- `:360` → `assert main._idle_evict("cuda:0", "qwen") is True`
- `:370` → `assert main._idle_evict("cuda:1", "qwen") is True`
- `:381` → `assert main._idle_evict("cuda:0", "qwen") is True  # qwen still freed`
- `:390` → `assert main._idle_evict("cuda:1", "qwen") is False  # nothing on card 1`
- `:392` → `assert main._idle_evict("cuda:0", "qwen") is True`

In `server/tts-sidecar/tests/test_placement.py`, widen the three injected doubles:

- `:57` (inside `make`) → `idle_evict=idle_evict or (lambda dk, eng: False),`
- `:101` (inside `test_idle_evict_then_place`) → `idle_evict=lambda dk, eng: (ledger.release(tok) or True),`
- `:179` → same widening; add the second parameter to whatever lambda is there.

- [ ] **Step 5: Run both test files to verify nothing changed**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_devices.py server/tts-sidecar/tests/test_placement.py -v`
Expected: all pass. This is a pure refactor — a failure means a call site was missed.

- [ ] **Step 6: Confirm no call site was missed**

Run: `grep -rn "idle_evict" server/tts-sidecar/`
Expected: every call passes two arguments, and every lambda takes two parameters. A one-arg survivor will `TypeError` only on the path that reaches it, which tests may not cover.

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_devices.py server/tts-sidecar/tests/test_placement.py
git commit -m "refactor(sidecar): pass the admitting engine to _idle_evict"
```

---

### Task 4: Wire Coqui into `_idle_evict`, behind a tunable TTL

The feature lands here. Includes the registry knob because `_idle_evict` is what resolves the TTL.

**Files:**
- Modify: `server/tts-sidecar/main.py` — `_idle_evict` (`:2544`); new `_COQUI_IDLE_TTL_DEFAULT` + `_coqui_idle_ttl()` near the other TTL resolvers (~`:5175`)
- Modify: `server/src/config/registry.ts` — after the `sidecar.spkIdleTtl` entry (~`:705-712`)
- Modify: `docs/wiki/Advanced-Settings.md` — §9 "GPU arbitration, memory & lifecycle"
- Test: `server/tts-sidecar/tests/test_devices.py`, `server/tts-sidecar/tests/test_placement.py`

**Interfaces:**
- Consumes: `CoquiEngine.maybe_free_idle` (Task 2), `_idle_evict(device_key, engine)` (Task 3).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

In `server/tts-sidecar/tests/test_devices.py`, extend the fake wiring. Add this class next to `_FakeEvictSingleton`:

```python
class _FakeEvictCoqui:
    """Matches CoquiEngine's residency surface for _idle_evict: a `_device`
    attribute and a `maybe_free_idle(ttl)` that reports it freed."""

    def __init__(self, device):
        self._device = device
        self.freed = 0
        self.ttls = []

    def maybe_free_idle(self, ttl_seconds):
        self.freed += 1
        self.ttls.append(ttl_seconds)
        return True
```

Extend `_wire_evict_engines` to register it:

```python
def _wire_evict_engines(monkeypatch, qwen_dev, asr_dev, spk_dev, coqui_dev="cpu"):
    qwen = _FakeEvictQwen(qwen_dev)
    asr = _FakeEvictSingleton("_device", asr_dev)
    spk = _FakeEvictSingleton("device", spk_dev)
    coqui = _FakeEvictCoqui(coqui_dev)
    monkeypatch.setitem(main.ENGINES, "qwen", qwen)
    monkeypatch.setitem(main.ENGINES, "coqui", coqui)
    monkeypatch.setattr(main, "ASR", asr)
    monkeypatch.setattr(main, "SPK", spk)
    return qwen, asr, spk, coqui
```

Update the four existing `_wire_evict_engines(...)` unpackings in that file to take the fourth value (`qwen, asr, spk, coqui = ...`). Their existing assertions are unchanged — the default `coqui_dev="cpu"` keeps Coqui out of every one of them.

Then add:

```python
def test_idle_evict_frees_an_idle_coqui_on_the_target_card(monkeypatch):
    """#1894 — a starved non-Coqui op reclaims a resident, idle XTTS."""
    _q, _a, _s, coqui = _wire_evict_engines(monkeypatch, "cpu", "cpu", "cpu", coqui_dev="cuda:0")
    assert main._idle_evict("cuda:0", "qwen") is True
    assert coqui.freed == 1
    assert coqui.ttls == [main._coqui_idle_ttl()]


def test_idle_evict_skips_coqui_on_another_card(monkeypatch):
    _q, _a, _s, coqui = _wire_evict_engines(monkeypatch, "cpu", "cpu", "cpu", coqui_dev="cuda:1")
    assert main._idle_evict("cuda:0", "qwen") is False
    assert coqui.freed == 0


def test_idle_evict_never_evicts_coqui_for_a_coqui_op(monkeypatch):
    """Coqui is a PRIMARY engine, unlike the transient models beside it here:
    evicting it for a starved Coqui op would unload the very model that op is
    about to reload. Admission gives a resident engine no free pass, so this
    is reachable."""
    _q, _a, _s, coqui = _wire_evict_engines(monkeypatch, "cpu", "cpu", "cpu", coqui_dev="cuda:0")
    assert main._idle_evict("cuda:0", "coqui") is False
    assert coqui.freed == 0
```

And the TTL resolver's own contract:

```python
def test_coqui_idle_ttl_defaults_and_floors(monkeypatch):
    monkeypatch.delenv("COQUI_IDLE_TTL", raising=False)
    assert main._coqui_idle_ttl() == 30.0
    monkeypatch.setenv("COQUI_IDLE_TTL", "90")
    assert main._coqui_idle_ttl() == 90.0
    monkeypatch.setenv("COQUI_IDLE_TTL", "1")  # below the 5s floor -> default
    assert main._coqui_idle_ttl() == 30.0
    monkeypatch.setenv("COQUI_IDLE_TTL", "not-a-number")
    assert main._coqui_idle_ttl() == 30.0
```

In `server/tts-sidecar/tests/test_placement.py`, add the end-to-end case beside `test_idle_evict_then_place`:

```python
def test_starved_qwen_admits_after_coqui_is_evicted():
    """#1894 end to end at the placement seam: an op that would have been told
    `noCapacity` is admitted once the idle Coqui hold is released."""
    devices = [dev(free=8000)]
    ledger = main.ReservationLedger()
    coqui_hold = ledger.hold("cuda:0", 3000)
    fp = type("F", (), {"peak_mb": lambda *_: 5600, "record": lambda *_: None})()
    evicted = []

    def evict(device_key, engine):
        if engine == "coqui":
            return False
        evicted.append((device_key, engine))
        ledger.release(coqui_hold)
        return True

    pc = main.PlacementController(
        probe=lambda: devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict=evict,
        is_resident=lambda e: None,
    )
    assert pc.admit("qwen", "q", {}, False, True)["device"] == "cuda:0"
    assert evicted == [("cuda:0", "qwen")]
```

- [ ] **Step 2: Run to verify they fail**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_devices.py server/tts-sidecar/tests/test_placement.py -v`

Expected — and **only two of the five new cases fail**, which is correct, not a deviation from TDD:

| Test | Before Step 4 | Why |
|---|---|---|
| `test_idle_evict_frees_an_idle_coqui_on_the_target_card` | **FAIL** | asserts `is True`; no branch exists |
| `test_coqui_idle_ttl_defaults_and_floors` | **FAIL** | `AttributeError: module 'main' has no attribute '_coqui_idle_ttl'` |
| `test_idle_evict_skips_coqui_on_another_card` | PASS | asserts `is False` / `freed == 0`, which is also true with no branch |
| `test_idle_evict_never_evicts_coqui_for_a_coqui_op` | PASS | same shape |
| `test_starved_qwen_admits_after_coqui_is_evicted` | PASS | injects its own `evict`; it pins the Task 3 signature, not the branch |

The three that pass early are guard tests — they exist to stay green *after* Step 4, proving the branch doesn't over-trigger. Note the module is imported as bare `main` in this suite, so the error names `'main'`, not `'tts_sidecar.main'`.

- [ ] **Step 3: Add the TTL resolver**

In `main.py`, immediately after `_spk_idle_ttl()` (~`:5191`):

```python
# Default seconds of Coqui inactivity before an ADMISSION-PATH evict may free
# the resident XTTS model (#1894). Override via COQUI_IDLE_TTL. Must match the
# registry sidecar.coquiIdleTtl default.
#
# 30, not the 120 its neighbours use, because Coqui deliberately has NO
# background watchdog: those TTLs answer "how long before we reclaim
# proactively", while this one only answers "was this in use just now", and it
# is consulted solely when another op is already starved. At 120 the lever
# would refuse in most real chapter gaps and the starved op would fail instead.
_COQUI_IDLE_TTL_DEFAULT = 30.0


def _coqui_idle_ttl() -> float:
    """Resolve COQUI_IDLE_TTL (seconds) with a safe default + 5 s floor —
    mirrors `_spk_idle_ttl`. Too small and a mixed-engine book evicts XTTS
    between groups and pays the ~90 s reload; too large and the lever declines
    while a render fails for want of the VRAM."""
    try:
        ttl = float(os.environ.get("COQUI_IDLE_TTL", _COQUI_IDLE_TTL_DEFAULT))
    except (TypeError, ValueError):
        return _COQUI_IDLE_TTL_DEFAULT
    return ttl if ttl >= 5.0 else _COQUI_IDLE_TTL_DEFAULT
```

- [ ] **Step 4: Add the Coqui branch to `_idle_evict`**

**Replace line `main.py:2580`** — the existing bare `    return freed` that closes `_idle_evict` — with the block below. Do not insert *before* it, or you end up with two `return freed` statements and an unreachable branch:

```python
    # Coqui (#1894). Unlike everything above, this is a PRIMARY synth engine —
    # so it is skipped when the admitting op is itself Coqui (evicting would
    # unload the model that op is about to reload), and it uses a real idle TTL
    # rather than the 0.0 the transient models take.
    if engine != "coqui":
        coqui = ENGINES.get("coqui")
        if coqui is not None and _same_card(getattr(coqui, "_device", None), device_key):
            try:
                freed = coqui.maybe_free_idle(_coqui_idle_ttl()) or freed
            except Exception:
                pass
    return freed
```

- [ ] **Step 5: Run to verify they pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_devices.py server/tts-sidecar/tests/test_placement.py -v`
Expected: all pass.

- [ ] **Step 6: Add the registry knob**

In `server/src/config/registry.ts`, directly after the `sidecar.spkIdleTtl` entry:

```ts
  {
    key: 'sidecar.coquiIdleTtl',
    env: 'COQUI_IDLE_TTL',
    group: 'gpu-lifecycle',
    label: 'Coqui (XTTS) idle TTL (s)',
    help: 'Seconds of Coqui inactivity before a VRAM-starved operation may reclaim the resident XTTS model (~3 GB). Unlike the other idle TTLs there is no background watchdog — this only ever fires when another operation would otherwise fail for want of VRAM. Raise it if a mixed-engine book keeps reloading XTTS between chapters (a reload costs ~90s); lower it if renders still fail while an idle Coqui is loaded. Values below 5 fall back to the default (30) to avoid reload thrash.',
    type: 'integer', min: 0,
    default: 30, // ← _COQUI_IDLE_TTL_DEFAULT in tts-sidecar/main.py
    apply: 'restart-sidecar', risk: 'high',
  },
```

- [ ] **Step 7: Sync the env example and verify**

Run: `npm run config:sync && npm run config:check`
Expected: `config:check` exits 0. `server/.env.example` should now carry a `COQUI_IDLE_TTL` line.

- [ ] **Step 8: Add the wiki row**

In `docs/wiki/Advanced-Settings.md`, §9 "GPU arbitration, memory & lifecycle" (starts at `:260`), add a row to that section's knob table. §9 uses the `| Knob | What it does | Default | Range | Apply | Risk |` header, renders the Apply cell with a middot (`restart · sidecar`), and keeps every "What it does" cell to one terse clause — match that, not the registry's `help` prose:

```
| Coqui (XTTS) idle TTL (s) | Idle secs before a VRAM-starved op may reclaim resident XTTS (~3GB); no watchdog | 30 | integer, min 0 | restart · sidecar | high |
```

- [ ] **Step 9: Run the sidecar + server suites**

Run: `npm run test:sidecar`
Expected: all pass.

Run: `cd server && npm run test -- config` then return to the repo root.
Expected: registry/config tests pass.

- [ ] **Step 10: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/ server/src/config/registry.ts server/.env.example docs/wiki/Advanced-Settings.md
git commit -m "feat(sidecar,server): reclaim an idle Coqui when an op is VRAM-starved"
```

---

### Task 5: Drop the now-redundant Coqui VRAM-blocker entry

`describe-vram-blockers.ts` exists to name models "the USER controls **and that admission deliberately will not auto-evict**." Coqui no longer qualifies.

**Files:**
- Modify: `server/src/gpu/describe-vram-blockers.ts` — header comment, `coquiLoaded` branch (`:35-37`)
- Modify: `server/src/gpu/describe-vram-blockers.test.ts` — `:6`, `:8`, `:25`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Update the tests first**

Open `server/src/gpu/describe-vram-blockers.test.ts`. The case at `:6` asserts a Coqui blocker is returned and `:25` asserts `{coquiLoaded: true, kokoroLoaded: true}` yields 2 entries. Rewrite them to the new contract:

```ts
  it('does not list Coqui — admission auto-evicts an idle one (#1894)', () => {
    expect(describeVramBlockers({ coquiLoaded: true })).toEqual([]);
  });
```

and change the two-blocker case to expect 1:

```ts
    expect(describeVramBlockers({ coquiLoaded: true, kokoroLoaded: true })).toHaveLength(1);
```

Keep every Kokoro assertion exactly as it is — Kokoro is deliberately still listed.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/gpu/describe-vram-blockers.test.ts`
Expected: FAIL — the Coqui entry is still returned.

- [ ] **Step 3: Remove the entry**

In `server/src/gpu/describe-vram-blockers.ts`, delete:

```ts
  if (health.coquiLoaded) {
    out.push({ model: 'Coqui XTTS', remedy: 'Use its Stop button, at the top of the window.' });
  }
```

Leave `coquiLoaded?: boolean` on `VramBlockerHealth` — `capacity-retry.ts:95` still passes it, and removing it would be a wider change than this task.

- [ ] **Step 4: Update the file header**

Replace `describe-vram-blockers.ts:5-17` — i.e. **both** remaining paragraphs, from `A resident Qwen base is excluded on purpose:` through `...the actionable fix names the setting instead.` Replacing only the first sentence leaves the second paragraph still explaining how Coqui's remedy differs from Kokoro's, for an entry that no longer exists.

Keep the #1839 finding-5 clause intact — it is live reasoning about the Qwen exclusion, unrelated to this change:

```
   A resident Qwen base is excluded on purpose: evict-idle-tts.ts already frees
   an idle one, so naming it here would be noise on top of an action already
   taken — and (since finding 5) that holds regardless of whether the blocked
   op is itself Qwen or a non-Qwen engine (Coqui/Kokoro): evictIdleQwenBase now
   reclaims BOTH idle Qwen tiers for a non-Qwen op, not just the one tier a
   Qwen op's own elevate-only rule would free. Coqui is excluded for the same
   reason since #1894 — the sidecar's admission path reclaims an idle XTTS
   before it ever reports noCapacity.

   Coqui's exclusion is a deliberate trade, not a clean win: when the evict
   DECLINES (Coqui mid-forward for a sibling chapter) the user loses the one
   actionable line this list would have given them. Accepted because pressing
   Stop at that moment would kill a live render — the honest remedy there is
   "wait", and an entry advising a destructive action is worse than no entry.

   Kokoro stays listed. It has a Stop pill reachable wherever it's resident
   (the top bar / global TTS notice banner — src/components/tts-notice-banner
   .tsx), but stopping it only frees the VRAM until the sidecar next restarts,
   because it's the eagerly-resident fallback gated by the "Preload Kokoro at
   startup" setting — so the actionable fix names the setting instead.
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd server && npx vitest run src/gpu/describe-vram-blockers.test.ts src/gpu/capacity-retry.test.ts`
Expected: all pass. `capacity-retry.test.ts` contains no Coqui reference, so it should be untouched — it is run here only to confirm the `NoCapacityError` message path still behaves with a shorter blocker list.

**Do not "fix" these four files** — they construct the `{ model: 'Coqui XTTS', remedy: 'Use its Stop button, at the top of the window.' }` literal themselves and pass it into `NoCapacityError` or a mock, never calling `describeVramBlockers`: `server/src/tts/tts-errors.test.ts:7,11`, `server/src/tts/design-voice-core.test.ts:186`, `server/src/routes/voice-sample.test.ts:481,490`, `server/src/routes/qwen-voice.test.ts:1255`. They stay green and need no change. They do now encode a string the product can no longer emit, so **note that in the PR body** (Task 6 Step 6) rather than silently leaving a trap for the next reader.

- [ ] **Step 6: Commit**

```bash
git add server/src/gpu/describe-vram-blockers.ts server/src/gpu/describe-vram-blockers.test.ts
git commit -m "fix(server): stop naming Coqui as a VRAM blocker admission now evicts"
```

---

### Task 6: Close the same race in `WhisperEngine` and `SpeakerEngine`

ASR and ECAPA have the identical unguarded-unload defect Task 1 fixed in Coqui — and unlike Coqui, **they are already driven by `_idle_evict(0.0)` today** (`main.py:2572`, `:2577`), so the race is live right now, not merely enabled by this branch.

It is a *smaller* fix than Coqui's: both engines already own an `_infer_lock` (`:4785`, `:4938`) and already hold it across their forward. Their `unload()` simply never acquires it.

**Files:**
- Modify: `server/tts-sidecar/main.py` — `WhisperEngine.__init__` (~`:4785`), `transcribe` (`:4867-4872`), `unload` (`:4902-4910`), `maybe_free_idle` (`:4913-4921`); `SpeakerEngine.__init__` (~`:4938`), `embed` (`:4990-5001`), `unload` (`:5005-5013`), `maybe_free_idle` (`:5016-5023`)
- Test: `server/tts-sidecar/tests/test_asr_spk_idle_evict.py` (create)

**Interfaces:**
- Consumes: nothing from Tasks 1-5 (deliberately independent — this task could ship alone).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Create `server/tts-sidecar/tests/test_asr_spk_idle_evict.py`:

```python
"""ASR + ECAPA unload/infer race (#1894, found during its review).

Both engines hold `_infer_lock` across their forward but their `unload()`
never acquires it, and `maybe_free_idle` calls `unload()` directly. Since both
are already driven by `_idle_evict(0.0)`, an admission-path evict can null the
model mid-forward. Same defect the Coqui work fixed, one layer over.
"""
import importlib, os, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


def test_asr_unload_waits_for_an_in_flight_transcribe(monkeypatch):
    entered, release = threading.Event(), threading.Event()

    class _FakeModel:
        def transcribe(self, audio, **kw):
            entered.set()
            release.wait(timeout=5)
            return ([], type("I", (), {"language": "en"})())

    eng = main.WhisperEngine()
    monkeypatch.setattr(eng, "_ensure_loaded", lambda device=None: None)
    monkeypatch.setattr(eng, "_pcm_to_float32_16k", lambda pcm, sr: [0.0])
    eng._model = _FakeModel()
    eng._last_used = time.monotonic()

    errors: list[BaseException] = []

    def run():
        try:
            eng.transcribe(b"\x00\x00", 16000)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    t = threading.Thread(target=run)
    t.start()
    assert entered.wait(timeout=5), "transcribe never entered the forward"

    freed = threading.Event()

    def run_unload():
        eng.unload()
        freed.set()

    u = threading.Thread(target=run_unload)
    u.start()
    assert not freed.wait(timeout=0.3), "unload() did not wait for the forward"

    release.set()
    t.join(timeout=5)
    u.join(timeout=5)
    assert errors == [], f"transcribe raised while unload raced it: {errors!r}"
    assert eng._model is None


def test_asr_maybe_free_idle_skips_an_in_flight_transcribe(monkeypatch):
    """The fast-out must exist, or admission blocks on the whole forward."""
    eng = main.WhisperEngine()
    eng._model = object()
    eng._last_used = time.monotonic() - 600.0  # long idle
    eng._infer_in_flight = 1
    assert eng.maybe_free_idle(120.0) is False
    assert eng._model is not None


def test_spk_unload_waits_for_an_in_flight_embed(monkeypatch):
    entered, release = threading.Event(), threading.Event()

    class _FakeEncoder:
        def encode_batch(self, t):
            entered.set()
            release.wait(timeout=5)
            import numpy as np
            return _FakeOut(np.ones((1, 4), dtype="float32"))

    class _FakeOut:
        def __init__(self, arr):
            self._arr = arr

        def squeeze(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            return self._arr.squeeze()

        def astype(self, dt):
            return self._arr.squeeze().astype(dt)

    eng = main.SpeakerEngine()
    eng._model = _FakeEncoder()
    eng._last_used = time.monotonic()

    errors: list[BaseException] = []

    def run():
        try:
            eng.embed(b"\x00\x00" * 160, 16000)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    t = threading.Thread(target=run)
    t.start()
    assert entered.wait(timeout=5), "embed never entered the forward"

    freed = threading.Event()

    def run_unload():
        eng.unload()
        freed.set()

    u = threading.Thread(target=run_unload)
    u.start()
    assert not freed.wait(timeout=0.3), "unload() did not wait for the forward"

    release.set()
    t.join(timeout=5)
    u.join(timeout=5)
    assert errors == [], f"embed raised while unload raced it: {errors!r}"
    assert eng._model is None


def test_spk_maybe_free_idle_skips_an_in_flight_embed(monkeypatch):
    eng = main.SpeakerEngine()
    monkeypatch.setattr(main, "_parse_device", lambda d: ("cuda", 0))
    eng._model = object()
    eng._last_used = time.monotonic() - 600.0
    eng._infer_in_flight = 1
    assert eng.maybe_free_idle(120.0) is False
    assert eng._model is not None
```

- [ ] **Step 2: Run to verify they fail**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_asr_spk_idle_evict.py -v`
Expected: the two `unload_waits` tests FAIL on `assert not freed.wait(...)` (nothing serializes them); the two `maybe_free_idle` tests FAIL because `_infer_in_flight` does not exist and the model is freed anyway.

- [ ] **Step 3: Add the in-flight counters**

In `WhisperEngine.__init__`, beside `self._infer_lock = threading.Lock()` (`:4785`):

```python
        # Claimed BEFORE `_infer_lock` so `maybe_free_idle` can fast-out
        # without blocking the admission path on a whole forward (#1894).
        self._infer_in_flight = 0
```

Add the identical two lines to `SpeakerEngine.__init__`, beside `:4938`.

- [ ] **Step 4: Claim the counter around each forward**

`WhisperEngine.transcribe` currently reads:

```python
        self._ensure_loaded(device=device)
        assert self._model is not None
        audio = self._pcm_to_float32_16k(pcm, sample_rate)
        with self._infer_lock:
            self._last_used = time.monotonic()
            segments, info = self._model.transcribe(
```

Change it to claim before the lock and re-ensure inside it — the same pair Task 1 applies to Coqui, for the same reason (`main.py:3835-3838`):

```python
        self._ensure_loaded(device=device)
        audio = self._pcm_to_float32_16k(pcm, sample_rate)
        self._infer_in_flight += 1
        self._last_used = time.monotonic()
        try:
            with self._infer_lock:
                # Re-ensure under the lock: an idle-evict holds `_infer_lock`
                # to null the model, so one ensured before the lock can be gone
                # in the gap. No-op on the warm path.
                self._ensure_loaded(device=device)
                model = self._model
                assert model is not None
                self._last_used = time.monotonic()
                segments, info = model.transcribe(
```

…and the rest of the `with` block is unchanged except that `self._model` becomes the local `model`. Close the `try` with:

```python
        finally:
            self._infer_in_flight -= 1
            self._last_used = time.monotonic()
```

placed after the `with` block ends (i.e. wrapping only the locked section, leaving the post-processing that builds `text`/`words` outside).

`SpeakerEngine.embed` gets the same treatment, with one difference: its `ensure_loaded` is **async**, so it cannot re-ensure under the lock. Re-check and raise the documented precondition instead — the counter is what actually closes the race:

```python
    def embed(self, pcm: bytes, sample_rate: int) -> list[float]:
        if self._model is None:
            raise RuntimeError("call await ensure_loaded() before embed()")
        import torch
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if sample_rate != self.TARGET_SR:  # numpy resample (no torchaudio dep)
            n = int(round(len(audio) * self.TARGET_SR / sample_rate))
            audio = np.interp(np.linspace(0, len(audio), n, endpoint=False),
                              np.arange(len(audio)), audio).astype(np.float32)
        t = torch.from_numpy(audio).unsqueeze(0)
        self._infer_in_flight += 1
        self._last_used = time.monotonic()
        try:
            with self._infer_lock, torch.no_grad():
                # `ensure_loaded` is async here, so unlike WhisperEngine we
                # cannot reload under the lock — re-check and surface the
                # documented precondition. The `_infer_in_flight` claim above
                # is what actually stops an idle-evict getting here (#1894).
                model = self._model
                if model is None:
                    raise RuntimeError("model was unloaded during embed()")
                emb = model.encode_batch(t).squeeze().cpu().numpy().astype(np.float32)
        finally:
            self._infer_in_flight -= 1
            self._last_used = time.monotonic()
        norm = float(np.linalg.norm(emb))
        return (emb / norm if norm > 0 else emb).tolist()
```

- [ ] **Step 5: Make `unload()` acquire the lock, with the reclaim outside it**

Both `unload()`s currently null the model and call `_reclaim_host_and_vram()` with no lock. Give each the same locked-drop / unlocked-reclaim split Task 1 uses on Coqui, and for the same reason — `_idle_evict` runs on the event loop (`main.py:5081-5082`).

`WhisperEngine.unload`:

```python
    def unload(self) -> bool:
        """Drop the model + reclaim. Idempotent. Returns True iff a model was
        actually freed (so the watchdog can log only real frees).

        Acquires `_infer_lock` so it cannot null the model out from under an
        in-flight transcribe (#1894). The reclaim runs after the lock is
        released — this is reached from `_idle_evict` on the event loop.
        """
        with self._infer_lock:
            if self._model is None:
                return False
            self._model = None
        _reclaim_host_and_vram()
        log.info("Whisper ASR model unloaded.")
        return True
```

`SpeakerEngine.unload` is identical apart from its log line (`"ECAPA speaker model unloaded."`).

- [ ] **Step 6: Give both `maybe_free_idle`s the in-flight fast-out**

`WhisperEngine.maybe_free_idle` — add the counter check to the existing guards:

```python
        if self._model is None or self._infer_in_flight > 0:
            return False
```

Same edit in `SpeakerEngine.maybe_free_idle`, keeping its existing cuda-only guard first:

```python
        if _parse_device(self.device)[0] != "cuda" or self._model is None:
            return False
        if self._infer_in_flight > 0:
            return False
```

- [ ] **Step 7: Run to verify they pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_asr_spk_idle_evict.py -v`
Expected: 4 passed.

- [ ] **Step 8: Run the full sidecar suite**

Run: `npm run test:sidecar`
Expected: all pass. Watch `test_transcribe_embed_admission.py` and any ASR/SPK test that constructs these engines directly — a missed `_infer_in_flight` initialiser surfaces there as an `AttributeError`.

- [ ] **Step 9: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_asr_spk_idle_evict.py
git commit -m "fix(sidecar): guard ASR and ECAPA unloads against an in-flight forward"
```

---

### Task 7: Documentation, on-box acceptance, release notes

**Files:**
- Modify: `docs/features/249-fs60-xtts-language-eligibility.md`
- Modify: `docs/testing/onbox-acceptance-register.md`
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`

**Interfaces:** none.

- [ ] **Step 1: Cross-reference the reclaim in plan 249**

Plan 249's accepted limitation #2 says `evictQwenForCoquiPhase` is a global unload, not per-book. Append a sentence to that limitation noting the reverse direction now exists and is scoped differently:

```
   Since #1894 the reverse direction is handled in the SIDECAR instead — an
   idle Coqui is reclaimed by `_idle_evict` on the admission path, which is
   engine-aware and device-targeted rather than a global Node-side unload.
   That asymmetry is deliberate: see
   `docs/superpowers/specs/2026-07-28-coqui-residency-eviction-design.md` §3
   for why the symmetric Node-side fix was rejected.
```

- [ ] **Step 2: Add the on-box acceptance row**

In `docs/testing/onbox-acceptance-register.md`, insert **A20** directly after A19's block (i.e. after the `---` at `:315`, before `## Group B`). Two counters must move, not one:

- `:50` — the Group A row in `## At a glance`: `| **A** | … | 19 |` → `20`
- `:60` — the total: `**31 owed.**` → `**32 owed.**` (leave the "Oldest" date alone)

Match A19's shape exactly:

```markdown
### A20 · Idle Coqui is reclaimed under VRAM pressure ([#1894](https://github.com/dudarenok-maker/Castwright/issues/1894)) · **single 8 GB card**

The sidecar's admission path now frees a resident-but-idle XTTS before reporting
`noCapacity`. Unit tests prove the branch fires and that it never evicts for a Coqui
op; what they cannot reach is whether reclaiming ~3 GB actually admits the blocked
operation on real hardware, and whether the 30 s TTL is tuned for real chapter gaps.

- **Run pinned to ONE card** — `CUDA_VISIBLE_DEVICES=0`. This box is dual-GPU
  (`cuda:0` 4070 8 GB, `cuda:1` 5070Ti 16 GB) and `_worst_device_key` picks the card
  with the **most** headroom, so an unpinned run calls `idle_evict("cuda:1")` while
  Coqui sits on `cuda:0`, `_same_card` declines, and the row passes or fails for
  entirely the wrong reason.
- Load Coqui from the UI, then start a Qwen-only render that would not otherwise fit.
  Confirm the render **proceeds** and the sidecar log carries `Coqui model unloaded.`
  Record whether the reclaimed ~3 GB actually admitted the op, or was immediately
  taken by something else.
- Then render a mixed Qwen+Coqui book and watch the chapter boundaries. **An
  evict→reload cycle repeating across chapters means `COQUI_IDLE_TTL` is too short**
  (each reload costs ~90 s); a render that still fails `NoCapacityError` with an idle
  Coqui resident means it is too long. Record which, with the observed interval
  between the evict and the next Coqui use, so the default can be moved off 30 s with
  evidence rather than a guess.
- Also confirm the Task 1 fix: press **Stop** on Coqui while a chapter is rendering
  through it. The chapter must continue to completion — before #1894 this could kill
  it with `AttributeError: 'NoneType' object has no attribute 'tts'`.

**Run this with A19 and A5** — same card, same mixed-cast book, and A19 already stages
the Qwen+Coqui co-residency this row's first bullet needs.

*Needs:* the 8 GB card only, pinned via `CUDA_VISIBLE_DEVICES=0`, and a mixed-cast
non-English book. *Criteria:* the spec at
`docs/superpowers/specs/2026-07-28-coqui-residency-eviction-design.md` §6; the TTL
rationale is in the comment on `_COQUI_IDLE_TTL_DEFAULT` in `tts-sidecar/main.py`.
*Cost:* short.
```

- [ ] **Step 3: Add the release notes**

Append to `docs/release-notes-next.md` under **`## 🎙️ Voices & casting`** (`:87`). There is no GPU/performance section — the file's headings are `## 🧱 Internals`, `## 🔧 Setup & prerequisites`, `## 📝 Script review & manuscript`, `## 🎙️ Voices & casting`, `## 🎧 Listening & revising`, `## 📱 Companion app`, `## 📖 Help`, `## 🔒 Security & dependencies`, `## 🧪 Test gates`. The open cycle is `release-notes-next-version: 1.15.0`, which matches `RELEASE_NOTES.md`'s top section.

```
- **Idle Coqui XTTS is now reclaimed under VRAM pressure** (#1894, PR #NNN) —
  the sidecar's admission path frees a resident-but-idle XTTS before reporting
  `noCapacity`, instead of failing the starved operation. Engine-aware (a Coqui
  op never evicts itself) and device-targeted. Tunable via `COQUI_IDLE_TTL` /
  `sidecar.coquiIdleTtl` (default 30 s). Also fixes an unguarded `CoquiEngine
  .unload()` that could crash an in-flight synth when the Stop button fired
  mid-render, and the same unguarded-unload race in the Whisper (ASR) and ECAPA
  speaker engines — which, unlike Coqui, were already being auto-evicted, so
  that one was reachable in production.
```

Add the matching user-facing line to the in-progress version section at the top of `RELEASE_NOTES.md`, in brand voice:

```
- Generation no longer stalls when a voice model you're done with is still
  holding the graphics card — it now steps aside on its own. And stopping
  Coqui mid-render can no longer interrupt the chapter being recorded.
```

`#NNN` cannot be resolved yet — the PR does not exist until Step 6. Leave the placeholder here, then **after Step 6 opens the PR, come back, substitute the real number, and land it as a follow-up commit on the same branch** (`docs(docs): fill in the PR ref in the release notes`). Do not amend the Step 5 commit if it has already been pushed. Shipping `#NNN` is a plan failure, not a cosmetic one — it is the reference a future reader uses to find this change.

- [ ] **Step 4: Run the branch-scoped battery**

Run: `npm run verify:fast:branch`
Expected: green. This is the same battery pre-push runs.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(docs): record the Coqui idle-evict, its acceptance, and release notes"
```

- [ ] **Step 6: Open the PR**

Push the branch and open a PR whose body links the issue. The title must match the commit convention.

```bash
git push -u origin fix/sidecar-coqui-idle-evict
```

PR title: `fix(sidecar,server): reclaim an idle Coqui when an op is VRAM-starved`

PR body must contain `Closes #1894`, a `## Summary` and a `## Test plan` section, and a link to the spec. It must also call out two things a reviewer would otherwise have to rediscover:

- Four test files still construct the `'Coqui XTTS' / 'Use its Stop button…'` blocker literal by hand (Task 5 Step 5). They stay green because they never call `describeVramBlockers`, but they now encode a string the product can no longer emit.
- Task 6 fixes the *same class* of bug in `WhisperEngine` and `SpeakerEngine`, which were already being auto-evicted — so that race was live in production, not introduced by this branch. Reviewers should read Task 6's diff as a bug fix on its own merits, independent of the Coqui feature.

**No `docs/features/` regression plan is created for this work**, and that is deliberate rather than an omission of Before-shipping checklist step 1: the design of record is the spec, the invariants it touches live in plan 249 (updated in Step 1), and the acceptance debt is register row A5. Say so in the PR body so the gate reads as answered, not skipped.

- [ ] **Step 7: Run the mandatory independent code review**

Per CLAUDE.md's Before-shipping checklist step 10 and the model-routing skill: dispatch a `pr-review-gate` pass at the tier the PR's scope calls for. This PR is multi-scope (`sidecar,server`) → **high** effort, Premium tier. Triage and fold findings before merge. Do not merge on a Critical finding without re-review.

