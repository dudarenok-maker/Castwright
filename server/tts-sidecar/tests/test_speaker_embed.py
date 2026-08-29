import numpy as np
import pytest
import asyncio
import sys
import time
import types

import main


async def _noop_async(*a, **k):
    return None


def _sine_pcm(freq, sr=16000, secs=2.0):
    t = np.linspace(0, secs, int(sr * secs), endpoint=False)
    return (np.sin(2 * np.pi * freq * t) * 8000).astype("<i2").tobytes()


def test_embed_is_unit_norm_and_192d():
    pytest.importorskip("speechbrain")
    from main import SPK
    asyncio.run(SPK.ensure_loaded())  # embed() requires the model be loaded first
    emb = SPK.embed(_sine_pcm(180), 16000)
    assert len(emb) == 192
    assert abs(float(np.linalg.norm(emb)) - 1.0) < 1e-4


def test_self_cosine_is_one():
    pytest.importorskip("speechbrain")
    from main import SPK
    from spikes.srv36.metrics import cosine
    asyncio.run(SPK.ensure_loaded())  # embed() requires the model be loaded first
    pcm = _sine_pcm(180)
    assert cosine(SPK.embed(pcm, 16000), SPK.embed(pcm, 16000)) > 0.999


def test_embed_endpoint_raw_body(monkeypatch):
    from fastapi.testclient import TestClient
    import main
    monkeypatch.setattr(main.SPK, "embed", lambda pcm, sr: [0.0] * 192)
    monkeypatch.setattr(main.SPK, "ensure_loaded", _noop_async)
    client = TestClient(main.app)
    r = client.post("/embed", content=_sine_pcm(180), headers={"X-Sample-Rate": "16000"})
    assert r.status_code == 200
    body = r.json()
    assert body["dim"] == 192 and len(body["embedding"]) == 192
    assert body["sample_rate"] == 16000


class _FakeModel:
    """Stand-in for the ECAPA EncoderClassifier — embed() isn't exercised in
    these device/eviction tests, so a bare object suffices."""


def _install_speechbrain_stub(monkeypatch: pytest.MonkeyPatch, *, from_hparams) -> None:
    """Stub `speechbrain.inference.speaker.EncoderClassifier.from_hparams`."""
    mod_speechbrain = types.ModuleType("speechbrain")
    mod_inference = types.ModuleType("speechbrain.inference")
    mod_speaker = types.ModuleType("speechbrain.inference.speaker")

    class _EncoderClassifier:
        pass

    # Assign AFTER the class body — referencing the `from_hparams` param inside
    # the class body would shadow it (class-local) and raise NameError.
    _EncoderClassifier.from_hparams = staticmethod(from_hparams)

    mod_speaker.EncoderClassifier = _EncoderClassifier
    mod_inference.speaker = mod_speaker
    mod_speechbrain.inference = mod_inference
    monkeypatch.setitem(sys.modules, "speechbrain", mod_speechbrain)
    monkeypatch.setitem(sys.modules, "speechbrain.inference", mod_inference)
    monkeypatch.setitem(sys.modules, "speechbrain.inference.speaker", mod_speaker)


def _stub_torch_cuda(monkeypatch: pytest.MonkeyPatch, *, available: bool) -> None:
    """Make `torch.cuda.is_available()` deterministic for ensure_loaded."""
    fake_torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: available, empty_cache=lambda: None)
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)


# NOTE: the sidecar suite has no pytest-asyncio — drive coroutines with
# asyncio.run(...), the same way test_kokoro.py / test_memory.py do.


def test_degrade_when_cuda_unavailable(monkeypatch: pytest.MonkeyPatch):
    _install_speechbrain_stub(monkeypatch, from_hparams=lambda **kw: _FakeModel())
    _stub_torch_cuda(monkeypatch, available=False)
    eng = main.SpeakerEngine()
    eng.device = "cuda"
    asyncio.run(eng.ensure_loaded())
    assert eng.device == "cpu"
    assert eng._model is not None


def test_demote_on_non_poison_load_failure(monkeypatch: pytest.MonkeyPatch):
    calls: list[str] = []

    def from_hparams(**kw):
        dev = kw["run_opts"]["device"]
        calls.append(dev)
        if dev == "cuda":
            raise RuntimeError("cuDNN library mismatch")  # non-poison
        return _FakeModel()

    _install_speechbrain_stub(monkeypatch, from_hparams=from_hparams)
    _stub_torch_cuda(monkeypatch, available=True)
    eng = main.SpeakerEngine()
    eng.device = "cuda"
    asyncio.run(eng.ensure_loaded())
    assert eng.device == "cpu"
    assert eng._model is not None
    assert calls == ["cuda", "cpu"]  # tried cuda, fell back to cpu


