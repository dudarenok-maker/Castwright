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

## Setting up the analyzer

The install bundle ships Kokoro weights for TTS only — the analyzer needs either a local Ollama daemon or a Gemini API key. The server-side default is `ANALYZER=local` (Ollama); if no Ollama daemon is reachable, the analyzer auto-falls back to the Gemini free tier when a key is configured.

**Option A — Ollama (private, fully on-device).** Since v1.3.0 the Account → Models card in the running app installs Ollama and pulls models without leaving the UI:

1. Start the app (`npm run start:prod`), open **Account → Models**.
2. Click **Install Ollama** (platform-aware bootstrap; Windows / macOS / Linux all covered).
3. Click **Pull model** and pick e.g. `qwen3.5:4b` (~2.5 GB).
4. **Account → Defaults for new books → Analysis model** → pick the pulled model. Save.

Or the manual path: install Ollama from <https://ollama.com>, `ollama pull qwen3.5:4b`, then set the model in the Account tab.

**Option B — Gemini (cloud, free tier).** Get a key from <https://aistudio.google.com>, paste it into **Account → Server configuration → Gemini API key**. Engine selection follows from the model picker — pick any Gemini model in **Defaults for new books → Analysis model**. Save. The key persists to `server/user-settings.json` (gitignored, plaintext, same trust model as `server/.env`).

**Option C — Pipelined two-model split (v1.4.0).** For long books: Phase 0 (cast detection) runs on Gemma while Phase 1 (sentence attribution) runs on Gemini Flash in parallel, hitting independent rate-limit buckets so effective quota nearly doubles. Configure under **Account → Defaults for new books → Phase 0 model + Phase 1 model + Min-lag chapters** (default 10), or set `ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` / `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` in `server/.env`. Manual handoff (`ANALYZER=manual`) short-circuits to sequential — the file-drop cowork loop can't pipeline.

## Switching TTS to Coqui XTTS v2 (alternate, on-device)

1. **Account → Defaults for new books → TTS engine** → "Local (free)".
2. **TTS model** → "Coqui XTTS v2".
3. Save. The first chapter generation triggers a one-time ~2 GB model download.

## Using Gemini for TTS (cloud, free tier)

The same Gemini key configured for the analyzer (see Option B above) doubles as the TTS provider when picked.

1. Get an API key from <https://aistudio.google.com> (Google account required), saved via **Account → Server configuration → Gemini API key**.
2. **Account → Defaults for new books → TTS engine** → "Gemini (cloud)".
3. **TTS model** → pick `gemini-3.1-flash-preview-tts` or `gemini-2.5-flash-preview-tts`. Save.

The key is stored plaintext in `server/user-settings.json` (gitignored, same trust model as `server/.env` for a single-user workspace). The env var `GEMINI_API_KEY` in `server/.env` still wins if both are set — useful for CI / scripted setups.

---

## Picking a chapter audio format (v1.4.0)

Chapter audio defaults to MP3 VBR V2. Two newer codecs are available per-book under **Listen view → metadata editor → Audio format** or in the export modal:

- **MP3** (default) — broadest player support; VBR V2.
- **AAC / M4A** — smaller files at equal perceived quality; `libfdk_aac` is auto-detected on the host ffmpeg with a graceful fallback to the native AAC encoder.
- **Opus** — best ratio at very low bitrates; ideal for streaming over LAN.

The `audioFormat` field is new on `BookStateJson` (default `'mp3'`) — existing books carry the default and need no migration. Export shapes mirror the codec: `aac-m4a-zip`, `opus-ogg-zip`, plus the existing `mp3-zip` + `mp3-folder` + `m4b-single`.

Loudness normalization (EBU R128, two-pass, targeting -16 LUFS / 11 LU / -1.5 dBTP) is **on by default** for every newly-rendered chapter. To opt out per server install, set `AUDIO_LOUDNORM_ENABLED=false` in `server/.env`. The Listen view's loudness report card surfaces measured LUFS / LRA / dBTP and flags drift between chapters.

---

## Mobile + tablet access over LAN HTTPS (v1.4.0)

The app drives on phone + tablet via LAN HTTPS using `mkcert` so iOS / Android trust the cert without browser warnings. One-time setup per dev box:

1. Install `mkcert` — `scoop install mkcert` (Windows), `brew install mkcert` (macOS), or `apt install mkcert` (Linux). Then `mkcert -install`.
2. `npm run install:cert-mobile` — prints LAN URL + QR code + per-OS root-cert install steps.
3. Install the root CA on each mobile device once (iOS: Settings → Profile downloaded → Install → trust; Android: Settings → Security → Install certificate).
4. Run the server in LAN mode: `npm run start:lan` for the production bundle on `https://0.0.0.0:8443`, or `npm run dev:lan` for HMR-capable Vite + Node on `https://0.0.0.0:5173`/`:8443`.
5. Open the printed LAN URL on the device — lock icon, no warning.

---

## Updating

A new release is just a new zip — there's no in-app auto-update yet. Tracked as [`docs/BACKLOG.md`](docs/BACKLOG.md) MUST #1 (in-app upgrade pathway): when that ships, the five-step manual sequence below becomes a single click in the Account tab. For now, work the manual path.

1. `npm run stop:prod` in the existing install folder.
2. Download the new `audiobook-generator-vX.Y.Z.zip`.
3. Extract OVER the existing folder, or extract to a fresh folder and copy your `server/.env` + `server/user-settings.json` across.
4. `npm ci && npm --prefix server ci` (catches any new deps).
5. `npm run start:prod`.

Your workspace (`WORKSPACE_DIR` from `server/.env`) is separate from the install folder and survives across upgrades unchanged.

### v1.3.x → v1.4.0 notes

- `BookStateJson` gained an optional `audioFormat` field (`'mp3' | 'aac-m4a' | 'opus'`). Existing books default to `'mp3'`; no migration required.
- Finished exports moved from the hidden `.audiobook/exports/<id>/` jail to a visible `<bookDir>/exports/<slug>.<ext>` sibling to `audio/`. Old exports stay where they were — only new exports land in the new location.
- Audio loudness normalization is on by default in v1.4.0. Set `AUDIO_LOUDNORM_ENABLED=false` in `server/.env` if you need bit-exact match with previously-rendered chapters; otherwise regenerate to bring older chapters into the loudness target.
- New optional env knobs: `ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` / `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` (pipelined two-model analyzer), `GEN_CHAPTER_CONCURRENCY` (parallel chapter synthesis, default 2). All have safe defaults — leave unset to keep the v1.3.1 behaviour.
