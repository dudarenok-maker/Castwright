"""C2 gate (fs-57): characterise the empty/neutral per-item instruct form.

This module answers ONE concrete question consumed by Task 6's batching design:

    Does _icl_instruct_synth() accept instruct="" (an empty per-item instruct
    producing only the chat-template wrapper tokens), or does it need a fixed
    neutral placeholder string to produce natural, non-degenerate narration?

Measurement spec
----------------
Both forms are driven through the real 1.7B-Base on the dev box (CUDA present +
qwen_tts installed).  "Valid" means: non-empty float32 PCM returned with a
positive sample rate and at least 0.1 s of audio.  The test is intentionally
minimal — it does NOT assert on audio *quality* (that requires human listening),
only that the generate() call completes without error and returns plausible
waveform data.

Finding (measured on the dev box, 2026-06-24)
---------------------------------------------
Both instruct="" and instruct=NEUTRAL_INSTRUCT produce valid, non-empty PCM.
The empty-string form is adopted as the canonical no-op because:
  1. It produces the minimal token sequence (just the chat-template tags,
     no content tokens) — the closest structural analogue to instruct_ids=None
     inside the batched generate() path.
  2. A fixed-wording placeholder drifts if the model is retrained; the empty
     template is model-agnostic.
  3. The smoke test (tests/golden/instruct_smoke.py) already confirmed that
     instruct_ids=[None] (no instruct at all) produces natural narration on
     the 1.7B-Base.  _build_instruct_text("") yields the equivalent token
     structure (same wrapper, no content) and behaves identically in practice.

NEUTRAL_INSTRUCT (exported constant)
-------------------------------------
The empty string "" is pinned as the canonical neutral/no-op value.  Task 6
and Task 8 import this constant from main so the entire instruct path uses the
same sentinel — never a bare "".

Weight gate
-----------
The real-model tests are marked @requires_qwen_gpu and SKIP cleanly when
qwen_tts or CUDA is unavailable (CI, dev boxes without weights).  The stub
tests below them run on every box.
"""
from __future__ import annotations

import os
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

# ---------------------------------------------------------------------------
# Weight gate — mirrors conftest._qwen_weights_present()
# ---------------------------------------------------------------------------

def _qwen_gpu_available() -> bool:
    """True when qwen_tts + torch + CUDA are all present."""
    try:
        import qwen_tts  # noqa: F401
        import torch  # noqa: F401
        return torch.cuda.is_available()
    except Exception:
        return False


requires_qwen_gpu = pytest.mark.skipif(
    not _qwen_gpu_available(),
    reason="Qwen weights / CUDA not available on this box (C2 measurement skipped)",
)

# ---------------------------------------------------------------------------
# Stub-based unit tests (always run — no GPU needed)
# ---------------------------------------------------------------------------

class _FakeTokenizerStub:
    def decode(self, codes: Any) -> tuple[list[Any], int]:  # type: ignore[return]
        return [np.zeros(6000, dtype=np.float32)], 24000


class _FakeInnerModule:
    def __init__(self) -> None:
        self.speech_tokenizer = _FakeTokenizerStub()
        self.last_generate: dict[str, Any] = {}

    def generate(self, **kwargs: Any) -> tuple[list[Any], None]:
        self.last_generate = dict(kwargs)
        return ([np.array([1, 2, 3])], None)


class _FakeWrapper:
    """Minimal stand-in for the real qwen_tts 0.1.x wrapper used by _icl_instruct_synth."""

    def __init__(self) -> None:
        self.model = _FakeInnerModule()

    def _build_assistant_text(self, t: str) -> str:
        return f"A:{t}"

    def _build_ref_text(self, t: str) -> str:
        return f"R:{t}"

    def _build_instruct_text(self, t: str) -> str:
        # Mirror the real implementation: `<|im_start|>user\n{t}<|im_end|>\n`
        return f"<|im_start|>user\n{t}<|im_end|>\n"

    def _tokenize_texts(self, texts: list[str]) -> list[tuple[str, str]]:
        return [("ids", s) for s in texts]

    def _merge_generate_kwargs(self, **_kw: Any) -> dict[str, Any]:
        return {}

    def _prompt_items_to_voice_clone_prompt(self, items: Any) -> dict[str, Any]:
        return {"ref_code": [getattr(it, "ref_code", None) for it in items]}


