# AMD GPU support for the TTS sidecar (Windows + Linux)

- **Date:** 2026-06-14
- **Status:** draft — the **spike-independent foundation (Phase 1) is plannable now**; the
  **AMD-specific Phase 2 is gated on the Section 0 verification spike** (two critical
  assumptions are unproven without it). See "Delivery sequencing."
- **Ships in:** the release after v1.7.0 (open beta) — so the upgrade migration path is
  first-class, not an afterthought.
- **Goal posture:** broaden the open beta to AMD-GPU owners. Best-effort, since the
  author has **no AMD hardware to verify on** — the design biases hard toward graceful
  detection, fail-safe degradation, and honest messaging over silent assumptions.

## Summary

Today the sidecar assumes NVIDIA/CUDA in three independent ways: PyTorch is installed
as a `cu124` wheel (Coqui, Qwen), Kokoro pulls the CUDA-only `onnxruntime-gpu`, and
device/VRAM telemetry shells out to `nvidia-smi`. None of this *crashes* on AMD — it
silently falls back to CPU, which is unusably slow for XTTS/Qwen. The analyzer (Ollama)
is already vendor-neutral (ships ROCm builds) and is out of scope.

This work introduces a single **accelerator profile** — `nvidia` / `amd` / `apple` /
`cpu` — resolved once and threaded through install, runtime device resolution,
`/health`, telemetry, and the wizard (**Approach B: a pure-function resolver + layered
requirements**). The torch engines run on AMD via **ROCm PyTorch** (which aliases the
CUDA API through HIP — confirmed: `torch.cuda.is_available()` returns `True` on the
Windows ROCm build — so `device="cuda"` works unchanged). Kokoro *aims* to run on
AMD-Windows via **DirectML**, but that is **unproven** (see C1) and defaults to a CPU
fallback until the spike confirms it. The whole sidecar **unifies on Python 3.12**
(required by ROCm-on-Windows PyTorch), forcing a one-time, automatic, atomic venv
rebuild on upgrade from v1.7.0.

### Verified external facts (2026-06-14)

- **ROCm PyTorch on Windows** exists as a **preview**; requires **Python 3.12**;
  `torch.cuda.is_available()` returns `True` (HIP aliases the CUDA API, so
  `device="cuda"` / `torch.autocast(device_type="cuda")` work unchanged).
- **Install mechanic is NOT a clean stable pip index.** AMD says the pytorch.org ROCm
  wheels "change regularly (nightly)" and recommends **pinned wheels from
  `repo.radeon.com`** for a specific ROCm release (e.g. torch 2.8.0 / ROCm 6.4.4).
  Treat ROCm torch like the flash-attn **manual-wheel-URL** pattern, not `--index-url`.
- **Torch version is dictated by the ROCm release** (2.8/2.9), **not** our NVIDIA pin
  (2.6/cu124). The AMD and NVIDIA profiles therefore run **different torch versions** —
  this is a first-class constraint, not an edge case (see C3).
- **ONNX Runtime on Windows AMD:** the ROCm EP is not available on Windows; **DirectML**
  (DX12) is the GPU path. **But Kokoro-on-DirectML has a documented `ConvTranspose`
  failure** (works on CPU, errors on DML) — the central Windows value prop is unproven.
- **`onnxruntime` vs `onnxruntime-directml` collide** — both provide the `onnxruntime`
  module; `kokoro-onnx` pulls base `onnxruntime`, so installing DirectML alongside needs
  explicit `--no-deps` / uninstall-then-install ordering (see H1).
- **cp312 wheel availability (the unify-on-3.12 gate):** `torch 2.6.0+cu124` (NVIDIA),
  `coqui-tts` (supports 3.10–3.13), `transformers<5`, `kokoro-onnx`/`onnxruntime`,
  `faster-whisper`, and the hand-sourced flash-attn (`…cp312-cp312-win_amd64.whl`) all
  have cp312 wheels. Nothing in the *NVIDIA* stack blocks the bump. (AMD-side torch
  compat with coqui-tts/qwen-tts on torch 2.8/2.9 is a **spike item**, not verified.)

### Known, accepted limitations (stated, never silently degraded)

- **Kokoro on AMD-Windows DirectML is UNPROVEN** (C1). Until the spike confirms it, the
  AMD-Windows Kokoro backend **defaults to CPU**; DirectML is opt-in and gated on a
  passing self-test at load.
