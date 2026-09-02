"""#2600 (PR #2617 review finding 1) — installing `nvidia-cudnn-cu12` lands the
cuDNN DLLs on disk but does not make them findable by onnxruntime's CUDA
execution provider on Windows (no `.pth`, no importable module, and the
onnxruntime-gpu wheel never touches the DLL search path itself). The fix is
`main._preload_ort_cuda_dlls()`, which calls onnxruntime's own opt-in
`preload_dlls()` once from the `_lifespan` startup sequence (pass 2 review
finding N5, PR #2617 -- NOT at raw module-import time; see
`test_lifespan_order.py` for the ordering pin).

This suite pins two properties: (1) the preload is actually attempted when the
symbol exists, and (2) every failure shape — no `preload_dlls` attribute (an
older/non-GPU onnxruntime build), `preload_dlls()` itself raising, and
onnxruntime not being importable at all — degrades to a logged no-op rather
than crashing the sidecar. The entire defect class this closes is *silent*
fallback, so each case also asserts a log line was emitted, not just a status
string.
"""
from __future__ import annotations

import logging
import subprocess
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


def test_preload_runs_when_symbol_present(monkeypatch, caplog) -> None:
    calls: list[dict] = []

    def _fake_preload(**kwargs) -> None:
        calls.append(kwargs)

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        _module_with(
            "onnxruntime", preload_dlls=_fake_preload, __version__="1.27.0", cuda_version="12.9"
        ),
    )

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()

    assert result == "preloaded"
    assert len(calls) == 1, "preload_dlls() must actually be called, not just detected"
    assert any("preload_dlls() loaded" in r.message for r in caplog.records), (
        "a successful preload must log at info level -- the whole defect class "
        "here is silent fallback, so a silent success is not acceptable either"
    )


def test_preload_passes_directory_empty_string(monkeypatch, caplog) -> None:
    """Pass 2 review finding N1 (PR #2617): the default `directory=None` makes
    onnxruntime's `preload_dlls()` prefer `<torch>/lib` whenever torch's CUDA
    major matches onnxruntime's -- discarding the `nvidia/<pkg>/bin/` path
    components entirely, so it never looks where `extraRuntimeSteps`
    (install-ort.mjs) actually installs the cuDNN runtime. `directory=""`
    (falsy but not None) is the one call shape that makes onnxruntime search
    under `nvidia/<pkg>/bin/` instead -- see onnxruntime/__init__.py's
    `preload_dlls` source (read against the live sidecar venv while fixing
    this) for the exact truthy/None/empty-string branching this pins."""
    calls: list[dict] = []

    def _fake_preload(**kwargs) -> None:
        calls.append(kwargs)

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        _module_with(
            "onnxruntime", preload_dlls=_fake_preload, __version__="1.27.0", cuda_version="12.9"
        ),
    )

    with caplog.at_level(logging.INFO, logger="sidecar"):
        main._preload_ort_cuda_dlls()

    assert calls == [{"directory": ""}], (
        "preload_dlls() must be called with directory='' -- an omitted/None "
        "directory silently re-opens the torch/lib-only bug this closes"
    )


def test_preload_that_loads_nothing_is_reported_as_failed(monkeypatch, caplog) -> None:
    """Pass 2 review finding N2 (PR #2617): `preload_dlls()` never raises on a
    missing/failed DLL -- it only `print()`s a "Failed to load ..." line per
    DLL and returns None regardless. Importing `main` against the live sidecar
    venv showed this exact shape: zero of twelve DLLs loaded, eleven printed
    failures, and the old code nonetheless logged success at INFO and
    returned "preloaded". A `preload_dlls()` that prints only failures must
    now be reported as failed, at WARNING, not as a silent success."""

    def _all_fail(**kwargs) -> None:
        for name in ("cudnn64_9.dll", "cublas64_12.dll"):
            print(f"Failed to load {name}: Could not find module '{name}'.")

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        _module_with("onnxruntime", preload_dlls=_all_fail, __version__="1.27.0"),
    )

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()

    assert result == "failed", (
        "a preload_dlls() call that printed only 'Failed to load' lines must "
        "not be reported as a success"
    )
    assert any(
        r.levelno == logging.WARNING and "DLL failed to load" in r.message
        for r in caplog.records
    ), "a real load failure must log at WARNING, not INFO"


