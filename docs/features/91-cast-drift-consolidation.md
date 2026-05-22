---
status: active
shipped: null
owner: null
---

# Cast Drift modal — consolidation by `(book × character × snapshot)`

> Status: active
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
  - Modal header chapter count remains *per-event*, not per-card (matches today's "N chapters flagged" surface).
  - Severity buckets (severe → moderate → mild) still order cards within a book.
  - Per-chapter Regen / Listen / Dismiss surfaces are preserved one-for-one; `onRegenerateChapter`, `onAutoQueueRegenerate`, `onDismiss` callbacks unchanged.
  - First-appearance bookId ordering preserved (anti-flicker for mid-render polls — plan 83 invariant).
- **Migration story**: none. The redesign reads the same `DriftEvent` shape the server emits; no slice state changes; no on-disk format changes. Lazy in the sense that older deployments emitting events without `snapshot` collapse to a single sentinel group per `(bookId, characterId)`.
- **Reversibility**: revert the PR. Slice and modal are self-contained; no downstream code calls the new helper or selector outside the modal + its tests.

## Invariants to preserve

- `selectDriftByBook` in `src/store/revisions-slice.ts:269` remains exported and stable-referenced — the slice's unit tests pin both the grouping behaviour and the reference-equality memoisation. Don't remove or break it.
- `groupDriftEvents` produces deterministic `groupId` strings — `(bookId, characterId, snapshotKey)` joined by `|`. Tests rely on this being a stable string the testids can substring-match.
- `DriftGroupCard` is wrapped in `React.memo` (`src/modals/drift-report.tsx`); its props must remain referentially stable across unrelated re-renders. The memoised `driftGroupsByBookView` in `layout.tsx` is what enforces this.
- Single-chapter groups skip the expand toggle and render the action row inline. Multi-chapter groups always render the toggle + bulk actions. The behavioural distinction is `group.events.length === 1`.
- The detailed `ProfileCompareCard` content stays visible by default at the top of every card — never hide it behind expand. The user explicitly called this out as the surface that makes drift detection meaningful.
- **Book-title resolution** for the per-section "BOOK" header (`src/components/layout.tsx`'s `driftGroupsByBookView` memo): fall through `bookMeta.saved[bookId]?.title` → `library.books.find(b => b.bookId === bookId)?.title` → raw `bookId`. The middle step is what keeps cross-book drift cards (book never opened this session, so `bookMeta.saved` is empty) from leaking the workspace slug into the header. Don't collapse the chain — the saved-meta step has to win when present (it carries user-edited title overrides), and the raw-bookId tail catches any book whose library entry has been pruned. Pinned by `Layout — drift modal book-title fallback (plan 91)` in `src/components/layout.test.tsx`.

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
  - Header "N chapters flagged" still counts every event, not every card.
- **Playwright e2e** (`e2e/drift-report-multibook.spec.ts`): extended with a second case that opens the modal, asserts the consolidated Eliza card with `Show 4 chapters` toggle + bulk Regen-all + exactly one toggle (since Halloran and Marcus are single-chapter groups). Fixture extended in `src/data/drift.ts` with 3 more Eliza events sharing one snapshot — exercises the real-world bug being fixed.

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

## Out of scope

- Manuscript view virtualisation (Backlog Should #1) — separate plan / branch.
- Confirm-cast + Listen chapter list virtualisation (Backlog Could #24) — separate plan / branch.
- Waveform memoisation (Backlog Could #25) — deferred; low impact.
- Server-side pagination of drift events — the flat array stays per plan 83's design; display-side consolidation is sufficient.
- Cross-character grouping — each character keeps its own card(s); the consolidation only dedupes across chapters of the *same* character.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any
behaviour delta vs. the original spec.)
