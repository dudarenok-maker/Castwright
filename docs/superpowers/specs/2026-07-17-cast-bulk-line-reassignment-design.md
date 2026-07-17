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
- **Stale indicator:** every reassignment path dispatches `changeLogActions.bumpBoundaryMove({chapterId, count})`. The "needs regeneration" flag is computed in `src/views/generation.tsx:1313-1321` as an **OR** of two independent signals: (a) a **precise** per-sentence diff of render-time speakers vs. live `characterId` (`stale-chapters.ts:59` `isChapterReassignedSinceRender`), which by design reads *not-stale* after a reassign-then-undo; and (b) an **always-on time-based** clause (`stale-chapters.ts:33` `isChapterStaleFromReassign`) comparing the newest `boundary_move` `.at` timestamp vs. `audioRenderedAt`. The time-based clause is not a fallback — it runs unconditionally, so a move-then-undo still reads stale via that clause. The change-log slice is **append/head-only** (`change-log-slice.ts:59-131`): `unshift`, in-place head `bumpBoundaryMove`, wholesale hydrate/reset — **no edit-or-delete-by-id**, so a `boundary_move` cannot be surgically reverted.
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
- **Virtualized / windowed row list** — the candidate list must render with windowing (only visible rows mounted), using `@tanstack/react-virtual` (already a dependency). The origin case is 1184 rows on Егор, and reassigning to/from Narrator can exceed 10k rows; today's modal mounts every row and would hit a DOM/perf cliff. The reducer already accepts an arbitrary key set, so only the view needs virtualization.
- **Selection model (must be render-independent).** Selection is a `Set<compositeKey>` (`"${chapterId}:${sentenceId}"`) held over the **full resolved candidate list** in component state — never derived from mounted DOM rows. Every bulk-select op (select-all, per-chapter select-all, invert, select-all-matching-filter) folds over that in-memory list. If selection were read from rendered rows, virtualization would silently limit "select all" to the visible window — defeating the exact 1184/10k-row cases virtualization exists for.
- **Target-character picker** — roster dropdown. Excluded/flagged targets: the source itself (disabled) and a **light confirm when the target is Narrator** (re-muddying narrator identity is the origin class of bug — worth a deliberate beat). *(There is no "pending removal" state on a `Character` in part (c) — marking a character for removal is a feature (b) concept — so no pending-removal exclusion is implemented here; see Round 3.)*
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
- Records the undo snapshot into the undo slot (§3): each key's **prior** `characterId`. (No stale/boundary-move baseline is captured — see §3 for why that would be both unimplementable and unnecessary.)
- A persistence-middleware rule for `'manuscript/setSentencesCharacterBulk'` (and for the undo action, §3) mirrors the existing `setSentenceCharacter` rule. **It must build the full `{ sentences, mergedAwayKeys }` patch shape** — the existing rule persists both, and dropping `mergedAwayKeys` would lose sentence-merge tombstones. No server change; line attribution round-trips through the generic `PUT /books/:id/state` as today.
- Change-log: apply dispatches `bumpBoundaryMove` **per affected chapter** so each touched chapter's stale indicator fires (one logical bulk action, per-chapter stale bumps). Undo does **not** touch `bumpBoundaryMove`; instead it appends one `appendLogEvent` ("Reverted reassignment of N lines") so the audit trail is symmetric without rewriting history (m2).
- **Persist-failure signal (scoped).** The apply/undo PUT can fail (network); redux would then show the move applied while disk holds prior attribution. The flush path currently **swallows** failures (`persistence-middleware.ts:295-297`, `console.error` only) for *all* slices. To avoid a book-wide behavior change, scope the new failure toast to the two bulk action types (apply/undo) — do not broaden it to every persisted slice. (m7)

### 3. Undo lifecycle — one-level, book-session-scoped

```ts
manuscript.lastBulkReassign:
  | {
      moves: { chapterId: number; sentenceId: number; prevCharacterId: string }[];
      targetLabel: string;
    }
  | null
```

