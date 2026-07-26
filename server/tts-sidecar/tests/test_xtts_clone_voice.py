"""CoquiEngine cloned-voice latents plumbing (fs-38 Wave 3c, task 7).

This task only establishes the artifact directory + path helper that later
tasks (clone-voice ingest, synth-time lookup) will write to and read from —
`self._voices_dir` (env-overridable, sibling convention to
`QwenEngine`'s `QWEN_VOICES_DIR`) and `_voice_paths(voice_id) ->
(pt_path, json_path)`. No endpoint exists yet, so these tests instantiate
`CoquiEngine` directly (its `__init__` never touches torch, so no
sys.modules stub is needed — same pattern as test_coqui_device.py).
"""
from __future__ import annotations

import base64
import json
import os
import pickle
import sys
import threading
import time
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


def test_voices_dir_defaults_next_to_sidecar(monkeypatch) -> None:
    """No XTTS_VOICES_DIR set → falls back to <sidecar>/voices/xtts, the
    sibling convention to QwenEngine's legacy_voices_dir default."""
    monkeypatch.delenv("XTTS_VOICES_DIR", raising=False)
    eng = main.CoquiEngine()
    expected = os.path.join(os.path.dirname(main.__file__), "voices", "xtts")
    assert eng._voices_dir == expected


def test_voices_dir_honours_env_override(tmp_path, monkeypatch) -> None:
    """XTTS_VOICES_DIR set (the Node side points it at <workspace>/voices/xtts)
    → CoquiEngine uses it verbatim, not the sidecar-relative default."""
    override = str(tmp_path / "workspace-voices-xtts")
    monkeypatch.setenv("XTTS_VOICES_DIR", override)
    eng = main.CoquiEngine()
    assert eng._voices_dir == override


def test_key_prefix_constant() -> None:
    assert main.CoquiEngine.XTTS_KEY_PREFIX == "xtts-"


def test_voice_paths_ascii_id_is_identity(monkeypatch) -> None:
    """An already-filename-safe id round-trips byte-for-byte — no hash
    suffix — mirroring QwenEngine._voice_paths's ASCII fast path."""
    monkeypatch.delenv("XTTS_VOICES_DIR", raising=False)
    eng = main.CoquiEngine()
    pt_path, json_path = eng._voice_paths("xtts-abc")
    assert pt_path == os.path.join(eng._voices_dir, "xtts-abc.pt")
    assert json_path == os.path.join(eng._voices_dir, "xtts-abc.json")


def test_voice_paths_lossy_sanitisation_stays_injective(monkeypatch) -> None:
    """Two distinct non-ASCII voice ids that `re.sub` would otherwise both
    flatten to the same run of underscores must resolve to DIFFERENT
    filenames — each gets its own stable sha1-derived suffix, so a purge (or
    a later re-derive) of one voice's latents can never collide with, or
    silently clobber, the other's."""
    monkeypatch.delenv("XTTS_VOICES_DIR", raising=False)
    eng = main.CoquiEngine()
    pt_a, json_a = eng._voice_paths("xtts-Ёлка")
    pt_b, json_b = eng._voice_paths("xtts-Йлка")
    assert pt_a != pt_b
    assert json_a != json_b
    # Both still land under the configured voices dir with the expected
    # extensions — the hash suffix changes the stem, not the shape.
    for p in (pt_a, pt_b):
        assert os.path.dirname(p) == eng._voices_dir
        assert p.endswith(".pt")
    for p in (json_a, json_b):
        assert p.endswith(".json")


# ── Task 9 — CoquiEngine.clone_voice (config-faithful latents derive) ──────
#
# No HTTP endpoint exists yet (Task 11 adds POST /xtts/clone-voice), so these
# tests call `CoquiEngine.clone_voice` directly, with a fake `TTS.api.TTS` +
# `torch` installed via sys.modules (same technique as
# test_concurrent_synthesis.py's `coqui_load_stubs` / test_coqui_device.py's
# `_stub_coqui_load`, inlined here to keep this file's fixtures
# self-contained). The fake `tts_model` mirrors the REAL `Xtts` low-level
# API shape closely enough to exercise the two verified traps: config-
# derived `get_conditioning_latents` kwargs, and a path-not-array audio
# input.


class _FakeXttsConfig:
    """Coqpit-`.get(key, default)`-shaped config stub. Defaults intentionally
    DIFFER from `get_conditioning_latents`'s own bare-signature defaults
    (6/6/30/False) below, so a test asserting the derive call received the
    CONFIG value (not the bare default) actually proves something."""

    def __init__(self, **overrides: Any) -> None:
        self.gpt_cond_len = 12
        self.gpt_cond_chunk_len = 4
        self.max_ref_len = 10
        self.sound_norm_refs = True
        self.temperature = 0.85
        self.length_penalty = 1.0
        self.repetition_penalty = 2.0
        self.top_k = 50
        self.top_p = 0.85
        self.languages = ["en", "es", "fr", "de", "it"]
        for k, v in overrides.items():
            setattr(self, k, v)

    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)


