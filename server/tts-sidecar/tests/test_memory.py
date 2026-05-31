"""Host-memory leak guard tests (2026-05-30 incident).

A long-lived sidecar grew to ~54 GB committed-private host RAM and the OS
killed the Node server mid-run. Root cause: dropping a heavy PyTorch model
(`self._base = None`) doesn't refcount-free it — nn.Module/Parameter graphs
hold reference CYCLES, so the backing host storage lingers until CPython's
cyclic GC runs, which lags under the synth load. The fix: every model-unload
path now `gc.collect()`s explicitly, plus a watchdog + /debug/memory readout.

These pin: (1) the unload paths force a collect, (2) the memory readout +
threshold parsing behave, (3) /debug/memory exposes the diagnostic surface.
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


class _CountingGc:
    """Wraps the real gc module, counting collect() calls so a test can assert
    an unload path forced a collection — while delegating get_count/get_objects/
    garbage so /debug/memory and anything else still works."""

    def __init__(self, real) -> None:
        self._real = real
        self.collect_calls = 0

    def collect(self, *args, **kwargs) -> int:
        self.collect_calls += 1
        return 0

    def __getattr__(self, name):
        return getattr(self._real, name)


class _FakeCudaTorch:
    """Stub torch whose cuda.is_available() is False, so the unload paths skip
    empty_cache() (no real CUDA call) while we assert the gc.collect() fired."""

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

    cuda = _Cuda()


# --- the core fix: unload paths force a cyclic collection ---


def test_qwen_unload_design_collects_and_drops(monkeypatch):
    """unload_design() must drop the heavy VoiceDesign ref AND force a
    gc.collect() — otherwise its ~3.4 GB host copy lingers in the cyclic-GC
    backlog (the dominant contributor to the 54 GB leak)."""
    counting = _CountingGc(main.gc)
    monkeypatch.setattr(main, "gc", counting)

    engine = main.QwenEngine()
    engine._design = object()  # sentinel "loaded" design model

    engine.unload_design()

    assert engine._design is None
    assert counting.collect_calls >= 1, "unload_design must gc.collect()"


def test_qwen_unload_design_noop_when_idle(monkeypatch):
    """No design resident → early return, no collect (don't pay GC cost on the
    common per-generation no-op path that synthesize() hits every chapter)."""
    counting = _CountingGc(main.gc)
    monkeypatch.setattr(main, "gc", counting)

    engine = main.QwenEngine()
    engine._design = None

    engine.unload_design()

    assert counting.collect_calls == 0, "idle unload_design must not gc.collect()"


def test_qwen_unload_collects_and_clears_cache(monkeypatch):
    """unload() drops Base + VoiceDesign + the in-memory prompt cache and forces
    a collect so none of the dropped graphs survive in the GC backlog."""
    counting = _CountingGc(main.gc)
    monkeypatch.setattr(main, "gc", counting)

    engine = main.QwenEngine()
    engine._base = object()
    engine._design = object()
    engine._prompt_cache["narrator"] = (object(), "English")

    engine.unload()

    assert engine._base is None
    assert engine._design is None
    assert engine._prompt_cache == {}
    assert counting.collect_calls >= 1, "unload must gc.collect()"


def test_coqui_unload_collects(monkeypatch):
    """The same cycle-breaking applies to the Coqui XTTS model (~3 GB)."""
    counting = _CountingGc(main.gc)
    monkeypatch.setattr(main, "gc", counting)

    engine = main.CoquiEngine()
    engine._tts = object()
    engine._torch = _FakeCudaTorch()  # cuda unavailable → empty_cache() skipped

    engine.unload()

    assert engine._tts is None
    assert counting.collect_calls >= 1, "Coqui unload must gc.collect()"


def test_reclaim_host_and_vram_collects(monkeypatch):
    """The watchdog's reclaim helper must gc.collect() (then best-effort
    empty_cache, which it swallows on any torch/CUDA error)."""
    counting = _CountingGc(main.gc)
    monkeypatch.setattr(main, "gc", counting)

    main._reclaim_host_and_vram()

    assert counting.collect_calls >= 1


# --- the readout: _process_mem + threshold parsing ---


def test_process_mem_reports_rss():
    """psutil is present in the venv → _process_mem returns a positive RSS."""
    mem = main._process_mem()
    assert "rss_mb" in mem
    assert mem["rss_mb"] > 0


def test_process_mem_degrades_without_psutil(monkeypatch):
    """No psutil handle → empty dict, so the watchdog/endpoint degrade to 'no
    readout' instead of crashing."""
    monkeypatch.setattr(main, "_PROC", None)
    assert main._process_mem() == {}


