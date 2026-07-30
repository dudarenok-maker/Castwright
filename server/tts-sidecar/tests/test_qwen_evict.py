"""POST /qwen/evict-voice (plan 161).

The server's voice-design 'promote' step moves a previewed embedding onto a
stable voiceId behind the sidecar's back, then calls this endpoint so a voiceId
already resident in the in-memory clone-prompt cache (from an earlier
generation) stops serving the OLD embedding. These tests pin: a hit pops the
entry (`evicted: true`), a miss is a no-op (`evicted: false`), and a missing
voiceId is a 400 — none of which require torch or a loaded model.

Also carries the plan 273 T8 lock/eviction pairing (`unload()` vs. a cold Base
load) — that one DOES exercise a loaded model, via a monkeypatched
`_load_qwen_model` rather than a real torch/qwen_tts load.
"""
from __future__ import annotations

import sys
import threading
import types
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def test_evict_voice_pops_a_cached_prompt():
    qwen = main.ENGINES.get("qwen")
    assert isinstance(qwen, main.QwenEngine)
    with qwen._cache_lock:
        qwen._prompt_cache["qwen-v_test"] = ("PROMPT", "English")
    client = TestClient(main.app)
    res = client.post("/qwen/evict-voice", json={"voiceId": "qwen-v_test"})
    assert res.status_code == 200
    assert res.json() == {"ok": True, "evicted": True}
    with qwen._cache_lock:
        assert "qwen-v_test" not in qwen._prompt_cache


def test_evict_voice_miss_is_a_noop():
    client = TestClient(main.app)
    res = client.post("/qwen/evict-voice", json={"voiceId": "qwen-never-loaded"})
    assert res.status_code == 200
    assert res.json() == {"ok": True, "evicted": False}


def test_evict_voice_requires_a_voice_id():
    client = TestClient(main.app)
    res = client.post("/qwen/evict-voice", json={})
    assert res.status_code == 400


def test_unload_is_not_blocked_by_a_cold_base_load(monkeypatch) -> None:
    """Plan 273 T8 — `unload()` must never queue behind a cold Base load
    triggered by `_guarded_base_synth`'s per-attempt re-ensure.

    Pre-T8, `_guarded_base_synth` ran `ensure_loaded()` INSIDE `with
    self._synth_lock:`; `unload()` also takes `_synth_lock`, so a cold load
    triggered by that call held a Stop off for the whole (multi-second real)
    weights pull. T8 hoists the re-ensure to run before the lock is taken.

    Drives `_guarded_base_synth` directly on a cold engine — the same entry
    point `synthesize`'s 0.6B-Base path uses — with `_load_qwen_model`
    monkeypatched to park on an Event, standing in for the real load.

    Mutation that must fail it — breaks the PRODUCER: move `ensure_loaded()`
    back inside `with self._synth_lock:`. `unload()` then queues behind the
    parked load and the 0.5s bound trips.
    """
    # Stub torch so `_ensure_device_resolved` (called before `_load_qwen_model`,
    # which we monkeypatch below) never touches the real CUDA runtime — a real
    # first-touch CUDA context init is occasionally slow enough on its own to
    # make the bounded waits below flaky, independent of anything under test.
    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: False, empty_cache=lambda: None,
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    engine = main.QwenEngine()
    engine._base = None
    engine._device_pref = "cpu"

    entry = threading.Event()
    release = threading.Event()

    class _FakeBase:
        def generate_voice_clone(self, text, language, voice_clone_prompt):
            return [np.zeros(2400, dtype=np.float32)], 24000

    def fake_load_qwen_model(model_id: str):
        entry.set()
        assert release.wait(5), "release never set — test bug"
        return _FakeBase()

    monkeypatch.setattr(engine, "_load_qwen_model", fake_load_qwen_model)

    synth_errors: list[BaseException] = []

    def run_synth() -> None:
        try:
            engine._guarded_base_synth(
                "_base", engine._ensure_base_loaded, engine.BASE_MODEL,
                "hello there friend", "English", ["p"],
            )
        except BaseException as e:  # noqa: BLE001 - asserted on below
            synth_errors.append(e)

    t = threading.Thread(target=run_synth, daemon=True)
    t.start()

    assert entry.wait(5), "the cold Base load never entered _load_qwen_model"

    stop = threading.Thread(target=engine.unload, daemon=True)
    stop.start()
    stop.join(0.5)
    assert not stop.is_alive(), (
        "unload() was blocked behind the parked Base load — the relocated "
        "#1925 defect"
    )

    release.set()
    t.join(5)
    assert not t.is_alive(), "synth thread did not finish within 5s"
    assert synth_errors == [], f"_guarded_base_synth raised: {synth_errors!r}"
