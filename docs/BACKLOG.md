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

**Counts as of 2026-05-17:** Must 0 · Should 2 · Could 14 · Won't 10

---

## Must — blocks v1 ship or hurts existing users

_All v1-blocker items shipped 2026-05-17 (plans 22a, 27, 32, 39)._

---

## Should — important, not blocking ship

### 1. Dark mode

Source: [`25-design-tokens.md`](features/25-design-tokens.md) (was Won't #6; promoted 2026-05-17 per user prioritisation).

- *What:* Add a `[data-theme="dark"]` token override block in `src/styles.css` for every `--peach`/`--ink`/`--magenta`/`--canvas`/`--ink-soft` token. Add a theme toggle in the top bar (`src/components/layout.tsx`). Persist preference via the `ui` slice (rides on the redux-persist wiring shipped 2026-05-17 — extend `UI_PERSIST_WHITELIST` with the new `theme` field in `src/store/index.ts`) and read `prefers-color-scheme` as the first-visit default.
- *Acceptance:* Toggling the affordance flips every surface (library, upload, analysing, confirm, ready, listen, voices, modals) without a single hex literal needing change. The grep test in plan 25 still returns zero hits. Refresh preserves the user's choice. New Playwright spec captures `toHaveScreenshot()` for both themes on the five core stages (extends the baseline harness shipped 2026-05-17 as `e2e/visual.spec.ts`).
- *Key files:* `src/styles.css` (dark-token block); `tailwind.config.ts` (already references `var(--token)`, no changes expected); `src/components/layout.tsx` (toggle); `src/store/ui-slice.ts` (theme field); `src/store/index.ts` (extend `UI_PERSIST_WHITELIST`); `docs/features/25-design-tokens.md` (drop the "out of scope" bullet, add a "Dark mode" invariants section).
- *Depends on:* none structural — the visual-baselines harness (`e2e/visual.spec.ts`) is already in place; dark-mode adds a second-theme baseline pass on top.
- *Benefit (user):* the single most-requested visual polish missing from v1; 9 PM listening sessions stop blasting white.

### 2. Bulk-apply library sync on confirm-cast

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

Specific items someone might reasonably re-propose. Each carries a *Why parked* (the v1 design or operational constraint) and a *Wake when* (the trigger that makes us reopen). The broad "v1 scope freeze" and "no visual redesign" are covered by CLAUDE.md "Out of scope" and don't need restating here — this list is for tracked-specific decisions only.

### 1. Auto-install Ollama / auto-pull models

Source: [`29-analyzer-ollama-local.md`](features/29-analyzer-ollama-local.md).

- *Why parked:* installer + `ollama pull` are platform-specific and fragile under the OneDrive workspace path; the README addendum + explicit user opt-in is the v1 contract.
- *Wake when:* Ollama upstream ships a stable cross-platform headless installer, OR a CI / dev-container path needs one-command bring-up. Likely two separate items then.

### 2. Auto-start TTS sidecar

Source: [`14-tts-sidecar-coqui.md`](features/14-tts-sidecar-coqui.md).

- *Why parked:* sidecar cold-start is ~10–20 s and competes with the analyzer Ollama for the 8 GB VRAM budget; explicit `npm run tts:sidecar` keeps the timing + VRAM tradeoff visible to the user. v1 scaffolding choice.
- *Wake when:* sidecar cold-start drops below ~2 s AND VRAM gating is no longer load-bearing (e.g. dedicated GPU per process). At that point, auto-launch from `cd server && npm run dev` is reasonable.

### 3. Multi-model fan-out for Gemini analyzer

Source: [`06-analyzer-gemini.md`](features/06-analyzer-gemini.md).

- *Why parked:* one model per run keeps cost predictable and the SSE stream simple; A/B comparison today is two sequential runs.
- *Wake when:* a real product use case for "render the same chapter under two models side-by-side in one view" emerges. The audio-layer a/b audition (plan 20) covers the listening-side intent today.

### 4. Multi-tab catch-up race resilience

Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md).

- *Why parked:* disk `state.json` is authoritative + single-user-per-workspace, so two tabs on the same book never compete on writes. Tab B catches up by re-reading state on focus.
- *Wake when:* multi-user collab on a shared workspace becomes a real use case. Pairs with Won't #10 — both wake under the same trigger.

### 5. Multi-book parallel generation

Source: [`16-generation-stream.md`](features/16-generation-stream.md).

- *Why parked:* single 8 GB GPU can't hold two XTTS/Kokoro instances; the generation queue is serial per workspace by design.
- *Wake when:* either cloud TTS becomes the dominant generation path so VRAM is no longer the bottleneck, or the user adds a dedicated per-book GPU. Neither is on the v1 roadmap.

### 6. Voice creation from scratch

Source: [`22-voice-library.md`](features/22-voice-library.md).

- *Why parked:* the library is a read-only view over the sidecar's voice catalog (28 Kokoro + Coqui's bundled set). Authoring a voice means a separate Coqui voice-cloning UI that's its own product surface.
- *Wake when:* user wants to author / fine-tune voices in-app rather than dropping pre-made reference `.wav`s into the sidecar's `voices/` folder. Likely depends on a much bigger Coqui training pipeline first.

### 7. Bulk pin / bulk delete in voice library

Source: [`22-voice-library.md`](features/22-voice-library.md).

- *Why parked:* v1 voice library has fewer than 50 entries (28 Kokoro + ~12 Coqui defaults); per-voice click is fast enough.
- *Wake when:* user-created voices push the library past ~50 entries and per-voice clicking becomes painful (track via user complaint, not preemptive). Pairs with Won't #6 — without an author flow there's nothing to bulk-operate on.

### 8. Live `VITE_USE_MOCKS` toggle in running UI

Source: [`23-mock-toggle.md`](features/23-mock-toggle.md).

- *Why parked:* the mock layer swaps the entire `api` module at module-load via the env flag; flipping at runtime would need a different architecture (e.g. mock middleware around the api object).
- *Wake when:* demo / QA flow requires mid-session real↔mock flipping. Today rebuilding with `VITE_USE_MOCKS=true` takes 5 s — building the runtime toggle would cost more than the friction it removes.

### 9. Partial mock mode (some endpoints mocked, others real)

Source: [`23-mock-toggle.md`](features/23-mock-toggle.md).

- *Why parked:* all-or-nothing keeps the type contract clean — every component imports from `api.*` without knowing which side it's hitting.
- *Wake when:* a specific endpoint needs mock-while-rest-real (e.g. mocking a flaky third-party while testing everything else live). The cheapest path then is likely a per-endpoint override in the mock layer, not the architecture change above.

### 10. Conflict resolution for two simultaneous `state.json` writers

Source: [`27-book-state-persistence.md`](features/27-book-state-persistence.md).

- *Why parked:* single-user-per-workspace assumption; file locking is advisory at best on Windows network shares.
- *Wake when:* multi-user collab on a shared workspace becomes a real use case. Pairs with Won't #4 — both wake under the same trigger.
