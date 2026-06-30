"""test_codec_timing.py — Phase-0 Code2Wav timing hook (side-19).

Qwen3TTSModel is a thin WRAPPER holding the real nn.Module at `.model`
(main.py:1547), and speech_tokenizer hangs off that inner module
(self._base17.model.speech_tokenizer.decode, :2453). The hot batch decode
runs inside qwen_tts's generate_voice_clone — a call site we don't own — so
we wrap the bound `decode` method on the resolved speech_tokenizer at load.
Pin: the resolver traverses `.model`, the flag defaults OFF (zero production
overhead), the wrapper accumulates wall-ms, snapshot/reset round-trips, and a
reload doesn't double-wrap.
"""
from __future__ import annotations

import time
import types
from typing import Any

import main


def _make_stub_model(decode_sleep_s: float = 0.0) -> Any:
    """A WRAPPER-shaped stub: the speech_tokenizer hangs off `.model`, exactly
    like the real Qwen3TTSModel. `decode`'s return value is derived from its
    input (echoes `items` back alongside a fixed sample rate) so a wrapped
    call's result can be checked for passthrough against a known-expected
    value rather than just asserting call counts."""
    def decode(items):
        if decode_sleep_s:
            time.sleep(decode_sleep_s)
        return (items, 24000)
    st = types.SimpleNamespace(decode=decode)
    inner = types.SimpleNamespace(speech_tokenizer=st)
    return types.SimpleNamespace(model=inner)


def test_resolve_speech_tokenizer_traverses_wrapper():
    st = types.SimpleNamespace(decode=lambda x: None)
    wrapper = types.SimpleNamespace(model=types.SimpleNamespace(speech_tokenizer=st))
    assert main._resolve_speech_tokenizer(wrapper) is st
    # Tolerates being handed the inner module directly.
    inner = types.SimpleNamespace(speech_tokenizer=st)
    assert main._resolve_speech_tokenizer(inner) is st
    # Missing → None so callers no-op instead of raising.
    assert main._resolve_speech_tokenizer(types.SimpleNamespace()) is None


def test_codec_timing_disabled_by_default(monkeypatch):
    monkeypatch.delenv("QWEN_CODEC_TIMING", raising=False)
    assert main._codec_timing_enabled() is False
    model = _make_stub_model()
    original = model.model.speech_tokenizer.decode
    main._install_codec_timing(model)
    assert model.model.speech_tokenizer.decode is original  # disabled → no wrap


def test_codec_timing_accumulates_when_enabled(monkeypatch):
    monkeypatch.setenv("QWEN_CODEC_TIMING", "1")
    main._codec_timing_reset()
    model = _make_stub_model(decode_sleep_s=0.01)
    main._install_codec_timing(model)
    items = [{"audio_codes": object()}]
    result = model.model.speech_tokenizer.decode(items)
    model.model.speech_tokenizer.decode([{"audio_codes": object()}])
    snap = main._codec_timing_snapshot()
    assert snap["calls"] == 2
    assert snap["total_ms"] >= 18.0  # two ~10ms sleeps, generous lower bound
    assert snap["enabled"] is True
    # The wrapper must pass the original decode's return value through unmodified.
    assert result == (items, 24000)


def test_codec_timing_reset_zeroes(monkeypatch):
    monkeypatch.setenv("QWEN_CODEC_TIMING", "1")
    main._codec_timing_reset()
    model = _make_stub_model()
    main._install_codec_timing(model)
    model.model.speech_tokenizer.decode([])
    assert main._codec_timing_snapshot()["calls"] == 1
    main._codec_timing_reset()
    assert main._codec_timing_snapshot() == {"total_ms": 0.0, "calls": 0, "enabled": True}


def test_codec_timing_install_idempotent(monkeypatch):
    monkeypatch.setenv("QWEN_CODEC_TIMING", "1")
    main._codec_timing_reset()
    model = _make_stub_model()
    main._install_codec_timing(model)
    wrapped_once = model.model.speech_tokenizer.decode
    main._install_codec_timing(model)  # reload — must not re-wrap
    assert model.model.speech_tokenizer.decode is wrapped_once
    model.model.speech_tokenizer.decode([])
    assert main._codec_timing_snapshot()["calls"] == 1  # one wrap, one increment


def test_codec_timing_install_tolerates_unresolvable(monkeypatch):
    monkeypatch.setenv("QWEN_CODEC_TIMING", "1")
    main._codec_timing_reset()
    # A model whose codec can't be resolved must not raise — a perf hook never
    # kills a load.
    main._install_codec_timing(types.SimpleNamespace())


def test_codec_share_math():
    import importlib.util
    import pathlib

    spec = importlib.util.spec_from_file_location(
        "bench_tts", pathlib.Path(__file__).parent.parent / "scripts" / "bench-tts.py"
    )
    bench = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bench)  # safe: the CLI entry is behind `if __name__`
    assert bench.codec_share(300.0, 1000.0) == 0.3
    assert bench.codec_share(0.0, 0.0) == 0.0  # no divide-by-zero
    assert bench.codec_share(50.0, 0.0) == 0.0