def _make_stub_engine() -> main.QwenEngine:
    """Return the global QwenEngine singleton with a fake 1.7B-Base wrapper wired in.
    Cleans up after itself (via the yielded context) so it doesn't pollute the
    global state for subsequent tests."""
    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)
    return engine


@pytest.fixture
def stub_engine(monkeypatch):
    """QwenEngine with a fake _base17 so _icl_instruct_synth runs without weights."""
    import contextlib
    engine = _make_stub_engine()
    fake_wrapper = _FakeWrapper()

    # Inject fake torch.no_grad into the engine's imports.
    fake_torch = types.ModuleType("torch")
    fake_torch.no_grad = contextlib.nullcontext  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    # Store original state.
    orig_base17 = engine._base17
    engine._base17 = fake_wrapper
    yield engine
    engine._base17 = orig_base17


def test_stub_empty_instruct_passes_non_none_instruct_ids(stub_engine) -> None:
    """_icl_instruct_synth with instruct="" always passes a non-None tensor to
    model.generate() — it is NOT the same as instruct_ids=None (which would skip
    the embedding entirely).  The empty-template tensor is a valid minimal input."""
    item = types.SimpleNamespace(ref_code=None, ref_text="calibration text")
    wav, sr = stub_engine._icl_instruct_synth([item], "A neutral line.", "", "English")

    gen_kw = stub_engine._base17.model.last_generate
    # instruct_ids must be present and non-None (the caller built it from "").
    assert "instruct_ids" in gen_kw
    assert gen_kw["instruct_ids"] is not None
    # The tokenised instruct content is the empty-template string.
    instruct_ids = gen_kw["instruct_ids"]
    assert len(instruct_ids) == 1
    _id, content = instruct_ids[0]
    assert "<|im_start|>user\n<|im_end|>\n" in content  # empty template
    # Output is valid PCM.
    assert sr == 24000
    assert isinstance(wav, np.ndarray) and len(wav) > 0


def test_stub_neutral_instruct_constant_flows_to_non_none_instruct_ids(stub_engine) -> None:
    """NEUTRAL_INSTRUCT (the exported constant Task 6/8 will import) flows through
    _build_instruct_text/_tokenize_texts and arrives at model.generate() as a
    non-None instruct_ids value — confirming the export-usage contract.

    Because NEUTRAL_INSTRUCT == "" this exercises the same empty-template path as
    the preceding test; the distinct assertion here is that the *constant itself*
    (not a bare literal) is accepted by the call chain without error and produces
    a valid, non-None instruct_ids entry."""
    item = types.SimpleNamespace(ref_code=None, ref_text="calibration text")
    placeholder = main.NEUTRAL_INSTRUCT  # the pinned constant under test
    wav, sr = stub_engine._icl_instruct_synth([item], "A neutral line.", placeholder, "English")

    gen_kw = stub_engine._base17.model.last_generate
    assert "instruct_ids" in gen_kw
    instruct_ids = gen_kw["instruct_ids"]
    assert instruct_ids is not None, "NEUTRAL_INSTRUCT must produce a non-None instruct_ids"
    assert len(instruct_ids) == 1
    _id, content = instruct_ids[0]
    # Content should be the empty-template (because NEUTRAL_INSTRUCT == "").
    assert "<|im_start|>user\n<|im_end|>\n" in content
    assert sr == 24000
    assert isinstance(wav, np.ndarray) and len(wav) > 0


def test_neutral_instruct_constant_is_exported() -> None:
    """NEUTRAL_INSTRUCT is importable from main and is the empty string."""
    assert hasattr(main, "NEUTRAL_INSTRUCT")
    assert main.NEUTRAL_INSTRUCT == ""


# ---------------------------------------------------------------------------
# fs-57 Task 7: raw-generate drift guard (weight-free signature introspection)
# ---------------------------------------------------------------------------

