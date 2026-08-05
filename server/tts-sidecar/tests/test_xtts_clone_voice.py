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
import logging
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


def _default_fake_load_audio(audiopath: Any, sampling_rate: int) -> None:
    """Stand-in for `TTS.tts.models.xtts.load_audio`. Never actually called
    by these tests (the fake `get_conditioning_latents` doesn't invoke it) —
    it only needs to exist with `patched_xtts_load_audio`'s expected
    `(audiopath, sampling_rate)` signature so that #1967's `with
    patched_xtts_load_audio():` wrap around `clone_voice`'s derive call
    doesn't raise `RuntimeError` (missing/drifted loader) on every one of
    this file's ~30 clone_voice-driving tests."""
    return None


def _install_fake_coqui_runtime(
    monkeypatch, tts_instance: _FakeTTS | None = None, coqui_version: str = "9.9.9-test"
) -> _FakeTTS:
    """Install a fake `TTS`/`TTS.api`/`torch` triple into sys.modules and
    force COQUI_DEVICE=cpu so `_ensure_loaded` resolves without touching a
    real CUDA/DeepSpeed path (fp16/DeepSpeed stay off on cpu — see
    `_resolve_runtime_options`).

    Also seeds `TTS.tts`/`TTS.tts.models`/`TTS.tts.models.xtts` (#1967) —
    `clone_voice` now wraps its derive call in `patched_xtts_load_audio()`,
    which does `import TTS.tts.models.xtts` and reads its `load_audio`.
    Without this, every test here that reaches `clone_voice` would fail with
    `ModuleNotFoundError: No module named 'TTS.tts'; 'TTS' is not a package`
    — the fake `TTS` module above has no `__path__`, so Python's import
    machinery can only resolve the dotted chain by finding each segment
    already cached in `sys.modules`, never by real submodule import.
    """
    monkeypatch.setenv("COQUI_DEVICE", "cpu")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    monkeypatch.delenv("COQUI_DEEPSPEED", raising=False)

    tts_instance = tts_instance or _FakeTTS("tts_models/multilingual/multi-dataset/xtts_v2")

    fake_tts_pkg = types.ModuleType("TTS")
    fake_tts_pkg.__version__ = coqui_version  # type: ignore[attr-defined]
    fake_tts_api = types.ModuleType("TTS.api")
    fake_tts_api.TTS = lambda model_id, *a, **k: tts_instance  # type: ignore[attr-defined]
    fake_xtts_leaf = types.ModuleType("TTS.tts.models.xtts")
    fake_xtts_leaf.load_audio = _default_fake_load_audio  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "TTS", fake_tts_pkg)
    monkeypatch.setitem(sys.modules, "TTS.api", fake_tts_api)
    monkeypatch.setitem(sys.modules, "TTS.tts", types.ModuleType("TTS.tts"))
    monkeypatch.setitem(sys.modules, "TTS.tts.models", types.ModuleType("TTS.tts.models"))
    monkeypatch.setitem(sys.modules, "TTS.tts.models.xtts", fake_xtts_leaf)
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


def test_clone_voice_survives_idle_evict_landing_in_the_ensure_lock_gap(
    monkeypatch, tmp_path
) -> None:
    """GATE 2 A-1 — `clone_voice` used to have NEITHER of `synthesize()`'s two
    TOCTOU guards: it never claimed `_synth_in_flight`, never refreshed
    `_last_used`, and re-checked the model with a bare `assert` after
    re-acquiring `_synth_lock`. An admission-time idle evict
    (`_idle_evict` -> `maybe_free_idle`) landing between the initial
    `_ensure_loaded` call and the `with self._synth_lock:` acquisition
    dropped the model out from under the derive and crashed at the bare
    assert with an `AssertionError`.

    Reproduced deterministically (no threads needed): wrap `_ensure_loaded`
    so the FIRST call — the one `clone_voice` makes before it can claim
    `_synth_in_flight` — evicts the model it just loaded via the real
    `maybe_free_idle(0)`, exactly mirroring `_idle_evict`'s admission-path
    call. Before the fix, `clone_voice` never calls `_ensure_loaded` a
    second time, so it proceeds straight into the bare assert and crashes.
    After the fix, the claim + re-ensure closes the window: the second
    `_ensure_loaded` call (the re-ensure) reloads the model, and the derive
    succeeds."""
    eng, _voices_dir, _tts_instance = _make_engine(monkeypatch, tmp_path)

    real_ensure = eng._ensure_loaded
    calls = {"n": 0}

    def _ensure_then_evict_once(model: str, device: Any = None) -> None:
        calls["n"] += 1
        real_ensure(model, device=device)
        if calls["n"] == 1:
            # Force "infinitely idle" rather than relying on ttl=0 racing
            # timer resolution — the point is only that the evict lands,
            # not exactly how idle it looks.
            eng._last_used = 0.0
            assert eng.maybe_free_idle(0) is True, "the simulated idle evict must actually land"

    monkeypatch.setattr(eng, "_ensure_loaded", _ensure_then_evict_once)

    result = eng.clone_voice("xtts-race-idle-evict", _ref_audio(), 24000, "an audition line")

    assert isinstance(result, main.SynthResult)
    assert calls["n"] == 2, (
        "the re-ensure must have run a second time to recover from the evict "
        f"that landed after the first — saw {calls['n']} call(s)"
    )


def test_maybe_free_idle_declines_while_clone_voice_holds_its_claim(
    monkeypatch, tmp_path
) -> None:
    """The claim `clone_voice` takes must be the SAME one the evictor reads.

    `clone_voice`'s TOCTOU guard is only worth anything if `maybe_free_idle`
    can actually observe it. `synthesize` and `maybe_free_idle` both go
    through the shared `InFlightCounter` (`_in_flight`, #1917); a `clone_voice`
    that bumped a private counter instead would claim something nobody
    consults — the derive would look idle to the admission path, the evict
    would proceed, and the race the guard closes would silently reopen.

    Observed from INSIDE the claim, at the re-ensure — which runs after the
    claim is taken and before `clone_voice` acquires `_synth_lock`, so
    `maybe_free_idle`'s lock-free fast-out is reached without deadlocking on
    the same thread. `_last_used` is zeroed right there so the engine looks
    INFINITELY IDLE: that neutralises the timestamp half of the guard, leaving
    the in-flight claim as the only thing that can make the evict decline.
    Without it the test would pass on the timestamp alone and prove nothing.

    Fails against a `clone_voice` that claims a counter of its own:
    `maybe_free_idle(0.0)` returns True, `_tts` is dropped mid-derive, and
    `clone_voice` then raises the loud "unloaded before this clone finished"
    RuntimeError."""
    eng, _voices_dir, _tts_instance = _make_engine(monkeypatch, tmp_path)

    real_ensure = eng._ensure_loaded
    calls = {"n": 0}
    observed: dict[str, Any] = {}

    def _ensure_then_probe_the_evictor(model: str, device: Any = None) -> None:
        calls["n"] += 1
        real_ensure(model, device=device)
        if calls["n"] == 2:  # the re-ensure — inside the claim, outside the lock
            observed["busy"] = eng._in_flight.busy
            observed["value"] = eng._in_flight.value
            eng._last_used = 0.0  # look infinitely idle: only the claim can save it
            observed["freed"] = eng.maybe_free_idle(0.0)
            observed["tts_after"] = eng._tts is not None

    monkeypatch.setattr(eng, "_ensure_loaded", _ensure_then_probe_the_evictor)

    result = eng.clone_voice("xtts-claim-visible", _ref_audio(), 24000, "an audition line")

    assert isinstance(result, main.SynthResult)
    assert observed["busy"] is True, (
        "`_in_flight.busy` read False while clone_voice was mid-derive — the "
        "derive claimed a counter the evictor does not consult"
    )
    assert observed["value"] >= 1
    assert observed["freed"] is False, (
        "maybe_free_idle evicted the model out from under an in-flight derive"
    )
    assert observed["tts_after"] is True, "the model was dropped mid-derive"
    assert eng._tts is not None
    assert eng._in_flight.value == 0, "the claim was not released on the way out"


