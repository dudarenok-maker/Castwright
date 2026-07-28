"""InFlightCounter (#1917) — the counter guarding each engine's forward.

`x += 1` on an attribute is LOAD_ATTR / BINARY_OP / STORE_ATTR, and CPython can
switch threads between any two of them. Two concurrent forwards can therefore
lose a decrement, leaving the counter stuck above zero — and because the evict
predicate is `> 0`, that disables that engine's eviction for the rest of the
process lifetime, silently.
"""
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


def test_a_concurrent_claim_blocks_on_the_counter_lock():
    """Companion to the deterministic gate above: hold the counter's own lock,
    then prove a concurrent claim BLOCKS on it rather than racing past.

    Catches a strict subset of what the gate above catches — only the
    lock-free mutant, not a "takes the lock for nothing, mutates outside it"
    mutant (that one still blocks here, since it does take `_lock` — it just
    doesn't guard `_n` with it). Fails against a lock-free `+=`: with no lock
    to block on, the worker thread runs `+= 1` immediately and exits before
    `t.join(0.5)` returns, so `t.is_alive()` is False — that assertion is the
    discriminator, not `_n`, which reads 0 either way (the empty claim body
    means the lock-free mutant's decrement has already run too).
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
