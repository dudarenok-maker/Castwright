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
    """Kokoro engine, real post-#2631-B3-fix shape: KOKORO_DEVICE=cuda:1 (the
    pristine `_requested_device`), a plain env-derived load so `_device` still
    reads that same intent ('cuda:1') — but the ORT session actually resolved
    to CPU-only providers, so ground truth (`_resolved_device`, set from the
    session at publish time — see `KokoroEngine._ensure_loaded`) disagrees
    with the intent string. A real KokoroEngine has all three attrs since the
    B2/B3 fix; the pre-fix double here had NONE of them ('No device/_device/
    _model attrs — mirrors a real KokoroEngine'), which was false as of
    #2631's B1/S4 commit and is why this regression test stayed green
    against code where the reconcile it exists to pin was silenced (#2631
    review B3)."""
    sess = types.SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider"])
    kok = types.SimpleNamespace(sess=sess)
    return types.SimpleNamespace(
        _requested_device="cuda:1", _device="cuda:1", _resolved_device="cpu", _kokoro=kok)


def _fake_kokoro_cuda_session():
    """Kokoro engine: requested cuda:0, ORT kept the CUDA EP — intent and
    ground truth agree."""
    sess = types.SimpleNamespace(get_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"])
    kok = types.SimpleNamespace(sess=sess)
    return types.SimpleNamespace(
        _requested_device="cuda:0", _device="cuda:0", _resolved_device="cuda", _kokoro=kok)


def _fake_kokoro_admitted_cpu_session():
    """Kokoro engine: KOKORO_DEVICE=cuda:1 (`_requested_device`, the pristine
    env pin), but THIS load was admitted onto cpu by the VRAM ledger under
    contention — `_device` (the per-load decision) diverges from
    `_requested_device` and reads 'cpu', not 'cuda:1'. The ORT session agrees
    (`_resolved_device` == 'cpu' too): this load asked for cpu and got cpu.
    Distinct from `_fake_kokoro_cpu_session`, where `_device` still reads the
    (stale) 'cuda:1' intent because the ORT fallback there is silent/
    unrequested, not admission-driven."""
    sess = types.SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider"])
    kok = types.SimpleNamespace(sess=sess)
    return types.SimpleNamespace(
        _requested_device="cuda:1", _device="cpu", _resolved_device="cpu", _kokoro=kok)


def test_engine_actual_card_kokoro_cuda_to_cpu_provider_drop_flags_fell_back():
    # Regression: tier-2 _parse_device(None) returns "auto", not None, so the
    # tier-3 guard `if family is None:` was False and the Kokoro reconcile was
    # unreachable. Fix: guard must be `if family in (None, "auto"):`.
    #
    # Also pins #2631 review B3: `_device` here reads 'cuda:1' (the stale
    # intent) — if `_engine_actual_card` read `_device` before
    # `_resolved_device`, this would wrongly report family='cuda',
    # fell_back=False. It must prefer `_resolved_device` ('cpu', the ORT
    # ground truth) instead.
    card = main._engine_actual_card(_fake_kokoro_cpu_session())
    assert card["family"] == "cpu"
    assert card["index"] is None
    assert card["fell_back"] is True


def test_engine_actual_card_kokoro_cuda_resident_no_fallback():
    card = main._engine_actual_card(_fake_kokoro_cuda_session())
    assert card["family"] == "cuda"
    assert card["index"] is None
    assert card["fell_back"] is False


def test_engine_actual_card_kokoro_admitted_cpu_is_not_fell_back():
    # #2647 supersedes #2631 review B3's semantics here. B3 read `_device`
    # ('cpu', the per-load decision) as diverging from `_requested_device`
    # ('cuda:1', the pristine env pin) and flagged that divergence itself as
    # `fell_back` — "the operator asked for cuda, this session is on cpu."
    # #2647 is why that reading doesn't hold: on the shipped default
    # (KOKORO_DEVICE unset), `_requested_device` never leaves "auto", so a
    # detector keyed on it can never fire in production regardless of what
    # the VRAM ledger admits — the actual regression this ticket exists to
    # fix. The corrected comparison is THIS LOAD's own intent (`_device`,
    # which the admission already overwrote to 'cpu' before the load ran)
    # against what actually happened (`_resolved_device`, also 'cpu') — they
    # AGREE: this load asked for cpu (the ledger's own capacity-driven
    # decision, not a silent failure) and got cpu. That is compliance, not a
    # fallback, so `fell_back` must be False. The badge exists to catch a
    # load whose OWN intent was cuda but which silently landed on cpu anyway
    # — see `_fake_kokoro_cpu_session` above for that shape, which still
    # correctly flags True.
    card = main._engine_actual_card(_fake_kokoro_admitted_cpu_session())
    assert card["family"] == "cpu"
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


def test_health_cuda_verified_fields_additive(monkeypatch):
    """Castwright#2709: /health exposes cuda_verified/cuda_verification_detail
    alongside the existing devices/gpus keys, without disturbing them. On a
    box that never triggered a real Kokoro load these read None/None -- the
    honest steady-state, not a bug."""
    from fastapi.testclient import TestClient
    monkeypatch.setattr(main, "_build_gpus_payload", lambda torch_module=None: [])
    monkeypatch.setattr(
        main, "_cuda_verification_state",
        {"verified": None, "detail": None},
    )
    client = TestClient(main.app)
    body = client.get("/health").json()
    assert "cuda_verified" in body
    assert "cuda_verification_detail" in body
    assert body["cuda_verified"] is None
    assert body["cuda_verification_detail"] is None
    # Additive contract: pre-existing keys untouched
    assert "devices" in body
    assert "gpus" in body


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


# ── review round (#2643 follow-up): Qwen/Whisper requested_fam dispatch, and
# `_is_resident` under an honest "unknown" family ──

def test_engine_actual_card_qwen_real_wrapper_shape_never_flags_fell_back():
    """The REAL qwen_tts `Qwen3TTSModel` wrapper (what QwenEngine._base/_base17/
    _design all hold) has no `.parameters()` method (verified against the
    installed qwen_tts package) — so the top-of-function torch introspection
    never reaches it, and `family` falls through to the SAME `_device` string
    `requested_fam` also reads. The two are therefore structurally equal on
    every real Qwen load, however `_device` is set: this pins that a "cuda"
    intent can never be flagged `fell_back` for Qwen's actual object shape."""
    class RealShapeQwenWrapper:
        pass  # no .parameters() — matches qwen_tts.Qwen3TTSModel exactly

    eng = types.SimpleNamespace(_device="cuda:0", _base=RealShapeQwenWrapper())
    card = main._engine_actual_card(eng)
    assert card["family"] == "cuda"
    assert card["fell_back"] is False


def test_engine_actual_card_qwen_would_flag_fell_back_if_model_exposed_parameters():
    """Control for the test above: the comparison itself is live, not dead
    code — if the held model DID expose `.parameters()` (a future qwen_tts
    API change) and it disagreed with `_device`'s cuda intent, the existing
    torch-introspection branch picks it up and flags `fell_back` exactly like
    Coqui/Kokoro. Today's no-op is a property of the wrapper's shape, not of
    this comparison being unreachable."""
    class HypotheticalWrapperWithParams:
        def parameters(self):
            yield types.SimpleNamespace(device=types.SimpleNamespace(type="cpu", index=None))

    eng = types.SimpleNamespace(_device="cuda:0", _base=HypotheticalWrapperWithParams())
    card = main._engine_actual_card(eng)
    assert card["family"] == "cpu"
    assert card["fell_back"] is True


def test_engine_actual_card_whisper_uses_requested_device_not_mutable_device():
    """Regression: WhisperEngine has a `_device` attribute (unlike SPK), so a
    bare `hasattr(engine, "_device")` dispatch wrongly routed it to the same
    branch as Coqui/Kokoro/Qwen. But Whisper's `_device` is overwritten with
    THIS LOAD's own actual placement at the end of `_ensure_loaded` (no
    separate `_resolved_device` ground truth exists) — comparing it to
    itself is tautological and can never flag a fallback. A real
    WhisperEngine instance (isinstance check, not a SimpleNamespace double)
    with a pristine cuda intent (`_requested_device`, frozen at __init__)
    that later landed on cpu (`_device`, mutated) must still be flagged.
    Note: this fixture is deliberately synthetic. No production path currently
    reaches a divergence between Whisper's requested and actual devices,
    because /transcribe passes cpu_capable=False, so admission returns either
    a GPU key or noCapacity. This test guards against a future regression."""
    eng = main.WhisperEngine()
    eng._requested_device = "cuda"
    eng._device = "cpu"
    eng._model = object()
    card = main._engine_actual_card(eng)
    assert card["family"] == "cpu"
    assert card["fell_back"] is True


def test_engine_actual_card_whisper_matching_intent_is_not_fell_back():
    """Companion to the above: when Whisper's frozen intent and its current
    `_device` agree, no false positive."""
    eng = main.WhisperEngine()
    eng._requested_device = "cuda"
    eng._device = "cuda:0"
    eng._model = object()
    card = main._engine_actual_card(eng)
    assert card["family"] == "cuda"
    assert card["fell_back"] is False


def test_whisper_drop_model_locked_restores_device_pin_after_cpu_admission(monkeypatch):
    """#2642: a CPU admission (`_ensure_loaded(device="cpu")`) must NOT
    permanently overwrite an ASR_DEVICE=cuda pin. Before this fix,
    `_drop_model_locked` left `self._device` at whatever `_ensure_loaded`
    last resolved it to, so a CPU-admitted load stuck there until process
    restart — the same defect class fixed for CoquiEngine (#1730 gap-3) and
    KokoroEngine (#2631 review S4)."""
    monkeypatch.setenv("ASR_DEVICE", "cuda:0")

    class _FakeWhisperModel:
        def __init__(self, model_name, **kwargs):
            pass

    fake_mod = types.ModuleType("faster_whisper")
    fake_mod.WhisperModel = _FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_mod)

    engine = main.WhisperEngine()
    assert engine._requested_device == "cuda:0"

    # Admission ledger refuses the GPU for this cold load.
    engine._ensure_loaded(device="cpu")
    assert engine._device == "cpu"

    with engine._infer_lock:
        dropped = engine._drop_model_locked()
    assert dropped is True
    assert engine._device == "cuda:0"


