"""test_runtime_wiring.py — CUDA + DeepSpeed + fp16 wiring assertions.

These cover the integration paths that the resolver tests in test_smoke.py
and the validation/error tests in test_synthesize.py deliberately stay above:

- DeepSpeed flag resolved → init_gpt_for_inference actually called with
  use_deepspeed=True, BEFORE tts.to(device).
- DeepSpeed init failure → swallowed, load continues, warning logged.
- fp16 flag resolved → synthesize() wraps tts.tts() in torch.autocast.
- PCM byte conversion handles clipping, stereo downmix, list input.
- Speaker manifest enumeration tolerates name_to_id absence and
  speaker_manager access errors.

All cases mock TTS/torch via sys.modules so no real model loads.
"""

from __future__ import annotations

import logging
import sys
import types
from pathlib import Path
from typing import Any

import numpy as np
import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# ── Call recorder ─────────────────────────────────────────────────────

class _CallRecord:
    """Ordered method-call log so tests can assert sequencing
    (e.g. init_gpt_for_inference happens before to(device))."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def record(self, name: str, **kwargs: Any) -> None:
        self.calls.append((name, kwargs))

    def names(self) -> list[str]:
        return [c[0] for c in self.calls]


# ── TTS load-path stubs ───────────────────────────────────────────────

class _FakeGpt:
    def __init__(self, record: _CallRecord, init_raises: bool = False) -> None:
        self._record = record
        self._init_raises = init_raises

    def init_gpt_for_inference(self, **kwargs: Any) -> None:
        self._record.record("init_gpt_for_inference", **kwargs)
        if self._init_raises:
            raise RuntimeError("deepspeed missing")


class _FakeSpeakerManager:
    """Configurable manager — pass `name_to_id` and/or `speaker_names`.
    Attributes not passed are omitted so `getattr(sm, name, default)`
    returns the default, exercising main.py's fallback chain."""

    def __init__(self, *, name_to_id: Any = None, speaker_names: Any = None) -> None:
        if name_to_id is not None:
            self.name_to_id = name_to_id
        if speaker_names is not None:
            self.speaker_names = speaker_names


class _FakeTtsModel:
    def __init__(
        self,
        record: _CallRecord,
        *,
        init_raises: bool = False,
        speaker_manager: Any = None,
    ) -> None:
        self.gpt = _FakeGpt(record, init_raises=init_raises)
        self.speaker_manager = speaker_manager if speaker_manager is not None else _FakeSpeakerManager()


class _RaisingTtsModel:
    """tts_model whose `speaker_manager` access itself raises, exercising
    the except branch around the manifest enumeration block."""

    def __init__(self, record: _CallRecord, init_raises: bool = False) -> None:
        self.gpt = _FakeGpt(record, init_raises=init_raises)

    @property
    def speaker_manager(self) -> Any:
        raise RuntimeError("speaker_manager broken")


class _FakeSynthesizer:
    def __init__(self, tts_model: Any, output_sample_rate: int = 24000) -> None:
        self.tts_model = tts_model
        self.output_sample_rate = output_sample_rate


class _FakeTtsInstance:
    def __init__(
        self,
        record: _CallRecord,
        *,
        tts_model: Any = None,
        output_sample_rate: int = 24000,
        model_id: str | None = None,
    ) -> None:
        self._record = record
        self.model_id = model_id
        if tts_model is None:
            tts_model = _FakeTtsModel(record)
        self.synthesizer = _FakeSynthesizer(tts_model, output_sample_rate=output_sample_rate)

    def to(self, device: str) -> "_FakeTtsInstance":
        self._record.record("to", device=device)
        return self


# ── load_stubs fixture ────────────────────────────────────────────────

class _LoadFixture:
    """Handle returned by `load_stubs`. Tests set knobs on the instance
    BEFORE calling _ensure_loaded; reads happen via .record after."""

    def __init__(self, record: _CallRecord) -> None:
        self.record = record
        self.cuda_available: bool = True
        self.init_raises: bool = False
        self.speaker_manager: Any = None         # default empty _FakeSpeakerManager
        self.tts_model_factory: Any = None       # callable(record) → tts_model — overrides other knobs
        self.instances: list[_FakeTtsInstance] = []
        # Counter for torch.cuda.empty_cache() invocations — exposed so the
        # /unload tests can assert the cached-allocator drain actually fires.
        self.empty_cache_calls: int = 0


