"""test_batch_synthesis.py — TRUE batching for Qwen (plan 112).

QwenEngine.synthesize_batch runs N sentences in ONE generate_voice_clone
batched forward, and the /synthesize-batch route frames the N PCM chunks as a
single length-prefixed binary body:

    {"sampleRate":24000,"lengths":[l0,l1,…]}\\n<pcm0><pcm1>…

These tests pin the contract that makes batching safe to ship without
re-measuring voice drift:

  - exactly ONE generate_voice_clone call with matching-length LIST args (the
    list-form invariant — independent sequences, never a concatenated string,
    so there's no shared decode context and no mid-chunk voice drift);
  - N items -> N PCM chunks in input order (no reordering);
  - each chunk carries ITS OWN text + voice prompt (no cross-item bleed / demux
    swap);
  - a single sample rate shared by the batch, echoed in X-Sample-Rate;
  - batch-of-1 == single /synthesize byte parity;
  - an undesigned voice fails the WHOLE batch, naming the item index;
  - the binary frame is well-formed and splits on the FIRST newline only, so
    PCM bytes that happen to equal 0x0A are never mis-parsed.

Uses fakes (stubs qwen_tts + torch) — no real model/weights, same approach as
test_qwen3.py.
"""
from __future__ import annotations

import contextlib
import json
import logging
import re
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


@pytest.fixture(autouse=True)
def _poison_safety(monkeypatch):
    """Stub the poison-exit timer so a CUDA-poison test can't os._exit(42) and
    kill the suite, and reset the process poison flag between cases (it's a
    module global that outlives a TestClient and would otherwise fast-fail
    later batch tests with a 503)."""

    class _NoOpTimer:
        def __init__(self, *a: Any, **k: Any) -> None:
            pass

        def start(self) -> None:
            pass

    monkeypatch.setattr(main.threading, "Timer", _NoOpTimer)
    main._reset_poison_for_test()
    yield
    main._reset_poison_for_test()


# ── encode / recover through the real float -> int16 conversion ──────────
#
# main._float_audio_to_int16_le clips to [-1, 1], scales by 32767, truncates to
# int16 LE. (m + 0.5)/32767 therefore round-trips to exactly `m` for any small
# m, which lets us stamp a recoverable marker into a fake wav and read it back
# off the emitted PCM.

def _ref_marker(ref_text: str) -> int:
    """Stable small int identifying a voice's clone prompt (its ref_text)."""
    return sum(ord(c) for c in ref_text) & 0x7FFF


def _wav_for(text: str, voice_marker: int) -> np.ndarray:
    """Float wav encoding, after the int16 conversion:
      sample[0] = ord(text[0]) -> proves the chunk carries THIS text
      sample[1] = voice_marker -> proves the chunk used THIS voice's clone
                                  prompt (the per-voice identity is distilled
                                  from the reference AUDIO — see _BatchFakeQwen;
                                  the ref_text is a fixed pangram for every
                                  voice, so it can't carry identity)
    and whose sample count == max(2, len(text)) so the frame's per-item
    `lengths` independently distinguishes differently-sized items."""
    n = max(2, len(text))
    arr = np.zeros(n, dtype=np.float32)
    arr[0] = ((ord(text[0]) & 0x7FFF) + 0.5) / 32767.0
    arr[1] = ((voice_marker & 0x7FFF) + 0.5) / 32767.0
    return arr


def _read_sample(pcm: bytes, i: int) -> int:
    """Read the i-th int16 LE sample (values are positive < 0x7FFF here)."""
    lo, hi = pcm[2 * i], pcm[2 * i + 1]
    return (hi << 8) | lo


class _FakePromptItem:
    """Mirror qwen_tts.VoiceClonePromptItem. The real library reads `.ref_code`
    (and `.ref_text`) off EACH item in the prompt list — see
    `_prompt_items_to_voice_clone_prompt`: `ref_code=[it.ref_code for it in
    items]`. So if the batch passes a list-of-LISTS, `it` is a list and that
    blows up with "'list' object has no attribute 'ref_code'" — the exact 500
    we shipped. Modelling the item as an object (not a dict) keeps the fake
    faithful to that attribute access, so the existing batch tests now catch a
    regression in the prompt shape.

    `ref_code` carries the per-voice identity marker (the persona, distilled
    through the reference AUDIO in create_voice_clone_prompt). `ref_text` is the
    fixed calibration pangram — the SAME for every voice (see
    main.QwenEngine.CALIBRATION_TEXT) — so identity must NOT ride on it."""

    def __init__(self, voice_marker: int, ref_text: str) -> None:
        self.ref_text = ref_text
        self.ref_code = voice_marker


class _FakeSpeechTokenizer:
    """Decode stand-in for the inner model's speech_tokenizer. The raw 1.7B
    liveInstruct batch path decodes a LIST of `{audio_codes}` dicts in one call
    and expects (list_of_wavs, sample_rate). Each fake `audio_codes` here is a
    1-D numpy array whose first element is the per-item text+voice marker; we
    echo it back as the wav so the batch demux can be asserted."""

    def decode(self, code_dicts: Any) -> tuple[list[Any], int]:
        wavs = []
        for d in code_dicts:
            c = d["audio_codes"]
            wavs.append(np.asarray(c, dtype=np.float32))
        return wavs, 24000


