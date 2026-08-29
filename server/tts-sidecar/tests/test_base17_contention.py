"""#2752 — `unload_base17()` must not silently kill an in-flight base17 load.

Before this fix, `design_voice()`'s eviction guard was `self._base17 is not
None` alone. `_base17` stays `None` for the ENTIRE duration of a base17
load/mint (claimed via `self._base17_in_flight.claim()` around
`_base17_activity`), so a `design_voice()` call arriving while a base17 load
was in flight but not yet assigned saw the guard read `False` and proceeded
straight into the VoiceDesign load with both models resident — the #1156 OOM
shape, on the mirror side of #2678/#2070's `_design_in_flight` fix.

The eviction-policy call (this ticket, same direction as #2070's "design
wins"): `unload_base17()` now waits (bounded) for `_base17_in_flight` to
clear before evicting, and raises `Base17ContentionTimeoutError` — never
silently nulling the model — if the wait expires.

These tests drive `unload_base17()` directly against a fresh `QwenEngine`,
claiming `_base17_in_flight` manually (mirroring `_base17_activity`'s own
`with self._base17_in_flight.claim():` bracket) rather than running a real
load — no torch/GPU required. The guard test drives `design_voice()` itself,
mirroring `test_design_contention.py`'s
`test_synthesize_widens_guard_to_design_still_loading` /
`test_mint_variant_widens_guard_to_design_still_loading`.
"""
from __future__ import annotations

import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

import numpy as np

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import pytest  # noqa: E402

import main  # noqa: E402


class _FakeBase17Model:
    """Stand-in for the loaded 1.7B-Base model — identity only matters for
    `is`/`is None` checks in these tests."""


class _StoppedAfterGuard(Exception):
    """Raised by a mocked `unload_base17()` so a guard test can prove the
    call happened without running the rest of `design_voice()` (which needs
    a real cached voice prompt / VoiceDesign load, neither available here)."""


def _quiet_kokoro() -> None:
    """Ensure no resident Kokoro so the Kokoro-eviction branch is a no-op and
    doesn't interfere with the model under test (other tests may leave it set)."""
    kok = main.ENGINES.get("kokoro")
    if isinstance(kok, main.KokoroEngine):
        kok._kokoro = None


def test_unload_base17_waits_for_in_flight_base17_then_unloads() -> None:
    """A base17 load still in flight when unload_base17() is called must NOT
    be killed — unload_base17() waits for it to clear, then unloads.

    Mutation that must fail this (verified) — breaks the PRODUCER: drop the
    `while self._base17_in_flight.busy: ...` wait loop in `unload_base17()`
    (i.e. revert to the pre-#2752 unconditional null). The `assert
    engine._base17 is not None` below — taken from the MAIN thread, 0.2s
    after starting `unload_base17()` on a background thread, while the
    simulated load is still held in flight — then finds `_base17` already
    `None`: a mutated `unload_base17()` nulls it immediately instead of
    waiting, so the snapshot 0.2s later reads the post-null state.
    """
    engine = main.QwenEngine()
    engine._base17 = _FakeBase17Model()

    release = threading.Event()
    entered = threading.Event()

    def hold_base17_in_flight() -> None:
        with engine._base17_in_flight.claim():
            entered.set()
            release.wait(5)

    holder = threading.Thread(target=hold_base17_in_flight, daemon=True)
    holder.start()
    assert entered.wait(2), "claim() never entered — test bug"

    def run_unload() -> None:
        engine.unload_base17(wait_seconds=5.0, poll_seconds=0.05)

    unloader = threading.Thread(target=run_unload, daemon=True)
    unloader.start()

    # Give unload_base17() time to enter its wait loop, then confirm the
    # model is still resident WHILE the "load" is in flight. This IS the
    # mutation-detecting assertion (see the docstring above).
    time.sleep(0.2)
    assert engine._base17 is not None, (
        "unload_base17() nulled `_base17` while _base17_in_flight was still "
        "busy — the design-wins policy was not applied."
    )

    release.set()
    holder.join(5)
    unloader.join(5)
    assert not unloader.is_alive(), "unload_base17() did not return after the load cleared"
    assert engine._base17 is None, "unload_base17() should unload once the load is no longer in flight"


