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
drives `unload_design()` directly, never through a route.

The three tests above each use a FAKE engine that raises
`DesignContentionTimeoutError` directly — they cover the route's mapping,
not the producer. `test_synthesize_maps_a_real_unload_design_timeout_to_503`
below is #2070's own acceptance criterion: it drives the REAL chain — a
real `QwenEngine.synthesize()` -> real `unload_design()` -> a real timeout
against a real in-flight claim -> the route's catch — with only the wait
budget shortened so it runs fast."""
from __future__ import annotations

import threading

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


def test_synthesize_maps_a_real_unload_design_timeout_to_503(monkeypatch: pytest.MonkeyPatch) -> None:
    """#2070's own acceptance criterion, driving the REAL chain end to end —
    not a fake engine that raises `DesignContentionTimeoutError` directly
    (that's `test_synthesize_maps_design_contention_timeout_to_503` above).

    A real `QwenEngine` with a resident `_design` and a real in-flight claim
    (mirroring `design_voice()`'s own `with self._design_in_flight.claim():`
    bracket, exactly as `test_design_contention.py` drives `unload_design()`
    directly) is registered as `ENGINES["qwen"]`. `POST /synthesize` then
    runs the real `synthesize()` -> real `unload_design()` -> real bounded
    wait -> real `DesignContentionTimeoutError` -> the route's catch — no
    GPU/torch needed, since the timeout fires before `synthesize()` reaches
    any model load.

    The 150s production wait (`_DESIGN_CONTENTION_WAIT_S_DEFAULT`) is
    shortened by rewriting `QwenEngine.unload_design`'s bound `__defaults__`
    tuple directly — a plain `monkeypatch.setattr(main,
    "_DESIGN_CONTENTION_WAIT_S_DEFAULT", ...)` would NOT reach the running
    method: Python resolves a default argument value once, at function-
    definition time (module import), not per call, so the module-level
    constant is already baked into `unload_design.__defaults__` by the time
    this test runs.

    Mutation that must fail it — breaks the PRODUCER: revert `unload_design`'s
    `while self._design_in_flight.busy: ... raise DesignContentionTimeoutError`
    wait/timeout loop to the pre-#2070 unconditional `self._design = None`
    (silently nulling instead of waiting/raising). The response would then be
    a normal (non-503) synth attempt instead of `design_in_flight` — see
    `test_design_contention.py`'s own mutation note for the equivalent
    producer-level assertion.
    """
    _reset_poison_guards(monkeypatch)
    # Rewrite the bound defaults so the real unload_design() times out fast —
    # (wait_seconds, poll_seconds) in declaration order.
    monkeypatch.setattr(main.QwenEngine.unload_design, "__defaults__", (0.3, 0.02))

    engine = main.QwenEngine()
    engine._design = object()  # any resident, non-None design — identity only matters

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

        monkeypatch.setitem(main.ENGINES, "qwen", engine)
        client = TestClient(main.app)
        res = client.post(
            "/synthesize",
            json={"engine": "qwen", "model": "0.6b", "voice": "some-voice", "text": "hi"},
        )

        assert res.status_code == 503
        body = res.json()
        assert body["code"] == "design_in_flight"
        assert body.get("poisoned") is not True
        assert body["detail"] != "Internal error."
    finally:
        release.set()
        holder.join(5)
