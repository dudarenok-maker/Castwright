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

import asyncio
import json
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


# --- side-11: env-gated MKLDNN disable (variable-shape host-leak probe) ---


def test_disable_mkldnn_parsing(monkeypatch):
    """Default OFF (opt-in); truthy tokens enable; garbage / 0 / unset → OFF."""
    monkeypatch.delenv("SIDECAR_DISABLE_MKLDNN", raising=False)
    assert main._disable_mkldnn() is False

    for truthy in ("1", "true", "TRUE", "yes", "on"):
        monkeypatch.setenv("SIDECAR_DISABLE_MKLDNN", truthy)
        assert main._disable_mkldnn() is True, truthy

    for falsy in ("0", "false", "no", "off", "not-a-bool", ""):
        monkeypatch.setenv("SIDECAR_DISABLE_MKLDNN", falsy)
        assert main._disable_mkldnn() is False, falsy


class _FakePerfTorch:
    """Stub torch exposing exactly the attributes `_apply_torch_perf_flags`
    touches, so we can assert the mkldnn gate flips the flag WITHOUT regressing
    the always-on TF32 / matmul-precision settings."""

    def __init__(self) -> None:
        from types import SimpleNamespace

        self.backends = SimpleNamespace(
            cuda=SimpleNamespace(matmul=SimpleNamespace(allow_tf32=False)),
            cudnn=SimpleNamespace(allow_tf32=False),
            mkldnn=SimpleNamespace(enabled=True),
        )
        self.matmul_precision = None

    def set_float32_matmul_precision(self, value: str) -> None:
        self.matmul_precision = value


def test_apply_torch_perf_flags_disables_mkldnn_when_gated(monkeypatch):
    """SIDECAR_DISABLE_MKLDNN on → mkldnn.enabled flipped False; off → left True.
    Either way the TF32 / matmul-precision flags are still applied (no regress)."""
    monkeypatch.setenv("SIDECAR_DISABLE_MKLDNN", "1")
    t = _FakePerfTorch()
    main._apply_torch_perf_flags(t)
    assert t.backends.mkldnn.enabled is False
    assert t.backends.cuda.matmul.allow_tf32 is True
    assert t.backends.cudnn.allow_tf32 is True
    assert t.matmul_precision == "high"

    monkeypatch.setenv("SIDECAR_DISABLE_MKLDNN", "0")
    t2 = _FakePerfTorch()
    main._apply_torch_perf_flags(t2)
    assert t2.backends.mkldnn.enabled is True  # untouched when gate off
    assert t2.backends.cuda.matmul.allow_tf32 is True  # TF32 still applied


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
    # The leak-slope bench keys its success bar on committed-private (the
    # recycle's own metric), so /debug/memory must surface it — present in the
    # venv where psutil resolves committed-private.
    assert "committed_mb" in body["process"]
    assert body["process"]["committed_mb"] > 0
    assert "gc" in body and "counts" in body["gc"]
    assert "engines" in body
    # Qwen is registered and cold here: base/design not loaded, cache empty.
    qwen = body["engines"].get("qwen")
    assert qwen is not None
    assert qwen["base_loaded"] is False
    assert qwen["design_loaded"] is False
    assert qwen["prompt_cache_entries"] == 0
    assert "cuda" in body


# --- side-11 item 2: SOFT recycle (recycle_pending → clean boundary recycle) ---


class _StopLoop(BaseException):
    """Breaks the watchdog's `while True` from a fake asyncio.sleep. A BaseException
    so neither the loop's `except asyncio.CancelledError` nor `except Exception`
    swallows it — it propagates straight out of the coroutine."""


def _fake_sleep_breaking_after(n: int):
    """Return an async sleep stub that returns for the first (n-1) calls then
    raises _StopLoop, so the watchdog runs exactly (n-1) full iterations."""
    state = {"calls": 0}

    async def _sleep(_seconds):
        state["calls"] += 1
        if state["calls"] >= n:
            raise _StopLoop()

    return _sleep


