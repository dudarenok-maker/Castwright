# Installing Audiobook Generator

This guide walks a deployer through bringing the app up on a clean Windows, macOS, or Linux machine after extracting `audiobook-generator-vX.Y.Z.zip` from a [GitHub release](https://github.com/dudarenok-maker/Audiobook-Generator/releases).

After install you'll have a single command (`npm run start:prod`) that brings up the Node server (port 8080), the Python TTS sidecar (port 9000), and the built frontend — all served from `http://localhost:8080`.

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

**Option B — Gemini (cloud, free tier).** Get a key from <https://aistudio.google.com>, paste it into **Account → Server configuration → Gemini API key**. Engine selection follows from the model picker — pick any Gemini model in **Defaults for new books → Analysis model**. Save. The key persists to your per-user settings file `~/.audiobook-generator/user-settings.json` (plaintext, same trust model as `server/.env`).

**Option C — Pipelined two-model split (v1.4.0).** For long books: Phase 0 (cast detection) runs on Gemma while Phase 1 (sentence attribution) runs on Gemini Flash in parallel, hitting independent rate-limit buckets so effective quota nearly doubles. Configure under **Account → Defaults for new books → Phase 0 model + Phase 1 model + Min-lag chapters** (default 10), or set `ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` / `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` in `server/.env`.

## Switching TTS to Coqui XTTS v2 (alternate, on-device)

1. **Account → Defaults for new books → TTS engine** → "Local (free)".
2. **TTS model** → "Coqui XTTS v2".
3. Save. The first chapter generation triggers a one-time ~2 GB model download.

## Switching TTS to Qwen3-TTS (v1.5.0, bespoke per-character voices)

Qwen3-TTS designs a unique voice per character from the cast persona instead of picking from a preset catalogue — only two English Qwen speakers exist upstream, so the app caches each designed voice's embedding and reuses it across the book and series for vocal consistency. This is the v1.5.0 headline TTS engine and **becomes the default for new books once it's installed** (until then, and on any box without it, books render in Kokoro). It is **NOT** auto-downloaded with the Kokoro / Coqui paths — it needs a one-time install of the Python package + model weights (~5 GB).

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

3. **Switch a book to Qwen3.** Start the app and go to **Account → Defaults for new books → TTS engine** → "Local (free)" → **TTS model** → pick the Qwen3 entry. Save. For an existing book opened under Kokoro / Coqui, use the cast view's "Rebaseline the series" modal to design Qwen voices for the principal cast with current-vs-proposed audition before regenerating.

**Disk + VRAM.** Qwen Base ~1 GB on disk, Base + VoiceDesign together ~2.5 GB. At runtime Base resides at ~2 GB VRAM during synth and VoiceDesign loads transiently during a design (~4–5 GB on top of Base, freed on idle or at the next synth). The GPU-arbitration semaphore (`GPU_VRAM_BUDGET` in `server/.env`, default 8 GiB) keeps an 8 GB GPU from double-booking against the analyzer.

## Using Gemini for TTS (cloud, free tier)

The same Gemini key configured for the analyzer (see Option B above) doubles as the TTS provider when picked.

1. Get an API key from <https://aistudio.google.com> (Google account required), saved via **Account → Server configuration → Gemini API key**.
2. **Account → Defaults for new books → TTS engine** → "Gemini (cloud)".
3. **TTS model** → pick `gemini-3.1-flash-preview-tts` or `gemini-2.5-flash-preview-tts`. Save.

The key is stored plaintext in `~/.audiobook-generator/user-settings.json` (per-user, same trust model as `server/.env` for a single-user workspace). The env var `GEMINI_API_KEY` in `server/.env` still wins if both are set — useful for CI / scripted setups.

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

## Android companion app

The native Flutter **Audiobook Companion** (a separate sideload app — **not** part of this release zip) pairs to the server over the LAN and delta-syncs only the chapters that changed, for offline playback with background / lock-screen / Bluetooth controls. To use it:

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

From **v1.6.0 onward, upgrading is one click in the Account tab** — open **Account → Application updates**, pick the new `audiobook-generator-vX.Y.Z.zip`, confirm the version delta, and the app stages, validates, swaps, reinstalls deps, migrates your book data (with an automatic backup first), and restarts itself. No terminal commands.

This works because 1.6.0 introduces a **versioned-directory layout**: each release lives in its own `releases/vX.Y.Z/` folder, a stable `launch.mjs` at the install root always runs the current one, and your data lives in shared siblings outside the release folders. An upgrade extracts the new release into a *fresh* folder and only flips a pointer once it's ready — the running version is never touched, so a failed upgrade just keeps running the old one.

```
<install>/
  launch.mjs            <- start the app from here (shortcut / start-app.bat points at it)
  .current-version      <- "1.6.0"
  releases/v1.6.0/      <- the code (one extracted zip)
  workspace/            <- your library (books, voices)
  venv/  models/kokoro/ <- shared python venv + ~330 MB Kokoro weights
  logs/  .run/
```

### One-time conversion when you adopt v1.6.0 (from v1.5.x)

A v1.5.x install is a single flat checkout with none of this machinery, so the **jump into 1.6.0 is still manual** — run the bundled converter once:

1. `npm run stop:prod` in your existing v1.5.x folder.
2. Download and extract `audiobook-generator-v1.6.0.zip` to a temporary folder.
3. From the extracted folder, dry-run the converter (prints exactly what it will move):
   ```
   node scripts/setup-versioned-install.mjs --install <new-install-dir> --from <old-v1.5.x-dir>
   ```
4. Re-run with `--apply` to execute. It creates `<new-install-dir>/releases/v1.6.0/`, writes the pointer, places `launch.mjs` at the root, and **moves** (not re-downloads) your `audiobook-workspace`, the sidecar `.venv`, and the Kokoro weights into the shared siblings.
5. Start the app: `node <new-install-dir>/launch.mjs`.

Your account settings live in `~/.audiobook-generator/user-settings.json` (outside any install folder) and carry over automatically; copy your old `server/.env` into `releases/v1.6.0/server/.env` if you had custom keys.

**After this one-time step, every later upgrade is the one-click Account flow above** — the first self-upgrade you'll experience is 1.6.0 → 1.7.0. (1.6.0 ships the mechanism; it can't upgrade *into* itself.)

