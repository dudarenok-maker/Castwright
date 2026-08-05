"""#2070 — `unload_design()` must not silently kill an in-flight design.

Before this fix, `synthesize()`/`synthesize_batch()` called `unload_design()`
unconditionally whenever a design was resident, with NO regard for whether
that design was still rendering (`_design_in_flight`). An ordinary synth on
another voice could null `self._design` mid-`design_voice()`, which then
failed loud with "VoiceDesign model was unloaded before this design could
render" — killing visible, user-initiated work for a batch job that could
simply have waited.

The eviction-policy call (#2070's implementation brief, D1): the DESIGN WINS.
`unload_design()` now waits (bounded) for `_design_in_flight` to clear before
evicting, and raises `DesignContentionTimeoutError` — never silently nulling
the model — if the wait expires.

These tests drive `unload_design()` directly against a fresh `QwenEngine`,
claiming `_design_in_flight` manually (mirroring `design_voice()`'s own
`with self._design_in_flight.claim():` bracket) rather than running a real
design — no torch/GPU required.
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import pytest  # noqa: E402

import main  # noqa: E402


class _FakeDesignModel:
    """Stand-in for the loaded VoiceDesign model — identity only matters for
    `is`/`is None` checks in these tests."""


def test_unload_design_waits_for_in_flight_design_then_unloads() -> None:
    """A design still in flight when unload_design() is called must NOT be
    killed — unload_design() waits for it to clear, then unloads.

    Mutation that must fail this — breaks the PRODUCER: drop the `while
    self._design_in_flight.busy: ...` wait loop in `unload_design()` (i.e.
    revert to the pre-#2070 unconditional null). `design_still_present_mid_wait`
    then reads False (nulled immediately) instead of True.
    """
    engine = main.QwenEngine()
    engine._design = _FakeDesignModel()

    release = threading.Event()
    entered = threading.Event()

    def hold_design_in_flight() -> None:
        with engine._design_in_flight.claim():
            entered.set()
            release.wait(5)

    holder = threading.Thread(target=hold_design_in_flight, daemon=True)
    holder.start()
    assert entered.wait(2), "claim() never entered — test bug"

    design_still_present_mid_wait: list[bool] = []

    def run_unload() -> None:
        # Snapshot just after unload_design() starts polling but before the
        # holder releases — proves it did NOT null `_design` immediately.
        design_still_present_mid_wait.append(engine._design is not None)
        engine.unload_design(wait_seconds=5.0, poll_seconds=0.05)

    unloader = threading.Thread(target=run_unload, daemon=True)
    unloader.start()

    # Give unload_design() time to enter its wait loop, then confirm the
    # design is still resident WHILE the "design" is in flight.
    time.sleep(0.2)
    assert engine._design is not None, (
        "unload_design() nulled `_design` while _design_in_flight was still "
        "busy — the design-wins policy was not applied."
    )

    release.set()
    holder.join(5)
    unloader.join(5)
    assert not unloader.is_alive(), "unload_design() did not return after the design cleared"
    assert engine._design is None, "unload_design() should unload once the design is no longer in flight"


def test_unload_design_raises_typed_error_after_bounded_wait() -> None:
    """A design that never clears (wedged) must not hang the synth forever —
    unload_design() times out into DesignContentionTimeoutError, and the
    design model is left in place (never silently nulled).

    Mutation that must fail this — breaks the PRODUCER: make the wait
    unbounded (drop the `deadline` check / raise), which would hang this test
    past its own bound instead of raising promptly.
    """
    engine = main.QwenEngine()
    engine._design = _FakeDesignModel()

    release = threading.Event()
    entered = threading.Event()

    def hold_design_in_flight() -> None:
        with engine._design_in_flight.claim():
            entered.set()
            release.wait(5)

    holder = threading.Thread(target=hold_design_in_flight, daemon=True)
    holder.start()
    assert entered.wait(2), "claim() never entered — test bug"

    try:
        with pytest.raises(main.DesignContentionTimeoutError):
            engine.unload_design(wait_seconds=0.3, poll_seconds=0.05)
        assert engine._design is not None, (
            "a timed-out unload_design() must not have nulled `_design` — "
            "the design still holds it."
        )
    finally:
        release.set()
        holder.join(5)


def test_unload_design_is_a_noop_when_no_design_resident() -> None:
    """Idempotency is unchanged by the #2070 fix: no design in flight AND no
    design resident returns immediately without waiting or raising."""
    engine = main.QwenEngine()
    engine._design = None
    start = time.monotonic()
    engine.unload_design(wait_seconds=5.0, poll_seconds=0.05)
    assert time.monotonic() - start < 0.5, "unload_design() should not wait when nothing is in flight"
    assert engine._design is None
