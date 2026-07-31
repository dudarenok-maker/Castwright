"""Tests for the #1996 render/unload-completion reclaim.

PR #1993 (closing most of #1976) added a bare `gc.collect()` +
`torch.cuda.empty_cache()` reclaim (`_reclaim_device_cache`, wired through
`PlacementController.reclaim` — see test_placement.py's "stranded-cache
reclaim" section), but wired it ONLY into the admission-failure path
(`admit()`/`_resolve_admission()`'s `_reclaim_stranded_cache`). If a chapter
render finishes and nothing else asks for capacity afterward, the stranded
pool that reclaim exists to clean up never gets a chance to run at all —
exactly #1976's acceptance criterion 1, left open by #1993 and tracked as
#1996.

#1996's own "open question": which engine's pool was actually stranded on
the box that produced the measurement (Qwen's own, or ASR's/the speaker
model's, both co-resident in the same session) was never established. The
fix sidesteps that rather than resolving it: `/unload` — the one HTTP route
that reports "engine unloaded" for all three TTS engines (coqui/kokoro/qwen)
— now fires the SAME `_placement.reclaim` hook unconditionally on every call,
regardless of which engine was requested or whether that engine had anything
resident to drop. An engine-agnostic completion hook can't miss the stranded
pool no matter which engine produced it.

These tests drive `/unload` through FastAPI's TestClient and assert the
reclaim hook actually ran — via the SAME "injected probe + a fake reclaim
hook that changes it" seam test_placement.py already established for the
admission-failure path (the issue's own "Test coverage gap" section names
this as the way to pin it without a real allocator)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Add the sidecar root to sys.path so `import main` works regardless of
# pytest's collection directory — same pattern as test_load_admission.py.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


@pytest.fixture
def unload_client(monkeypatch):
    # Fresh, cold engines so no unload path's own `if had:`/`if dropped:` guard
    # is what's actually firing the reclaim underneath us — the completion
    # hook must run regardless of whether anything was resident.
    monkeypatch.setitem(main.ENGINES, "qwen", main.QwenEngine())
    monkeypatch.setitem(main.ENGINES, "coqui", main.CoquiEngine())
    # Drop the real Kokoro engine so TestClient's startup event doesn't try to
    # eager-preload it (mirrors test_load_admission.py's `load_client` fixture).
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    with TestClient(main.app) as c:
        yield c


def test_unload_qwen_fires_completion_reclaim(monkeypatch, unload_client):
    """A cold Qwen engine (`had` False inside `QwenEngine.unload()`, so its OWN
    inline reclaim is a no-op) still gets the completion-hook reclaim — proof
    this doesn't ride on any per-engine unload's own gate."""
    reclaimed = []
    monkeypatch.setattr(main._placement, "reclaim", lambda dk: reclaimed.append(dk))

    r = unload_client.post("/unload", json={"engine": "qwen"})

    assert r.status_code == 200
    assert reclaimed == ["unload:qwen"]


def test_unload_coqui_fires_completion_reclaim(monkeypatch, unload_client):
    reclaimed = []
    monkeypatch.setattr(main._placement, "reclaim", lambda dk: reclaimed.append(dk))

    r = unload_client.post("/unload", json={"engine": "coqui"})

    assert r.status_code == 200
    assert reclaimed == ["unload:coqui"]


def test_unload_kokoro_fires_completion_reclaim(monkeypatch, unload_client):
    """Kokoro isn't even registered in ENGINES here (dropped by the fixture),
    so the branch's own `isinstance(kokoro, KokoroEngine)` guard is False —
    the completion hook must still fire, engine-agnostically."""
    reclaimed = []
    monkeypatch.setattr(main._placement, "reclaim", lambda dk: reclaimed.append(dk))

    r = unload_client.post("/unload", json={"engine": "kokoro"})

    assert r.status_code == 200
    assert reclaimed == ["unload:kokoro"]


def test_unload_default_engine_fires_completion_reclaim(monkeypatch, unload_client):
    """No `engine` key in the body defaults to coqui (the route's existing
    contract) — the completion hook must still fire on that default path."""
    reclaimed = []
    monkeypatch.setattr(main._placement, "reclaim", lambda dk: reclaimed.append(dk))

    r = unload_client.post("/unload", json={})

    assert r.status_code == 200
    assert reclaimed == ["unload:coqui"]


def test_unload_completion_reclaim_recovers_a_stranded_probe(monkeypatch, unload_client):
    """The anti-placebo version: mirrors test_placement.py's
    `test_stranded_cache_reclaim_lets_a_starved_admit_succeed`, but the state
    change is driven by /unload's COMPLETION, not by a later admission
    failure — exactly the gap #1993 left open. An injected probe starts
    starved; only the reclaim hook (fired here) raises it back up, so reading
    the probe again after /unload returns is proof the reclaim actually ran
    as a side effect of completion, not of some later capacity check."""
    state = {"free": 200}

    def probe():
        return [{"kind": "cuda", "index": 0, "label": "g", "totalMb": 8192, "freeMb": state["free"]}]

    monkeypatch.setattr(main._placement, "probe", probe)

    def reclaim(device_key):
        state["free"] = 8000  # the stranded pool comes back, as in #1976's table

    monkeypatch.setattr(main._placement, "reclaim", reclaim)

    assert main._placement.probe()[0]["freeMb"] == 200  # sanity: still starved before

    r = unload_client.post("/unload", json={"engine": "qwen"})

    assert r.status_code == 200
    assert main._placement.probe()[0]["freeMb"] == 8000  # reclaim ran at completion
