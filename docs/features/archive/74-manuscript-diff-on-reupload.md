---
status: stable
shipped: null
owner: null
---

# 74 — Manuscript diff viewer on re-upload

> Status: stable
> Key files: `src/lib/manuscript-diff.ts`, `src/components/manuscript-diff.tsx`, `src/store/manuscript-slice.ts`, `src/store/ui-slice.ts`, `src/views/upload.tsx`, `src/components/listen/listen-header.tsx`, `src/views/listen.tsx`
> URL surface: `#/new` (when `ui.reuploadingBookId` is set); diff modal is overlay-only (no URL of its own).
> OpenAPI ops: none — purely client-side gate. The new manuscript text is committed into `manuscript-slice` on Apply; re-analysis remains the user's separate explicit choice via the existing reanalyse confirm flow.

## Benefit / Rationale

- **User:** today, dropping a revised manuscript on a known book shows no indication of what changed — the user is forced to either re-read the entire text, trust external version control, or accept the new state blind. The diff viewer closes that gap with a side-by-side review surface that the user explicitly confirms before any slice mutation lands.
- **Technical:** the slice's `pendingReupload` slot is a "preview before apply" state machine — `previewReuploadDiff` snapshots the OLD live fields and stashes the NEW candidate without touching either, `applyReupload` promotes new → live, `discardReupload` clears the pending slot. Live fields are NEVER mutated during the preview window, so Discard is cost-free.
- **Architectural:** sentence-level LCS + character-level inner diff are pure, dependency-free helpers (`src/lib/manuscript-diff.ts`). Future surfaces that want diff visualisation (revision history, drift report, cast attribution remap) can call into the same primitives — no new npm dep on `diff`.

## Architectural impact

- **New seams:**
  - `manuscript-slice`: `pendingReupload: PendingReupload | null` field + three new actions (`previewReuploadDiff`, `applyReupload`, `discardReupload`).
  - `ui-slice`: `reuploadingBookId: string | null` field + two new actions (`startReupload`, `clearReupload`). `startReupload` also flips `stage` to `{ kind: 'upload' }` in one shot.
  - `src/lib/manuscript-diff.ts`: `splitIntoSentences`, `diffManuscripts`, `diffSentenceArrays`, `charDiff`, `summariseDiff`. All pure.
  - `src/components/manuscript-diff.tsx`: `<ManuscriptDiffModal/>` — the side-by-side diff modal, keyboard-shortcut bound (Esc → Discard, Cmd/Ctrl+Enter → Apply).
  - `src/components/listen/listen-header.tsx`: optional `onReplaceManuscript?: () => void` prop drives the new "Replace manuscript" button in the action row. Hidden when the prop isn't passed.
- **Invariants preserved:**
  - **OpenAPI source of truth (plan 24):** `Sentence` continues to come from generated `api-types.ts`. The new `PendingReupload` shape is app-domain (re-upload preview is a UI concept) and lives in `src/store/manuscript-slice.ts` only.
  - **Discriminated-union `ui.stage` (plan 00):** `reuploadingBookId` is a top-level flat field, NOT part of `stage`. The diff is an overlay; no new `Stage` variant.
  - **RTK Immer drafts (plan 26):** all new reducers mutate via Immer drafts; no spread-based rewrites.
  - **Design tokens (plan 25):** diff modal highlights use `bg-peach/40` (additions), `bg-magenta/15` (deletions), `bg-ink/[0.02]` (replace rows) — all token references, no hex literals.
  - **Mock toggle (plan 23):** the modal is rendered out of slice state; no `api.*` call is made during preview / apply / discard. `splitIntoSentences` is pure client-side. Works identically in mock + real modes.
- **Migration story:** no on-disk data shape changes. `pendingReupload` and `reuploadingBookId` are transient — explicitly OMITTED from `MANUSCRIPT_PERSIST_WHITELIST` / `UI_PERSIST_WHITELIST` so a refresh during the preview window restores the pre-preview state.
- **Reversibility:** the entire feature is additive. Removing it = drop the three new actions, the new field, and the upload-view re-upload branch. The existing `uploadComplete` reducer is untouched.

## Invariants to preserve

- `ManuscriptState.pendingReupload` in `src/store/manuscript-slice.ts` is `PendingReupload | null` — see the shape declared inline. When set, the live top-level fields (`sourceText`, `sentences`, `wordCount`, `title`, `format`) MUST NOT have been mutated by `previewReuploadDiff` — that's the "preview before apply" contract. `applyReupload` is the ONLY action that mirrors `newCandidate` into the live fields.
- `UiState.reuploadingBookId` in `src/store/ui-slice.ts` is `string | null`. Set by `startReupload`, cleared by `clearReupload`. Transient — NOT in `UI_PERSIST_WHITELIST`. The persist-config tests (`src/store/persist-config.test.ts`) include this key in their transient-keys assertion so any future whitelist drift fails noisily.
- `src/lib/manuscript-diff.ts:diffManuscripts` returns entries whose `type` is exactly `'equal' | 'insert' | 'delete' | 'replace'`. Adjacent (delete, insert) pairs MUST fold into one `replace` row — the fold-runs-into-pairwise-replace logic is what makes the side-by-side renderer line each edit up on one row. Tests pin this with the multi-sentence-replace + insert-then-delete order cases.
- `ManuscriptDiffModal`'s Esc → Discard / Cmd-Ctrl+Enter → Apply shortcuts MUST only bind when `open` is true (so dismissed modal doesn't intercept keys). Pinned by the keyboard-shortcut test cases in `src/components/manuscript-diff.test.tsx`.

