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


def test_kokoro_synthesize_acquires_the_arbiter(monkeypatch):
    """KokoroEngine.synthesize must run its load+create under the arbiter so a
    concurrent design can't start mid-synth."""
    import main

    eng = main.KokoroEngine()
    seen = {"in_flight_during_create": None}

    class _FakeModel:
        def create(self, text, voice, speed, lang):
            seen["in_flight_during_create"] = main._VD_KOKORO._kokoro_in_flight
            import numpy as np
            return np.zeros(10, dtype="float32"), 24000

    eng._kokoro = _FakeModel()
    eng._voices = ["af_heart"]
    monkeypatch.setattr(eng, "_ensure_loaded", lambda model: None)

    eng.synthesize("kokoro", "af_heart", "hello")
    assert seen["in_flight_during_create"] == 1


def test_qwen_base_synth_not_gated_by_vd_kokoro_arbiter(monkeypatch):
    """QwenEngine.synthesize (Base) must complete while _VD_KOKORO.design() is
    held in another thread — i.e. Qwen Base generation is NOT blocked by an
    in-flight VoiceDesign operation. Only KokoroEngine.synthesize gates on the
    arbiter; QwenEngine.synthesize uses only _synth_lock."""
    import main
    import numpy as np

    qeng = main.QwenEngine()

    class _FakeBase:
        def generate_voice_clone(self, text, language, voice_clone_prompt):
            return [np.zeros(10, dtype="float32")], 24000

    qeng._base = _FakeBase()
    # Patch _ensure_base_loaded so the real model isn't required.
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda: None)
    # Patch _load_voice_prompt so no .pt file is needed on disk.
    monkeypatch.setattr(
        qeng,
        "_load_voice_prompt",
        lambda voice: ({"prompt": True}, "english", True),
    )

    design_holding = threading.Event()
    release_design = threading.Event()
    synth_completed = threading.Event()

    def hold_design():
        with main._VD_KOKORO.design():
            design_holding.set()
            release_design.wait(timeout=2)

    design_thread = threading.Thread(target=hold_design)
    design_thread.start()
    design_holding.wait(timeout=1)

    # Qwen Base synthesize must NOT block on _VD_KOKORO — run it from the
    # main thread while design_thread holds arb.design().
    result = qeng.synthesize("qwen3-tts-0.6b", "qwen-narrator", "Hello there.")

    synth_completed.set()
    release_design.set()
    design_thread.join(timeout=2)

    # If we got here, synthesize did not block on _VD_KOKORO.
    assert result is not None, "QwenEngine.synthesize must return a SynthResult"
    assert result.sample_rate == 24000


def test_design_voice_holds_arbiter_and_evicts_resident_kokoro(monkeypatch):
    """design_voice must take arb.design() around its VoiceDesign forward and,
    if Kokoro is resident, unload it first so the 1.7B load has headroom."""
    import main

    qeng = main.QwenEngine()

    # The KokoroEngine singleton lives in ENGINES["kokoro"], not a bare `kokoro`
    # module-level name — reference it through ENGINES.
    kokoro_eng = main.ENGINES["kokoro"]
    kokoro_eng._kokoro = object()  # pretend Kokoro is resident
    unloaded = {"called": False}

    def _fake_unload():
        unloaded["called"] = True
        kokoro_eng._kokoro = None  # simulate the real unload clearing the model

    monkeypatch.setattr(kokoro_eng, "unload", _fake_unload)

    captured = {"design_active": None, "kokoro_resident": None}

    class _FakeDesign:
        def generate_voice_design(self, text, language, instruct):
            captured["design_active"] = main._VD_KOKORO._design_active
            captured["kokoro_resident"] = kokoro_eng._kokoro is not None
            import numpy as np
            return [np.zeros(10, dtype="float32")], 24000

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            import numpy as np
            return [np.zeros(10, dtype="float32")], 24000

    qeng._design = _FakeDesign()
    qeng._base = _FakeBase()
    monkeypatch.setattr(qeng, "_ensure_design_loaded", lambda: None)
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda: None)

    import tempfile
    qeng._voices_dir = tempfile.mkdtemp()
    monkeypatch.setattr("torch.save", lambda *a, **k: None)

    qeng.design_voice("qwen-narrator-preview", "A warm voice.", "english", "Hello there.")

    assert unloaded["called"] is True, "resident Kokoro must be evicted before the design"
    assert captured["design_active"] is True, "design forward must run under arb.design()"
    assert captured["kokoro_resident"] is False, "Kokoro must be unloaded during the design forward"
