# Script-review: per-chapter/per-type summary review + create-once speakers

- **Status:** draft
- **Date:** 2026-07-20
- **Feature area:** fs-58 (script review)
- **Related:** `docs/superpowers/specs/2026-07-09-script-review-persistence-design.md`,
  `reference_silent_hydration_throw_blanks_script_review` (the #1735 hydration fix that
  first surfaced this at whole-book scale)

## Problem

Running an entire book through **Review Script** produces on the order of a thousand
proposed ops. The current approval UI (`src/components/script-review-diff.tsx`,
`ScriptReviewDiff`) presents them as one flat modal grouped only by **op class**
(merge, strip_tag, …) — one card per op, with a per-op checkbox and a per-class
"select all". At whole-book scale this is unreviewable: a thousand cards in eight
giant sections, with chapter identity reduced to a tiny `ch3 · #118` corner tag.
There is no way to see "what's proposed in chapter 5" or to confirm at a granularity
a human can actually reason about.

Second, **new-speaker creation is per-line**. When `reattribute` ops propose a
speaker not yet in the cast, `handleApply` queues one `CreateCharacterForm` **per op**
(keyed by opKey, so it remounts and resets each step). If the same new speaker appears
on six lines, the user is asked to "create" them six times. The apply layer
(`src/lib/apply-proposed.ts`) already de-duplicates the actual `createCharacter` POST
by normalized name within a batch — so no duplicate cast row is created — but the
**confirm step is shown once per line**, and a name created on line 1 isn't reflected
back into the roster the form checks, so line 2 doesn't recognise it as existing.

## Goals

1. A **summary-first** review surface: a whole-book run opens as a short, scannable
   list of chapters, each collapsible into per-type groups, each of which expands to
   today's per-op cards.
2. **Confirm at a meaningful granularity**: approve a whole chapter, or a single type
   within a chapter, without eyeballing every line — while still being able to expand
   and spot-check or tick individual ops.
3. **Create-once speakers**: a newly-discovered speaker is created a single time and
   auto-applied to all its proposed lines, book-wide — never one prompt per line.

## Non-goals

- No change to how ops are *generated* (server/analyzer), streamed, or persisted.
- No `scriptReview` slice **shape** change (only an additive pure selector + one reducer).
- No new modal/route — this evolves the existing `ScriptReviewDiff` overlay in place.
- No cross-cutting "approve all high-confidence" shortcut (YAGNI; per-group approve
  already gives the control). Can be revisited later.

## Design

### A. Summary view (accordion, collapsed by default)

`ScriptReviewDiff` gains a chapter layer above its existing class grouping. On open,
**everything is collapsed** so the modal is a list of chapter rows, not a wall of cards:

```
Review suggestions · 1,203 across 34 chapters      [Apply selected (0)]

▸ Chapter 3  ·  48                    [Approve all 48]
▸ Chapter 4  ·  31                    [Approve all 31]
▾ Chapter 5  ·  52                    [Approve all 52]
     Merge            22   [Approve 22]   ▸
     Strip tag        14   [Approve 14]   ▸
     Fix emotion       8   [Approve 8]    ▸
   ▾ Reattribute       4   (new speakers) — review
         · s#118  "…" → Guard          [create speaker ↓]
         · s#204  "…" → Guard          (auto: Guard)
         ...
▸ Chapter 8  ·  17                    [Approve all 17]
   (chapters 6–7 had no suggestions and are omitted)
```

- **Chapter row** — chapter label + appliable-op count + `Approve all N`. Expand → type
  sub-rows. Chapters are ordered by chapter id. **Zero-pending chapters are omitted**
  (not rendered as muted rows): a chapter with no pending ops simply isn't in `bucket.ops`,
  so a "nothing pending" row can't be produced from a pure `bucket` selector without a
  cross-slice read of the full chapter list — not worth it. The header count reflects only
  chapters that produced findings.
- **Type row** — type label + count + `Approve N` (ticks this chapter-and-type's
  `selectableKeys` via the new `toggleKeys` reducer — *not* the cross-chapter
  `toggleClass`). Expand → the individual `OpPreview` cards with per-op checkboxes:
  **today's UI, reused unchanged**.
- **Apply** — one footer action over the union of everything ticked, one server round-trip
  batch (unchanged from today). Header count reflects total selected across all chapters.
- Expand/collapse is **local component state** (not persisted); selection continues to
  sync per-chapter via the existing debounced `patchScriptReviewSelection`.
- **Existing empty / unappliable states are preserved.** The current no-ops empty state
  and the separate `unappliable` notice must still render. A bucket whose ops are *all*
  unappliable yields a **zero-chapter** summary — the accordion body is empty but the
  unappliable notice still shows, so the modal is never blank with nothing explained.

### B. Group-approve semantics

- **Bulk-approvable types** (get `Approve all` / `Approve N`): `merge`, `strip_tag`,
  `split`, `extract_dialogue`, `fix_emotion`, `validate_instruct` — the mechanical six.
