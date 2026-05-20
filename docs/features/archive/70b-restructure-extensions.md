---
status: stable
shipped: 2026-05-19
owner: null
---

# Plan 70b — Chapter restructure feature extensions

> Status: stable
> Key files: `src/components/restructure-chapters-button.tsx`, `src/components/restructure-chapters-panel.tsx`, `src/views/restructure.tsx`, `src/views/manuscript.tsx`, `src/components/listen/listen-header.tsx`, `src/lib/api.ts`, `server/src/workspace/restructure.ts`, `server/src/routes/chapters-restructure.ts`
> URL surface: `#/books/<id>/manuscript` (new entry point), `#/books/<id>/restructure` (new sticky toolbar + per-row exclude + refresh button)
> OpenAPI ops: `POST /api/books/{bookId}/chapters/exclude`, `POST /api/books/{bookId}/chapters/refresh-titles`

## Benefit / Rationale

- **User:** Five concrete usability wins on top of plan 70a's bug fixes:
  1. **Restructure chapters is now discoverable BEFORE generation.** A "Restructure chapters" button now lives in the Manuscript view header next to "Approve cast & start generating" — same component, same hash route as the post-generation Listen-view entry.
  2. **Long-manuscript ergonomics fixed.** The "Merge selected" toolbar in the Restructure view is now sticky-pinned to the viewport (`position: sticky, top: 0`), so scrolling past chapter 5 in a 30-chapter manuscript leaves the merge / cancel-reorder / apply-reorder actions in reach.
  3. **Exclude chapter affordance.** Per-row Exclude / Include toggle on every chapter; clicking flips `Chapter.excluded` server-side via a new `POST /chapters/exclude` endpoint. Excluded rows render with `opacity-60` + `line-through` + the existing-merge-checkbox disabled. Audio files are preserved (soft-hide invariant) — un-excluding restores the chapter without re-rendering.
  4. **Refresh chapter names button.** Re-parses the source manuscript to recover parser-aligned titles for any chapter still carrying a generic "Chapter N" auto-title, then opportunistically promotes the first non-dialogue sentence to the title if it passes the title-case + length heuristics. User-customised titles ("The Verdict") are never clobbered.
  5. **Plan 70a `warnings` channel surfaced.** The pushed-but-previously-invisible advisory strings (orphan recovery counts, empty-chapter prune counts, generic-title renumber counts) now toast on the Restructure view via `notificationsActions.pushToast`. The user sees "Recovered N orphaned sentences", "Removed N empty chapter(s)", "Renumbered N auto-generated chapter title(s)" inline after each operation.
- **Technical:** Extracts a shared `<RestructureChaptersButton>` component used by both entry points. Adds two server endpoints + two pure transforms (`applyExclude`, `applyRefreshTitles`) that funnel through the same `applyRestructure` scaffolding (per-book lock, atomic state.json write, in-memory hint refresh, audio op application, analysis-cache invalidation). Both endpoints reuse `postProcessRestructure` so the prune-empty + renumber-generic-titles passes from plan 70a apply uniformly — every restructure op tidies up the same way.
- **Architectural:** Establishes the `warnings: string[]` consumer pattern on the Restructure view. Future structural ops can publish to the same channel; the toast layer is wired once. The button extraction also sets the precedent for future cross-view feature buttons — keep them in `src/components/` if they're shared, with both `default` and `compact` variants ready for tight toolbars.

## Architectural impact

- **New seams.**
  - `src/components/restructure-chapters-button.tsx` — shared button mounted in two places (Listen + Manuscript). `data-testid="open-restructure"` stays stable so existing Listen-view e2e selectors keep resolving.
  - `RestructurePanelProps.onExclude?: (chapterId, excluded) => void | Promise<void>` — optional prop; Exclude button only renders when wired. Back-compat for any future modal mount that doesn't want the affordance.
  - `RestructurePanelProps.onRefreshTitles?: () => void | Promise<void>` — same optional pattern.
  - `applyExclude` and `applyRefreshTitles` in `server/src/workspace/restructure.ts` — pure transforms; both feed through `postProcessRestructure` (auto-prune + generic-title renumber).
  - `api.excludeChapters(bookId, chapterIds, excluded)` and `api.refreshChapterTitles(bookId, options)` in `src/lib/api.ts` — both real + mock implementations.
- **Invariants preserved.**
  - Soft-hide invariant on `Chapter.excluded` (audio preserved, ids unchanged, generation queue skips per `src/views/generation.tsx:360`).
  - Sticky toolbar uses `bg-canvas/95 backdrop-blur-sm` — design tokens via CSS custom properties, no hex literals (CLAUDE.md token rule).
  - User-customised chapter titles preserved through the refresh-titles parser-aligned pass — the existing `GENERIC_TITLE_RE` detector gates rewrites, so anything non-generic stays put. (Plan 78 added an explicit sticky `titleOverridden: boolean` flag that runs BEFORE the regex gate, so user renames stick even when the new title happens to look generic. The regex stays as backup for legacy chapters without the flag — see [78-chapter-rename.md](../78-chapter-rename.md).)
  - `data-testid="open-restructure"` preserved across the button extraction so plan-51 / plan-60 selectors still resolve.
- **Migration story.** None. New endpoints are additive; existing books work unchanged.
- **Reversibility.** Pure frontend / route additions. Revert is a single git revert of the diff.

## Invariants to preserve

