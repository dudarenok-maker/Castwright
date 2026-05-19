# Audiobook Generator

Turn a manuscript into a finished audiobook on your own machine.

Upload `.md` / `.txt` / `.epub` / `.pdf` → an analyzer extracts characters,
chapters, and per-sentence speaker tags → assign a TTS voice to each
character → generate per-chapter audio → listen, revise, export to M4B
or MP3.

The pipeline runs locally end-to-end. Analysis can use a local Ollama
model (default), a manual file-drop coworking flow with any chat model,
or the Gemini free-tier API. TTS uses Kokoro v1 (eager-loaded, ~1 GB
VRAM) by default, with Coqui XTTS v2 available on demand for zero-shot
voice cloning.

## Quickstart

**Prerequisites**

- Node 20.6 or newer
- Python 3.11 (for the TTS sidecar)
- ffmpeg on `PATH` (checked by `npm run dev` via `scripts/preflight-ffmpeg.cjs`)
- Windows 11 with PowerShell 5.1+ — the harness ships Windows-native start
  scripts; macOS / Linux work for development but the orchestration scripts
  under `scripts/` are PowerShell

**Install**

```powershell
git clone https://github.com/dudarenok-maker/Audiobook-Generator.git
cd Audiobook-Generator
npm install
cd server && npm install && cd ..
```

The `prepare` hook installs husky and wires `.husky/` for commit gating.

Optional, one-time per workstation:

```powershell
# Pester 5+ for the PowerShell-scripts test harness
Install-Module -Name Pester -Scope CurrentUser -Force -SkipPublisherCheck

# Chromium for Playwright e2e
npx playwright install chromium

# Kokoro v1 weights for the default TTS engine (~1 GB)
powershell -ExecutionPolicy Bypass -File server/tts-sidecar/scripts/install-kokoro.ps1
```

**Run**

```powershell
npm start                  # frontend + server + TTS sidecar in one shot
# or, three terminals if you want them split:
npm run dev:frontend       # Vite on http://localhost:5173
npm run dev:server         # Node API on http://localhost:8080
npm run tts:sidecar        # FastAPI TTS on http://localhost:9000
```

Since v1.3.0 the server owns the TTS sidecar child-process lifecycle (per-user `autoStartSidecar` preference, default on) — `npm start` brings up frontend + server + sidecar from one terminal, and Ctrl+C tears the sidecar down cleanly.

The frontend opens to the book library at <http://localhost:5173>. Configure analyzer and TTS preferences from the Account page once the app is up. The Account → Models card (also new in v1.3.0) installs Ollama, pulls model weights, and pre-fetches Coqui XTTS without dropping to a terminal.

**Verify your install**

```powershell
npm run verify             # typecheck + all tests + e2e + build
```

This is the same battery the pre-push hook runs. Sub-batteries:
`npm run test:fast` (pre-commit), `npm run verify:quick` (all tests, no
e2e/build), `npm run test:e2e` (Playwright only).

## Features

- **Manuscript ingestion** — paste or upload `.md`, `.txt`, `.epub`, `.pdf`, `.mobi`, or `.azw3`; chapter names extracted, low-confidence speaker assignments surfaced for review. DRM-protected MOBI files are rejected up-front with a clear error.
- **Analyzer choice** — local Ollama (default, no API key required), Gemini free-tier (cloud, 1500 RPD), or manual file-drop coworking with any chat model. Sticky across navigation and process restarts. **In-app multi-model management (v1.3.0)** — Install Ollama, pull a model, and pre-fetch Coqui XTTS from the Account → Models card without dropping to a terminal.
- **Voice library** — per-engine catalogs, family grouping, drag-to-assign, per-character overrides, sample playback, side-by-side cast comparison. **Same-book cast compare from the global Voices tab (v1.3.0)** — on-demand fetches the foreign book's cast so you can audition two characters from a different book side-by-side.
- **TTS engines** — Kokoro v1 (eager-loaded English-only, 28 voices), Coqui XTTS v2 (button-driven, zero-shot cloning), Gemini cloud. Per-character voice profiles persist across engine switches. **Voice preview while editing (v1.3.0)** — audition multiple voice candidates inside the profile drawer with a user-editable sample line, without committing the assignment.
- **Generation** — per-chapter SSE stream, sticky across navigation, cold-boot resumable. Auto-retry on transient sidecar failures. **Cross-tab state sync (v1.3.0)** — open the same book in two tabs and the analysis / generation pills update in lockstep via `BroadcastChannel`, no round-trip needed.
- **Revisions & drift** — pending-revisions pill, A/B audio audition with rollback preservation, full diff view, engine-drift detection per chapter. **Revision history timeline (v1.3.0)** — read-only chronological log of accept/reject events per chapter, surfaced from the existing A/B player modal.
- **Listening surface (overhauled in v1.3.0)** — playback speed picker (0.75×–2×, persisted per book), user-placed markers (note / rerecord) with a listen-view sidebar, sleep timer with countdown presets + end-of-chapter mode, true RMS waveform peaks computed at encode time, listening-progress resume bookmarks, per-book editorial notes (collapsible card), share a 30-second clip of any chapter as MP3, mint a slugged share URL for the whole book M4B.
- **Library covers** — auto-fetch from OpenLibrary on import, manual picker with three tabs (search, upload, frame), drag-pan + zoom framing without re-encoding the source JPEG.
- **Export** — M4B (with cover, chapter atoms, optional descriptions), MP3 zip, per-chapter MP3 folder, sync-folder save, LAN download with QR. Chapter audio is MP3 VBR V2.
- **Persistence** — per-book `state.json` + `cast.json` + `manuscript-edits.json` with rotating backups, torn-read recovery, and schema versioning for forward-compatible migrations.
- **Themes (stable in v1.3.0)** — Light / Dark / System toggle with an account-managed first-visit default. Full dark-mode coverage across white / amber / red / rose ladders + bespoke `floating-pill-inverse` utility for the cast-view selection bar.