def test_clone_voice_raises_loud_error_not_assertionerror_when_unload_wins_final_gap(
    monkeypatch, tmp_path
) -> None:
    """GATE 2 A-1 — the claim + re-ensure closes the admission-evict window
    (see the test above), but an explicit `/unload` (Stop button / analyzer
    auto-evict) doesn't check `_synth_in_flight` at all, only `_synth_lock`
    — so it can still win the narrow gap between the re-ensure and
    `clone_voice`'s own `with self._synth_lock:` acquisition. Before the fix
    that gap's re-check was a bare `assert self._tts is not None`, which
    crashes with `AssertionError` (or, under `python -O`, an
    `AttributeError` on the next line) — a programmer-error shape for a
    reachable runtime race. After the fix it must raise a loud, actionable
    `RuntimeError` instead, matching how `synthesize()` reports the same
    lost-model race."""
    eng, _voices_dir, _tts_instance = _make_engine(monkeypatch, tmp_path)

    real_ensure = eng._ensure_loaded

    def _ensure_then_unload_every_time(model: str, device: Any = None) -> None:
        real_ensure(model, device=device)
        # An explicit /unload wins the race every time this runs — so even
        # the re-ensure's own reload is undone before `clone_voice` reaches
        # its `with self._synth_lock:` acquisition.
        with eng._synth_lock:
            eng._drop_model_locked()

    monkeypatch.setattr(eng, "_ensure_loaded", _ensure_then_unload_every_time)

    with pytest.raises(RuntimeError) as exc_info:
        eng.clone_voice("xtts-race-unload", _ref_audio(), 24000, "an audition line")

    assert not isinstance(exc_info.value, AssertionError), (
        f"must be a loud RuntimeError, not a bare assert: {exc_info.value!r}"
    )
    assert "unloaded" in str(exc_info.value)


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


class _ImportFailingXttsModel(_FakeXttsModel):
    """Reproduces the real upstream shape (#2017): `enable_text_splitting=True`
    reaches `TTS.tts.layers.xtts.tokenizer.get_spacy_lang`, which raises
    `ImportError` when spacy is missing/broken — regardless of how long
    `text` is (the length check that decides WHETHER splitting is needed
    lives inside spacy's own `split_sentence`, downstream of the import).
    This fake raises that same `ImportError` on the first
    (`enable_text_splitting=True`) call and only that one, so a retry with
    `enable_text_splitting=False` succeeds — exactly the belt-and-braces
    behaviour `_infer_from_latents` must now provide."""

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
        if kwargs.get("enable_text_splitting"):
            raise ImportError("enable_text_splitting=True requires Spacy: pip install spacy[ja]")
        return {"wav": np.zeros(2400, dtype=np.float32)}


def test_synthesize_cloned_voice_recovers_when_spacy_import_fails(
    monkeypatch, tmp_path, caplog
) -> None:
    """#2017 regression. Before the fix, `_infer_from_latents` had no catch
    around the `tts_model.inference(enable_text_splitting=True, ...)` call,
    so a missing/broken spacy install (`get_spacy_lang`'s `ImportError`)
    propagated straight out of `synthesize()` — a cloned Coqui voice
    rendering ANY line at/above `tokenizer.char_limits[lang]` 500'd outright
    (`{"detail": "Internal error."}`), reproduced here with the exact
    reported shape: a Russian string past `char_limits['ru']` (182 chars).
    `requirements/base.txt` now declares plain `spacy` so this should never
    fire in a properly-provisioned venv — this test pins the code-level
    belt-and-braces fallback for when it does anyway (stale/broken install),
    without needing a real uninstalled-spacy environment: it fails before
    the fix (ImportError propagates, no retry) and passes after (caught,
    logged loudly, retried with enable_text_splitting=False)."""
    config = _FakeXttsConfig(languages=["en", "es", "fr", "de", "it", "ru"])
    tts_model = _ImportFailingXttsModel(config=config)
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    _clone(eng, "xtts-spacy-missing")
    tts_model.infer_calls.clear()  # drop clone_voice's own audition call

    long_ru_text = "Съешь ещё этих мягких французских булок, да выпей же чаю. " * 5
    assert len(long_ru_text) > 182, "must exceed char_limits['ru'] to match the reported repro"

    caplog.clear()  # drop clone_voice's own `_ensure_loaded` speaker-enumeration WARNING
    with caplog.at_level(logging.ERROR, logger="sidecar"):
        result = eng.synthesize("xtts_v2", "xtts-spacy-missing", long_ru_text, language="ru")

    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert len(tts_model.infer_calls) == 2, "expected the True attempt AND the False retry"
    assert tts_model.infer_calls[0]["enable_text_splitting"] is True
    assert tts_model.infer_calls[1]["enable_text_splitting"] is False
    assert tts_model.infer_calls[1]["text"] == long_ru_text
    assert any(
        r.levelno >= logging.ERROR and "retrying WITHOUT sentence splitting" in r.getMessage()
        for r in caplog.records
    ), "the ImportError fallback must log loudly, not silently degrade"


def test_synthesize_cloned_voice_japanese_import_failure_names_sudachi(
    monkeypatch, tmp_path, caplog
) -> None:
    """A Japanese line hitting the same `ImportError` fallback must NOT get
    the generic "spacy missing or broken … reinstall the sidecar
    requirements" message — for `ja` specifically, plain `spacy` (what
    `requirements/base.txt` declares) is neither missing nor broken; it is
    working exactly as decided (#2038): the `[ja]` extra (SudachiPy +
    sudachidict-core) is deliberately NOT installed. "Reinstall" would send
    an operator in a circle. The `ja` branch must instead name SudachiPy and
    reference #2038, while every other language keeps the original message
    (pinned by `test_synthesize_cloned_voice_recovers_when_spacy_import_fails`
    above)."""
    config = _FakeXttsConfig(languages=["en", "ja"])
    tts_model = _ImportFailingXttsModel(config=config)
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    _clone(eng, "xtts-ja-spacy-missing")
    tts_model.infer_calls.clear()  # drop clone_voice's own audition call

    ja_text = "これは長い日本語の文章です。" * 10  # well past char_limits['ja'] = 71

    caplog.clear()
    with caplog.at_level(logging.ERROR, logger="sidecar"):
        result = eng.synthesize("xtts_v2", "xtts-ja-spacy-missing", ja_text, language="ja")

    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert len(tts_model.infer_calls) == 2, "expected the True attempt AND the False retry"
    assert tts_model.infer_calls[1]["enable_text_splitting"] is False

    error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert any("Sudachi" in r.getMessage() for r in error_records), \
        "the ja fallback must name SudachiPy/sudachidict-core, not blame a generic spacy install"
    assert any("2038" in r.getMessage() for r in error_records), \
        "the ja fallback must reference #2038, the tracked decision"
    assert not any("reinstall" in r.getMessage().lower() for r in error_records), \
        "the ja fallback must NOT tell the operator to reinstall — that would not fix anything"


def test_get_spacy_lang_ja_resolves_and_splits_real_japanese_text() -> None:
    """#2038 — the POSITIVE case: with `sudachipy` + `sudachidict-core`
    installed (install-coqui.mjs's third pip step, alongside plain spacy),
    upstream's `get_spacy_lang('ja')` — the exact call
    `CoquiEngine._infer_from_latents` reaches via `enable_text_splitting=True`
    — must resolve without raising, and the resulting tokenizer must
    genuinely split Japanese text into real morphological tokens, not just
    construct without error.

    Drives the REAL upstream call (not `_ImportFailingXttsModel`'s forced
    fake, which the two tests above use to pin the FALLBACK's behaviour
    regardless of what's installed) — this is the dependency itself, so a
    fake would prove nothing. Skips rather than fails on a box that hasn't
    run the Coqui installer (sudachipy/sudachidict-core are opt-in, not in
    the base venv) — same idiom as `test_xtts_audio_io.py`'s real-TTS checks.
    """
    xtts_tokenizer = pytest.importorskip("TTS.tts.layers.xtts.tokenizer")
    pytest.importorskip("sudachipy")
    pytest.importorskip("sudachidict_core")

    nlp = xtts_tokenizer.get_spacy_lang("ja")
    doc = nlp("これは長い日本語の文章です。")
    tokens = [t.text for t in doc]
    assert len(tokens) > 1, (
        f"expected multiple morphological tokens from SudachiPy, got {tokens!r} — "
        "a length-1 result would mean the tokenizer isn't actually splitting"
    )


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