- **Whisper ASR is CPU-only on AMD** under every option (CTranslate2 has no ROCm/DML
  backend). Off by default regardless.
- **Kokoro on AMD-Linux falls back to the CPU EP** — DirectML is Windows-only; ROCm ONNX
  Runtime is build-from-source (out of scope).
- **DirectML VRAM is unmeasurable from our process** — the VRAM watchdog can't see it.
- **AMD perf trails NVIDIA even when working** — no ROCm flash-attn, no ROCm DeepSpeed
  (both correctly skipped). "Works on AMD" ≠ "as fast as NVIDIA."
- **ROCm-on-Windows PyTorch is a preview** — stability/perf for XTTS/Qwen is unproven;
  UI labels AMD support "experimental."

## Scope decisions (locked with the user)

| Decision | Choice |
|---|---|
| Goal | Broaden open beta to AMD users; best-effort, unverified by author |
| Engines | All three (Kokoro, Qwen, Coqui) — subject to AMD torch/DML spike outcomes |
| Profile selection | Auto-detect with override |
| Python version | Unify the whole sidecar on Python 3.12 |
| Python 3.12 acquisition | Auto-install via wizard, guided fallback (with Windows caveats, H3) |
| Whisper on AMD | CPU-only (accepted limitation) |
| OS coverage | Windows and Linux |
| Analyzer (Ollama) | Out of scope — already vendor-neutral |

## Section 0 — Verification spike (GATES the implementation plan)

Two critical assumptions are unproven and would invalidate large parts of the plan if
false. The spike is mostly doable **without** AMD hardware (CPU-side compat + packaging);
the GPU-execution items need one AMD tester or a cloud AMD box. **Do not write the
implementation plan until S0.1 and S0.2 resolve.**

- **S0.1 — Kokoro on DirectML (gates the Windows headline).** Run the Kokoro v1 ONNX model
  under `onnxruntime-directml` on a current ORT version. Determine: does the `ConvTranspose`
  error still occur? Is it fixed by a newer opset / ORT / a re-export?
  - **Preferred outcome — a single universal model for ALL installs (N2).** If the fix is a
    re-exported / higher-opset model, verify it **also runs correctly on the CPU and CUDA
    EPs** (a higher opset is backward-compatible across EPs as long as our `onnxruntime`
    floor — already `>=1.20.1` — supports it). If so, **ship that one corrected model to
    every profile** (NVIDIA/CPU/AMD alike): re-pin its hash in `model-hashes.json`, let
    `install-kokoro` re-fetch on hash mismatch (a one-time ~330 MB re-download on upgrade,
    even for NVIDIA). This avoids per-backend model artifacts + selection logic entirely.
  - **Fallback only if a single model can't satisfy all EPs:** Kokoro-on-AMD-Windows stays
    **CPU**, Windows value prop narrows to Qwen/Coqui — stated plainly. We do NOT ship two
    Kokoro artifacts.
- **S0.2 — ROCm-Windows torch install + version compat (gates the install layer).** Pin the
  *actual* install mechanic (repo.radeon.com wheel URL(s) vs nightly index) and the exact
  torch version. Then verify **coqui-tts**, **qwen-tts**, **and `torchcodec`** (N4 —
  `coqui-tts[codec]` pulls it and it is torch-version-coupled) import + synthesize on that
  torch version (CPU-side import/load test needs no GPU). If coqui-tts / torchcodec are
  incompatible with the ROCm torch version, Coqui drops from the AMD matrix.
  - **Integrity (N5):** AMD says ROCm wheels "change regularly," so a hash-pin (ops-7
    `model-hashes.json` model) may rot. S0.2 must settle whether a **stable, versioned**
    repo.radeon.com wheel URL exists to pin, or whether the experimental AMD profile takes a
    documented **unpinned-torch exception** (integrity trade-off, AMD-only).
- **S0.3 — onnxruntime/DirectML packaging (gates H1).** Confirm the working install recipe
  for `kokoro-onnx` + `onnxruntime-directml` without a double-`onnxruntime` conflict.
- **S0.4 — dual-GPU detection (gates M1).** Confirm the vendor-priority rule against real
  multi-GPU `Win32_VideoController` / `lspci` output samples.

Spike output: a short findings note appended here, then the AMD-specific plan is written
against **verified** mechanics, not assumptions.

## Delivery sequencing (foundation first, AMD-specifics behind the spike)