## Diff algorithm

Sentence-level Myers-style LCS over normalised sentence arrays.

1. **Split.** Both old and new manuscripts pass through `splitIntoSentences`. The splitter handles paragraph breaks (blank-line separated), CRLF normalisation, terminal-punctuation-followed-by-whitespace boundaries, and quote-wrapped sentence endings. Approximation deliberate — the server-side splitter is the source of truth at analyse time; here we only need rough boundaries the user can recognise.
2. **Normalise for compare.** Internal whitespace collapsed via `s.replace(/\s+/g, ' ').trim()` so trailing spaces / double-spaces between sentences round-trip as `equal`. Visible text retains the original whitespace.
3. **LCS table.** Classic two-pointer table over the normalised sentence arrays. O(m × n) space; for a 1000 × 1000 sentence diff the table is 1MB of int32s — well under any browser limit. Perf smoke test asserts <200 ms on 1000-sentence inputs.
4. **Backtrack.** Walk from `(m, n)` to `(0, 0)` emitting `equal / delete / insert` raw entries (the standard LCS backtrack tie-breaks toward `delete`).
5. **Fold runs.** Group adjacent non-`equal` raw entries into one run; within the run pair each `delete` with the same-position `insert` to emit `replace`. Leftover deletes / inserts surface unpaired. This is what makes the side-by-side renderer show one row per logical edit instead of two stacked rows.
6. **Char-level inner diff.** For each `replace` row, the modal calls `charDiff(oldText, newText)`. Tokenise on word boundaries (`\s+|[^\s]+`), run LCS again, merge consecutive same-type spans. Highlights the changed words inside the sentence without staining shared substrings.

## Modal UX

- **Layout:** side-by-side two-column grid. Header carries the book title + counts ("12 changed, 3 added, 1 removed") + a close button. Body is a scrollable list of rows; each row aligns OLD on the left and NEW on the right.
- **Row variants:**
  - `equal`: both columns show the sentence verbatim, no highlights.
  - `insert`: left column shows an em-dash placeholder, right column highlights the inserted sentence in `bg-peach/40`.
  - `delete`: right column shows the placeholder, left column strikes through the deleted sentence in `bg-magenta/15`.
  - `replace`: both columns render the `charDiff` output — OLD column shows shared text + struck-through removals; NEW column shows shared text + highlighted additions.
- **Footer:** keyboard-hint label ("Esc discard · Ctrl+Enter apply") + Discard button + Apply button (dark variant).
- **Keyboard shortcuts:** Esc → Discard, Cmd/Ctrl+Enter → Apply. Bound at the `document` level via `useEffect` so focus inside the scrollable body still surfaces them. Only bound when `open` is true.
- **Backdrop click:** dismisses via Discard (consistent with the rest of the confirm-dialog vocabulary).

## State machine

```
                ┌─────────────────────────────────────────┐
                │  ui.reuploadingBookId = null            │
                │  manuscript.pendingReupload = null      │
                │  → normal upload / no diff modal        │
                └──────────────┬──────────────────────────┘
                               │ user clicks "Replace
                               │ manuscript" on listen view
                               ▼
                ┌─────────────────────────────────────────┐
                │  ui.reuploadingBookId = '<bookId>'      │
                │  ui.stage = { kind: 'upload' }          │
                │  manuscript.pendingReupload = null      │
                │  → upload view shows re-upload banner   │
                └──────────────┬──────────────────────────┘
                               │ api.importManuscript resolves
                               ▼
                ┌─────────────────────────────────────────┐
                │  ui.reuploadingBookId = '<bookId>'      │
                │  manuscript.pendingReupload != null     │
                │  → diff modal mounts                    │
                └──────────┬───────────────┬──────────────┘
              user clicks  │   user clicks │
                Apply      │     Discard   │
                           ▼               ▼
       ┌─────────────────────────┐   ┌───────────────────────────┐
       │ applyReupload — promote │   │ discardReupload — clear   │
       │ newCandidate into live  │   │ pendingReupload only      │
       │ fields                  │   │                           │
       │ clearReupload + navigate│   │ clearReupload + navigate  │
       │ to book's listen view   │   │ to book's listen view     │
       └─────────────────────────┘   └───────────────────────────┘
```

## Entry point

**Decision: Listen view "Replace manuscript" button.** Trade-off:

- **Listen view button (chosen):** explicit, discoverable, testable. The user opens a finished book → clicks Replace manuscript → upload view shows re-upload banner → diff modal mounts on success. One additional small button next to the existing Preview / Restructure / Share row.
- **Ambient detection (rejected):** auto-detect re-upload by matching the new candidate's title/author/series against the library. Less explicit (silent decision), harder to test (the detection logic would have to gate on slice + library state), and forces the user to confirm the metadata match before knowing they're in re-upload mode. Punted as a future affordance — if the user uploads via "Start a new book" but the metadata matches an existing book, we could surface a "Did you mean to replace?" prompt. Out of scope for v1.

## Test plan

### Automated coverage

- Vitest unit (`src/lib/manuscript-diff.test.ts`) — 22 tests: `splitIntoSentences` (5 edge cases), `diffManuscripts` identity / trivial (4), structural (5), `diffSentenceArrays` parity (1), `charDiff` (4), `summariseDiff` (2), perf smoke (1).
- Vitest unit (`src/store/manuscript-slice.test.ts`) — +5 tests for the re-upload reducers: previewReuploadDiff captures + leaves live fields untouched, falls back to current title/format, applyReupload promotes the candidate + clears the slot, applyReupload is a no-op without a pending slot, discardReupload clears without touching live fields.
- Vitest component (`src/components/manuscript-diff.test.tsx`) — 17 tests: render gate (4), row variants (4), button callbacks (4), keyboard shortcuts (5).
- Vitest view (`src/views/upload.test.tsx`) — 7 tests: first-time upload path unchanged, re-upload banner renders, previewReuploadDiff fires on import, diff modal opens with the right rows, Apply commits + navigates, Discard rolls back + navigates, Cancel re-upload returns without committing.
- Vitest persist-config (`src/store/persist-config.test.ts`) — extended to include `pendingReupload` + `reuploadingBookId` in the transient-keys assertion (so a future whitelist drift fails noisily).
- Playwright e2e (`e2e/manuscript-reupload-diff.spec.ts`) — 2 tests: end-to-end Apply (mock-mode Solway Bay → Replace manuscript → paste revised text → diff modal opens with non-empty rows → Apply commits sourceText + clears pending), end-to-end Discard (paste reject → Discard returns without committing).

### Manual acceptance walkthrough

1. **Cold boot at `#/`** → stage = `{ kind: 'books' }`, library cards visible.
2. **Click into "Solway Bay" (mock seed)** → stage = `{ kind: 'ready', view: 'listen' }`, listen header visible. Expect a "Replace manuscript" button alongside Preview / Restructure / Share in the action row.
3. **Click Replace manuscript** → stage = `{ kind: 'upload' }`, URL = `#/new`. The upload-view headline now reads "Drop the revised manuscript to see what changed" and a subline names the book. A "Cancel re-upload" link is visible.
4. **Paste a revised manuscript text and click Upload pasted text** → diff modal opens; title reads `Re-uploading manuscript for "Solway Bay" — review changes before applying`; counts row reports the delta. Each non-equal row carries a `data-testid` that distinguishes insert / delete / replace.
5. **Press Esc** → modal closes; slice's `sourceText` is unchanged; URL returns to the book's listen view.
6. **Repeat steps 3–4, then press Cmd/Ctrl+Enter** → modal closes; slice's `sourceText` now reflects the pasted text; URL returns to listen view. The "Replace manuscript" button is still available for another round.
7. **Refresh during step 4 (before Apply)** → pendingReupload is dropped (transient, not persisted); the user lands back on the listen view with the OLD manuscript intact.

## Out of scope

- **Per-sentence accept/reject UX.** v1 is binary — Apply all or Discard all. Granular per-row choice (keep this old sentence, accept that new one) is a future Could. Capture as BACKLOG item if the user requests it.
- **Cast attribution remap.** When the new manuscript is committed, the existing characterId assignments on the OLD sentences are dropped — the new sentences carry `characterId: 'narrator'` placeholders. Properly remapping speaker assignments across the diff is also a future Could (handled when re-analysis runs).
- **Re-analysis routing.** Apply commits to the slice only; the existing reanalyse confirm flow (`uiActions.reanalyse`) is the explicit follow-up the user clicks if they want the server to re-run character detection / sentence attribution against the new text.
- **Server-side diff.** No `POST /api/manuscripts/diff` endpoint; the diff is computed client-side from the slice's hydrated sentence array + the just-imported candidate text. The original BACKLOG entry mentioned a new server endpoint — punted.
- **Whitespace-only changes.** Treated as `equal` by design. If the user wants whitespace-sensitive diff (rare), expose a toggle. Future Could.

## Ship notes

Shipped 2026-05-20 · `4c8c02d` (feat(frontend): manuscript diff viewer on re-upload). Behaviour locked by the manuscript-slice re-upload tests (`previewReuploadDiff` / `applyReupload` / `discardReupload`).