def test_preload_missing_symbol_degrades_to_noop(monkeypatch, caplog) -> None:
    """An onnxruntime build with no `preload_dlls` (older release, or a
    non-GPU wheel that never needed it) must not raise -- it degrades and
    logs why, rather than crashing sidecar startup."""
    monkeypatch.setitem(
        sys.modules, "onnxruntime", _module_with("onnxruntime", __version__="1.20.0")
    )

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()  # must not raise

    assert result == "unavailable"
    assert any("no preload_dlls()" in r.message for r in caplog.records)


def test_preload_dlls_raising_is_caught(monkeypatch, caplog) -> None:
    """`preload_dlls()` itself can raise (e.g. the `[cuda]`-extra packages
    absent) -- that must be caught, not left to crash the sidecar, and it must
    be LOGGED loudly (a warning), not swallowed silently."""

    def _boom(**kwargs) -> None:
        raise OSError("could not locate a CUDA DLL directory")

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        _module_with("onnxruntime", preload_dlls=_boom, __version__="1.27.0"),
    )

    with caplog.at_level(logging.WARNING, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()  # must not raise

    assert result == "failed"
    assert any(
        r.levelno == logging.WARNING and "preload_dlls() raised" in r.message
        for r in caplog.records
    )


def test_onnxruntime_not_importable_degrades_to_noop(monkeypatch, caplog) -> None:
    """onnxruntime absent entirely (e.g. an interim state during a bootstrap
    swap) must not crash the module import."""
    monkeypatch.setitem(sys.modules, "onnxruntime", None)  # forces ImportError on re-import

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()  # must not raise

    assert result == "not-importable"
    assert any("not importable yet" in r.message for r in caplog.records)


def test_preload_no_cuda_build_is_not_reported_as_preloaded(monkeypatch, caplog) -> None:
    """Pass 3 review finding N9(a): a CPU/AMD/Apple-profile `onnxruntime`
    build has an empty `cuda_version` and `preload_dlls()` returns
    immediately having loaded nothing and printed nothing -- indistinguishable
    from a genuine success unless `cuda_version` is checked explicitly. This
    is the live-today case: `installRecipe` resolves every non-NVIDIA profile
    to plain `onnxruntime`, so every such install was logging "loaded the
    CUDA/cudnn/cublas/cufft DLLs" at every start before this fix."""

    def _noop(**kwargs) -> None:
        pass  # the real CPU-build behaviour: no prints, nothing loaded

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        _module_with(
            "onnxruntime", preload_dlls=_noop, __version__="1.27.0", cuda_version=""
        ),
    )

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()

    assert result == "no-cuda-build", (
        "a CPU/AMD/Apple build that loaded nothing must not be reported as 'preloaded'"
    )
    assert not any("loaded the CUDA" in r.message for r in caplog.records), (
        "a no-op on a non-CUDA build must not claim the CUDA DLLs were loaded"
    )


def test_preload_torch_skip_is_not_reported_as_preloaded(monkeypatch, caplog) -> None:
    """Pass 3 review finding N9(b): onnxruntime's torch-early-return branch
    (`is_cuda_cudnn_imported_by_torch`) is gated purely on `"torch" in
    sys.modules`, never on `directory` -- `directory=""` (this PR's N1 fix)
    does NOT defeat it. If it ever fires, `preload_dlls()` looked under
    neither `nvidia/<pkg>/bin` nor anywhere else: it prints exactly one line
    ("Skip loading CUDA and cuDNN DLLs since torch is imported.") and returns,
    leaving torch's own bundled DLLs as whatever the CUDA execution provider
    finds -- the same torch/lib-only outcome register row A28 (discharged)
    had recorded as not fixing the bug. That must be reported distinctly, not
    folded into "preloaded" just because no "Failed to load" line appeared."""

    def _torch_skip(**kwargs) -> None:
        print("Skip loading CUDA and cuDNN DLLs since torch is imported.")

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        _module_with(
            "onnxruntime",
            preload_dlls=_torch_skip,
            __version__="1.27.0",
            cuda_version="12.9",
        ),
    )

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()

    assert result == "torch-skip", (
        "a preload_dlls() call that skipped its own search because torch was already "
        "imported must not be reported as 'preloaded'"
    )
    assert any(
        r.levelno == logging.WARNING and "skipped its own DLL search" in r.message
        for r in caplog.records
    ), "the torch-skip outcome must be logged at WARNING, not folded into a quiet success"