- **Expand-only types** (no blind bulk-approve): `reattribute` and `flag_nonstory`.
  These are already `DEFAULT_OFF` (opt-in, unchecked) and are the high-stakes edits
  (identity changes, story exclusion). A chapter-level `Approve all` ticks only the
  mechanical types and **says so**, e.g. *"48 approved · 4 reattributions left to
  review"*. The reattribute/flag sub-rows must be expanded and ticked deliberately.
- "Approve" here means **tick the group's opKeys in `selected`** — it does not apply on
  its own. Apply is still the single explicit footer action. This keeps one mental model
  (tick → Apply) and one TOCTOU re-check path.

### C. Create-once speaker flow

Replace the per-op confirm queue with a **per-unique-name** one, consulting the live
roster first so it de-duplicates across chapters and across separate approve actions.

When Apply runs and the selected set contains off-roster `reattribute` ops
(`op.op === 'reattribute' && op.proposed && !op.characterId`):

1. **Group the proposed ops by normalized `proposed.name`.** For each unique name:
   - **Already in the live cast** (a real member, or one created earlier this session)
     → no form; every line for that name is treated as a plain reattribute to that id.
   - **Genuinely new** → show **one** `CreateCharacterForm`, headed
     *"New speaker: «Name» — N lines"*.
2. On create, all N lines for that name **apply together** in that one step
   (auto-apply). `apply-proposed.ts` already memoises the POST, so exactly one
   `createCharacter` fires per unique name; the memo is seeded from the live roster so
   step 1's "already in cast" branch never re-creates.
3. Reassigned lines resolve as a batch and drop out of pending. Undo is the normal
   manuscript undo (`setSentenceCharacter` is an ordinary mutation). With M new speakers
   in a batch, the user sees **M forms, one per name** — never one per line.

Net effect: create-once is **book-wide**, because the roster check in step 1 means a
"Guard" created while approving chapter 3 is silently reused when chapter 12's approve
runs later.