def test_recycle_soft_threshold_parsing(monkeypatch):
    """Default 0 (DISABLED — opt-in); explicit override honoured; 0 / negative /
    garbage all disable. Mirrors the SIDECAR_DISABLE_MKLDNN default-OFF convention."""
    monkeypatch.delenv("SIDECAR_RECYCLE_SOFT_MB", raising=False)
    assert main._mem_recycle_soft_threshold_mb() == 0.0

    monkeypatch.setenv("SIDECAR_RECYCLE_SOFT_MB", "30000")
    assert main._mem_recycle_soft_threshold_mb() == 30000.0

    monkeypatch.setenv("SIDECAR_RECYCLE_SOFT_MB", "0")
    assert main._mem_recycle_soft_threshold_mb() == 0.0

    monkeypatch.setenv("SIDECAR_RECYCLE_SOFT_MB", "garbage")
    assert main._mem_recycle_soft_threshold_mb() == 0.0


def test_should_soft_recycle():
    """Soft-recycle iff a positive soft ceiling is set, committed meets it, AND
    committed is still BELOW the hard ceiling (above it the hard exit owns it)."""
    # soft <= commit < hard → flag it
    assert main._should_soft_recycle(32000, 30000, 35000) is True
    assert main._should_soft_recycle(30000, 30000, 35000) is True  # inclusive
    # below soft → no
    assert main._should_soft_recycle(29999, 30000, 35000) is False
    # at/above hard → hard branch owns it, soft must NOT also fire
    assert main._should_soft_recycle(35000, 30000, 35000) is False
    assert main._should_soft_recycle(40000, 30000, 35000) is False
    # soft disabled (0) → never
    assert main._should_soft_recycle(99999, 0, 35000) is False


def test_watchdog_sets_recycle_pending_below_hard(monkeypatch):
    """One watchdog tick with soft <= committed < hard sets `_recycle_pending`
    and does NOT schedule an exit — the soft signal is advisory only."""
    monkeypatch.setenv("SIDECAR_RECYCLE_SOFT_MB", "30000")
    monkeypatch.setenv("SIDECAR_RESTART_MB", "35000")
    monkeypatch.setenv("SIDECAR_RSS_WARN_MB", "0")  # skip the futile reclaim branch
    monkeypatch.setattr(main, "_recycle_pending", False)
    monkeypatch.setattr(main, "_process_mem", lambda: {"rss_mb": 20000.0})
    monkeypatch.setattr(main, "_process_commit_mb", lambda: 32000.0)  # soft < c < hard
    scheduled: list = []
    monkeypatch.setattr(main, "_schedule_restart_exit", lambda *a: scheduled.append(a))
    monkeypatch.setattr(main.asyncio, "sleep", _fake_sleep_breaking_after(2))

    with pytest.raises(_StopLoop):
        asyncio.run(main._memory_watchdog())

    assert main._recycle_pending is True
    assert scheduled == [], "soft recycle must NOT trigger the hard self-exit"


