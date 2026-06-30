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