class _FakeXttsModel:
    """Stands in for `Xtts.synthesizer.tts_model`. Signature mirrors the
    real `get_conditioning_latents`/`inference` closely enough that
    `inspect.signature(...)` introspection in `clone_voice` behaves exactly
    as it would against the real class."""

    def __init__(self, config: "_FakeXttsConfig | None" = None) -> None:
        self.config = config or _FakeXttsConfig()
        self.derive_calls: list[dict[str, Any]] = []
        self.infer_calls: list[dict[str, Any]] = []
        self.derive_exc: Exception | None = None

    def get_conditioning_latents(
        self,
        audio_path: Any,
        max_ref_length: int = 30,
        gpt_cond_len: int = 6,
        gpt_cond_chunk_len: int = 6,
        librosa_trim_db: Any = None,
        sound_norm_refs: bool = False,
        load_sr: int = 22050,
    ) -> tuple[str, str]:
        # Real get_conditioning_latents takes a PATH, not an array (trap 2)
        # — assert that invariant right here so a regression that passes an
        # array/bytes object fails LOUD inside the fake, not silently.
        assert isinstance(audio_path, (str, os.PathLike)), (
            f"get_conditioning_latents must receive a path, got {type(audio_path)!r}"
        )
        assert os.path.isfile(audio_path), "the temp WAV must exist while deriving"
        self.derive_calls.append(
            {
                "audio_path": audio_path,
                "max_ref_length": max_ref_length,
                "gpt_cond_len": gpt_cond_len,
                "gpt_cond_chunk_len": gpt_cond_chunk_len,
                "sound_norm_refs": sound_norm_refs,
            }
        )
        if self.derive_exc is not None:
            raise self.derive_exc
        return ("LATENT", "EMBEDDING")

    def inference(
        self,
        text: str,
        language: str,
        gpt_cond_latent: Any,
        speaker_embedding: Any,
        **kwargs: Any,
    ) -> dict[str, Any]:
        self.infer_calls.append(
            {
                "text": text,
                "language": language,
                "gpt_cond_latent": gpt_cond_latent,
                "speaker_embedding": speaker_embedding,
                **kwargs,
            }
        )
        return {"wav": np.zeros(2400, dtype=np.float32)}


class _FakeSynthesizer:
    def __init__(self, tts_model: _FakeXttsModel | None = None) -> None:
        self.tts_model = tts_model or _FakeXttsModel()
        self.output_sample_rate = 24000


class _FakeTTS:
    """Stands in for `TTS.api.TTS(model_id)`."""

    def __init__(self, model_id: str, synthesizer: _FakeSynthesizer | None = None) -> None:
        self.model_id = model_id
        self.synthesizer = synthesizer or _FakeSynthesizer()
        # Task 10 — records calls to the catalogue/fallback synth path
        # (`self._tts.tts(...)`), distinct from `tts_model.inference(...)`
        # (recorded in `_FakeXttsModel.infer_calls`) — a placebo-proof test
        # must spy on THIS, not on the tts_model, to actually observe
        # whether a fallback substitution happened.
        self.tts_calls: list[dict[str, Any]] = []

    def to(self, device: str) -> "_FakeTTS":
        return self

    def tts(self, text: str, speaker: str, language: str) -> list[float]:
        self.tts_calls.append({"text": text, "speaker": speaker, "language": language})
        return [0.0, 0.0, 0.0, 0.0]


def _fake_torch_module() -> types.ModuleType:
    """pickle-backed save/load so a test can open the persisted `.pt` and
    inspect its real content, not just its presence — stronger than the
    marker-byte trick some other fixtures use, and cheap since these fakes
    only ever persist plain strings/dicts."""
    fake_torch = types.ModuleType("torch")

    def _save(obj: Any, path: str) -> None:
        with open(path, "wb") as fh:
            pickle.dump(obj, fh)

    def _load(path: str, **_kwargs: Any) -> Any:
        with open(path, "rb") as fh:
            return pickle.load(fh)

    fake_torch.save = _save  # type: ignore[attr-defined]
    fake_torch.load = _load  # type: ignore[attr-defined]
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: False, empty_cache=lambda: None
    )
    return fake_torch