def test_is_resident_falls_back_to_intent_when_actual_card_unknown(monkeypatch):
    """#2647 companion fix (Kokoro's `_resolved_device` init sentinel moved
    `None` -> "unknown", not "cpu") made an honest "unknown" family reachable
    for a genuinely GPU-resident engine (ORT session read failed under
    kokoro-onnx API drift). `_is_resident` must not drop the residency
    constraint just because the actual-card probe couldn't confirm it —
    PlacementController still needs to know this card is occupied."""
    monkeypatch.setattr(main, "_engine_actual_card",
        lambda e: {"family": "unknown", "index": None, "fell_back": False})
    eng = types.SimpleNamespace(_device="cuda:0")
    monkeypatch.setitem(main.ENGINES, "kokoro", eng)
    assert main._is_resident("kokoro") == "cuda:0"


def test_is_resident_stays_none_when_unknown_and_no_gpu_intent(monkeypatch):
    """Companion control: an "unknown" actual card with no cuda/rocm intent
    behind it (e.g. genuinely unloaded, or a cpu/auto pin) must still report
    not-resident — the fallback above is scoped to a real GPU intent only."""
    monkeypatch.setattr(main, "_engine_actual_card",
        lambda e: {"family": "unknown", "index": None, "fell_back": False})
    eng = types.SimpleNamespace(_device="auto")
    monkeypatch.setitem(main.ENGINES, "kokoro", eng)
    assert main._is_resident("kokoro") is None


