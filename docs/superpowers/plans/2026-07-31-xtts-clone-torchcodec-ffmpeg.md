# XTTS cloned-voice derive without torchcodec — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cloned-voice derives on Coqui/XTTS work on a box whose FFmpeg is a static build, by decoding the reference WAV ourselves instead of letting XTTS route it through torchaudio's loader into torchcodec.

**Architecture:** A new sidecar module decodes the reference WAV with the stdlib `wave` module + NumPy and is swapped into `TTS.tts.models.xtts` by a scoped context manager for the duration of the derive, inside the existing `_synth_lock`. A post-install verification step in `install-coqui.mjs` fails the Coqui install if the patch could not be applied. Separately, the `derive-failed` user-facing copy stops inventing "Re-enable Qwen", and the twelve-plus repo sites asserting the now-false "never calls torchaudio's loader" premise are corrected.

**Tech Stack:** Python 3.12 (sidecar, pytest), Node/TypeScript (server, Vitest), `coqui-tts` 0.27.5, torch/torchaudio 2.11.0.

**Spec:** [`docs/superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md`](../specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md) (v4). **Issue:** #1967.

## Global Constraints

- **Worktree:** `C:\Claude\Projects\wt-1967-xtts-torchcodec`, branch `docs/docs-1967-xtts-torchcodec`. Verify with `git branch --show-current` before the first commit. Hooks are active (`.husky/_` exists).
- **The sidecar venv does NOT exist in this worktree — Task 0 is not optional.** `server/tts-sidecar/.venv` lives only in the primary checkout. Every `pytest` command below depends on Task 0 having junctioned it. **The failure mode is silent:** `run-tests.ps1:18-27` prints `SKIP: sidecar pytest -- venv not found` and **exits 0**, so `npm run test:sidecar` and the `test:sidecar` leg of `verify:fast:branch` both report success having executed nothing. Never read a green `test:sidecar` as evidence without confirming the venv resolved.
- **Sidecar module-level imports of `torch`/`torchaudio` are forbidden in new sidecar modules.** `tests/test_xtts_clone_voice.py:256` installs a *fake* `torch` into `sys.modules`; any module imported under it that touches real `torchaudio` dies with `ModuleNotFoundError: No module named 'torch.hub'`. Import both inside the function.
- **Never `--no-verify`.** If a hook fails, triage related vs. pre-existing; surface pre-existing failures rather than fixing them here.
- **No hard-wrapping in markdown.** Write prose paragraphs as one line; only break at genuine block boundaries.
- **`server/tts-sidecar/xtts_audio_io.py` sits in the directory `tests/test_audio_io_invariant.py:39` scans**, and that scan's `_strip_comments` (`:22-24`) drops only `#` lines, **not docstrings**. Its regex is `torchaudio\s*\.\s*(?:load|save|info)\s*\(`. Never write that call form in a docstring or a non-`#` line in that file — say "torchaudio's loader" instead. `torchaudio.functional.resample(` is safe.
- **The `_synth_lock` invariant:** inside the sidecar process, every entry and exit of `patched_xtts_load_audio()` happens inside `with self._synth_lock:`. Task 3's installer verification is the one exception, and only because it runs in a separate Python process.
- **Commit convention:** `<type>(<scope>): <subject>`. Scopes used here: `side` (sidecar), `server`, `docs`.
- **Do not add a dependency.** `soundfile` is present on every profile but is deliberately not used — see spec §6.

## File Structure

| File | Responsibility |
|---|---|
| `server/tts-sidecar/xtts_audio_io.py` | **Create.** The replacement decoder + the scoped context manager. Only file that knows XTTS's loader internals. |
| `server/tts-sidecar/tests/test_xtts_audio_io.py` | **Create.** Poison test (the can-fail proof), decode equivalence, context-manager mechanism, drift raising. |
| `server/tts-sidecar/main.py` | **Modify** `:2500-2508` — wrap the `get_conditioning_latents` call. |
| `server/tts-sidecar/tests/test_xtts_clone_voice.py` | **Modify.** Assert the patch is live *during* the derive call. |
| `server/tts-sidecar/tests/test_audio_io_invariant.py` | **Modify.** Correct the docstring; keep the assertions. |
| `server/tts-sidecar/scripts/install-coqui.mjs` | **Modify.** Export the verification snippet; run it after the pip loop, before the prefetch. |
| `server/src/tts/install-coqui-steps.test.ts` | **Modify.** New describe block for the verification snippet; existing six `it` blocks untouched. |
| `server/src/tts/clone-voice-resolver.ts` | **Modify** `:88-95`, `:136-152`, `:531/:566/:570`. Copy + engine tagging. |
| `server/src/tts/clone-voice-resolver.test.ts` | **Modify** four literals; **add** three message tests. |
| `server/src/tts/synthesise-chapter-derive-vram-partition.test.ts` | **Modify** two literals (`:503`, `:832`). |
| Docs (Task 5) | The re-derived live sites, acceptance surfaces, release notes. |

---

### Task 0: Make the worktree able to run Python tests

**Files:** none — environment only.

**Interfaces:** Produces a resolvable `server/tts-sidecar/.venv` for every later task's pytest command.

- [ ] **Step 1: Confirm the venv really is missing**

```
ls -d /c/Claude/Projects/wt-1967-xtts-torchcodec/server/tts-sidecar/.venv
```

Expected: `No such file or directory`. If it exists, skip to Step 3.

- [ ] **Step 2: Junction it from the primary checkout**

```powershell
$link = 'C:\Claude\Projects\wt-1967-xtts-torchcodec\server\tts-sidecar\.venv'
$target = 'C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv'
New-Item -ItemType Junction -Path $link -Target $target
(Get-Item $link -Force).Target
```

Junction rather than bootstrap: a fresh bootstrap re-downloads ~2.5 GB of torch and has timed out here before. Use `.Target`, **not** `.LinkTarget` — the latter reads empty on Windows PowerShell 5.1 even for a real junction, so a check written against it passes vacuously.

- [ ] **Step 3: Prove pytest actually runs**

```
cd /c/Claude/Projects/wt-1967-xtts-torchcodec/server/tts-sidecar && .venv/Scripts/python.exe -m pytest tests/test_audio_io_invariant.py -v
```

Expected: **3 passed** — a real count, not a SKIP banner. If you see `SKIP: sidecar pytest -- venv not found`, the junction did not take.

- [ ] **Step 4: Note the teardown hazard**