class _DistinctLatentsXttsModel(_FakeXttsModel):
    """Task 10 fix round 1 — `get_conditioning_latents` returns a distinct
    latents pair on each call (unlike the base fixture's fixed "LATENT"/
    "EMBEDDING"), keyed off `len(self.derive_calls)`. Lets a test prove a
    render used the SECOND clone's latents rather than a stale FIRST pair
    still sitting in `_latents_cache`.

    Mirrors the base class's full named-parameter list (not **kwargs) —
    same reason `_SlowFakeXttsModel` above does: `clone_voice` introspects
    `inspect.signature(tts_model.get_conditioning_latents)` to find each
    named keyword's default, which a `**kwargs`-only override would hide."""

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
        # Delegates to the base implementation for its path/isfile assertion
        # and `derive_calls` bookkeeping; overrides only the return value.
        super().get_conditioning_latents(
            audio_path,
            max_ref_length=max_ref_length,
            gpt_cond_len=gpt_cond_len,
            gpt_cond_chunk_len=gpt_cond_chunk_len,
            librosa_trim_db=librosa_trim_db,
            sound_norm_refs=sound_norm_refs,
            load_sr=load_sr,
        )
        n = len(self.derive_calls)
        return (f"LATENT-{n}", f"EMBEDDING-{n}")


def test_reclone_same_voice_id_invalidates_stale_latents_cache(monkeypatch, tmp_path) -> None:
    """Review Important #1 (task-10-review.md), fix round 1. `clone_voice`
    must bump `_evict_epoch` on a RE-clone of the same `voice_id` — without
    it, a voice_id re-cloned from new reference audio (the Coqui-parity
    counterpart of Qwen's shipped re-derive-same-uuid repair flow,
    `clone-voice-resolver.ts:301-334`) would keep serving the OLD tensors
    from `_latents_cache` indefinitely, with `substituted_from` staying
    `None` — Property 1's silent-substitution shape via a stale cache
    instead of a stale file. Newly reachable: Task 11's
    `POST /xtts/clone-voice` (891770af) means a repeat clone of the same
    uuid now reaches `CoquiEngine.clone_voice` for real.

    Scenario: clone -> render (warms the cache with the FIRST latents) ->
    re-clone the SAME voice_id with DIFFERENT reference audio -> render
    again. The second render must use the NEW latents, not the cached OLD
    ones — asserted on the actual `gpt_cond_latent`/`speaker_embedding`
    values `inference()` received, not merely that the call succeeded."""
    config = _FakeXttsConfig()
    tts_model = _DistinctLatentsXttsModel(config=config)
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)

    # First clone + render — warms `_latents_cache` with the FIRST pair.
    eng.clone_voice("xtts-reclone", _ref_audio(4800), 24000, "an audition line")
    tts_model.infer_calls.clear()  # drop clone_voice's own audition call
    eng.synthesize("xtts_v2", "xtts-reclone", "hello there")

    assert len(tts_model.infer_calls) == 1
    assert tts_model.infer_calls[0]["gpt_cond_latent"] == "LATENT-1"
    assert tts_model.infer_calls[0]["speaker_embedding"] == "EMBEDDING-1"
    assert eng._latents_cache["xtts-reclone"] == ("LATENT-1", "EMBEDDING-1")

    # Re-clone the SAME voice_id from DIFFERENT reference audio — the .pt on
    # disk (and, per the fix, the epoch) both advance to the SECOND pair.
    eng.clone_voice("xtts-reclone", _ref_audio(9600), 24000, "an audition line")
    tts_model.infer_calls.clear()  # drop the re-clone's own audition call

    result = eng.synthesize("xtts_v2", "xtts-reclone", "hello again")

    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert len(tts_model.infer_calls) == 1
    # The load-bearing assertions: the second render's actual inference call
    # carried the NEW latents, not the ones warmed by the first render.
    assert tts_model.infer_calls[0]["gpt_cond_latent"] == "LATENT-2"
    assert tts_model.infer_calls[0]["speaker_embedding"] == "EMBEDDING-2"
    assert eng._latents_cache["xtts-reclone"] == ("LATENT-2", "EMBEDDING-2")


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


def test_clone_voice_route_manifest_read_failure_returns_empty_not_unknown_coqui_version(
    monkeypatch, tmp_path
) -> None:
    """fs-38 Wave 3c Task 19 fix round 1 (IMPORTANT-2). A manifest-read
    failure after a successful clone must report X-Coqui-Version: "" (empty),
    NEVER the "unknown" sentinel. Node's derive-engine-artifact.ts stores this
    header verbatim as the voice's stored coquiVersion; isArtifactVersionStale
    only treats an EMPTY version as "not stale" — "unknown" is truthy, so it
    would misclassify every subsequent classify as stale forever (a spurious
    GPU re-derive on every render, which could re-hit the same failure and
    loop). Simulates the failure via json.load raising (any manifest-read
    error the route's broad except Exception already catches), NOT a
    monkeypatched _voice_paths — the .pt/manifest ARE really written by
    clone_voice; only the route's OWN re-read of the manifest fails."""
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path, coqui_version="9.9.9-test")
    client = TestClient(main.app)

    def _raise_on_manifest_read(fh):
        raise ValueError("simulated corrupt manifest")

    # monkeypatch auto-restores json.load at test teardown — clone_voice's OWN
    # write path uses `_json.dump` (a separately-imported local alias), so
    # patching just `.load` leaves the actual clone/persist unaffected.
    monkeypatch.setattr(main.json, "load", _raise_on_manifest_read)

    resp = client.post(
        "/xtts/clone-voice",
        content=_pcm_bytes(),
        headers={"X-Sample-Rate": "24000", "X-Voice-Id": "xtts-manifest-fail"},
    )

    assert resp.status_code == 200  # the clone itself succeeded — only the header read failed
    assert resp.headers["X-Coqui-Version"] == ""
    assert resp.headers["X-Coqui-Version"] != "unknown"
    # modelId's own "unknown" sentinel is untouched by this fix — it is never
    # a staleness comparand (only coquiVersion is), so it keeps its prior
    # default deliberately.
    assert resp.headers["X-Model-Id"] == "unknown"
    # The .pt WAS actually persisted by clone_voice — only the route's
    # post-hoc manifest re-read failed, not the clone itself.
    pt_path, _json_path = eng._voice_paths("xtts-manifest-fail")
    assert os.path.isfile(pt_path)


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


# ── Task 8a — CoquiEngine.unload() races an in-flight forward ──────────────
#
# Folded in from Task 8's review (pre-existing defect, not introduced by
# Task 8): `unload()` took no lock and nulled `self._tts` outright, while
# `synthesize()`'s forward re-dereferences `self._tts` AFTER the possibly
# multi-second `tts()` call returns (still inside its own `with
# self._synth_lock:` block) — a racing /unload could null the model
# mid-flight and kill the request with an AttributeError after the
# expensive GPU work already ran. The fix mirrors QwenEngine.unload():
# take `_synth_lock` before nulling, so unload waits for an in-flight
# forward to finish and drop its own reference first.
#
# `test_evict_voice_route_evicts_even_when_model_unloaded` above already
# pins the companion Defect-2 decision (unload() deliberately does NOT
# clear `_latents_cache`; evict-voice does, even when unloaded) — no new
# test is added for that here, this section only covers the race.


