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

DeepSpeed is not in `requirements.txt` because its `setup.py` needs the
standalone NVIDIA CUDA Toolkit (with `nvcc`) at install time on Windows.
The CUDA runtime libraries that ship inside the PyTorch wheel aren't
enough. If you want this extra speedup:

1. Install the CUDA Toolkit 12.4 from
   <https://developer.nvidia.com/cuda-downloads> (~3 GB). Match the
   toolkit major version to the PyTorch wheel (`cu124` → CUDA 12.x).
2. Install deepspeed without pre-compiling ops (lazy compile on first
   use):
   ```powershell
   $env:DS_BUILD_OPS = "0"
   .\.venv\Scripts\python.exe -m pip install --no-build-isolation "deepspeed>=0.15,<0.16"
   ```
3. Set `COQUI_DEEPSPEED=1` in `server/.env` and restart the sidecar.

The sidecar logs a warning and continues in vanilla mode if DeepSpeed
isn't installed when the flag is on, so the toolkit install is opt-in.

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
# rate in X-Sample-Rate. Node wraps it in WAV; for a standalone test, save
# the raw bytes and inspect the header.
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

## License note

XTTS v2 ships under the Coqui Public Model License (CPML), which restricts
commercial use of the model weights. This project is local-only / personal,
which is compatible. Read the license before redistributing generated audio.
