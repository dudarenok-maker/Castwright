"""Pin the sidecar's logging format. Every line written to logs/tts.log
must lead with `YYYY-MM-DD HH:mm:ss.SSS [sidecar] ` so cross-sink (server
+ sidecar + frontend) timeline reconstruction works without guesswork.

The format string lives at server/tts-sidecar/main.py:33 — if it drifts
(format= or datefmt= changed) this regression catches it before a user
notices the un-timestamped log."""
from __future__ import annotations

import io
import logging
import re
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402  — triggers logging.basicConfig at import time


_TS_LINE = re.compile(
    r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[sidecar\] hello-from-test$"
)


def test_root_handler_emits_timestamped_sidecar_prefix() -> None:
    """basicConfig configures the ROOT handler with our format. Reproduce its
    Formatter (same format= + datefmt= the sidecar uses) and run a record
    through it — that's what the user sees on disk. Direct stream-capture
    on the root handler is brittle because pytest's caplog hooks intercept
    the records earlier in the pipeline."""
    root = logging.getLogger()
    assert root.handlers, "basicConfig should have installed a root handler"
    handler = root.handlers[0]
    formatter = handler.formatter
    assert formatter is not None, "root handler must carry a Formatter"

    record = main.log.makeRecord(
        name="sidecar",
        level=logging.INFO,
        fn=__file__,
        lno=0,
        msg="hello-from-test",
        args=(),
        exc_info=None,
    )
    formatted = formatter.format(record)
    assert _TS_LINE.match(formatted), f"unexpected log line shape: {formatted!r}"


def test_format_includes_milliseconds() -> None:
    """%(asctime)s.%(msecs)03d guarantees a 3-digit ms tail. Without the
    explicit `.%(msecs)03d` (i.e. relying on default asctime), the format
    would miss sub-second resolution — and high-rate progress events
    would all timestamp the same second. Pin it."""
    handler = logging.getLogger().handlers[0]
    formatter = handler.formatter
    assert formatter is not None
    fmt = formatter._fmt or ""
    assert "%(asctime)s" in fmt
    assert "%(msecs)03d" in fmt
    assert "[sidecar]" in fmt
    assert formatter.datefmt == "%Y-%m-%d %H:%M:%S"
