# Stub `torch` for scripts/tests/run-golden-tests.Tests.ps1 (#1892 regression).
#
# run-golden-tests.ps1's Qwen probe only ever calls `torch.cuda.is_available()`
# after importing the stub `qwen_tts` above. Stubbed to always report False so
# the probe deterministically resolves "Qwen not present" (no real GPU/CUDA
# needed on the box running this test) and the script falls through past the
# Coqui probe to its "no golden weights found" SKIP path, rather than
# launching a real (heavy, GPU-dependent) golden pytest run from inside a
# Pester test.
class _Cuda:
    @staticmethod
    def is_available():
        return False


cuda = _Cuda()
