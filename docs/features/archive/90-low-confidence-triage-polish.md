---
status: stable
shipped: 2026-05-22
owner: null
---

# Low-confidence triage polish — fast nav, series-roster pickers, typeahead search

> Status: stable (BACKLOG Could #32 + #33 + #34 — shipped together as one workflow round; archived after the picker portal + dismissal polish on PR #148).
> Key files: `src/views/manuscript.tsx`, `src/components/character-search-picker.tsx`, `src/store/cast-slice.ts` (`addCharacter`), `src/lib/api.ts` (`addFromSeriesRoster`), `src/components/layout.tsx` (`priorRoster` exposed via `LayoutContext`), `src/routes/index.tsx` (ReadyRoute wiring), `server/src/routes/cast-add-from-roster.ts`.
> URL surface: indirect — exercised inside `#/books/:bookId/manuscript`.
> OpenAPI ops: new `POST /api/books/:bookId/cast/add-from-roster`.

## Benefit / Rationale

Spun off from a real low-confidence triage session on a series-Book-2 manuscript: "Councillor Linnet" was misattributed to "Lord Vane" with a Low-confidence pill, but Linnet was nowhere in the per-sentence reassign picker — she exists in the series-level roster (via `api.getSeriesRoster`), just not in the local cast for this book. Fixing one misattribution required three context switches (manuscript → ProfileDrawer → manual link → back). After this round, the same fix is keyboard-and-one-click.

- **User:** turns "find a misattributed sentence" from "scroll a 300-sentence chapter by eye" into K key presses (J for next low-confidence, K for prev) regardless of chapter length. Turns "reassign to a recurring series character missing from this book's cast" from three context switches into one picker click. Keeps the picker usable as casts grow — internal-scroll height cap + typeahead means a 30-character series-Book-N cast doesn't overflow the viewport (especially on plan 81's mobile/tablet viewports).
- **Technical:** factors the reassign UI into a single `<CharacterSearchPicker>` component consumed by all three manuscript-view picker sites (segment-row dropdown + inspector segment-level + inspector per-sentence). New `POST /cast/add-from-roster` endpoint extends the existing `cast/link-prior` family with the "create-new-character-from-prior" case the old endpoint can't cover (link-prior requires the source character to already exist locally). New `priorRoster` field on `LayoutContext` so the manuscript view and the ProfileDrawer share one `/series-roster` round-trip per book.
- **Architectural:** locks in the picker-as-component pattern for future reassign affordances (e.g. confirm-cast row regen). The `addFromSeriesRoster` server route follows the same `findBookByBookId` + series-mate guard + atomic-write contract the link-prior route established — drift between the two routes is now testable via the existing series-mate fixture pattern. The `priorRoster` context field replaces the silent "drawer-only" fetch trigger with a per-book-bookId-change fetch that any consumer can read.

## Architectural impact

**New seams added:**
- `POST /api/books/:bookId/cast/add-from-roster` — server route under `server/src/routes/cast-add-from-roster.ts`. Body: `{ targetBookId, targetCharacterId }`. Response: `{ character: Character }`. Series-mate guard matches `cast-link-prior.ts` (same `state.author + state.series + !isStandalone` rule). Side effect: appends a new row to source's `cast.json` atomically. No mutation on target's `cast.json` (no new alias info to learn — different from link-prior which DOES alias target).
- `castActions.addCharacter(c: Character)` reducer — idempotent push (skips if id already present). Defensive against double-dispatch under network retry.
- `<CharacterSearchPicker>` shared component — focused-on-open search input + arrow/Enter/Esc keyboard nav + internal-scroll height cap + optional series-roster group below local cast. Used by all three picker sites in `src/views/manuscript.tsx`.
- `LayoutContext.priorRoster: SeriesRosterEntry[]` — feeds ProfileDrawer's existing "From prior books in this series" optgroup AND the manuscript-view reassign picker. Fetched once per `bookId` change inside `Layout`.

**Invariants preserved:**
- `Stage` union shape (`src/lib/types.ts`) — unchanged.
- Per-chapter sentence-id keying for `setSentenceCharacter` / `setSentencesCharacter` — still scoped via `(chapterId, sentenceId)` (`src/store/manuscript-slice.ts:254-262`).
- `Character.matchedFrom` shape — the new `addFromSeriesRoster` populates the same fields `applyManualMatch` does (`bookId`, `characterId`, `bookTitle`, `confidence: 1`).
- ProfileDrawer's "From prior books in this series" optgroup behaviour — unchanged. Now reads `priorRoster` from `LayoutContext` instead of its own local `Map` (single source of truth).

**Migration story:** none. The new endpoint is additive. The new redux reducer is additive. No `state.json` or `cast.json` shape changes.

**Reversibility:** revert the PR. The new endpoint becomes a 404; the picker's roster section becomes inert (or, if reverted partially, falls back to local-cast-only because `onAddFromSeriesRoster` will be undefined and the roster rows are filtered out internally). No on-disk data destroyed by adding characters — they're appended, not in-place.

