# Cast: bulk-reassign attributed lines to a character (#1676, part c)

**Status:** Design approved 2026-07-17
**Issue:** #1676 — Cast editing: re-point alias on unlink (b) + bulk-reassign lines (c). This spec covers **part (c) only**; part (b) is a separate follow-up spec that will reuse the reusable form built here.
**Origin:** Night Watch (Ночной дозор) first-person-narrator mis-attribution scattered ~700+ narrator lines onto a side character (Егор). Correcting that line-by-line is not viable — this feature provides the bulk affordance.

## Goal

Let a user move many attributed lines from one character to another in a single, undoable action, reachable from both the roster/cast view and the script/review view, through **one reusable form** so the UX improves in a single place regardless of where it is invoked.

## Non-goals

- **Not** a character merge. Bulk reassign moves *lines* only; both roster rows survive. The authoritative full-cast merge (`POST /cast/merge`) is unchanged and out of scope.
- **Not** feature (b) (alias re-point on unlink) — that ships next and reuses the form.
- No new server endpoint. Line attribution already round-trips through the generic manuscript state PUT.
- No smart/heuristic auto-selection of "wrong" lines. Selection is manual (with select-all + filter helpers).

## Current behavior (what exists today)

- **The modal** `src/modals/reattribute-lines.tsx` is a per-chapter card list with two hard-coded chips per row (source character vs. the freshly-split alias). Each chip click dispatches one `manuscriptActions.setSentenceCharacter` immediately. No multi-select, no arbitrary target, no undo. Opened only from the alias-unlink flow (`src/components/layout.tsx:2109-2138`, rendered `:2278-2285`).
- **Sentence model** (`src/lib/api-types.ts:4043-4057`, app-side `src/lib/types.ts:43-45`): speaker is `characterId: string`; sentence `id` restarts per chapter, so every lookup is keyed by the composite `(chapterId, id)`. Redux home `src/store/manuscript-slice.ts`; on disk `manuscript-edits.json`.
- **Reassignment reducers:** `setSentenceCharacter({chapterId, sentenceId, characterId})` (`manuscript-slice.ts:279-287`) and the per-chapter batch `setSentencesCharacter({chapterId, sentenceIds[], characterId})` (`:421-431`). Both are single-chapter.
- **Persistence:** rule `'manuscript/setSentenceCharacter'` in `src/store/persistence-middleware.ts:81-84` debounces `PUT /api/books/:bookId/state` with `slice: 'manuscript'` (whole `sentences[]`). No dedicated per-line REST endpoint.
- **Stale indicator:** every reassignment path dispatches `changeLogActions.bumpBoundaryMove({chapterId, count})`; a rendered chapter is flagged "needs regeneration" from the latest boundary-move vs. its render time.
- **Existing multi-sentence UI:** boundary drag (`manuscript.tsx:555-596`) and whole-segment reassign (`:632-646`), both dispatching the per-chapter batch. `useSentenceSelection` (`:2161-2205`) is a **single**-sentence text-range selection (used for splits). There is no checkbox / arbitrary multi-select and **no undo** anywhere for cast/line edits.

## Design

### 1. Reusable form — `ReassignLinesModal`

Generalize `reattribute-lines.tsx` into one form driven by a discriminated `source` prop:

```ts
type ReassignSource =
  | { kind: 'character'; characterId: string }      // all sentences on this character, grouped by chapter (roster path)
  | { kind: 'selection'; keys: SentenceKey[] }       // explicit keys multi-selected in the script view
  | { kind: 'unlink'; impactedChapters: UnlinkAliasImpactedChapter[]; aliasCharacterId: string }; // today's flow; feature (b) reuses this

type SentenceKey = { chapterId: number; sentenceId: number };
```

Candidate resolution:
- `character`: filter `manuscript.sentences` where `characterId === source.characterId`, group by chapter.
- `selection`: hydrate the given keys from the live store.
- `unlink`: existing impacted-chapter candidate list.