def _install_fake_coqui_runtime(
    monkeypatch, tts_instance: _FakeTTS | None = None, coqui_version: str = "9.9.9-test"
) -> _FakeTTS:
    """Install a fake `TTS`/`TTS.api`/`torch` triple into sys.modules and
    force COQUI_DEVICE=cpu so `_ensure_loaded` resolves without touching a
    real CUDA/DeepSpeed path (fp16/DeepSpeed stay off on cpu — see
    `_resolve_runtime_options`)."""
    monkeypatch.setenv("COQUI_DEVICE", "cpu")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    monkeypatch.delenv("COQUI_DEEPSPEED", raising=False)

    tts_instance = tts_instance or _FakeTTS("tts_models/multilingual/multi-dataset/xtts_v2")

    fake_tts_pkg = types.ModuleType("TTS")
    fake_tts_pkg.__version__ = coqui_version  # type: ignore[attr-defined]
    fake_tts_api = types.ModuleType("TTS.api")
    fake_tts_api.TTS = lambda model_id, *a, **k: tts_instance  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "TTS", fake_tts_pkg)
    monkeypatch.setitem(sys.modules, "TTS.api", fake_tts_api)
    monkeypatch.setitem(sys.modules, "torch", _fake_torch_module())
    return tts_instance


def _make_engine(monkeypatch, tmp_path: Path, **kwargs: Any) -> tuple[main.CoquiEngine, Path, _FakeTTS]:
    monkeypatch.setenv("XTTS_VOICES_DIR", str(tmp_path / "xtts"))
    tts_instance = _install_fake_coqui_runtime(monkeypatch, **kwargs)
    eng = main.CoquiEngine()
    return eng, Path(eng._voices_dir), tts_instance


def _ref_audio(n: int = 4800) -> np.ndarray:
    return np.zeros(n, dtype=np.float32)


def test_clone_voice_persists_pt_with_both_keys(monkeypatch, tmp_path) -> None:
    eng, voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    eng.clone_voice("xtts-clone1", _ref_audio(), 24000, "an audition line")

    pt_path, _json_path = eng._voice_paths("xtts-clone1")
    assert os.path.isfile(pt_path)
    with open(pt_path, "rb") as fh:
        saved = pickle.load(fh)
    assert set(saved.keys()) == {"gpt_cond_latent", "speaker_embedding"}
    assert saved["gpt_cond_latent"] == "LATENT"
    assert saved["speaker_embedding"] == "EMBEDDING"


def test_clone_voice_returns_nonempty_24khz_audition(monkeypatch, tmp_path) -> None:
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    result = eng.clone_voice("xtts-clone2", _ref_audio(), 24000, "an audition line")
    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert result.sample_rate == 24000


def test_clone_voice_writes_metadata_json(monkeypatch, tmp_path) -> None:
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, coqui_version="1.2.3-fake")
    eng.clone_voice("xtts-clone3", _ref_audio(), 24000, "an audition line", model="xtts_v2")

    _pt_path, json_path = eng._voice_paths("xtts-clone3")
    assert os.path.isfile(json_path)
    manifest = json.loads(Path(json_path).read_text(encoding="utf-8"))
    assert manifest["voiceId"] == "xtts-clone3"
    assert manifest["clone"] is True
    assert manifest["coquiVersion"] == "1.2.3-fake"
    assert manifest["modelId"] == "tts_models/multilingual/multi-dataset/xtts_v2"


def test_clone_voice_get_conditioning_latents_receives_config_derived_kwargs(
    monkeypatch, tmp_path
) -> None:
    """Trap 1: a bare call would use gpt_cond_len=6/gpt_cond_chunk_len=6/
    max_ref_length=30/sound_norm_refs=False — LOWER fidelity than the
    engine's own tts()/synthesize() path. The derive call must receive the
    LOADED MODEL's config values instead."""
    config = _FakeXttsConfig(
        gpt_cond_len=99, gpt_cond_chunk_len=17, max_ref_len=42, sound_norm_refs=True
    )
    tts_model = _FakeXttsModel(config=config)
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    eng.clone_voice("xtts-clone4", _ref_audio(), 24000, "an audition line")

    assert len(tts_model.derive_calls) == 1
    call = tts_model.derive_calls[0]
    assert call["gpt_cond_len"] == 99
    assert call["gpt_cond_chunk_len"] == 17
    assert call["max_ref_length"] == 42
    assert call["sound_norm_refs"] is True


def test_clone_voice_falls_back_to_signature_default_when_config_key_absent(
    monkeypatch, tmp_path
) -> None:
    """A config missing a key (API drift / an unusual config subclass) must
    fall back to get_conditioning_latents' OWN signature default, not crash
    and not silently use some other made-up value."""
    config = _FakeXttsConfig(max_ref_len=999)
    del config.max_ref_len  # simulate the key being absent from this config
    tts_model = _FakeXttsModel(config=config)
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    eng.clone_voice("xtts-clone5", _ref_audio(), 24000, "an audition line")

    # get_conditioning_latents' own signature default for max_ref_length is 30.
    assert tts_model.derive_calls[0]["max_ref_length"] == 30