1. `<RestructureChaptersButton />` carries `data-testid="open-restructure"`. Cited at `src/components/restructure-chapters-button.tsx`.
2. Refresh-titles parser-aligned pass only fires when the current title matches `GENERIC_TITLE_RE` from plan 70a. Cited at the `if (!GENERIC_TITLE_RE.test(c.title.trim())) return c;` guard in `applyRefreshTitles`.
3. First-line promotion rejection rules (in this order): chapter has no first sentence → skip; first sentence starts with `"`, `'`, `"`, `"`, `'`, `'`, `—`, or `–` → reject (dialogue); length > 80 → reject; ends with `.` or `!` → reject; doesn't pass `looksLikeTitle` → reject. Cited at `applyRefreshTitles` first-line block.
4. `applyExclude` and `applyRefreshTitles` both flow through `postProcessRestructure`. Sticky audit: any new structural op should do the same.
5. Excluded chapters cannot be merge-selected — the checkbox is `disabled` when `chapter.excluded === true`. Cited at `restructure-chapters-panel.tsx` `<input type="checkbox" disabled={busy || !selectable || isExcluded}>`.

## Test plan

### Automated coverage

- `src/components/restructure-chapters-button.test.tsx` — renders full / compact labels; fires onClick. 3 cases.
- `src/components/restructure-chapters-panel.test.tsx`:
  - New: 5 cases under `exclude per-row (plan 70b)` — Exclude button render gating, Exclude/Include label flip, onExclude flag inversion, merge checkbox disabled when excluded, `data-excluded` styling assertion.
  - New: 3 cases under `Refresh chapter names button (plan 70b)` — render gating, confirm dialog, onRefreshTitles fires after confirm.
  - Existing 10 cases stay green.
- `server/src/routes/chapters-restructure.test.ts`:
  - New: 7 cases under `POST /:bookId/chapters/exclude (plan 70b)` — flips flag, un-excludes, preserves audio, 400 on missing/empty chapterIds, 400 on non-boolean excluded, 400 on missing chapter id, runs post-process pass.
  - New: 4 cases under `POST /:bookId/chapters/refresh-titles (plan 70b)` — first-line promotion happy path, dialogue rejection, length cap rejection, user-custom title preservation, useFirstLine:false bypass, 404 on missing book.
  - New: 1 case `does not run the renumber post-pass on split` — pins plan 70a's split bypass invariant.
  - Existing 23 cases stay green.

### Manual acceptance walkthrough

1. **Cold boot** → open an analyzed book → land on `#/books/<id>/manuscript`. Expected: "Restructure chapters" button visible in the header next to "Approve cast & start generating".
2. **Click "Restructure chapters"** → land on `#/books/<id>/restructure`. Toolbar at top.
3. **Scroll past chapter 5** in the chapter list → toolbar stays pinned to viewport top (sticky).
4. **Click Exclude** on chapter 3 → row gets `opacity-60` + `line-through`; sentence-count line gains "· excluded"; merge checkbox dims out. Toast: empty (operation was clean).
5. **Click Include** on the same chapter → row returns to normal.
6. **Mid-list merge** of chapters 2 + 3 on a book with auto-titles → merge happens; toast surfaces "Renumbered N auto-generated chapter title(s)" if any of the subsequent chapters had generic titles.
7. **Click Refresh chapter names** → confirm dialog → Apply. Any chapter with a generic title gets re-derived (parser-aligned or first-line promotion). Toast: "Re-derived N chapter titles from the source manuscript." or "Promoted N first-sentence candidate(s) to chapter titles."

## Out of scope

- **Explicit "Remove empty (N)" button** in the toolbar. Auto-prune (plan 70a) handles the symptom; user can trigger any merge to flush the cleanup. Reopen if users ask for explicit cleanup.
- **Bulk-exclude-via-selection.** Per-row only for v1 (matches the symmetric "single row Exclude" affordance most users expect). Add an "Exclude selected" alongside "Merge selected" if usage warrants.
- **Hard-delete on exclude.** Audio preserved as soft-hide; un-excluding restores without re-rendering. A "Remove audio" sub-action could land separately.
- **Back-button context tracking.** The Restructure view's "Back" button still routes to Listen regardless of source. Acceptable for v1 — user can use the top-bar tabs. Reopen if confusing.
- **Excluded rows in reorder.** Currently still draggable (the drag-handle isn't disabled). Acceptable since the renumber pass handles whatever order they end up in. Disable if it confuses users.

## Ship notes

Shipped 2026-05-19 via PR #63 (merge commit `ecc86fa`). Three commits:
- `bca3046` feat(frontend,server): five-part feature bundle (button extraction, sticky toolbar, exclude affordance, refresh chapter names, warnings toast).
- `68f2536` test(e2e): regenerated manuscript view visual baselines for the new Restructure button placement.
- `35b57b2` fix(frontend): post-merge correction — the sticky toolbar was anchoring at `top-0 z-10` but the global `<TopBar>` is also `sticky top-0 z-40 h-16`, so the toolbar was getting parked behind the top-nav and invisible to the user. Reported on an 88-chapter book where the user scrolled to chapter 86+ and couldn't reach Merge. Fix: `top-16 z-30`.

Built on [plan 70a](70a-restructure-bugfix.md). Together they close the chapter-restructure surface for the v1.4.0 slate — Manuscript-view entry is the discoverability win, sticky toolbar + per-row exclude + refresh-titles cover the long-manuscript ergonomics the user originally hit, and the `warnings` toast surfaces the silent-recovery messages from 70a so future regressions are visible inline.
