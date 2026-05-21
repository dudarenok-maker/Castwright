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

Ranking within each bucket = top is highest priority. Item numbers are
sequential per bucket and renumber every time an item ships (see the
"Update rule" above) — don't cite a Could-#N from outside `BACKLOG.md`
without re-reading the current list.


---

## Must — blocks v1 ship or hurts existing users

### 1. Multi-language support — same-language audio for same-language books (Russian first)

Source: net-new (2026-05-20). Captured during planning of the next full version update; user-flagged as critical for the next full version update.

- _What:_ Lift the implicit English-only assumption across the stack. Add `language` (BCP-47 string, default `"en"`) to `BookStateJson` and the OpenAPI `Book` + `Character` schemas. Add **Qwen3-TTS 0.6B** as a third sidecar engine (Alibaba, Apache 2.0, ~2.5 GB on disk, 4–6 GB VRAM during synth — fits the existing analyzer-eviction pattern) with its own cross-platform install script. Pipe `book.language` through to every sidecar `/synthesize` call. Auto-detect language on manuscript drop (≥30% Cyrillic codepoints → `"ru"`) with a chip + override on the confirm-metadata view. Filter the voice library panel by `voice.language === book.language` and auto-load Qwen3 when a Russian book becomes active. Fix the Gemini analyzer's Latin-only chars/4 token estimator for Cyrillic. Inject a language preamble into analyzer skill prompts for non-English manuscripts. Listen-header language badge + dedicated library language filter pill (separate from free-text tags). **Hard invariant: never cross-language** — Russian voices never read English text, English voices never read Russian text.
- _Acceptance:_ Upload an English manuscript → behaviour unchanged from today (regression). Upload a Russian public-domain fixture (Pushkin / Chekhov — NOT the Keefe Story, that's English) → confirm-metadata chip detects Russian + allows override → opening the book auto-loads Qwen3 with the existing analyzer-eviction banner → cast picker shows ONLY Russian voices → preview button speaks a Russian pangram → generated chapter audio is Russian with zero English bleed-through. Cyrillic token estimate within ±10% of actual `usage.input_tokens` on a long chapter. Library `Russian` filter pill ANDs with existing tag filters. Concurrent-multibook invariant holds: starting Russian Book A then switching to English Book B mid-flight keeps Book B's picker English and Book A's in-flight analysis Russian. On a fresh clone with no Qwen3 weights, opening a Russian book surfaces a clear "run `npm run install:qwen3`" call-to-action — not a silent 404. New Vitest + Playwright coverage on every new seam (detect-language helper, voice-library filter, preview-text switch, listen-header badge, library language pill); new pytest case in `server/tts-sidecar/tests/test_qwen3.py` (Cyrillic input + `language: "ru"` → non-empty PCM, no cross-bleed under concurrent synth).
- _Key files:_ `openapi.yaml` (add `language` to `Book` + `Character`; `BaseVoice.language` already half-extended at `openapi.yaml:2181-2185`); `src/lib/types.ts:135-185` (`BookStateJson`); `src/store/book-meta-slice.ts:22-38` (`EditableBookMeta`); server state.json reader (default-back-fill migration on read). Sidecar: `server/tts-sidecar/main.py:176,403-409,436,468,527-532` + new `server/tts-sidecar/engines/qwen3.py` + new `server/tts-sidecar/scripts/install-qwen3.mjs` (Node ESM, cross-platform) + thin `scripts/install-qwen3.ps1` wrapper for Windows discoverability. Server: `server/src/tts/voice-mapping.ts:104-146,223-242` (add Qwen3 profile tables, language-aware `pickVoiceForEngine`), `server/src/tts/synthesise-chapter.ts` (thread `book.language` to sidecar), `server/src/tts/base-voices.ts:36-41` (populate the existing-but-unfilled `language` field on every voice), `server/src/analyzer/gemini.ts:553-562` (Cyrillic-aware `estimateInputTokens`), analyzer skill-prompt loader (language preamble injection). Frontend: `src/views/upload.tsx:141-163` + new `src/lib/detect-language.ts` + the confirm-metadata view (chip + override); `src/components/listen/listen-header.tsx:219-234` (badge); `src/components/voice-library-panel.tsx` (language filter), `src/components/voice-preview-button.tsx` (per-language sample text), `src/components/model-control-pill.tsx` (Qwen3 button + auto-load on Russian-book select); `src/components/library/library-chrome.tsx:49-56` + `src/store/library-slice.ts:111` (language filter pill ANDed with tag intersection). Tailwind config needs no work — General Sans / Lora / Inter all support Cyrillic. Full design intent + wave decomposition captured in `~/.claude/plans/ok-lets-do-a-delightful-kahn.md`; move into `docs/features/NN-multi-language-russian.md` when the next round opens.
- _Depends on:_ none structural. Reuses the existing sidecar load/unload + analyzer auto-eviction pattern (`POST /api/sidecar/{load,unload}` + `POST /api/ollama/unload` per `server/src/analyzer/ollama.ts:92`), the half-extended `BaseVoice.language` field, the per-engine `overrideTtsVoices` cast map, the tag-filter intersection at `src/store/library-slice.ts:111`, Vitest + RTL + Playwright harnesses, and the Kokoro install script as the shape reference for the new Qwen3 installer.
- _Benefit (user / architectural):_ unlocks Russian (and arbitrary future languages) as a first-class concept — Russian books play Russian audio with Russian voices, no cross-language artefacts. The BCP-47-string contract (vs. closed enum) makes adding Spanish / German / etc. a UI-list change rather than a contract migration. Engine choice (Qwen3 over XTTS) preserves the option to monetize: XTTS's CPML is non-commercial-only; Qwen3-TTS is Apache 2.0. Critical for the next full version update per user direction.

---

## Should — important, not blocking ship

(none currently)

---

## Could — nice to have, low-cost wins

Ordered roughly: audio-quality magic → multibook invariants → workflow stubs → cast/revisions → voice library → ops & CI → distribution → listener-app handoffs → passive tracking.

### 1. Streaming audio for live playback during chapter generation

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Acceptance:_ Generating a chapter shows audio progress under the play cursor before the chapter completes. Existing per-chapter file is still written atomically at the end.
- _Key files:_ `server/src/tts/synthesise-chapter.ts`; `server/src/tts/mp3.ts`; `src/components/mini-player.tsx` for the MediaSource consumer.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on.

### 2. Per-segment regen consumer for `revisions.acceptedSelections`

Source: plan 20 close-out (2026-05-18). The `revisions.acceptedSelections` map is persisted by `revisionsActions.acceptRevision` but no in-app code reads it back — per-segment splicing of accepted takes was explicitly "Out of scope" for plan 20 v1, and remains so in the v1 close-out.

- _What:_ Add a per-segment regen path that consumes `acceptedSelections[revisionId]` to re-render only the segments the user flipped to 'B' (the new take) while preserving 'A' (the original) segments verbatim. This requires (a) a server endpoint that accepts `{ revisionId, segmentSelections }` and dispatches per-segment synth, (b) a segments-manifest merge step that interleaves the two takes on disk, (c) a frontend trigger from the revision-diff player's "Commit selection" action.
- _Acceptance:_ Open a pending revision, toggle segments 3 + 7 to 'B' (others 'A'), click "Commit selection" → the chapter MP3 is rewritten with segments 3 + 7 re-rendered from the new take, all other segments byte-identical to the preserved (A) take. Server Vitest covers the manifest merge + per-segment synth; frontend Vitest covers the action dispatch shape; e2e covers the audition-then-commit flow.
- _Key files:_ new `server/src/routes/revisions-commit-segments.ts`; `server/src/tts/synthesise-chapter.ts` (extend for per-segment paths); `src/views/revision-diff.tsx` (dispatch through the new endpoint); `src/store/revisions-slice.ts` (mark the revision as committed once the segment-level synth completes).
- _Depends on:_ plan 20 shipped (acceptedSelections persistence is already on disk). Pairs with Could #5 (multi-step rollback / snapshot-per-entry) — the timeline becomes meaningful once per-segment commits land separately from full regens.
- _Benefit (user):_ true segment-level revision control. Today accept/reject is whole-revision swap — if the user likes 9 of 10 segments in the new take but wants segment 7 from the original, they have to regenerate the whole chapter under different prompts to recover that one segment. This closes the loop the slice has been quietly capturing since plan 20 v1.

### 3. Multi-step rollback / snapshot-per-entry (revision history)

Source: net-new (2026-05-19). Spun off from plan 55 ship — v1.3.0 plan 55 ships the read-only history view; this entry covers the multi-step rollback that needs snapshot-per-entry storage.

- _What:_ Extend plan 20's `preserveExistingAsPrevious` to write `.previous.<entryId>.<slug>.mp3` per timeline entry (not just one `.previous.<slug>.mp3` per chapter). Wire a server `POST /api/books/:bookId/revisions/:entryId/rollback` endpoint that restores a specific timeline entry's audio + flips subsequent entries to `rolled-back-from`. Add a GC pass that prunes oldest snapshots after the user commits (or when disk pressure exceeds a cap, e.g. 10 entries / chapter).
- _Acceptance:_ Generate chapter, regenerate twice, accept both. Open History → 2 active entries each `reversible: true`. Click Rollback on entry 1 → chapter audio reverts to entry-1's state; entry 2 marked `rolled-back-from`. New rollback can target a still-reversible entry; double-rollback → 409.
- _Key files:_ `server/src/workspace/preserve-previous-audio.ts` (extend filename pattern); new `server/src/routes/revisions-rollback.ts`; `src/components/revision-timeline-modal.tsx` (enable Rollback button on reversible entries); slice already plumbed (plan 55's `rolledBack` reducer + `reversible` field).
- _Depends on:_ plan 55 shipped (slice plumbing already on disk).
- _Benefit (user):_ closes the centerpiece feature from plan 55 — true non-linear undo per chapter. Today the timeline modal is read-only; the user has to walk through accept/reject in the A/B player.

### 4. Batch voice-replace across all books

Source: net-new (2026-05-18).

- _What:_ Add a "Replace voice everywhere" affordance in the voice library: pick a current voice, pick a replacement, see a preview of all (book, character) pairs that would be affected, confirm. Affected books' cast slices are mutated; audio is invalidated (regen prompt per book).
- _Acceptance:_ Three books each use voice `am_michael` for one character → batch replace `am_michael` → `am_eric` shows 3 affected pairs, confirm rewrites all three cast.json files, audio marked stale. Vitest covers the dry-run preview + write logic; e2e covers the modal flow.
- _Key files:_ new `src/modals/batch-voice-replace.tsx`; `src/views/voices.tsx` (entry point); `server/src/routes/voices.ts` (cross-book write endpoint); new `server/src/audio/invalidate.ts` (multi-book audio invalidation).
- _Depends on:_ none.
- _Benefit (user):_ cross-book voice consistency without per-book re-casting. Common need when switching a recurring narrator across a series.

### 5. Cross-book voice compare

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- _What:_ Lift the cross-book guard. When the two selected voices belong to different `bookId`s, fetch each book's cast (one of them may be the open book — short-circuit) and pass both characters into `CompareCastModal`. Decide and document: do we route saves back to each character's source book's cast slice, or refuse the save and surface a "viewing only" banner?
- _Acceptance:_ The Compare button enables for cross-book pairs; the modal opens with both characters; the Save behaviour is documented and tested. The e2e gains a cross-book pair assertion.
- _Key files:_ `src/views/voices.tsx`; `src/store/cast-slice.ts` (Save routing); `src/modals/compare-cast-modal.tsx` (if the viewing-only banner is needed).
- _Depends on:_ plan 60 shipped (same on-demand fetch machinery is already in place; this entry lifts the cross-book guard and decides foreign-book save routing).
- _Benefit (user):_ enables A/B for users who reuse the same TTS voice across books — e.g. comparing the same narrator across two books in a series to spot drift.

### 6. Linux visual baselines for CI

Source: net-new (2026-05-19). Spun off from the visual-baselines CI fix — `e2e/visual.spec.ts` now skips on platforms with no committed baselines so PR Verify can go green, but PR CI then carries zero visual-regression coverage. Until Linux baselines land, only local Windows runs catch chromium drift.

- _What:_ Commit `e2e/linux/visual.spec.ts/*.png` (12 PNGs matching the Win32 set). Two paths: (a) generate locally via Docker / WSL with `playwright test --update-snapshots visual.spec.ts`; (b) add a `workflow_dispatch` GitHub Action that runs `--update-snapshots` on an ubuntu-latest runner and opens a PR with the artefact, so future regen doesn't need a Linux box. The directory-level skip in `e2e/visual.spec.ts` re-enables the spec on Linux automatically the moment the directory exists.
- _Acceptance:_ Next PR's Verify run is green on all 12 visual specs (no skip messages). `docs/features/archive/37-e2e-playwright.md` "Per-platform skip" subsection loses the "Win32 only" caveat. Bonus: if the workflow_dispatch path is taken, document it under "Regenerate workflow".
- _Key files:_ `e2e/linux/visual.spec.ts/` (new directory); optional `.github/workflows/regen-visual-baselines.yml`; `docs/features/archive/37-e2e-playwright.md` "Visual baselines" section.
- _Benefit (technical):_ restores Verify as a real merge gate. Today PR CI's only red signal is "visual baselines missing" — once those land, a red Verify means real regression and reviewers stop ignoring it.

### 7. Auto-backup scheduling for `state.json`

Source: net-new (2026-05-18).

- _What:_ Add a background backup job that on configurable cadence (daily / weekly) writes a snapshot of `<workspace>/<bookId>/.audiobook/state.json` to `<workspace>/.backups/<bookId>/<YYYYMMDD-HHMMSS>.json`. Keep last N (configurable, default 14). Manual "Restore from backup" affordance in workspace settings.
- _Acceptance:_ Set daily backups → 14 daily snapshots accumulate in `.backups/`, oldest auto-pruned. Restore from snapshot → state.json reverted to that point; library view refreshes. New server Vitest spec covers the cron-like cadence + prune.
- _Key files:_ new `server/src/workspace/auto-backup.ts`; `server/src/workspace/scan.ts` (initial trigger on server start); new settings affordance under Could #13 power-user panel (or inline in `src/views/library.tsx` if shipped first).
- _Depends on:_ none.
- _Benefit (user):_ disaster recovery without manual intervention. Particularly valuable on Windows where OneDrive sync conflicts can occasionally corrupt `state.json` mid-write.

### 8. GPU-arbitration semaphore for parallel Claude Code sessions

Source: net-new (2026-05-19). Spun off from the parallel-sessions tooling — `scripts/wt-new.mjs` resolves port collisions but leaves GPU/VRAM contention as a manual-coordination concern documented in CONTRIBUTING.md.

- _What:_ Add a small server-side semaphore around heavy-GPU operations (analyzer's chat completion path + sidecar's `/synthesize`) so concurrent requests from N parallel sessions get serialized rather than fighting over VRAM on an 8 GB GPU. Default concurrency = 1 GPU operation at a time; configurable via `GPU_CONCURRENCY` env var. Surface the queue depth in the existing top-bar pill state so the user sees "Queued (1 ahead)".
- _Acceptance:_ Two parallel sessions both kick off `/analyse` → second request waits in queue until first completes (no VRAM spill, no silent OOM). The top-bar pill in the waiting session shows "Queued". New server Vitest spec covers the semaphore behaviour; existing tests stay green.
- _Key files:_ new `server/src/gpu/semaphore.ts`; `server/src/analyzer/ollama.ts` (wrap chat calls); `server/src/routes/sidecar-synth.ts` (wrap synth proxy); `src/components/layout.tsx` (consume queue-depth from existing pill polling).
- _Depends on:_ none. Pairs with the worktree parallel-sessions tooling — without the semaphore, users must queue heavy operations by hand per the CONTRIBUTING.md "GPU + shared-resource caveats" note.
- _Benefit (user):_ removes the silent VRAM-spillover-to-RAM slowdown when two sessions hit the analyzer or sidecar concurrently. Today a parallel run can take 5–10× longer than serial because both processes thrash the GPU.

### 9. Keyboard shortcuts / power-user tuning panel

Source: net-new (2026-05-18).

- _What:_ Add a settings panel (under a gear icon in the top-bar) for power-user tuning: keyboard-shortcut overrides (e.g. spacebar = play/pause), runtime knobs (SSE chunk size, TTS concurrency cap, debounce values for autosave), accessibility toggles (high-contrast theme, larger text). Settings persist in localStorage and apply on next render.
- _Acceptance:_ Open settings, change autosave debounce from 500ms to 2000ms → next edit waits 2s before write. Override "play/pause" shortcut to "K" → keyboard "K" toggles mini-player. Vitest covers the persistence + shortcut binding.
- _Key files:_ new `src/views/settings.tsx`; new `src/lib/keybindings.ts`; new `src/store/settings-slice.ts`; `src/components/layout.tsx` (gear icon entry point).
- _Depends on:_ none.
- _Benefit (technical / accessibility):_ power-user tuning surfaces today's hardcoded values; keyboard navigation closes an accessibility gap.

### 10. Windows installer (Inno Setup or NSIS) wrapping the release zip

Source: net-new (2026-05-18). Deferred follow-up to Should #2 ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `audiobook-generator-vX.Y.Z.zip` produced by Should #2 into a signed `.exe` installer. Installer extracts to `%LocalAppData%\AudiobookGenerator`, drops a Start Menu entry, runs prerequisite checks (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, and offers to run `install-kokoro.ps1` post-install. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Acceptance:_ Double-clicking the installer on a clean Windows 11 box yields a runnable app reachable at `http://localhost:5173`, with no terminal interaction required from the deployer. SmartScreen warning cleared after one user "Run anyway" click (full reputation requires an EV code-signing cert — out of scope until the cert is procured).
- _Key files:_ new `installer/audiobook-generator.iss` (Inno Setup), new `installer/build-installer.ps1`, `.github/workflows/release.yml` (add `installer` job on `windows-latest` that runs after the zip job and uploads to the same release).
- _Depends on:_ Should #2 shipped (the installer wraps the existing zip — no point building before the zip pipeline exists).
- _Benefit (user):_ friction-free install for non-developers. Today's Should #2 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.

### 11. Docker image + compose file for headless / Linux deployment

Source: net-new (2026-05-18). Deferred follow-up to Should #2 ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/audiobook-generator:vX.Y.Z` on tag push.
- _Acceptance:_ `docker compose up` on a host with NVIDIA Container Toolkit installed brings up the three-service stack reachable on the documented ports. The published image works against a fresh `WORKSPACE_DIR` bind mount; tagged versions are pullable from GHCR.
- _Key files:_ new `Dockerfile`, new `docker-compose.yml`, new `docs/features/50-docker-image.md` (when this graduates from BACKLOG to active), `.github/workflows/release.yml` (extend with the GHCR push job).
- _Depends on:_ Should #2 shipped (reuses the same tag-push trigger and version source); resolving the workspace-mount question.
- _Benefit (user):_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case.

### 12. Apple Books (iOS / macOS) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Apple Books tile with the appropriate handoff: macOS supports drag-into-Books; iOS supports AirDrop or sync via Files. Modal shows the platform-specific flow (detect Mac vs other UA, default to "iOS via AirDrop"). Copy-and-instructions only — no direct integration with Apple Books library API (which is restricted).
- _Acceptance:_ Click tile → modal shows platform-detected instructions. Vitest covers the UA detection branching.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`.
- _Depends on:_ plan 18b shipped.
- _Benefit (user):_ closes one more "Coming soon" tile.

### 13. Plex (self-hosted media server) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Plex tile with two paths: (a) instructions for manual upload to a Plex server library, (b) optional direct upload via the Plex API if the user has provided a Plex token (settings field). Path (b) is the most-complex of the four — Plex auth + library scan trigger.
- _Acceptance:_ Click tile → modal shows manual upload steps. If a Plex token is configured, an "Upload directly" button hits the Plex API. Vitest covers both modes.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`; `src/views/settings.tsx` (Plex token field — see Could #13 power-user panel); new `server/src/export/plex.ts` for the optional upload path.
- _Depends on:_ plan 18b shipped; ideally Could #13 (power-user panel) for the token storage.
- _Benefit (user):_ closes one more "Coming soon" tile; opens the door to direct upload integration.

### 14. PocketBook Cloud direct upload OR `@pbsync.com` email gateway

Source: [`32-audiobook-export.md`](features/32-audiobook-export.md) follow-ups.

- _What:_ Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- _Acceptance:_ A working prototype for one of the two paths; new tile on the export modal; documented size limits + caveats.
- _Key files:_ new tile config in `src/data/listener-apps.ts`; `src/modals/export-audiobook.tsx`; `server/src/export/` for any new transport.
- _Benefit (user):_ true sideload-free path. Low priority because LAN download + sync folder already work.

### 15. Single-poll TTS lifecycle for a third consumer (tracking)

Source: [`30-global-model-control.md`](features/30-global-model-control.md) "When to extend the pattern".

- _What:_ Tracking item. The consolidated `useTtsLifecycle()` hook (`src/lib/use-tts-lifecycle.ts`) drives today's pill surfaces — top-bar (`src/components/layout.tsx`) and Generation view (`src/views/generation.tsx`) — from one `setInterval` via `LayoutContext`. Per the 2026-05-21 Kokoro-Stop-pill change, the hook now fans out per engine: it returns `{ coqui, kokoro, evictionNotice, loadErrorNotice, dismissNotices }` from a single /health probe. **Wake this item when a JIT-warmed surface graduates to pill-driven UI.** Concrete triggers: Profile Drawer Play, Cast row Play, or the per-character "regenerate this voice across the book" button — whichever first stops using `playSampleWithAutoLoad` and starts wanting an always-on Load/Stop affordance.
- _Acceptance:_ The new surface reads `ttsLifecycle` from `useOutletContext<LayoutContext>()` (pattern from `generation.tsx`), picks the per-engine slot it cares about (`ttsLifecycle.coqui` / `ttsLifecycle.kokoro`), and renders the right pill via `ModelControlPill` with the matching `engineLabel`. No new `setInterval`, no new `/health` poll, no duplicated `evictionNotice` / `loadErrorNotice` state.
- _Key files:_ `src/lib/use-tts-lifecycle.ts` (no changes expected — the per-engine fan-out is already in place); `src/components/layout.tsx` (no changes — already exposes the context and the `selectEnginesInUse` mounting pattern); `src/store/engines-in-use-selector.ts` (extend only if the new surface needs a different "is this engine relevant" predicate); the new surface's component file.
- _Depends on:_ an actual third surface materialising. Product-driven, not architecture-driven — the seam is ready, the trigger isn't.
- _Benefit (architectural):_ prevents the duplicated-poll explosion that motivated plan 30 G1 in the first place.

### 16. Non-blocking GH Actions workflow for `npm run test:e2e:mobile`

Source: net-new (2026-05-21). Spun off from plan 81 wave 5 (PR #92).

- _What:_ Add a `.github/workflows/e2e-mobile.yml` job that runs `npm run test:e2e:mobile` on every PR targeting `main`, set `continue-on-error: true` so it shows status without blocking merges. Visibility-only — the pre-push gate stays chromium-only (under the 5 min budget that plan 81 set).
- _Acceptance:_ A PR that breaks mobile-chrome layout shows a red but non-blocking check on the PR page. A PR that doesn't touch UI shows green. Failure status surfaces in the merge UI as "Mobile e2e — failing (non-blocking)".
- _Key files:_ new `.github/workflows/e2e-mobile.yml` mirroring `verify.yml`'s setup (node, npm cache, chromium install) but invoking `npm run test:e2e:mobile` instead of `npm run verify`. Concurrency `cancel-in-progress` per PR ref to avoid stacking runs.
- _Depends on:_ plan 81 shipped (which added the `test:e2e:mobile` script).
- _Benefit (technical):_ catches mobile regressions in PRs without blowing the pre-push budget. Two-tier gate — mobile is opt-in for local iteration but mandatory-visibility in CI.

### 17. Bless mobile + tablet visual-snapshot baselines per Playwright project

Source: net-new (2026-05-21). Plan 81 wave 5 follow-up.

- _What:_ Run `npx playwright test --update-snapshots --project=mobile-chrome` + `--project=tablet-chrome` to capture per-project visual baselines for the six `visual.spec.ts` views (library, upload, analysing, confirm, ready/manuscript, listen). Commit them under `e2e/win32/visual.spec.ts/<project>/<view>.png` per the existing snapshot-path template. Promote `visual.spec.ts` to assert against the captured baselines on all three projects (today it only runs at chromium).
- _Acceptance:_ `npm run test:e2e:mobile` captures + diffs visual snapshots; a layout drift at any viewport fails the assertion. Per-platform per-project paths: `e2e/win32/visual.spec.ts/mobile-chrome/library.png` etc.
- _Key files:_ `e2e/visual.spec.ts` (remove the chromium-only assumption; gate test.skip on the per-project baseline dir per the existing `BASELINE_DIR` pattern); regenerated PNGs in `e2e/{win32,linux,darwin}/visual.spec.ts/{mobile-chrome,tablet-chrome}/`; `playwright.config.ts:45` `snapshotPathTemplate` already includes `{platform}` — extend to `{platform}/{project}` if needed.
- _Depends on:_ plan 81 shipped.
- _Benefit (technical):_ pixel-level mobile/tablet regression net. Today the no-overflow assertion catches layout breakage but not visual drift; this entry closes that gap.

### 18. Mobile Playwright worker count tuning (browser-launch contention fix)

Source: net-new (2026-05-21). Surfaced during plan 81 wave 5 development.

- _What:_ Running 3 Playwright projects in parallel with the default worker count (~CPU/2) exhausted process slots on the dev box and caused browser-launch timeouts on mobile/tablet specs (real failures: 3 hard, 7 flaky on retry). Reduce `workers` to 1 or 2 for the mobile suite specifically — either via `playwright.config.ts` per-project `workers` override (if Playwright supports per-project workers; if not, via a separate config file invoked by `test:e2e:mobile`).
- _Acceptance:_ `npm run test:e2e:mobile` runs end-to-end with no browser-launch timeouts on the dev box (current state: ~3/24 fail with `TimeoutError: browserType.launch: Timeout 180000ms exceeded`). Total wall-clock may increase slightly but reliability is more important here than speed for the mobile suite.
- _Key files:_ `playwright.config.ts` (workers field, or per-project workers if 1.40+ supports it); maybe a new `playwright.mobile.config.ts` if a separate config is cleaner.
- _Depends on:_ plan 81 shipped.
- _Benefit (technical):_ unblocks #20 — the non-blocking CI workflow needs reliable mobile e2e to be useful as a signal source.

### 19. In-app LAN HTTPS banner under dev settings

Source: net-new (2026-05-21). Plan 81 wave 1 / 2 deferred item.

- _What:_ Account settings card showing the current LAN HTTPS URL (from `GET /api/export/lan` when LAN_HTTPS=1) with one-click "Copy URL" + "Install cert on phone" links. The latter opens a doc / route that shows the QR code that `npm run install:cert-mobile` prints to the terminal today. Dev-mode only — hidden in production single-user environments.
- _Acceptance:_ When LAN_HTTPS=1 is set on the server, the Account view shows a "LAN access" card with the live HTTPS URL + a QR code linking to `/cert/root.crt`. Tapping "Copy URL" puts the URL in the clipboard.
- _Key files:_ new `src/components/lan-access-card.tsx`; `src/views/account.tsx` (or wherever account settings render) to mount the card; `src/lib/api.ts` to wrap `GET /api/export/lan` if not already wrapped.
- _Depends on:_ plan 81 shipped.
- _Benefit (user):_ surfaces the LAN access flow inside the app instead of requiring the user to read terminal output. Especially valuable for users who first installed via the alpha release zip (no terminal interaction expected).

### 20. Broad hover-affordance audit with `coarse-pointer:` Tailwind variant

Source: net-new (2026-05-21). Plan 81 wave 4 deferred item.

- _What:_ Plan 81 wave 4 shipped a `coarse-pointer:` Tailwind variant (matches `@media (pointer: coarse)`) for touch devices that don't expose hover. First consumer is the manuscript boundary handle label. Sweep `src/` for all uses of `group-hover:` / `peer-hover:` / `hover:opacity-0` and apply the variant where the hover-revealed content is functional (e.g. action buttons), not purely decorative (e.g. card lift transitions).
- _Acceptance:_ All action-revealing hover patterns in cast, manuscript, voices, listen, generation views get a `coarse-pointer:opacity-100` (or appropriate) fallback. A test confirms `(pointer: coarse)` simulation reveals the same buttons hover would.
- _Key files:_ grep `src/**/*.tsx` for `group-hover:` / `peer-hover:` / `hover:opacity-0`; apply per-component judgement.
- _Depends on:_ plan 81 shipped.
- _Benefit (user):_ touch users get every action that mouse users do, without needing to discover hidden affordances.

### 21. Within-chapter sentence parallelism

Source: net-new (2026-05-21). Spun off from the perf-tuning survey at `~/.claude/plans/want-to-focus-this-bright-donut.md` (item A2). Stacks on plan 87.

- _What:_ Inside `synthesiseChapter`, dispatch K sentence groups concurrently to the sidecar `/synthesize` (currently 1 at a time per plan 70d). Per-engine determinism + voice non-drift must be re-pinned in `server/tts-sidecar/tests/test_concurrent_synthesis.py`; per-group `onGroupStart` heartbeats must still reset the 30 s stall detector correctly; emitted PCM order preserved by indexing.
- _Acceptance:_ K parallel sentence groups inside one chapter render with no audible drift artefacts on Coqui (XTTS more drift-prone than Kokoro per plan 70d's findings); the stall watchdog still trips correctly on an actual stall; PCM order matches single-threaded baseline. Pytest pin + Vitest server pin both green.
- _Key files:_ `server/src/synthesise-chapter.ts:138-145`; `server/tts-sidecar/tests/test_concurrent_synthesis.py` (additional cases).
- _Depends on:_ plan 87 shipped + measurement showing GPU headroom remains under default chapter concurrency.
- _Benefit (user):_ another ~2× per chapter on top of plan 87 (so 4× headline if GPU survives). Only worth pursuing once plan 87's envelope is known.

### 22. Both TTS engines resident (Kokoro + XTTS)

Source: net-new (2026-05-21). Spun off from the perf-tuning survey (item A3).

- _What:_ Drop the eviction wiring between Kokoro and XTTS; keep both engines loaded. Per-character voice profiles already carry `overrideTtsVoices: { coqui?, kokoro? }` per CLAUDE.md — pick at synth time. VRAM math (Kokoro 1 GB + XTTS 3 GB + Ollama analyzer ~7 GB = 11 GB on an 8 GB GPU) requires Ollama auto-eviction during generation, with the existing "TTS / Analyzer unloaded to free VRAM" banner.
- _Acceptance:_ A mixed-engine book (Coqui voice on character A, Kokoro on character B) renders without engine-swap latency between sentences. First XTTS use no longer pays the ~30 s cold-load. Ollama auto-eviction surfaces a clear banner during generation; re-loads on analysis trigger.
- _Key files:_ `server/tts-sidecar/main.py` (eviction wiring removal); `src/components/model-control-pill.tsx`; analyzer eviction at `server/src/analyzer/ollama.ts:92`.
- _Depends on:_ none structural. Speed gain conditional on mixed-engine casts.
- _Benefit (user):_ eliminates the 30 s XTTS cold-load on first use for mixed-engine books; enables fluid engine mixing per character.

### 23. Per-call local→Gemini analyzer overflow

Source: net-new (2026-05-21). Spun off from the perf-tuning survey (item B4).

- _What:_ Extend `FallbackAnalyzer` (`server/src/analyzer/index.ts:159-210`) to route partial load to Gemini when local Ollama is slow (not just unreachable). Different from plan 88's per-phase split — this is per-call. Roster names + attribution patterns must normalise across the mixed-analyzer run to avoid duplicate characters.
- _Acceptance:_ With both local Ollama and Gemini configured, long-book analysis bursts overflow to Gemini under local slowness; the final roster contains no duplicates from cross-analyzer name variants.
- _Key files:_ `server/src/analyzer/index.ts:159-210`; `server/src/analyzer/select-analyzer.ts`.
- _Depends on:_ plan 88 shipped (its per-phase plumbing is the seam this builds on).
- _Benefit (user):_ uses idle Gemini quota when local is the bottleneck. Lower priority than plan 88's bucketed split.

### 24. Confirm-cast + listen-chapter list virtualisation

Source: net-new (2026-05-21). Spun off from the perf-tuning survey (item C4).

- _What:_ Apply Should #1's `@tanstack/react-virtual` pattern to `src/views/confirm-cast.tsx:187-205` and `src/components/listen/listen-player-region.tsx:93-117`. Same virtualiser dep + helper shape.
- _Acceptance:_ Books with >40 characters mount without confirm-cast jank; books with >40 chapters mount without listen-region jank. Existing tests still green.
- _Key files:_ `src/views/confirm-cast.tsx`; `src/components/listen/listen-player-region.tsx`; shared dep from Should #1.
- _Depends on:_ Should #1 (shares the virtualiser dep + helper — pair to amortise dep adoption).
- _Benefit (user):_ only matters above ~40 rows. Most books are below the threshold today.

### 25. Waveform memoisation

Source: net-new (2026-05-21). Spun off from the perf-tuning survey (item C6).

- _What:_ In `src/components/waveform.tsx`, stabilise the 48-bar `useMemo` (memo key invariant against re-mount) and lift the animation interval to the parent so it ticks once per listen-view mount (not per waveform instance).
- _Acceptance:_ Listen view with N visible waveforms ticks on one shared interval (not N intervals); the rendered output is visually unchanged from today.
- _Key files:_ `src/components/waveform.tsx`; parent in `src/components/listen/listen-player-region.tsx`.
- _Depends on:_ none.
- _Benefit (technical):_ avoids 480+ DOM mutations per 800 ms when many waveforms are visible simultaneously. Low real-world impact today (rare to see >3 waveforms at once).

### 28. Configurable chapter-title silence durations

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-up — net-new (2026-05-21). Deferred from PR #101 (`fix/server-voiced-chapter-titles-and-pauses`).

- _What:_ Promote the two hard-coded constants `CHAPTER_LEAD_SILENCE_SEC = 1.5` and `CHAPTER_POST_TITLE_SILENCE_SEC = 1.5` in `server/src/tts/synthesise-chapter.ts` to a per-book setting on `state.json`. Surface in the Listen view's metadata editor (the same panel that already edits narratorCredit / genre / etc.) as a "Chapter break duration" slider with a small preset list (e.g. 0.5/1/1.5/2/3 s) for the leading + post-title legs. Generation route reads the per-book values and forwards into `synthesiseChapter` opts.
- _Acceptance:_ Editing a book's silence durations and regenerating one chapter produces an MP3 whose leading + post-title silence matches the new setting (ffprobe / spectrogram). Default for legacy books stays 1.5 + 1.5. Existing chapter-audio-format paired tests stay green.
- _Key files:_ `server/src/tts/synthesise-chapter.ts` (params); `server/src/routes/generation.ts` (forward); `server/src/workspace/scan.ts` (state-json field); `src/components/listen/listen-header.tsx` or sibling metadata editor (UI); `openapi.yaml` (book-state shape).
- _Depends on:_ none.
- _Benefit (user):_ lets the user pace chapter breaks to match book length / mood (a tight 0.5 s for a short kids' book, a longer 3 s for a slow-burn novel) without code changes. Today the 3.0 s default is "audiobook-standard" but not universally right.

### 29. Render the chapter-title segment on the Listen view timeline

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-up — net-new (2026-05-21). Deferred from PR #101 (`fix/server-voiced-chapter-titles-and-pauses`).

- _What:_ The new title segment in `segments.json` (kind: `'title'`, empty `sentenceIds[]`) is currently filtered out at the `ChapterAudio` API boundary in `server/src/routes/chapter-audio.ts` because the wire contract types `sentenceId` as a required integer. To surface the title on the listen-view timeline (a labelled "TITLE" pill anchored at the start of the chapter, ~3 s wide including silence), widen the API segment shape so `sentenceId` is optional and add an optional `kind?: 'title' | 'sentence'` discriminator, regenerate `src/lib/api-types.ts`, then teach `src/components/listen/listen-player-region.tsx` to render title-kind segments differently from sentence-kind segments.
- _Acceptance:_ The listen view's chapter timeline shows a short "TITLE" pill at the head of each chapter rendered after this lands. Clicking it seeks to t=0. Pre-existing chapters whose `segments.json` has no title-kind row degrade gracefully (no title pill — same as today).
- _Key files:_ `openapi.yaml` (ChapterAudio segments shape); `src/lib/api-types.ts` (regenerated); `server/src/routes/chapter-audio.ts` (drop the filter, pass kind through); `src/components/listen/listen-player-region.tsx`.
- _Depends on:_ none (the on-disk segment shape already carries `kind: 'title'` since PR #101).
- _Benefit (user):_ visual cue that matches the audible cue — listener sees "you're hearing the title now" before the body segments start. Today the title beat is audible-only.

### 30. Generation SSE survives Node hot-reload during dev

Source: net-new (2026-05-21). Surfaced while smoke-testing PR #107 — a `tsx` restart killed the active SSE bridge and the frontend showed "Worker has gone quiet · 67s" while the sidecar kept synthesising in the background.

- _What:_ When the Node server hot-reloads in dev (`tsx watch` triggered by any file change under `server/src/`), the open `/api/generation/stream` SSE connection dies with it. The sidecar keeps synthesising for as long as the in-flight HTTP request is alive, but the frontend's `generation-stream-middleware` sees no more `progress` ticks and surfaces the "Worker has gone quiet" stall banner after `STALL_THRESHOLD_MS`. Auto-reconnect on the SSE consumer side (re-open against the active book's stream endpoint if it drops while a generation is alive) would let the dev keep editing without manually Pause/Resume-ing every time. Two-layer fix: the consumer reopens; the server-side stream emits an idempotent `resume_from` ack so a reconnect doesn't replay completed chapters. Production users hit this rarely — only on crash recovery — but the seam is exactly the same.
- _Acceptance:_ Edit any file under `server/src/` during a live generation; `tsx` restarts the Node server; within ~3 s the frontend re-establishes the SSE and the chapter list keeps advancing without a "Worker has gone quiet" banner. The book's state.json reflects no double-progress for already-completed chapters.
- _Key files:_ `src/store/generation-stream-middleware.ts` (reconnect logic — today the middleware treats the EventSource ending as a terminal stop); `src/lib/api.ts` `realStreamGeneration` (handle source error/end events as recoverable when a book is mid-flight); `server/src/routes/generation.ts` (idempotent resume — emit a snapshot of completed chapters first, then resume per-chapter `progress`).
- _Depends on:_ none. Self-contained inside the streaming surface.
- _Benefit (dev / technical):_ no more false "stalled" banners during interactive development. Same fix incidentally covers production crash-recovery (Node OOM, manual restart) so users running long books survive a sidecar/server bounce without losing the visible progress thread.

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