def test_mem_warn_threshold_parsing(monkeypatch):
    """Default 8192; explicit override honoured; garbage falls back to default;
    0 is a valid 'logging only, no reclaim' value."""
    monkeypatch.delenv("SIDECAR_RSS_WARN_MB", raising=False)
    assert main._mem_warn_threshold_mb() == 8192.0

    monkeypatch.setenv("SIDECAR_RSS_WARN_MB", "12000")
    assert main._mem_warn_threshold_mb() == 12000.0

    monkeypatch.setenv("SIDECAR_RSS_WARN_MB", "not-a-number")
    assert main._mem_warn_threshold_mb() == 8192.0

    monkeypatch.setenv("SIDECAR_RSS_WARN_MB", "0")
    assert main._mem_warn_threshold_mb() == 0.0


# --- process-recycle (committed-private hard ceiling → self-restart via srv-15) ---


def test_process_commit_mb_reports_private():
    """psutil is present in the venv → committed-private (Windows pmem.private /
    elsewhere uss) is a positive figure, and ≥ RSS (private/committed exceeds the
    resident set — the whole reason the recycle keys on it)."""
    commit = main._process_commit_mb()
    assert commit is not None
    assert commit > 0


def test_process_commit_mb_none_without_psutil(monkeypatch):
    monkeypatch.setattr(main, "_PROC", None)
    assert main._process_commit_mb() is None


def test_mem_restart_threshold_parsing(monkeypatch):
    """Explicit override honoured; 0 disables; garbage falls through to the
    RAM-based default; unset → 70% of total physical RAM."""
    import psutil

    monkeypatch.setenv("SIDECAR_RESTART_MB", "30000")
    assert main._mem_restart_threshold_mb() == 30000.0

    monkeypatch.setenv("SIDECAR_RESTART_MB", "0")
    assert main._mem_restart_threshold_mb() == 0.0  # disabled

    monkeypatch.setenv("SIDECAR_RESTART_MB", "garbage")
    assert main._mem_restart_threshold_mb() > 0  # falls through to RAM default

    monkeypatch.delenv("SIDECAR_RESTART_MB", raising=False)
    expected = 0.70 * psutil.virtual_memory().total / 1_000_000.0
    assert abs(main._mem_restart_threshold_mb() - expected) < 1.0


def test_mem_restart_disabled_without_psutil(monkeypatch):
    """No override + no psutil → 0 (disabled): never guess a ceiling that could
    fire on a healthy small box."""
    monkeypatch.delenv("SIDECAR_RESTART_MB", raising=False)
    monkeypatch.setattr(main, "psutil", None)
    assert main._mem_restart_threshold_mb() == 0.0


def test_should_restart():
    """Recycle iff a positive ceiling is set AND committed memory meets it."""
    assert main._should_restart(35000, 30000) is True
    assert main._should_restart(30000, 30000) is True  # inclusive
    assert main._should_restart(29999, 30000) is False
    assert main._should_restart(99999, 0) is False  # disabled ceiling