def test_unload_base17_raises_typed_error_after_bounded_wait() -> None:
    """A base17 load that never clears (wedged) must not hang the design
    forever — unload_base17() times out into Base17ContentionTimeoutError,
    and the base17 model is left in place (never silently nulled).

    Mutation that must fail this — breaks the PRODUCER: make the wait
    unbounded (drop the `deadline` check / raise), which would hang this test
    past its own bound instead of raising promptly.
    """
    engine = main.QwenEngine()
    engine._base17 = _FakeBase17Model()

    release = threading.Event()
    entered = threading.Event()

    def hold_base17_in_flight() -> None:
        with engine._base17_in_flight.claim():
            entered.set()
            release.wait(5)

    holder = threading.Thread(target=hold_base17_in_flight, daemon=True)
    holder.start()
    assert entered.wait(2), "claim() never entered — test bug"

    try:
        with pytest.raises(main.Base17ContentionTimeoutError):
            engine.unload_base17(wait_seconds=0.3, poll_seconds=0.05)
        assert engine._base17 is not None, (
            "a timed-out unload_base17() must not have nulled `_base17` — "
            "the load still holds it."
        )
    finally:
        release.set()
        holder.join(5)


def test_unload_base17_is_a_noop_when_no_base17_resident() -> None:
    """Idempotency is unchanged by the #2752 fix: no load in flight AND no
    model resident returns immediately without waiting or raising."""
    engine = main.QwenEngine()
    engine._base17 = None
    start = time.monotonic()
    engine.unload_base17(wait_seconds=5.0, poll_seconds=0.05)
    assert time.monotonic() - start < 0.5, "unload_base17() should not wait when nothing is in flight"
    assert engine._base17 is None


def test_design_voice_widens_guard_to_base17_still_loading() -> None:
    """#2752 — `design_voice()`'s eviction guard must not skip
    `unload_base17()` while a base17 load/mint has claimed
    `_base17_in_flight` but has not yet assigned `self._base17` (the weights
    are still loading). The pre-fix guard (`self._base17 is not None` alone)
    is `False` in exactly this window, so a design proceeding here loaded the
    heavy VoiceDesign model concurrently with the still-loading base17 — the
    #1156 OOM shape.

    Mutation that must fail this (verified per this ticket's acceptance
    criteria): revert the guard to `self._base17 is not None`. `_base17` is
    still `None` in this test's setup, so the reverted guard is `False` and
    `unload_base17` is never called — `mocked_unload.assert_called_once()`
    below then fails.
    """
    engine = main.QwenEngine()
    engine._base17 = None  # a base17 load has claimed in-flight but not assigned yet

    release = threading.Event()
    entered = threading.Event()

    def hold_base17_in_flight() -> None:
        with engine._base17_in_flight.claim():
            entered.set()
            release.wait(5)

    holder = threading.Thread(target=hold_base17_in_flight, daemon=True)
    holder.start()
    try:
        assert entered.wait(2), "claim() never entered — test bug"
        # The exact gap this fix closes: not-None is False, busy is True.
        assert engine._base17 is None
        assert engine._base17_in_flight.busy is True

        with mock.patch.dict(sys.modules, {"torch": mock.MagicMock()}):
            with mock.patch.object(
                engine, "unload_base17", side_effect=_StoppedAfterGuard
            ) as mocked_unload:
                with pytest.raises(Exception):  # noqa: B017 — any raise ends the probe
                    engine.design_voice(
                        voice_id="__nonexistent_voice_for_test__",
                        instruct="a warm, gentle teenage girl",
                        language="en",
                        calibration_text=None,
                    )
            mocked_unload.assert_called_once()
    finally:
        release.set()
        holder.join(5)


