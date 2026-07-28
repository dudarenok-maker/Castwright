# Noisy stub `TTS` for scripts/tests/run-golden-tests.Tests.ps1.
#
# The sibling fixture dir's TTS.py is deliberately SILENT, because when it was
# written run-golden-tests.ps1's Coqui-presence probe had no
# $ErrorActionPreference relaxation and any stderr from `import TTS` would have
# crashed the script regardless of the #1892 Qwen fix under test there. That
# file's own comment names the gap as "arguably a second latent instance of the
# same bug class". It was.
#
# This stub is the opposite: it writes to native stderr on import, exactly the
# way a real `import TTS` does on a box with a torch/transformers deprecation
# notice, and then reports "not present" so the script lands on the same clean
# "no golden weights found" SKIP banner rather than launching a real, heavy,
# GPU-dependent golden pytest run from inside a Pester test.
#
# The stderr text is deliberately DISTINCT from qwen_tts.py's SoX line: both
# probes run in the same invocation, so if this test ever fails the message
# identifies which probe lost its guard.
#
# Shadowed ahead of the sibling dir on PYTHONPATH, so qwen_tts.py/torch.py
# still come from there and only TTS is overridden.
import sys

sys.stderr.write(
    "WARNING: TTS import emitted a deprecation notice (stub for the Coqui-probe regression test)\n"
)
sys.stderr.flush()
sys.exit(1)
