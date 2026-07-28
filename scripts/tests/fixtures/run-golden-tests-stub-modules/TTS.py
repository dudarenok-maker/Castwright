# Stub `TTS` for scripts/tests/run-golden-tests.Tests.ps1 (#1892 regression).
#
# run-golden-tests.ps1's Coqui-presence probe is `import TTS`, reached once
# the Qwen probe above has resolved "not present". Deliberately a SILENT
# `sys.exit(1)` (no stderr output) rather than a raised ImportError:
# unlike the Qwen probe, this line's own `& $venvPython -c "import TTS"` call
# is NOT wrapped in the $ErrorActionPreference='Continue' relaxation the
# fix under test applies — an ImportError's traceback on stderr trips the
# identical native-stderr-under-Stop crash this file's fixture set exists to
# reproduce, for a DIFFERENT, unrelated code path. That would confound this
# regression test (it would fail regardless of whether the #1892 fix is
# present or reverted) and is arguably a second latent instance of the same
# bug class in run-golden-tests.ps1 — out of scope for this fixture, noted
# in the review report instead of patched here.
import sys

sys.exit(1)
