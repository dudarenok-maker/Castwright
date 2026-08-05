"""#2070 review R6/R10 — every route whose engine call can raise
`DesignContentionTimeoutError` (the design-wins eviction policy's typed
timeout, #2070) must map it to the same non-poisoned, retry-safe 503
(`code: "design_in_flight"`) — not fall into the generic `except Exception`
-> 500 `{"detail": "Internal error."}` arm.

Three call sites reach `unload_design()` and so can raise this:
`/synthesize` and `/synthesize-batch` (both had the arm already) and
`/qwen/mint-variant` (review R6 — this one was missing it entirely and
fell into the generic 500). All three are covered here so a future call
site gains coverage automatically only if it's added to this file — the
route wiring itself is untestable from `test_design_contention.py`, which
drives `unload_design()` directly, never through a route."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main


def _reset_poison_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "_process_poisoned", False, raising=False)
    monkeypatch.setattr(main, "_restart_pending", False, raising=False)


def test_synthesize_maps_design_contention_timeout_to_503(monkeypatch: pytest.MonkeyPatch) -> None:
    _reset_poison_guards(monkeypatch)

    class _FakeEngine:
        def synthesize(self, model, voice, text, language=None):
            raise main.DesignContentionTimeoutError(
                "Qwen VoiceDesign has been in flight for over 150s — refusing to evict it."
            )

    monkeypatch.setitem(main.ENGINES, "coqui", _FakeEngine())
    client = TestClient(main.app)
    res = client.post(
        "/synthesize",
        json={"engine": "coqui", "model": "xtts_v2", "voice": "v", "text": "hi"},
    )

    assert res.status_code == 503
    body = res.json()
    assert body["code"] == "design_in_flight"
    assert body.get("poisoned") is not True
    assert body["detail"] != "Internal error."


def test_synthesize_batch_maps_design_contention_timeout_to_503(monkeypatch: pytest.MonkeyPatch) -> None:
    _reset_poison_guards(monkeypatch)

    class _FakeQwen:
        def synthesize_batch(self, model, items, live_instruct=False):
            raise main.DesignContentionTimeoutError("design still in flight")

    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwen())
    client = TestClient(main.app)
    res = client.post(
        "/synthesize-batch",
        json={"engine": "qwen", "model": "0.6b", "items": [{"voice": "a", "text": "hi"}]},
    )

    assert res.status_code == 503
    body = res.json()
    assert body["code"] == "design_in_flight"
    assert body.get("poisoned") is not True
    assert body["detail"] != "Internal error."


def test_mint_variant_maps_design_contention_timeout_to_503(monkeypatch: pytest.MonkeyPatch) -> None:
    """The specific gap review R6 found: this route had NO arm for
    `DesignContentionTimeoutError` at all — it fell through to the generic
    `except Exception` -> 500, contradicting the PR body's and both
    release-notes entries' claim of a 503 here.

    Mutation that must fail it — breaks the PRODUCER: remove the
    `except DesignContentionTimeoutError` arm from `/qwen/mint-variant`
    (main.py `qwen_mint_variant`). The response reverts to a plain 500
    `{"detail": "Internal error."}`.
    """
    _reset_poison_guards(monkeypatch)

    class _FakeQwenMint(main.QwenEngine):
        def __init__(self):
            pass  # skip the real heavy __init__ — the route only calls mint_variant

        def mint_variant(
            self, base_voice_id, variant_voice_id, emotion_instruct,
            language=None, calibration_text=None, voice_uuid=None,
            report_progress=None, device=None,
        ):
            raise main.DesignContentionTimeoutError("design still in flight")

    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwenMint())
    client = TestClient(main.app)
    res = client.post(
        "/qwen/mint-variant",
        json={
            "baseVoiceId": "qwen-base",
            "variantVoiceId": "qwen-base__angry",
            "emotionInstruct": "Delivered angrily, with raised intensity and edge.",
        },
    )

    assert res.status_code == 503
    body = res.json()
    assert body["code"] == "design_in_flight"
    assert body.get("poisoned") is not True
    assert body["detail"] != "Internal error."
