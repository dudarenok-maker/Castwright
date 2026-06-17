# Local TTS sidecar

FastAPI process that the Node backend talks to when a user picks a local
TTS engine (default: Coqui XTTS v2). Lives in its own venv so the Coqui +
torch dependency tree doesn't leak into Node tooling.

## Key versions

| Component | Version | Notes |
|---|---|---|
| **Python** | **3.12** (exactly) | bootstrap probes for 3.12 and refuses anything else; venv stamped `cp312` |
| **PyTorch** | **`torch==2.11.0` + `torchaudio==2.11.0`** (matched pair, pinned in `requirements/nvidia-cuda.txt`) | needed by Coqui + Qwen (Kokoro doesn't use torch); the sidecar does all audio I/O via soundfile + ffmpeg and never calls `torchaudio.load`, so torchaudio's 2.9 backend removal doesn't affect it (no torchcodec) |
| → NVIDIA GPU | PyPI default = CUDA-bundled wheel; or pre-install `--index-url https://download.pytorch.org/whl/cu128` for **CUDA 12.8** | ~2.5 GB |
| → CPU / macOS | PyPI default = CPU / MPS build | |
| coqui-tts | `>=0.24.0` (resolves ~0.27.x), **no `[codec]` extra** | 0.27.5 dropped its transitive torch (torch now explicit); `[codec]` dropped → no torchcodec |
| **torchcodec** | **not installed** | the sidecar does all audio I/O via soundfile + ffmpeg and never calls `torchaudio.load`, so torchaudio's 2.9 backend removal doesn't affect it — no torchcodec needed |
| kokoro-onnx | `>=0.4.0,<0.5.0` (plain, **no `[gpu]`**) | overlay lands core `onnxruntime` (CPU); `install-ort.mjs` swaps in `onnxruntime-gpu` on the nvidia profile. `[gpu]` is avoided — it coexists with the core dep and can silently leave CPU onnxruntime winning. No torch |
| transformers | `>=4.45,<5.0` | coqui-tts compat cap |

## Accelerator profiles (NVIDIA / AMD / CPU / Apple)

The install picks an **accelerator profile** for the box and installs the matching
requirements overlay. It resolves as **`ACCELERATOR` env override → the existing
venv's stamped profile (carry-forward) → hardware detection → cpu**, so an existing
install is never force-migrated by a re-detect; only an explicit override switches it.
Set it in `server/.env`, via the first-run wizard, or the `#/advanced` **Accelerator
profile** knob (a change rebuilds the venv).

| Profile | Overlay | torch | Kokoro (ONNX) |
|---|---|---|---|
| `nvidia` (default) | `nvidia-cuda.txt` | PyPI CUDA wheel | `onnxruntime-gpu` |
| `cpu` / `apple` | `cpu.txt` / nvidia-cuda | PyPI cpu/mps wheel | `onnxruntime` (CPU/CoreML) |
| `amd` *(experimental preview)* | `amd-rocm.txt` | **ROCm** preview wheels (repo.radeon.com), pre-installed by `install-torch.mjs` | **CPU** — see below |

**AMD notes:** Qwen/Coqui run on **ROCm** torch (`torch.version.hip` → reported as
`rocm` in `/health`). Kokoro runs on **CPU**: DirectML was validated on-box and
**cannot run the Kokoro model** (the `onnxruntime-directml` ConvTranspose op fails;
see `side-16` / #819). The AMD install is **best-effort with a CPU fallback** — if the
alpha ROCm wheels fail to install, the bootstrap degrades to a working CPU install
(writes `.accelerator-fallback.json`, stamps `cpu`) rather than failing. AMD is an
experimental preview pending beta validation on a ROCm-supported card.

## Python version

The sidecar requires **Python 3.12** (exactly). The installer/bootstrap probes
for a 3.12 interpreter and refuses anything else, because the venv is stamped with
its Python tag (`cp312`) and a mismatch triggers a forced reinstall. Python ≤3.11
and ≥3.13 are not accepted (3.13/3.14 also still lack wheels for some ML deps).

Install Python 3.12 alongside whatever else you have:

```powershell
winget install --id Python.Python.3.12
```

Confirm it's available — `py -3.12 --version` should print `Python 3.12.x`.

> **Upgrading from an older install (pre-3.12 venv)?** A venv is bound to the
> Python it was built with, so a 3.11 venv can't be upgraded in place. Delete it
> and re-bootstrap (`Remove-Item -Recurse -Force .venv`). Your books and designed
> voices are **safe** — they live in the workspace dir, not the venv. The app
> detects a mismatched venv and guides you to reinstall.

## One-time setup

From the repo root, on Windows / PowerShell. Note: we invoke the venv's
`python.exe` directly instead of `Activate.ps1`, so this works under the
default `Restricted` execution policy.

```powershell
cd server\tts-sidecar
# Use the Python 3.12 launcher explicitly so the venv binds to 3.12.
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
# Install everything, including PyTorch. torch + torchaudio are now EXPLICIT,
# pinned to the matched 2.11.0 pair (recent coqui-tts no longer pulls torch
# transitively; the sidecar does all audio I/O via soundfile + ffmpeg and never
# calls torchaudio.load, so torchaudio's 2.9 backend removal doesn't affect it —
# no torchcodec needed). On Windows / Linux x86_64 PyPI gives the CUDA-bundled wheel; on macOS
# the CPU/MPS build. No separate torch step is needed for the common case.
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The CUDA-bundled torch download is ~2.5 GB.

If the venv was created against the wrong Python (e.g. 3.11/3.14), delete the
folder first: `Remove-Item -Recurse -Force .venv`.

### Forcing a specific torch build (optional)

The requirements install pulls the PyPI-default `torch==2.11.0` (CUDA-bundled on
Windows/Linux, CPU/MPS on macOS), which is what most setups want. If you need a
**specific** build — e.g. CPU-only torch on a GPU box, or a particular CUDA
toolkit — pre-install the **matched 2.11.0 pair** BEFORE the requirements (pip then
leaves the `==2.11.0` pins satisfied):

```powershell
# CPU-only (smaller; no CUDA libs):
.\.venv\Scripts\python.exe -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cpu
# …then:
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## GPU install (NVIDIA)

XTTS v2 on CPU runs at real-time factor ~3× (one second of audio ≈ three
seconds of compute). On a modern NVIDIA GPU with the CUDA PyTorch wheel
plus `COQUI_HALF=1` and `COQUI_DEEPSPEED=1`, RTF drops to ~0.1–0.2× —
**10–25× faster** for the same code path.

**On Windows / Linux x86_64 the default requirements install already gives you a
CUDA-bundled torch** (the PyPI-default wheel), so GPU works out of the box — no
separate step. You only need the explicit index below to pick a **specific** CUDA
toolkit version.

### Picking a specific CUDA build (e.g. CUDA 12.8)

PyTorch ships per-CUDA wheels behind `--index-url`. Pre-install the **matched
2.11.0 pair** for your toolkit BEFORE the requirements (pip then leaves the
`==2.11.0` pins satisfied). Run `nvidia-smi` first to confirm a GPU.

```powershell
# Replace any default torch first if you want to switch CUDA builds:
.\.venv\Scripts\python.exe -m pip uninstall -y torch torchaudio
# CUDA 12.8 (the validated pair):
.\.venv\Scripts\python.exe -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
# (for a different CUDA toolkit, swap cu128 for the matching index from pytorch.org/get-started/previous-versions)
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The CUDA download is ~2.5 GB. After install, flip the env (in `server/.env`):

```
COQUI_DEVICE=cuda
COQUI_HALF=1
COQUI_DEEPSPEED=0
```

Restart the sidecar (`npm run tts:sidecar`). The startup log should show:

```
[sidecar] Loading Coqui model=… on device=cuda half=True deepspeed=False …
[sidecar] Model cast to fp16.
```

Run `nvidia-smi` while a synth is in flight — `python.exe` should appear
with ~2–3 GB of VRAM and >50% GPU-Util. If it doesn't, the venv still has
the CPU wheel; re-run the uninstall + install above.

### GPU clock / power floor (keep the card from down-clocking)

Sustained TTS decode fires many tiny GPU kernels with short CPU gaps
between them. On a laptop / consumer GPU the clock governor reads that
gappy load as "idle" and parks the SM clock low (we've seen ~400 MHz on a
3105 MHz-capable card during decode), which slows compute-bound engines.
The settings below pin a performance floor so the card stays clocked up.
Do them once per dev box — they're baseline hygiene for any sustained GPU
compute, not Qwen-specific.

1. **Windows power plan → High performance.** Balanced lets the OS
   down-clock aggressively. Set High performance:

   ```powershell
   # SCHEME_MIN is the built-in "High performance" plan.
   powercfg /setactive SCHEME_MIN
   # If it's missing on Windows 11 (some SKUs hide it), recreate it first:
   #   powercfg -duplicatescheme 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c
   # Confirm which plan is active:
   powercfg /getactivescheme
   ```

2. **NVIDIA Control Panel → Manage 3D settings → Power management mode →
   "Prefer maximum performance".** Set it globally, or per-program for
   `python.exe` (the sidecar interpreter) under the Program Settings tab.
   GUI-only toggle — no stable CLI equivalent on GeForce.

3. **Lock the GPU clock floor (optional, admin shell).** `nvidia-smi
   -lgc <min>,<max>` pins the SM clock between min and max so it can't sag
   during the gappy decode:

   ```powershell
   # Floor 2100 MHz, ceiling 3105 MHz (values are this 4070's range —
   # check yours with: nvidia-smi -q -d SUPPORTED_CLOCKS).
   nvidia-smi -lgc 2100,3105
   # Or pin flat at max:
   #   nvidia-smi -lgc 3105,3105
   # Revert to the driver default when done:
   nvidia-smi -rgc
   ```

   Verify it holds during a synth — the `sm` clock should stay near the
   floor instead of dropping:

   ```powershell
   nvidia-smi dmon -s pc   # live `sm` clock + `pwr` columns
   ```

**Honest caveat — this did NOT speed up Qwen on our box.** Qwen's
autoregressive decode is *dispatch-bound* (CPU-launch-latency-bound), not
clock-bound: the GPU finishes each tiny kernel fast and then waits on the
next launch, so forcing the clock high (2100 → 3105) left the measured RTF
unchanged (see `../../docs/tts-performance.md`). Set the floor anyway — it
removes clock-sag as a variable and helps the *compute-bound* engines
(Coqui XTTS, Kokoro) — but the path past Qwen's dispatch-bound ceiling is
batching + the blocked CUDA-graph fork (`docs/features/129-qwen-decode-cuda-graph-spike.md`),
not clocks.

### VRAM headroom — disable the sysmem fallback (prevent the silent spill)

On Windows the NVIDIA driver defaults to a **"CUDA – Sysmem Fallback Policy"**
that, when a CUDA allocation would exceed the physical card, *silently maps the
overflow into system RAM* instead of failing. It looks like the program keeps
running — but every access to the spilled memory now crosses PCIe, so the GPU
sits at ~100% util while throughput collapses (RTF goes from ~1 to ~5+). This is
the 2026-06-01 stall: a Qwen model reload had stacked a second copy past the
8 GB card (plan 161), reserved VRAM climbed to ~17 GB, and generation crawled
instead of erroring.

The sidecar already recycles itself out of a spill (the reserved-VRAM watchdog,
plan 161), and `unload()` no longer stacks copies — but you should also disable
the fallback so a genuine over-card allocation **OOMs cleanly** (fast, the
recycle catches it) rather than thrashing invisibly:

1. **NVIDIA Control Panel → Manage 3D settings → Program Settings → `python.exe`
   (the sidecar interpreter) → "CUDA – Sysmem Fallback Policy" → "Prefer No
   Sysmem Fallback".** GUI-only on GeForce (driver R546+). Set it per-program so
   it doesn't affect other apps.
2. **Curb allocator fragmentation** (which is what creeps the reserved pool past
   the card on long variable-shape runs) by setting in `server/.env` *before*
   starting the sidecar — it inherits the server env, so a running sidecar must
   be restarted to pick it up:

   ```
   PYTORCH_CUDA_ALLOC_CONF=garbage_collection_threshold:0.8,max_split_size_mb:256
   ```

   `expandable_segments` is **unsupported on Windows** (torch logs a warning) —
   do not set it.

The watchdog logs `sidecar memory: … vram_reserved=R/T MB` each tick and a loud
`VRAM SPILL` warning if `R > T`; `/health` and `/debug/memory` expose
`vram_reserved_mb` / `vram_total_mb` so you can watch headroom without
`nvidia-smi`.

### Optional: DeepSpeed (extra ~1.5–2× on top of CUDA + fp16)

DeepSpeed fuses the kernel launches in XTTS's autoregressive GPT decoder,
which is where the remaining time goes after CUDA + fp16. On Windows it is
**not pip-installable directly** — the PyPI wheel is built against torch 2.3
and refuses to load against our torch 2.6, and the PyPI sdist has half a
dozen Windows-specific bugs that have to be worked around manually. The
procedure below is the _actually-working_ recipe we figured out the hard
way. Plan ~30 min wall time the first time.

#### Prerequisites

1. **NVIDIA CUDA Toolkit 12.4** — must match the torch wheel's CUDA major.
   Get it from <https://developer.nvidia.com/cuda-12-4-0-download-archive>
   (Windows / x86_64 / 11 / exe local). ~3 GB. The installer sets
   `CUDA_PATH=…\v12.4` but **does NOT always add `nvcc` to PATH** — that
   is expected, DeepSpeed reads `CUDA_HOME`/`CUDA_PATH` directly.

2. **Visual Studio Build Tools 2022 (C++ workload)** — DeepSpeed compiles
   its CUDA kernels through `cl.exe`. Get it via winget:

   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools `
     --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

   ~3 GB. No reboot needed; UAC will prompt.

3. **`wheel` package in the sidecar venv** — pip needs `bdist_wheel` to
   build deepspeed from source, and a fresh `python -m venv` skips it:
   ```powershell
   .\.venv\Scripts\python.exe -m pip install wheel
   ```

#### Install procedure

```powershell
# 1. Wire CUDA + MSVC env into the current shell.
$env:CUDA_PATH = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.4"
$env:CUDA_HOME = $env:CUDA_PATH
$env:PATH = "$env:CUDA_PATH\bin;$env:CUDA_PATH\libnvvp;$env:PATH"
$vcvars = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
}
$env:CUDA_HOME = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.4"  # vcvars stomps it; reset

# 2. Tell DeepSpeed's setup.py to skip the bash-only git probe and lazy-compile ops.
$env:DS_BUILD_OPS = "0"
$env:DS_BUILD_STRING = "+local"  # PEP 440-compliant version suffix; also bypasses bash

# 3. Download the sdist, fix the Windows packaging bug, install from the
#    extracted dir. Don't `pip install deepspeed` directly — the PyPI wheel
#    is pinned to torch 2.3 and will fail at import (PyTorch version mismatch).
$tmp = "$env:TEMP\deepspeed-0.15.4"
Invoke-WebRequest "https://files.pythonhosted.org/packages/source/d/deepspeed/deepspeed-0.15.4.tar.gz" -OutFile "$tmp.tar.gz"
tar -xzf "$tmp.tar.gz" -C $env:TEMP
# Stub the missing Windows launchers (setup.py declares them in `scripts=`
# but they aren't in the sdist — known DeepSpeed 0.15.x sdist bug).
Set-Content "$tmp\bin\deepspeed.bat" "@echo off`r`npython -m deepspeed.launcher.runner %*"
Set-Content "$tmp\bin\ds_report.bat" "@echo off`r`npython -m deepspeed.env_report %*"

cd C:\Users\dudar\OneDrive\Documents\Claude\Projects\Audiobook-Generator\server\tts-sidecar
.\.venv\Scripts\python.exe -m pip install --no-build-isolation $tmp

# 4. Patch transformer_inference op_builder so MSVC link.exe sees cublas.lib + curand.lib.
#    Upstream returns `['-lcurand']` which MSVC ignores (LNK4044), and the op actually
#    uses cublas symbols too → 7 unresolved externals at link time. See troubleshooting.
$opBuilder = ".\.venv\Lib\site-packages\deepspeed\ops\op_builder\transformer_inference.py"
(Get-Content $opBuilder -Raw) `
    -replace "return \['-lcurand'\]\s*\n\s*else:\s*\n\s*return \[\]", `
@"
import sys
            if sys.platform == 'win32':
                return ['cublas.lib', 'curand.lib']
            return ['-lcurand', '-lcublas']
        else:
            return []
"@ | Set-Content $opBuilder -Encoding UTF8
```

#### Activating it

1. Set `COQUI_DEEPSPEED=1` in `server/.env`.
2. **Launch the sidecar from a shell that has CUDA + MSVC env wired** —
   DeepSpeed lazy-compiles `transformer_inference.pyd` on first synth, and
   that compile needs `nvcc` + `cl.exe` reachable. The simplest is to use
   the same PowerShell session you ran the install in, then `npm run
tts:sidecar`. If you start the sidecar from a fresh shell without the
   env wired, the compile will fail and DeepSpeed falls back to vanilla
   mode (sidecar still works, just no speedup).
3. First synth after restart takes 30–60 s longer than usual — that's the
   ninja → nvcc → cl.exe op compile. Subsequent calls are the steady state.

The sidecar logs `DeepSpeed inference enabled.` once the build succeeds.
If it logs `DeepSpeed enable failed (…)`, search the `…` for the cause:

- `PyTorch version mismatch` → wheel install slipped through, redo step 3.
- `Error building extension 'transformer_inference'` → ninja log under
  `%LOCALAPPDATA%\torch_extensions\torch_extensions\Cache\py311_cu124\transformer_inference\`
  has the real error. Most likely: missing `cublas.lib`/`curand.lib` in
  link line (step 4 patch was skipped or got overwritten by a reinstall).
- `Cannot find file 'bin\deepspeed.bat'` → sdist patch (step 3 stub) was
  skipped.

## Kokoro v1 (second local engine, English-only)

Kokoro v1 is a lightweight quality-tuned TTS model that runs alongside
Coqui XTTS v2 in the same sidecar process. It is the default engine for
new accounts. Compared to XTTS:

- **~1 GB VRAM with the GPU runtime** (vs ~3 GB for XTTS) — small enough
  to stay permanently resident, so there is no Load/Stop pill for it.
- **28 baked English voices** (American + British, female + male). Other
  languages from Kokoro's manifest are filtered out at the sidecar
  boundary; this project is English-only.
- **No voice cloning** — pick from the catalog. XTTS remains available
  for its zero-shot cloning if/when the UI surfaces it.
- **ONNX runtime** — `kokoro-onnx` + `onnxruntime-gpu` (or `onnxruntime`
  for CPU-only). Pure-Python install, no DeepSpeed/CUDA Toolkit dance.

### Install

The Python deps land via `requirements.txt` (already added). The model
weights (~330 MB) are gitignored and downloaded by a helper script:

```powershell
cd server\tts-sidecar
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
powershell -ExecutionPolicy Bypass -File scripts\install-kokoro.ps1
```

That drops `kokoro-v1.0.onnx` and `voices-v1.0.bin` into
`server/tts-sidecar/voices/kokoro/`. The script is idempotent (re-runs
skip already-downloaded files) and failure-tolerant (wipes partial
downloads so the next run retries cleanly).

If you put the weights elsewhere, point the sidecar at them via env:

```
KOKORO_MODEL_PATH=D:\kokoro\kokoro-v1.0.onnx
KOKORO_VOICES_PATH=D:\kokoro\voices-v1.0.bin
```

Kokoro auto-preloads at sidecar startup (~1 s cold load). If the weights
aren't installed yet, the sidecar logs a warning and stays alive on the
Coqui path; install Kokoro and restart to pick it up.

### Pause OneDrive sync before installing

`pip install kokoro-onnx onnxruntime-gpu` and the weight downloads can
both trip the OneDrive lock trap below. Pause sync first (system tray →
Pause sync) or pre-purge `__pycache__` / `*.dist-info` dirs as described
in the troubleshooting section.

## Windows install troubleshooting

A non-exhaustive list of gotchas this sidecar has eaten on Windows. Most
of these have one-line fixes; this section is here so you don't have to
re-derive them.

**OneDrive sync locks pip uninstalls.** If the repo lives under
`%USERPROFILE%\OneDrive\…` (this one does), `pip uninstall` and pip's
upgrade-stash dance fail mid-transaction with
`PermissionError: [WinError 5] Access is denied` on `__pycache__` or
`*.dist-info` dirs. OneDrive's file watcher acquires brief locks that
collide with pip's move-then-delete pattern. **Workaround**: pause
OneDrive sync (system tray → Pause sync), or pre-purge the offending
dirs manually before pip:

```powershell
Remove-Item -Recurse -Force .\.venv\Lib\site-packages\<package>
Remove-Item -Recurse -Force .\.venv\Lib\site-packages\<package>-*.dist-info
```

Direct PowerShell `Remove-Item` works where pip's `shutil.move` fails.
After install, sweep ghost `~*` dirs to silence pip warnings:

```powershell
Get-ChildItem .\.venv\Lib\site-packages\~* | Remove-Item -Recurse -Force
```

**`nvcc` not on PATH after CUDA Toolkit install.** Expected. The
installer sets `CUDA_PATH` but doesn't always prepend `%CUDA_PATH%\bin`
to PATH. Invoke nvcc by full path or set `CUDA_HOME = $env:CUDA_PATH`
before running anything that needs it.

**`npm run tts:sidecar` blocked by execution policy.** npm on Windows
ships both `.cmd` and `.ps1` shims; PowerShell prefers the `.ps1` which
trips `Restricted` execution policy. The package script itself uses
`-ExecutionPolicy Bypass` internally but you can't reach it through the
blocked shim. **Workaround**: call `npm.cmd run tts:sidecar` (the cmd
shim) — same end result, no policy check on the outer call.

**vcvars64.bat doesn't propagate into PowerShell directly.** It is a
cmd-only batch script. To bring its env into PowerShell, capture `set`
output after invoking it and re-export each line:

```powershell
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
}
```

Note: vcvars64.bat will overwrite `CUDA_HOME` if it had been set —
re-export it after sourcing.

**DeepSpeed PyPI wheel is built against torch 2.3.** `pip install
deepspeed` pulls a pre-built wheel that fails at import time:
`PyTorch version mismatch! Install torch version=2.3, Runtime torch
version=2.6`. **Workaround**: install from sdist (`pip install
--no-build-isolation <path-to-sdist>` — see DeepSpeed install
procedure above). `--no-binary=deepspeed` _should_ do the same but pip's
resolver drops to ancient 0.3.x versions when you set it, so direct
tarball install is the reliable path.

**DeepSpeed `setup.py` calls `bash -c git rev-parse`.** No `bash` on
Windows by default (and `vcvars64.bat` strips Git's bash from PATH even
if it was there). Set `DS_BUILD_STRING=+local` before pip install — it
bypasses the bash code path and stamps a PEP 440-compliant version
suffix.

**DeepSpeed 0.15.4 sdist is missing `bin/deepspeed.bat` and
`bin/ds_report.bat`.** `setup.py` declares them in the Windows `scripts=`
list but they aren't in the sdist tarball. Result: `error: [Errno 2] No
such file or directory: 'bin\\deepspeed.bat'` at `bdist_wheel` time.
**Workaround**: extract the sdist, create stub .bat files in `bin/`,
install from the extracted dir (see DeepSpeed install procedure above).

**DeepSpeed `transformer_inference` op uses Unix `-l<name>` ldflags.**
MSVC link.exe ignores them (LNK4044) so `curand.lib` doesn't get linked,
and the op_builder doesn't request `cublas.lib` at all even though the
op uses `cublasCreate_v2`/`cublasGemmEx`. Result: `LNK2019: unresolved
external symbol` for 7 cublas/curand symbols, no `.pyd` produced.
**Workaround**: patch `deepspeed/ops/op_builder/transformer_inference.py`
`extra_ldflags()` to return `['cublas.lib', 'curand.lib']` on Windows.
The patch is in the DeepSpeed install procedure above. **It gets blown
away on reinstall** — re-apply if you reinstall deepspeed.

**`wheel` package missing from a fresh venv.** Modern `python -m venv`
sets up `pip` and `setuptools` but **not** `wheel`. DeepSpeed's source
build needs `bdist_wheel`; without it you get `error: invalid command
'bdist_wheel'`. **Workaround**: `pip install wheel` in the venv before
installing any package that builds from source.

## Running

From the repo root:

```
npm run tts:sidecar
```

That invokes the venv's `python.exe` to run `uvicorn main:app --host 127.0.0.1 --port 9000`.
Alternatively, run it manually:

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 9000
```

The model loads lazily on the first /synthesize call. Expect 5-10s of load
time and ~3 GB resident memory for XTTS v2 on CPU.

## Smoke test

```powershell
# Health check (instant — no model load).
Invoke-RestMethod http://localhost:9000/health

# Synthesize a sentence. The response is raw 16-bit LE mono PCM at the
# rate in X-Sample-Rate. Node encodes it to MP3 before persisting; for a
# standalone test, save the raw bytes and feed them to ffmpeg manually.
$body = @{ engine='coqui'; model='xtts_v2'; voice='Claribel Dervla'; text='Hello, this is a test of the local TTS sidecar.' } | ConvertTo-Json
$resp = Invoke-WebRequest -Uri http://localhost:9000/synthesize -Method Post -ContentType 'application/json' -Body $body
$resp.Headers['X-Sample-Rate']
[IO.File]::WriteAllBytes("$pwd\sample.raw", $resp.Content)
```

## Environment

- `COQUI_LANGUAGE` (default `en`) — language code passed to XTTS.
- `COQUI_DEVICE` (default `auto`) — `cpu`, `cuda`, or `auto`. `auto` picks
  `cuda` when `torch.cuda.is_available()`, else falls back to `cpu`.
- `COQUI_HALF` (default: on when device=cuda, forced off on cpu) — fp16
  weight cast. ~30–50% faster on GPU, no audible quality loss in practice.
  Set `COQUI_HALF=0` to fall back to fp32 if a specific voice degrades.
- `COQUI_DEEPSPEED` (default: on when device=cuda, forced off on cpu) —
  enables DeepSpeed-inference for the XTTS GPT autoregressive decoder.
  Roughly doubles GPU throughput. Best-effort: if deepspeed isn't installed
  the sidecar logs a warning and continues in vanilla mode.
- `PRELOAD_COQUI` (default `1`) — load XTTS at startup so the first
  /synthesize doesn't pay the 30–60s model-load cost on top of the synth.
  Set `0` for lazy load during protocol iteration.
- `KOKORO_MODEL_PATH` (default `voices/kokoro/kokoro-v1.0.onnx`) —
  override where the Kokoro ONNX weights live.
- `KOKORO_VOICES_PATH` (default `voices/kokoro/voices-v1.0.bin`) —
  override where the Kokoro voice manifest lives.
- `KOKORO_LANGUAGE` (default `en-us`) — espeak-ng language code passed to
  Kokoro's phonemiser. The voice IDs encode accent (`af_` American,
  `bf_` British), so this is mainly a phonemiser hint.
