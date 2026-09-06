import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")

def test_parse_device():
    assert main._parse_device("cpu") == ("cpu", None)
    assert main._parse_device("cuda") == ("cuda", None)
    assert main._parse_device("cuda:0") == ("cuda", 0)
    assert main._parse_device("CUDA:2") == ("cuda", 2)
    assert main._parse_device("cuda:x") == ("cuda", None)   # malformed index → no index, family kept
    assert main._parse_device("") == ("auto", None)
    assert main._parse_device(None) == ("auto", None)

def test_ct2_kwargs_splits_index():
    assert main._ct2_kwargs("cuda:1", "int8_float16") == {"device": "cuda", "device_index": 1, "compute_type": "int8_float16"}
    assert main._ct2_kwargs("cuda", "int8_float16") == {"device": "cuda", "compute_type": "int8_float16"}
    assert main._ct2_kwargs("cpu", "int8") == {"device": "cpu", "compute_type": "int8"}

def test_ct2_kwargs_normalises_admitted_rocm():
    """#2813 review finding 1: an admitted device can arrive as an explicit
    'rocm:N' from the VRAM-ledger admission layer. Before the fix,
    `_ct2_kwargs('rocm:0', ...)` returned `{"device": "rocm", ...}` --
    CTranslate2 has no 'rocm' device at all, so every `/transcribe` on a
    ROCm box would 500. Index preservation and the compute_type pass-through
    both still hold post-normalisation."""
    assert main._ct2_kwargs("rocm:0", "int8_float16") == {"device": "cuda", "device_index": 0, "compute_type": "int8_float16"}
    assert main._ct2_kwargs("rocm:1", "int8_float16") == {"device": "cuda", "device_index": 1, "compute_type": "int8_float16"}

def test_whisper_compute_type_honours_indexed_cuda(monkeypatch):
    monkeypatch.delenv("ASR_COMPUTE_TYPE", raising=False)
    monkeypatch.setenv("ASR_DEVICE", "cuda:1")
    assert main.WhisperEngine()._compute_type() == "int8_float16"

def test_spk_run_device():
    assert main._spk_run_device("cuda:1") == "cuda:1"
    assert main._spk_run_device("cuda") == "cuda"
    assert main._spk_run_device("cpu") == "cpu"

def test_spk_run_device_normalises_admitted_rocm():
    """#2813 review finding 1: an admitted device can arrive as an explicit
    'rocm:N'. Before the fix, `_spk_run_device('rocm:0')` returned the
    OPAQUE string 'rocm' (the `family in ("cpu","auto")` else-branch just
    returns `family` verbatim) -- speechbrain's `EncoderClassifier` has no
    'rocm' device and raises on it, same as CT2 for Whisper."""
    assert main._spk_run_device("rocm:0") == "cuda:0"
    assert main._spk_run_device("rocm:1") == "cuda:1"

def test_spk_indexed_cuda_degrades_when_no_gpu(monkeypatch):
    """SPK_DEVICE=cuda:1 with no CUDA must degrade to cpu, not crash on the
    `== "cuda"` mismatch (the bug)."""
    monkeypatch.setenv("SPK_DEVICE", "cuda:1")
    spk = main.SpeakerEngine()
    assert main._parse_device(spk.device)[0] == "cuda"
    # stub torch so cuda is 'unavailable' and the present-check runs the degrade
    import types
    fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    monkeypatch.setitem(sys.modules, "torch", fake)
    # Stub speechbrain too. After the degrade, ensure_loaded() still proceeds to a
    # real cpu _load_on(); a genuine `import speechbrain` under the stubbed torch
    # fails partway and leaves the package PARTIALLY INITIALIZED in sys.modules
    # (monkeypatch reverts torch but not speechbrain). That poison then reddens the
    # real-ECAPA tests in test_speaker_embed under the full battery with a cryptic
    # "partially initialized module 'speechbrain' has no attribute 'utils'" — the
    # #1181 "flake". The stub keeps this test to its stated intent: exercise the
    # degrade decision, never the real model load. (Mirror of test_speaker_embed's
    # _install_speechbrain_stub.)
    class _FakeEnc:
        @staticmethod
        def from_hparams(**kw):
            return object()
    mod_sb = types.ModuleType("speechbrain")
    mod_inf = types.ModuleType("speechbrain.inference")
    mod_spk = types.ModuleType("speechbrain.inference.speaker")
    mod_spk.EncoderClassifier = _FakeEnc
    mod_inf.speaker = mod_spk
    mod_sb.inference = mod_inf
    monkeypatch.setitem(sys.modules, "speechbrain", mod_sb)
    monkeypatch.setitem(sys.modules, "speechbrain.inference", mod_inf)
    monkeypatch.setitem(sys.modules, "speechbrain.inference.speaker", mod_spk)
    import asyncio
    asyncio.run(spk.ensure_loaded())
    assert spk.device == "cpu"
    assert spk._model is not None  # degraded to cpu AND loaded (via the stub)


import types as _types
import pytest

def test_validate_cuda_index_rejects_out_of_range():
    fake = _types.SimpleNamespace(
        cuda=_types.SimpleNamespace(is_available=lambda: True, device_count=lambda: 2)
    )
    with pytest.raises(ValueError):
        main._validate_cuda_index("cuda:9", fake)


def test_validate_cuda_index_passes_in_range():
    fake = _types.SimpleNamespace(
        cuda=_types.SimpleNamespace(is_available=lambda: True, device_count=lambda: 2)
    )
    main._validate_cuda_index("cuda:1", fake)  # must not raise


