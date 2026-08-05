"""#1944 — the speechbrain lazy-proxy disarm helper.

Root cause (full writeup in the issue's implementation-brief comment):
speechbrain 1.1.0 leaves several `LazyModule` / `DeprecatedModuleRedirect`
proxies in `sys.modules` after an ECAPA import. Their `__getattr__` raises
`ImportError` (not `AttributeError`) when the backing optional dep (e.g. k2)
is missing. CPython's `inspect.getmodule()` walks every entry in
`sys.modules` on a cache miss and does `hasattr(module, '__file__')` on each
one; `hasattr` only swallows `AttributeError`, so the proxy's `ImportError`
escapes and detonates whatever unrelated code triggered the walk — observed
as `import TTS.api` failing only in a sidecar process that has already served
an ECAPA `/embed`.

Two of the investigator's own probes passed VACUOUSLY before this was caught
(one `inspect.getmodule` probe short-circuited on `__module__` and never
walked `sys.modules`; one disarm probe used a wrong `ensure_module(1)`
signature so every proxy "failed" identically with `ValueError`). Test 1
below exists specifically to prove the precondition — that the bug is real —
rather than assume it."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

# The real speechbrain package (installed in this venv — the sidecar's own
# dependency) supplies the real LazyModule base class. Subclassing it (rather
# than a hand-rolled stand-in) means `isinstance(m, LazyModule)` inside the
# helper under test genuinely exercises the same check production hits.
#
# speechbrain lives in requirements/speaker-qa.txt (NOT base.txt) because it
# pulls torch, so the lean CI venv does not have it. Same treatment as
# test_speaker_embed.py:21.
_sb_importutils = pytest.importorskip("speechbrain.utils.importutils")
LazyModule = _sb_importutils.LazyModule


class _AlwaysFailingLazyModule(LazyModule):
    """A proxy whose backing target can never be resolved — mirrors a real
    speechbrain redirect pointed at a missing optional dep (e.g. k2)."""

    def ensure_module(self, stacklevel: int):
        raise ImportError("Lazy import of FakeModule(target=fake.missing) failed")


class _RecordingLazyModule(LazyModule):
    """A proxy that records (and fails loudly on) any attempt to resolve it —
    used to prove the disarm never probes."""

    def __init__(self, name: str, target: str, calls: list[str]) -> None:
        super().__init__(name, target, None)
        self._calls = calls

    def ensure_module(self, stacklevel: int):
        # `self.__name__` (a real ModuleType attribute, set by
        # ModuleType.__init__) — NOT `self.name`, which isn't a real
        # attribute and would recurse back into LazyModule.__getattr__ ->
        # this very method.
        self._calls.append(self.__name__)
        raise AssertionError(
            f"disarm must never call ensure_module (probed {self.__name__!r})"
        )


def test_precondition_lazy_proxy_hasattr_raises_importerror_before_any_fix(monkeypatch):
    """Assert-your-preconditions (per the brief's own vacuous-probe warning):
    install a LazyModule proxy whose target can never resolve, and PROVE
    `hasattr(m, '__file__')` propagates `ImportError` — this is the literal
    mechanism `inspect.getmodule()` trips over. A test that skipped this
    assertion could pass for the wrong reason."""
    proxy = _AlwaysFailingLazyModule("fake.always_fails", "fake.missing", None)
    monkeypatch.setitem(sys.modules, "fake.always_fails", proxy)

    with pytest.raises(ImportError):
        hasattr(proxy, "__file__")


def test_disarm_evicts_the_broken_proxy_red_then_green(monkeypatch):
    """Same setup as the precondition test above, but now run the disarm
    helper: it must evict the proxy from sys.modules and report its name."""
    proxy = _AlwaysFailingLazyModule("fake.always_fails", "fake.missing", None)
    monkeypatch.setitem(sys.modules, "fake.always_fails", proxy)

    evicted = main._disarm_speechbrain_lazy_modules()

    assert "fake.always_fails" in evicted
    assert "fake.always_fails" not in sys.modules


def test_disarm_never_probes_the_proxy_it_evicts(monkeypatch):
    """Stops candidate C-surgical (probe-then-evict-only-the-failures) from
    being reintroduced: probing a proxy imports its backing package (e.g.
    transformers), which half-loads it and breaks the subsequent `TTS.api`
    import a SECOND, more confusing way (a duplicate `wait_tensor` kernel
    registration RuntimeError — measured during this issue's investigation).
    The disarm must evict WITHOUT ever calling `ensure_module`."""
    calls: list[str] = []
    proxy = _RecordingLazyModule("fake.recording", "fake.recording_target", calls)
    monkeypatch.setitem(sys.modules, "fake.recording", proxy)

    evicted = main._disarm_speechbrain_lazy_modules()

    assert "fake.recording" in evicted
    assert calls == [], "disarm invoked ensure_module -- it must evict unconditionally, never probe"


def test_disarm_no_ops_safely_when_lazymodule_cannot_be_imported(monkeypatch):
    """A future speechbrain release that renames/drops LazyModule must not
    crash ECAPA loading, which currently works. Simulate the import failing
    via the standard `sys.modules[name] = None` halt-on-reimport mechanism."""
    monkeypatch.setitem(sys.modules, "speechbrain.utils.importutils", None)

    assert main._disarm_speechbrain_lazy_modules() == []


def test_disarm_sweeps_multiple_proxies_including_the_deprecated_redirect_subclass(monkeypatch):
    """`isinstance(m, LazyModule)` must catch BOTH the base class AND its
    `DeprecatedModuleRedirect` subclass in one unconditional sweep — the
    implementation must never enumerate proxy names by hand (that list would
    silently go stale against a future speechbrain release)."""
    from speechbrain.utils.importutils import DeprecatedModuleRedirect

    base_proxy = _AlwaysFailingLazyModule("fake.base_proxy", "fake.base_target", None)
    redirect_proxy = DeprecatedModuleRedirect(
        old_import="fake.old_path", new_import="fake.recording_target"
    )
    monkeypatch.setitem(sys.modules, "fake.base_proxy", base_proxy)
    monkeypatch.setitem(sys.modules, "fake.old_path", redirect_proxy)

    evicted = main._disarm_speechbrain_lazy_modules()

    assert "fake.base_proxy" in evicted
    assert "fake.old_path" in evicted
    assert "fake.base_proxy" not in sys.modules
    assert "fake.old_path" not in sys.modules
