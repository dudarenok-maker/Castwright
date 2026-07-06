import importlib, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


def _fake_torch_with_reserved(free_mb, reserved_mb):
    def props(i):
        return types.SimpleNamespace(name="Card", total_memory=16 * 10**6 * 1000, uuid=f"GPU-{i}")
    cuda = types.SimpleNamespace(
        is_available=lambda: True, device_count=lambda: 1,
        get_device_properties=props,
        mem_get_info=lambda i: (free_mb * 1_000_000, 16000 * 1_000_000),
        memory_reserved=lambda i: reserved_mb * 1_000_000)
    return types.SimpleNamespace(cuda=cuda)


def test_free_floor_default_1024(monkeypatch):
    monkeypatch.delenv("SIDECAR_VRAM_FREE_FLOOR_MB", raising=False)
    assert main._sidecar_vram_free_floor_mb() == 1024.0


def test_free_floor_env_override(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "2048")
    assert main._sidecar_vram_free_floor_mb() == 2048.0


def test_check_per_card_ceilings_flags_floor_breach(monkeypatch):
    """Floor fires on a card torch is NOT actively managing (reserved below
    _TORCH_ACTIVE_RESERVED_MB) — the ORT/CT2-only guard the floor exists for.
    The breach now carries the breaching reading + limit so the trip log names
    real numbers (was "0MB crossed ... 0MB")."""
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "1024")
    tm = _fake_torch_with_reserved(free_mb=500, reserved_mb=100)  # free < floor
    ledger = main.DeviceLedger(tm)
    breach = main._check_per_card_ceilings(ledger, tm)
    assert breach == {
        "uuid": "GPU-0", "idx": 0, "reason": "driver_free_floor",
        "metric_mb": 500.0, "threshold_mb": 1024.0,
    }


def test_check_per_card_ceilings_floor_skipped_on_torch_active_card(monkeypatch):
    """The 2026-07-06 recycle storm: torch actively reserves on the card, so a
    routine 1.7B batch peak legitimately drives driver-free below the floor.
    The floor must NOT flag it — OOM protection there is the reserved ceiling
    (and the queue-level storm breaker otherwise pauses the whole run)."""
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "1024")
    tm = _fake_torch_with_reserved(free_mb=500, reserved_mb=6000)  # free < floor, torch active
    ledger = main.DeviceLedger(tm)
    assert main._check_per_card_ceilings(ledger, tm) is None


def test_check_per_card_ceilings_floor_applies_when_torch_unreadable(monkeypatch):
    """torch reserved unreadable for the card (ORT/CT2-only deployment) → the
    card is treated as non-torch and the floor still guards it — the guard's
    original purpose survives the scoping fix."""
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "1024")
    tm = _fake_torch_with_reserved(free_mb=500, reserved_mb=100)

    def boom(i):
        raise RuntimeError("no torch context on this card")

    tm.cuda.memory_reserved = boom
    ledger = main.DeviceLedger(tm)
    breach = main._check_per_card_ceilings(ledger, tm)
    assert breach is not None and breach["reason"] == "driver_free_floor"


def test_check_per_card_ceilings_flags_reserved_ceiling(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "100")  # low floor so it doesn't fire first
    tm = _fake_torch_with_reserved(free_mb=2000, reserved_mb=15700)  # reserved >= 0.98*16000
    ledger = main.DeviceLedger(tm)
    breach = main._check_per_card_ceilings(ledger, tm)
    assert breach is not None
    assert breach["reason"] == "reserved_vram_ceiling"
    assert breach["uuid"] == "GPU-0" and breach["idx"] == 0
    assert breach["metric_mb"] == 15700.0
    assert breach["threshold_mb"] == main._card_reserved_ceiling_mb(16000.0)


def test_check_per_card_ceilings_none_when_healthy(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "1024")
    tm = _fake_torch_with_reserved(free_mb=8000, reserved_mb=4000)
    ledger = main.DeviceLedger(tm)
    assert main._check_per_card_ceilings(ledger, tm) is None


def test_schedule_restart_exit_accepts_card(monkeypatch):
    """card= is a new optional kwarg — existing (no-card) callers keep working."""
    main._reset_restart_state_for_test()
    monkeypatch.setattr(main, "_drain_grace_ms", lambda: 0)
    monkeypatch.setattr(main.threading, "Thread", lambda target, args, daemon: types.SimpleNamespace(start=lambda: None))
    try:
        main._schedule_restart_exit(500.0, 400.0, "reserved VRAM", card={"uuid": "GPU-1", "idx": 1})
        assert main._last_restart_card == {"uuid": "GPU-1", "idx": 1}
    finally:
        # _restart_scheduled/_restart_pending/_last_restart_card are module
        # globals mutated directly (not via monkeypatch.setattr) — clear them
        # so this test doesn't leak a "restart pending" state (503 fast-fail)
        # into every test file that runs after this one in the same session.
        main._reset_restart_state_for_test()


def test_write_restart_breadcrumb_persists_card(tmp_path, monkeypatch):
    breadcrumb = tmp_path / ".run" / "last-restart-trip.json"
    monkeypatch.setattr(main, "_RESTART_BREADCRUMB_PATH", str(breadcrumb))
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {1: [{"engine": "coqui", "actual_card": 1}]})
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    main._write_restart_breadcrumb({"uuid": "GPU-1", "idx": 1}, "reserved VRAM")
    import json
    body = json.loads(breadcrumb.read_text(encoding="utf-8"))
    assert body["card"] == {"uuid": "GPU-1", "idx": 1}
    assert body["reason"] == "reserved VRAM"
    assert body["residentEngines"] == ["coqui"]
    assert "ts" in body


def test_write_restart_breadcrumb_never_raises_on_failure(tmp_path, monkeypatch):
    """A write failure (here: the breadcrumb's parent directory component is
    actually a file, so os.makedirs can never succeed) must never raise into
    the caller — this is on the sidecar's self-exit path, where an unhandled
    exception would break the drain-and-restart flow itself."""
    blocker = tmp_path / "not_a_dir"
    blocker.write_text("x")  # a regular file occupying the path a directory needs
    breadcrumb = blocker / "sub" / "x.json"
    monkeypatch.setattr(main, "_RESTART_BREADCRUMB_PATH", str(breadcrumb))
    main._write_restart_breadcrumb(None, "committed memory")  # must not raise


def test_schedule_restart_exit_writes_breadcrumb(tmp_path, monkeypatch):
    main._reset_restart_state_for_test()
    breadcrumb = tmp_path / "trip.json"
    monkeypatch.setattr(main, "_RESTART_BREADCRUMB_PATH", str(breadcrumb))
    monkeypatch.setattr(main, "_drain_grace_ms", lambda: 0)
    monkeypatch.setattr(main.threading, "Thread", lambda target, args, daemon: types.SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {})
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    try:
        main._schedule_restart_exit(500.0, 400.0, "reserved VRAM", card={"uuid": "GPU-1", "idx": 1})
        assert breadcrumb.exists()
    finally:
        # _restart_scheduled/_restart_pending/_last_restart_card are module
        # globals mutated directly (not via monkeypatch.setattr) — clear them
        # so this test doesn't leak a "restart pending" state (503 fast-fail)
        # into every test file that runs after this one in the same session.
        main._reset_restart_state_for_test()