def test_drift_guard_passes_when_generate_has_var_keyword(stub_engine) -> None:
    """The drift guard passes silently when the inner model's generate() has a
    catch-all **kwargs (VAR_KEYWORD) — accepting any keyword argument including
    instruct_ids and voice_clone_prompt.  This is the _FakeInnerModule shape."""
    # _FakeInnerModule.generate(**kwargs) has VAR_KEYWORD → guard passes.
    item = types.SimpleNamespace(ref_code=None, ref_text="text")
    # Must not raise.
    stub_engine._icl_instruct_synth_batch(
        [[item]], ["Hello."], ["Whispering."], ["English"]
    )


def test_drift_guard_passes_when_generate_has_explicit_params(stub_engine) -> None:
    """The drift guard passes silently when generate() declares BOTH params by
    name (the real qwen_tts model pattern, e.g. qwen_tts 0.1.1).

    We only assert that no DRIFT RuntimeError is raised; the call may raise for
    unrelated fake-output reasons after the guard (the decode step isn't wired)
    — that's fine, drift detection is the only contract under test here."""

    class _ConformantExplicit:
        speech_tokenizer = _FakeTokenizerStub()

        def generate(self, *, input_ids=None, ref_ids=None, instruct_ids=None,
                     voice_clone_prompt=None, languages=None, non_streaming_mode=False):
            # Minimal output shape so the ICL-trim branch doesn't explode.
            return ([None], None)

    stub_engine._base17.model = _ConformantExplicit()
    item = types.SimpleNamespace(ref_code=None, ref_text="text")
    try:
        stub_engine._icl_instruct_synth_batch(
            [[item]], ["Hello."], ["Whispering."], ["English"]
        )
    except Exception as exc:
        # Fail only for drift-guard errors; other errors (e.g. TypeError from
        # the **gk temperature kwarg hitting explicit params, or fake-decode
        # issues) are outside the scope of this test.
        if "signature drift" in str(exc):
            raise


def test_drift_guard_raises_when_instruct_ids_missing(stub_engine) -> None:
    """Drift guard raises RuntimeError naming the missing parameter when
    `instruct_ids` is dropped from generate()'s signature — simulating a
    future qwen_tts upgrade that renames/removes it.

    The drifted fake uses explicit keyword params WITHOUT a catch-all **kwargs
    so inspect.signature sees exactly the declared parameters (no VAR_KEYWORD
    escape hatch)."""

    class _MissingInstructIds:
        """generate() without instruct_ids and no **kwargs — the drifted form."""
        speech_tokenizer = _FakeTokenizerStub()

        def generate(self, *, input_ids=None, ref_ids=None, voice_clone_prompt=None,
                     languages=None, non_streaming_mode=False):
            return ([types.SimpleNamespace()], None)

    stub_engine._base17.model = _MissingInstructIds()
    with pytest.raises(RuntimeError, match="instruct_ids"):
        item = types.SimpleNamespace(ref_code=None, ref_text="text")
        stub_engine._icl_instruct_synth_batch(
            [[item]], ["Hello."], ["Whispering."], ["English"]
        )


def test_drift_guard_raises_when_voice_clone_prompt_missing(stub_engine) -> None:
    """Drift guard raises RuntimeError naming the missing parameter when
    `voice_clone_prompt` is dropped from generate()'s signature."""

    class _MissingVcp:
        """generate() without voice_clone_prompt and no **kwargs — drifted form."""
        speech_tokenizer = _FakeTokenizerStub()

        def generate(self, *, input_ids=None, ref_ids=None, instruct_ids=None,
                     languages=None, non_streaming_mode=False):
            return ([types.SimpleNamespace()], None)

    stub_engine._base17.model = _MissingVcp()
    with pytest.raises(RuntimeError, match="voice_clone_prompt"):
        item = types.SimpleNamespace(ref_code=None, ref_text="text")
        stub_engine._icl_instruct_synth_batch(
            [[item]], ["Hello."], ["Whispering."], ["English"]
        )


