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

- ***What***: one-sentence concrete description so the work is actionable from this bullet alone.
- ***Acceptance***: observable criteria for "done", so future-you knows when to remove the bullet.
- ***Key files***: starting points so the next pick-up doesn't spend an hour spelunking.
- ***Depends on***: (optional) — listed only when there's a real prerequisite.
- ***Benefit (axis)***: the *why* (user / technical / architectural).

Ranking within each bucket = top is highest priority.

**Counts as of 2026-05-17:** Must 0 · Should 11 · Could 13 · Won't 13

---

## Must — blocks v1 ship or hurts existing users

_All v1-blocker items shipped 2026-05-17 (plans 22a, 27, 32, 39)._

---

## Should — important, not blocking ship

### 1. Cold-load tab discovery of in-flight server analyses

Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md) follow-ups.

- *What:* Add a `GET /api/books/active-analyses` endpoint that scans every workspace `.audiobook/analysis-state.json` and returns the most-recent paused/halted snapshot. Frontend Layout mounts an effect that hits it on cold boot and seeds the analysis slice so the top-bar pill appears without the user having to navigate to the analysing route first.
- *Acceptance:* Refreshing the page while an analysis is paused on book X immediately surfaces the pill on the Books library; clicking the pill navigates to `#/books/X/analysing`.
- *Key files:* new endpoint in `server/src/routes/` (mirror the pattern in `server/src/routes/analysis.ts`); `src/components/layout.tsx` cold-boot effect; `src/store/analysis-slice.ts` for the hydrate action.
- *Benefit (user):* the top-bar pill is the whole point of sticky analysis. If it appears only after you've already navigated to the running job, the pill is decorative.

### 2. Library-home pill for paused-but-unopened books

Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md) follow-ups.

- *What:* Pills today are per-currently-opened-book. Surface a per-book badge on the library card for any book whose `.audiobook/analysis-state.json` shows a paused/halted run, so the user sees at a glance "you have unfinished analysis on book X" without opening it.
- *Acceptance:* From the Books library, a book with a paused analysis shows a "Paused — resume?" badge on its card; clicking the card opens the book and the existing top-bar pill takes over.
- *Key files:* `src/views/book-library.tsx` (`BookCard`); the same endpoint from Should #1; `src/store/library-slice.ts` for the new field on `LibraryBook`.
- *Depends on:* Should #1 (same endpoint; consolidate into one round trip).
- *Benefit (user):* prevents the "started yesterday, forgot where" failure mode.

### 3. Concurrent-synthesis / thread-pool saturation tests for the TTS sidecar

Source: CLAUDE.md commit-gate section ("next milestone").

- *What:* Add pytest coverage that fires N parallel `/synthesize` requests through the sidecar's thread pool and asserts each output's audio integrity (frame count, sample-rate, no silent frames, no cross-request bleed).
- *Acceptance:* New file `server/tts-sidecar/tests/test_concurrent_synthesis.py` exercises Kokoro (default) and Coqui (when loaded). Tests gate on `torch.cuda.is_available()` so they skip cleanly on a non-GPU dev box.
- *Key files:* `server/tts-sidecar/tests/test_runtime_wiring.py` (existing pattern to mirror); `server/tts-sidecar/main.py` for the thread-pool wiring.
- *Benefit (technical):* current pytest pins the single-request CUDA+DeepSpeed+fp16 path but says nothing about thread-pool behaviour under parallel load — exactly the regression class that produces silent audio corruption.

### 4. Subset-retry route sticky behaviour (second in-flight map)

Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md) follow-ups.

- *What:* The chapter-specific re-analysis path uses the same SSE plumbing but does not yet land in the server-side in-flight map, so a navigation away during a subset retry drops the run. Add a second in-flight map keyed by `(bookId, chapterIds)` and route subset-retry SSEs through it, mirroring the full-analysis sticky pattern.
- *Acceptance:* Starting a subset retry, navigating to Books, then back to `analysing` shows the AnalysisPill in its subset-retry variant and the SSE stream continues uninterrupted; covered by a new server-side Vitest spec.
- *Key files:* `server/src/routes/analysis.ts` (existing full-analysis sticky map); `src/store/analysis-stream-middleware.ts`; `src/components/AnalysisPill.tsx` (subset-retry variant already exists in UI).
- *Benefit (technical):* the AnalysisPill subset-retry variant lies today — UI says "retrying chapter 4" but a navigation drops the run. Closing this is correctness, not polish.

### 5. Implicit reconcile-driven generation start guard

Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md) follow-ups.