def test_resolve_uuid_to_index_passthrough_for_non_uuid_values():
    assert main._resolve_uuid_to_index("cuda:1") == "cuda:1"
    assert main._resolve_uuid_to_index("auto") == "auto"
    assert main._resolve_uuid_to_index(None) is None
    assert main._resolve_uuid_to_index("cpu") == "cpu"


def test_resolve_uuid_to_index_resolves_a_known_uuid(monkeypatch):
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    assert main._resolve_uuid_to_index("cuda-uuid:GPU-1") == "cuda:1"


def test_resolve_uuid_to_index_none_for_unknown_uuid(monkeypatch):
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    assert main._resolve_uuid_to_index("cuda-uuid:GPU-VANISHED") is None


def test_read_device_env_resolves_uuid(monkeypatch):
    monkeypatch.setenv("QWEN_DEVICE", "cuda-uuid:GPU-1")
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    assert main._read_device_env("QWEN_DEVICE") == "cuda:1"


def test_read_device_env_falls_back_to_auto_when_uuid_unresolved(monkeypatch, caplog):
    monkeypatch.setenv("QWEN_DEVICE", "cuda-uuid:GONE")
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    assert main._read_device_env("QWEN_DEVICE") == "auto"


def test_codec_device_pref_resolves_uuid(monkeypatch):
    """QWEN_CODEC_DEVICE is a type:'device' knob, so a card picked in Advanced
    Settings is persisted as 'cuda-uuid:<uuid>'. _codec_device_pref is what
    _load_qwen_model actually calls, so a UUID must never reach torch raw."""
    monkeypatch.setenv("QWEN_CODEC_DEVICE", "cuda-uuid:GPU-1")
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    assert main._codec_device_pref() == "cuda:1"
    assert main._resolve_codec_device(main._codec_device_pref(), "cuda:0") == "cuda:1"


def test_codec_device_pref_vanished_uuid_falls_back_to_cpu(monkeypatch):
    """A vanished card must NOT degrade to 'auto' -- for the codec that means
    "follow the model", i.e. move onto the very card the user was spreading VRAM
    away from. cpu is the knob's registry default and is VRAM-neutral."""
    monkeypatch.setenv("QWEN_CODEC_DEVICE", "cuda-uuid:GONE")
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    assert main._codec_device_pref() == "cpu"
    # _resolve_codec_device('cpu', ...) is None == "leave the codec where it is"
    assert main._resolve_codec_device(main._codec_device_pref(), "cuda:0") is None


def test_codec_device_pref_unset_and_empty_mean_cpu(monkeypatch):
    monkeypatch.delenv("QWEN_CODEC_DEVICE", raising=False)
    assert main._codec_device_pref() == "cpu"
    monkeypatch.setenv("QWEN_CODEC_DEVICE", "   ")
    assert main._codec_device_pref() == "cpu"


def test_codec_device_pref_passes_through_plain_values(monkeypatch):
    """cpu / auto / cuda:N are unchanged -- no behaviour change for any value
    that already worked."""
    for raw, expected in (("cpu", "cpu"), ("auto", "auto"), ("cuda:1", "cuda:1")):
        monkeypatch.setenv("QWEN_CODEC_DEVICE", raw)
        assert main._codec_device_pref() == expected


# ── #3058 — _parse_device_hint (X-Device-Hint header validation) ───────────
#
# Reuses the exact same grammar `_engine_env_pin` applies to COQUI_DEVICE/
# QWEN_DEVICE (`_resolve_uuid_to_index` + `_parse_device`), so these tests
# mirror the _read_device_env / _engine_env_pin tests above rather than
# inventing new coverage of the underlying grammar.


def test_parse_device_hint_none_or_blank_is_no_hint():
    assert main._parse_device_hint(None) is None
    assert main._parse_device_hint("") is None
    assert main._parse_device_hint("   ") is None


def test_parse_device_hint_accepts_plain_indexed_cuda():
    assert main._parse_device_hint("cuda:1") == "cuda:1"
    assert main._parse_device_hint("CUDA:0") == "cuda:0"


def test_parse_device_hint_resolves_uuid_form(monkeypatch):
    monkeypatch.setattr(
        main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}],
    )
    assert main._parse_device_hint("cuda-uuid:GPU-1") == "cuda:1"


def test_parse_device_hint_unresolved_uuid_is_ignored_not_fatal(monkeypatch, caplog):
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    with caplog.at_level("WARNING"):
        assert main._parse_device_hint("cuda-uuid:GONE") is None
    assert any("uuid_unresolved" in r.getMessage() for r in caplog.records)


def test_parse_device_hint_malformed_value_is_ignored_not_fatal(caplog):
    """Mirrors how an invalid registry device value degrades today (see
    `_engine_env_pin`/`_parse_device`): never raises, never crashes the
    process -- just fails to produce a concrete pin."""
    with caplog.at_level("WARNING"):
        assert main._parse_device_hint("banana") is None
        assert main._parse_device_hint("cuda:x") is None  # unindexed after malformed-index parse
    assert any("not a valid device key" in r.getMessage() for r in caplog.records)


def test_parse_device_hint_auto_is_no_hint_without_warning(caplog):
    with caplog.at_level("WARNING"):
        assert main._parse_device_hint("auto") is None
    assert not any("X-Device-Hint" in r.getMessage() for r in caplog.records)


def test_parse_device_hint_normalises_admitted_rocm(monkeypatch):
    """#2813's vocabulary rule applies here too: the admission ledger's own
    candidate keys are 'rocm:N' on a ROCm box, so a hint must be re-tagged
    the same way _engine_env_pin already is, or it could never match."""
    monkeypatch.setattr(main, "_cuda_is_rocm", lambda: True)
    assert main._parse_device_hint("cuda:1") == "rocm:1"
