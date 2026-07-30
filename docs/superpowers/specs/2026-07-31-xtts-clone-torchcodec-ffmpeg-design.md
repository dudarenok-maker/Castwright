# XTTS cloned-voice derive without torchcodec — design

**Status:** approved
**Issue:** [#1967](https://github.com/dudarenok-maker/Castwright/issues/1967) (`bug`, `area:side`)
**Found by:** fs-38 Wave 3 on-box acceptance Run 2 (2026-07-31), `main` @ `b5479e9c` — blocked all nine items of Section E
**Related plan:** [271-fs38-wave3c-xtts.md](../../features/271-fs38-wave3c-xtts.md)

## 1. What is broken

Every cloned-voice derive on Coqui/XTTS fails on a box whose FFmpeg is a static build — the normal Windows install, and the one our own docs steer deployers to (`winget install Gyan.FFmpeg`). The user sees only `derive-failed`, wrapped in copy that tells them to "Re-enable **Qwen**" after a **Coqui** failure.

The chain, from `logs/tts.err.log`:

```
main.py:9114 xtts_clone_voice
  → main.py:2502 clone_voice → tts_model.get_conditioning_latents(...)
    → TTS/tts/models/xtts.py:362 → :84 load_audio → torchaudio.load(audiopath)
      → torchaudio/_torchcodec.py:82 load_with_torchcodec → import torchcodec
OSError: Could not load this library: …/site-packages/torchcodec/libtorchcodec_core8.dll
```

torchaudio 2.9 removed the in-core soundfile/sox backends, so *every* `torchaudio.load` now dispatches to torchcodec, which needs FFmpeg's **shared** libraries. The gyan.dev `full_build` is `--enable-static`: it ships `ffmpeg.exe` and no `avcodec-*.dll` at all. Everything else the product does with FFmpeg — assembly, loudnorm, peaks — shells out to `ffmpeg.exe` and is unaffected.

The version is not the problem. This box runs FFmpeg 8.1.1 and torchcodec ships a matching `libtorchcodec_core8`. Shared-vs-static is the problem. `PATH` cannot fix it either: CPython ≥3.8 ignores `PATH` for `ctypes.CDLL`, so the libraries must sit beside the loading library or be registered via `os.add_dll_directory()`.

The never-substitute guarantee holds throughout — the chapter fails loudly rather than rendering someone else's voice — so this is a hard block, not a silent corruption.

## 2. Why it was invisible until now

Stock XTTS voices read pre-computed latents from the speaker manifest and never touch `load_audio`. Only a *cloned* voice reaches `get_conditioning_latents` with a real audio path, so the defect could not exist before Wave 3c shipped cloning on Coqui, and it surfaced on the first on-box run afterwards.

Compounding it, the codebase asserts the opposite of what it does. [`docs/wiki/Installing-Castwright.md:41`](../../wiki/Installing-Castwright.md) states the sidecar "does all audio I/O via soundfile + ffmpeg and **never calls `torchaudio.load`**", and that torchcodec "is **never actually called at runtime**". Because the premise was that torchcodec is dead weight, `install-coqui.mjs` drops it in with `--no-deps` and never provisions its native dependency — which is correct behaviour under a premise that stopped being true.

The same sentence is copy-pasted across `requirements/nvidia-cuda.txt:13`, `scripts/install-coqui.mjs:80`, `scripts/accelerator-profile.mjs:161`, `tests/test_requirements.py`'s docstring, and [`2026-06-15-pinokio-installer-design.md:83`](2026-06-15-pinokio-installer-design.md). `install-coqui.mjs:82` even predicts this precise failure — "which can't even load its shared libs against a static FFmpeg" — in the same breath as asserting nothing calls it.

## 3. Why both guardrails missed it

This matters more than the ten-line fix, because two separate mechanisms were aimed at exactly this risk and both were shaped so they could not see it.

**`tests/test_audio_io_invariant.py` greps the wrong files.** It scans `SIDECAR.glob("*.py")` — the sidecar's own top-level sources — for `torchaudio.load(`. The offending call lives in a third-party package the sidecar *invokes*, so no amount of correctness in the regex could have caught it. Its own docstring says it is "EXPECTED to be vacuously green today", which was true, stayed true, and told nobody anything.

**`tests/test_xtts_clone_voice.py` stubs out the decode.** All 2131 lines drive `CoquiEngine.clone_voice` against a fake `tts_model` whose `get_conditioning_latents` asserts it received a path and then never opens it. The one line of real behaviour that mattered was the one the fixture replaced.

The lesson drives the test strategy in §8: the deliverable that prevents recurrence is a test that *fails* without the fix, not a broader static scan.

## 4. Blast radius

Verified by grep across the installed venv:

- In all of `TTS/`, the only `torchaudio.load` reachable from any path we use is `xtts.py:80` `load_audio`. The others live in `bark`, `vits`, `knnvc`, `utils/vad`, `datasets/dataset`, the bundled `server/server.py`, and the fine-tune demos — none of which the sidecar touches.
- `speechbrain` contains no `torchaudio.load`/`.info` call at all, so the ECAPA/QA speaker-embed path is unaffected.

`load_audio` itself is a leaf function: `torchaudio.load` → mono downmix → `torchaudio.functional.resample` → range warning → `clip_(-1, 1)`. Only the first line needs a codec; `torchaudio.functional` is pure tensor math.

Meanwhile `clone_voice` already holds fully decoded PCM. `main.py:9100` builds `ref_audio` from raw int16 wire bytes, and `:2500` writes it back out to a temp WAV solely because `get_conditioning_latents` takes a path — which XTTS then re-decodes through torchcodec. The failing decode is a round-trip of audio the sidecar never needed to encode.

## 5. Options considered

**A. Bypass — give XTTS a soundfile-backed `load_audio`. → CHOSEN.** One leaf function, one call site. `torchaudio.load` is never reached, so torchcodec returns to being the merely-present import-satisfier `install-coqui.mjs` always intended, and the docs' premise becomes true rather than needing retraction. Platform-agnostic: it fixes static-FFmpeg Windows, static Linux builds, and any future variant, with no installer change, no Pinokio change, and nothing new in the venv.

**B. Provision — productise the manual workaround.** Copy PyAV's bundled FFmpeg set into `site-packages/torchcodec/` under canonical names, plus `os.add_dll_directory()` before the Coqui import. It demonstrably works — it unblocked the acceptance run. Rejected because it buys a Windows-specific install path, ~80 MB of duplicated DLLs, a dependence on undocumented PyAV bundling internals, and a second FFmpeg major inside the venv that differs from the `ffmpeg.exe` the rest of the pipeline shells out to. Worse, **PyAV is not a declared requirement**: `pip show av` reports `Required-by: faster-whisper`. Coqui cloning would rest on the private DLL bundle of an unrelated engine's transitive dependency, so a faster-whisper release that drops PyAV silently re-breaks it. And it leaves `torchaudio.load` on the hot path, so the next torchcodec-or-FFmpeg-major drift reproduces this bug exactly.

**C. Document a shared-build requirement and detect it in Setup.** Not a fix. It leaves the feature broken on the normal Windows install and makes every deployer solve it. Survives only as the probe component of A, in the changed form described in §7.

## 6. The replacement loader

New module `server/tts-sidecar/xtts_audio_io.py`, exposing two things.

**`soundfile_load_audio(audiopath, sampling_rate)`** — a semantic clone of `xtts.py:80` differing only in how bytes become a tensor:

```python
data, lsr = sf.read(audiopath, dtype="float32", always_2d=True)   # (frames, channels)
audio = torch.from_numpy(data.T.copy())                            # (channels, frames)
```

then the original's own mono downmix, `torchaudio.functional.resample`, range warning, and `clip_(-1, 1)`, copied verbatim. Two properties make this a faithful substitution rather than a lookalike: `torchaudio.load` returns float32 normalised to [-1, 1] in `(channels, frames)`, and soundfile's `dtype="float32"` read applies the same 1/32768 normalisation to the int16 PCM `_atomic_wav_save` writes; and the resampler is the *same* `torchaudio.functional.resample` call, so no resampling difference can creep into the derived latents.

**`patched_xtts_load_audio()`** — a context manager that swaps the replacement into `TTS.tts.models.xtts` for the duration of the derive and restores the original on exit, including on exception. Scoped rather than permanent so nothing else in the process inherits a mutated third-party module.

`clone_voice` (`main.py:2500`) wraps its existing `get_conditioning_latents` call in it. That is the entire hot-path change.

**Drift raises; it does not fall through.** If `TTS.tts.models.xtts.load_audio` is absent, or `inspect.signature` is not `(audiopath, sampling_rate)`, the context manager raises with a message naming the installed `coqui-tts` version. Falling back to the original would read as tolerance while silently restoring this exact bug on every static-FFmpeg box — invisible precisely because the derive still succeeds everywhere a developer tests. `install-coqui.mjs` pins `coqui-tts`, so drift means a hand-upgrade, and the never-substitute guarantee already makes a loud failure the designed response to a clone problem.

## 7. Readiness probe

A sidecar self-check that exercises the real mechanism instead of a proxy for it: synthesise a small in-memory WAV, push it through `patched_xtts_load_audio()`, and assert the tensor returns at the expected shape and sample rate. It reports Coqui-cloning readiness, or names the actual reason — a moved `load_audio`, a missing soundfile, an unrecognised `coqui-tts`. Surfaced through the existing Setup diagnosis (`server/src/routes/setup-diagnosis.ts`) alongside the ffmpeg check, so a broken clone path appears at Setup rather than as `derive-failed` mid-render.

It deliberately does **not** probe for `avcodec-*.dll`. After this fix a box with no shared FFmpeg libraries clones perfectly well, so a shared-library probe would fail boxes that work — the wrong question, asked confidently.

Its real value is catching §6's drift failure at Setup instead of at derive time, which is the one way this fix can decay.

## 8. Test strategy

**The torchcodec-poison test is the centrepiece.** Block `import torchcodec` with a meta-path finder, purge it from `sys.modules`, then drive the derive path and assert it completes. Both halves are asserted in the same file: under poison the *unpatched* loader must raise, and the *patched* one must succeed. A poison test that only checks the success case is another test that cannot fail, and this bug already survived one of those (§3).

`coqui-tts` is opt-in and absent from every overlay, so the real `TTS` package is not installed in CI. Coverage therefore splits three ways, and the gap is named rather than papered over:

| Layer | Where it runs | What it proves |
|---|---|---|
| Mechanism | Everywhere (`npm run test:sidecar`) | Against the fake-`TTS` fixture pattern the existing clone tests use, with a fake `load_audio` that calls `torchaudio.load` as the real one does — the context manager swaps, restores, and raises on drift. |
| Fidelity | Where Coqui is installed; skips cleanly otherwise | Reads the *installed* `TTS/tts/models/xtts.py`, asserts `load_audio`'s signature is still `(audiopath, sampling_rate)` and that it still calls `torchaudio.load` — so the patch stays both necessary and correctly shaped. Triple-gate skip style follows the golden-audio sidecar tier. |
| Reality | On-box only | A real Coqui cloned-voice derive on a static-FFmpeg box. Unprovable in CI by construction → an on-box acceptance row, not a merge blocker. |

`test_audio_io_invariant.py` keeps guarding our own source, but its docstring currently states the claim that broke and calls itself vacuously green. It is corrected to say what it covers and, more usefully, what it structurally cannot — a call inside a third-party package the sidecar invokes — with a pointer to the poison test.

`server/src/tts/clone-voice-resolver.test.ts` gains cases for the new `derive-failed` remedy clause. The existing byte-identical-legacy-text assertion (`:1415`) must stay green.

**No Playwright spec.** The change is a server-thrown message and a sidecar code path, crossing no router, redux, or layout seam — below the e2e bar in CLAUDE.md's testing discipline.

## 9. The `derive-failed` copy

Two defects, not one.

`derive-failed` is neither `engine-unavailable` nor `wrong-engine`, so it lands in `fromList`'s catch-all branch, and `engineLabelFor(broken, 'engine-unavailable')` finds no engine-tagged entry and falls back to its `'Qwen'` default. Hence "Re-enable Qwen" on a Coqui failure.

Tagging the entry with its engine is necessary but insufficient: it yields "Re-enable Coqui", which is still wrong advice, because a failed derive is not an availability problem and re-enabling an already-enabled engine fixes nothing. `derive-failed` needs its own remedy clause — the shape Wave 3c Task 6b gave `wrong-engine` rather than folding it into the catch-all: the clone itself failed, so the remedy is to re-run the clone and check the sidecar log.

Both changes live in `server/src/tts/clone-voice-resolver.ts`.

## 10. Docs and installer sweep

After the fix the premise sentence becomes *true*, but only if stated precisely: **the clone path loads reference audio via soundfile; torchcodec is present to satisfy `coqui-tts`'s import check and is never called.** The amended claim must land in every site listed in §2 — six of them — or the next reader reasons from stale copy, which is how this propagated in the first place.

**Installers.** `install-coqui.mjs` needs no behaviour change: `--no-deps torchcodec` remains exactly right, and the comment at `:82` keeps its prediction while dropping the claim that nothing calls it.

**Pinokio.** `install.js:43` / `update.js:42` provision ffmpeg via `conda install -y -c conda-forge "ffmpeg>=6"`. conda-forge builds ffmpeg shared, so Pinokio is expected never to have been affected — this is **checked on a Pinokio install, not assumed**, and recorded either way. Whichever way it lands, the fix makes Pinokio's exposure moot. `start.js`, `stop.js` and `reset.js` touch neither ffmpeg nor Coqui and need nothing.

## 11. Verifying the fix

The development venv is currently hot-patched — PyAV's FFmpeg 8 DLLs were copied into `site-packages/torchcodec/` under canonical names to unblock the acceptance run. **The fix cannot be honestly verified against that venv**: with those libraries present torchcodec loads, and the derive passes whether or not the replacement loader ever runs.

Verification therefore requires deleting the non-hash-suffixed `*.dll` from `site-packages/torchcodec/`, confirming `import torchcodec` fails again, and only then running the derive. That returns the box to broken for the duration, and fs-38 Wave 3 is mid-run (16/60) with Section E depending on it — so the revert is scheduled with the repo owner rather than performed opportunistically.

**On-box acceptance owed** (register row + `docs/testing/fs38-wave3-onbox-acceptance.md`):

1. On a box whose only FFmpeg is static, `.venv\Scripts\python.exe -c "import torchcodec"` still fails **and** a Coqui cloned-voice derive completes, writing `voices/xtts/xtts-<uuid>.{pt,json}`.
2. Latent equivalence — a derive on a shared-FFmpeg box before and after the change produces audibly equivalent output, confirming the soundfile read is a true substitution.
3. The Setup readiness probe reports ready on a healthy box and names the reason on a deliberately broken one.

## 12. Out of scope

- Making torchcodec functional (option B) — explicitly rejected, §5.
- Removing torchcodec from the Coqui install; `coqui-tts` still presence-checks it at import.
- Any change to Kokoro, Qwen, Whisper/ASR, or the ECAPA speaker-embed path — none reaches `torchaudio.load` (§4).
- The temp-WAV round-trip in `clone_voice`. Passing in-memory audio would mean owning XTTS's latent math instead of a ten-line leaf function; the round-trip is cheap and the coupling is not worth trading.

## 13. Risks

| Risk | Mitigation |
|---|---|
| `coqui-tts` upgrade moves or reshapes `load_audio` | Version pinned by the installer; context manager raises rather than falling through (§6); readiness probe surfaces it at Setup (§7); fidelity test pins the signature where Coqui is installed (§8). |
| Replacement loader is not bit-faithful, shifting derived latents | Same `torchaudio.functional.resample`, same normalisation, same clip; on-box acceptance item 2 compares real output. |
| Docs sweep skimped, stale premise survives somewhere | All six sites enumerated in §2 and §10; the sweep is a plan task with an explicit file list, not a "and update the docs" line. |
| PR is large — four surfaces in one change | Every part traces to #1967 and the docs correction is meaningless without the fix; splitting would ship a fix whose own documentation contradicts it. One PR, one task per surface. |
