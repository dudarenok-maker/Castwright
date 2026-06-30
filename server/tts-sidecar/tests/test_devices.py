import importlib, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")

def _fake_torch():
    def props(i):
        return types.SimpleNamespace(name=["RTX 4070","RTX 5070 Ti"][i],
                                     total_memory=[8*10**9,16*10**9][i], uuid=f"GPU-{i}")
    cuda = types.SimpleNamespace(
        is_available=lambda: True, device_count=lambda: 2,
        get_device_properties=props,
        mem_get_info=lambda i: ([6*10**9,14*10**9][i], [8*10**9,16*10**9][i]))
    return types.SimpleNamespace(cuda=cuda)

def test_enumerate_cards():
    out = main._enumerate_cuda_devices(_fake_torch())
    assert [d["idx"] for d in out] == [0, 1]
    assert out[1] == {"uuid": "GPU-1", "idx": 1, "name": "RTX 5070 Ti", "total_mb": 16000, "free_mb": 14000}

def test_enumerate_empty_without_cuda():
    fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    assert main._enumerate_cuda_devices(fake) == []

def test_engine_actual_card_detects_cpu_fallback():
    # a fake engine that REQUESTED cuda:1 but actually resolved to cpu
    eng = types.SimpleNamespace(_requested_device="cuda:1", device="cpu", _model=object())
    card = main._engine_actual_card(eng)
    assert card["family"] == "cpu"
    assert card["fell_back"] is True

def test_engine_actual_card_none_when_unloaded():
    eng = types.SimpleNamespace(_requested_device="cuda:1", device="cpu", _model=None)
    assert main._engine_actual_card(eng) is None

def test_engine_actual_card_unknown_family_when_all_probes_fail():
    # model is a plain object(): no parameters(), no device/kokoro attrs on engine
    eng = types.SimpleNamespace(_requested_device="cuda:1", _model=object())
    card = main._engine_actual_card(eng)
    assert card is not None
    assert card["family"] == "unknown"
    assert card["index"] is None
    assert card["fell_back"] is False


# --- Kokoro ORT provider reconcile ---

def _fake_kokoro_cpu_session():
    """Kokoro engine: requested cuda:1 but ORT resolved to CPU-only providers."""
    sess = types.SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider"])
    kok = types.SimpleNamespace(sess=sess)
    # No device/_device/_model attrs — mirrors a real KokoroEngine
    return types.SimpleNamespace(_requested_device="cuda:1", _kokoro=kok)


def _fake_kokoro_cuda_session():
    """Kokoro engine: requested cuda:0, ORT kept the CUDA EP."""
    sess = types.SimpleNamespace(get_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"])
    kok = types.SimpleNamespace(sess=sess)
    return types.SimpleNamespace(_requested_device="cuda:0", _kokoro=kok)


def test_engine_actual_card_kokoro_cuda_to_cpu_provider_drop_flags_fell_back():
    # Regression: tier-2 _parse_device(None) returns "auto", not None, so the
    # tier-3 guard `if family is None:` was False and the Kokoro reconcile was
    # unreachable. Fix: guard must be `if family in (None, "auto"):`.
    card = main._engine_actual_card(_fake_kokoro_cpu_session())
    assert card["family"] == "cpu"
    assert card["index"] is None
    assert card["fell_back"] is True


def test_engine_actual_card_kokoro_cuda_resident_no_fallback():
    card = main._engine_actual_card(_fake_kokoro_cuda_session())
    assert card["family"] == "cuda"
    assert card["index"] is None
    assert card["fell_back"] is False


# --- _resident_engines_by_card + _build_gpus_payload (Task 9) ---

def test_resident_buckets_engines_by_card(monkeypatch):
    # ENGINES["qwen"] loaded on card 1; ASR fell back to cpu
    monkeypatch.setattr(main, "_engine_actual_card",
        lambda e: {"family": "cuda", "index": 1, "fell_back": False} if e is main.ENGINES["qwen"]
        else ({"family": "cpu", "index": None, "fell_back": True} if e is main.ASR else None))
    by_card = main._resident_engines_by_card([{"idx": 0}, {"idx": 1}])
    assert {"engine": "qwen", "actual_card": 1} in by_card[1]
    # a fell_back engine is recorded with stale_reason (card key is the cpu bucket convention)
    flat = [r for v in by_card.values() for r in v]
    assert any(r.get("stale_reason") == "cpu_fallback" and r["engine"] == "asr" for r in flat)


def test_build_gpus_payload_merges(monkeypatch):
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [{"uuid":"GPU-1","idx":1,"name":"x","total_mb":16000,"free_mb":14000}])
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {1: [{"engine":"qwen","actual_card":1}]})
    out = main._build_gpus_payload(_fake_torch())
    assert out[0]["resident"] == [{"engine": "qwen", "actual_card": 1}]
    assert "torch_reserved_mb" in out[0]


def test_health_gpus_field_additive(monkeypatch):
    """gpus key appears in /health and pre-existing keys are byte-for-byte unchanged."""
    from fastapi.testclient import TestClient
    monkeypatch.setattr(main, "_build_gpus_payload", lambda torch_module=None: [])
    client = TestClient(main.app)
    body = client.get("/health").json()
    assert "gpus" in body
    # Additive contract: none of the pre-existing keys were removed or renamed
    assert "devices" in body
    assert "asr_device" in body
    assert "spk_device" in body
