"""QwenEngine coverage — registration, /health + /speakers wiring, the
design -> clone -> cache -> reuse contract, fail-fast on an undesigned voice,
and the /qwen/design-voice + /synthesize HTTP surface (plan 108).

Qwen is a per-character BESPOKE-voice engine, not a fixed catalog: a voice is
DESIGNED once from a persona and reused consistently. The real `qwen_tts`
package + multi-GB weights aren't installed in CI / the dev venv, so these
tests stub `qwen_tts` and `torch` via sys.modules (same approach as
test_kokoro.py's _FakeKokoro) and assert on the engine's caching behaviour +
the HTTP responses — not on real audio quality (that's the empirical
model-download step, owned by scripts/install-qwen3.mjs).

Load-bearing invariants pinned here:
  - synthesize() FAILS FAST when the requested voice hasn't been designed
    (no profile-inference fallback — bespoke voices are explicit).
  - design_voice() caches a <voiceId>.pt embedding + <voiceId>.json manifest
    and returns an audition preview.
  - /speakers lists designed voiceIds (from the manifests), available even
    when the model isn't loaded.
"""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


class _FakeQwenModel:
    """Stand-in for qwen_tts.Qwen3TTSModel. Implements just the surface
    QwenEngine touches. Audio is a flat-zero float32 buffer at 24 kHz —
    enough to exercise the int16 conversion + the (wavs, sr) return shape."""

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.design_calls: list[tuple[str, str, str]] = []
        self.clone_calls: list[tuple[Any, Any]] = []
        self.prompt_calls: list[tuple[Any, str]] = []

    @classmethod
    def from_pretrained(cls, model_id: str, **_kwargs: Any) -> "_FakeQwenModel":
        return cls(model_id)

    def generate_voice_design(self, text: str, language: str, instruct: str):
        self.design_calls.append((text, language, instruct))
        return [np.zeros(24000, dtype=np.float32)], 24000

    def create_voice_clone_prompt(self, ref_audio: Any, ref_text: str, **_kwargs: Any):
        self.prompt_calls.append((ref_audio, ref_text))
        # A reusable prompt is opaque to us — return a sentinel the fake
        # torch.save/load round-trips.
        return {"_prompt": True, "ref_text": ref_text}

    def generate_voice_clone(self, text: Any, language: Any, voice_clone_prompt: Any):
        self.clone_calls.append((text, voice_clone_prompt))
        return [np.zeros(12000, dtype=np.float32)], 24000


@pytest.fixture
def fake_qwen_runtime(monkeypatch, tmp_path):
    """Stub `qwen_tts` + `torch` in sys.modules and point the global Qwen
    engine's voices dir at a tmp dir, so design/clone/synth run without the
    real package or weights. Yields the tmp voices dir + the engine."""
    # Fake qwen_tts module.
    fake_qwen = types.ModuleType("qwen_tts")
    fake_qwen.Qwen3TTSModel = _FakeQwenModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "qwen_tts", fake_qwen)

    # Fake torch: save writes a marker file so os.path.isfile passes; load
    # returns a sentinel; cuda helpers are no-ops.
    fake_torch = types.ModuleType("torch")
    _store: dict[str, Any] = {}

    def _save(obj: Any, path: str) -> None:
        _store[str(path)] = obj
        with open(path, "wb") as fh:
            fh.write(b"\x00")  # presence marker for isfile()

    def _load(path: str, **kwargs: Any) -> Any:
        fake_torch._last_load_kwargs = kwargs  # type: ignore[attr-defined]
        return _store.get(str(path), {"_prompt": True})

    fake_torch.save = _save  # type: ignore[attr-defined]
    fake_torch.load = _load  # type: ignore[attr-defined]
    fake_torch.bfloat16 = "bfloat16"  # type: ignore[attr-defined]
    fake_cuda = types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
    fake_torch.cuda = fake_cuda  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)
    monkeypatch.setattr(engine, "_voices_dir", str(tmp_path / "qwen"))
    # Reset any resident model state from a prior test.
    engine._base = None
    engine._design = None
    engine._loading = False
    yield {"dir": tmp_path / "qwen", "engine": engine}
    engine._base = None
    engine._design = None