- `QWEN_ATTN_IMPL` (default `sdpa`) — attention implementation passed to the
  Qwen `from_pretrained` load. `sdpa` (PyTorch-native, no extra dependency)
  is the right default for the autoregressive decode loop. Set `eager` to
  measure the slow baseline, or `flash_attention_2` once the optional wheel is
  installed (see **FlashAttention-2** below). A build that rejects the kwarg
  falls back to the library default with a warning. The impl that actually took
  effect is logged at model load (`Qwen model=… attn_implementation=…`).
- `SIDECAR_DISABLE_MKLDNN` (default `0`/off) — **side-11 host-leak probe.** Qwen
  generation leaks committed-private host RAM monotonically: every sentence is a
  different length → a new native per-shape workspace that is never freed
  (committed climbs unbounded on variable-length generation, holds flat on fixed
  shapes; CUDA stays flat — pytorch/pytorch #32596). Setting this to `1` disables
  torch MKLDNN, which kills the suspected CPU per-shape workspace at a small
  CPU-op cost. Opt-in until a live A/B (`bench-tts.py --mem-sample`, below) proves
  the committed slope flattens. CPU-only flag — a no-op if the leak is on the CUDA
  allocator side. The `SIDECAR_RESTART_MB` process-recycle remains the backstop
  regardless.
- `SIDECAR_RECYCLE_SOFT_MB` (default `0`/off) — **side-11 item 2: soft recycle at
  the chapter boundary.** Once committed-private crosses this threshold the
  sidecar sets `recycle_pending: true` in `/health` (it does **not** exit). The
  generation worker reads that at each chapter boundary and POSTs `/recycle` to
  trigger a CLEAN recycle (drain → respawn) — so the leak-forced recycle lands
  *between* chapters and *earlier* than the hard `SIDECAR_RESTART_MB` ceiling
  (which fires late, after RTF has degraded, and can drain mid-chapter). Set it a
  few GB **below** `SIDECAR_RESTART_MB`. Opt-in (default off) until a live GPU run
  tunes it; the hard ceiling stays the untouched backstop. `POST /recycle` reuses
  the hard watchdog's drain→exit path verbatim (idempotent), and `/health` also
  carries `committed_mb` for boundary-decision observability.

## FlashAttention-2 (optional)

FlashAttention-2 is the attention backend `qwen_tts` is built for — its model
classes set `_supports_flash_attn = True` and the upstream `qwen-tts-demo`
defaults `--flash-attn` on. We still default to **SDPA**: it needs no extra
dependency, is the right call for the autoregressive decode loop, and benchmarks
at parity on TTS-decode-bound workloads — so skipping FA2 costs nothing measurable.

> **Not available on the current Python 3.12 stack.** Upstream `flash-attn` ships
> no Windows wheel on PyPI, so the install script pins a community prebuilt — but
> that wheel is `cp311 + torch-2.6 + cu124`-only and **does not load on the
> sidecar's Python 3.12 / current-torch stack**. So `--flash-attn` **auto-skips**
> and Qwen runs on SDPA. To use FA2 on 3.12 you'd have to source a matching
> prebuilt wheel (e.g. a `cp312` build for your exact torch/CUDA, such as the
> `cu130torch2.x` builds some community repos publish) and `pip install` it
> directly. It's **opt-in** and **non-fatal** either way.

```powershell
# folded into the normal install (auto-skips if no compatible wheel for your stack):
node scripts\install-qwen3.mjs --flash-attn
# or, if you've sourced a wheel matching your exact cp312 + torch + CUDA:
.\.venv\Scripts\python.exe -m pip install <path-or-url-to-your-cp312-flash_attn-wheel>
```

Then activate it: set `QWEN_ATTN_IMPL=flash_attention_2` in the sidecar env and
restart. Confirm it actually engaged (not a silent SDPA fallback) via the
model-load line: `Qwen model=… attn_implementation=flash_attention_2`.

> Installing the wheel also silences the upstream `flash-attn is not installed`
> banner — though that line is benign (transformers prints it whenever FA2 isn't
> present) and SDPA is unaffected either way.

> **Worth it? Measured 2026-05-26 (RTX 4070): no — FA2 ≈ SDPA.** FA2's win is
> largest on long-sequence *prefill*; TTS is single-token *decode*, so the gain is
> small and inconsistent. End-to-end chapter generation at `QWEN_BATCH_SIZE=8` was
> RTF ~1.19 (FA2) vs ~1.15 (SDPA) — SDPA marginally ahead and more stable. **SDPA
> stays the default; FA2 is a legit opt-in but not worth flipping.** Full data:
> [docs/tts-performance.md](../../docs/tts-performance.md). Re-measure on your GPU
> with `scripts/bench-tts.py` (below) if you want to confirm.

## Suppressed startup warnings

A clean Windows install + first Qwen model load print a few alarming-looking
warnings that are all no-ops here. We suppress them so a deployer's console only
shows warnings they must act on. Setup lives in `warning_filters.py`
(`configure_warning_filters()`, called from `main.py` at startup) and, for the
install prefetch subprocess, in `scripts/install-qwen3.mjs`.

| Warning | Why it's benign | How it's suppressed |
|---|---|---|
| HF Hub `...cache-system uses symlinks...` | Windows without Developer Mode can't create cache symlinks; HF Hub transparently falls back to file copies. | `HF_HUB_DISABLE_SYMLINKS_WARNING=1` — set in both the install subprocess env and the sidecar runtime env. We do **not** set `HF_HOME`/`HF_HUB_CACHE` (the engine ignores them, so the cache stays at its default location). |
| `SoX could not be found!` | A transitive torchaudio/coqui probe for the optional SoX backend. We do all audio I/O via soundfile + ffmpeg, so SoX is never used. | Message-scoped `warnings.filterwarnings` (narrowest scope — other `UserWarning`s still surface). |
| transformers `flash-attn is not installed` banner | SDPA is the correct default attention impl (see **FlashAttention-2** above); FA2 is an opt-in accelerator, not a missing requirement. | Message-scoped `warnings.filterwarnings`. Deployers who install the FA2 wheel silence it the upstream way regardless. |
| Qwen `code_predictor_config is None. Initializing code_predictor model with default values` | HuggingFace config-defaulting inside `qwen_tts`'s `Qwen3TTSTalkerConfig.__init__` at `from_pretrained` — a one-time load-time `logging.info`, **not** a per-sentence recompute (the design-time slowness that once drew the eye was generation-length-bound, fixed separately). | A logging filter (`_DropSubstringLogFilter`), not a warnings filter: `_suppress_code_predictor_log()` in `main.py` adds it to the root handlers only around the Qwen `from_pretrained` calls and removes it after (load-scoped, zero leak). Pinned by `tests/test_log_filter.py`. |

(The first three rows above are Python `warnings` suppressed via `warning_filters.py`; the
last row is a `logging` record, so it's dropped by a load-scoped log filter in `main.py` instead.)

Everything else stays visible by design — CUDA poison / OOM detail, model-load
failures, and the FA2-install warnings (which point at a retry action) are all
actionable and must reach the deployer.

## Benchmarking

`scripts/bench-tts.py` measures per-call wall time and real-time factor
(RTF = synth-time ÷ audio-seconds; <1 is faster than realtime) against a
running sidecar — so the Kokoro-vs-Qwen speed gap is a measured number, not a
felt one. Stdlib only; run it by hand (it needs the weights resident, so it's
not in CI).

```powershell
# Kokoro reference point:
python scripts\bench-tts.py --engine kokoro --voice af_heart

# Qwen, a designed voice (design it first via the app / POST /qwen/design-voice):
python scripts\bench-tts.py --engine qwen --voice <designedVoiceId>

# Does more concurrency help? Sweep it — aggregate throughput should rise only
# until the single GPU saturates (raise GPU_VRAM_BUDGET on the Node side first,
# else the global semaphore pins real concurrency to 1):
python scripts\bench-tts.py --engine qwen --voice <id> --concurrency 2
python scripts\bench-tts.py --engine qwen --voice <id> --concurrency 4
```

To compare the SDPA default against another backend, set `QWEN_ATTN_IMPL`
(`eager` for the slow baseline, or `flash_attention_2` for the optional wheel —
see **FlashAttention-2** above) in the sidecar env, restart it, run the bench,
then unset it and re-run. Confirm the model-load line reports the impl you set
before trusting the number.

### Host-leak slope A/B (`--mem-sample`, side-11)

`--mem-sample` drives many variable-shape batched calls, sampling
`/debug/memory` after each, and prints the **committed-private slope (MB/batch)**
— the metric the process-recycle keys on. A steep committed slope with flat CUDA
is the variable-shape host leak; a flat slope means a candidate fix bound it.
Reboot first (clean VRAM/process state), then A/B a fix off vs on:

```powershell
# 1. baseline — leak present (flag OFF):
python scripts\bench-tts.py --engine qwen --voice <id> --batch 16 --mem-sample --batches 200
# 2. restart the sidecar with the candidate fix, re-run IDENTICALLY:
$env:SIDECAR_DISABLE_MKLDNN='1'   # then restart the sidecar
python scripts\bench-tts.py --engine qwen --voice <id> --batch 16 --mem-sample --batches 200
```

PASS iff the flag-ON committed slope is ≈ flat (within ±2 MB/batch of the
`--bucket 1` length-tight control) while CUDA stays flat. The seeded corpus makes
the two runs byte-identical, so the slope delta is signal, not noise. `--out
series.csv` dumps the per-batch series (the only file the script writes).

## License note

XTTS v2 ships under the Coqui Public Model License (CPML), which restricts
commercial use of the model weights. This project is local-only / personal,
which is compatible. Read the license before redistributing generated audio.
