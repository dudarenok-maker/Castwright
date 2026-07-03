"""Plan 2a — a `cuda-uuid:<uuid>` device-knob env var must not crash the
sidecar at import time.

Found on real hardware during Plan 2a's on-box acceptance: `ENGINES =
{"qwen": QwenEngine(), ...}` constructs its entries at MODULE-IMPORT time,
and `QwenEngine.__init__` reads `QWEN_DEVICE` through `_read_device_env` ->
`_resolve_uuid_to_index`, which calls `_enumerate_cuda_devices`. That
function used to be defined ~2300 lines further down the file — after the
`ENGINES` dict already needed it — so any fresh boot with a UUID-keyed
override already on disk (the exact scenario the picker is built to
support: a pin that survives a restart) crashed with
`NameError: name '_enumerate_cuda_devices' is not defined` and crash-looped
forever, since the env is identical on every respawn.

Every other sidecar test in this suite imports `main` once at module scope
and shares that cached import across the whole pytest session (see
test_cuda_env_shadow.py's own `import main` at the top) — by the time ANY
test in the suite runs, `main` is already successfully imported once, so a
regular `import main` inside a test can never re-trigger a module-level
NameError regardless of env. Only a genuinely fresh subprocess reproduces
(and locks) this class of bug."""

import subprocess
import sys
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parent.parent


def _import_main_in_subprocess(extra_env: dict) -> subprocess.CompletedProcess:
    import os

    env = {**os.environ, **extra_env}
    return subprocess.run(
        [sys.executable, "-c", "import main"],
        cwd=str(SIDECAR_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_fresh_import_does_not_crash_with_a_uuid_keyed_qwen_device():
    result = _import_main_in_subprocess(
        {"QWEN_DEVICE": "cuda-uuid:00000000-0000-0000-0000-000000000000"}
    )
    assert result.returncode == 0, result.stderr
    assert "NameError" not in result.stderr


def test_fresh_import_does_not_crash_with_a_uuid_keyed_kokoro_device():
    result = _import_main_in_subprocess(
        {"KOKORO_DEVICE": "cuda-uuid:00000000-0000-0000-0000-000000000000"}
    )
    assert result.returncode == 0, result.stderr
    assert "NameError" not in result.stderr


def test_fresh_import_resolves_a_real_uuid_to_its_real_index_no_gpu_assertion():
    """Best-effort: on a CPU-only CI runner _enumerate_cuda_devices returns []
    and every uuid stays unresolved (falls back to 'auto') — that's fine, this
    only asserts the import itself never crashes and the warning path (not a
    traceback) is what fires for an unresolvable uuid, matching
    test_cuda_env_shadow.py's convention of not asserting real hardware state."""
    result = _import_main_in_subprocess(
        {"QWEN_DEVICE": "cuda-uuid:00000000-0000-0000-0000-000000000000"}
    )
    assert result.returncode == 0, result.stderr
    assert "did not match any visible GPU (uuid_unresolved)" in result.stderr
