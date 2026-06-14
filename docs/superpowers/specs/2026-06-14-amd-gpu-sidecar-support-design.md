# AMD GPU support for the TTS sidecar (Windows + Linux)

- **Date:** 2026-06-14
- **Status:** draft
- **Ships in:** the release after v1.7.0 (open beta) — so the upgrade migration path is first-class, not an afterthought.
- **Goal posture:** broaden the open beta to AMD-GPU owners. Best-effort, since
  the author has **no AMD hardware to verify on** — the design therefore biases
  hard toward graceful detection, fail-safe degradation, and honest messaging
  over silent assumptions.

## Summary

Today the sidecar assumes NVIDIA/CUDA in three independent ways: PyTorch is
installed as a `cu124` wheel (Coqui, Qwen), Kokoro pulls the CUDA-only
`onnxruntime-gpu`, and device/VRAM telemetry shells out to `nvidia-smi`. None of
this *crashes* on AMD — it silently falls back to CPU, which is unusably slow for
XTTS/Qwen. The analyzer (Ollama) is already vendor-neutral (ships ROCm builds) and
is out of scope here.

This work introduces a single **accelerator profile** concept — `nvidia` / `amd` /
`apple` / `cpu` — resolved once and threaded through install, runtime device
resolution, `/health`, telemetry, and the wizard. The torch engines run on AMD via
**ROCm PyTorch** (which aliases the CUDA API through HIP, so `device="cuda"` works
unchanged); Kokoro runs on AMD-Windows via **DirectML** (the ROCm ONNX Runtime
provider does not exist on Windows). The whole sidecar **unifies on Python 3.12**
(required by the ROCm-on-Windows PyTorch wheels), which forces a one-time venv
rebuild on upgrade from v1.7.0 — handled automatically and atomically.

### Verified external facts (2026-06-14)

- **ROCm PyTorch on Windows** exists as a **preview** release; requires **Python
  3.12** and targets PyTorch 2.9 on ROCm 6.3/6.4 with a recent Adrenalin driver.
  HIP aliases the CUDA API, so `torch.cuda.is_available()`, `device="cuda"`, and
  `torch.autocast(device_type="cuda")` all work on a ROCm build.
- **ONNX Runtime on Windows AMD:** the ROCm execution provider is **not** available
  on Windows; **DirectML** (DX12) is the supported GPU path and needs no ROCm.
- **cp312 wheel availability (the unify-on-3.12 gate):** `torch 2.6.0+cu124`,
  `coqui-tts` (supports 3.10–3.13), `transformers<5`, `kokoro-onnx`/`onnxruntime`,
  `faster-whisper`, and the hand-sourced flash-attn
  (`…cu124torch2.6.0…cp312-cp312-win_amd64.whl`, same lldacing repo) **all have
  cp312 wheels**. Nothing in the NVIDIA stack blocks the bump.

### Known, accepted limitations (stated, never silently degraded)

- **Whisper ASR is CPU-only on AMD** under every option — CTranslate2 has no ROCm
  or DirectML backend. The content-QA gate is unaccelerated on AMD (it is off by
  default regardless).
- **Kokoro on AMD-Linux falls back to the CPU EP** — DirectML is Windows-only and
  the ROCm ONNX Runtime provider is build-from-source (out of scope for best-effort).
- **DirectML VRAM is unmeasurable from our process** — Kokoro-on-DML uses no torch
  context, so the VRAM watchdog cannot see it.
- **ROCm-on-Windows PyTorch is a preview** — stability/perf for XTTS/Qwen
  specifically is unproven; the UI labels AMD support "experimental."

## Scope decisions (locked with the user)

| Decision | Choice |
|---|---|
| Goal | Broaden open beta to AMD users; best-effort, unverified by author |
| Engines | **All three** — Kokoro, Qwen, Coqui |
| Profile selection | **Auto-detect with override** |
| Python version | **Unify the whole sidecar on Python 3.12** (freeze nothing) |
| Python 3.12 acquisition | **Auto-install via wizard (winget / official installer / pkg hint), guided fallback** |
| Whisper on AMD | CPU-only (accepted limitation) |
| OS coverage | Windows **and** Linux |
| Analyzer (Ollama) | Out of scope — already vendor-neutral |

## Architecture

