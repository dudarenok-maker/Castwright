"""Regression (side-11 / 2026-05-31): a Qwen load that FAILS after it has
materialised weights must reclaim the partial allocation before re-raising.

The dominant failed-reload shape is `inner.to(device)` hitting a CUDA OOM partway
through moving weights to a card that is already pressured. The partially-built
`Qwen3TTSModel` is an `nn.Module` whose reference CYCLES keep its tensors alive
past the failing frame (refcount alone won't free them), and `_ensure_*_loaded`
never assigns it to `self._base`/`self._design`, so without an explicit reclaim
nothing frees it — repeated failed reloads then orphan VRAM (the measured ~9.9 GB
CUDA-allocated with `base_loaded=false`). The fix wraps the load so it runs the
gc+empty_cache reclaim on failure, mirroring `unload()`.

CI has no GPU, so these pin the reclaim-on-failure CONTRACT (the reclaim runs and
no half-built model is left assigned), not actual byte counts.
"""

import sys
import time
import types
from typing import Any

import pytest

import main


class _RaisingInner:
    """The inner nn.Module of the Qwen3TTSModel wrapper — the only object with a
    `.to()`. Here `.to(device)` raises, simulating a CUDA OOM partway through the
    move to the GPU."""

    def __init__(self) -> None:
        self.device: Any = None
        self.config = types.SimpleNamespace(_attn_implementation="sdpa")

    def to(self, _device: Any) -> Any:
        raise RuntimeError("CUDA out of memory: tried to allocate 2.00 GiB (move failed)")


class _PartialFakeQwen:
    """from_pretrained SUCCEEDS (weights materialised on CPU) but the subsequent
    move to device fails — the exact partial-load shape that orphaned VRAM."""

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.model = _RaisingInner()
        self.device: Any = None

    @classmethod
    def from_pretrained(cls, model_id: str, **_kwargs: Any) -> "_PartialFakeQwen":
        return cls(model_id)


@pytest.fixture
def qwen_load_failure_runtime(monkeypatch):
    """Stub qwen_tts + torch so a load materialises then fails on `.to(device)`,
    and spy on `_reclaim_host_and_vram` to assert it runs on the failure path."""
    fake_qwen = types.ModuleType("qwen_tts")
    fake_qwen.Qwen3TTSModel = _PartialFakeQwen  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "qwen_tts", fake_qwen)

    fake_torch = types.ModuleType("torch")
    fake_torch.bfloat16 = "bfloat16"  # type: ignore[attr-defined]
    fake_torch.device = lambda d: d  # type: ignore[attr-defined]
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: True, empty_cache=lambda: None, device_count=lambda: 1
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    # The fake torch has no real perf-flag surface — neutralise the hook.
    monkeypatch.setattr(main, "_apply_torch_perf_flags", lambda _t: None)

    calls = {"reclaim": 0}
    monkeypatch.setattr(
        main, "_reclaim_host_and_vram", lambda: calls.__setitem__("reclaim", calls["reclaim"] + 1)
    )

    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)
    engine._base = None
    engine._design = None
    yield {"engine": engine, "calls": calls}
    engine._base = None
    engine._design = None


def test_load_failure_reclaims_partial_allocation(qwen_load_failure_runtime) -> None:
    engine = qwen_load_failure_runtime["engine"]
    calls = qwen_load_failure_runtime["calls"]
    with pytest.raises(RuntimeError, match="out of memory"):
        engine._load_qwen_model(engine.BASE_MODEL)
    assert calls["reclaim"] == 1, "a failed load must run _reclaim_host_and_vram before re-raising"


def test_ensure_base_loaded_leaves_no_model_on_failure(qwen_load_failure_runtime) -> None:
    """A failed cold load must NOT leave a half-built model assigned to `_base`
    (which would make the next call think it's loaded and skip a real reload), and
    must have reclaimed the partial allocation."""
    engine = qwen_load_failure_runtime["engine"]
    calls = qwen_load_failure_runtime["calls"]
    with pytest.raises(RuntimeError, match="out of memory"):
        engine._ensure_base_loaded()
    assert engine._base is None
    assert calls["reclaim"] == 1


def test_ensure_design_loaded_leaves_no_model_on_failure(qwen_load_failure_runtime) -> None:
    engine = qwen_load_failure_runtime["engine"]
    calls = qwen_load_failure_runtime["calls"]
    with pytest.raises(RuntimeError, match="out of memory"):
        engine._ensure_design_loaded()
    assert engine._design is None
    assert calls["reclaim"] == 1