def test_drift_guard_raises_when_both_params_missing(stub_engine) -> None:
    """Drift guard raises RuntimeError listing BOTH missing parameters when
    generate() has neither `instruct_ids` nor `voice_clone_prompt`."""

    class _BothMissing:
        speech_tokenizer = _FakeTokenizerStub()

        def generate(self, *, input_ids=None, languages=None):
            return ([types.SimpleNamespace()], None)

    stub_engine._base17.model = _BothMissing()
    with pytest.raises(RuntimeError) as exc_info:
        item = types.SimpleNamespace(ref_code=None, ref_text="text")
        stub_engine._icl_instruct_synth_batch(
            [[item]], ["Hello."], ["Whispering."], ["English"]
        )
    msg = str(exc_info.value)
    assert "instruct_ids" in msg
    assert "voice_clone_prompt" in msg


# ---------------------------------------------------------------------------
# fs-57: liveInstruct gain path unit tests (weight-free)
# ---------------------------------------------------------------------------

def test_live_instruct_gain_defaults() -> None:
    """_live_instruct_gain returns the expected values for known emotions."""
    assert main._live_instruct_gain("whisper") == pytest.approx(0.35)
    assert main._live_instruct_gain("angry") == pytest.approx(1.7)
    assert main._live_instruct_gain("sad") == pytest.approx(0.6)
    assert main._live_instruct_gain("excited") == pytest.approx(1.15)
    # Unknown/absent emotion → unity gain.
    assert main._live_instruct_gain("neutral") == pytest.approx(1.0)
    assert main._live_instruct_gain(None) == pytest.approx(1.0)
    assert main._live_instruct_gain("") == pytest.approx(1.0)


def test_live_instruct_gain_case_insensitive() -> None:
    """_live_instruct_gain is case-insensitive."""
    assert main._live_instruct_gain("WHISPER") == pytest.approx(0.35)
    assert main._live_instruct_gain("Angry") == pytest.approx(1.7)


def test_live_instruct_gain_env_override(monkeypatch) -> None:
    """QWEN_LIVE_GAIN_<EMOTION> env var overrides the default gain."""
    monkeypatch.setenv("QWEN_LIVE_GAIN_WHISPER", "0.25")
    assert main._live_instruct_gain("whisper") == pytest.approx(0.25)
    # Bogus value falls back to the default, never raises.
    monkeypatch.setenv("QWEN_LIVE_GAIN_ANGRY", "not-a-float")
    assert main._live_instruct_gain("angry") == pytest.approx(1.7)


def test_gain_for_item_live_instruct_path() -> None:
    """_gain_for_item uses _live_instruct_gain (emotion key) on the liveInstruct path."""
    assert main._gain_for_item({"emotion": "whisper", "voice": "base-voice"}, True) == pytest.approx(0.35)
    assert main._gain_for_item({"emotion": "angry", "voice": "base-voice"}, True) == pytest.approx(1.7)
    assert main._gain_for_item({"emotion": "sad", "voice": "base-voice"}, True) == pytest.approx(0.6)
    # neutral / absent emotion → unity (the base-voice name is IGNORED on liveInstruct).
    assert main._gain_for_item({"voice": "base-voice"}, True) == pytest.approx(1.0)
    assert main._gain_for_item({"emotion": "neutral", "voice": "base-voice"}, True) == pytest.approx(1.0)


def test_gain_for_item_variant_path_unchanged() -> None:
    """_gain_for_item uses the voice __<emotion> suffix on the anchored-variant path
    (live_instruct=False) — the original _emotion_output_gain behaviour is unchanged."""
    assert main._gain_for_item({"voice": "qwen-x__whisper"}, False) == pytest.approx(0.45)
    assert main._gain_for_item({"voice": "qwen-x__angry"}, False) == pytest.approx(1.5)
    # Base voice (no suffix) → unity.
    assert main._gain_for_item({"voice": "base-voice"}, False) == pytest.approx(1.0)
    # emotion key is IGNORED on the variant path — only the voice name matters.
    assert main._gain_for_item({"voice": "base-voice", "emotion": "angry"}, False) == pytest.approx(1.0)


def _amp_ratios(pcms: list[bytes]) -> list[float]:
    """Mean absolute int16 amplitude of each PCM buffer, normalised to [0, 1]."""
    INT16_MAX = 32767
    return [
        float(np.abs(np.frombuffer(p, dtype="<i2").astype(np.float32) / INT16_MAX).mean())
        for p in pcms
    ]


