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
> Register rows: [A39–A42](onbox-acceptance-register.md#group-a--the-gpu-box),
> [E9](onbox-acceptance-register.md#group-e--not-the-gpu-box),
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
| 1 | Fresh NVIDIA bootstrap — marker present at the installed GPU version; `pip check` clean, exit 0; Kokoro reports `CUDAExecutionProvider` | A39 | Owed |
| 2 | **The reported bug** — Windows + NVIDIA, app running, in-app Qwen3 install completes with no `WinError 5`; GPU Kokoro afterwards | A40 | Owed — this is #2192 itself |
| 3 | Self-heal on an existing (pre-marker) box | — | **Discharged**, see §5 |
| 4 | Pinokio update path (`update.js`, the deployment shape that reported the bug) | E9 | Owed |
| 5 | AMD box — no marker is written; the live case is the AMD→ROCm-failure→CPU-fallback ordering | Blocked (AMD/ROCm) | Blocked — no hardware |
| 6 | Clobbered box — both dist-infos present, GPU build's files in the namespace; boot takes the loud path | A41 | Owed |
| — | *Addition, not one of the spec's six:* the in-app upgrade path (`upgrade/apply.ts` → `pipInstall`) | A42 | Owed |

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

## 3. Criterion 1 — fresh NVIDIA bootstrap (A39)

### 3.1 Procedure

1. Wipe (or freshly clone into) the sidecar venv and run a from-scratch
   `bootstrap-venv.mjs` on the nvidia profile — not an upgrade, not the boot-time
   self-heal, a genuine first bootstrap.
2. After it completes, inspect `site-packages` for `onnxruntime-<version>.dist-info`
   at the version `onnxruntime-gpu` actually installed.
3. Run `pip check` inside that venv.
4. Load Kokoro (via the app or a direct sidecar call) and confirm its reported
   execution provider.

### 3.2 Expected result

The marker is present, at the correct version, as a direct product of
`installForProfile`'s own `applyOrtMarkerWrite` call — not the boot-time self-heal,
which never needs to fire on a venv that was correct from the first pip call.
`pip check` exits 0. Kokoro reports `CUDAExecutionProvider`.

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
**Disposition:** STILL OWED — marker/pip-check mechanics pass, GPU provider
check fails on a real dependency gap.
**Run by:** claude (Castwright#2506, wave 3 step 2, fast-path claim).
**Date:** 2026-08-20.

---

## 4. Criterion 2 — the reported bug: in-app Qwen3 install (A40)

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

**Qwen3 install outcome:** _(fill in)_
**`WinError 5` present/absent:** _(fill in)_
**Kokoro execution provider after install:** _(fill in)_
**Run by:** _(fill in)_ **Date:** _(fill in)_

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

## 6. Criterion 4 — Pinokio update path (E9)

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

## 8. Criterion 6 — clobbered box (A41)

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
   `CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node server/tts-sidecar/scripts/install-ort.mjs <venv-python>`.
5. Re-check `pip check` and Kokoro's reported execution provider.

### 8.2 Expected result

`ensureOrtMarker` returns `'clobbered'`, logs the condition and the exact remedy
command, and writes **no** marker over the real distribution. `pip check` stays
clean throughout (pinned versions matched here, unlike wave-3's mismatched 1.29.0
run, so there was nothing broken for boot to silently "fix" either way) — the
discriminating checks are (a) the `'clobbered'` return value and the `[ort-marker]`
log line naming the condition and remedy command, and (b) that no NEW marker folder
is written over the real plain distribution (confirm by directory listing — only
the real plain dist-info at its own distinct version, plus the GPU swap dist-info,
both present). Running the remedy command repairs the box: uninstalls both,
reinstalls `onnxruntime-gpu` clean, writes a legitimate marker afterward.

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
same CUDA13/cuDNN9 gap documented for A39; would report `CPUExecutionProvider`
on this box regardless of marker/dist-info correctness.
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

Re-ran the corrected §8.1 recipe on a **fresh** throwaway venv (`python -m
venv`, not a copy of the sidecar's own) against branch
`fix/sidecar-2535-ort-marker-fix` at commit `5142039` (after merging latest
`origin/main` — the merge touched neither `install-ort.mjs` nor its test).

**Manufactured state confirmed:** `detectOrtOwner === 'swap'`,
`findPlainOrtDistInfos.length === 1`, both `onnxruntime-1.27.0.dist-info` and
`onnxruntime_gpu-1.27.0.dist-info` present.

**Log line observed (clobbered):** fired correctly — `[ort-marker] A stray
real plain onnxruntime dist-info coexists with the GPU build's files...
Refusing to write a marker that would certify this bad state. Repair with:
CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node
server/tts-sidecar/scripts/install-ort.mjs <venv-python>` — naming the exact
remedy command, at server boot (`tsx watch`, `SIDECAR_VENV_DIR` pointed at the
throwaway venv, isolated port 8290). No marker written over the real
distribution; `pip check` stayed clean (pinned versions matched here, unlike
wave-3's mismatched 1.29.0 run, so there was nothing broken for boot to
silently "fix" either way).

**Repair command output:** `CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node
server/tts-sidecar/scripts/install-ort.mjs <venv-python>` uninstalled both
`onnxruntime` 1.27.0 and `onnxruntime-gpu` 1.27.0, reinstalled
`onnxruntime-gpu==1.27.0` (`--no-deps`) — `[install-ort] onnxruntime-gpu in
place.`

**`pip check` after repair:** clean, no broken requirements.
**Post-repair owner check:** `detectOrtOwner === 'swap'`,
`findPlainOrtDistInfos.length === 0` — the marker now correctly reflects the
GPU build owning the namespace with no real plain distribution left behind.
**Kokoro execution provider after repair:** not independently re-tested;
`get_available_providers()` still lists `CUDAExecutionProvider` but
constructing a real inference session was not attempted — same box-level
CUDA 12.4 vs. CUDA 13.x/cuDNN 9.x gap (`#2534`) already blocking this check
on A39/A40, not a new gap.

**Disposition:** the defect #2535 was filed against — the silent `'deleted'`
path — is fixed and verified: the loud `'clobbered'` path now fires exactly
where wave-3 found it silent, and the remedy command repairs the box
correctly. The row stays **STILL OWED** only because its own criteria include
the CUDA-provider re-check, blocked by the pre-existing `#2534` gap (same
precedent as A39).

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
(1.27.0/1.27.0) — the same-version bug wave-3 step-3 exposed. This section
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
- `pip check` clean (versions pinned to match)

**ensureOrtMarker behavior:**

`ensureOrtMarker(venvDir)` returns `'clobbered'` and logs:

```
[ort-marker] A stray real plain onnxruntime dist-info coexists with the GPU build's files (which own the namespace). This corrupts pip's dependency resolution — a landmine for the next pip operation. The GPU build's files currently own the namespace, but the inconsistency must be repaired. Refusing to write a marker that would certify this bad state. Repair with:
  CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
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
**Venv:** fresh throwaway venv under a scratch temp path.
Evidence: hand-execution against `server/tts-sidecar/scripts/install-ort.mjs`
functions with venv at `C:\Users\dudar\AppData\Local\Temp\castwright-ort-verify-20260821-183456`
(preserved during PR review, deleted post-fix).

---

## 9. Addition — the in-app upgrade path (A42, not one of the spec's six)

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

**Marker absent during the overlay install (observed how):** _(fill in)_
**Marker present + correct version after a successful upgrade:** _(fill in)_
**`pip check` after upgrade:** _(fill in)_
**Forced-failure marker state (if run):** _(fill in)_
**Run by:** _(fill in)_ **Date:** _(fill in)_ **Release version upgraded to:** _(fill in)_

---

## 10. Disposition summary

_(Update as each remaining criterion runs.)_

- Criterion 1 — fresh NVIDIA bootstrap (A39): **Run 2026-08-20 — STILL OWED.**
  Marker/pip-check mechanics pass; GPU provider check fails (CUDA13/cuDNN9 gap).
- Criterion 2 — the reported bug, in-app Qwen3 install (A40): owed — not run
  this session (needs the full app + Model Manager UI); see wave-3 step-2
  results file.
- Criterion 3 — self-heal: **Discharged 2026-08-07.**
- Criterion 4 — Pinokio update path (E9): owed.
- Criterion 5 — AMD box: blocked, no hardware.
- Criterion 6 — clobbered box (A41): **Run 2026-08-21 — STILL OWED.** The
  filed defect (#2535) is fixed and verified: the corrected recipe now
  exercises the `'clobbered'` branch correctly, the log line fires with the
  remedy command, and the repair works (see §8.5 verification). The row
  stays owed only for the CUDA-provider re-check, blocked by #2534.
- Addition — in-app upgrade path (A42): owed — not run this session (needs a
  real packaged `release/` install); see wave-3 step-2 results file.

Once a criterion is run and its Result filled in, remove the corresponding row
from `docs/testing/onbox-acceptance-register.md` and mirror the removal in the
live view, per that register's own "Live view" procedure. **Not done for A39/
A41 in this run** — per Castwright#2506's own instructions, step 9 of the
wave-3 chain is the single writer for the register/live-view; this step only
records results.