def test_clone_voice_cleans_up_temp_wav_after_success(monkeypatch, tmp_path) -> None:
    eng, voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    eng.clone_voice("xtts-clone6", _ref_audio(), 24000, "an audition line")

    pt_path, _json_path = eng._voice_paths("xtts-clone6")
    tmp_wav_path = os.path.splitext(pt_path)[0] + ".derive-src.tmp.wav"
    assert not os.path.exists(tmp_wav_path)
    # And nothing else was left behind under the voices dir either.
    leftovers = [p for p in voices_dir.iterdir() if p.name.endswith(".wav")]
    assert leftovers == []


def test_clone_voice_cleans_up_temp_wav_on_derive_exception(monkeypatch, tmp_path) -> None:
    config = _FakeXttsConfig()
    tts_model = _FakeXttsModel(config=config)
    tts_model.derive_exc = RuntimeError("boom — simulated derive failure")
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)

    with pytest.raises(RuntimeError, match="boom"):
        eng.clone_voice("xtts-clone7", _ref_audio(), 24000, "an audition line")

    pt_path, _json_path = eng._voice_paths("xtts-clone7")
    tmp_wav_path = os.path.splitext(pt_path)[0] + ".derive-src.tmp.wav"
    assert not os.path.exists(tmp_wav_path)
    # The exception must also mean no artifact was persisted — a partial
    # derive never lands a .pt a later synth could pick up.
    assert not os.path.isfile(pt_path)


def test_clone_voice_and_synthesize_never_interleave_on_shared_model(
    monkeypatch, tmp_path
) -> None:
    """Task 8 deferred this: `clone_voice` (Task 9) is the SECOND concurrent
    entry point into the same `self._tts` that motivated `_synth_lock`. A
    `/synthesize` forward and a `clone_voice` derive+audition forward,
    running on separate threads, must never interleave — `_synth_lock`
    serialises them exactly like two `/synthesize` calls (Task 8's own
    regression)."""
    events: list[tuple[str, str]] = []
    events_lock = threading.Lock()

    def _record(label: str, phase: str) -> None:
        with events_lock:
            events.append((label, phase))

    class _SlowFakeXttsModel(_FakeXttsModel):
        # Mirrors the base class's full parameter list (not **kwargs) so
        # `inspect.signature` in `clone_voice` still finds each named
        # keyword's default — the same shape the REAL Xtts method has.
        def get_conditioning_latents(
            self,
            audio_path: Any,
            max_ref_length: int = 30,
            gpt_cond_len: int = 6,
            gpt_cond_chunk_len: int = 6,
            librosa_trim_db: Any = None,
            sound_norm_refs: bool = False,
            load_sr: int = 22050,
        ) -> tuple[str, str]:
            _record("clone", "enter")
            time.sleep(0.05)
            result = super().get_conditioning_latents(
                audio_path,
                max_ref_length=max_ref_length,
                gpt_cond_len=gpt_cond_len,
                gpt_cond_chunk_len=gpt_cond_chunk_len,
                librosa_trim_db=librosa_trim_db,
                sound_norm_refs=sound_norm_refs,
                load_sr=load_sr,
            )
            _record("clone", "exit")
            return result

    class _SlowFakeTTS(_FakeTTS):
        def tts(self, text: str, speaker: str, language: str) -> list[float]:
            _record("synth", "enter")
            time.sleep(0.05)
            _record("synth", "exit")
            return [0.0, 0.0]

    tts_model = _SlowFakeXttsModel()
    tts_instance = _SlowFakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    eng._ensure_loaded("xtts_v2")  # warm first, so both threads race on the FORWARD only

    outcome: dict[str, Any] = {}

    def _do_synth() -> None:
        outcome["synth"] = eng.synthesize("xtts_v2", "anything", "hello there")

    def _do_clone() -> None:
        outcome["clone"] = eng.clone_voice(
            "xtts-interleave", _ref_audio(), 24000, "an audition line"
        )

    t_synth = threading.Thread(target=_do_synth)
    t_clone = threading.Thread(target=_do_clone)
    t_synth.start()
    time.sleep(0.02)  # let the synth forward begin before the clone races in
    t_clone.start()
    t_synth.join(timeout=5)
    t_clone.join(timeout=5)

    assert "synth" in outcome and "clone" in outcome, "one of the two calls did not complete"
    assert len(events) == 4, f"expected exactly 2 enter/exit pairs, got {events}"
    first_label = events[0][0]
    second_label = events[2][0]
    assert first_label != second_label
    assert events == [
        (first_label, "enter"),
        (first_label, "exit"),
        (second_label, "enter"),
        (second_label, "exit"),
    ], (
        f"forwards interleaved instead of serialising under _synth_lock: {events}"
    )


# ── Task 10 — CoquiEngine.synthesize cloned-voice latents branch ───────────
#
# `/synthesize` already maps `VoiceNotDesignedError` to a 409
# engine-agnostically, so this task lands no route/HTTP-layer change — these
# tests call `CoquiEngine.synthesize` / `_load_voice_latents` /
# `_bump_evict_epoch` directly, same technique as the Task 9 section above.


