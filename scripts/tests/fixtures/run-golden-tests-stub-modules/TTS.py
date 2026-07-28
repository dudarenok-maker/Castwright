# Stub `TTS` for scripts/tests/run-golden-tests.Tests.ps1 (#1892 regression).
#
# run-golden-tests.ps1's Coqui-presence probe is `import TTS`, reached once
# the Qwen probe above has resolved "not present". Deliberately a SILENT
# `sys.exit(1)` (no stderr output) rather than a raised ImportError: this
# fixture dir backs the Qwen-probe regression test, where the Coqui probe is
# incidental — it just needs to resolve "not present" cleanly so the script
# reaches the same SKIP banner regardless. (The Coqui probe's OWN stderr
# handling is now separately guarded — see
# run-golden-tests.ps1:100-107 — and tested against the sibling
# `run-golden-tests-stub-modules-coqui-noisy/TTS.py` fixture, which writes to
# stderr on purpose to exercise that guard.)
import sys

sys.exit(1)