### Manual fallback (any version)

The in-app flow is just orchestration — you can always swap by hand: `npm run stop:prod`, extract the new release into a new `releases/vX.Y.Z/`, set `.current-version`, `npm ci && npm --prefix server ci`, then `node launch.mjs`. Your `workspace/`, `venv/`, and `models/` are untouched.

### v1.4.0 → v1.5.0 notes

- **Qwen3-TTS is the new headline TTS engine and becomes the DEFAULT for new books once it's installed** (resolved live — a box without Qwen keeps defaulting to Kokoro, and an explicit engine pick in Account is always honoured). It is NOT auto-installed by the per-OS steps above; install it in one click from **Account → Models** (or via `node server/tts-sidecar/scripts/install-qwen3.mjs`). Existing books continue to render through their current engine unchanged. **Graceful fallback:** a Qwen book whose character has no designed voice — or any Qwen render when the engine isn't installed/loaded — renders that character in Kokoro instead of failing, shown as a "Fallback (Kokoro)" status.
- **Per-character TTS engine.** Cast members now carry a per-engine `overrideTtsVoices: { coqui?, kokoro?, gemini?, qwen? }` map; legacy single-field `overrideTtsVoice` rows migrate lazily on read, so books from v1.4.0 keep their voice assignments when you flip a project's engine — no re-cast required.
- **Persisted generation queue** at `<workspace>/.queue.json`. No migration: the file is created on first enqueue post-upgrade; in-progress generations pre-1.5.0 just finish.
- **New optional env knobs** in `server/.env` (all have safe defaults — leave unset to keep the v1.4.0 behaviour):
  - `GPU_VRAM_BUDGET` — VRAM-weighted GPU semaphore budget in GiB (default `8`). Drop to `6` on a 6 GB card to keep analyzer + Qwen Base co-resident.
  - `QWEN_BATCH_SIZE` — Qwen sentences-per-batched-forward cap (default `8`). Set `=1` as a per-call kill-switch to fall back to one-sentence-per-call.
  - `QWEN_ATTN_IMPL` — attention impl for Qwen (default `sdpa`). Flip to `flash_attention_2` after running `install-qwen3.mjs --flash-attn`.
- **Build-version footer.** Every view now stamps the running build at the bottom (`v1.5.0 (a1b2c3d)` in production). If you upgraded but the footer still reads `v1.4.0`, the new bundle didn't extract over — re-run the unpack.
- **No `BookStateJson` schema change.** Books from v1.4.0 hydrate as-is.

### v1.3.x → v1.4.0 notes

- `BookStateJson` gained an optional `audioFormat` field (`'mp3' | 'aac-m4a' | 'opus'`). Existing books default to `'mp3'`; no migration required.
- Finished exports moved from the hidden `.audiobook/exports/<id>/` jail to a visible `<bookDir>/exports/<slug>.<ext>` sibling to `audio/`. Old exports stay where they were — only new exports land in the new location.
- Audio loudness normalization is on by default in v1.4.0. Set `AUDIO_LOUDNORM_ENABLED=false` in `server/.env` if you need bit-exact match with previously-rendered chapters; otherwise regenerate to bring older chapters into the loudness target.
- New optional env knobs: `ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` / `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` (pipelined two-model analyzer), `GEN_WORKERS` (renamed from `GEN_CHAPTER_CONCURRENCY`; how many chapters the generation queue synthesises at once, default 2). All have safe defaults — leave unset to keep the v1.3.1 behaviour.