class _BatchFakeInner:
    """Inner nn.Module of the Qwen3TTSModel wrapper — the ONLY object with a
    `.to()`. The wrapper itself has none (the loader moves `model.model` and
    resyncs `model.device`), so the fake must too.

    Also carries a `generate()` + `speech_tokenizer` so the raw 1.7B
    liveInstruct batch bypass (which calls `_base17.model.generate(...)`
    directly, not `generate_voice_clone`) can run on the fake. `generate`
    records its kwargs (so `instruct_ids` can be inspected per item) and returns
    one code tensor per `input_ids` entry, each stamped with that item's
    text+voice marker so the batch demux is verifiable."""

    def __init__(self) -> None:
        self.device: Any = None
        self.config = types.SimpleNamespace(_attn_implementation="sdpa")
        self.speech_tokenizer = _FakeSpeechTokenizer()
        self.generate_calls: list[dict[str, Any]] = []

    def to(self, device: Any) -> "_BatchFakeInner":
        self.device = device
        return self

    def generate(self, **kwargs: Any) -> tuple[list[Any], Any]:
        # The raw batched bypass passes parallel per-item lists. We pair
        # input_ids[i] (carries the text marker) with voice_clone_prompt's
        # ref_code[i] (carries the voice marker) and emit one code array per
        # item stamped with BOTH — so the batch demux proves text i kept voice
        # i (no cross-bleed) AND each item's own instruct_ids[i] is recorded.
        self.generate_calls.append(dict(kwargs))
        input_ids = kwargs["input_ids"]
        vcp = kwargs["voice_clone_prompt"]
        ref_codes = vcp["ref_code"]
        codes = []
        for i, tok in enumerate(input_ids):
            # tok is the (kind, text) tuple stamped by the fake _tokenize_texts;
            # the assistant text embeds the source text's first char.
            text_marker = ord(tok[1][2]) if len(tok[1]) > 2 else 0
            voice_marker = int(ref_codes[i]) if ref_codes[i] is not None else 0
            # Encode the markers the SAME way _wav_for does so they round-trip
            # through main._float_audio_to_int16_le → _read_sample.
            arr = np.zeros(2, dtype=np.float32)
            arr[0] = ((text_marker & 0x7FFF) + 0.5) / 32767.0
            arr[1] = ((voice_marker & 0x7FFF) + 0.5) / 32767.0
            codes.append(arr)
        return codes, None


class _BatchFakeQwen:
    """Stand-in for qwen_tts.Qwen3TTSModel that honours LIST inputs: returns one
    wav per text element, each stamped with its text + prompt so demux swaps and
    cross-item bleed are detectable. Records every generate_voice_clone call so
    the list-form invariant can be asserted. A thin WRAPPER with no `.to()` (the
    real nn.Module lives at `.model`), matching the real API."""

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.model = _BatchFakeInner()  # the inner module the loader moves
        self.device: Any = None  # resynced by the loader after the move
        self.clone_calls: list[dict[str, Any]] = []

    @classmethod
    def from_pretrained(cls, model_id: str, **_kwargs: Any) -> "_BatchFakeQwen":
        return cls(model_id)

    def generate_voice_design(self, text: str, language: str, instruct: str):
        # The reference clip's IDENTITY comes from the persona `instruct`, not
        # the (fixed pangram) `text`. Stamp the persona marker into the audio so
        # create_voice_clone_prompt can distil a per-voice clone prompt from it,
        # exactly as the real model derives the clone embedding from the audio.
        arr = np.zeros(24000, dtype=np.float32)
        arr[0] = float(_ref_marker(instruct))
        return [arr], 24000

    def create_voice_clone_prompt(self, ref_audio: Any, ref_text: str, **_kwargs: Any):
        # The REAL library returns List[VoiceClonePromptItem] (length 1 here) —
        # NOT a bare object. That list shape is exactly what the batch path must
        # flatten. Voice identity is distilled from the reference AUDIO (the
        # per-voice persona marker generate_voice_design stamped into it), since
        # ref_text is a fixed pangram shared by every voice; recovering it here
        # lets the synth output prove which voice's prompt was used per item.
        arr = ref_audio[0] if isinstance(ref_audio, tuple) else ref_audio
        voice_marker = int(round(float(arr[0]))) if len(arr) else 0
        return [_FakePromptItem(voice_marker, ref_text)]

    def generate_voice_clone(self, text: Any, language: Any, voice_clone_prompt: Any):
        texts = text if isinstance(text, list) else [text]
        langs = language if isinstance(language, list) else [language]
        prompt_items = (
            voice_clone_prompt
            if isinstance(voice_clone_prompt, list)
            else [voice_clone_prompt]
        )
        self.clone_calls.append(
            {"text": texts, "language": langs, "prompt": prompt_items}
        )
        # The model contract: in batch mode the list args must match length.
        assert len(texts) == len(prompt_items) == len(langs)
        # Read `.ref_text` off each item exactly as the library reads `.ref_code`
        # — raises AttributeError if an item is itself a list (the list-of-lists
        # bug), so a wrong prompt shape can't pass silently.
        wavs = [_wav_for(t, p.ref_code) for t, p in zip(texts, prompt_items)]
        return wavs, 24000

    # ── helpers used by the raw 1.7B liveInstruct batch bypass ───────────────
    # The bypass calls _base17.model.generate(...) directly (not
    # generate_voice_clone), building per-item input_ids / ref_ids /
    # instruct_ids / voice_clone_prompt via these wrapper helpers — mirroring
    # _icl_instruct_synth lifted to a batch. The fakes preserve enough structure
    # for the engine to assemble the parallel lists; identity markers ride
    # through ref_code (voice) and the assistant text (source text).

    def _build_assistant_text(self, t: str) -> str:
        return f"A:{t}"

    def _build_ref_text(self, t: str) -> str:
        return f"R:{t}"

    def _build_instruct_text(self, t: str) -> str:
        # Mirror the real wrapper: `<|im_start|>user\n{t}<|im_end|>\n`.
        return f"<|im_start|>user\n{t}<|im_end|>\n"

    def _tokenize_texts(self, texts: list[str]) -> list[tuple[str, str]]:
        return [("ids", s) for s in texts]

    def _merge_generate_kwargs(self, **_kw: Any) -> dict[str, Any]:
        return {}

    def _prompt_items_to_voice_clone_prompt(self, items: Any) -> dict[str, Any]:
        return {"ref_code": [getattr(it, "ref_code", None) for it in items]}