def test_is_resident_retags_to_rocm_on_a_rocm_box(monkeypatch):
    """#2813 review finding 2: a loaded engine's own `self._device`/`.device`
    is now ALWAYS normalised to torch-native "cuda:N" (this PR's fix —
    torch/CT2/speechbrain don't understand "rocm:N" — so it can never
    literally hold "rocm:N" any more, the way it used to before #2813). On a
    real ROCm box, `_engine_actual_card`'s `family` therefore reads "cuda"
    even for a genuinely ROCm-resident engine — but the admission ledger's
    own candidate keys (`PlacementController._device_key`) are "rocm:N"
    there, so an un-retagged "cuda:N" residency key could never match one:
    a resident engine's OWN next admission would report permanent
    `noCapacity` against the very card it is already loaded on."""
    monkeypatch.setattr(main, "_cuda_is_rocm", lambda: True)
    monkeypatch.setattr(main, "_engine_actual_card",
        lambda e: {"family": "cuda", "index": 0, "fell_back": False})
    eng = types.SimpleNamespace(_device="cuda:0")
    monkeypatch.setitem(main.ENGINES, "coqui", eng)
    assert main._is_resident("coqui") == "rocm:0"


def test_is_resident_unknown_fallback_retags_to_rocm_on_a_rocm_box(monkeypatch):
    """Companion to the test above, for the "unknown" actual-card fallback
    branch (#2647): the intent-derived key must be retagged too, not just
    the main branch."""
    monkeypatch.setattr(main, "_cuda_is_rocm", lambda: True)
    monkeypatch.setattr(main, "_engine_actual_card",
        lambda e: {"family": "unknown", "index": None, "fell_back": False})
    eng = types.SimpleNamespace(_device="cuda:0")
    monkeypatch.setitem(main.ENGINES, "kokoro", eng)
    assert main._is_resident("kokoro") == "rocm:0"