def _clone(eng: main.CoquiEngine, voice_id: str, **kwargs: Any) -> None:
    eng.clone_voice(voice_id, _ref_audio(), 24000, "an audition line", **kwargs)


def test_synthesize_cloned_voice_renders_with_no_substitution(monkeypatch, tmp_path) -> None:
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-synth1")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()  # drop clone_voice's own audition call

    result = eng.synthesize("xtts_v2", "xtts-synth1", "hello there")

    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert result.sample_rate == 24000
    assert result.substituted_from is None
    # Placebo guard: with `_speakers` empty (no speaker_manager configured on
    # this fake), the OLD substitution path is also permissive — a bare
    # `pcm`/`substituted_from` check above would pass even if the cloned-
    # voice branch were never entered, by falling through to `_tts.tts()`.
    # Pin that this actually went through the latents/`inference()` path.
    assert len(tts_model.infer_calls) == 1
    assert tts_instance.tts_calls == []


def test_synthesize_missing_latents_raises_voice_not_designed(monkeypatch, tmp_path) -> None:
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)

    with pytest.raises(main.VoiceNotDesignedError):
        eng.synthesize("xtts_v2", "xtts-never-cloned", "hello there")


def test_synthesize_missing_latents_never_falls_back_to_real_tts_call(monkeypatch, tmp_path) -> None:
    """Placebo-proof `[AC-M1]`: asserting on `tts_model.*` can never observe
    a fallback substitution — the cloned-voice branch never touches
    `tts_model.speaker_manager`/the catalogue path at all. The REAL
    fallback is `self._tts.tts()`; spy on THAT and assert it was never
    called on a miss."""
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)

    with pytest.raises(main.VoiceNotDesignedError):
        eng.synthesize("xtts_v2", "xtts-never-cloned", "hello there")

    assert tts_instance.tts_calls == []


def test_synthesize_catalog_voice_still_substitutes_regression(monkeypatch, tmp_path) -> None:
    """A non-cloned (baked catalog) voice absent from the manifest must
    still hit the PRE-EXISTING fail-soft substitution path — the new
    cloned-voice branch (gated on `XTTS_KEY_PREFIX`) must never intercept a
    plain catalog voice id."""
    config = _FakeXttsConfig()
    tts_model = _FakeXttsModel(config=config)
    tts_model.speaker_manager = types.SimpleNamespace(
        name_to_id={main.CoquiEngine.FALLBACK_SPEAKER: 0, "Some Other Speaker": 1}
    )
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)

    result = eng.synthesize("xtts_v2", "NotInCatalog", "hello there")

    assert result.substituted_from == "NotInCatalog"
    assert len(tts_instance.tts_calls) == 1
    assert tts_instance.tts_calls[0]["speaker"] == main.CoquiEngine.FALLBACK_SPEAKER
    # And the cloned-voice branch was never entered for a plain catalog id.
    assert tts_model.infer_calls == []


def test_synthesize_cloned_voice_receives_config_settings_and_text_splitting(
    monkeypatch, tmp_path
) -> None:
    """`[AC-C3]` — the bare low-level `inference()` hardcodes
    temperature=0.75/repetition_penalty=10.0/top_p=0.85 and defaults
    `enable_text_splitting=False`. The cached-latents synth branch must
    receive the LOADED MODEL's config values (via the shared
    `_infer_from_latents` helper Task 9 built) and
    `enable_text_splitting=True`."""
    config = _FakeXttsConfig(
        temperature=0.42, length_penalty=2.5, repetition_penalty=3.3, top_k=17, top_p=0.11
    )
    tts_model = _FakeXttsModel(config=config)
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    _clone(eng, "xtts-synth2")
    tts_model.infer_calls.clear()  # drop clone_voice's own audition call

    eng.synthesize("xtts_v2", "xtts-synth2", "hello there")

    assert len(tts_model.infer_calls) == 1
    call = tts_model.infer_calls[0]
    assert call["temperature"] == 0.42
    assert call["length_penalty"] == 2.5
    assert call["repetition_penalty"] == 3.3
    assert call["top_k"] == 17
    assert call["top_p"] == 0.11
    assert call["enable_text_splitting"] is True


def test_synthesize_cloned_voice_long_sentence_renders(monkeypatch, tmp_path) -> None:
    """The crash case `[AC-C3]`: a bare `inference()` call defaults
    `enable_text_splitting=False` and then asserts
    `text_tokens.shape[-1] < gpt_max_text_tokens` — a long sentence that
    renders fine on a stock catalogue voice hard-crashes a cloned one. This
    fake doesn't replicate the real token-length assert (no real model is
    loaded), but does pin that `enable_text_splitting=True` — the actual
    fix — is passed for an unmistakably long input, and that the call
    completes rather than raising."""
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-synth3")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()

    long_text = "This is a long sentence that keeps going. " * 200
    result = eng.synthesize("xtts_v2", "xtts-synth3", long_text)

    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert tts_model.infer_calls[-1]["enable_text_splitting"] is True
    assert tts_model.infer_calls[-1]["text"] == long_text