The work splits cleanly along the spike boundary, so the foundation is buildable **now**
without any AMD hardware or spike outcome:

- **Phase 1 — Spike-independent foundation (plan + build now):** the pure-function
  accelerator-profile resolver + detection (Section 1), the layered-requirements scaffold
  with the NVIDIA/CPU recipes (Section 3), the venv stamp + three-way decision +
  build-new-then-swap migration (Section 2), the `/health` family-vocabulary +
  torch-first VRAM telemetry (Sections 4–5, NVIDIA/CPU paths), the Python-3.12 unification
  (incl. NVIDIA cp312 flash-attn tag), and the **entire test backbone** (Section 7). This
  delivers the 3.11→3.12 migration and the architecture even before AMD is enabled — and is
  independently valuable (vendor-neutral VRAM telemetry, atomic venv migration).
- **Spike — Section 0** (S0.1–S0.4) runs in parallel with / after Phase 1.
- **Phase 2 — AMD enablement (plan + build post-spike):** the verified ROCm `torchSpec` +
  repo.radeon.com wheel handling, the DirectML ORT install ordering + provider selection +
  cached self-test, the (possibly re-exported) universal Kokoro model, and the AMD rows of
  the wizard/about/Help messaging — all written against S0 findings.

**Engine-drop priority (N8):** if S0.2 forces a cut on the AMD profile, preserve in this
order — **Kokoro (default narration) > Qwen (voice design) > Coqui (alternate)**. Coqui is
the first to drop; Kokoro CPU-fallback is preferable to losing the engine entirely.

## Architecture

**Approach B** (a profile resolver + layered requirements) over inline branching (smears
profile logic across 5+ scripts) and a full pluggable-backend abstraction (over-engineered
for four profiles). The resolver is the single source of truth; everything asks it.

```
detect vendor ──► resolveProfile(override, detected, platform) ──► profile
                                                                     │
        ┌────────────────────────────┬───────────────────────────┬─┘
        ▼                            ▼                           ▼
 installRecipe(profile,        runtimeBackend(profile,     ortProviders(profile,
   engine, platform)             engine, platform)            platform)
```

### The (vendor × OS × engine) matrix the resolver owns

| vendor × OS | torch engines (Coqui/Qwen) | Kokoro (onnxruntime) |
|---|---|---|
| nvidia (any) | `cuda` — torch **2.6/cu124** wheels | CUDA EP (`onnxruntime-gpu`) |
| amd + Windows | `rocm` — torch **2.8/2.9 ROCm** (repo.radeon.com wheel, HIP→`device="cuda"`) | **DirectML EP IF S0.1 passes, else CPU EP** |
| amd + Linux | `rocm` — torch ROCm (Linux index) | ROCm/MIGraphX EP if present, else CPU EP |
| apple | `mps` (existing, untouched) | CoreML/CPU EP (existing) |
| cpu / unknown | `cpu` | CPU EP |

Note the **per-profile torch version** (2.6 NVIDIA vs 2.8/2.9 AMD): the resolver returns
a torch *spec* (version + source), not just a flag. Coqui/Qwen inclusion on AMD is
contingent on S0.2.

## Section 1 — Accelerator profile resolver

**New module:** `server/tts-sidecar/scripts/accelerator-profile.mjs`, all **pure
functions** so the whole matrix is unit-testable with zero AMD hardware.

- `detectVendor({ platform, exec })` → `'nvidia' | 'amd' | 'apple' | 'cpu' | 'unknown'`.
  - Windows: `Get-CimInstance Win32_VideoController`; Linux: `lspci` + `rocminfo` /
    `nvidia-smi` presence; `exec` injected so parsing is testable on canned output.
  - **Dual-GPU priority (M1/N6):** generalized rule — **if any NVIDIA GPU is present,
    resolve to `nvidia`** (the proven path) unless overridden; otherwise if any AMD GPU is
    present, `amd`; else `cpu`. This covers iGPU+dGPU *and* dGPU+dGPU combos by defaulting
    to the verified path when ambiguous. Integrated-only AMD (APU) resolves to `amd`. Rule
    pinned against real multi-GPU samples in S0.4.
- `resolveProfile({ override, detected, platform })` → profile. Precedence (N7): explicit
  **`ACCELERATOR` env beats the persisted wizard choice beats detection beats the `cpu`
  fallback** — consistent with the existing `#/advanced` locked-by-`.env` semantics.
  `unknown` → `cpu` (never silently "tries AMD").
