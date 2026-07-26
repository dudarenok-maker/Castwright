"""side-27a — pin the startup/shutdown sequence the sidecar's `lifespan`
context manager runs.

Twelve `@app.on_event("startup"|"shutdown")` handlers were collapsed into a
single `main._lifespan` ahead of the Starlette bump this branch also makes.
That collapse wasn't forced by import-time breakage — FastAPI re-implements
`on_startup`/`on_shutdown`/`on_event` locally (`fastapi/routing.py`), so the
decorators still resolve fine against the pinned FastAPI 0.140. It was done
because `on_event` is formally deprecated there, kept only on a compatibility
shim FastAPI's own source marks for future removal. With the decorators gone,
the ordering is no longer expressed by twelve registration sites that are hard
to reorder by accident — it is twelve consecutive `await` lines that a
careless edit could reshuffle, drop, or duplicate silently. Hence this file.

These tests drive the ACTUAL wired-up `app.router.lifespan_context`, with every
handler monkeypatched to a recorder, and compare the observed call order against
the order the `on_event` form produced. They deliberately do NOT read a
hand-maintained list off the module — that would pass vacuously against the very
edit it is supposed to catch. Monkeypatching module attributes is what the
sidecar's own testing convention prescribes (see the torch-injection note in
CLAUDE.md), and it works here because `_lifespan` resolves each handler as a
module global at call time.

Note the shutdown order is registration order, NOT the reverse of startup:
FastAPI's `APIRouter._shutdown()` iterates `on_shutdown` forwards, and the
migration preserved that rather than "tidying" it into a reversal."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

# Make the sidecar package importable: tests/ sits one level below main.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402

# The two sequences as the `@app.on_event` decorators registered them, in the
# order Starlette invoked them. Any change to either list is a behaviour change
# and must be argued for, not slipped in.
EXPECTED_STARTUP = [
    "_configure_vd_kokoro_coupling",
    "_start_design_idle_watchdog",
    "_start_asr_idle_watchdog",
    "_start_spk_idle_watchdog",
    "_start_device_probe",
    "_start_memory_watchdog",
    "_preload_default_engines",
    "_startup_cuda_env_shadow_check",
]

EXPECTED_SHUTDOWN = [
    "_stop_design_idle_watchdog",
    "_stop_asr_idle_watchdog",
    "_stop_spk_idle_watchdog",
    "_stop_memory_watchdog",
]


def _install_recorders(monkeypatch, calls: list[str], raises: str | None = None) -> None:
    """Replace all twelve handlers with async recorders that append their own
    name. `raises` optionally makes one of them blow up, so the abort semantics
    can be exercised without a real handler failure."""

    def _make(name: str):
        async def _recorder() -> None:
            calls.append(name)
            if name == raises:
                raise RuntimeError(f"boom in {name}")

        return _recorder

    for name in EXPECTED_STARTUP + EXPECTED_SHUTDOWN:
        # getattr first: a renamed/deleted handler must fail loudly here rather
        # than have the test quietly patch a name nothing calls.
        assert callable(getattr(main, name)), name
        monkeypatch.setattr(main, name, _make(name))


async def _run_lifespan(calls: list[str]) -> None:
    """Enter and exit the app's real lifespan exactly as the ASGI server does."""
    async with main.app.router.lifespan_context(main.app):
        calls.append("--serving--")


def test_app_is_wired_to_the_lifespan_context_manager():
    # Guards the seam the other tests depend on: if the app were ever
    # constructed without `lifespan=`, it would fall back to FastAPI's own
    # `_DefaultLifespan` over the (now empty) `on_startup`/`on_shutdown` lists
    # and every ordering assertion below would pass against nothing at all.
    # The two asserts below only make sense against FastAPI's `APIRouter`,
    # which keeps `on_startup`/`on_shutdown` as instance lists for backward
    # compatibility after Starlette dropped them outright — this would
    # `AttributeError` on a plain Starlette `Router`, which has no such lists.
    assert main.app.router.lifespan_context is main._lifespan
    assert main.app.router.on_startup == []
    assert main.app.router.on_shutdown == []


def test_lifespan_runs_startup_then_shutdown_in_the_registered_order(monkeypatch):
    calls: list[str] = []
    _install_recorders(monkeypatch, calls)

    asyncio.run(_run_lifespan(calls))

    assert calls == EXPECTED_STARTUP + ["--serving--"] + EXPECTED_SHUTDOWN


def test_a_failing_startup_handler_aborts_boot_and_skips_the_rest(monkeypatch):
    # `Router.startup()` awaited its handlers in an unguarded loop, so the first
    # raiser aborted the whole startup and neither the handlers after it nor any
    # shutdown handler ran. The single lifespan must keep that: a half-started
    # process is meant to die, not limp on with three of eight watchdogs live.
    calls: list[str] = []
    _install_recorders(monkeypatch, calls, raises="_start_asr_idle_watchdog")

    with pytest.raises(RuntimeError, match="_start_asr_idle_watchdog"):
        asyncio.run(_run_lifespan(calls))

    assert calls == EXPECTED_STARTUP[:3]


def test_shutdown_still_runs_when_the_serving_phase_raises(monkeypatch):
    # Starlette's `_DefaultLifespan.__aexit__` ignored its exc_info and ran
    # `Router.shutdown()` unconditionally, so a lifespan task cancelled while
    # serving still cancelled the four watchdog tasks. That is why `_lifespan`
    # wraps its `yield` in try/finally — drop the `finally` and this fails.
    calls: list[str] = []
    _install_recorders(monkeypatch, calls)

    async def _raise_while_serving() -> None:
        async with main.app.router.lifespan_context(main.app):
            raise RuntimeError("server died mid-flight")

    with pytest.raises(RuntimeError, match="server died mid-flight"):
        asyncio.run(_raise_while_serving())

    assert calls == EXPECTED_STARTUP + EXPECTED_SHUTDOWN