def test_unload_blocks_until_inflight_forward_completes_and_no_attribute_error(
    monkeypatch, tmp_path
) -> None:
    """The regression: force the forward to block INSIDE `tts()` — still
    holding `_synth_lock` — and race a concurrent `unload()` in during that
    window. Before the fix, `unload()` took no lock, so it could null
    `self._tts` right then; the forward's post-`tts()` re-dereference
    (`self._tts.synthesizer.output_sample_rate`) would raise `AttributeError`
    on `None`. Deterministic via a `threading.Event` handshake (not sleeps):
    the fake `tts()` doesn't return until this test explicitly releases it,
    so `unload()` gets every opportunity to race in before the forward's
    post-call dereference — the classic race-test placebo is timing that
    never actually interleaves, which this handshake rules out."""
    tts_entered = threading.Event()
    proceed_with_tts = threading.Event()
    events: list[str] = []
    events_lock = threading.Lock()

    class _BlockingFakeTTS(_FakeTTS):
        def tts(self, text: str, speaker: str, language: str) -> list[float]:
            with events_lock:
                events.append("forward:enter")
            tts_entered.set()
            assert proceed_with_tts.wait(timeout=5), "test stalled waiting to release the forward"
            with events_lock:
                events.append("forward:tts-returns")
            return [0.0, 0.0]

    tts_model = _FakeXttsModel()
    tts_model.speaker_manager = types.SimpleNamespace(name_to_id={"Claribel Dervla": 0})
    tts_instance = _BlockingFakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    eng._ensure_loaded("xtts_v2")  # warm first, so both threads race on the FORWARD only

    outcome: dict[str, Any] = {}

    def _do_synth() -> None:
        try:
            outcome["result"] = eng.synthesize("xtts_v2", "Claribel Dervla", "hello there")
        except Exception as exc:  # noqa: BLE001 — captured for the assertion below
            outcome["error"] = exc

    def _do_unload() -> None:
        eng.unload()
        with events_lock:
            events.append("unload:done")

    t_synth = threading.Thread(target=_do_synth)
    t_synth.start()
    assert tts_entered.wait(timeout=5), "the forward never entered tts()"

    t_unload = threading.Thread(target=_do_unload)
    t_unload.start()
    time.sleep(0.1)  # give unload() every chance to race in while the forward blocks in tts()
    assert eng._tts is not None, "unload() must not null the model while the forward still holds _synth_lock"

    proceed_with_tts.set()
    t_synth.join(timeout=5)
    t_unload.join(timeout=5)

    assert "error" not in outcome, f"the forward must not raise: {outcome.get('error')!r}"
    assert outcome["result"].pcm  # the forward actually completed, not a placebo
    assert events == ["forward:enter", "forward:tts-returns", "unload:done"], (
        f"unload() must not interleave with the in-flight forward: {events}"
    )
    assert eng._tts is None, "unload() must still run to completion, just after the forward releases the lock"


# ── Task 11a — evict landing after latents load but before the GPU forward ──
#
# Folded in from Task 11's review (reasoned from source, not empirically): an
# already-latents-loaded `/synthesize` forward was never epoch-checked again
# before the GPU forward, so a voice evicted in the window between
# `_load_voice_latents` returning and `_infer_from_latents`'s
# `tts_model.inference()` call would complete and return audio anyway —
# `/xtts/evict-voice` reporting `evicted: True` did NOT mean "rendering
# stopped" for a request already past the latents-load step. The fix
# re-checks `_evict_epoch` immediately before the GPU forward (inside
# `_synth_lock`, right before `_infer_from_latents`) and raises rather than
# renders on a mismatch — `_load_voice_latents` now returns the epoch it
# validated against, captured ATOMICALLY with the cache read/install so the
# caller's re-check can't itself race an evict landing in the gap. This
# closes the window down to the (unavoidable, undetectable) gap between that
# re-check and the forward call itself — it does NOT abort a forward that is
# already inside `tts_model.inference()` by the time the evict lands. See
# the code comment at the re-check site and the `/xtts/evict-voice`
# docstring for that same caveat stated for a caller of the route.
#
# Fix round 1 (review): the first test below only covered the cache-MISS
# branch of `_load_voice_latents` — added the cache-HIT (warm-cache)
# counterpart, and a third test that pins the check's placement INSIDE
# `_synth_lock` rather than merely after `_load_voice_latents` returns.


def test_evict_landing_after_latents_load_aborts_before_gpu_forward(monkeypatch, tmp_path) -> None:
    """The regression Task 11's review reasoned to from source: block the
    synth thread right after `_load_voice_latents` hands back the latents —
    exactly the window between that return and the GPU forward starting —
    and land an evict there via `_bump_evict_epoch`, the same call
    `/xtts/evict-voice` makes. Deterministic via a `threading.Event`
    handshake (not sleeps): the wrapped `_load_voice_latents` doesn't let the
    synth thread proceed into `_synth_lock` until this test explicitly
    releases it, so the evict is GUARANTEED to land inside the window, not
    merely likely to. Before the fix this reproduces the bug (the forward
    completes and returns audio despite the evict); after the fix it must
    raise instead of rendering, and `tts_model.inference()` (the actual GPU
    forward) must never be called at all — not just that some error
    surfaces after the fact."""
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-evict-race")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()  # drop clone_voice's own audition call

    latents_loaded = threading.Event()
    proceed_after_evict = threading.Event()
    real_load = eng._load_voice_latents

    def _blocking_load(voice_id: str) -> Any:
        result = real_load(voice_id)
        latents_loaded.set()
        assert proceed_after_evict.wait(timeout=5), "test stalled waiting for the evict to land"
        return result

    monkeypatch.setattr(eng, "_load_voice_latents", _blocking_load)

    outcome: dict[str, Any] = {}

    def _do_synth() -> None:
        try:
            outcome["result"] = eng.synthesize("xtts_v2", "xtts-evict-race", "hello there")
        except Exception as exc:  # noqa: BLE001 — captured for the assertion below
            outcome["error"] = exc

    t = threading.Thread(target=_do_synth)
    t.start()
    assert latents_loaded.wait(timeout=5), "latents were never loaded"

    # Evict lands exactly in the window between `_load_voice_latents`
    # returning and the forward starting — the same call `/xtts/evict-voice`
    # makes (Task 13's revoke/purge flow, files-first / evict-last).
    eng._bump_evict_epoch("xtts-evict-race")

    proceed_after_evict.set()
    t.join(timeout=5)

    assert "error" in outcome, (
        f"an evicted voice's forward must fail loud rather than render: {outcome.get('result')!r}"
    )
    assert isinstance(outcome["error"], main.VoiceNotDesignedError)
    assert tts_model.infer_calls == [], "the GPU forward must never run once the evict landed"


def test_evict_landing_after_warm_cache_hit_aborts_before_gpu_forward(monkeypatch, tmp_path) -> None:
    """Fix round 1 (Task 11a review, Medium) — the test above only exercises
    the cache-MISS/fresh-load branch of `_load_voice_latents`
    (the `torch.load` path). Every sentence AFTER the first in a chapter
    render hits the CACHE-HIT branch instead (`main.py` ~1539-1541, a
    different line that reads `_evict_epoch` at a different point) — exactly
    the scenario the defect describes, since a chapter's second-and-later
    sentences are the common case, not the exception. Without this test, a
    regression that returned a stale/constant epoch on the cache-hit branch
    specifically (or read it before taking `_latents_lock`) would go inert
    for every sentence after the first, and this suite would say nothing."""
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-evict-race-warm")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()  # drop clone_voice's own audition call

    # Warm the cache first — this call takes the fresh-load branch and
    # installs the entry. The race below's `_load_voice_latents` call is
    # therefore a cache HIT, not a miss.
    eng._load_voice_latents("xtts-evict-race-warm")
    assert "xtts-evict-race-warm" in eng._latents_cache

    latents_loaded = threading.Event()
    proceed_after_evict = threading.Event()
    real_load = eng._load_voice_latents

    def _blocking_load(voice_id: str) -> Any:
        result = real_load(voice_id)  # cache HIT this time
        latents_loaded.set()
        assert proceed_after_evict.wait(timeout=5), "test stalled waiting for the evict to land"
        return result

    monkeypatch.setattr(eng, "_load_voice_latents", _blocking_load)

    outcome: dict[str, Any] = {}

    def _do_synth() -> None:
        try:
            outcome["result"] = eng.synthesize("xtts_v2", "xtts-evict-race-warm", "hello again")
        except Exception as exc:  # noqa: BLE001 — captured for the assertion below
            outcome["error"] = exc

    t = threading.Thread(target=_do_synth)
    t.start()
    assert latents_loaded.wait(timeout=5), "latents were never loaded"

    eng._bump_evict_epoch("xtts-evict-race-warm")

    proceed_after_evict.set()
    t.join(timeout=5)

    assert "error" in outcome, (
        f"an evicted voice's forward must fail loud on a warm cache hit too: {outcome.get('result')!r}"
    )
    assert isinstance(outcome["error"], main.VoiceNotDesignedError)
    assert tts_model.infer_calls == [], "the GPU forward must never run once the evict landed"