**Set / clear arbitration (fixes C1 — the set-then-clear self-defeat).** The clear is an **explicit whitelist**, not a blanket matcher over manuscript actions:
- `setSentencesCharacterBulk` **sets** the slot (reducer computes each `prevCharacterId` from current state before overwriting). It is *exempt* from the clear set — it must not clear the slot it just wrote.
- A **separate `undoBulkReassign` action** performs the restore: it rewrites each key back to `prevCharacterId` and **nulls the slot**. It does **not** record a new undo record (so no undo-of-undo). This is why Undo cannot reuse the recording reducer — that was the internal contradiction.
- **Clear on conflict is key-granular, not chapter-granular (M-2).** The slot clears only when a later single-line edit (reassign / split / boundary-move) touches a **moved key** — i.e. membership in the stored `moves` key set — or on a *second* `setSentencesCharacterBulk`. A split of a moved line counts as a conflict (it renumbers that key). Edits to *untouched sibling lines in the same chapter* do **not** clear undo. Chapter-granularity was rejected: the origin bug spans nearly every chapter, so a chapter-level predicate would let almost any later edit nuke the undo — reintroducing the very M6 failure this is meant to fix.
- Undo is **book-session-scoped**, not view-scoped: it survives cast↔script navigation within the same book. The slot lives in the manuscript slice, but the book-transition reducers mutate fields individually and will **not** clear a new field automatically — so `lastBulkReassign = null` must be added explicitly to **`manuscript.reset`, `hydrateFromBookState`, and `hydrateFromAnalysis`** (M-1). Missing any of these leaks Book A's undo (with A's composite keys) onto Book B, where clicking Undo would rewrite colliding B keys — silent cross-book corruption. It is **not** persisted, so a full reload drops it (accepted: "undoable" is satisfied by one-level in-session undo).

**Stale-marking on undo — accept stale-after-undo (revises M4).** Undo does **not** try to un-flag chapters. On the precise stale path, restoring each `prevCharacterId` makes live == rendered, so the chapter auto-reads not-stale for free. On the always-on time-based clause (§Current-behavior), the chapter remains flagged for regen — which is **exactly** how every existing reassign-then-undo already behaves (the append-only change-log has no way to revert a `boundary_move`, and building one is a separate concern touching all edit paths, out of scope here). Consistent, honest for a one-level undo, and zero new machinery. (The earlier `staleBaseline` idea was both unimplementable against this change-log and unnecessary.)

**Banner host (fixes m10).** The Undo affordance is a **persistent, non-auto-dismissing** banner "Reassigned N lines to {targetLabel} — **Undo**", rendered at the **layout level** (joining the existing `WhatsNewBanner` / `UpdateNotifierBanner` / `ToastStack` region — non-dismiss action toasts already have precedent), not inside the modal (which closes on apply), and tied to the book-session-scoped slot above — so it behaves identically regardless of which view opened the form.

### 4. Entry points

- **Roster/cast view** (`src/views/cast.tsx` / `src/modals/profile-drawer.tsx`): per-character "Reassign lines…" action → opens the form with `source: { kind: 'character', characterId }`.
- **Script/review view** (`src/views/manuscript.tsx`): a checkbox multi-select mode — gutter checkboxes + shift-click range — kept distinct from the existing single text-range selection used for splits. A floating "Reassign N selected…" action bar opens the form with `source: { kind: 'selection', keys }`.

### 5. Edge cases

- Source ends with zero lines: allowed; show a subtle "0 lines now" hint only. Removal/merge is feature (b) / the merge flow, not here.
- **Key drift between open and apply (m9).** Keys are `(chapterId, sentenceId)`. If a `splitSentence` or a background `hydrateFromAnalysis` runs while the modal is open, the head piece keeps its id (key resolves but its text changed) while offspring get new ids not in the selection. At apply, **re-validate each selected key against the live store**: skip keys that no longer resolve, and report the outcome ("Moved N lines; M no longer existed and were skipped") rather than silently applying a partial set.
- Empty selection: Apply disabled.
- Target eligibility: source disabled; Narrator target triggers a light confirm (see §1). (No pending-removal exclusion — the cast model has no such state in part (c); see Round 3.)
- Very large moves (700+): single batch dispatch + one debounced persist; the confirm step (always shown) surfaces counts first. The list is virtualized so row count does not gate rendering.

## Testing