## Invariants to preserve

1. Picker rows in `CharacterSearchPicker` are keyed by `kind` ('local' vs 'roster') — `src/components/character-search-picker.tsx:55-58`. Don't conflate; the roster pick path has a different action (POST + materialise) than the local pick path (just dispatch).
2. The roster-name-vs-local-name dedup in `CharacterSearchPicker` — `src/components/character-search-picker.tsx:86-89`. A roster entry whose name matches a local cast member is hidden from the roster group (no duplicate visible row).
3. The J/K keyboard handler in `ManuscriptView` is guarded against firing while the user is typing in an input/textarea/contenteditable — `src/views/manuscript.tsx` low-conf nav useEffect. Don't drop the guard; the chapter filter input and the picker search input would otherwise eat the keystrokes.
4. The low-confidence threshold is `confidence != null && confidence < 0.75` in EVERY low-conf surface: header counter, SegmentRow pill, derived list for the navigator. Lock-step.
5. `LayoutContext.priorRoster` fetch fires on `bookId` change, NOT on `openProfileId` set. Don't tighten the gate without verifying every consumer.
6. The `cast/add-from-roster` route guards `sourceBookId !== targetBookId` (400) AND `same author + series + !isStandalone` (404). Same shape as `cast/link-prior` — keep them in sync if the series-mate rule changes.

## Test plan

### Automated coverage

