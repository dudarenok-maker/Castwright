"""Sidecar pytest session setup.

#4054: `import main` starts the parent watch when SIDECAR_PARENT_PID is set, and
about 45 test modules import `main`. A pid leaked in from the shell (a terminal
that once ran a server-spawned sidecar) would end the whole pytest run early
once that process dies. Dropped here, before any test module imports `main`."""
import os

for _name in ("SIDECAR_PARENT_PID", "SIDECAR_PARENT_START_MS"):
    os.environ.pop(_name, None)
