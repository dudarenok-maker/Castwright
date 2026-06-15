"""side-14 — per-engine device ground-truth probe + /health composition."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Same sys.path bootstrap as the other test modules so `import main` works
# regardless of pytest's collection directory.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


class _StubCuda:
    def __init__(self, available: bool) -> None:
        self._available = available

    def is_available(self) -> bool:
        return self._available


class _StubMps:
    def __init__(self, available: bool) -> None:
        self._available = available

    def is_available(self) -> bool:
        return self._available


class _StubBackends:
    def __init__(self, mps_available: bool) -> None:
        self.mps = _StubMps(mps_available)


class _StubVersion:
    def __init__(self, hip: object = None, cuda: object = None) -> None:
        self.hip = hip
        self.cuda = cuda


class _StubTorch:
    def __init__(self, cuda: bool = False, mps: bool = False, hip: bool = False) -> None:
        # On a ROCm build torch.cuda.is_available() is True (HIP aliases CUDA) and
        # torch.version.hip is set; on a CUDA build version.hip is None.
        self.cuda = _StubCuda(cuda)
        self.backends = _StubBackends(mps)
        self.version = _StubVersion(
            hip="6.4.4" if hip else None, cuda=None if hip else "12.8"
        )


class _StubOrt:
    def __init__(self, providers: list[str]) -> None:
        self._providers = providers

    def get_available_providers(self) -> list[str]:
        return self._providers


def test_normalize_device_family() -> None:
    assert main._normalize_device_family("cuda:0") == "cuda"
    assert main._normalize_device_family("cuda:1") == "cuda"
    assert main._normalize_device_family("mps") == "mps"
    assert main._normalize_device_family("CPU") == "cpu"
    assert main._normalize_device_family("auto") is None  # unresolved pref is not truth
    assert main._normalize_device_family(None) is None
    assert main._normalize_device_family("") is None


def test_predictions_cuda_box() -> None:
    out = main._compute_device_predictions(
        _StubTorch(cuda=True), _StubOrt(["CUDAExecutionProvider", "CPUExecutionProvider"])
    )
    assert out == {"kokoro": "cuda", "coqui": "cuda", "qwen": "cuda"}


def test_normalize_device_family_hip_build_reports_rocm() -> None:
    """A HIP torch build reports 'cuda' device strings but is really ROCm."""
    assert main._normalize_device_family("cuda:0", _StubTorch(cuda=True, hip=True)) == "rocm"
    assert main._normalize_device_family("cuda:0", _StubTorch(cuda=True)) == "cuda"
    # No torch module → can't tell HIP from CUDA; stays cuda (back-compat).
    assert main._normalize_device_family("cuda") == "cuda"


def test_predict_kokoro_device_directml_and_rocm() -> None:
    assert (
        main._predict_kokoro_device(_StubOrt(["DmlExecutionProvider", "CPUExecutionProvider"]))
        == "directml"
    )
    assert (
        main._predict_kokoro_device(_StubOrt(["ROCMExecutionProvider", "CPUExecutionProvider"]))
        == "rocm"
    )
    assert main._predict_kokoro_device(_StubOrt(["CUDAExecutionProvider"])) == "cuda"
    assert main._predict_kokoro_device(_StubOrt(["CPUExecutionProvider"])) == "cpu"


def test_predictions_amd_rocm_box() -> None:
    """AMD-Windows: Qwen/Coqui ride ROCm (torch HIP build), Kokoro DirectML."""
    out = main._compute_device_predictions(
        _StubTorch(cuda=True, hip=True),
        _StubOrt(["DmlExecutionProvider", "CPUExecutionProvider"]),
    )
    assert out == {"kokoro": "directml", "coqui": "rocm", "qwen": "rocm"}


def test_predictions_apple_silicon() -> None:
    """The headline case: Qwen rides Metal, Coqui/Kokoro honestly report CPU."""
    out = main._compute_device_predictions(_StubTorch(mps=True), _StubOrt(["CPUExecutionProvider"]))
    assert out == {"kokoro": "cpu", "coqui": "cpu", "qwen": "mps"}


def test_predictions_cpu_only() -> None:
    out = main._compute_device_predictions(_StubTorch(), _StubOrt(["CPUExecutionProvider"]))
    assert out == {"kokoro": "cpu", "coqui": "cpu", "qwen": "cpu"}


def test_predictions_explicit_pin_normalised(monkeypatch) -> None:
    qwen = main.ENGINES.get("qwen")
    monkeypatch.setattr(qwen, "_device_pref", "cuda:1")
    out = main._compute_device_predictions(_StubTorch(cuda=True), _StubOrt([]))
    assert out["qwen"] == "cuda"


def test_predictions_without_torch_still_predict_kokoro() -> None:
    out = main._compute_device_predictions(None, _StubOrt(["CUDAExecutionProvider"]))
    assert out["kokoro"] == "cuda"
    assert out["coqui"] is None
    assert out["qwen"] is None


def test_predictions_ort_failure_is_tolerated() -> None:
    class _BrokenOrt:
        def get_available_providers(self):  # noqa: ANN201
            raise RuntimeError("ort exploded")

    out = main._compute_device_predictions(_StubTorch(cuda=True), _BrokenOrt())
    assert out["kokoro"] == "cpu"  # degrade, never raise


from fastapi.testclient import TestClient  # noqa: E402


def _health(monkeypatch=None) -> dict:
    client = TestClient(main.app)
    res = client.get("/health")
    assert res.status_code == 200
    return res.json()


def test_health_pending_before_probe(monkeypatch) -> None:
    monkeypatch.setattr(main, "_device_probe", {"kokoro": None, "coqui": None, "qwen": None})
    monkeypatch.setattr(main, "_device_probe_state", "pending")
    body = _health()
    assert body["devices"] == {"kokoro": None, "coqui": None, "qwen": None}
    assert body["devices_state"] == "pending"


def test_health_reports_probe_result(monkeypatch) -> None:
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": "cpu", "qwen": "mps"}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    body = _health()
    assert body["devices"] == {"kokoro": "cpu", "coqui": "cpu", "qwen": "mps"}
    assert body["devices_state"] == "ready"
    # legacy field untouched (Coqui not loaded)
    assert body["device"] is None


def test_health_loaded_coqui_overrides_prediction(monkeypatch) -> None:
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": "cpu", "qwen": None}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    coqui = main.ENGINES["coqui"]
    monkeypatch.setattr(coqui, "_tts", object())
    monkeypatch.setattr(coqui, "_resolved_device", "cuda")
    body = _health()
    assert body["devices"]["coqui"] == "cuda"   # actual beats prediction
    assert body["device"] == "cuda"             # legacy field still works


def test_health_unloaded_coqui_falls_back_to_prediction(monkeypatch) -> None:
    """unload() resets _resolved_device to 'cpu' — that stale value must NOT
    masquerade as ground truth; the prediction takes back over."""
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cuda", "coqui": "cuda", "qwen": "cuda"}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    coqui = main.ENGINES["coqui"]
    monkeypatch.setattr(coqui, "_tts", None)
    monkeypatch.setattr(coqui, "_resolved_device", "cpu")
    body = _health()
    assert body["devices"]["coqui"] == "cuda"


def test_health_loaded_qwen_reports_actual_device(monkeypatch) -> None:
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": "cpu", "qwen": "cpu"}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    qwen = main.ENGINES["qwen"]
    monkeypatch.setattr(qwen, "_base", object())
    monkeypatch.setattr(qwen, "_device", "mps")
    body = _health()
    assert body["devices"]["qwen"] == "mps"


def test_health_loaded_qwen_unresolved_device_falls_back(monkeypatch) -> None:
    """A loaded Qwen whose _device somehow still reads 'auto' must not leak
    'auto' to the wire — normaliser maps it to None → prediction wins."""
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": "cpu", "qwen": "cuda"}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    qwen = main.ENGINES["qwen"]
    monkeypatch.setattr(qwen, "_base", object())
    monkeypatch.setattr(qwen, "_device", "auto")
    body = _health()
    assert body["devices"]["qwen"] == "cuda"


def test_health_loaded_kokoro_reads_session_providers(monkeypatch) -> None:
    class _Sess:
        def get_providers(self) -> list[str]:
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]

    class _FakeKokoro:
        sess = _Sess()

    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": None, "qwen": None}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    kokoro = main.ENGINES["kokoro"]
    monkeypatch.setattr(kokoro, "_kokoro", _FakeKokoro())
    body = _health()
    assert body["devices"]["kokoro"] == "cuda"


def test_health_kokoro_session_api_drift_falls_back(monkeypatch) -> None:
    class _NoSessKokoro:
        pass  # no .sess attribute — simulated kokoro-onnx API drift

    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cuda", "coqui": None, "qwen": None}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    kokoro = main.ENGINES["kokoro"]
    monkeypatch.setattr(kokoro, "_kokoro", _NoSessKokoro())
    body = _health()
    assert body["devices"]["kokoro"] == "cuda"  # prediction survives drift


def test_run_device_probe_without_torch_sets_error_state(monkeypatch) -> None:
    """Direct probe-body test: a box where torch can't import must land
    devices_state='error' on the wire (the frontend keys its fallback off this)
    — and the probe must swallow the failure rather than raise. A None entry in
    sys.modules makes `import torch` raise ImportError inside the probe."""
    monkeypatch.setitem(sys.modules, "torch", None)
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": None, "coqui": None, "qwen": None}
    )
    monkeypatch.setattr(main, "_device_probe_state", "pending")
    main._run_device_probe()  # must not raise
    assert main._device_probe_state == "error"
    # Torch-dependent slots stay null; kokoro may still resolve via the real
    # onnxruntime in the venv (machine-dependent), so only its presence is pinned.
    assert main._device_probe["coqui"] is None
    assert main._device_probe["qwen"] is None
    assert "kokoro" in main._device_probe
    body = _health()
    assert body["devices_state"] == "error"
