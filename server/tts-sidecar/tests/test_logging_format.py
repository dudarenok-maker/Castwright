"""Pin the sidecar's logging format. Every line written to logs/tts.log
must lead with `YYYY-MM-DD HH:mm:ss.SSS [sidecar] ` so cross-sink (server
+ sidecar + frontend) timeline reconstruction works without guesswork.

The format string lives at server/tts-sidecar/main.py (LOG_FORMAT /
LOG_DATEFMT constants) — if it drifts this regression catches it before a
user notices the un-timestamped log."""
from __future__ import annotations

import logging
import re
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


_TS_LINE = re.compile(
    r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[sidecar\] hello-from-test$"
)


def test_format_emits_timestamped_sidecar_prefix() -> None:
    """Construct a Formatter with main's published constants and run a
    record through it — that's the line shape that lands on disk in
    production (basicConfig installs a handler with this same Formatter
    when uvicorn imports main first).

    Reading `handlers[0].formatter` directly is brittle under pytest:
    caplog installs its own root handler before main is imported, so
    `logging.basicConfig` becomes a no-op and handler[0] is pytest's,
    not ours. The format-constant assertion below is what matters."""
    formatter = logging.Formatter(fmt=main.LOG_FORMAT, datefmt=main.LOG_DATEFMT)
    record = logging.LogRecord(
        name="sidecar",
        level=logging.INFO,
        pathname=__file__,
        lineno=0,
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
    assert "%(asctime)s" in main.LOG_FORMAT
    assert "%(msecs)03d" in main.LOG_FORMAT
    assert "[sidecar]" in main.LOG_FORMAT
    assert main.LOG_DATEFMT == "%Y-%m-%d %H:%M:%S"
