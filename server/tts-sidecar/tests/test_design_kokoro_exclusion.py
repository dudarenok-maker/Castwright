"""Unit tests for the VoiceDesign<->Kokoro arbiter (resident-VRAM exclusion).

The arbiter guarantees a VoiceDesign forward and Kokoro synths never overlap,
while letting Kokoro synths run concurrently with each other when no design is
active. See docs/.../2026-06-09-voice-design-contention-robustness-design.md.
"""
import sys
import threading
import time
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from main import _VdKokoroArbiter


def test_design_waits_for_in_flight_kokoro_to_drain():
    arb = _VdKokoroArbiter()
    order = []
    started = threading.Event()

    def kokoro():
        with arb.kokoro_synth():
            started.set()
            time.sleep(0.05)
            order.append("kokoro-done")

    def design():
        started.wait()
        with arb.design():
            order.append("design-start")

    t1 = threading.Thread(target=kokoro)
    t2 = threading.Thread(target=design)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert order == ["kokoro-done", "design-start"]


def test_kokoro_blocks_while_design_active():
    arb = _VdKokoroArbiter()
    order = []
    design_holding = threading.Event()
    release_design = threading.Event()

    def design():
        with arb.design():
            design_holding.set()
            release_design.wait(timeout=1)
            order.append("design-done")

    def kokoro():
        design_holding.wait()
        with arb.kokoro_synth():
            order.append("kokoro-start")

    t1 = threading.Thread(target=design)
    t2 = threading.Thread(target=kokoro)
    t1.start()
    t2.start()
    time.sleep(0.05)
    release_design.set()
    t1.join()
    t2.join()

    assert order == ["design-done", "kokoro-start"]


def test_two_kokoro_synths_run_concurrently_when_no_design():
    arb = _VdKokoroArbiter()
    both_in = threading.Barrier(2, timeout=1)
    errors = []

    def kokoro():
        try:
            with arb.kokoro_synth():
                both_in.wait()  # BrokenBarrierError if they can't co-exist
        except Exception as e:  # noqa: BLE001 - surface to the assertion below
            errors.append(e)

    t1 = threading.Thread(target=kokoro)
    t2 = threading.Thread(target=kokoro)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    assert not errors, f"Kokoro synths could not run concurrently: {errors}"
