# AMD GPU Support — Section 0 Verification Spike Plan

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

On any box with the model present (`server/tts-sidecar/voices/kokoro/kokoro-v1.0.onnx`):
Run a tiny Python snippet in the sidecar venv: `import onnx; m = onnx.load(path); print(m.opset_import)`.
Capture: the current opset. Cross-reference whether DirectML's ConvTranspose support requires a higher opset.

- [ ] **Step 3: 🔴 AMD-Windows box — actually run it**

On an AMD-Windows box (tester or cloud), in a Python 3.12 venv with `onnxruntime-directml`:
load `kokoro-v1.0.onnx` with `providers=['DmlExecutionProvider','CPUExecutionProvider']` and synthesize one short line.
Capture: does it succeed on DML, error at ConvTranspose, or silently fall back to CPU? (Check `session.get_providers()` after load to confirm which EP actually bound.)

- [ ] **Step 4: 🟡 If a re-export is required — verify the universal-model claim (N2)**

If S0.1 needs a re-exported / higher-opset model: re-export (or obtain) it, then on a **non-AMD** box confirm it loads + synthesizes correctly on **CPU** and (on the NVIDIA dev box) **CUDA** EPs, byte-plausible audio. This proves we can ship ONE corrected model to ALL profiles rather than maintaining two artifacts.

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

- [ ] **Step 2: 🟡 Compat — import coqui-tts / qwen-tts / torchcodec on the ROCm torch version**

On any box (ROCm torch CPU-imports even without an AMD GPU; `torch.cuda.is_available()` will be `False`, which is fine for an *import/resolve* check): create a throwaway Python 3.12 venv, install the ROCm torch wheel from Step 1, then `pip install coqui-tts[codec] transformers<5 qwen-tts` (or the project's pins) and verify **all three import** without a version conflict. Pay special attention to **`torchcodec`** (N4 — it is torch-version-coupled and `coqui-tts[codec]` pulls it).
Capture: which install cleanly, which conflict, exact error messages.

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

Feed each sample into `parseVendorFromProbe` (the Phase-1 function) and confirm the verdict matches intent. Add any sample that surprises as a new test case to `server/src/tts/accelerator-profile.test.ts`.
Capture: any rule adjustment needed (e.g. an unusual AMD branding string the regex misses).

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
