"""POST /qwen/evict-voice (plan 161).

The server's voice-design 'promote' step moves a previewed embedding onto a
stable voiceId behind the sidecar's back, then calls this endpoint so a voiceId
already resident in the in-memory clone-prompt cache (from an earlier
generation) stops serving the OLD embedding. These tests pin: a hit pops the
entry (`evicted: true`), a miss is a no-op (`evicted: false`), and a missing
voiceId is a 400 — none of which require torch or a loaded model.
"""
from __future__ import annotations

import sys
from pathlib import Path

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
