# Stub for scripts/tests/run-golden-tests.Tests.ps1 (#1892 regression).
#
# Shadowed onto sys.path (via PYTHONPATH) ahead of the real sidecar venv's
# site-packages so the Pester test can exercise run-golden-tests.ps1's actual
# Qwen-probe line (`import sys, qwen_tts, torch; ...`) without needing a real
# qwen_tts install, a real GPU, or a genuinely sox-less PATH on every box that
# runs `npm run test:scripts`.
#
# Reproduces the one side effect that matters for the regression: `import
# qwen_tts` pulls in torchaudio, which writes a warning line to native stderr
# when `sox` isn't on PATH. That stderr line is what used to crash the whole
# gate under PowerShell 5.1's `$ErrorActionPreference = 'Stop'` (see
# run-golden-tests.ps1's own comment above the probe) even though the Python
# process itself exited cleanly.
import sys

sys.stderr.write("WARNING: SoX could not be found! (stub for #1892 regression test)\n")
sys.stderr.flush()
