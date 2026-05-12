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
# Install PyTorch first if you want GPU acceleration — see https://pytorch.org/get-started/locally/
# CPU works without an explicit torch install (coqui-tts will pull a CPU wheel).
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

If the venv was already created against the wrong Python (e.g. 3.14), delete
the folder first: `Remove-Item -Recurse -Force .venv`.

On macOS / Linux:

```bash
cd server/tts-sidecar
python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
```

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
curl http://localhost:9000/health

# Synthesize a sentence and save the PCM to a WAV via Node-side conversion,
# or use the inline helper:
curl -X POST http://localhost:9000/synthesize `
     -H "content-type: application/json" `
     --data '{\"engine\":\"coqui\",\"model\":\"xtts_v2\",\"voice\":\"Claribel Dervla\",\"text\":\"Hello, this is a test of the local TTS sidecar.\"}' `
     --output sample.raw
```

The `sample.raw` is raw 16-bit signed LE mono PCM at the rate in the
`X-Sample-Rate` response header — the Node backend wraps this in WAV.

## Environment

- `COQUI_LANGUAGE` (default `en`) — language code passed to XTTS.
- `COQUI_DEVICE` (default `auto`) — `cpu`, `cuda`, or `auto`.

## License note

XTTS v2 ships under the Coqui Public Model License (CPML), which restricts
commercial use of the model weights. This project is local-only / personal,
which is compatible. Read the license before redistributing generated audio.
