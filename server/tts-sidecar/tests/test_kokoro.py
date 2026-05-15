"""KokoroEngine coverage — module load wiring, English-only voice filter,
synthesis happy path, voice fallback, /speakers integration, /synthesize
HTTP surface.

The real `kokoro_onnx` package isn't installed in CI / the dev venv. These
tests stub it via sys.modules so the load path executes without the
~330 MB of weights, then assert on the engine's internal state and on the
HTTP responses.

The English-only filter (KokoroEngine.ENGLISH_VOICE_PREFIXES) is load-bearing
for this project's scope — non-English voices must NEVER reach the picker
UI or the /synthesize request validator. The filter tests pin that
invariant; if you add a new language prefix, extend the assertions here.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

# Same sys.path bootstrap as the other test modules so `import main` works
# regardless of pytest's collection directory.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# Representative multilingual catalog spanning every language prefix
# Kokoro v1 ships with — used to verify the English filter drops the rest.
# The English subset (af_*, am_*, bf_*, bm_*) here matches the curated
# names from the project plan; expand if Kokoro adds new names.
_FAKE_VOICE_MANIFEST = [
    # American female (af_)
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_aoede",
    "af_jessica", "af_kore", "af_alloy", "af_river",
    # American male (am_)
    "am_michael", "am_onyx", "am_adam", "am_eric", "am_liam",
    # British female (bf_)
    "bf_emma", "bf_alice",
    # British male (bm_)
    "bm_george", "bm_lewis",
    # Non-English: Spanish, French, Hindi, Italian, Japanese, Portuguese, Chinese
    "ef_dora", "em_alex",
    "ff_siwis",
    "hf_alpha", "hm_omega",
    "if_sara",
    "jf_alpha", "jm_kumo",
    "pf_dora",
    "zf_xiaobei", "zm_yunjian",
]


class _FakeKokoro:
    """Stand-in for kokoro_onnx.Kokoro. Implements just the surface
    KokoroEngine touches: constructor with model+voices paths, get_voices(),
    create(). The audio array is a one-second flat-zero numpy float32
    buffer at 24 kHz — enough to exercise the int16 conversion."""

    def __init__(
        self,
        model_path: str,
        voices_path: str,
        voices: Optional[list[str]] = None,
    ) -> None:
        self.model_path = model_path
        self.voices_path = voices_path
        # The voices list is parameterisable so tests can inject a specific
        # manifest (full multilingual, English-only, empty, etc.) without
        # monkeypatching the class.
        self._voices = list(voices) if voices is not None else list(_FAKE_VOICE_MANIFEST)
        self.calls: list[tuple[str, str, float, str]] = []

    def get_voices(self) -> list[str]:
        return list(self._voices)

    def create(self, text: str, voice: str, speed: float, lang: str):
        self.calls.append((text, voice, speed, lang))
        # 24 kHz × 1 s × float32 ∈ [-1, 1]. Real kokoro-onnx returns the
        # tuple form (samples, sample_rate); mirror that.
        samples = np.zeros(24000, dtype=np.float32)
        return samples, 24000


@pytest.fixture
def fake_kokoro_module(monkeypatch):
    """Insert a fake `kokoro_onnx` module into sys.modules so
    KokoroEngine._ensure_loaded's `from kokoro_onnx import Kokoro` works
    without the real package. Yields the _FakeKokoro class so tests can
    assert on its constructor args / call log."""
    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _FakeKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)
    yield _FakeKokoro


@pytest.fixture
def fake_weight_files(monkeypatch, tmp_path):
    """Create empty weight + manifest files at the paths KokoroEngine
    expects so its `os.path.isfile` checks pass. Real kokoro-onnx would
    fail to load these — but the _FakeKokoro stub doesn't read them, so
    the test only needs the existence check to succeed."""
    model_path = tmp_path / "kokoro-v1.0.onnx"
    voices_path = tmp_path / "voices-v1.0.bin"
    model_path.write_bytes(b"")
    voices_path.write_bytes(b"")
    monkeypatch.setenv("KOKORO_MODEL_PATH", str(model_path))
    monkeypatch.setenv("KOKORO_VOICES_PATH", str(voices_path))
    yield {"model": str(model_path), "voices": str(voices_path)}


# ── KokoroEngine load wiring ─────────────────────────────────────────────

def test_kokoro_load_populates_english_voices_only(fake_kokoro_module, fake_weight_files) -> None:
    """The full Kokoro manifest spans ~8 languages; only af_/am_/bf_/bm_
    voices should reach _voices. Regression: if the prefix tuple drifts
    or the filter is removed, non-English voices would leak into the
    picker and the per-character override UI — that's exactly the
    "clutter" the user explicitly didn't want."""
    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")

    # Every retained voice must match one of the four English prefixes.
    for v in engine._voices:
        assert v.startswith(("af_", "am_", "bf_", "bm_")), (
            f"non-English voice '{v}' leaked through the filter"
        )

    # Specific names from the fake manifest that should survive.
    assert "af_heart" in engine._voices
    assert "bm_george" in engine._voices

    # Names that must be filtered out.
    for foreign in ("ef_dora", "ff_siwis", "hf_alpha", "if_sara", "jf_alpha", "pf_dora", "zf_xiaobei"):
        assert foreign not in engine._voices, f"foreign voice '{foreign}' leaked through filter"