def test_is_resident_stays_cuda_on_a_real_cuda_box(monkeypatch):
    """Companion control: the retag must not fire on a genuinely NVIDIA box
    — the overwhelming majority of installs — so a resident engine's key
    stays exactly "cuda:N", unchanged, when `_cuda_is_rocm()` is False."""
    monkeypatch.setattr(main, "_cuda_is_rocm", lambda: False)
    monkeypatch.setattr(main, "_engine_actual_card",
        lambda e: {"family": "cuda", "index": 0, "fell_back": False})
    eng = types.SimpleNamespace(_device="cuda:0")
    monkeypatch.setitem(main.ENGINES, "coqui", eng)
    assert main._is_resident("coqui") == "cuda:0"


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


def test_same_card_matches_a_rocm_native_target():
    """#2813 review finding 7: `target` is ALWAYS a probe-derived key
    (`_worst_device_key`/`_device_key`), which reads "rocm:N" on a ROCm/HIP
    box — but a resident engine's own device string is torch-native
    "cuda:N" (this PR's own forward fix guarantees it always is, except the
    documented Kokoro exception). Before the fix, `_same_card`'s hard
    `family != "cuda"` gate rejected a "rocm:N" target outright, so it could
    NEVER match ANY resident engine on a real ROCm box — the entire
    idle-eviction ladder silently emptied and every admission needing an
    eviction fell straight to `noCapacity`. Index preservation and the
    off-card/family-mismatch rejections above must hold in both directions."""
    assert main._same_card("cuda:0", "rocm:0") is True
    assert main._same_card("cuda:1", "rocm:1") is True
    assert main._same_card("cuda:0", "rocm:1") is False
    assert main._same_card("rocm:0", "cuda:0") is True  # Kokoro's own exception (finding 9)
    assert main._same_card("rocm:0", "rocm:0") is True
    assert main._same_card("cpu", "rocm:0") is False
    assert main._same_card(None, "rocm:0") is False


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