def test_evict_re_check_reads_epoch_after_acquiring_synth_lock_not_before(
    monkeypatch, tmp_path
) -> None:
    """Fix round 1 (Task 11a review, Low) — pins WHERE the re-check runs:
    after `_synth_lock` is actually acquired, not merely after
    `_load_voice_latents` returns. The two tests above park the synth thread
    INSIDE `_load_voice_latents` itself, before it ever reaches
    `with self._synth_lock:` — so they'd still pass even if the re-check
    were hoisted to run right after `_load_voice_latents` returns instead of
    inside the lock, because in either placement the evict has already
    landed before either version's check runs. That hoist would matter in
    practice: it would widen the real window from microseconds (the gap
    between the in-lock check and the forward call, both back-to-back
    statements) to potentially SECONDS (the time a forward can spend queued
    waiting for `_synth_lock` behind another in-flight render) — while the
    code comment and the `/xtts/evict-voice` docstring both claim the narrow
    bound. A comment silently going false is exactly the defect class this
    branch keeps catching.

    Proven by holding `_synth_lock` in this test's own thread BEFORE
    starting the synth thread: `_load_voice_latents` still returns
    immediately (no I/O blocks it here), but the synth thread then MUST
    queue on `_synth_lock` — held by us — before any in-lock check can run.
    The evict lands while it is queued (lock still held by us, so the synth
    thread cannot have reached the forward, or a correctly-placed check, by
    construction), then we release the lock. Only a check that re-reads the
    epoch AFTER acquiring the lock — not one that ran before the queue —
    can observe the evict and raise."""
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-lock-race")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()  # drop clone_voice's own audition call

    load_returned = threading.Event()
    real_load = eng._load_voice_latents

    def _signalling_load(voice_id: str) -> Any:
        result = real_load(voice_id)
        load_returned.set()
        return result

    monkeypatch.setattr(eng, "_load_voice_latents", _signalling_load)

    outcome: dict[str, Any] = {}

    def _do_synth() -> None:
        try:
            outcome["result"] = eng.synthesize("xtts_v2", "xtts-lock-race", "hello there")
        except Exception as exc:  # noqa: BLE001 — captured for the assertion below
            outcome["error"] = exc

    assert eng._synth_lock.acquire(timeout=5), "test could not acquire _synth_lock"
    try:
        t = threading.Thread(target=_do_synth)
        t.start()
        assert load_returned.wait(timeout=5), "latents were never loaded"
        # The synth thread's `_load_voice_latents` has already returned, and
        # it cannot have proceeded any further — we hold `_synth_lock`. Evict
        # now, while it is queued waiting for the lock we hold.
        eng._bump_evict_epoch("xtts-lock-race")
    finally:
        eng._synth_lock.release()

    t.join(timeout=5)

    assert "error" in outcome, (
        f"the re-check must read the epoch AFTER acquiring _synth_lock, not before: {outcome.get('result')!r}"
    )
    assert isinstance(outcome["error"], main.VoiceNotDesignedError)
    assert tts_model.infer_calls == [], "the GPU forward must never run once the evict landed"


# -- GATE 1 fix round: sidecar findings MIN-1..MIN-6 -----------------------
#
# Each test below pins ONE of the whole-branch review's sidecar findings.
# Every one was verified by reverting its fix and watching it fail for the
# stated reason before being kept (the fix report records the observed
# output) - this branch has already shipped ten placebo tests, so "it
# passes" was not accepted as evidence for any of them.


def test_load_voice_latents_uses_the_safe_unpickler(monkeypatch, tmp_path) -> None:
    """MIN-1 - the persisted artifact is `{"gpt_cond_latent": tensor,
    "speaker_embedding": tensor}`, plain tensors the safe loader handles, and
    `pt_path` is derived from a CALLER-SUPPLIED `voice` field. Loading it with
    `weights_only=False` makes any file that lands at
    `voices/xtts/<sanitised>.pt` execute arbitrary code at load time. Assert
    the flag actually reaching `torch.load`, not merely that the load
    succeeded - a wrong flag loads these tensors perfectly happily, so a
    round-trip assertion would be a placebo."""
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-weights1")

    real_torch = sys.modules["torch"]
    load_kwargs: list[dict[str, Any]] = []

    def _recording_load(path: str, **kwargs: Any) -> Any:
        load_kwargs.append(kwargs)
        return real_torch.load(path, **kwargs)

    recording_torch = types.ModuleType("torch")
    recording_torch.save = real_torch.save  # type: ignore[attr-defined]
    recording_torch.load = _recording_load  # type: ignore[attr-defined]
    recording_torch.cuda = real_torch.cuda  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", recording_torch)

    eng._load_voice_latents("xtts-weights1")

    assert len(load_kwargs) == 1
    assert load_kwargs[0]["weights_only"] is True
    # map_location stays 'cpu' - latents are persisted as CUDA tensors on
    # whichever card derived them (`_load_voice_latents`'s own docstring).
    assert load_kwargs[0]["map_location"] == "cpu"


class _TtsReadSpyEngine(main.CoquiEngine):
    """Counts `self._tts` reads taken while `_synth_lock` is NOT held.

    That set is exactly the set a racing `POST /unload` can observe as None:
    `unload()` acquires `_synth_lock` before nulling `self._tts`, so a read
    taken under that lock is safe by construction and a read taken outside it
    is not. The backing store is a separate attribute so the property can
    intercept every get without changing what `__init__`/`_ensure_loaded`
    store."""

    _tts_backing: Any = None

    def __init__(self) -> None:
        self.unlocked_tts_reads = 0
        super().__init__()

    @property  # type: ignore[override]
    def _tts(self) -> Any:
        if not self._synth_lock.locked():
            self.unlocked_tts_reads += 1
        return self._tts_backing

    @_tts.setter
    def _tts(self, value: Any) -> None:
        self._tts_backing = value


def _make_spy_engine(monkeypatch, tmp_path: Path) -> tuple[_TtsReadSpyEngine, _FakeTTS]:
    monkeypatch.setenv("XTTS_VOICES_DIR", str(tmp_path / "xtts"))
    tts_instance = _install_fake_coqui_runtime(monkeypatch)
    return _TtsReadSpyEngine(), tts_instance


def test_cloned_branch_reads_tts_once_outside_the_synth_lock(monkeypatch, tmp_path) -> None:
    """MIN-2 - the cloned branch ran `assert self._tts is not None` and then
    `config = self._tts.synthesizer.tts_model.config`: TWO separate reads,
    both after `_ensure_loaded` released `_synth_lock` and both before the
    branch's own `with self._synth_lock:`. A `/unload` landing between them
    (Stop button, or the Analysing screen auto-evicting Coqui for the
    analyzer LLM) makes the second read None - an `AttributeError` on
    `'NoneType' object has no attribute 'synthesizer'` under `python -O`,
    where the guarding assert is stripped.

    Counting reads is the assertion that actually discriminates: the fix is a
    single local capture, so any regression that re-introduces a second
    unguarded read fails here even when no unload ever races it. The counter
    is reset after `_ensure_loaded` so only the branch's own reads are
    measured - `_ensure_loaded`'s early-return read is not this finding's
    subject."""
    eng, tts_instance = _make_spy_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-lockread1")
    tts_instance.synthesizer.tts_model.infer_calls.clear()

    real_ensure = eng._ensure_loaded

    def _ensure_then_reset(*args: Any, **kwargs: Any) -> None:
        real_ensure(*args, **kwargs)
        eng.unlocked_tts_reads = 0

    monkeypatch.setattr(eng, "_ensure_loaded", _ensure_then_reset)

    result = eng.synthesize("xtts_v2", "xtts-lockread1", "hello there")

    assert result.substituted_from is None
    assert len(tts_instance.synthesizer.tts_model.infer_calls) == 1
    assert eng.unlocked_tts_reads == 1, (
        "the cloned branch must read self._tts exactly once outside _synth_lock "
        f"(a racing unload can null it between reads); saw {eng.unlocked_tts_reads}"
    )