## Layout

```
src/                  Vite + React 18 + Redux Toolkit frontend
  store/              RTK slices (ui, cast, chapters, revisions, manuscript,
                      book-meta, notifications, broadcast-middleware)
  views/              Stage views (books, upload, analysing, confirm, ready, listen,
                      account); listen.tsx is an orchestrator over the sub-components
                      below (decomposed in v1.3.0)
  components/         Shared UI primitives
    listen/           Listen-view region sub-components — listen-header,
                      listen-player-region, listen-download-section (v1.3.0)
  modals/             Profile drawer, cover picker, compare-cast, share-clip,
                      share-link, etc.
  lib/                api, router, types, generated api-types
  mocks/              VITE_USE_MOCKS=1 fixtures
server/               Node + Express API (TypeScript)
  src/
    routes/           HTTP routes including new /api/books/:bookId/share +
                      /share/:slug + /api/books/:bookId/chapters/:chapterId/clip
                      (v1.3.0)
    ollama/           Vendor-installer bootstrap (v1.3.0)
  tts-sidecar/        Python FastAPI TTS sidecar (Coqui + Kokoro)
    scripts/          install-kokoro.{sh,ps1} + install-coqui.{sh,ps1} (v1.3.0)
  handoff/            Manual-analyzer inbox/outbox (when ANALYZER=manual)
e2e/                  Playwright specs against Vite in mock mode
scripts/              Orchestration (start/stop/install/preflight) — primarily
                      Node ESM since v1.2.2; wt-new.mjs spawns parallel Claude
                      worktrees (v1.3.0)
.github/workflows/    CI — release.yml on tag push, verify.yml on every PR (v1.3.0)
docs/
  features/           Living per-feature regression plans (INDEX.md)
  features/archive/   Plans that shipped and are no longer load-bearing
  BACKLOG.md          MoSCoW-bucketed outstanding work
  project-narrative.md  Project story for design / engineering conversations
openapi.yaml          API contract — single source of truth for shapes
```

## Configuration

Server reads `server/.env` (Node 20.6+ native `process.loadEnvFile`).
Copy `server/.env.example` as a starting point. Notable knobs:

- `ANALYZER` — `local` (default, Ollama), `manual`, or `gemini`.
- `GEMINI_API_KEY`, `GEMINI_MODEL`, and the per-model RPM / TPM / RPD
  caps when `ANALYZER=gemini`.
- `PRELOAD_COQUI` — `0` (default; Coqui loads on demand) or `1`.
- `WORKSPACE_DIR` — where per-book `.audiobook/` folders live.

Frontend reads `VITE_USE_MOCKS` from `.env.development`. Mock mode
round-trips against an in-memory store and is what the Playwright e2e
suite runs against.

## Documentation

- [`docs/features/INDEX.md`](docs/features/INDEX.md) — every shipped
  feature has a living regression plan with invariants, acceptance
  walkthrough, and test pointers.
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — MoSCoW-bucketed outstanding
  work; future rounds pull from here.
- [`CLAUDE.md`](CLAUDE.md) — project context for AI assistants:
  conventions, commands, branching, testing discipline.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — commit convention, scope
  vocabulary, branching workflow, release-notes rules.

## Releases

Packaged downloads of tagged releases are published to
[GitHub Releases](https://github.com/dudarenok-maker/Audiobook-Generator/releases).
Each release is a single platform-independent `audiobook-generator-vX.Y.Z.zip`
plus a `.sha256` checksum. Follow [`INSTALL.md`](INSTALL.md) for the
extract-and-run walkthrough (Windows, macOS, Linux). The release pipeline
is documented in [`docs/features/archive/49-release-package.md`](docs/features/archive/49-release-package.md).

## Testing

Five harnesses, all wired into `npm run verify`:

| Harness            | Command                | What it covers                          |
| ------------------ | ---------------------- | --------------------------------------- |
| Frontend           | `npm test`             | Vitest + jsdom, React Testing Library   |
| Server             | `npm run test:server`  | Vitest + node, ffmpeg integration       |
| Sidecar            | `npm run test:sidecar` | pytest against the Python venv          |
| PowerShell scripts | `npm run test:scripts` | Pester 5 against `scripts/lib/`         |
| End-to-end         | `npm run test:e2e`     | Playwright + Chromium against mock mode |

Commit gating runs `verify:fast` on pre-commit and the full `verify` on
pre-push. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the commit
convention enforced by `.husky/commit-msg`.

## License

Private — not currently licensed for redistribution.