def test_synthesize_cloned_voice_unsupported_language_raises(monkeypatch, tmp_path) -> None:
    """The fake's `config.languages` is `["en", "es", "fr", "de", "it"]` — a
    request for an unsupported language must fail loud before ever reaching
    `inference()`, mirroring `Xtts.synthesize`'s own guard (xtts.py:422-423)
    that the low-level `inference()` path skips entirely."""
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-synth4")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()

    with pytest.raises(main.VoiceNotDesignedError):
        eng.synthesize("xtts_v2", "xtts-synth4", "hello there", language="xx")

    assert tts_model.infer_calls == []


def test_synthesize_cloned_voice_zh_language_quirk_matches_upstream(monkeypatch, tmp_path) -> None:
    """Config-faithful means faithful to the upstream quirk too:
    `Xtts.synthesize`'s own guard is
    `"zh-cn" if language == "zh" else language in self.config.languages`
    (xtts.py:422-423) — because a non-empty string literal is always
    truthy, `language="zh"` ALWAYS passes this assert regardless of whether
    "zh"/"zh-cn" is actually in `config.languages`. This fake's
    `config.languages` deliberately excludes both."""
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-synth5")
    tts_model = tts_instance.synthesizer.tts_model
    assert "zh" not in tts_model.config.languages
    assert "zh-cn" not in tts_model.config.languages
    tts_model.infer_calls.clear()

    result = eng.synthesize("xtts_v2", "xtts-synth5", "hello there", language="zh")

    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert tts_model.infer_calls[-1]["language"] == "zh"


def test_load_voice_latents_epoch_bumped_mid_load_discards_result(monkeypatch, tmp_path) -> None:
    """`[AC-C7][ADV-M1]` — interleaving. `_bump_evict_epoch` landing while a
    `torch.load` for that same voice is in flight must discard the load's
    result instead of installing it into the cache, and the in-flight call
    itself must raise rather than silently returning a load that's already
    stale. Deterministic via threading.Event handshakes, not sleeps."""
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-race")

    real_torch = sys.modules["torch"]
    load_entered = threading.Event()
    proceed_with_load = threading.Event()

    def _blocking_load(path: str, **kwargs: Any) -> Any:
        load_entered.set()
        assert proceed_with_load.wait(timeout=5), "test stalled waiting for the epoch bump"
        return real_torch.load(path, **kwargs)

    blocking_torch = types.ModuleType("torch")
    blocking_torch.save = real_torch.save  # type: ignore[attr-defined]
    blocking_torch.load = _blocking_load  # type: ignore[attr-defined]
    blocking_torch.cuda = real_torch.cuda  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", blocking_torch)

    outcome: dict[str, Any] = {}

    def _do_load() -> None:
        try:
            outcome["latents"] = eng._load_voice_latents("xtts-race")
        except Exception as exc:  # noqa: BLE001 — captured for the assertion below
            outcome["error"] = exc

    t = threading.Thread(target=_do_load)
    t.start()
    assert load_entered.wait(timeout=5), "torch.load was never entered"
    eng._bump_evict_epoch("xtts-race")
    proceed_with_load.set()
    t.join(timeout=5)

    assert "latents" not in outcome, "a load whose epoch moved mid-flight must not succeed"
    assert "error" in outcome, "expected VoiceNotDesignedError from the stale-epoch refusal"
    assert isinstance(outcome["error"], main.VoiceNotDesignedError)
    assert "xtts-race" not in eng._latents_cache


def test_bump_evict_epoch_drops_a_resident_cache_entry(monkeypatch, tmp_path) -> None:
    """Property 2 — erasure reaches the in-process cache, not just disk. A
    voice already resident in `_latents_cache` must be dropped by
    `_bump_evict_epoch`, forcing the next load to re-read from disk (or, if
    the .pt is also gone by then, fail loud)."""
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-evict1")
    eng._load_voice_latents("xtts-evict1")  # warm the cache
    assert "xtts-evict1" in eng._latents_cache

    eng._bump_evict_epoch("xtts-evict1")

    assert "xtts-evict1" not in eng._latents_cache


# ── Task 11 — POST /xtts/clone-voice + POST /xtts/evict-voice ──────────────
#
# HTTP-layer coverage. Reuses the Task 9/10 fake-runtime fixtures above
# (`_make_engine`/`_install_fake_coqui_runtime`) instead of duplicating them
# — same technique test_qwen_clone_voice.py uses for /qwen/clone-voice.
# Bare `TestClient(main.app)` throughout (never `with TestClient(...)`) —
# the context manager fires startup handlers against the fake torch.


def _pcm_bytes(n: int = 4800) -> bytes:
    """Raw s16le mono PCM — the wire body /xtts/clone-voice expects (as
    opposed to `_ref_audio`'s float32 array, used by the direct engine-level
    tests above)."""
    return np.zeros(n, dtype="<i2").tobytes()


