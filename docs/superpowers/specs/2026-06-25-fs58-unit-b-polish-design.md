---
status: stable
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
  sentence is excluded, so a selection captured before exclusion can't split.
  (This race is near-unreachable today — a line can only be excluded via the
  script-review `flag_nonstory` op, not an inline control — so the guard is
  cheap insurance, not a load-bearing path.)

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

Two create flows `await api.createCharacter` with no `catch`. The exact current
behaviour (verified against source, correcting the original spec draft):

**(a) Sidebar "Add character" form (`manuscript.tsx`).** The form's `onSubmit`
is `async (f) => { await onCreateCharacter(f); setAddingChar(false); }`
(line ~1263), where `onCreateCharacter` is `handleCreateCharacter` (line ~597),
which `await`s `api.createCharacter`. On rejection the `await` throws, so
`setAddingChar(false)` is **skipped** — the form already stays open — but the
async `onSubmit` promise rejects **unhandled** and the user gets **no error
surface**. Fix:

- In `handleCreateCharacter`, wrap the `await` in `try/catch`; on failure
  dispatch
  `notificationsActions.pushToast({ kind: 'error', message: "Couldn't create character", dedupeKey: 'create-character' })`
  and **re-throw**.
- In the parent `onSubmit` (line ~1263), wrap in `try/catch`: call
  `setAddingChar(false)` **only** on success; on the re-thrown error do nothing
  (form stays open for retry, no unhandled rejection).

This split is deliberate: the close decision lives in the parent (`setAddingChar`),
so the catch that *suppresses* the rejection must also live there, while the
toast lives in the handler that knows the API failed.

**(b) Script-review off-roster confirm batch (`script-review-diff.tsx`).**
`runProposed` (line ~189) calls `applyProposedReattributions`, which calls
`api.createCharacter` internally. On rejection mid-batch the error propagates,
so `setConfirm(null)` and `clearReview` (line ~207-208) never run — the confirm
machinery is left wedged. Fix: wrap the `await applyProposedReattributions(...)`
in `try/catch`; on failure push the same error toast and call `setConfirm(null)`
to reset the per-op confirm machine, but **do not** `clearReview` — leaving the
review bucket lets the operator re-trigger. Partial application is safe to
re-run: `setSentenceCharacter` is idempotent for an already-applied
chapter/sentence/character (a reattribute applied before the failing
`createCharacter` simply re-applies to the same value on retry). Add a one-line
comment noting this idempotency reliance.

The toast API is the existing `notificationsActions.pushToast` from
`src/store/notifications-slice.ts` (signature `{ kind, message, dedupeKey? }`;
same pattern as `book-library.tsx`'s export-failure toast). Paired tests assert
the toast dispatch — and, for (a), that the form stays open — against a mocked
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
- No new error-recovery beyond a toast + keep-open (no automatic retry, no
  rollback of partially-applied reattributes — idempotent re-run covers it).
- Items #1119 (fs-63 auto-voice), #1120 (fs-64 cross-chapter context), and
  #1121 (hydrate-merge bug) are tracked separately and out of scope here.

## Testing

**Item 1 cannot be unit-tested in jsdom** — both gates depend on
`window.getSelection()` / `range.getBoundingClientRect()` (popover) and
`document.elementFromPoint()` (drag), none of which jsdom implements, and no
existing e2e drives the selection-popover or boundary-drag paths. So:

- **Extract the gate decision into a pure predicate** (e.g.
  `isExcludedSentence(sentences, chapterId, sentenceId)` in a small helper, or
  reuse the existing lookup) and **unit-test the predicate** — cheap, real
  coverage of the decision logic, independent of the DOM.
- **New Playwright e2e** (`e2e/manuscript-excluded-line-noedit.spec.ts`): on a
  manuscript with an excluded line, (a) selecting that line's text shows **no**
  "Assign selection to" popover (a normal line still does — positive control),
  and (b) dragging a boundary handle over the excluded line never adds the
  `sentence-candidate` class to it (a normal line does). Getting an excluded
  line in e2e: prefer seeding a mock manuscript fixture with one
  `excludeFromSynthesis` sentence; fall back to driving the script-review
  `flag_nonstory` flow if no fixture seam exists. If the drag-negative
  assertion proves flaky, keep the selection-popover e2e + predicate unit test
  and document the drag half as manual acceptance (explicitly, per the
  before-shipping checklist) rather than shipping a flaky spec.
- **Item 2 / Item 3:** Vitest component tests as described above (Item 3 also
  asserts the sidebar form stays open on a mocked rejection).
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

## Adversarial review (folded)

Round 1 (against source) found two blockers, both folded above:

- **Item 1 is not jsdom-testable** (`getSelection`/`elementFromPoint` seam, no
  existing e2e harness) — Testing now specifies a pure predicate unit test + a
  new Playwright e2e, and the "no new e2e" non-goal was removed.
- **Item 3's original "keep form open" claim was inverted** — the form already
  stays open on failure (the throw skips the close); the real defects are an
  unhandled rejection + no toast, and the fix must span both the handler and
  the parent `onSubmit`. Item 3 was rewritten around the verified behaviour.

Also folded: `runProposed` partial-failure handling (catch + toast + reset
confirm, leave review bucket; rely on `setSentenceCharacter` idempotency for
re-run), the `_roster` call-site removal (5th arg at the call site), and a
softened rationale for the `assignSelectionTo` belt-and-suspenders guard.

## Ship notes

Shipped 2026-06-25 via the fs-58 Unit B polish branch (`chore/frontend-fs58-unit-b-polish`), Closes #1122.

Five code commits (`26d1fff7..6ba895fd`):
- `26d1fff7` chore — `type="button"` on CreateCharacterForm + reattribute-vs-create routing tests (Items 4a, 2)
- `a2ce8e9e` refactor — drop unused `_roster` param from `dispatchAcceptedOps` (Item 4b)
- `cd42a67c` fix — toast + keep-open on a failed sidebar character-create (Item 3a)
- `fe433a40` fix — toast + clean reset on a failed off-roster reattribute batch (Item 3b)
- `6ba895fd` fix — no split/drag affordance on excluded manuscript lines: `isExcludedSentenceId` predicate + popover/assignSelectionTo/onMove gates + Playwright e2e (Item 1)

Built via subagent-driven development (implementer + per-task review each, opus whole-branch review: 0 Critical/Important). Spec + plan each passed one adversarial review round before execution. Deferred cosmetic test-clarity Minors (zero-risk): tighten the toast-assert regex; a non-discriminating-assertion comment in the script-review batch test; `isExcludedSentenceId` placement; e2e `toHaveCount(0)` vs `not.toBeVisible()`.
