"""Register row A28 (discharged 2026-08-31 on-box run) -- `onnxruntime.preload_dlls()`
only preloads the fixed set of DLLs onnxruntime itself links against
(cublas/cublasLt/cufft/cudart plus a single cudnn entry point). cuDNN 9's own
"engine" plugin DLLs (`cudnn_engines_tensor_ir64_9.dll` and siblings) are
dlopened lazily by cuDNN itself, on demand, the first time a real kernel is
built -- long after `preload_dlls()` has already returned. Confirmed on real
hardware: `os.add_dll_directory()` (what `preload_dlls()` uses internally)
does not make these findable; only prepending the directories to the process
`PATH` env var does. `main._add_nvidia_dll_dirs_to_path()` is the fix.

This suite pins: (1) every `nvidia/<pkg>/bin` directory that exists on disk
gets prepended to `PATH`, (2) a layout with no `nvidia/` directory at all
(CPU/AMD/Apple installs) is a harmless no-op, (3) onnxruntime not being
importable degrades to a no-op rather than raising, and (4) the returned list
mirrors what was actually prepended (order preserved), so a caller can log it
accurately.
"""
from __future__ import annotations

import logging
import os
import sys
import types
from pathlib import Path
from typing import Any

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def _module_with(name: str, **attrs: Any) -> types.ModuleType:
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    return mod


def _fake_onnxruntime_at(site_packages: Path) -> types.ModuleType:
    ort_dir = site_packages / "onnxruntime"
    ort_dir.mkdir(parents=True, exist_ok=True)
    init_file = ort_dir / "__init__.py"
    init_file.write_text("")
    return _module_with("onnxruntime", __file__=str(init_file))


def test_prepends_every_nvidia_bin_dir_that_exists(monkeypatch, tmp_path) -> None:
    site_packages = tmp_path / "site-packages"
    for pkg in ("cudnn", "cublas", "cufft", "cuda_runtime"):
        (site_packages / "nvidia" / pkg / "bin").mkdir(parents=True)
    # A package dir with no bin/ subdirectory must not be included.
    (site_packages / "nvidia" / "ml_py").mkdir(parents=True)

    monkeypatch.setitem(sys.modules, "onnxruntime", _fake_onnxruntime_at(site_packages))
    monkeypatch.setenv("PATH", "C:\\pre-existing")

    added = main._add_nvidia_dll_dirs_to_path()

    assert len(added) == 4
    for pkg in ("cudnn", "cublas", "cufft", "cuda_runtime"):
        expected = str(site_packages / "nvidia" / pkg / "bin")
        assert expected in added
        assert expected in os.environ["PATH"]
    assert os.environ["PATH"].endswith("C:\\pre-existing"), (
        "must PREPEND, not replace, the existing PATH"
    )
    # The returned list must mirror the actual PATH prefix order, not just its
    # membership -- a caller logs `added` to report what it did, and a caller
    # that reversed it relative to the real prefix would log something false.
    assert os.environ["PATH"] == os.pathsep.join(added) + os.pathsep + "C:\\pre-existing"


def test_empty_pre_existing_path_gains_no_trailing_separator(monkeypatch, tmp_path) -> None:
    """An empty PATH entry (not an empty PATH string) is CWD in Windows' DLL
    search order -- `"<dirs>;"` with nothing after the trailing separator
    would silently add the current directory to the search path used by
    every later lazy LoadLibrary call this function exists to serve."""
    site_packages = tmp_path / "site-packages"
    (site_packages / "nvidia" / "cudnn" / "bin").mkdir(parents=True)

    monkeypatch.setitem(sys.modules, "onnxruntime", _fake_onnxruntime_at(site_packages))
    monkeypatch.setenv("PATH", "")

    added = main._add_nvidia_dll_dirs_to_path()

    assert len(added) == 1
    assert os.environ["PATH"] == added[0], "no trailing separator when PATH was empty"
    assert not os.environ["PATH"].endswith(os.pathsep)


