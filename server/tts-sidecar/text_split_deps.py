"""Real-import probe for the packages Coqui/XTTS text splitting needs (#4961).

`CoquiEngine._infer_from_latents` (main.py) passes `enable_text_splitting=True`,
which reaches upstream's `get_spacy_lang` — that needs `spacy`, and Japanese
additionally needs `sudachipy` + `sudachidict_core` (#2017 / #2038). A Coqui
install made before 1.15 lacks them, and main.py then falls back to
`enable_text_splitting=False` (truncation / 400-token-assert risk on long lines).

This module is the DETECTION half of the server's boot-time auto-install
(server/src/tts/coqui-extras-autoinstall.ts). It runs as a script in the sidecar
venv BEFORE the sidecar itself is spawned, so it can't use the sidecar's /health.
It does a real import (not `find_spec`): a half-installed package that is present
but unimportable must read as missing too.

Exit code 0 = everything importable; 1 = at least one missing (names on stdout,
one per line). Stdlib-only so it runs in any venv state.
"""

from __future__ import annotations

import importlib
import sys
from typing import Callable, List

# Import names, not pip names (`sudachidict-core` imports as `sudachidict_core`).
REQUIRED_TEXT_SPLIT_MODULES = ("spacy", "sudachipy", "sudachidict_core")


def missing_text_split_modules(
    import_fn: Callable[[str], object] = importlib.import_module,
) -> List[str]:
    """Names of REQUIRED_TEXT_SPLIT_MODULES that fail a real import."""
    missing: List[str] = []
    for name in REQUIRED_TEXT_SPLIT_MODULES:
        try:
            import_fn(name)
        except Exception:  # ImportError, or a broken native extension
            missing.append(name)
    return missing


def main() -> int:
    missing = missing_text_split_modules()
    for name in missing:
        print(name)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