def test_poison_load_failure_is_reraised(monkeypatch: pytest.MonkeyPatch):
    def from_hparams(**kw):
        raise RuntimeError("CUDA error: device-side assert triggered")

    _install_speechbrain_stub(monkeypatch, from_hparams=from_hparams)
    _stub_torch_cuda(monkeypatch, available=True)
    eng = main.SpeakerEngine()
    eng.device = "cuda"
    with pytest.raises(Exception) as ei:
        asyncio.run(eng.ensure_loaded())
    assert main._CUDA_POISON_RE.search(str(ei.value))
    assert eng._model is None  # nothing loaded


def test_spk_drop_model_locked_restores_device_pin_after_cpu_demotion():
    """#2750: a cuda->cpu self-demotion in `ensure_loaded` must NOT
    permanently overwrite an SPK_DEVICE=cuda pin. Before this fix,
    `_drop_model_locked` left `self.device` at "cpu" forever — the same
    defect class fixed for WhisperEngine (#2642), CoquiEngine (#1730 gap-3)
    and KokoroEngine (#2631 review S4)."""
    eng = main.SpeakerEngine()
    eng._requested_device = "cuda"
    eng.device = "cpu"  # simulates the post-demotion state from ensure_loaded
    eng._model = _FakeModel()

    with eng._infer_lock:
        dropped = eng._drop_model_locked()
    assert dropped is True
    assert eng.device == "cuda"


def test_maybe_free_idle_frees_and_restores_pin_on_demoted_engine(monkeypatch: pytest.MonkeyPatch):
    """#2750: once self-demoted, `self.device` reads "cpu" forever unless
    `maybe_free_idle`'s device-family gate also admits a demoted engine —
    otherwise teardown (and the pin restore inside it) can never run."""
    _stub_torch_cuda(monkeypatch, available=True)
    eng = main.SpeakerEngine()
    eng._requested_device = "cuda"
    eng.device = "cpu"  # demoted: device != _requested_device
    eng._model = _FakeModel()
    eng._last_used = time.monotonic() - 10_000  # very idle
    assert eng.maybe_free_idle(120.0) is True
    assert eng._model is None
    assert eng.device == "cuda"  # pin restored


def test_maybe_free_idle_noop_on_cpu(monkeypatch: pytest.MonkeyPatch):
    eng = main.SpeakerEngine()
    eng._requested_device = "cpu"  # pin to cpu; don't inherit from ambient SPK_DEVICE env
    eng.device = "cpu"
    eng._model = _FakeModel()
    eng._last_used = time.monotonic() - 10_000  # very idle
    assert eng.maybe_free_idle(120.0) is False
    assert eng._model is not None  # cpu never evicts


def test_maybe_free_idle_frees_on_cuda_after_ttl(monkeypatch: pytest.MonkeyPatch):
    _stub_torch_cuda(monkeypatch, available=True)
    eng = main.SpeakerEngine()
    eng.device = "cuda"
    eng._model = _FakeModel()
    eng._last_used = time.monotonic() - 10_000
    assert eng.maybe_free_idle(120.0) is True
    assert eng._model is None


def test_maybe_free_idle_frees_on_indexed_cuda(monkeypatch: pytest.MonkeyPatch):
    """SPK_DEVICE=cuda:1 keeps self.device == 'cuda:1'; the idle-evict guard must
    treat that as the cuda family (via _parse_device), or ECAPA never frees and
    SPK_IDLE_TTL is defeated on a pinned card."""
    _stub_torch_cuda(monkeypatch, available=True)
    eng = main.SpeakerEngine()
    eng.device = "cuda:1"
    eng._model = _FakeModel()
    eng._last_used = time.monotonic() - 10_000
    assert eng.maybe_free_idle(120.0) is True
    assert eng._model is None


def test_maybe_free_idle_not_demoted_on_admitted_indexed_load(monkeypatch: pytest.MonkeyPatch):
    """#2750: regression guard for family-aware demoted predicate.

    Defensive-correctness test: the demoted computation COULD theoretically
    diverge between a string-exact check ('cuda' != 'cuda:0' = True) and a
    family-aware check (cuda_fam == cuda_fam = False) when an indexed device
    is admitted. However, the gate logic `if not demoted and device_not_cuda:`
    produces the SAME outcome in all currently reachable states: because device
    IS cuda (family), the second part of the AND is False regardless of demoted's
    value. This test cannot currently fail (the demoted flag is never
    stat-differentiating).

    Kept as documentation that the family-aware fix is correct for any future
    architectural changes where the divergence could matter.
    """
    _stub_torch_cuda(monkeypatch, available=True)
    eng = main.SpeakerEngine()
    eng._requested_device = "cuda"  # env-derived, unindexed
    eng.device = "cuda:0"  # after capacity admission indexing
    eng._model = _FakeModel()
    eng._last_used = time.monotonic() - 10_000  # very idle
    # Evicts because it's idle cuda (demoted flag doesn't gate this path).
    assert eng.maybe_free_idle(120.0) is True
    assert eng._model is None
    assert eng.device == "cuda"  # pin restored to unindexed