def test_schedule_restart_is_idempotent(monkeypatch):
    """Two over-ceiling ticks schedule exactly ONE exit (the flag guards it).
    `_restart_now` is patched so the timer can't actually kill pytest; we
    wait past the flush delay to confirm it fired once. With nothing in flight
    (srv-17c) the drain returns immediately, so this is also the no-wait path."""
    calls: list[int] = []
    monkeypatch.setattr(main, "_restart_now", lambda: calls.append(1))
    monkeypatch.setattr(main, "_restart_scheduled", False)
    monkeypatch.setattr(main, "_restart_pending", False)
    monkeypatch.setattr(main, "_inflight_synth", 0)  # nothing to drain → exits at once

    main._schedule_restart_exit(50000, 45000)
    main._schedule_restart_exit(51000, 45000)  # second call must be a no-op
    assert main._restart_scheduled is True
    assert main._restart_pending is True  # new synth now fast-fails 503

    # Let the single scheduled timer fire (into the patched no-op) before the
    # monkeypatch is torn down — otherwise a late real exit would kill the suite.
    time.sleep(main._POISON_EXIT_DELAY_MS / 1000.0 + 0.5)
    assert calls == [1]


# --- srv-17c: drain in-flight synth before the recycle self-exit ---


def test_drain_grace_parsing(monkeypatch):
    """Default 180000ms; explicit override honoured; garbage → default; 0
    (draining disabled → immediate exit) is a valid value."""
    monkeypatch.delenv("SIDECAR_DRAIN_GRACE_MS", raising=False)
    assert main._drain_grace_ms() == 180000

    monkeypatch.setenv("SIDECAR_DRAIN_GRACE_MS", "5000")
    assert main._drain_grace_ms() == 5000

    monkeypatch.setenv("SIDECAR_DRAIN_GRACE_MS", "not-a-number")
    assert main._drain_grace_ms() == 180000

    monkeypatch.setenv("SIDECAR_DRAIN_GRACE_MS", "0")
    assert main._drain_grace_ms() == 0


def test_max_text_length_parsing(monkeypatch):
    """side-13: default 8000; explicit override honoured; garbage → default;
    0 (cap disabled) is a valid value."""
    monkeypatch.delenv("MAX_TEXT_LENGTH", raising=False)
    assert main._max_text_length() == 8000

    monkeypatch.setenv("MAX_TEXT_LENGTH", "1234")
    assert main._max_text_length() == 1234

    monkeypatch.setenv("MAX_TEXT_LENGTH", "not-a-number")
    assert main._max_text_length() == 8000

    monkeypatch.setenv("MAX_TEXT_LENGTH", "0")
    assert main._max_text_length() == 0


def test_drain_waits_for_inflight_then_exits(monkeypatch):
    """The drain holds the exit while a synth is in flight, then fires `_restart_now`
    once the counter reaches 0 — so the in-flight chapter finishes on its worker
    instead of failing."""
    calls: list[int] = []
    monkeypatch.setattr(main, "_restart_now", lambda: calls.append(1))
    monkeypatch.setattr(main, "_POISON_EXIT_DELAY_MS", 50)
    monkeypatch.setattr(main, "_inflight_synth", 1)  # one chapter mid-synth

    t = threading.Thread(target=main._drain_then_restart, args=(5000,), daemon=True)
    t.start()

    time.sleep(0.3)
    assert calls == []  # still draining — must NOT have exited yet

    monkeypatch.setattr(main, "_inflight_synth", 0)  # synth finished
    time.sleep(0.6 + 0.05 + 0.25)  # one poll + flush + margin
    assert calls == [1]


def test_drain_grace_expiry_exits_anyway(monkeypatch):
    """If the grace expires with a synth STILL in flight, exit regardless — the
    server's in-worker recovery re-renders that chapter (best-effort drain)."""
    calls: list[int] = []
    monkeypatch.setattr(main, "_restart_now", lambda: calls.append(1))
    monkeypatch.setattr(main, "_POISON_EXIT_DELAY_MS", 50)
    monkeypatch.setattr(main, "_inflight_synth", 1)  # never drains

    t = threading.Thread(target=main._drain_then_restart, args=(600,), daemon=True)
    t.start()

    time.sleep(1.0 + 0.05 + 0.35)  # ~2 polls (grace) + flush + margin
    assert calls == [1]


