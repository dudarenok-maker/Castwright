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

**Counts as of 2026-05-17:** Must 0 · Should 4 · Could 14 · Won't 12

---

## Must — blocks v1 ship or hurts existing users

_All v1-blocker items shipped 2026-05-17 (plans 22a, 27, 32, 39)._

---

## Should — important, not blocking ship

### 1. E2E coverage: listen view + mini-player

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups.

- *What:* The existing `e2e/listen-playback.spec.ts` opens Solway Bay and asserts play click flips `<audio>.paused`. Tracking item to add a progressing-duration assertion (mini-player time changes after N ms of play) and chapter-switch + resume-from-position cases once Could #3 (listening progress / resume bookmarks) lands.
- *Acceptance:* `e2e/listen-playback.spec.ts` adds the duration-tick + chapter-switch assertions.
- *Key files:* `e2e/listen-playback.spec.ts`; `src/views/listen.tsx`; `src/components/mini-player.tsx`.
- *Depends on:* Could #3 (resume bookmarks) for the resume-from-position case; the duration-tick case is unblocked today.
- *Benefit (technical):* listen + playback is the second-highest-blast-radius surface.

### 2. Dark mode

Source: [`25-design-tokens.md`](features/25-design-tokens.md) (was Won't #6; promoted 2026-05-17 per user prioritisation).

- *What:* Add a `[data-theme="dark"]` token override block in `src/styles.css` for every `--peach`/`--ink`/`--magenta`/`--canvas`/`--ink-soft` token. Add a theme toggle in the top bar (`src/components/layout.tsx`). Persist preference via the `ui` slice (rides on the redux-persist wiring shipped 2026-05-17 — extend `UI_PERSIST_WHITELIST` with the new `theme` field in `src/store/index.ts`) and read `prefers-color-scheme` as the first-visit default.
- *Acceptance:* Toggling the affordance flips every surface (library, upload, analysing, confirm, ready, listen, voices, modals) without a single hex literal needing change. The grep test in plan 25 still returns zero hits. Refresh preserves the user's choice. New Playwright spec captures `toHaveScreenshot()` for both themes on the five core stages (extends the baseline harness shipped 2026-05-17 as `e2e/visual.spec.ts`).
- *Key files:* `src/styles.css` (dark-token block); `tailwind.config.ts` (already references `var(--token)`, no changes expected); `src/components/layout.tsx` (toggle); `src/store/ui-slice.ts` (theme field); `src/store/index.ts` (extend `UI_PERSIST_WHITELIST`); `docs/features/25-design-tokens.md` (drop the "out of scope" bullet, add a "Dark mode" invariants section).
- *Depends on:* none structural — the visual-baselines harness (`e2e/visual.spec.ts`) is already in place; dark-mode adds a second-theme baseline pass on top.
- *Benefit (user):* the single most-requested visual polish missing from v1; 9 PM listening sessions stop blasting white.

### 3. Adjustable cover framing + local-disk upload

Source: [`40-cover-framing-and-upload.md`](features/40-cover-framing-and-upload.md) (draft).

- *What:* Extend the existing CoverPicker (plan [36](features/36-book-covers.md)) with two tabs: **Upload** (drag-drop / file picker for JPEG/PNG, ≤10 MB, PNG transcoded to JPEG server-side) and **Frame** (drag-pan + zoom slider 1.0×–3.0× on the square preview). Framing persists to `state.json.coverImage.framing` and renders via `object-position` + `transform: scale`; uploaded covers replace the on-disk JPEG so the export pipeline (M4B `covr`, MP3 `APIC`) keeps working unchanged. New endpoints: `POST /api/books/{bookId}/cover/upload`, `PATCH /api/books/{bookId}/cover/framing`.
- *Acceptance:* Per the plan 40 walkthrough — drag-to-frame an OpenLibrary cover so the title is visible inside the square; reload preserves framing; upload a local PNG → transcoded to JPEG on disk → renders identically on BookCard + CoverArt; M4B export still embeds an `attached_pic` stream. Paired Vitest covers `computeCoverStyle` boundaries, picker tab switching, and the two new server endpoints; optional Playwright spec exercises the upload golden path.
- *Key files:* `src/modals/cover-picker.tsx`; `src/views/book-library.tsx`; `src/views/listen.tsx`; new `src/lib/cover-framing.ts`; new `server/src/cover/upload.ts`; `server/src/routes/cover.ts`; `server/src/workspace/scan.ts`; `openapi.yaml`.
- *Depends on:* none structural. Plan 36's data model and endpoints are extended, not replaced; the plan 27 schema-versioning seam (already shipped) accommodates the additive `coverImage.framing` field.
- *Benefit (user):* OpenLibrary covers crop the title/author away in our square frame today, and books with no OpenLibrary match are stuck on the procedural gradient forever. Both gaps close in one round.

### 4. Bulk-apply library sync on confirm-cast

Source: [`41-bulk-library-sync.md`](features/41-bulk-library-sync.md) (draft) — supersedes plan 09 §"Bulk-accept-all UI".

- *What:* Add a "Sync N profiles from library" pill at the top of the confirm-cast view that ticks every eligible character's "Sync profile" checkbox in one click. Inverse "Clear all syncs" when all are already ticked. No server changes — existing `handleConfirm` batch (`src/views/confirm-cast.tsx:62-86`) handles the per-character library-cast-override calls already.
- *Acceptance:* Pill appears when at least one character has `matchedFrom.bookId + characterId` set; click ticks every such character's checkbox; click again clears; per-character untick still works as the exception path. New Vitest covers pill render + bulk-toggle logic; new Playwright spec walks cold-boot → confirm → click pill → click Confirm cast.
- *Key files:* `src/views/confirm-cast.tsx`; new `src/views/confirm-cast.test.tsx`; new `e2e/bulk-sync-library.spec.ts`; new `docs/features/41-bulk-library-sync.md`.
- *Depends on:* none. Plan 09's per-character override (shipped) is the API path; this is purely a UI compression.
- *Benefit (user):* large manuscripts in long-running series (12+ carryovers) currently demand a click per character before "Confirm cast". One-click bulk + exception ticking matches how the user actually thinks ("reuse all, except these").

---

## Could — nice to have, low-cost wins

### 1. CI integration for the test suite

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups.

- *What:* Add a GitHub Actions (or equivalent) workflow that runs `npm run verify` on every PR. Cache `node_modules` and the Playwright browser. Budget for e2e being the slowest job (~60 s cold).
- *Acceptance:* PRs that break tests are blocked from merge. Workflow runs in under 10 min cold, under 5 min warm.
- *Key files:* new `.github/workflows/verify.yml`.
- *Benefit (technical):* eliminates the "works on my machine" gap. Pairs with the visual baselines shipped 2026-05-17 (`e2e/visual.spec.ts`) — without CI, the baselines are a tree-falling-in-a-forest.

### 2. ESLint + Prettier + axe-core a11y pass

Source: CLAUDE.md "Suggested follow-ups".

- *What:* Add ESLint with `@typescript-eslint`, `eslint-plugin-react`, `eslint-plugin-jsx-a11y`; Prettier with a minimal config; an axe-core check that runs against the rendered library, upload, confirm, and listen views via Vitest+React Testing Library. The `npm run lint` script is already wired in `package.json:17`; this PR fills in the missing config + devDependencies.
- *Acceptance:* `npm run lint` passes on the current tree (after one auto-fix pass); a new `npm run test:a11y` exists and asserts zero a11y violations on the four views. Hook these into `npm run verify`.
- *Key files:* new `.eslintrc.cjs`, `.prettierrc`; `package.json` scripts.
- *Benefit (technical):* baseline code hygiene + first a11y net. Doing this earlier means the auto-fix noise lands once on a clean tree, not buried inside future feature PRs.

### 3. Listening progress / resume bookmarks

Source: net-new (2026-05-17). Validated absent in `src/views/listen.tsx` + `src/components/mini-player.tsx` (in-memory `currentSec` only).

- *What:* Persist `{ chapterId, currentSec, updatedAt }` per book to a sibling `listen-progress.json` (NOT extending `state.json`, to keep that file's shape stable now that the schema-versioning seam — plan 27 — is in place). Mini-player resumes from the saved point when a chapter reopens. Show a "Resume at MM:SS" pill next to the chapter title on the Listen view.
- *Acceptance:* Play chapter 3 to 1:23, navigate away, refresh, reopen → resume point is 1:23 ±1s. Server Vitest covers the read/write; frontend Vitest covers the mini-player resume effect.
- *Key files:* `src/views/listen.tsx`; `src/components/mini-player.tsx`; new `src/store/listen-progress-slice.ts`; new server endpoint under `server/src/routes/`.
- *Depends on:* persistence-model decision (recommendation: sibling file).
- *Benefit (user):* the single feature audiobook users assume exists. Today's behaviour (reset to 0) actively trains the user not to refresh. Also unblocks Should #4's resume-from-position e2e case.

### 4. Global error toast / banner surface

Source: net-new (2026-05-17). Today errors land in `chapters.lastError`; only `src/components/stale-audio-banner.tsx` is wired as a domain banner.

- *What:* Add a top-level `notifications` slice with `pushToast({ kind: 'error'|'warn'|'info', message, dedupeKey? })` and an auto-dismiss timer. Mount a `<ToastStack/>` in `src/components/layout.tsx`. Route middleware-surfaced errors (analysis-stream, generation-stream, export) through the slice.
- *Acceptance:* New Vitest spec asserts dedupe-by-key suppresses repeats; e2e spec triggers a forced 500 on an export and asserts the toast appears + auto-dismisses; existing `stale-audio-banner.tsx` continues to work (it's a domain banner, not a transient toast).
- *Key files:* new `src/store/notifications-slice.ts`; new `src/components/toast-stack.tsx`; `src/store/analysis-stream-middleware.ts`; `src/store/generation-stream-middleware.ts`; `src/components/layout.tsx`.
- *Depends on:* none.
- *Benefit (user):* transient failures today are invisible to the user — they just see the UI not advance. A toast surface closes the "did anything happen?" gap.

### 5. Audio loudness normalization (ffmpeg `loudnorm`)

Source: net-new (2026-05-17). Validated absent in `server/src/tts/mp3.ts` (raw PCM → LAME VBR, no loudness filter).

- *What:* Add an optional `loudnorm` pass to the chapter encode pipeline. Two-pass mode (analyse → apply) gates on a config knob (`AUDIO_LOUDNORM=off|single|two-pass`, default `single`). Targets EBU R128 `-16 LUFS`, `-1.5 dBTP`, `LRA 11`.
- *Acceptance:* New server Vitest spec asserts the ffmpeg invocation includes the loudnorm filter when enabled; manual: compare two chapters generated with different voices, both land within ±1 LU of target. Skip when `AUDIO_LOUDNORM=off`.
- *Key files:* `server/src/tts/mp3.ts`; `server/.env.example` (new knob); `docs/features/28-chapter-audio-format.md` (extend with a "Loudness" section).
- *Depends on:* none. Encode latency cost is ~20-40% for single-pass loudnorm; document the trade-off.
- *Benefit (user):* per-voice volume drift across chapters today forces the listener to ride the volume knob. Loudnorm makes the book sit at one level.

### 6. AAC/M4A or Opus output (swappable encoder)

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- *What:* Generalise `encodePcmToMp3` to accept an encoder choice (`mp3 | m4a | opus`) and add a sidecar/server config knob that selects per-book output format.
- *Acceptance:* The boundary in `server/src/tts/mp3.ts` (or wherever `encodePcmToMp3` lives) is renamed `encodePcmToAudio` and dispatches on format; existing tests still pass; a new test covers m4a output.
- *Key files:* `server/src/tts/mp3.ts`; `docs/features/28-chapter-audio-format.md`.
- *Depends on:* none, but cluster after Could #5 (loudnorm) so the encoder boundary is generalised AFTER the loudnorm wiring lands — otherwise we re-touch the dispatch twice.
- *Benefit (user):* smaller files / better quality for users who prefer either; small cost because the encoder seam already exists.

### 7. Long-form description (`desc` / `ldes`) for Voice export

Source: [`33-voice-export.md`](features/33-voice-export.md) known gap.

- *What:* Add a `description: string | null` field to the book metadata model; expose an edit affordance in the metadata modal; pipe the value into the M4B `desc` and `ldes` atoms during export.
- *Acceptance:* Editing a book and saving sets the description; an M4B export embeds `desc` / `ldes` (verified by `ffprobe -show_streams`); the Live Voice app shows the richer "About this audiobook" text.
- *Key files:* `src/modals/edit-book-meta.tsx`; `server/src/export/build-m4b.ts`; `openapi.yaml` (BookMetadata schema); `server/src/workspace/scan.ts` (`BookStateJson`).
- *Benefit (user):* richer "About this audiobook" panel in Live Voice.

### 8. Voice compare from the global `#/voices` tab for same-book pairs

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- *What:* When both selected voices in the global `#/voices` tab share a `bookId` (≠ `currentBookId`), fetch that book's cast on demand via `api.getBookState(bookId)` and pass the resolved characters into `CompareCastModal`. Cache the fetched cast for the modal session so re-opens are instant.
- *Acceptance:* The Compare button enables in the global tab for a same-`bookId` 2-voice pair; the modal opens with the correct two characters. Vitest covers the on-demand fetch path + the disabled state when the fetch fails. The e2e `voices-compare.spec.ts` gains a global-tab same-book pair assertion.
- *Key files:* `src/views/voices.tsx` (gating logic + on-demand fetch); `src/lib/api.ts` (`getBookState`); `e2e/voices-compare.spec.ts`.
- *Depends on:* none structural.
- *Benefit (user):* closes the gap in the Voice library global view — today the global tab's Compare is fully disabled, even for pairs that would resolve cleanly with one fetch.

### 9. Cross-book voice compare

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- *What:* Lift the cross-book guard. When the two selected voices belong to different `bookId`s, fetch each book's cast (one of them may be the open book — short-circuit) and pass both characters into `CompareCastModal`. Decide and document: do we route saves back to each character's source book's cast slice, or refuse the save and surface a "viewing only" banner?
- *Acceptance:* The Compare button enables for cross-book pairs; the modal opens with both characters; the Save behaviour is documented and tested. The e2e gains a cross-book pair assertion.
- *Key files:* `src/views/voices.tsx`; `src/store/cast-slice.ts` (Save routing); `src/modals/compare-cast-modal.tsx` (if the viewing-only banner is needed).
- *Depends on:* Could #8 (the same on-demand fetch machinery).
- *Benefit (user):* enables A/B for users who reuse the same TTS voice across books — e.g. comparing the same narrator across two books in a series to spot drift.

### 10. More e2e golden paths (voices, cast, profile drawer)

Source: [`37-e2e-playwright.md`](features/37-e2e-playwright.md) follow-ups.

- *What:* Add Playwright specs for the Voice library tab (open, see voices, pin/unpin) and the cast/profile-drawer flow (open a confirmed book, click a character, see drawer with evidence toggle).
- *Acceptance:* Two new spec files (`e2e/voices.spec.ts`, `e2e/cast-drawer.spec.ts`); both run in under 15 s warm.
- *Key files:* `e2e/smoke.spec.ts` (pattern to mirror); `src/views/voices.tsx`; `src/modals/profile-drawer.tsx`.
- *Benefit (technical):* incremental low-cost coverage growth.

### 11. Streaming audio for live playback during chapter generation

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- *What:* Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- *Acceptance:* Generating a chapter shows audio progress under the play cursor before the chapter completes. Existing per-chapter file is still written atomically at the end.
- *Key files:* `server/src/tts/synthesise-chapter.ts`; `server/src/tts/mp3.ts`; `src/components/mini-player.tsx` for the MediaSource consumer.
- *Benefit (user):* "listen as it generates" is the magic moment audiobook tools sell on.

### 12. Cross-tab `BroadcastChannel` state sync

Source: net-new (2026-05-17). Validated absent in frontend.

- *What:* Open `new BroadcastChannel('audiobook-state')` in store init; broadcast post-mutation snapshots of the analysis + generation slices keyed by `bookId`. Listening tabs hydrate without a network round-trip.
- *Acceptance:* Open the same book in two tabs, start an analysis in tab A → tab B's top-bar pill updates without a refresh. New Vitest spec under jsdom mocks `BroadcastChannel` and asserts inbound messages drive the right reducer.
- *Key files:* `src/store/index.ts`; new `src/store/broadcast-middleware.ts`; `src/store/analysis-slice.ts`; `src/store/chapters-slice.ts`.
- *Depends on:* none structural. Note the tension with Won't #6 (multi-tab catch-up race resilience parked) — this entry covers the cooperative cross-tab case, not the racing-writes case.
- *Benefit (technical):* eliminates the cold-boot endpoint round-trip (the `/api/library/active-analyses` lookup, shipped 2026-05-17) when a sibling tab already has the state. Single-user-per-workspace assumption still holds.

### 13. PocketBook Cloud direct upload OR `@pbsync.com` email gateway

Source: [`32-audiobook-export.md`](features/32-audiobook-export.md) follow-ups.

- *What:* Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- *Acceptance:* A working prototype for one of the two paths; new tile on the export modal; documented size limits + caveats.
- *Key files:* new tile config in `src/data/listener-apps.ts`; `src/modals/export-audiobook.tsx`; `server/src/export/` for any new transport.
- *Benefit (user):* true sideload-free path. Low priority because LAN download + sync folder already work.

### 14. Single-poll TTS lifecycle for a third consumer (tracking)

Source: [`30-global-model-control.md`](features/30-global-model-control.md) "When to extend the pattern".

- *What:* Tracking item. The consolidated `useTtsLifecycle()` hook (`src/lib/use-tts-lifecycle.ts`) already drives both today's pill surfaces — top-bar (`src/components/layout.tsx`) and Generation view (`src/views/generation.tsx`) — from one `setInterval` via `LayoutContext`. **Wake this item when a JIT-warmed surface graduates to pill-driven UI.** Concrete triggers: Profile Drawer Play, Cast row Play, or the per-character "regenerate this voice across the book" button — whichever first stops using `playSampleWithAutoLoad` and starts wanting an always-on Load/Stop affordance.
- *Acceptance:* The new surface reads `ttsLifecycle` from `useOutletContext<LayoutContext>()` (pattern from `generation.tsx`). No new `setInterval`, no new `/health` poll, no duplicated `evictionNotice` / `loadErrorNotice` state.
- *Key files:* `src/lib/use-tts-lifecycle.ts` (no changes expected — already exported); `src/components/layout.tsx` (no changes — already exposes the context); the new surface's component file.
- *Depends on:* an actual third surface materialising. Product-driven, not architecture-driven — the seam is ready, the trigger isn't.
- *Benefit (architectural):* prevents the duplicated-poll explosion that motivated plan 30 G1 in the first place.

---

## Won't (this round) — explicitly parked

Listed for traceability so they aren't repeatedly proposed and re-rejected. Each has a "wake when" condition documented in the source plan.

1. **New features beyond v1 surface.** Source: CLAUDE.md "Out of scope".
2. **Visual redesign.** Source: CLAUDE.md "Out of scope".
3. **Auto-install Ollama / auto-pull models.** Source: [`29-analyzer-ollama-local.md`](features/29-analyzer-ollama-local.md). Installer/pip steps fragile; explicit user opt-in only.
4. **Auto-start TTS sidecar.** Source: [`14-tts-sidecar-coqui.md`](features/14-tts-sidecar-coqui.md). v1 scaffolding choice — user runs `npm run tts:sidecar` manually.
5. **Multi-model fan-out for Gemini analyzer.** Source: [`06-analyzer-gemini.md`](features/06-analyzer-gemini.md). One model per run; A/B via re-run.
6. **Multi-tab catch-up race resilience.** Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md). Theoretical edge — disk state is authoritative; single-user-assumed.
7. **Multi-book parallel generation.** Source: [`16-generation-stream.md`](features/16-generation-stream.md). Design constraint.
8. **Voice creation from scratch.** Source: [`22-voice-library.md`](features/22-voice-library.md). Library is read-only over the sidecar's voice catalog.
9. **Bulk pin / bulk delete in voice library.** Source: [`22-voice-library.md`](features/22-voice-library.md). Single-item v1.
10. **Live `VITE_USE_MOCKS` toggle in running UI.** Source: [`23-mock-toggle.md`](features/23-mock-toggle.md). Build-time flag only.
11. **Partial mock mode (some endpoints mocked, others real).** Source: [`23-mock-toggle.md`](features/23-mock-toggle.md). All-or-nothing on purpose.
12. **Conflict resolution for two simultaneous `state.json` writers.** Source: [`27-book-state-persistence.md`](features/27-book-state-persistence.md). Single-user-per-workspace assumption.