- *What:* The D2 guard catches an explicit TTS-start while a local analysis is alive, but the implicit reconcile path (auto-start when state hydrates with `pendingGenerations`) bypasses the guard. Either route reconcile through the same guard, or add a reducer-level check that refuses to flip a generation to `running` while an analysis is alive on the same book.
- *Acceptance:* A Vitest spec asserts that hydrating a book with `analysisStatus: 'running'` AND `pendingGenerations: [...]` ends in a paused-pending-generations state, NOT a running one. The acceptance walkthrough in plan 32 picks up a fourth invariant for D2.
- *Key files:* `src/store/generation-stream-middleware.ts`; `src/store/persistence-middleware.ts` (hydration path); `docs/features/32-sticky-analysis.md` D2 section.
- *Benefit (architectural):* current behaviour is deliberate but leaks the rule. Closing the seam stops a future contributor from accidentally bypassing D2 by routing through reconcile.

### 6. `state.json` schema versioning + migration story

Source: [`27-book-state-persistence.md`](features/27-book-state-persistence.md) (TBD note).

- *What:* Add a top-level `schema: 1` field to `.audiobook/state.json` writers, a reader that asserts `schema === 1`, and a `migrate()` skeleton that handles `1 → 2` (no-op today, but the seam exists). Document the rename-vs-add policy in plan 27.
- *Acceptance:* New writes include `"schema": 1`; reads of a missing `schema` field still succeed (treated as v1 for back-compat); a deliberately-bumped fixture (`schema: 2`) routes through `migrate()`. Server test covers both directions.
- *Key files:* `server/src/workspace/state.ts` (or wherever state.json read/write lives); `server/src/routes/book-state.ts`; `docs/features/27-book-state-persistence.md`.
- *Benefit (architectural):* every persisted-state system that skipped versioning regrets it on the first non-additive change. Write the version now while there are zero on-disk v1 files in the wild that resist upgrade.

### 7. E2E coverage: upload → analysing → confirm → ready

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups.

- *What:* Add a Playwright spec that walks the cold-boot → "Start a new book" → paste a tiny manuscript → wait for `analysing` → wait for `confirm` → click Confirm → land on `ready`. Use the mock backend so it doesn't need a sidecar.
- *Acceptance:* New file `e2e/new-book-flow.spec.ts`. Wall-clock under 30 s on a warm cache. URL transitions asserted at each step; the smoke spec at `e2e/smoke.spec.ts` stays untouched.
- *Key files:* `e2e/smoke.spec.ts` (pattern to mirror); `playwright.config.ts`; mock fixtures in `src/mocks/canned-data.ts` are already wired for this flow.
- *Benefit (technical):* the full new-book flow is the highest-blast-radius user journey and currently has zero browser-level regression coverage.

### 8. Slice unit tests: `applyGenerationTick`, `applyVoiceMatches`

Source: CLAUDE.md "Suggested follow-ups".