def test_kokoro_load_is_idempotent(fake_kokoro_module, fake_weight_files) -> None:
    """Calling _ensure_loaded a second time is a no-op — the model stays
    the same instance. This matches CoquiEngine's behaviour and is what
    the eager-preload-on-startup pattern relies on."""
    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")
    first = engine._kokoro
    engine._ensure_loaded("v1")
    assert engine._kokoro is first


def test_kokoro_load_fails_loudly_when_kokoro_onnx_missing(fake_weight_files, monkeypatch) -> None:
    """If kokoro-onnx isn't installed, the import raises and we surface
    the install hint. Critical UX: a generic ImportError tells the user
    nothing; this wraps it with the pip command that fixes the problem.

    Simulates the missing module by installing an import hook that
    raises ImportError specifically for `kokoro_onnx`. Works whether or
    not the real package is installed in the test venv — needed because
    once Kokoro is installed in CI / dev venv, a simple sys.modules.pop
    just lets the next import succeed from the on-disk package."""
    sys.modules.pop("kokoro_onnx", None)

    class _BlockKokoroFinder:
        def find_spec(self, name, *_args, **_kwargs):
            if name == "kokoro_onnx":
                raise ImportError("simulated missing kokoro-onnx for test")
            return None

    finder = _BlockKokoroFinder()
    sys.meta_path.insert(0, finder)
    try:
        engine = main.KokoroEngine()
        with pytest.raises(RuntimeError) as excinfo:
            engine._ensure_loaded("v1")
        assert "kokoro-onnx" in str(excinfo.value)
        assert "pip install" in str(excinfo.value)
    finally:
        sys.meta_path.remove(finder)
        sys.modules.pop("kokoro_onnx", None)


def test_kokoro_load_fails_loudly_when_model_file_missing(fake_kokoro_module, monkeypatch, tmp_path) -> None:
    """install-kokoro.ps1 didn't run yet → model file doesn't exist →
    raise with the path + install hint, not a cryptic ONNX error."""
    monkeypatch.setenv("KOKORO_MODEL_PATH", str(tmp_path / "nope.onnx"))
    monkeypatch.setenv("KOKORO_VOICES_PATH", str(tmp_path / "nope.bin"))
    engine = main.KokoroEngine()
    with pytest.raises(RuntimeError) as excinfo:
        engine._ensure_loaded("v1")
    assert "install-kokoro" in str(excinfo.value).lower()


def test_kokoro_load_tolerates_voices_attr_dict_api(fake_weight_files, monkeypatch) -> None:
    """Older kokoro-onnx releases expose voices as a dict attribute instead
    of a get_voices() method. The fallback in _ensure_loaded should handle
    both shapes so a minor-version bump doesn't break the load path."""
    class _OldKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self.voices = {v: object() for v in _FAKE_VOICE_MANIFEST}

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _OldKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")
    # English filter must still apply via the dict.keys() path.
    assert "af_heart" in engine._voices
    assert "ef_dora" not in engine._voices


def test_kokoro_load_tolerates_voice_enumeration_failure(fake_weight_files, monkeypatch) -> None:
    """If neither get_voices() nor a voices attribute exists, _voices stays
    empty rather than crashing the load. /speakers will report an empty
    list (signal that the manifest API drifted), but synthesis still works
    because the substitution gate only fires when _voices is non-empty."""
    class _OpaqueKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            pass

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _OpaqueKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")  # should not raise
    assert engine._voices == []
    assert engine._kokoro is not None


# ── KokoroEngine synthesize ──────────────────────────────────────────────

def test_kokoro_synthesize_returns_pcm_at_native_sample_rate(fake_kokoro_module, fake_weight_files) -> None:
    """Happy path: a known voice produces a SynthResult with int16 LE PCM
    at the model's native rate (24 kHz). The Node side reads the rate
    from the X-Sample-Rate header at the HTTP layer; we test the engine
    output here directly."""
    engine = main.KokoroEngine()
    result = engine.synthesize("v1", "af_heart", "Hello, world.")
    assert result.sample_rate == 24000
    # 1 s of zero-valued audio = 24000 int16 samples = 48000 bytes.
    assert len(result.pcm) == 48000
    assert result.substituted_from is None


def test_kokoro_synthesize_substitutes_unknown_voice(fake_kokoro_module, fake_weight_files) -> None:
    """A voice ID not in the English manifest (here: a non-English ID like
    ef_dora) falls back to af_heart and sets substituted_from. The Node
    side surfaces this as a warning so the upstream catalog can be
    fixed — synthesis still completes for the chapter rather than
    failing the whole render."""
    engine = main.KokoroEngine()
    result = engine.synthesize("v1", "ef_dora", "Bonjour.")
    assert result.substituted_from == "ef_dora"
    # The fake records the actual voice handed to create() — must be
    # af_heart, not the requested ef_dora.
    assert engine._kokoro.calls[-1][1] == "af_heart"