- `installRecipe(profile, engine, platform)` → `{ torchSpec, pipExtras, ortPackage,
  ortInstallSteps, flashAttnTag? }`. `torchSpec` carries version + source (index URL or
  manual wheel URL — ROCm uses the latter). `ortInstallSteps` encodes the H1 ordering.
- `runtimeBackend(profile, engine, platform)` → `'cuda' | 'rocm' | 'directml' | 'cpu' |
  'mps'`.
- `ortProviders(profile, platform)` → ordered ONNX Runtime provider list.

Resolved profile + torch spec are logged at install and at sidecar boot.

## Section 2 — Venv lifecycle & the open-beta upgrade migration

**The problem:** the self-upgrade (`server/src/upgrade/apply.ts`) reuses **one shared
venv** and only `pip install`s when the requirements hash changes (`.req-hash` gate,
`apply.ts:77`). A venv is bound to the Python it was created with, so a v1.7.0
(Python 3.11) box upgrading to v1.8.0 would pip-install into a 3.11 interpreter →
failure. There is **no path to change the interpreter**, and `bootstrap-venv.mjs` is
idempotent on existence alone (`bootstrap-venv.mjs:62`).

**Goals:** automatic, atomic, **never destroys a working environment**, preserves model
weights, communicates honestly. One prompt, no manual venv commands.

1. **Stamp the venv.** `.venv-stamp.json` in the venv dir: `{ pythonTag, profile,
   reqHash, builtVersion }`. **Missing stamp (a v1.7.0 venv has `.req-hash` but no
   stamp) ⇒ treat as mismatch ⇒ rebuild (M2).**