def test_synthesize_batch_live_instruct_gain_drives_real_method(monkeypatch) -> None:
    """Integration seam (#1100): drive the REAL QwenEngine.synthesize_batch on the
    1.7B live-instruct path with ONLY the inner model forward mocked, and assert the
    per-emotion gain lands on the returned PCM.

    Unlike the prior version (which reimplemented the gain loop in the test), this
    exercises the real call site — `_gain_for_item(items[i], live_instruct)` +
    `_float_audio_to_int16_le` inside `synthesize_batch`. So a call-site regression
    (e.g. reverting to `_apply_emotion_gain` keyed on the voice name, or dropping the
    `live_instruct` flag) is now caught here, not silently passed.
    """
    import contextlib

    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)

    AMPLITUDE = 0.5  # high enough that whisper×0.35 stays well above the int16 floor
    SR = 24000
    fake_wav = np.full(6000, AMPLITUDE, dtype=np.float32)

    # Neutralise every model/VRAM touchpoint so no GPU/weights are needed; the
    # gain application below is the REAL code under test.
    monkeypatch.setattr(engine, "_design", None, raising=False)
    monkeypatch.setattr(engine, "_base17_activity", lambda: contextlib.nullcontext())
    monkeypatch.setattr(engine, "_ensure_base17_loaded", lambda: None)
    monkeypatch.setattr(engine, "_load_voice_prompt_17b", lambda voice: (object(), "English", True))
    # The inner batched forward returns one fake wav per text and NO gain — the
    # real synthesize_batch must add the per-emotion gain on top.
    monkeypatch.setattr(
        engine,
        "_icl_instruct_synth_batch",
        lambda prompt_lists, texts, instructs, langs: ([fake_wav.copy() for _ in texts], SR),
    )

    items = [
        {"voice": "base-voice", "text": "Whispering softly.", "emotion": "whisper"},
        {"voice": "base-voice", "text": "Shouting angrily.", "emotion": "angry"},
        {"voice": "base-voice", "text": "Feeling sad.", "emotion": "sad"},
        {"voice": "base-voice", "text": "Neutral line.", "emotion": "neutral"},
    ]
    result = engine.synthesize_batch("1.7b", items, live_instruct=True)

    assert result.sample_rate == SR
    assert len(result.pcms) == 4
    for ratio, emo in zip(_amp_ratios(result.pcms), ["whisper", "angry", "sad", "neutral"]):
        expected = min(AMPLITUDE * main._live_instruct_gain(emo), 1.0)
        assert abs(ratio - expected) < 1e-2, (
            f"emotion={emo!r}: expected amplitude ~{expected:.4f}, got {ratio:.4f} "
            "— the live-instruct gain call site may have regressed."
        )


def test_synthesize_batch_variant_path_gain_drives_real_method(monkeypatch) -> None:
    """Integration seam (#1100): drive the REAL synthesize_batch on the anchored-variant
    path (live_instruct=False) with only the wrapper forward mocked, asserting the gain
    is keyed on the voice's `__<emotion>` suffix — NOT the per-item emotion key. Guards
    the variant path against the same class of call-site regression.
    """
    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)

    AMPLITUDE = 0.5
    SR = 24000
    fake_wav = np.full(6000, AMPLITUDE, dtype=np.float32)

    class _FakeBase:
        def generate_voice_clone(self, text, language, voice_clone_prompt):
            return ([fake_wav.copy() for _ in text], SR)

    monkeypatch.setattr(engine, "_design", None, raising=False)
    monkeypatch.setattr(engine, "_ensure_base_loaded", lambda: None)
    monkeypatch.setattr(engine, "_load_voice_prompt", lambda voice: (object(), "English", True))
    monkeypatch.setattr(engine, "_base", _FakeBase(), raising=False)

    # `emotion` is set but must be IGNORED on the variant path — only the voice
    # suffix drives gain there.
    items = [
        {"voice": "qwen-x__whisper", "text": "Whispering variant.", "emotion": "angry"},
        {"voice": "qwen-narrator", "text": "Neutral narrator."},
    ]
    result = engine.synthesize_batch("0.6b", items, live_instruct=False)

    assert result.sample_rate == SR
    expected_gains = [0.45, 1.0]  # __whisper suffix, then unity — emotion key ignored
    for ratio, expected_gain in zip(_amp_ratios(result.pcms), expected_gains):
        expected = min(AMPLITUDE * expected_gain, 1.0)
        assert abs(ratio - expected) < 1e-2, (
            f"expected amplitude ~{expected:.4f}, got {ratio:.4f} "
            "— the variant gain call site may have regressed."
        )


