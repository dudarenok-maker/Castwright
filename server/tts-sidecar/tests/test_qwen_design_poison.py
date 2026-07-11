"""CUDA-poison classification for /qwen/design-voice and /qwen/mint-variant
(issue: the bulk 'Design full cast' job silently ground through every
character on GPU contention because these two routes never checked
_CUDA_POISON_RE like /transcribe and /embed already do — see
docs/superpowers/specs/2026-07-11-cast-design-job-hardening-design.md)."""

import pytest
from fastapi.testclient import TestClient

import main


def _reset_poison_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mirrors test_speaker_embed.py's test_embed_load_poison_is_fenced: clear
    both guard flags so the route reaches the design call, and stub
    _mark_cuda_poisoned so the test process never schedules a real
    threading.Timer-based os._exit."""
    monkeypatch.setattr(main, "_process_poisoned", False, raising=False)
    monkeypatch.setattr(main, "_restart_pending", False, raising=False)
    monkeypatch.setattr(main, "_mark_cuda_poisoned", lambda reason: None)


class _FakeQwenOom(main.QwenEngine):
    def __init__(self):
        pass  # skip the real heavy __init__; the route only calls design_voice

    def design_voice(self, voice_id, instruct, language, calibration_text, voice_uuid=None, report_progress=None, mint_method=None, fallback_for=None):
        raise RuntimeError(
            "CUDA out of memory. Tried to allocate 20.00 MiB (GPU 0; 8.00 GiB total capacity; "
            "7.90 GiB already allocated)"
        )


class _FakeQwenOther(main.QwenEngine):
    def __init__(self):
        pass

    def design_voice(self, voice_id, instruct, language, calibration_text, voice_uuid=None, report_progress=None, mint_method=None, fallback_for=None):
        raise RuntimeError("some unrelated, unclassified failure")


def test_design_voice_oom_returns_classified_503(monkeypatch: pytest.MonkeyPatch):
    _reset_poison_guards(monkeypatch)
    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwenOom())

    client = TestClient(main.app)
    res = client.post("/qwen/design-voice", json={"voiceId": "qwen-x", "instruct": "warm"})

    assert res.status_code == 503
    body = res.json()
    assert body["code"] == "gpu_poisoned"
    assert body["poisoned"] is True
    assert "GPU is out of memory" in body["detail"]
    assert body["detail"] != "Internal error."


def test_design_voice_non_poison_exception_stays_generic_500(monkeypatch: pytest.MonkeyPatch):
    _reset_poison_guards(monkeypatch)
    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwenOther())

    client = TestClient(main.app)
    res = client.post("/qwen/design-voice", json={"voiceId": "qwen-x", "instruct": "warm"})

    assert res.status_code == 500
    assert res.json() == {"detail": "Internal error."}
