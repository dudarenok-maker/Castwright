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


class _FakeTokenizerStub:
    """Stand-in for model.speech_tokenizer used by _icl_instruct_synth (Task 2).
    decode() returns a flat-zero 24 kHz clip — same shape as the real decode."""

    def decode(self, codes: Any) -> tuple[list[Any], int]:  # type: ignore[return]
        return [np.zeros(6000, dtype=np.float32)], 24000


class _FakeInnerModule:
    """Stand-in for the real nn.Module at Qwen3TTSModel.model. The WRAPPER is
    not an nn.Module and has no `.to()`; only this inner object does. Faithful
    to the real qwen_tts API so a regression back to `wrapper.to()` fails here
    the same way it does on the real weights (AttributeError on the wrapper)."""

    def __init__(self) -> None:
        self.device: Any = None
        self.config = types.SimpleNamespace(_attn_implementation="sdpa")
        # Task 2 (fs-55): tokenizer stub so _icl_instruct_synth can call
        # m.speech_tokenizer.decode without real weights.
        self.speech_tokenizer = _FakeTokenizerStub()
        self.last_generate: dict[str, Any] = {}

    def to(self, device: Any) -> "_FakeInnerModule":
        self.device = device
        return self

    def generate(self, **kwargs: Any) -> tuple[list[Any], None]:
        """Fake raw-generate used by _icl_instruct_synth (Task 2).
        Returns a single-element code list + None (no loss)."""
        self.last_generate = kwargs
        return ([np.array([1, 2, 3])], None)


class _FakeQwenModel:
    """Stand-in for qwen_tts.Qwen3TTSModel — a thin WRAPPER (NOT an nn.Module).
    The real nn.Module lives at `.model`; the wrapper caches its device at
    `.device` and has NO `.to()`. Audio is a flat-zero float32 buffer at 24 kHz
    — enough to exercise the int16 conversion + the (wavs, sr) return shape."""

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.model = _FakeInnerModule()  # the real nn.Module the loader moves
        self.device: Any = None  # resynced by the loader after the move
        self.design_calls: list[tuple[str, str, str]] = []
        self.clone_calls: list[tuple[Any, Any]] = []
        self.prompt_calls: list[tuple[Any, str]] = []

    @classmethod
    def from_pretrained(cls, model_id: str, **_kwargs: Any) -> "_FakeQwenModel":
        return cls(model_id)

    # NB: deliberately NO `.to()` — the real wrapper has none. The loader must
    # move `self.model` (the inner module) and resync `self.device`.

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

    # ── Task 2 (fs-55): wrapper internals used by _icl_instruct_synth ────
    # The real qwen_tts 0.1.1 wrapper has these as private helpers; the sidecar
    # calls them directly because the public API never wires ICL+instruct together.

    def _build_assistant_text(self, t: str) -> str:
        return f"A:{t}"

    def _build_ref_text(self, t: str) -> str:
        return f"R:{t}"

    def _build_instruct_text(self, t: str) -> str:
        return f"I:{t}"

    def _tokenize_texts(self, texts: list[str]) -> list[tuple[str, str]]:
        return [("ids", s) for s in texts]

    def _merge_generate_kwargs(self, **kw: Any) -> dict[str, Any]:
        return {}

    def _prompt_items_to_voice_clone_prompt(self, items: Any) -> dict[str, Any]:
        return {"ref_code": [getattr(it, "ref_code", None) for it in items]}


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
    fake_torch.device = lambda d: d  # type: ignore[attr-defined]  # loader resyncs model.device
    fake_cuda = types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
    fake_torch.cuda = fake_cuda  # type: ignore[attr-defined]
    # Task 2 (fs-55): _icl_instruct_synth wraps the generate call in no_grad.
    import contextlib
    fake_torch.no_grad = contextlib.nullcontext  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)
    monkeypatch.setattr(engine, "_voices_dir", str(tmp_path / "qwen"))
    # Reset any resident model state from a prior test. The engine is a global
    # singleton, so the in-memory prompt cache must be cleared too — a stale
    # entry from another test would mask a cache miss here.
    engine._base = None
    engine._base17 = None
    engine._design = None
    engine._loading = False
    engine._prompt_cache.clear()
    yield {"dir": tmp_path / "qwen", "engine": engine}
    engine._base = None
    engine._base17 = None
    engine._design = None
    engine._prompt_cache.clear()


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

    engine.design_voice("maerin", "a bright, confident teenage girl", "English", None)
    assert "maerin" in client.get("/speakers").json()["qwen"]


# ── design -> clone -> cache -> reuse contract ───────────────────────────

