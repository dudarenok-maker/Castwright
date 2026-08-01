"""pytest config: never load the real Coqui model during tests.

`PRELOAD_COQUI=0` short-circuits the FastAPI startup hook in main.py — the
tests stub `ENGINES` with a lightweight fake instead. Without this guard, any
test that imports `main` would hit the 30-60s model load on first run and
fail on CI machines without a configured venv."""
import os

os.environ.setdefault("PRELOAD_COQUI", "0")

# COQUI_PIN_IMPORT_ORDER (main.py's `_pin_coqui_import_order`, #1944) defaults
# ON in production — unlike PRELOAD_COQUI, it unconditionally does a real
# `import TTS.api` at startup regardless of whether Coqui is ever used, which
# would slow down every test that spins up the real FastAPI lifespan via
# TestClient. Default it OFF suite-wide, same rationale as PRELOAD_COQUI
# above; the dedicated pin tests opt back in explicitly.
os.environ.setdefault("COQUI_PIN_IMPORT_ORDER", "0")

# The Qwen output-degeneracy guard (main.py `_QWEN_DEGEN_GUARD_ENABLED`) inspects
# real synth-output length; the suite's minimal fakes emit non-realistic audio
# (fixed tiny buffers / marker-length arrays) that would read as degenerate and
# trip the reload+self-recycle path. Default it OFF suite-wide — the dedicated
# regression test (test_qwen_degeneracy_guard.py) re-enables it explicitly.
os.environ.setdefault("QWEN_DEGEN_GUARD", "0")

# Same rationale, Coqui side (#2026 defect 3, main.py `_COQUI_DEGEN_GUARD_ENABLED`)
# — the suite's fake CoquiEngine forwards also emit non-realistic short audio
# that would otherwise read as degenerate and trip the retry loop. Default it
# OFF suite-wide; the dedicated regression test (test_coqui_degeneracy_guard.py)
# re-enables it explicitly.
os.environ.setdefault("COQUI_DEGEN_GUARD", "0")

# Capacity-aware GPU admission (main.py `_capacity_admission_enabled`) defaults ON
# in production (#1720), but most route tests exercise a GPU-configured engine
# with a faked/absent CUDA runtime, so the real free-VRAM probe can't fit them and
# they'd get a `503 noCapacity` before reaching the route logic under test (poison
# fencing, OOM classification, preview PCM, 409s). Default it OFF suite-wide — the
# dedicated admission tests (test_devices / test_*_admission) opt back IN with "1",
# and test_capacity_admission_default_on delenv's to assert the production default.
os.environ.setdefault("SEG_CAPACITY_ADMISSION", "0")


def _qwen_weights_present() -> bool:
    """True only when the real qwen-tts + Qwen3-TTS weights are importable/loadable.
    Gates GPU tests so CI / dev venvs SKIP instead of failing."""
    try:
        import qwen_tts  # noqa: F401
        import torch  # noqa: F401
        return torch.cuda.is_available()
    except Exception:
        return False


def pytest_configure(config):
    """Register the `golden` marker so `-m golden` / `-m "not golden"` selection
    (the opt-in real-model golden-audio tier, ops-11) doesn't emit an
    unknown-marker warning. The fast `test:sidecar` tier runs `-m "not golden"`;
    `run-golden-tests.ps1` runs `-m golden`."""
    config.addinivalue_line(
        "markers",
        "golden: real-model golden-audio regression (opt-in; needs Kokoro weights)",
    )