@pytest.fixture
def qwen_batch_runtime(monkeypatch, tmp_path):
    """Stub qwen_tts + torch and point the global Qwen engine's voices dir at a
    tmp dir, so design/synth run without the real package or weights."""
    fake_qwen = types.ModuleType("qwen_tts")
    fake_qwen.Qwen3TTSModel = _BatchFakeQwen  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "qwen_tts", fake_qwen)

    fake_torch = types.ModuleType("torch")
    _store: dict[str, Any] = {}

    def _save(obj: Any, path: str) -> None:
        _store[str(path)] = obj
        with open(path, "wb") as fh:
            fh.write(b"\x00")  # presence marker for isfile()

    def _load(path: str, **_kwargs: Any) -> Any:
        return _store.get(str(path), [_FakePromptItem(0, "")])

    fake_torch.save = _save  # type: ignore[attr-defined]
    fake_torch.load = _load  # type: ignore[attr-defined]
    fake_torch.bfloat16 = "bfloat16"  # type: ignore[attr-defined]
    fake_torch.device = lambda d: d  # type: ignore[attr-defined]  # loader resyncs model.device
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: False, empty_cache=lambda: None
    )
    # The raw 1.7B liveInstruct bypass (_icl_instruct_synth_batch) wraps the
    # generate call in `torch.no_grad()`; the unit-test fakes never hit the
    # tensor `torch.cat` trim branch (fake ref_codes are non-tensor markers).
    fake_torch.no_grad = contextlib.nullcontext  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)
    monkeypatch.setattr(engine, "_voices_dir", str(tmp_path / "qwen"))
    engine._base = None
    engine._design = None
    engine._loading = False
    yield {"dir": tmp_path / "qwen", "engine": engine}
    engine._base = None
    engine._design = None


def _design(engine, voice_id: str) -> int:
    """Design a voice from a per-voice persona, so each voice's clone prompt
    carries a distinct identity marker — distilled from the reference AUDIO, NOT
    the ref_text (which is the same calibration pangram for every voice).
    Returns that per-voice marker for the synth-output assertions."""
    persona = f"persona {voice_id}"
    engine.design_voice(voice_id, persona, "English", f"cal-{voice_id}")
    return _ref_marker(persona)


# ── engine-level: list-form invariant + demux correctness ────────────────

def test_synthesize_batch_is_one_call_with_matching_lists(qwen_batch_runtime) -> None:
    engine = qwen_batch_runtime["engine"]
    for v in ("a", "b", "c"):
        _design(engine, v)
    engine._base.clone_calls.clear()  # drop the per-voice audition calls

    items = [
        {"voice": "a", "text": "Apple."},
        {"voice": "b", "text": "Banana!!"},
        {"voice": "c", "text": "Cat"},
    ]
    res = engine.synthesize_batch("0.6b", items)

    # Exactly ONE batched forward — not three separate calls.
    assert len(engine._base.clone_calls) == 1
    call = engine._base.clone_calls[0]
    # All three list args present and equal-length (the list-form invariant —
    # independent sequences, never a concatenated string).
    assert call["text"] == ["Apple.", "Banana!!", "Cat"]
    assert len(call["text"]) == len(call["language"]) == len(call["prompt"]) == 3
    # FLAT prompt-item list (one item per text), NOT a list-of-lists — the shape
    # the library's `[it.ref_code for it in items]` demands.
    assert all(not isinstance(p, list) for p in call["prompt"])
    assert all(hasattr(p, "ref_code") for p in call["prompt"])
    assert res.sample_rate == 24000
    assert len(res.pcms) == 3


def test_synthesize_batch_preserves_order_text_and_voice(qwen_batch_runtime) -> None:
    engine = qwen_batch_runtime["engine"]
    refs = {v: _design(engine, v) for v in ("a", "b", "c")}

    items = [
        {"voice": "a", "text": "Apple."},
        {"voice": "b", "text": "Banana!!"},
        {"voice": "c", "text": "Cat"},
    ]
    res = engine.synthesize_batch("0.6b", items)

    for pcm, item in zip(res.pcms, items):
        # chunk carries THIS item's text (first char) ...
        assert _read_sample(pcm, 0) == ord(item["text"][0])
        # ... and THIS item's voice prompt (no demux swap).
        assert _read_sample(pcm, 1) == refs[item["voice"]]
        # byte length tracks text length (independent ordering signal).
        assert len(pcm) == 2 * max(2, len(item["text"]))


def test_batch_flattens_per_voice_prompt_item_lists(qwen_batch_runtime) -> None:
    """Regression: each designed voice's cached prompt is a LIST of prompt items
    (create_voice_clone_prompt's shape), so synthesize_batch must FLATTEN them
    into one item per text. Appending the per-voice lists verbatim shipped a
    list-of-lists, which made the library's `[it.ref_code for it in items]` raise
    "'list' object has no attribute 'ref_code'" — a 500 on every batched Qwen
    chapter."""
    engine = qwen_batch_runtime["engine"]
    for v in ("a", "b"):
        _design(engine, v)
    engine._base.clone_calls.clear()

    res = engine.synthesize_batch(
        "0.6b", [{"voice": "a", "text": "Hi."}, {"voice": "b", "text": "Yo."}]
    )

    prompts = engine._base.clone_calls[0]["prompt"]
    assert len(prompts) == 2  # one prompt item per text, not two nested lists
    assert all(not isinstance(p, list) for p in prompts)
    assert all(hasattr(p, "ref_code") for p in prompts)
    assert len(res.pcms) == 2


def test_batch_of_one_matches_single_call(qwen_batch_runtime) -> None:
    """Batch-of-1 must be byte-identical to the single /synthesize path — the
    parity that lets QWEN_BATCH_SIZE=1 act as a safe kill-switch."""
    engine = qwen_batch_runtime["engine"]
    _design(engine, "a")

    single = engine.synthesize("0.6b", "a", "Hello there.")
    batched = engine.synthesize_batch("0.6b", [{"voice": "a", "text": "Hello there."}])

    assert batched.sample_rate == single.sample_rate
    assert batched.pcms[0] == single.pcm


def test_undesigned_voice_fails_whole_batch_with_index(qwen_batch_runtime) -> None:
    engine = qwen_batch_runtime["engine"]
    _design(engine, "a")

    with pytest.raises(RuntimeError) as excinfo:
        engine.synthesize_batch(
            "0.6b",
            [{"voice": "a", "text": "ok"}, {"voice": "ghost", "text": "boom"}],
        )
    msg = str(excinfo.value)
    assert "1" in msg          # the offending item index
    assert "ghost" in msg      # the offending voice
    assert "design" in msg.lower()


def test_empty_batch_raises(qwen_batch_runtime) -> None:
    engine = qwen_batch_runtime["engine"]
    with pytest.raises(RuntimeError):
        engine.synthesize_batch("0.6b", [])


# ── batch-path perf log ──────────────────────────────────────────────────

_BATCH_LOG = re.compile(
    r"qwen batch synth: model=\S+ items=(\d+) voices=(\d+) text_len=(\d+) "
    r"load_ms=[0-9.]+ gen_ms=[0-9.]+ audio_ms=[0-9.]+ rtf=([0-9.]+)"
)


