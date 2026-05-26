# Local TTS sidecar

FastAPI process that the Node backend talks to when a user picks a local
TTS engine (default: Coqui XTTS v2). Lives in its own venv so the Coqui +
torch dependency tree doesn't leak into Node tooling.

## Python version

Coqui TTS (and its torch dependency) need **Python 3.10, 3.11, or 3.12**.
Python 3.13 and 3.14 don't have wheels available for the ML deps yet.
3.11 is the safest choice.

Install Python 3.11 alongside whatever else you have:

```powershell
winget install --id Python.Python.3.11
```

Confirm it's available — `py -3.11 --version` should print `Python 3.11.x`.

## One-time setup

From the repo root, on Windows / PowerShell. Note: we invoke the venv's
`python.exe` directly instead of `Activate.ps1`, so this works under the
default `Restricted` execution policy.

```powershell
cd server\tts-sidecar
# Use the Python 3.11 launcher explicitly so the venv binds to 3.11.
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
# Install PyTorch separately — coqui-tts deliberately excludes it from its
# dependencies so you choose CPU vs CUDA. See "GPU install" below for the
# fast path; the CPU index works everywhere as a fallback.
.\.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
# Then the rest of the requirements.
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

If the venv was already created against the wrong Python (e.g. 3.14), delete
the folder first: `Remove-Item -Recurse -Force .venv`.

## GPU install (recommended if you have an NVIDIA card)

XTTS v2 on CPU runs at real-time factor ~3× (one second of audio ≈ three
seconds of compute). On a modern NVIDIA GPU with the CUDA PyTorch wheel
plus `COQUI_HALF=1` and `COQUI_DEEPSPEED=1`, RTF drops to ~0.1–0.2× —
**10–25× faster** for the same code path.

If you already installed the CPU wheel above, uninstall it first:

```powershell
.\.venv\Scripts\python.exe -m pip uninstall -y torch torchaudio torchcodec
```

Then install the CUDA build. The `cu124` index matches CUDA 12.4 (the
broadest-compatible recent toolkit; works fine with newer NVIDIA drivers).
Run `nvidia-smi` first to confirm a GPU is present:

```powershell
.\.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
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

## FlashAttention-2 (optional, Windows / Python 3.11)

FlashAttention-2 is the attention backend `qwen_tts` is built for — its model
classes set `_supports_flash_attn = True` and the upstream `qwen-tts-demo`
defaults `--flash-attn` on. We still default to **SDPA**: it needs no extra
dependency and is the right call for the autoregressive decode loop. FA2 is
installable here if you want to benchmark it.

Upstream `flash-attn` ships **no Windows wheel** on PyPI and the source build is
a notorious Windows headache. The install script instead pins a community
prebuilt wheel that matches our exact stack (torch 2.6.0/cu124, CPython 3.11,
win_amd64). It's **opt-in** and **non-fatal** — any other platform/Python skips,
and a failed install just leaves you on SDPA:

```powershell
# folded into the normal install:
node scripts\install-qwen3.mjs --flash-attn
# or into an already-installed venv:
.\.venv\Scripts\python.exe -m pip install https://huggingface.co/lldacing/flash-attention-windows-wheel/resolve/main/flash_attn-2.7.4+cu124torch2.6.0cxx11abiFALSE-cp311-cp311-win_amd64.whl
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

## License note

XTTS v2 ships under the Coqui Public Model License (CPML), which restricts
commercial use of the model weights. This project is local-only / personal,
which is compatible. Read the license before redistributing generated audio.
