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

**Counts as of 2026-05-18 (post plan 52 commit):** Must 0 · Should 2 · Could 33 · Won't 9

---

## Must — blocks v1 ship or hurts existing users

(empty — Must #1 verify-cache shipped in plan 50 on 2026-05-18.)

---

## Should — important, not blocking ship

### 1. Playback speed control in the mini-player

Source: net-new (2026-05-18). Promoted from Could to Should in Round 0 re-prioritisation — table-stakes audiobook listener feature, missing today.

- _What:_ Add a speed-selector affordance to the mini-player exposing 0.75x / 1.0x / 1.25x / 1.5x / 1.75x / 2.0x rates. Uses `HTMLMediaElement.playbackRate` (browser-native, no audio reprocessing). Selection persists per book in `listen-progress.json` so a chosen rate carries across sessions.
- _Acceptance:_ Play chapter, click 1.5x → playback speeds up immediately, pitch unchanged. Refresh → still at 1.5x. Vitest covers the slice extension; e2e covers the speed-change + persistence flow.
- _Key files:_ `src/components/mini-player.tsx` (speed picker UI); `src/store/listen-progress-slice.ts` (extend with `playbackRate`); `server/src/routes/listen-progress.ts` (payload extension); new `e2e/playback-speed.spec.ts`.
- _Depends on:_ plan 47 (listen progress) shipped — relies on the same persistence seam.
- _Benefit (user):_ standard audiobook player feature; users expect 0.75x–2x as basic controls. Today only 1x is available, forcing browser zoom-and-pinch or per-chapter regeneration workarounds.

### 2. Extend verify-cache to `verify:fast` (pre-commit gate)

Source: net-new (2026-05-18). Follow-up to plan 50 (Verify-cache for cheap retries after flake).

- _What:_ Reuse the runner in `scripts/verify-cache.mjs` for `scripts.verify:fast` (the pre-commit gate, today `test:hooks && test && test:server`). Parameterise the runner so it accepts a `--steps lint,typecheck,test:hooks,test,test:server` style flag, then change `scripts.verify` to `node scripts/verify-cache.mjs` (no flag = all steps) and `scripts.verify:fast` to `node scripts/verify-cache.mjs --steps test:hooks,test,test:server`. Cache file is shared — a `test:server` cache entry written by `verify:fast` skips correctly in a subsequent `verify` and vice-versa.
- _Acceptance:_ pre-commit on a small follow-up commit (no source changes) prints `[cached]` for all three fast steps and exits in under 1 s; same when the prior `npm run verify` already populated the cache. Existing pre-commit semantics (refuse commit on first failure) preserved. Vitest spec covers the `--steps` filter parsing.
- _Key files:_ `scripts/verify-cache.mjs` (extend `parseFlags` + `runPipeline` to filter `STEPS` by a `--steps` list); `package.json` `scripts.verify:fast`; `scripts/tests/verify-cache.test.mjs` (add filter-parsing case).
- _Depends on:_ plan 50 shipped.
- _Benefit (user / developer):_ pre-commit is the most-frequently-run gate in the day. Even though it's sub-5s warm today, caching brings it under 1 s for the no-source-change case (e.g. doc-only commits, regenerated lockfile-only commits), making the gate effectively free for those.

---

## Could — nice to have, low-cost wins

Ordered in clusters: audio quality → listening UX → library/workflow → cast/revisions → voice library → coverage & ops → streaming/sync → distribution → tracking → deferred listener-app handoffs.

### 1. Audio loudness normalization (ffmpeg `loudnorm`)

Source: net-new (2026-05-17). Validated absent in `server/src/tts/mp3.ts` (raw PCM → LAME VBR, no loudness filter).

- _What:_ Add an optional `loudnorm` pass to the chapter encode pipeline. Two-pass mode (analyse → apply) gates on a config knob (`AUDIO_LOUDNORM=off|single|two-pass`, default `single`). Targets EBU R128 `-16 LUFS`, `-1.5 dBTP`, `LRA 11`.
- _Acceptance:_ New server Vitest spec asserts the ffmpeg invocation includes the loudnorm filter when enabled; manual: compare two chapters generated with different voices, both land within ±1 LU of target. Skip when `AUDIO_LOUDNORM=off`.
- _Key files:_ `server/src/tts/mp3.ts`; `server/.env.example` (new knob); `docs/features/28-chapter-audio-format.md` (extend with a "Loudness" section).
- _Depends on:_ none. Encode latency cost is ~20-40% for single-pass loudnorm; document the trade-off.
- _Benefit (user):_ per-voice volume drift across chapters today forces the listener to ride the volume knob. Loudnorm makes the book sit at one level.

### 2. AAC/M4A or Opus output (swappable encoder)

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- _What:_ Generalise `encodePcmToMp3` to accept an encoder choice (`mp3 | m4a | opus`) and add a sidecar/server config knob that selects per-book output format.
- _Acceptance:_ The boundary in `server/src/tts/mp3.ts` (or wherever `encodePcmToMp3` lives) is renamed `encodePcmToAudio` and dispatches on format; existing tests still pass; a new test covers m4a output.
- _Key files:_ `server/src/tts/mp3.ts`; `docs/features/28-chapter-audio-format.md`.
- _Depends on:_ none, but cluster after Could #1 (loudnorm) so the encoder boundary is generalised AFTER the loudnorm wiring lands — otherwise we re-touch the dispatch twice.
- _Benefit (user):_ smaller files / better quality for users who prefer either; small cost because the encoder seam already exists.

### 3. Per-chapter loudness report / visualization

Source: net-new (2026-05-18). Pairs with Could #1 (loudnorm).

- _What:_ Add a "Loudness report" card to the listen view showing per-chapter integrated loudness (LUFS), peak (dBTP), and LRA, computed at chapter-encode time and persisted alongside the audio. Chapters drifting more than ±2 LU from target highlight red. Click a chapter row → opens that chapter in the listen view with the loudness numbers shown.
- _Acceptance:_ After loudnorm-enabled chapter encode, each chapter row in the loudness report card shows LUFS / dBTP / LRA. Forced low-loudness mock chapter shows up red. New server Vitest spec covers loudness extraction from `ffmpeg -af ebur128`. Frontend Vitest covers the card rendering + click-through.
- _Key files:_ new `src/components/loudness-report.tsx`; `src/views/listen.tsx` (mount); `server/src/tts/mp3.ts` (emit loudness metadata to chapter meta); `server/src/routes/chapter-audio.ts` (surface in meta endpoint).
- _Depends on:_ Could #1 (loudnorm) — without normalization there's no expected target to compare against.
- _Benefit (user):_ catch problem chapters before export (e.g. a voice that came out 4 LU softer than the rest). Pairs with Could #1 to make loudness drift visible, not just corrected.

### 4. User-placed markers / bookmarks in the listen view

Source: net-new (2026-05-18). Builds on plan 47's `listen-progress.json` persistence seam.

- _What:_ Extend `listen-progress.json` to carry a `markers: Array<{ id, chapterId, sec, label, kind: 'note' | 'rerecord', createdAt }>` list per book. Listen-view mini-player exposes "Add bookmark here" affordance (keyboard shortcut + button) that captures the current `chapterId + currentSec`. Sidebar lists all markers per chapter, click → seek to that position. Each marker has a short editable label and a kind toggle (general note vs flag for re-record).
- _Acceptance:_ Drop a marker at 1:23 in chapter 3 with label "re-record this", reload page, marker persists and click-to-seek returns to 1:23 ±1s. Vitest covers the slice (add/edit/delete marker, payload roundtrip). Server Vitest covers the marker payload extension. New e2e spec covers add-marker + reload + seek.
- _Key files:_ `src/store/listen-progress-slice.ts` (extend reducers); `src/views/listen.tsx` (sidebar + add-button); `src/components/mini-player.tsx` (shortcut); `server/src/routes/listen-progress.ts` (payload extension); new `e2e/listen-bookmarks.spec.ts`.
- _Depends on:_ plan 47 shipped (already shipped 2026-05-17).
- _Benefit (user):_ today re-record candidates have nowhere to live — the user must remember a timestamp manually. Markers give a per-book scratchpad of "fix this later" annotations without leaving the listen view.

### 5. Sleep timer + auto-stop on chapter boundary

Source: net-new (2026-05-18). Validated absent in `src/components/mini-player.tsx`.

- _What:_ Add a sleep-timer affordance to the mini-player: countdown picker (15 / 30 / 45 / 60 min, plus "End of chapter" option). When the timer expires, the player pauses and saves the listen-progress position. The "End of chapter" mode pauses at the next chapter boundary regardless of elapsed time. Picker UI is a dropdown menu off a clock icon in the mini-player.
- _Acceptance:_ Set 5-minute timer, leave playing, after 5 min mini-player auto-pauses and listen-progress is saved. Set "End of chapter" while at 2:00/15:00 → auto-pauses at 15:00 (chapter end). Vitest covers the timer state machine; e2e spec covers the "end of chapter" boundary case.
- _Key files:_ `src/components/mini-player.tsx`; new `src/lib/sleep-timer.ts` (state machine); `src/store/listen-progress-slice.ts` (no changes — relies on existing save).
- _Depends on:_ plan 47 shipped (relies on the same save seam).
- _Benefit (user):_ standard audiobook listener pattern — most listeners fall asleep mid-chapter and want playback to stop at a natural boundary. Parity with standalone audiobook apps.

### 6. Share a 30-second chapter clip as MP3

Source: net-new (2026-05-18).

- _What:_ Add a "Share clip" button next to the play affordance in the listen view. Clicking opens a small modal with a draggable time range (default ±15 s around the current playhead, max 60 s); on confirm, the server slices the chapter MP3 to the requested range and offers the slice as a download. No re-encode — uses `ffmpeg -ss <start> -t <duration> -c copy`.
- _Acceptance:_ Play chapter 2, click Share clip, set range 1:20-1:50, confirm → downloaded file plays the requested 30 s. New server Vitest spec covers the slicing route. Frontend Vitest covers the modal interactions.
- _Key files:_ new `src/modals/share-clip.tsx`; `src/views/listen.tsx` (entry point); new `server/src/routes/clip.ts`; `openapi.yaml` (new `/api/books/:bookId/chapters/:chapterId/clip` route).
- _Depends on:_ none.
- _Benefit (user):_ viral loop for shared-book workflows — easy to send a friend "listen to this part." Today the only sharing path is the whole chapter MP3.

### 7. Library search + tag / category filter

Source: net-new (2026-05-18).

- _What:_ Add a search bar to the library view that filters books by title / author substring (case-insensitive). Add a tag system: each book carries a `tags: string[]` on its `BookStateJson`; chips in the library view filter by tag. Tag-edit affordance lives in the book-meta modal.
- _Acceptance:_ Library with 10 books → typing 3 characters of a title filters to matching books. Add tag "priority" to two books, click chip → only those two remain. Tags persist on disk via the existing state-write path. Vitest covers the filter logic + tag-edit reducer; e2e covers the search-then-filter user flow.
- _Key files:_ `src/views/library.tsx` (search bar + chip row); `src/modals/edit-book-meta.tsx` (tag editor); `openapi.yaml` (BookStateJson `tags` field); `server/src/workspace/scan.ts` (read/write `tags`).
- _Depends on:_ none.
- _Benefit (user):_ library browsing becomes tenable at 10+ titles; tagging cross-cuts the alphabetical tree (priority / series / genre).

### 8. Manuscript diff viewer on re-upload

Source: net-new (2026-05-18).

- _What:_ When a user re-uploads a revised manuscript for an existing book, show a side-by-side diff of the previous manuscript text vs the new one (sentence-level granularity, character-level highlighting within changed sentences). Surface changed sentences mapped to existing cast attribution, so the user knows which characters' lines changed.
- _Acceptance:_ Re-upload a manuscript with 5 sentence changes → diff view shows those 5 sentences side-by-side; "View affected characters" expands per-sentence into the cast list. Vitest covers the diff algorithm; e2e covers the upload-then-diff flow.
- _Key files:_ new `src/components/manuscript-diff.tsx`; new `src/lib/manuscript-diff.ts` (diff algorithm — leverage `diff` npm package); `src/views/upload.tsx`; new server endpoint for diff-friendly fetch of the previous manuscript.
- _Depends on:_ none.
- _Benefit (user):_ re-uploading a manuscript today shows no indication of what changed — the user must manually re-read or trust external version control. Diff view closes that gap.

### 10. Portable book export with embedded state

Source: net-new (2026-05-18).

- _What:_ Add an "Export book as portable archive" affordance: zip up `<bookDir>/.audiobook/state.json` + `manuscript.txt` + all audio + cover into a single `<bookId>.zip`. Importing that zip into another workspace drops it into `<workspace>/<bookId>/` and the library view picks it up after a refresh.
- _Acceptance:_ Export book → produces `bonus-keefe-story.zip` containing all needed state. Drop zip into a second workspace's `import/` folder → first run picks it up, restores book to library with full cast + audio + listen progress intact. Vitest covers the manifest; e2e covers the export-then-import flow.
- _Key files:_ new `server/src/export/build-portable-book.ts`; new `server/src/import/scan-import-folder.ts`; `src/views/listen.tsx` (export button).
- _Depends on:_ none.
- _Benefit (user):_ hand-off between machines without re-casting; backup-and-restore semantics for individual books.

### 11. Per-book editorial notes / README field

Source: net-new (2026-05-18).

- _What:_ Add a `notes: string` field to `BookStateJson` (markdown, no formatting toolbar — plain textarea) for editorial notes: source attribution, license, narration intent, in-progress thoughts. Displayed in a collapsible "Notes" card on the ready/listen view.
- _Acceptance:_ Edit notes → save → notes persist on disk; reload → notes show in the listen view. Markdown line breaks render. Vitest covers the field roundtrip.
- _Key files:_ `openapi.yaml` (BookStateJson `notes`); `server/src/workspace/scan.ts` (read/write); `src/views/listen.tsx` (display + edit affordance); `src/modals/edit-book-meta.tsx` (edit form field).
- _Depends on:_ none. Pairs with Could #15 (long-form `desc`/`ldes`) — both add a long-form text field, but `notes` is workspace-internal (never exported), `description` lands in the M4B atom.
- _Benefit (user):_ workspace becomes a place for editorial context, not just audio + state. Lightweight scratchpad for "things to remember about this book."

### 12. Revision history timeline (visual rollback)

Source: net-new (2026-05-18). Builds on plan 20's `acceptedSelections` persistence.

- _What:_ Add a "Revision history" view per chapter showing a chronological timeline of every regeneration / sentence-level edit / accept-revision event, with one-click rollback to any prior version. Each timeline entry carries the diff against the prior state (what changed) and the audio fingerprint (which voice/segment manifest produced it).
- _Acceptance:_ Generate chapter, regenerate two sentences, accept revision, regenerate again → timeline shows 4 entries. Click rollback on entry 2 → chapter audio + state revert to that point; subsequent entries marked "rolled back from this point." Vitest covers the timeline state; server Vitest covers the rollback transaction.
- _Key files:_ new `src/components/revision-timeline.tsx`; `src/store/revisions-slice.ts` (extend with timeline accessor); `server/src/routes/revisions.ts` (add /history endpoint); `server/src/audio/revisions-store.ts` (timeline persistence).
- _Depends on:_ plan 20 (revisions-and-drift close-out) shipped — needs the `acceptedSelections` consumer wired so timeline entries are meaningful.
- _Benefit (user):_ today rollback is binary (revert to previous via the a/b player). Timeline gives true non-linear undo per chapter; user can experiment with multiple takes without losing history.

### 13. Preview voice sample while editing the character

Source: net-new (2026-05-18). Leverages existing `useTtsLifecycle`.

- _What:_ In the profile drawer / cast-edit modal, expose a per-voice "Play sample" affordance that synthesises a short user-editable preview line (e.g. "The quick brown fox...") with the candidate voice without committing the assignment. Multiple candidates can be auditioned without closing the drawer.
- _Acceptance:_ Open profile drawer, hover voice candidate row, click "Play sample" → preview audio renders in under 3 s (uses TTS sidecar lifecycle). Switch to another candidate, click → second preview replaces the first. No assignment is committed until Save. Vitest covers the preview-state slice; e2e covers the drawer-preview flow.
- _Key files:_ `src/modals/profile-drawer.tsx` (add preview button + sample text input); `src/lib/use-tts-lifecycle.ts` (no changes — already exposed); new `src/components/voice-preview-button.tsx`.
- _Depends on:_ none structural. Pairs with Could #28 (third-consumer lifecycle tracking) if/when that activates.
- _Benefit (user):_ faster voice-picking feedback loop. Today the user assigns a voice, regenerates a sample, judges, optionally re-assigns — preview cuts that cycle from minutes to seconds.

### 14. Batch voice-replace across all books

Source: net-new (2026-05-18).

- _What:_ Add a "Replace voice everywhere" affordance in the voice library: pick a current voice, pick a replacement, see a preview of all (book, character) pairs that would be affected, confirm. Affected books' cast slices are mutated; audio is invalidated (regen prompt per book).
- _Acceptance:_ Three books each use voice `am_michael` for one character → batch replace `am_michael` → `am_eric` shows 3 affected pairs, confirm rewrites all three cast.json files, audio marked stale. Vitest covers the dry-run preview + write logic; e2e covers the modal flow.
- _Key files:_ new `src/modals/batch-voice-replace.tsx`; `src/views/voices.tsx` (entry point); `server/src/routes/voices.ts` (cross-book write endpoint); new `server/src/audio/invalidate.ts` (multi-book audio invalidation).
- _Depends on:_ none.
- _Benefit (user):_ cross-book voice consistency without per-book re-casting. Common need when switching a recurring narrator across a series.

### 16. Voice compare from the global `#/voices` tab for same-book pairs

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- _What:_ When both selected voices in the global `#/voices` tab share a `bookId` (≠ `currentBookId`), fetch that book's cast on demand via `api.getBookState(bookId)` and pass the resolved characters into `CompareCastModal`. Cache the fetched cast for the modal session so re-opens are instant.
- _Acceptance:_ The Compare button enables in the global tab for a same-`bookId` 2-voice pair; the modal opens with the correct two characters. Vitest covers the on-demand fetch path + the disabled state when the fetch fails. The e2e `voices-compare.spec.ts` gains a global-tab same-book pair assertion.
- _Key files:_ `src/views/voices.tsx` (gating logic + on-demand fetch); `src/lib/api.ts` (`getBookState`); `e2e/voices-compare.spec.ts`.
- _Depends on:_ none structural.
- _Benefit (user):_ closes the gap in the Voice library global view — today the global tab's Compare is fully disabled, even for pairs that would resolve cleanly with one fetch.

### 17. Cross-book voice compare

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- _What:_ Lift the cross-book guard. When the two selected voices belong to different `bookId`s, fetch each book's cast (one of them may be the open book — short-circuit) and pass both characters into `CompareCastModal`. Decide and document: do we route saves back to each character's source book's cast slice, or refuse the save and surface a "viewing only" banner?
- _Acceptance:_ The Compare button enables for cross-book pairs; the modal opens with both characters; the Save behaviour is documented and tested. The e2e gains a cross-book pair assertion.
- _Key files:_ `src/views/voices.tsx`; `src/store/cast-slice.ts` (Save routing); `src/modals/compare-cast-modal.tsx` (if the viewing-only banner is needed).
- _Depends on:_ Could #16 (the same on-demand fetch machinery).
- _Benefit (user):_ enables A/B for users who reuse the same TTS voice across books — e.g. comparing the same narrator across two books in a series to spot drift.

### 18. CI integration for the test suite

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups.

- _What:_ Add a GitHub Actions (or equivalent) workflow that runs `npm run verify` on every PR. Cache `node_modules` and the Playwright browser. Budget for e2e being the slowest job (~60 s cold).
- _Acceptance:_ PRs that break tests are blocked from merge. Workflow runs in under 10 min cold, under 5 min warm.
- _Key files:_ new `.github/workflows/verify.yml`.
- _Benefit (technical):_ eliminates the "works on my machine" gap. Pairs with the visual baselines shipped 2026-05-17 (`e2e/visual.spec.ts`) — without CI, the baselines are a tree-falling-in-a-forest.

### 20. Un-quarantine the two e2e flakes (`listen-playback`, `new-book-flow`) by fixing parallel-worker contention

Source: plan 46 ship (2026-05-18). Two specs `test.fixme`'d when plan 46 landed.

- _What:_ Both specs pass in isolation but fail consistently when Playwright runs workers in parallel on Windows under load. Root cause is unproven — candidates: (a) the mock MP3 fetch + decode racing two workers on the same Vite dev server, (b) SSE phase transitions firing faster than the mock-canned-data tick under contention, (c) a `setTimeout`/`requestAnimationFrame` interaction with the headless tab being throttled. Investigate via Playwright trace (`test-results/*/trace.zip`), narrow to one of (a)/(b)/(c), then either bump the per-test timeout, add a focused `waitFor` predicate, or carve out a `serial` workers config for these two specs.
- _Acceptance:_ Drop the `.fixme` markers on both specs. `npm run verify` lands green at least 5 times in a row on a Windows host with default parallel workers. Add a regression test that pins the fix (e.g. a deterministic mock-tick or a docs note in `playwright.config.ts:25-26` explaining why the affected specs need `test.describe.serial`).
- _Key files:_ `e2e/listen-playback.spec.ts:15`, `e2e/new-book-flow.spec.ts:32`, `playwright.config.ts:14-26`, `e2e/helpers.ts`, `src/mocks/canned-data.ts` (if mock-tick determinism turns out to be the fix).
- _Depends on:_ none.
- _Benefit (technical):_ restores the two e2e specs that cover the highest-blast-radius surfaces (mini-player play + full new-book cold-boot walk). Until then both code paths only have Vitest+jsdom coverage, which is known to lie about audio playback and SSE timing.

### 21. Windows installer (Inno Setup or NSIS) wrapping the release zip

Source: net-new (2026-05-18). Deferred follow-up to Should #2 ([`49-release-package.md`](features/49-release-package.md)).

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `audiobook-generator-vX.Y.Z.zip` produced by Should #2 into a signed `.exe` installer. Installer extracts to `%LocalAppData%\AudiobookGenerator`, drops a Start Menu entry, runs prerequisite checks (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, and offers to run `install-kokoro.ps1` post-install. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Acceptance:_ Double-clicking the installer on a clean Windows 11 box yields a runnable app reachable at `http://localhost:5173`, with no terminal interaction required from the deployer. SmartScreen warning cleared after one user "Run anyway" click (full reputation requires an EV code-signing cert — out of scope until the cert is procured).
- _Key files:_ new `installer/audiobook-generator.iss` (Inno Setup), new `installer/build-installer.ps1`, `.github/workflows/release.yml` (add `installer` job on `windows-latest` that runs after the zip job and uploads to the same release).
- _Depends on:_ Should #2 shipped (the installer wraps the existing zip — no point building before the zip pipeline exists).
- _Benefit (user):_ friction-free install for non-developers. Today's Should #2 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.

### 22. Docker image + compose file for headless / Linux deployment

Source: net-new (2026-05-18). Deferred follow-up to Should #2 ([`49-release-package.md`](features/49-release-package.md)).

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/audiobook-generator:vX.Y.Z` on tag push.
- _Acceptance:_ `docker compose up` on a host with NVIDIA Container Toolkit installed brings up the three-service stack reachable on the documented ports. The published image works against a fresh `WORKSPACE_DIR` bind mount; tagged versions are pullable from GHCR.
- _Key files:_ new `Dockerfile`, new `docker-compose.yml`, new `docs/features/50-docker-image.md` (when this graduates from BACKLOG to active), `.github/workflows/release.yml` (extend with the GHCR push job).
- _Depends on:_ Should #2 shipped (reuses the same tag-push trigger and version source); resolving the workspace-mount question.
- _Benefit (user):_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case.

### 23. Auto-backup scheduling for `state.json`

Source: net-new (2026-05-18).

- _What:_ Add a background backup job that on configurable cadence (daily / weekly) writes a snapshot of `<workspace>/<bookId>/.audiobook/state.json` to `<workspace>/.backups/<bookId>/<YYYYMMDD-HHMMSS>.json`. Keep last N (configurable, default 14). Manual "Restore from backup" affordance in workspace settings.
- _Acceptance:_ Set daily backups → 14 daily snapshots accumulate in `.backups/`, oldest auto-pruned. Restore from snapshot → state.json reverted to that point; library view refreshes. New server Vitest spec covers the cron-like cadence + prune.
- _Key files:_ new `server/src/workspace/auto-backup.ts`; `server/src/workspace/scan.ts` (initial trigger on server start); new settings affordance under Could #24 power-user panel (or inline in `src/views/library.tsx` if shipped first).
- _Depends on:_ none.
- _Benefit (user):_ disaster recovery without manual intervention. Particularly valuable on Windows where OneDrive sync conflicts can occasionally corrupt `state.json` mid-write.

### 24. Keyboard shortcuts / power-user tuning panel

Source: net-new (2026-05-18).

- _What:_ Add a settings panel (under a gear icon in the top-bar) for power-user tuning: keyboard-shortcut overrides (e.g. spacebar = play/pause), runtime knobs (SSE chunk size, TTS concurrency cap, debounce values for autosave), accessibility toggles (high-contrast theme, larger text). Settings persist in localStorage and apply on next render.
- _Acceptance:_ Open settings, change autosave debounce from 500ms to 2000ms → next edit waits 2s before write. Override "play/pause" shortcut to "K" → keyboard "K" toggles mini-player. Vitest covers the persistence + shortcut binding.
- _Key files:_ new `src/views/settings.tsx`; new `src/lib/keybindings.ts`; new `src/store/settings-slice.ts`; `src/components/layout.tsx` (gear icon entry point).
- _Depends on:_ none.
- _Benefit (technical / accessibility):_ power-user tuning surfaces today's hardcoded values; keyboard navigation closes an accessibility gap.

### 25. Streaming audio for live playback during chapter generation

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Acceptance:_ Generating a chapter shows audio progress under the play cursor before the chapter completes. Existing per-chapter file is still written atomically at the end.
- _Key files:_ `server/src/tts/synthesise-chapter.ts`; `server/src/tts/mp3.ts`; `src/components/mini-player.tsx` for the MediaSource consumer.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on.

### 26. Cross-tab `BroadcastChannel` state sync

Source: net-new (2026-05-17). Validated absent in frontend.

- _What:_ Open `new BroadcastChannel('audiobook-state')` in store init; broadcast post-mutation snapshots of the analysis + generation slices keyed by `bookId`. Listening tabs hydrate without a network round-trip.
- _Acceptance:_ Open the same book in two tabs, start an analysis in tab A → tab B's top-bar pill updates without a refresh. New Vitest spec under jsdom mocks `BroadcastChannel` and asserts inbound messages drive the right reducer.
- _Key files:_ `src/store/index.ts`; new `src/store/broadcast-middleware.ts`; `src/store/analysis-slice.ts`; `src/store/chapters-slice.ts`.
- _Depends on:_ none structural. Note the tension with Won't #3 (multi-tab catch-up race resilience parked) — this entry covers the cooperative cross-tab case, not the racing-writes case.
- _Benefit (technical):_ eliminates the cold-boot endpoint round-trip (the `/api/library/active-analyses` lookup, shipped 2026-05-17) when a sibling tab already has the state. Single-user-per-workspace assumption still holds.

### 27. PocketBook Cloud direct upload OR `@pbsync.com` email gateway

Source: [`32-audiobook-export.md`](features/32-audiobook-export.md) follow-ups.

- _What:_ Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- _Acceptance:_ A working prototype for one of the two paths; new tile on the export modal; documented size limits + caveats.
- _Key files:_ new tile config in `src/data/listener-apps.ts`; `src/modals/export-audiobook.tsx`; `server/src/export/` for any new transport.
- _Benefit (user):_ true sideload-free path. Low priority because LAN download + sync folder already work.

### 28. Single-poll TTS lifecycle for a third consumer (tracking)

Source: [`30-global-model-control.md`](features/30-global-model-control.md) "When to extend the pattern".

- _What:_ Tracking item. The consolidated `useTtsLifecycle()` hook (`src/lib/use-tts-lifecycle.ts`) already drives both today's pill surfaces — top-bar (`src/components/layout.tsx`) and Generation view (`src/views/generation.tsx`) — from one `setInterval` via `LayoutContext`. **Wake this item when a JIT-warmed surface graduates to pill-driven UI.** Concrete triggers: Profile Drawer Play, Cast row Play, or the per-character "regenerate this voice across the book" button — whichever first stops using `playSampleWithAutoLoad` and starts wanting an always-on Load/Stop affordance.
- _Acceptance:_ The new surface reads `ttsLifecycle` from `useOutletContext<LayoutContext>()` (pattern from `generation.tsx`). No new `setInterval`, no new `/health` poll, no duplicated `evictionNotice` / `loadErrorNotice` state.
- _Key files:_ `src/lib/use-tts-lifecycle.ts` (no changes expected — already exported); `src/components/layout.tsx` (no changes — already exposes the context); the new surface's component file.
- _Depends on:_ an actual third surface materialising. Product-driven, not architecture-driven — the seam is ready, the trigger isn't.
- _Benefit (architectural):_ prevents the duplicated-poll explosion that motivated plan 30 G1 in the first place.

### 31. Apple Books (iOS / macOS) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Apple Books tile with the appropriate handoff: macOS supports drag-into-Books; iOS supports AirDrop or sync via Files. Modal shows the platform-specific flow (detect Mac vs other UA, default to "iOS via AirDrop"). Copy-and-instructions only — no direct integration with Apple Books library API (which is restricted).
- _Acceptance:_ Click tile → modal shows platform-detected instructions. Vitest covers the UA detection branching.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`.
- _Depends on:_ plan 18b shipped.
- _Benefit (user):_ closes one more "Coming soon" tile.

### 32. Plex (self-hosted media server) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Plex tile with two paths: (a) instructions for manual upload to a Plex server library, (b) optional direct upload via the Plex API if the user has provided a Plex token (settings field). Path (b) is the most-complex of the four — Plex auth + library scan trigger.
- _Acceptance:_ Click tile → modal shows manual upload steps. If a Plex token is configured, an "Upload directly" button hits the Plex API. Vitest covers both modes.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`; `src/views/settings.tsx` (Plex token field — see Could #24 power-user panel); new `server/src/export/plex.ts` for the optional upload path.
- _Depends on:_ plan 18b shipped; ideally Could #24 (power-user panel) for the token storage.
- _Benefit (user):_ closes one more "Coming soon" tile; opens the door to direct upload integration.

### 33. Listen-view download tiles wiring (m4b chaptered / MP3 zip / streaming link)

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18a (Listen view wiring) — scope-cut because the download paths need new server endpoints (MP3 zip bundling + streaming-link minting), which is more than a single PR.

- _What:_ Replace the three "Coming soon" download tiles on the Listen view with live affordances. M4B chaptered already has a working pipeline (plan 33 voice export) — wire that tile to open the existing `ExportAudiobookModal` pre-filled to `format: 'm4b'`. MP3 ZIP needs a new `server/src/export/build-mp3-zip.ts` that walks the chapter MP3s and bundles them via Node's `node:stream` + a streaming zip writer. Streaming link needs a server-minted shareable URL (likely a slugged route under `/share/:slug` that proxies the M4B from disk).
- _Acceptance:_ Each tile's Download button enabled; clicking M4B chaptered opens the export modal in M4B mode; MP3 ZIP triggers a `POST /api/books/:bookId/export` with `format: 'mp3-zip'` and the job appears in the rail; streaming link mints a URL the user can copy + share. Server Vitest covers the MP3-zip builder; new Playwright spec covers the three-tile flow.
- _Key files:_ `src/views/listen.tsx` (DownloadCard wiring); new `server/src/export/build-mp3-zip.ts`; `server/src/routes/exports.ts` (extend to handle mp3-zip + streaming-link formats); `openapi.yaml` (extend `BookExportJob.format` enum if streaming-link is added).
- _Depends on:_ none structural. Tile wiring is straightforward; the MP3-zip builder is the meatiest piece.
- _Benefit (user):_ closes the second-largest "Coming soon" surface on the Listen view. Today the user can only export via the listener-app tiles (which gate on a target app); these download tiles offer direct artifact retrieval.

### 34. Export queue Retry + Download row actions

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18a — needs middleware integration to re-fire a failed export, which is bigger than a row-handler wiring.

- _What:_ The Listen view's Export queue surfaces Retry (on `failed` rows) and Download (on `done` rows without a URL) as wired buttons. Retry re-fires the original `POST /api/books/:bookId/export` with the same payload via a middleware action that reads the job's recorded `format`/`destination`/`syncPath`. Download triggers a `GET /api/exports/:exportId/download` redirect (or a `window.location.assign(item.url)` when the job already carries `downloadUrl`).
- _Acceptance:_ Click Retry on a failed row → a new export job appears with the same parameters and the failed row is dismissed. Click Download on a done-with-URL row → file downloads. Vitest covers the middleware re-fire path; e2e covers the visible buttons.
- _Key files:_ `src/views/listen.tsx` (ExportQueue handlers); `src/store/exports-middleware.ts` (extend with `retryExport` thunk); `server/src/routes/exports.ts` (add `/exports/:exportId/download` redirect if needed).
- _Depends on:_ Could #33 (download tiles) for the underlying export endpoints to be live.
- _Benefit (user):_ closes the remaining "Coming soon" stubs in the queue rail. Today copy + remove work (shipped in plan 18a); retry + download are the other two row actions promised by the design.

### 35. Listen-view waveform card driven by real chapter peaks

Source: plan 18 known gap (2026-05-18). The chapter-audio meta endpoint currently returns `peaks: []`; the Listen view's waveform card derives its bars from a mock `peaks: float[240]` array that doesn't reflect the actual chapter audio.

- _What:_ Extend the chapter encode pipeline (`server/src/tts/synthesise-chapter.ts` or the MP3 step) to compute a fixed-length (240-bin) RMS-peaks summary alongside the MP3 and persist it under `<bookDir>/audio/<slug>.peaks.json`. The chapter-audio meta endpoint (`server/src/routes/chapter-audio.ts`) reads + returns it. Listen view consumes it via the existing `peaks` field — no frontend changes beyond removing the `peaks: []` fallback path.
- _Acceptance:_ Generate a chapter from scratch → `<slug>.peaks.json` exists on disk with 240 floats. Open Listen view → the waveform card paints those peaks (not mock). Server Vitest covers the peak-compute + read paths.
- _Key files:_ `server/src/tts/mp3.ts` (extend to emit peaks during encode); `server/src/routes/chapter-audio.ts` (read + return peaks); new `server/src/audio/compute-peaks.ts` (240-bin RMS reducer).
- _Depends on:_ none structural. Pairs naturally with Could #3 (per-chapter loudness report) — both emit chapter-level audio metadata at encode time.
- _Benefit (user):_ the Listen view's waveform card stops lying about chapter shape (loud passages, silences, fades all become visible). Spotting problem chapters at a glance.

### 36. Per-segment regen consumer for `revisions.acceptedSelections`

Source: plan 20 close-out (2026-05-18). The `revisions.acceptedSelections` map is persisted by `revisionsActions.acceptRevision` but no in-app code reads it back — per-segment splicing of accepted takes was explicitly "Out of scope" for plan 20 v1, and remains so in the v1 close-out.

- _What:_ Add a per-segment regen path that consumes `acceptedSelections[revisionId]` to re-render only the segments the user flipped to 'B' (the new take) while preserving 'A' (the original) segments verbatim. This requires (a) a server endpoint that accepts `{ revisionId, segmentSelections }` and dispatches per-segment synth, (b) a segments-manifest merge step that interleaves the two takes on disk, (c) a frontend trigger from the revision-diff player's "Commit selection" action.
- _Acceptance:_ Open a pending revision, toggle segments 3 + 7 to 'B' (others 'A'), click "Commit selection" → the chapter MP3 is rewritten with segments 3 + 7 re-rendered from the new take, all other segments byte-identical to the preserved (A) take. Server Vitest covers the manifest merge + per-segment synth; frontend Vitest covers the action dispatch shape; e2e covers the audition-then-commit flow.
- _Key files:_ new `server/src/routes/revisions-commit-segments.ts`; `server/src/tts/synthesise-chapter.ts` (extend for per-segment paths); `src/views/revision-diff.tsx` (dispatch through the new endpoint); `src/store/revisions-slice.ts` (mark the revision as committed once the segment-level synth completes).
- _Depends on:_ plan 20 shipped (acceptedSelections persistence is already on disk). Pairs with Could #12 (revision history timeline) — the timeline becomes meaningful once per-segment commits land separately from full regens.
- _Benefit (user):_ true segment-level revision control. Today accept/reject is whole-revision swap — if the user likes 9 of 10 segments in the new take but wants segment 7 from the original, they have to regenerate the whole chapter under different prompts to recover that one segment. This closes the loop the slice has been quietly capturing since plan 20 v1.

### 37. In-app multi-model management UX

Source: net-new (2026-05-18). Plan 49 (release packaging) ships with a Kokoro-only install bundle and an in-app Gemini API key field; the rest of the multi-model story still needs the deployer to drop to a terminal. This item closes that gap.

- _What:_ Add to the Account view (or a sibling Models tab): (a) "Install Ollama" affordance that detects the platform, downloads the vendor installer, and walks the user through setup; (b) "Pull model" UI on the analyzer section — lists models present on disk, exposes a Pull button for the configured-default that doesn't shell to a terminal; (c) "Refresh available models" button that re-hits `/api/ollama/health` and updates the dropdown without a page reload; (d) optional Coqui XTTS pre-install script (POSIX `.sh` + PowerShell `.ps1` parallels to `install-kokoro.*`) that fetches weights ahead of first generation.
- _Acceptance:_ Fresh deployer install (Kokoro only) → Account → Models → Install Ollama → Pull qwen3.5:4b → analyze a book, all without leaving the app. Coqui XTTS users can pre-fetch weights similarly. New Vitest specs cover the per-step state machine; one Playwright spec covers the install → pull → analyze loop end-to-end (mock the actual download).
- _Key files:_ `src/views/account.tsx` (extend with Models section), new `src/components/ollama-install.tsx`, new `src/components/model-pull-status.tsx`, `server/src/routes/ollama-health.ts` (extend with `POST /pull`), new `server/src/ollama/install-bootstrap.ts`, new `server/tts-sidecar/scripts/install-coqui.{sh,ps1}`.
- _Depends on:_ none structural — the Account UX seam exists from plan 49. Unparks the install-and-pull-from-UI subset of Won't #1 ("Auto-install Ollama / auto-pull models"); the headless-CI variant of Won't #1 stays parked.
- _Benefit (user):_ closes the gap that plan 49's Kokoro-only install leaves. Today a deployer who wants Ollama or Coqui XTTS must drop to a terminal; this UX keeps the install + model-management flow entirely in-app, matching the deployer-first promise of plan 49.

### 38. E2E coverage for the binary-upload flow (EPUB / PDF / MOBI / AZW3)

Source: [`52-mobi-parsing.md`](features/52-mobi-parsing.md) Out-of-scope follow-up (2026-05-18). Plan 52 explicitly deferred this — EPUB and PDF have never had dedicated Playwright coverage either, and MOBI shouldn't be the exception that sets a new bar in the same PR that ships it.

- _What:_ Add a single Playwright spec under `e2e/binary-upload.spec.ts` that drops each of the four binary fixtures (EPUB / PDF / MOBI / AZW3) onto `#/new` in mock mode and asserts the confirm-metadata screen renders with the expected title / chapter count. Wire it into `npm run test:e2e`. Fixtures: reuse `server/src/parsers/__fixtures__/sample.epub` for the EPUB case; generate a tiny MOBI/AZW3 either by checking in a small Project Gutenberg-derived file or by extending `scripts/gen-parser-fixtures.mjs` to call out to Calibre's `ebook-convert` (Calibre is a prerequisite, not bundled).
- _Acceptance:_ `npm run test:e2e` includes the new spec; CI run in `verify` passes with the spec exercising all four formats. A regression like "MOBI parser threw on real-world files" gets caught browser-side, not just at the unit level.
- _Key files:_ new `e2e/binary-upload.spec.ts`; possibly extend `scripts/gen-parser-fixtures.mjs` for MOBI/AZW3 generation (Calibre-dependent); `docs/features/52-mobi-parsing.md` "Test plan" section updates to cite the new spec.
- _Depends on:_ plan 52 shipped (the parser must already accept MOBI/AZW3). Independent of the existing flaky e2e items (Could #20).
- _Benefit (technical):_ binary parsers are the highest-risk seam in the upload flow — third-party libs (epub2 / pdf-parse / @lingo-reader/mobi-parser) have real-world quirks that unit tests with mocked libraries can't catch. Browser-level coverage locks the integration contract.

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