def test_design_voice_caches_embedding_and_manifest(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    voices_dir = fake_qwen_runtime["dir"]
    result = engine.design_voice("hart", "a witty teenage boy, mid-paced", "English", None)

    # Cached embedding + manifest written, keyed by voiceId.
    assert (voices_dir / "hart.pt").is_file()
    assert (voices_dir / "hart.json").is_file()
    import json

    manifest = json.loads((voices_dir / "hart.json").read_text(encoding="utf-8"))
    assert manifest["voiceId"] == "hart"
    assert manifest["instruct"] == "a witty teenage boy, mid-paced"
    assert manifest["language"] == "English"
    # Audition preview is real PCM bytes.
    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert result.sample_rate == 24000


def test_design_voice_references_short_text_but_auditions_supplied_line(fake_qwen_runtime) -> None:
    """The heavy 1.7B reference clip (+ its clone prompt) speaks the SHORT
    CALIBRATION_TEXT — never the caller's evidence quote — so a long quote
    can't push the reference generation past the server's design timeout (the
    >120s stall this fix addresses). The AUDITION preview still speaks the
    caller's supplied line, so it doubles as the character's 12s sample: the
    server pre-caches it under the sample key, which is keyed on that exact
    text, so changing the reference text must NOT change the audition text."""
    engine = fake_qwen_runtime["engine"]
    voices_dir = fake_qwen_runtime["dir"]
    line = "We have to tell the Council before the others wake."
    assert engine.CALIBRATION_TEXT not in line  # guard the test's own premise
    engine.design_voice("maerin", "a poised teenage girl", "English", line)

    # Reference clip + clone prompt run on the SHORT pangram (cheap on the 1.7B).
    assert engine._design.design_calls[-1][0] == engine.CALIBRATION_TEXT
    assert engine._base.prompt_calls[-1][1] == engine.CALIBRATION_TEXT
    # Audition speaks the caller's full line — the cached-sample contract.
    assert engine._base.clone_calls[-1][0] == [line]

    import json

    manifest = json.loads((voices_dir / "maerin.json").read_text(encoding="utf-8"))
    # refText records the ACTUAL reference text (the pangram now), not the quote.
    assert manifest["refText"] == engine.CALIBRATION_TEXT


def test_design_voice_falls_back_to_calibration_pangram_when_unset(fake_qwen_runtime) -> None:
    """No calibrationText → the audition speaks the built-in CALIBRATION_TEXT."""
    engine = fake_qwen_runtime["engine"]
    engine.design_voice("hart", "a witty teenage boy", "English", None)
    assert engine._design.design_calls[-1][0] == engine.CALIBRATION_TEXT
    assert engine._base.clone_calls[-1][0] == [engine.CALIBRATION_TEXT]


def test_design_voice_writes_voice_uuid_to_manifest(fake_qwen_runtime) -> None:
    """voiceUuid supplied → persisted in the descriptor (srv-43, inert field)."""
    import json

    engine = fake_qwen_runtime["engine"]
    voices_dir = fake_qwen_runtime["dir"]
    test_uuid = "550e8400-e29b-41d4-a716-446655440000"
    engine.design_voice("lorian", "a calm, measured older man", "English", None, test_uuid)

    manifest = json.loads((voices_dir / "lorian.json").read_text(encoding="utf-8"))
    assert manifest["voiceUuid"] == test_uuid


def test_design_voice_writes_null_voice_uuid_when_absent(fake_qwen_runtime) -> None:
    """voiceUuid omitted (None) → descriptor contains null (srv-43, inert field)."""
    import json

    engine = fake_qwen_runtime["engine"]
    voices_dir = fake_qwen_runtime["dir"]
    engine.design_voice("lorian2", "a calm, measured older man", "English", None)

    manifest = json.loads((voices_dir / "lorian2.json").read_text(encoding="utf-8"))
    assert "voiceUuid" in manifest
    assert manifest["voiceUuid"] is None


# ── design-model race / idle-watchdog (2026-06-02 regression) ────────────

def test_design_voice_survives_design_model_freed_in_the_gap(
    fake_qwen_runtime, monkeypatch
) -> None:
    """The idle watchdog (or a concurrent /synthesize's unload_design) can null
    `_design` in the unguarded window between `_ensure_design_loaded()` and the
    `_synth_lock` forward. design_voice used to crash there with
    "'NoneType' object has no attribute 'generate_voice_design'". The fix
    re-ensures the model UNDER the lock, so the design completes regardless of a
    free landing in the gap.

    We simulate the free deterministically (no threads): wrap `_ensure_base_loaded`
    — which runs in that gap — to null `_design` on its FIRST call only (the
    pre-lock ensure), leaving the re-ensure inside the lock to reload it."""
    engine = fake_qwen_runtime["engine"]
    orig_ensure_base = engine._ensure_base_loaded
    fired = {"n": 0}

    def racing_ensure_base() -> None:
        orig_ensure_base()
        if fired["n"] == 0:  # only the pre-lock ensure, not the in-lock re-ensure
            fired["n"] += 1
            engine._design = None  # a watchdog free lands in the gap

    monkeypatch.setattr(engine, "_ensure_base_loaded", racing_ensure_base)

    # Must NOT raise AttributeError: 'NoneType' … generate_voice_design.
    result = engine.design_voice("hart", "a witty teenage boy", "English", None)

    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert result.sample_rate == 24000
    assert fired["n"] == 1  # the model really was nulled in the gap …
    assert engine._design is not None  # … and re-ensured under the lock


def test_watchdog_does_not_free_design_while_in_flight(fake_qwen_runtime) -> None:
    """`maybe_free_idle_design` must refuse to free the VoiceDesign model while a
    design is in flight (`_design_in_flight` > 0), even past the idle TTL — the
    plan-161 race where a long compare-modal dwell crosses the TTL mid-design.
    Once nothing is in flight, an idle model is freed as before."""
    engine = fake_qwen_runtime["engine"]
    engine._ensure_design_loaded()
    assert engine._design is not None
    engine._design_last_used = 0.0  # ancient → past any ttl

    engine._design_in_flight = 1
    assert engine.maybe_free_idle_design(0.0) is False
    assert engine._design is not None  # NOT freed while a design is in flight

    engine._design_in_flight = 0
    assert engine.maybe_free_idle_design(0.0) is True
    assert engine._design is None  # freed once idle AND not in flight


def test_synthesize_reuses_cached_voice(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    engine.design_voice("maerin", "a bright, confident teenage girl", "English", None)
    res = engine.synthesize("qwen3-tts-0.6b", "maerin", "Hello there, this is a test.")
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


# ── in-memory prompt cache + attn implementation (plan 112) ──────────────

def _count_torch_loads(monkeypatch) -> dict[str, int]:
    """Wrap the fixture's fake torch.load so a test can assert how many disk
    reads happened. Returns a mutable counter dict."""
    import torch as _t  # the stubbed module from fake_qwen_runtime

    calls = {"load": 0}
    orig = _t.load

    def counting(path, **kwargs):
        calls["load"] += 1
        return orig(path, **kwargs)

    monkeypatch.setattr(_t, "load", counting)
    return calls


def test_synthesize_caches_prompt_across_calls(fake_qwen_runtime, monkeypatch) -> None:
    """The designed voice's .pt is read from disk on the first synth only;
    subsequent synths of the same voice hit the in-memory cache. Without the
    cache this was a torch.load per sentence (hundreds per book)."""
    engine = fake_qwen_runtime["engine"]
    engine.design_voice("maerin", "a bright, confident teenage girl", "English", None)
    calls = _count_torch_loads(monkeypatch)

    engine.synthesize("qwen3-tts-0.6b", "maerin", "First sentence.")
    engine.synthesize("qwen3-tts-0.6b", "maerin", "Second sentence.")
    engine.synthesize("qwen3-tts-0.6b", "maerin", "Third sentence.")

    assert calls["load"] == 1  # one miss, two hits
    assert "maerin" in engine._prompt_cache


def test_redesign_evicts_cached_prompt(fake_qwen_runtime, monkeypatch) -> None:
    """Re-designing a voiceId must drop its cached embedding so the next
    synth reloads the freshly-written .pt — never serves the stale one."""
    engine = fake_qwen_runtime["engine"]
    engine.design_voice("hart", "a witty teenage boy", "English", None)
    engine.synthesize("qwen3-tts-0.6b", "hart", "One.")
    assert "hart" in engine._prompt_cache  # warmed by the miss

    engine.design_voice("hart", "now a gruff old sailor", "English", None)
    assert "hart" not in engine._prompt_cache  # evicted on re-design

    calls = _count_torch_loads(monkeypatch)
    engine.synthesize("qwen3-tts-0.6b", "hart", "Two.")
    assert calls["load"] == 1  # reloaded from disk, not served stale


def test_unload_clears_prompt_cache(fake_qwen_runtime) -> None:
    """unload() drops cached prompt tensors too — they hold GPU memory that
    would otherwise survive empty_cache()."""
    engine = fake_qwen_runtime["engine"]
    engine.design_voice("wren", "a curious teenage girl", "English", None)
    engine.synthesize("qwen3-tts-0.6b", "wren", "Hi.")
    assert engine._prompt_cache
    engine.unload()
    assert engine._prompt_cache == {}


# ── transient VoiceDesign lifecycle: keep warm, free on idle / leave ─────
# Regression for the 2026-05-27 CUDA OOM: the heavy VoiceDesign 1.7B model was
# loaded on the first design and never freed (unload_design was dead code), so
# it sat resident alongside the Base model and exhausted the 8 GB GPU during a
# cast-review session. It now stays warm across rapid designs but frees on idle
# or when real synthesis begins.

def test_idle_watchdog_frees_only_design_model(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    engine.design_voice("wren", "a curious teenage girl", "English", None)
    assert engine._design is not None  # warm immediately after designing
    assert engine._base is not None

    # Still within the idle window → keep it warm (no per-design reload churn).
    assert engine.maybe_free_idle_design(600.0) is False
    assert engine._design is not None

    # Simulate the TTL elapsing since the last design.
    engine._design_last_used -= 1000.0
    assert engine.maybe_free_idle_design(120.0) is True
    assert engine._design is None    # transient design model freed …
    assert engine._base is not None  # … resident synth model kept


def test_idle_watchdog_noop_when_no_design_resident(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    assert engine._design is None
    assert engine.maybe_free_idle_design(0.0) is False  # nothing to free


def test_synthesize_frees_resident_design_model(fake_qwen_runtime) -> None:
    """A real synth = leaving design mode → the heavy VoiceDesign model is
    freed so it can't squeeze generation VRAM, while Base stays and audio still
    returns."""
    engine = fake_qwen_runtime["engine"]
    engine.design_voice("wren", "a curious teenage girl", "English", None)
    assert engine._design is not None

    res = engine.synthesize("qwen3-tts-0.6b", "wren", "Hello there.")
    assert engine._design is None      # freed on the first real synth
    assert engine._base is not None
    assert isinstance(res.pcm, bytes) and len(res.pcm) > 0


def test_consecutive_designs_reuse_warm_model(fake_qwen_runtime, monkeypatch) -> None:
    """Back-to-back designs within the idle window reuse the warm VoiceDesign
    model — loaded exactly once, not reloaded per design (the user's explicit
    'stop reloading' requirement)."""
    engine = fake_qwen_runtime["engine"]
    design_loads = {"n": 0}
    real_load = engine._load_qwen_model

    def counting_load(model_id):
        if model_id == engine.VOICEDESIGN_MODEL:
            design_loads["n"] += 1
        return real_load(model_id)

    monkeypatch.setattr(engine, "_load_qwen_model", counting_load)

    engine.design_voice("wren", "a curious teenage girl", "English", None)
    engine.design_voice("garrow", "a gravelly older man", "English", None)
    engine.design_voice("hart", "a bright teenage boy", "English", None)

    assert design_loads["n"] == 1      # one load, reused across all three
    assert engine._design is not None  # still warm (no synth, within TTL)


def _patch_from_pretrained(fake_qwen_runtime, monkeypatch) -> dict[str, Any]:
    """Replace the fake Qwen3TTSModel.from_pretrained with a recorder so a
    test can inspect the kwargs the loader passed. Returns the capture dict."""
    import qwen_tts  # the stubbed module from fake_qwen_runtime

    captured: dict[str, Any] = {}

    def recorder(model_id, **kwargs):
        captured["model_id"] = model_id
        captured["kwargs"] = kwargs
        return _FakeQwenModel(model_id)

    monkeypatch.setattr(qwen_tts.Qwen3TTSModel, "from_pretrained", recorder)
    return captured


def test_load_passes_sdpa_attn_by_default(fake_qwen_runtime, monkeypatch) -> None:
    """The loader requests attn_implementation=sdpa (PyTorch-native, the right
    default for the autoregressive decode loop) when QWEN_ATTN_IMPL is unset."""
    engine = fake_qwen_runtime["engine"]
    monkeypatch.delenv("QWEN_ATTN_IMPL", raising=False)
    captured = _patch_from_pretrained(fake_qwen_runtime, monkeypatch)

    engine._load_qwen_model(engine.BASE_MODEL)
    assert captured["kwargs"].get("attn_implementation") == "sdpa"
    # The loader must NOT pass device_map: device_map routes through accelerate's
    # dispatch_model, which leaves params on the meta device on this composite
    # model and then 500s moving them ("Cannot copy out of meta tensor"). We
    # force real tensors (low_cpu_mem_usage=False) then move the inner module.
    assert "device_map" not in captured["kwargs"]
    assert captured["kwargs"].get("low_cpu_mem_usage") is False


def test_load_honours_qwen_attn_impl_env(fake_qwen_runtime, monkeypatch) -> None:
    """QWEN_ATTN_IMPL overrides the default — e.g. 'eager' to bench the slow
    baseline, or 'flash_attention_2' when a flash-attn wheel is installed."""
    engine = fake_qwen_runtime["engine"]
    monkeypatch.setenv("QWEN_ATTN_IMPL", "eager")
    captured = _patch_from_pretrained(fake_qwen_runtime, monkeypatch)

    engine._load_qwen_model(engine.BASE_MODEL)
    assert captured["kwargs"].get("attn_implementation") == "eager"


def test_load_falls_back_when_attn_kwarg_rejected(fake_qwen_runtime, monkeypatch) -> None:
    """A transformers/qwen_tts build that rejects attn_implementation must not
    harden into a load failure — retry without the kwarg and carry on."""
    engine = fake_qwen_runtime["engine"]
    import qwen_tts

    calls: list[dict[str, Any]] = []

    def picky(model_id, **kwargs):
        calls.append(kwargs)
        if "attn_implementation" in kwargs:
            raise ValueError("unexpected keyword argument 'attn_implementation'")
        return _FakeQwenModel(model_id)

    monkeypatch.setattr(qwen_tts.Qwen3TTSModel, "from_pretrained", picky)

    model = engine._load_qwen_model(engine.BASE_MODEL)
    assert model is not None
    assert len(calls) == 2  # first attempt + retry
    assert "attn_implementation" in calls[0]
    assert "attn_implementation" not in calls[1]
    # Neither attempt may use device_map (the meta-tensor 500 path) — the retry
    # only drops the attention knob, it keeps the real-tensor load shape.
    assert "device_map" not in calls[0]
    assert "device_map" not in calls[1]
    assert calls[1].get("low_cpu_mem_usage") is False


def test_load_moves_inner_model_and_resyncs_device(fake_qwen_runtime, monkeypatch) -> None:
    """Regression (the meta-tensor /load crash): Qwen3TTSModel is a WRAPPER with
    no `.to()`, and passing device_map 500s with a meta-tensor
    NotImplementedError on this transformers/accelerate stack. So the loader
    must (a) never pass device_map and force low_cpu_mem_usage=False for real
    tensors, and (b) move the inner nn.Module (`model.model`) and resync
    `model.device` — NOT call `wrapper.to()` (which AttributeErrors on the real
    weights, and on _FakeQwenModel which deliberately omits `.to()`)."""
    engine = fake_qwen_runtime["engine"]
    captured = _patch_from_pretrained(fake_qwen_runtime, monkeypatch)

    model = engine._load_qwen_model(engine.BASE_MODEL)

    # No device_map ever; real-tensor load forced.
    assert "device_map" not in captured["kwargs"]
    assert captured["kwargs"].get("low_cpu_mem_usage") is False
    # The inner module was moved to the engine device; the wrapper's cached
    # device was resynced to match (so generate-time inputs land on the GPU).
    assert model.model.device == engine._device
    assert model.device == engine._device


# ── QWEN_VOICES_DIR relocation + legacy migration (sidecar-qwen-voice-dir) ──

def test_voices_dir_resolves_from_env(monkeypatch, tmp_path) -> None:
    """QWEN_VOICES_DIR overrides the __file__-relative default. Pins that a
    fresh QwenEngine reads the env (the Node server points it at the
    per-workspace tree so restarts can't orphan designed voices)."""
    target = tmp_path / "ws" / "voices" / "qwen"
    monkeypatch.setenv("QWEN_VOICES_DIR", str(target))
    engine = main.QwenEngine()
    assert engine._voices_dir == str(target)


def test_voice_paths_ascii_id_is_byte_identical(monkeypatch, tmp_path) -> None:
    """Back-compat (plan 219): an already-ASCII voice_id maps to the exact same
    filename as before the non-Latin fix — no hash suffix, so every voice
    designed pre-219 is still found on disk."""
    monkeypatch.setenv("QWEN_VOICES_DIR", str(tmp_path))
    engine = main.QwenEngine()
    vid = "v_master-oduvan-qwen3-tts-0.6b-ab12cd"
    pt, js = engine._voice_paths(vid)
    assert os.path.basename(pt) == f"{vid}.pt"
    assert os.path.basename(js) == f"{vid}.json"


def test_voice_paths_non_latin_ids_do_not_collide(monkeypatch, tmp_path) -> None:
    """Plan 219: two distinct Cyrillic ids both flatten to underscores under the
    ASCII sanitiser, so the pre-219 code mapped them to the SAME .pt and one
    overwrote the other. A stable hash suffix of the original id makes the
    mapping injective again."""
    import re as _re

    monkeypatch.setenv("QWEN_VOICES_DIR", str(tmp_path))
    engine = main.QwenEngine()
    a, _ja = engine._voice_paths("анна")
    b, _jb = engine._voice_paths("мария")
    assert a != b  # was: both ".../____.pt"
    assert engine._voice_paths("анна")[0] == a  # deterministic across calls
    assert _re.search(r"-[0-9a-f]{8}\.pt$", os.path.basename(a))


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
    fake_torch.device = lambda d: d  # type: ignore[attr-defined]
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: False, empty_cache=lambda: None
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    voices_dir = tmp_path / "ws" / "voices" / "qwen"
    monkeypatch.setenv("QWEN_VOICES_DIR", str(voices_dir))

    # First boot: design + cache a voice.
    engine = main.QwenEngine()
    assert engine._voices_dir == str(voices_dir)
    engine.design_voice("marlow", "a charming, mischievous teenage boy", "English", None)
    assert (voices_dir / "marlow.pt").is_file()

    # Simulate a restart: a fresh engine (resident model gone) reading the
    # same env-pointed dir. Synthesis must find the cached embedding.
    restarted = main.QwenEngine()
    assert restarted._base is None
    res = restarted.synthesize("qwen3-tts-0.6b", "marlow", "Hi there.")
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
        json={"voiceId": "wren", "instruct": "a curious, earnest teenage girl"},
    )
    assert resp.status_code == 200
    assert resp.headers["X-Sample-Rate"] == "24000"
    assert len(resp.content) > 0


def test_design_voice_route_requires_voiceid_and_instruct(fake_qwen_runtime) -> None:
    client = TestClient(main.app)
    assert client.post("/qwen/design-voice", json={"instruct": "x"}).status_code == 400
    assert client.post("/qwen/design-voice", json={"voiceId": "x"}).status_code == 400


def test_design_voice_route_500_detail_never_empty(fake_qwen_runtime, monkeypatch) -> None:
    """A design failure must still surface a non-empty detail even when the
    exception has no message (some torch/CUDA errors raise empty). The body is
    a GENERIC constant ("Internal error.") — the exception text is logged
    server-side only (CodeQL py/stack-trace-exposure) — so the UI always has a
    non-blank reason and no server detail ever leaks."""
    engine = fake_qwen_runtime["engine"]

    class _Empty(Exception):
        def __str__(self) -> str:  # mimics a no-message exception
            return ""

    def boom(*_args, **_kwargs):
        raise _Empty()

    monkeypatch.setattr(engine, "design_voice", boom)
    client = TestClient(main.app)
    resp = client.post("/qwen/design-voice", json={"voiceId": "x", "instruct": "y"})
    assert resp.status_code == 500
    assert resp.json()["detail"], "500 detail must never be empty"


def test_synthesize_route_routes_qwen(fake_qwen_runtime) -> None:
    client = TestClient(main.app)
    client.post(
        "/qwen/design-voice",
        json={"voiceId": "brann", "instruct": "a calm, kind teenage boy"},
    )
    resp = client.post(
        "/synthesize",
        json={"engine": "qwen", "model": "qwen3-tts-0.6b", "voice": "brann", "text": "Hi."},
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


# ── 1.7B-Base loader (fs-55) ──────────────────────────────────────────────

def test_ensure_base17_loaded_uses_base17_model(fake_qwen_runtime) -> None:
    """_ensure_base17_loaded() populates _base17 with the 1.7B-Base model,
    leaving _base (0.6B) untouched."""
    engine = fake_qwen_runtime["engine"]
    assert engine._base17 is None
    engine._ensure_base17_loaded()
    assert engine._base17 is not None
    assert engine._base is None  # did not load the 0.6B-Base


def test_ensure_base17_loaded_is_idempotent(fake_qwen_runtime) -> None:
    """A second call to _ensure_base17_loaded() is a no-op (single-flight)."""
    engine = fake_qwen_runtime["engine"]
    load_calls: list[str] = []
    real_load = engine._load_qwen_model

    def tracking_load(model_id: str) -> Any:
        load_calls.append(model_id)
        return real_load(model_id)

    engine._load_qwen_model = tracking_load
    engine._ensure_base17_loaded()
    engine._ensure_base17_loaded()  # second call — must not reload
    assert load_calls.count(engine.BASE17_MODEL) == 1


def test_unload_base17_clears_base17(fake_qwen_runtime) -> None:
    """unload_base17() sets _base17 to None without touching _base."""
    engine = fake_qwen_runtime["engine"]
    engine._ensure_base_loaded()
    engine._ensure_base17_loaded()
    assert engine._base is not None
    assert engine._base17 is not None
    engine.unload_base17()
    assert engine._base17 is None
    assert engine._base is not None  # 0.6B-Base still resident


def test_health_exposes_qwen_base17_loaded_field() -> None:
    """/health carries qwen_base17_loaded (False on a cold engine)."""
    client = TestClient(main.app)
    body = client.get("/health").json()
    assert "qwen_base17_loaded" in body
    assert body["qwen_base17_loaded"] is False


# weights-gated loader test — only runs when the real qwen_tts + CUDA are present
from conftest import _qwen_weights_present

@pytest.mark.skipif(not _qwen_weights_present(), reason="weights absent")
def test_ensure_base17_loads_a_base_checkpoint() -> None:
    """On a GPU box with weights: loads the real 1.7B-Base model,
    confirms _base17 is populated, then unloads cleanly."""
    eng = main.ENGINES["qwen"]
    assert isinstance(eng, main.QwenEngine)
    eng._ensure_base17_loaded()
    assert eng._base17 is not None
    assert getattr(eng._base17.model, "tts_model_type", None) == "base"
    eng.unload_base17()
    assert eng._base17 is None


# ── Task 2 (fs-55): raw-generate ICL+instruct synth helper ───────────────

def test_icl_instruct_synth_passes_instruct_and_clone(fake_qwen_runtime) -> None:
    """_icl_instruct_synth() calls model.generate() with instruct_ids,
    voice_clone_prompt, and ref_ids all populated, and returns a (wav, sr)
    pair with the sidecar's native 24 kHz sample rate.

    The test item carries ref_code=None so the ICL trim branch (torch.cat) is
    skipped — that path requires real tensor ops and is covered by Task 0's
    on-box instruct_smoke.py runner. Without ref_code the trim is a no-op and
    the full generate+decode path still exercises every other branch."""
    engine = fake_qwen_runtime["engine"]
    # Provision a fresh fake 1.7B-Base wrapper (same class as the 0.6B fake).
    engine._base17 = _FakeQwenModel("1.7b")

    # A minimal prompt item: ref_code=None skips the decode-trim, ref_text
    # supplies the text tokenised into ref_ids.
    item = types.SimpleNamespace(ref_code=None, ref_text="calib")

    wav, sr = engine._icl_instruct_synth([item], "Hello.", "Delivered angrily.", "English")

    kw = engine._base17.model.last_generate
    assert "instruct_ids" in kw and kw["instruct_ids"] is not None
    assert "voice_clone_prompt" in kw
    assert "ref_ids" in kw
    assert sr == 24000
    assert isinstance(wav, np.ndarray)


# ── Task 3 (fs-55): cosine_distance pure-math helper ─────────────────────

def test_cosine_distance_pure() -> None:
    """cosine_distance is a pure numpy function — no weights, no model.
    Identical vectors → 0.0 (self-distance); orthogonal vectors → 1.0."""
    from main import cosine_distance

    v = np.array([1.0, 0.0], np.float32)
    assert cosine_distance(v, v) == pytest.approx(0.0, abs=1e-6)
    assert cosine_distance(v, np.array([0.0, 1.0], np.float32)) == pytest.approx(
        1.0, abs=1e-6
    )


# ── Task 2 (fs-55): qwen-tts version-pin guard ────────────────────────────

def test_qwen_tts_pinned_for_raw_bypass() -> None:
    """The raw model.generate() bypass depends on qwen_tts 0.1.x internal
    method signatures (_build_assistant_text, _prompt_items_to_voice_clone_prompt,
    etc.) that a major bump could break silently. Pin to 0.1.x and fail loudly
    so a future upgrade is a conscious decision with re-verification (fs-55)."""
    from importlib.metadata import version

    assert version("qwen-tts").startswith("0.1."), (
        "re-verify raw generate() branches before bumping qwen-tts past 0.1.x (fs-55)"
    )


# ── Task 4 (fs-55): anchored emotion-variant minting ─────────────────────

def test_mint_variant_anchors_to_base_and_marks_json(fake_qwen_runtime, monkeypatch) -> None:
    """mint_variant() chains: load-1.7B → decode ref_code → ICL re-derive →
    instruct-synth → unload-1.7B → 0.6B distil → write .pt + .json.

    The call-sequence assertion (`instruct_synth` BEFORE `unload17`) is the
    core invariant: the 1.7B work must complete before the model is freed.
    The JSON manifest must carry `anchoredTo`, `mintMethod`, and `voiceUuid`
    so the Node side can distinguish anchored variants from independent designs.
    """
    eng = fake_qwen_runtime["engine"]
    vdir = fake_qwen_runtime["dir"]
    # base voice exists on disk (design it via the fake path)
    eng.design_voice("v1", "A warm narrator.", "English", None, None)
    calls: list[str] = []
    monkeypatch.setattr(eng, "_ensure_base17_loaded", lambda: calls.append("load17"))
    monkeypatch.setattr(eng, "unload_base17", lambda: calls.append("unload17"))
    monkeypatch.setattr(
        eng,
        "_icl_instruct_synth",
        lambda items, text, instr, lang: (
            calls.append("instruct_synth"),
            (np.zeros(6000, "float32"), 24000),
        )[1],
    )
    # CRITICAL: the shared fake's create_voice_clone_prompt returns a DICT (no
    # .ref_code), so stub _load_voice_prompt to hand back a ref_code-bearing
    # item (ref_code=None skips the fake decode-trim cleanly). Without this,
    # mint_variant's `base_item.ref_code` AttributeErrors.
    import types as _types
    monkeypatch.setattr(
        eng,
        "_load_voice_prompt",
        lambda v: ([_types.SimpleNamespace(ref_code=None, ref_text="calib")], "English", False),
    )
    # base17 wrapper needed for decode + ICL re-derive (has speech_tokenizer via Task 2's fake)
    eng._base17 = type(eng._base)("1.7b")
    eng.mint_variant("v1", "v1__angry", "Delivered angrily.", "English", None, "uuid-1")
    assert calls.index("instruct_synth") < calls.index("unload17")  # 1.7B work before unload
    import json as _json
    meta = _json.load(open(os.path.join(vdir, "v1__angry.json"), encoding="utf-8"))
    assert meta["anchoredTo"] == "v1" and meta["mintMethod"] == "anchored-icl-instruct"
    assert meta["voiceUuid"] == "uuid-1"


def test_mint_variant_raises_when_base_absent(fake_qwen_runtime) -> None:
    """mint_variant() raises VoiceNotDesignedError when the base .pt is absent."""
    eng = fake_qwen_runtime["engine"]
    with pytest.raises(main.VoiceNotDesignedError):
        eng.mint_variant("nope", "nope__sad", "Delivered sadly.", "English", None, None)


# weights-gated identity regression (calibration owed on the GPU box)
from conftest import _qwen_weights_present

@pytest.mark.skipif(not _qwen_weights_present(), reason="weights absent")
def test_minted_variant_holds_base_identity() -> None:
    """On a GPU box with weights: base and variant share speaker identity
    (cosine distance < 0.30 — threshold calibrated in Task 4 Step 6)."""
    eng = main.ENGINES["qwen"]
    assert isinstance(eng, main.QwenEngine)
    eng.design_voice("rv1", "A warm mid-30s British female narrator.", "English", None, None)
    eng.mint_variant("rv1", "rv1__angry", "Delivered angrily, with raised intensity and edge.", "English", None, None)
    base, lang, _ = eng._load_voice_prompt("rv1")
    var, _, _ = eng._load_voice_prompt("rv1__angry")
    bw, bsr = eng._base.generate_voice_clone(text=["Stop right there."], language=[lang], voice_clone_prompt=base)
    vw, vsr = eng._base.generate_voice_clone(text=["Stop right there."], language=[lang], voice_clone_prompt=var)
    assert eng.speaker_distance(bw[0], bsr, vw[0], vsr) < 0.30  # threshold calibrated in Step 6


# ── Task 5 (fs-55): POST /qwen/mint-variant HTTP surface ─────────────────

def _fake_mint_variant(fake_qwen_runtime, monkeypatch):
    """Patch QwenEngine.mint_variant on the global engine so the route tests
    never touch the real model path. Returns the engine."""
    engine = fake_qwen_runtime["engine"]
    import types as _types

    def _stub_mint(base_voice_id, variant_voice_id, emotion_instruct, language, calibration_text, voice_uuid=None):
        from main import SynthResult
        return SynthResult(pcm=b"\x00" * 48000, sample_rate=24000)

    monkeypatch.setattr(engine, "mint_variant", _stub_mint)
    return engine


def test_mint_variant_route_returns_preview_pcm(fake_qwen_runtime, monkeypatch) -> None:
    """Happy-path: valid body → 200 with PCM content + X-Sample-Rate header."""
    engine = fake_qwen_runtime["engine"]
    # Design the base voice so the route can find it (or bypass via stub).
    engine.design_voice("v1", "A warm narrator.", "English", None)
    _fake_mint_variant(fake_qwen_runtime, monkeypatch)

    client = TestClient(main.app)
    resp = client.post(
        "/qwen/mint-variant",
        json={
            "baseVoiceId": "v1",
            "variantVoiceId": "v1__angry",
            "emotionInstruct": "Delivered angrily, with raised intensity.",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["X-Sample-Rate"] == "24000"
    assert len(resp.content) > 0


def test_mint_variant_route_400_missing_base_voice_id(fake_qwen_runtime, monkeypatch) -> None:
    """Missing baseVoiceId → 400."""
    _fake_mint_variant(fake_qwen_runtime, monkeypatch)
    client = TestClient(main.app)
    resp = client.post(
        "/qwen/mint-variant",
        json={"variantVoiceId": "v1__angry", "emotionInstruct": "angrily"},
    )
    assert resp.status_code == 400


def test_mint_variant_route_400_missing_variant_voice_id(fake_qwen_runtime, monkeypatch) -> None:
    """Missing variantVoiceId → 400."""
    _fake_mint_variant(fake_qwen_runtime, monkeypatch)
    client = TestClient(main.app)
    resp = client.post(
        "/qwen/mint-variant",
        json={"baseVoiceId": "v1", "emotionInstruct": "angrily"},
    )
    assert resp.status_code == 400


def test_mint_variant_route_400_missing_emotion_instruct(fake_qwen_runtime, monkeypatch) -> None:
    """Missing emotionInstruct → 400."""
    _fake_mint_variant(fake_qwen_runtime, monkeypatch)
    client = TestClient(main.app)
    resp = client.post(
        "/qwen/mint-variant",
        json={"baseVoiceId": "v1", "variantVoiceId": "v1__angry"},
    )
    assert resp.status_code == 400


def test_mint_variant_route_409_base_absent(fake_qwen_runtime) -> None:
    """VoiceNotDesignedError from mint_variant → 409 (base voice not designed)."""
    client = TestClient(main.app)
    # No base voice designed → real mint_variant raises VoiceNotDesignedError.
    resp = client.post(
        "/qwen/mint-variant",
        json={
            "baseVoiceId": "no-such-base",
            "variantVoiceId": "no-such-base__sad",
            "emotionInstruct": "Delivered sadly.",
        },
    )
    assert resp.status_code == 409