def test_a_path_write_failure_other_than_oserror_does_not_raise(monkeypatch, tmp_path, caplog) -> None:
    """Real regression: `os.environ["PATH"] = ...` raises `ValueError` (not
    `OSError`) when the resulting value exceeds Windows' 32767-character
    environment-variable ceiling -- a bare `except OSError` around the write
    does not catch it. This function is called from the FIRST, unguarded
    lifespan startup handler (`_startup_ort_cuda_preload`), so an uncaught
    raise here aborts sidecar boot entirely instead of degrading to the
    documented harmless no-op.

    Pass-2 review finding: degrading must not also mean degrading SILENTLY.
    The caller (`_startup_ort_cuda_preload`) only logs on a truthy return, so
    an unlogged `[]` here is byte-identical to every other reason this
    function returns `[]` -- the one condition where the mechanism actually
    failed would be the one condition nothing reports. A guard that only
    asserted `added == []` would still pass if a future edit short-circuited
    BEFORE the write ever ran, without ever exercising this branch -- the
    `caplog` assertion is what proves the guard itself was reached."""
    site_packages = tmp_path / "site-packages"
    (site_packages / "nvidia" / "cudnn" / "bin").mkdir(parents=True)

    monkeypatch.setitem(sys.modules, "onnxruntime", _fake_onnxruntime_at(site_packages))
    monkeypatch.setenv("PATH", "C:\\pre-existing")

    real_environ = os.environ

    class _RaisingEnviron:
        def __getitem__(self, key):
            return real_environ[key]

        def get(self, key, default=None):
            return real_environ.get(key, default)

        def __setitem__(self, key, value):
            if key == "PATH":
                raise ValueError("the environment variable is longer than 32767 characters")
            real_environ[key] = value

    monkeypatch.setattr(main.os, "environ", _RaisingEnviron())

    with caplog.at_level(logging.WARNING, logger="sidecar"):
        added = main._add_nvidia_dll_dirs_to_path()  # must not raise

    assert added == []
    assert any(
        r.levelno == logging.WARNING and "failed to write PATH" in r.message
        for r in caplog.records
    ), (
        "a PATH-write failure must be logged loudly -- silently returning the "
        "same [] as a healthy no-op reopens the exact silent-CPU-fallback bug "
        "this function exists to close"
    )


def test_calling_twice_does_not_grow_path(monkeypatch, tmp_path) -> None:
    """Real regression, found running this repo's own sidecar test suite: a
    FastAPI TestClient re-triggers the lifespan (and this function) on every
    test that instantiates the app, in the same process. Without an
    idempotence check, PATH grows by the same handful of directories on every
    call -- across a whole pytest session that overflows Windows' 32767-char
    environment variable ceiling and raises
    `ValueError: the environment variable is longer than 32767 characters`."""
    site_packages = tmp_path / "site-packages"
    (site_packages / "nvidia" / "cudnn" / "bin").mkdir(parents=True)

    monkeypatch.setitem(sys.modules, "onnxruntime", _fake_onnxruntime_at(site_packages))
    monkeypatch.setenv("PATH", "C:\\pre-existing")

    first = main._add_nvidia_dll_dirs_to_path()
    path_after_first = os.environ["PATH"]
    second = main._add_nvidia_dll_dirs_to_path()
    path_after_second = os.environ["PATH"]

    assert len(first) == 1
    assert second == [], "the directory is already on PATH -- nothing left to add"
    assert path_after_second == path_after_first, "PATH must not grow on a repeat call"


def test_no_nvidia_directory_is_a_harmless_noop(monkeypatch, tmp_path) -> None:
    site_packages = tmp_path / "site-packages"
    monkeypatch.setitem(sys.modules, "onnxruntime", _fake_onnxruntime_at(site_packages))
    original_path = "C:\\unchanged"
    monkeypatch.setenv("PATH", original_path)

    added = main._add_nvidia_dll_dirs_to_path()

    assert added == []
    assert os.environ["PATH"] == original_path, (
        "a CPU/AMD/Apple install with no nvidia/ directory must not touch PATH at all"
    )


def test_onnxruntime_not_importable_degrades_to_noop(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "onnxruntime", None)  # forces ImportError on re-import

    added = main._add_nvidia_dll_dirs_to_path()  # must not raise

    assert added == []


def test_missing_dunder_file_degrades_to_noop(monkeypatch) -> None:
    """A frozen/zip-imported onnxruntime with no real `__file__` must not crash
    startup -- this helper is a nice-to-have, not load-bearing enough to risk
    the sidecar's whole boot sequence over."""
    monkeypatch.setitem(sys.modules, "onnxruntime", _module_with("onnxruntime"))

    added = main._add_nvidia_dll_dirs_to_path()  # must not raise

    assert added == []
