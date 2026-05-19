# Feature regression plans

Living specs for every feature shipped in v1. Each plan combines **invariants to preserve** (structural rules a refactor must not break) and an **acceptance walkthrough** (manual click-through with expected URL hashes, redux state, and network calls). Partial features are documented as-is with a `KNOWN: scaffolded` banner so reviewers do not mistake "documented current behavior" for "fully working."

PRs that change behavior cited in a plan MUST update the relevant plan in the same diff — that is the regression discipline the plans buy.

**For outstanding work** see [`../BACKLOG.md`](../BACKLOG.md) — the MoSCoW-bucketed list of every follow-up, scaffolded item, and untested seam pulled from these plans. Future planned rounds of work pull from there.

## Writing a new plan

1. Copy [TEMPLATE.md](TEMPLATE.md) — required sections are **Benefit / Rationale**, **Architectural impact**, and **Test plan** (automated + manual).
2. Add YAML frontmatter (`status`, `shipped`, `owner`). New plans start `status: draft` until they ship.
3. Link the plan from the matching area section below.
4. Land paired automated tests in the same PR — see CLAUDE.md "Testing discipline".

## Plan lifecycle

Each plan's frontmatter `status:` is one of:

- **draft** — written, not yet implementing.
- **active** — implementation in progress on the main branch.
- **stable** — feature is end-to-end functional, behavior locked by automated tests.
- **deferred** — explicitly parked; see body for "wake when" condition.
- **scaffolded** — UI/contract in place, parts mocked or partial (matches the `KNOWN: scaffolded` body banner).

When a plan reaches **stable** AND has a filled **Ship notes** section, move it to [`archive/`](archive/README.md) in the same PR — the top-level index is the working set, not a changelog. See `archive/README.md` for the move checklist.

## How to run a plan

1. Pick a plan from the index.
2. Read the **Invariants** section first; if any cited file/line has moved, the plan is stale — fix it before validating behavior.
3. Walk the **Acceptance** steps against a running app (`npm run dev`, plus `cd server && npm run dev` and the TTS sidecar if the plan covers audio).
4. Any drift → update the plan in the same PR as the code change.

## Plans by area

### A. Stage machine & routing

- [00 — Stage machine](00-stage-machine.md) — `ui.stage` discriminated union and reducer-guarded transitions.
- [01 — Hash router](01-hash-router.md) — URL ↔ stage two-way sync, URL grammar.

### B. Upload & import

- [02 — Upload (paste or file)](02-upload-paste-or-file.md) — `.md/.txt/.epub/.pdf/.mobi/.azw3` upload + paste flow.
- [03 — Import & confirm metadata](03-import-confirm-metadata.md) — Parse-only import then confirm-write to disk.

### C. Analysis pipeline

- [04 — Analysing view & SSE progress](04-analysing-view-progress.md) — Stream rendering, live ETA, model selection, "Start fresh."
- [05 — Manual handoff analyzer](05-analyzer-manual-handoff.md) — `ANALYZER=manual` file-drop cowork loop.
- [06 — Gemini analyzer](06-analyzer-gemini.md) — `ANALYZER=gemini` direct-API mode (also the fallback when local is unreachable).
- [29 — Local Ollama analyzer + fallback](29-analyzer-ollama-local.md) — `ANALYZER=local` default; auto-fallback to Gemini only when daemon is unreachable.
- [07 — Audio tag vocabulary](07-audio-tag-vocabulary.md) — `[tag]` vocabulary UI ↔ parser sync.
- [08 — Audio tag auto-detection](08-audio-tag-auto-detection.md) — Server-side auto-tagging from punctuation/markdown/HTML.

### D. Voice matching & cast

- [09 — Voice match pipeline](09-voice-match-pipeline.md) — Post-analysis library matching.
- [10 — Profile drawer](10-profile-drawer.md) — Character edit drawer + sample preview + evidence toggle.
- [11 — Batch character regenerate](11-batch-character-regenerate.md) — Multi-select character → chapter-range regen.

### E. Manuscript editing

- [12 — Manuscript view](12-manuscript-view.md) — Sentence list, low-confidence flagging, speaker reassignment.
- [12a — Fix: sentence reassignment scoped by (chapterId, id)](12a-fix-reassign-cross-chapter-id.md) — Reassign reducers + inspector prop scope by both chapter and sentence id; pre-fix, clicks on chapter 2+ silently mutated chapter 1. Shipped 2026-05-18.