def test_preload_success_with_zero_nvidia_provenance_is_not_claimed(
    monkeypatch, caplog, tmp_path
) -> None:
    """Pass 4 review finding P2 (PR #2617): an empty capture from
    `preload_dlls()` means every DLL it was asked for loaded from
    *somewhere* loadable -- it does NOT mean any of them came from
    `nvidia/<pkg>/bin`, the directory `extraRuntimeSteps` (install-ort.mjs)
    actually installs into. `preload_dlls()` has a second loop that retries,
    by bare filename off PATH, any DLL missing from `nvidia/`, and prints
    nothing on that path either -- so a system CUDA toolkit or torch's own
    bundled DLLs can produce the exact same clean capture. Simulate that
    shape: none of the expected DLLs exist on disk under `nvidia/<pkg>/bin`,
    yet `preload_dlls()` reports a clean run. The fix must measure this
    (via onnxruntime's own `_get_nvidia_dll_paths`) and report it at WARNING
    with the real count, not log an unconditional INFO naming
    `nvidia/<pkg>/bin` as the source."""

    def _clean_no_output(**kwargs) -> None:
        pass  # nothing printed -- what a PATH-resolved (not nvidia/-resolved) success looks like

    def _fake_get_nvidia_dll_paths(is_windows: bool):
        return [
            ("nvidia", "cudnn", "bin", "cudnn64_9.dll"),
            ("nvidia", "cublas", "bin", "cublas64_12.dll"),
        ]

    fake_onnxruntime_dir = tmp_path / "site-packages" / "onnxruntime"
    fake_onnxruntime_dir.mkdir(parents=True)
    fake_init = fake_onnxruntime_dir / "__init__.py"
    fake_init.write_text("")
    # Deliberately do NOT create nvidia/cudnn/bin or nvidia/cublas/bin under
    # tmp_path/site-packages -- zero of the two expected DLLs exist there.

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        _module_with(
            "onnxruntime",
            preload_dlls=_clean_no_output,
            __version__="1.27.0",
            cuda_version="12.9",
            __file__=str(fake_init),
            _get_nvidia_dll_paths=_fake_get_nvidia_dll_paths,
        ),
    )

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()

    assert result == "preloaded"
    assert not any(
        "all 2 expected files were found under nvidia" in r.message for r in caplog.records
    ), "zero of the expected DLLs exist under nvidia/<pkg>/bin -- must not claim full nvidia/ provenance"
    assert any(
        r.levelno == logging.WARNING
        and "0 of 2 expected files were found under nvidia" in r.message
        for r in caplog.records
    ), (
        "a success where zero of the expected DLLs are found under nvidia/<pkg>/bin must be "
        "reported at WARNING with the measured count, not silently folded into the plain "
        "'loaded' INFO line"
    )


def test_fresh_import_of_main_does_not_import_torch() -> None:
    """Pass 3 review finding N9(b) (latent path): nothing today pins the
    assumption that `main.py` has no module-level `import torch` -- if one
    were ever added (directly, or transitively via some other module-level
    import), `"torch" in sys.modules` would already be True by the time
    `_startup_ort_cuda_preload()` runs, silently reopening the torch-skip
    outcome above and the guard would still log success. A plain `import
    main` inside this process can't test that: ~45 other sidecar test
    modules already `import main` (and some import torch directly) in the
    same pytest session, so `sys.modules` is contaminated by collection
    order, not by main.py's own behaviour. This uses a genuinely fresh
    subprocess, same technique `test_module_import_order.py` uses for the
    same reason."""
    sidecar_dir = SIDECAR_ROOT
    result = subprocess.run(
        [sys.executable, "-c", "import main, sys; print('torch' in sys.modules)"],
        cwd=str(sidecar_dir),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "False", (
        "main.py must not import torch at module scope -- doing so would make "
        "onnxruntime.preload_dlls() take its torch-early-return branch (N9) instead of "
        "searching nvidia/<pkg>/bin, silently reopening the bug #2600 exists to close"
    )
