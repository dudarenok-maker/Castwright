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

- **The modal** `src/modals/reattribute-lines.tsx` is a per-chapter card list with two hard-coded chips per row (source character vs. the freshly-split alias). Each chip click dispatches one `manuscriptActions.setSentenceCharacter` immediately. No multi-select, no arbitrary target, no undo. Opened only from the alias-unlink flow (`src/components/layout.tsx:2109-2138`, rendered `:2278-2287`).
- **Sentence model** (`src/lib/api-types.ts:4043-4057`, app-side `src/lib/types.ts:43-45`): speaker is `characterId: string`; sentence `id` restarts per chapter, so every lookup is keyed by the composite `(chapterId, id)`. Redux home `src/store/manuscript-slice.ts`; on disk `manuscript-edits.json`.
- **Reassignment reducers:** `setSentenceCharacter({chapterId, sentenceId, characterId})` (`manuscript-slice.ts:279-287`) and the per-chapter batch `setSentencesCharacter({chapterId, sentenceIds[], characterId})` (`:421-431`). Both are single-chapter.
- **Persistence:** rule `'manuscript/setSentenceCharacter'` in `src/store/persistence-middleware.ts:81-84` debounces `PUT /api/books/:bookId/state` with `slice: 'manuscript'` (whole `sentences[]`). No dedicated per-line REST endpoint.
- **Stale indicator:** every reassignment path dispatches `changeLogActions.bumpBoundaryMove({chapterId, count})`; a rendered chapter is flagged "needs regeneration" from the latest boundary-move vs. its render time.
- **Existing multi-sentence UI:** boundary drag (`manuscript.tsx:555-596`) and whole-segment reassign (`:632-646`), both dispatching the per-chapter batch. `useSentenceSelection` (`:2161-2207`) is a **single**-sentence text-range selection (used for splits). There is no checkbox / arbitrary multi-select and **no undo** anywhere for cast/line edits.

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
- Per-row **checkbox**; header **select-all**, **per-chapter select-all**, and **invert selection**; live **selected count**.
- **Filter** row with two facets: a **text substring** filter over sentence text, and — in `selection` mode where rows may span speakers — a **current-speaker** facet. A **"select all matching filter"** button applies the current selection to exactly the filtered subset. (In `character` mode every row is the same speaker, so only the text facet is meaningful.) This satisfies the #1676 acceptance verbs: *filter by current speaker*, *select-all-for-character*.
- **Virtualized / windowed row list** — the candidate list must render with windowing (only visible rows mounted). The origin case is 1184 rows on Егор, and reassigning to/from Narrator can exceed 10k rows; today's modal mounts every row and would hit a DOM/perf cliff. The reducer already accepts an arbitrary key set, so only the view needs virtualization.
- **Target-character picker** — roster dropdown. Excluded/flagged targets: the source itself (disabled); characters pending removal (excluded); and a **light confirm when the target is Narrator** (re-muddying narrator identity is the origin class of bug — worth a deliberate beat).
- Single **Apply** button: "Reassign N lines → {Target}". Apply always routes through one lightweight confirm that doubles as the count summary: "Reassign N lines from X to Y across M chapters?" (Cancel returns to the form with the selection intact.)
- Existing empty-state preserved (e.g. `character` source with zero lines, or `unlink` with no candidates).

Behavior change: select-then-apply replaces per-row immediate dispatch, so one bulk move is a single action. The `unlink` caller (and therefore feature b) inherits this UX; target defaults to the alias character in that mode.

**Non-goal (reaffirmed):** no heuristic/smart auto-selection of "wrong" lines. Selection stays manual, aided only by the ergonomics above (invert, select-all-matching, speaker facet).

**Rename note:** the current exported symbol is `ReattributeLinesModal`; renaming to `ReassignLinesModal` and switching from flat props to the `source` union requires updating the sole caller in `src/components/layout.tsx` (setReattributeModal state + the `<ReattributeLinesModal>` render at ~`2278-2287`).

### 2. Data plumbing (client-side)

New cross-chapter reducer:

```ts
manuscriptActions.setSentencesCharacterBulk({ keys: SentenceKey[]; characterId: string })
```

- Rewrites `characterId` for each `(chapterId, sentenceId)` key.
- Records the undo snapshot into the undo slot (§3): each key's **prior** `characterId`, plus the pre-apply boundary-move baseline for each affected chapter (so undo can restore stale state, not re-dirty it).
- A persistence-middleware rule for `'manuscript/setSentencesCharacterBulk'` (and for the undo action, §3) mirrors the existing `setSentenceCharacter` rule. **It must build the full `{ sentences, mergedAwayKeys }` patch shape** — the existing rule persists both, and dropping `mergedAwayKeys` would lose sentence-merge tombstones. No server change; line attribution round-trips through the generic `PUT /books/:id/state` as today.
- Change-log: dispatch `bumpBoundaryMove` **per affected chapter** so each touched chapter's stale indicator fires. One logical bulk action, but per-chapter stale bumps.
- **Persist-failure signal:** the apply/undo PUT can fail (network). Because redux would then show the move applied while disk holds the prior attribution, surface a failure toast so the user isn't silently diverged. (m7)

### 3. Undo lifecycle — one-level, book-session-scoped

```ts
manuscript.lastBulkReassign:
  | {
      moves: { chapterId: number; sentenceId: number; prevCharacterId: string }[];
      staleBaseline: { chapterId: number; /* pre-apply boundary-move state to restore */ }[];
      targetLabel: string;
    }
  | null
```

