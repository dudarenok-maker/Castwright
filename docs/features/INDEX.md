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
- [95 — Analysing-stage multi-model UI + sticky bar](archive/95-analysing-multi-model-ui.md) — Per-phase model chip + swap inside each PhaseCard; CSS-only sticky status bar pins Pause + active-model under the topbar as the page scrolls. Consumes the per-phase defaults shipped in plan 88 / PR #118. Extracts `PhaseCard` from the 1,769-line `src/views/analysing.tsx` monolith. Shipped 2026-05-22 via PR #138.
- [05 — Manual handoff analyzer](05-analyzer-manual-handoff.md) — `ANALYZER=manual` file-drop cowork loop.
- [06 — Gemini analyzer](06-analyzer-gemini.md) — `ANALYZER=gemini` direct-API mode (also the fallback when local is unreachable).
- [29 — Local Ollama analyzer + fallback](29-analyzer-ollama-local.md) — `ANALYZER=local` default; auto-fallback to Gemini only when daemon is unreachable.
- [07 — Audio tag vocabulary](07-audio-tag-vocabulary.md) — `[tag]` vocabulary UI ↔ parser sync.
- [08 — Audio tag auto-detection](08-audio-tag-auto-detection.md) — Server-side auto-tagging from punctuation/markdown/HTML.

### D. Voice matching & cast

- [09 — Voice match pipeline](09-voice-match-pipeline.md) — Post-analysis library matching.
- [10 — Profile drawer](10-profile-drawer.md) — Character edit drawer + sample preview + evidence toggle.
- [11 — Batch character regenerate](11-batch-character-regenerate.md) — Multi-select character → chapter-range regen.
- [95 — Editable cast aliases](95-alias-edit.md) — Per-chip X on the Profile Drawer's "Also known as" row splits a misplaced alias back into its own standalone cast member; sibling `+ Add alias` button appends a typed name. Reattribute Lines modal (new) is opened by the X-click and lists candidate sentences in the chapters where the alias originally appeared (derived from the preserved Phase-0a `chapterCast`), reusing `manuscriptActions.setSentenceCharacter` for per-sentence picks. Two new contract-internal POST routes (`cast/unlink-alias`, `cast/add-alias`).
- [96 — Recover missing character (manual cast script)](96-recover-missing-character.md) — `node scripts/recover-missing-character.mjs <bookDir> --name <Name> --gender <m|f> --role <role>` appends a manually-typed Character entry to the book's `cast.json` and re-attributes any dialogue-tag patterns (`<Name> said/growled/...`) in `manuscript-edits.json` from `narrator` to the new id. Dry-run by default; `--apply` writes. Hotfix path for narrator-only / rarely-speaking named characters that Phase 0a missed (Grizel + Sandor in Neverseen). Paired with [plan 97](97-narrator-only-named-characters.md) which is the analyzer-side systemic fix.

### E. Manuscript editing

