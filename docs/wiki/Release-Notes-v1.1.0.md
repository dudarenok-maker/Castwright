Released 2026-05-17. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.1.0).

---

# Castwright 1.1.0

**Polish, resilience, and the v1 ergonomics gaps.** Dark mode, an auto-starting
sidecar, cover framing, sticky analysis, and `state.json` resilience.

---

## ✨ Headline features

### 🌗 Dark mode (new)
- Light / Dark / System toggle in the top bar with an account-managed first-visit
  default; a `[data-theme="dark"]` token-override block reflects every shipped
  surface without per-component dark-class plumbing (plan 42).

### 🔌 TTS sidecar starts with the server (new)
- Per-user `autoStartSidecar`; `start-app.bat` brings up frontend + server +
  sidecar in one shot, Node owning the child-process lifecycle (port-9000 probe →
  spawn → `.run/tts.pid` → tree-kill on SIGINT / SIGTERM) (plan 43).

### 🖼️ Cover artwork framing (new)
- A three-tab `CoverPicker` (Search / Upload / Frame) — drag-pan + zoom keeps the
  meaningful part of portrait covers inside square / landscape frames; framing is
  metadata-only (applied at render time via `object-position` + `transform`,
  no re-encode); local-disk upload covers self-pub + non-English titles (plan 40).

---

## 🎙️ Voice & continuity

- **Manual continuity link** to a prior series book on the Profile Drawer's "Merge
  into" dropdown — closes the `nameScore < 0.34` floor gap where the matcher
  dropped a legitimate match (e.g. "Dexter Alvin Diznee" vs "Dex") and the
  duplicate was unreachable (plan 09).

## 🩺 Resilience

- **Sticky analysis across navigation** — re-running a failed sentence subset
  survives leaving the analysing view; cold-boot rehydrate scans every book's
  analysis-state on boot, with "Paused — resume?" / "Halted — review?" card badges
  (plan 32).
- **Auto-retry transient TTS failures** — per-group bounded retry absorbs sidecar
  503s / connection-refused without wedging the queue.
- **Rotating `state.json` backups + torn-read recovery** — the single most
  valuable file keeps a rolling history; a torn write falls back to the most recent
  intact backup. Redux-persist on ui + manuscript restores the last stage / chapter
  on refresh (plan 27).

## 🎧 Fixes

- **Reassigning a sentence on chapter 2+ reassigned the same-id sentence in
  chapter 1** — the reducer keyed only by id. Now all three manuscript-slice
  reducers key by `(chapterId, id)`, so reassignments land on the clicked sentence
  (plan 12a).
- **Cold-boot rehydrating a book with a live local analysis auto-fired generation**
  — the analyzer and TTS fought over a single GPU and both halted. Now the
  implicit-reconcile seam is gated like explicit TTS-start callsites (plan 32).
- **Confirm / Ready could land with empty `cast.characters`** after a Phase 0
  cache resume (manuscript hydrated faster than cast). Now the views re-fetch when
  cast is empty.

## 🏗️ Under the hood

- **`state.json` schema seam** — a `schema` field with a v1 → vN migration seam,
  stamping `schema: 1` now for clean room later (plan 27).
- Five new Playwright specs (golden path, listen playback, per-stage Redux +
  refresh, cover framing, manual-continuity link) with light + dark visual
  baselines; sidecar pytest pins thread-pool saturation for `/synthesize`.
- **Release-notes conventions documented in `CONTRIBUTING.md`**; a real `README.md`
  landing page with install / run / verify.

**Full changelog:** `v1.0.0...v1.1.0`
