Released 2026-05-22. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.4.0).

---

# Castwright 1.4.0

**The largest round since the v1.3.1 listening overhaul.** The app now drives on phone + tablet over LAN HTTPS, chapter audio is loudness-normalised against EBU R128 with a per-chapter drift report card, AAC/M4A and Opus join MP3 as first-class codecs, the analyzer pipelines a two-model split that nearly doubles quota, and generation parallelises across chapters.

---

## ✨ Headline features

### 📱 Mobile + tablet over LAN HTTPS (new)
A six-wave round bringing the app to phone + tablet (plan 81).

- **One-command LAN bootstrap** — `mkcert` drops a local root CA on every dev box; `npm run install:cert-mobile` prints LAN URL + QR + per-OS steps; `dev:lan` / `start:lan` serve HMR Vite + Node at `https://0.0.0.0:5173` / `:8443`.
- **Three viewport tiers** — `<640px` phone (single-column, drawers + bottom sheets, full-screen modals), `640–1024px` tablet (two-column, dialog modals, right drawer), `≥1024px` desktop (three-pane). Every view re-laid out.
- **Touch-equivalence rule** — every desktop drag / hover affordance ships a tap replacement (tap-to-assign voice pills, PointerEvent manuscript boundaries covering mouse + touch + pen); hover labels stay faintly visible via a new `coarse-pointer:` Tailwind variant; controls ≥ 44×44 px per WCAG 2.5.5.

### 🔊 EBU R128 loudness + new codecs (new)
- **Two-pass `loudnorm`** targeting -16 LUFS / 11 LU / -1.5 dBTP on every newly-rendered chapter (`AUDIO_LOUDNORM_ENABLED`), surfaced as a colour-coded per-row drift pill + an expandable report card with sparkline (plans 71, 77).
- **AAC/M4A + Opus** join MP3 as first-class chapter codecs via `BookStateJson.audioFormat`, with matching export shapes (plan 72).

### 🩺 Pipelined two-model analyzer (new)
- **Phase 0** (cast detection, `gemma-4-31b-it`) and **Phase 1** (attribution, `gemini-3.1-flash-lite`) run in parallel with a configurable min-lag; the two phases hit independent rate-limit buckets, so effective quota nearly doubles. Legacy single-model path preserved verbatim when unset (plan 88).

---

## 📖 Library & manuscript

- **Library search + table view** — debounced title / author search, a tag-chip filter row (tags persist on `BookStateJson.tags`), and a card↔table view toggle with a series-grouped dense table (plans 73, 76).
- **Portable book bundle** — `GET /export/portable` streams a single `.zip` (state + manuscript + audio + cover + change-log + MANIFEST); `POST /import/portable` accepts it with rename / replace / skip conflict modes (plan 75).
- **Manuscript re-upload diff** — a side-by-side sentence-level diff gates re-upload before any state mutation, warning when chapter title overrides won't match the new content (plans 74, 84).
- **Per-chapter rename** — a pencil affordance on every chapter row, persisted with a sticky `titleOverridden` flag that survives heuristic refresh-titles passes (plan 78).
- **Low-confidence triage polish** — J / K jump to next / previous misattribution and auto-open the inspector; a typeahead picker materialises a missing series-mate from the prior roster via `POST /cast/add-from-roster` (plan 90).

## 🩺 Cast drift & multi-book

- **Drift modal collapses ~300 events into ~6–18 cards** — one card per `(book × character × snapshot)` instead of one per event (~7,200 DOM nodes → ~200), with bulk Regen-all / Dismiss-all / Auto-regen-all (plan 91).
- **Background drift polling** — a bulk `GET /api/revisions?bookIds=...` + a two-tier poller (30s active, 120s background) surfaces Book B's drift in Book A's modal within ~2 min, active-book latency unchanged (plan 83).

## 🔊 Generation

- **Bounded worker pool over chapters** via `GEN_CHAPTER_CONCURRENCY` (default 2), with per-chapter SSE tracks kept isolated (plan 87).
- **Export queue Retry + Download** wired — failed rows re-fire the original POST; done rows without a signed URL stream directly (plan 82).
- **Kokoro stop pill** in the top bar frees ~1 GB VRAM for an XTTS warm or a heavier analyzer model without restarting the sidecar.

## 🎧 Generation fixes

- **Edited speaker reassignments / split sentences were silently dropped on regenerate** — the analyser cache wasn't rebuilt after a manuscript edit. Now regenerate applies the manuscript-edits overlay before synth (plan 80).
- **Chapters had no audible boundary and titles weren't spoken** — players cross-faded straight from one into the next. Now each chapter opens with its title voiced in the narrator voice + a baked-in inter-chapter silence (plan 101).
- **Force-regen on a range re-ran the catch-up replay** against the just-chosen chapters, racing the new run. Now the replay skips in-scope chapters so the user-selected scope wins.
- **The generation pill froze at its last snapshot** and never drained after completion. Now it drains to zero across excluded + idle gaps.
- **Two tabs on one workspace fanned out idle cross-tab updates.** Now the broadcast layer diffs snapshots before posting and debounces phase progress.

## 🏗️ Under the hood

- **Frontend perf pass** — broadcast-middleware shallow-diffs `activeStream`, shallow-equality selector wraps, and route-level `React.lazy` drop the main bundle 410 → 345 kB (gzip 108 → 91 kB) (plan 89); manuscript / confirm-cast / listen lists virtualise via `@tanstack/react-virtual` above their cutoffs (plans 92, 93).
- **Exports moved out of the hidden jail** to `<bookDir>/exports/<slug>.<ext>`, with a sync-folder "Test" probe and widened rename retries for Drive / OneDrive (plan 79).
- **CI Node 20 → 22 → 24**; `scripts/wt-merge.mjs` reconciliation helper (plan 85); dev-only worktree dashboard at `#/worktrees` (plan 86); ~14 new e2e specs + the responsive harness; LAN-cert bootstrap scripts + Playwright mobile / tablet projects.

**Full changelog:** `v1.3.1...v1.4.0`
