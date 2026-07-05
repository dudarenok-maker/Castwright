# Castwright v1.7.0

Released 2026-06-14. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.7.0).

---

**The Castwright release.** The project grew up this cycle: a new name and identity,
a companion app for your phone and car, guided first-run setup, a one-click sample
book, and first-class support for Apple Silicon Macs — on top of a deep round of
generation-quality and reliability work.

> ⚠️ **Upgrade note:** 1.6.0 installs **cannot self-upgrade across the rename.**
> Alpha installs reinstall fresh as Castwright. Your library/data directories move
> to the new Castwright paths on first run.

---

## ✨ Headline features

### 📱 A mobile companion app (new)
Castwright now has a native Flutter companion for Android (and iOS), paired to your
desktop server over your home network — no cloud, no account.

- **One-scan pairing** — pair by scanning a compact QR code; the channel is
  certificate-pinned and protected by a short-lived pairing code, with per-device
  tokens you can revoke (#562, #565–#567, #679, #696, #591).
- **Take your library offline** — delta sync downloads books for offline listening,
  with range-resume, atomic swaps, accounting and automatic eviction (#572, #573,
  #606, #614, #616).
- **Native player** — lock-screen / media-key control, per-book resume, two-way
  resume sync between phone and desktop, per-chapter waveforms (#575, #576, #604, #610).
- **Listen in the car** — Android Auto / CarPlay in-car browser with a downloaded-only
  2-tab "This Book / Library" layout and current-chapter highlighting (#588, app-9).
- **Browse, search & continue** — author → series → book hierarchy, a home shelf with
  "Continue listening", and multi-book switching (#577, #582, #615, #618).
- **Stream over LAN** for instant play without a full download (#589).
- **Distribution** — signed release APK with an alpha channel, plus a Google Play
  AAB lane (#586, #777); the APK is also offered as a download from the desktop app (#661).

### 🚀 First-run setup & onboarding (new)
Getting from a fresh clone to a working install is now guided end-to-end.

- **First-run setup wizard** (fs-21) — a five-step wizard that checks everything
  Castwright needs, installs the default Kokoro voice engine in-app, bootstraps the
  Python sidecar venv, and runs a two-tier smoke test — with plain-language remediation
  when something's missing (#744, #748, #749, #750, #751).
- **In-app guided tour** (fe-38) — a spotlight walkthrough of the core flow, launchable
  any time from the top-bar **?** menu (#765, #772).
- **In-app Help / troubleshooting view** (fe-29) with a unified, friendly analysis-failure
  taxonomy so errors tell you what to do next (#740, #741).

### 📖 Try it in one click (new)
A bundled original sample — **_The Coalfall Commission_**, a 2-chapter / 14-character
showcase — ships with every voice pre-designed, so you can generate and hear a full-cast
performance before importing anything of your own (#727, #728). You can also **replace the
manuscript** on an existing book while preserving its designed cast (#724).

### 🍎 Runs on a Mac
First-class Apple Silicon support — the sidecar auto-detects Metal (mps), with graceful
CUDA → mps → CPU fallback and cross-platform launch scripts. Intel Macs work too (#702, #703).

---

## 🎙️ Voice design & casting

- **Design full cast** — one click designs a bespoke Qwen voice for every "Needs voice"
  character as a background, reload-resilient job (#637).
- **Single voice design** is now background-survivable with honest live progress (#639).
- **Per-book bulk emotion-variant design** with a per-character cast-table glyph strip,
  and emotion variants that travel across linked books in a series (#687).
- **Has / Needs emotion-variant filters** and per-card "Needs variant" badges (#642, #643).
- **Per-quote emotion loop** completed — detect-emotions + UX (fs-33/fs-34) (#596).
- **Cross-book voice reuse** hardened — match by stable voice id when names drift, scope
  generic role-names (e.g. "Narrator") to the same series, and stop cross-series mismatches
  on the confirm screen (#634, #681, #689, #693, #694).

## 🔊 Generation quality & reliability

- **Per-sentence QA gate** — every line is acoustically checked and (with srv-31)
  **transcript-verified via Whisper ASR** before a chapter is assembled, with automatic
  re-record of the broken ones (#513, #526, #531, #646).
- **Generation stall protection** — long runs ride out sidecar recycles and recover on
  their own (defense-in-depth, three waves) (#673, #677).
- **Voice-design VRAM contention** robustness — engine mutual-exclusion, liveness timeouts,
  honest progress (#685).
- **Attribution coverage guards** for large chapters — re-split under-budget stage-2
  chapters, recover dropped speakers, preserve tagged speakers (#516, #520, #532, #609, #678).
- **Golden-audio regression harness** (ops-11) — opt-in acoustic regression gate (#527).

## 🎧 Listening experience (web)

- **Continue-listening rail + reading-stats dashboard** (fs-15 / fs-16) — your shelf
  remembers what you were mid-way through; `#/stats` shows streaks and hours, fed by a
  wall-clock accumulator and offline buffering (#783, #792).
- **Listen download section** finalized with truthful, store-level export progress (#675).
- **Real per-chapter waveform bars** in the Listen view (fe-33) (#585).

## ⚙️ Models, settings & covers

- **In-app Model Manager** (fs-23) — load/unload engines and per-model Ollama residency
  from the app (#581, #766).
- **In-app Advanced Settings** — ~70 model/generation/QA knobs with an env-precedence
  resolver and drift-guarded `.env.example` (#669).
- **Multi-source cover search** — OpenLibrary + Apple + Google, with free-text matching
  and per-source badges (#697).
- **Device ground-truth on `/health`** plus a diagnostics panel (side-14) (#718).

## 🔌 Sync & server infrastructure

- **LAN security** — opt-in shared-secret token guard and per-device tokens with revoke
  (srv-20 / srv-33) (#561, #564, #591).
- **Sync primitives** — stable per-chapter UUIDs, a delta-friendly per-chapter sync
  manifest with durations, and guarded listen-progress writes (srv-32/34/35) (#558, #569, #570, #601).
- **Merge journal** for deterministic alias un-linking (srv-1) (#793).

## 🏗️ Under the hood

- **Castwright rebrand** end-to-end — package names, release artifact
  (`castwright-vX.Y.Z.zip`), data dirs, startup banner, in-app `/about` page, branded
  narrator-credit default, and self-hosted **General Sans + Lora** fonts (no runtime
  font CDN) (#623, #629, #653, #657, #660, #698, #713).
- **Public-readiness docs + licensing** (FSL-1.1-ALv2) (#663, #664).
- **Dependency majors round 3** (#712).

---

**Full changelog:** `v1.6.0...v1.7.0`
