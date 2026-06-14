---
status: active
shipped: null
owner: null
---

# AMD GPU support (Phase 1: Python 3.12 + accelerator-profile + detect-and-reinstall)

> Status: active — Phase 1 SHIPS (the public-beta ship gate); AMD enablement is Phase 2 (OWED)
> Key files: `server/tts-sidecar/scripts/accelerator-profile.mjs`, `server/tts-sidecar/scripts/venv-migration.mjs` (+ `.d.mts`), `server/tts-sidecar/scripts/{bootstrap-venv,ensure-python312}.mjs`, `server/tts-sidecar/requirements/{base,nvidia-cuda}.txt`, `server/tts-sidecar/requirements.txt` (shim), `server/tts-sidecar/python-tag.txt`, `server/src/upgrade/apply.ts`
> URL surface: none (install-path / sidecar infrastructure)
> OpenAPI ops: none
> Backlog: `side-15` ([#813](https://github.com/dudarenok-maker/Castwright/issues/813))
> Spec: [`2026-06-14-amd-gpu-sidecar-support-design.md`](../superpowers/specs/2026-06-14-amd-gpu-sidecar-support-design.md)
> Plans: [`2026-06-14-amd-gpu-phase1-foundation.md`](../superpowers/plans/2026-06-14-amd-gpu-phase1-foundation.md) (Phase 1, shipped) · [`2026-06-14-amd-gpu-phase2-enablement.md`](../superpowers/plans/2026-06-14-amd-gpu-phase2-enablement.md) (Phase 2, owed)

## Benefit / Rationale

- **User:** unlocks AMD-GPU deployers — a large currently-excluded cohort — without regressing the NVIDIA / CPU / macOS users who work today. The Python **3.11 → 3.12** transition keeps the sidecar on a supported interpreter (3.11 is past its feature window) and pulls the latest PyPI torch.
- **Technical:** the accelerator decision (vendor → profile → per-engine backend → ORT providers → install recipe) becomes a single pure, unit-tested module instead of scattered conditionals; the venv lifecycle gains a **stamp** (`pythonTag` / `profile` / `reqHash`) so "is this venv still right?" is a computed answer, not a guess.
- **Architectural:** Phase 1 ships the AMD code **dormant + fully unit-tested** behind a "no overlay selection by hardware" fence, so Phase 2 (AMD enablement) is a *flip of existing branches* (`amd-rocm.txt`, ROCm torch, DirectML, profile-switch) rather than new plumbing. It also locks in the **never-destroy-a-working-venv** invariant: a Python/profile mismatch maps to **detect-and-reinstall**, never an in-place teardown.

## Architectural impact

- **New seams / extension points:**
  - `server/tts-sidecar/scripts/accelerator-profile.mjs` — pure resolver (`parseVendorFromProbe`, `detectVendor`, `resolveProfile`, `runtimeBackend`, `ortProviders`, `installRecipe`, `describeResolved`). Plain ESM so both the server runtime and the install scripts consume it; side-effect-guarded so `import` is inert.
  - `server/tts-sidecar/scripts/venv-migration.mjs` — pure decision core (`computeReqHash`, `decideVenvAction`, `classifyVenvState`, `readStamp`/`writeStamp`/`stampPath`, `resolveRequired`). A hand-written `venv-migration.d.mts` types the three exports consumed by `apply.ts`.
  - `server/tts-sidecar/requirements/` — layered structure (`base.txt` + `nvidia-cuda.txt`); the `requirements.txt` shim is the **sole** install path.
  - `server/tts-sidecar/python-tag.txt` (`cp312`) — single canonical Python-tag source, read from the *extracted release* by the `apply.ts` guard (never hard-coded in the running old code).
  - `server/tts-sidecar/scripts/ensure-python312.mjs` — fresh-install Python-3.12 discovery / auto-install / guided fallback (`decidePythonAcquisition`).
- **Invariants preserved:**
  - **NVIDIA regression fence** — the shipped NVIDIA install set is byte-equivalent to today (transitive PyPI torch, `onnxruntime-gpu` via `kokoro-onnx[gpu]`); no new index step.
  - **Never destroy a working venv** — a mismatch is `needs-reinstall` (guidance + abort), never a teardown-then-build. The data-preservation gate (below) makes the reinstall safe.
- **Migration story:** alpha installs on a 3.11 venv are **detected and guided to a fresh reinstall** — there is no in-place 3.11→3.12 rebuild (that high-risk path is dropped because only a tiny coordinated alpha cohort ever upgrades; the public-beta majority installs fresh on 3.12). User content survives the reinstall **because the packaged `WORKSPACE_DIR` is external to the install** — this is a **verified acceptance gate** (Task 17.D), not an assumption. Stamps are written on a fresh bootstrap; a v1.7.0 venv has no stamp → classifies `needs-reinstall`.
- **Reversibility:** the AMD branches ship unreached (no `amd-rocm.txt`, no AMD detection wired into the install path), so Phase 1 behaviourally equals "today + Python 3.12". The pure modules are import-inert; removing the wiring (the `apply.ts` guard + the 3.12 bootstrap target) reverts to prior behaviour without touching the dormant resolver.

## Invariants to preserve

Phase 1 ships these as the regression surface. Each cites the enforcing test/file.

1. **Accelerator resolver matrix** (`accelerator-profile.mjs`, tested in `server/src/tts/accelerator-profile.test.ts`):
   - `installRecipe('nvidia', …)` === `{ torchPreinstall: null, ortPackage: 'onnxruntime-gpu' }` — the NVIDIA regression fence: no explicit torch step, exactly today.
   - Dual-GPU: `parseVendorFromProbe('win32', '<AMD iGPU>\n<NVIDIA dGPU>')` === `'nvidia'` — **NVIDIA-present-wins** when both appear.
   - AMD branches exist (`runtimeBackend('amd', …)`, `ortProviders('amd', …)`, `installRecipe('amd', …)` with `torchPreinstall: 'PENDING_SPIKE'`) but are **dormant** — no install path routes to them in Phase 1. The AMD-Kokoro DirectML values are marked provisional (spike S0.1); AMD `torchPreinstall` is the `PENDING_SPIKE` placeholder.
   - `resolveProfile` precedence is env > wizard > detection > `'cpu'`; an `'unknown'` / invalid value falls through (never silently `'amd'`).
2. **Layered requirements** (`server/tts-sidecar/requirements/`, tested in `server/src/tts/requirements-layout.test.ts`):
   - `nvidia-cuda.txt` begins `-r base.txt`; `base.txt` carries vendor-neutral deps (`fastapi`, `faster-whisper`, …) and **no** `torch` / `onnxruntime`; `nvidia-cuda.txt` carries `coqui-tts[codec]` + `kokoro-onnx[gpu]` (byte-equivalent to today's set).
   - `requirements.txt` is the shim `-r requirements/nvidia-cuda.txt` — the **sole** install path.
   - **No `cpu.txt` / `amd-rocm.txt`** in Phase 1 (those + overlay-by-hardware selection are Phase 2).
3. **Venv lifecycle = detect-and-reinstall** (`venv-migration.mjs`, tested in `server/src/tts/venv-migration.test.ts`):
   - `classifyVenvState` maps a `pythonTag` / `profile` mismatch (or a missing stamp) to **`needs-reinstall`** (NOT an in-place rebuild); `!venvExists` → `fresh-bootstrap`; a `reqHash`-only change → `pip-in-place`; all-match → `noop`.
   - `bootstrap-venv.mjs` on `needs-reinstall` prints reinstall guidance + exits non-zero **without touching the venv**.
   - `apply.ts` reads the shared-venv stamp + the *candidate release's* declared `pythonTag` (from `releaseDir`'s `python-tag.txt`) and, on a 3.11→3.12 mismatch, returns `{ ok: false, phase: 'needs-reinstall' }` — never calls `pipInstall` or `flipPointer` (old release stays current). Tested in `server/src/upgrade/apply.test.ts`.
4. **Python 3.12 unification:** `server/tts-sidecar/python-tag.txt` is the single canonical Python-tag source (`cp312`); `resolveRequired` in `venv-migration.mjs` is the **shared** required-`{pythonTag, profile, reqHash}` helper (bootstrap + apply.ts compute the same thing, never reimplemented).
5. **Bootstrap stamp records the EFFECTIVE profile (`'nvidia'`), not the detected vendor** — Phase 1 does not select an overlay by hardware, so the stamp reflects what was actually built (keeps `decideVenvAction` predictable; detection lands unit-tested but unconsumed by the install path until Phase 2).

## Data-preservation gate (hard acceptance gate — Task 17.D)

A fresh reinstall **must** preserve all user content (books, `cast.json`, designed `.pt` voices) because the packaged `WORKSPACE_DIR` is **external to the install directory**. This is the load-bearing assumption that lets Phase 1 drop the in-place rebuild. It is a **verified gate, not a belief**: acceptance step D points the app at a v1.7.0 (3.11) install, confirms `needs-reinstall` + guidance + no pip-into-3.11, then does a fresh reinstall and confirms every artifact survives.

> **STOP condition:** if any user content is lost on reinstall, the packaged `WORKSPACE_DIR` is NOT external and the entire detect-and-reinstall strategy must be revisited before ship.

## Test plan

### Automated coverage

New behaviour landed paired tests in the same waves (all run under `npm run test:server` — `node` env):

- Vitest server (`server/src/tts/accelerator-profile.test.ts`) — the full resolver matrix: vendor parse incl. dual-GPU NVIDIA-wins; `detectVendor` cpu-on-failure + darwin short-circuit; `resolveProfile` precedence; `runtimeBackend` / `ortProviders` per-engine matrix (NVIDIA live, AMD/Apple/CPU branches); `installRecipe` NVIDIA fence + AMD `PENDING_SPIKE`; `describeResolved` summary.
- Vitest server (`server/src/tts/venv-migration.test.ts`) — `computeReqHash` stability/order-sensitivity; `decideVenvAction` three-way (missing stamp → rebuild, py/profile mismatch → rebuild, reqHash-only → pip-in-place, all-match → noop); `classifyVenvState` Phase-1 mapping (mismatch → **`needs-reinstall`**, never rebuild); stamp I/O round-trip + null-on-missing/corrupt.
- Vitest server (`server/src/tts/requirements-layout.test.ts`) — layered structure: `nvidia-cuda.txt` overlays `base.txt`; `base.txt` vendor-neutral (no torch/onnxruntime); NVIDIA overlay == today's engine lines; shim is the sole path; **no** `cpu.txt`/`amd-rocm.txt`.
- Vitest server (`server/src/tts/ensure-python312-helpers.test.ts`) — `decidePythonAcquisition` (found-on-PATH use; absent+winget auto-install; absent+no-winget guided fallback; Linux guided, never silent sudo).
- Vitest server (`server/src/upgrade/apply.test.ts`) — the upgrade-path guard: 3.11→3.12 mismatch returns `phase: 'needs-reinstall'` and calls neither `pipInstall` nor `flipPointer`; a matching `pythonTag` with a changed `reqHash` still pip-installs in place.

**`venv-migration.d.mts` note:** the hand-written declaration for the untyped `.mjs` is trusted blindly by `tsc` (no compile-time cross-check — both value and type imports resolve through the same `.d.mts`). The real guard against drift is the runtime test suite asserting the full shapes of the consumed exports. See residual risk #2.

**CI does NOT run the sidecar pytest suite** — `run-tests.ps1` exits 0 with a SKIP banner when the venv is absent (always true on a runner), by design (sidecar validation = author-hardware acceptance). So the "pytest green on 3.12" check is an author-acceptance item (A0 below), not CI.

**Residual-risk updates (post final-review):**
- **torch was only transitive → FIXED** (commit `e8d0468d`). `coqui-tts 0.27.5` dropped its torch
  declaration, so a fresh venv had **no torch** and Coqui XTTS + Qwen synth (≈10 `import torch`
  sites in `main.py`) would fail — a **pre-existing gap on `main`**, exposed by the 3.12 reinstall
  (old venvs carried torch from an older coqui-tts). Fix: explicit `torch>=2.6` in
  `nvidia-cuda.txt`; the `installRecipe` "torch is transitive" premise was corrected;
  `test_requirements.py::test_torch_is_explicit` locks it. Kokoro (onnxruntime) was never affected.
- **reqHash-only-hashed-the-shim → FIXED** (commit `00a396ca`). `zip-validate` now computes `reqHash = computeReqHash([nvidia-cuda.txt, base.txt])` from the zip — byte-identical to the venv stamp's hash — so a future overlay/base pin edit triggers the upgrade pip-install, and `ctx.reqHash` no longer diverges from the stamp. A test proves a shim-only edit does NOT change the hash while an overlay/base edit does.
- **Flash-attn → SDPA on 3.12 (benign, flag at acceptance):** the pinned FlashAttention-2 wheel is `cp311`-only, so on a 3.12 venv `install-qwen3.mjs` skips it and Qwen uses the SDPA attention backend. Correctly gated + tested; the only effect is that anyone who had opted into FA2 loses that speedup after the 3.12 move. Note it in the A-series acceptance so it isn't a surprise.

### Manual acceptance walkthrough — Phase 1 ship gate (author hardware, NO AMD)

> Green unit tests are necessary but NOT sufficient. These are real runs on the author's hardware — the gate to ship the public-beta-enabling package. Record results here when run (live-GPU acceptance currently **owed**).

1. **A0. Sidecar pytest green on Python 3.12** — on a bootstrapped 3.12 venv, `npm run test:sidecar` passes (the existing suite survives the 3.11→3.12 bump). CI skips this by design.
2. **A. Fresh install on 3.12 — NVIDIA** — clean install builds a 3.12 venv with **explicit torch present** (`pip show torch` after bootstrap), synthesises a chapter on **all three torch-dependent paths: Kokoro + a Qwen design + a Coqui XTTS render** (Coqui is the engine the dropped-torch gap specifically broke, so it MUST be exercised — not just Kokoro/Qwen); `/health` reports `cuda`.
3. **B. Fresh install on 3.12 — CPU-only box** — installs, synthesises (Kokoro CPU); `/health` reports `cpu`.
4. **C. Fresh install on 3.12 — macOS / Apple Silicon** — installs, synthesises (Qwen on `mps`, Kokoro CPU); mps path unchanged.
5. **D. Alpha detect-and-reinstall + data gate** — point the app at a v1.7.0 (3.11) install → classifies `needs-reinstall`, shows guidance, does **not** pip into the 3.11 venv. Then do a fresh reinstall and confirm books + `cast.json` + designed voices are all preserved. **If any user content is lost, STOP** (see the data-preservation gate above).
6. **E. Python-3.12-absent fresh box** — `ensure-python312` auto-installs (or guides + relaunch) and the bootstrap then succeeds on 3.12.
7. **F. Dual-GPU box (AMD iGPU + NVIDIA dGPU)** — resolves to `nvidia` (CPU/NVIDIA only — no AMD path shipped).

## Out of scope

**Phase 2 — AMD enablement (OWED, requires an AMD-owning tester)** — tracked in [`2026-06-14-amd-gpu-phase2-enablement.md`](../superpowers/plans/2026-06-14-amd-gpu-phase2-enablement.md). Owed acceptance (spec §Acceptance "Phase 2"):

- AMD-Windows fresh install: Qwen/Coqui report ROCm in `/about` + generate audio; Kokoro reports DirectML **if spike S0.1 passed**, else CPU (honestly).
- AMD-Linux fresh install: Qwen/Coqui = ROCm, Kokoro = CPU.
- AMD release upgrade on an existing NVIDIA install: forces **no** migration (`noop` / `pip-in-place`); books/voices untouched.
- Override / profile switch: `ACCELERATOR=amd` triggers the (job-coordinated) profile re-setup; reports AMD backends after.

Also deferred to Phase 2 (present here only as dormant placeholders or absent by design): `cpu.txt` / `amd-rocm.txt` overlays + profile-based overlay selection; the ROCm torch wheel URL (`torchPreinstall: 'PENDING_SPIKE'`); DirectML for Kokoro (provisional, spike S0.1); the in-place rebuild / resumable `apply.ts` / atomic swap / `decideDiskAction` 3× headroom pre-flight; the `/health` backend enum going live; VRAM telemetry; the seamless profile-switch.

## Ship notes

(Filled in when status flips to `stable` — append the shipped date + commit SHA + any behaviour delta vs. the spec, then `git mv` to `docs/features/archive/`. Phase 1 code shipped on branch `feat/sidecar-amd-gpu-support`; live-GPU acceptance — steps A0–F — owed before `stable`.)