@pytest.fixture
def load_stubs(monkeypatch) -> _LoadFixture:
    """Install fake TTS.api.TTS + torch in sys.modules so
    CoquiEngine._ensure_loaded's lazy imports resolve to controllable
    stubs. Tests configure the returned handle to drive deepspeed init
    outcome, speaker-manager shape, and cuda availability."""
    record = _CallRecord()
    fixture = _LoadFixture(record)

    def _build_tts_model() -> Any:
        if fixture.tts_model_factory is not None:
            return fixture.tts_model_factory(record)
        return _FakeTtsModel(
            record,
            init_raises=fixture.init_raises,
            speaker_manager=fixture.speaker_manager,
        )

    def _fake_tts_class(model_id: str, *args: Any, **kwargs: Any) -> _FakeTtsInstance:
        record.record("TTS.__init__", model_id=model_id)
        inst = _FakeTtsInstance(record, tts_model=_build_tts_model(), model_id=model_id)
        fixture.instances.append(inst)
        return inst

    fake_tts_api = types.ModuleType("TTS.api")
    fake_tts_api.TTS = _fake_tts_class
    fake_tts = types.ModuleType("TTS")
    fake_tts.api = fake_tts_api

    class _FakeCuda:
        @staticmethod
        def is_available() -> bool:
            return fixture.cuda_available

        @staticmethod
        def empty_cache() -> None:
            fixture.empty_cache_calls += 1

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = _FakeCuda
    fake_torch.float16 = "FAKE_FLOAT16"

    monkeypatch.setitem(sys.modules, "TTS", fake_tts)
    monkeypatch.setitem(sys.modules, "TTS.api", fake_tts_api)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    return fixture


# ── DeepSpeed wiring ──────────────────────────────────────────────────

def test_deepspeed_init_called_before_to_device_when_enabled(monkeypatch, load_stubs):
    """COQUI_DEEPSPEED=1 + CUDA → init_gpt_for_inference(kv_cache=True,
    use_deepspeed=True) runs BEFORE tts.to(device). Order matters:
    DeepSpeed rebuilds the GPT module against its runtime, and main.py
    documents that moving to GPU afterwards transfers the rebuilt module.
    If the order flipped, the speedup would silently regress."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.setenv("COQUI_DEEPSPEED", "1")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    load_stubs.cuda_available = True

    engine = main.CoquiEngine()
    engine._ensure_loaded("xtts_v2")

    assert load_stubs.record.names() == ["TTS.__init__", "init_gpt_for_inference", "to"]
    init_call = next(c for c in load_stubs.record.calls if c[0] == "init_gpt_for_inference")
    assert init_call[1] == {"kv_cache": True, "use_deepspeed": True}
    to_call = next(c for c in load_stubs.record.calls if c[0] == "to")
    assert to_call[1] == {"device": "cuda"}
    assert engine._tts is not None


def test_deepspeed_disabled_by_env_skips_init_call(monkeypatch, load_stubs):
    """COQUI_DEEPSPEED=0 + CUDA → init_gpt_for_inference must NOT run.
    Users disable DeepSpeed when the install misbehaves on their box;
    if the env override were silently ignored, the load would crash."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.setenv("COQUI_DEEPSPEED", "0")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    load_stubs.cuda_available = True

    engine = main.CoquiEngine()
    engine._ensure_loaded("xtts_v2")

    assert load_stubs.record.names() == ["TTS.__init__", "to"]
    assert engine._tts is not None