def test_cloned_branch_unloaded_model_fails_with_a_clear_error(monkeypatch, tmp_path) -> None:
    """MIN-2, the other half - when the racing unload DOES win (the single
    read yields None), the branch must fail with an explicit, actionable
    error rather than a bare `assert` (an `AssertionError`, or nothing at all
    under `python -O`, which degrades into an `AttributeError` one line
    later). `_ensure_loaded` is stubbed to a no-op so the branch is entered
    with `self._tts` genuinely None - the state a completed `/unload` leaves
    behind."""
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-unloaded1")
    eng.unload()
    assert eng._tts is None
    monkeypatch.setattr(eng, "_ensure_loaded", lambda *a, **k: None)

    with pytest.raises(RuntimeError, match="unloaded") as excinfo:
        eng.synthesize("xtts_v2", "xtts-unloaded1", "hello there")

    # Specifically NOT an AssertionError (stripped under -O) and NOT an
    # AttributeError on None - both were the pre-fix outcomes.
    assert not isinstance(excinfo.value, AssertionError)
    assert not isinstance(excinfo.value, AttributeError)


def test_cached_latents_forward_unloaded_model_fails_with_a_clear_error(monkeypatch, tmp_path) -> None:
    """A merge-sweep finding, same MIN-2 shape at a DIFFERENT reachable
    window than the test above: the branch's OWN `with self._synth_lock:`
    re-check (immediately before the Task 11a epoch re-check and the GPU
    forward) was still a bare `assert self._tts is not None`. Unlike the
    `_ensure_loaded`-guarded read tested above, `_load_voice_latents` runs
    entirely OFF the lock (its own docstring), so an explicit `/unload`
    (Stop button / analyzer auto-evict) landing between it returning and
    this branch's `with self._synth_lock:` acquisition is independently
    reachable - it checks only `_synth_lock`, never any in-flight claim.

    Reproduced deterministically: wrap `_load_voice_latents` so it calls the
    real `unload()` right after returning, landing the race in exactly that
    window every time. Before the fix this crashes with `AssertionError`
    (or, under `python -O`, an `AttributeError` one line later); after the
    fix it must raise the same loud `RuntimeError` `/synthesize`'s other
    branches already use."""
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-unloaded2")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()  # drop clone_voice's own audition call

    real_load = eng._load_voice_latents

    def _load_then_unload(voice_id: str) -> Any:
        result = real_load(voice_id)
        eng.unload()  # an explicit Stop wins the race right here
        return result

    monkeypatch.setattr(eng, "_load_voice_latents", _load_then_unload)

    with pytest.raises(RuntimeError, match="unloaded") as excinfo:
        eng.synthesize("xtts_v2", "xtts-unloaded2", "hello there")

    # Specifically NOT an AssertionError (stripped under -O) and NOT an
    # AttributeError on None - both were the pre-fix outcomes.
    assert not isinstance(excinfo.value, AssertionError)
    assert not isinstance(excinfo.value, AttributeError)
    assert tts_model.infer_calls == [], "the GPU forward must never run once the model was unloaded"


def test_infer_from_latents_unloaded_model_fails_with_a_clear_error(monkeypatch, tmp_path) -> None:
    """A merge-sweep finding: `_infer_from_latents` — the low-level forward
    helper Task 9 built and shared between `clone_voice`'s audition preview
    and this cached-latents `/synthesize` branch (its own docstring) — still
    carried its OWN bare `assert self._tts is not None` at its very first
    line, the same MIN-2 shape already fixed on both of its callers'
    pre-checks. `CALLER MUST HOLD _synth_lock` per its docstring, but the
    guard itself is what the caller relies on to fail loud rather than
    dereference `None` a line later — drives the method directly with the
    model already dropped (the state a completed `/unload` leaves behind),
    same technique as `test_publish_loaded_locked_stamps_last_used_before_publishing_tts`
    in test_coqui_publish_race.py uses for another guard-only helper."""
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    eng._tts = None  # the state a completed /unload leaves behind

    with pytest.raises(RuntimeError, match="unloaded") as excinfo:
        eng._infer_from_latents("LATENT", "EMBEDDING", "hello there", "en")

    # Specifically NOT an AssertionError (stripped under -O) and NOT an
    # AttributeError on None - both were the pre-fix outcomes.
    assert not isinstance(excinfo.value, AssertionError)
    assert not isinstance(excinfo.value, AttributeError)


def test_unsupported_language_raises_its_own_error_type(monkeypatch, tmp_path) -> None:
    """MIN-4 - the language gate raised a bare `VoiceNotDesignedError`, which
    /synthesize maps to "has not been designed yet". The voice IS cloned; the
    loaded model just does not list the language, so that remedy (clone it
    again) can never work. The new type must still be a
    `VoiceNotDesignedError` subclass: every other handler treats it as the
    fail-loud, no-fallback condition it is (Property 1), and collapsing that
    would be a regression."""
    eng, _voices_dir, tts_instance = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-lang1")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()

    with pytest.raises(main.VoiceLanguageUnsupportedError) as excinfo:
        eng.synthesize("xtts_v2", "xtts-lang1", "hello there", language="xx")

    assert isinstance(excinfo.value, main.VoiceNotDesignedError)
    assert "xx" in str(excinfo.value)
    assert tts_model.infer_calls == []


def test_missing_latents_is_not_the_language_error_type(monkeypatch, tmp_path) -> None:
    """MIN-4's companion - the two conditions must stay distinguishable. A
    genuinely never-cloned voice keeps raising the PLAIN
    `VoiceNotDesignedError`, so /synthesize keeps answering
    `voice_not_designed` for it. Without this, "give the language failure its
    own type" could have been satisfied by widening both to the new one."""
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)

    with pytest.raises(main.VoiceNotDesignedError) as excinfo:
        eng.synthesize("xtts_v2", "xtts-never-cloned-lang", "hello there")

    assert not isinstance(excinfo.value, main.VoiceLanguageUnsupportedError)


def test_synthesize_route_reports_unsupported_language_not_not_designed(
    monkeypatch, tmp_path
) -> None:
    """MIN-4 over the wire. The user-visible symptom was a Russian book on a
    cloned Coqui voice being told "Voice 'xtts-...' has not been designed
    yet" - so the assertion that matters is on the RESPONSE BODY, not on the
    exception type: the code must not be `voice_not_designed`, and the detail
    must name the language and the model's supported set instead of implying
    a re-clone."""
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-lang-http1")
    client = TestClient(main.app)

    resp = client.post(
        "/synthesize",
        json={
            "engine": "coqui", "model": "xtts_v2",
            "voice": "xtts-lang-http1", "text": "hello there", "language": "ru",
        },
    )

    assert resp.status_code == 409
    body = resp.json()
    assert body["code"] == "voice_language_unsupported"
    assert body["code"] != "voice_not_designed"
    assert "has not been designed yet" not in body["detail"]
    assert "ru" in body["detail"]
    # The fake's config.languages - the actionable part of the message.
    assert "en" in body["detail"]


def test_synthesize_route_still_reports_voice_not_designed_for_a_missing_pt(
    monkeypatch, tmp_path
) -> None:
    """MIN-4 regression guard at the route: adding the narrower handler must
    not shadow the existing one. A never-cloned voice keeps its #1063 409
    `voice_not_designed` contract, which Node's voice-sample.ts and
    voice-library.ts both match on."""
    _install_engine(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/synthesize",
        json={"engine": "coqui", "model": "xtts_v2", "voice": "xtts-absent1", "text": "hello"},
    )

    assert resp.status_code == 409
    assert resp.json()["code"] == "voice_not_designed"


