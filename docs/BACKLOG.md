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

(empty — Should #2 verify-cache fast shipped in plan 54 on 2026-05-19.)

---

## Could — nice to have, low-cost wins

Ordered roughly: audio-quality magic → multibook invariants → workflow stubs → cast/revisions → voice library → ops & CI → distribution → listener-app handoffs → passive tracking.

### 1. Streaming audio for live playback during chapter generation

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Acceptance:_ Generating a chapter shows audio progress under the play cursor before the chapter completes. Existing per-chapter file is still written atomically at the end.
- _Key files:_ `server/src/tts/synthesise-chapter.ts`; `server/src/tts/mp3.ts`; `src/components/mini-player.tsx` for the MediaSource consumer.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on.

### 2. Background drift polling across non-active books

Source: net-new (2026-05-19). Spun off from the drift-report-fidelity work — the Drift Report modal now groups events across books, but the runtime poller only fetches the active book. Drift accumulated on Book B while the user is in Book A only surfaces after they navigate to Book B (or via the disk hydrate on book-open).

- _What:_ Extend the revisions poller (`src/components/layout.tsx` ~528-540) to fan out across every book that has rendered chapters (probably `state.bookMeta.saved` filtered to books past the `confirm` stage). Each book's response is stamped with `bookId` in the `applyPoll` payload (already wired). Keep the active book on a 30s tick; throttle non-active books to a longer interval (e.g. 2 min) so we don't blow free-tier server quotas.
- _Acceptance:_ Two books concurrently generating. Drift detected on background Book B (e.g. user changes a cast attribute in Book B's cast slice without navigating back) surfaces in the Drift Report modal opened from Book A's top bar within the poll interval. New unit test covers the multi-book fan-out; e2e spec extends `drift-report-multibook.spec.ts` with a background-poll case.
- _Key files:_ `src/components/layout.tsx` (poller `useEffect`); maybe a new `src/store/revisions-poll-middleware.ts` if the cross-book scheduling outgrows the inline useEffect; `docs/features/35-engine-drift-detection.md` "Modal fidelity contract" invariant (e).
- _Benefit (user):_ honours the concurrent-multibook invariant for drift. Today a user analysing Book A + generating Book B has to navigate between them to see fresh drift events for each.

### 3. Export queue Retry + Download row actions

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18a — needs middleware integration to re-fire a failed export, which is bigger than a row-handler wiring.

- _What:_ The Listen view's Export queue surfaces Retry (on `failed` rows) and Download (on `done` rows without a URL) as wired buttons. Retry re-fires the original `POST /api/books/:bookId/export` with the same payload via a middleware action that reads the job's recorded `format`/`destination`/`syncPath`. Download triggers a `GET /api/exports/:exportId/download` redirect (or a `window.location.assign(item.url)` when the job already carries `downloadUrl`).
- _Acceptance:_ Click Retry on a failed row → a new export job appears with the same parameters and the failed row is dismissed. Click Download on a done-with-URL row → file downloads. Vitest covers the middleware re-fire path; e2e covers the visible buttons.
- _Key files:_ `src/views/listen.tsx` (ExportQueue handlers); `src/store/exports-middleware.ts` (extend with `retryExport` thunk); `server/src/routes/exports.ts` (add `/exports/:exportId/download` redirect if needed).
- _Depends on:_ download-tile endpoints live (today's listener-app handoff stubs land their own download URLs).
- _Benefit (user):_ closes the remaining "Coming soon" stubs in the queue rail. Today copy + remove work (shipped in plan 18a); retry + download are the other two row actions promised by the design.

### 4. Per-segment regen consumer for `revisions.acceptedSelections`

Source: plan 20 close-out (2026-05-18). The `revisions.acceptedSelections` map is persisted by `revisionsActions.acceptRevision` but no in-app code reads it back — per-segment splicing of accepted takes was explicitly "Out of scope" for plan 20 v1, and remains so in the v1 close-out.

- _What:_ Add a per-segment regen path that consumes `acceptedSelections[revisionId]` to re-render only the segments the user flipped to 'B' (the new take) while preserving 'A' (the original) segments verbatim. This requires (a) a server endpoint that accepts `{ revisionId, segmentSelections }` and dispatches per-segment synth, (b) a segments-manifest merge step that interleaves the two takes on disk, (c) a frontend trigger from the revision-diff player's "Commit selection" action.
- _Acceptance:_ Open a pending revision, toggle segments 3 + 7 to 'B' (others 'A'), click "Commit selection" → the chapter MP3 is rewritten with segments 3 + 7 re-rendered from the new take, all other segments byte-identical to the preserved (A) take. Server Vitest covers the manifest merge + per-segment synth; frontend Vitest covers the action dispatch shape; e2e covers the audition-then-commit flow.
- _Key files:_ new `server/src/routes/revisions-commit-segments.ts`; `server/src/tts/synthesise-chapter.ts` (extend for per-segment paths); `src/views/revision-diff.tsx` (dispatch through the new endpoint); `src/store/revisions-slice.ts` (mark the revision as committed once the segment-level synth completes).
- _Depends on:_ plan 20 shipped (acceptedSelections persistence is already on disk). Pairs with Could #5 (multi-step rollback / snapshot-per-entry) — the timeline becomes meaningful once per-segment commits land separately from full regens.
- _Benefit (user):_ true segment-level revision control. Today accept/reject is whole-revision swap — if the user likes 9 of 10 segments in the new take but wants segment 7 from the original, they have to regenerate the whole chapter under different prompts to recover that one segment. This closes the loop the slice has been quietly capturing since plan 20 v1.

### 5. Multi-step rollback / snapshot-per-entry (revision history)

Source: net-new (2026-05-19). Spun off from plan 55 ship — v1.3.0 plan 55 ships the read-only history view; this entry covers the multi-step rollback that needs snapshot-per-entry storage.

- _What:_ Extend plan 20's `preserveExistingAsPrevious` to write `.previous.<entryId>.<slug>.mp3` per timeline entry (not just one `.previous.<slug>.mp3` per chapter). Wire a server `POST /api/books/:bookId/revisions/:entryId/rollback` endpoint that restores a specific timeline entry's audio + flips subsequent entries to `rolled-back-from`. Add a GC pass that prunes oldest snapshots after the user commits (or when disk pressure exceeds a cap, e.g. 10 entries / chapter).
- _Acceptance:_ Generate chapter, regenerate twice, accept both. Open History → 2 active entries each `reversible: true`. Click Rollback on entry 1 → chapter audio reverts to entry-1's state; entry 2 marked `rolled-back-from`. New rollback can target a still-reversible entry; double-rollback → 409.
- _Key files:_ `server/src/workspace/preserve-previous-audio.ts` (extend filename pattern); new `server/src/routes/revisions-rollback.ts`; `src/components/revision-timeline-modal.tsx` (enable Rollback button on reversible entries); slice already plumbed (plan 55's `rolledBack` reducer + `reversible` field).
- _Depends on:_ plan 55 shipped (slice plumbing already on disk).
- _Benefit (user):_ closes the centerpiece feature from plan 55 — true non-linear undo per chapter. Today the timeline modal is read-only; the user has to walk through accept/reject in the A/B player.

### 6. Batch voice-replace across all books

Source: net-new (2026-05-18).

- _What:_ Add a "Replace voice everywhere" affordance in the voice library: pick a current voice, pick a replacement, see a preview of all (book, character) pairs that would be affected, confirm. Affected books' cast slices are mutated; audio is invalidated (regen prompt per book).
- _Acceptance:_ Three books each use voice `am_michael` for one character → batch replace `am_michael` → `am_eric` shows 3 affected pairs, confirm rewrites all three cast.json files, audio marked stale. Vitest covers the dry-run preview + write logic; e2e covers the modal flow.
- _Key files:_ new `src/modals/batch-voice-replace.tsx`; `src/views/voices.tsx` (entry point); `server/src/routes/voices.ts` (cross-book write endpoint); new `server/src/audio/invalidate.ts` (multi-book audio invalidation).
- _Depends on:_ none.
- _Benefit (user):_ cross-book voice consistency without per-book re-casting. Common need when switching a recurring narrator across a series.

### 7. Cross-book voice compare

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- _What:_ Lift the cross-book guard. When the two selected voices belong to different `bookId`s, fetch each book's cast (one of them may be the open book — short-circuit) and pass both characters into `CompareCastModal`. Decide and document: do we route saves back to each character's source book's cast slice, or refuse the save and surface a "viewing only" banner?
- _Acceptance:_ The Compare button enables for cross-book pairs; the modal opens with both characters; the Save behaviour is documented and tested. The e2e gains a cross-book pair assertion.
- _Key files:_ `src/views/voices.tsx`; `src/store/cast-slice.ts` (Save routing); `src/modals/compare-cast-modal.tsx` (if the viewing-only banner is needed).
- _Depends on:_ plan 60 shipped (same on-demand fetch machinery is already in place; this entry lifts the cross-book guard and decides foreign-book save routing).
- _Benefit (user):_ enables A/B for users who reuse the same TTS voice across books — e.g. comparing the same narrator across two books in a series to spot drift.

### 8. Linux visual baselines for CI

Source: net-new (2026-05-19). Spun off from the visual-baselines CI fix — `e2e/visual.spec.ts` now skips on platforms with no committed baselines so PR Verify can go green, but PR CI then carries zero visual-regression coverage. Until Linux baselines land, only local Windows runs catch chromium drift.

- _What:_ Commit `e2e/linux/visual.spec.ts/*.png` (12 PNGs matching the Win32 set). Two paths: (a) generate locally via Docker / WSL with `playwright test --update-snapshots visual.spec.ts`; (b) add a `workflow_dispatch` GitHub Action that runs `--update-snapshots` on an ubuntu-latest runner and opens a PR with the artefact, so future regen doesn't need a Linux box. The directory-level skip in `e2e/visual.spec.ts` re-enables the spec on Linux automatically the moment the directory exists.
- _Acceptance:_ Next PR's Verify run is green on all 12 visual specs (no skip messages). `docs/features/archive/37-e2e-playwright.md` "Per-platform skip" subsection loses the "Win32 only" caveat. Bonus: if the workflow_dispatch path is taken, document it under "Regenerate workflow".
- _Key files:_ `e2e/linux/visual.spec.ts/` (new directory); optional `.github/workflows/regen-visual-baselines.yml`; `docs/features/archive/37-e2e-playwright.md` "Visual baselines" section.
- _Benefit (technical):_ restores Verify as a real merge gate. Today PR CI's only red signal is "visual baselines missing" — once those land, a red Verify means real regression and reviewers stop ignoring it.

### 9. Auto-backup scheduling for `state.json`

Source: net-new (2026-05-18).

- _What:_ Add a background backup job that on configurable cadence (daily / weekly) writes a snapshot of `<workspace>/<bookId>/.audiobook/state.json` to `<workspace>/.backups/<bookId>/<YYYYMMDD-HHMMSS>.json`. Keep last N (configurable, default 14). Manual "Restore from backup" affordance in workspace settings.
- _Acceptance:_ Set daily backups → 14 daily snapshots accumulate in `.backups/`, oldest auto-pruned. Restore from snapshot → state.json reverted to that point; library view refreshes. New server Vitest spec covers the cron-like cadence + prune.
- _Key files:_ new `server/src/workspace/auto-backup.ts`; `server/src/workspace/scan.ts` (initial trigger on server start); new settings affordance under Could #13 power-user panel (or inline in `src/views/library.tsx` if shipped first).
- _Depends on:_ none.
- _Benefit (user):_ disaster recovery without manual intervention. Particularly valuable on Windows where OneDrive sync conflicts can occasionally corrupt `state.json` mid-write.

### 10. GPU-arbitration semaphore for parallel Claude Code sessions

Source: net-new (2026-05-19). Spun off from the parallel-sessions tooling — `scripts/wt-new.mjs` resolves port collisions but leaves GPU/VRAM contention as a manual-coordination concern documented in CONTRIBUTING.md.

- _What:_ Add a small server-side semaphore around heavy-GPU operations (analyzer's chat completion path + sidecar's `/synthesize`) so concurrent requests from N parallel sessions get serialized rather than fighting over VRAM on an 8 GB GPU. Default concurrency = 1 GPU operation at a time; configurable via `GPU_CONCURRENCY` env var. Surface the queue depth in the existing top-bar pill state so the user sees "Queued (1 ahead)".
- _Acceptance:_ Two parallel sessions both kick off `/analyse` → second request waits in queue until first completes (no VRAM spill, no silent OOM). The top-bar pill in the waiting session shows "Queued". New server Vitest spec covers the semaphore behaviour; existing tests stay green.
- _Key files:_ new `server/src/gpu/semaphore.ts`; `server/src/analyzer/ollama.ts` (wrap chat calls); `server/src/routes/sidecar-synth.ts` (wrap synth proxy); `src/components/layout.tsx` (consume queue-depth from existing pill polling).
- _Depends on:_ none. Pairs with the worktree parallel-sessions tooling — without the semaphore, users must queue heavy operations by hand per the CONTRIBUTING.md "GPU + shared-resource caveats" note.
- _Benefit (user):_ removes the silent VRAM-spillover-to-RAM slowdown when two sessions hit the analyzer or sidecar concurrently. Today a parallel run can take 5–10× longer than serial because both processes thrash the GPU.

### 11. Auto-reconcile helper for parallel-agent integration branches

Source: net-new (2026-05-19). Spun off from the parallel-sessions tooling — CONTRIBUTING.md "Reconciliation pattern" describes the `integration/<date>` ritual but executes it manually (one `git switch` + `git merge` + `npm run verify` per agent branch). The friction-iest part of the parallel-agent workflow today.

- _What:_ Add `scripts/wt-merge.mjs <branch> [<branch>...] [--into integration/<date>]` that drives the documented reconciliation pattern: cut a fresh integration branch off `main`, merge each agent branch in sequence, run `npm run verify` between merges, abort on first failure with a clear "this branch broke verify" message and instructions for dropping the offending branch. Idempotent — safe to re-run from a partially-merged integration branch.
- _Acceptance:_ Four parallel agent branches → `node scripts/wt-merge.mjs feat/a feat/b feat/c feat/d` → integration branch created, all four merged in order, verify passes between each. Fail one branch → script aborts on that branch's verify, prints the failing test summary + the suggested follow-up command. New Pester / Node test covers the dispatch order + abort behaviour.
- _Key files:_ new `scripts/wt-merge.mjs`; new `scripts/tests/wt-merge.test.mjs`; CONTRIBUTING.md "Reconciliation pattern" section (cross-link the helper).
- _Depends on:_ the parallel-sessions tooling already shipped (the worktrees are the input). The verify-cache plan 50 makes the between-merge verify fast enough that this becomes practical.
- _Benefit (user):_ collapses the 6-step manual reconciliation into one command. Today the friction of "merge, verify, merge, verify, ..." discourages users from running > 2 parallel agents.

### 12. Live worktree dashboard in the app

Source: net-new (2026-05-19). Spun off from the parallel-sessions tooling — `scripts/wt-list.mjs` answers "which worktrees are open?" from the terminal, but once the user routinely has 3+ sessions running, an in-app view is the natural escalation.

- _What:_ Add a `#/worktrees` view (and a top-bar entry point) that lists every worktree visible to `git worktree list --porcelain`, each one's branch + assigned ports + last-modified-file timestamp + a "Is the dev server alive?" probe (TCP connect against the worktree's `VITE_PORT`). Click a row → opens that worktree's dev URL in a new tab.
- _Acceptance:_ Three worktrees open with `npm run dev` running in two of them → the view shows all three rows; the two live ones show a green dot; clicking opens their UIs. Auto-refreshes every 10 s. New server endpoint `/api/worktrees` (only enabled in dev mode or behind a flag). Vitest covers the parsing; e2e covers the navigation.
- _Key files:_ new `src/views/worktrees.tsx`; new `server/src/routes/worktrees.ts` (dev-mode only); `src/components/layout.tsx` (top-bar link, dev-only gate).
- _Depends on:_ none structural. Pairs with Could #10 (GPU semaphore) — the dashboard is the natural place to surface "this worktree is the one currently holding the GPU."
- _Benefit (architectural):_ operational visibility once parallel-session workflow becomes routine. Today the user has to remember which terminal tab is on which port.

### 13. Keyboard shortcuts / power-user tuning panel

Source: net-new (2026-05-18).

- _What:_ Add a settings panel (under a gear icon in the top-bar) for power-user tuning: keyboard-shortcut overrides (e.g. spacebar = play/pause), runtime knobs (SSE chunk size, TTS concurrency cap, debounce values for autosave), accessibility toggles (high-contrast theme, larger text). Settings persist in localStorage and apply on next render.
- _Acceptance:_ Open settings, change autosave debounce from 500ms to 2000ms → next edit waits 2s before write. Override "play/pause" shortcut to "K" → keyboard "K" toggles mini-player. Vitest covers the persistence + shortcut binding.
- _Key files:_ new `src/views/settings.tsx`; new `src/lib/keybindings.ts`; new `src/store/settings-slice.ts`; `src/components/layout.tsx` (gear icon entry point).
- _Depends on:_ none.
- _Benefit (technical / accessibility):_ power-user tuning surfaces today's hardcoded values; keyboard navigation closes an accessibility gap.

### 14. Windows installer (Inno Setup or NSIS) wrapping the release zip

Source: net-new (2026-05-18). Deferred follow-up to Should #2 ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `audiobook-generator-vX.Y.Z.zip` produced by Should #2 into a signed `.exe` installer. Installer extracts to `%LocalAppData%\AudiobookGenerator`, drops a Start Menu entry, runs prerequisite checks (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, and offers to run `install-kokoro.ps1` post-install. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Acceptance:_ Double-clicking the installer on a clean Windows 11 box yields a runnable app reachable at `http://localhost:5173`, with no terminal interaction required from the deployer. SmartScreen warning cleared after one user "Run anyway" click (full reputation requires an EV code-signing cert — out of scope until the cert is procured).
- _Key files:_ new `installer/audiobook-generator.iss` (Inno Setup), new `installer/build-installer.ps1`, `.github/workflows/release.yml` (add `installer` job on `windows-latest` that runs after the zip job and uploads to the same release).
- _Depends on:_ Should #2 shipped (the installer wraps the existing zip — no point building before the zip pipeline exists).
- _Benefit (user):_ friction-free install for non-developers. Today's Should #2 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.

### 15. Docker image + compose file for headless / Linux deployment

Source: net-new (2026-05-18). Deferred follow-up to Should #2 ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/audiobook-generator:vX.Y.Z` on tag push.
- _Acceptance:_ `docker compose up` on a host with NVIDIA Container Toolkit installed brings up the three-service stack reachable on the documented ports. The published image works against a fresh `WORKSPACE_DIR` bind mount; tagged versions are pullable from GHCR.
- _Key files:_ new `Dockerfile`, new `docker-compose.yml`, new `docs/features/50-docker-image.md` (when this graduates from BACKLOG to active), `.github/workflows/release.yml` (extend with the GHCR push job).
- _Depends on:_ Should #2 shipped (reuses the same tag-push trigger and version source); resolving the workspace-mount question.
- _Benefit (user):_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case.

### 16. Apple Books (iOS / macOS) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Apple Books tile with the appropriate handoff: macOS supports drag-into-Books; iOS supports AirDrop or sync via Files. Modal shows the platform-specific flow (detect Mac vs other UA, default to "iOS via AirDrop"). Copy-and-instructions only — no direct integration with Apple Books library API (which is restricted).
- _Acceptance:_ Click tile → modal shows platform-detected instructions. Vitest covers the UA detection branching.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`.
- _Depends on:_ plan 18b shipped.
- _Benefit (user):_ closes one more "Coming soon" tile.

### 17. Plex (self-hosted media server) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Plex tile with two paths: (a) instructions for manual upload to a Plex server library, (b) optional direct upload via the Plex API if the user has provided a Plex token (settings field). Path (b) is the most-complex of the four — Plex auth + library scan trigger.
- _Acceptance:_ Click tile → modal shows manual upload steps. If a Plex token is configured, an "Upload directly" button hits the Plex API. Vitest covers both modes.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`; `src/views/settings.tsx` (Plex token field — see Could #13 power-user panel); new `server/src/export/plex.ts` for the optional upload path.
- _Depends on:_ plan 18b shipped; ideally Could #13 (power-user panel) for the token storage.
- _Benefit (user):_ closes one more "Coming soon" tile; opens the door to direct upload integration.

### 18. PocketBook Cloud direct upload OR `@pbsync.com` email gateway

Source: [`32-audiobook-export.md`](features/32-audiobook-export.md) follow-ups.

- _What:_ Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- _Acceptance:_ A working prototype for one of the two paths; new tile on the export modal; documented size limits + caveats.
- _Key files:_ new tile config in `src/data/listener-apps.ts`; `src/modals/export-audiobook.tsx`; `server/src/export/` for any new transport.
- _Benefit (user):_ true sideload-free path. Low priority because LAN download + sync folder already work.

### 19. Single-poll TTS lifecycle for a third consumer (tracking)

Source: [`30-global-model-control.md`](features/30-global-model-control.md) "When to extend the pattern".

- _What:_ Tracking item. The consolidated `useTtsLifecycle()` hook (`src/lib/use-tts-lifecycle.ts`) already drives both today's pill surfaces — top-bar (`src/components/layout.tsx`) and Generation view (`src/views/generation.tsx`) — from one `setInterval` via `LayoutContext`. **Wake this item when a JIT-warmed surface graduates to pill-driven UI.** Concrete triggers: Profile Drawer Play, Cast row Play, or the per-character "regenerate this voice across the book" button — whichever first stops using `playSampleWithAutoLoad` and starts wanting an always-on Load/Stop affordance.
- _Acceptance:_ The new surface reads `ttsLifecycle` from `useOutletContext<LayoutContext>()` (pattern from `generation.tsx`). No new `setInterval`, no new `/health` poll, no duplicated `evictionNotice` / `loadErrorNotice` state.
- _Key files:_ `src/lib/use-tts-lifecycle.ts` (no changes expected — already exported); `src/components/layout.tsx` (no changes — already exposes the context); the new surface's component file.
- _Depends on:_ an actual third surface materialising. Product-driven, not architecture-driven — the seam is ready, the trigger isn't.
- _Benefit (architectural):_ prevents the duplicated-poll explosion that motivated plan 30 G1 in the first place.

### Manuscript-diff guard for renamed chapters on re-upload

Source: net-new (2026-05-20). Spun off from plan 78 chapter-rename × plan 74 manuscript-diff interaction.

- _What:_ When a user re-uploads a manuscript via the listen-header "Replace manuscript" flow (plan 74), the existing `previewReuploadDiff` modal compares sentence content but does not flag chapters whose `titleOverridden=true` flag would attach to a different chapter id after the re-parse. If the new manuscript has a different chapter count (or a chapter is inserted / removed mid-book), the override flag stays attached by numeric id — so it lands on the wrong chapter. Add a per-chapter override-conflict row to the diff modal: enumerate every overridden chapter whose old position doesn't match the new manuscript's heading at that position; offer "keep override" / "drop override" per row, defaulting to drop on mismatch.
- _Acceptance:_ Book with three chapters; user renames chapter 2; user re-uploads a manuscript that splits chapter 1 into two (so the original chapter 2 is now at position 3). Diff modal shows a "Renamed chapter conflict" section listing the override + the new chapter at the override's old id, with per-row pick. Applying the upload either carries the override forward to the new id or drops it. New `manuscript-diff` Vitest spec covers both the detect-conflict and resolve-conflict paths.
- _Key files:_ `src/components/manuscript-diff.tsx` (modal UI); `src/store/manuscript-slice.ts` (`previewReuploadDiff` / `applyReupload`); maybe a new `src/lib/chapter-override-conflict.ts` helper; `server/src/routes/book-state.ts` (PUT state path that lands the resolved overrides).
- _Depends on:_ plan 74 shipped, plan 78 shipped.
- _Benefit (user):_ closes the long-tail edge case where a re-upload silently mis-attributes a user's manual rename. Today an override on chapter 2 of the old manuscript stays attached to "chapter id 2" of the new one, which may be entirely different content.

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