class _FakeEvictCoqui(main.CoquiEngine):
    """CoquiEngine stand-in whose `maybe_free_idle` just records it was
    called (real CoquiEngine() construction is cheap — no model I/O). Must
    subclass CoquiEngine, not just duck-type its surface: `_idle_evict_steps`'s
    Coqui branch is `isinstance`-guarded (#1894 review) the same way its Qwen
    sibling already was."""

    def __init__(self, device):
        super().__init__()
        self._device = device
        self.freed = 0
        self.ttls = []

    def maybe_free_idle(self, ttl_seconds):
        self.freed += 1
        self.ttls.append(ttl_seconds)
        return True


def _wire_evict_engines(monkeypatch, qwen_dev, asr_dev, spk_dev, coqui_dev="cpu"):
    qwen = _FakeEvictQwen(qwen_dev)
    asr = _FakeEvictSingleton("_device", asr_dev)
    spk = _FakeEvictSingleton("device", spk_dev)
    coqui = _FakeEvictCoqui(coqui_dev)
    monkeypatch.setitem(main.ENGINES, "qwen", qwen)
    monkeypatch.setitem(main.ENGINES, "coqui", coqui)
    monkeypatch.setattr(main, "ASR", asr)
    monkeypatch.setattr(main, "SPK", spk)
    return qwen, asr, spk, coqui


def _run(device_key, engine):
    """Build the steps, assert on their names, then RUN them — the builder
    never invokes the lambdas, so the existing per-engine call counters and
    the TTL assertion only mean anything if we drive them here."""
    steps = main._idle_evict_steps(device_key, engine)
    names = [s.name for s in steps]
    freed = any([s.run() for s in steps])  # list, not generator — no short-circuit
    return names, freed


def test_idle_evict_only_frees_engines_on_target_card(monkeypatch):
    """Qwen on cuda:0, ASR on cuda:1, SPK on cuda:0. Admitting onto cuda:0 must
    free Qwen (design + base17) and SPK, but NOT ASR (different card) — the
    multi-GPU over-eviction #1721 fixes."""
    qwen, asr, spk, coqui = _wire_evict_engines(monkeypatch, "cuda:0", "cuda:1", "cuda:0")
    names, freed = _run("cuda:0", "qwen")
    assert "qwen.design" in names and "qwen.base17" in names
    assert "spk" in names
    assert "asr" not in names  # resident on the OTHER card — no step built
    assert freed is True
    assert (qwen.design_freed, qwen.base17_freed) == (1, 1)
    assert spk.freed == 1
    assert asr.freed == 0  # resident on the OTHER card — left alone


def test_idle_evict_targets_the_other_card(monkeypatch):
    """Same layout, admitting onto cuda:1 instead: only ASR (the cuda:1
    resident) is freed; Qwen + SPK on cuda:0 are untouched."""
    qwen, asr, spk, coqui = _wire_evict_engines(monkeypatch, "cuda:0", "cuda:1", "cuda:0")
    names, freed = _run("cuda:1", "qwen")
    assert names == ["asr"]
    assert freed is True
    assert asr.freed == 1
    assert (qwen.design_freed, qwen.base17_freed) == (0, 0)
    assert spk.freed == 0


def test_idle_evict_skips_cpu_resident_engines(monkeypatch):
    """An engine resident on cpu holds no VRAM on any GPU, so a GPU admission
    never evicts it (evicting would just cost a needless reload). ASR defaults
    to cpu — admitting onto cuda:0 must leave it alone."""
    qwen, asr, spk, coqui = _wire_evict_engines(monkeypatch, "cuda:0", "cpu", "cpu")
    names, freed = _run("cuda:0", "qwen")
    assert "qwen.design" in names and "qwen.base17" in names  # qwen still freed
    assert "asr" not in names
    assert "spk" not in names
    assert freed is True
    assert asr.freed == 0
    assert spk.freed == 0