def test_maybe_free_idle_keeps_recent_model(monkeypatch: pytest.MonkeyPatch):
    _stub_torch_cuda(monkeypatch, available=True)
    eng = main.SpeakerEngine()
    eng.device = "cuda"
    eng._model = _FakeModel()
    eng._last_used = time.monotonic()  # just used
    assert eng.maybe_free_idle(120.0) is False
    assert eng._model is not None


def test_spk_idle_ttl_default_and_floor(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SPK_IDLE_TTL", raising=False)
    assert main._spk_idle_ttl() == main._SPK_IDLE_TTL_DEFAULT
    monkeypatch.setenv("SPK_IDLE_TTL", "1")  # below the 5 s floor
    assert main._spk_idle_ttl() == main._SPK_IDLE_TTL_DEFAULT
    monkeypatch.setenv("SPK_IDLE_TTL", "300")
    assert main._spk_idle_ttl() == 300.0


def test_spk_idle_ttl_default_matches_registry():
    # Guard the R2-A invariant: registry sidecar.spkIdleTtl default == sidecar
    # default, or a default-config sidecar silently diverges from the UI.
    assert main._SPK_IDLE_TTL_DEFAULT == 120.0


def test_real_cuda_demotion_through_maybe_free_idle(monkeypatch: pytest.MonkeyPatch):
    """#2750: chain the real cuda->cpu self-demotion from ensure_loaded into
    maybe_free_idle, asserting the invariant end-to-end: a demoted engine
    correctly teardown restores the device pin and frees the model.

    This exercises the actual code path (not hand-assigned field values):
    1. ensure_loaded() triggers real demotion on a cuda load failure
    2. device is now "cpu" while _requested_device is "cuda"
    3. maybe_free_idle() detects the demoted state and tears down
    4. _drop_model_locked() restores device to _requested_device

    If a later change made ensure_loaded record the admitted card into
    _requested_device as well, demoted would become False and teardown
    would be unreachable — this test would catch that regression."""
    calls: list[str] = []

    def from_hparams(**kw):
        dev = kw["run_opts"]["device"]
        calls.append(dev)
        if dev == "cuda":
            raise RuntimeError("cuDNN library mismatch")  # non-poison, triggers demotion
        return _FakeModel()

    # Set SPK_DEVICE=cuda so _requested_device will be "cuda" at init time
    monkeypatch.setenv("SPK_DEVICE", "cuda")
    _install_speechbrain_stub(monkeypatch, from_hparams=from_hparams)
    _stub_torch_cuda(monkeypatch, available=True)

    # Create engine — _requested_device will be "cuda" from the env
    eng = main.SpeakerEngine()

    # Trigger real demotion via ensure_loaded
    asyncio.run(eng.ensure_loaded())

    # Verify demotion occurred: device is cpu but _requested_device is cuda
    assert eng.device == "cpu"
    assert eng._requested_device == "cuda"
    assert eng._model is not None
    assert calls == ["cuda", "cpu"]  # tried cuda, fell back to cpu

    # Mark it idle
    eng._last_used = time.monotonic() - 10_000

    # Call maybe_free_idle — should detect the demoted state and tear down
    freed = eng.maybe_free_idle(120.0)
    assert freed is True
    assert eng._model is None  # model was dropped
    assert eng.device == "cuda"  # device restored to _requested_device


def test_embed_load_poison_is_fenced(monkeypatch: pytest.MonkeyPatch):
    """A cuda LOAD poison must return 503/poisoned (not an unclassified 500),
    so the supervisor recycles the corrupt context."""
    from fastapi.testclient import TestClient  # import inside, like test_embed_endpoint_raw_body

    def from_hparams(**kw):
        raise RuntimeError("CUDA error: device-side assert triggered")

    _install_speechbrain_stub(monkeypatch, from_hparams=from_hparams)
    _stub_torch_cuda(monkeypatch, available=True)

    # Fresh engine on cuda; clear BOTH guard flags so the route reaches the
    # load (the recycle fence returns early on _restart_pending too).
    monkeypatch.setattr(main, "SPK", main.SpeakerEngine())
    main.SPK.device = "cuda"
    monkeypatch.setattr(main, "_process_poisoned", False, raising=False)
    monkeypatch.setattr(main, "_restart_pending", False, raising=False)
    monkeypatch.setattr(main, "_mark_cuda_poisoned", lambda reason: None)

    pcm = (b"\x00\x00" * 8)
    # Bare TestClient (no `with`) — matches this file's existing
    # test_embed_endpoint_raw_body; the route doesn't need lifespan, and bare
    # avoids running the startup preload/watchdog hooks.
    client = TestClient(main.app)
    res = client.post("/embed", content=pcm, headers={"X-Sample-Rate": "24000"})
    assert res.status_code == 503
    assert res.json().get("poisoned") is True