def test_unload_base17_with_default_wait_never_raises_during_stop() -> None:
    """#2752 — the bare unload_base17() call (no args, used by the /unload Stop
    route) must NEVER raise, even if base17 is in flight. Stop must always
    succeed, freeing the model regardless of in-flight state — mirroring the
    sibling unload() method's unconditional-null semantics.

    The bare call uses wait_seconds=0.0 (the default), which should bypass the
    busy-wait path entirely and unconditionally null _base17, NOT raise
    Base17ContentionTimeoutError immediately.

    Mutation that must fail this (verified) — keep the current behavior where
    wait_seconds=0.0 raises immediately if busy: set up an in-flight claim,
    call unload_base17() with no args, and it will raise instead of returning.
    """
    engine = main.QwenEngine()
    engine._base17 = _FakeBase17Model()

    release = threading.Event()
    entered = threading.Event()

    def hold_base17_in_flight() -> None:
        with engine._base17_in_flight.claim():
            entered.set()
            release.wait(5)

    holder = threading.Thread(target=hold_base17_in_flight, daemon=True)
    holder.start()
    assert entered.wait(2), "claim() never entered — test bug"

    try:
        # Bare call with default wait_seconds=0.0, as the Stop route uses it.
        # Must NOT raise, must return normally and null _base17.
        engine.unload_base17()
        assert engine._base17 is None, "bare unload_base17() should have nulled _base17"
    finally:
        release.set()
        holder.join(5)


def test_design_voice_card_lock_prevents_concurrent_base17_reload() -> None:
    """#2790 — design_voice() must hold card_lock during evict-through-load to
    prevent a concurrent mint_variant() from loading base17 in the gap.

    Before this fix, design_voice() evicted base17 without holding the same
    per-card mutex that mint_variant() holds during its base17 load. A
    concurrent mint_variant() could reload base17 on the card after
    design_voice()'s eviction check but before its VoiceDesign load started,
    causing both 1.7B models to co-reside (OOM on 8 GB).

    This test verifies that with card_lock, a concurrent base17 load is
    blocked until the design's VoiceDesign load completes (inside the design()
    block), serializing the two check-residency->evict->load sequences.

    Mutation that must fail this (verified) — remove the card_lock wrapping
    in design_voice(): the lock acquisition on the background thread will
    succeed immediately (instead of being blocked), causing both loads to
    overlap in time instead of serializing.
    """
    engine = main.QwenEngine()

    # Simulate that Kokoro is already warm from a prior operation
    _quiet_kokoro()

    design_started = threading.Event()
    allow_design_to_complete = threading.Event()
    base17_loaded_while_design_loading = {"value": False}
    design_load_complete = threading.Event()

    class _FakeDesign:
        def generate_voice_design(self, text, language, instruct):
            return [np.zeros(10, dtype="float32")], 24000

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            return [np.zeros(10, dtype="float32")], 24000

    engine._design = _FakeDesign()
    engine._base = _FakeBase()

    # Mock ensure to track when loads happen
    original_ensure_design = engine._ensure_design_loaded
    def _tracked_ensure_design(device=None):
        design_started.set()
        # Signal that design load has started, then wait for the test
        # to try a concurrent base17 load before completing
        allow_design_to_complete.wait(10)
        # Simulate the design model loading
        engine._design = _FakeDesign()
        design_load_complete.set()

    engine._ensure_design_loaded = _tracked_ensure_design
    engine._ensure_base_loaded = lambda device=None: None

    # Mock torch
    with mock.patch.dict(sys.modules, {"torch": mock.MagicMock()}):
        import torch
        torch.save = lambda *a, **k: None

        engine._voices_dir = tempfile.mkdtemp()

        # Start design_voice in a background thread
        def run_design() -> None:
            try:
                engine.design_voice(
                    voice_id="test-voice",
                    instruct="a warm voice",
                    language="en",
                    calibration_text="Hello",
                )
            except Exception:
                # Expected to fail since we're mocking, just need to get
                # past the ensure calls
                pass

        design_thread = threading.Thread(target=run_design, daemon=True)
        design_thread.start()

        # Wait for design load to start
        assert design_started.wait(5), "design_voice never started loading"

        # Now try to load base17 concurrently (simulating mint_variant)
        # This should BLOCK until the card_lock is released
        base17_load_acquired_lock = threading.Event()

        def try_load_base17() -> None:
            # Try to acquire the same card lock that design_voice holds
            card_idx = main._qwen_configured_card_idx()
            lock = main._DEVICE_LEDGER.card_lock(card_idx)

            # If the lock is being held by design_voice's card_lock context,
            # this acquire will block. Set an event to show we tried.
            base17_load_acquired_lock.set()
            acquired = lock.acquire(timeout=0.5)  # Short timeout to detect blocking

            if acquired:
                try:
                    # We got the lock quickly, which means design_voice released it
                    # (or never held it). Record that we loaded base17 while design
                    # was loading.
                    if not design_load_complete.is_set():
                        base17_loaded_while_design_loading["value"] = True
                finally:
                    lock.release()

        base17_thread = threading.Thread(target=try_load_base17, daemon=True)
        base17_thread.start()

        # Give the base17 thread time to try acquiring the lock
        base17_load_acquired_lock.wait(5)

        # Allow design to complete
        allow_design_to_complete.set()

        # Wait for both to complete
        design_thread.join(10)
        base17_thread.join(5)

        # Verify the race is closed: base17 should NOT have loaded while
        # design was loading (because card_lock prevented it)
        assert base17_loaded_while_design_loading["value"] is False, (
            "base17 loaded while design was loading — card_lock is not preventing "
            "concurrent loads on the same card"
        )


