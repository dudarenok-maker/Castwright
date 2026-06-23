"""Suppress the benign-but-scary warnings the Qwen install + first model load
emit on a clean Windows box, leaving only warnings a deployer must act on.

This lives in its own tiny module (no numpy / fastapi / torch imports) so the
regression test can import + call `configure_warning_filters()` without paying
the cost of importing all of `main`. `main` calls it once at startup, before
`app = FastAPI()`.

Four noise sources are silenced — none of them is actionable:

1. **HF Hub symlink warning** — on Windows without Developer Mode, the Hugging
   Face Hub cache can't create symlinks and prints a multi-line warning on every
   download. The cache transparently falls back to file copies, so it's benign.
   We set `HF_HUB_DISABLE_SYMLINKS_WARNING=1` (the env knob HF Hub itself reads)
   rather than ask deployers to flip a Windows setting. The install script sets
   the same flag for the prefetch subprocess.

2. **`SoX could not be found!`** — a torchaudio/coqui transitive probe for the
   optional SoX backend. We do all audio I/O via soundfile + ffmpeg, so SoX is
   never used; the message is a pure no-op nag. Filtered at the narrowest scope
   (message regex) so unrelated UserWarnings still surface.

3. **transformers `flash-attn is not installed` banner** — transformers prints
   this whenever the optional FA2 wheel is absent. SDPA is our correct default
   (see README "FlashAttention-2"); the message implies a missing dependency
   that isn't actually required. Filtered at the narrowest scope (message regex)
   so other transformers warnings still surface. Deployers who install the FA2
   wheel silence it the upstream way regardless.

4. **torch `expandable_segments not supported on this platform`** — issue #1024
   sets `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` to curb CUDA allocator
   fragmentation; a Windows torch build without support parses it, can't honour
   it, and emits this benign UserWarning at the first CUDA op (it keeps the
   default allocator). The flag is forward-looking — the real Windows fix is the
   warm-1.7B-Base idle watchdog. Filtered at the narrowest scope.
"""
from __future__ import annotations

import os
import warnings

# Marker the regression test asserts on, so it can confirm the function ran
# without re-deriving the env/filter shapes.
WARNING_FILTERS_CONFIGURED = False


def configure_warning_filters() -> None:
    """Register the env knob + the two narrow message-scoped warning filters.

    Idempotent: safe to call more than once (env set is idempotent; duplicate
    warnings.filterwarnings entries are harmless)."""
    global WARNING_FILTERS_CONFIGURED

    # (1) HF Hub symlink warning — set the knob HF Hub reads. setdefault so an
    # explicit operator override (e.g. someone debugging the cache) wins.
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    # (2) torchaudio/coqui "SoX could not be found!" probe — narrowest scope.
    warnings.filterwarnings("ignore", message=r".*SoX could not be found.*")

    # (3) transformers "flash-attn is not installed" banner — narrowest scope.
    warnings.filterwarnings("ignore", message=r".*flash[- ]?attn(ention)? is not installed.*")

    # (4) torch "expandable_segments not supported on this platform" — issue #1024
    # sets PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True to curb CUDA allocator
    # fragmentation from repeated heavy-model load/free. On a Windows torch build
    # without support, torch parses it, can't honour it, and emits this benign
    # UserWarning at the first CUDA op (it just keeps the default allocator). The
    # flag is forward-looking (helps on Linux / a future torch with Windows
    # support); silence the nag at the narrowest scope. The real Windows fix is the
    # warm-1.7B-Base idle watchdog, not this flag.
    warnings.filterwarnings("ignore", message=r".*expandable_segments not supported.*")

    WARNING_FILTERS_CONFIGURED = True