def test_kokoro_synthesize_passes_speed_one_and_language(fake_kokoro_module, fake_weight_files, monkeypatch) -> None:
    """Quality config invariants: speed must always be 1.0 (no speed-up
    that degrades prosody) and the language code reaches the phonemiser.
    KOKORO_LANGUAGE defaults to en-us; an override should flow through."""
    monkeypatch.setenv("KOKORO_LANGUAGE", "en-gb")
    engine = main.KokoroEngine()
    engine.synthesize("v1", "bf_emma", "Hello there.")
    text, voice, speed, lang = engine._kokoro.calls[-1]
    assert speed == 1.0
    assert lang == "en-gb"
    assert voice == "bf_emma"
    assert text == "Hello there."


def test_kokoro_synthesize_handles_create_returning_array_only(fake_weight_files, monkeypatch) -> None:
    """Defensive: a future kokoro-onnx release might drop the (samples,
    sr) tuple form and return just the array. Engine should fall back
    to NATIVE_SAMPLE_RATE rather than crashing on the unpack."""
    class _ArrayOnlyKokoro(_FakeKokoro):
        def create(self, text: str, voice: str, speed: float, lang: str):
            super().create(text, voice, speed, lang)
            return np.zeros(24000, dtype=np.float32)

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _ArrayOnlyKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    engine = main.KokoroEngine()
    result = engine.synthesize("v1", "af_heart", "Hi.")
    assert result.sample_rate == 24000
    assert len(result.pcm) == 48000


def test_kokoro_unload_drops_state(fake_kokoro_module, fake_weight_files) -> None:
    """unload() drops the kokoro instance + voice list. Subsequent
    _ensure_loaded reinitialises. Matches CoquiEngine's semantics."""
    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")
    assert engine._kokoro is not None
    engine.unload()
    assert engine._kokoro is None
    assert engine._voices == []
    # Re-load works.
    engine._ensure_loaded("v1")
    assert engine._kokoro is not None
    assert "af_heart" in engine._voices


# ── HTTP integration ─────────────────────────────────────────────────────

@pytest.fixture
def kokoro_client(monkeypatch, fake_kokoro_module, fake_weight_files):
    """TestClient with a preloaded KokoroEngine registered. The Coqui
    engine is left untouched — both should coexist in ENGINES."""
    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")
    monkeypatch.setitem(main.ENGINES, "kokoro", engine)
    with TestClient(main.app) as c:
        c.app_state_kokoro = engine  # type: ignore[attr-defined]
        yield c


def test_speakers_includes_kokoro_english_subset(kokoro_client: TestClient) -> None:
    """/speakers must surface Kokoro voices keyed under 'kokoro' AND those
    voices must all be in the English subset. This is the contract the
    Node-side base-voices aggregator depends on — if non-English voices
    leak here, they show up in the picker."""
    r = kokoro_client.get("/speakers")
    assert r.status_code == 200
    body = r.json()
    assert "kokoro" in body
    voices = body["kokoro"]
    assert len(voices) > 0
    for v in voices:
        assert v.startswith(("af_", "am_", "bf_", "bm_")), (
            f"non-English voice '{v}' surfaced via /speakers"
        )
    # The count from the fake manifest matches the curated English subset.
    # If the manifest grows or shrinks, update _FAKE_VOICE_MANIFEST.
    assert len(voices) == 18  # 9 af + 5 am + 2 bf + 2 bm


def test_synthesize_routes_kokoro_engine(kokoro_client: TestClient) -> None:
    """POST /synthesize with engine=kokoro must route to KokoroEngine and
    return clean PCM with the right sample-rate header. The Coqui-specific
    poison fence must NOT fire for Kokoro requests (kokoro is ONNX, not
    PyTorch — different failure mode)."""
    r = kokoro_client.post(
        "/synthesize",
        json={"engine": "kokoro", "model": "v1", "voice": "af_heart", "text": "Hello."},
    )
    assert r.status_code == 200
    assert r.headers["X-Sample-Rate"] == "24000"
    assert r.headers["content-type"].startswith("audio/L16")
    assert len(r.content) == 48000


def test_synthesize_kokoro_substitutes_foreign_voice(kokoro_client: TestClient) -> None:
    """A request for a non-English voice (ef_dora) must complete with
    fallback to af_heart and an X-Voice-Substituted-From header. This
    is the user-visible signal that the upstream catalog has an issue."""
    r = kokoro_client.post(
        "/synthesize",
        json={"engine": "kokoro", "model": "v1", "voice": "ef_dora", "text": "Hola."},
    )
    assert r.status_code == 200
    assert r.headers.get("X-Voice-Substituted-From") == "ef_dora"
