# Installing Castwright

This guide walks a deployer through bringing the app up on a clean Windows, macOS, or Linux machine after extracting `castwright-vX.Y.Z.zip` from a [GitHub release](https://github.com/dudarenok-maker/Castwright/releases).

After install you'll have a single command (`npm run start:prod`) that brings up the Node server (port 8080), the Python voice engine (port 9000), and the built frontend — all served from `http://localhost:8080`.

---

## Prerequisites (all platforms)

- **Node.js 20.19 or newer** (Vite 8 needs ≥20.19 / ≥22.12; the repo targets Node 24) — <https://nodejs.org>
- **Python 3.11**
  - Windows: <https://python.org> installer (tick "Add to PATH" during setup)
  - macOS: `brew install python@3.11`
  - Linux (Ubuntu / Debian): `sudo apt install python3.11 python3.11-venv`
  - Linux (Fedora / RHEL): `sudo dnf install python3.11`
- **ffmpeg on PATH** (server encodes chapter audio to MP3)
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` (or `sudo dnf install ffmpeg`)
- **~3 GB free disk** (Kokoro TTS weights ~1.1 GB, plus the Node modules and Python virtual environment)
- **A GPU is optional but strongly recommended** (Kokoro on CPU is ~10× slower than on a modest GPU):
  - Windows / Linux: an **NVIDIA GPU + recent drivers** (CUDA).
  - macOS: **Apple Silicon (M-series)** is used automatically via Metal (`mps`) — no drivers, no CUDA, no config. Intel Macs fall back to CPU.

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
#    Option A — in-app: start the app first, then Admin → Model Manager → Kokoro → Install (no terminal needed).
#    Option B — terminal:
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
#    Option A — in-app: start the app first, then Admin → Model Manager → Kokoro → Install (no terminal needed).
#    Option B — terminal:
bash scripts/install-kokoro.sh
cd ../..

# 4. Configure server.
cp server/.env.example server/.env
# Open server/.env and edit WORKSPACE_DIR (e.g. ~/Documents/audiobooks).

# 5. Run.
npm run start:prod
```

> **Apple Silicon TTS device**: no configuration needed — the sidecar auto-detects
> the GPU (`mps`) and falls back to CPU. To force a specific device, set
> `QWEN_DEVICE=cpu` (or `mps`) in `server/.env`.

Browser opens `http://localhost:8080`.

To stop: `npm run stop:prod`.

> **Gatekeeper note**: macOS may prompt that downloaded binaries (`python`, `ffmpeg`, sidecar `.dylib`s) are from an "unidentified developer." Allowing them once via System Settings → Privacy & Security is expected; this release zip is not codesigned.

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
#    Option A — in-app: start the app first, then Admin → Model Manager → Kokoro → Install (no terminal needed).
#    Option B — terminal:
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

## Try the demo book

The app ships with a generate-able demo — **The Coalfall Commission** (an original
Castwright work). On the books-library empty state or the upload screen, click
**"try a sample book"** to load it into your workspace with its full 13-character
cast already designed, then **Generate** to hear it.

The designed voices are **Qwen** (the flagship per-character engine), so generating
the demo as designed needs the Qwen model installed (Model Manager → install Qwen)
on a GPU. Every character also carries a **Kokoro** fallback preset, so the demo
still generates with a full cast on a box without Qwen — just less bespoke. No audio
ships in the bundle; the demo runs the real pipeline locally.

---

## Troubleshooting

### "ffmpeg not found on PATH"

The server pipes chapter PCM through ffmpeg at encode time; missing it = no audio. Confirm with `ffmpeg -version`. If the binary is installed but not on PATH, prepend its directory to PATH in your shell profile (Windows: System → Environment Variables; macOS/Linux: `~/.zshrc` / `~/.bashrc`).

### Port :8080 already in use

Either another instance of this app is running (`npm run stop:prod` then retry), or another process is bound to :8080. On Windows: `netstat -ano | findstr :8080` shows the PID. On POSIX: `lsof -i:8080`. Override the port for one run via `PORT=8081 npm run start:prod` (then visit `http://localhost:8081`).

### Sidecar fails to load Kokoro

The sidecar logs to `logs/server.log` (the Node server captures sidecar stdout). Most common cause: the Kokoro weights download was interrupted mid-flight. Re-running `install-kokoro.sh` / `install-kokoro.ps1` cleans up partial downloads and retries.

### GPU not detected

Sidecar will fall back to CPU and log it. **On Windows / Linux (NVIDIA):** verify `nvidia-smi` works at the OS level — driver mismatches (e.g. CUDA 11.x runtime on a 12.x driver) are the common culprit; reinstall the matching CUDA runtime from <https://developer.nvidia.com/cuda-downloads>. **On macOS (Apple Silicon):** the GPU is used automatically via Metal — no driver setup is needed, and the sidecar log should show `device=mps`. Force a device with `QWEN_DEVICE=cpu` (or `mps`) in `server/.env` if you need to override the auto-detection.

### "Cannot find module '../../dist/index.html'"

`npm run start:prod` checks for the pre-built frontend bundle. The release zip ships `dist/` pre-built — if you're seeing this, the extract was incomplete or you've manually deleted `dist/`. Re-extract.

---

## Configuration

The server reads `server/.env` (copied from `server/.env.example` in the install
steps above). All knobs have safe defaults — set only what you need.

**Analyzer**

- `ANALYZER` — `local` (default, Ollama) or `gemini`.
- `GEMINI_API_KEY` — required when `ANALYZER=gemini` (or as the automatic
  fallback when Ollama is unreachable).
- `GEMINI_MODEL` — the Gemini model id; plus per-model `GEMINI_RPM_*` /
  `GEMINI_TPM_*` / `GEMINI_RPD_*` rate caps (see `server/.env.example`).
- `ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` /
  `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` — optional two-model analyzer (cast
  detection + sentence attribution in parallel). Set both phase vars to enable.

**Generation & TTS**

- `WORKSPACE_DIR` — where your per-book library lives (set this to a writable
  folder).
- `GEN_WORKERS` — how many chapters synthesise at once (default `2`).
- `GPU_VRAM_BUDGET` — VRAM-weighted GPU budget in GiB (default `8`). Drop to `6`
  on a 6 GB card.
- `PRELOAD_COQUI` — `0` (default; Coqui loads on demand) or `1`.
- `QWEN_BATCH_SIZE` (default `8`) and `QWEN_ATTN_IMPL` (default `sdpa`) — Qwen
  tuning knobs.
- `AUDIO_LOUDNORM_ENABLED` — `true` (default; two-pass EBU R128 at
  -16 LUFS / 11 LU / -1.5 dBTP) or `false` to opt out.

**LAN / companion access**

- `LAN_HTTPS` — `1` serves over mkcert-backed HTTPS on `:8443`, bound on all
  interfaces (phone/tablet web + the Android companion). Off by default;
  `npm run start:lan` sets it. Requires the LAN cert
  (`npm run install:cert-mobile`); with `LAN_HTTPS=1` the server refuses to start
  if the cert is missing.
- `LAN_AUTH_TOKEN` — the shared pairing secret for the companion (and the LAN
  access guard on `/api` + `/workspace`). Required for the companion app.

## Setting up the analyzer

The install bundle ships Kokoro weights for TTS only — the analyzer needs either a local Ollama daemon or a Gemini API key. The server-side default is `ANALYZER=local` (Ollama); if no Ollama daemon is reachable, the analyzer auto-falls back to the Gemini free tier when a key is configured.

**Option A — Ollama (private, fully on-device).** The Account → Models card in the running app installs Ollama and pulls models without leaving the UI:

1. Start the app (`npm run start:prod`), open **Account → Models**.
2. Click **Install Ollama** (platform-aware bootstrap; Windows / macOS / Linux all covered).
3. Click **Pull model** and pick e.g. `qwen3.5:4b` (~2.5 GB).
4. **Account → Defaults for new books → Analysis model** → pick the pulled model. Save.

Or the manual path: install Ollama from <https://ollama.com>, `ollama pull qwen3.5:4b`, then set the model in the Account tab. On macOS, also run `brew services start ollama` so the daemon starts on login and survives reboots (registers a launchd login item).

**Option B — Gemini (cloud, free tier).** Get a key from <https://aistudio.google.com>, paste it into **Account → Server configuration → Gemini API key**. Engine selection follows from the model picker — pick any Gemini model in **Defaults for new books → Analysis model**. Save. The key persists to your per-user settings file `~/.castwright/user-settings.json` (plaintext, same trust model as `server/.env`).

**Option C — Pipelined two-model split.** For long books: Phase 0 (cast detection) runs on Gemma while Phase 1 (sentence attribution) runs on Gemini Flash in parallel, hitting independent rate-limit buckets so effective quota nearly doubles. Configure under **Account → Defaults for new books → Phase 0 model + Phase 1 model + Min-lag chapters** (default 10), or set `ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` / `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` in `server/.env`.

## Switching the voice engine to Coqui XTTS v2 (alternate, on-device)

1. **Account → Defaults for new books → Voice engine** → "Local (free)".
2. **Voice model** → "Coqui XTTS v2".
3. Save. The first chapter generation triggers a one-time ~2 GB model download.

## Switching TTS to Qwen3-TTS

Qwen3-TTS designs a unique voice per character from the cast persona instead of picking from a preset catalogue — only two English Qwen speakers exist upstream, so the app caches each designed voice's embedding and reuses it across the book and series for vocal consistency. It **becomes the default for new books once it's installed** (until then, and on any box without it, books render in Kokoro). It is **NOT** auto-downloaded with the Kokoro / Coqui paths — it needs a one-time install of the Python package + model weights (~2.5 GB).

**Recommended — install in-app (no terminal).** Start the app, open **Account → Models**, and click **Install Qwen3-TTS** on the Qwen card. It downloads the Base + VoiceDesign models in the background with live progress; when it finishes, new books default to Qwen. The CLI below stays available for scripted / offline / CI setups and is equivalent.

1. **Install the engine (CLI alternative).** From the extracted folder, with the sidecar venv already bootstrapped (step 2 of the per-OS install above):

   ```sh
   node server/tts-sidecar/scripts/install-qwen3.mjs
   ```

   Cross-platform Node ESM — same command on Windows / macOS / Linux. Idempotent (pip is a no-op when satisfied; the model download is a no-op when the Hugging Face cache already has the snapshot). Pip-installs `qwen-tts` into the sidecar venv and pre-fetches the Base (synth) + VoiceDesign models into `server/tts-sidecar/voices/qwen/hf`. Add `--skip-design` if you only want the synth model (saves ~1.7 GB on machines that won't host the cast-review design step); add `--cpu` to force CPU-only torch on a box without a CUDA GPU.

2. **Optional — FlashAttention-2 wheel (Windows-only).** SDPA is the default attention impl and benchmarked at parity with FA2 on TTS-decode-bound workloads, so skipping FA2 costs nothing measurable. To install the wheel anyway (e.g. for a benchmark):

   ```sh
   node server/tts-sidecar/scripts/install-qwen3.mjs --flash-attn
   ```

   The script auto-skips on macOS / Linux / non-`cp311` Python / non-`torch-2.6 + cu124` — a wheel that can't load doesn't get installed. Once installed, activate it by setting `QWEN_ATTN_IMPL=flash_attention_2` in `server/.env`.

3. **Switch a book to Qwen3.** Start the app and go to **Account → Defaults for new books → Voice engine** → "Local (free)" → **Voice model** → pick the Qwen3 entry. Save. For an existing book opened under Kokoro / Coqui, use the cast view's "Rebaseline the series" modal to design Qwen voices for the principal cast with current-vs-proposed audition before regenerating.

**Disk + VRAM.** Qwen Base ~1 GB on disk, Base + VoiceDesign together ~2.5 GB. At runtime Base resides at ~2 GB VRAM during synth and VoiceDesign loads transiently during a design (~4–5 GB on top of Base, freed on idle or at the next synth). The GPU-arbitration semaphore (`GPU_VRAM_BUDGET` in `server/.env`, default 8 GiB) keeps an 8 GB GPU from double-booking against the analyzer.

## Using Gemini for TTS (cloud, free tier)

The same Gemini key configured for the analyzer (see Option B above) doubles as the TTS provider when picked.

1. Get an API key from <https://aistudio.google.com> (Google account required), saved via **Account → Server configuration → Gemini API key**.
2. **Account → Defaults for new books → Voice engine** → "Gemini (cloud)".
3. **Voice model** → pick `gemini-3.1-flash-preview-tts` or `gemini-2.5-flash-preview-tts`. Save.

The key is stored plaintext in `~/.castwright/user-settings.json` (per-user, same trust model as `server/.env` for a single-user workspace). The env var `GEMINI_API_KEY` in `server/.env` still wins if both are set — useful for CI / scripted setups.

---

## Picking a chapter audio format

Chapter audio defaults to MP3 VBR V2. Two newer codecs are available per-book under **Listen view → metadata editor → Audio format** or in the export modal:

- **MP3** (default) — broadest player support; VBR V2.
- **AAC / M4A** — smaller files at equal perceived quality; `libfdk_aac` is auto-detected on the host ffmpeg with a graceful fallback to the native AAC encoder.
- **Opus** — best ratio at very low bitrates; ideal for streaming over LAN.

The `audioFormat` field is new on `BookStateJson` (default `'mp3'`) — existing books carry the default and need no migration. Export shapes mirror the codec: `aac-m4a-zip`, `opus-ogg-zip`, plus the existing `mp3-zip` + `mp3-folder` + `m4b-single`.

Loudness normalization (EBU R128, two-pass, targeting -16 LUFS / 11 LU / -1.5 dBTP) is **on by default** for every newly-rendered chapter. To opt out per server install, set `AUDIO_LOUDNORM_ENABLED=false` in `server/.env`. The Listen view's loudness report card surfaces measured LUFS / LRA / dBTP and flags drift between chapters.

---

## Mobile + tablet access over LAN HTTPS

The app drives on phone + tablet via LAN HTTPS using `mkcert` so iOS / Android trust the cert without browser warnings. One-time setup per dev box:

1. Install `mkcert` — `scoop install mkcert` (Windows), `brew install mkcert` (macOS), or `apt install mkcert` (Linux). Then `mkcert -install`.
2. `npm run install:cert-mobile` — prints LAN URL + QR code + per-OS root-cert install steps.
3. Install the root CA on each mobile device once (iOS: Settings → Profile downloaded → Install → trust; Android: Settings → Security → Install certificate).
4. Run the server in LAN mode: `npm run start:lan` for the production bundle on `https://0.0.0.0:8443`, or `npm run dev:lan` for HMR-capable Vite + Node on `https://0.0.0.0:5173`/`:8443`.
5. Open the printed LAN URL on the device — lock icon, no warning.

---

## Android companion app

The native Flutter **Castwright** pairs to the server over the LAN and delta-syncs only the chapters that changed, for offline playback with background / lock-screen / Bluetooth / Android-Auto controls. It's a separate Flutter build from this server zip, but **each [GitHub Release](https://github.com/dudarenok-maker/Castwright/releases) attaches a ready-to-sideload `castwright-vX.Y.Z.apk`** (+ `.sha256`). To use it:

1. Do the LAN-HTTPS setup above (mkcert + `npm run install:cert-mobile`).
2. Set **both** in `server/.env`, then restart in LAN mode:

   ```
   LAN_HTTPS=1
   LAN_AUTH_TOKEN=<a-strong-secret>
   ```

   `LAN_AUTH_TOKEN` is the **pairing token**. With `LAN_HTTPS=1` set, the server **won't start if the LAN cert is missing** — run step 1 first.
3. The pairing values are served at `GET /api/export/lan` (`{ urls, protocol: "https", token, caFingerprint }`).
4. In the app: **Pair a device** → scan the pairing QR or enter the server URL (`https://<lan-ip>:8443`), access token, and CA fingerprint. The app pins the CA itself, so — unlike the mobile *web* UI — **you do not install the root CA on the phone**.

Build/sideload instructions for the app live in [`apps/android/README.md`](apps/android/README.md); the full design is [`docs/features/188-android-companion-app.md`](docs/features/188-android-companion-app.md).

---

## Updating

Upgrading is one click in the app: open **Account → Application updates**, pick
the new `castwright-vX.Y.Z.zip`, confirm the version delta, and the app stages,
validates, swaps, reinstalls dependencies, migrates your book data (with an
automatic backup first), and restarts itself. No terminal commands.

This works because Castwright uses a **versioned-directory layout**: each release
lives in its own `releases/vX.Y.Z/` folder, a stable `launch.mjs` at the install
root always runs the current one, and your data lives in shared siblings outside
the release folders. An upgrade extracts the new release into a *fresh* folder and
only flips a pointer once it's ready — the running version is never touched, so a
failed upgrade just keeps running the previous one. A fresh install already ships
this machinery, so there is nothing to convert.

```
<install>/
  launch.mjs            <- start the app from here (shortcut / start-app.bat points at it)
  .current-version      <- e.g. "1.7.0"
  releases/vX.Y.Z/      <- the code (one extracted zip per release)
  workspace/            <- your library (books, voices)
  venv/  models/kokoro/ <- shared Python venv + Kokoro weights
  logs/  .run/
```

Your account settings live in `~/.castwright/user-settings.json` (outside any
install folder) and carry over automatically; copy your old `server/.env` into
`releases/vX.Y.Z/server/.env` if you set custom keys.

### Manual fallback (any version)

The in-app flow is just orchestration — you can always swap by hand: `npm run stop:prod`, extract the new release into a new `releases/vX.Y.Z/`, set `.current-version`, `npm ci && npm --prefix server ci`, then `node launch.mjs`. Your `workspace/`, `venv/`, and `models/` are untouched.

