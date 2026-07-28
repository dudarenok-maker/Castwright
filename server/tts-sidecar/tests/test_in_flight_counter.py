"""InFlightCounter (#1917) — the counter guarding each engine's forward.

`x += 1` on an attribute is LOAD_ATTR / BINARY_OP / STORE_ATTR, and CPython can
switch threads between any two of them. Two concurrent forwards can therefore
lose a decrement, leaving the counter stuck above zero — and because the evict
predicate is `> 0`, that disables that engine's eviction for the rest of the
process lifetime, silently.
"""
import sys
import threading

import main


def test_the_mutation_happens_between_acquire_and_release():
    """THE GATE. Deterministic, single-threaded, no timing.

    Reads the counter's RAW `_n` at each lock boundary — not `.value` / `.busy`,
    which re-acquire and would deadlock against a real inner lock.

    Fails against the wrong implementation: with `self._n += 1` outside the
    `with`, the enter/exit pair reads (0, 0) instead of (0, 1) — or there are no
    events at all, because a lock-free version never touches `_lock`.

    Note what this catches that a weaker spy would not: asserting merely that
    "one acquire/release pair happened per claim" passes against an
    implementation that takes the lock for nothing and mutates outside it.
    The VALUE at the boundary is the discriminator.
    """
    events: list[tuple[str, int]] = []

    class Spy:
        def __enter__(self):
            events.append(("enter", c._n))
            return self

        def __exit__(self, *a):
            events.append(("exit", c._n))
            return False

    c = main.InFlightCounter(lock=Spy())
    with c.claim():
        pass
    assert events == [("enter", 0), ("exit", 1), ("enter", 1), ("exit", 0)]


def test_the_mutation_is_guarded_by_the_lock_not_merely_adjacent_to_it():
    """Stronger companion to the test above: hold the counter's own lock, then
    prove a concurrent claim BLOCKS on it rather than racing past.

    Fails against the wrong implementation: a lock-free `+=` completes
    immediately, so the thread is dead and `_n` is 1.
    """
    c = main.InFlightCounter()
    started = threading.Event()

    def worker():
        started.set()
        with c.claim():
            pass

    with c._lock:
        t = threading.Thread(target=worker)
        t.start()
        assert started.wait(2)
        t.join(0.5)
        assert t.is_alive()      # blocked on the lock we hold
        assert c._n == 0         # and it has NOT mutated
    t.join(2)
    assert c._n == 0


def test_concurrent_claims_return_to_zero():
    """Realism check: heavy contention must leave the counter at exactly 0.

    Fails against the wrong implementation reliably (not certainly) with the
    switch interval dialled down — a lost decrement leaves a positive residue.
    Paired with the deterministic test above, which is the real gate.
    """
    c = main.InFlightCounter()
    barrier = threading.Barrier(8)
    old_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        def worker():
            barrier.wait()
            for _ in range(5000):
                with c.claim():
                    pass

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        sys.setswitchinterval(old_interval)
    assert c.value == 0
    assert c.busy is False


def test_busy_reflects_an_outstanding_claim():
    c = main.InFlightCounter()
    assert c.busy is False
    with c.claim():
        assert c.busy is True
    assert c.busy is False


def test_claim_releases_on_exception():
    c = main.InFlightCounter()
    try:
        with c.claim():
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert c.busy is False
    assert c.value == 0
