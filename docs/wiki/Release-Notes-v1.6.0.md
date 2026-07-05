Released 2026-06-03. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.6.0).

---

# Castwright 1.6.0

**Seed release for in-app self-upgrade.** From here, future versions install
themselves from a hand-delivered bundle (Account → Application updates), on top
of a round of reliability, observability and listening polish.

> ⚠️ **Upgrade note:** the jump *into* 1.6.0 is manual; 1.6.0 → 1.7.0 is the
> first self-upgrade.

---

## ✨ Headline features

### 🚀 Update from inside the app (new)
One-click cross-version upgrades for hand-delivered alpha bundles (fs-1).

- **Versioned-directory install layout** — `releases/vX.Y.Z/` + a stable
  `launch.mjs` + shared `workspace/` / `venv/` / `models/` siblings, so the
  running release is never touched and rollback is just not flipping the pointer.
- **Safe migrations** — a boot coordinator backs up every workspace JSON before
  migrating; a top-bar version pill + what's-new banner surface the running version.

### 🌍 Multi-language — Russian (new)
A book-level BCP-47 language field, end to end (fs-2, language half).

- **Cyrillic auto-detection** + a confirm-step selector; designed Qwen voices
  speak the book's language; Cyrillic-aware analyzer token estimates and
  per-language attribution; a Listen language badge.
- **Never-cross-language invariant** force-routes non-English books to Qwen
  (Kokoro is English-only) and blocks any silent cross-language fallback. English
  books are byte-identical to before.

### 🩺 Admin watch console (new)
The former dev-only Worktrees view is now an all-users **Admin** console at
`#/admin` (fs-18).

- **Health board** — green / amber / red on GPU / VRAM, TTS sidecar + resident
  models, analyzer connectivity, ffmpeg, free disk, from a new `GET /api/diagnostics`,
  plus generation throughput. The top-bar pill carries a health status dot.

---

## 🎧 Listening experience

- **Auto-advance / continuous playback** — the mini-player advances to the next
  chapter and keeps playing, behind a default-on toggle (Account → Advanced), so
  a book plays hands-free end to end (fe-23).
- **Skip forward / back** — intra-chapter ±15s / ±30s seek in the mini-player
  with rebindable shortcuts (defaults J / L) and configurable deltas (fe-24).

## 🔊 Generation quality & reliability

- **Post-synthesis audio QA** — each finished chapter gets a cheap automated
  check (near-silent / clipped / truncated / runaway duration) and an advisory
  "Suspect" badge with the reason in Generate + Listen, so garbled or empty
  renders are flagged before the listener hits them (srv-27).
- **Pre-flight disk-space guard** — free space is checked against an estimate
  before a run or export and a warning is surfaced when it's tight (configurable
  to block) — no more failing 40 chapters into a run (srv-28).
- **Silent generation stalls** could leave a chapter showing a misleading
  "Queued" forever. Now a per-chapter no-progress watchdog records a real
  failure, leak-saturated orphan sidecars are no longer adopted, and the
  supervisor health-polls adopted sidecars.
- **A Qwen reload doubled VRAM** into the Windows sysmem-spill stall. Now the
  reload no longer doubles VRAM and the recycle watchdog also keys on reserved VRAM.
- **"Design & compare" broke** on a missing voice or a design-model race. Now it
  no longer breaks, and the persona prompt aligns with the official VoiceDesign format.
- **Ungenerated chapters masqueraded as playable** in the Listen view. Now Play /
  Share are gated on generated audio.

## ⚙️ Settings, observability & models

- **Plain-language failure messages** — recurring failures (sidecar down, VRAM
  spill, rate-limit, OOM, disk-full, model-not-loaded, timeouts) now show a
  human-readable message plus a "what to do next" line instead of a raw error
  string (fs-19).
- **Per-run resource telemetry** — per-chapter RTF, VRAM, host RAM and wall-time
  are logged and charted in a new Admin "Resource trends" panel for
  perf-regression visibility (fs-20).
- **Auto-backup of `state.json`** — scheduled per-book snapshots on a
  configurable cadence with retention + one-click restore from Account (srv-2).
- **Power-user tuning** — rebindable shortcuts, accessibility toggles
  (high-contrast + larger text) and an autosave-debounce knob, device-local (fe-2).
- **In-app Coqui XTTS v2 installer**, plus an A/B current-vs-proposed voice
  audition in the Qwen voice-design flow.

## 🏗️ Under the hood

- **Dependency major upgrades** — React 18→19, Vite 5→8 (Rolldown), Vitest 2→4,
  react-router 6→7, TypeScript 5→6 (plan 167); Zod 3→4, Express 4→5, pdfjs-dist
  4→5, Tailwind 3→4 (plan 170); GitHub Actions runners off the deprecated Node-20 majors.
- **CI cost** — path-filtered per-PR verify, draft-by-default + integration
  batching, a doc-only CI fast-path, and a local pre-push guard that refuses
  force-push / deletion of `main`.
- **Release pipeline** — three-way version lockstep (root + server + sidecar
  `version.py`), a cross-OS gate fired before tagging, and `RELEASE_NOTES.md`
  baked into the zip.

**Full changelog:** `v1.5.1...v1.6.0`