def test_design_voice_card_lock_acquire_is_bounded() -> None:
    """#2790 (pass-2 review) — design_voice() must NOT hang indefinitely when
    trying to acquire card_lock. The lock acquire in the card_lock context
    manager must be bounded by a timeout matching _BASE17_CONTENTION_WAIT_S_DEFAULT,
    raising Base17ContentionTimeoutError if the lock is held by another thread
    (e.g. a mint_variant loading base17) and the timeout expires.

    Before the fix, the lock acquire was unbounded (plain `with` statement),
    so if a concurrent mint_variant() held the lock for any duration,
    design_voice() would block indefinitely instead of timing out and raising
    a proper error.

    Mutation that must fail this (verified) — remove the timeout from the
    lock acquire (restore plain `with` statement): the acquire call will block
    forever instead of timing out after 60s, causing this test to hang past
    its 10s deadline.
    """
    engine = main.QwenEngine()
    _quiet_kokoro()

    # Create a long-lived hold on the card_lock to simulate a slow/wedged
    # mint_variant() call
    card_idx = main._qwen_configured_card_idx()
    lock = main._DEVICE_LEDGER.card_lock(card_idx)

    # Hold the lock in a background thread for longer than the design's
    # acquire timeout (60s), simulating a slow base17 load
    release = threading.Event()
    entered = threading.Event()

    def hold_card_lock() -> None:
        with lock:
            entered.set()
            # Hold for 120s (longer than the 60s design timeout)
            release.wait(120)

    holder = threading.Thread(target=hold_card_lock, daemon=True)
    holder.start()

    try:
        assert entered.wait(2), "card_lock holder never entered — test bug"

        # Now try design_voice while the card_lock is held by another thread.
        # It should timeout and raise Base17ContentionTimeoutError, NOT hang.
        # Mock torch and other heavy dependencies to avoid loading the real models
        with mock.patch.dict(sys.modules, {"torch": mock.MagicMock()}):
            with pytest.raises(main.Base17ContentionTimeoutError):
                engine.design_voice(
                    voice_id="__nonexistent_voice_for_test__",
                    instruct="a warm, gentle teenage girl",
                    language="en",
                    calibration_text=None,
                )
    finally:
        release.set()
        holder.join(5)