- [12 — Manuscript view](12-manuscript-view.md) — Sentence list, low-confidence flagging, speaker reassignment.
- [12a — Fix: sentence reassignment scoped by (chapterId, id)](12a-fix-reassign-cross-chapter-id.md) — Reassign reducers + inspector prop scope by both chapter and sentence id; pre-fix, clicks on chapter 2+ silently mutated chapter 1. Shipped 2026-05-18.
- [70c — Restructure rebuilds the analysis cache](70c-merge-cache-rebuild.md) — Merge / split / reorder now rebuild `server/handoff/cache/{manuscriptId}.json` from `manuscript-edits.json` instead of deleting it. Generation auto-heals on the next POST if the cache is empty. Resolves post-merge halts citing "No analysed sentences cached for this book."
- [74 — Manuscript diff viewer on re-upload](74-manuscript-diff-on-reupload.md) — Side-by-side sentence-level diff (LCS + char-level inner highlight) gates the user's re-upload of an existing book before any slice mutation lands. New `manuscript-slice` `pendingReupload` slot + `previewReuploadDiff` / `applyReupload` / `discardReupload` actions; new `ui-slice` `reuploadingBookId` + `startReupload`; entry point is the listen-header "Replace manuscript" button.
- [78 — Chapter rename (manual title override)](archive/78-chapter-rename.md) — Pencil-icon affordance on every chapter row in Listen / Generation / Restructure surfaces a shared modal that POSTs `/api/books/{id}/chapters/{chapterId}/rename`. New sticky `titleOverridden` flag on `BookStateJson.chapters[]` locks the title against both heuristic refresh-titles passes. Manuscript-diff-on-reupload structural-mismatch gap closed by plan 84. Shipped 2026-05-21.
- [84 — Manuscript-diff rename guard for re-upload](84-manuscript-diff-rename-guard.md) — New `detectOverrideConflicts` + `scanCandidateChapters` helpers detect renamed chapters that won't match the re-uploaded manuscript's content. Amber banner in the diff modal lists conflicts; on apply, `chaptersActions.clearOverrides` flips `titleOverridden=false` so the new parse wins. Auto-drop on apply; per-row keep/drop picker is a follow-up.
- [80 — Regenerate applies manuscript-edits overlay before synth](80-regenerate-applies-manuscript-edits.md) — `POST /api/books/:bookId/generation` now rebuilds the analysis cache from `manuscript-edits.json` whenever edits exist (not only on the plan-70c "cache empty" auto-heal path), so per-sentence speaker reassignments and split-offspring sentences made in the manuscript view actually reach the TTS engine on regenerate. Subsumes the prior auto-heal block; three new regression tests in `generation.test.ts` capture the synthesise-chapter `sentences` arg to assert the EDITED `characterId` reaches synth, not the cached one. Shipped 2026-05-20.
- [90 — Low-confidence triage polish: fast-nav + series-roster pickers + typeahead search](90-low-confidence-triage-polish.md) — Three behaviours shipped together as one workflow round (BACKLOG Could #32 + #33 + #34). New `<CharacterSearchPicker>` extracted under `src/components/`, consumed by all three manuscript-view picker sites. New `POST /api/books/:bookId/cast/add-from-roster` route lets the user materialise a new local character from a prior series-mate's cast in one click — closes the "analyzer missed a recurring series character entirely" gap that the older `cast/link-prior` couldn't fix. Header's "X low-confidence" stat becomes an active ▲/▼ navigator with J/K shortcuts that scroll the next misattribution into view and auto-open the inspector. `priorRoster` now lives on `LayoutContext` so the ProfileDrawer and the manuscript view share one `/series-roster` fetch per book.
- [92 — Manuscript view virtualisation](92-manuscript-virtualisation.md) — `useWindowVirtualizer` from `@tanstack/react-virtual` wraps the segment list above a 60-segment threshold; below that the flat-render path stays for short chapters where windowing is overhead. Boundary drag, `data-sentence-id`/`data-sentence-idx` attributes, and the J/K low-confidence jumper all preserved (jump routes via `virtualizer.scrollToIndex` first). DOM node count for a 300-segment chapter drops from ~300 to ~20–40 (visible + overscan window).
- [93 — Confirm-cast + listen-chapter list virtualisation](93-list-virtualisation.md) — Same `@tanstack/react-virtual` dep as plan 92, two shapes: `useWindowVirtualizer` for the page-scrolling confirm-cast picker (`src/views/confirm-cast.tsx`); `useVirtualizer` with `getScrollElement` for the listen view's chapter list that scrolls inside its own `max-h-[560px]` container (`src/components/listen/listen-player-region.tsx`). Both gated at 40 rows so short books stay on the flat path. No new dep cost beyond plan 92.

### F. TTS

- [70d — Per-sentence synth + audio-tag stripping](70d-per-sentence-synth-and-tag-strip.md) — `buildSentenceGroups` emits one group per sentence (was: fold consecutive same-speaker), and `normaliseForTts` strips the closed `[empathic]` / `[whispers]` / etc. vocabulary at the TTS boundary. Fixes long all-narrator chapters that ran past the 30 s stall watchdog, audio tags being read aloud, and same-speaker voice drift at large context sizes.

- [13 — TTS engine picker](13-tts-engine-picker.md) — Two-tier engine + model selector.
- [14a — Kokoro v1 TTS engine](14a-tts-sidecar-kokoro.md) — Local sidecar default, English-only, per-engine cast voice profiles.
- [15 — Gemini cloud TTS](15-tts-gemini-cloud.md) — Cloud opt-in.

### G. Generation

- [16 — Generation stream](16-generation-stream.md) — Chapter audio SSE stream. Cross-links to plan 28 for the on-disk format.
- [17 — Regenerate this/forward](17-regenerate-this-or-forward.md) — Per-chapter + per-character regen.
- [28 — Audio output format](28-chapter-audio-format.md) — Chapter audio + voice samples both MP3 VBR V2 via ffmpeg; ffmpeg preflight in `start-app.ps1`.
- [72 — AAC/M4A and Opus chapter audio output](72-audio-codec-aac-opus.md) — `encodePcmToAudio` dispatches on `format: 'mp3' | 'aac-m4a' | 'opus'`; per-book `BookStateJson.audioFormat` field (default `'mp3'`) drives generation extension + codec; libfdk_aac auto-detect with native AAC fallback; new `aac-m4a-zip` / `opus-ogg-zip` export shapes mirror the MP3.ZIP packer. Shipped 2026-05-20.
- [31 — Sticky generation across navigation](31-sticky-generation.md) — Generation survives every navigation except an explicit Stop or queue drain; local-analyzer triggers prompt for pause-and-analyse when a run is alive.
- [32 — Sticky analysis across navigation](32-sticky-analysis.md) — Analysis survives every navigation except `/pause` or `fresh:true` displacement; server-owned job + multi-subscriber catch-up replay; `AnalysisPill` in the top-bar mirrors the generation pill.
- [35 — Per-chapter engine drift detection](35-engine-drift-detection.md) — Stamp each rendered chapter with its TTS engine; surface drift when the project's active engine differs.

### H. Playback & listen

- [19 — Listener preview](19-preview-listener.md) — Listener-POV full-screen preview.
- [82 — Export queue Retry + Download row actions](82-export-queue-retry-download.md) — Failed rows surface a wired Retry button (re-fires `POST /api/books/:bookId/exports` with the same wire params); done rows without a signed URL surface a Download button (streams `/api/books/:bookId/exports/:exportId/download`). New `retryExport` thunk in `src/store/exports-middleware.ts`; new wire-context fields on `ExportQueueItem`. Closes plan 18's last two "Coming soon" stubs.
- [47 — Listening progress / resume bookmarks](archive/47-listen-progress.md) — Per-book sibling `listen-progress.json`; mini-player seeks to the saved point on chapter mount; Listen view "Resume at MM:SS" pill. Shipped 2026-05-18.
- [69 — Share a 30-second chapter clip](archive/69-share-chapter-clip.md) — Per-chapter "Share clip" affordance in the listen view's player region; modal-driven start/end picker (default ±15 s around playhead, max 60 s); server slices via `ffmpeg -ss -i -t -c copy` (no re-encode). Shipped 2026-05-19.
- [32 — Audiobook export](32-audiobook-export.md) — Sideload to PocketBook Reader (Phase A: MP3.ZIP) via LAN download or sync folder; per-chapter ID3v2.4 tags, no re-encode, atomic writes.
- [34 — MP3-folder export](34-mp3-folder-export.md) — Per-chapter MP3s in a sub-folder for folder-scanning audiobook apps (Smart AudioBook Player, BookPlayer, Audiobookshelf). Sync-folder destination only; APIC cover travels with each chapter.
- [67 — Streaming-link download tile](archive/67-streaming-link-tile.md) — Mints a 12-char Crockford base32 slug; `GET /share/:slug` proxies the book's most-recent M4B export off disk. Closes the last "Coming soon" tile on the Listen view. Shipped 2026-05-19.
- [77 — Per-chapter loudness report card](77-loudness-report-card.md) — Consumes plan 71's `<slug>.lufs.json` sidecars and surfaces them in the Listen view as (a) a colour-coded per-row drift pill (≤2 / 2–4 / >4 LU buckets) and (b) an expandable report card with summary line + sparkline + per-chapter table. Drift comparisons gated on `twoPass === true`; single-pass values degrade to neutral.

### I. Revisions & drift

- [83 — Background drift polling across non-active books](83-drift-poll-multibook.md) — New `GET /api/revisions?bookIds=...` bulk endpoint + frontend two-tier poller (30 s active, 120 s background). Drift on Book B surfaces in Book A's modal within ~2 min without a navigate. Active-book latency unchanged.
- [91 — Cast Drift modal consolidation by (book × character × snapshot)](91-cast-drift-consolidation.md) — One card per group instead of one card per event; ~300-event modal collapses to ~6–18 cards. `createSelector`-memoised `selectDriftGroupsByBook` + `React.memo`-wrapped row components + memoised prop builder in `layout.tsx` drop DOM-node count from ~7,200 to ~200. Detailed `ProfileCompareCard` preserved (renders once per group), per-chapter Regen / Listen / Dismiss preserved in an expandable strip; bulk Regen-all / Dismiss-all / Auto-regen-all added on multi-chapter groups.

### J. Library & workspace

- [21 — Book library](21-book-library.md) — Workspace scan + status derivation.
- [22 — Voice library](22-voice-library.md) — Cross-book voices view + pinning.
- [96 — Cross-book voice Compare with series-propagating saves](96-cross-book-voice-compare.md) — Lifts plan 22a + plan 65's cross-book guard (BACKLOG #7); Compare modal now opens for pairs from different books in the same series. Saves route through new `POST /api/books/:bookId/cast/:characterId/series-patch` which applies the patch to every series-sibling `cast.json` row matching the source character under plan-94's name/alias dedup rule. Dark-mode contrast on the floating toolbar pill + "same / different base voice" badges fixed in the same PR (adopts `.floating-pill-inverse` instead of raw `bg-ink text-canvas`).
- [36 — Book covers (OpenLibrary)](36-book-covers.md) — Real cover artwork on cards + Listen header; auto-fetch on import, manual picker on demand; gradient skeleton fallback.
- [73 — Library search + per-book tag filter](73-library-search-tags.md) — Debounced title/author search input + tag-chip filter row in the library chrome; chip editor + suggestions dropdown in the EditBookMeta modal; tags persist to `BookStateJson.tags` and round-trip via the existing `slice: 'state'` PUT path.
- [75 — Portable book bundle (export + import)](75-portable-book-export.md) — Single `.zip` containing state.json + manuscript + audio + cover + change-log + MANIFEST. `GET /api/books/:id/export/portable` streams the bundle; `POST /api/import/portable` accepts a multipart upload; conflict default is `rename`. Listen view 4th download tile + Library view Import button.

### K. Cross-cutting invariants

- [23 — Mock toggle](23-mock-toggle.md) — `VITE_USE_MOCKS` flips real ↔ mock; components stay neutral.
- [24 — OpenAPI source of truth](24-openapi-source-of-truth.md) — Types come from generated `api-types.ts`.
- [25 — Design tokens](25-design-tokens.md) — Colours via CSS variables only.
- [26 — RTK Immer drafts](26-rtk-immer.md) — Reducers mutate, never spread.
- [38 — Branching & commit convention](38-branching-and-commit-convention.md) — Trunk-based branching + Conventional-Commits subject format; `.husky/commit-msg` gates the convention.
- [44 — Pull request hygiene](44-pr-hygiene.md) — PR template + PR-title lint workflow + merge-commit-only / delete-branch-on-merge repo settings; codifies the Summary / Test plan shape PRs #1-#4 already use.
- [85 — `wt-merge.mjs` reconciliation helper](85-wt-merge-helper.md) — One-command driver for CONTRIBUTING.md "Reconciliation pattern": cut `integration/<date>` off `main`, merge each agent branch in sequence, `npm run verify` between merges, abort on conflict (exit 2) or verify failure (exit 3) with a suggested follow-up that drops the offending branch. Idempotent re-runs; `--dry-run` previews the plan.
- [86 — Live worktree dashboard](86-worktree-dashboard.md) — Dev-only `#/worktrees` view + `GET /api/worktrees` route. Lists every git worktree visible to `git worktree list --porcelain` with its branch, ports, and a live TCP probe of each VITE_PORT. Click a green row → opens that worktree's dev URL in a new tab. Top-bar `wt` chip gated on `import.meta.env.DEV`; server route 404s in production.
- [45 — Vitest pool tuning + one-retry policy](45-vitest-pool-tuning.md) — Caps the server-suite forks pool at 4 and turns on `retry: 1` on both Vitest configs so transient tinypool "Worker exited unexpectedly" failures no longer force a full pre-push re-run.
- [46 — Lint, format, a11y baseline](archive/46-lint-format-a11y.md) — ESLint 8 + Prettier 3 + axe-core on four core views; lint prepended to `verify`. Shipped 2026-05-18.
- [48 — Global toast surface](archive/48-toast-surface.md) — `notifications` slice + `<ToastStack/>`; stream-middleware halts + export 5xx dispatch through it; dedupe-by-key collapses repeats; auto-dismiss 6 s. Shipped 2026-05-18.

### L. Book state persistence

- [27 — Book state persistence](27-book-state-persistence.md) — `.audiobook/state.json` hydration + slice PUT patches.
- [67 — Per-book editorial notes](archive/67-editorial-notes.md) — `notes?: string | null` on `BookStateJson`; collapsible card on the listen header (mounted in `listen-header.tsx`); plain textarea editor in the metadata block; `whitespace-pre-wrap` for line-break rendering (no markdown parser dependency). Shipped 2026-05-19.

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
- [41 — Bulk-apply library sync on confirm-cast](archive/41-bulk-library-sync.md) — Top-of-view pill that flips Reuse for every eligible row and auto-ticks the "Sync profile" checkbox for low-confidence (< 0.9) matches only; high-confidence rows keep the sync as a per-card opt-in. Existing `handleConfirm` batch fans out the per-character library-cast-override POSTs unchanged. Shipped 2026-05-18; Bug C amend 2026-05-19; Bug D (confidence gate) amend 2026-05-22.
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
- [61 — In-app multi-model management UX](archive/61-in-app-model-management.md) — Account → Models card: detect-Ollama + install (platform-aware), pull-model (NDJSON-streamed progress), refresh-available-models, plus `install-coqui.{sh,ps1}` parallels to `install-kokoro.*`. Two state machines (install: idle → detecting → downloading → installing → installed; pull: idle → pulling → pulled). Dependency-injectable bootstraps so tests run offline. Closes plan 49's deployer-first gap for non-Kokoro engines. Shipped 2026-05-19.
- [62 — CI verify-on-PR](archive/62-ci-verify-on-pr.md) — GitHub Actions workflow runs `npm run verify` on every PR targeting `main`; ffmpeg + Node + Playwright chromium provisioned, npm + browser caches keyed on lockfile hash; concurrency `cancel-in-progress` supersedes redundant runs on rapid pushes; pairs with the visual baselines (`e2e/visual.spec.ts`) so the same gate the pre-push hook runs locally is the gate every PR must clear before merge. Shipped 2026-05-19.
- [64 — Voice preview while editing the character](archive/64-voice-preview-while-editing.md) — Per-candidate "Play sample" affordance in the profile-drawer override picker; user-editable sample line persisted to `localStorage` (key `voice-preview-sample-text`); auditions are read-only (no cast commit until Save). Reuses existing `playBaseVoiceSampleWithAutoLoad` orchestrator + `useTtsLifecycle()` (no new slice). Shipped 2026-05-19.
- [65 — Voices global-tab same-book compare](archive/65-voices-global-tab-compare.md) — Lifts plan 22a's "Open a book to compare" gate for global-tab pairs that share a `bookId`: `api.getBookState(bookId)` resolves the foreign cast on demand, cached for the modal session via a component-local `Map<bookId, Character[]>` (no new redux slice). Fetch-fails surface a deduped error toast and retroactively disable the Compare button for that bookId. Cross-book pairs remain disabled (BACKLOG #17). Shipped 2026-05-19.
- [66 — Real-binary MOBI / AZW3 parser fixtures](archive/66-real-binary-parser-fixtures.md) — `scripts/gen-parser-fixtures.mjs` probes for Calibre's `ebook-convert` and derives gitignored `sample.mobi` + `sample.azw3` from the existing EPUB fixture; new server Vitest suite + the binary-upload e2e MOBI/AZW3 cases run the real `@lingo-reader/mobi-parser` path against those binaries, skipping cleanly via `describe.skipIf` + `test.skip` when Calibre isn't installed. Shipped 2026-05-19.
- [67 — Per-book editorial notes](archive/67-editorial-notes.md) — `notes?: string | null` on `BookStateJson` round-trips via the existing `slice='state'` PUT; collapsible Notes card mounted in `ListenHeader` (plan-60 sub-component, not the orchestrator); plain textarea in the metadata editor; line breaks via `whitespace-pre-wrap` (no markdown parser dep). Persistence middleware's `bookMeta/commitDraft` rule simultaneously gained `description` (previously missing). Shipped 2026-05-19.
- [68 — Streaming-link download tile](archive/68-streaming-link-tile.md) — `POST /api/books/:bookId/share` mints a 12-char Crockford-style base32 slug; `GET /share/:slug` resolves the slug → bookId via `<workspace>/.audiobook/share-links.json` and proxies the book's most-recent successful M4B export off disk. Idempotent mint (re-POST returns the same slug). Closes BACKLOG #33 and the last "Coming soon" tile on the Listen view's "Or download a file" section. Shipped 2026-05-19.
- [69 — Share 30-second chapter clip](archive/69-share-chapter-clip.md) — New `GET /api/books/{bookId}/chapters/{chapterId}/clip` route slices the source MP3 via `ffmpeg -ss <start> -i <mp3> -t <duration> -c copy` (no re-encode, fast-seek path). Per-chapter Share-clip button in the listen-view player region opens a modal with default ±15 s window around the current playhead, range / step / typed-input handles, server-enforced 60 s cap. Shipped 2026-05-19.
- [70a — Chapter restructure bug fix](archive/70a-restructure-bugfix.md) — Orphan-sentence recovery (preserves original `oldChapterId` in the response remap so the frontend reducer lookup still resolves), auto-prune of empty chapter rows, and auto-renumber of generic "Chapter N" titles against new positions on every merge / reorder. Resolves the stale-numbers + zero-sentence symptoms visible on long manuscripts. Server-only; opens a `warnings: string[]` channel on the restructure response. Shipped 2026-05-19.
- [70b — Chapter restructure feature extensions](archive/70b-restructure-extensions.md) — Five-part feature bundle: shared `<RestructureChaptersButton>` mounted in both Listen and Manuscript view headers (pre-generation entry); sticky Merge-selected toolbar (`top-16 z-30` to clear the global TopBar); per-row Exclude / Include toggle reusing `Chapter.excluded` soft-hide semantics (audio preserved, merge checkbox disabled on excluded rows); Refresh chapter names button (re-parse manuscript + first-line promotion with dialogue / length / title-case heuristics, user-custom titles preserved); frontend toast consumer surfaces plan 70a's `warnings` advisories inline. Shipped 2026-05-19.
- [76 — Library card↔table view](archive/76-library-table-view.md) — Toggle pill in the library chrome flips between the existing card grid and a dense, series-grouped table view; standalones collected into a synthetic pseudo-section; `library.viewMode` persisted in localStorage. Behaviour parity via reuse of the grid's callbacks; shared `STATUS_UI` + empty-state modules extracted for both. Shipped 2026-05-20.
- [79 — Exports in the book folder + Voice sync fixes](archive/79-exports-in-book-folder-and-voice-fixes.md) — Finished artifacts move out of the hidden `.audiobook/exports/<id>/` jail into a visible `<bookDir>/exports/<slug>.<ext>` sibling to `audio/` (clobber-newest-wins; manifests stay under `.audiobook/export-manifests/`). Export modal auto-saves the sync folder on blur, surfaces save errors as a red banner, and gains a "Test" probe button backed by `POST /api/user/settings/sync-folder/test`. Widens `renameWithRetry` to cover EACCES / EIO for Drive for Desktop's virtual-FS hiccups; prepends Drive/OneDrive-specific hints on terminal failures. Portable bundle now also stages a local copy at `<bookDir>/exports/<slug>.portable.zip`. Shipped 2026-05-20.
- [81 — Mobile + tablet support (LAN over HTTPS)](archive/81-mobile-tablet-support.md) — Six-wave round: mkcert local-CA HTTPS for LAN access (`npm run dev:lan` / `start:lan` / `install:cert-mobile`); Playwright mobile + tablet projects (chromium-engine override on Pixel 7 + iPad Pro 11 viewports) gated to `e2e/responsive/` specs; responsive shell (top-bar overflow + sticky mini-player + 44px touch targets); per-view responsive (6 parallel agents on isolated worktrees: books / confirm-cast / manuscript / listen / generation+upload / cast); touch affordances additive to drag-and-drop (tap-to-assign voice card pill + sticky banner; PointerEvents instead of MouseEvents on manuscript paragraph boundaries); `coarse-pointer:` Tailwind variant for hover-only affordances; e2e script split (`test:e2e` chromium-only for pre-push, `test:e2e:mobile` opt-in). Shipped 2026-05-21.
- [87 — Parallel chapter synthesis](archive/87-parallel-chapter-synth.md) — Bounded worker pool over chapters via `GEN_CHAPTER_CONCURRENCY` (default 2). `processOneChapter` extracted from `runMainGenerationJob`; cascade-fatal aborts the shared signal so in-flight siblings exit cleanly; per-chapter SSE tracks route through `src/store/chapters-slice.ts` so interleaved events for chapter B never touch chapter A's row. Shipped 2026-05-21.
- [88 — Pipelined two-model analyzer (Gemma cast + Gemini attribution, 10-chapter lag)](archive/88-analyzer-per-phase-model.md) — Phase 0 (Gemma) and Phase 1 (Gemini) wrapped in sibling `Promise.all` worker pools; `awaitPhase1Dispatch` enforces a minimum 10-chapter lag via the new `phase-watermark.ts` back-pressure semaphore. Independent rate-limit buckets (gemma 1,500 RPD + gemini 500 RPD). Rolling roster snapshot per dispatch, final consolidation when Gemma's done. `ANALYZER_PHASE{0,1}_MODEL` + `ANALYZER_PHASE1_MIN_LAG_CHAPTERS` env knobs; manual handoff short-circuits to sequential. Shipped 2026-05-21.
- [89 — Frontend perf pass](archive/89-frontend-perf-pass.md) — Broadcast-middleware shallow diffing + phaseProgress debounce (C2); `useAppSelectorShallow` applied at five large-slice sites including `src/views/listen.tsx:122` (C3); `React.lazy` route splitting with a delayed Suspense fallback in the layout shell + per-area icon split (C5). Main bundle 410 kB → 345 kB (gzip 108 kB → 91 kB). Preserves plan 63 narrow-scope BroadcastChannel rule. Shipped 2026-05-21.
- [71 — Audio loudness normalization (EBU R128)](archive/71-audio-loudness-normalization.md) — Two-pass `loudnorm` via ffmpeg in the chapter encoder; default ON via `AUDIO_LOUDNORM_ENABLED`; per-chapter `<slug>.lufs.json` sidecar carries the post-normalisation integrated loudness / LRA / true-peak (2026-05-22 post-ship correction: was previously persisting the pre-filter input loudness; second-pass filter now emits `print_format=json` and `mp3.ts` parses `output_i` out of the encoder's stderr). Backfill via `scripts/relufs-existing.mjs` for chapters rendered before the correction. Shipped 2026-05-20; corrected 2026-05-22.
- [94 — Series-prior roster dedup](archive/94-series-prior-dedup.md) — `dedupSeriesPrior` (union-find over normalised name + alias tokens; transitive alias-chain merge) collapses per-book cast.json rows into one entry per unique character before they reach the analysing-view pill and the Phase 0a per-chapter prompt. The "Carried in from prior books in this series · N characters" count now reports unique characters (KOTLC #4 dropped from 136 raw rows). Producer (`scanSeriesCharacters`) + Profile Drawer's manual continuity-link picker route stay raw — they legitimately need per-book provenance. `SeriesPriorCharacter.fromBookTitle` → `fromBookTitles: string[]`; SSE payload shape unchanged. Shipped 2026-05-22.