def test_synthesize_batch_logs_aggregate_rtf(qwen_batch_runtime, caplog) -> None:
    """The batched forward — the path that drives real chapter generation —
    must emit a `qwen batch synth: … rtf=` perf line mirroring the single
    /synthesize line. Without it the only rtf in the log is the slow per-sample
    voice-audition path (~8), which hides the batched chapter throughput (the
    ~1 target the box is tuned for). `voices` counts DISTINCT voices so a
    mixed narrator+dialogue batch is legible; `rtf` is the aggregate
    gen_ms / Σ audio_ms across the whole batch."""
    engine = qwen_batch_runtime["engine"]
    for v in ("a", "b"):
        _design(engine, v)
    engine._base.clone_calls.clear()  # drop the per-voice audition calls + logs

    items = [
        {"voice": "a", "text": "Apple."},
        {"voice": "a", "text": "Banana!!"},
        {"voice": "b", "text": "Cat"},
    ]
    with caplog.at_level(logging.INFO, logger="sidecar"):
        engine.synthesize_batch("0.6b", items)

    lines = [r.getMessage() for r in caplog.records if "qwen batch synth:" in r.getMessage()]
    assert len(lines) == 1, f"expected exactly one batch-synth log line, got {lines!r}"
    m = _BATCH_LOG.search(lines[0])
    assert m, f"batch-synth log shape drifted: {lines[0]!r}"
    assert int(m.group(1)) == 3  # items
    assert int(m.group(2)) == 2  # distinct voices (a appears twice, b once)
    assert int(m.group(3)) == len("Apple.") + len("Banana!!") + len("Cat")  # text_len
    float(m.group(4))  # rtf parses as a float


# ── HTTP surface: the length-prefixed binary frame ───────────────────────

def _parse_frame(raw: bytes) -> tuple[dict[str, Any], list[bytes]]:
    """Mirror the Node client's parse: split on the FIRST newline, JSON-decode
    the header, slice the body by `lengths`."""
    nl = raw.index(b"\n")
    header = json.loads(raw[:nl].decode("utf-8"))
    body = raw[nl + 1 :]
    chunks, off = [], 0
    for length in header["lengths"]:
        chunks.append(body[off : off + length])
        off += length
    assert off == len(body)  # body fully consumed by the declared lengths
    return header, chunks


def test_route_frames_length_prefixed_binary(qwen_batch_runtime) -> None:
    engine = qwen_batch_runtime["engine"]
    refs = {v: _design(engine, v) for v in ("a", "b")}
    client = TestClient(main.app)

    resp = client.post(
        "/synthesize-batch",
        json={
            "engine": "qwen",
            "model": "0.6b",
            "items": [
                {"voice": "a", "text": "Apple."},
                {"voice": "b", "text": "Banana!!"},
            ],
        },
    )
    assert resp.status_code == 200
    assert resp.headers["x-sample-rate"] == "24000"

    header, chunks = _parse_frame(resp.content)
    assert header["sampleRate"] == 24000
    assert len(chunks) == 2
    assert _read_sample(chunks[0], 0) == ord("A")
    assert _read_sample(chunks[0], 1) == refs["a"]
    assert _read_sample(chunks[1], 0) == ord("B")
    assert _read_sample(chunks[1], 1) == refs["b"]


def test_route_header_carries_batch_perf(qwen_batch_runtime) -> None:
    """The frame header must carry genMs/audioMs (additive to sampleRate/lengths)
    so the server can surface a LIVE per-batch RTF as each batch lands — the
    per-chapter rollup is too coarse to act on."""
    engine = qwen_batch_runtime["engine"]
    _design(engine, "a")
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={"engine": "qwen", "model": "0.6b", "items": [{"voice": "a", "text": "Hello there."}]},
    )
    assert resp.status_code == 200
    header, _chunks = _parse_frame(resp.content)
    assert "genMs" in header and "audioMs" in header
    assert isinstance(header["genMs"], (int, float)) and header["genMs"] >= 0
    # The fake wav has samples → non-zero audio duration.
    assert isinstance(header["audioMs"], (int, float)) and header["audioMs"] > 0


def test_route_rejects_non_qwen_engine(qwen_batch_runtime) -> None:
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={"engine": "kokoro", "model": "v1", "items": [{"voice": "x", "text": "hi"}]},
    )
    assert resp.status_code == 400
    assert "qwen-only" in resp.json()["detail"]


def test_route_validates_items(qwen_batch_runtime) -> None:
    client = TestClient(main.app)
    base = {"engine": "qwen", "model": "0.6b"}
    assert client.post("/synthesize-batch", json={**base, "items": []}).status_code == 400
    assert (
        client.post(
            "/synthesize-batch", json={**base, "items": [{"text": "hi"}]}
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/synthesize-batch", json={**base, "items": [{"voice": "a", "text": "  "}]}
        ).status_code
        == 400
    )


def test_route_500s_on_undesigned_voice(qwen_batch_runtime) -> None:
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={"engine": "qwen", "model": "0.6b", "items": [{"voice": "ghost", "text": "x"}]},
    )
    assert resp.status_code == 500


def test_frame_splits_on_first_newline_only(qwen_batch_runtime, monkeypatch) -> None:
    """PCM that happens to contain 0x0A (newline) bytes must not break framing:
    the header is newline-free and terminated by the FIRST newline, so the body
    — 0x0A bytes and all — is recovered intact by slicing on `lengths`."""
    engine = qwen_batch_runtime["engine"]
    pcm_a = b"\x0a\x00\x0a\x00"  # four bytes, two of them 0x0A
    pcm_b = b"\x01\x02"

    monkeypatch.setattr(
        engine,
        "synthesize_batch",
        lambda model, items, live_instruct=False: main.SynthBatchResult(
            pcms=[pcm_a, pcm_b], sample_rate=24000
        ),
    )
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={
            "engine": "qwen",
            "model": "0.6b",
            "items": [{"voice": "a", "text": "x"}, {"voice": "b", "text": "y"}],
        },
    )
    assert resp.status_code == 200
    header, chunks = _parse_frame(resp.content)
    assert header["lengths"] == [4, 2]
    assert chunks[0] == pcm_a
    assert chunks[1] == pcm_b