### F. TTS

- [13 — TTS engine picker](13-tts-engine-picker.md) — Two-tier engine + model selector.
- [14a — Kokoro v1 TTS engine](14a-tts-sidecar-kokoro.md) — Local sidecar default, English-only, per-engine cast voice profiles.
- [15 — Gemini cloud TTS](15-tts-gemini-cloud.md) — Cloud opt-in.

### G. Generation

- [16 — Generation stream](16-generation-stream.md) — Chapter audio SSE stream. Cross-links to plan 28 for the on-disk format.
- [17 — Regenerate this/forward](17-regenerate-this-or-forward.md) — Per-chapter + per-character regen.
- [28 — Audio output format](28-chapter-audio-format.md) — Chapter audio + voice samples both MP3 VBR V2 via ffmpeg; ffmpeg preflight in `start-app.ps1`.
- [31 — Sticky generation across navigation](31-sticky-generation.md) — Generation survives every navigation except an explicit Stop or queue drain; local-analyzer triggers prompt for pause-and-analyse when a run is alive.
- [32 — Sticky analysis across navigation](32-sticky-analysis.md) — Analysis survives every navigation except `/pause` or `fresh:true` displacement; server-owned job + multi-subscriber catch-up replay; `AnalysisPill` in the top-bar mirrors the generation pill.
- [35 — Per-chapter engine drift detection](35-engine-drift-detection.md) — Stamp each rendered chapter with its TTS engine; surface drift when the project's active engine differs.

### H. Playback & listen

- [19 — Listener preview](19-preview-listener.md) — Listener-POV full-screen preview.
- [47 — Listening progress / resume bookmarks](archive/47-listen-progress.md) — Per-book sibling `listen-progress.json`; mini-player seeks to the saved point on chapter mount; Listen view "Resume at MM:SS" pill. Shipped 2026-05-18.
- [32 — Audiobook export](32-audiobook-export.md) — Sideload to PocketBook Reader (Phase A: MP3.ZIP) via LAN download or sync folder; per-chapter ID3v2.4 tags, no re-encode, atomic writes.
- [34 — MP3-folder export](34-mp3-folder-export.md) — Per-chapter MP3s in a sub-folder for folder-scanning audiobook apps (Smart AudioBook Player, BookPlayer, Audiobookshelf). Sync-folder destination only; APIC cover travels with each chapter.
- [60 — Listen view decomposition](archive/60-listen-view-decompose.md) — Behaviour-neutral lift: `src/views/listen.tsx` (1136 → 319 lines) becomes a slice-wiring orchestrator that composes three new region sub-components under `src/components/listen/` (header, player+markers, downloads+queue). Zero spec modifications. Shipped 2026-05-19.

### I. Revisions & drift


### J. Library & workspace

- [21 — Book library](21-book-library.md) — Workspace scan + status derivation.
- [22 — Voice library](22-voice-library.md) — Cross-book voices view + pinning.
- [36 — Book covers (OpenLibrary)](36-book-covers.md) — Real cover artwork on cards + Listen header; auto-fetch on import, manual picker on demand; gradient skeleton fallback.

### K. Cross-cutting invariants

