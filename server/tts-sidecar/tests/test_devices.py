import importlib, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")

import pytest
from fastapi.testclient import TestClient

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


# ── final-review fixes: loaded Coqui visibility + unindexed cpu_fallback ──

def test_engine_actual_card_detects_loaded_coqui_via_tts():
    """A loaded Coqui keeps its model in `_tts` (not _model/_kokoro/_base) and its
    ACTUAL device in `_resolved_device` (the pref lives in `_device`). A Coqui that
    requested cuda but resolved cpu must be visible (not None) and flagged fell_back."""
    coqui = types.SimpleNamespace(
        _requested_device="cuda:1", _tts=object(), _resolved_device="cpu", _device="cuda:1"
    )
    card = main._engine_actual_card(coqui)
    assert card is not None  # was None before the _tts lookup fix
    assert card["family"] == "cpu"  # resolved device, not the cuda pref
    assert card["fell_back"] is True


def test_engine_actual_card_loaded_coqui_on_cuda_no_fallback():
    coqui = types.SimpleNamespace(
        _requested_device="cuda:1", _tts=object(), _resolved_device="cuda:1", _device="cuda:1"
    )
    card = main._engine_actual_card(coqui)
    assert card is not None
    assert card["family"] == "cuda"
    assert card["fell_back"] is False


def test_build_gpus_payload_surfaces_unindexed_cpu_fallback(monkeypatch):
    """An ORT/CT2 (or cpu-fallen) engine has index=None → the -1 bucket, which no
    real card claims. _build_gpus_payload must surface it as a synthetic entry so the
    cpu_fallback is visible in gpus[] rather than silently dropped."""
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {
        1: [{"engine": "qwen", "actual_card": 1}],
        -1: [{"engine": "kokoro", "actual_card": None, "stale_reason": "cpu_fallback"}],
    })
    out = main._build_gpus_payload(_fake_torch())
    unindexed = [c for c in out if c["idx"] == -1]
    assert len(unindexed) == 1
    assert {"engine": "kokoro", "actual_card": None, "stale_reason": "cpu_fallback"} in unindexed[0]["resident"]


def test_build_gpus_payload_no_unindexed_entry_when_bucket_empty(monkeypatch):
    """A fully-indexed box (no -1 bucket) sees no synthetic entry — additive only."""
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {1: [{"engine": "qwen", "actual_card": 1}]})
    out = main._build_gpus_payload(_fake_torch())
    assert [c for c in out if c["idx"] == -1] == []


def test_build_gpus_payload_includes_per_card_ceilings(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "1024")
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {})
    out = main._build_gpus_payload(_fake_torch())
    assert out[0]["free_floor_mb"] == 1024.0
    assert out[0]["reserved_ceiling_mb"] == main._VRAM_HARD_FRACTION * 16000


def test_build_gpus_payload_unindexed_row_also_carries_free_floor(monkeypatch):
    """The synthetic -1 (unindexed cpu/ORT/CT2) row must carry free_floor_mb
    too — it's a global absolute, not per-card, and this bucket IS the
    Kokoro/Whisper CPU-fallback engines the floor exists to protect. A
    consumer that expects every gpus[] row to carry the field (e.g. a
    staleness display) must not see it silently missing here."""
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "2048")
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {
        -1: [{"engine": "kokoro", "actual_card": None, "stale_reason": "cpu_fallback"}],
    })
    out = main._build_gpus_payload(_fake_torch())
    unindexed = [c for c in out if c["idx"] == -1]
    assert len(unindexed) == 1
    assert unindexed[0]["free_floor_mb"] == 2048.0
    assert unindexed[0]["reserved_ceiling_mb"] == 0.0


# --- /synthesize capacity admission (SEG_CAPACITY_ADMISSION, task 4) ---


