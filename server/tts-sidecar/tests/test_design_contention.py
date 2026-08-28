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
from unittest import mock

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import pytest  # noqa: E402

import main  # noqa: E402


class _FakeDesignModel:
    """Stand-in for the loaded VoiceDesign model — identity only matters for
    `is`/`is None` checks in these tests."""


class _StoppedAfterGuard(Exception):
    """Raised by a mocked `unload_design()` so a guard test can prove the
    call happened without running the rest of `synthesize()` (which imports
    `torch` and needs a real cached voice prompt — neither available here)."""


def test_unload_design_waits_for_in_flight_design_then_unloads() -> None:
    """A design still in flight when unload_design() is called must NOT be
    killed — unload_design() waits for it to clear, then unloads.

    Mutation that must fail this (verified) — breaks the PRODUCER: drop the
    `while self._design_in_flight.busy: ...` wait loop in `unload_design()`
    (i.e. revert to the pre-#2070 unconditional null). The `assert
    engine._design is not None` below — taken from the MAIN thread, 0.2s after
    starting `unload_design()` on a background thread, while the simulated
    design is still held in flight — then finds `_design` already `None`: a
    mutated `unload_design()` nulls it immediately instead of waiting, so the
    snapshot 0.2s later reads the post-null state. That single assertion is
    what detects the mutation; nothing else in this test needs to (review R13
    — an earlier draft's `design_still_present_mid_wait` list duplicated this
    check inside `run_unload()` itself but was never asserted, so it detected
    nothing; removed rather than wired up, since the main-thread assertion
    below already covers the same property more directly).
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

    def run_unload() -> None:
        engine.unload_design(wait_seconds=5.0, poll_seconds=0.05)

    unloader = threading.Thread(target=run_unload, daemon=True)
    unloader.start()

    # Give unload_design() time to enter its wait loop, then confirm the
    # design is still resident WHILE the "design" is in flight. This IS the
    # mutation-detecting assertion (see the docstring above).
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


def test_synthesize_widens_guard_to_design_still_loading() -> None:
    """#2678 — `synthesize()`'s render guard must not skip `unload_design()`
    while `design_voice()` has claimed `_design_in_flight` but has not yet
    assigned `self._design` (the heavy VoiceDesign weights are still
    loading). The pre-fix guard (`self._design is not None` alone) is
    `False` in exactly this window, so a render proceeding here loaded its
    own model concurrently with the design's still-loading one — the
    `Castwright#2678` vram-spill.

    Mutation that must fail this (verified per this ticket's acceptance
    criteria): revert the guard to `self._design is not None`. `_design` is
    still `None` in this test's setup, so the reverted guard is `False` and
    `unload_design` is never called — `mocked_unload.assert_called_once()`
    below then fails. (The reverted guard also lets execution fall through
    into `_load_voice_prompt`, which may raise its own — environment
    dependent — error first; either way the call is caught below and the
    `assert_called_once()` is what actually pins the guard's behavior,
    independent of what that fallthrough raises.)
    """
    engine = main.QwenEngine()
    engine._design = None  # design_voice() has claimed in-flight but not assigned yet

    release = threading.Event()
    entered = threading.Event()

    def hold_design_in_flight() -> None:
        with engine._design_in_flight.claim():
            entered.set()
            release.wait(5)

    holder = threading.Thread(target=hold_design_in_flight, daemon=True)
    holder.start()
    try:
        assert entered.wait(2), "claim() never entered — test bug"
        # The exact gap this fix closes: not-None is False, busy is True.
        assert engine._design is None
        assert engine._design_in_flight.busy is True

        with mock.patch.object(
            engine, "unload_design", side_effect=_StoppedAfterGuard
        ) as mocked_unload:
            with pytest.raises(Exception):  # noqa: B017 — see docstring: any raise ends the probe
                engine.synthesize("0.6b", "__nonexistent_voice_for_test__", "hello")
        mocked_unload.assert_called_once()
    finally:
        release.set()
        holder.join(5)


def test_synthesize_batch_widens_guard_to_design_still_loading() -> None:
    """Same gap as `test_synthesize_widens_guard_to_design_still_loading`,
    for the batch path — `Castwright#2678`'s actual repro hit
    `synthesize_batch()`, which is what the chapter-render endpoint drives.
    """
    engine = main.QwenEngine()
    engine._design = None

    release = threading.Event()
    entered = threading.Event()

    def hold_design_in_flight() -> None:
        with engine._design_in_flight.claim():
            entered.set()
            release.wait(5)

    holder = threading.Thread(target=hold_design_in_flight, daemon=True)
    holder.start()
    try:
        assert entered.wait(2), "claim() never entered — test bug"
        assert engine._design is None
        assert engine._design_in_flight.busy is True

        with mock.patch.object(engine, "unload_design") as mocked_unload:
            with pytest.raises(RuntimeError, match="no items"):
                engine.synthesize_batch("0.6b", [])
        mocked_unload.assert_called_once()
    finally:
        release.set()
        holder.join(5)


def test_mint_variant_widens_guard_to_design_still_loading() -> None:
    """#2678 — `mint_variant()`'s render guard must not skip `unload_design()`
    while `design_voice()` has claimed `_design_in_flight` but has not yet
    assigned `self._design` (the heavy VoiceDesign weights are still
    loading). The pre-fix guard (`self._design is not None` alone) is
    `False` in exactly this window, so a mint proceeding here loaded its
    own model concurrently with the design's still-loading one — the
    `Castwright#2678` vram-spill.

    Mutation that must fail this (verified per this ticket's acceptance
    criteria): revert the guard to `self._design is not None`. `_design` is
    still `None` in this test's setup, so the reverted guard is `False` and
    `unload_design` is never called. Code then proceeds to `_ensure_base17_for_mint()`,
    which calls `_ensure_base17_loaded()` → `_load_qwen_model()`. With torch mocked
    as a MagicMock, the `isinstance(e, getattr(torch.cuda, "OutOfMemoryError", ()))`
    check at main.py:5811 raises `TypeError: isinstance() arg 2 must be a type`
    (the mocked torch.cuda returns a MagicMock, not a real type), which proves the
    guard was skipped (unload_design was never called, so execution reached the
    problematic code path).
    """
    engine = main.QwenEngine()
    engine._design = None  # design_voice() has claimed in-flight but not assigned yet

    release = threading.Event()
    entered = threading.Event()

    def hold_design_in_flight() -> None:
        with engine._design_in_flight.claim():
            entered.set()
            release.wait(5)

    holder = threading.Thread(target=hold_design_in_flight, daemon=True)
    holder.start()
    try:
        assert entered.wait(2), "claim() never entered — test bug"
        # The exact gap this fix closes: not-None is False, busy is True.
        assert engine._design is None
        assert engine._design_in_flight.busy is True

        # Bypass early checks to reach the guard
        with mock.patch.dict(sys.modules, {"torch": mock.MagicMock()}):
            with mock.patch("os.path.isfile", return_value=True):
                with mock.patch.object(engine, "_load_voice_prompt", return_value=([None], None, None)):
                    with mock.patch.object(
                        engine, "unload_design", side_effect=_StoppedAfterGuard
                    ) as mocked_unload:
                        with pytest.raises(_StoppedAfterGuard):  # Proof: guard reached and called unload_design
                            engine.mint_variant(
                                base_voice_id="__nonexistent_base_for_test__",
                                variant_voice_id="__nonexistent_variant_for_test__",
                                emotion_instruct="happy",
                                language="en",
                                calibration_text=None,
                            )
        mocked_unload.assert_called_once()
    finally:
        release.set()
        holder.join(5)
