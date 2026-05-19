---
status: stable
shipped: 2026-05-19
owner: null
---

# Listen view decomposition into region sub-components (behaviour-neutral refactor)

> Status: stable — pure lift, no behaviour change. `src/views/listen.tsx` is now an orchestrator that wires the slice subscriptions + composes three dedicated region sub-components.
> Key files: `src/views/listen.tsx`, `src/components/listen/listen-header.tsx`, `src/components/listen/listen-player-region.tsx`, `src/components/listen/listen-download-section.tsx`, `src/views/listen.test.tsx` (unchanged), `e2e/listen-playback.spec.ts` (unchanged), `e2e/listen-resume.spec.ts` (unchanged), `e2e/mini-player-features.spec.ts` (unchanged), `e2e/download-tiles.spec.ts` (unchanged), `e2e/cover-framing.spec.ts` (unchanged)
> URL surface: `#/books/:bookId/listen` — unchanged
> OpenAPI ops: unchanged

## Benefit / Rationale

- **User:** none. This is a pure structural refactor; no user-facing affordance moves, changes shape, or changes wiring. Tests prove the invariant — none were modified.
- **Technical:** Wave 3 of the v1.4.0 alpha-launch slate (streaming-link tile, editorial notes, share-clip) lands new sub-features on the listen view. Each future feature now mounts its JSX inside the matching region sub-component instead of injecting into a 1136-line file, so three parallel branches no longer collide on the same hot file.
- **Architectural:** locks in the region boundaries (header / player+markers / downloads+queue) before they get crusted over by feature growth. Once a file passes ~1000 lines, the next refactor cost is much higher than the next-N-features cost; doing it now de-risks the next round at a friction point that's still cheap to renegotiate.

## Architectural impact

- **New seams**: three sub-component files under `src/components/listen/`:
  - `listen-header.tsx` — exports `ListenHeader` (cover-art + title + author/narrator line + stats + action buttons including the inline "Change cover" hover affordance) AND `ListenMetadataEditor` (the bottom book-meta editor card with cover Replace/Regenerate). Both are dumb-render — all state lives on the parent.
  - `listen-player-region.tsx` — exports `ListenPlayerRegion` (markers sidebar from plan 53 + the capped, scrollable chapter list that drives the global mini-player when a row is clicked). `MarkersPanel` and `ChapterListenRow` are internal helpers.
  - `listen-download-section.tsx` — exports `ListenDownloadSection` (listener-app tiles + export queue + the three "Or download a file" tiles). `DownloadCard`, `ListenerApps`, `ListenerAppCard`, and `ExportQueue` are internal helpers.
- **Invariants preserved** (cross-cutting plans 23/24/25/26/27 + listen-view plan 18):
  - The mock toggle (plan 23) — the regions are pure presentational components; the parent still owns every `useAppSelector` for the dispatching seams (`exports.byBookId[bookId]`, `listenProgressActions`). Per-row resume bookmarks (plan 47) still subscribe via `useAppSelector(selectListenProgress(bookId))` inside `ChapterListenRow` because that's where the read was before — the lift moved the call site, not the slice access.
  - OpenAPI types (plan 24) — `Chapter`, `Character`, `Voice`, `ListenerApp`, `ExportQueueItem`, `EditableBookMeta`, `EditableBookMetaField`, `ListenMarker`, `CoverFraming` all still import from their source-of-truth modules. No type duplication.
  - Design tokens (plan 25) — every Tailwind class lifted byte-identically; no hex literals introduced.
  - RTK Immer (plan 26) — no reducer code touched.
  - Book-state persistence (plan 27) — the metadata editor's `onCommit` / `onCancel` / `onEditField` props still receive the same handlers from `ListenRoute`. No persistence behaviour changes.
- **Migration**: none — this is a code-level lift only. No on-disk state shape, no API contract, no user data.
- **Reversibility**: trivial — `git revert` of this commit restores the monolithic `listen.tsx`. No follow-up cleanup needed in any other module.

## Invariants to preserve

The acceptance criterion FROM the BACKLOG entry was the test suite — no test file was modified in this PR, so any behaviour drift would have surfaced as a test failure. Specific structural rules a future refactor on this seam must not break:

1. **The DOM order on `#/books/:bookId/listen` stays**: header section, markers panel (when present), chapter-list section, listener-apps section, export-queue section, downloads section, metadata editor section, modals. Same z-order, same `mb-12` spacing rhythm.
2. **Every `data-testid` from the original file is preserved verbatim**: `listen-cover-art`, `listen-cover-art-image`, `listen-change-cover`, `open-export-modal`, `open-restructure`, `listen-chapters-scroll`, `chapter-row-<id>`, `listen-markers-panel`, `listen-marker-<id>`, `listen-marker-seek-<id>`, `listen-marker-delete-<id>`, `listener-app-<id>`, `listener-app-action-<id>`, `download-tile-m4b`, `download-tile-mp3-zip`, `download-tile-streaming`, `meta-description`, `meta-cover-replace`, `meta-cover-regenerate`, `meta-cancel`. Renaming any of these constitutes a behaviour change.
3. **The orchestrator owns the state** — `useState` for `coverPickerOpen`, `coverPickerInitialTab`, `coverOverride`, `framingOverride`, `coverLoadFailed`, `exportModal` all live in `ListenView`. Region sub-components receive computed props + handlers; they do not own dispatchers.
4. **Two modals stay in the orchestrator** — `ExportAudiobookModal` + `CoverPicker` are state-driven from `ListenView`. Lifting them into a region would require duplicating the modal-state plumbing.
5. **`MarkersPanel` and `ChapterListenRow` keep their `useAppSelector(selectListenProgress(bookId))` calls** — that's the slice subscription the original code performed. Moving it to the parent and threading via props would re-render the whole chapter list on every progress write (~1 Hz from the mini-player), which is the regression this preservation guards against.
6. **`git diff main -- src/views/listen.tsx` is dominated by deletions** — at ship time, 52 additions (imports + composition JSX) vs 869 deletions. Any future change that flips that ratio is no longer a behaviour-neutral lift; treat it as a new feature and route it through a regular review.

## Test plan

### Automated coverage

This refactor's test plan IS the existing suite — every behaviour locked by tests on `main` must remain green WITHOUT modifying any test file. Concretely:

- **Vitest unit** (`src/views/listen.test.tsx`) — 36 tests covering header reads from `bookMeta`, cover-art overlay + framing, metadata-editor wiring (typing / dirty-gate / save+cancel), listener-app coming-soon state + live-tile open-modal wiring, download-tile coming-soon + live-tile wiring, the mocked-preview-banner count, Play-from-start dispatch, excluded-chapter filtering, chapter-list scroll cap, per-row Copy-link + Remove dispatch, metadata-editor cover-button picker routing.
- **Playwright e2e**:
  - `e2e/listen-playback.spec.ts` — opens the listen view, clicks chapter row 2, asserts audio src + paused flip.
  - `e2e/listen-resume.spec.ts` — Resume pill visibility against `listen-progress` slice state.
  - `e2e/mini-player-features.spec.ts` — speed picker, markers add/seek, sleep-timer toggle pill.
  - `e2e/download-tiles.spec.ts` — M4B + MP3 ZIP tile pre-fill, streaming tile remains coming-soon.
  - `e2e/cover-framing.spec.ts` — covers the CoverPicker upload + frame flow exercised from the listen view's metadata editor.

If ANY spec change is required, the refactor is not behaviour-neutral and must be backed out. The spec set above is the litmus test for the lift.

### Manual acceptance walkthrough

Sanity check; the automated suite is the contract.

1. **Cold-boot at `#/`** → library renders. Click any book in `ready` state.
2. **`#/books/<id>/listen`** → header (cover + title + meta + buttons), chapter list, listener apps, export queue, downloads, metadata editor — same DOM order as `main`.
3. **Click "Play from the start"** → mini-player loads chapter 1 of the listenable set (excluded chapters skipped).
4. **Click a chapter row** → mini-player loads that chapter.
5. **Add a marker via the mini-player** → markers panel appears above the chapters section; click a marker seeks the player.
6. **Click "Export audiobook" pill** → ExportAudiobookModal opens on the Download tab.
7. **Click an M4B / MP3 ZIP download tile** → modal opens with the format pre-filled.
8. **Click a listener-app live tile (PocketBook / Voice / Smart AudioBook / BookPlayer / Audiobookshelf)** → modal opens in tile mode.
9. **Edit a metadata field** → header updates live (live overlay via `selectEffectiveMeta`); Save+Cancel gain the dirty state.
10. **Click cover hover button OR meta-cover-replace / meta-cover-regenerate** → CoverPicker opens on the corresponding tab (none / upload / search).

## Out of scope

- Any user-visible behaviour change. This is a pure lift.
- The mini-player itself (lives in `src/components/mini-player.tsx`, mounted by `Layout` — not on the listen view).
- The two modals (`ExportAudiobookModal`, `CoverPicker`) — they stay on the parent; their state machines are unchanged.
- Lifting the orchestrator's `useState` and `useAppSelector` calls into the regions — that would couple state ownership to layout, which is what motivates this lift in reverse.
- New tests for the three sub-components — they're internal-only structural splits with no new behaviour to assert. The existing 36-test Vitest spec + the 13-test e2e spread already pin everything they expose.

## Ship notes

Shipped 2026-05-19 on branch `refactor/frontend-listen-view-decompose`.

- `src/views/listen.tsx`: 1136 lines → 319 lines (52 insertions / 869 deletions vs `main`). Pure-deletion ratio holds.
- Three new sub-component files under `src/components/listen/` totalling 1042 lines (header 407, player+markers 279, downloads+queue 356). The expansion comes from explicit prop interfaces — same JSX, slightly more typing seams.
- Zero spec modifications. `npm run verify` green; 1046 Vitest tests + 36 listen-specific Vitest tests + 13 listen-touching e2e tests + 1 revision-diff e2e test all passed without touching any test file.
- Gates Wave 3 of the v1.4.0 slate (streaming-link tile, editorial notes, share-clip) — those three branches now rebase against three smaller files instead of one monolith.