- **Unit (reducer):** `setSentencesCharacterBulk` rewrites `characterId` for all keys and records the correct inverse; `lastBulkReassign` populated and **not** immediately cleared by its own dispatch (C1); `undoBulkReassign` restores prior ids, nulls the slot, records no new undo record, and appends one revert audit event (m2).
- **Undo lifecycle (key-granular, M-2):** slot survives an edit to an **untouched sibling line in a touched chapter** and cast↔script navigation; slot **clears** on an edit to a **moved key** (incl. a split of a moved line) and on a second bulk.
- **Cross-book clearing (M-1):** slot is nulled by `manuscript.reset`, `hydrateFromBookState`, and `hydrateFromAnalysis` — a bulk in Book A then opening Book B shows no stale banner and cannot rewrite B's keys.
- **Persistence middleware:** both new actions trigger the debounced state PUT with the full `{ sentences, mergedAwayKeys }` patch (`slice: 'manuscript'`); a failed **apply and a failed undo** PUT each surface a toast, scoped to the bulk actions (m7, S-0).
- **Selection/virtualization (M2, m-1):** select-all / invert / select-all-matching operate over the full candidate set with only a small window mounted (e.g. invert with 20 of 1000 rows mounted selects 980); virtualized list renders a 1000+ set without mounting every row.
- **Stale-after-undo (accepted):** apply emits one `bumpBoundaryMove` per affected chapter; after undo, a render-mapped chapter reads not-stale via the precise diff, while the time-based clause behaves identically to an existing single-line reassign-then-undo (no new un-flagging machinery).
- **Component:** per-chapter select-all / text + speaker filter / target picker (source disabled, Narrator confirm) / apply count / confirm step / empty-state; undo banner appears at layout level and reverts the move; drift-skip reporting (m9).
- **Regression:** existing alias-unlink → reattribute flow still works through the generalized form (renamed `ReassignLinesModal`, `unlink` source).

## Rollout / follow-up

- Part (c) ships first (this spec).
- Part (b) — re-point alias to another character on unlink — is a separate spec that reuses `ReassignLinesModal` and adds the "Drop vs. Move to <character>" choice at unlink time.

## Adversarial-review revisions (2026-07-17)

### Round 1 (fact-check + design attack against the initial spec)
- **C1 (critical):** undo set/clear was self-defeating — replaced blanket-clear with an explicit clear-whitelist; the bulk-set is exempt, and a separate `undoBulkReassign` action restores without recording (§3).
- **M2:** virtualized candidate list (origin case is 1184+ rows; Narrator 10k+) (§1).
- **M4:** undo stale handling — *later revised in round 2 (see below); the round-1 `staleBaseline` fix was wrong.*
- **M6:** undo is book-session-scoped and cleared only by a conflicting edit or a second bulk (§3).
- **M3/M5 (scope, user-decided):** ergonomics-only — invert, select-all-matching, speaker facet, per-speaker select-all; no heuristic auto-select (§1).
- **m7/m8/m9/m10:** persist-failure toast, target exclusions + Narrator confirm, key-drift re-validation at apply, layout-level banner host.

Round-1 caveat: the fact-check ran against the *original* spec and did not cover mechanisms introduced by the round-1 fixes — notably the stale subsystem's OR-semantics — which round 2 then caught.

### Round 2 (attacking the round-1 fixes; both reviewers converged)
- **C-1 (critical) — dropped `staleBaseline` entirely.** The stale flag is an OR of a precise per-sentence diff and an *always-on* time-based `boundary_move` clause; the change-log is append/head-only with no revert-by-id, so the round-1 baseline was unimplementable — and unnecessary, since the precise path already reads not-stale after undo. Now: **accept stale-after-undo**, matching every existing reassign-then-undo (§3). This also removed most of the added complexity, so the design is proportionate.
- **M-1 (major) — cross-book leak.** The undo slot must be explicitly nulled in `reset`, `hydrateFromBookState`, **and** `hydrateFromAnalysis`; book switch is a partial hydrate, not a slice reset (§3).
- **M-2 (major) — clear is now key-granular, not chapter-granular** (chapter-level barely fixed M6 for the book-wide origin case) (§3).
- **m-1/m-2:** selection pinned to a `Set<key>` over the full candidate set (virtualization-safe); undo appends its own revert audit event (§1/§2).
- **Confirmed sound:** apply→undo persistence ordering (single per-slice last-wins debounce); virtualization lib already present (`@tanstack/react-virtual`); layout-level banner host has precedent.

### Round 3 (attacking the implementation plan; two Premium reviewers converged)
- **Pending-removal exclusion dropped as vacuous.** No `pendingRemoval`/`markedForRemoval` field exists on `Character` anywhere in `src`; marking a character for removal is a feature (b) concept, so in part (c) the exclusion would be a silent no-op behind a speculative cast. Removed from §1/§5 target eligibility. If feature (b) introduces a removal-in-flight state, it re-adds the exclusion where the field actually lives.
- **Plan-level fixes (do not change this spec's design):** per-chapter select-all must be actually rendered (a "Select all in chapter…" facet) not just a dead helper; the modal delete must land in the *same* commit that rewires its caller (no non-compiling intermediate tree); `SentenceKey` has one home (the manuscript slice) and the modal imports it; the change-log revert event uses a valid `ChangeLogType` (not `'edit'`); and several test harnesses were corrected (real `ui.stage` bookId, real `renderDrawer` prop forwarding, disambiguated "Select all" queries, a drift test that keeps the stale key selected). These live in the plan doc.