def test_watchdog_finer_sampling_catches_transient_committed_spike(monkeypatch):
    """The leak oscillates per batch, so a once-a-minute sample can land in a
    trough and miss the spike — the 2026-06-02 run grazed the soft ceiling for
    minutes without ever flipping recycle_pending. The watchdog now evaluates the
    soft ceiling against EACH sample (every _MEM_WATCHDOG_SAMPLE_INTERVAL), so a
    single spike above soft — even with troughs on either side — flips
    recycle_pending without crossing the hard ceiling."""
    monkeypatch.setenv("SIDECAR_RECYCLE_SOFT_MB", "30000")
    monkeypatch.setenv("SIDECAR_RESTART_MB", "46000")
    monkeypatch.setenv("SIDECAR_RSS_WARN_MB", "0")
    monkeypatch.setattr(main, "_recycle_pending", False)
    monkeypatch.setattr(main, "_process_mem", lambda: {"rss_mb": 9000.0})
    samples = iter([9000.0, 36000.0, 9000.0])  # trough, SPIKE (≥ soft, < hard), trough
    monkeypatch.setattr(main, "_process_commit_mb", lambda: next(samples, 9000.0))
    monkeypatch.setattr(main, "_cuda_vram_mb", lambda: (None, None, None))
    scheduled: list = []
    monkeypatch.setattr(main, "_schedule_restart_exit", lambda *a: scheduled.append(a))
    monkeypatch.setattr(main.asyncio, "sleep", _fake_sleep_breaking_after(4))  # 3 iterations

    with pytest.raises(_StopLoop):
        asyncio.run(main._memory_watchdog())

    assert main._recycle_pending is True, "a transient spike above soft must flip recycle_pending"
    assert scheduled == [], "the spike is below the hard ceiling — no self-exit"


def test_watchdog_hard_ceiling_still_exits_when_soft_set(monkeypatch):
    """With the soft threshold ALSO configured, crossing the HARD ceiling still
    schedules the exit (backstop intact) and short-circuits before the soft
    branch, so `_recycle_pending` is not also flipped."""
    monkeypatch.setenv("SIDECAR_RECYCLE_SOFT_MB", "30000")
    monkeypatch.setenv("SIDECAR_RESTART_MB", "35000")
    monkeypatch.setenv("SIDECAR_RSS_WARN_MB", "0")
    monkeypatch.setattr(main, "_recycle_pending", False)
    monkeypatch.setattr(main, "_process_mem", lambda: {"rss_mb": 20000.0})
    monkeypatch.setattr(main, "_process_commit_mb", lambda: 36000.0)  # >= hard
    scheduled: list = []
    monkeypatch.setattr(main, "_schedule_restart_exit", lambda *a: scheduled.append(a))
    monkeypatch.setattr(main.asyncio, "sleep", _fake_sleep_breaking_after(2))

    with pytest.raises(_StopLoop):
        asyncio.run(main._memory_watchdog())

    assert len(scheduled) == 1, "hard ceiling must still schedule the recycle exit"
    assert main._recycle_pending is False, "hard branch continues before the soft branch"