The chosen approach is **Approach B — a profile resolver + layered requirements**
(over inline branching, which smears profile logic across 5+ scripts, and over a
full pluggable-backend abstraction, which is over-engineered for four profiles and
violates the repo's simplicity-first rule).

The resolver is the single source of truth. Everything else asks it questions.

```
detect vendor ──► resolveProfile(override, detected, platform) ──► profile
                                                                     │
        ┌────────────────────────────┬───────────────────────────┬─┘
        ▼                            ▼                           ▼
 installRecipe(profile,        runtimeBackend(profile,     ortProviders(profile,
   engine, platform)             engine, platform)            platform)
        │                            │                           │
   installers +                 sidecar device              Kokoro ORT
   layered requirements         resolution + /health        provider list
```

### The (vendor × OS × engine) matrix the resolver owns

| vendor × OS | torch engines (Coqui/Qwen) | Kokoro (onnxruntime) |
|---|---|---|
| nvidia (any) | `cuda` (cu124 wheels) | CUDA EP (`onnxruntime-gpu`) |
| amd + Windows | `rocm` ROCm-Win torch (HIP→`device="cuda"`) | **DirectML EP** (`onnxruntime-directml`) |
| amd + Linux | `rocm` ROCm torch | ROCm/MIGraphX EP if present, else **CPU EP** |
| apple | `mps` (existing, untouched) | CoreML/CPU EP (existing) |
| cpu / unknown | `cpu` | CPU EP |

`apple`/mps is named only so the matrix is complete; its behavior is unchanged.

## Section 1 — Accelerator profile resolver

**New module:** `server/tts-sidecar/scripts/accelerator-profile.mjs`, all **pure
functions** (no I/O at module scope) so the entire matrix is unit-testable with zero
AMD hardware.

- `detectVendor({ platform, exec })` → `'nvidia' | 'amd' | 'apple' | 'cpu' | 'unknown'`
  - Windows: `Get-CimInstance Win32_VideoController` → match `AMD|Radeon` / `NVIDIA`.
  - Linux: `lspci` (VGA/Display lines) + presence of `rocminfo` / `nvidia-smi`.
  - `exec` is injected so detection parsing is testable against canned output.
- `resolveProfile({ override, detected, platform })` → profile object. Precedence:
  explicit `ACCELERATOR` env / persisted wizard choice **beats** detection; detection
  **beats** the `cpu` fallback. `unknown` resolves to `cpu` (safe) — never silently
  "tries AMD."
- `installRecipe(profile, engine, platform)` → `{ torchIndexUrl?, pipExtras,
  ortPackage, flashAttnTag? }` — the wheel truth for installers.
- `runtimeBackend(profile, engine, platform)` → `'cuda' | 'rocm' | 'directml' |
  'cpu' | 'mps'` — consumed by sidecar device resolution + `/health`.
- `ortProviders(profile, platform)` → the ordered ONNX Runtime provider list.

The resolved profile is logged once at install and once at sidecar boot, so a
mis-detection is immediately visible in the logs.

## Section 2 — Venv lifecycle & the open-beta upgrade migration

**The problem:** the self-upgrade (`server/src/upgrade/apply.ts`) reuses **one shared
venv** across releases and only `pip install`s into it when the requirements hash
changes (`.req-hash` gate, `apply.ts:77`). A venv is permanently bound to the Python
it was created with, so a v1.7.0 (Python 3.11) box upgrading to v1.8.0 would try to
pip-install ROCm-Windows torch (no cp311 wheel) into a 3.11 interpreter → failure or
wrong wheels. There is currently **no path to change the interpreter**, and
`bootstrap-venv.mjs` is idempotent on existence alone (`bootstrap-venv.mjs:62`), so
it would leave the stale venv in place.

**Design goals:** automatic, atomic, **never destroys a working environment**,
preserves model weights, communicates honestly. One prompt, no manual venv commands.

1. **Stamp the venv.** Replace the bare `.req-hash` with `.venv-stamp.json` in the
   venv dir: `{ pythonTag, profile, reqHash, builtVersion }`.
2. **Three-way decision** (shared by `apply.ts` and `bootstrap-venv.mjs`):
   - `pythonTag` or `profile` mismatch → **full teardown + rebuild**.
   - `reqHash` changed only → **pip install in place** (today's behavior, preserved).
   - all match → **no-op** (today's behavior, preserved).
3. **Build-new-then-swap (atomicity, mirrors the release-dir pattern):**
   - Pre-flight: locate a suitable Python 3.12 (Section 3). If none and auto-install
     fails → **stop before touching anything**; the old venv stays intact.
   - Build the replacement at `.venv-next`, pip-install, smoke-check it imports torch
     and reports the expected backend.
   - On green only: atomically swap `.venv-next` → `.venv` (keep old as `.venv-prev`
     for one cycle as rollback). A failed rebuild leaves the running environment working.
4. **Weights preserved.** Model weights (Kokoro `.onnx`, Qwen `.pt`, voices) live in
   `voices/`, outside the venv. A rebuild re-fetches pip packages (torch ~2–2.5 GB)
   but **not** the multi-GB model weights.
5. **One honest prompt** before the rebuild (see Section 6), then automatic progress.
6. **Profile-switch reuses the same machinery** — flipping `ACCELERATOR`
   (nvidia↔amd) is a `profile` mismatch → same teardown+rebuild+swap.

## Section 3 — Install layer

1. **Layered requirements** under `server/tts-sidecar/requirements/`:
   - `base.txt` — vendor-neutral (fastapi, uvicorn, numpy, psutil, soundfile,
     faster-whisper).
   - `nvidia-cuda.txt` — torch (cu124 index), `onnxruntime-gpu`, `kokoro-onnx[gpu]`.
   - `amd-rocm.txt` — torch (ROCm index), `onnxruntime-directml` (Win) /
     `onnxruntime` (Linux), `kokoro-onnx` (plain).
   - `cpu.txt` — torch (cpu index), `onnxruntime`, `kokoro-onnx` (plain).
   - Each overlay `-r base.txt`. A thin root `requirements.txt` shim resolves to the
     active overlay so `apply.ts`'s `reqHash` keeps hashing a stable file and any
     legacy reader still works.
2. **Installers consume the resolver.** `install-qwen3.mjs`'s hard-pinned cu124 URL
   + cp311 flash-attn gate (`install-qwen3.mjs:73`–`90`) become resolver lookups:
   on `amd` the torch install uses the ROCm index and flash-attn is skipped (no ROCm
   flash-attn wheel; SDPA is already the non-fatal default). `install-kokoro` picks
   `onnxruntime-directml` vs `onnxruntime-gpu`. `install-coqui` rides the resolved
   torch. The cp311→cp312 flash-attn tag bump lands here (the cp312 wheel exists).
3. **Python 3.12 acquisition (auto-install, guided fallback).** Extend the existing
   Python-discovery step feeding `bootstrap-venv.mjs <pythonCmd>`:
   - Discover `python3.12` / `py -3.12` on PATH first.
   - If absent, **attempt auto-install**: Windows → `winget install Python.Python.3.12`
     (fall back to silent official-installer download); Linux → detect the package
     manager and surface/offer the one-line install (never `sudo` silently).
   - If auto-install fails → guided remediation + download link; the working v1.7.0
     venv is never touched (Section 2 pre-flight).
4. **Record profile at install** into `.venv-stamp.json`.

Net touch: one `requirements/` dir, three installers swap hard-codes for resolver
calls, the Python-discovery step gains an auto-install attempt. The NVIDIA recipe is
preserved byte-for-byte except the cp311→cp312 flash-attn tag.

## Section 4 — Runtime device resolution per engine

**Coqui + Qwen (torch) — compute path unchanged; only reporting changes.** On a ROCm
build `torch.cuda.is_available()` is `True`, `device="cuda"` allocates on the AMD GPU,
`torch.autocast(device_type="cuda")` is valid. So Coqui's resolver (`main.py:498`) and
Qwen's `_resolve_torch_device` (`main.py:915`) keep working and land on the AMD GPU.
The only falsehood is the *reported* family. Add a build-introspection helper:
`torch.version.hip is not None` → family `"rocm"`, else `torch.version.cuda` → `"cuda"`.
This feeds `/health` only, **not** the compute path. No new device string, no
`.to("rocm")`. DeepSpeed stays off (no ROCm build). flash-attn stays skipped on AMD
(SDPA default). fp16 autocast kept.

**Kokoro (onnxruntime) — the real runtime change.** Today the constructor is called
with **no providers list** (`main.py:787`) to dodge cross-version drift. Add
`ortProviders(profile, platform)` → `['DmlExecutionProvider','CPUExecutionProvider']`
(amd+win) / `['CUDAExecutionProvider','CPUExecutionProvider']` (nvidia) /
`['CPUExecutionProvider']` (amd-linux / cpu). Call
`Kokoro(model, voices, providers=...)` guarded by `try/except TypeError` that falls
back to the current no-arg constructor (preserving drift-tolerance while gaining
explicit DML selection); also set any provider env-hint the installed kokoro-onnx
honors. Fix the ImportError remediation text (`main.py:765`) which hard-codes
"onnxruntime-gpu needs an NVIDIA GPU" → make it profile-aware.

**CUDA-poison detection — extend for HIP.** `_CUDA_POISON_RE` (`main.py:166`) matches
CUDA/CUBLAS phrases to flag a corrupted context and trigger the supervised restart.
ROCm emits `HIP error` / `rocBLAS` / `hipBLAS` strings it misses; add them so a
poisoned ROCm context self-heals.

## Section 5 — `/health` device truth + VRAM/telemetry honesty

Extend the existing per-engine device-truth probe (side-14:
`_compute_device_predictions`, `_normalize_device_family`, `/health` → `devices` +
`devices_state`), don't rebuild it.

1. **Add `rocm` + `directml` to the family vocabulary.** Torch engines: feed the
   `torch.version.hip` introspection so a HIP build reports `rocm` not `cuda` (touches
   `_normalize_device_family` + `_compute_device_predictions`). Kokoro: map session
   providers `DmlExecutionProvider→directml`, `CUDAExecutionProvider→cuda`,
   `ROCMExecutionProvider→rocm`, else `cpu` (both the loaded-session path and the
   `get_available_providers()` prediction path). The fs-43 /about panel then shows
   "ROCm" / "DirectML" with at most a label-formatting map.
2. **VRAM telemetry — measure what we can, say `unknown` for the rest.**
   - Prefer `torch.cuda.mem_get_info()` for resident torch-engine VRAM — works
     identically under ROCm/HIP (vendor-neutral; better than the nvidia-smi shell-out
     even on NVIDIA). Optional whole-GPU fallback via `rocm-smi` where present.
   - DirectML VRAM is unmeasurable → report **`unknown`, never `0`** (`0` would lie to
     the watchdog as headroom).
   - **Fail-safe when VRAM is `unknown`:** disable VRAM-based eviction and the
     committed-ceiling recycle trigger; rely on the host-RAM watchdog + configured
     budgets only. Prevents both the recycle-storm and false-headroom-OOM failure modes
     on AMD by not making VRAM-math decisions it cannot measure.
3. **Engine mutual-exclusion stays conservative** — the Coqui ↔ analyzer ↔ Kokoro
   evict-to-free rules remain in force (correctness, not optimization); we just stop
   relying on precise VRAM arithmetic to relax them.
4. **`nvidia-smi` contention probe** (pre-commit throttle, supervisor) no-ops on AMD —
   the GPU-contention auto-throttle never fires on an AMD dev box. Accepted; a
   `rocm-smi` equivalent is out of scope.

## Section 6 — Wizard UX + messaging

Everything plugs into existing surfaces (fs-21 wizard, fs-43 /about device panel,
#/advanced, fe-29 Help/failure-remediation taxonomy).

1. **Profile in the setup wizard.** The environment/readiness step shows the detected
   vendor in plain language ("AMD Radeon detected — using ROCm for voice design and
   DirectML for narration") with an override control (Auto-detected / NVIDIA / AMD /
   CPU). Persists to user-settings and becomes the `profile` in `.venv-stamp.json`.
2. **The upgrade migration prompt** (Section 2): one clear modal —
   *"Castwright v1.8.0 needs a one-time setup update: a newer Python (3.12) and the
   libraries for your GPU. Your books and designed voices are safe and won't be
   touched. This takes about 5–15 minutes."* → [Update now] — then automatic progress
   (Checking Python → Installing Python 3.12 → Rebuilding voice engines → Verifying
   GPU). Python-3.12 auto-install runs inline; only its failure shows guided steps + a
   download link. No "delete this folder" instructions anywhere.
3. **Per-engine backend truth in /about:** Narration (Kokoro): DirectML · Voice design
   (Qwen): ROCm · Coqui: ROCm · Content-check (Whisper): CPU — with an inline
   "AMD GPU support is in preview" note.
4. **#/advanced surfaces the `ACCELERATOR` override** with the existing
   locked-by-`.env` + drift-guard behavior.
5. **Failure messaging via the existing taxonomy:** a new
   "GPU acceleration unavailable — running on CPU" failure-remediation entry listing
   likely causes (driver/Adrenalin version, unsupported gfx target, preview-wheel
   instability) + links. Keeps the FailureCode lockstep discipline (taxonomy +
   remediations + openapi + help titles + parity test move together).
6. **Limitations stated, not buried** — AMD-Linux Kokoro→CPU and Whisper→CPU-always
   appear as plain notes in the device panel.

## Section 7 — Testing strategy (real coverage with zero AMD hardware)

~90% is genuinely unit-tested on existing runners by making the decision logic pure
and mockable; the irreducibly-hardware 10% becomes an explicit manual acceptance
matrix (the project's "OWED live-GPU acceptance" pattern), not faked coverage.

1. **Resolver matrix tests (backbone).** `accelerator-profile.mjs` pure functions →
   exhaustive table tests of every `(detected, override, platform) → profile` and
   `(profile, engine, platform) → {installRecipe, runtimeBackend, ortProviders}`.
   Includes a pinned assertion that the **NVIDIA recipe is unchanged** (cu124 index,
   `onnxruntime-gpu`) except the cp312 tag — the regression fence for existing testers.
2. **Detection-probe tests** with injected `exec` against canned
   `Win32_VideoController` / `lspci` / `rocminfo` output (AMD, NVIDIA, both, none,
   malformed → `unknown`→`cpu`).
3. **Sidecar device-resolution tests** extending `test_device_probe.py`: `_StubTorch`
   gains `version.hip`/`version.cuda` (assert `rocm` vs `cuda`); `_StubOrt` returns
   `['DmlExecutionProvider',…]` (assert `directml`); new amd-win / amd-linux prediction
   cases; a stub `Kokoro` rejecting the `providers=` kwarg (assert `try/except
   TypeError` fallback); extended `_CUDA_POISON_RE` matches `HIP error`/`rocBLAS`.
4. **Venv-migration tests (highest-risk, fully fakeable)** via the injected
   `ApplySteps` + exported `bootstrap-venv.mjs` helpers: stamp `pythonTag` mismatch →
   teardown+rebuild with **build-`.venv-next`-then-swap order** and **old venv preserved
   on rebuild failure**; profile mismatch → rebuild; reqHash-only → pip-in-place;
   all-match → no-op; **Python-3.12-missing → abort pre-flight, assert `rmDir` never
   called** (the safety property for the easy-upgrade promise).
5. **Installer-recipe tests** extending the pure `resolveFlashAttnInstall` (cp312 +
   amd-skip) and asserting resolver-driven index-url / package / tag per profile with
   `spawn` faked.
6. **CI changes (flagged):** all the above run on existing NVIDIA/CPU/mock runners —
   no AMD CI hardware. But unify-on-3.12 means the CI matrix + `cross-os.yml` move the
   sidecar to Python 3.12 (a real edit; also catches cp312 wheel surprises on
   Ubuntu/macOS/Windows runners). Sidecar tests keep SKIP-on-unbootstrapped-venv.
7. **The honest gap → manual AMD acceptance matrix** (ships in the regression plan
   under `docs/features/`): per-engine generate on AMD, `/about` shows ROCm/DirectML,
   upgrade-from-1.7.0 triggers rebuild and preserves books/voices, Python-3.12-absent
   auto-install path. Marked `OWED`.

## Risks & mitigations

- **ROCm-Windows PyTorch is preview** → label experimental; fail-safe to CPU with an
  honest `/health` reason + Help remediation; never claim it works untested.
- **Existing NVIDIA testers must rebuild their venv on 3.12** → automatic, atomic,
  weights preserved, one prompt; working env never destroyed on failure.
- **kokoro-onnx may not honor `providers=`** across versions → `try/except TypeError`
  fallback + env-hint belt-and-suspenders.
- **VRAM unmeasurable on DirectML** → report `unknown`, disable VRAM-math decisions,
  lean on host-RAM watchdog.
- **No AMD hardware to verify** → pure-function resolver + mock-heavy tests give real
  green coverage; the rest is an explicit owed acceptance matrix.

## Out of scope

- Analyzer (Ollama) changes — already vendor-neutral via its own ROCm builds.
- Whisper GPU acceleration on AMD — no ROCm/DirectML CTranslate2 backend exists.
- Kokoro GPU on AMD-Linux (source-built ROCm ONNX Runtime) — CPU EP fallback only.
- A `rocm-smi` dev-box contention probe.
- Apple/mps behavior changes — named for completeness, otherwise untouched.

## Acceptance (owed — requires an AMD-owning tester)

- [ ] Fresh install on AMD-Windows: all three engines report GPU backends in /about
      (Kokoro=DirectML, Qwen=ROCm, Coqui=ROCm), generation produces audio.
- [ ] Fresh install on AMD-Linux: Qwen/Coqui=ROCm, Kokoro=CPU (as designed).
- [ ] Upgrade from v1.7.0: one prompt, automatic rebuild, books + designed voices
      intact, ends on Python 3.12.
- [ ] Python-3.12-absent box: auto-install succeeds (or guided fallback works) and the
      working install is never broken mid-flight.
- [ ] Override: forcing `ACCELERATOR=cpu` on an AMD box triggers a rebuild and reports
      CPU honestly.