class _FakeSynthEngine(main.CoquiEngine):
    """Minimal Coqui stand-in so /synthesize never touches the real
    multi-gigabyte XTTS model — same shape as test_smoke.py's _FakeEngine,
    duplicated locally to keep this file's admission tests self-contained."""

    name = "coqui"

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[tuple[str, str, str]] = []

    def synthesize(self, model, voice, text, language=None):
        self.calls.append((model, voice, text))
        return main.SynthResult(pcm=b"\x00\x00", sample_rate=24000, substituted_from=None)


@pytest.fixture
def synth_client(monkeypatch):
    fake = _FakeSynthEngine()
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    # Drop the real Kokoro engine so TestClient's startup event doesn't try
    # to eager-preload it (mirrors test_smoke.py's `client` fixture).
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    main._reset_poison_for_test()
    with TestClient(main.app) as c:
        yield c
    main._reset_poison_for_test()


def _synth_body():
    return {"engine": "coqui", "model": "xtts_v2", "voice": "v", "text": "hi"}


def test_synthesize_flag_off_ignores_full_device(monkeypatch, synth_client):
    """Explicit opt-out (SEG_CAPACITY_ADMISSION=0): /synthesize behaves exactly
    as the pre-admission build — no admission check runs at all — even when the
    probe reports a device with no free room. This is the rollback path."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "0")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [{"kind": "cuda", "index": 0, "label": "g", "totalMb": 8192, "freeMb": 50}],
    )
    r = synth_client.post("/synthesize", json=_synth_body())
    assert r.status_code == 200
    assert r.content == b"\x00\x00"


def test_capacity_admission_default_on(monkeypatch):
    """Regression for the #1720 flag flip: capacity admission is ON by default
    (unset), stays ON for any value that isn't the explicit "0" opt-out, and
    only "0" turns it off (the rollback path)."""
    monkeypatch.delenv("SEG_CAPACITY_ADMISSION", raising=False)
    assert main._capacity_admission_enabled() is True
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    assert main._capacity_admission_enabled() is True
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "0")
    assert main._capacity_admission_enabled() is False


def test_synthesize_flag_on_no_capacity_returns_503(monkeypatch, synth_client):
    """Flag ON + a probe that can't fit the peak -> 503 noCapacity, engine
    never called."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [{"kind": "cuda", "index": 0, "label": "g", "totalMb": 8192, "freeMb": 50}],
    )
    r = synth_client.post("/synthesize", json=_synth_body())
    assert r.status_code == 503
    body = r.json()
    assert body["noCapacity"] is True
    assert body["neededMb"] > 0
    assert body["deviceKey"] == "cuda:0"