def test_idle_evict_unindexed_cuda_is_card_zero(monkeypatch):
    """A resident engine reporting bare "cuda" (no index) normalises to card 0,
    so it's freed for a cuda:0 admission and spared for cuda:1."""
    qwen, asr, spk, coqui = _wire_evict_engines(monkeypatch, "cuda", "cuda", "cuda")
    names, freed = _run("cuda:1", "qwen")
    assert names == []  # nothing on card 1
    assert freed is False
    assert (qwen.design_freed, spk.freed, asr.freed) == (0, 0, 0)
    names, freed = _run("cuda:0", "qwen")
    assert freed is True
    assert (qwen.design_freed, qwen.base17_freed, asr.freed, spk.freed) == (1, 1, 1, 1)


def test_idle_evict_frees_engines_against_a_rocm_native_target(monkeypatch):
    """#2813 review finding 7, end-to-end mirror of the reviewer's own
    repro: `_idle_evict_steps` is always called with a PROBE-derived target
    (`_worst_device_key`), which reads "rocm:N" on a ROCm/HIP box, while a
    resident engine's own device string is torch-native "cuda:0" (this PR's
    forward fix). Before the fix, `_same_card`'s hard "cuda"-only gate meant
    the ladder was silently empty for EVERY resident engine on that
    hardware -- an admission that could have been rescued by freeing an
    idle model fell straight to `noCapacity` instead. Qwen/SPK genuinely
    resident on card 0 (torch-native "cuda:0"); admitting against the
    probe's own "rocm:0" target must still find and free them."""
    qwen, asr, spk, coqui = _wire_evict_engines(monkeypatch, "cuda:0", "cuda:1", "cuda:0")
    names, freed = _run("rocm:0", "qwen")
    assert "qwen.design" in names and "qwen.base17" in names
    assert "spk" in names
    assert "asr" not in names  # resident on the OTHER card — still correctly excluded
    assert freed is True
    assert (qwen.design_freed, qwen.base17_freed) == (1, 1)
    assert spk.freed == 1
    assert asr.freed == 0


def test_idle_evict_frees_an_idle_coqui_on_the_target_card(monkeypatch):
    """#1894 — a starved non-Coqui op reclaims a resident, idle XTTS."""
    _q, _a, _s, coqui = _wire_evict_engines(monkeypatch, "cpu", "cpu", "cpu", coqui_dev="cuda:0")
    names, freed = _run("cuda:0", "qwen")
    assert "coqui" in names
    assert freed is True
    assert coqui.freed == 1
    assert coqui.ttls == [main._coqui_idle_ttl()]


def test_idle_evict_skips_coqui_on_another_card(monkeypatch):
    _q, _a, _s, coqui = _wire_evict_engines(monkeypatch, "cpu", "cpu", "cpu", coqui_dev="cuda:1")
    names, freed = _run("cuda:0", "qwen")
    assert names == []
    assert freed is False
    assert coqui.freed == 0


def test_idle_evict_never_evicts_coqui_for_a_coqui_op(monkeypatch):
    """Coqui is a PRIMARY engine, unlike the transient models beside it here:
    evicting it for a starved Coqui op would unload the very model that op is
    about to reload. Admission gives a resident engine no free pass, so this
    is reachable."""
    _q, _a, _s, coqui = _wire_evict_engines(monkeypatch, "cpu", "cpu", "cpu", coqui_dev="cuda:0")
    names, freed = _run("cuda:0", "coqui")
    assert "coqui" not in names  # self-eviction guard — no step built at all
    assert freed is False
    assert coqui.freed == 0


def test_coqui_idle_ttl_defaults_and_floors(monkeypatch):
    monkeypatch.delenv("COQUI_IDLE_TTL", raising=False)
    assert main._coqui_idle_ttl() == 30.0
    monkeypatch.setenv("COQUI_IDLE_TTL", "90")
    assert main._coqui_idle_ttl() == 90.0
    monkeypatch.setenv("COQUI_IDLE_TTL", "1")  # below the 5s floor -> default
    assert main._coqui_idle_ttl() == 30.0
    monkeypatch.setenv("COQUI_IDLE_TTL", "not-a-number")
    assert main._coqui_idle_ttl() == 30.0
