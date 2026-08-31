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

    # Ensure Kokoro isn't resident so its eviction branch is a no-op and
    # doesn't interfere with the model under test.
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
    indefinitely instead of timing out after the scaled timeout, causing this
    test to hang.
    """
    engine = main.QwenEngine()
    _quiet_kokoro()

    # Create a long-lived hold on the card_lock to simulate a slow/wedged
    # mint_variant() call
    card_idx = main._qwen_configured_card_idx()
    lock = main._DEVICE_LEDGER.card_lock(card_idx)

    # Hold the lock in a background thread for longer than the design's
    # acquire timeout, simulating a slow base17 load.
    # We scale down the timeout via monkeypatch so the test runs quickly.
    release = threading.Event()
    entered = threading.Event()

    def hold_card_lock() -> None:
        with lock:
            entered.set()
            # Hold for longer than the scaled timeout
            release.wait(5)

    holder = threading.Thread(target=hold_card_lock, daemon=True)
    holder.start()

    try:
        assert entered.wait(2), "card_lock holder never entered — test bug"

        # Now try design_voice while the card_lock is held by another thread.
        # It should timeout and raise Base17ContentionTimeoutError, NOT hang.
        # Mock torch and other heavy dependencies to avoid loading the real models.
        # Monkeypatch the timeout to something small (0.3s) so the test completes quickly.
        with mock.patch.object(
            main, "_BASE17_CONTENTION_WAIT_S_DEFAULT", 0.3
        ):
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


def test_card_lock_released_when_base17_eviction_raises() -> None:
    """#2809 (pass-2 review) — `design_voice()` must not leak `card_lock` when
    the base17 eviction raises.

    `unload_base17(wait_seconds > 0)` raises `Base17ContentionTimeoutError` by
    design — that is its documented bounded-wait failure mode, and
    `design_voice()` is the only caller that opts into it (#2752 / #1156). The
    call sits between `card_lock.acquire()` and the `finally` that releases it,
    so a release-`finally` that does not span it leaks the lock. `card_lock`
    instances are cached per card index for the PROCESS lifetime
    (`_DeviceLedger.card_lock`), so a leaked one wedges every subsequent
    `design_voice()` (bounded acquire → `Base17ContentionTimeoutError`) and
    every `mint_variant()` (unbounded acquire → hang) on that card until the
    sidecar restarts.

    Mutation that must fail this (verified) — replace the outer
    `finally: if not card_lock_released: card_lock.release()` with a no-op
    (`pass`), i.e. leave the only release inside the post-eviction `try`: the
    final `lock.locked()` assertion below flips to `True`.
    """
    engine = main.QwenEngine()
    _quiet_kokoro()

    card_idx = main._qwen_configured_card_idx()
    lock = main._DEVICE_LEDGER.card_lock(card_idx)
    assert not lock.locked(), (
        "card_lock was already held before this test ran — an earlier test "
        "leaked it (which is exactly the defect under test)."
    )

    # Force the eviction branch, then make the eviction take its own documented
    # bounded-wait failure path.
    engine._base17 = _FakeBase17Model()

    def _raise_contention(*_args, **_kwargs):
        raise main.Base17ContentionTimeoutError(
            "simulated bounded-wait timeout on an in-flight base17 load"
        )

    engine.unload_base17 = _raise_contention  # type: ignore[method-assign]

    with mock.patch.dict(sys.modules, {"torch": mock.MagicMock()}):
        with pytest.raises(main.Base17ContentionTimeoutError):
            engine.design_voice(
                voice_id="__leak_probe_voice__",
                instruct="A warm voice.",
                language="en",
                calibration_text="Hello there.",
            )

    assert not lock.locked(), (
        "card_lock is still held after design_voice() failed in the base17 "
        "eviction — it is cached for the process lifetime, so this wedges "
        "every later design and mint on this card until sidecar restart."
    )
    # And prove it is genuinely re-acquirable by a later caller, not merely
    # reporting an unlocked flag.
    assert lock.acquire(timeout=1.0), "card_lock could not be re-acquired"
    lock.release()


def test_two_concurrent_healthy_designs_both_succeed() -> None:
    """#2790 — Two concurrent, healthy (non-wedged) design_voice() calls should
    both succeed, even if one takes longer than the other. Before the fix,
    design B would timeout waiting for card_lock after 60s, even though design
    A was still running healthily (just in its GPU forward phase, not holding
    card_lock anymore).

    This test simulates two designs with staggered starts and variable timing,
    proving that narrowing the card_lock scope (holding it only through load,
    not GPU forwards) allows concurrent designs to both complete successfully.

    Mutation that must fail this — broaden the card_lock scope to include GPU
    forwards (revert the narrowing): design B will timeout while design A is
    still running its GPU forwards, causing the assertion below to fail.

    The two timings below are what make that mutation detectable, and both
    matter (#2809 pass-1 review — this test previously could NOT fail under
    the mutation its own docstring names). The acquire bound is
    `_BASE17_CONTENTION_WAIT_S_DEFAULT`, 60s in production; A's fake forward
    used to sleep 0.1s against it, i.e. B waited ~0.15s of a 60s budget and
    never timed out no matter how broad the lock was. So: scale the bound down
    to 0.3s (mirroring the sibling `test_design_voice_card_lock_acquire_is_bounded`,
    which monkeypatches the same constant for the same reason) and lengthen A's
    forward to 2.0s so it comfortably outlives the bound.
    """
    engine = main.QwenEngine()
    _quiet_kokoro()

    class _FakeDesignForConcurrentTest:
        def generate_voice_design(self, text, language, instruct):
            # Simulate a slow forward pass. MUST outlast the scaled-down
            # acquire bound below, or the broadened-lock mutation is invisible.
            time.sleep(2.0)
            return [np.zeros(10, dtype="float32")], 24000

    class _FakeBaseForConcurrentTest:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            # Simulate audition forward pass
            return [np.zeros(10, dtype="float32")], 24000

    engine._base = _FakeBaseForConcurrentTest()

    # Track which designs succeeded
    results = {"design_a": None, "design_b": None, "both_completed": False}

    def run_design_a() -> None:
        try:
            with mock.patch.dict(sys.modules, {"torch": mock.MagicMock()}):
                engine.design_voice(
                    voice_id="test-voice-a",
                    instruct="a warm voice",
                    language="en",
                    calibration_text="Hello",
                )
            results["design_a"] = "success"
        except Exception as e:
            results["design_a"] = f"failed: {e}"

    def run_design_b() -> None:
        # Start design B after design A has started but is still loading
        time.sleep(0.02)  # Small delay to let A reach the load phase
        try:
            with mock.patch.dict(sys.modules, {"torch": mock.MagicMock()}):
                engine.design_voice(
                    voice_id="test-voice-b",
                    instruct="a gentle voice",
                    language="en",
                    calibration_text="Hi",
                )
            results["design_b"] = "success"
        except Exception as e:
            results["design_b"] = f"failed: {e}"

    # Mock necessary dependencies. The scaled-down acquire bound is patched on
    # `main` (not per-thread) so both design threads read it — 0.3s against A's
    # 2.0s forward, so a card_lock still held across that forward times B out.
    with mock.patch.object(main, "_BASE17_CONTENTION_WAIT_S_DEFAULT", 0.3), \
            mock.patch.dict(sys.modules, {"torch": mock.MagicMock()}):
        engine._voices_dir = tempfile.mkdtemp()

        # Mock ensure calls to control timing
        design_b_can_proceed = threading.Event()

        def _tracked_ensure_design(device=None):
            # Signal that design load is happening, so design B can try to
            # acquire card_lock
            if not design_b_can_proceed.is_set():
                design_b_can_proceed.set()
                # Let design B try while we're still loading
                time.sleep(0.05)
            # Actually load (mocked, so instant)
            engine._design = _FakeDesignForConcurrentTest()

        def _no_op_ensure(device=None):
            pass

        engine._ensure_design_loaded = _tracked_ensure_design
        engine._ensure_base_loaded = _no_op_ensure

        # Run both designs concurrently
        thread_a = threading.Thread(target=run_design_a, daemon=True)
        thread_b = threading.Thread(target=run_design_b, daemon=True)

        thread_a.start()
        thread_b.start()

        thread_a.join(10)
        thread_b.join(10)

        results["both_completed"] = (
            not thread_a.is_alive() and not thread_b.is_alive()
        )

    # Verify both designs succeeded (not that one timed out)
    assert results["both_completed"], (
        "Both design threads should complete within 10s. "
        f"Thread A alive: {thread_a.is_alive()}, Thread B alive: {thread_b.is_alive()}"
    )
    assert results["design_a"] == "success", (
        f"Design A should succeed, but got: {results['design_a']}"
    )
    assert results["design_b"] == "success", (
        f"Design B should succeed (not timeout), but got: {results['design_b']}. "
        "If design B timed out with Base17ContentionTimeoutError, the card_lock "
        "scope is still too broad."
    )
