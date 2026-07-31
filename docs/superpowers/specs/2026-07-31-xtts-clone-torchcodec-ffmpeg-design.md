# XTTS cloned-voice derive without torchcodec — design

**Status:** approved
**Issue:** [#1967](https://github.com/dudarenok-maker/Castwright/issues/1967) (`bug`, `area:side`)
**Found by:** fs-38 Wave 3 on-box acceptance Run 2 (2026-07-31), `main` @ `b5479e9c` — blocked all nine items of Section E
**Related plan:** [271-fs38-wave3c-xtts.md](../../features/271-fs38-wave3c-xtts.md)
**Revision:** v4, after three adversarial review rounds. §14 records what changed and why. Round 2 forced a redesign of the pin and the probe; round 3 broke no mechanism and returned *converged on the design* — v4 is its four patches, plus the correction of a habit it named: **this spec kept asserting exhaustiveness ("exactly two hits", "the complete set", a site count) and kept being wrong.** Every such claim is now either re-derivable from a stated command or dropped.

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

torchaudio 2.9 removed the in-core soundfile/sox backends, so *every* `torchaudio.load` now dispatches to torchcodec, which needs FFmpeg's **shared** libraries. The gyan.dev `full_build` is `--enable-static`: it ships `ffmpeg.exe` and no `avcodec-*.dll` at all. Everything the *product* does with FFmpeg — assembly, loudnorm, peaks — happens in the Node server and shells out to `ffmpeg.exe`, so it is unaffected.

The version is not the problem. This box runs FFmpeg 8.1.1 and torchcodec ships a matching `libtorchcodec_core8`. Shared-vs-static is the problem. `PATH` cannot fix it either: CPython ≥3.8 ignores `PATH` for `ctypes.CDLL`, so the libraries must sit beside the loading library or be registered via `os.add_dll_directory()`.

The never-substitute guarantee holds throughout — the chapter fails loudly rather than rendering someone else's voice — so this is a hard block, not a silent corruption.

## 2. Why it was invisible until now

Stock XTTS voices read pre-computed latents from the speaker manifest and never touch `load_audio`. Only a *cloned* voice reaches `get_conditioning_latents` with a real audio path, so the defect could not exist before Wave 3c shipped cloning on Coqui, and it surfaced on the first on-box run afterwards.

Compounding it, the repo asserts the opposite of what it does, in two overlapping false claims — "never calls `torchaudio.load`", and "audio I/O via soundfile + ffmpeg".

**Re-derive this list before sweeping; do not trust the table.** Successive revisions of this spec claimed six, then nine, then eleven, then twelve sites, and every count was short — twice in files already cited. The table below is *known sites at time of writing*, not an inventory. The sweep starts by running:

```
rg -n "torchaudio\.load|audio I/O via soundfile|never actually called|manifest speakers" \
   --glob '!**/{node_modules,.venv,dist}/**' .
```

and triaging each hit as live (correct it) or historical (leave it, §2 final paragraph).

| Site | Shape of the claim |
|---|---|
| `docs/wiki/Installing-Castwright.md:41` | "never calls `torchaudio.load`" + "never actually called at runtime" |
| `INSTALL.md:27` | "never calls `torchaudio.load`" |
| `server/tts-sidecar/README.md:12` | "never calls `torchaudio.load`" |
| `server/tts-sidecar/README.md:15` | `coqui-tts \| >=0.24.0` — a constraint that exists in no file (§7) |
| `server/tts-sidecar/README.md:16` | the most detailed false claim in the repo — names this exact failure ("can't load its shared libs against a static FFmpeg 8 build") and then says it "is never reached" |
| `server/tts-sidecar/README.md:78` | "never calls torchaudio.load" |
| `server/tts-sidecar/README.md:626` | a third, independent "We do all audio I/O via soundfile + ffmpeg" in the suppressed-warnings table |
| `server/tts-sidecar/requirements/nvidia-cuda.txt:13` | "the sidecar NEVER calls torchaudio.load" |
| `server/tts-sidecar/requirements/nvidia-cuda.txt:14` | a *second*, separate falsehood: "Coqui uses manifest speakers, not `speaker_wav`" — true of inference, false of cloning, and the sentence that most directly encoded the wrong mental model |
| `server/tts-sidecar/scripts/install-coqui.mjs:80,83` | "never calls" + the same static-FFmpeg prediction, asserted as unreachable |
| `server/tts-sidecar/tests/test_requirements.py:88-97` | `test_torch_and_torchaudio_are_a_matched_pair`'s docstring — a *separate* test from the one below, carrying both false claims plus the wrong-mental-model sentence |
| `server/tts-sidecar/tests/test_requirements.py:109-125` | `test_no_torchcodec`'s docstring: "the sidecar never calls torchaudio.load … so torchcodec's FFmpeg decode path … is never reached" |
| `server/tts-sidecar/warning_filters.py:19` | "We do all audio I/O via soundfile + ffmpeg" |

`server/tts-sidecar/tests/test_audio_io_invariant.py`'s docstring carries a *related* falsehood — "Qwen reads audio via soundfile (`sf.read`)" — and is corrected alongside (§11).

Two mechanical notes for the sweep: `README.md:77-79` is a **fenced quote of `nvidia-cuda.txt:12-14`**, so those two sites must be edited in lockstep or the quote drifts from its source; and several rows above carry *both* false claims on one line, so a per-claim pass over the file will visit some lines twice.

Historical records are **not** rewritten: `docs/wiki/Release-Notes-v1.9.0.md`, the June `sidecar-torch-cve-bump` / `amd-gpu-sidecar-support` / `pinokio-installer` specs and plans stated what was believed when they shipped. One exception, §3.

## 3. Why three guardrails missed it

This matters more than the ten-line fix, because three separate mechanisms were aimed at exactly this risk and all three were shaped so they could not see it.

**`tests/test_audio_io_invariant.py` greps the wrong files.** It scans `SIDECAR.glob("*.py")` (`:39`) — the sidecar's own top-level sources — for `torchaudio.load(`. The offending call lives in a third-party package the sidecar *invokes*, so no amount of correctness in the regex could have caught it. Its own docstring says it is "EXPECTED to be vacuously green today", which was true, stayed true, and told nobody anything.

**`tests/test_xtts_clone_voice.py` stubs out the decode.** All 2131 lines drive `CoquiEngine.clone_voice` against a fake `tts_model` whose `get_conditioning_latents` asserts it received a path and then never opens it. The one line of real behaviour that mattered was the one the fixture replaced.

**The design of record specified the correct behaviour and the implementation diverged.** [`2026-07-04-fs38-voices-library-design.md:196`](2026-07-04-fs38-voices-library-design.md) reads: *"**XTTS:** derive = … load `master.wav` via **`soundfile`** (never `torchaudio.load`; a guardrail test forbids it), run `get_conditioning_latents`…"*. Wave 3c instead shipped a path handoff (`main.py:2494-2504`, "Trap 2") that routes the decode straight into `torchaudio.load`. Nobody reconciled the divergence, and the guardrail test named in that very sentence was the one from the first bullet.

That third one is the actual recurrence vector, and it is not a testing gap — it is a plan-to-implementation reconciliation gap. The poison test in §9 closes the testing half; correcting that design doc (the one historical exception in §2) closes the other half by removing a stale spec that still reads as satisfied.

## 4. Blast radius

Verified by grep across the installed venv, and independently re-verified in review:

- In all of `TTS/`, the only `torchaudio.load` reachable from any path we use is `xtts.py:80` `load_audio`, called at `:362`. The others live in `bark`, `vits`, `knnvc`, `utils/vad`, `datasets/dataset`, the bundled `server/server.py`, and the fine-tune demos — none imported. `main.py` contains **zero** `speaker_wav` occurrences, so `Xtts.synthesize`'s own clone branch (`xtts.py:442`) is unreachable.
- `speechbrain` contains no `torchaudio.load`/`.info` call; it already migrated to its own soundfile layer. The ECAPA/QA speaker-embed path is unaffected.

`load_audio` itself is a leaf function: `torchaudio.load` → mono downmix → `torchaudio.functional.resample` → range warning → `clip_(-1, 1)`, returning a single tensor. Only the first line needs a codec; `torchaudio.functional` is pure tensor math.

Meanwhile `clone_voice` already holds fully decoded PCM. `main.py:9100` builds `ref_audio` from raw int16 wire bytes, and `:2500` writes it back out to a temp WAV solely because `get_conditioning_latents` takes a path — which XTTS then re-decodes through torchcodec. The failing decode is a round-trip of audio the sidecar never needed to encode.

## 5. Options considered

**A. Bypass — replace XTTS's `load_audio` on the clone path. → CHOSEN.** One leaf function, one call site. `torchaudio.load` is never reached, so torchcodec returns to being the merely-present import-satisfier `install-coqui.mjs` always intended, and the docs' premise becomes true rather than needing retraction. Platform-agnostic: it fixes static-FFmpeg Windows, static Linux builds, and any future variant, with no Pinokio change.

**B. Provision — productise the manual workaround.** Copy PyAV's bundled FFmpeg set into `site-packages/torchcodec/` under canonical names, plus `os.add_dll_directory()` before the Coqui import. It demonstrably works — it unblocked the acceptance run. Rejected because it buys a Windows-specific install path, ~80 MB of duplicated DLLs, a dependence on undocumented PyAV bundling internals, and a second FFmpeg major inside the venv. Worse, PyAV is undeclared and reaches the venv only via **`faster-whisper`** (`Requires-Dist: av>=11`) — an unrelated engine, so a faster-whisper release that drops PyAV silently re-breaks Coqui cloning. And it leaves `torchaudio.load` on the hot path, so the next torchcodec-or-FFmpeg-major drift reproduces this bug exactly.

**C. Document a shared-build requirement and detect it in Setup.** Not a fix. It leaves the feature broken on the normal Windows install and makes every deployer solve it. Its detection half survives in the relocated form described in §8.

## 6. The replacement loader

New module `server/tts-sidecar/xtts_audio_io.py`, exposing two things.

**`wave_load_audio(audiopath, sampling_rate)`** — a semantic clone of `xtts.py:80` differing only in how bytes become a tensor. It decodes with the **stdlib `wave` module plus NumPy**, the same pair `main.py` already uses everywhere else:

```python
with wave.open(audiopath, "rb") as w:
    if w.getsampwidth() != 2:                       # loud, not silent — see below
        raise ValueError(f"expected PCM_16 reference WAV, got {w.getsampwidth() * 8}-bit")
    lsr, nch = w.getframerate(), w.getnchannels()
    raw = w.readframes(w.getnframes())
pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
audio = torch.from_numpy(pcm.reshape(-1, nch).T.copy())   # (channels, frames)
```

then the original's own mono downmix, `torchaudio.functional.resample`, range warning, and `clip_(-1, 1)`, copied verbatim.

Three properties make this a faithful substitution rather than a lookalike, all confirmed in review: `torchaudio.load` returns float32 normalised to [-1, 1] in `(channels, frames)` (`torchaudio/_torchcodec.py:63-75`); FFmpeg's s16→flt conversion scales by exactly 1/32768, matching the divisor above; and the resampler is the *same* `torchaudio.functional.resample` call, so no resampling difference can reach the derived latents.

**Why stdlib rather than soundfile.** The input is always the mono PCM_16 WAV that `_atomic_wav_save` (`main.py:227-247`) wrote two lines earlier at `:2500`, so nothing broader is needed — and `wave` + NumPy is what the sidecar already uses for all its audio I/O (`main.py:38`, `:236`, `:6146`, `:8814`, `:9100`). Choosing the pair the module's own neighbours use keeps one decode idiom in the file instead of two.

**The availability argument v3 gave for this was false, and is withdrawn.** v3 claimed `soundfile` reaches the venv only via `coqui-tts → librosa`, and therefore that a soundfile-based §9 mechanism test would be unrunnable wherever Coqui was never installed. Round 3 disproved it: `requirements/speaker-qa.txt:6` pins `speechbrain==1.1.0`, which declares `soundfile>=0.12.1`, and `speaker-qa.txt` is included by **all three** overlays (`nvidia-cuda.txt:65`, `amd-rocm.txt:30`, `cpu.txt:27`); `qwen-tts` declares `soundfile` too. It is present on every profile. **Either implementation would have worked.** The stdlib choice stands on simplicity and on parity with `main.py`, not on availability — recorded plainly because a decision defended by a false reason is exactly what §3 is about.

The narrowed contract (PCM only) is not a silent narrowing: the `getsampwidth() != 2` guard raises rather than mis-decoding.

**Two implementation traps.** `wave.open` on CPython 3.12 special-cases only `isinstance(f, str)`; a `pathlib.Path` falls through to the open-file-object branch and dies with `AttributeError` rather than the designed `ValueError`. `get_conditioning_latents` types `audio_path` as `str | os.PathLike[Any]` (`xtts.py:320,333`) and today's caller passes a `str` (`main.py:2499`), so nothing breaks — but the module normalises with `os.fspath(audiopath)` regardless. And `xtts_audio_io.py` will sit in the top-level directory that `test_audio_io_invariant.py:39` scans, whose `_strip_comments` (`:22-24`) drops only `#` lines — **not docstrings**. A docstring mentioning `torchaudio.load(` in call form will redden that guardrail; write it as "torchaudio's loader" or similar.

**`patched_xtts_load_audio()`** — a context manager that swaps the replacement into `TTS.tts.models.xtts` for the duration of the derive and restores the original on exit, including on exception. Scoped rather than permanent so nothing else in the process inherits a mutated third-party module. Confirmed to take effect: `get_conditioning_latents` calls bare `load_audio(file_path, load_sr)` at `xtts.py:362` — a module global, not a closure, method, or import-from binding.

**Concurrency is an explicit constraint, not an accident of placement.** The context manager mutates a process-global on a single shared `CoquiEngine` instance (`main.py:6529-6530`), reached from a thread pool via `asyncio.to_thread`. It is safe *only* because `clone_voice` holds `self._synth_lock` — a plain `threading.Lock` (`main.py:1321`) — from `:2452` across the `get_conditioning_latents` call at `:2502`, serialising derives against each other and against `/synthesize`. **The invariant to implement against: inside the sidecar process, every entry and exit of this context manager happens inside `with self._synth_lock:`.** Wrapping the `clone_voice` body, the `to_thread` call site, applying the patch at engine load, or entering it from any request path outside the lock are all wrong — the last of those is what sank v2's probe (§8), because an `__exit__` firing outside the lock restores the *original* loader while a real derive is mid-flight, reintroducing #1967 intermittently and non-reproducibly.

**The carve-out, stated because §7 relies on it:** the invariant is scoped to the sidecar process. §7's install-time verification enters the same context manager without the lock, and is safe because `install-coqui.mjs` runs as a **separate Python process** with its own module globals — it cannot perturb the sidecar's `TTS.tts.models.xtts`. That process boundary is the whole reason, and it is *not* "no derive can be in flight": `POST /api/coqui/install` (`server/src/routes/coqui-install.ts:6`) spawns the installer from the running server (`server/src/tts/coqui-install-bootstrap.ts:156`), so a Qwen generation — and a derive — genuinely can be in flight during a Coqui install.

**On drift, it raises rather than falling through.** If `load_audio` is missing or its signature is not `(audiopath, sampling_rate)`, the context manager raises with a message naming the installed `coqui-tts` version. Falling back to the original would read as tolerance while silently restoring this exact bug on every static-FFmpeg box — invisible precisely because the derive still succeeds everywhere a developer tests.

## 7. No pin — install-time verification instead

v1 asserted `install-coqui.mjs` pins `coqui-tts`; it does not (`:104` runs `pip install coqui-tts -c base.txt`, and `base.txt` has no `coqui-tts` line, so the constraints file constrains nothing for this package). `torchcodec` (`:109`) is likewise unversioned. `README.md:15`'s `>=0.24.0` row describes a constraint that exists in no file.

v2 responded by adding exact pins. **Review rejected that, correctly, on four counts:** the pins would live in a hardcoded `.mjs` argument array — profile-blind and invisible to `test_requirements.py`, unlike `torch`/`torchaudio` which are pinned in *declarative per-profile overlays* the tests parse; an exact `torchcodec` pin risks hard-failing the installer on the AMD/ROCm profile, where `amd-rocm.txt:7-10` records torchcodec as unneeded and merely inert, and where a missing wheel would turn a benign install into `process.exit(1)`; the pins break existing assertions in `server/src/tts/install-coqui-steps.test.ts` (notably `:22-29`'s exact-array equality) that v2 budgeted nothing for; and §16's "Dependabot still surfaces advisories" mitigation is false twice over — **the repo has no `.github/dependabot.yml`**, and Dependabot could not read a version inside a JS array if it did.

**So there is no pin.** The premise the raise-on-drift rule needs — that drift is detected before it reaches a deriving user — is supplied instead by a **post-install verification step in `install-coqui.mjs`**: import `TTS`, assert `TTS.tts.models.xtts.load_audio` exists with signature `(audiopath, sampling_rate)`, and round-trip a small generated PCM_16 WAV through `patched_xtts_load_audio()`.

Three placement decisions, each of which review showed matters:

- **It runs after the pip loop and *before* the weights prefetch** (`install-coqui.mjs:159-167`). Before, because `import TTS` and the `load_audio` shape check need no weights, and failing after the prefetch would throw away a ~1.8 GB, multi-minute download the user had already paid for. This also means a failure costs the user only the pip time.
- **It lives outside `coquiPipInstallSteps`, as its own exported function.** That array is asserted by exact equality — `install-coqui-steps.test.ts:22-29` maps `args[indexOf('install') + 1]` over every step and compares to `['coqui-tts','torchcodec','pypinyin']`. A verification step added *into* the array has no `install` token, so `indexOf` returns `-1`, a bogus element appears, and the assertion fails. Keeping it separate leaves all six existing `it` blocks green and gives the new step its own describe block.
- **It fails the install** (`process.exit(1)`, matching `:133`/`:155`/`:167`), surfaced by `coqui-install-bootstrap.ts:191`. A warning would leave a Coqui install that looks complete and cannot clone — the failure mode this whole spec exists to remove. The message names the installed `coqui-tts` version and this issue.

It is profile-independent: `import TTS` and the `load_audio` shape check behave identically on NVIDIA, ROCm and CPU, and the check touches nothing torchcodec-specific.

One unwritten dependency to preserve: the snippet imports `xtts_audio_io`, which resolves only because `run()` sets `cwd: SIDECAR_DIR` (`install-coqui.mjs:60`) and `python -c` prepends the CWD to `sys.path`.

This is strictly better than a pin for this codebase. It runs exactly once, at opt-in install time, where a ~12 s `import TTS` is irrelevant against a multi-minute install. It is profile-agnostic. It needs no version bookkeeping and no `test_requirements.py` change. It converts "the next upstream release silently breaks every new install's cloning" into "the Coqui install refuses, with the reason" — which is the outcome the pin was reaching for, without freezing the dependency.

What it does not cover: a venv that breaks *after* install, e.g. a manual `pip install -U coqui-tts`. That case still surfaces at derive time via §6's raise, with the same message. Stated rather than hidden.

`README.md:15`'s phantom `>=0.24.0` row is corrected in the same sweep (§11) to describe what actually happens: unpinned, verified at install.

## 8. Where the readiness check lives

You asked for a Setup-wizard probe. **It moves into §7's post-install verification instead**, and this is the one place v3 knowingly departs from what was approved — so the reasoning is set out rather than assumed.

v2 put the probe in the Setup diagnosis path, and round 2 found that specification unbuildable for three independent reasons:

1. **It violated §6's own concurrency invariant.** A Setup-triggered probe entering `patched_xtts_load_audio()` outside `_synth_lock` can restore the original loader mid-derive — reintroducing #1967 intermittently. Taking the lock instead would hang Setup behind a synth or a ~90 s cold load (cf. open `#1925`).
2. **It could not use the surface it was hung off.** `/health` already carries Coqui install state (`coqui_package_installed`, `coqui_import_ok`, `coqui_version`, `coqui_weights_present`), consumed by `deriveCoquiInstallState` (`server/src/routes/sidecar-health.ts:286-290`) — but `tests/test_install_state.py:160-173` explicitly pins that this surface must **not** `import TTS`, so a 30-second poll never eats the torch-pulling import cost. `test_coqui_import_pin.py:113-116` measures that cost at **14.6 s vs 2.9 s**. The probe cannot patch `TTS.tts.models.xtts` without importing TTS.
3. **It had no answer for a `broken` verdict.** `diagnoseTts` returns a single pass/fail blocker, so `broken` for an opt-in engine either fails Setup on a box where Kokoro works fine, or is invisible.

Install-time verification dissolves all three: it needs no lock because it runs in a **separate Python process** (§6's carve-out — *not* because nothing can be in flight; `POST /api/coqui/install` runs against a live server, so a derive genuinely can be), it pays the `import TTS` cost exactly once where that is free, and "Coqui not installed" cannot occur at the moment you are installing Coqui — which also disposes of v2's three-state table.

The Setup wizard is therefore **unchanged by this PR**, and `setup-diagnosis.ts` is not touched. (v2 also mis-described it: `TtsDiagnosisInput` does already carry Coqui via `weightsMissingEngine` (`:136`) and `VOICE_ENGINE_IDS`; what it lacks is a `coquiPackageConfirmedBroken` member. Moot now.)

It deliberately does **not** probe for `avcodec-*.dll`. After this fix a box with no shared FFmpeg libraries clones perfectly well, so a shared-library probe would fail boxes that work.

## 9. Test strategy

**The torchcodec-poison test is the centrepiece.** Block `import torchcodec` with a meta-path finder, purge it from `sys.modules`, then drive the derive path and assert it completes. Both halves are asserted in the same file: under poison the *unpatched* loader must raise, and the *patched* one must succeed. A poison test that only checks the success case is another test that cannot fail, and this bug already survived two of those (§3).

**Import order is load-bearing: import `TTS` first, then poison.** `coqui-tts` presence-checks torchcodec at *package* import via `find_spec("torchcodec")` (`install-coqui.mjs:75-79`), so a meta-path finder installed before `import TTS` makes that check fail and `import TTS` raises `ImportError` — the test then "passes" for entirely the wrong reason, which is the §3 pathology wearing a new hat.

`coqui-tts` is opt-in and absent from every overlay, so the real `TTS` package is not installed in CI. Coverage splits three ways, and the gap is named rather than papered over:

| Layer | Where it runs | What it proves |
|---|---|---|
| Mechanism | Any box (`npm run test:sidecar`) | Against the fake-`TTS` fixture pattern the existing clone tests use, with a fake `load_audio` that calls `torchaudio.load` as the real one does — the context manager swaps, restores, raises on drift, and stays inside `_synth_lock`. Runnable everywhere precisely because §6 took the stdlib route and added no dependency. |
| Fidelity | Where Coqui is installed; skips cleanly otherwise | Reads the *installed* `TTS/tts/models/xtts.py`, asserts `load_audio`'s signature is still `(audiopath, sampling_rate)` and that it still calls `torchaudio.load` — so the patch stays both necessary and correctly shaped. Triple-gate skip style follows the golden-audio sidecar tier. |
| Reality | On-box only | A real Coqui cloned-voice derive on a static-FFmpeg box. Unprovable in CI by construction → an on-box acceptance row, not a merge blocker. |

**Honest limit on "gates merge":** sidecar pytest is a **local/pre-push leg only** — `verify.yml` runs no pytest step, and `release.yml:73` notes it skips with a banner. So the mechanism tier gates the developer's push, not cloud CI. That is a pre-existing property of the sidecar harness, not something this PR changes, but v2 claimed "everywhere" and it is worth stating accurately.

`test_audio_io_invariant.py` keeps guarding our own source, but its docstring both states the claim that broke and calls itself vacuously green. It is corrected to say what it covers, what it structurally cannot — a call inside a third-party package the sidecar invokes — and to drop its false "Qwen reads audio via soundfile (`sf.read`)" aside, with a pointer to the poison test.

**No Playwright spec.** The change is a server-thrown message and a sidecar code path, crossing no router, redux, or layout seam — below the e2e bar in CLAUDE.md's testing discipline.

## 10. The `derive-failed` copy

Both earlier revisions got this wrong in a way that would have shipped the reported symptom intact. The full mechanism:

`derive-failed` is neither `engine-unavailable` nor `wrong-engine`, so it lands in `fromList`'s catch-all, and `engineLabelFor(broken, 'engine-unavailable')` (`clone-voice-resolver.ts:88-95`) finds no matching entry and returns its `|| 'Qwen'` fallback. **Tagging the entry with `engine: 'coqui'` changes nothing on its own**, because `engineLabelFor` filters on *reason*.

v2 proposed excluding `derive-failed` from `hasOtherReason`. Review confirmed that fixes a *pure* derive-failed list and leaves a worse residual: for **any** list carrying an "other" reason but no `engine-unavailable` entry, the fallback still fires. `[{Marlow, revoked}, {Reeve, derive-failed}]` still prints "Re-enable Qwen" — and that shape is the existing fixture at `clone-voice-resolver.test.ts:1047-1053`.

The real defect is that the catch-all names an engine to re-enable when no reason in the list is about engine availability. Three changes:

1. **Only name an engine when one was reported unavailable.** Emit "Re-enable {engines}" only when an `engine-unavailable` entry exists; otherwise the clause is just "restore the missing voice(s)". This removes the `|| 'Qwen'` fallback's ability to invent a diagnosis, and fixes `revoked`/`missing-master`/`misconfigured` lists too — not only `derive-failed`. Two consequences to handle: `engineLabelFor`'s `|| 'Qwen'` at `:93` becomes provably dead once it is only called when a matching entry exists, and should go rather than linger as a false safety net; and **the first remedy is sentence-initial** — `:166-169` renders `. ${remedies.join('; ')}.`, so today's capital "Re-enable" is doing capitalisation work that "restore the missing voice(s)" would not. Every clause must read correctly in first position.
2. **Exclude `derive-failed` from the catch-all** — `hasOtherReason` becomes `b.reason !== 'wrong-engine' && b.reason !== 'derive-failed'` — so a pure derive-failed list gets no availability clause at all.
3. **Give `derive-failed` its own remedy clause**, the shape Wave 3c Task 6b gave `wrong-engine`: the clone itself failed on {engine}, so re-run the clone and check the sidecar log. **This clause names the engine, which is why `derive-failed` entries do get engine-tagged** — v2 called the tagging a no-op and then budgeted tests that only move under tagging; the tagging is real, it just does nothing until this clause consumes it.

**Tests.** Change 3's engine-tagging adds an `engine` key to every `derive-failed` entry, so every `toEqual` literal asserting one moves. Re-derive the set rather than trusting a list — `rg -n "reason: 'derive-failed'" server/src --glob '*.test.ts'` — because v2 claimed four and named the wrong file for a fifth. At time of writing it returns **six** across **two** files: `clone-voice-resolver.test.ts:660`, `:992`, `:1052`, `:1331`, and `synthesise-chapter-derive-vram-partition.test.ts:503`, `:832` — the second file was missed by both earlier revisions. `:195`/`:288` are `ClonedVoiceClassification` objects with no `engine` field and do not move; `:1415` is the untouched `engine-unavailable` case, and change 1 cannot disturb it because its label comes from `?? 'qwen'` at `:89`, not the `|| 'Qwen'` at `:93`.

No existing `fromList` message test covers a pure derive-failed list, so **new** tests are owed, not just updates: a pure derive-failed list, the mixed `[revoked, derive-failed]` shape that is the residual above, and a `revoked`-only list to lock the sentence-initial casing from change 1.

**The on-box run sheet is also a copy surface.** `docs/testing/fs38-wave3-onbox-acceptance.md:1341` and `:1755-1785` embed the expected remedy strings verbatim as C-13's acceptance criteria. This change invalidates them, and the PR is already touching that file for §12's new rows.

## 11. Docs and installer sweep

The current phrasing is false in two ways, and the second was itself introduced by v2's proposed replacement. **The sidecar does not use soundfile** — `main.py` imports it zero times — **and the sidecar runtime does not shell out to ffmpeg either.** Grepping every `.py` under `server/tts-sidecar/` for `ffmpeg|subprocess|Popen` returns around thirty hits, but the only *runtime* ones are the two inside `warning_filters.py`'s own false comment; the rest live in `spikes/srv36/*.py`, operator-run analysis scripts that do call `subprocess.run(["ffmpeg", …])` and are not part of the serving process. (v3 asserted "exactly two hits", which was wrong — the conclusion held, the evidence did not, which is the §3 pattern in miniature.)

The evidenced replacement claim, to land at every live site (re-derived per §2) plus `test_audio_io_invariant.py`'s docstring:

> The sidecar does its audio I/O with the stdlib `wave` module and NumPy — Kokoro is ONNX, Qwen and the XTTS clone path read and write PCM directly. It never calls `torchaudio.load`. `torchcodec` is installed only to satisfy `coqui-tts`'s import-time presence check and is never invoked. (The audio pipeline's ffmpeg work — assembly, loudnorm, peaks — runs in the Node server, not in the sidecar runtime.)

Plus two site-specific corrections: `requirements/nvidia-cuda.txt:14`'s "Coqui uses manifest speakers, not `speaker_wav`" (true of inference, false of cloning), and `README.md:15`'s phantom `>=0.24.0` pin (§7).

**Installers.** `install-coqui.mjs` gains the post-install verification step (§7); `--no-deps torchcodec` and the unpinned installs remain unchanged, and its `:83` comment keeps its prediction while dropping the claim that nothing calls it. Because no pin lands *and* the step stays outside `coquiPipInstallSteps` (§7), all six existing `it` blocks in `install-coqui-steps.test.ts` stay green; the new step gets its own describe block.

**Pinokio — genuinely unknown, to be checked.** `install.js:43` / `update.js:42` do provision `conda install -y -c conda-forge "ffmpeg>=6"`, and conda-forge builds ffmpeg shared. But concluding from that alone that Pinokio was unaffected contradicts §1: conda's shared libraries live in `env/Library/bin`, not beside `site-packages/torchcodec/`, and the sidecar venv is a *nested* `.venv` created from the conda interpreter (`install.js:74`). Shared-ness does not imply loadable. So Pinokio may well have been affected too. This is checked on a real Pinokio install and recorded either way; the fix makes the answer moot for behaviour, but not for the docs.

`start.js`, `stop.js` and `reset.js` touch neither ffmpeg nor Coqui and need nothing.

**Filed separately, not fixed here:** `test_coqui_import_pin.py:36-38,105-111` asserts coqui-tts "ships as an ordinary dependency, so `_coqui_package_installed()` is true on EVERY install", which contradicts `test_requirements.py:137-142`'s assertion that coqui-tts is absent from every overlay. One of those two live docstrings is wrong. It is adjacent but not caused by this change, needs its own judgement, and gets a `type:chore` issue.

## 12. Verifying the fix

The development venv is currently hot-patched — PyAV's FFmpeg 8 DLLs were copied into `site-packages/torchcodec/` under canonical names to unblock the acceptance run. **The fix cannot be honestly verified against that venv**: with those libraries present torchcodec loads, and the derive passes whether or not the replacement loader ever runs.

Verification therefore requires deleting the non-hash-suffixed `*.dll` from `site-packages/torchcodec/`, confirming `import torchcodec` fails again, and only then running the derive. That returns the box to broken for the duration, and fs-38 Wave 3 is mid-run (16/60) with Section E depending on it — so the revert is scheduled with the repo owner rather than performed opportunistically.

**On-box acceptance owed — all three surfaces, per CLAUDE.md's before-shipping step 3.** v3 named only two. The third is the **live HTML twin**, updated via the `url` recorded at `docs/testing/onbox-acceptance-register.md:28` — never republished from scratch, since that mints a second competing register (the register's own text at `:33` warns about exactly this). So: the register row, `docs/testing/fs38-wave3-onbox-acceptance.md`, and the HTML twin, all in this PR. Four items are owed, so none of it is skippable:

1. On a box whose only FFmpeg is static, `.venv\Scripts\python.exe -c "import torchcodec"` still fails **and** a Coqui cloned-voice derive completes, writing `voices/xtts/xtts-<uuid>.{pt,json}`.
2. Latent equivalence — a derive on a shared-FFmpeg box before and after the change produces audibly equivalent output, confirming the `wave` read is a true substitution.
3. The post-install verification passes on a healthy Coqui install and fails, naming the reason, against a deliberately broken one.
4. Pinokio: whether `import torchcodec` succeeds there (§11), recorded either way.

## 13. Surfaces and PR shape

Four surfaces, one PR, one task each. Every part traces to #1967, and the docs correction is meaningless without the fix — shipping the fix alone would leave documentation that contradicts it.

1. **Loader** — `xtts_audio_io.py`, the `clone_voice` wrap inside `_synth_lock`, and the poison + mechanism + fidelity tests.
2. **Install verification** — the post-install step in `install-coqui.mjs` plus its assertion.
3. **Copy** — the three `fromList` changes, the six `toEqual` updates across two files, three new message tests, and the run-sheet strings.
4. **Docs** — the live sites re-derived per §2, the evidenced claim, the diverged design of record in §3, and the three acceptance surfaces in §12.

v2 had five, including a Setup probe that round 2 showed was the largest piece, fixed no part of #1967, and carried two unmade design decisions. Relocating it into surface 2 (§8) is what makes "one cohesive change" true rather than asserted.

## 14. Revision history

**v3 → v4** (round 3 broke no mechanism and returned *converged on the design, not buildable as written*; these are its four patches plus the habit it named):

- **The stdlib rationale was false and is withdrawn.** `soundfile` is on every profile via `speechbrain` (`speaker-qa.txt`, included by all three overlays) and `qwen-tts`. Either implementation would have worked; stdlib stands on simplicity and parity with `main.py`, not availability (§6).
- **Six `toEqual` literals, across two files** — `synthesise-chapter-derive-vram-partition.test.ts:503,:832` were missed by both earlier revisions (§10). Also: the first remedy is sentence-initial, so change 1 would have emitted a lowercase sentence.
- **§7's step is now placed** — outside `coquiPipInstallSteps` (or `install-coqui-steps.test.ts:22-29`'s exact-array assertion breaks), before the 1.8 GB prefetch, failing hard.
- **The lock invariant needed a process-boundary carve-out** (§6): install-time verification is safe because it runs in a separate process, *not* because no derive can be in flight — `POST /api/coqui/install` runs against a live server.
- Poison-test import ordering (§9), `os.fspath` and the docstring/guardrail trap (§6), the thirteenth doc site and the false "exactly two hits" evidence (§2, §11), the missing third acceptance surface (§12), citation drift.
- **The habit, not just the instances:** four revisions produced four wrong exhaustiveness claims. Counts are replaced by re-derivation commands (§2, §10).