- *What:* Add focused Vitest unit specs for the two reducers that mutate the most state during a run (generation progress ticks; voice-match application after analysis).
- *Acceptance:* New `*.test.ts` files alongside the slices assert: initial-state defaults, idempotency under repeated identical payloads, mutation isolation (one chapter's update doesn't touch another's), and the regression cases that prompted the past commits referenced in git log.
- *Key files:* `src/store/chapters-slice.ts` (likely owns `applyGenerationTick`); `src/store/cast-slice.ts` (likely owns `applyVoiceMatches`); existing `*-slice.test.ts` files for the pattern.
- *Benefit (technical):* the two slice reducers with the most regression history, currently exercised only via integration. Unit coverage shrinks the blast radius of any future refactor of either.

### 9. Visual-regression baselines via Playwright `toHaveScreenshot()`

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups + open question.

- *What:* Capture screenshot baselines for the five core stages (library, upload, analysing, confirm, ready) plus the listen view, using Playwright's native `toHaveScreenshot()`. Decide and document: per-platform baselines (`e2e/__screenshots__/{platform}/`) vs. single committed artwork. CI implications differ per choice.
- *Acceptance:* `npm run test:e2e` includes a `visual.spec.ts` that captures and diffs the six baselines; first run blesses, subsequent runs diff. `docs/features/37-e2e-playwright.md` gets a new "Visual baselines" section documenting the storage decision.
- *Key files:* new `e2e/visual.spec.ts`; `playwright.config.ts` (may need a project for `--update-snapshots` toggling); `docs/features/37-e2e-playwright.md`.
- *Depends on:* Should #7 (the new-book flow spec — `e2e/new-book-flow.spec.ts` — captures the analysing/confirm/ready stages under the mock-data shape this would baseline against).
- *Benefit (technical):* first defence against the silent CSS-token / Tailwind / icon-set drift that unit tests can't catch.

### 10. Automatic retry of transient TTS sidecar failures

Source: [`14-tts-sidecar-coqui.md`](features/14-tts-sidecar-coqui.md) (KNOWN: scaffolded behaviour).

- *What:* Wrap the per-sentence sidecar synth call in an in-band retry with exponential backoff (e.g. 1 attempt + 2 retries at 500ms / 2s) on transient errors (HTTP 5xx, connection-refused, timeout). Distinguish transient-and-retried from persistent-and-surfaced so the queue keeps moving on flakes.
- *Acceptance:* A new Vitest spec in `server/src/tts/synthesise-chapter.test.ts` mocks two consecutive 503s followed by a 200 and asserts the third attempt's audio is returned. The UI's existing "Retry" button now only appears on retry-exhausted failures.
- *Key files:* `server/src/tts/synthesise-chapter.ts`; `server/src/tts/sidecar.ts` (the HTTP client to the sidecar); existing retry pattern in `server/src/analyzer/gemini.ts` for reference (see `generateWithLimiter`).
- *Benefit (user):* a long generation run with one flaky sentence today wedges the queue until the user notices and clicks Retry. A single auto-retry restores hands-off operation.

### 11. Top-bar TTS pill — third-surface consolidation trigger

Source: [`30-global-model-control.md`](features/30-global-model-control.md).

- *What:* Tracking item. Single-poll consolidation across pills was deferred until a third surface needs warm. The moment a third pill consumer appears (e.g. preview drawer, Listen view warm-up indicator), unify the polling.
- *Acceptance:* `useTtsLifecycle` (already a single hook per plan 30 G1) drives all three+ surfaces from one `setInterval`. No new network polls per surface mount.
- *Key files:* `src/hooks/useTtsLifecycle.ts`; `src/components/layout.tsx`; whatever new surface lands.
- *Depends on:* the actual third surface materialising.
- *Benefit (architectural):* prevents the duplicated-poll explosion that motivated plan 30 G1's hook consolidation in the first place.

---

## Could — nice to have, low-cost wins

### 1. AAC/M4A or Opus output (swappable encoder)

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- *What:* Generalise `encodePcmToMp3` to accept an encoder choice (`mp3 | m4a | opus`) and add a sidecar/server config knob that selects per-book output format.
- *Acceptance:* The boundary in `server/src/tts/mp3.ts` (or wherever `encodePcmToMp3` lives) is renamed `encodePcmToAudio` and dispatches on format; existing tests still pass; a new test covers m4a output.
- *Key files:* `server/src/tts/mp3.ts`; `docs/features/28-chapter-audio-format.md`.
- *Benefit (user):* smaller files / better quality for users who prefer either; small cost because the encoder seam already exists.

### 2. `redux-persist` on `ui` and `manuscript` slices

Source: CLAUDE.md "Suggested follow-ups".

- *What:* Install redux-persist, wire it to the two slices that hold last-visited stage and last-edited manuscript state, so a page refresh keeps the user where they were instead of bouncing back to Books.
- *Acceptance:* Refresh on `#/books/<id>/manuscript` restores the same view and the same selected chapter. Existing Vitest specs still pass; new spec asserts the persisted shape's stability across slice version bumps.
- *Key files:* `src/store/index.ts`; `src/store/ui-slice.ts`; `src/store/manuscript-slice.ts`.
- *Benefit (user):* page refresh today resets `ui.stage` to `{ kind: 'books' }`; persist keeps the user where they were.

### 3. Swap `src/lib/router.ts` for `react-router` v6 `createHashRouter`

Source: CLAUDE.md "Suggested follow-ups".

- *What:* Replace the hand-rolled `parseHash`/`stageToHash`/`RouterStore` adapter with `createHashRouter` while keeping the URL grammar in plan 01 byte-identical.
- *Acceptance:* Every URL in plan 01's acceptance walkthrough still resolves to the same stage; `src/lib/router.test.ts` (rewritten) passes; the hand-rolled `RouterStore` adapter is deleted.
- *Key files:* `src/lib/router.ts`; `src/store/index.ts` (router install); `docs/features/01-hash-router.md`.
- *Benefit (technical):* eliminates a hand-rolled router and its bespoke `RouterStore` adapter — one less maintenance load.

### 4. Real `<audio>` element in `MiniPlayer`

Source: CLAUDE.md "Suggested follow-ups".

- *What:* Replace the visual stub mini-player with a real `<audio>` element wired to `getChapterAudio({ chapterId })`; respond to spacebar pause-play and arrow seek.
- *Acceptance:* Clicking play on the mini-player plays the chapter audio in real mode; the Listen e2e spec (Should #8) asserts playback state.
- *Key files:* `src/components/MiniPlayer.tsx` (or wherever `MiniPlayer` is defined).
- *Depends on:* Should #8 (e2e coverage). Mock audio URLs shipped 2026-05-17 with plan 20.
- *Benefit (user):* listen view becomes actually-listenable.

### 5. ESLint + Prettier + axe-core a11y pass

Source: CLAUDE.md "Suggested follow-ups".

- *What:* Add ESLint with `@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-jsx-a11y`; Prettier with a minimal config; an axe-core check that runs against the rendered library, upload, confirm, and listen views via Vitest+React Testing Library.
- *Acceptance:* `npm run lint` exists and passes on the current tree (after one auto-fix pass); a new `npm run test:a11y` exists and asserts zero a11y violations on the four views. Hook these into `npm run verify`.
- *Key files:* new `.eslintrc.cjs`, `.prettierrc`; `package.json` scripts.
- *Benefit (technical):* baseline code hygiene + first a11y net.

### 6. JSON-schema-mode structured output for Ollama

Source: [`29-analyzer-ollama-local.md`](features/29-analyzer-ollama-local.md) out-of-scope.

- *What:* Adopt Ollama 0.5+ structured-output mode by passing the analyzer's `zod` schemas through `zod-to-json-schema` and into the request. Reduces free-text-parsing brittleness in `parseAnalyzerResponse`.
- *Acceptance:* The analyzer slice's validation-failure rate metric (or a manual eyeball over a 5-chapter test manuscript) drops measurably. Existing Vitest specs covering the parser still pass; a new spec asserts the request body includes the JSON schema.
- *Key files:* `server/src/analyzer/ollama.ts`; `server/src/analyzer/schemas.ts` (or wherever the zod schemas live); add `zod-to-json-schema` to server deps.
- *Benefit (technical):* current failures cluster on free-text parsing — exactly the dimension structured output cuts.

### 7. Long-form description (`desc` / `ldes`) for Voice export

Source: [`33-voice-export.md`](features/33-voice-export.md) known gap.

- *What:* Add a `description: string | null` field to the book metadata model; expose an edit affordance in the metadata modal; pipe the value into the M4B `desc` and `ldes` atoms during export.
- *Acceptance:* Editing a book and saving sets the description; an M4B export embeds `desc` / `ldes` (verified by `ffprobe -show_streams`); the Live Voice app shows the richer "About this audiobook" text.
- *Key files:* `src/modals/edit-book-meta.tsx`; `server/src/export/build-m4b.ts`; `openapi.yaml` (BookMetadata schema).
- *Benefit (user):* richer "About this audiobook" panel in Live Voice.

### 8. Streaming audio for live playback during chapter generation

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- *What:* Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- *Acceptance:* Generating a chapter shows audio progress under the play cursor before the chapter completes. Existing per-chapter file is still written atomically at the end.
- *Key files:* `server/src/tts/synthesise-chapter.ts`; `server/src/tts/mp3.ts`; `src/components/MiniPlayer.tsx` (or wherever playback lives) for the MediaSource consumer.
- *Benefit (user):* "listen as it generates" is the magic moment audiobook tools sell on.

### 9. CI integration for the test suite

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups.

- *What:* Add a GitHub Actions (or equivalent) workflow that runs `npm run verify` on every PR. Cache `node_modules` and the Playwright browser. Budget for e2e being the slowest job (~60 s cold).
- *Acceptance:* PRs that break tests are blocked from merge. Workflow runs in under 10 min cold, under 5 min warm.
- *Key files:* new `.github/workflows/verify.yml`.
- *Benefit (technical):* eliminates the "works on my machine" gap.

### 10. More e2e golden paths (voices, cast, profile drawer)

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups.

- *What:* Add Playwright specs for the Voice library tab (open, see voices, pin/unpin) and the cast/profile-drawer flow (open a confirmed book, click a character, see drawer with evidence toggle).
- *Acceptance:* Two new spec files (`e2e/voices.spec.ts`, `e2e/cast-drawer.spec.ts`); both run in under 15 s warm.
- *Key files:* `e2e/smoke.spec.ts` (pattern to mirror); `src/views/voices.tsx`; `src/modals/profile-drawer.tsx`.
- *Benefit (technical):* incremental low-cost coverage growth.

### 11. PocketBook Cloud direct upload OR `@pbsync.com` email gateway

Source: [`32-audiobook-export.md`](features/32-audiobook-export.md) follow-ups.

- *What:* Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- *Acceptance:* A working prototype for one of the two paths; new tile on the export modal; documented size limits + caveats.
- *Key files:* new tile config in `src/data/listener-apps.ts`; `src/modals/export-audiobook.tsx`; `server/src/export/` for any new transport.
- *Benefit (user):* true sideload-free path. Low priority because LAN download + sync folder already work.

### 12. Voice compare from the global `#/voices` tab for same-book pairs

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- *What:* When both selected voices in the global `#/voices` tab share a `bookId` (≠ `currentBookId`), fetch that book's cast on demand via `api.getBookState(bookId)` and pass the resolved characters into `CompareCastModal`. Cache the fetched cast for the modal session so re-opens are instant.
- *Acceptance:* The Compare button enables in the global tab for a same-`bookId` 2-voice pair; the modal opens with the correct two characters. Vitest covers the on-demand fetch path + the disabled state when the fetch fails. The e2e `voices-compare.spec.ts` gains a global-tab same-book pair assertion.
- *Key files:* `src/views/voices.tsx` (gating logic + on-demand fetch); `src/lib/api.ts` (`getBookState`); `e2e/voices-compare.spec.ts`.
- *Depends on:* none structural; orthogonal to Must #2 (`mockGetBookState`) but the latter unblocks proper e2e coverage under mocks.
- *Benefit (user):* closes the gap in the Voice library global view — today the global tab's Compare is fully disabled, even for pairs that would resolve cleanly with one fetch.

### 13. Cross-book voice compare

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- *What:* Lift the cross-book guard. When the two selected voices belong to different `bookId`s, fetch each book's cast (one of them may be the open book — short-circuit) and pass both characters into `CompareCastModal`. Decide and document: do we route saves back to each character's source book's cast slice, or refuse the save and surface a "viewing only" banner?
- *Acceptance:* The Compare button enables for cross-book pairs; the modal opens with both characters; the Save behaviour is documented and tested. The e2e gains a cross-book pair assertion.
- *Key files:* `src/views/voices.tsx`; `src/store/cast-slice.ts` (Save routing); `src/modals/compare-cast-modal.tsx` (if the viewing-only banner is needed).
- *Depends on:* Could #12 (the same on-demand fetch machinery).
- *Benefit (user):* enables A/B for users who reuse the same TTS voice across books — e.g. comparing the same narrator across two books in a series to spot drift.

---

## Won't (this round) — explicitly parked

Listed for traceability so they aren't repeatedly proposed and re-rejected. Each has a "wake when" condition documented in the source plan.

1. **New features beyond v1 surface.** Source: CLAUDE.md "Out of scope".
2. **Visual redesign.** Source: CLAUDE.md "Out of scope".
3. **Auto-install Ollama / auto-pull models.** Source: [`29-analyzer-ollama-local.md`](features/29-analyzer-ollama-local.md). Installer/pip steps fragile; explicit user opt-in only.
4. **Auto-start TTS sidecar.** Source: [`14-tts-sidecar-coqui.md`](features/14-tts-sidecar-coqui.md). v1 scaffolding choice — user runs `npm run tts:sidecar` manually.
5. **Multi-model fan-out for Gemini analyzer.** Source: [`06-analyzer-gemini.md`](features/06-analyzer-gemini.md). One model per run; A/B via re-run.
6. **Dark mode.** Source: [`25-design-tokens.md`](features/25-design-tokens.md). Light-only for v1.
7. **Multi-tab catch-up race resilience.** Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md). Theoretical edge — disk state is authoritative; single-user-assumed.
8. **Multi-book parallel generation.** Source: [`16-generation-stream.md`](features/16-generation-stream.md). Design constraint.
9. **Voice creation from scratch.** Source: [`22-voice-library.md`](features/22-voice-library.md). Library is read-only over the sidecar's voice catalog.
10. **Bulk pin / bulk delete in voice library.** Source: [`22-voice-library.md`](features/22-voice-library.md). Single-item v1.
11. **Live `VITE_USE_MOCKS` toggle in running UI.** Source: [`23-mock-toggle.md`](features/23-mock-toggle.md). Build-time flag only.
12. **Partial mock mode (some endpoints mocked, others real).** Source: [`23-mock-toggle.md`](features/23-mock-toggle.md). All-or-nothing on purpose.
13. **Conflict resolution for two simultaneous `state.json` writers.** Source: [`27-book-state-persistence.md`](features/27-book-state-persistence.md). Single-user-per-workspace assumption.