This junction must be deleted with `[System.IO.Directory]::Delete($link, $false)` before the worktree is removed, or `git worktree remove` can follow it and delete the **real** venv in the primary checkout. Record it in the PR body.

---

### Task 1: The replacement decoder and its context manager

**Files:**
- Create: `server/tts-sidecar/xtts_audio_io.py`
- Test: `server/tts-sidecar/tests/test_xtts_audio_io.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `wave_load_audio(audiopath: str | os.PathLike, sampling_rate: int) -> torch.Tensor` returning `(channels, frames)` float32 in [-1, 1]; `patched_xtts_load_audio()` — a `contextlib.contextmanager` taking no arguments, raising `RuntimeError` on drift. Task 2 imports both; Task 3 references `patched_xtts_load_audio` by name inside a Python snippet string.

- [ ] **Step 1: Write the failing tests**

Create `server/tts-sidecar/tests/test_xtts_audio_io.py`:

```python
"""#1967 — the XTTS clone path must decode its reference WAV without torchcodec.

The poison test below is the regression gate. It asserts BOTH halves: with
torchcodec unimportable, torchaudio's own loader must fail, and ours must
succeed. Asserting only the success half would produce a test that passes
whether or not the fix is present -- the exact shape that let #1967 ship.
"""
import importlib
import sys
import types
import wave

import numpy as np
import pytest
import torch

from xtts_audio_io import patched_xtts_load_audio, wave_load_audio


class _BlockTorchcodec:
    """A meta-path finder that makes `import torchcodec` raise."""

    def find_module(self, fullname, path=None):  # legacy API, harmless
        return None

    def find_spec(self, fullname, path=None, target=None):
        if fullname == "torchcodec" or fullname.startswith("torchcodec."):
            raise ImportError("torchcodec blocked by test")
        return None


@pytest.fixture
def poisoned():
    finder = _BlockTorchcodec()
    saved = {k: v for k, v in sys.modules.items() if k.startswith("torchcodec")}
    for k in saved:
        del sys.modules[k]
    sys.meta_path.insert(0, finder)
    try:
        yield
    finally:
        sys.meta_path.remove(finder)
        sys.modules.update(saved)


def _write_wav(path, pcm_int16, sr=24000, nch=1):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(nch)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm_int16.tobytes())


@pytest.fixture
def ref_wav(tmp_path):
    t = np.linspace(0, 1, 24000, endpoint=False, dtype=np.float32)
    pcm = (np.sin(2 * np.pi * 220 * t) * 0.5 * 32767).astype("<i2")
    p = tmp_path / "ref.wav"
    _write_wav(p, pcm)
    return p


def test_torchaudio_loader_fails_without_torchcodec(poisoned, ref_wav):
    """The can-fail half: proves the poison fixture actually bites."""
    import torchaudio

    with pytest.raises((ImportError, OSError, RuntimeError)):
        torchaudio.load(str(ref_wav))


def test_our_loader_succeeds_without_torchcodec(poisoned, ref_wav):
    audio = wave_load_audio(str(ref_wav), 22050)
    assert audio.shape[0] == 1
    assert audio.dtype == torch.float32
    assert audio.shape[1] == pytest.approx(22050, rel=0.01)
    assert float(audio.abs().max()) <= 1.0


def test_matches_torchaudio_when_torchcodec_works(ref_wav):
    """Fidelity: same tensor as the loader we replace, where that loader runs."""
    torchaudio = pytest.importorskip("torchaudio")
    try:
        expected, sr = torchaudio.load(str(ref_wav))
    except Exception:
        pytest.skip("torchaudio's loader unavailable here (no shared FFmpeg)")
    ours = wave_load_audio(str(ref_wav), sr)
    assert torch.allclose(ours, expected, atol=1e-6)


def test_accepts_pathlib_path(ref_wav):
    assert wave_load_audio(ref_wav, 22050).shape[0] == 1


def test_rejects_non_pcm16(tmp_path):
    p = tmp_path / "eight.wav"
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(24000)
        w.writeframes(b"\x80" * 1000)
    with pytest.raises(ValueError, match="PCM_16"):
        wave_load_audio(str(p), 22050)


def _fake_xtts_module(load_audio_fn):
    pkg = types.ModuleType("TTS")
    tts = types.ModuleType("TTS.tts")
    models = types.ModuleType("TTS.tts.models")
    xtts = types.ModuleType("TTS.tts.models.xtts")
    xtts.load_audio = load_audio_fn
    pkg.__version__ = "0.27.5"
    return {
        "TTS": pkg,
        "TTS.tts": tts,
        "TTS.tts.models": models,
        "TTS.tts.models.xtts": xtts,
    }


@pytest.fixture
def fake_xtts(monkeypatch):
    def _install(load_audio_fn):
        mods = _fake_xtts_module(load_audio_fn)
        for name, mod in mods.items():
            monkeypatch.setitem(sys.modules, name, mod)
        return mods["TTS.tts.models.xtts"]

    return _install


def test_context_manager_swaps_and_restores(fake_xtts):
    def original(audiopath, sampling_rate):
        return "original"

    xtts = fake_xtts(original)
    with patched_xtts_load_audio():
        assert xtts.load_audio is wave_load_audio
    assert xtts.load_audio is original


def test_context_manager_restores_on_exception(fake_xtts):
    def original(audiopath, sampling_rate):
        return "original"

    xtts = fake_xtts(original)
    with pytest.raises(ValueError):
        with patched_xtts_load_audio():
            raise ValueError("boom")
    assert xtts.load_audio is original


def test_raises_when_load_audio_missing(fake_xtts):
    xtts = fake_xtts(lambda audiopath, sampling_rate: None)
    del xtts.load_audio
    with pytest.raises(RuntimeError, match="#1967"):
        with patched_xtts_load_audio():
            pass


def test_raises_on_signature_drift(fake_xtts):
    def renamed(path, sr):  # upstream renamed the parameters
        return "drifted"

    fake_xtts(renamed)
    with pytest.raises(RuntimeError, match="signature"):
        with patched_xtts_load_audio():
            pass


