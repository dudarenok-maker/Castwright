# Installing Audiobook Generator

This guide walks a deployer through bringing the app up on a clean Windows, macOS, or Linux machine after extracting `audiobook-generator-vX.Y.Z.zip` from a [GitHub release](https://github.com/dudarenok-maker/Audiobook-Generator/releases).

After install you'll have a single command (`npm run start:prod`) that brings up the Node server (port 8080), the Python TTS sidecar (port 9000), and the built frontend — all served from `http://localhost:8080`.

---

## Prerequisites (all platforms)

- **Node.js 20.6 or newer** — <https://nodejs.org>
- **Python 3.11**
  - Windows: <https://python.org> installer (tick "Add to PATH" during setup)
  - macOS: `brew install python@3.11`
  - Linux (Ubuntu / Debian): `sudo apt install python3.11 python3.11-venv`
  - Linux (Fedora / RHEL): `sudo dnf install python3.11`
- **ffmpeg on PATH** (server encodes chapter audio to MP3)
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` (or `sudo dnf install ffmpeg`)
- **~3 GB free disk** for the Kokoro TTS weights
- **NVIDIA GPU + recent drivers** (optional but strongly recommended — Kokoro on CPU is ~10× slower than on a modest GPU)

> **Note for Linux deployers**: validated on Ubuntu 22.04+. The same scripts should work on any glibc Linux with `bash`, `curl`, and the prereqs above. Snap-installed ffmpeg sometimes ends up at `/snap/bin/ffmpeg` instead of `/usr/bin/ffmpeg`; if `which ffmpeg` returns empty after `apt install`, prepend `/snap/bin` to your PATH.

---

## Install — Windows

Open PowerShell in the extracted folder, then run:

```powershell
# 1. Install Node deps (root + server).
npm ci
npm --prefix server ci

# 2. Bootstrap the Python sidecar.
cd server\tts-sidecar
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 3. Fetch the Kokoro TTS weights (~1.1 GB, one-time download).
powershell -ExecutionPolicy Bypass -File scripts\install-kokoro.ps1
cd ..\..

# 4. Configure server.
copy server\.env.example server\.env
# Open server\.env and edit WORKSPACE_DIR to a writable folder where your
# audiobooks will live (e.g. C:\Users\you\Documents\audiobooks).

# 5. Run.
npm run start:prod
```

Browser opens `http://localhost:8080`.

To stop: `npm run stop:prod` in the same folder.

---

## Install — macOS

Open Terminal in the extracted folder, then run:

```bash
# 1. Install Node deps.
npm ci
npm --prefix server ci

# 2. Bootstrap the Python sidecar.
cd server/tts-sidecar
python3.11 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt

# 3. Fetch the Kokoro TTS weights (~1.1 GB).
bash scripts/install-kokoro.sh
cd ../..

# 4. Configure server.
cp server/.env.example server/.env
# Open server/.env and edit WORKSPACE_DIR (e.g. ~/Documents/audiobooks).

# 5. Run.
npm run start:prod
```

Browser opens `http://localhost:8080`.

To stop: `npm run stop:prod`.

> **Gatekeeper note**: macOS may prompt that downloaded binaries (`python`, `ffmpeg`, sidecar `.dylib`s) are from an "unidentified developer." Allowing them once via System Settings → Privacy & Security is expected; the v1 release zip is not codesigned.

---

## Install — Linux

Open a terminal in the extracted folder, then run:

```bash
# 1. Install Node deps.
npm ci
npm --prefix server ci

# 2. Bootstrap the Python sidecar.
cd server/tts-sidecar
python3.11 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt

# 3. Fetch the Kokoro TTS weights (~1.1 GB).
bash scripts/install-kokoro.sh
cd ../..

# 4. Configure server.
cp server/.env.example server/.env
# Edit WORKSPACE_DIR to a writable folder.

# 5. Run.
npm run start:prod
```

Browser: `http://localhost:8080`.

To stop: `npm run stop:prod`.

---

## Troubleshooting

### "ffmpeg not found on PATH"

The server pipes chapter PCM through ffmpeg at encode time; missing it = no audio. Confirm with `ffmpeg -version`. If the binary is installed but not on PATH, prepend its directory to PATH in your shell profile (Windows: System → Environment Variables; macOS/Linux: `~/.zshrc` / `~/.bashrc`).

### Port :8080 already in use

Either another instance of this app is running (`npm run stop:prod` then retry), or another process is bound to :8080. On Windows: `netstat -ano | findstr :8080` shows the PID. On POSIX: `lsof -i:8080`. Override the port for one run via `PORT=8081 npm run start:prod` (then visit `http://localhost:8081`).

### Sidecar fails to load Kokoro

The sidecar logs to `logs/server.log` (the Node server captures sidecar stdout). Most common cause: the Kokoro weights download was interrupted mid-flight. Re-running `install-kokoro.sh` / `install-kokoro.ps1` cleans up partial downloads and retries.

### GPU not detected

Sidecar will fall back to CPU and log it. Verify `nvidia-smi` works at the OS level. Driver mismatches (e.g. CUDA 11.x runtime on a 12.x driver) are the common culprit — reinstall the matching CUDA runtime from <https://developer.nvidia.com/cuda-downloads>.

### "Cannot find module '../../dist/index.html'"

`npm run start:prod` checks for the pre-built frontend bundle. The release zip ships `dist/` pre-built — if you're seeing this, the extract was incomplete or you've manually deleted `dist/`. Re-extract.

---

## Switching analyzer to Ollama (local, free, on-device)

The install bundle ships Kokoro for TTS only. The analyzer defaults to Google's free Gemini API. To switch the analyzer to Ollama (private, fully on-device):

1. Install Ollama from <https://ollama.com>.
2. Pull a model: `ollama pull qwen3.5:4b` (~2.5 GB).
3. In the app: **Account → Server configuration → Analyzer engine** → "Local Ollama".
4. **Account → Defaults for new books → Analysis model** → "Qwen3.5 4B (local)".
5. Save. The next analysis routes to your local Ollama.

> **Coming in a future release**: an "Install Ollama" + "Pull model" UX on the Account tab so you don't have to leave the app for the above. Tracked in [docs/BACKLOG.md](docs/BACKLOG.md) as a Could-bucket item.

## Switching TTS to Coqui XTTS v2 (alternate, on-device)

1. **Account → Defaults for new books → TTS engine** → "Local (free)".
2. **TTS model** → "Coqui XTTS v2".
3. Save. The first chapter generation triggers a one-time ~2 GB model download.

## Using Gemini for analysis or TTS (cloud, free tier)

1. Get an API key from <https://aistudio.google.com> (Google account required).
2. In the app: **Account → Server configuration → Gemini API key** → paste the key → Save.
3. Engine selection follows from the model picker: choose any Gemini model in **Defaults for new books → Analysis model** (or TTS engine + model). Save.

The key is stored plaintext in `server/user-settings.json` (gitignored, same trust model as `server/.env` for a single-user workspace). The env var `GEMINI_API_KEY` in `server/.env` still wins if both are set — useful for CI / scripted setups.

---

## Updating

A new release is just a new zip — there's no in-app auto-update yet.

1. `npm run stop:prod` in the existing install folder.
2. Download the new `audiobook-generator-vX.Y.Z.zip`.
3. Extract OVER the existing folder, or extract to a fresh folder and copy your `server/.env` + `server/user-settings.json` across.
4. `npm ci && npm --prefix server ci` (catches any new deps).
5. `npm run start:prod`.

Your workspace (`WORKSPACE_DIR` from `server/.env`) is separate from the install folder and survives across upgrades unchanged.