# ── concurrency: the Base forward is serialised (sidecar-qwen-concurrent-batch-race) ──

def test_synthesize_batch_serialises_concurrent_forwards(qwen_batch_runtime, monkeypatch) -> None:
    """Regression: the Qwen Base `generate_voice_clone` forward is NOT thread-safe.
    When GPU_VRAM_BUDGET>1 runs N workers, two batched forwards of DIFFERENT sizes
    (e.g. a full 8 overlapping a chapter's 7-item remainder) overlap and collide on
    shared model state — reproducibly raising "size of tensor a (8) must match
    tensor b (7) at non-singleton dimension 0" (confirmed 6/6 on the real model).
    `QwenEngine._synth_lock` must serialise same-engine forwards. This instruments
    the fake model's forward to flag any concurrent entry; with the lock it must
    never observe overlap (and no call must fail)."""
    import threading
    import time

    engine = qwen_batch_runtime["engine"]
    for v in ("a", "b", "c", "d"):
        _design(engine, v)
    base = engine._base  # the loaded _BatchFakeQwen

    state = {"inside": 0, "max_concurrent": 0}
    guard = threading.Lock()
    real = base.generate_voice_clone

    def instrumented(text, language, voice_clone_prompt):
        with guard:
            state["inside"] += 1
            state["max_concurrent"] = max(state["max_concurrent"], state["inside"])
        try:
            time.sleep(0.05)  # widen the overlap window so a missing lock is caught
            return real(text, language, voice_clone_prompt)
        finally:
            with guard:
                state["inside"] -= 1

    monkeypatch.setattr(base, "generate_voice_clone", instrumented)

    # Two concurrent batches of DIFFERENT sizes — the exact real-world trigger.
    items8 = [{"voice": v, "text": f"s{i}"} for i, v in enumerate(["a", "b", "c", "d", "a", "b", "c", "d"])]
    items7 = [{"voice": v, "text": f"t{i}"} for i, v in enumerate(["a", "b", "c", "d", "a", "b", "c"])]
    errors: list[Exception] = []

    def worker(items):
        try:
            engine.synthesize_batch("0.6b", items)
        except Exception as e:  # pragma: no cover - only on regression
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(items8,)),
               threading.Thread(target=worker, args=(items7,))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"concurrent batches errored: {errors}"
    assert state["max_concurrent"] == 1, (
        f"Base forwards overlapped (max_concurrent={state['max_concurrent']}) — "
        "_synth_lock is not serialising same-engine synthesis"
    )


def test_ensure_base_loaded_single_flights_concurrent_cold_loads(
    qwen_batch_runtime, monkeypatch
) -> None:
    """Regression (sidecar-qwen-cold-load-race): `_ensure_base_loaded` ran
    UNLOCKED, so two synth workers that both observed a cold `_base` on the first
    synth after a sidecar restart each loaded the Base model. The racing loads
    left the model in a half-cast dtype state and every later forward died with
    "expected mat1 and mat2 to have the same dtype, float != BFloat16" (199 such
    500s in the wild). The threading lock + double-check must collapse N racing
    callers to exactly ONE load."""
    import threading
    import time

    engine = qwen_batch_runtime["engine"]
    engine._base = None

    load_count = 0
    count_guard = threading.Lock()

    def slow_load(model_id):
        nonlocal load_count
        with count_guard:
            load_count += 1
        time.sleep(0.05)  # widen the race window so a missing lock double-loads
        return object()  # stand-in model

    monkeypatch.setattr(engine, "_load_qwen_model", slow_load)

    # Release all callers at once for maximal contention on the cold check.
    barrier = threading.Barrier(8)

    def call():
        barrier.wait()
        engine._ensure_base_loaded()

    threads = [threading.Thread(target=call) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert load_count == 1, f"cold load raced: {load_count} concurrent loads (want 1)"
    assert engine._base is not None


def test_route_batch_cuda_error_poisons_and_503s(qwen_batch_runtime, monkeypatch) -> None:
    """Regression (sidecar-poison-fence-all-engines): a CUDA error inside the
    batched forward must flag process poison, return 503 (not a plain 500), and
    schedule the supervised exit — exactly like /synthesize. The batch route
    previously returned a bare 500 with no poison handling, so a Qwen batch CUDA
    error wedged the whole run."""
    timer_calls: list[tuple[float, Any]] = []

    class _FakeTimer:
        def __init__(self, delay: float, fn: Any) -> None:
            timer_calls.append((delay, fn))

        def start(self) -> None:
            pass

    monkeypatch.setattr(main.threading, "Timer", _FakeTimer)

    engine = qwen_batch_runtime["engine"]
    _design(engine, "a")

    def _boom(*_a: Any, **_k: Any):
        raise RuntimeError("CUDA error: unknown error")

    monkeypatch.setattr(engine._base, "generate_voice_clone", _boom)

    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={"engine": "qwen", "model": "0.6b", "items": [{"voice": "a", "text": "hi"}]},
    )
    assert resp.status_code == 503
    assert resp.json().get("poisoned") is True
    assert main._process_poisoned is True
    assert len(timer_calls) == 1  # batched CUDA error scheduled the supervised exit


# ── fs-56 Quality tier: synthesize_batch routes 1.7b model to _base17 ───────
#
# The 1.7b branch of synthesize_batch must:
#   - call _ensure_base17_loaded (not _ensure_base_loaded) before the forward;
#   - derive each item's prompt via _load_voice_prompt_17b (not _load_voice_prompt);
#   - call _base17.generate_voice_clone (NOT _base.generate_voice_clone).
#
# We stub _ensure_base17_loaded + _load_voice_prompt_17b to avoid needing the
# full 1.7B model internals, and record which generate_voice_clone is called.