def test_deepspeed_init_failure_swallowed_load_continues(monkeypatch, load_stubs, caplog):
    """If init_gpt_for_inference raises (deepspeed not installed, API drift),
    main.py catches it, logs a warning, and continues to tts.to(device).
    Load completes; subsequent synth runs in cuda+fp16 sans DeepSpeed.
    Without this resilience, `pip install`ing the sidecar without
    DeepSpeed would crash the process on first load."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.setenv("COQUI_DEEPSPEED", "1")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    load_stubs.cuda_available = True
    load_stubs.init_raises = True

    engine = main.CoquiEngine()
    with caplog.at_level(logging.WARNING, logger="sidecar"):
        engine._ensure_loaded("xtts_v2")

    # init_gpt_for_inference was attempted (and raised); to(device) ran after.
    assert load_stubs.record.names() == ["TTS.__init__", "init_gpt_for_inference", "to"]
    assert engine._tts is not None
    assert engine._resolved_device == "cuda"
    # fp16 stays on — autocast is independent of DeepSpeed.
    assert engine._use_half is True
    assert any("DeepSpeed enable failed" in r.getMessage() for r in caplog.records)


# ── fp16 autocast wrap (synth path) ───────────────────────────────────

class _AutocastCtx:
    def __init__(self, events: list, kwargs: dict) -> None:
        self._events = events
        self._kwargs = kwargs

    def __enter__(self) -> "_AutocastCtx":
        self._events.append(("autocast.enter", self._kwargs))
        return self

    def __exit__(self, *_: Any) -> bool:
        self._events.append(("autocast.exit", {}))
        return False


def _make_synth_tts(events: list, *, output_sample_rate: int = 24000,
                    audio: list[float] | None = None) -> _FakeTtsInstance:
    """tts stub for synth-path tests. .tts() records the call and returns
    a small float list so _float_audio_to_int16_le runs on real input."""
    sample = audio if audio is not None else [0.0, 0.5, -0.5]
    record = _CallRecord()
    inst = _FakeTtsInstance(record, output_sample_rate=output_sample_rate)

    def _tts_call(*, text: str, speaker: str, language: str) -> list[float]:
        events.append(("tts.call", {"text": text, "speaker": speaker, "language": language}))
        return list(sample)

    inst.tts = _tts_call
    return inst


def _make_synth_torch(events: list) -> types.ModuleType:
    """torch stub for synth-path tests. Only .autocast() and .float16 are
    read by main.py:276-282."""
    mod = types.ModuleType("torch")
    mod.float16 = "FAKE_FLOAT16"

    def autocast(**kwargs: Any) -> _AutocastCtx:
        return _AutocastCtx(events, kwargs)

    mod.autocast = autocast
    return mod


def test_synthesize_wraps_tts_call_in_autocast_when_use_half():
    """_use_half=True + cuda → synthesize() wraps tts.tts() in
    torch.autocast(device_type='cuda', dtype=torch.float16). The autocast
    context is the entire reason fp16 is enabled — without it, the weights
    stay fp32 and the headline GPU speedup vanishes silently."""
    engine = main.CoquiEngine()
    events: list = []
    engine._tts = _make_synth_tts(events)
    engine._torch = _make_synth_torch(events)
    engine._use_half = True
    engine._resolved_device = "cuda"
    engine._speakers = []

    result = engine.synthesize("xtts_v2", "Narrator", "hello")

    assert result.sample_rate == 24000
    assert [e[0] for e in events] == ["autocast.enter", "tts.call", "autocast.exit"]
    assert events[0][1] == {"device_type": "cuda", "dtype": "FAKE_FLOAT16"}


def test_synthesize_skips_autocast_when_use_half_false():
    """_use_half=False (CPU, or fp16 explicitly disabled on CUDA) →
    autocast must NOT be entered. Otherwise CPU runs would hit the
    fp16-on-CPU crash that the resolver tests already protect against."""
    engine = main.CoquiEngine()
    events: list = []
    engine._tts = _make_synth_tts(events)
    engine._torch = _make_synth_torch(events)
    engine._use_half = False
    engine._resolved_device = "cpu"
    engine._speakers = []

    result = engine.synthesize("xtts_v2", "Narrator", "hello")

    assert result.sample_rate == 24000
    assert [e[0] for e in events] == ["tts.call"]


# ── PCM byte conversion ───────────────────────────────────────────────

def _decode_pcm(pcm: bytes) -> list[int]:
    return list(np.frombuffer(pcm, dtype="<i2"))


def test_float_audio_to_int16_le_clips_above_one():
    """Inputs outside [-1.0, 1.0] must be clipped before the int16 cast.
    Without clipping the conversion would wrap (1.5*32767 = 49150 → int16
    overflow), producing audible clicks at chapter peaks when a voice
    runs hot."""
    audio = [0.0, 0.5, 1.5, -2.0, 1.0, -1.0]
    pcm = main._float_audio_to_int16_le(audio)
    assert _decode_pcm(pcm) == [0, 16383, 32767, -32767, 32767, -32767]


def test_float_audio_to_int16_le_downmixes_stereo_to_mono():
    """XTTS speaks mono today, but other engines (Piper, Kokoro) and future
    XTTS versions can return stereo. The downmix is .mean(axis=-1), so
    [[0.4, 0.6], [-0.4, -0.6]] collapses to [0.5, -0.5]."""
    audio = np.array([[0.4, 0.6], [-0.4, -0.6]], dtype=np.float32)
    pcm = main._float_audio_to_int16_le(audio)
    # 0.5 * 32767 = 16383.5 → int16 truncates toward zero → 16383.
    assert _decode_pcm(pcm) == [16383, -16383]


def test_float_audio_to_int16_le_accepts_python_list():
    """Coqui's tts() can return either np.ndarray or list[float]. The
    converter must handle the list path without forcing the caller to
    wrap in np.asarray (which would defeat the point of the helper)."""
    pcm = main._float_audio_to_int16_le([0.1, -0.1])
    assert len(pcm) == 4
    # 0.1 * 32767 = 3276.7 → truncate → 3276.
    assert _decode_pcm(pcm) == [3276, -3276]


# ── Idempotency and speaker manifest fallbacks ────────────────────────

def test_ensure_loaded_idempotent(monkeypatch, load_stubs):
    """Calling _ensure_loaded twice must NOT reload the model. main.py:140
    early-returns when self._tts is set; otherwise every /synthesize call
    would re-run the 30-60s model load that PRELOAD_COQUI=0 is trying
    to avoid in tests."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.setenv("COQUI_DEEPSPEED", "1")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    load_stubs.cuda_available = True

    engine = main.CoquiEngine()
    engine._ensure_loaded("xtts_v2")
    engine._ensure_loaded("xtts_v2")

    init_calls = [c for c in load_stubs.record.calls if c[0] == "TTS.__init__"]
    assert len(init_calls) == 1


