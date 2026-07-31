# XTTS cloned-voice derive without torchcodec — design

**Status:** approved
**Issue:** [#1967](https://github.com/dudarenok-maker/Castwright/issues/1967) (`bug`, `area:side`)
**Found by:** fs-38 Wave 3 on-box acceptance Run 2 (2026-07-31), `main` @ `b5479e9c` — blocked all nine items of Section E
**Related plan:** [271-fs38-wave3c-xtts.md](../../features/271-fs38-wave3c-xtts.md)
**Revision:** v2, after an adversarial review that contradicted five load-bearing claims in v1. §14 records what changed and why, because two of those corrections change what gets built.

## 1. What is broken

Every cloned-voice derive on the Coqui/XTTS engine fails on a box whose FFmpeg is a static build — the normal Windows install, and the one our own docs steer deployers to (`winget install Gyan.FFmpeg`). The user sees only `derive-failed`, wrapped in copy that tells them to "Re-enable **Qwen**" after a **Coqui** failure.

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

Compounding it, the repo asserts the opposite of what it does, in **nine live places**. The claim takes two forms, and both are false:

| Site | Shape of the claim |
|---|---|
| `docs/wiki/Installing-Castwright.md:41` | "never calls `torchaudio.load`" + "never actually called at runtime" |
| `INSTALL.md:27` | "never calls `torchaudio.load`" |
| `server/tts-sidecar/README.md:12` | "never calls `torchaudio.load`" |
| `server/tts-sidecar/README.md:16` | the most detailed false claim in the repo — names this exact failure ("can't load its shared libs against a static FFmpeg 8 build") and then says it "is never reached" |
| `server/tts-sidecar/README.md:78` | "never calls torchaudio.load" |
| `server/tts-sidecar/requirements/nvidia-cuda.txt:13` | "the sidecar NEVER calls torchaudio.load" |
| `server/tts-sidecar/requirements/nvidia-cuda.txt:14` | a *second*, separate falsehood: "Coqui uses manifest speakers, not `speaker_wav`" — true of inference, false of cloning, and the sentence that most directly encoded the wrong mental model |
| `server/tts-sidecar/scripts/install-coqui.mjs:80,82` | "never calls" + the same static-FFmpeg prediction, asserted as unreachable |
| `server/tts-sidecar/tests/test_requirements.py` docstring | "the sidecar never calls torchaudio.load … so torchcodec's FFmpeg decode path … is never reached" |

Two further sites carry a related false premise and are corrected alongside: `server/tts-sidecar/warning_filters.py:19` and `server/tts-sidecar/tests/test_audio_io_invariant.py`'s docstring both state "we do all audio I/O via soundfile + ffmpeg", which is wrong in a way nobody has noticed — see §6.

Historical records are **not** rewritten: `docs/wiki/Release-Notes-v1.9.0.md`, the June `sidecar-torch-cve-bump` / `amd-gpu-sidecar-support` / `pinokio-installer` specs and plans stated what was believed when they shipped. One exception, §3.

## 3. Why three guardrails missed it

This matters more than the ten-line fix, because three separate mechanisms were aimed at exactly this risk and all three were shaped so they could not see it.

**`tests/test_audio_io_invariant.py` greps the wrong files.** It scans `SIDECAR.glob("*.py")` (`:39`) — the sidecar's own top-level sources — for `torchaudio.load(`. The offending call lives in a third-party package the sidecar *invokes*, so no amount of correctness in the regex could have caught it. Its own docstring says it is "EXPECTED to be vacuously green today", which was true, stayed true, and told nobody anything.

**`tests/test_xtts_clone_voice.py` stubs out the decode.** All 2131 lines drive `CoquiEngine.clone_voice` against a fake `tts_model` whose `get_conditioning_latents` asserts it received a path and then never opens it. The one line of real behaviour that mattered was the one the fixture replaced.

**The design of record specified the correct behaviour and the implementation diverged.** [`2026-07-04-fs38-voices-library-design.md:196`](2026-07-04-fs38-voices-library-design.md) reads: *"**XTTS:** derive = … load `master.wav` via **`soundfile`** (never `torchaudio.load`; a guardrail test forbids it), run `get_conditioning_latents`…"*. Wave 3c instead shipped a path handoff (`main.py:2494-2504`, "Trap 2") that routes the decode straight into `torchaudio.load`. Nobody reconciled the divergence, and the guardrail test named in that very sentence was the one from the first bullet.

That third one is the actual recurrence vector, and it is not a testing gap — it is a plan-to-implementation reconciliation gap. The poison test in §9 closes the testing half; correcting that design doc (the one historical exception in §2) closes the other half by removing a stale spec that still reads as satisfied.

## 4. Blast radius

Verified by grep across the installed venv, and independently re-verified during review:

- In all of `TTS/`, the only `torchaudio.load` reachable from any path we use is `xtts.py:80` `load_audio`, called at `:362`. The others live in `bark`, `vits`, `knnvc`, `utils/vad`, `datasets/dataset`, the bundled `server/server.py`, and the fine-tune demos — none imported. `main.py` contains **zero** `speaker_wav` occurrences, so `Xtts.synthesize`'s own clone branch (`xtts.py:441`) is unreachable.
- `speechbrain` contains no `torchaudio.load`/`.info` call; it already migrated to its own soundfile layer (`speechbrain/dataio/audio_io.py`). The ECAPA/QA speaker-embed path is unaffected.

`load_audio` itself is a leaf function: `torchaudio.load` → mono downmix → `torchaudio.functional.resample` → range warning → `clip_(-1, 1)`, returning a single tensor. Only the first line needs a codec; `torchaudio.functional` is pure tensor math.

Meanwhile `clone_voice` already holds fully decoded PCM. `main.py:9100` builds `ref_audio` from raw int16 wire bytes, and `:2500` writes it back out to a temp WAV solely because `get_conditioning_latents` takes a path — which XTTS then re-decodes through torchcodec. The failing decode is a round-trip of audio the sidecar never needed to encode.

## 5. Options considered

**A. Bypass — give XTTS a soundfile-backed `load_audio`. → CHOSEN.** One leaf function, one call site. `torchaudio.load` is never reached, so torchcodec returns to being the merely-present import-satisfier `install-coqui.mjs` always intended, and the docs' premise becomes true rather than needing retraction. Platform-agnostic: it fixes static-FFmpeg Windows, static Linux builds, and any future variant, with no Pinokio change. It is also what [`2026-07-04-fs38-voices-library-design.md:196`](2026-07-04-fs38-voices-library-design.md) specified in the first place (§3).

**B. Provision — productise the manual workaround.** Copy PyAV's bundled FFmpeg set into `site-packages/torchcodec/` under canonical names, plus `os.add_dll_directory()` before the Coqui import. It demonstrably works — it unblocked the acceptance run. Rejected because it buys a Windows-specific install path, ~80 MB of duplicated DLLs, a dependence on undocumented PyAV bundling internals, and a second FFmpeg major inside the venv that differs from the `ffmpeg.exe` the rest of the pipeline shells out to. Worse, PyAV is undeclared and reaches the venv only via **`faster-whisper`** (`Requires-Dist: av>=11`) — an unrelated engine, so a faster-whisper release that drops PyAV silently re-breaks Coqui cloning. And it leaves `torchaudio.load` on the hot path, so the next torchcodec-or-FFmpeg-major drift reproduces this bug exactly.

**C. Document a shared-build requirement and detect it in Setup.** Not a fix. It leaves the feature broken on the normal Windows install and makes every deployer solve it. Survives only as the probe component of A, in the changed form described in §8.

## 6. The replacement loader

New module `server/tts-sidecar/xtts_audio_io.py`, exposing two things.

**`soundfile_load_audio(audiopath, sampling_rate)`** — a semantic clone of `xtts.py:80` differing only in how bytes become a tensor:

```python
data, lsr = sf.read(audiopath, dtype="float32", always_2d=True)   # (frames, channels)
audio = torch.from_numpy(data.T.copy())                            # (channels, frames)
```

then the original's own mono downmix, `torchaudio.functional.resample`, range warning, and `clip_(-1, 1)`, copied verbatim. Three properties make this a faithful substitution rather than a lookalike, all confirmed in review: `torchaudio.load` returns float32 normalised to [-1, 1] in `(channels, frames)` (`torchaudio/_torchcodec.py:63-75`); FFmpeg's s16→flt and libsndfile's float read of PCM_16 both scale by 1/32768, and the input is always the mono PCM_16 WAV `_atomic_wav_save` (`main.py:227-247`) wrote two lines earlier; and the resampler is the *same* `torchaudio.functional.resample` call, so no resampling difference can reach the derived latents.

**`soundfile` is declared, not assumed.** Review found it in no requirements file — it arrives transitively via `coqui-tts → librosa`. That is tighter coupling than Option B's PyAV problem (soundfile ships with the very package we are patching, not with an unrelated engine), but "tighter" is not "declared", and the argument used to reject B applies to A unless it is closed. So the Coqui opt-in install adds `soundfile` explicitly, alongside `coqui-tts`, in `install-coqui.mjs`.

*Rejected alternative:* decoding with the stdlib `wave` module plus `np.frombuffer`, which would need no dependency at all. It was rejected for narrowing the contract — `wave` handles only PCM, so a future caller handing XTTS any other format would break where soundfile would not — and for diverging from the design of record in §3, which specified soundfile. Declaring the dependency is the more honest close.

**`patched_xtts_load_audio()`** — a context manager that swaps the replacement into `TTS.tts.models.xtts` for the duration of the derive and restores the original on exit, including on exception. Scoped rather than permanent so nothing else in the process inherits a mutated third-party module. Confirmed to take effect: `get_conditioning_latents` calls bare `load_audio(file_path, load_sr)` at `xtts.py:362` — a module global, not a closure, method, or import-from binding.

**Concurrency is an explicit constraint, not an accident of placement.** The context manager mutates a process-global on a single shared `CoquiEngine` instance (`main.py:6529-6530`), reached from a thread pool via `asyncio.to_thread`. It is safe *only* because `clone_voice` holds `self._synth_lock` (`:2452`) across the `get_conditioning_latents` call (`:2502`), which serialises derives against each other and against `/synthesize`. **The invariant to implement against: the context manager must be entered and exited inside `with self._synth_lock:`.** Wrapping the `clone_voice` body, the `to_thread` call site, or applying the patch at engine load all put a global mutation outside the lock and are wrong.

## 7. Pinning `coqui-tts` and `torchcodec`

v1 asserted that `install-coqui.mjs` pins `coqui-tts`, and used that to justify raising on drift rather than falling back. **Review contradicted it and I confirmed the contradiction:** `install-coqui.mjs:104` runs `pip install coqui-tts -c <base.txt>`, and `base.txt` contains no `coqui-tts` line, so the constraints file constrains nothing for this package. `torchcodec` (`:109`) is likewise unversioned. The README's `>=0.24.0` row describes a spec that exists in no file.

That inverts the risk. Unpinned, "drift" is not a hand-upgrade — it is **the next `install-coqui.mjs` run on any machine**. The first upstream release that renames or re-signatures `load_audio` would turn a Windows-static-FFmpeg bug into a total clone-derive failure on every new install, on every platform, with this design's own no-fallback rule guaranteeing it, and with existing dev boxes keeping their working version so nobody reproduces it locally.

**So this PR pins both, exactly** — `coqui-tts==0.27.5` and `torchcodec==<installed>` in `coquiPipInstallSteps`, matching how `torch`/`torchaudio` are already pinned. That restores the premise the raise-on-drift rule depends on, and closes a second latent hazard: an unpinned torchcodec wheel that fails to *import* (not merely to load its DLLs) would break `import TTS` outright — strictly worse than the bug being fixed.

The cost is real and accepted: Coqui upgrades become deliberate. That is the correct trade for an opt-in engine whose breakage is silent and deployer-side.

## 8. Readiness probe

A sidecar self-check that exercises the real mechanism instead of a proxy for it: synthesise a small in-memory WAV, push it through `patched_xtts_load_audio()`, and assert a tensor of the expected shape comes back. (`load_audio` returns a bare tensor, not a rate — v1 said otherwise.)

**Three states, because Coqui is opt-in and absent from every overlay:**

| State | When | Setup shows |
|---|---|---|
| `not-installed` | no `TTS` package — the majority install | nothing; this is not a failure |
| `ready` | patch applies, WAV round-trips | pass |
| `broken:<reason>` | `load_audio` moved, soundfile missing, unrecognised `coqui-tts` | fail, naming the reason |

Reporting `pass` when Coqui is absent would restore precisely the vacuous-green pathology §3 condemns, so the neutral state is separate from the healthy one.

**Surface.** v1 called this a small addition alongside the ffmpeg check; review showed that was wrong, and it is the largest single piece of the PR. `server/src/routes/setup-diagnosis.ts` is a pure-function module over pre-probed booleans — `TtsDiagnosisInput` (`:118-140`) has slots for Kokoro and Qwen and none for Coqui, and `diagnoseFfmpeg` (`:205`) consumes booleans from a local CLI probe. The probe therefore needs a sidecar-side implementation exposed on the existing Coqui install-state surface, a new `TtsDiagnosisInput` member, the wiring that fills it, and its own tests on both sides. It is budgeted as its own surface in §13, not as a rider on the loader.

It deliberately does **not** probe for `avcodec-*.dll`. After this fix a box with no shared FFmpeg libraries clones perfectly well, so a shared-library probe would fail boxes that work — the wrong question, asked confidently. Its real value is catching §6's drift failure at Setup instead of at derive time, which is the one way this fix can decay.

## 9. Test strategy

**The torchcodec-poison test is the centrepiece.** Block `import torchcodec` with a meta-path finder, purge it from `sys.modules`, then drive the derive path and assert it completes. Both halves are asserted in the same file: under poison the *unpatched* loader must raise, and the *patched* one must succeed. A poison test that only checks the success case is another test that cannot fail, and this bug already survived two of those (§3).

`coqui-tts` is opt-in and absent from every overlay, so the real `TTS` package is not installed in CI. Coverage therefore splits three ways, and the gap is named rather than papered over:

| Layer | Where it runs | What it proves |
|---|---|---|
| Mechanism | Everywhere (`npm run test:sidecar`) | Against the fake-`TTS` fixture pattern the existing clone tests use, with a fake `load_audio` that calls `torchaudio.load` as the real one does — the context manager swaps, restores, raises on drift, and stays inside `_synth_lock`. |
| Fidelity | Where Coqui is installed; skips cleanly otherwise | Reads the *installed* `TTS/tts/models/xtts.py`, asserts `load_audio`'s signature is still `(audiopath, sampling_rate)` and that it still calls `torchaudio.load` — so the patch stays both necessary and correctly shaped. Triple-gate skip style follows the golden-audio sidecar tier. |
| Reality | On-box only | A real Coqui cloned-voice derive on a static-FFmpeg box. Unprovable in CI by construction → an on-box acceptance row, not a merge blocker. |

The fidelity tier runs on the deployer's box, i.e. *after* a bad upgrade rather than before it. The pin in §7 is what makes that acceptable; without it, this tier would be the only thing standing between an upstream release and a total clone failure, and it would arrive too late.

`test_audio_io_invariant.py` keeps guarding our own source, but its docstring states the claim that broke and calls itself vacuously green. It is corrected to say what it covers and, more usefully, what it structurally cannot — a call inside a third-party package the sidecar invokes — with a pointer to the poison test.

**No Playwright spec.** The change is a server-thrown message and a sidecar code path, crossing no router, redux, or layout seam — below the e2e bar in CLAUDE.md's testing discipline.

## 10. The `derive-failed` copy

v1 got the mechanism wrong here; the conclusion survives but the implementation instruction does not.

`derive-failed` is neither `engine-unavailable` nor `wrong-engine`, so it lands in `fromList`'s catch-all, and `engineLabelFor(broken, 'engine-unavailable')` (`clone-voice-resolver.ts:88-95`) finds no matching entry and returns its `'Qwen'` fallback. **Tagging the entry with `engine: 'coqui'` changes the output not at all** — `engineLabelFor` filters on `reason`, so a `derive-failed` entry never matches `'engine-unavailable'` however it is tagged. v1 claimed this yields "Re-enable Coqui"; it yields "Re-enable Qwen", unchanged.

The fix needs both halves:

1. **Exclude `derive-failed` from the catch-all.** `hasOtherReason` is currently `broken.some(b => b.reason !== 'wrong-engine')` (`:138`), which is true for a pure derive-failed list. It becomes `b.reason !== 'wrong-engine' && b.reason !== 'derive-failed'`. Without this the reported bad sentence *survives* and the new clause is merely appended after it — the acceptance criterion would read as met while the user still sees "Re-enable Qwen".
2. **Give `derive-failed` its own remedy clause**, the shape Wave 3c Task 6b gave `wrong-engine`: the clone itself failed, so the remedy is to re-run the clone and check the sidecar log. Re-enabling an already-enabled engine fixes nothing.

**Tests at risk are not the one v1 named.** `clone-voice-resolver.test.ts:1415` is the `engine-unavailable` case and is untouched. The assertions that move if derive-failed entries get engine-tagged are the four `toEqual`s against un-tagged literals — `:660`, `:992`, `:1052`, and `:1331` (the coqui one, expecting `[{ name: 'Marlow', reason: 'derive-failed' }]`). The resolver's own comment at `:61-66` documents this hazard exactly. The plan budgets for updating them; loosening them is the wrong fix.

## 11. Docs and installer sweep

After the fix the premise becomes *true*, but only if stated precisely, and the current phrasing is wrong in a second way. **The sidecar does not do its audio I/O via soundfile today** — `main.py` imports soundfile zero times, writes WAVs with the stdlib `wave` module (`:38`, `:236`) and reads wire PCM with `np.frombuffer` (`:6146`, `:6423`, `:8814`, `:9100`). So "the sidecar does all audio I/O via soundfile + ffmpeg" was never accurate and cannot simply be kept.

The replacement claim, to land at all nine sites in §2 plus `warning_filters.py:19` and `test_audio_io_invariant.py`'s docstring:

> The sidecar does its audio I/O via the stdlib `wave` module, NumPy, and the `ffmpeg` CLI; the XTTS clone path additionally decodes its reference WAV with `soundfile`. `torchaudio.load` is never called. `torchcodec` is installed only to satisfy `coqui-tts`'s import-time presence check and is never invoked.

Plus the separate correction to `requirements/nvidia-cuda.txt:14` ("Coqui uses manifest speakers, not `speaker_wav`" — true of inference, false of cloning).

**Installers.** `install-coqui.mjs` gains the two pins and the `soundfile` declaration (§6, §7); `--no-deps torchcodec` remains right, and its `:82` comment keeps its prediction while dropping the claim that nothing calls it.

**Pinokio — genuinely unknown, to be checked.** `install.js:43` / `update.js:42` do provision `conda install -y -c conda-forge "ffmpeg>=6"`, and conda-forge builds ffmpeg shared. But v1 concluded from that alone that Pinokio was unaffected, which contradicts this spec's own §1: conda's shared libraries live in `env/Library/bin`, not beside `site-packages/torchcodec/`, and the sidecar venv is a *nested* `.venv` created from the conda interpreter (`install.js:74`). Shared-ness does not imply loadable. So Pinokio may well have been affected too. This is checked on a real Pinokio install and recorded either way; the fix makes the answer moot for behaviour, but not for the docs.

`start.js`, `stop.js` and `reset.js` touch neither ffmpeg nor Coqui and need nothing.

## 12. Verifying the fix

The development venv is currently hot-patched — PyAV's FFmpeg 8 DLLs were copied into `site-packages/torchcodec/` under canonical names to unblock the acceptance run. **The fix cannot be honestly verified against that venv**: with those libraries present torchcodec loads, and the derive passes whether or not the replacement loader ever runs.

Verification therefore requires deleting the non-hash-suffixed `*.dll` from `site-packages/torchcodec/`, confirming `import torchcodec` fails again, and only then running the derive. That returns the box to broken for the duration, and fs-38 Wave 3 is mid-run (16/60) with Section E depending on it — so the revert is scheduled with the repo owner rather than performed opportunistically.

**On-box acceptance owed** (register row + `docs/testing/fs38-wave3-onbox-acceptance.md`):

1. On a box whose only FFmpeg is static, `.venv\Scripts\python.exe -c "import torchcodec"` still fails **and** a Coqui cloned-voice derive completes, writing `voices/xtts/xtts-<uuid>.{pt,json}`.
2. Latent equivalence — a derive on a shared-FFmpeg box before and after the change produces audibly equivalent output, confirming the soundfile read is a true substitution.
3. The readiness probe reports `ready` on a healthy Coqui box, `broken` on a deliberately broken one, and `not-installed` on a box that never opted into Coqui.
4. Pinokio: whether `import torchcodec` succeeds there (§11), recorded either way.

## 13. Surfaces and PR shape

Five surfaces, one PR, one task each. Every part traces to #1967, and the docs correction is meaningless without the fix — shipping the fix alone would leave documentation that contradicts it.

1. **Loader** — `xtts_audio_io.py`, the `clone_voice` wrap inside `_synth_lock`.
2. **Install** — `coqui-tts` + `torchcodec` pins, `soundfile` declared.
3. **Probe** — sidecar install-state field, `TtsDiagnosisInput` member, Setup wiring.
4. **Copy** — `hasOtherReason` exclusion + the `derive-failed` remedy clause, and the four `toEqual` tests.
5. **Docs** — eleven sites, the corrected claim, and the diverged design of record in §3.

## 14. What changed in v2

Recorded because v1 was reviewed and found wrong on five load-bearing points; two of them change what gets built.

- **The pin did not exist.** v1's raise-on-drift rule was justified by a `coqui-tts` pin that is in no file. §7 is new: this PR now creates the pin it assumed. *Changes the build.*
- **Engine-tagging `derive-failed` is a no-op.** v1's copy fix would have shipped with the reported bad sentence intact. §10 now specifies the `hasOtherReason` exclusion. *Changes the build.*
- **Wrong test named.** v1 flagged `:1415`; the tests actually at risk are `:660`, `:992`, `:1052`, `:1331`.
- **Six doc sites was wrong** — there are nine live ones plus two related, and v1 miscited `accelerator-profile.mjs:161`, which carries no such claim. The premise sentence is also false in a second way (§11): the sidecar never used soundfile at all.
- **The probe is a surface, not an addition.** `setup-diagnosis.ts` is a pure function over pre-probed booleans with no Coqui slot, and v1 had no answer for the majority install where Coqui is absent. §8 now specifies three states and the full wiring.
- **Third guardrail found.** §3 gains the diverged design of record, which shifts the lesson from "write a poison test" to "reconcile plan against implementation" — and adds a doc to the sweep.
- **Concurrency safety was accidental.** Confirmed safe via `_synth_lock`, but v1 never named it; §6 now states it as an implementation constraint.
- **Pinokio conclusion withdrawn** (§11) as contradicting §1.

## 15. Out of scope

- Making torchcodec functional (option B) — explicitly rejected, §5.
- Removing torchcodec from the Coqui install; `coqui-tts` still presence-checks it at import.
- Any change to Kokoro, Qwen, Whisper/ASR, or the ECAPA speaker-embed path — none reaches `torchaudio.load` (§4).
- The temp-WAV round-trip in `clone_voice`. Passing in-memory audio would mean owning XTTS's latent math instead of a ten-line leaf function; the round-trip is cheap and the coupling is not worth trading.
- Rewriting historical release notes and superseded design docs (§2).

## 16. Risks

| Risk | Mitigation |
|---|---|
| `coqui-tts` upgrade moves or reshapes `load_audio` | Exact pin created by this PR (§7); context manager raises rather than falling through (§6); readiness probe surfaces it at Setup (§8); fidelity test pins the signature where Coqui is installed (§9). |
| Replacement loader is not bit-faithful, shifting derived latents | Same `torchaudio.functional.resample`, same 1/32768 normalisation, same clip, verified against `torchaudio/_torchcodec.py:63-75`; on-box acceptance item 2 compares real output. |
| Patch applied outside `_synth_lock`, mutating a process global under concurrency | Stated as an explicit implementation constraint (§6) and asserted by the mechanism test (§9). |
| Docs sweep skimped, stale premise survives | All eleven sites enumerated in §2 and §11 with the exact replacement text; the sweep is its own surface (§13) with a file list, not an "and update the docs" line. |
| Pin freezes a security fix in `coqui-tts` | Accepted (§7). Coqui is opt-in; Dependabot still surfaces advisories against the pinned version. |
| PR spans five surfaces | Every part traces to #1967; splitting would ship a fix whose own documentation contradicts it. One task per surface. |