# ── registration + health/speakers wiring ───────────────────────────────

def test_qwen_registered_in_engines() -> None:
    assert "qwen" in main.ENGINES
    assert isinstance(main.ENGINES["qwen"], main.QwenEngine)
    assert main.ENGINES["qwen"].name == "qwen"


def test_health_exposes_qwen_fields() -> None:
    client = TestClient(main.app)
    body = client.get("/health").json()
    assert "qwen_loaded" in body
    assert "qwen_loading" in body
    assert "qwen" in body["engines"]
    # Not loaded by default (lazy).
    assert body["qwen_loaded"] is False


def test_speakers_lists_designed_voices(fake_qwen_runtime) -> None:
    """/speakers['qwen'] reflects designed voiceIds (manifests on disk),
    available even though the model isn't loaded."""
    engine = fake_qwen_runtime["engine"]
    client = TestClient(main.app)
    assert client.get("/speakers").json().get("qwen") == []

    engine.design_voice("Maerin", "a bright, confident teenage girl", "English", None)
    assert "Maerin" in client.get("/speakers").json()["qwen"]


# ── design -> clone -> cache -> reuse contract ───────────────────────────

def test_design_voice_caches_embedding_and_manifest(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    voices_dir = fake_qwen_runtime["dir"]
    result = engine.design_voice("Hart", "a witty teenage boy, mid-paced", "English", None)

    # Cached embedding + manifest written, keyed by voiceId.
    assert (voices_dir / "Hart.pt").is_file()
    assert (voices_dir / "Hart.json").is_file()
    import json

    manifest = json.loads((voices_dir / "Hart.json").read_text(encoding="utf-8"))
    assert manifest["voiceId"] == "Hart"
    assert manifest["instruct"] == "a witty teenage boy, mid-paced"
    assert manifest["language"] == "English"
    # Audition preview is real PCM bytes.
    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert result.sample_rate == 24000


def test_synthesize_reuses_cached_voice(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    engine.design_voice("Maerin", "a bright, confident teenage girl", "English", None)
    res = engine.synthesize("qwen3-tts-0.6b", "Maerin", "Hello there, this is a test.")
    assert isinstance(res.pcm, bytes) and len(res.pcm) > 0
    # The cached prompt was passed to generate_voice_clone (reuse, not re-design).
    assert engine._base is not None
    assert len(engine._base.clone_calls) >= 1
    # Regression: PyTorch 2.6+ defaults torch.load(weights_only=True), which
    # rejects the qwen_tts VoiceClonePromptItem object we cache. The engine
    # MUST load with weights_only=False (the file is our own, trusted output).
    import torch as _t  # the stubbed module from the fixture

    assert _t._last_load_kwargs.get("weights_only") is False


def test_synthesize_fails_fast_on_undesigned_voice(fake_qwen_runtime) -> None:
    """No catalog fallback — an unknown voiceId must raise, not silently
    substitute. Pins the bespoke-voice invariant."""
    engine = fake_qwen_runtime["engine"]
    with pytest.raises(RuntimeError) as excinfo:
        engine.synthesize("qwen3-tts-0.6b", "never-designed", "Hello.")
    assert "design" in str(excinfo.value).lower()


# ── QWEN_VOICES_DIR relocation + legacy migration (sidecar-qwen-voice-dir) ──

def test_voices_dir_resolves_from_env(monkeypatch, tmp_path) -> None:
    """QWEN_VOICES_DIR overrides the __file__-relative default. Pins that a
    fresh QwenEngine reads the env (the Node server points it at the
    per-workspace tree so restarts can't orphan designed voices)."""
    target = tmp_path / "ws" / "voices" / "qwen"
    monkeypatch.setenv("QWEN_VOICES_DIR", str(target))
    engine = main.QwenEngine()
    assert engine._voices_dir == str(target)


def test_voices_dir_defaults_to_file_relative_when_env_unset(monkeypatch) -> None:
    """Back-compat: unset QWEN_VOICES_DIR keeps the legacy __file__-relative
    voices/qwen dir exactly as before."""
    monkeypatch.delenv("QWEN_VOICES_DIR", raising=False)
    engine = main.QwenEngine()
    expected = os.path.join(os.path.dirname(main.__file__), "voices", "qwen")
    assert engine._voices_dir == expected


def test_designed_voice_survives_restart_at_env_dir(monkeypatch, tmp_path) -> None:
    """Design a voice with QWEN_VOICES_DIR set, then simulate a sidecar
    restart (a brand-new engine instance with _base reset) and synthesize:
    the cached .pt is found at the env-pointed dir, no ENOENT."""
    # Stub qwen_tts + torch exactly like the fake_qwen_runtime fixture, but
    # construct the engine ourselves so __init__ reads QWEN_VOICES_DIR.
    fake_qwen = types.ModuleType("qwen_tts")
    fake_qwen.Qwen3TTSModel = _FakeQwenModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "qwen_tts", fake_qwen)

    fake_torch = types.ModuleType("torch")
    _store: dict[str, Any] = {}

    def _save(obj: Any, path: str) -> None:
        _store[str(path)] = obj
        with open(path, "wb") as fh:
            fh.write(b"\x00")

    def _load(path: str, **kwargs: Any) -> Any:
        return _store.get(str(path), {"_prompt": True})

    fake_torch.save = _save  # type: ignore[attr-defined]
    fake_torch.load = _load  # type: ignore[attr-defined]
    fake_torch.bfloat16 = "bfloat16"  # type: ignore[attr-defined]
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: False, empty_cache=lambda: None
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    voices_dir = tmp_path / "ws" / "voices" / "qwen"
    monkeypatch.setenv("QWEN_VOICES_DIR", str(voices_dir))

    # First boot: design + cache a voice.
    engine = main.QwenEngine()
    assert engine._voices_dir == str(voices_dir)
    engine.design_voice("Marlow", "a charming, mischievous teenage boy", "English", None)
    assert (voices_dir / "Marlow.pt").is_file()

    # Simulate a restart: a fresh engine (resident model gone) reading the
    # same env-pointed dir. Synthesis must find the cached embedding.
    restarted = main.QwenEngine()
    assert restarted._base is None
    res = restarted.synthesize("qwen3-tts-0.6b", "Marlow", "Hi there.")
    assert isinstance(res.pcm, bytes) and len(res.pcm) > 0
    assert restarted._base is not None  # loaded on demand, found the .pt


def test_legacy_voices_migrated_to_env_dir(monkeypatch, tmp_path) -> None:
    """On init, if QWEN_VOICES_DIR relocates the cache and the legacy
    __file__-relative dir holds *.pt embeddings while the target is empty,
    the legacy files are moved (shutil.move) into the new dir."""
    # Seed a fake legacy voices/qwen dir next to main.py with one voice.
    legacy_dir = os.path.join(os.path.dirname(main.__file__), "voices", "qwen")
    os.makedirs(legacy_dir, exist_ok=True)
    legacy_pt = os.path.join(legacy_dir, "_migtest.pt")
    legacy_json = os.path.join(legacy_dir, "_migtest.json")
    try:
        with open(legacy_pt, "wb") as fh:
            fh.write(b"\x00")
        with open(legacy_json, "w", encoding="utf-8") as fh:
            fh.write('{"voiceId": "_migtest"}')

        target = tmp_path / "ws" / "voices" / "qwen"
        monkeypatch.setenv("QWEN_VOICES_DIR", str(target))
        main.QwenEngine()  # __init__ runs the migration

        # Moved into the new dir, removed from the legacy dir.
        assert (target / "_migtest.pt").is_file()
        assert (target / "_migtest.json").is_file()
        assert not os.path.exists(legacy_pt)
        assert not os.path.exists(legacy_json)
    finally:
        for p in (legacy_pt, legacy_json):
            if os.path.exists(p):
                os.remove(p)


def test_legacy_migration_skipped_when_target_already_populated(monkeypatch, tmp_path) -> None:
    """Migration is a no-op when the target dir already holds a designed
    voice — never clobbers an existing workspace cache."""
    legacy_dir = os.path.join(os.path.dirname(main.__file__), "voices", "qwen")
    os.makedirs(legacy_dir, exist_ok=True)
    legacy_pt = os.path.join(legacy_dir, "_migtest2.pt")
    try:
        with open(legacy_pt, "wb") as fh:
            fh.write(b"\x00")

        target = tmp_path / "ws" / "voices" / "qwen"
        target.mkdir(parents=True)
        (target / "existing.pt").write_bytes(b"\x00")
        monkeypatch.setenv("QWEN_VOICES_DIR", str(target))
        main.QwenEngine()

        # Target untouched; legacy file left in place (no merge).
        assert (target / "existing.pt").is_file()
        assert not (target / "_migtest2.pt").exists()
        assert os.path.exists(legacy_pt)
    finally:
        if os.path.exists(legacy_pt):
            os.remove(legacy_pt)


def test_import_missing_qwen_tts_raises_with_pip_hint(monkeypatch) -> None:
    """A missing qwen-tts package surfaces the install command, not a bare
    ImportError."""
    sys.modules.pop("qwen_tts", None)

    class _BlockFinder:
        def find_spec(self, name, *_a, **_k):
            if name == "qwen_tts":
                raise ImportError("simulated missing qwen-tts")
            return None

    finder = _BlockFinder()
    sys.meta_path.insert(0, finder)
    try:
        engine = main.QwenEngine()
        with pytest.raises(RuntimeError) as excinfo:
            engine._load_qwen_model(engine.BASE_MODEL)
        assert "qwen-tts" in str(excinfo.value)
        assert "pip install" in str(excinfo.value)
    finally:
        sys.meta_path.remove(finder)
        sys.modules.pop("qwen_tts", None)


# ── HTTP surface ─────────────────────────────────────────────────────────

def test_design_voice_route_returns_preview_pcm(fake_qwen_runtime) -> None:
    client = TestClient(main.app)
    resp = client.post(
        "/qwen/design-voice",
        json={"voiceId": "Wren", "instruct": "a curious, earnest teenage girl"},
    )
    assert resp.status_code == 200
    assert resp.headers["X-Sample-Rate"] == "24000"
    assert len(resp.content) > 0


def test_design_voice_route_requires_voiceid_and_instruct(fake_qwen_runtime) -> None:
    client = TestClient(main.app)
    assert client.post("/qwen/design-voice", json={"instruct": "x"}).status_code == 400
    assert client.post("/qwen/design-voice", json={"voiceId": "x"}).status_code == 400


def test_synthesize_route_routes_qwen(fake_qwen_runtime) -> None:
    client = TestClient(main.app)
    client.post(
        "/qwen/design-voice",
        json={"voiceId": "Brann", "instruct": "a calm, kind teenage boy"},
    )
    resp = client.post(
        "/synthesize",
        json={"engine": "qwen", "model": "qwen3-tts-0.6b", "voice": "Brann", "text": "Hi."},
    )
    assert resp.status_code == 200
    assert resp.headers["X-Sample-Rate"] == "24000"
    assert len(resp.content) > 0


def test_synthesize_route_500s_on_undesigned_qwen_voice(fake_qwen_runtime) -> None:
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize",
        json={"engine": "qwen", "model": "qwen3-tts-0.6b", "voice": "ghost", "text": "Hi."},
    )
    assert resp.status_code == 500


# ── load / unload ─────────────────────────────────────────────────────────

def test_unload_is_idempotent(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    engine.unload()  # no model — no-op
    engine._ensure_base_loaded()
    assert engine._base is not None
    engine.unload()
    assert engine._base is None
    engine.unload()  # again — still fine
