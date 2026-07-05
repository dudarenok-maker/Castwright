# Castwright v1.5.0

Released 2026-05-29. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.5.0).

---

# Castwright 1.5.0

**The largest TTS round since the engine first shipped.** v1.5.0 adds Qwen3-TTS
— a bespoke per-character voice engine that *designs* a unique voice from each
cast member's persona instead of picking from a preset catalogue, caches the
embedding, and reuses it across the book and series for vocal consistency.
Generation moves onto a single persisted cross-book queue, cast management gains
"rebaseline the series" + cross-book duplicate review, and the whole synthesis
path reports live real-time-factor (RTF) telemetry.

> ⚠️ **Upgrade note:** the `GEN_CHAPTER_CONCURRENCY` env var was retired and
> renamed to `GEN_WORKERS` (default 2) — rename it in your `server/.env`. No
> `BookStateJson` schema change; `.queue.json` is created on first enqueue;
> legacy single-field `overrideTtsVoice` rows migrate lazily on read. See
> INSTALL.md "v1.4.0 → v1.5.0 notes".

---

## ✨ Headline features

### 🎙️ Qwen3-TTS bespoke voices (new)
A new local engine that *designs* a unique voice per character from the cast
persona rather than picking from a preset catalogue (plan 108).

- **Design → clone → cache → reuse** — the VoiceDesign 1.7B model synthesises a
  calibration reference from the persona, the Base 0.6B model auditions and
  renders, and the designed embedding is cached and reused for every line that
  character speaks across the book and series. A Gemini-backed persona generator
  fills `Character.voiceStyle` to seed the design.
- **Default when installed** — Qwen becomes the default engine for new books once
  installed (resolved live; an explicit Account pick is honoured forever). Install
  in one click from **Account → Models**; ~5 GB of weights download on demand and
  aren't bundled in the zip.
- **Per-character engine mixing** — each cast member carries a per-engine
  `overrideTtsVoices: { coqui?, kokoro?, gemini?, qwen? }` map, so one book can
  mix a designed Qwen principal against a Kokoro narrator.
