---
status: stable
shipped: 2026-05-22
owner: null
---

# Cast Drift modal — consolidation + book-title + per-character scope

> Status: stable
> Key files: `src/modals/drift-report.tsx`, `src/store/revisions-slice.ts`, `src/components/layout.tsx`, `src/data/drift.ts`
> URL surface: drift banner on `#/books/<id>/cast` → modal overlay
> OpenAPI ops: `GET /api/revisions?bookIds=…` (consumed; this plan does not change the contract)

## Benefit / Rationale

- **User:** the modal no longer hangs the browser when the cross-book poller has accumulated ~300 events. A character whose voice profile changed once now shows as a single card with all affected chapters listed inside (collapsed by default), instead of N redundant cards repeating the same before/now diff.
- **Technical:** DOM node count for a 300-event modal drops from ~7,200 to ~200 in the typical case. `createSelector`-memoised slice projection + `React.memo`-wrapped row components + memoised prop builder in `layout.tsx` cut the per-interaction render cost; unrelated re-renders (foreign book's analyser tick, cast slice mutation in the active book) no longer rebuild the drift Map.
- **Architectural:** introduces `selectDriftGroupsByBook` + `groupDriftEvents` helper in `src/store/revisions-slice.ts` — a reusable, snapshot-fingerprinted grouping primitive that other future drift surfaces (history view, chapter-row badges) can reuse. The redesign preserves the detailed `ProfileCompareCard` content (user explicitly called this out as load-bearing for the feature's meaning).

## Architectural impact

- **New seams / extension points**:
  - `DriftGroup` interface and `selectDriftGroupsByBook` selector exported from `src/store/revisions-slice.ts`.
  - `groupDriftEvents(events)` pure helper for callers that need ad-hoc grouping (tests, future history surface).
  - `DriftBookGroupView` exported from `src/modals/drift-report.tsx` for layout-level callers.
  - Snapshot fingerprint format (private `snapshotKey` in `revisions-slice.ts`) — derived from the same fields the compare card reads; changing the compare card's fields means the fingerprint must extend in lockstep.
- **Invariants preserved**:
  - Severity buckets (severe → moderate → mild) still order cards within a book.
  - Per-chapter Regen / Listen / Dismiss surfaces are preserved one-for-one; `onRegenerateChapter`, `onAutoQueueRegenerate`, `onDismiss` callbacks unchanged.
  - First-appearance bookId ordering preserved (anti-flicker for mid-render polls — plan 83 invariant).
- **Migration story**: none. The redesign reads the same `DriftEvent` shape the server emits; no slice state changes; no on-disk format changes. Lazy in the sense that older deployments emitting events without `snapshot` collapse to a single sentinel group per `(bookId, characterId)`.
- **Reversibility**: revert the PR. Slice and modal are self-contained; no downstream code calls the new helper or selector outside the modal + its tests.

## Invariants to preserve

- `selectDriftByBook` in `src/store/revisions-slice.ts:269` remains exported and stable-referenced — the slice's unit tests pin both the grouping behaviour and the reference-equality memoisation. Don't remove or break it.
- `groupDriftEvents` produces deterministic `groupId` strings — `(bookId, characterId, snapshotKey)` joined by `|`. Tests rely on this being a stable string the testids can substring-match.
- `DriftGroupCard` is wrapped in `React.memo` (`src/modals/drift-report.tsx`); its props must remain referentially stable across unrelated re-renders. The memoised `driftGroupsByBookView` in `layout.tsx` is what enforces this.
- Single-chapter groups skip the expand toggle and render the action row inline. Multi-chapter groups always render the toggle + bulk actions. The behavioural distinction is `group.chapters.length === 1` (was `group.events.length === 1` pre-correction — see "Post-ship correction" below).
- The detailed `ProfileCompareCard` content stays visible by default at the top of every card — never hide it behind expand. The user explicitly called this out as the surface that makes drift detection meaningful.
- **Book-title resolution** for the per-section "BOOK" header (`src/components/layout.tsx`'s `driftGroupsByBookView` memo): fall through `bookMeta.saved[bookId]?.title` → `library.books.find(b => b.bookId === bookId)?.title` → raw `bookId`. The middle step is what keeps cross-book drift cards (book never opened this session, so `bookMeta.saved` is empty) from leaking the workspace slug into the header. Don't collapse the chain — the saved-meta step has to win when present (it carries user-edited title overrides), and the raw-bookId tail catches any book whose library entry has been pruned. Pinned by `Layout — drift modal book-title fallback (plan 91)` in `src/components/layout.test.tsx`.
- **Per-character entry scopes the modal**: clicking the amber drift pill on a cast row opens the modal scoped to that single character — both `src/views/cast.tsx` per-row click handlers (table + card layouts) dispatch `uiActions.openDriftReportForCharacter(c.id)` instead of the unscoped `setShowDriftReport(true)`. The top "Voice drift detected in N chapters" banner stays unscoped (calls `onShowDrift()` with no argument). The modal honours `filterCharacterId` by pruning each book's groups to that one character + surfaces a "Showing X · Show all characters" banner that calls `onClearFilter` to drop the filter without closing. `setShowDriftReport(false)` clears the filter so the next top-banner open starts on the full list. Race-condition guard: when the filter points at a character with zero events (drift dismissed between dispatch and render), the modal returns null instead of an empty shell. Pinned by `DriftReportModal — per-character filter (pill-click entry)` (3 cases) in `src/modals/drift-report.test.tsx` and `CastView drift pill — per-character entry to the Voice Drift Detector` in `src/views/cast.test.tsx`.

## Test plan

### Automated coverage

- **Vitest slice** (`src/store/revisions-slice.test.ts`): 9 new cases plus the original `selectDriftByBook` cases.
  - `selectDriftByBook` returns a stable reference when the drift array is unchanged (memoisation invariant).
  - `selectDriftGroupsByBook` collapses N same-snapshot events into 1 group.
  - Two snapshots for the same character produce two groups (mid-book cast edit).
  - Events within a group sort by `chapterId` ascending.
  - `severityCounts` + `topSeverity` aggregate correctly across the group.
  - `factors[]` is the union of `event.factor` across the group.
  - `allAutoQueueable` flips false when any event lacks `autoQueueable`.
  - Stable reference on unchanged input (memoisation invariant for the new selector).
- **Vitest modal** (`src/modals/drift-report.test.tsx`): 9 new cases plus the 14 original cases (all green, button-label assertions updated for the shorter per-chapter labels).
  - N same-snapshot events collapse to one card with the compare table rendered once.
  - Two-snapshot character splits into two cards.
  - Single-chapter group renders inline action row (no expand button, no Regen-all).
  - Multi-chapter group keeps the strip collapsed by default; click "Show N chapters" reveals the rows.
  - `Regenerate all` fires `onRegenerateChapter` once per chapter in the group.
  - `Auto-regen all` only present when every event is `autoQueueable`; fires once per chapter when present.
  - `Dismiss all` fires `onDismiss` once per event in the group.
  - Header "N chapters flagged" counts unique chapters (post-correction — see "Post-ship correction" below; the original plan shipped per-event counts and was corrected later the same day).
- **Playwright e2e** (`e2e/drift-report-multibook.spec.ts`): extended with a second case that opens the modal, asserts the consolidated Eliza card with `Show 4 chapters` toggle + bulk Regen-all + exactly one toggle (since Halloran and Marcus are single-chapter groups). Fixture extended in `src/data/drift.ts` with 3 more Eliza events sharing one snapshot — exercises the real-world bug being fixed.
- **Book-title fallback** (`src/components/layout.test.tsx`, PR #141): 1 case `Layout — drift modal book-title fallback (plan 91)` seeds two drift books — one with both `bookMeta.saved` + `library.books`, one with library-only — asserts saved-meta wins for the first book, library-title surfaces for the second, neither raw bookId leaks into the modal as a title.
- **Per-character filter** (`src/modals/drift-report.test.tsx`, PR #145): 3 cases under `DriftReportModal — per-character filter (pill-click entry)`: (a) `filterCharacterId` prunes non-matching cards + the banner names the filtered character + header count reflects the filtered view, (b) the "Show all characters" button calls `onClearFilter` exactly once, (c) returns null (not an empty modal shell) when the filter points at a character with zero events (race-condition guard).
- **Pill dispatch shape** (`src/views/cast.test.tsx`, PR #145): 1 case `CastView drift pill — per-character entry to the Voice Drift Detector` renders the amber drift pill in both responsive layouts (desktop table + mobile card) and asserts both invoke `onShowDrift(characterId)` — the unscoped form `onShowDrift()` is reserved for the top-banner entry.

### Manual acceptance walkthrough

Run `npm start` (or `npm run dev` for HMR) in mock mode (`VITE_USE_MOCKS=true`, on by default in `.env.development`).

1. Open `http://localhost:5173/#/`. Library view appears.
2. Click "Solway Bay". Stage → `{ kind: 'ready', bookId: 'sb' }`.
3. Navigate to `#/books/sb/cast`. The amber drift banner reads **"Voice drift detected in 6 chapters"**.
4. Click the banner. Modal opens; header reads **"6 chapters flagged"**.
5. Under the **Severe** severity bucket, ONE card for Eliza shows **"4 chapters · 4× severe"** with a **Show 4 chapters** toggle. The compare table is visible at the top of the card showing `voice af_sarah → af_sarah` (or whichever fields differ).
6. Click **Show 4 chapters**. The strip expands to show CH 02, CH 07, CH 08, CH 09 each with their own Regenerate / Listen / Dismiss buttons.
7. Under **Moderate**, a single-chapter card for Captain Halloran (CH 05) renders its action row inline — no expand toggle, no Regen-all.
8. Under **Mild**, a single-chapter card for Marcus (CH 04).
9. Click **Regenerate all** on the Eliza card. The modal closes; the regen flow handles each chapter.
10. **Scale stress test**: extend the fixture to 300 events (or hit a real backend that has accumulated drift), reopen the modal. Interactions should feel responsive — no multi-second freezes. Chrome DevTools Performance panel: no scripting blocks > 50 ms on a modern laptop.

**Per-character pill scope (PR #145).** From the same cast view as step 3 above:

11. On the cast table row for Eliza (or any character with a drift count), an amber pill renders next to the name showing the chapter count. Title attribute reads "N chapters with voice drift".
12. Click the pill (NOT the top banner). Modal opens with an amber banner at the top reading **"Showing drift for Eliza only · Show all characters"**. Only Eliza's card is visible — Halloran and Marcus do NOT render.
13. Click **Show all characters**. The amber banner disappears; the unfiltered descriptive paragraph returns; all three cards become visible.
14. Close the modal (X or backdrop), then click the top banner again. Modal opens unscoped — no per-character banner, full list visible. The filter does NOT persist across close/reopen.

**Book-title fallback (PR #141).** Requires a multi-book session with drift events spanning at least two books, ideally one that hasn't been opened in this session:

15. Open any book whose drift modal has events from BOTH the active book AND another book the user hasn't visited this session (e.g. via cross-book bulk poll). Trigger the modal via the top banner.
16. The per-section **BOOK** headers render the workspace-scan title (e.g. "The Hollow Tide") for both books — neither shows the raw slug `shannon-messenger__the-hollow-tide__keeper-of-the-lost-ci…`. If the active book has user-edited title overrides in `bookMeta.saved`, those win over the library scan title.

## Out of scope

- Manuscript view virtualisation (Backlog Should #1) — separate plan / branch.
- Confirm-cast + Listen chapter list virtualisation (Backlog Could #24) — separate plan / branch.
- Waveform memoisation (Backlog Could #25) — deferred; low impact.
- Server-side pagination of drift events — the flat array stays per plan 83's design; display-side consolidation is sufficient.
- Cross-character grouping — each character keeps its own card(s); the consolidation only dedupes across chapters of the *same* character.

## Ship notes

Plan 91 shipped in four increments. The original consolidation landed first; book-title fix, per-character scope, and the per-event → per-chapter count correction landed as three follow-up PRs after user-surfaced bugs.

- **PR #119** (merge `fd9c218`, 2026-05-21): the original consolidation — `selectDriftGroupsByBook` + `groupDriftEvents` + the `(book × character × snapshot)` card collapse. DOM-node count for a 300-event modal dropped from ~7,200 to ~200. Detailed `ProfileCompareCard` preserved per the user's load-bearing-content callout. Behaviour matched the plan body as written.
- **PR #141** (merge `b6537e5`, 2026-05-22): book-title fallback fix. The per-section "BOOK" header was rendering the raw workspace slug for cross-book drift cards when the book wasn't in this session's `bookMeta.saved`. Resolved by adding the `library.books` middle step in `src/components/layout.tsx`'s `driftGroupsByBookView` memo. Invariant added under "Invariants to preserve"; case in `src/components/layout.test.tsx`.
- **PR #145** (merge `d2fac41`, 2026-05-22): per-character pill scope. Clicking the amber drift pill on a cast row used to open the full unscoped modal — user had to scroll to find the character. Added `ui.driftReportCharacterFilter` state field + `openDriftReportForCharacter` / `clearDriftReportCharacterFilter` actions; `DriftReportModal` now accepts `filterCharacterId` + `onClearFilter`; an in-modal "Showing X · Show all characters" banner is the escape hatch. Closing the modal also clears the filter. Invariant added under "Invariants to preserve"; 4 paired cases across `src/modals/drift-report.test.tsx` (3) + `src/views/cast.test.tsx` (1).
- **PR #170** (merge `636e23f`, 2026-05-22): per-chapter rollup — see "Post-ship correction" below. `groupDriftEvents` gained `chapters: DriftChapterEntry[]`; the chapter strip dedupes multi-factor events on the same chapter to one row; banner + badge + toggle counts switch from per-event to per-chapter; bulk regen iterates chapters not events; bulk + per-row Dismiss still iterate every factor-event so the chapter doesn't resurface. 4 slice cases + 2 modal cases added. Overturned the original "Modal header chapter count remains per-event" invariant (dropped from the Invariants section).

The first three follow-ups were additive (new invariants under "Invariants to preserve"). PR #170 is the only one that retracted an original invariant; its scope is documented under "Post-ship correction" below.

## Post-ship correction (2026-05-22)

The original plan preserved one invariant that turned out to be wrong: *"Modal header chapter count remains per-event, not per-card."* The server emits one `DriftEvent` per drift factor (voice / gender / ageRange / 4 tone metrics / attributes), so a single chapter that fires three factors produced three events. The "{N} chapters flagged" label was counting those events — a Marlow chapter with `voice + warmth + attributes` drift contributed +3 to the banner. The chapter strip also rendered one row per event, so the same CH NN appeared three times in a row.

User-visible bug: the Voice Drift Detector showed "30 chapters flagged across 2 books" when only ~10 unique chapters were actually flagged, and the per-character "Show chapters" expander listed each chapter 2-3× depending on how many factors fired.

Correction:

- `groupDriftEvents` now derives a `chapters: DriftChapterEntry[]` rollup per group — one entry per unique `chapterId`, with the underlying factor-events folded into `eventIds[]`, `factors[]`, per-chapter `topSeverity`, and a `representativeEvent` for the listen-back probe.
- The chapter strip renders `group.chapters.map(...)` instead of `group.events.map(...)`.
- Modal banner total, per-book "{N} flagged" badge, card chapter count, and the Show/Hide toggle label all switch to `group.chapters.length`.
- `group.severityCounts` is now per-chapter top-severity counts (so a single severe+moderate+mild chapter contributes +1 to "severe", not +1 to every bucket).
- `single`-chapter optimisation uses `group.chapters.length === 1`, not `events.length`.
- Regen-all + Auto-regen-all loop over `group.chapters` (was `group.events`) — one regen per chapter, not per factor.
- Dismiss-all still loops over `group.events` because every factor-event must be dismissed individually so the chapter doesn't resurface on the next poll. Per-row Dismiss now does the same loop internally via `entry.eventIds`.
- `group.events[]` stays exported — used by Dismiss-all and by any future surface that wants the raw event stream.
- Per-factor labels remain visible at the card scope via the existing `group.factors` chip strip.

Pinned by 4 new cases in `src/store/revisions-slice.test.ts` (`selectDriftGroupsByBook — per-chapter rollup (multi-factor dedup)`) + 2 new cases in `src/modals/drift-report.test.tsx` (`dedupes multi-factor events on the same chapter to one row + unique-chapter header count` and `single-row Dismiss on a multi-factor chapter dismisses every underlying factor-event`). Landed via PR #170, merge `636e23f`.