def test_patched_derive_survives_poison_where_unpatched_dies(poisoned, ref_wav, fake_xtts):
    """THE regression gate: poison and the derive-shaped call path, together.

    Every other test here exercises one or the other. The fake `load_audio`
    below calls torchaudio's loader for real, exactly as the shipped XTTS one
    does, and `derive()` reaches it through the module global exactly as
    get_conditioning_latents does -- so under poison it must die, and must stop
    dying once our context manager is active. Without this test the suite
    passes in full with the fix entirely absent, which is the #1967 shape.
    """
    import torchaudio

    def upstream_load_audio(audiopath, sampling_rate):
        audio, _lsr = torchaudio.load(audiopath)
        return audio

    fake_xtts(upstream_load_audio)

    def derive():
        return sys.modules["TTS.tts.models.xtts"].load_audio(str(ref_wav), 22050)

    with pytest.raises((ImportError, OSError, RuntimeError)):
        derive()

    with patched_xtts_load_audio():
        audio = derive()
    assert audio.shape[0] == 1


def test_installed_xtts_loader_still_has_the_shape_we_patch():
    """Spec §9 fidelity tier — the patch must stay NECESSARY and correctly shaped.

    Skips where coqui-tts was never opted into. This is a different assertion
    from the tensor-equivalence test above: that one checks our decoder is
    right, this one checks upstream still needs replacing.
    """
    import inspect as _inspect

    xtts = pytest.importorskip("TTS.tts.models.xtts")
    fn = getattr(xtts, "load_audio", None)
    assert fn is not None, "upstream removed load_audio — patched_xtts_load_audio will raise"
    assert tuple(_inspect.signature(fn).parameters)[:2] == ("audiopath", "sampling_rate")
    src = _inspect.getsource(fn)
    assert "torchaudio" in src and ".load(" in src, (
        "upstream stopped routing the reference decode through torchaudio's loader — "
        "the #1967 patch may no longer be necessary; re-evaluate before deleting it"
    )
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest tests/test_xtts_audio_io.py -v
```

Expected: collection error — `ModuleNotFoundError: No module named 'xtts_audio_io'`.

- [ ] **Step 3: Write the module**

Create `server/tts-sidecar/xtts_audio_io.py`:

```python
"""Reference-audio decode for the XTTS clone path (#1967).

XTTS's own reference loader routes through torchaudio's loader, which on
torchaudio >= 2.9 dispatches to torchcodec and needs FFmpeg's SHARED
libraries. A static ffmpeg build -- the normal Windows install, and the one
our docs steer deployers to -- ships none, so every cloned-voice derive
failed there. We decode the reference WAV ourselves with the stdlib `wave`
module plus NumPy (the pair main.py already uses for all its audio I/O) and
swap our decoder in for the duration of the derive.

NOTE for editors: this file sits in the directory tests/test_audio_io_invariant.py
scans, and that scan does not strip docstrings. Never spell torchaudio's
loader in call form anywhere in this file outside a `#` comment.
"""
from __future__ import annotations

import contextlib
import inspect
import logging
import os
import wave
from typing import TYPE_CHECKING, Any, Iterator

import numpy as np

if TYPE_CHECKING:  # pragma: no cover
    import torch

logger = logging.getLogger(__name__)

# torch / torchaudio are imported INSIDE the function on purpose. The clone
# tests install a fake `torch` into sys.modules (tests/test_xtts_clone_voice.py),
# and a module-level `import torchaudio` executed under that fake dies with
# "No module named 'torch.hub'; 'torch' is not a package" -- reddening ~30
# unrelated tests with an error that points nowhere near the cause.

# The parameter names XTTS's loader has had since 0.22; the patch refuses to
# apply against anything else rather than guessing (see _drift_message).
_EXPECTED_PARAMS = ("audiopath", "sampling_rate")


def wave_load_audio(audiopath: Any, sampling_rate: int) -> torch.Tensor:
    """Drop-in replacement for XTTS's reference loader, minus the codec.

    Returns float32 in [-1, 1], shaped (channels, frames), resampled to
    `sampling_rate` -- byte-identical semantics to the function it replaces,
    which normalises int16 by 1/32768 and resamples with the same
    torchaudio.functional call used below.
    """
    import torch  # noqa: PLC0415
    import torchaudio  # noqa: PLC0415

    path = os.fspath(audiopath)
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(
                f"expected a PCM_16 reference WAV, got {w.getsampwidth() * 8}-bit: {path}"
            )
        lsr = w.getframerate()
        nch = w.getnchannels()
        raw = w.readframes(w.getnframes())

    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    audio = torch.from_numpy(pcm.reshape(-1, nch).T.copy())

    # From here down this mirrors the replaced function exactly.
    if audio.size(0) != 1:
        audio = torch.mean(audio, dim=0, keepdim=True)
    if lsr != sampling_rate:
        audio = torchaudio.functional.resample(audio, lsr, sampling_rate)
    if torch.any(audio > 10) or not torch.any(audio < 0):
        logger.error("Error with %s. Max=%.2f min=%.2f", path, audio.max(), audio.min())
    audio.clip_(-1, 1)
    return audio


def _drift_message(what: str) -> str:
    try:
        import TTS as _tts_pkg  # noqa: PLC0415

        version = getattr(_tts_pkg, "__version__", "unknown")
    except Exception:  # pragma: no cover - only on a broken install
        version = "unknown"
    return (
        f"XTTS reference-audio patch cannot be applied: {what} (coqui-tts {version}). "
        "Refusing to derive: without the patch the clone path would decode via "
        "torchcodec and fail on any box whose FFmpeg is a static build. See #1967."
    )


@contextlib.contextmanager
def patched_xtts_load_audio() -> Iterator[None]:
    """Swap our decoder into TTS.tts.models.xtts for the duration of a derive.

    Scoped, not permanent, so nothing else in the process inherits a mutated
    third-party module. INSIDE THE SIDECAR PROCESS this must be entered and
    exited while holding CoquiEngine._synth_lock: an exit that fires outside
    the lock would restore the original decoder while another derive is
    mid-flight. The installer's verification snippet is exempt because it runs
    in a separate process with its own module globals.

    Raises RuntimeError rather than falling through if the target moved --
    a silent fall-through would restore #1967 on exactly the boxes that
    cannot notice.
    """
    import TTS.tts.models.xtts as _xtts  # noqa: PLC0415

    original = getattr(_xtts, "load_audio", None)
    if original is None:
        raise RuntimeError(_drift_message("TTS.tts.models.xtts.load_audio is missing"))
    params = tuple(inspect.signature(original).parameters)
    if params[:2] != _EXPECTED_PARAMS:
        raise RuntimeError(_drift_message(f"unexpected load_audio signature {params!r}"))

    _xtts.load_audio = wave_load_audio
    try:
        yield
    finally:
        _xtts.load_audio = original