- **Graceful Kokoro fallback** — a Qwen render with no designed voice (or when
  the engine isn't installed / loaded) renders in Kokoro instead of failing,
  shown as "Fallback (Kokoro)" (plan 130).
- **Under the hood** — batched forward passes with length-bucketing
  (`QWEN_BATCH_SIZE`, default 8), an SDPA attention path + prompt cache, an
  optional FlashAttention-2 wheel for Windows, and a VoiceDesign model that frees
  ~4–5 GB on idle (`QWEN_DESIGN_IDLE_TTL`) (plans 112, 113, 115, 117, 128).

### 🗂️ Persistent cross-book generation queue (new)
Generation is now driven by a single durable queue that survives restarts
(plans 102, 111).

- `<workspace>/.queue.json` is the sole source of truth — crash-orphaned entries
  reset to queued on boot, failed chapters persist as "Failed" with one-click Retry.
- A bounded worker pool runs N chapters concurrently (`GEN_WORKERS`, default 2).
- A global queue modal + top-bar chip show every book's queued / in-progress /
  done / failed rows, with drag-to-reorder, Clear-queue, and a force-remove escape
  hatch for stuck `in_progress` entries.

### 📊 Live RTF telemetry (new)
- The synthesis path reports live per-batch real-time-factor up the stack
  (sidecar → server → frontend) so a deployer can watch how fast their GPU is
  rendering — surfaced in the generation UI and structured logs (plan 127).

---

## 🎙️ Voice & cast management

- **Rebaseline the series** — a modal designs bespoke Qwen voices for the
  principal cast with a current-vs-proposed audition before regenerating,
  collapsing recurring members by name / alias (plans 95, 96, 99, 101).
- **Cross-book duplicate review** — hydrates both casts and lets you merge a
  duplicated character / link a shared voice from the Voices pill, with the link +
  aliases carried on the Voice payload so the warning stays gone on reload.
- **Rename + alias promotion** — cast members can be renamed and an alias promoted
  to the primary name (logged as a `name_change` event); aliases are editable with
  a reattribute-lines modal.
- **Voice status leads** — a new "Sampled" tier joins Matched / Generated; the
  cast table sorts by line count; toggle chips filter by voice-matching status
  (multi-select OR, live counts), so undesigned voices stop getting lost.
- **One-chapter A/B preview** — audition a profile-change regen on a single
  chapter before committing the full regenerate.

## 🔊 Generation performance

- **Within-chapter sentence parallelism** overlaps synthesis across a chapter's
  sentences (plan 107); a **GPU-arbitration semaphore** (`GPU_CONCURRENCY`, with
  optional VRAM-weighted budgeting via `GPU_VRAM_BUDGET`) keeps parallel sessions
  and the analyzer from double-booking an 8 GB card (plans 100, 108).
- **Per-character progress is now monotonic and exact** under parallel synth — no
  counter that jumps backwards or double-counts when several chapters are in flight.

## 🩺 Analyzer & ingest

- **Multi-model analysing view** — a per-phase model chip shows the effective
  Phase 0 / Phase 1 model with an inline swap control, plus a sticky status bar
  (plan 94). Phase 0a keeps narrator-only named characters so they aren't dropped.
- **Low-confidence triage** gains sticky next / previous navigation with a
  per-chapter badge; the Voice Drift Detector can be scoped to a single character.
- **EPUB / MOBI robustness** — namespace-prefixed OPF EPUBs recover through a
  raw-zip fallback that also reads NCX titles; DRM-protected MOBI uploads return a
  clean 415 with an actionable message.

## 🎧 Listening fixes

- **MP3 chapters showed the wrong / zero duration and couldn't be scrubbed** —
  libmp3lame wasn't emitting the Xing VBR header. Now chapters are seekable MP3
  with the Xing header, the mini-player trusts the server `durationSec`, and
  `scripts/rexing-existing.mjs` re-headers old files (plan 109).
- **A fully-rendered chapter showed `00:00`** in the chapter list until reload —
  the `chapter_complete` duration was dropped by the parallel-chapter coalesce.
  Now `chapter_complete` carries `durationSec` directly, with a library-scan backfill.
- **The Loudness Report Card flagged nearly every chapter as ~6 LU off-target**
  even though the audio was correctly normalised — the `.lufs.json` stored the
  *pre*-normalisation measurement. Now the post-pass measurement is persisted and
  `scripts/relufs-existing.mjs` refreshes old chapters (plan 77).
- **The Listen row time didn't track the player** and a stale "Resume" pill stayed
  visible during playback. Now the row time live-syncs and the resume pill hides.
- **Per-phase analyzer model picks had no effect** — the selection was unreachable
  and the chips showed a fabricated name. Now the picks drive each phase and the
  chips show the truly-effective model (plan 88).
- **The "carried in from prior books" pill over-counted** (a 4th-book series
  claimed 136 carried-in characters) and bloated the Phase 0a prompt ~4×. Now the
  roster dedupes by name / alias.
- **"Apply all N matches" auto-ticked profile-sync for every match.** Now it only
  auto-ticks sync for lower-confidence rows (< 0.9).
- **The low-confidence reassign picker was clipped / closed mid-gesture / invisible
  in dark mode.** Now it portals to the body with viewport-aware flipping,
  dismisses on outside-click / Esc, and has a contrasted dark surface (plan 90).
- **The Voice Drift Detector showed a raw workspace slug** and **listed the same
  chapter multiple times.** Now it shows the clean book title and rolls events up
  per chapter with an accurate flagged count (plan 91).
- **Navigating between views left the new view mid-scroll.** Now the window scrolls
  to the top on every hash-route change.

## 🏗️ Under the hood

- **CI cost reduction** — doc-only skip + path-filtered per-PR verify +
  cross-OS consolidation into `cross-os.yml` (plans 101, 103); draft-PRs-by-default,
  `--changed`-scoped vitest legs, per-job timeouts, integration-branch batching (plan 118).
- **Cross-OS gate on the release cut** — `bump-version.mjs` fires `cross-os.yml`
  on `origin/main` and BLOCKS on green before the tag is created; `--skip-cross-os`
  is the escape hatch (plan 127).
- **Test-harness tiers** — new `test:server-slow` (timeout-prone files pinned to
  one fork) and `test:e2e:visual` (chromium, `--workers=1`) so font-hinting drift
  can't race the parallel battery; 42 committed Linux baseline PNGs.
- **Dependency / security bumps** — `multer` 1→2 (upload-route CVE), ESLint 8→9
  flat-config, `jsdom` / `archiver`.
- **Build-version footer** — every view stamps the running build (e.g.
  `v1.5.0 (a1b2c3d)`) so a deployer can confirm an upgraded bundle extracted (plan 124).
- **Per-user settings** moved to `~/.audiobook-generator/user-settings.json` so
  multiple checkouts share one config. New repair scripts under `scripts/`
  (`rexing-existing`, `relufs-existing`, `recover-missing-character`, …).

**Full changelog:** `v1.4.0...v1.5.0`