**This is not a one-line swap** — the per-op model is hard-coded across five touch-points
in `script-review-diff.tsx` that all move to per-name together (call them out so the
implementer doesn't discover them mid-task):

1. the `confirm` state shape `{ queue, index, finalized, startBookId }` → a per-name
   queue (`{ name, ops[], … }[]`);
2. `confirmOp` derivation and the `key={opKey(confirmOp…)}` form remount trigger →
   keyed by name;
3. the *"Confirm new speaker (N of M)"* header → per-name (*"New speaker: «Name» —
   N lines"*);
4. **`advanceConfirm`** — its walk-one-op-at-a-time logic, including the on-roster branch
   that immediately dispatches `setSentenceCharacter` + `resolveAppliedOps`, and its
   terminal `runProposed(finalized)` call — is rewritten to advance per name;
5. `runProposed`'s `finalized` accumulation.

`apply-proposed.ts` itself (the memo/roster-seed) is reused unchanged; the churn is all in
the confirm-queue UI layer.

### D. Plumbing

- **No slice shape change.** Add a pure selector to `src/store/script-review-slice.ts`:
  - `selectReviewSummary(bucket)` →
    `{ totalOps, chapters: [{ chapterId, total, byType: [{ op, count, selectableKeys }] }] }`,
    aggregating the existing flat `bucket.ops` (appliable only — never `unappliable`) by
    `chapterId` then `op`. `selectableKeys` are the `opKey(chapterId, id, op)` strings the
    group-approve buttons tick (named *selectable*, not *appliable*, to avoid colliding
    with `planApply`'s "appliable" survivors).
- **Single bulk-tick reducer, not `toggleClass`.** `toggleClass` filters `bucket.ops`
  across **all chapters**, so it cannot be scoped to one chapter and must **not** be
  reused for group-approve. Add one primitive — `toggleKeys(bookId, keys[], value)` —
  that sets/clears an explicit list of opKeys in `selected`. Both `Approve all N`
  (chapter) and `Approve N` (type) call it with the group's `selectableKeys`; there is no
  separate `toggleChapter` reducer (a chapterId-only reducer would have to re-encode the
  mechanical-vs-expand-only taxonomy, which we're single-sourcing instead — see below).
- **Single-source the taxonomy.** `DEFAULT_OFF` (`{reattribute, flag_nonstory}`) is today
  a function-local inside `setReview`. Export shared `BULK_APPROVABLE` / `EXPAND_ONLY`
  sets from the slice; have `setReview`'s default-off logic, `selectReviewSummary`
  (to compute which keys a group's approve button ticks), and Section B's UI all consume
  the one source, so adding an op class later is a one-line change.
- **Bulk ticks must sync the post-toggle snapshot.** The debounced per-chapter
  `scheduleSelectionSync` reads `selected` from the render closure, which is stale on the
  same tick a bulk tick dispatches. Each group-approve handler must compute the
  post-dispatch selection locally (as today's `toggleClass` onChange already does) and
  pass **that** to `scheduleSelectionSync` — otherwise a bulk approve PATCHes the
  pre-tick selection and the ticks don't survive reload. The sync mechanism itself
  (one bounded PATCH per chapter, 500ms debounce) is unchanged and payload-safe.
- **Create-once** slots into `handleApply`'s existing `proposedOps` branch but rewrites
  the five confirm-queue touch-points listed in Section C. `api.createCharacter`,
  `apply-proposed.ts`, `resolveOpsLocally`, and the TOCTOU re-check are reused unchanged.

### D2. Bulk apply must surface partial application

`handleApply` re-runs `planApply` on the ticked set and applies only the survivors,
**discarding the freshly-computed `unappliable`**. With per-op selection the user rarely
ticks mutually-conflicting ops, so this is invisible today. But `Approve all 48` will
routinely tick two structural ops on one sentence, or a `strip_tag` on a merge-consumed
id — `planApply` drops the loser, and Apply silently applies fewer than 48 with no
feedback. **Requirement:** the bulk path surfaces a post-Apply result —
*"46 applied · 2 couldn't apply (conflicting edits)"* — via the existing toast/notice
surface, so a group-approve never silently under-applies. (Per-op Apply gets the same
notice; it's just rarely non-zero there.)

### E. Shippable units

1. **Summary accordion + group-approve** (Sections A, B, D-selectors/reducer).
2. **Create-once consolidation** (Section C, D-handleApply branch).

Either can merge alone. Default: one PR unless the diff argues for splitting.

## Testing

- **Unit — `script-review-slice.test.ts`**: `selectReviewSummary` aggregation across
  multiple chapters/types (appliable only — an `unappliable` op is excluded from counts
  and `selectableKeys`); correct `selectableKeys` per group; the shared
  `BULK_APPROVABLE`/`EXPAND_ONLY` split; `toggleKeys` sets/clears exactly the given keys
  and nothing else.
- **Unit — `apply-proposed.test.ts`**: two `proposed` ops with the same name → exactly
  one `createCharacter` call, both lines repointed; a proposed name already in roster →
  zero creates, line repointed to the existing id.
- **Component — `script-review-diff.test.tsx`**: opens collapsed; `Approve all N` on a
  chapter ticks its mechanical ops, leaves reattribute/flag_nonstory unticked, shows the
  "N left to review" note; the post-Apply partial-apply notice fires when the ticked set
  contains conflicting ops (*"46 applied · 2 couldn't apply"*); one `CreateCharacterForm`
  per unique new name across a multi-line batch; the all-unappliable bucket still renders
  the unappliable notice (not a blank modal).
- **Component — post-toggle sync**: a bulk `Approve all` schedules a selection sync with
  the *post-tick* keys (guard against the stale-closure PATCH regression).
- **E2E — `e2e/`** (one spec): whole-book bucket → summary opens collapsed → expand a
  chapter → `Approve all` → Apply → the chapter count drops. Crosses redux/layout/router
  seams, so it earns the Playwright spec per the testing rule. **Fixture:** confirm
  `src/mocks/canned-data.ts` seeds a review bucket spanning several chapters (the bucket
  is served in-JS in mock mode, so `page.route` can't inject it — it must exist in the
  canned data); add/extend one if absent.
- **Mobile**: the accordion must stay single-column and usable at phone width; group
  controls keep ≥44px touch targets (per the mobile testing protocol).

## Acceptance criteria

1. A whole-book run opens the review modal **collapsed** to a chapter list; no wall of
   cards.
2. A chapter expands to per-type groups; a type expands to today's per-op cards with
   working per-op checkboxes.
3. `Approve all N` (chapter) and `Approve N` (type) tick the appropriate mechanical-type
   ops; reattribute/flag_nonstory are never blind-approved and the skipped count is
   surfaced.
4. Apply remains a single batched action over everything ticked.
5. A new speaker appearing on N lines prompts **one** create form; creating it applies
   all N lines; the same name never prompts again in the session (book-wide).
6. No `scriptReview` slice shape change; new selector/reducer are additive and unit-tested;
   the bulk-approvable taxonomy is single-sourced from the slice.
7. A bulk approve that Apply can only partially satisfy **surfaces** how many applied vs
   couldn't — never silently under-applies.

## Resolved questions

- **Zero-pending chapters — OMIT.** A chapter with no pending ops isn't in `bucket.ops`,
  so a muted "nothing pending" row can't come from a pure `bucket` selector. Omit them.
  If a "34 of 40 chapters" footer is ever wanted, its denominator (total book chapters)
  must be read from the chapters/manuscript slice — out of scope for the pure summary
  selector, and not part of v1.
- **`extract_dialogue`/`split` with `pieceCharacterIds` — safe.** These never carry
  `proposed` and never hit the create-once trigger (`op === 'reattribute' && proposed &&
  !characterId`), so they stay bulk-approvable and introduce no new speaker. (Note a
  pre-existing, orthogonal gap: `planApply` doesn't roster-validate `pieceCharacterIds`
  the way it gates on-roster `reattribute` — unreachable via this feature's paths, filed
  as out-of-scope, not fixed here.)

## Ship notes

_(to be filled at ship)_