2. **Three-way decision** (shared by `apply.ts` and `bootstrap-venv.mjs`):
   - `pythonTag` or `profile` mismatch (or no stamp) → **full teardown + rebuild**.
   - `reqHash` changed only → **pip install in place** (today's behavior).
   - all match → **no-op**.
   - **`reqHash` is computed over the RESOLVED overlay's contents (Section 3), not the
     static root shim (H2)** — otherwise overlay edits go undetected.
3. **Build-new-then-swap (atomicity, mirrors the release-dir pattern):**
   - **Pre-flight (a):** locate a suitable Python 3.12 (Section 3); if none and
     auto-install fails → **stop before touching anything**; old venv intact.
   - **Pre-flight (b) disk check (M3/N1):** a full second venv (torch ~2–2.5 GB) is built at
     `.venv-next` before the swap. Verify free space first; **if tight, ABORT with a clear
     "free N GB and retry" message — never teardown-then-build.** The "never destroy a
     working environment" guarantee is absolute; a mid-download failure of a multi-GB ROCm
     wheel after teardown would leave the user with no venv, which is exactly the outcome
     this section exists to prevent.
   - Build `.venv-next`, pip-install, smoke-check (imports torch, reports expected
     backend, Kokoro self-test for DML if applicable).
   - On green only: atomically swap `.venv-next` → `.venv` (keep old as `.venv-prev` for
     one cycle as rollback). Failed rebuild leaves the running environment working.
4. **Weights preserved** — `voices/` lives outside the venv; rebuild re-fetches pip
   packages (torch ~2–2.5 GB) but **not** the multi-GB model weights.
5. **One honest prompt** (Section 6), then automatic progress.
6. **Profile-switch reuses the same machinery** (a `profile` mismatch).

**Risk acknowledgment (H4):** unify-on-3.12 forces *every existing NVIDIA beta user*
through this rebuild — the highest-risk new code, imposed on the users the feature does
not benefit. Accepted deliberately (single-version maintenance > one-time rebuild cost),
but it raises the bar on the migration's test coverage and the rollback guarantee.

## Section 3 — Install layer

1. **Layered requirements** under `server/tts-sidecar/requirements/`:
   - `base.txt` — vendor-neutral (fastapi, uvicorn, numpy, psutil, soundfile,
     faster-whisper).
   - `nvidia-cuda.txt`, `amd-rocm.txt`, `cpu.txt` — each `-r base.txt`.
   - **The `reqHash` in `apply.ts` is computed over the resolved overlay's full
     transitive content (overlay + base), NOT a static root shim (H2).** A root
     `requirements.txt` may remain only as a human pointer; it is not the hash source.
2. **Torch install is resolver-driven and profile-versioned.** NVIDIA: torch 2.6/cu124
   via the cu124 index (unchanged) + cp312 flash-attn (opt-in, non-fatal). **AMD: torch
   2.8/2.9 from the pinned repo.radeon.com wheel URL(s)** (manual-wheel pattern, like
   flash-attn), version per S0.2; flash-attn skipped (no ROCm wheel; SDPA default);
   DeepSpeed skipped.
3. **Kokoro/onnxruntime install ordering (H1).** AMD-Windows: install `kokoro-onnx`
   **without** its `onnxruntime` dep (or uninstall the pulled-in CPU `onnxruntime`), then
   install `onnxruntime-directml` — exact recipe pinned in S0.3. NVIDIA:
   `kokoro-onnx[gpu]` (unchanged). CPU/Linux-AMD: plain `kokoro-onnx` + `onnxruntime`.
4. **Installers consume the resolver.** `install-qwen3.mjs`'s hard-pinned cu124 URL +
   cp311 flash-attn gate (`:73`–`90`) become resolver lookups; `install-kokoro` picks the
   ORT package + ordering; `install-coqui` rides the resolved torch spec. cp311→cp312
   flash-attn tag bump lands here.
5. **Python 3.12 acquisition (auto-install, guided fallback) — with Windows caveats
   (H3).** Discover `python3.12` / `py -3.12` first. If absent, attempt auto-install
   (Windows `winget install Python.Python.3.12`, else silent official-installer download;
   Linux: detect pkg manager, offer the one-line install, never silent `sudo`). **Caveat:
   the newly installed interpreter is typically not on the running process's PATH and the
   installer may need UAC** — so the realistic flow is *install → prompt the user to
   relaunch → resume the rebuild with the now-visible 3.12*, not a single seamless step.
   On winget-less editions (Server/LTSC), go straight to guided fallback. The working
   v1.7.0 venv is never touched on any failure.
6. **Record profile + torch spec at install** into `.venv-stamp.json`.

NVIDIA recipe preserved except the cp311→cp312 flash-attn tag.

## Section 4 — Runtime device resolution per engine

**Coqui + Qwen (torch) — compute path unchanged; only reporting changes.** On a ROCm
build `torch.cuda.is_available()` is `True` (confirmed), `device="cuda"` allocates on the
AMD GPU, `torch.autocast(device_type="cuda")` is valid. Coqui's resolver (`main.py:498`)
and Qwen's `_resolve_torch_device` (`main.py:915`) keep working. Add a build-introspection
helper: `torch.version.hip is not None` → family `"rocm"`, else `torch.version.cuda` →
`"cuda"`. Feeds `/health` only. DeepSpeed off, flash-attn skipped on AMD, fp16 autocast
kept. *(Inclusion of these engines on AMD is contingent on S0.2.)*

**Kokoro (onnxruntime) — DirectML is gated, CPU is the safe default (C1).** Today the
constructor takes no providers (`main.py:787`). Add `ortProviders(profile, platform)`;
call `Kokoro(model, voices, providers=...)` guarded by `try/except TypeError` →
no-arg fallback, plus any provider env-hint. **But until S0.1 proves DirectML runs the
Kokoro model, the AMD-Windows default is `['CPUExecutionProvider']`.** DirectML is enabled
only when (a) S0.1 passed and (b) a **cached, engine-conditional self-test** passes:
- **Engine-conditional (N3):** the self-test is only relevant when **Kokoro is the active
  engine** on the AMD-Windows profile. If the configured engine is Qwen (ROCm torch), no
  Kokoro DML self-test runs at all.
- **Cached, not per-boot (N3):** it runs **lazily on the first Kokoro-on-DML load**, records
  the result (in `.venv-stamp.json` or a sibling marker), and **re-runs only on a profile or
  GPU-driver change** — never a synthesis probe on every startup (which would add latency and
  risk hanging the DML driver each launch).
- Any DML failure (ConvTranspose or otherwise) falls back to CPU and is reported honestly in
  `/health`. Fix the ImportError remediation text (`main.py:765`).

**CUDA-poison detection — extend for HIP.** `_CUDA_POISON_RE` (`main.py:166`) misses ROCm
strings; add `HIP error` / `rocBLAS` / `hipBLAS` so a poisoned ROCm context self-heals.

## Section 5 — `/health` device truth + VRAM/telemetry honesty

Extend the existing per-engine probe (side-14: `_compute_device_predictions`,
`_normalize_device_family`, `/health` → `devices` + `devices_state`).

1. **Add `rocm` + `directml` families.** Torch engines: `torch.version.hip` → `rocm` not
   `cuda`. Kokoro: map session providers `DmlExecutionProvider→directml`,
   `CUDAExecutionProvider→cuda`, `ROCMExecutionProvider→rocm`, else `cpu` (both loaded and
   prediction paths). /about panel shows "ROCm" / "DirectML" via a label map.
2. **VRAM telemetry — measure what we can, say `unknown` for the rest.**
   - Prefer `torch.cuda.mem_get_info()` for resident torch-engine VRAM (works under
     ROCm/HIP; vendor-neutral). Optional whole-GPU `rocm-smi` where present.
   - DirectML VRAM unmeasurable → **`unknown`, never `0`**.
   - **Fail-safe when VRAM is `unknown`:** disable VRAM-based eviction + the committed-
     ceiling recycle trigger; rely on the host-RAM watchdog + configured budgets. Prevents
     the recycle-storm and false-headroom-OOM modes on AMD.
3. **Engine mutual-exclusion stays conservative** (correctness, not optimization).
4. **`nvidia-smi` contention probe no-ops on AMD** — the dev-box throttle never fires;
   accepted, `rocm-smi` probe out of scope.

## Section 6 — Wizard UX + messaging

Plugs into existing surfaces (fs-21 wizard, fs-43 /about panel, #/advanced, fe-29
Help/failure taxonomy).

1. **Profile in the setup wizard** — detected vendor in plain language with an override
   control (Auto / NVIDIA / AMD / CPU); persists to user-settings + `.venv-stamp.json`.
2. **Upgrade migration prompt** (Section 2): one modal — *"Castwright vX needs a one-time
   setup update: a newer Python (3.12) and the libraries for your GPU. Your books and
   designed voices are safe and won't be touched. This takes about 5–15 minutes."* →
   automatic progress; Python-3.12 auto-install runs inline **with the relaunch caveat
   (H3)**; only its failure shows guided steps + a download link.
3. **Per-engine backend truth in /about** — Kokoro: DirectML *(or CPU if S0.1 fails)* ·
   Qwen: ROCm · Coqui: ROCm · Whisper: CPU — with an inline "AMD GPU support is in
   preview" note.
4. **#/advanced surfaces `ACCELERATOR`** with locked-by-`.env` + drift-guard behavior.
5. **Failure messaging:** a "GPU acceleration unavailable — running on CPU" remediation
   entry (driver/Adrenalin version, unsupported gfx, preview-wheel, DML-op fallback). Keeps
   the FailureCode lockstep discipline (taxonomy + remediations + openapi + help titles +
   parity test move together).
6. **Limitations stated, not buried** — AMD-Linux Kokoro→CPU, Whisper→CPU, Kokoro-DML
   unproven, AMD slower than NVIDIA.

## Section 7 — Testing strategy (real coverage with zero AMD hardware)

~90% unit-tested on existing runners by making decision logic pure/mockable; the
hardware-bound rest is an explicit owed acceptance matrix.

1. **Resolver matrix tests (backbone)** — exhaustive table tests of `(detected, override,
   platform) → profile` (incl. dual-GPU priority, M1) and `(profile, engine, platform) →
   {torchSpec, ortPackage, ortInstallSteps, runtimeBackend, ortProviders}`. Pinned
   assertion that the **NVIDIA recipe is unchanged** except the cp312 tag.
2. **Detection-probe tests** with injected `exec` against canned multi-GPU
   `Win32_VideoController` / `lspci` output (AMD-only, NVIDIA-only, AMD-iGPU+NVIDIA-dGPU,
   none, malformed → `unknown`→`cpu`).
3. **Sidecar device-resolution tests** extending `test_device_probe.py`: `version.hip`/
   `version.cuda` → `rocm`/`cuda`; `DmlExecutionProvider` → `directml`; **Kokoro DML
   self-test failure → CPU fallback reported honestly**; `providers=` TypeError fallback;
   `_CUDA_POISON_RE` matches `HIP error`/`rocBLAS`.
4. **Venv-migration tests (highest-risk, fully fakeable)** via injected `ApplySteps` +
   exported `bootstrap-venv.mjs` helpers: `pythonTag` mismatch / **missing stamp (M2)** →
   teardown+rebuild with **build-`.venv-next`-then-swap order** + **old venv preserved on
   failure**; profile mismatch → rebuild; reqHash-only (over **resolved overlay**, H2) →
   pip-in-place; all-match → no-op; **Python-3.12-missing → abort pre-flight, `rmDir`
   never called**; **low-disk (M3) → teardown-then-build fallback with warning**.
5. **Installer-recipe tests** — extend pure `resolveFlashAttnInstall` (cp312 + amd-skip);
   assert resolver-driven torch spec (manual wheel URL for AMD), ORT install ordering
   (H1), per profile with `spawn` faked.
6. **CI changes (flagged):** all above run on existing NVIDIA/CPU/mock runners — no AMD CI
   hardware. Unify-on-3.12 moves the sidecar Python to 3.12 in the CI matrix +
   `cross-os.yml` (also catches cp312 wheel surprises on Ubuntu/macOS/Windows). Sidecar
   tests keep SKIP-on-unbootstrapped-venv.
7. **The honest gap → manual AMD acceptance matrix** (in the regression plan under
   `docs/features/`), marked `OWED`.

## Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| C1 | Kokoro-on-DirectML `ConvTranspose` may not run → default engine no GPU on AMD-Win | **S0.1 spike gate**; CPU default + load-time self-test before enabling DML; honest /health |
| C2 | ROCm-Win torch is nightly/manual-wheel, not a stable index | Model as manual-wheel URL (S0.2); resolver returns a torch *spec* |
| C3 | AMD torch (2.8/2.9) ≠ NVIDIA torch (2.6); coqui-tts/qwen-tts compat unverified | **S0.2 spike**; per-profile torch versions; drop Coqui from AMD if incompatible |
| H1 | `onnxruntime` + `onnxruntime-directml` double-install conflict | S0.3 recipe; `--no-deps` / uninstall-then-install ordering encoded in `ortInstallSteps` |
| H2 | Static root-shim reqHash misses overlay changes | Hash the resolved overlay's transitive content |
| H3 | Windows Python auto-install needs UAC + PATH refresh | Install → relaunch → resume; guided fallback on winget-less editions |
| H4 | Migration taxes the verified NVIDIA majority; riskiest code | Atomic build-new-then-swap; rollback; heavy migration test coverage |
| M1/N6 | Dual-GPU mis-detection | NVIDIA-present-wins priority rule (generalized), pinned in S0.4 |
| M2 | Missing-stamp v1.7.0 venv | No stamp ⇒ rebuild |
| M3/N1 | `.venv-prev` doubles disk | Disk pre-flight; **abort if tight (never teardown-then-build)** — atomicity is absolute |
| M4 | AMD slower than NVIDIA even when working | Set expectation in UI ("experimental"); no flash-attn/DeepSpeed on AMD |
| N2 | Second Kokoro model artifact + selection | Prefer a single corrected model shipped to ALL profiles (re-pin hash); two artifacts explicitly rejected |
| N3 | DML self-test latency / driver hang per boot | Cached + engine-conditional; lazy on first DML load, re-run only on profile/driver change |
| N7 | Env vs wizard-choice precedence | Env beats wizard beats detection (locked-by-`.env` semantics) |

## Out of scope

- Analyzer (Ollama) changes — already vendor-neutral.
- Whisper GPU on AMD — no ROCm/DML CTranslate2 backend.
- Kokoro GPU on AMD-Linux (source-built ROCm ORT) — CPU EP only.
- `rocm-smi` dev-box contention probe.
- Apple/mps behavior changes — named for completeness, untouched.

## Acceptance (owed — requires an AMD-owning tester)

- [ ] AMD-Windows fresh install: Qwen/Coqui report ROCm in /about and generate audio;
      Kokoro reports DirectML **if S0.1 passed**, else CPU (honestly).
- [ ] AMD-Linux fresh install: Qwen/Coqui=ROCm, Kokoro=CPU.
- [ ] Upgrade from v1.7.0: one prompt, automatic atomic rebuild, books + designed voices
      intact, ends on Python 3.12; failed rebuild leaves v1.7.0 working.
- [ ] Python-3.12-absent box: auto-install (or guided fallback + relaunch) works; the
      working install is never broken mid-flight.
- [ ] Dual-GPU box (AMD iGPU + NVIDIA dGPU): resolves to NVIDIA by default.
- [ ] Override: `ACCELERATOR=cpu` on an AMD box triggers a rebuild and reports CPU.
