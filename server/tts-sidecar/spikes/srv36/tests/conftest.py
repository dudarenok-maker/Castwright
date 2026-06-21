import os, sys
_SIDE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _SIDE not in sys.path:
    sys.path.insert(0, _SIDE)
os.environ.setdefault("PRELOAD_COQUI", "0")
os.environ.setdefault("PRELOAD_KOKORO", "0")
