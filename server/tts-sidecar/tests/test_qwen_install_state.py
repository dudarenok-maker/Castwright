"""Qwen install-state probe coverage (Qwen-default plan, phase 0).

The probe distinguishes 'not-installed' (pip package absent) / 'weights-missing'
(package present, Base weights not downloaded) / 'ready' / 'loaded' so the Node
proxy can drive the conditional default (Qwen-when-installed) + the install-check
warning WITHOUT importing torch or loading a model. These tests pin the
side-effect-free derivation + the HF-cache weights scan, and that /health
surfaces the field.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Same sys.path bootstrap as the other test modules so `import main` works.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# ---- _qwen_install_state derivation (the 4-state contract) ------------------

@pytest.mark.parametrize(
    "loaded,pkg,weights,expected",
    [
        (True, True, True, "loaded"),
        (True, False, False, "loaded"),  # loaded wins regardless
        (False, False, False, "not-installed"),
        (False, True, False, "weights-missing"),
        (False, True, True, "ready"),
    ],
)
def test_install_state_derivation(monkeypatch, loaded, pkg, weights, expected):
    monkeypatch.setattr(main, "_qwen_package_installed", lambda: pkg)
    monkeypatch.setattr(main, "_qwen_weights_present", lambda: weights)
    assert main._qwen_install_state(loaded) == expected


# ---- _qwen_weights_present scans the HF cache for a real weight file --------

def _make_snapshot(cache_root: Path, *, filename: str) -> None:
    repo = "models--" + main.QwenEngine.BASE_MODEL.replace("/", "--")
    snap = cache_root / repo / "snapshots" / "rev1"
    snap.mkdir(parents=True, exist_ok=True)
    (snap / filename).write_bytes(b"\x00" * 16)


def test_weights_present_true_when_weight_file_in_cache(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    _make_snapshot(tmp_path, filename="model.safetensors")
    assert main._qwen_weights_present() is True


def test_weights_present_false_when_only_metadata(monkeypatch, tmp_path):
    # A half-finished download with just config.json must NOT read as ready.
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    _make_snapshot(tmp_path, filename="config.json")
    assert main._qwen_weights_present() is False


def test_weights_present_false_when_cache_empty(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    assert main._qwen_weights_present() is False


def test_hub_cache_dir_honours_env_precedence(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "explicit"))
    monkeypatch.setenv("HF_HOME", str(tmp_path / "home"))
    assert main._qwen_hub_cache_dir() == str(tmp_path / "explicit")
    monkeypatch.delenv("HF_HUB_CACHE")
    assert main._qwen_hub_cache_dir() == str(tmp_path / "home" / "hub")


# ---- package probe never throws ---------------------------------------------

def test_package_installed_returns_bool():
    # qwen_tts isn't installed in the CI/dev venv — the probe must return a
    # bool, never raise, regardless of presence.
    assert isinstance(main._qwen_package_installed(), bool)


# ---- /health surfaces the new fields ----------------------------------------

def test_health_includes_qwen_install_state(monkeypatch):
    monkeypatch.setattr(main, "_qwen_package_installed", lambda: True)
    monkeypatch.setattr(main, "_qwen_weights_present", lambda: True)
    # Pin load-state: a full real-weights run can leave the Base model resident
    # from a prior weights-gated test, which flips /health's install-state to
    # 'loaded'. Force not-resident so this test deterministically exercises the
    # 'ready' (pkg+weights present, cold) branch regardless of test order.
    qwen = main.ENGINES.get("qwen")
    if isinstance(qwen, main.QwenEngine):
        monkeypatch.setattr(qwen, "_base", None)
    client = TestClient(main.app)
    body = client.get("/health").json()
    assert body["qwen_install_state"] in ("not-installed", "weights-missing", "ready", "loaded")
    assert body["qwen_package_installed"] is True
    assert body["qwen_weights_present"] is True
    # Not loaded in a fresh test process → 'ready' (pkg+weights stubbed present).
    assert body["qwen_install_state"] == "ready"