def test_bump_evict_epoch_reports_whether_it_dropped_an_entry(monkeypatch, tmp_path) -> None:
    """MIN-3 - the `evicted` flag's source of truth. `_bump_evict_epoch` now
    returns the pop's own result, computed inside the same `_latents_lock`
    critical section as the pop, so the two can never disagree."""
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-flag1")
    eng._load_voice_latents("xtts-flag1")
    assert "xtts-flag1" in eng._latents_cache

    assert eng._bump_evict_epoch("xtts-flag1") is True
    # Idempotent: a second call has nothing left to drop.
    assert eng._bump_evict_epoch("xtts-flag1") is False
    assert eng._bump_evict_epoch("xtts-never-cached") is False


class _AcquisitionCountingLock:
    """Wraps a real lock and counts `with` entries. Every `_latents_lock` use
    in main.py is a context-manager use, so this observes all of them."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.acquisitions = 0

    def __enter__(self) -> Any:
        self.acquisitions += 1
        return self._inner.__enter__()

    def __exit__(self, *exc: Any) -> Any:
        return self._inner.__exit__(*exc)

    def locked(self) -> bool:
        return self._inner.locked()


def test_evict_voice_route_reads_and_pops_in_one_critical_section(monkeypatch, tmp_path) -> None:
    """MIN-3 - the route read `stripped_id in coqui._latents_cache` under its
    OWN `_latents_lock` acquisition and then popped under a second one inside
    `_bump_evict_epoch`. A `_load_voice_latents` installing that voice in the
    gap made the response say `evicted: false` for a call that did in fact
    evict an entry - `/qwen/evict-voice` has always done both in one section.

    Counting acquisitions is what discriminates: asserting the flag alone
    passes on the two-section version too (the gap is empty in a
    single-threaded test), which is exactly the placebo shape this branch
    keeps producing. Two acquisitions == the gap exists."""
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path)
    _clone(eng, "xtts-atomic-evict1")
    eng._load_voice_latents("xtts-atomic-evict1")
    assert "xtts-atomic-evict1" in eng._latents_cache

    counting = _AcquisitionCountingLock(eng._latents_lock)
    monkeypatch.setattr(eng, "_latents_lock", counting)
    client = TestClient(main.app)

    resp = client.post("/xtts/evict-voice", json={"voiceId": "xtts-atomic-evict1"})

    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "evicted": True}
    assert counting.acquisitions == 1, (
        "the membership read and the pop must share ONE _latents_lock critical "
        f"section; saw {counting.acquisitions} acquisitions"
    )


def test_manifest_write_is_atomic_a_failed_write_leaves_the_previous_one_intact(
    monkeypatch, tmp_path
) -> None:
    """MIN-5 / M7 - `clone_voice` persisted the `.pt` atomically and then
    wrote the sibling `.json` with a plain `open(json_path, "w")`, the exact
    non-atomic call its own D-C rationale rejected. `open(..., "w")`
    truncates FIRST, so a serialiser failure (or a `taskkill /T /F`, which is
    how `npm start` tears the sidecar down on Windows) part-way through left
    a TRUNCATED manifest where a valid one had been.

    The stimulus is a real failure, not a patched writer: an unserialisable
    `coquiVersion` makes `json.dump` emit the first two keys and then raise,
    while `json.dumps` raises having touched no file at all. So the pre-fix
    code corrupts the target and the post-fix code cannot. Asserting the file
    merely EXISTS afterwards would pass on both."""
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, coqui_version="1.2.3-fake")
    _clone(eng, "xtts-atomic-json1")
    _pt_path, json_path = eng._voice_paths("xtts-atomic-json1")
    good = json.loads(Path(json_path).read_text(encoding="utf-8"))
    assert good["coquiVersion"] == "1.2.3-fake"

    # A non-string version - `getattr(TTS, "__version__")` is read verbatim
    # into the manifest, so this reaches the serialiser as a real TypeError
    # part-way through the document.
    monkeypatch.setattr(sys.modules["TTS"], "__version__", object())

    with pytest.raises(TypeError):
        _clone(eng, "xtts-atomic-json1")

    survived = json.loads(Path(json_path).read_text(encoding="utf-8"))
    assert survived == good, "a failed manifest write must leave the previous manifest intact"
    assert not os.path.isfile(f"{json_path}.tmp"), "the temp sibling must be cleaned up"


def test_manifest_temp_sibling_has_a_deterministic_purgeable_name(monkeypatch, tmp_path) -> None:
    """M7's naming constraint. The GATE 1 Critical is that
    `_atomic_torch_save`/`_atomic_wav_save` strand RANDOMLY named `mkstemp`
    siblings that `purgeCloneArtifacts` - a fixed path list with no directory
    sweep - can never reach, so a hard kill leaves the conditioning latents
    and the raw human reference clip behind forever (Property 2). The
    manifest's atomic write must not add a third unreachable name: its temp
    is `<target>.tmp`, derivable from the target, so a fixed-path purge can
    delete it."""
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path)
    _pt_path, json_path = eng._voice_paths("xtts-atomic-json2")

    replaces: list[tuple[str, str]] = []
    real_replace = os.replace

    def _recording_replace(src: Any, dst: Any) -> None:
        replaces.append((str(src), str(dst)))
        real_replace(src, dst)

    monkeypatch.setattr(main.os, "replace", _recording_replace)
    _clone(eng, "xtts-atomic-json2")

    manifest_replaces = [r for r in replaces if r[1] == json_path]
    assert len(manifest_replaces) == 1, "the manifest must land via a single os.replace"
    assert manifest_replaces[0][0] == f"{json_path}.tmp"


def test_clone_voice_route_rejects_a_non_prefixed_voice_id(monkeypatch, tmp_path) -> None:
    """MIN-6 - `/xtts/clone-voice` accepted any non-empty `X-Voice-Id`, while
    `synthesize()` enters its cloned branch ONLY for ids starting with
    `XTTS_KEY_PREFIX`. A clone stored under a non-prefixed id therefore
    succeeded (200, `.pt` + `.json` written, audition returned) and then, at
    render time, fell through to the catalogue substitution path - a
    successful clone whose renders are silently swapped for a stock speaker,
    Property 1's exact shape. Assert no artifact is written, not just the
    status: a 400 that still persisted the `.pt` would leave the trap armed."""
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/xtts/clone-voice",
        content=_pcm_bytes(),
        headers={"X-Sample-Rate": "24000", "X-Voice-Id": "not-prefixed-uuid"},
    )

    assert resp.status_code == 400
    assert main.CoquiEngine.XTTS_KEY_PREFIX in resp.json()["detail"]
    pt_path, json_path = eng._voice_paths("not-prefixed-uuid")
    assert not os.path.isfile(pt_path)
    assert not os.path.isfile(json_path)


def test_clone_voice_route_still_accepts_the_prefixed_id(monkeypatch, tmp_path) -> None:
    """MIN-6 regression guard - the shipped producer
    (`derive-engine-artifact.ts`, which always sends
    `cloneStorageKey(engine, voiceUuid)`) must be unaffected by the new
    boundary check."""
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/xtts/clone-voice",
        content=_pcm_bytes(),
        headers={"X-Sample-Rate": "24000", "X-Voice-Id": "xtts-prefixed-ok"},
    )

    assert resp.status_code == 200
    pt_path, _json_path = eng._voice_paths("xtts-prefixed-ok")
    assert os.path.isfile(pt_path)


def _engine_with_live_manifest(monkeypatch, tmp_path: Path) -> tuple[main.CoquiEngine, _FakeTTS]:
    """An engine whose `_speakers` manifest is POPULATED, so the fail-soft
    catalogue substitution path is actually live. With the default fake
    (`_speakers` empty) that path is permissive and never substitutes, so a
    test built on it could not observe a substitution even if one happened —
    the placebo shape `test_synthesize_cloned_voice_renders_with_no_
    substitution` already calls out."""
    tts_model = _FakeXttsModel(config=_FakeXttsConfig())
    tts_model.speaker_manager = types.SimpleNamespace(
        name_to_id={main.CoquiEngine.FALLBACK_SPEAKER: 0, "Some Other Speaker": 1}
    )
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    return eng, tts_instance


def test_case_varied_clone_key_never_reaches_catalogue_substitution(
    monkeypatch, tmp_path
) -> None:
    """GATE 1 sweep, third instance of the un-folded-clone-key class (Task 10a
    fixed the first, the C4 fix the second).

    `XTTS-<uuid>` did not start with the lower-case `XTTS_KEY_PREFIX`, so it
    skipped the cloned-voice branch entirely and fell through to the fail-soft
    catalogue path, which substituted a stock speaker. The Node-side fail-loud
    guard that exists to catch exactly that (`tts/sidecar.ts`'s
    `substitutedFrom.startsWith('xtts-')`) was case-sensitive too, so it
    missed the identical input — a matched blind spot across both layers.

    NTFS/APFS resolve case-insensitively, so `XTTS-<uuid>` reaches the very
    same `.pt` the victim consented to; the string comparison disagreeing with
    the filesystem is the whole bug.

    The assertion spies on `self._tts.tts()` — the REAL substitution call —
    rather than on `tts_model.inference()`, for the reason
    `test_synthesize_missing_latents_never_falls_back_to_real_tts_call`
    documents: asserting on `tts_model.*` can never observe a fallback."""
    eng, tts_instance = _engine_with_live_manifest(monkeypatch, tmp_path)
    _clone(eng, "xtts-case1")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()
    tts_instance.tts_calls.clear()

    with pytest.raises(main.VoiceNotDesignedError) as excinfo:
        eng.synthesize("xtts_v2", "XTTS-case1", "hello there")

    # Fail LOUD, and specifically not by rendering someone else's voice.
    assert tts_instance.tts_calls == [], (
        "a case-varied clone key must never reach the catalogue substitution "
        f"path; it rendered {tts_instance.tts_calls!r}"
    )
    assert tts_model.infer_calls == []
    assert "case-sensitive" in str(excinfo.value)


def test_canonical_clone_key_with_a_mixed_case_uuid_still_renders(monkeypatch, tmp_path) -> None:
    """The fold must reject a case-varied PREFIX without normalising the whole
    key: the uuid segment's casing is Node's to choose, and the sidecar reads
    and writes at the path Node's own `cloneStorageKey` derives. Lower-casing
    the entire id would make the sidecar look for a file Node never wrote on
    any case-SENSITIVE filesystem, and leave `purgeCloneArtifacts` deleting a
    path the in-memory cache no longer matches. A canonical prefix with an
    upper-case uuid is a normal, renderable voice."""
    eng, tts_instance = _engine_with_live_manifest(monkeypatch, tmp_path)
    _clone(eng, "xtts-MixedCaseUuid")
    tts_model = tts_instance.synthesizer.tts_model
    tts_model.infer_calls.clear()
    tts_instance.tts_calls.clear()

    result = eng.synthesize("xtts_v2", "xtts-MixedCaseUuid", "hello there")

    assert result.substituted_from is None
    assert len(tts_model.infer_calls) == 1
    assert tts_instance.tts_calls == []
    # The cache/epoch key is the raw id, byte-identical to Node's key.
    assert "xtts-MixedCaseUuid" in eng._latents_cache


def test_synthesize_route_case_varied_clone_key_is_409_not_a_substituted_200(
    monkeypatch, tmp_path
) -> None:
    """The wire-level shape of the same defect. Before the fold this returned
    200 with `X-Voice-Substituted-From: XTTS-<uuid>` — audio of a stranger's
    voice, which the Node guard then failed to reject. The user-visible
    contract is a loud 409 and no audio at all."""
    eng, _tts_instance = _engine_with_live_manifest(monkeypatch, tmp_path)
    monkeypatch.setitem(main.ENGINES, "coqui", eng)
    _clone(eng, "xtts-case-http1")
    client = TestClient(main.app)

    resp = client.post(
        "/synthesize",
        json={
            "engine": "coqui", "model": "xtts_v2",
            "voice": "XTTS-case-http1", "text": "hello there",
        },
    )

    assert resp.status_code == 409
    assert "X-Voice-Substituted-From" not in resp.headers


def test_clone_voice_route_rejects_a_case_varied_prefix(monkeypatch, tmp_path) -> None:
    """The write side of the same rule. `/xtts/clone-voice` requires the exact
    canonical prefix, so an artifact can never be persisted under a key
    `synthesize` will later refuse — the two boundaries agree on one spelling
    rather than one accepting what the other rejects."""
    eng, _voices_dir, _tts = _install_engine(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/xtts/clone-voice",
        content=_pcm_bytes(),
        headers={"X-Sample-Rate": "24000", "X-Voice-Id": "XTTS-case-write1"},
    )

    assert resp.status_code == 400
    pt_path, _json_path = eng._voice_paths("XTTS-case-write1")
    assert not os.path.isfile(pt_path)


class _LoaderSpyXttsModel(_FakeXttsModel):
    """Records the live TTS.tts.models.xtts.load_audio at derive time, and
    whether CoquiEngine._synth_lock was already held when the derive ran.

    Subclassed rather than hooked into the shared fake: ~30 tests use
    _FakeXttsModel and none of them want this.

    Mirrors the base class's full named-parameter list (not `*a, **kw`) --
    same reason `_DistinctLatentsXttsModel` above does: `clone_voice`
    introspects `inspect.signature(tts_model.get_conditioning_latents)` to
    read each named keyword's default, and a `**kwargs`-only override hides
    them from that introspection.
    """

    def __init__(self, *a, **kw) -> None:
        super().__init__(*a, **kw)
        self.loader_during_derive = None
        self.lock_was_held: bool | None = None
        # Filled by the test after `_make_engine` returns -- the engine
        # doesn't exist yet when this fake is constructed.
        self.engine_ref: list[Any] = [None]

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
        import sys

        self.loader_during_derive = sys.modules["TTS.tts.models.xtts"].load_audio

        # The lock must ALREADY be held when the derive runs, or the module-global
        # swap is racing every concurrent synth.
        acquired = self.engine_ref[0]._synth_lock.acquire(blocking=False)
        self.lock_was_held = not acquired
        if acquired:
            self.engine_ref[0]._synth_lock.release()

        return super().get_conditioning_latents(
            audio_path,
            max_ref_length=max_ref_length,
            gpt_cond_len=gpt_cond_len,
            gpt_cond_chunk_len=gpt_cond_chunk_len,
            librosa_trim_db=librosa_trim_db,
            sound_norm_refs=sound_norm_refs,
            load_sr=load_sr,
        )


def test_derive_runs_with_the_patched_loader_installed(monkeypatch, tmp_path) -> None:
    """#1967 -- the reference decode must be OURS during the derive call, and
    the module-global swap must happen while `_synth_lock` is held.

    Asserting only that clone_voice succeeds would pass with no patch at all
    on a box with shared FFmpeg. Assert the module attribute from inside the
    fake get_conditioning_latents instead.
    """
    import sys

    import xtts_audio_io

    tts_model = _LoaderSpyXttsModel()
    tts_instance = _FakeTTS(
        "tts_models/multilingual/multi-dataset/xtts_v2",
        synthesizer=_FakeSynthesizer(tts_model=tts_model),
    )
    eng, _voices_dir, _tts = _make_engine(monkeypatch, tmp_path, tts_instance=tts_instance)
    tts_model.engine_ref[0] = eng

    # `_install_fake_coqui_runtime` (via `_make_engine`) seeds
    # `TTS.tts.models.xtts.load_audio` with `_default_fake_load_audio` —
    # capture it so we can prove `patched_xtts_load_audio()` restores it
    # afterwards, without hardcoding that fixture's private function name.
    xtts_mod = sys.modules["TTS.tts.models.xtts"]
    original_load_audio = xtts_mod.load_audio

    eng.clone_voice("voice-1", _ref_audio(), 24000, "hello")

    assert tts_model.loader_during_derive is xtts_audio_io.wave_load_audio
    assert xtts_mod.load_audio is original_load_audio  # restored afterwards
    assert tts_model.lock_was_held
