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
- No `scriptReview` slice **shape** change (only additive pure selectors + one reducer).
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
▸ Chapter 6  ·  0  ✓ nothing pending
```

- **Chapter row** — chapter label + appliable-op count + `Approve all N`. Expand → type
  sub-rows. Chapters are ordered by chapter id; chapters with zero pending appliable ops
  render as a muted "nothing pending" row (or are omitted — see Open questions).
- **Type row** — type label + count + `Approve N` (the existing per-class select-all,
  now scoped to this chapter). Expand → the individual `OpPreview` cards with per-op
  checkboxes: **today's UI, reused unchanged**.
- **Apply** — one footer action over the union of everything ticked, one server round-trip
  batch (unchanged from today). Header count reflects total selected across all chapters.
- Expand/collapse is **local component state** (not persisted); selection continues to
  sync per-chapter via the existing debounced `patchScriptReviewSelection`.

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

### D. Plumbing (kept thin)

- **No slice shape change.** Add pure selectors to `src/store/script-review-slice.ts`:
  - `selectReviewSummary(bucket)` →
    `{ totalOps, chapters: [{ chapterId, total, byType: [{ op, count, appliableKeys }] }] }`,
    aggregating the existing flat `bucket.ops` by `chapterId` then `op`. `appliableKeys`
    are `opKey(chapterId, id, op)` strings the group-approve buttons tick.
- Add a **`toggleChapter`** reducer mirroring the existing `toggleClass`: given a
  chapterId (and the set of bulk-approvable op keys), set those keys in `selected`.
  `Approve N` (per type) reuses `toggleClass` scoped to the chapter's keys, or a small
  `toggleKeys(keys, value)` helper if cleaner.
- The create-once consolidation slots into `handleApply`'s **existing** `proposedOps`
  branch — replace the per-op `confirm` queue (`{ queue, index, … }`) with a
  per-name one built by grouping `proposedOps` by normalized name and filtering out
  names already present in the live roster.
- Everything else — `selected` map, `handleApply` TOCTOU re-check, the Apply batch,
  per-chapter selection sync, `resolveOpsLocally` — is reused untouched.

### E. Shippable units

1. **Summary accordion + group-approve** (Sections A, B, D-selectors/reducer).
2. **Create-once consolidation** (Section C, D-handleApply branch).

Either can merge alone. Default: one PR unless the diff argues for splitting.

## Testing

- **Unit — `script-review-slice.test.ts`**: `selectReviewSummary` aggregation across
  multiple chapters/types, a chapter with zero pending, correct `appliableKeys`;
  `toggleChapter` ticks only mechanical-type keys and leaves `reattribute`/`flag_nonstory`
  untouched.
- **Unit — `apply-proposed.test.ts`**: two `proposed` ops with the same name → exactly
  one `createCharacter` call, both lines repointed; a proposed name already in roster →
  zero creates, line repointed to the existing id.
- **Component — `script-review-diff.test.tsx`**: opens collapsed; `Approve all N` on a
  chapter ticks its mechanical ops, leaves reattribute unticked, shows the "N left to
  review" note; one `CreateCharacterForm` per unique new name across a multi-line batch.
- **E2E — `e2e/`** (one spec): whole-book bucket → summary opens collapsed → expand a
  chapter → `Approve all` → Apply → the chapter count drops. Crosses redux/layout/router
  seams, so it earns the Playwright spec per the testing rule.
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
6. No `scriptReview` slice shape change; new selectors/reducer are additive and unit-tested.

## Open questions

- **Zero-pending chapters**: show a muted "nothing pending" row, or omit entirely? Lean
  omit (less noise) with a footer "34 of 40 chapters have suggestions".
- **`extract_dialogue`/`split` with `pieceCharacterIds`**: these reference existing ids,
  not new speakers, so they stay in the bulk-approvable set — confirm no case introduces
  an off-roster id there.

## Ship notes

_(to be filled at ship)_