def test_speaker_manifest_falls_back_to_speaker_names(monkeypatch, load_stubs):
    """When the speaker manager exposes `speaker_names` but no `name_to_id`
    (older coqui-tts releases), main.py's second getattr must populate
    self._speakers. Otherwise version drift silently empties the manifest
    and every requested voice falls through to substitution."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.setenv("COQUI_DEEPSPEED", "0")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    load_stubs.cuda_available = True
    load_stubs.speaker_manager = _FakeSpeakerManager(
        speaker_names=["Ana Florence", "Asya Anara", "Claribel Dervla"],
    )

    engine = main.CoquiEngine()
    engine._ensure_loaded("xtts_v2")

    assert engine._speakers == ["Ana Florence", "Asya Anara", "Claribel Dervla"]


def test_unload_clears_state_and_empties_cuda_cache(monkeypatch, load_stubs):
    """After unload(), _tts/_torch/_speakers must be reset and the CUDA
    cached-allocator drained via torch.cuda.empty_cache(). The empty_cache
    call is the load-bearing bit: Python GC drops the model tensors when
    _tts is nilled, but the cached-allocator blocks stay reserved until
    empty_cache() releases them — and the whole point of the auto-evict
    flow is for other processes (Ollama) to see freed VRAM immediately."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.setenv("COQUI_DEEPSPEED", "0")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    load_stubs.cuda_available = True
    load_stubs.speaker_manager = _FakeSpeakerManager(
        name_to_id={"Claribel Dervla": 0, "Ana Florence": 1},
    )

    engine = main.CoquiEngine()
    engine._ensure_loaded("xtts_v2")
    assert engine._tts is not None
    assert engine._speakers != []
    assert load_stubs.empty_cache_calls == 0

    engine.unload()

    assert engine._tts is None
    assert engine._torch is None
    assert engine._speakers == []
    assert engine._resolved_device == "cpu"
    assert engine._use_half is False
    assert load_stubs.empty_cache_calls == 1


def test_unload_idempotent_when_idle(monkeypatch):
    """unload() with no model loaded must be a safe no-op — the auto-evict
    flow on the Analysing screen fires /unload on TTS whether or not the
    sidecar happened to be warm, so this path runs on every analyzer-Load
    click. If it raised or touched a None _torch, the analyzer button
    would surface an error toast even though nothing is wrong."""
    engine = main.CoquiEngine()
    assert engine._tts is None  # fresh engine starts unloaded
    engine.unload()              # must not raise
    assert engine._tts is None


def test_load_unload_load_roundtrip(monkeypatch, load_stubs):
    """Full lifecycle: load → unload → load. The second load must rebuild
    state via _ensure_loaded (NOT short-circuit on stale flags). Without
    this, clicking Stop then Load again in the UI would leave _loading=True
    or _speakers=[] forever, breaking voice substitution."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.setenv("COQUI_DEEPSPEED", "0")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    load_stubs.cuda_available = True
    load_stubs.speaker_manager = _FakeSpeakerManager(name_to_id={"Claribel Dervla": 0})

    engine = main.CoquiEngine()
    engine._ensure_loaded("xtts_v2")
    assert engine._tts is not None

    engine.unload()
    assert engine._tts is None
    assert engine._speakers == []

    engine._ensure_loaded("xtts_v2")
    assert engine._tts is not None
    assert engine._speakers == ["Claribel Dervla"]
    init_calls = [c for c in load_stubs.record.calls if c[0] == "TTS.__init__"]
    assert len(init_calls) == 2, "second _ensure_loaded must re-run TTS.__init__"


def test_speaker_manifest_error_falls_back_to_empty_list(monkeypatch, load_stubs, caplog):
    """If speaker_manager access raises (API drift broke the path), the
    enumeration block must swallow and set _speakers=[]. _ensure_loaded
    must not propagate the error — otherwise startup fails on releases
    that don't ship the expected speaker-manager surface."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.setenv("COQUI_DEEPSPEED", "0")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    load_stubs.cuda_available = True
    load_stubs.tts_model_factory = lambda rec: _RaisingTtsModel(rec)

    engine = main.CoquiEngine()
    with caplog.at_level(logging.WARNING, logger="sidecar"):
        engine._ensure_loaded("xtts_v2")

    assert engine._speakers == []
    assert engine._tts is not None
    assert any("Could not enumerate Coqui speakers" in r.getMessage() for r in caplog.records)