def test_synthesize_batch_1_7b_routes_to_base17(qwen_batch_runtime, monkeypatch) -> None:
    """synthesize_batch(model='1.7b') must call _base17.generate_voice_clone,
    NOT _base.generate_voice_clone — the critical regression this fixes."""
    engine = qwen_batch_runtime["engine"]

    # Design a 0.6b voice so the base manifest + prompt exist (needed by
    # _load_voice_prompt_17b's internal call to _load_voice_prompt).
    markers = {v: _design(engine, v) for v in ("p", "q")}

    # Stub _base17 as a _BatchFakeQwen so we can assert it receives the call.
    fake17 = _BatchFakeQwen("qwen3-1.7b-fake")
    monkeypatch.setattr(engine, "_base17", fake17)

    # Stub _ensure_base17_loaded to a no-op (base17 already set above).
    monkeypatch.setattr(engine, "_ensure_base17_loaded", lambda: None)

    # Stub _load_voice_prompt_17b to return a recognisable fake prompt built
    # from the voice name so per-item prompt isolation is verifiable. The
    # prompt shape mirrors _BatchFakeQwen.create_voice_clone_prompt output: a
    # length-1 list of _FakePromptItem.
    def _fake_prompt_17b(voice: str):
        marker = markers.get(voice, 0)
        return [_FakePromptItem(marker + 1000, "pangram")], "English", False

    monkeypatch.setattr(engine, "_load_voice_prompt_17b", _fake_prompt_17b)

    # Clear calls accumulated during voice design (design auditions use _base).
    engine._base.clone_calls.clear()

    items = [{"voice": "p", "text": "Hello."}, {"voice": "q", "text": "World."}]
    res = engine.synthesize_batch("1.7b", items)

    # _base17 received the call, not _base.
    assert len(fake17.clone_calls) == 1, (
        f"_base17.generate_voice_clone should have been called once, got {len(fake17.clone_calls)}"
    )
    assert len(engine._base.clone_calls) == 0, (
        "_base.generate_voice_clone must NOT be called for model='1.7b'"
    )

    # Correct number of outputs returned.
    assert len(res.pcms) == 2
    assert res.sample_rate == 24000


def test_synthesize_batch_1_7b_derives_per_item_prompts_from_load_voice_prompt_17b(
    qwen_batch_runtime, monkeypatch
) -> None:
    """Each item's prompt must come from _load_voice_prompt_17b (not the 0.6B
    _load_voice_prompt). We verify by making the two functions return distinct
    prompt markers and asserting the 1.7B marker is what reaches generate_voice_clone."""
    engine = qwen_batch_runtime["engine"]
    markers = {v: _design(engine, v) for v in ("x", "y")}

    fake17 = _BatchFakeQwen("qwen3-1.7b-fake")
    monkeypatch.setattr(engine, "_base17", fake17)
    monkeypatch.setattr(engine, "_ensure_base17_loaded", lambda: None)

    # 1.7B prompts carry marker+2000; 0.6B prompts carry marker (from _design).
    # If the batch mistakenly calls _load_voice_prompt, the marker recorded in
    # generate_voice_clone will be marker, not marker+2000.
    def _fake_prompt_17b(voice: str):
        marker = markers.get(voice, 0)
        return [_FakePromptItem(marker + 2000, "pangram")], "English", False

    monkeypatch.setattr(engine, "_load_voice_prompt_17b", _fake_prompt_17b)

    # Clear design-time calls so only synth calls are counted below.
    engine._base.clone_calls.clear()

    items = [{"voice": "x", "text": "Alpha."}, {"voice": "y", "text": "Beta."}]
    engine.synthesize_batch("1.7b", items)

    assert len(fake17.clone_calls) == 1
    call = fake17.clone_calls[0]
    # prompt items carry the 1.7B-specific markers (not the raw 0.6B design markers).
    assert call["prompt"][0].ref_code == markers["x"] + 2000
    assert call["prompt"][1].ref_code == markers["y"] + 2000


def test_synthesize_batch_0_6b_does_not_touch_base17(qwen_batch_runtime, monkeypatch) -> None:
    """Regression guard: model='0.6b' (the existing path) must NOT call _base17
    after the refactor split the branches."""
    engine = qwen_batch_runtime["engine"]
    for v in ("a", "b"):
        _design(engine, v)

    base17_calls: list[Any] = []

    class _Sentry:
        """Raises immediately if any method is called — proves base17 is untouched."""
        def __getattr__(self, name: str) -> Any:
            def _boom(*_a: Any, **_k: Any) -> Any:
                base17_calls.append(name)
                raise AssertionError(f"_base17.{name} called during 0.6b batch")
            return _boom

    monkeypatch.setattr(engine, "_base17", _Sentry())
    base17_loaded_calls: list[int] = []
    monkeypatch.setattr(
        engine, "_ensure_base17_loaded", lambda: base17_loaded_calls.append(1)
    )

    res = engine.synthesize_batch(
        "0.6b", [{"voice": "a", "text": "Hi."}, {"voice": "b", "text": "Bye."}]
    )
    assert not base17_calls, f"0.6b batch touched _base17 methods: {base17_calls}"
    assert not base17_loaded_calls, "_ensure_base17_loaded called during 0.6b batch"
    assert len(res.pcms) == 2


# ── fs-57 Task 6: batch-level liveInstruct path (1.7B only) ─────────────────
#
# When synthesize_batch is called with model='1.7b' AND liveInstruct=True, EVERY
# item runs the raw `_base17.model.generate(...)` bypass in ONE batched forward
# (P-C1: a single forward can't mix the generate_voice_clone wrapper and the raw
# bypass, so the path is chosen at BATCH level, not per item). Each item's
# instruct_ids is built from its own `instruct`, or NEUTRAL_INSTRUCT when absent
# — so a neutral item still rides the bypass, never the wrapper. liveInstruct is
# 1.7B-only and ignored on 0.6B.


def _instruct_text_of(tok_entry: Any) -> str:
    """Recover the instruct text the engine tokenised for one item.

    The fake `_tokenize_texts` returns ("ids", build_string); the engine builds
    each instruct via `_build_instruct_text(instruct)` →
    `<|im_start|>user\\n{instruct}<|im_end|>\\n`. tok_entry is that tuple."""
    return tok_entry[1] if tok_entry is not None else ""


def _setup_17b_engine(engine, monkeypatch, voices, prompt_offset=5000):
    """Wire a fake _base17 + stubbed loaders so the 1.7B liveInstruct batch runs
    without weights. Returns {voice: voice_marker} for output-demux assertions."""
    markers = {v: _design(engine, v) for v in voices}
    fake17 = _BatchFakeQwen("qwen3-1.7b-fake")
    monkeypatch.setattr(engine, "_base17", fake17)
    monkeypatch.setattr(engine, "_ensure_base17_loaded", lambda: None)

    def _fake_prompt_17b(voice: str):
        marker = markers.get(voice, 0) + prompt_offset
        # ref_text is the per-voice ICL ref; ref_code carries the voice marker.
        return [_FakePromptItem(marker, f"ref-{voice}")], "English", False

    monkeypatch.setattr(engine, "_load_voice_prompt_17b", _fake_prompt_17b)
    engine._base.clone_calls.clear()
    return markers, fake17, prompt_offset