def test_oom_load_failure_does_not_schedule_a_restart(qwen_load_failure_runtime) -> None:
    """The plain CUDA-OOM `.to(device)` failure above is a DIFFERENT, already-
    handled fault (retrying eventually succeeds once VRAM frees up) — it must
    NOT trigger the meta-tensor fault's self-recycle."""
    engine = qwen_load_failure_runtime["engine"]
    calls = {"scheduled": 0}
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            main, "_schedule_model_load_fault_restart",
            lambda *a, **k: calls.__setitem__("scheduled", calls["scheduled"] + 1),
        )
        with pytest.raises(RuntimeError, match="out of memory"):
            engine._load_qwen_model(engine.BASE_MODEL)
    assert calls["scheduled"] == 0


class _MetaTensorRaisingInner:
    """Simulates the recurring "Cannot copy out of meta tensor" fault: some
    submodule the checkpoint doesn't cover landed on the meta device, and
    `.to(device)` cannot materialise it (side-11-adjacent, recurring since
    2026-05-26 — see _schedule_model_load_fault_restart)."""

    def __init__(self) -> None:
        self.device: Any = None
        self.config = types.SimpleNamespace(_attn_implementation="sdpa")

    def to(self, _device: Any) -> Any:
        raise NotImplementedError(
            "Cannot copy out of meta tensor; no data! Please use "
            "torch.nn.Module.to_empty() instead of torch.nn.Module.to() "
            "when moving module from meta to a different device."
        )


class _MetaTensorFakeQwen:
    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.model = _MetaTensorRaisingInner()
        self.device: Any = None

    @classmethod
    def from_pretrained(cls, model_id: str, **_kwargs: Any) -> "_MetaTensorFakeQwen":
        return cls(model_id)


@pytest.fixture
def qwen_meta_tensor_failure_runtime(monkeypatch):
    """Same stubbed qwen_tts/torch runtime as `qwen_load_failure_runtime`, but
    the `.to(device)` failure is the meta-tensor NotImplementedError rather
    than a CUDA OOM."""
    fake_qwen = types.ModuleType("qwen_tts")
    fake_qwen.Qwen3TTSModel = _MetaTensorFakeQwen  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "qwen_tts", fake_qwen)

    fake_torch = types.ModuleType("torch")
    fake_torch.bfloat16 = "bfloat16"  # type: ignore[attr-defined]
    fake_torch.device = lambda d: d  # type: ignore[attr-defined]
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: True, empty_cache=lambda: None, device_count=lambda: 1
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setattr(main, "_apply_torch_perf_flags", lambda _t: None)
    monkeypatch.setattr(main, "_reclaim_host_and_vram", lambda: None)

    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)
    engine._base = None
    engine._design = None
    yield engine
    engine._base = None
    engine._design = None


def test_meta_tensor_load_failure_schedules_a_fault_restart(qwen_meta_tensor_failure_runtime, monkeypatch) -> None:
    """The known-only-a-fresh-process-clears-it fault must schedule a self-
    recycle (distinct exit code from the memory-watchdog path — see
    _MODEL_LOAD_FAULT_EXIT_CODE) AND still propagate the 500 to the caller
    unchanged, so the current request gets a real error."""
    engine = qwen_meta_tensor_failure_runtime
    scheduled: list[tuple[Any, ...]] = []
    monkeypatch.setattr(
        main, "_schedule_model_load_fault_restart",
        lambda *a: scheduled.append(a),
    )
    with pytest.raises(NotImplementedError, match="meta tensor"):
        engine._load_qwen_model(engine.VOICEDESIGN_MODEL)
    assert scheduled == [(engine.VOICEDESIGN_MODEL, scheduled[0][1])]
    assert "meta tensor" in scheduled[0][1].lower()


def test_schedule_model_load_fault_restart_is_idempotent_and_uses_its_own_exit_code(monkeypatch) -> None:
    """Mirrors test_schedule_restart_is_idempotent, but for the load-fault
    trigger: two faults schedule exactly ONE exit, and it fires with
    _MODEL_LOAD_FAULT_EXIT_CODE — NOT _RESTART_EXIT_CODE (43), so the Node
    supervisor's code-43 streak-trip never sees this fault class."""
    calls: list[int] = []
    monkeypatch.setattr(main, "_restart_now", lambda code=None: calls.append(code))
    monkeypatch.setattr(main, "_restart_scheduled", False)
    monkeypatch.setattr(main, "_restart_pending", False)
    monkeypatch.setattr(main, "_inflight_synth", 0)
    monkeypatch.setattr(main, "_POISON_EXIT_DELAY_MS", 50)
    monkeypatch.setattr(main, "_write_restart_breadcrumb", lambda *a, **k: None)

    main._schedule_model_load_fault_restart("qwen-voicedesign", "meta tensor boom")
    main._schedule_model_load_fault_restart("qwen-voicedesign", "second call must be a no-op")
    assert main._restart_scheduled is True
    assert main._restart_pending is True

    time.sleep(0.5)
    assert calls == [main._MODEL_LOAD_FAULT_EXIT_CODE]
    assert main._MODEL_LOAD_FAULT_EXIT_CODE != main._RESTART_EXIT_CODE
