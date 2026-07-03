"""Plan 2 §2.5 — the sidecar WARNs at startup when CUDA_VISIBLE_DEVICES (or
CUDA_DEVICE_ORDER) is still set in the environment, since it silently
overrides every per-engine device pin set via the Advanced Configuration
picker (server-side Task 11 already surfaces this as `cudaEnvShadow` on
GET /api/config; this is the sidecar-side half — the startup log nudge)."""

import logging
import sys
from pathlib import Path

# Make the sidecar package importable: tests/ sits one level below main.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402


def test_startup_warns_when_cuda_visible_devices_still_set(monkeypatch, caplog):
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "1,0")
    caplog.set_level(logging.WARNING)
    main._warn_if_cuda_env_shadow_active()
    assert any("CUDA_VISIBLE_DEVICES" in r.message for r in caplog.records)


def test_startup_silent_when_cuda_visible_devices_unset(monkeypatch, caplog):
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    monkeypatch.delenv("CUDA_DEVICE_ORDER", raising=False)
    caplog.set_level(logging.WARNING)
    main._warn_if_cuda_env_shadow_active()
    assert not any("CUDA_VISIBLE_DEVICES" in r.message for r in caplog.records)