def test_batch_live_instruct_two_different_instructs_no_cross_bleed(
    qwen_batch_runtime, monkeypatch
) -> None:
    """(a) liveInstruct=True, two items with DIFFERENT instructs → two non-empty
    PCM buffers, each carrying ITS OWN text+voice (no demux swap) and ITS OWN
    instruct_ids (no cross-bleed of the delivery direction)."""
    engine = qwen_batch_runtime["engine"]
    markers, fake17, off = _setup_17b_engine(engine, monkeypatch, ("p", "q"))

    items = [
        {"voice": "p", "text": "Apple.", "instruct": "Whispering, afraid."},
        {"voice": "q", "text": "Banana.", "instruct": "Shouting with joy."},
    ]
    res = engine.synthesize_batch("1.7b", items, live_instruct=True)

    # Raw bypass: exactly ONE generate() forward on the inner model; the
    # generate_voice_clone wrapper is NEVER called on the liveInstruct path.
    assert len(fake17.model.generate_calls) == 1
    assert len(fake17.clone_calls) == 0, "liveInstruct must NOT call generate_voice_clone"
    call = fake17.model.generate_calls[0]

    # Per-item parallel lists of the SAME length (one entry per item).
    assert len(call["input_ids"]) == 2
    assert len(call["instruct_ids"]) == 2
    assert len(call["voice_clone_prompt"]["ref_code"]) == 2

    # Each item's instruct_ids carries ITS OWN instruct text (no cross-bleed).
    assert "Whispering, afraid." in _instruct_text_of(call["instruct_ids"][0])
    assert "Shouting with joy." in _instruct_text_of(call["instruct_ids"][1])

    # Two non-empty PCM buffers, demux intact: text p→voice p, text q→voice q.
    assert len(res.pcms) == 2
    assert all(len(p) > 0 for p in res.pcms)
    assert _read_sample(res.pcms[0], 0) == ord("A")           # "Apple."
    assert _read_sample(res.pcms[0], 1) == markers["p"] + off  # voice p prompt
    assert _read_sample(res.pcms[1], 0) == ord("B")           # "Banana."
    assert _read_sample(res.pcms[1], 1) == markers["q"] + off  # voice q prompt


def test_batch_live_instruct_neutral_item_uses_neutral_instruct(
    qwen_batch_runtime, monkeypatch
) -> None:
    """(b) liveInstruct=True with one instructed + one NEUTRAL (no `instruct`)
    item → BOTH go through the bypass; the neutral item's instruct_ids is built
    from main.NEUTRAL_INSTRUCT (the empty-template form), never the wrapper."""
    engine = qwen_batch_runtime["engine"]
    markers, fake17, off = _setup_17b_engine(engine, monkeypatch, ("p", "q"))

    items = [
        {"voice": "p", "text": "Apple.", "instruct": "Mournfully."},
        {"voice": "q", "text": "Banana."},  # no instruct → NEUTRAL_INSTRUCT
    ]
    res = engine.synthesize_batch("1.7b", items, live_instruct=True)

    # Single bypass forward; wrapper never touched.
    assert len(fake17.model.generate_calls) == 1
    assert len(fake17.clone_calls) == 0
    call = fake17.model.generate_calls[0]

    # The instructed item carries its instruct; the neutral one carries the
    # empty-template NEUTRAL_INSTRUCT (`<|im_start|>user\n<|im_end|>\n`), NOT a
    # missing/None entry (which would be the wrong path).
    assert "Mournfully." in _instruct_text_of(call["instruct_ids"][0])
    neutral_built = engine._base17._build_instruct_text(main.NEUTRAL_INSTRUCT)
    assert _instruct_text_of(call["instruct_ids"][1]) == neutral_built
    assert call["instruct_ids"][1] is not None

    assert len(res.pcms) == 2
    assert all(len(p) > 0 for p in res.pcms)


def test_batch_live_instruct_false_uses_generate_voice_clone_ignores_instruct(
    qwen_batch_runtime, monkeypatch
) -> None:
    """(c) liveInstruct=False → the existing generate_voice_clone path runs and
    `instruct` is ignored entirely (no raw generate() bypass)."""
    engine = qwen_batch_runtime["engine"]
    markers, fake17, off = _setup_17b_engine(engine, monkeypatch, ("p", "q"))

    items = [
        {"voice": "p", "text": "Apple.", "instruct": "ignored entirely"},
        {"voice": "q", "text": "Banana."},
    ]
    res = engine.synthesize_batch("1.7b", items, live_instruct=False)

    # Wrapper path: ONE generate_voice_clone call, NO raw generate() bypass.
    assert len(fake17.clone_calls) == 1
    assert len(fake17.model.generate_calls) == 0, (
        "liveInstruct=False must use generate_voice_clone, not the raw bypass"
    )
    assert len(res.pcms) == 2


def test_batch_live_instruct_defaults_false(qwen_batch_runtime, monkeypatch) -> None:
    """Back-compat: omitting live_instruct keeps the existing wrapper path (the
    default is False), so legacy callers are unaffected."""
    engine = qwen_batch_runtime["engine"]
    _setup_17b_engine(engine, monkeypatch, ("p",))
    fake17 = engine._base17

    engine.synthesize_batch("1.7b", [{"voice": "p", "text": "Hi.", "instruct": "x"}])
    assert len(fake17.clone_calls) == 1
    assert len(fake17.model.generate_calls) == 0