- [23 — Mock toggle](23-mock-toggle.md) — `VITE_USE_MOCKS` flips real ↔ mock; components stay neutral.
- [24 — OpenAPI source of truth](24-openapi-source-of-truth.md) — Types come from generated `api-types.ts`.
- [25 — Design tokens](25-design-tokens.md) — Colours via CSS variables only.
- [26 — RTK Immer drafts](26-rtk-immer.md) — Reducers mutate, never spread.
- [38 — Branching & commit convention](38-branching-and-commit-convention.md) — Trunk-based branching + Conventional-Commits subject format; `.husky/commit-msg` gates the convention.
- [44 — Pull request hygiene](44-pr-hygiene.md) — PR template + PR-title lint workflow + merge-commit-only / delete-branch-on-merge repo settings; codifies the Summary / Test plan shape PRs #1-#4 already use.
- [45 — Vitest pool tuning + one-retry policy](45-vitest-pool-tuning.md) — Caps the server-suite forks pool at 4 and turns on `retry: 1` on both Vitest configs so transient tinypool "Worker exited unexpectedly" failures no longer force a full pre-push re-run.
- [46 — Lint, format, a11y baseline](archive/46-lint-format-a11y.md) — ESLint 8 + Prettier 3 + axe-core on four core views; lint prepended to `verify`. Shipped 2026-05-18.
- [48 — Global toast surface](archive/48-toast-surface.md) — `notifications` slice + `<ToastStack/>`; stream-middleware halts + export 5xx dispatch through it; dedupe-by-key collapses repeats; auto-dismiss 6 s. Shipped 2026-05-18.
- [60 — CI verify-on-PR](60-ci-verify-on-pr.md) — GitHub Actions workflow runs `npm run verify` on every PR targeting `main`; ffmpeg + Node + Playwright chromium provisioned, npm + browser caches keyed on lockfile hash; pairs with the visual baselines (`e2e/visual.spec.ts`) so the same gate the pre-push hook runs locally is the gate every PR must clear before merge.

### L. Book state persistence

- [27 — Book state persistence](27-book-state-persistence.md) — `.audiobook/state.json` hydration + slice PUT patches.

### M. Deferred / future work

- [30 — Global model-control affordance](30-global-model-control.md) — Hoist the TTS pill into the top bar once a third surface needs JIT warm. Pairs with the JIT auto-load helper in `src/lib/play-sample-with-auto-load.ts`.

## Status legend