def test_health_reports_recycle_pending(monkeypatch):
    """/health surfaces `recycle_pending` (default False) + `committed_mb` so the
    generation worker reads the soft signal off the same poll. Flipping the flag
    is reflected on the next poll."""
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    monkeypatch.setitem(main.ENGINES, "qwen", main.QwenEngine())
    monkeypatch.setattr(main, "_recycle_pending", False)
    with TestClient(main.app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["recycle_pending"] is False
        assert "committed_mb" in body
        assert body["committed_mb"] is not None and body["committed_mb"] > 0

        main._recycle_pending = True  # restored by the monkeypatch.setattr teardown
        assert client.get("/health").json()["recycle_pending"] is True


def test_recycle_endpoint_schedules_clean_exit(monkeypatch):
    """POST /recycle reuses the drain->exit path: 202 + `recycling`, flips
    `_restart_pending`, fires exactly ONE exit, and a second POST is a no-op
    (idempotent via `_restart_scheduled`)."""
    calls: list[int] = []
    monkeypatch.setattr(main, "_restart_now", lambda: calls.append(1))
    monkeypatch.setattr(main, "_POISON_EXIT_DELAY_MS", 50)
    monkeypatch.setattr(main, "_restart_scheduled", False)
    monkeypatch.setattr(main, "_restart_pending", False)
    monkeypatch.setattr(main, "_inflight_synth", 0)  # nothing to drain → immediate

    resp = asyncio.run(main.recycle())
    assert resp.status_code == 202
    body = json.loads(resp.body)
    assert body["status"] == "recycling"
    assert "committed_mb" in body
    assert main._restart_pending is True

    asyncio.run(main.recycle())  # second POST must NOT schedule a second exit

    time.sleep(main._POISON_EXIT_DELAY_MS / 1000.0 + 0.4)
    assert calls == [1]


def test_recycle_endpoint_drains_inflight_before_exit(monkeypatch):
    """A /recycle while a synth is in flight holds the exit (the drain fence)
    until the in-flight count reaches 0 — the in-flight chapter finishes here."""
    calls: list[int] = []
    monkeypatch.setattr(main, "_restart_now", lambda: calls.append(1))
    monkeypatch.setattr(main, "_POISON_EXIT_DELAY_MS", 50)
    monkeypatch.setattr(main, "_restart_scheduled", False)
    monkeypatch.setattr(main, "_restart_pending", False)
    monkeypatch.setattr(main, "_inflight_synth", 1)  # one chapter mid-synth

    asyncio.run(main.recycle())
    time.sleep(0.3)
    assert calls == [], "must still be draining — no exit while synth in flight"

    monkeypatch.setattr(main, "_inflight_synth", 0)  # synth finished
    time.sleep(0.6 + 0.05 + 0.25)  # one poll + flush + margin
    assert calls == [1]


# --- plan 161: VRAM-keyed recycle + non-leaky reload ---


def test_vram_recycle_threshold_parsing(monkeypatch):
    """Soft/hard VRAM ceilings: explicit MB env wins; unset → a fraction of the
    device total (auto-scales to the card); no env AND no readable total →
    0 (disabled)."""
    monkeypatch.delenv("SIDECAR_VRAM_RECYCLE_SOFT_MB", raising=False)
    monkeypatch.delenv("SIDECAR_VRAM_RESTART_MB", raising=False)
    # No env: derive from device total.
    assert main._vram_recycle_soft_threshold_mb(8000.0) == pytest.approx(7200.0)
    assert main._vram_restart_threshold_mb(8000.0) == pytest.approx(7840.0)
    # No env AND no total → disabled (never guess a ceiling).
    assert main._vram_recycle_soft_threshold_mb(None) == 0.0
    assert main._vram_restart_threshold_mb(None) == 0.0
    # Explicit MB overrides the fraction regardless of total.
    monkeypatch.setenv("SIDECAR_VRAM_RECYCLE_SOFT_MB", "7400")
    monkeypatch.setenv("SIDECAR_VRAM_RESTART_MB", "8000")
    assert main._vram_recycle_soft_threshold_mb(8000.0) == 7400.0
    assert main._vram_restart_threshold_mb(None) == 8000.0
    # Garbage falls back to the fraction (or disabled when no total).
    monkeypatch.setenv("SIDECAR_VRAM_RECYCLE_SOFT_MB", "nope")
    assert main._vram_recycle_soft_threshold_mb(8000.0) == pytest.approx(7200.0)


def test_unknown_vram_disables_vram_recycle_amd_fail_safe(monkeypatch):
    """AMD phase 2 fail-safe: when VRAM is unreadable (DirectML-only box, or torch
    GPU unavailable) the VRAM read returns None → both VRAM ceilings derive to 0 →
    the VRAM hard-restart and soft-recycle are DISABLED, so the host-RAM watchdog
    is the sole governor. A ROCm box (readable total) keeps full VRAM protection."""
    monkeypatch.delenv("SIDECAR_VRAM_RECYCLE_SOFT_MB", raising=False)
    monkeypatch.delenv("SIDECAR_VRAM_RESTART_MB", raising=False)
    # Unknown VRAM (e.g. DirectML-only): the probe yields no total.
    _, _, total = (None, None, None)
    soft = main._vram_recycle_soft_threshold_mb(total)
    hard = main._vram_restart_threshold_mb(total)
    assert soft == 0.0 and hard == 0.0
    # With 0 ceilings, no committed value can trip a VRAM recycle/restart.
    assert main._should_restart(10**9, hard) is False
    assert main._should_soft_recycle(10**9, soft, hard) is False
    # ROCm box (readable total) → ceilings active again (full protection).
    assert main._vram_restart_threshold_mb(8000.0) == pytest.approx(7840.0)


def test_watchdog_vram_soft_sets_recycle_pending(monkeypatch):
    """Reserved VRAM in [soft, hard) flags `recycle_pending` (the SAME flag the
    host soft-recycle uses) and does NOT exit. Host ceilings disabled so only the
    VRAM branch can fire."""
    monkeypatch.setenv("SIDECAR_RESTART_MB", "0")  # host hard disabled
    monkeypatch.setenv("SIDECAR_RECYCLE_SOFT_MB", "0")  # host soft disabled
    monkeypatch.setenv("SIDECAR_RSS_WARN_MB", "0")  # skip the reclaim branch
    monkeypatch.setenv("SIDECAR_VRAM_RECYCLE_SOFT_MB", "7000")
    monkeypatch.setenv("SIDECAR_VRAM_RESTART_MB", "8000")
    monkeypatch.setattr(main, "_recycle_pending", False)
    monkeypatch.setattr(main, "_process_mem", lambda: {"rss_mb": 5000.0})
    monkeypatch.setattr(main, "_process_commit_mb", lambda: 5000.0)
    # reserved 7500: soft(7000) <= reserved < hard(8000) on an 8188MB card.
    monkeypatch.setattr(main, "_cuda_vram_mb", lambda: (5000.0, 7500.0, 8188.0))
    scheduled: list = []
    monkeypatch.setattr(main, "_schedule_restart_exit", lambda *a: scheduled.append(a))
    monkeypatch.setattr(main.asyncio, "sleep", _fake_sleep_breaking_after(2))

    with pytest.raises(_StopLoop):
        asyncio.run(main._memory_watchdog())

    assert main._recycle_pending is True
    assert scheduled == [], "VRAM soft recycle must NOT trigger the hard self-exit"


def test_watchdog_vram_hard_exits(monkeypatch):
    """Reserved VRAM at/above the hard ceiling schedules the self-exit, labelled
    'reserved VRAM' so the log names which pressure tripped."""
    monkeypatch.setenv("SIDECAR_RESTART_MB", "0")  # host hard disabled
    monkeypatch.setenv("SIDECAR_RECYCLE_SOFT_MB", "0")
    monkeypatch.setenv("SIDECAR_RSS_WARN_MB", "0")
    monkeypatch.setenv("SIDECAR_VRAM_RECYCLE_SOFT_MB", "7000")
    monkeypatch.setenv("SIDECAR_VRAM_RESTART_MB", "8000")
    monkeypatch.setattr(main, "_recycle_pending", False)
    monkeypatch.setattr(main, "_process_mem", lambda: {"rss_mb": 5000.0})
    monkeypatch.setattr(main, "_process_commit_mb", lambda: 5000.0)
    monkeypatch.setattr(main, "_cuda_vram_mb", lambda: (8050.0, 8100.0, 8188.0))
    scheduled: list = []
    monkeypatch.setattr(main, "_schedule_restart_exit", lambda *a: scheduled.append(a))
    monkeypatch.setattr(main.asyncio, "sleep", _fake_sleep_breaking_after(2))

    with pytest.raises(_StopLoop):
        asyncio.run(main._memory_watchdog())

    assert len(scheduled) == 1, "VRAM hard ceiling must schedule the recycle exit"
    assert scheduled[0][2] == "reserved VRAM", "exit log must name the VRAM ceiling"
    assert main._recycle_pending is False, "hard branch continues before the soft branch"


def test_watchdog_no_vram_branch_when_cuda_unavailable(monkeypatch):
    """When CUDA is unavailable (_cuda_vram_mb → all None) the VRAM branches are
    skipped entirely — no crash, no spurious recycle."""
    monkeypatch.setenv("SIDECAR_RESTART_MB", "0")
    monkeypatch.setenv("SIDECAR_RECYCLE_SOFT_MB", "0")
    monkeypatch.setenv("SIDECAR_RSS_WARN_MB", "0")
    monkeypatch.setattr(main, "_recycle_pending", False)
    monkeypatch.setattr(main, "_process_mem", lambda: {"rss_mb": 5000.0})
    monkeypatch.setattr(main, "_process_commit_mb", lambda: 5000.0)
    monkeypatch.setattr(main, "_cuda_vram_mb", lambda: (None, None, None))
    scheduled: list = []
    monkeypatch.setattr(main, "_schedule_restart_exit", lambda *a: scheduled.append(a))
    monkeypatch.setattr(main.asyncio, "sleep", _fake_sleep_breaking_after(2))

    with pytest.raises(_StopLoop):
        asyncio.run(main._memory_watchdog())

    assert main._recycle_pending is False
    assert scheduled == []


def test_health_reports_vram_fields(monkeypatch):
    """/health exposes `vram_reserved_mb` / `vram_total_mb` so the dev can watch
    headroom off the same poll."""
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    monkeypatch.setitem(main.ENGINES, "qwen", main.QwenEngine())
    monkeypatch.setattr(main, "_cuda_vram_mb", lambda: (5000.0, 7500.0, 8188.0))
    with TestClient(main.app) as client:
        body = client.get("/health").json()
    assert body["vram_reserved_mb"] == 7500.0
    assert body["vram_total_mb"] == 8188.0


def test_qwen_unload_waits_for_synth_lock(monkeypatch):
    """unload() must acquire `_synth_lock` before nulling `_base`, so it can't
    drop the model out from under an in-flight forward. Without the lock the
    running forward keeps the old model alive past the null → its VRAM can't be
    reclaimed → the next /load stacks a SECOND copy (the 2026-06-01 reload spill).
    Mirrors the drain-fence test: hold the lock, confirm unload blocks, release,
    confirm it completes."""
    counting = _CountingGc(main.gc)
    monkeypatch.setattr(main, "gc", counting)
    # Avoid a real CUDA call in the delta-log + keep it deterministic.
    monkeypatch.setattr(main, "_cuda_vram_mb", lambda: (None, None, None))

    engine = main.QwenEngine()
    engine._base = object()

    engine._synth_lock.acquire()  # simulate a forward in flight
    done: list[int] = []
    t = threading.Thread(target=lambda: (engine.unload(), done.append(1)))
    t.start()
    try:
        time.sleep(0.2)
        assert engine._base is not None, "unload must BLOCK while _synth_lock is held"
        assert done == []
    finally:
        engine._synth_lock.release()

    t.join(timeout=2)
    assert engine._base is None, "unload completes once the forward releases the lock"
    assert done == [1]
    assert counting.collect_calls >= 1


def test_health_exposes_qwen_design_ever_loaded(monkeypatch):
    """/health exposes `qwen_design_ever_loaded` as False on a fresh process so
    the Node telemetry can exclude design-contaminated processes from synth/coqui
    VRAM sampling (fs-45 clean-process gate)."""
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    monkeypatch.setitem(main.ENGINES, "qwen", main.QwenEngine())
    # `_QWEN_DESIGN_EVER_LOADED` is a process-lifetime module global; another test
    # in the same pytest process may have loaded VoiceDesign and flipped it True.
    # Pin it deterministically (monkeypatch auto-restores) and assert BOTH states.
    monkeypatch.setattr(main, "_QWEN_DESIGN_EVER_LOADED", False)
    with TestClient(main.app) as client:
        body = client.get("/health").json()
    assert body["qwen_design_ever_loaded"] is False  # fresh / clean process

    monkeypatch.setattr(main, "_QWEN_DESIGN_EVER_LOADED", True)
    with TestClient(main.app) as client:
        body = client.get("/health").json()
    assert body["qwen_design_ever_loaded"] is True  # after a design load
