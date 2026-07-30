"""QwenEngine clone-voice coverage (fs-38 Wave 3b1).

/qwen/clone-voice distils a CALLER-supplied clip (raw s16le mono PCM) into a
reusable <voiceId>.pt and returns an audition preview — the same clip->.pt
block design_voice uses, but with a real clip (no VoiceDesign model). Reuses
the sys.modules-injected fake qwen_tts/torch fixture from test_qwen3.py.
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

# Put the tests/ directory on sys.path so we can reuse fake_qwen_runtime from
# test_qwen3.py instead of duplicating it here (same bootstrap as
# test_synthesize.py's reuse of test_smoke.py's _FakeEngine). pytest's rootdir
# adjustment doesn't put sibling test files on the path by default on Windows.
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from test_qwen3 import fake_qwen_runtime  # noqa: E402,F401  (reuse the fixture)

def _pcm(n: int = 24000) -> bytes:
    return np.zeros(n, dtype="<i2").tobytes()

def _b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")

def test_clone_voice_writes_pt_and_returns_audition(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    voices_dir = fake_qwen_runtime["dir"]
    client = TestClient(main.app)
    resp = client.post(
        "/qwen/clone-voice",
        content=_pcm(),
        headers={
            "X-Sample-Rate": "24000",
            "X-Voice-Id": "qwen-clone1",
            "X-Ref-Text": _b64("hello there this is a sample of my own voice"),
        },
    )
    assert resp.status_code == 200
    assert resp.headers["X-Sample-Rate"] == "24000"
    assert resp.headers["X-Base-Model"] == engine.BASE_MODEL
    assert len(resp.content) > 0
    # .pt cached under the caller-supplied voiceId; base model used, design NOT.
    assert (voices_dir / "qwen-clone1.pt").is_file()
    assert (voices_dir / "qwen-clone1.json").is_file()
    assert "qwen-clone1" in engine._prompt_cache
    assert engine._design is None                 # VoiceDesign never loaded
    assert engine._base.prompt_calls, "used create_voice_clone_prompt on the base model"

def test_clone_voice_uses_the_supplied_ref_text_not_calibration(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    client = TestClient(main.app)
    client.post(
        "/qwen/clone-voice",
        content=_pcm(),
        headers={"X-Sample-Rate": "24000", "X-Voice-Id": "qwen-clone2",
                 "X-Ref-Text": _b64("my real transcript"),
                 "X-Audition-Text": _b64("audition me please")},
    )
    # ref_text is the caller transcript; audition speaks the audition text.
    assert engine._base.prompt_calls[-1][1] == "my real transcript"
    assert engine._base.clone_calls[-1][0] == ["audition me please"]

def test_clone_voice_rejects_missing_body_and_headers(fake_qwen_runtime) -> None:
    client = TestClient(main.app)
    assert client.post("/qwen/clone-voice", content=b"",
                       headers={"X-Sample-Rate": "24000", "X-Voice-Id": "q", "X-Ref-Text": _b64("t")}).status_code == 400
    assert client.post("/qwen/clone-voice", content=_pcm(),
                       headers={"X-Voice-Id": "q", "X-Ref-Text": _b64("t")}).status_code == 400
    assert client.post("/qwen/clone-voice", content=_pcm(),
                       headers={"X-Sample-Rate": "24000", "X-Ref-Text": _b64("t")}).status_code == 400
    assert client.post("/qwen/clone-voice", content=_pcm(),
                       headers={"X-Sample-Rate": "24000", "X-Voice-Id": "q"}).status_code == 400


def test_clone_voice_cache_entry_survives_a_load_voice_prompt_round_trip(
    fake_qwen_runtime,
) -> None:
    """Regression: clone_voice's post-lock cache warm (main.py ~5290) must
    store the SAME `(prompt, language)` 2-tuple shape as design_voice's and
    _load_voice_prompt_17b's writers — _load_voice_prompt (~5508-5510)
    unconditionally unpacks `prompt, lang = cached`. clone_voice used to
    stash the bare prompt object instead of a tuple, so the very next
    /synthesize call against a freshly-cloned voice (still warm, same
    process) raised `ValueError: not enough values to unpack (expected 2,
    got 1)` and returned an HTTP 500 — restarting the sidecar 'fixed' it
    only because that wipes the in-memory cache, proving the on-disk .pt
    was always fine and the poisoned cache entry was the sole fault.

    The shared fixture's create_voice_clone_prompt fake used to return a
    2-key dict, and a 2-key dict happens to unpack into 2 values WITHOUT
    raising -- which let a naive version of this test pass even with the bug
    present. It's now faithful to the real shape: qwen_tts
    create_voice_clone_prompt returns a LIST of VoiceClonePromptItem,
    normally length 1 (main.py:5908-5911) -- a length-1 list is exactly what
    reproduces the real ValueError (#1951; no per-test monkeypatch needed
    any more).

    This exercises the real write via the HTTP route (same as clone_voice's
    other tests above), then calls the real read path directly — no
    stubbing of _prompt_cache itself, which is the unit under test."""
    engine = fake_qwen_runtime["engine"]
    client = TestClient(main.app)
    resp = client.post(
        "/qwen/clone-voice",
        content=_pcm(),
        headers={
            "X-Sample-Rate": "24000",
            "X-Voice-Id": "qwen-clone-cache",
            "X-Ref-Text": _b64("hello there this is a sample of my own voice"),
            "X-Language": "German",
        },
    )
    assert resp.status_code == 200

    # The clone warmed the in-memory cache synchronously (post-lock, same
    # thread as clone_voice ran on via asyncio.to_thread) — no synth needed
    # to observe it. This call is exactly _load_voice_prompt's unpack site
    # (main.py:5510) that raised ValueError before the fix.
    prompt, lang, cache_hit = engine._load_voice_prompt("qwen-clone-cache")
    assert cache_hit is True  # in-memory hit, not a disk re-load (the miss
    # path would also return a valid triple and would silently mask this bug)
    assert lang == "German"
    assert isinstance(prompt, list) and len(prompt) == 1