**v2 → v3** (round 2 returned *not sound enough to build from*; three of v2's four new sections carried a contradicted load-bearing claim):

- **The pin is gone.** Profile-blind in a `.mjs` array, invisible to `test_requirements.py`, risked hard-failing the AMD installer, broke four unbudgeted tests, and its Dependabot mitigation was false — the repo has no `dependabot.yml`. Replaced by install-time verification (§7). *Changes the build.*
- **The probe moved out of Setup.** It violated §6's own `_synth_lock` invariant, could not import TTS on a surface whose tests forbid exactly that, and had no defined behaviour for a `broken` verdict. Now part of §7. *Changes the build, and departs from what was approved — see §8.*
- **soundfile → stdlib `wave`.** v2's declaration plan would have made §9's mechanism tier unrunnable wherever Coqui was never installed, and taxed every install for a Coqui-only path. *Changes the build.*
- **The replacement doc sentence was itself false** — the sidecar shells out to ffmpeg nowhere. Rewritten from the grep (§11).
- **The copy fix was still incomplete** — v2 fixed pure derive-failed lists and left `[revoked, derive-failed]` printing "Re-enable Qwen". §10 now removes the fallback's ability to invent a diagnosis at all, and owes new tests, not just updates.
- **Twelve doc sites, not eleven** (`README.md:626`, `README.md:15`), with three citation errors corrected.
- **v2's `TtsDiagnosisInput` claim was wrong** — it does carry Coqui; moot now that §8 doesn't touch it.

**v1 → v2:** the `coqui-tts` pin v1 assumed did not exist; engine-tagging `derive-failed` was a no-op; the at-risk tests were `:660`/`:992`/`:1052`/`:1331`, not `:1415`; six doc sites was nine plus a miscitation; the probe was a surface, not an addition; a third guardrail (§3) was found; `_synth_lock` safety was accidental and unnamed.

## 15. Out of scope

- Making torchcodec functional (option B) — explicitly rejected, §5.
- Removing torchcodec from the Coqui install; `coqui-tts` still presence-checks it at import.
- Pinning `coqui-tts` or `torchcodec` — considered in v2, rejected in §7.
- Any Setup-wizard change; `setup-diagnosis.ts` is untouched (§8).
- Any change to Kokoro, Qwen, Whisper/ASR, or the ECAPA speaker-embed path — none reaches `torchaudio.load` (§4).
- The temp-WAV round-trip in `clone_voice`. Passing in-memory audio would mean owning XTTS's latent math instead of a ten-line leaf function.
- The contradictory install-state docstrings (§11) — filed as its own chore.
- Rewriting historical release notes and superseded design docs (§2).

## 16. Risks

| Risk | Mitigation |
|---|---|
| `coqui-tts` upgrade moves or reshapes `load_audio` | Post-install verification fails the Coqui install with the reason (§7); context manager raises rather than falling through (§6); fidelity test pins the signature where Coqui is installed (§9). Residual: a manual `pip install -U` after install surfaces only at derive time — stated in §7, not hidden. |
| Replacement loader is not bit-faithful, shifting derived latents | Same `torchaudio.functional.resample`, same 1/32768 divisor, same clip, verified against `torchaudio/_torchcodec.py:63-75`; on-box acceptance item 2 compares real output. |
| A non-PCM WAV reaches the loader | `getsampwidth() != 2` raises rather than mis-decoding (§6). |
| Patch applied outside `_synth_lock`, mutating a process global under concurrency | Stated as an explicit implementation constraint (§6), asserted by the mechanism test (§9), and the reason §8 relocated the probe. |
| Docs sweep skimped, stale premise survives | The sweep begins by **re-deriving** the site list from the command in §2 rather than trusting the table — four revisions produced four short counts. Exact replacement text in §11; its own surface (§13). |
| A new false claim replaces the old one | Every clause of §11's sentence was checked against the code, and the two that failed (soundfile; sidecar-shells-ffmpeg) are recorded in §11 rather than quietly corrected. |
| Sidecar pytest does not gate cloud CI | Pre-existing (§9); the on-box row (§12) is what actually proves the fix. |
