# Castwright

> _Any book, performed by a full cast — effortlessly. Even in your own voice._
> (The internal package / repo name stays `audiobook-generator`.)

Turn a manuscript into a finished, **full-cast** audiobook on your own machine — every
character in their own voice, consistent across a whole series.

Upload `.md` / `.txt` / `.epub` / `.pdf` → an analyzer extracts characters,
chapters, and per-sentence speaker tags → assign a TTS voice to each
character → generate per-chapter audio → listen, revise, export to M4B
or MP3.

The pipeline runs locally end-to-end. Analysis can use a local Ollama
model (default) or the Gemini free-tier API. TTS uses Kokoro v1 (eager-loaded, ~1 GB
VRAM) by default, with Coqui XTTS v2 available on demand for zero-shot
voice cloning.

## Quickstart

**Prerequisites**

- Node 20.19 or newer (Vite 8 requires ≥20.19 / ≥22.12; the repo targets Node 24 via `.nvmrc`)
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

- **Manuscript ingestion** — paste or upload `.md`, `.txt`, `.epub`, `.pdf`, `.mobi`, or `.azw3`; chapter names extracted, low-confidence speaker assignments surfaced for review. DRM-protected MOBI files are rejected up-front with a clear error. **Diff-on-reupload (v1.4.0)** — side-by-side sentence-level diff (LCS + char-level inner highlight) gates any re-upload of an existing book before slice mutation; an amber banner flags renamed chapters whose sticky title overrides won't match the new parse.
- **Manuscript editing** — per-sentence speaker reassign, chapter merge/split/reorder, manual chapter rename with a sticky `titleOverridden` flag (v1.4.0) preserved across heuristic refresh passes. **Low-confidence triage polish (v1.4.0)** — J/K shortcuts jump to the next misattribution and auto-open the inspector; a typeahead `<CharacterSearchPicker>` lists local cast + recurring series-mates so a missing series character can be materialised from the prior roster in one click.
- **Analyzer choice** — local Ollama (default, no API key required) or Gemini free-tier (cloud, 1500 RPD). Sticky across navigation and process restarts. **In-app multi-model management (v1.3.0)** — Install Ollama, pull a model, and pre-fetch Coqui XTTS from the Account → Models card without dropping to a terminal. **Pipelined two-model analyzer (v1.4.0)** — opt-in Phase 0 (cast detection, e.g. `gemma-4-31b-it`) and Phase 1 (sentence attribution, e.g. `gemini-3.1-flash-lite`) run in parallel with a configurable 10-chapter minimum lag, hitting independent rate-limit buckets so effective quota nearly doubles. Phase model picker + min-lag knob live on the Account tab.
- **Voice library** — per-engine catalogs, family grouping, drag-to-assign, per-character overrides, sample playback, side-by-side cast comparison. **Same-book cast compare from the global Voices tab (v1.3.0)** — on-demand fetches the foreign book's cast so you can audition two characters from a different book side-by-side.
- **TTS engines** — Kokoro v1 (eager-loaded English-only, 28 voices), Coqui XTTS v2 (button-driven, zero-shot cloning), Gemini cloud. Per-character voice profiles persist across engine switches. **Voice preview while editing (v1.3.0)** — audition multiple voice candidates inside the profile drawer with a user-editable sample line, without committing the assignment. **Kokoro stop pill (v1.4.0)** — top-bar pill evicts Kokoro to free ~1 GB VRAM for an XTTS warm or a heavier analyzer model without restarting the sidecar.
- **Generation** — per-chapter SSE stream, sticky across navigation, cold-boot resumable. Auto-retry on transient sidecar failures. **Cross-tab state sync (v1.3.0)** — open the same book in two tabs and the analysis / generation pills update in lockstep via `BroadcastChannel`, no round-trip needed. **Parallel chapter synthesis (v1.4.0)** — bounded worker pool over chapters via `GEN_CHAPTER_CONCURRENCY` (default 2); per-chapter SSE tracks isolated through the chapters slice so interleaved events never cross. **Voiced chapter titles + inter-chapter silence (v1.4.0)** — each chapter audio now opens with the title rendered as a period-separated clause (`Chapter 2. Moolark.`) in the project's narrator voice, followed by a baked-in silence; reads cleanly across Coqui / Kokoro / Gemini.
- **Revisions & drift** — pending-revisions pill, A/B audio audition with rollback preservation, full diff view, engine-drift detection per chapter. **Revision history timeline (v1.3.0)** — read-only chronological log of accept/reject events per chapter, surfaced from the existing A/B player modal. **Cast Drift consolidation (v1.4.0)** — drift report modal collapses by `(book × character × snapshot)` — ~300 events surface as ~6–18 cards with bulk Regen-all / Dismiss-all / Auto-regen-all on multi-chapter groups. **Background drift polling (v1.4.0)** — `GET /api/revisions?bookIds=...` bulk endpoint + two-tier poller (30 s active, 120 s background) surfaces drift on non-active books within ~2 min without a navigate.
- **Listening surface (overhauled in v1.3.0)** — playback speed picker (0.75×–2×, persisted per book), user-placed markers (note / rerecord) with a listen-view sidebar, sleep timer with countdown presets + end-of-chapter mode, true RMS waveform peaks computed at encode time, listening-progress resume bookmarks, per-book editorial notes (collapsible card), share a 30-second clip of any chapter as MP3, mint a slugged share URL for the whole book M4B. **Loudness report card (v1.4.0)** — colour-coded per-row drift pill (≤2 / 2–4 / >4 LU buckets) + expandable card with summary line, sparkline, and per-chapter table.
- **Library** — auto-fetched OpenLibrary covers on import; manual cover picker with three tabs (search, upload, frame), drag-pan + zoom framing without re-encoding the source JPEG. **Library polish (v1.4.0)** — debounced title/author search + tag-chip filter; card↔table view toggle with series grouping; portable book bundle (`.zip` of state + manuscript + audio + cover + change-log + MANIFEST) for export and import.
- **Export** — M4B (with cover, chapter atoms, optional descriptions), AAC/M4A zip, Opus zip, MP3 zip, per-chapter MP3 folder, portable book bundle (v1.4.0), sync-folder save, LAN download with QR. **Per-book audio format (v1.4.0)** — `BookStateJson.audioFormat` (default `'mp3'`, also `'aac-m4a'` or `'opus'`) drives the chapter encode + matching export shapes; libfdk_aac auto-detects with native AAC fallback. **EBU R128 loudness normalization (v1.4.0)** — two-pass `loudnorm` at -16 LUFS / 11 LU / -1.5 dBTP on by default (`AUDIO_LOUDNORM_ENABLED=false` opts out); voice samples deliberately skip the pass.
- **Exports + sync folder (v1.4.0)** — finished artifacts now land at `<bookDir>/exports/<slug>.<ext>` (visible) rather than the hidden `.audiobook/exports/<id>/` jail; export modal auto-saves the sync folder on blur with an inline error banner and a "Test" probe button; widened `renameWithRetry` covers Google Drive for Desktop and OneDrive virtual-FS EACCES/EIO hiccups with destination-specific hints.
- **Persistence** — per-book `state.json` + `cast.json` + `manuscript-edits.json` with rotating backups, torn-read recovery, and schema versioning for forward-compatible migrations.
- **Themes (stable in v1.3.0)** — Light / Dark / System toggle with an account-managed first-visit default. Full dark-mode coverage across white / amber / red / rose ladders + bespoke `floating-pill-inverse` utility for the cast-view selection bar.
- **Mobile + tablet (v1.4.0)** — every view re-laid out across three Tailwind viewport tiers (`<640px` phone, `640–1024px` tablet, `≥1024px` desktop); LAN HTTPS via `mkcert` (`npm run install:cert-mobile` prints LAN URL + QR + per-OS root-cert install steps; `npm run dev:lan` / `start:lan` brings Vite + Node up on `https://0.0.0.0:5173`/`:8443`); touch-equivalence for every drag/hover affordance (tap-to-assign voice pill, PointerEvents on manuscript paragraph boundaries, `coarse-pointer:` Tailwind variant for hover-reveal labels); 44×44 px touch targets enforced.
- **Frontend performance (v1.4.0)** — `useWindowVirtualizer` from `@tanstack/react-virtual` wraps the manuscript segment list above 60 segments, and the confirm-cast picker + listen chapter list above 40 rows (short books stay on the flat-render path). Broadcast-middleware shallow-diffs snapshots, `useAppSelectorShallow` applied at five large-slice sites, route-level `React.lazy` code-split. Main bundle 410 kB → 345 kB (gzip 108 kB → 91 kB).
- **Android companion app** — a native **Flutter** listening companion (`apps/android/`) that pairs to the server over LAN HTTPS, **delta-syncs only the chapters that changed** (per-chapter `…/audio` files, not whole-book re-exports), and plays offline with background / lock-screen / Bluetooth / Android-Auto controls + two-way resume sync. Pairing is cryptographically auto-verified — the app fetches `/cert/root.crt` and pins the CA itself, so **no OS root-cert install is needed on the phone**. See [Companion app (Android)](#companion-app-android) below and [`apps/android/README.md`](apps/android/README.md). The full architecture + delivery log is [`docs/features/188-android-companion-app.md`](docs/features/188-android-companion-app.md).

## Layout

```
src/                  Vite 8 (Rolldown) + React 19 + Redux Toolkit frontend
  store/              RTK slices (ui, cast, chapters, revisions, manuscript,
                      book-meta, notifications, broadcast-middleware,
                      engines-in-use-selector)
  views/              Stage views (books, upload, analysing, confirm, ready, listen,
                      account, worktrees); listen.tsx is an orchestrator over the
                      sub-components below (decomposed in v1.3.0); book-library.tsx
                      is a thin orchestrator over src/components/library/* (v1.4.0)
  components/         Shared UI primitives — including character-search-picker (v1.4.0),
                      manuscript-diff, loudness-report, delayed-spinner, stat-tiles
    listen/           Listen-view region sub-components — listen-header,
                      listen-player-region, listen-download-section (v1.3.0)
    library/          Library-view sub-components — library-chrome (search + tags +
                      view toggle), library-grid, library-table, library-status-ui,
                      library-empty-states (v1.4.0)
  modals/             Profile drawer, cover picker, compare-cast, share-clip,
                      share-link, edit-book-meta, edit-chapter-title (v1.4.0), etc.
  lib/                api, router, types, generated api-types, manuscript-diff,
                      chapter-override-conflict, use-debounced-value
  mocks/              VITE_USE_MOCKS=1 fixtures
server/               Node + Express API (TypeScript)
  src/
    routes/           HTTP routes including /api/books/:bookId/share +
                      /share/:slug + /api/books/:bookId/chapters/:chapterId/clip
                      (v1.3.0); /api/books/:id/export/portable + /api/import/portable
                      + /api/books/:bookId/cast/add-from-roster +
                      /api/books/:bookId/chapters/:chapterId/rename +
                      /api/revisions?bookIds=... + /api/worktrees +
                      /api/user/settings/sync-folder/test +
                      /api/sidecar/{load,unload} + /cert-root (v1.4.0)
    analyzer/         phase-watermark + select-analyzer for the pipelined
                      two-model Phase 0/1 split (v1.4.0)
    tts/              loudnorm.ts (EBU R128 two-pass), aac.ts, opus.ts,
                      synthesise-chapter.ts (parallel-friendly extracted entry),
                      chapter-title-narration.ts (v1.4.0)
    export/           build-portable-book.ts, build-codec-zip.ts (v1.4.0)
    import/           scan-import-folder.ts (v1.4.0)
    ollama/           Vendor-installer bootstrap (v1.3.0)
  tts-sidecar/        Python FastAPI TTS sidecar (Coqui + Kokoro)
    scripts/          install-kokoro.{sh,ps1} + install-coqui.{sh,ps1} (v1.3.0)
  handoff/            Gemini analyzer prompt/response traceability
apps/android/         Flutter companion app (pkg castwright) — domain
                      (pure logic) / data (cert-pinned client, drift store, sync
                      engine, player) / ui; iOS target lives here too. See
                      apps/android/README.md + docs/features/188-…md
e2e/                  Playwright specs against Vite in mock mode (chromium-only
                      pre-push); responsive/* runs against mobile-chrome (Pixel 7)
                      and tablet-chrome (iPad Pro 11) via npm run test:e2e:mobile
                      (v1.4.0)
scripts/              Orchestration (start/stop/install/preflight) — primarily
                      Node ESM since v1.2.2; wt-new.mjs spawns parallel Claude
                      worktrees, wt-list.mjs shows their port assignments,
                      wt-merge.mjs (v1.3.1) drives the integration-branch
                      reconciliation pattern, setup-lan-certs.mjs +
                      print-cert-install-instructions.mjs bootstrap mkcert
                      HTTPS for mobile testing (v1.4.0)
.github/workflows/    CI — release.yml on tag push, verify.yml on every PR (v1.3.0);
                      Node 24 since v1.4.0
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

- `ANALYZER` — `local` (default, Ollama) or `gemini`.
- `GEMINI_API_KEY`, `GEMINI_MODEL`, and the per-model RPM / TPM / RPD
  caps when `ANALYZER=gemini`.
- `ANALYZER_PHASE0_MODEL` / `ANALYZER_PHASE1_MODEL` /
  `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` (v1.4.0) — opt-in pipelined
  two-model analyzer (Gemma cast + Gemini attribution by default,
  10-chapter min lag). Set both phase vars to enable; legacy
  single-model `ANALYZER=…` path preserved verbatim when unset. The
  Account tab UI mirrors the same knobs per-book.
- `PRELOAD_COQUI` — `0` (default; Coqui loads on demand) or `1`.
- `GEN_WORKERS` (v1.4.0; renamed from `GEN_CHAPTER_CONCURRENCY`, which is no
  longer read) — how many chapters the generation queue synthesises
  concurrently. Default `2`. Queue concurrency only; the GPU semaphore
  (`GPU_VRAM_BUDGET` / `GPU_CONCURRENCY`) is the separate VRAM guard.
- `AUDIO_LOUDNORM_ENABLED` (v1.4.0) — `true` (default; two-pass EBU R128
  at -16 LUFS / 11 LU / -1.5 dBTP on every newly-rendered chapter) or
  `false` to opt out per server install. Voice samples deliberately
  skip the pass.
- `WORKSPACE_DIR` — where per-book `.audiobook/` folders live.
- `LAN_HTTPS` — `1` flips the listener from HTTP `:8080` (loopback) to
  mkcert-backed HTTPS `:8443` bound on all interfaces (mobile/tablet web access
  and the Android companion). Off by default; `npm run start:lan` sets it.
  Requires the LAN cert (`npm run install:cert-mobile`).
- `LAN_AUTH_TOKEN` — a shared secret that, together with `LAN_HTTPS=1`, turns on
  the LAN access guard on `/api` + `/workspace` (loopback always bypasses;
  `/cert/root.crt` + `/audio` stay open). **Required for the companion** — it's
  the pairing token, surfaced in the `GET /api/export/lan` pairing payload. Per-
  device, individually-revocable tokens layer on top via `GET/POST/DELETE
  /api/devices` (`srv-33`).

Frontend reads `VITE_USE_MOCKS` from `.env.development`. Mock mode
round-trips against an in-memory store and is what the Playwright e2e
suite runs against.

### Mobile + tablet over LAN HTTPS (v1.4.0)

1. One-time per dev box: `scoop install mkcert` (Windows), `brew install mkcert` (macOS), or `apt install mkcert` (Linux), then `mkcert -install`.
2. `npm run install:cert-mobile` — prints LAN URL + QR code + per-OS root-cert install steps.
3. Install the root CA on each mobile device once (iOS: Settings → Profile downloaded → Install → trust; Android: Settings → Security → Install certificate).
4. `npm run dev:lan` (HMR-capable Vite + Node at `https://0.0.0.0:5173`/`:8443`) or `npm run build && npm run start:lan` (production bundle at `https://0.0.0.0:8443`).
5. Open the printed LAN URL on the device — lock icon, no warning.

E2E across phone (Pixel 7) and tablet (iPad Pro 11) viewports is opt-in via `npm run test:e2e:mobile` (~10–15 min); the pre-push gate (`npm run test:e2e`) is chromium-only.

## Companion app (Android)

The native Flutter companion lives in [`apps/android/`](apps/android/README.md).
It pairs to a server running in **LAN HTTPS mode with an access token** and then
delta-syncs + plays offline. The web UI's LAN setup above is shared; the
companion adds an **access token** (the pairing secret) on top.

**Server side — bring it up for pairing:**

1. One-time LAN cert (same as mobile web): install `mkcert` (e.g. `winget install
   FiloSottile.mkcert` on Windows), then `npm run install:cert-mobile` (runs
   `mkcert -install` and writes `.run/certs/`).
2. In `server/.env` set both:

   ```
   LAN_HTTPS=1
   LAN_AUTH_TOKEN=<a-strong-secret>
   ```

3. Start in LAN mode: `npm run start:lan` (binds `https://0.0.0.0:8443`). With
   `LAN_HTTPS=1` set, the server **hard-exits if the LAN cert is missing** — run
   step 1 first.
4. The pairing values come from `GET /api/export/lan` →
   `{ urls, port, protocol: "https", token, caFingerprint }`.

**Phone/emulator side — pair:** open the app → **Pair a device** → scan the
pairing QR, or enter **Server URL** (`https://<lan-ip>:8443`), **access token**,
and **CA fingerprint (SHA-256)** manually. The app fetches `/cert/root.crt`,
verifies its SHA-256 against the fingerprint, and pins the CA in its own TLS
context — **no OS root-cert install on the phone** (unlike the web UI, which
needs the root CA trusted in the device browser).

**Per-device tokens (optional, `srv-33`):** `POST /api/devices` mints an
individually-revocable token; `GET /api/devices` lists them; `DELETE
/api/devices/:id` revokes one. Layered on the shared secret — the shared token
keeps working.

Build/run/test the app itself per [`apps/android/README.md`](apps/android/README.md).
_Distribution: each tagged [GitHub Release](#releases) attaches a built
`castwright-vX.Y.Z.apk` (sideload it) plus an unsigned iOS build —
it's a separate Flutter build from the server zip, but shipped alongside it on
the same release._

## Parallel sessions (developer-only)

Multiple Claude Code (or any) sessions can run in parallel against this
repo via git worktrees with non-colliding ports:

- `node scripts/wt-new.mjs feat/foo-slug` — creates a worktree under
  `.claude/worktrees/agent-…`, cuts the branch, and writes a `.env.local`
  with VITE_PORT / PORT / LOCAL_TTS_PORT / PLAYWRIGHT_PORT offset by
  `slot * 10` so dev servers don't fight over `:5173` / `:8080` / `:9000`
  / `:5174`. The parent worktree keeps stock defaults.
- `node scripts/wt-list.mjs` — terminal-friendly table of every active
  worktree with its slot, branch, and port assignments.
- **`#/worktrees` view (dev mode only)** — once a dev server is running
  (`npm run dev`), open `http://localhost:5173/#/worktrees` or click
  the small `wt` chip in the top-bar (left of the theme toggle, dev-only).
  The view lists every worktree with a live TCP probe against each
  VITE_PORT (green dot = dev server alive). Click a green row → opens
  that worktree's dev URL in a new tab. Auto-refresh every 10 s. The
  backing `GET /api/worktrees` route 404s in production builds.
- `node scripts/wt-merge.mjs <branch> [<branch>...]` — drives the
  CONTRIBUTING.md "Reconciliation pattern" for parallel-agent branches:
  cuts `integration/<YYYY-MM-DD>` off `main`, merges each branch via
  `--no-ff`, runs `npm run verify` between merges, aborts on conflict
  (exit 2) or verify failure (exit 3) with a copy-pasteable follow-up.
  Idempotent; `--dry-run` previews without mutating.

See [`docs/features/archive/86-worktree-dashboard.md`](docs/features/archive/86-worktree-dashboard.md),
[`docs/features/archive/85-wt-merge-helper.md`](docs/features/archive/85-wt-merge-helper.md),
and [`CONTRIBUTING.md` "Parallel agents"](CONTRIBUTING.md#parallel-agents)
for the full workflow.

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
Each release attaches (all with `.sha256` checksums):

- `audiobook-generator-vX.Y.Z.zip` — the platform-independent **server** bundle
  (Windows / macOS / Linux); follow [`INSTALL.md`](INSTALL.md).
- `castwright-vX.Y.Z.apk` — the installable **Android companion** app
  (plan 188), versioned in lockstep via `scripts/bump-version.mjs` (which now
  also bumps `apps/android/pubspec.yaml`). Sideload it onto the phone.
- `castwright-vX.Y.Z-ios-unsigned.*` — the **unsigned iOS** build
  (app-12 prep): the release pipeline compiles the iOS app every release so the
  pathway stays green; it needs Apple signing certs to become an installable
  `.ipa` (tracked as `app-12`).

The release pipeline is documented in
[`docs/features/archive/49-release-package.md`](docs/features/archive/49-release-package.md).

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