```

- [ ] **Step 4: Run the tests to verify they pass**

```
cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest tests/test_xtts_audio_io.py -v
```

Expected: **11 passed** (or 10 passed + 1 skipped). `test_matches_torchaudio_when_torchcodec_works` skips on a static-FFmpeg box and `test_installed_xtts_loader_still_has_the_shape_we_patch` skips where coqui-tts was never installed — both correct, not failures.

> **Read the skips.** On this dev box the venv is currently **hot-patched** (PyAV's FFmpeg DLLs were copied into `site-packages/torchcodec/`), so torchcodec loads and the equivalence test really runs. The poison tests are unaffected either way — the meta-path finder blocks the *import*, before any DLL is touched.

- [ ] **Step 5: Confirm the new file does not redden the existing guardrail**

```
cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest tests/test_audio_io_invariant.py -v
```

Expected: PASS. If it fails, the module contains torchaudio's loader in call form outside a `#` comment — reword, do not weaken the guardrail.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/xtts_audio_io.py server/tts-sidecar/tests/test_xtts_audio_io.py
git commit -m "fix(side): decode XTTS clone reference audio without torchcodec"
```

---

### Task 2: Wire the patch into the derive, inside the lock

**Files:**
- Modify: `server/tts-sidecar/main.py:2500-2508`
- Test: `server/tts-sidecar/tests/test_xtts_clone_voice.py`

**Interfaces:**
- Consumes: `patched_xtts_load_audio` from Task 1.
- Produces: no new symbols. Behaviour: `CoquiEngine.clone_voice` derives with our decoder installed.

- [ ] **Step 1: Write the failing test**

Append to `server/tts-sidecar/tests/test_xtts_clone_voice.py`. The existing fixtures build a fake `tts_model`; this test asserts the patch is live *at the moment* `get_conditioning_latents` runs — the only placement that matters.

This file's real helpers, confirmed by reading it: `_make_engine(monkeypatch, tmp_path, **kwargs) -> (CoquiEngine, Path, _FakeTTS)` at `:260`, forwarding `**kwargs` to `_install_fake_coqui_runtime(monkeypatch, tts_instance=None, coqui_version=…)` at `:237`; `_ref_audio(n=4800)` at `:267`; `_FakeXttsModel` at `:125`. **There is no callback parameter.** Observe the derive by subclassing `_FakeXttsModel` — the pattern `_DistinctLatentsXttsModel` (`:847`) already uses — and pass it via `tts_instance=`.

```python
class _LoaderSpyXttsModel(_FakeXttsModel):
    """Records the live TTS.tts.models.xtts.load_audio at derive time.

    Subclassed rather than hooked into the shared fake: ~30 tests use
    _FakeXttsModel and none of them want this.
    """

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.loader_during_derive = None

    def get_conditioning_latents(self, *a, **kw):
        import sys

        self.loader_during_derive = sys.modules["TTS.tts.models.xtts"].load_audio
        return super().get_conditioning_latents(*a, **kw)


def test_derive_runs_with_the_patched_loader_installed(monkeypatch, tmp_path):
    """#1967 — the reference decode must be OURS during the derive call.

    Asserting only that clone_voice succeeds would pass with no patch at all on
    a box with shared FFmpeg. Assert the module attribute from inside the fake
    get_conditioning_latents instead.
    """
    import sys
    import types

    import xtts_audio_io

    # patched_xtts_load_audio does `import TTS.tts.models.xtts`, which walks the
    # package chain. _install_fake_coqui_runtime registers a NON-package `TTS`,
    # so installing only the leaf raises "cannot import name 'tts' from 'TTS'" —
    # seed both intermediates too.
    def _original(audiopath, sampling_rate):
        return None

    xtts_mod = types.ModuleType("TTS.tts.models.xtts")
    xtts_mod.load_audio = _original
    for name, mod in (
        ("TTS.tts", types.ModuleType("TTS.tts")),
        ("TTS.tts.models", types.ModuleType("TTS.tts.models")),
        ("TTS.tts.models.xtts", xtts_mod),
    ):
        monkeypatch.setitem(sys.modules, name, mod)

    spy = _LoaderSpyXttsModel()
    engine, _voices_dir, _tts = _make_engine(
        monkeypatch, tmp_path, tts_instance=_FakeTTS(synthesizer=_FakeSynthesizer(spy))
    )
    engine.clone_voice("voice-1", _ref_audio(), 24000, "hello")

    assert spy.loader_during_derive is xtts_audio_io.wave_load_audio
    assert xtts_mod.load_audio is _original  # restored afterwards
```

> **Match the file's real constructors.** `_FakeTTS` / `_FakeSynthesizer` above are the *shapes* `_install_fake_coqui_runtime` builds — read `:125-265` and use the exact call signatures found there rather than these approximations. Everything else (`_make_engine`, `_ref_audio`, `_FakeXttsModel`, the `tts_instance=` kwarg, the `(monkeypatch, tmp_path)` signature) is verified to exist as written.

**Also close the spec §16 lock row mechanically.** Spec §16 claims the `_synth_lock` invariant is "asserted by the mechanism test"; without this it is only Step 5's human read. Add to `_LoaderSpyXttsModel.get_conditioning_latents`, with `engine_ref` a one-element list the test fills after `_make_engine` returns:

```python
        # The lock must ALREADY be held when the derive runs, or the module-global
        # swap is racing every concurrent synth.
        acquired = engine_ref[0]._synth_lock.acquire(blocking=False)
        self.lock_was_held = not acquired
        if acquired:
            engine_ref[0]._synth_lock.release()
```

and `assert spy.lock_was_held` at the end of the test.

- [ ] **Step 2: Run it to verify it fails**

```
cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest tests/test_xtts_clone_voice.py -k patched_loader -v
```

Expected: FAIL on the assertion — `spy.loader_during_derive` is `_original`, not `wave_load_audio`. **If it fails with `ImportError: cannot import name 'tts' from 'TTS'` instead, the three `sys.modules` entries above did not all take** — that is a broken test, not a red-phase pass, and it would stay red after the fix.

- [ ] **Step 3: Wrap the derive call**

In `server/tts-sidecar/main.py`, add the import beside the other function-local imports in `clone_voice` (near `import TTS as _tts_pkg` at `:2412`):

```python
from xtts_audio_io import patched_xtts_load_audio  # noqa: PLC0415
```

Then change `:2500-2508` from:

```python
                    _atomic_wav_save(_float_audio_to_int16_le(ref_audio), int(ref_sr), tmp_wav_path)
                    try:
                        gpt_cond_latent, speaker_embedding = tts_model.get_conditioning_latents(
                            audio_path=tmp_wav_path, **derive_kwargs
                        )
                    finally:
