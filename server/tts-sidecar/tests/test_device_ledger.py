import importlib, os, sys, threading, time, types
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


def _fake_torch(uuids=("GPU-0", "GPU-1")):
    def props(i):
        return types.SimpleNamespace(name=["RTX 4070", "RTX 5070 Ti"][i],
                                     total_memory=[8 * 10**9, 16 * 10**9][i], uuid=uuids[i])
    cuda = types.SimpleNamespace(
        is_available=lambda: True, device_count=lambda: 2,
        get_device_properties=props,
        mem_get_info=lambda i: ([6 * 10**9, 14 * 10**9][i], [8 * 10**9, 16 * 10**9][i]))
    return types.SimpleNamespace(cuda=cuda)


def test_ledger_sample_returns_card_row():
    ledger = main.DeviceLedger(_fake_torch())
    row = ledger.sample(1)
    assert row == {"uuid": "GPU-1", "idx": 1, "name": "RTX 5070 Ti", "total_mb": 16000, "free_mb": 14000}


def test_ledger_sample_none_for_out_of_range_idx():
    ledger = main.DeviceLedger(_fake_torch())
    assert ledger.sample(9) is None


def test_ledger_flags_vanished_on_uuid_mismatch():
    """A renumbered card (same idx, different physical GPU) must be reported as
    vanished (None), NEVER silently read as if it were the originally-seen card."""
    fake = _fake_torch()
    ledger = main.DeviceLedger(fake)
    assert ledger.sample(1)["uuid"] == "GPU-1"  # seeds known uuid at idx 1
    fake.cuda.get_device_properties = lambda i: types.SimpleNamespace(
        name="Different Card", total_memory=16 * 10**9, uuid="GPU-DIFFERENT")
    assert ledger.sample(1) is None


def test_ledger_sample_all_revalidates_every_card():
    ledger = main.DeviceLedger(_fake_torch())
    rows = ledger.sample_all()
    assert [r["idx"] for r in rows] == [0, 1]


def test_ledger_sample_all_empty_without_cuda():
    fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    ledger = main.DeviceLedger(fake)
    assert ledger.sample_all() == []


def test_ledger_card_lock_is_per_idx_and_stable():
    ledger = main.DeviceLedger(_fake_torch())
    lock0a = ledger.card_lock(0)
    lock0b = ledger.card_lock(0)
    lock1 = ledger.card_lock(1)
    assert lock0a is lock0b
    assert lock0a is not lock1


def test_ledger_sample_all_does_not_deadlock():
    """sample_all() must not call the public sample() (which re-acquires the
    lock) while already holding it — a naive implementation deadlocks here."""
    import threading
    ledger = main.DeviceLedger(_fake_torch())
    done = threading.Event()

    def worker():
        ledger.sample_all()
        done.set()

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout=2.0)
    assert done.is_set(), "sample_all() deadlocked"


def test_card_lock_serialises_two_threads_on_same_idx():
    ledger = main.DeviceLedger(_fake_torch())
    order = []

    def worker(name, hold_ms):
        with ledger.card_lock(1):
            order.append(f"{name}-start")
            time.sleep(hold_ms / 1000.0)
            order.append(f"{name}-end")

    t1 = threading.Thread(target=worker, args=("a", 100))
    t2 = threading.Thread(target=worker, args=("b", 0))
    t1.start()
    time.sleep(0.02)  # ensure t1 has the lock first
    t2.start()
    t1.join(timeout=2.0)
    t2.join(timeout=2.0)
    # b must not start until a has fully finished — proves serialisation, not just mutual presence.
    assert order == ["a-start", "a-end", "b-start", "b-end"]
