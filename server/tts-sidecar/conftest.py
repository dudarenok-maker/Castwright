"""pytest config: never load the real Coqui model during tests.

`PRELOAD_COQUI=0` short-circuits the FastAPI startup hook in main.py — the
tests stub `ENGINES` with a lightweight fake instead. Without this guard, any
test that imports `main` would hit the 30-60s model load on first run and
fail on CI machines without a configured venv."""
import os

os.environ.setdefault("PRELOAD_COQUI", "0")


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
