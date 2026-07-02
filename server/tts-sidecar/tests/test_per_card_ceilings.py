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
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "1024")
    tm = _fake_torch_with_reserved(free_mb=500, reserved_mb=100)  # free < floor
    ledger = main.DeviceLedger(tm)
    breach = main._check_per_card_ceilings(ledger, tm)
    assert breach == {"uuid": "GPU-0", "idx": 0, "reason": "driver_free_floor"}


def test_check_per_card_ceilings_flags_reserved_ceiling(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "100")  # low floor so it doesn't fire first
    tm = _fake_torch_with_reserved(free_mb=2000, reserved_mb=15700)  # reserved >= 0.98*16000
    ledger = main.DeviceLedger(tm)
    breach = main._check_per_card_ceilings(ledger, tm)
    assert breach == {"uuid": "GPU-0", "idx": 0, "reason": "reserved_vram_ceiling"}


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