def test_batch_live_instruct_ignored_on_0_6b(qwen_batch_runtime, monkeypatch) -> None:
    """0.6B ignores live_instruct entirely (no live instruct on 0.6B): even with
    live_instruct=True + per-item instruct, the 0.6B wrapper path runs and
    _base17 is never touched."""
    engine = qwen_batch_runtime["engine"]
    for v in ("a", "b"):
        _design(engine, v)

    class _Sentry:
        def __getattr__(self, name: str) -> Any:
            def _boom(*_a: Any, **_k: Any) -> Any:
                raise AssertionError(f"_base17.{name} called during 0.6b liveInstruct batch")
            return _boom

    monkeypatch.setattr(engine, "_base17", _Sentry())
    engine._base.clone_calls.clear()

    res = engine.synthesize_batch(
        "0.6b",
        [{"voice": "a", "text": "Hi.", "instruct": "loud"}, {"voice": "b", "text": "Bye."}],
        live_instruct=True,
    )
    # 0.6B wrapper path ran exactly once; live_instruct + instruct were ignored.
    assert len(engine._base.clone_calls) == 1
    assert len(res.pcms) == 2


# ── route: /synthesize-batch threads liveInstruct + per-item instruct ───────


def test_route_passes_live_instruct_and_instruct_through(
    qwen_batch_runtime, monkeypatch
) -> None:
    """The /synthesize-batch route forwards a top-level `liveInstruct` flag and
    per-item `instruct` to engine.synthesize_batch, so Task 8's chapter driver
    can drive the 1.7B live-instruct path over HTTP."""
    engine = qwen_batch_runtime["engine"]
    _design(engine, "a")

    seen: dict[str, Any] = {}

    def _spy(model, items, live_instruct=False):
        seen["model"] = model
        seen["items"] = items
        seen["live_instruct"] = live_instruct
        return main.SynthBatchResult(pcms=[b"\x00\x00"], sample_rate=24000)

    monkeypatch.setattr(engine, "synthesize_batch", _spy)
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={
            "engine": "qwen",
            "model": "1.7b",
            "liveInstruct": True,
            "items": [{"voice": "a", "text": "Hi.", "instruct": "softly"}],
        },
    )
    assert resp.status_code == 200
    assert seen["live_instruct"] is True
    assert seen["items"][0]["instruct"] == "softly"


def test_route_live_instruct_defaults_false(qwen_batch_runtime, monkeypatch) -> None:
    """Omitting `liveInstruct` in the body defaults the engine flag to False —
    legacy clients (no liveInstruct key) keep the wrapper path."""
    engine = qwen_batch_runtime["engine"]
    _design(engine, "a")

    seen: dict[str, Any] = {}

    def _spy(model, items, live_instruct=False):
        seen["live_instruct"] = live_instruct
        return main.SynthBatchResult(pcms=[b"\x00\x00"], sample_rate=24000)

    monkeypatch.setattr(engine, "synthesize_batch", _spy)
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={"engine": "qwen", "model": "0.6b", "items": [{"voice": "a", "text": "Hi."}]},
    )
    assert resp.status_code == 200
    assert seen["live_instruct"] is False


# ── fs-57 Task 7 (m4): instruct length cap on /synthesize-batch ─────────────
#
# A per-item `instruct` that exceeds _max_text_length() must be rejected with
# HTTP 400 and a message matching `instruct` too long (N chars > cap).
# The cap applies ONLY when liveInstruct=True; a long `instruct` with
# liveInstruct=False (or absent) must pass validation silently.


def test_route_rejects_over_cap_instruct_when_live_instruct_on(
    qwen_batch_runtime, monkeypatch
) -> None:
    """liveInstruct=True + an instruct that exceeds the cap → HTTP 400 with
    a message mentioning `instruct` too long and the item index."""
    monkeypatch.setattr(main, "_max_text_length", lambda: 10)  # tiny cap for test
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={
            "engine": "qwen",
            "model": "1.7b",
            "liveInstruct": True,
            "items": [
                {"voice": "a", "text": "Hello.",
                 "instruct": "X" * 11},  # 11 > cap 10
            ],
        },
    )
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "instruct" in detail
    assert "too long" in detail
    assert "11" in detail  # length reported
    assert "10" in detail  # cap reported


def test_route_rejects_over_cap_instruct_names_correct_item_index(
    qwen_batch_runtime, monkeypatch
) -> None:
    """The 400 message must name the item index of the first over-cap instruct
    (item 1 here — the first item is fine)."""
    monkeypatch.setattr(main, "_max_text_length", lambda: 5)
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={
            "engine": "qwen",
            "model": "1.7b",
            "liveInstruct": True,
            "items": [
                {"voice": "a", "text": "Hi.", "instruct": "ok"},     # fine
                {"voice": "a", "text": "Hi.", "instruct": "Y" * 6},  # over cap
            ],
        },
    )
    assert resp.status_code == 400
    assert "item 1" in resp.json()["detail"]


def test_route_allows_instruct_at_exact_cap(qwen_batch_runtime, monkeypatch) -> None:
    """An instruct exactly at the cap boundary (len == cap) must pass validation."""
    monkeypatch.setattr(main, "_max_text_length", lambda: 5)
    engine = qwen_batch_runtime["engine"]
    _design(engine, "a")

    seen: dict[str, Any] = {}

    def _spy(model, items, live_instruct=False):
        seen["called"] = True
        return main.SynthBatchResult(pcms=[b"\x00\x00"], sample_rate=24000)

    monkeypatch.setattr(engine, "synthesize_batch", _spy)
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={
            "engine": "qwen",
            "model": "1.7b",
            "liveInstruct": True,
            "items": [{"voice": "a", "text": "Hi.", "instruct": "A" * 5}],  # == cap
        },
    )
    assert resp.status_code == 200
    assert seen.get("called")


def test_route_ignores_over_cap_instruct_when_live_instruct_off(
    qwen_batch_runtime, monkeypatch
) -> None:
    """liveInstruct=False (or absent): per-item `instruct` is ignored entirely,
    so even a pathologically long one must NOT trigger the 400."""
    monkeypatch.setattr(main, "_max_text_length", lambda: 5)
    engine = qwen_batch_runtime["engine"]
    _design(engine, "a")

    def _spy(model, items, live_instruct=False):
        return main.SynthBatchResult(pcms=[b"\x00\x00"], sample_rate=24000)

    monkeypatch.setattr(engine, "synthesize_batch", _spy)
    client = TestClient(main.app)
    resp = client.post(
        "/synthesize-batch",
        json={
            "engine": "qwen",
            "model": "0.6b",
            "liveInstruct": False,
            "items": [{"voice": "a", "text": "Hi.", "instruct": "Z" * 9999}],
        },
    )
    assert resp.status_code == 200
