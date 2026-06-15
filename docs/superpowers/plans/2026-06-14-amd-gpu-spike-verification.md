# AMD GPU Support — Section 0 Verification Spike Plan

> ✅ **RESOLVED 2026-06-15.** Findings recorded in the spec ("Spike findings (2026-06-15)") and
> applied in Phase 2 (PR #818). Headline: **S0.1 DirectML FAILED on-box** (ConvTranspose on
> `onnxruntime-directml` 1.24.4) → Kokoro on AMD = CPU (`side-16` #819). S0.2 ROCm wheels pinned
> (import/synth = beta telemetry, Wave H2). S0.3 ORT swap dormant (DirectML disabled). S0.4 parser
> validated. See `docs/features/archive/217-amd-gpu-support.md`.

> **For agentic workers:** This is an **investigation plan**, not a TDD build plan. Each task produces a recorded *finding* + a *decision*, not shipped code. The terminal output is a "Spike findings" block appended to the spec, which then unblocks the Phase 2 implementation plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Resolve the four unproven assumptions that gate Phase 2 (AMD enablement), so the Phase 2 plan is written against verified mechanics, not guesses.

**Why this exists:** two assumptions are critical (Kokoro-on-DirectML actually runs; ROCm-Windows torch install mechanic + version compat) and would invalidate large parts of Phase 2 if false. Two are smaller (ORT packaging; dual-GPU samples).

**Spec:** `docs/superpowers/specs/2026-06-14-amd-gpu-sidecar-support-design.md` (Section 0).

**Hardware reality:** the author has **no AMD GPU**. Each task below is tagged:
- 🟢 **Desk / any box** — doable now without AMD hardware.
- 🟡 **Non-AMD box, partial** — install/import checks that run on any box but don't prove GPU execution.
- 🔴 **AMD box required** — needs an AMD-Windows (and ideally AMD-Linux) tester or a cloud AMD instance. These are the *owed* parts; everything else can complete first.

**Output contract:** append a `## Spike findings (YYYY-MM-DD)` section to the spec recording, per task: the verdict, the exact pinned values (URLs/versions/recipes), and the resulting Phase-2 decision (e.g. "Coqui stays/drops on AMD").

---

## Task S0.1 — Kokoro on DirectML (gates the Windows headline)

**Question:** does the Kokoro v1 ONNX model run under `onnxruntime-directml`, or does the documented `ConvTranspose` error still block it? If a re-exported/higher-opset model is needed, does that single model still run on CPU + CUDA (so we ship ONE model to everyone, N2)?

- [ ] **Step 1: 🟢 Desk research — current status of the upstream issue**

Read the two known references and check for newer comments/fixes:
- `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/discussions/5` (ConvTranspose + DirectML)
- `https://github.com/hexgrad/kokoro/issues/79` (DirectML EP errors)
Also check the latest `onnxruntime-directml` release notes for ConvTranspose op coverage and the current `kokoro-onnx` version's bundled model opset.
Capture: is there a known fix (newer ORT? newer opset? a re-export)? Record versions.

- [ ] **Step 2: 🟢 Inspect the shipped model's opset**

On any box with the model present (`server/tts-sidecar/voices/kokoro/kokoro-v1.0.onnx` —
it's git-ignored, so **run `scripts/install-kokoro.{ps1,sh}` first if absent**, P8):
Run a tiny Python snippet in the sidecar venv: `import onnx; m = onnx.load(path); print(m.opset_import)`.
Capture: the current opset. Cross-reference whether DirectML's ConvTranspose support requires a higher opset.

- [ ] **Step 3: 🔴 AMD-Windows box — actually run it**

On an AMD-Windows box (tester or cloud), in a Python 3.12 venv with `onnxruntime-directml`:
load `kokoro-v1.0.onnx` with `providers=['DmlExecutionProvider','CPUExecutionProvider']` and synthesize one short line.
Capture: does it succeed on DML, error at ConvTranspose, or silently fall back to CPU? (Check `session.get_providers()` after load to confirm which EP actually bound.)

- [ ] **Step 4: 🟡 If a re-export is required — verify the universal-model claim (N2)**

If S0.1 needs a re-exported / higher-opset model: **first establish whether we can even
produce one (P5).** We consume a community ONNX export from the `kokoro-onnx` releases — we
do **not** own the PyTorch→ONNX export pipeline, so a re-export may depend on
**upstream** (onnx-community / kokoro-onnx) publishing a corrected model. If we can obtain
a corrected model: on a **non-AMD** box confirm it loads + synthesizes correctly on **CPU**
and (on the NVIDIA dev box) **CUDA** EPs — proving we can ship ONE corrected model to ALL
profiles. **If no corrected universal model is obtainable**, the realistic outcomes collapse
to PASS(run the current model as-is) or FAIL → CPU; we do not block on producing our own export.

- [ ] **Step 5: Record the decision in the spec**

Append to "Spike findings" one of:
- **PASS (runtime only):** DML runs the existing model → enable DirectML for Kokoro on AMD-Windows (gated by the cached self-test, Section 4). No model change.
- **PASS (universal re-export):** ship the re-exported model to all profiles; record the new artifact URL + sha256 for `model-hashes.json`; note the one-time ~330 MB re-download on upgrade.
- **FAIL:** Kokoro-on-AMD-Windows stays CPU; Windows value prop = Qwen/Coqui only. Update the matrix + acceptance accordingly. **Do NOT ship two Kokoro artifacts.**

---

## Task S0.2 — ROCm-Windows torch install mechanic + engine compat (gates the install layer)

**Question:** what is the exact, pinnable ROCm-Windows torch wheel (URL + version), and do `coqui-tts`, `qwen-tts`, and `torchcodec` work on that torch version?

- [ ] **Step 1: 🟢 Pin the install mechanic**

From AMD's docs (`https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/windows/install-pytorch.html`) and `repo.radeon.com`, identify the **stable, versioned** ROCm-Windows torch wheel(s) for a specific ROCm release (e.g. torch 2.8.0 / ROCm 6.4.4). Capture: exact wheel URL(s) for cp312-win_amd64 (torch + torchaudio/torchvision as needed), the torch version, and the required Adrenalin driver version.
Decide: is there a **stable URL to hash-pin**, or must the AMD profile take the documented **unpinned-torch exception** (N5)? Record the choice.

- [ ] **Step 2: 🟡→🔴 Compat — import coqui-tts / qwen-tts / torchcodec on the ROCm torch version**

**First verify import-ability without AMD hardware (P4):** the ROCm-**Windows** preview wheel
may hard-require the AMD driver/HIP runtime DLLs *just to import* (unlike Linux ROCm wheels,
which typically import with `cuda.is_available()` → `False`). In a throwaway Python 3.12 venv,
install the ROCm torch wheel from Step 1 and try `python -c "import torch"`.
- **If it imports on a non-AMD box (🟡):** proceed here — `pip install coqui-tts[codec]
  transformers<5 qwen-tts` and verify **all three import** without a version conflict, paying
  special attention to **`torchcodec`** (N4 — torch-version-coupled, pulled by
  `coqui-tts[codec]`). Capture which install cleanly, which conflict, exact errors.
- **If it will NOT import without the AMD runtime (🔴):** this whole compat check moves to an
  AMD box — note that S0.2 is then *fully* AMD-hardware-gated, which materially shrinks the
  "desk-doable" portion of the spike. Record this explicitly.

- [ ] **Step 3: 🔴 AMD box — confirm actual synthesis (sanity)**

On an AMD box, load Qwen + Coqui and synthesize one short line each on the ROCm torch. Confirm `torch.cuda.is_available()` is `True` and audio is produced.

- [ ] **Step 4: Record the decision in the spec**

Append to "Spike findings": the pinned torch wheel URL(s) + version (to fill the Phase-1 `installRecipe` AMD `torchSpec` placeholder), the integrity decision (pin vs unpinned exception), and the **engine matrix outcome** — specifically whether **Coqui drops from the AMD profile** (N8 priority: Kokoro > Qwen > Coqui).

---

## Task S0.3 — onnxruntime / DirectML packaging (gates H1)

**Question:** what is the working pip recipe to get `kokoro-onnx` running on `onnxruntime-directml` without the double-`onnxruntime` module conflict?

- [ ] **Step 1: 🟡 Reproduce + resolve the conflict on a Windows box**

In a throwaway Python 3.12 venv on Windows: `pip install kokoro-onnx` (pulls base `onnxruntime`), then `pip install onnxruntime-directml`. Confirm whether both land (conflict) and whether `import onnxruntime; print(onnxruntime.get_available_providers())` shows `DmlExecutionProvider`.
Then test the fix: `pip install kokoro-onnx --no-deps` + explicit `onnxruntime-directml` (+ any other kokoro-onnx deps installed individually), OR `pip uninstall -y onnxruntime` then `pip install onnxruntime-directml`. Capture which recipe yields a clean single `onnxruntime` providing `DmlExecutionProvider`.

- [ ] **Step 2: Record the decision in the spec**

Append the exact `ortInstallSteps` recipe for the AMD-Windows profile (the ordered pip commands) to "Spike findings" — this fills the Phase-1 `installRecipe` `ortInstallSteps` shape for Phase 2.

---

## Task S0.4 — dual-GPU detection samples (gates M1)

**Question:** does the `parseVendorFromProbe` rule (NVIDIA-present-wins) hold against real multi-GPU output?

- [ ] **Step 1: 🟢 Collect real probe samples**

Gather real `(Get-CimInstance Win32_VideoController).Name` output (Windows) and `lspci` VGA/Display lines (Linux) from a few configurations: NVIDIA-only, AMD-only (dGPU + APU), AMD-iGPU + NVIDIA-dGPU laptop, Intel-iGPU + AMD-dGPU, and a headless/basic-display box. Tester-sourced is fine.

- [ ] **Step 2: 🟢 Validate the Phase-1 parser against the samples**

**Depends on Phase 1 Task 1** (`parseVendorFromProbe` must exist) — P9. Feed each sample into
`parseVendorFromProbe` and confirm the verdict matches intent. Add any sample that surprises
as a new test case to `server/src/tts/accelerator-profile.test.ts` (lands on the Phase-1
branch). Capture: any rule adjustment needed — e.g. a bare `Advanced Micro Devices` line with
no `[AMD/ATI]` bracket, which the current regex would miss (P7).

- [ ] **Step 3: Record the decision in the spec**

Append confirmed sample strings + any rule refinement to "Spike findings"; land new parser test cases on the Phase-1 branch.

---

## Closing the spike

- [ ] **Step 1: Write the consolidated findings block**

Append `## Spike findings (YYYY-MM-DD)` to the spec with the four verdicts + pinned values (S0.1 model decision, S0.2 torch URL + Coqui in/out, S0.3 ORT recipe, S0.4 parser confirmation).

- [ ] **Step 2: Update the matrix + scope if anything changed**

If S0.1 FAILed or S0.2 dropped Coqui, edit the `(vendor × OS × engine)` matrix and the "Engines" scope row to match reality.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-14-amd-gpu-sidecar-support-design.md
git commit -m "docs(sidecar): record AMD GPU verification spike findings (S0.1-S0.4)"
```

- [ ] **Step 4: Gate check before Phase 2**

Confirm: S0.1 and S0.2 both resolved (PASS or a documented narrowed scope). Only then write the Phase 2 implementation plan. If an AMD tester is still unavailable for the 🔴 steps, Phase 2 can be *written* against the 🟢/🟡 findings but **must not be released** until the 🔴 acceptance is met (per the spec's delivery model — the 3.12 flip ships only with validated AMD support).