# ---------------------------------------------------------------------------
# Real-GPU C2 measurement tests (skipped without CUDA + qwen_tts)
# ---------------------------------------------------------------------------

# The voices dir for the real-model test: the main project's designed voices
# (wt-fs57-spec is a git worktree; its `voices/qwen/` dir is empty, but the
# main project's dir contains `cw_gpu_17b.pt` with a `__1.7b.pt` sibling).
_MAIN_VOICES_DIR = (
    Path(__file__).resolve().parents[4]
    / "Projects"
    / "Audiobook-Generator"
    / "server"
    / "tts-sidecar"
    / "voices"
    / "qwen"
)
# Fallback: same box, user home variation.
_ALT_VOICES_DIR = Path("C:/Claude/Projects/Audiobook-Generator/server/tts-sidecar/voices/qwen")

# Voice that has a __1.7b.pt sibling (produced by the anchored-mint workflow).
_TEST_VOICE = "cw_gpu_17b"


def _voices_dir_with_17b_pt() -> Path | None:
    """Return the first voices dir that holds <_TEST_VOICE>__1.7b.pt."""
    for d in (_MAIN_VOICES_DIR, _ALT_VOICES_DIR):
        if (d / f"{_TEST_VOICE}__1.7b.pt").is_file():
            return d
    return None


requires_17b_pt = pytest.mark.skipif(
    _voices_dir_with_17b_pt() is None,
    reason=f"No {_TEST_VOICE}__1.7b.pt found in expected voices dirs",
)


@requires_qwen_gpu
@requires_17b_pt
def test_real_empty_instruct_produces_valid_pcm() -> None:
    """C2 gate (real model): _icl_instruct_synth with instruct="" returns
    valid, non-empty PCM from the 1.7B-Base.

    This is the primary C2 measurement.  A short synthesis line is used to
    keep the test fast (~5-15s on GPU); the assertion is purely structural
    (non-empty float32 array, plausible sample rate, minimum 0.1s audio).
    """
    voices_dir = _voices_dir_with_17b_pt()
    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)

    # Point the engine at the voices dir that has the __1.7b.pt file.
    orig_voices_dir = engine._voices_dir
    engine._voices_dir = str(voices_dir)
    try:
        # Both the prompt load AND the generate call live inside ONE
        # _base17_activity() context — mirrors synthesize()/synthesize_batch()
        # so the idle watchdog cannot null _base17 between load and use.
        with engine._base17_activity():
            engine._ensure_base17_loaded()
            prompt_items, lang, _hit = engine._load_voice_prompt_17b(_TEST_VOICE)

            if not isinstance(prompt_items, list):
                prompt_items = [prompt_items]

            # Drive with instruct="" (the empty-template form under test).
            wav, sr = engine._icl_instruct_synth(
                prompt_items,
                "The harbor fell silent as the fog rolled in.",
                "",
                lang,
            )
    finally:
        engine._voices_dir = orig_voices_dir

    assert sr > 0, "sample rate must be positive"
    assert isinstance(wav, np.ndarray), "PCM must be a numpy array"
    assert len(wav) > 0, "PCM must be non-empty"
    min_samples = int(sr * 0.1)  # at least 0.1s of audio
    assert len(wav) >= min_samples, (
        f"PCM too short: {len(wav)} samples < {min_samples} (0.1s at {sr} Hz). "
        "Possible degenerate output from empty instruct."
    )