def test_synthesize_flag_on_fits_proceeds(monkeypatch, synth_client):
    """Flag ON + a roomy probe -> the reservation admits and /synthesize
    proceeds as normal."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [{"kind": "cuda", "index": 0, "label": "g", "totalMb": 16384, "freeMb": 16000}],
    )
    r = synth_client.post("/synthesize", json=_synth_body())
    assert r.status_code == 200
    assert r.content == b"\x00\x00"


# --- device-targeted idle_evict (#1721) ---


def test_same_card_normalises_and_rejects_off_card():
    """`_same_card` compares two concrete device strings by CUDA index only.
    Unindexed "cuda" is card 0 (torch default); cpu/mps/auto/None never match a
    GPU target — an engine off the target card holds no VRAM there to free."""
    assert main._same_card("cuda:1", "cuda:1") is True
    assert main._same_card("cuda", "cuda:0") is True  # unindexed -> card 0
    assert main._same_card("cuda:0", "cuda:1") is False
    assert main._same_card("cpu", "cuda:0") is False
    assert main._same_card("auto", "cuda:0") is False
    assert main._same_card(None, "cuda:0") is False


class _FakeEvictQwen(main.QwenEngine):
    """QwenEngine stand-in whose idle-evict methods just record they were
    called (real QwenEngine() construction is cheap — no model I/O). Both the
    VoiceDesign and 1.7B-Base models live on the shared `_device`, so one card
    string gates both."""

    name = "qwen"

    def __init__(self, device):
        super().__init__()
        self._device = device
        self._design = object()
        self._base17 = object()
        self.design_freed = 0
        self.base17_freed = 0

    def maybe_free_idle_design(self, ttl_seconds):
        self.design_freed += 1
        self._design = None
        return True

    def maybe_free_idle_base17(self, ttl_seconds):
        self.base17_freed += 1
        self._base17 = None
        return True


class _FakeEvictSingleton:
    """ASR / SPK stand-in: carries a resolved device attr (name differs — ASR
    uses `_device`, SPK uses `device`) and records `maybe_free_idle` calls."""

    def __init__(self, device_attr, device_val):
        setattr(self, device_attr, device_val)
        self.freed = 0

    def maybe_free_idle(self, ttl_seconds):
        self.freed += 1
        return True


def _wire_evict_engines(monkeypatch, qwen_dev, asr_dev, spk_dev):
    qwen = _FakeEvictQwen(qwen_dev)
    asr = _FakeEvictSingleton("_device", asr_dev)
    spk = _FakeEvictSingleton("device", spk_dev)
    monkeypatch.setitem(main.ENGINES, "qwen", qwen)
    monkeypatch.setattr(main, "ASR", asr)
    monkeypatch.setattr(main, "SPK", spk)
    return qwen, asr, spk


def test_idle_evict_only_frees_engines_on_target_card(monkeypatch):
    """Qwen on cuda:0, ASR on cuda:1, SPK on cuda:0. Admitting onto cuda:0 must
    free Qwen (design + base17) and SPK, but NOT ASR (different card) — the
    multi-GPU over-eviction #1721 fixes."""
    qwen, asr, spk = _wire_evict_engines(monkeypatch, "cuda:0", "cuda:1", "cuda:0")
    assert main._idle_evict("cuda:0") is True
    assert (qwen.design_freed, qwen.base17_freed) == (1, 1)
    assert spk.freed == 1
    assert asr.freed == 0  # resident on the OTHER card — left alone


def test_idle_evict_targets_the_other_card(monkeypatch):
    """Same layout, admitting onto cuda:1 instead: only ASR (the cuda:1
    resident) is freed; Qwen + SPK on cuda:0 are untouched."""
    qwen, asr, spk = _wire_evict_engines(monkeypatch, "cuda:0", "cuda:1", "cuda:0")
    assert main._idle_evict("cuda:1") is True
    assert asr.freed == 1
    assert (qwen.design_freed, qwen.base17_freed) == (0, 0)
    assert spk.freed == 0


def test_idle_evict_skips_cpu_resident_engines(monkeypatch):
    """An engine resident on cpu holds no VRAM on any GPU, so a GPU admission
    never evicts it (evicting would just cost a needless reload). ASR defaults
    to cpu — admitting onto cuda:0 must leave it alone."""
    qwen, asr, spk = _wire_evict_engines(monkeypatch, "cuda:0", "cpu", "cpu")
    assert main._idle_evict("cuda:0") is True  # qwen still freed
    assert asr.freed == 0
    assert spk.freed == 0


def test_idle_evict_unindexed_cuda_is_card_zero(monkeypatch):
    """A resident engine reporting bare "cuda" (no index) normalises to card 0,
    so it's freed for a cuda:0 admission and spared for cuda:1."""
    qwen, asr, spk = _wire_evict_engines(monkeypatch, "cuda", "cuda", "cuda")
    assert main._idle_evict("cuda:1") is False  # nothing on card 1
    assert (qwen.design_freed, spk.freed, asr.freed) == (0, 0, 0)
    assert main._idle_evict("cuda:0") is True
    assert (qwen.design_freed, qwen.base17_freed, asr.freed, spk.freed) == (1, 1, 1, 1)