- **Vitest unit** `src/components/character-search-picker.test.tsx` — 11 cases: focus-on-mount, substring filter on name + aliases, local/roster dedup by name, arrow + Enter for local rows, arrow + Enter for roster rows (materialise-then-assign), mouse click on roster row, Esc closes, empty-state, degrades without roster.
- **Vitest slice** `src/store/cast-slice.test.ts` (`addCharacter` describe block) — 2 cases: appends with `matchedFrom`/`voiceId`/`voiceState: 'reused'`; idempotent on existing id.
- **Vitest view** `src/views/low-confidence-nav.test.tsx` — 4 cases: K=0 disabled state, K>0 active pill + buttons, ▼ click opens inspector on first low-conf sentence, ▲ from cursor=0 wraps to LAST low-conf sentence. (J/K keyboard is exercised in e2e — jsdom doesn't model scrollIntoView reliably.)
- **Vitest view** `src/views/manuscript.test.tsx` — updated the cross-chapter reassign isolation test to drive the new picker (Change… → search → row click) instead of the old inline button list.
- **Vitest server** `server/src/routes/cast-add-from-roster.test.ts` — 11 cases: 400 on missing/same-book body; 404 on unknown source/target/cross-series/standalone/missing character; 409 on missing cast.json; 200 happy path appends with full new record + preserved voiceId + matchedFrom; target cast.json untouched; mint-unique-id on repeat call.
- **Playwright e2e** `e2e/manuscript-low-confidence-triage.spec.ts` — drives the full chain in mock mode: cold boot → upload → analyse → confirm → manuscript → ▼ button jumps to low-conf sentence → inspector opens → "Change…" opens picker → search "halloran" → click roster row → picker closes → segment header reflects new character.

### Manual acceptance walkthrough

Run in mock mode (`npm run dev`):

1. **Cold boot at `#/`** → library list visible.
2. **Start a new book** → upload a small markdown manuscript (heading + 2 chapters).
3. **Confirm metadata + author** → click "Save book and start analysis".
4. **Start analysis** on the analysing route → wait for the mocked phases (~7.6 s) → confirm-cast route loads.
5. **Click "Confirm cast and review manuscript"** → manuscript view loads.
6. **Click chapter 3 in the sidebar** ("Cold Galley" in the canned fixture).
7. **Expected:** the header reads `1 low-confidence ▲ ▼`. Two buttons (▲/▼) visible. (Mock fixture's sentence id=13 has confidence 0.62.)
8. **Press J** → manuscript scrolls so the misattributed sentence ("Cold supper it is, then.") is in view; the inspector (sticky aside at lg+, bottom-sheet at <md) opens on the segment containing it. The segment shows the "Low confidence" warning pill.
9. **In the inspector, click the "Change…" button** under "Reassign whole segment to" → the picker opens with the search input focused. Local cast (Narrator, Halloran, Marcus, Eliza) listed above a "From prior books in this series" separator with two roster entries (Captain James Halloran · Solway Bay; Mae Vance · Solway Bay).
10. **Type "vance"** → list narrows to only "Mae Vance" with the "From Solway Bay" subtitle.
11. **Press Enter (or click the row)** → mock POSTs `/cast/add-from-roster` (~120 ms); picker closes; the segment header now reads "Mae Vance"; the inspector also closes.
12. **Open the Cast view from the side nav** → "Mae Vance" appears at the end of the cast list with the "Continuity preserved" affordance (voice `v_mae_vance` retained from the roster entry; voiceState='reused').
13. **Navigate back to the manuscript view** → press K (reverse) → wraps to the last low-conf sentence in the chapter (now the next one, if any; or wraps within the remaining low-conf list).
14. **Open any sentence's per-sentence picker** (click a multi-sentence segment to open inspector → "Reassign just this one" button on any sentence) → same `CharacterSearchPicker` opens with the same local + roster groups.

## Out of scope

- Updating the SegmentInspector's rich segment-level picker styling to match the new compact picker's look. The pre-refactor markup carried tinted backgrounds + check icons for the active row; the new picker uses the compact dropdown style consistent with the SegmentRow dropdown. Visual-polish follow-up if the user misses the rich treatment.
- Server-side dedup of repeat add-from-roster calls. Each click mints a new local character; the frontend gates this on user intent (one click = one POST). If a future surface auto-fires this, add a `existingMatchedFromId` query to skip the create.
- Cross-series picker support. Today the picker only lists characters from books that pass the same-author-and-series guard. Cross-series roster is out per the broader `cast/link-prior` precedent.

## Ship notes

**Shipped:** 2026-05-22 — initial round (BACKLOG Could #32 + #33 + #34) landed pre-merge-commit-discipline so the original SHA isn't recorded inline; the post-ship polish below lands as merge commit `0a34849` (PR #148, branch `fix/frontend-reassign-picker-portal-and-dark`). Plan flipped from `active` → `stable` in this same docs PR alongside the archive move.

**Behaviour delta vs. the original spec:** none in the picker contract (typeahead, roster grouping, keyboard nav, dedup all unchanged). The post-ship polish below changes the internals (picker now portal-renders) but the user-visible contract — search-on-mount focus + arrow/Enter/Esc + roster materialise-then-assign — matches the spec.

### Post-ship polish — picker portal + dismissal + dark surface (PR #148, 0a34849)

Triaged a fresh manuscript on 2026-05-22 and hit three regressions in this
component that the original ship missed:

1. **Inspector picker was clipped.** `CharacterSearchPicker` was positioned
   `absolute` inside the inspector's `overflow-y-auto` middle (`src/views/manuscript.tsx`).
   On a tall cast (especially with the "From prior books in this series" group
   below the separator) the bottom rows fell past the inspector card and were
   unreachable — the user reported "doesn't show all characters in book or
   series." Fix: portal the picker to `document.body` via `createPortal` and
   anchor it with `position: fixed` from the trigger's `getBoundingClientRect`.
   New prop shape: `anchorRef`, `placement`, `minWidth` (replaces the per-caller
   `className` positioning override). Auto-flips to render above the trigger
   when it would spill past the viewport bottom; re-positions on `window` scroll
   (capture phase, catches nested scroll containers) + resize.
2. **Row-level dropdown closed mid-gesture.** `SegmentRow`'s `onMouseLeave`
   handler called `setMenuOpen(false)`. The popover lives outside the row's
   bounding box, so moving the cursor from the trigger into the popover fired
   the row's `mouseleave` and the menu closed before the user could click a
   character. Fix: drop the row-level `setMenuOpen(false)` and centralise
   dismissal inside the picker as a document `mousedown` listener that
   excludes both the popover and the anchor.
3. **Dark-mode contrast on the floating surface.** `bg-white` redirected to
   `#1f1b19` under `[data-theme='dark']`, only Δ12 lighter than `--canvas`.
   The popover read as bleed-through over manuscript prose. Fix: new
   `.picker-surface` rule in `src/styles.css` that lifts the dark popover to
   `#2a2520` with `rgba(244,239,236,0.18)` border, plus `shadow-float` (already
   defined for elevated overlays) and `z-50` so the popover lands above the
   inspector's sticky-aside z-stacking.

**Files touched:** `src/components/character-search-picker.tsx`,
`src/views/manuscript.tsx`, `src/styles.css`.

**New tests:** five additional cases in
`src/components/character-search-picker.test.tsx` (portal + dismissal),
two cases in `src/views/manuscript.test.tsx` (Sela-reachable + row-popover
survives pointerleave), one entry in `src/test/dark-mode-css.test.ts`
(`.picker-surface`), and a new Playwright spec
`e2e/manuscript-reassign-picker.spec.ts` (4 cases — portal contract,
pointer-crossing dismissal survival, click-outside, dark-surface computed-style
check). The visual-baseline path was tried first and dropped: the popover's
width depends on the trigger's `getBoundingClientRect` which varies between
re-renders, so a computed-style assertion on `background-color` ended up the
more durable contract for the dark-surface bit.

**Invariant 1 of this plan (kind='local' vs 'roster' row keying)** is unchanged
— the pick path branches before the portal renders, so the materialise-then-
assign flow for roster picks is unaffected.

**Reversibility:** drop `createPortal` + the new props; restore the per-caller
`className` positioning; restore `setMenuOpen(false)` in `onMouseLeave`. No
on-disk state shape changed.