UI additions over today's modal:
- Per-row **checkbox**; header **select-all** and **per-chapter select-all**; live **selected count**.
- **Text filter** to narrow the visible rows (client-side substring over sentence text).
- **Target-character picker** — full roster dropdown, including Narrator. Target == source is disabled.
- Single **Apply** button: "Reassign N lines → {Target}". Apply always routes through one lightweight confirm that doubles as the count summary: "Reassign N lines from X to Y across M chapters?" (Cancel returns to the form with the selection intact.)
- Existing empty-state preserved (e.g. `character` source with zero lines, or `unlink` with no candidates).

Behavior change: select-then-apply replaces per-row immediate dispatch, so one bulk move is a single action. The `unlink` caller (and therefore feature b) inherits this UX; target defaults to the alias character in that mode.

### 2. Data plumbing (client-side)

New cross-chapter reducer:

```ts
manuscriptActions.setSentencesCharacterBulk({ keys: SentenceKey[]; characterId: string })
```

- Rewrites `characterId` for each `(chapterId, sentenceId)` key.
- Records each key's **prior** `characterId` into the undo slot (§3).
- A persistence-middleware rule for `'manuscript/setSentencesCharacterBulk'` mirrors the existing `setSentenceCharacter` rule → debounced state PUT (whole `sentences[]`). No server change.
- Change-log: dispatch `bumpBoundaryMove` **per affected chapter** so each touched chapter's stale indicator fires. One logical bulk action, but per-chapter stale bumps.

### 3. Undo lifecycle ("until you leave or make another edit")

```ts
manuscript.lastBulkReassign:
  | { moves: { chapterId: number; sentenceId: number; prevCharacterId: string }[]; targetLabel: string }
  | null
```

- Set by `setSentencesCharacterBulk` (reducer computes `prevCharacterId` from current state before overwriting).
- A **persistent, non-auto-dismissing** banner/toast: "Reassigned N lines to {targetLabel} — **Undo**".
- Cleared when: any other manuscript-mutating action dispatches (`setSentenceCharacter`, `setSentencesCharacter`, `splitSentence`, boundary move, another bulk, etc.), **or** the user navigates away (view unmount clears the slot).
- **Undo** re-dispatches `setSentencesCharacterBulk` with the inverse mapping (restore each key's `prevCharacterId`), re-persists, re-bumps stale per chapter, and clears the slot. (Undo intentionally does not push its own undo record.)

### 4. Entry points

- **Roster/cast view** (`src/views/cast.tsx` / `src/modals/profile-drawer.tsx`): per-character "Reassign lines…" action → opens the form with `source: { kind: 'character', characterId }`.
- **Script/review view** (`src/views/manuscript.tsx`): a checkbox multi-select mode — gutter checkboxes + shift-click range — kept distinct from the existing single text-range selection used for splits. A floating "Reassign N selected…" action bar opens the form with `source: { kind: 'selection', keys }`.

### 5. Edge cases

- Source ends with zero lines: allowed; show a subtle "0 lines now" hint only. Removal/merge is feature (b) / the merge flow, not here.
- Sentence changed speaker between form open and apply: form reads the live store and applies only to the keys still selected.
- Empty selection: Apply disabled.
- Very large moves (700+): single batch dispatch + one debounced persist; the confirm step (always shown) surfaces counts first.

## Testing

- **Unit (reducer):** `setSentencesCharacterBulk` rewrites `characterId` for all keys and records the correct inverse; `lastBulkReassign` populated; undo restores prior ids; slot cleared on a subsequent manuscript-mutating action.
- **Persistence middleware:** the new action triggers the debounced state PUT (`slice: 'manuscript'`).
- **Change-log:** one `bumpBoundaryMove` per affected chapter.
- **Component:** select-all / per-chapter select-all / filter / target picker / apply count / confirm step / empty-state; undo banner appears and reverts the move.
- **Regression:** existing alias-unlink → reattribute flow still works through the generalized form.

## Rollout / follow-up

- Part (c) ships first (this spec).
- Part (b) — re-point alias to another character on unlink — is a separate spec that reuses `ReassignLinesModal` and adds the "Drop vs. Move to <character>" choice at unlink time.
