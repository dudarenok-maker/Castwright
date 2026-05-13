"""pytest config: never load the real Coqui model during tests.

`PRELOAD_COQUI=0` short-circuits the FastAPI startup hook in main.py — the
tests stub `ENGINES` with a lightweight fake instead. Without this guard, any
test that imports `main` would hit the 30-60s model load on first run and
fail on CI machines without a configured venv."""
import os

os.environ.setdefault("PRELOAD_COQUI", "0")
