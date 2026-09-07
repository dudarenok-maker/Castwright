# ORT pip-consistency marker — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS each criterion is
> run on real hardware. Do not pre-fill them — criterion 3 below is filled in
> because it was genuinely run during implementation (2026-08-07); the rest are
> templates, left blank on purpose.
>
> **Revision note (2026-08-08):** the criterion↔row mapping below was corrected
> after an earlier version of this sheet mis-tracked the design doc's own
> §On-box acceptance numbering — it had dropped criteria 1 and 2 entirely and
> invented an Apple Silicon criterion the spec never names. Apple takes the same
> skip/delete branch as cpu and amd (`ortPackage` is plain `onnxruntime` for all
> three profiles), so criterion 5's AMD row already covers that mechanism; no
> separate Apple row is owed.
>
> Plan of record: [`docs/features/282-ort-pip-consistency-marker.md`](../features/282-ort-pip-consistency-marker.md)
> Design of record: [`docs/superpowers/specs/2026-08-07-qwen-ort-namespace-chokepoint-design.md`](../superpowers/specs/2026-08-07-qwen-ort-namespace-chokepoint-design.md)
> ("### On-box acceptance" section — the six numbered criteria this sheet mirrors)
> Register rows: A28 (discharged 2026-08-31, retired, not reused) and [A29–A30](onbox-acceptance-register.md#group-a--the-gpu-box),
> [E7](onbox-acceptance-register.md#group-e--not-the-gpu-box),
> [Blocked — AMD/ROCm](onbox-acceptance-register.md#blocked--hardware-not-available)
> Issue: [#2192](https://github.com/dudarenok-maker/Castwright/issues/2192)

---

## 1. Purpose & scope

Automated tests pin every helper (`isOurMarker`, `detectOrtOwner`, `ensureOrtMarker`,
the `installForProfile`/`pipInstall` ordering seams) against synthetic fixtures —
throwaway temp directories with hand-built `dist-info` shapes. What they cannot
prove is that the mechanism holds against a **real** pip venv: real PEP-427
directory-name escaping, a real `onnxruntime-gpu` wheel's
`build_and_package_info.py`, a real `pip check`, and a real server boot sequence.
That needs the box.

**Seven rows total: the design doc's own six numbered criteria, plus one addition
this sheet owes on top of the spec.** The addition (the in-app upgrade path) is
called out explicitly as *not* one of the spec's six — Task 8 wired
`upgrade/apply.ts`'s marker handling and nothing on real hardware has ever proven
it, so it is genuinely owed debt even though the design doc never named it as an
acceptance criterion.

| # | Criterion (design doc's own wording) | Register row | Status |
|---|---|---|---|
| 1 | Fresh NVIDIA bootstrap — marker present at the installed GPU version; `pip check` clean, exit 0; Kokoro reports `CUDAExecutionProvider` | A28 | **Discharged, 2026-08-31 — see §10** |
| 2 | **The reported bug** — Windows + NVIDIA, app running, in-app Qwen3 install completes with no `WinError 5`; GPU Kokoro afterwards | A29 | Owed — this is #2192 itself |
| 3 | Self-heal on an existing (pre-marker) box | — | **Discharged**, see §5 |
| 4 | Pinokio update path (`update.js`, the deployment shape that reported the bug) | E7 | Owed |
| 5 | AMD box — no marker is written; the live case is the AMD→ROCm-failure→CPU-fallback ordering | Blocked (AMD/ROCm) | Blocked — no hardware |
| 6 | Clobbered box — both dist-infos present, GPU build's files in the namespace; boot takes the loud path | *(removed)* | **Discharged, 2026-08-23 — see §8.6** |
| — | *Addition, not one of the spec's six:* the in-app upgrade path (`upgrade/apply.ts` → `pipInstall`) | A30 (renumbered from A39, fold #2625) | Owed — blocked |

## 2. Preconditions (common to all criteria)

- [ ] A Windows NVIDIA dev box with a real sidecar venv
      (`server/tts-sidecar/.venv`), `onnxruntime-gpu` installed.
- [ ] Shell access to run `python -m pip check` inside that venv
      (`server/tts-sidecar/.venv/Scripts/python.exe -m pip check`).
- [ ] For criteria 1, 2, 6 and the upgrade addition: willingness to deliberately
      rebuild/break the venv, or a disposable copy of it.
- [ ] For criterion 5: AMD/ROCm hardware — not present on the primary dev box; see
      §6.
- [ ] For criterion 4: a machine with Pinokio installed, on an existing (pre-fix)
      install so the update path actually fires.

---

## 3. Criterion 1 — fresh NVIDIA bootstrap (A28)

### 3.1 Procedure

1. Wipe (or freshly clone into) the sidecar venv and run a from-scratch
   `bootstrap-venv.mjs` on the nvidia profile — not an upgrade, not the boot-time
   self-heal, a genuine first bootstrap.
2. After it completes, inspect `site-packages` for `onnxruntime-<version>.dist-info`
   at the version `onnxruntime-gpu` actually installed.
3. Run `pip check` inside that venv.
4. **Start the sidecar and read the `[ort-preload]` lines it logs at startup
   before doing anything else** (#2600, PR #2617 — `main._preload_ort_cuda_dlls`'s
   own docstring carries the full list of the six possible lines; A28, which used
   to hold this pointer, discharged 2026-08-31 and was removed from the register).
   Note which one fired: a plain
   "loaded ... all N expected files were found under nvidia/<pkg>/bin" success,
   the WARNING variant naming fewer than the full count (PATH/torch fallback,
   not this installer's own runtime), `failed`, `torch-skip`, `no-cuda-build`,
   or `unavailable`. This is the diagnostic wave-3/wave-4 lacked — it tells you
   *which* directory actually got searched, not just whether Kokoro ends up on
   CPU.
5. Load Kokoro (via the app or a direct sidecar call) and confirm its reported
   execution provider — still required, since the `[ort-preload]` lines above
   describe what onnxruntime tried, not what the CUDA execution provider's own
   later `LoadLibrary` calls actually resolved.

### 3.2 Expected result

The marker is present, at the correct version, as a direct product of
`installForProfile`'s own `applyOrtMarkerWrite` call — not the boot-time self-heal,
which never needs to fire on a venv that was correct from the first pip call.
`pip check` exits 0. The `[ort-preload]` startup log names all expected files
found under `nvidia/<pkg>/bin`. Kokoro reports `CUDAExecutionProvider`.

### 3.3 Result

**Marker present + version:** `onnxruntime-1.27.0.dist-info` present in
site-packages, INSTALLER=`castwright-ort-marker`, RECORD 0 bytes — matches
the version `onnxruntime-gpu` actually installed (1.27.0).
**`pip check` exit code:** 0 (`No broken requirements found.`).
**Kokoro execution provider:** `CPUExecutionProvider` only — **not**
`CUDAExecutionProvider`, so this part of the criterion is **NOT met**. See
the wave-3 step-2 results file for the root cause: `onnxruntime-gpu` 1.27.0
requires CUDA 13 / cuDNN 9 runtime DLLs (`cublasLt64_13.dll` etc.) that are
not present anywhere on this box — the system CUDA toolkit is v12.4 only,
and no pip-vendored CUDA 13 runtime packages are in requirements. Reproduced
identically against the **live** sidecar venv (read-only, not modified) —
this is an environment-wide defect, not specific to the throwaway venv.

> **Superseded note (2026-08-21):** this run predates PR #2576, which resolved the blocking box-level CUDA 12.4 vs. CUDA 13.x/cuDNN 9.x gap by re-pinning `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27`. The criterion outcome recorded above is from 2026-08-20, before that resolution. The shared GPU-provider re-check was re-run against the fixed pin (wave-4 step 8, 2026-08-21) and still fails, but on a new, distinct root cause — the missing `nvidia-cudnn-cu12` dependency (distinct from #2534). See disposition summary (§10) and onbox-acceptance-register.md for full details.

**Disposition (as of 2026-08-20):** STILL OWED — marker/pip-check mechanics pass, GPU provider
check fails on a real dependency gap.
**Run by:** claude (Castwright#2506, wave 3 step 2, fast-path claim).
**Date:** 2026-08-20.

> **DISCHARGED 2026-08-31.** `install-ort.mjs`'s `extraRuntimeSteps` gained
> `nvidia-cufft-cu12`/`nvidia-cuda-runtime-cu12` (missing since the gaps found
> above and in the 2026-08-23 re-run below) and `NVIDIA_CUDNN_CONSTRAINT`
> was tightened to `~=9.19.0` to match torch's bundled cuDNN line. A real
> Kokoro CUDA load now succeeds end-to-end: `Device probe complete:
> {'kokoro': 'cuda', 'coqui': 'cuda', 'qwen': 'cuda'}`, a real
> `POST /synthesize` returns real GPU-speed PCM, `/health` reports
> `cuda_verified: true`. Full account in `onbox-acceptance-register.md`'s
> row A28 (now discharged/retired) and its changelog. Run by: claude,
> dudarenok-maker.

> **2026-08-23 re-run (Castwright#2621) — STILL OWED, root cause now identified
> and it is NOT `install-ort.mjs`.** Marker mechanics and `pip check` still
> discharge cleanly. Confirmed the "N of M expected files found under nvidia/"
> warning is real on this box (round 1, fix as shipped: `cufft64_11.dll` and
> `cudart64_12.dll` failed to load from anywhere). Installing the `[cuda]`
> extras (round 2) fixes `preload_dlls()` completely — all 11 expected files
> resolve under `nvidia/<pkg>/bin` — but Kokoro still silently falls back to
> CPU even with a clean preload. Root cause isolated to `kokoro-onnx==0.5.0`'s
> own `Kokoro.__init__` auto-detect: `importlib.util.find_spec("onnxruntime-gpu")`
> is always `None` (the pip distribution installs into the `onnxruntime`
> import namespace, not a separately-importable module), so it always
> constructs with `providers=["CPUExecutionProvider"]` explicitly — CUDA is
> never offered to onnxruntime. A raw `InferenceSession` with CUDA providers
> genuinely works on this box once `preload_dlls()` has run, confirming the
> gap is entirely inside `kokoro-onnx`, not the sidecar's own DLL/dependency
> wiring. Third distinct root cause, after #2534 and #2600. Not fixed here per
> the fold brief's scope. Evidence:
> `docs/testing/onbox-wave5-results/step-ort-a-a37-a38.md`. Run by: claude
> (Castwright#2621).
>
> **FIXED in code, 2026-08-23 (#2631) — this criterion is now re-runnable and
> is the thing to re-check first.** The sidecar no longer lets kokoro-onnx
> choose providers at all: it builds the ORT InferenceSession itself and hands
> it to Kokoro.from_session(). The server (spawn-sidecar.ts) already injects
> KOKORO_ORT_PROVIDERS for every accelerator profile, nvidia included, so on
> a server-spawned sidecar that injected CUDA+CPU list is what reaches the
> session — this is the path that was previously falling to CPU.
> Resolving providers from ORT's own reported state only fires when
> KOKORO_ORT_PROVIDERS is unset, which is the sidecar-launched-standalone
> case (start.ps1/start.sh set nothing), not the NVIDIA default.
>
> Unit tests pin the wiring, but **whether CUDA is genuinely used cannot be
> proven off-box**: get_available_providers() reports CUDA whether or not any
> session uses it, which is exactly what hid this. Criteria 1 and 2 still need
> a real load here — row A28 is discharged (2026-08-31); row A29 is discharged
> (2026-09-07, retired, not reused) —
> read the provider off a live Kokoro, not off the available-providers list.
>
> **A CPU session here is not automatically this criterion failing (#2631
> review N6).** This box's VRAM ledger (`admit()`, `main.py`) is a genuine
> `cpu` decision, not just a fallback bug: when no GPU candidate has headroom
> for Kokoro's footprint, `admit()` returns `{"device": "cpu"}` **by design**,
> and `_ensure_loaded` correctly honours it — that's the **B1** fix this run
> also covers (#2631 review S6, corrected: S4 is the unload-restore fix, not
> the CPU-placement-honouring one), working as intended, not a fourth root
> cause. This sheet is
> routinely read with GPU time booked (i.e. the card may be busy with another
> load, an analyzer, or a concurrent generation at the moment this criterion
> is run), so a CPU session is an expected outcome under contention, not
> automatically a repeat of #2534/#2600/#2621's bug. Tell the two apart
> before filing a fourth root cause:
> - **Check the card's free VRAM at the moment of the load** (`nvidia-smi` /
>   the sidecar's own `/capacity` payload, or `/health`'s `gpus[]` — **not**
>   `/gpus`, which does not exist as its own route: `gpus` is a field inside
>   `/health`, not a separate endpoint) (#2631 review S6, corrects this bullet's
>   endpoint name). If another resident model (analyzer, Coqui, Qwen) left too
>   little headroom for Kokoro's footprint, `cpu` is the correct, by-design
>   outcome — re-run this criterion with the card idle.
> - **Check `/health`'s ground truth for the loaded session, not the log**
>   (#2631 review S6, replacing this bullet — the prior version pointed at two
>   signals that are structurally silent on an nvidia box: `_directml_selftest_
>   or_fallback`'s WARNING only fires `if "DmlExecutionProvider" in providers`,
>   which A28/A29 (nvidia) never build, and the kokoro-onnx-auto-detect
>   remediation path only fires on an `ImportError`, which a loaded-but-CPU
>   Kokoro by definition didn't hit — so their absence proves nothing here, and
>   reading it as "by-design" is backwards in exactly the case this row exists
>   to catch: #2534, #2600 and #2621 were all silent). Read `/health`'s
>   `devices.kokoro` — it reports the real ONNX Runtime session providers
>   (`cuda`/`cpu`), not the env pin, so it can't be fooled by a `_device` that
>   still says `cuda`. Since #2631's B3 fix, also check `gpus[].resident[]`
>   for the Kokoro entry's `stale_reason: 'cpu_fallback'` (#2647: the badge
>   compares THIS LOAD's own intent, not the pristine `KOKORO_DEVICE` env
>   pin) — a VRAM-ledger admission onto `cpu` under contention (bullet 1's
>   by-design case) publishes `cpu` as that load's own `_device` before the
>   load runs, so `stale_reason` correctly stays ABSENT for it: that session
>   asked for cpu and got cpu, which is compliance, not a fallback. The badge
>   fires only when this load's own intent was `cuda` — an env pin, or an
>   admitted `cuda:N` placement — and the session silently landed on `cpu`
>   anyway, so its presence DOES distinguish the two: seeing it here is
>   itself the genuine-bug signal (#2534/#2600/#2621's shape), and bullets 1
>   and 3 remain how you tell a by-design contention CPU session (no badge)
>   from that fourth root cause (badge present).
> - **Re-run with the card verifiably idle** (no other resident engine, no
>   concurrent generation). If Kokoro still lands on CPU with KOKORO_DEVICE
>   unset/cuda and a free card, that is the real criterion failure this row
>   exists to catch — only then is it a fourth root cause.

---

## 4. Criterion 2 — the reported bug: in-app Qwen3 install (A29)

This is **#2192 itself** — the alpha tester's exact scenario, with the app running.
Every other row in this sheet is a mechanism check; this one is the actual
acceptance criterion the issue was filed against.

### 4.1 Procedure

1. Start the app normally (`npm start`), NVIDIA profile, a bootstrapped sidecar
   venv (marker present or absent — either starting state is fine, since boot's
   `ensureOrtMarker` should have already handled it either way).
2. From the app UI, install Qwen3 (Model Manager → the Qwen engine's Install
   action) — the exact step #2192's report describes failing.
3. Watch for the install completing without error, specifically **no**
   `WinError 5` / `Accès refusé` on any `.dll` under
   `site-packages/onnxruntime/capi/`.
4. After install, load Kokoro and confirm it still reports `CUDAExecutionProvider`
   — the install must not have silently swapped the GPU runtime for CPU en route.

### 4.2 Expected result

The install completes cleanly. No `WinError 5`. GPU Kokoro unaffected afterward.

### 4.3 Result

**Qwen3 install outcome:** PASS — clicked Install on Qwen3-TTS Base (0.6B) in
Model Manager, against a freshly bootstrapped worktree venv (nvidia
profile); job resolved `"status":"installed","step":"Already installed."`
with no error, no exception, no partial state.
**`WinError 5` present/absent:** ABSENT — no `WinError 5` / `Accès refusé`
on any `.dll` under `site-packages/onnxruntime/capi/`.
**Kokoro execution provider after install:** NOT VALIDATED — UNREACHABLE,
not FAIL. This box's TTS sidecar binds a single hardcoded `:9000` port
shared across every worktree; another live agent lane already held it for
the whole session, so `POST /api/sidecar/restart` (which the install flow's
`onInstalled` callback calls to pick up the freshly-installed package)
returned 409 Conflict. Without a restart, nothing in this worktree's own
venv was ever loaded into a running sidecar this session, so a
GPU-provider check would have measured the other lane's venv, not this
one — worthless evidence. A structural box-contention limitation, distinct
from the already-filed #2534 CUDA13/cuDNN9 gap.
**Run by:** claude (wave-4 step 5c, Castwright#2561). **Date:** 2026-08-21.
**Disposition:** Register row **A29 is discharged** (2026-09-07, retired, not
reused; renumbered from A39 this wave) — at this point in the chain it stayed
STILL OWED, partially run. Full evidence:
`docs/testing/onbox-wave4-results/step-5c-a40.md`.

> **2026-08-23 (Castwright#2621) — STILL OWED, blocked by box-wide sidecar
> port contention again.** Started this worktree's own app; the server found
> another process already listening on the hardcoded `:9000` sidecar port and
> adopted it instead of spawning its own, so `SIDECAR_VENV_DIR` never took
> effect. That pre-existing sidecar (PID 7380, actively `ESTABLISHED` with a
> live client) was identified before assuming it was safe to use; per the
> standing rule against disrupting another agent's live process, Install was
> **not** clicked against it — only a read-only `GET /health` was run
> (all three engines reported `cuda`, noted only as context). Neither the
> Qwen3 install click-through nor the Kokoro-afterward check could be safely
> run this session — not attempted, not failed — a third piece of evidence for
> the same structural port-contention class as wave-4 step-5c. Worth filing
> separately: `spawn-sidecar.ts`/`sidecar-owner.ts`'s hardcoded `9000` vs.
> `LOCAL_TTS_PORT`'s per-worktree value. Evidence:
> `docs/testing/onbox-wave5-results/step-ort-a-a37-a38.md`. Run by: claude
> (Castwright#2621).

> **2026-09-06 (chain #2913 retry, Castwright#2916/#2914/#3015) — one datum
> retired, Qwen3 install click-through still not run.** #2632's per-worktree
> `LOCAL_TTS_PORT` fix genuinely closes the box-wide port-contention class
> that made wave-4 step 5c's and wave-5's Kokoro-provider checks
> UNREACHABLE above: this worktree's sidecar bound its own assigned `:9080`,
> a real in-app Kokoro install + load ran against it, and `GET /health`'s
> `devices.kokoro` (read from the live ONNX session's own providers, not
> `get_available_providers()`) reported `"cuda"` — proof the isolated venv's
> GPU runtime works end to end once a worktree can actually reach its own
> sidecar. That retires the port-contention *reason* stated in §4.3 above,
> but does not discharge this row: Qwen3-TTS was already installed from this
> worktree's own bootstrap, so the Install action never rendered and no
> fresh `pip install` ran — criterion 2 (a real Install click, watched for
> `WinError 5`) remains genuinely untested. Full evidence:
> `docs/testing/onbox-a29-results/step-1-retry.md`. Redo filed separately,
> chain Castwright#2913 → #3020 → #3019. Run by: claude
> (Castwright#2916/#2914).

---

## 5. Criterion 3 — self-heal on an existing box (DISCHARGED)

### 5.1 Procedure

1. Start from a sidecar venv bootstrapped **before** this change — `onnxruntime-gpu`
   installed, no `onnxruntime-<version>.dist-info` marker present.
2. Run `python -m pip check` and confirm it reports the three broken requirements
   (`faster-whisper`, `kokoro-onnx`, `qwen-tts` all "requires onnxruntime, which is
   not installed").
3. Start the server (`npm run dev` or `npm start`) and watch the log for the
   `[ort-marker]` line **before** `[server] listening`.
4. Re-run `pip check` and confirm it now exits 0.
5. Inspect the marker directory on disk: `INSTALLER` file content, `RECORD` file
   size.

### 5.2 Expected result

`pip check` fails before boot, a single `[ort-marker] recorded …` log line appears
during boot (before the server is ready to serve requests), and `pip check`
succeeds after — with no reinstall, no network call, no interruption to any other
boot step.

### 5.3 Result

**Box:** the repo owner's Windows dev box, NVIDIA profile, sidecar venv at
`server/tts-sidecar/.venv`, `onnxruntime-gpu 1.27.0` installed.

**BEFORE** — `python -m pip check` exit 1:

```
faster-whisper 1.2.1 requires onnxruntime, which is not installed.
kokoro-onnx 0.5.0 requires onnxruntime, which is not installed.
qwen-tts 0.1.1 requires onnxruntime, which is not installed.
```

**BOOT** — server started, logged, **before** `[server] listening`:

```
2026-08-07 18:41:23.909 [ort-marker] recorded onnxruntime 1.27.0 as provided by onnxruntime-gpu.
```

**AFTER** — `python -m pip check` exit 0: `No broken requirements found.`

**Marker on disk:** `onnxruntime-1.27.0.dist-info/` with `INSTALLER` =
`castwright-ort-marker` and `RECORD` = **0 bytes**.

**Run by:** the repo owner's session (controller-executed, not a subagent).
**Date:** 2026-08-07.

**Disposition:** DISCHARGED. Not filed as a register row. See
`docs/features/282-ort-pip-consistency-marker.md`'s Ship notes once the plan ships.

---

## 6. Criterion 4 — Pinokio update path (E7)

The design doc names `update.js` specifically — "the deployment shape that
reported the bug" — not `install.js`. A fresh install and an update load
different code (`update.js` iterates the **currently checked-out** release's
`run[]`, per the Pinokio installer's own documented one-update-lag behaviour), so
a fresh-install pass does not stand in for this one. `install.js` is worth
exercising in the **same session**, as a second shape, but is not a separate row.

### 6.1 Procedure

1. On a machine with Pinokio and an **existing** (pre-fix) Castwright install, run
   Update — this is `pinokio-scripts/update.js`, invoking `bootstrap-venv.mjs`
   directly with no server process involved.
2. Immediately after Update completes (before ever starting the server), run
   `pip check` inside the resulting venv.
3. Start the app and, from the UI, install Qwen3 — the original #2192 repro.
4. **In the same session, also exercise `install.js`** (a fresh install on a clean
   machine or a wiped Pinokio env) and confirm the same result — this is a second
   shape of the same criterion, not a separate row.

### 6.2 Expected result

**This expectation is conditional on the requirements hash actually changing.**
`bootstrap-venv.mjs`'s `classifyVenvState` (lines ~257-260) returns `noop` when
the stamped `reqHash` already matches what this release requires — `main()`
returns immediately in that case and never calls `runInstall`/`installForProfile`
at all, so **no marker is written by Update**. This branch is the one this PR's
own diff lands into (it changes no `requirements/*.txt`), so *by design* an
Update run against this PR's release will see `pip check` still reflecting
whatever state the venv was already in, and the marker (if owed) arrives at the
next server boot via `ensureOrtMarker` instead — that is the expected, correct
outcome, not a failure of this criterion.

So the procedure has two distinct expected results depending on which branch
Update takes:

- **`reqHash` unchanged (`noop`, the shape this PR itself exercises):** `pip
  check` after Update is unchanged from before Update (Update did nothing). The
  marker legitimately arrives at first server boot afterward — confirm the
  `[ort-marker] recorded …` log line appears there instead, then `pip check`
  clean post-boot. This is NOT a failure — it is criterion 3's self-heal path
  reached via the Update entry point rather than Update's own marker write.
- **`reqHash` changed (`pip-in-place`, e.g. a future release that touches
  `requirements/*.txt`):** `pip check` is clean immediately after Update, with
  no server ever having run — proving `bootstrap-venv.mjs`'s own marker
  application (not the server-boot self-heal) is what did it.

Either way, installing Qwen3 afterward completes with no `WinError 5`. The
`install.js` pass (§6.1 step 4) always takes the `pip-in-place`-shaped fresh-
install path (there is no prior stamp to be a `noop` against), so it always
shows the second (immediate, no-boot-needed) outcome.

### 6.3 Result

**`reqHash` branch taken (`noop` or `pip-in-place`):** _(fill in)_
**`pip check` immediately post-Update:** _(fill in — if `noop`, record "unchanged,
by design" rather than treating a still-broken `pip check` as a failure)_
**If `noop`: marker + clean `pip check` observed at next server boot instead:**
_(fill in)_
**Qwen3 install result (WinError 5 present/absent):** _(fill in)_
**`install.js` pass (fresh install) outcome:** _(fill in)_
**Run by:** _(fill in)_ **Date:** _(fill in)_ **Platform:** _(fill in)_

---

## 7. Criterion 5 — AMD box (Blocked, not owed)

No AMD/ROCm hardware exists on this box — see the register's Blocked section.
`planOrtSwap('amd', …).marker.action === 'delete'` is unit-tested; the AMD-specific
ordering (delete-at-entry protecting the ROCm-failure→CPU fallback's own
`onnxruntime` install) has never run against real hardware. This section stays
templated so a future AMD box has a ready-to-run recipe rather than needing one
authored from scratch.

### 7.1 Procedure (for when AMD/ROCm hardware exists)

1. Force the AMD→ROCm-failure→CPU fallback inside `installForProfile` (e.g. by
   pointing the ROCm wheel index at an unreachable URL).
2. Confirm the marker is deleted **before** the fallback's `pip install -r
   <cpu overlay>` runs — inspect for the marker's absence, or a log/timestamp
   ordering check.
3. Confirm the fallback's explicit `onnxruntime` line from `cpu.txt` actually
   installs (not silently skipped because a stale marker made pip think it was
   already satisfied).
4. Confirm no marker is ever written on this profile — the design doc's own
   framing for this criterion.

### 7.2 Result

_(N/A — no AMD/ROCm hardware. Filed as a Blocked entry, not an owed row.)_

---

## 8. Criterion 6 — clobbered box (formerly A38, DISCHARGED and removed 2026-08-23 — see §8.6)

### 8.1 Procedure

1. On a disposable copy of the sidecar venv or a throwaway venv (with intent to run
   the repair command afterward — this is destructive), with the sidecar stopped,
   manufacture the clobbered state by installing **plain** `onnxruntime` first and
   then force-reinstalling `onnxruntime-gpu` **over** it. Pip keys upgrade-detection
   on the package name, so installing a different distribution that shares the
   `onnxruntime/` namespace does not replace the first, and the plain package's
   dist-info survives on disk:
   ```powershell
   python -m venv <venv>
   <venv>\Scripts\pip install onnxruntime==1.28.0
   <venv>\Scripts\pip install --force-reinstall --no-deps onnxruntime-gpu==1.27.0
   ```
   (Versions pinned for reproducibility — plain at 1.28.0, GPU at 1.27.0, so the
   two dist-info folder names are distinguishable by directory listing alone,
   matching the unit test fixture; verified to reach `'clobbered'` in §8.5.)
2. Confirm both `onnxruntime_gpu-1.27.0.dist-info` and a **real**
   `onnxruntime-1.28.0.dist-info` (INSTALLER `pip`, non-empty RECORD) coexist with
   **different version numbers** (this is the discriminating check — a marker and the real plain
   dist-info could be named `onnxruntime-1.27.0.dist-info` and would collide, making name-based
   detection useless), and
   that `site-packages/onnxruntime/` holds the GPU build's files
   (`capi/build_and_package_info.py` reports `package_name = 'onnxruntime-gpu'`).
3. Boot the server and watch the log.
4. Run the named remedy command:
   - PowerShell: `$env:CASTWRIGHT_ACCELERATOR_PROFILE='nvidia'; node server/tts-sidecar/scripts/install-ort.mjs <venv-python>`
   - POSIX: `CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node server/tts-sidecar/scripts/install-ort.mjs <venv-python>`
5. Re-check `pip check` and Kokoro's reported execution provider.

### 8.2 Expected result

`ensureOrtMarker` returns `'clobbered'`, logs the condition and the exact remedy
command, and writes **no** marker over the real distribution. `pip check` stays
clean throughout regardless of the two packages' versions (nothing else in a
throwaway venv depends on `onnxruntime`, so there's nothing broken for boot to
silently "fix" either way) — the discriminating checks are (a) the `'clobbered'`
return value and the `[ort-marker]`
log line naming the condition and remedy command, and (b) that no NEW marker folder
is written over the real plain distribution (confirm by directory listing — only
the real plain dist-info at its own distinct version, plus the GPU swap dist-info,
both present). Running the remedy command repairs the box: uninstalls both,
reinstalls `onnxruntime-gpu` clean, writes a legitimate marker afterward,
`pip check` clean, and Kokoro reports `CUDAExecutionProvider` — this last
check is the row's own remaining owed criterion (§8.1 step 5).

### 8.3 Result

**Log line observed (clobbered):** **NONE.** `ensureOrtMarker` did **not**
return `'clobbered'` for this manufactured state — it returned `'deleted'`
silently (no log call on that branch) and removed the stale
`castwright-ort-marker` dist-info with zero operator-visible warning. Full
mechanism trace and why in the wave-3 step-2 results file — this is a real
defect, reproducible from the row's own documented manufacture recipe.
**`pip check` after boot (should still be broken):** it was NOT broken —
`pip check` was already clean before boot (the force-reinstall step
installed a complete, self-consistent plain `onnxruntime` 1.29.0), so there
was nothing for boot to silently "fix"; the marker deletion is the only
observable boot-time effect, and it happened without any log line.
**Repair command output:** `CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node server/tts-sidecar/scripts/install-ort.mjs <venv-python>` uninstalled `onnxruntime` 1.29.0
and `onnxruntime-gpu` 1.27.0, reinstalled `onnxruntime-gpu==1.27.0`
(`--no-deps`), and wrote `onnxruntime-1.27.0.dist-info` (marker) —
`[install-ort] onnxruntime-gpu in place.`
**`pip check` after repair:** one pre-existing, unrelated warning
(`numba 0.66.0 has requirement numpy<2.5,>=1.22, but you have numpy 2.5.2`)
— introduced by this test's own earlier `pip install --force-reinstall
onnxruntime` step pulling a newer numpy; not a repair defect.
**Kokoro execution provider after repair:** not re-tested — blocked by the
same CUDA 12.4 vs. CUDA 13.x/cuDNN 9.x gap documented for A28; would report `CPUExecutionProvider`
on this box regardless of marker/dist-info correctness.

> **Superseded note (2026-08-21):** this run predates PR #2576, which resolved the blocking box-level CUDA/cuDNN gap by re-pinning `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27`. The outcome recorded above is from a run before that fix. The row is still OWED for re-check of the repair command.
**Disposition:** STILL OWED — the manufactured "clobbered" state (exactly as
the row's own recipe describes) does not exercise the `'clobbered'` refuse-
and-log branch at all; it exercises `'deleted'` instead, silently. The
repair command itself works correctly when run directly.
**Run by:** claude (Castwright#2506, wave 3 step 2, fast-path claim).
**Date:** 2026-08-20.
**Venv:** a throwaway copy of the live sidecar venv at
`server/tts-sidecar/.venv`, robocopied to a scratch path, deleted after the
run. Live venv confirmed byte-unchanged before and after (see step-2 results
file).

> **Manufacture recipe corrected, 2026-08-21 — as part of #2545 (task to address #2535, the defect). Verified in §8.5.** The §8.1
> procedure above was replaced (plain-then-GPU) after the original GPU-then-plain
> recipe was shown to reach `'deleted'`, not `'clobbered'`, in this 2026-08-20 run.
> The corrected recipe was verified against the real `detectOrtOwner`/
> `findPlainOrtDistInfos` (`server/tts-sidecar/scripts/install-ort.mjs`) on a
> throwaway venv: `detectOrtOwner === 'swap'`, one real plain dist-info present, and
> `ensureOrtMarker` returns `'clobbered'` (see §8.5 for the complete verification).

### 8.4 Wave-4 re-run, 2026-08-21 (Castwright#2569)

Ran the **INCORRECT recipe version** (1.27.0 plain and 1.27.0 GPU — same versions) on a **fresh** throwaway venv (`python -m
venv`, not a copy of the sidecar's own) against branch
`fix/sidecar-2535-ort-marker-fix`, at committed HEAD `fe77babd` but with a
**local, uncommitted edit to `install-ort.mjs`** containing the corrected
clobbered-state message (later committed as `bd09fcfa`), fixing the silent-defect
#2535. The recorded log message matches the 452-character wording from that
uncommitted edit (later bd09fcfa's wording), not the 262-character wording from
the prior merge commit 51420399. **CRITICAL NOTE:** This run therefore did NOT
fully verify the fix against the intended manufactured state where the two
packages have different versions. The corrected recipe verification with
1.28.0 plain and 1.27.0 GPU is in §8.5.

**Manufactured state confirmed:** `detectOrtOwner === 'swap'`,
`findPlainOrtDistInfos.length === 1`, both `onnxruntime-1.27.0.dist-info` and
`onnxruntime_gpu-1.27.0.dist-info` present.

**Log line observed (clobbered):** fired correctly — `[ort-marker] A stray
real plain onnxruntime dist-info coexists with the GPU build's files (which own
the namespace). This corrupts pip's dependency resolution — a landmine for the
next pip operation. GPU Kokoro is currently working, but the inconsistency must
be repaired. Refusing to write a marker that would certify this bad state.
Repair with: CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node
server/tts-sidecar/scripts/install-ort.mjs <venv-python>` *[log wording superseded by commit c556f51c; the phrase "GPU Kokoro is currently working" was later removed and replaced with "The GPU build's files currently own the namespace" — see server/src/tts/ort-ensure-marker.test.ts:102-105 for the correction]* — naming the exact
remedy command, at server boot (`tsx watch`, `SIDECAR_VENV_DIR` pointed at the
throwaway venv, isolated port 8290). No marker written over the real
distribution; `pip check` stayed clean (pinned versions matched here, unlike
wave-3's mismatched 1.29.0 run, so there was nothing broken for boot to
silently "fix" either way).

**Repair command output:** `CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node server/tts-sidecar/scripts/install-ort.mjs <venv-python>` uninstalled both
`onnxruntime` 1.27.0 and `onnxruntime-gpu` 1.27.0, reinstalled
`onnxruntime-gpu==1.27.0` (`--no-deps`) — `[install-ort] onnxruntime-gpu in
place.`

> *Superseded note (2026-08-22):* The POSIX form shown above reflects the state on 2026-08-21 when this run was executed. Shipped code now also emits a PowerShell form of the repair command as an alternative on Windows shells, added in a later round.

**`pip check` after repair:** clean, no broken requirements.
**Post-repair owner check:** `detectOrtOwner === 'swap'`,
`findPlainOrtDistInfos.length === 0` — the marker now correctly reflects the
GPU build owning the namespace with no real plain distribution left behind.
**Kokoro execution provider after repair:** not independently re-tested;
`get_available_providers()` still lists `CUDAExecutionProvider` but
constructing a real inference session was not attempted — same box-level
CUDA 12.4 vs. CUDA 13.x/cuDNN 9.x gap (`#2534`) already blocking this check
on A28/A29, not a new gap.

**Disposition:** the defect #2535 was filed against — the silent `'deleted'`
path — is fixed and verified: the loud `'clobbered'` path now fires exactly
where wave-3 found it silent, and the remedy command repairs the box
correctly. The row stays **STILL OWED** only because its own criteria include
the CUDA-provider re-check, blocked by the pre-existing `#2534` gap (same
precedent as A28).

*Dated run record (2026-08-21). The `#2534` blocker cited here has been resolved by PR #2576 (which re-pinned `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27`); the shared GPU-provider re-check was re-run (wave-4 step 8, 2026-08-21) and still fails, but on a new, distinct root cause — the missing `nvidia-cudnn-cu12` dependency. See disposition summary (§10) and the A28/A29 rows in onbox-acceptance-register.md for details.*

**Run by:** claude (Castwright#2569).
**Date:** 2026-08-21.
**Venv:** a fresh throwaway venv under a scratch temp path, deleted after the
run. The live sidecar venv at `server/tts-sidecar/.venv` (main repo checkout,
not this worktree — this worktree has no `.venv` of its own) was never
touched; confirmed by its `python.exe` mtime being unchanged (2026-07-03,
predating this session) both before and after.
Evidence: `docs/testing/onbox-wave4-results/step-1-a41-rerun.md`.

### 8.5 Verification of corrected recipe (2026-08-21, PR #2578 review correction)

**CRITICAL NOTE:** §8.4 above was run with the INCORRECT recipe version
(1.27.0/1.27.0) — both packages at the same version, a separate defect from
the ordering issue wave-3 step 2 exposed. This section
re-verifies the corrected recipe (1.28.0 plain, 1.27.0 GPU) to confirm the fix
actually works against the intended manufactured state, where `detectOrtOwner
=== 'swap'`, `findPlainOrtDistInfos.length === 1`, and the two versions are
discriminable by directory listing alone (the critical property that allows a
wrongly-written marker to be detected).

**Corrected recipe verification:**

Fresh throwaway venv with the CORRECT recipe:

```powershell
python -m venv <venv>
<venv>\Scripts\pip install onnxruntime==1.28.0
<venv>\Scripts\pip install --force-reinstall --no-deps onnxruntime-gpu==1.27.0
```

**Pre-repair manufactured state:**

- `detectOrtOwner(sitePackages)` → `'swap'` (GPU build's files own the namespace)
- `findPlainOrtDistInfos(sitePackages).length` → `1` (one real plain dist-info)
- Directory listing: `onnxruntime-1.28.0.dist-info` (real plain, named by version)
  and `onnxruntime_gpu-1.27.0.dist-info` (GPU build) coexist with DIFFERENT version
  numbers — crucially different from §8.4's run which showed both at 1.27.0.
- `pip check` clean (nothing else in this throwaway venv depends on
  `onnxruntime`, so there's nothing for either package's version to violate —
  not because the two versions match; §8.1's recipe deliberately pins them
  differently)

**ensureOrtMarker behavior:**

`ensureOrtMarker(venvDir, console.log)` returns `'clobbered'` and logs:

```
[ort-marker] A stray real plain onnxruntime dist-info coexists with the GPU build's files. This corrupts pip's dependency resolution — a landmine for the next pip operation. The GPU build's files currently own the namespace, but the inconsistency must be repaired. Refusing to write a marker that would certify this bad state. Repair with:
  (PowerShell) $env:CASTWRIGHT_ACCELERATOR_PROFILE='<profile>'; node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
  (POSIX) CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
```

No marker written over the real distribution (directory listing unchanged after
the check).

**Repair command output:**

```
[install-ort] pip uninstall -y onnxruntime onnxruntime-gpu
Found existing installation: onnxruntime 1.28.0
Uninstalling onnxruntime-1.28.0: Successfully uninstalled onnxruntime-1.28.0
Found existing installation: onnxruntime-gpu 1.27.0
Uninstalling onnxruntime-gpu-1.27.0: Successfully uninstalled onnxruntime-gpu-1.27.0
[install-ort] pip install --force-reinstall --no-deps onnxruntime-gpu>=1.27,<1.28
Successfully installed onnxruntime-gpu-1.27.0
[install-ort] onnxruntime-gpu in place.
```

> *Superseded note (2026-08-21):* The constraint `>=1.27,<1.28` shown above predates PR #2576, which re-pinned `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27` in `server/tts-sidecar/scripts/install-ort.mjs:223`. The output above reflects the state before that fix; the repair command would use the updated constraint on the current branch.

**Post-repair state:**

- `detectOrtOwner(sitePackages)` → `'swap'` (still GPU build's files)
- `findPlainOrtDistInfos(sitePackages).length` → `0` (stale real plain dist-info
  removed, only marker remains)
- Directory listing: `onnxruntime-1.27.0.dist-info` (marker written) and
  `onnxruntime_gpu-1.27.0.dist-info` (GPU build)
- `pip check` clean

**Disposition:** ✓ PASS. The fix (finding-4, commit `3a8b5009`) is verified
against the correct manufactured state where the two packages have different
versions. The `'clobbered'` return value fires exactly as intended, the remedy
command repairs the box correctly, and the marker is written only after the
swap succeeds. This is the verification §8.4 CLAIMED to do but actually
performed against the wrong recipe (1.27.0/1.27.0).

**Run by:** claude (Castwright#2578, wave 5, round-2 review correction).
**Date:** 2026-08-21.
**Venv:** fresh throwaway venv under a scratch temp path (not the sidecar's
own — `server/tts-sidecar/.venv` was never touched).
Evidence: hand-execution against `server/tts-sidecar/scripts/install-ort.mjs`
functions, against a throwaway venv under the reviewing machine's temp
directory. Kept resident through the PR's review rounds so later passes could
re-run the same functions against it read-only; not deleted as of this
writing — delete once the PR merges and no further review round needs it.

### 8.6 Final discharge (2026-08-23, Castwright#2620, fold #2625)

**VERDICT: DISCHARGED.** Re-ran against a **full copy of the real, currently
in-service sidecar venv** (`server/tts-sidecar/.venv`, 6.2 GB, 56,542 files) —
a more realistic target than a throwaway venv, since that is the box
`ensureOrtMarker` actually runs against at boot. The live venv was never
touched: copied, the copy was clobbered and destroyed, and the original was
byte-verified unchanged before and after (venv `python.exe` SHA-256, the
`onnxruntime*` dist-info set, the marker's `INSTALLER` content, a SHA-256 of
`onnxruntime/capi/build_and_package_info.py`, total file count, and total byte
size — every field identical before/after).

Manufactured the clobbered state on the copy (plain `onnxruntime==1.28.0` then
`--force-reinstall --no-deps onnxruntime-gpu==1.27.0`); confirmed
`detectOrtOwner === 'swap'`, `findPlainOrtDistInfos.length === 1`. Took a
directory listing and a SHA-256 of the real plain dist-info's `METADATA`
immediately before and immediately after calling `ensureOrtMarker` —
`ensureOrtMarker` returned `'clobbered'`, logged the condition and the exact
remedy command, and **provably touched nothing on disk** (identical directory
listing and identical file hash before/after). The named remedy command was
separately confirmed to still work: uninstalls both packages, reinstalls
`onnxruntime-gpu` clean, writes a legitimate marker, `pip check` clean.

This row's own criteria (design doc §On-box acceptance item 6, the eight-state
table) are about `ensureOrtMarker`'s refuse behaviour, not GPU execution — no
`InferenceSession` construction was needed and none was attempted; the row is
tagged "no GPU needed, sidecar venv only." With the refuse-vs-repair
distinction now proven against a real, previously-clean production-shaped
venv and a manufactured silent-repair check finding no repair, this row is
fully discharged and **removed from `onbox-acceptance-register.md`** (Group A
renumbered contiguously: old A39–A44 → A38–A43 at the time) and from the live
view, per the fold instructions. (Group A has since renumbered again — see
this register's own current changelog for the live mapping.)

**Run by:** claude (Castwright#2620). **Date:** 2026-08-23.
Evidence: `docs/testing/onbox-wave5-results/step-ort-b-a39.md`.

---

## 9. Addition — the in-app upgrade path (A30, renumbered from A39, not one of the spec's six)

**This criterion is not in the design doc's §On-box acceptance table.** It is
owed anyway: Task 8 wired `upgrade/apply.ts`'s marker handling (with a new
dependency-injection seam specifically because `pipInstall`'s real body had zero
prior test coverage), and nothing on real hardware has ever driven it — a
different consumer of `planOrtSwap`'s output than `bootstrap-venv.mjs`, so
criterion 1 passing proves nothing about this path.

### 9.1 Procedure

1. Take a real installed Castwright release (packaged `release/` layout, not the
   dev checkout), on NVIDIA, with a marker already present.
2. Trigger the in-app upgrade to a release whose sidecar requirements changed
   enough to re-run `pipInstall`.
3. Confirm the marker is deleted before the overlay install and rewritten only
   after the swap steps succeed (inspect `onnxruntime-<version>.dist-info`'s
   METADATA before/after, or a log/timestamp check if the window is too fast to
   catch by hand).
4. Confirm `pip check` is clean afterward.
5. If practical, force a swap-step failure and confirm the marker is deleted
   rather than left lying about a runtime that was never reinstalled.

### 9.2 Expected result

The same delete-first/write-last ordering proven by the unit-level injection seam
(`apply-ort-marker.test.ts`) actually fires against a real `spawn`/`venvDir`/
release directory. `pip check` clean afterward; a forced failure leaves no marker.

### 9.3 Result

**Not run — no real installed release directory exists on this box.** Per
`server/src/upgrade/paths.ts`, a real release is a `vX.Y.Z` directory under a
`releases/` parent, produced by the packaging/install path, not a git clone.
Checked exhaustively (2026-08-23, Castwright#2619): neither the primary
checkout nor any worktree sits under a `releases/` ancestor; no
`*astwright*` directory under `C:\`, `Program Files`, `Program Files (x86)`,
or `%LOCALAPPDATA%\Programs`; no running Castwright/Electron process; no
uninstall-registry entry. Per the issue's own instruction, a fake release
directory was not manufactured (requires a release cut, forbidden by standing
rules; a hand-assembled directory would not exercise the real `applyUpgrade`
path against real packaging output anyway). Matches the standing conclusion
on record since wave-3 (§3 above, `docs/testing/onbox-wave3-results/step-2-ort-marker.md`).
**Marker absent during the overlay install (observed how):** not reached.
**Marker present + correct version after a successful upgrade:** not reached.
**`pip check` after upgrade:** not reached.
**Forced-failure marker state (if run):** not reached.
**Run by:** claude (Castwright#2619). **Date:** 2026-08-23.
**Release version upgraded to:** N/A — no release directory available to
trigger an upgrade against.
Evidence: `docs/testing/onbox-wave5-results/step-ort-c-a40.md`.

---

## 10. Disposition summary

_(Update as each remaining criterion runs.)_

- Criterion 1 — fresh NVIDIA bootstrap (A28): **DISCHARGED 2026-08-31** (was: run
  2026-08-20, re-check 2026-08-21 wave-4 step 8, then STILL OWED through two more
  root-cause narrowings on 2026-08-23).
  Wave-3 run: marker/pip-check mechanics pass; GPU provider check fails (CUDA 12.4 vs. CUDA 13.x/cuDNN 9.x gap, #2534 blocker). Wave-4 re-run (after PR #2576 resolved the blocker): re-ran the GPU-provider check against fixed pin, still fails but on a new root cause — `onnxruntime-gpu` 1.26.0 requires `nvidia-cudnn-cu12~=9.0` via optional `[cudnn]` extra, never requested by `install-ort.mjs`. Follow-up filed: #2600. 2026-08-31: `install-ort.mjs` gained the missing `cufft`/`cuda-runtime` pins and a corrected, torch-line-matched cuDNN pin (`~=9.19.0`) — a real Kokoro CUDA load now succeeds end-to-end on this box. See onbox-acceptance-register.md A28 row (now retired) for full details and evidence.*
- Criterion 2 — the reported bug, in-app Qwen3 install (A29): **STILL OWED — partially run.** Clicking
  Install on Qwen3-TTS Base (0.6B) in Model Manager completed cleanly with no
  `WinError 5`, but follow-on Kokoro GPU-provider check unreachable on this box
  due to port contention (distinct from #2534); see
  `docs/testing/onbox-wave4-results/step-5c-a40.md`.
- Criterion 3 — self-heal: **Discharged 2026-08-07.**
- Criterion 4 — Pinokio update path (E7): owed.
- Criterion 5 — AMD box: blocked, no hardware.
- Criterion 6 — clobbered box (formerly A38, now removed): **DISCHARGED,
  2026-08-23 (§8.6).** Re-verified against a full copy of the real
  in-service sidecar venv: `ensureOrtMarker` refuses and logs exactly as
  designed, provably touches nothing on disk, and the named remedy command
  repairs the box. This row's own criteria do not require a GPU-provider
  check (tagged "no GPU needed, sidecar venv only") — fully discharged and
  removed from `onbox-acceptance-register.md` and the live view (fold #2625).
- Addition — in-app upgrade path (A30, renumbered from A39): **STILL OWED —
  BLOCKED, 2026-08-23 (§9.3).** No packaged `release/` install exists
  anywhere on this box; checked exhaustively rather than assumed. Not
  manufactured per the issue's own instruction against cutting a release.

**Register and live view updated in this session (fold #2625, 2026-08-23):**
the clobbered-box row (formerly A38 at that time) is removed per its discharge
above; Group A renumbered contiguously (old A39–A44 → A38–A43 at that time);
A28, A29 and the new A30 (in-app upgrade path, today's post-wave-7 numbers —
A36/A37/A38 at the time this note was written) carry dated notes recording
that session's findings and stay STILL OWED. `npm run check:onbox-register`
was green then; Group A has since renumbered again (wave 7).