@requires_qwen_gpu
@requires_17b_pt
def test_real_neutral_placeholder_produces_valid_pcm() -> None:
    """C2 gate (real model): _icl_instruct_synth with the neutral placeholder
    also returns valid PCM.  Used to confirm the placeholder form is a safe
    fallback even though the empty-string form is the pinned NEUTRAL_INSTRUCT.
    """
    voices_dir = _voices_dir_with_17b_pt()
    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)

    orig_voices_dir = engine._voices_dir
    engine._voices_dir = str(voices_dir)
    try:
        # Both the prompt load AND the generate call live inside ONE
        # _base17_activity() context — mirrors synthesize()/synthesize_batch()
        # so the idle watchdog cannot null _base17 between load and use.
        with engine._base17_activity():
            engine._ensure_base17_loaded()
            prompt_items, lang, _hit = engine._load_voice_prompt_17b(_TEST_VOICE)

            if not isinstance(prompt_items, list):
                prompt_items = [prompt_items]

            # Neutral placeholder — a concrete delivery direction for the no-instruct case.
            _NEUTRAL_PLACEHOLDER = "Delivered in a calm, natural narration voice."

            wav, sr = engine._icl_instruct_synth(
                prompt_items,
                "She crossed the bridge without looking back.",
                _NEUTRAL_PLACEHOLDER,
                lang,
            )
    finally:
        engine._voices_dir = orig_voices_dir

    assert sr > 0
    assert isinstance(wav, np.ndarray) and len(wav) > 0
    min_samples = int(sr * 0.1)
    assert len(wav) >= min_samples, (
        f"PCM too short: {len(wav)} samples < {min_samples} (0.1s at {sr} Hz)."
    )


@requires_qwen_gpu
@requires_17b_pt
def test_real_batch_live_instruct_heterogeneous_no_cross_bleed() -> None:
    """fs-57 Task 6 (real model): synthesize_batch(model='1.7b',
    live_instruct=True) runs N items with DIFFERENT per-item instructs (one
    neutral, no `instruct`) through ONE batched forward and returns N distinct,
    non-empty PCM buffers.

    This is the on-box proof that the heterogeneous per-item instruct_ids list
    is accepted by the real `model.generate()` in a single forward (the brief's
    hard part) AND that a neutral item (NEUTRAL_INSTRUCT) shares that forward
    without the wrapper. Cross-bleed evidence is structural here (each item gets
    its own non-empty buffer of independent length); audio-quality / emotion
    intensity is a human-listening check outside this gate."""
    voices_dir = _voices_dir_with_17b_pt()
    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)

    orig_voices_dir = engine._voices_dir
    engine._voices_dir = str(voices_dir)
    try:
        items = [
            {
                "voice": _TEST_VOICE,
                "text": "The harbor fell silent as the fog rolled in.",
                "instruct": "Whispering, tense and afraid.",
            },
            {
                "voice": _TEST_VOICE,
                "text": "He laughed and threw open the door.",
                "instruct": "Booming with delighted laughter.",
            },
            # Neutral item — no `instruct` → NEUTRAL_INSTRUCT, same bypass forward.
            {"voice": _TEST_VOICE, "text": "She crossed the bridge without looking back."},
        ]
        res = engine.synthesize_batch("1.7b", items, live_instruct=True)
    finally:
        engine._voices_dir = orig_voices_dir

    assert res.sample_rate > 0
    assert len(res.pcms) == 3, "one PCM buffer per input item, in order"
    for i, pcm in enumerate(res.pcms):
        assert isinstance(pcm, (bytes, bytearray)), f"item {i} PCM must be bytes"
        # int16 LE → at least 0.1 s of audio (2 bytes/sample).
        min_bytes = int(res.sample_rate * 0.1) * 2
        assert len(pcm) >= min_bytes, (
            f"item {i} PCM too short: {len(pcm)} bytes < {min_bytes} "
            f"(0.1s at {res.sample_rate} Hz) — possible degenerate batch output."
        )
    # No cross-bleed proxy: the three differently-worded lines must not all
    # collapse to byte-identical buffers (independent sequences → distinct PCM).
    assert not (res.pcms[0] == res.pcms[1] == res.pcms[2]), (
        "all three batched items produced identical PCM — a demux/cross-bleed bug."
    )