def _b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


def _install_engine(monkeypatch, tmp_path: Path, **kwargs: Any) -> tuple[main.CoquiEngine, Path, _FakeTTS]:
    eng, voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path, **kwargs)
    monkeypatch.setitem(main.ENGINES, "coqui", eng)
    return eng, voices_dir, tts_instance


def test_clone_voice_route_happy_path_returns_pcm_and_headers(monkeypatch, tmp_path) -> None:
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path, coqui_version="9.9.9-test")
    client = TestClient(main.app)

    resp = client.post(
        "/xtts/clone-voice",
        content=_pcm_bytes(),
        headers={"X-Sample-Rate": "24000", "X-Voice-Id": "xtts-happy1"},
    )

    assert resp.status_code == 200
    assert resp.headers["X-Sample-Rate"] == "24000"
    assert resp.headers["X-Coqui-Version"] == "9.9.9-test"
    assert resp.headers["X-Model-Id"] == "tts_models/multilingual/multi-dataset/xtts_v2"
    assert len(resp.content) > 0
    pt_path, json_path = eng._voice_paths("xtts-happy1")
    assert os.path.isfile(pt_path)
    assert os.path.isfile(json_path)


def test_clone_voice_route_rejects_missing_body_and_headers(monkeypatch, tmp_path) -> None:
    _install_engine(monkeypatch, tmp_path)
    client = TestClient(main.app)

    assert client.post(
        "/xtts/clone-voice", content=b"",
        headers={"X-Sample-Rate": "24000", "X-Voice-Id": "xtts-x"},
    ).status_code == 400
    assert client.post(
        "/xtts/clone-voice", content=_pcm_bytes(),
        headers={"X-Voice-Id": "xtts-x"},
    ).status_code == 400
    assert client.post(
        "/xtts/clone-voice", content=_pcm_bytes(),
        headers={"X-Sample-Rate": "24000"},
    ).status_code == 400


def test_clone_voice_route_honours_audition_text_header(monkeypatch, tmp_path) -> None:
    """`[AC-C2]` — the verified `_b64` scoping bug on /qwen/clone-voice: a
    bare `_b64.b64decode` inside `try/except Exception` with no local import
    would swallow the NameError and silently discard the audition text. This
    asserts the DECODED text actually reaches the engine's inference call,
    not just that the response is 200 (a 200 says nothing about which text
    was spoken — the default-fallback text also renders 200)."""
    eng, _voices_dir, tts_instance = _install_engine(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/xtts/clone-voice",
        content=_pcm_bytes(),
        headers={
            "X-Sample-Rate": "24000",
            "X-Voice-Id": "xtts-audition1",
            "X-Audition-Text": _b64("please say this exact audition line"),
        },
    )

    assert resp.status_code == 200
    tts_model = tts_instance.synthesizer.tts_model
    assert tts_model.infer_calls[-1]["text"] == "please say this exact audition line"
    assert tts_model.infer_calls[-1]["text"] != eng.DEFAULT_AUDITION_TEXT


def test_clone_voice_route_defaults_audition_text_when_header_absent(monkeypatch, tmp_path) -> None:
    eng, _voices_dir, tts_instance = _install_engine(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/xtts/clone-voice",
        content=_pcm_bytes(),
        headers={"X-Sample-Rate": "24000", "X-Voice-Id": "xtts-audition2"},
    )

    assert resp.status_code == 200
    tts_model = tts_instance.synthesizer.tts_model
    assert tts_model.infer_calls[-1]["text"] == eng.DEFAULT_AUDITION_TEXT


def test_clone_voice_route_cuda_poison_shaped_exception_returns_503(monkeypatch, tmp_path) -> None:
    """The verified `_mark_cuda_poisoned` naming trap: calling the wrong
    helper name (`_mark_poisoned`) would raise a NameError INSIDE the except
    handler, so a real CUDA OOM would never mark the process poisoned. This
    forces a CUDA-poison-shaped exception out of the derive call and asserts
    both the 503 response AND that the process-wide poison flag actually
    flipped — a wrong-name bug would blow up this test with a NameError
    instead of a clean assertion failure, which is exactly the point.

    `_mark_cuda_poisoned` (real, unstubbed, so the flag genuinely flips) also
    arms a `threading.Timer`-based `os._exit(42)` via `_schedule_poison_exit`
    — the production self-restart the sidecar relies on when a real CUDA
    context is poisoned. Left un-stubbed, that timer fires ~500ms later and
    kills the whole pytest process out from under the rest of the suite
    (green dots, then a stray exit 42). Every other poison-triggering test
    module in this package stubs `threading.Timer` to a no-op for exactly
    this reason (see test_synthesize.py's `_stub_poison_exit_timer`); this
    is the first poison test in this file, so it gets its own scoped stub
    rather than a file-wide autouse fixture no other test here needs."""

    class _NoOpTimer:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        def start(self) -> None:
            pass

    monkeypatch.setattr(main.threading, "Timer", _NoOpTimer)

    config = _FakeXttsConfig()
    tts_model = _FakeXttsModel(config=config)
    tts_model.derive_exc = RuntimeError("CUDA error: out of memory")
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    _install_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    main._reset_poison_for_test()
    client = TestClient(main.app)

    try:
        resp = client.post(
            "/xtts/clone-voice",
            content=_pcm_bytes(),
            headers={"X-Sample-Rate": "24000", "X-Voice-Id": "xtts-poison1"},
        )

        assert resp.status_code == 503
        body = resp.json()
        assert body["poisoned"] is True
        assert main._process_poisoned is True
    finally:
        main._reset_poison_for_test()


