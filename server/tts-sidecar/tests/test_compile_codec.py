"""test_compile_codec.py — side-19 Phase 1 QWEN_COMPILE_CODEC wiring.

The compile target is TWO levels below the resolved speech_tokenizer
(st.model.decoder, a real nn.Module submodule), not the speech_tokenizer
itself -- see _resolve_codec_decoder. The swap replaces decoder.forward (an
instance attribute), never the decoder object, because chunked_decode's
internal `self(codes_chunk)` calls resolve `self.forward` via attribute
lookup on the decoder instance -- swapping the whole object would have that
lookup delegate to the ORIGINAL uncompiled forward via OptimizedModule's
__getattr__, a silent no-op (side-19 Task 4 finding). GPU-free: stub
torch.compile and the WRAPPER model shape (speech_tokenizer on `.model`,
its own `.model.decoder` two levels deeper), like test_codec_timing.py.
"""
from __future__ import annotations

import types
from typing import Any

import main


def _stub_torch(compile_raises: bool = False) -> Any:
    def _compile(fn, **kwargs):
        if compile_raises:
            raise RuntimeError("inductor exploded")
        def _compiled(*args, **kwargs2):
            return ("compiled-out", fn, args, kwargs2)
        return _compiled
    return types.SimpleNamespace(compile=_compile)


def _stub_model() -> Any:
    def eager_forward(codes):
        return ("eager-out", codes)
    decoder = types.SimpleNamespace(forward=eager_forward)
    codec_model = types.SimpleNamespace(decoder=decoder)
    st = types.SimpleNamespace(model=codec_model, decode=lambda items: ([], 24000))
    inner = types.SimpleNamespace(speech_tokenizer=st)
    return types.SimpleNamespace(model=inner)  # wrapper holds inner at .model


def test_resolve_codec_decoder_traverses_two_levels():
    model = _stub_model()
    decoder = model.model.speech_tokenizer.model.decoder
    assert main._resolve_codec_decoder(model) is decoder
    # Missing hop at either level -> None, never raises.
    assert main._resolve_codec_decoder(types.SimpleNamespace()) is None
    st_no_model = types.SimpleNamespace(speech_tokenizer=types.SimpleNamespace())
    assert main._resolve_codec_decoder(st_no_model) is None


def test_should_compile_default_off(monkeypatch):
    monkeypatch.delenv("QWEN_COMPILE_CODEC", raising=False)
    assert main._should_compile_codec() is False


def test_should_compile_off_on_windows_even_when_set(monkeypatch):
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "win32")
    assert main._should_compile_codec() is False


def test_should_compile_on_when_set_off_windows(monkeypatch):
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "linux")
    assert main._should_compile_codec() is True


def test_maybe_compile_installs_compiled_forward(monkeypatch):
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "linux")
    model = _stub_model()
    assert main._maybe_compile_codec(model, _stub_torch()) is True
    assert callable(model._compiled_codec_forward)
    # The compiled callable must wrap the ORIGINAL eager forward, not a clone.
    eager = model.model.speech_tokenizer.model.decoder.forward
    result = model._compiled_codec_forward("codes")
    assert result[0] == "compiled-out"
    assert result[1] is eager


def test_maybe_compile_swallows_failure(monkeypatch):
    """A compile failure at load must NOT raise -- fall back to eager."""
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "linux")
    model = _stub_model()
    assert main._maybe_compile_codec(model, _stub_torch(compile_raises=True)) is False
    assert getattr(model, "_compiled_codec_forward", None) is None


def test_batch_swap_swaps_forward_attribute_not_the_module(monkeypatch):
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "linux")
    model = _stub_model()
    decoder = model.model.speech_tokenizer.model.decoder
    eager_forward = decoder.forward
    main._maybe_compile_codec(model, _stub_torch())
    assert decoder.forward is eager_forward  # outside ctx -> single path stays eager
    with main._codec_compiled_for_batch(model):
        assert decoder.forward is model._compiled_codec_forward
        assert decoder is model.model.speech_tokenizer.model.decoder  # object identity unchanged -- only .forward swapped
    assert decoder.forward is eager_forward  # restored after the batch forward


def test_batch_swap_noop_when_not_compiled(monkeypatch):
    monkeypatch.delenv("QWEN_COMPILE_CODEC", raising=False)
    model = _stub_model()
    eager_forward = model.model.speech_tokenizer.model.decoder.forward
    with main._codec_compiled_for_batch(model):
        assert model.model.speech_tokenizer.model.decoder.forward is eager_forward  # never swapped
