---
status: draft
issue: 1122
area: fs
type: chore
---

# fs-58 Unit B polish — excluded-line split/drag disable + minor cleanups

Deferred polish and review-Minors from fs-58 Unit B (LLM Script Review;
#1040, PR #1118). Bundled into one chore (#1122) so they aren't lost. All
four items are frontend-only and unit-testable; none change the analyzer or
server contract.

## Background

fs-58 Unit B added two new script-review op kinds, `reattribute` and
`flag_nonstory`. An excluded (`flag_nonstory`) sentence is rendered with
`line-through opacity-50` and a one-tap **include** toggle, but it keeps its
`absIdx` slot in the chapter's `sentences[]` array (excluding is a display +
synth-filter flag, not a structural removal). Because the slot survives, the
two manuscript edit affordances — the selection-popover split and the
boundary-drag reassign — still fire on excluded lines. The synth pipeline
drops the line regardless, so this is **UX-only**: offering edit affordances on
a line that won't be synthesised is misleading.

The remaining three items are deferred review-Minors from the Unit B PR.

## Scope

Branch: `chore/frontend-fs58-unit-b-polish`, cut from `main`.

### Item 1 — Disable split + drag on excluded lines

File: `src/views/manuscript.tsx`.

Both edit affordances are gated so they never act on a sentence whose
`excludeFromSynthesis` is set. A re-include toggle remains the only action
offered on an excluded line (unchanged).

**(a) Selection-popover split.** Selecting text inside a sentence raises the
"Assign selection to…" popover; assigning either reassigns the whole sentence
or splits it into pieces (`assignSelectionTo`). Gate at two points:

- At the `<SelectionPopover>` render site, suppress the popover when the
  selected sentence is excluded — pass `sel={null}` in that case. The selected
  sentence is resolved from `selection.sentenceId` against the current
  chapter's `sentences[]` (the same per-chapter scoping `assignSelectionTo`
  already uses, because sentence ids restart per chapter).
- Belt-and-suspenders: early-return in `assignSelectionTo` if the resolved
  sentence is excluded, so a stale selection captured before exclusion can't
  split.

**(b) Boundary drag.** Dragging a boundary handle highlights a *candidate*
sentence (`candidateSentenceIdx`) and, on drop, reassigns a contiguous run of
sentences to a character (`commitBoundaryMove`). Gate in the `pointermove`
`onMove` handler: when the hovered sentence (`data-sentence-idx`) is excluded,
do **not** set it as `candidateSentenceIdx`. The `sentence-candidate` highlight
and the drop target then skip excluded lines.

Out of scope (and called out so the limit is explicit): a reassign *run* that
merely **contains** an excluded line in its interior is unavoidable — the run
is a contiguous `[start, end]` index range — and is harmless, because the
excluded line won't synthesise regardless of which character it's attributed
to. Only the **drop target / candidate** is gated, not run membership.

Remove the `follow-up:` comment at `src/views/manuscript.tsx` (currently
adjacent to the excluded-line re-include toggle) once both gates land.

### Item 2 — Component test for reattribute-to-existing

File: `src/components/create-character-form.test.tsx`.

`CreateCharacterForm` routes its primary button to `onReattributeExisting`
(not `onSubmit`) when the typed name matches a `rosterByName` entry — the
branch that maps to a direct `setSentenceCharacter` reassign with **zero**
`api.createCharacter` calls. The logic is sound and indirectly covered today;
add an explicit case:

- Render with a `rosterByName` containing `{ "alice": { id: "c1", name: "Alice" } }`.
- Type `Alice`, assert the button label becomes `Reattribute to «Alice»`.
- Click it; assert `onReattributeExisting` was called with `"c1"` and
  `onSubmit` was **not** called.
- Symmetric assertion for a non-matching name: `onSubmit` fires, label reads
  `Create character`, `onReattributeExisting` not called.

### Item 3 — Catch + toast on a failed create

Files: `src/views/manuscript.tsx`, `src/components/script-review-diff.tsx`.

Two create flows `await api.createCharacter` with no `catch`, so a failed
`POST /cast/create` rejects unhandled — the form/confirm UI is left mid-flow
with no error surface:

- `handleCreateCharacter` (`manuscript.tsx`) — the sidebar "create character"
  path. Wrap the `await` in `try/catch`; on failure dispatch
  `notificationsActions.pushToast({ kind: 'error', message: "Couldn't create character", dedupeKey: 'create-character' })`.
  Keep the form open for retry (do not advance/close on failure).
- `runProposed` (`script-review-diff.tsx`) — the off-roster reattribute confirm
  batch runs `applyProposedReattributions`, which calls `api.createCharacter`
  internally. Wrap the `await`; on failure push the same error toast. Only
  clear `confirm` / the review bucket on success.

The toast API is the existing `notificationsActions.pushToast` from
`src/store/notifications-slice.ts` (same pattern as `book-library.tsx`'s
export-failure toast). Paired tests assert the toast dispatch against a mocked
`api.createCharacter` rejection.

### Item 4 — Trivia

- `src/components/create-character-form.tsx` — add explicit `type="button"` to
  both buttons (defensive against accidental form submission if the component
  is ever nested in a `<form>`).
- `src/lib/script-review-apply.ts` — drop the unused `_roster` parameter from
  `dispatchAcceptedOps`, and its argument at the call site in
  `script-review-diff.tsx`. (`planApply` keeps its `roster` param — it is used
  there to gate on-roster reattributes; only the dispatch helper's copy is
  dead.)

## Non-goals

- No change to exclusion semantics, the synth filter, or the `flag_nonstory`
  op itself.
- No new e2e spec — all four items are unit-testable, and the existing
  `e2e/script-review.spec.ts` already covers the confirm flow end to end.
- Items #1119 (fs-63 auto-voice), #1120 (fs-64 cross-chapter context), and
  #1121 (hydrate-merge bug) are tracked separately and out of scope here.

## Testing

- **Item 1:** Vitest component test on `manuscript.tsx` — an excluded sentence
  yields no `SelectionPopover` for a selection within it, and the
  `pointermove` candidate detection skips it. (jsdom can drive the selection /
  pointer paths the existing manuscript tests already exercise.)
- **Item 2 / Item 3:** Vitest component tests as described above.
- **Item 4:** Covered transitively; `type="button"` asserted in the Item 2
  render, `_roster` removal is a pure refactor caught by `typecheck` + existing
  `script-review-apply` tests.
- Full gate: `npm run verify` (typecheck + unit + e2e + build) before push.

## Acceptance

1. On an excluded line, selecting text shows **no** "Assign selection to…"
   popover, and dragging a boundary onto it does **not** highlight it as a drop
   candidate. The **include** toggle still works.
2. A non-excluded line behaves exactly as before (popover + drag unchanged).
3. A simulated `POST /cast/create` failure surfaces an error toast and leaves
   the create/confirm UI open rather than failing silently.
4. `CreateCharacterForm` with a name matching the roster calls
   `onReattributeExisting` (0 `api.createCharacter` calls); a novel name calls
   `onSubmit`.
5. `npm run verify` is green.

## Ship notes

_(filled at ship time: date, commit SHA; close #1122.)_