def test_clone_voice_route_admission_branch_threads_device_into_clone_voice(
    monkeypatch, tmp_path
) -> None:
    """Exercises the SEG_CAPACITY_ADMISSION=1 branch — conftest.py defaults
    it OFF for every other test in this suite, so without this test the
    admission wrapping around /xtts/clone-voice would never actually run."""
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path)
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [
            {"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8192, "freeMb": 5000},
            {"kind": "cuda", "index": 1, "label": "g1", "totalMb": 24000, "freeMb": 20000},
        ],
    )
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    real_clone_voice = eng.clone_voice

    def _spy(*args: Any, **kwargs: Any) -> Any:
        calls.append((args, kwargs))
        return real_clone_voice(*args, **kwargs)

    monkeypatch.setattr(eng, "clone_voice", _spy)
    client = TestClient(main.app)

    resp = client.post(
        "/xtts/clone-voice",
        content=_pcm_bytes(),
        headers={"X-Sample-Rate": "24000", "X-Voice-Id": "xtts-admission1"},
    )

    assert resp.status_code == 200
    assert len(calls) == 1
    _args, kwargs = calls[0]
    assert kwargs.get("device") == "cuda:1"


def test_evict_voice_route_rejects_missing_voice_id(monkeypatch, tmp_path) -> None:
    _install_engine(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post("/xtts/evict-voice", json={})

    assert resp.status_code == 400


def test_evict_voice_route_miss_is_a_noop(monkeypatch, tmp_path) -> None:
    _install_engine(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post("/xtts/evict-voice", json={"voiceId": "xtts-never-cloned"})

    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "evicted": False}


def test_evict_voice_route_drops_warm_cache_and_next_synth_raises_409(monkeypatch, tmp_path) -> None:
    """The route-level equivalent of `test_bump_evict_epoch_drops_a_resident_
    cache_entry` above, but proves the full Property-2 lifecycle across the
    HTTP surface end to end: clone -> warm the in-memory cache via a synth ->
    evict via the route -> (mirroring Task 13's purgeCloneArtifacts,
    files-first) delete the on-disk .pt -> the next /synthesize for that
    voice fails loud with 409, exactly as /synthesize already maps
    VoiceNotDesignedError."""
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-evict-http1")
    eng._load_voice_latents("xtts-evict-http1")  # warm the in-memory cache
    assert "xtts-evict-http1" in eng._latents_cache
    client = TestClient(main.app)

    resp = client.post("/xtts/evict-voice", json={"voiceId": "xtts-evict-http1"})

    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "evicted": True}
    assert "xtts-evict-http1" not in eng._latents_cache

    pt_path, _json_path = eng._voice_paths("xtts-evict-http1")
    os.remove(pt_path)

    synth_resp = client.post(
        "/synthesize",
        json={"engine": "coqui", "model": "xtts_v2", "voice": "xtts-evict-http1", "text": "hello"},
    )
    assert synth_resp.status_code == 409


def test_evict_voice_route_evicts_even_when_model_unloaded(monkeypatch, tmp_path) -> None:
    """`[AC-M4]` — the cache-clear must NOT be gated on engine residency the
    way `unload()`'s own `self._tts is None` early-return is. A voice can
    have warm latents cached from an earlier synth even after the model
    itself was later unloaded (e.g. the UI's Stop button, or the Analysing
    screen auto-evicting Coqui for the analyzer LLM) — Property 2 (erasure
    is total) must still reach that cache entry on revoke regardless."""
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-evict-unloaded")
    eng._load_voice_latents("xtts-evict-unloaded")
    assert "xtts-evict-unloaded" in eng._latents_cache

    eng.unload()
    assert eng._tts is None
    # unload() doesn't touch _latents_cache — the entry survives a stop.
    assert "xtts-evict-unloaded" in eng._latents_cache

    client = TestClient(main.app)
    resp = client.post("/xtts/evict-voice", json={"voiceId": "xtts-evict-unloaded"})

    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "evicted": True}
    assert "xtts-evict-unloaded" not in eng._latents_cache