def test_drain_disabled_exits_immediately(monkeypatch):
    """SIDECAR_DRAIN_GRACE_MS=0 → draining disabled: exit at once even with synth
    in flight (the pre-srv-17c immediate-recycle behaviour)."""
    calls: list[int] = []
    monkeypatch.setattr(main, "_restart_now", lambda: calls.append(1))
    monkeypatch.setattr(main, "_POISON_EXIT_DELAY_MS", 50)
    monkeypatch.setattr(main, "_inflight_synth", 5)  # would block if draining

    t = threading.Thread(target=main._drain_then_restart, args=(0,), daemon=True)
    t.start()

    time.sleep(0.05 + 0.25)  # flush + margin — NO drain wait
    assert calls == [1]


def test_synthesize_fast_fails_503_while_recycling(monkeypatch):
    """While `_restart_pending` is set, /synthesize returns a NON-poisoned 503 so
    the server classifies it transient (5xx, not poisoned) and its in-worker
    recovery rides out the respawn — no new chapter enters the dying process."""
    # Mirror test_debug_memory: drop kokoro before TestClient fires the eager
    # preload, swap a fresh cold qwen so the lookup succeeds without weights.
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    monkeypatch.setitem(main.ENGINES, "qwen", main.QwenEngine())
    monkeypatch.setattr(main, "_process_poisoned", False)
    monkeypatch.setattr(main, "_restart_pending", True)

    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "qwen", "model": "qwen", "voice": "v", "text": "hello"},
        )

    assert r.status_code == 503
    body = r.json()
    assert "recycling" in body["detail"].lower()
    assert "poisoned" not in body  # NOT the CUDA-poison 503 — server must treat it transient


def test_load_reports_not_ready_while_recycling(monkeypatch):
    """The 2026-05-31 cascade fix: while `_restart_pending` is set, /load must NOT
    answer the instant `{"status":"ready"}` (the model is still resident) — it has
    to mirror the /synthesize drain fence with the recycling 503. Otherwise the
    server's readiness gate (ensureSidecarEngineReady → /load) sees `ready` and
    marches a queued chapter straight into a 503, dropping every chapter started
    during the ~2-min drain window. With the fence, the gate POLLS through the
    drain+respawn instead."""
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    monkeypatch.setitem(main.ENGINES, "qwen", main.QwenEngine())
    monkeypatch.setattr(main, "_restart_pending", True)

    with TestClient(main.app) as client:
        r = client.post("/load", json={"engine": "qwen"})

    assert r.status_code == 503
    body = r.json()
    assert "recycling" in body["detail"].lower()
    assert body.get("status") != "ready"  # the gate must treat this as keep-waiting


# --- the diagnostic endpoint ---


def test_debug_memory_endpoint_shape(monkeypatch):
    """/debug/memory exposes process RSS, GC stats, per-engine model/cache state
    and CUDA alloc — the surface for watching the host-RAM curve on demand."""
    # Drop the real Kokoro engine before TestClient fires the eager-preload
    # startup hook (mirrors test_smoke's fixture — avoids loading real weights).
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    # Swap in a FRESH Qwen engine: ENGINES["qwen"] is a module-level singleton,
    # so other tests in the same process may have warmed its prompt cache —
    # a fresh instance makes the cold-state assertions below deterministic.
    monkeypatch.setitem(main.ENGINES, "qwen", main.QwenEngine())
    with TestClient(main.app) as client:
        r = client.get("/debug/memory")
    assert r.status_code == 200
    body = r.json()
    assert "process" in body and "rss_mb" in body["process"]
    assert "gc" in body and "counts" in body["gc"]
    assert "engines" in body
    # Qwen is registered and cold here: base/design not loaded, cache empty.
    qwen = body["engines"].get("qwen")
    assert qwen is not None
    assert qwen["base_loaded"] is False
    assert qwen["design_loaded"] is False
    assert qwen["prompt_cache_entries"] == 0
    assert "cuda" in body