**Set / clear arbitration (fixes C1 — the set-then-clear self-defeat).** The clear is an **explicit whitelist**, not a blanket matcher over manuscript actions:
- `setSentencesCharacterBulk` **sets** the slot (reducer computes each `prevCharacterId` from current state before overwriting). It is *exempt* from the clear set — it must not clear the slot it just wrote.
- A **separate `undoBulkReassign` action** performs the restore: it rewrites each key back to `prevCharacterId`, restores the `staleBaseline` for affected chapters, and **nulls the slot**. It does **not** record a new undo record (so no undo-of-undo). This is why Undo cannot reuse the recording reducer — that was the internal contradiction.
- The slot **clears only** on a *conflicting* edit — a single-line reassign/split/boundary-move that touches one of the moved keys' chapters — or on a *second* `setSentencesCharacterBulk`. Unrelated edits elsewhere in the book do **not** discard undo (fixes M6: a stray single-line edit no longer nukes a 700-line undo).
- Undo is **book-session-scoped**, not view-scoped: it survives cast↔script navigation within the same book, and is cleared on book switch/close. It is **not** persisted, so a full reload drops it (accepted: "undoable" is satisfied by one-level in-session undo; m7).

**Stale-marking on undo (fixes M4).** Undo restores the `staleBaseline` captured at apply time rather than emitting fresh `bumpBoundaryMove`s. After undo, attribution equals the last-rendered state, so those chapters must **not** be left flagged "needs regeneration."

**Banner host (fixes m10).** The Undo affordance is a **persistent, non-auto-dismissing** banner "Reassigned N lines to {targetLabel} — **Undo**", rendered at the **layout level** (not inside the modal, which closes on apply), and tied to the book-session-scoped slot above — so it behaves identically regardless of which view opened the form.

### 4. Entry points

- **Roster/cast view** (`src/views/cast.tsx` / `src/modals/profile-drawer.tsx`): per-character "Reassign lines…" action → opens the form with `source: { kind: 'character', characterId }`.
- **Script/review view** (`src/views/manuscript.tsx`): a checkbox multi-select mode — gutter checkboxes + shift-click range — kept distinct from the existing single text-range selection used for splits. A floating "Reassign N selected…" action bar opens the form with `source: { kind: 'selection', keys }`.

### 5. Edge cases

- Source ends with zero lines: allowed; show a subtle "0 lines now" hint only. Removal/merge is feature (b) / the merge flow, not here.
- **Key drift between open and apply (m9).** Keys are `(chapterId, sentenceId)`. If a `splitSentence` or a background `hydrateFromAnalysis` runs while the modal is open, the head piece keeps its id (key resolves but its text changed) while offspring get new ids not in the selection. At apply, **re-validate each selected key against the live store**: skip keys that no longer resolve, and report the outcome ("Moved N lines; M no longer existed and were skipped") rather than silently applying a partial set.
- Empty selection: Apply disabled.
- Target eligibility: source disabled; pending-removal characters excluded; Narrator target triggers a light confirm (see §1).
- Very large moves (700+): single batch dispatch + one debounced persist; the confirm step (always shown) surfaces counts first. The list is virtualized so row count does not gate rendering.

## Testing

- **Unit (reducer):** `setSentencesCharacterBulk` rewrites `characterId` for all keys and records the correct inverse + `staleBaseline`; `lastBulkReassign` populated and **not** immediately cleared by its own dispatch (C1); `undoBulkReassign` restores prior ids, restores stale baseline, nulls the slot, and records no new undo record.
- **Undo lifecycle:** slot survives an unrelated single-line edit in a different chapter and cast↔script navigation (M6); slot **clears** on a conflicting edit (touching a moved key's chapter) and on a second bulk; slot dropped on book switch.
- **Persistence middleware:** both new actions trigger the debounced state PUT with the full `{ sentences, mergedAwayKeys }` patch (`slice: 'manuscript'`); a failed PUT surfaces a toast (m7).
- **Change-log / stale:** apply emits one `bumpBoundaryMove` per affected chapter; **undo does not re-flag** those chapters stale — it restores the baseline (M4).
- **Component:** select-all / per-chapter select-all / invert / select-all-matching / text + speaker filter / target picker (source disabled, Narrator confirm) / apply count / confirm step / empty-state; virtualized list renders a 1000+ candidate set without mounting every row (M2); undo banner appears at layout level and reverts the move; drift-skip reporting (m9).
- **Regression:** existing alias-unlink → reattribute flow still works through the generalized form (renamed `ReassignLinesModal`, `unlink` source).

## Rollout / follow-up

- Part (c) ships first (this spec).
- Part (b) — re-point alias to another character on unlink — is a separate spec that reuses `ReassignLinesModal` and adds the "Drop vs. Move to <character>" choice at unlink time.

## Adversarial-review revisions (2026-07-17)

Two independent reviewers (codebase fact-check + design attack) ran against this spec. Fact-check: all codebase assumptions confirmed. Design fixes folded in above:
- **C1 (critical):** undo set/clear was self-defeating — replaced blanket-clear with an explicit clear-whitelist; the bulk-set is exempt, and a separate `undoBulkReassign` action restores without recording (§3).
- **M2:** virtualized candidate list (origin case is 1184+ rows; Narrator 10k+) (§1).
- **M4:** undo restores the pre-apply stale baseline instead of re-flagging chapters for regeneration (§2/§3).
- **M6:** undo is book-session-scoped and cleared only by a conflicting edit or a second bulk — an unrelated single-line edit no longer discards it (§3).
- **M3/M5 (scope, user-decided):** ergonomics-only — invert, select-all-matching, speaker facet, per-speaker select-all; no heuristic auto-select (§1).
- **m7/m8/m9/m10:** persist-failure toast, target exclusions + Narrator confirm, key-drift re-validation at apply, layout-level banner host.