```

to:

```python
                    _atomic_wav_save(_float_audio_to_int16_le(ref_audio), int(ref_sr), tmp_wav_path)
                    try:
                        # #1967 — XTTS's own reference loader goes through torchcodec,
                        # which needs FFmpeg's shared libs and so fails on a static
                        # ffmpeg build. Decode the WAV we just wrote ourselves. This
                        # `with` sits inside `self._synth_lock` (taken above), which is
                        # what makes mutating a third-party module global safe here.
                        with patched_xtts_load_audio():
                            gpt_cond_latent, speaker_embedding = tts_model.get_conditioning_latents(
                                audio_path=tmp_wav_path, **derive_kwargs
                            )
                    finally:
```

- [ ] **Step 4: Run the tests to verify they pass**

```
cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest tests/test_xtts_clone_voice.py -v
```

Expected: all pass, including the pre-existing suite.

- [ ] **Step 5: Verify the wrap is inside the lock**

Read `main.py` from the `with self._synth_lock:` at `:2452` down to the new `with patched_xtts_load_audio():`. Confirm no `return`, `yield`, or lock release sits between them. This is a read-and-confirm step, not a command — the constraint cannot be asserted mechanically from inside the test.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_xtts_clone_voice.py
git commit -m "fix(side): derive XTTS clone latents with the torchcodec-free loader"
```

---

### Task 3: Fail the Coqui install when the patch cannot apply

**Files:**
- Modify: `server/tts-sidecar/scripts/install-coqui.mjs`
- Test: `server/src/tts/install-coqui-steps.test.ts`

**Interfaces:**
- Consumes: `patched_xtts_load_audio` (Task 1), by name, inside a Python snippet string.
- Produces: `export const COQUI_VERIFY_CODE: string` from `install-coqui.mjs`.

**Placement is load-bearing** (spec §7): the snippet must live **outside** `coquiPipInstallSteps` — that array is asserted by exact equality at `install-coqui-steps.test.ts:22-29`, and a step with no `install` token makes `indexOf` return `-1` and adds a bogus element. It runs **after** the pip loop and **before** the ~1.8 GB prefetch, so a failure costs the user only pip time.

- [ ] **Step 1: Write the failing test**

Append a new describe block to `server/src/tts/install-coqui-steps.test.ts` (do not touch the existing six `it` blocks):

```ts
describe('COQUI_VERIFY_CODE', () => {
  it('exercises the real patch rather than merely importing TTS', () => {
    expect(COQUI_VERIFY_CODE).toContain('patched_xtts_load_audio');
    expect(COQUI_VERIFY_CODE).toContain('xtts_audio_io');
  });

  it('round-trips a generated WAV, so a silently-broken decode fails the install', () => {
    expect(COQUI_VERIFY_CODE).toContain('wave');
    expect(COQUI_VERIFY_CODE).toMatch(/get_conditioning_latents|load_audio/);
  });

  it('needs no model weights, so it can run before the prefetch', () => {
    expect(COQUI_VERIFY_CODE).not.toContain('xtts_v2');
  });

  it('uses a non-silent buffer, so XTTS\'s range guard does not log "Error with" at the user', () => {
    expect(COQUI_VERIFY_CODE).not.toContain('np.zeros');
  });

  it('is actually wired into the installer, not merely exported', () => {
    // Without this, COQUI_VERIFY_CODE could be exported and never invoked and
    // every other assertion here would still pass.
    const src = readFileSync(
      new URL('../../tts-sidecar/scripts/install-coqui.mjs', import.meta.url),
      'utf8',
    );
    const verifyAt = src.indexOf('COQUI_VERIFY_CODE]');
    const prefetchAt = src.indexOf('Pre-fetching XTTS v2');
    expect(verifyAt, 'verification step must be invoked').toBeGreaterThan(-1);
    expect(verifyAt, 'must run BEFORE the 1.8 GB prefetch').toBeLessThan(prefetchAt);
  });
});
```

Add `import { readFileSync } from 'node:fs';` at the top of the test file if it is not already there.

Add `COQUI_VERIFY_CODE` to the existing import from `install-coqui.mjs` at the top of the file.

- [ ] **Step 2: Run it to verify it fails**

```
cd server && npx vitest run src/tts/install-coqui-steps.test.ts
```

Expected: FAIL — `COQUI_VERIFY_CODE` is not exported.

- [ ] **Step 3: Export the snippet and run it**

In `server/tts-sidecar/scripts/install-coqui.mjs`, after `coquiPipInstallSteps`:

```js
/**
 * #1967 — verify the clone path can actually decode reference audio before we
 * spend 1.8 GB on weights. coqui-tts is NOT pinned (base.txt carries no
 * coqui-tts line), so an upstream release that renames or re-signatures XTTS's
 * reference loader would otherwise install cleanly and fail at first derive,
 * on every new install, with nobody able to reproduce it locally. Exported as
 * a string so it is unit-testable; kept OUT of coquiPipInstallSteps because
 * that array is asserted by exact equality.
 */
export const COQUI_VERIFY_CODE = [
  'import os, sys, tempfile, wave',
  'import numpy as np',
  'from xtts_audio_io import patched_xtts_load_audio',
  'import TTS.tts.models.xtts as _x',
  'd = tempfile.mkdtemp()',
  'p = os.path.join(d, "verify.wav")',
  // A real waveform, NOT np.zeros: XTTS's own range guard logs "Error with
  // <path>. Max=0.00 min=0.00" for an all-zero buffer (`not torch.any(audio < 0)`),
  // and run() uses stdio:'inherit', so the user would see a line starting
  // "Error with" immediately before "verify ok" in the installer output.
  'pcm = (np.sin(np.linspace(0, 6.28 * 220, 2400)) * 16000).astype("<i2")',
  'w = wave.open(p, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)',
  'w.writeframes(pcm.tobytes()); w.close()',
  'with patched_xtts_load_audio():',
  '    a = _x.load_audio(p, 22050)',
  'assert a.shape[0] == 1, a.shape',
  'os.remove(p); os.rmdir(d)',
  'print("[install-coqui] clone-path verify ok")',
].join('\n');
```

Then in the main flow, between the pip loop and the prefetch (`install-coqui.mjs:~158`):