In-body banner (legacy — still valid for plans that haven't been ported to frontmatter):

- **stable** — feature is end-to-end functional; assert real behavior.
- **KNOWN: scaffolded** — UI/contract is in place but parts are mocked or partial; assert only the documented behavior.
- **KNOWN: backend-pending** — frontend done, backend stub returns empty/canned data; mock mode exercises the UI, real mode is intentionally a no-op.
- **KNOWN: operational dependency** — works but requires a sibling process the user must start (TTS sidecar).

Frontmatter (canonical going forward — see "Plan lifecycle" above for the full set).

## Shipped (archive)

Plans that shipped and are no longer load-bearing for in-flight work live in
[`archive/`](archive/README.md). The git log is the changelog; this section is a
breadcrumb so cross-references still resolve.

- [22a — Voice library compare](archive/22a-voice-library-compare.md) — Two-cast-member compare entry point on the Voices tab; reuses `CompareCastModal`; same-/different-base-voice badge on the selection pill. Shipped 2026-05-17.
- [39 — Purge WAV (MP3 is the only format)](archive/39-purge-wav.md) — Dropped the legacy-WAV fallback once documented in plan 28; locator + routes + types now MP3-only. Shipped 2026-05-17.
- [40 — Cover framing + local-disk upload](archive/40-cover-framing-and-upload.md) — Three-tab CoverPicker (Search / Upload / Frame), PNG → JPEG transcode server-side, render-time pan + zoom via `object-position` + `transform`, account-level default for the initial tab. Shipped 2026-05-17.
- [46 — Lint, format, a11y baseline](archive/46-lint-format-a11y.md) — ESLint 8 + Prettier 3 + axe-core on the four core views; `npm run lint` (max-warnings 0) prepended to `verify`. Shipped 2026-05-18.
- [41 — Bulk-apply library sync on confirm-cast](archive/41-bulk-library-sync.md) — Top-of-view pill that ticks every eligible "Sync profile" checkbox in one click; per-card untick still handles exceptions; existing `handleConfirm` batch fans out the per-character library-cast-override POSTs unchanged. Shipped 2026-05-18.
- [48 — Global toast surface](archive/48-toast-surface.md) — `notifications` slice + `<ToastStack/>`; stream-middleware halts + export 5xx dispatch through it; dedupe-by-key collapses repeats; auto-dismiss 6 s. Shipped 2026-05-18.
- [47 — Listening progress / resume bookmarks](archive/47-listen-progress.md) — Per-book sibling `listen-progress.json`; mini-player seeks to the saved position on chapter mount via debounced PUT + onLoadedMetadata; Listen view "Resume at MM:SS" pill. Shipped 2026-05-18.
- [50 — Verify-cache for cheap retries after flake](archive/50-verify-cache.md) — Per-step input-hash cache on `npm run verify`; skips green steps when inputs (filtered from `git ls-files` + lockfiles + Pester/pytest tool fingerprints) match the last green hash. Cold ~120s → warm ~1s; flake recovery drops from the full pipeline to one re-run. Shipped 2026-05-18.
- [37 — Playwright e2e harness](archive/37-e2e-playwright.md) — Browser-level smoke + on-ramp for visual regression; 14 specs / 30 tests at ship, covering library, upload, analysing, confirm, ready, listen, voices, cast/drawer, theme, toast, manual continuity, revision diff, bulk sync, cover framing, plus per-surface visual baselines (light + dark). Shipped 2026-05-18.
- [14 — Coqui XTTS sidecar](archive/14-tts-sidecar-coqui.md) — Local sidecar TTS alternate (zero-shot voice cloning); bounded-retry with provider-side classification of transient (network blip / 5xx / 408) vs non-transient (4xx / CUDA-poisoned 503) failures; full failure-path table. Shipped 2026-05-18.
- [33 — Voice export](archive/33-voice-export.md) — Live Voice (Android audiobook player) tile on the Listen tab; M4B-standards conformance (`stik = 2` + `desc` / `ldes`) regression-guarded; defaults to M4B + sync-folder. Long-form description field shipped alongside. Shipped 2026-05-18.
- [20 — Revisions & drift](archive/20-revisions-and-drift.md) — Pending drafts + drift events + a/b audio audition (rollback-preserved previous audio) + stale-audio banner on voice edits. Close-out adds startup fsck for half-preserved rollback pairs + mid-flight Reject toast. Shipped 2026-05-18.
- [18 — Listen view](archive/18-listen-view.md) — Cover, chapter list, mini-player, metadata editor, listener-app tiles (5 of 7 live via export modal), export queue, cover Replace/Regenerate. Plan 18a slice + 18b correction shipped 2026-05-18; remaining gaps tracked as BACKLOG Could #31/#32/#33/#34/#35.
- [51 — Chapter restructure panel](archive/51-restructure-chapters.md) — Three-way structural edit surface (merge / split / drag-reorder) at ready-stage `view: 'restructure'`. Pure-remap semantics preserve sentence text + characterId + voice assignment; content-changed chapters' audio is deleted, renumbered-only chapters' audio is renamed in place (two-pass via temp + segments.json metadata rewrite). Shipped 2026-05-18.
- [52 — MOBI / AZW3 parsing](archive/52-mobi-parsing.md) — `.mobi` + `.azw3` upload via `@lingo-reader/mobi-parser`; KF8 routes through `initKf8File`, legacy MOBI through `initMobiFile`; DRM-protected files rejected up-front with HTTP 415 by reading the PalmDOC encryption byte; original `.azw3` extension preserved on persist; `stripHtml` / `extractFirstHeading` / `GENERIC_NCX_RE` hoisted from `epub.ts` into shared `html-utils.ts`. Shipped 2026-05-18.
- [49 — Release packages on git-tag push](archive/49-release-package.md) — `scripts/bump-version.mjs` + `.github/workflows/release.yml` produce `audiobook-generator-vX.Y.Z.zip` + `.sha256` on GitHub Releases whenever a `v*.*.*` tag is pushed. Cross-OS verify matrix (Ubuntu / macOS / Windows), Node-ESM production launch path (`npm run start:prod` → `express.static(dist)` on :8080), in-app Gemini API key field. v1.2.0 and v1.2.1 retracted as dry-runs; v1.2.2 the first live ship. Shipped 2026-05-18.
- [53 — Mini-player feature pack](archive/53-mini-player-feature-pack.md) — Playback speed picker (0.75×–2×) persisted per book; user-placed markers (note / rerecord) with a listen-view sidebar; sleep timer with countdown presets + end-of-chapter mode. Shipped 2026-05-19.
- [54 — verify-cache `--steps` filter](archive/54-verify-cache-fast.md) — `--steps=<csv>` flag selects a subset of the verify pipeline; `verify:fast` (pre-commit) now caches via the plan-50 runner, dropping warm pre-commits to under 1 s on no-source-change commits. Shipped 2026-05-19.
- [55 — Revision history timeline](archive/55-revision-history-timeline.md) — Per-chapter chronological log of accept/reject events surfaced via a modal off the existing A/B player; read-side consumer for plan 20's `acceptedSelections` map. Read-only in v1.3.0; multi-step rollback (snapshot-per-entry) parked for v1.4.0. Shipped 2026-05-19.
- [56 — Real chapter-audio peaks at encode time](archive/56-real-chapter-peaks.md) — 240-bin RMS envelope written alongside the MP3 encode, persisted as `<bookDir>/audio/<slug>.peaks.json`, surfaced from the chapter-audio meta endpoint. Missing-file fallback returns `peaks: []` so legacy chapters keep working. Shipped 2026-05-19.
- [57 — Listen-view download tiles](archive/57-download-tiles.md) — Wires the M4B chaptered + new MP3 ZIP tiles on the listen view to open `ExportAudiobookModal` with the format pre-filled; streaming-link tile remains "Coming soon" pending a slugged URL endpoint. Shipped 2026-05-19.
- [58 — E2E coverage refresh](archive/58-e2e-coverage-refresh.md) — Un-quarantines `listen-playback` + `new-book-flow`; adds `binary-upload.spec.ts` covering EPUB / PDF / MOBI / AZW3 routing; applies file-level serial mode to five contention-flaky spec files. From 3-5 hard failures per `verify` run to 0. Shipped 2026-05-19.
- [59 — Parallel Claude Code sessions](archive/59-parallel-claude-sessions.md) — `scripts/wt-new.mjs` spawns a git worktree on a new branch with non-colliding dev-server ports so multiple top-level `claude` sessions can run in parallel without fighting over `:5173` / `:8080` / `:9000` / `:5174`. Slot N → ports offset by `N*10`. `scripts/wt-list.mjs` lists active worktrees + their assignments. `vite.config.ts` + `playwright.config.ts` now env-driven; stock defaults preserved for the main worktree. Shipped 2026-05-19.
- [42 — Dark mode + theme management](archive/42-dark-mode.md) — `[data-theme="dark"]` token override block; top-bar 3-state toggle (Light / Dark / System) as device-local override; Account page sets the first-visit default. Multi-commit ship arc (initial feat 2026-05-17, contrast passes + pre-ship bug bundle through 2026-05-19) — final dark utility-override block covers white / amber / red / rose ladders with their `/N` alpha + hover variants. Plus the `floating-pill-inverse` bespoke utility (cast-view selection bar), match-detail z-index bump, and book-card always-visible metadata strip. Shipped 2026-05-19.
- [43 — Auto-start TTS sidecar](archive/43-auto-start-sidecar.md) — Per-user `autoStartSidecar` preference (default ON); Node owns the sidecar child-process lifecycle (port-9000 probe → spawn → `.run/tts.pid` → `win32` `taskkill /T /F` tree-kill on SIGINT/SIGTERM). `start-app.bat` brings up frontend + server + sidecar in one shot. `PRELOAD_COQUI` env propagation gated on `defaultTtsModelKey === 'coqui-xtts-v2'` (Kokoro's eager-load is unconditional inside the sidecar). 6-case Vitest covers the spawn/probe/tree-kill contract. Shipped 2026-05-17.
- [60 — Listen view decomposition](archive/60-listen-view-decompose.md) — Behaviour-neutral lift of `src/views/listen.tsx` (1136 → 319 lines) into a slice-wiring orchestrator that composes three region sub-components under `src/components/listen/` (header, player+markers, downloads+queue). Pure-deletion diff (52 ins / 869 del); zero spec modifications. Gates Wave 3 of the v1.4.0 slate. Shipped 2026-05-19.
- [63 — Cross-tab `BroadcastChannel` state sync](archive/63-cross-tab-broadcast-sync.md) — `broadcastMiddleware` sends post-mutation snapshots of analysis + chapters `activeStream` on `BroadcastChannel('audiobook-state')` so a sibling tab on the same workspace updates its top-bar pill without a `/api/library/active-analyses` round-trip. Two-layer echo suppression (per-tab `instanceId` tag + inbound-action allowlist); narrow scope (only `activeStream` slots — never per-chapter rows / cast / manuscript) preserves the single-user-per-workspace contract and keeps Won't #3 parked. Shipped 2026-05-19.
