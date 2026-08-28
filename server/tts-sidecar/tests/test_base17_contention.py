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
import threading
import time
from pathlib import Path
from unittest import mock

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