```js
  step('Verifying the clone path can decode reference audio (#1967)...');
  if (run(python, ['-c', COQUI_VERIFY_CODE], env) !== 0) {
    step('FAIL: the XTTS reference-audio patch could not be applied.');
    step('      This coqui-tts release has moved or reshaped XTTS\'s reference loader,');
    step('      so cloned-voice derives would fail. Report the version above on');
    step('      https://github.com/dudarenok-maker/Castwright/issues/1967');
    process.exit(1);
  }
```

> The snippet imports `xtts_audio_io` by bare name. That resolves only because `run()` sets `cwd: SIDECAR_DIR` (`:60`) and `python -c` prepends the CWD to `sys.path`. Do not change `run`'s `cwd`.

- [ ] **Step 4: Run the tests to verify they pass**

```
cd server && npx vitest run src/tts/install-coqui-steps.test.ts
```

Expected: all eleven `it` blocks pass — the six pre-existing ones unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/install-coqui.mjs server/src/tts/install-coqui-steps.test.ts
git commit -m "fix(side): fail the Coqui install when the XTTS audio patch cannot apply"
```

---

### Task 4: Stop the `derive-failed` copy inventing "Re-enable Qwen"

**Files:**
- Modify: `server/src/tts/clone-voice-resolver.ts` (`:88-95`, `:136-152`, `:531`, `:566`, `:570`)
- Test: `server/src/tts/clone-voice-resolver.test.ts`, `server/src/tts/synthesise-chapter-derive-vram-partition.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BrokenClonedVoice` entries with `reason: 'derive-failed'` now carry `engine`.

- [ ] **Step 1: Re-derive BOTH the producers and the affected test literals**

```
cd /c/Claude/Projects/wt-1967-xtts-torchcodec
rg -n "derive-failed" server/src/tts/clone-voice-resolver.ts
rg -n "reason: 'derive-failed'" server/src --glob '*.test.ts'
```

**Producers — there are four, not three.** Three are `broken.push` sites in the catch path (`:531`, `:566`, `:570`). The fourth is the **classifier** path at `:446-458`, fed by `classifyClonedVoice`'s `if (slot?.status === 'failed') return { state: 'broken', reason: 'derive-failed' }` (`:227`), whose engine spread is gated to `engine-unavailable | wrong-engine` only (`:454-457`) — so it emits an **untagged** `derive-failed`.

That fourth one is the dominant real-world path, and missing it re-ships the bug: a permanent derive failure persists `status: 'failed'` at `:557`, so **every run after the first** classifies from that stamp rather than the catch block, and an untagged entry resolves through `b.engine ?? 'qwen'` (`:89`) to "Re-run the clone for **Qwen**" on a Coqui book — #1967's exact symptom, in the new clause.

**Test literals:** at time of writing six hits across two files — `clone-voice-resolver.test.ts:660`, `:992`, `:1052`, `:1331` and `synthesise-chapter-derive-vram-partition.test.ts:503`, `:832`. Use the command's output, not this list.

- [ ] **Step 2: Write the failing tests**

Add to `server/src/tts/clone-voice-resolver.test.ts`:

```ts
describe('#1967 — derive-failed remedy copy', () => {
  it('a pure derive-failed list never says "Re-enable Qwen"', () => {
    const e = UnresolvableClonedVoiceError.fromList([
      { name: 'Одуван', reason: 'derive-failed', engine: 'coqui' },
    ]);
    expect(e.message).not.toContain('Re-enable');
    expect(e.message).toContain('Re-run the clone for Coqui');
  });

  it('a mixed [revoked, derive-failed] list still never says "Re-enable Qwen"', () => {
    const e = UnresolvableClonedVoiceError.fromList([
      { name: 'Marlow', reason: 'revoked' },
      { name: 'Reeve', reason: 'derive-failed', engine: 'coqui' },
    ]);
    expect(e.message).not.toContain('Re-enable Qwen');
    expect(e.message).toContain('Restore the missing voice(s)');
    expect(e.message).toContain('Re-run the clone for Coqui');
  });

  it('an UNTAGGED derive-failed (the persisted-failed-slot path) never names Qwen', () => {
    // clone-voice-resolver.ts:446-458 emits derive-failed with no engine unless
    // Step 4(c) widens the spread gate. Without that widening this test prints
    // "Re-run the clone for Qwen" — #1967's exact symptom, on every run after
    // the first.
    const e = UnresolvableClonedVoiceError.fromList([
      { name: 'Одуван', reason: 'derive-failed', engine: 'coqui' },
    ]);
    expect(e.message).not.toContain('Qwen');
  });

  it('the first remedy reads correctly in sentence-initial position', () => {
    const e = UnresolvableClonedVoiceError.fromList([{ name: 'Marlow', reason: 'revoked' }]);
    // `. ${remedies.join('; ')}.` — the first clause follows a full stop.
    expect(e.message).toMatch(/\.\s+[A-Z]/);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

```
cd server && npx vitest run src/tts/clone-voice-resolver.test.ts -t "#1967"
```

Expected: the first three FAIL — messages contain "Re-enable Qwen" and no "Re-run the clone" clause exists yet. The fourth (`/\.\s+[A-Z]/`) **passes today for the wrong reason** — the capital comes from the existing "Re-enable" — and its job is to stay green once change 1 replaces that clause with "Restore…". Say so in the report rather than counting it as a red-to-green.

- [ ] **Step 4: Make the three changes**

**(a) Only name an engine when one was reported unavailable.** In `engineLabelFor` (`:88-95`), drop the `|| 'Qwen'` tail — it becomes dead once the caller is gated, and leaving it is a false safety net:

```ts
function engineLabelFor(broken: BrokenClonedVoice[], reason: BrokenClonedVoice['reason']): string {
  const engines = new Set(broken.filter((b) => b.reason === reason).map((b) => b.engine ?? 'qwen'));
  return CLONE_ENGINE_LIST.filter((e) => engines.has(e))
    .map((e) => (e === 'coqui' ? 'Coqui' : 'Qwen'))
    .join(' or ');
}
```

**(b) Rework the remedy branches.** **Scope precisely: replace `:138-151` only** — that is the `hasOtherReason` declaration through the end of its `if` block. **Do not re-declare `hasWrongEngine`**, which already exists at `:137`, immediately above the replaced region; a literal paste including it yields `TS2451: Cannot redeclare block-scoped variable`. Vitest would not catch that — only `npm run typecheck`, a whole task later.

```ts
    // `hasWrongEngine` is already declared at :137 — do not repeat it.
    const hasDeriveFailed = broken.some((b) => b.reason === 'derive-failed');
    const hasEngineUnavailable = broken.some((b) => b.reason === 'engine-unavailable');
    /* #1967 — `derive-failed` gets its own clause below, so it must NOT also
       trigger the availability catch-all; and the catch-all only names an
       engine to re-enable when one was actually reported unavailable. Before
       this, a derive failure on Coqui printed "Re-enable Qwen" — naming a
       perfectly healthy engine, because engineLabelFor filters on REASON and
       fell back to 'Qwen' when it matched nothing. */
    const hasOtherReason = broken.some(
      (b) => b.reason !== 'wrong-engine' && b.reason !== 'derive-failed',
    );
    const remedies: string[] = [];
    if (hasOtherReason) {
      remedies.push(
        hasEngineUnavailable
          ? `Re-enable ${engineLabelFor(broken, 'engine-unavailable')} or restore the missing voice(s)`
          : 'Restore the missing voice(s)',
      );
    }
    if (hasDeriveFailed) {
      remedies.push(
        `Re-run the clone for ${engineLabelFor(broken, 'derive-failed')} and check the sidecar log`,
      );
    }
```

> Both new clauses are capitalised because `:166-169` renders `. ${remedies.join('; ')}.` — whichever fires first is sentence-initial. `reassign the character(s)` is never first (`fromList` returns early on an empty `broken` list), so it stays lowercase. **Pre-existing and deliberately not fixed here:** a pure `wrong-engine` list makes `switch the book to …` (`:163`) first, lowercase after a full stop. It is outside this issue's scope and touching it would widen the diff and the test set; note it in the PR body as found-in-passing.

**(c) Tag `derive-failed` entries with their engine — at all FOUR producers.** Without this, clause (b) has no engine to name and falls through to `'qwen'`.

Three are `broken.push` sites in the catch path — `:531`, `:566`, `:570` — each becoming `broken.push({ name: characterName, reason: 'derive-failed', engine })`. `engine` is confirmed in scope at all three (same `for` iteration; already used at `:456`, `:471`, `:504`).

The fourth is the **classifier** path at `:446-458`, whose engine spread is gated to two reasons. Widen the gate:

```ts
        ...(classification.reason === 'engine-unavailable' ||
        classification.reason === 'wrong-engine' ||
        classification.reason === 'derive-failed'
          ? { engine }
          : {}),
```

and update the comment above it — it currently explains that only those two reasons name an engine, which stops being true. This is the site that matters most in production: a permanent derive failure persists `status: 'failed'` (`:557`), so every run after the first comes through here, not the catch block.

- [ ] **Step 5: Update the six existing literals**

Add the engine **each fixture actually drives** to every `toEqual` literal from Step 1 — it is not uniformly coqui. At time of writing: `clone-voice-resolver.test.ts:660`, `:992`, `:1052` drive `engine: 'qwen'` (set at `:632` and `:1038-1039`); `:1331` drives coqui (`:1324`); both `synthesise-chapter-derive-vram-partition.test.ts` sites drive coqui. Read each fixture, don't assume. **Do not loosen them to `objectContaining`** — the exactness is what caught this.

- [ ] **Step 6: Run the full server suite for both files**

```
cd server && npx vitest run src/tts/clone-voice-resolver.test.ts src/tts/synthesise-chapter-derive-vram-partition.test.ts
```

Expected: all pass, including `:1415`'s byte-identical legacy assertion — change (a) cannot disturb it, because its label comes from the `?? 'qwen'` inside `map`, not the removed tail.

- [ ] **Step 7: Commit**

```bash
git add server/src/tts/clone-voice-resolver.ts server/src/tts/clone-voice-resolver.test.ts server/src/tts/synthesise-chapter-derive-vram-partition.test.ts
git commit -m "fix(server): stop derive-failed copy naming an unrelated engine"
```

---

### Task 5: Correct the false premise everywhere, and record the acceptance debt

**Files:** the live sites re-derived below, plus `docs/testing/onbox-acceptance-register.md`, `docs/testing/fs38-wave3-onbox-acceptance.md`, the live HTML twin, `docs/release-notes-next.md`, `RELEASE_NOTES.md`.

**Interfaces:** none — documentation only.

- [ ] **Step 1: Re-derive the site list**

```
cd /c/Claude/Projects/wt-1967-xtts-torchcodec && rg -n "torchaudio\.load|audio I/O via soundfile|never actually called|manifest speakers|Re-enable (Qwen|Coqui)|coqui-tts.*>=0\.24" --glob '!**/{node_modules,.venv,dist}/**' .
```

The `Re-enable` terms catch copy sites Task 4 may have invalidated — e.g. `docs/features/271-fs38-wave3c-xtts.md:144` — which the narrower pattern in the first draft of this plan missed entirely.

Triage each hit as **live** (correct it) or **historical** (leave it: `docs/wiki/Release-Notes-v1.9.0.md`, the June `sidecar-torch-cve-bump` / `amd-gpu-sidecar-support` / `pinokio-installer` specs and plans). Spec §2 lists the sites known at writing time; four revisions produced four short counts, so trust the command.

- [ ] **Step 2: Replace the claim at every live site**

The corrected text, verbatim:

> The sidecar does its audio I/O with the stdlib `wave` module and NumPy — Kokoro is ONNX, Qwen and the XTTS clone path read and write PCM directly. It never calls `torchaudio.load`. `torchcodec` is installed only to satisfy `coqui-tts`'s import-time presence check and is never invoked. (The audio pipeline's ffmpeg work — assembly, loudnorm, peaks — runs in the Node server, not in the sidecar runtime.)

Adapt phrasing to each site's format (table cell, code comment, docstring) but not its content. Three notes:

- `README.md:76-78` sits inside a **PowerShell fenced block** and carries its own differently-worded version of the claim; `nvidia-cuda.txt:13-14` is the other. They are *not* quotes of each other (the spec said otherwise — that was an unchecked claim), but both need editing and their line numbers are adjacent to what the spec cites, so locate by text rather than line.
- `requirements/nvidia-cuda.txt:14`'s "Coqui uses manifest speakers, not `speaker_wav`" needs its own correction — true of inference, false of cloning.
- `README.md:15`'s `coqui-tts | >=0.24.0` row describes a constraint in no file; it is unpinned and verified at install (Task 3).

- [ ] **Step 3: Correct the two guardrail docstrings and the diverged design doc**

`tests/test_audio_io_invariant.py` — keep both assertions; rewrite the docstring to say what it covers, that it **cannot** see a call inside a third-party package the sidecar invokes, and to point at `tests/test_xtts_audio_io.py`. Drop its false "Qwen reads audio via soundfile (`sf.read`)" aside. `tests/test_requirements.py` — same treatment for **both** `:88-97` and `:109-125`.

`docs/superpowers/specs/2026-07-04-fs38-voices-library-design.md:196` — add a correction note that Wave 3c shipped a path handoff instead of the specified soundfile read, that the divergence caused #1967, and link this plan. Do not silently rewrite it; the divergence is the record.

- [ ] **Step 4: Update the run sheet's embedded remedy strings**

`docs/testing/fs38-wave3-onbox-acceptance.md:1341` and `:1755-1785` embed the expected `derive-failed` copy verbatim as C-13's acceptance criteria. Task 4 invalidated them — update to the new text.

- [ ] **Step 4b: Update plan 271 and the Pinokio record**

`docs/features/271-fs38-wave3c-xtts.md` is the regression plan this bug belongs to — Wave 3c shipped the clone path that carries it. Add a post-ship note there describing #1967, the fix, and the divergence in §3; correct its `Re-enable Coqui` copy site (`:144`) if Task 4 changed it. This is the "changed behaviour cited in an existing plan → update that plan in the same diff" case from CLAUDE.md's before-shipping step 1, so **no new `docs/features/` file and no `INDEX.md` entry are needed** — say so explicitly in the PR body rather than silently omitting.

Spec §11 also owes a Pinokio *documentation* outcome, not just the acceptance item: whichever way the `import torchcodec` check lands there, record it in the Pinokio design spec's stale rationale (`docs/superpowers/specs/2026-06-15-pinokio-installer-design.md:83`, which says torchcodec "was dropped").

- [ ] **Step 5: Record the acceptance debt on all three surfaces**

Per CLAUDE.md before-shipping step 3: the register row in `docs/testing/onbox-acceptance-register.md`, the criteria in `docs/testing/fs38-wave3-onbox-acceptance.md`, **and the live HTML twin** — updated via the `url` recorded at `onbox-acceptance-register.md:28`, never republished from scratch. Four items are owed (spec §12): static-FFmpeg derive succeeds; latent equivalence before/after; install verification passes healthy and fails broken; Pinokio's `import torchcodec` result recorded either way.

Then:

```
npm run check:onbox-register
```

Expected: PASS (it checks the register's internal arithmetic).

- [ ] **Step 6: Release notes, both files**

Append a PR-refed entry to `docs/release-notes-next.md` and a matching brand-voice line to the in-progress section at the top of `RELEASE_NOTES.md`. Describe the shipped end state — "cloned voices now derive on Coqui regardless of how your FFmpeg was built" — not the investigation.

- [ ] **Step 7: Commit**

```bash
git add -A docs RELEASE_NOTES.md INSTALL.md server/tts-sidecar
git commit -m "docs(docs): correct the torchaudio-load premise and record #1967 acceptance"
```

---

### Task 6: Branch verification and PR

- [ ] **Step 1: Typecheck** — subagent lanes can land TS errors that neither Vitest nor pre-commit sees.

```
npm run typecheck
```

- [ ] **Step 2: Branch-scoped battery**

```
npm run verify:fast:branch
```

- [ ] **Step 3: Sidecar suite**

```
npm run test:sidecar
```

- [ ] **Step 4: File the adjacent finding**

`test_coqui_import_pin.py:36-38,105-111` asserts coqui-tts "ships as an ordinary dependency, so `_coqui_package_installed()` is true on EVERY install", contradicting `test_requirements.py:137-142`. Out of scope here (spec §15) — file a `type:chore` issue with both citations.

- [ ] **Step 5: Open the PR**

Title: `fix(side,server): derive XTTS cloned voices without torchcodec`. Body must contain `Closes #1967` as literal text (not backticked). Summary + Test plan per the template; link the spec and this plan; declare Task 5's doc corrections and the filed chore.

- [ ] **Step 6: Mandatory independent review**

Dispatch the `code-review` gate at Premium tier — multi-scope PR, so `high` effort. Triage and fold findings before merge.

---

## Self-Review

This plan was itself reviewed and found *not buildable* in its first draft; the notes below record what that pass changed, because two of the defects were the kind that ship silently.

**Spec coverage.** §6 loader → Task 1. §6 lock invariant → Task 2 Step 3 (placement), Step 5 (human read) **and** the optional `_synth_lock.acquire(blocking=False)` assertion, which is what spec §16's risk row actually claims. §7 install verification → Task 3. §8 no Setup change → correctly absent. §9 poison tier → Task 1, including `test_patched_derive_survives_poison_where_unpatched_dies`, which is the only test where poison and the derive path meet; without it the whole suite passes with Task 2 unimplemented. §9 fidelity tier → `test_installed_xtts_loader_still_has_the_shape_we_patch` (signature + still-necessary), which is a *different* assertion from the tensor-equivalence test — the first draft conflated them and silently dropped the tier. §10 → Task 4, now covering **four** `derive-failed` producers. §11 → Task 5. §12 → Task 5 Step 5. §13 → Tasks 1–2, 3, 4, 5. §15 chore → Task 6 Step 4.

**Placeholder scan.** One adaptation point remains, narrowed: Task 2 Step 1's `_FakeTTS` / `_FakeSynthesizer` constructor shapes must be read from `:125-265`. Everything the first draft called a placeholder is now resolved — `_ref_audio` already existed at `:267` (calling it a placeholder would have sent the implementer inventing one), and `_make_engine` at `:260` is the real helper, with subclassing rather than a callback as the way in.

**Type consistency.** `wave_load_audio` / `patched_xtts_load_audio` are spelled identically in Tasks 1, 2, and 3's snippet. `COQUI_VERIFY_CODE` matches between export, invocation, and both tests. `engineLabelFor`'s signature is unchanged; only its `|| 'Qwen'` tail is removed. Task 4(b) replaces `:138-151` **only**, leaving `hasWrongEngine` at `:137` intact.

**Known red-phase traps, called out where they occur:** Task 2's test fails with `ImportError` rather than an assertion if the three `sys.modules` entries don't all take (Step 2); Task 4's fourth new test passes today for the wrong reason (Step 3). Both are flagged inline so an implementer doesn't read them as normal red-to-green.
