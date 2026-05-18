# Backlog (MoSCoW)

The live backlog. Every outstanding item from `docs/features/*.md` plan bodies,
CLAUDE.md "Suggested follow-ups", deferred sections, KNOWN-scaffolded plans,
and untested territory.

**Update rule:** Future rounds of planned work pull from this list. Bugs are
out-of-band (the user files them as they hit them; they don't queue here).
When an item ships:

1. Remove its bullet here.
2. Update the source plan's `status:` / fill its **Ship notes** section.
3. If the plan is now `stable`, move it to `docs/features/archive/` per
   [`archive/README.md`](features/archive/README.md).

When you discover a new outstanding item (a new "Suggested follow-up" added
to a plan, a TODO landed in code, a flaky test quarantined), add it here in
the same PR — the backlog is only useful while it stays current.

**Each item carries:**

- **_What_**: one-sentence concrete description so the work is actionable from this bullet alone.
- **_Acceptance_**: observable criteria for "done", so future-you knows when to remove the bullet.
- **_Key files_**: starting points so the next pick-up doesn't spend an hour spelunking.
- **_Depends on_**: (optional) — listed only when there's a real prerequisite.
- **_Benefit (axis)_**: the _why_ (user / technical / architectural).

Ranking within each bucket = top is highest priority.

**Counts as of 2026-05-18:** Must 1 · Should 1 · Could 14 · Won't 9

---

## Must — blocks v1 ship or hurts existing users

### 1. Verify-cache for cheap retries after flake

Source: net-new (2026-05-18). Follow-up to plan 45 (Vitest pool tuning + one-retry policy). Plan 45 lowers the _probability_ of `npm run verify` flaking; this lever drops the _cost_ of any remaining flake to near-zero.

- _What:_ Add a `.verify-cache.json` (gitignored) that records, per pipeline step (`typecheck`, `test:hooks`, `test` (frontend), `test:server`, `test:scripts`, `test:sidecar`, `test:e2e`, `build`), the input hash that produced the last green result. The input hash is the SHA-256 of every file the step reads (resolvable from `tsconfig.json` includes for typecheck, the Vitest `include` globs for each Vitest config, etc.) plus the lockfile hash. On `npm run verify`, each step computes its current input hash; if it matches the cached green hash, the step is skipped with a `[cached]` marker. On a green completion, the cache is updated. Cache invalidates automatically when any input changes. Manual override: `npm run verify -- --no-cache` re-runs everything.
- _Acceptance:_ (1) Run `npm run verify` on a clean tree → all steps run, cache populated. (2) Re-run immediately, no changes → every step prints `[cached] (input hash unchanged)` and exits in under 5 s total. (3) Touch one file in `src/lib/` → the frontend `test` step re-runs, every other step stays cached. (4) Touch `server/src/foo.ts` → server `test` and `typecheck` re-run, frontend test stays cached. (5) Force a flake on the server suite, retry without touching anything → cached typecheck + frontend + sidecar + Pester + e2e + build skip; only the server suite re-runs. (6) `npm run verify -- --no-cache` runs everything regardless of cache. (7) New Vitest spec covers the input-hash computation + cache hit/miss decision; manual: walk steps 1-6 once.
- _Key files:_ new `scripts/verify-cache.mjs` (the cache + step-runner); `package.json` `scripts.verify` (delegate to the new script); new `scripts/tests/verify-cache.test.mjs`; `.gitignore` (add `.verify-cache.json`).
- _Depends on:_ plan 45 shipped (already on this branch — the retry policy means the cache doesn't have to worry about transient-pass-then-fail; one retry stabilises before the green hash is written).
- _Benefit (user / developer):_ the user explicitly flagged "commits don't waste too much time doing double takes." Today a transient worker death at step 5 of 6 re-runs all 6 steps from scratch on the next push, even though steps 1–4 produced identical output. This cache makes the _recovery_ cost of a flake = the cost of one re-run of the step that actually failed (typically ~60 s for the server suite) instead of ~6 min for the whole pipeline. Even on clean re-pushes after editing one file, the developer feedback loop drops from ~6 min to ~30–60 s. Compounds with plan 45: plan 45 makes flakes rarer, this lever makes them cheap when they do happen.

---

## Should — important, not blocking ship

### 1. Release packages on git-tag push

Source: net-new (2026-05-18) — user-requested ahead of handing the app to a deployer. Full plan in [`49-release-package.md`](features/49-release-package.md) (status: draft).

- _What:_ Add `scripts/bump-version.ps1 -Level (patch|minor|major)` that rewrites both `package.json` versions + lockfiles, creates the `chore: bump version to X.Y.Z` commit, and creates the annotated `vX.Y.Z` tag locally. Add `.github/workflows/release.yml` that fires on `push: tags: ['v*.*.*']`, runs `npm run verify:quick && npm run build`, assembles `audiobook-generator-vX.Y.Z.zip` via a new `scripts/build-release-zip.mjs` (manifest-driven include / exclude rules), computes SHA-256, and uploads both as a GitHub Release with the tag annotation as the release notes. Ship a top-level `INSTALL.md` walking a deployer through extracting the zip, prerequisites, `install-kokoro.ps1`, and `npm start`. Add a "Releasing" section to CONTRIBUTING.md.
- _Acceptance:_ (1) `pwsh scripts/bump-version.ps1 -Level patch` on a clean main bumps both `package.json` versions in lockstep, regenerates both lockfiles, commits with the standard subject, and tags `v<new>`. (2) `git push origin main && git push origin v<new>` triggers `release.yml`; the workflow ends green with a `audiobook-generator-v<new>.zip` + `.sha256` asset on the matching GitHub release. (3) Extracting the zip on a clean Windows 11 host and following INSTALL.md yields a runnable app at `http://localhost:5173`. (4) New Pester test `scripts/tests/bump-version.Tests.ps1` locks the bump-script post-state; new Vitest spec `scripts/tests/release-manifest.test.mjs` locks the include / exclude manifest.
- _Key files:_ new `.github/workflows/release.yml`, `scripts/bump-version.ps1`, `scripts/build-release-zip.mjs`, `scripts/tests/bump-version.Tests.ps1`, `scripts/tests/release-manifest.test.mjs`, `INSTALL.md`, `docs/features/49-release-package.md`; edited `docs/features/INDEX.md`, `README.md` (Releases link), `CONTRIBUTING.md` (Releasing section), `.gitignore`.
- _Depends on:_ none. Pairs naturally with Could #1 (CI integration for the test suite) — both add GitHub Actions workflows; if shipped together the same caching infrastructure is reusable.
- _Benefit (user / technical):_ user can hand a downloadable artefact to a deployer instead of walking them through a git-clone + dev-from-source flow. Cutting a release becomes one command instead of a 4-file edit. Establishes the release seam that Could #16 (Windows installer) and Could #17 (Docker image) hang off — both extend `release.yml` rather than spawn parallel pipelines.

---

## Could — nice to have, low-cost wins

### 1. CI integration for the test suite

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups.

- _What:_ Add a GitHub Actions (or equivalent) workflow that runs `npm run verify` on every PR. Cache `node_modules` and the Playwright browser. Budget for e2e being the slowest job (~60 s cold).
- _Acceptance:_ PRs that break tests are blocked from merge. Workflow runs in under 10 min cold, under 5 min warm.
- _Key files:_ new `.github/workflows/verify.yml`.
- _Benefit (technical):_ eliminates the "works on my machine" gap. Pairs with the visual baselines shipped 2026-05-17 (`e2e/visual.spec.ts`) — without CI, the baselines are a tree-falling-in-a-forest.

### 5. Audio loudness normalization (ffmpeg `loudnorm`)

Source: net-new (2026-05-17). Validated absent in `server/src/tts/mp3.ts` (raw PCM → LAME VBR, no loudness filter).

- _What:_ Add an optional `loudnorm` pass to the chapter encode pipeline. Two-pass mode (analyse → apply) gates on a config knob (`AUDIO_LOUDNORM=off|single|two-pass`, default `single`). Targets EBU R128 `-16 LUFS`, `-1.5 dBTP`, `LRA 11`.
- _Acceptance:_ New server Vitest spec asserts the ffmpeg invocation includes the loudnorm filter when enabled; manual: compare two chapters generated with different voices, both land within ±1 LU of target. Skip when `AUDIO_LOUDNORM=off`.
- _Key files:_ `server/src/tts/mp3.ts`; `server/.env.example` (new knob); `docs/features/28-chapter-audio-format.md` (extend with a "Loudness" section).
- _Depends on:_ none. Encode latency cost is ~20-40% for single-pass loudnorm; document the trade-off.
- _Benefit (user):_ per-voice volume drift across chapters today forces the listener to ride the volume knob. Loudnorm makes the book sit at one level.

### 6. AAC/M4A or Opus output (swappable encoder)

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- _What:_ Generalise `encodePcmToMp3` to accept an encoder choice (`mp3 | m4a | opus`) and add a sidecar/server config knob that selects per-book output format.
- _Acceptance:_ The boundary in `server/src/tts/mp3.ts` (or wherever `encodePcmToMp3` lives) is renamed `encodePcmToAudio` and dispatches on format; existing tests still pass; a new test covers m4a output.
- _Key files:_ `server/src/tts/mp3.ts`; `docs/features/28-chapter-audio-format.md`.
- _Depends on:_ none, but cluster after Could #5 (loudnorm) so the encoder boundary is generalised AFTER the loudnorm wiring lands — otherwise we re-touch the dispatch twice.
- _Benefit (user):_ smaller files / better quality for users who prefer either; small cost because the encoder seam already exists.

### 7. Long-form description (`desc` / `ldes`) for Voice export

Source: [`33-voice-export.md`](features/33-voice-export.md) known gap.

- _What:_ Add a `description: string | null` field to the book metadata model; expose an edit affordance in the metadata modal; pipe the value into the M4B `desc` and `ldes` atoms during export.
- _Acceptance:_ Editing a book and saving sets the description; an M4B export embeds `desc` / `ldes` (verified by `ffprobe -show_streams`); the Live Voice app shows the richer "About this audiobook" text.
- _Key files:_ `src/modals/edit-book-meta.tsx`; `server/src/export/build-m4b.ts`; `openapi.yaml` (BookMetadata schema); `server/src/workspace/scan.ts` (`BookStateJson`).
- _Benefit (user):_ richer "About this audiobook" panel in Live Voice.

### 8. Voice compare from the global `#/voices` tab for same-book pairs

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- _What:_ When both selected voices in the global `#/voices` tab share a `bookId` (≠ `currentBookId`), fetch that book's cast on demand via `api.getBookState(bookId)` and pass the resolved characters into `CompareCastModal`. Cache the fetched cast for the modal session so re-opens are instant.
- _Acceptance:_ The Compare button enables in the global tab for a same-`bookId` 2-voice pair; the modal opens with the correct two characters. Vitest covers the on-demand fetch path + the disabled state when the fetch fails. The e2e `voices-compare.spec.ts` gains a global-tab same-book pair assertion.
- _Key files:_ `src/views/voices.tsx` (gating logic + on-demand fetch); `src/lib/api.ts` (`getBookState`); `e2e/voices-compare.spec.ts`.
- _Depends on:_ none structural.
- _Benefit (user):_ closes the gap in the Voice library global view — today the global tab's Compare is fully disabled, even for pairs that would resolve cleanly with one fetch.

### 9. Cross-book voice compare

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- _What:_ Lift the cross-book guard. When the two selected voices belong to different `bookId`s, fetch each book's cast (one of them may be the open book — short-circuit) and pass both characters into `CompareCastModal`. Decide and document: do we route saves back to each character's source book's cast slice, or refuse the save and surface a "viewing only" banner?
- _Acceptance:_ The Compare button enables for cross-book pairs; the modal opens with both characters; the Save behaviour is documented and tested. The e2e gains a cross-book pair assertion.
- _Key files:_ `src/views/voices.tsx`; `src/store/cast-slice.ts` (Save routing); `src/modals/compare-cast-modal.tsx` (if the viewing-only banner is needed).
- _Depends on:_ Could #8 (the same on-demand fetch machinery).
- _Benefit (user):_ enables A/B for users who reuse the same TTS voice across books — e.g. comparing the same narrator across two books in a series to spot drift.

### 10. More e2e golden paths (voices, cast, profile drawer)

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups.

- _What:_ Add Playwright specs for the Voice library tab (open, see voices, pin/unpin) and the cast/profile-drawer flow (open a confirmed book, click a character, see drawer with evidence toggle).
- _Acceptance:_ Two new spec files (`e2e/voices.spec.ts`, `e2e/cast-drawer.spec.ts`); both run in under 15 s warm.
- _Key files:_ `e2e/smoke.spec.ts` (pattern to mirror); `src/views/voices.tsx`; `src/modals/profile-drawer.tsx`.
- _Benefit (technical):_ incremental low-cost coverage growth.

### 11. Streaming audio for live playback during chapter generation

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Acceptance:_ Generating a chapter shows audio progress under the play cursor before the chapter completes. Existing per-chapter file is still written atomically at the end.
- _Key files:_ `server/src/tts/synthesise-chapter.ts`; `server/src/tts/mp3.ts`; `src/components/mini-player.tsx` for the MediaSource consumer.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on.

### 12. Cross-tab `BroadcastChannel` state sync

Source: net-new (2026-05-17). Validated absent in frontend.

- _What:_ Open `new BroadcastChannel('audiobook-state')` in store init; broadcast post-mutation snapshots of the analysis + generation slices keyed by `bookId`. Listening tabs hydrate without a network round-trip.
- _Acceptance:_ Open the same book in two tabs, start an analysis in tab A → tab B's top-bar pill updates without a refresh. New Vitest spec under jsdom mocks `BroadcastChannel` and asserts inbound messages drive the right reducer.
- _Key files:_ `src/store/index.ts`; new `src/store/broadcast-middleware.ts`; `src/store/analysis-slice.ts`; `src/store/chapters-slice.ts`.
- _Depends on:_ none structural. Note the tension with Won't #3 (multi-tab catch-up race resilience parked) — this entry covers the cooperative cross-tab case, not the racing-writes case.
- _Benefit (technical):_ eliminates the cold-boot endpoint round-trip (the `/api/library/active-analyses` lookup, shipped 2026-05-17) when a sibling tab already has the state. Single-user-per-workspace assumption still holds.

### 13. PocketBook Cloud direct upload OR `@pbsync.com` email gateway

Source: [`32-audiobook-export.md`](features/32-audiobook-export.md) follow-ups.

- _What:_ Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- _Acceptance:_ A working prototype for one of the two paths; new tile on the export modal; documented size limits + caveats.
- _Key files:_ new tile config in `src/data/listener-apps.ts`; `src/modals/export-audiobook.tsx`; `server/src/export/` for any new transport.
- _Benefit (user):_ true sideload-free path. Low priority because LAN download + sync folder already work.

### 14. Single-poll TTS lifecycle for a third consumer (tracking)

Source: [`30-global-model-control.md`](features/30-global-model-control.md) "When to extend the pattern".

- _What:_ Tracking item. The consolidated `useTtsLifecycle()` hook (`src/lib/use-tts-lifecycle.ts`) already drives both today's pill surfaces — top-bar (`src/components/layout.tsx`) and Generation view (`src/views/generation.tsx`) — from one `setInterval` via `LayoutContext`. **Wake this item when a JIT-warmed surface graduates to pill-driven UI.** Concrete triggers: Profile Drawer Play, Cast row Play, or the per-character "regenerate this voice across the book" button — whichever first stops using `playSampleWithAutoLoad` and starts wanting an always-on Load/Stop affordance.
- _Acceptance:_ The new surface reads `ttsLifecycle` from `useOutletContext<LayoutContext>()` (pattern from `generation.tsx`). No new `setInterval`, no new `/health` poll, no duplicated `evictionNotice` / `loadErrorNotice` state.
- _Key files:_ `src/lib/use-tts-lifecycle.ts` (no changes expected — already exported); `src/components/layout.tsx` (no changes — already exposes the context); the new surface's component file.
- _Depends on:_ an actual third surface materialising. Product-driven, not architecture-driven — the seam is ready, the trigger isn't.
- _Benefit (architectural):_ prevents the duplicated-poll explosion that motivated plan 30 G1 in the first place.

### 15. Un-quarantine the two e2e flakes (`listen-playback`, `new-book-flow`) by fixing parallel-worker contention

Source: plan 46 ship (2026-05-18). Two specs `test.fixme`'d when plan 46 landed.

- _What:_ Both specs pass in isolation but fail consistently when Playwright runs workers in parallel on Windows under load. Root cause is unproven — candidates: (a) the mock MP3 fetch + decode racing two workers on the same Vite dev server, (b) SSE phase transitions firing faster than the mock-canned-data tick under contention, (c) a `setTimeout`/`requestAnimationFrame` interaction with the headless tab being throttled. Investigate via Playwright trace (`test-results/*/trace.zip`), narrow to one of (a)/(b)/(c), then either bump the per-test timeout, add a focused `waitFor` predicate, or carve out a `serial` workers config for these two specs.
- _Acceptance:_ Drop the `.fixme` markers on both specs. `npm run verify` lands green at least 5 times in a row on a Windows host with default parallel workers. Add a regression test that pins the fix (e.g. a deterministic mock-tick or a docs note in `playwright.config.ts:25-26` explaining why the affected specs need `test.describe.serial`).
- _Key files:_ `e2e/listen-playback.spec.ts:15`, `e2e/new-book-flow.spec.ts:32`, `playwright.config.ts:14-26`, `e2e/helpers.ts`, `src/mocks/canned-data.ts` (if mock-tick determinism turns out to be the fix).
- _Depends on:_ none.
- _Benefit (technical):_ restores the two e2e specs that cover the highest-blast-radius surfaces (mini-player play + full new-book cold-boot walk). Until then both code paths only have Vitest+jsdom coverage, which is known to lie about audio playback and SSE timing.

### 16. Windows installer (Inno Setup or NSIS) wrapping the release zip

Source: net-new (2026-05-18). Deferred follow-up to Should #1 ([`49-release-package.md`](features/49-release-package.md)).

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `audiobook-generator-vX.Y.Z.zip` produced by Should #1 into a signed `.exe` installer. Installer extracts to `%LocalAppData%\AudiobookGenerator`, drops a Start Menu entry, runs prerequisite checks (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, and offers to run `install-kokoro.ps1` post-install. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Acceptance:_ Double-clicking the installer on a clean Windows 11 box yields a runnable app reachable at `http://localhost:5173`, with no terminal interaction required from the deployer. SmartScreen warning cleared after one user "Run anyway" click (full reputation requires an EV code-signing cert — out of scope until the cert is procured).
- _Key files:_ new `installer/audiobook-generator.iss` (Inno Setup), new `installer/build-installer.ps1`, `.github/workflows/release.yml` (add `installer` job on `windows-latest` that runs after the zip job and uploads to the same release).
- _Depends on:_ Should #1 shipped (the installer wraps the existing zip — no point building before the zip pipeline exists).
- _Benefit (user):_ friction-free install for non-developers. Today's Should #1 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.

### 17. Docker image + compose file for headless / Linux deployment

Source: net-new (2026-05-18). Deferred follow-up to Should #1 ([`49-release-package.md`](features/49-release-package.md)).

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/audiobook-generator:vX.Y.Z` on tag push.
- _Acceptance:_ `docker compose up` on a host with NVIDIA Container Toolkit installed brings up the three-service stack reachable on the documented ports. The published image works against a fresh `WORKSPACE_DIR` bind mount; tagged versions are pullable from GHCR.
- _Key files:_ new `Dockerfile`, new `docker-compose.yml`, new `docs/features/50-docker-image.md` (when this graduates from BACKLOG to active), `.github/workflows/release.yml` (extend with the GHCR push job).
- _Depends on:_ Should #1 shipped (reuses the same tag-push trigger and version source); resolving the workspace-mount question.
- _Benefit (user):_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case.

---

## Won't (this round) — explicitly parked

Specific items someone might reasonably re-propose. Each carries a _Why parked_ (the v1 design or operational constraint) and a _Wake when_ (the trigger that makes us reopen). The broad "v1 scope freeze" and "no visual redesign" are covered by CLAUDE.md "Out of scope" and don't need restating here — this list is for tracked-specific decisions only.

### 1. Auto-install Ollama / auto-pull models

Source: [`29-analyzer-ollama-local.md`](features/29-analyzer-ollama-local.md).

- _Why parked:_ installer + `ollama pull` are platform-specific and fragile under the OneDrive workspace path; the README addendum + explicit user opt-in is the v1 contract.
- _Wake when:_ Ollama upstream ships a stable cross-platform headless installer, OR a CI / dev-container path needs one-command bring-up. Likely two separate items then.

### 2. Multi-model fan-out for Gemini analyzer

Source: [`06-analyzer-gemini.md`](features/06-analyzer-gemini.md).

- _Why parked:_ one model per run keeps cost predictable and the SSE stream simple; A/B comparison today is two sequential runs.
- _Wake when:_ a real product use case for "render the same chapter under two models side-by-side in one view" emerges. The audio-layer a/b audition (plan 20) covers the listening-side intent today.

### 3. Multi-tab catch-up race resilience

Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md).

- _Why parked:_ disk `state.json` is authoritative + single-user-per-workspace, so two tabs on the same book never compete on writes. Tab B catches up by re-reading state on focus.
- _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with Won't #9 — both wake under the same trigger.

### 4. Multi-book parallel generation

Source: [`16-generation-stream.md`](features/16-generation-stream.md).

- _Why parked:_ single 8 GB GPU can't hold two XTTS/Kokoro instances; the generation queue is serial per workspace by design.
- _Wake when:_ either cloud TTS becomes the dominant generation path so VRAM is no longer the bottleneck, or the user adds a dedicated per-book GPU. Neither is on the v1 roadmap.

### 5. Voice creation from scratch

Source: [`22-voice-library.md`](features/22-voice-library.md).

- _Why parked:_ the library is a read-only view over the sidecar's voice catalog (28 Kokoro + Coqui's bundled set). Authoring a voice means a separate Coqui voice-cloning UI that's its own product surface.
- _Wake when:_ user wants to author / fine-tune voices in-app rather than dropping pre-made reference `.wav`s into the sidecar's `voices/` folder. Likely depends on a much bigger Coqui training pipeline first.

### 6. Bulk pin / bulk delete in voice library

Source: [`22-voice-library.md`](features/22-voice-library.md).

- _Why parked:_ v1 voice library has fewer than 50 entries (28 Kokoro + ~12 Coqui defaults); per-voice click is fast enough.
- _Wake when:_ user-created voices push the library past ~50 entries and per-voice clicking becomes painful (track via user complaint, not preemptive). Pairs with Won't #5 — without an author flow there's nothing to bulk-operate on.

### 7. Live `VITE_USE_MOCKS` toggle in running UI

Source: [`23-mock-toggle.md`](features/23-mock-toggle.md).

- _Why parked:_ the mock layer swaps the entire `api` module at module-load via the env flag; flipping at runtime would need a different architecture (e.g. mock middleware around the api object).
- _Wake when:_ demo / QA flow requires mid-session real↔mock flipping. Today rebuilding with `VITE_USE_MOCKS=true` takes 5 s — building the runtime toggle would cost more than the friction it removes.

### 8. Partial mock mode (some endpoints mocked, others real)

Source: [`23-mock-toggle.md`](features/23-mock-toggle.md).

- _Why parked:_ all-or-nothing keeps the type contract clean — every component imports from `api.*` without knowing which side it's hitting.
- _Wake when:_ a specific endpoint needs mock-while-rest-real (e.g. mocking a flaky third-party while testing everything else live). The cheapest path then is likely a per-endpoint override in the mock layer, not the architecture change above.

### 9. Conflict resolution for two simultaneous `state.json` writers

Source: [`27-book-state-persistence.md`](features/27-book-state-persistence.md).

- _Why parked:_ single-user-per-workspace assumption; file locking is advisory at best on Windows network shares.
- _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with Won't #3 — both wake under the same trigger.
