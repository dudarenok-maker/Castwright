---
status: active
shipped: null
owner: null
---

# Cast: bulk-reassign attributed lines to a character (#1676, part c)

> Status: active
> Key files: `src/modals/reassign-lines.tsx`, `src/components/bulk-reassign-undo-banner.tsx`,
> `src/store/manuscript-slice.ts`, `src/store/persistence-middleware.ts`,
> `src/lib/change-log.ts`, `src/modals/profile-drawer.tsx` (roster entry point),
> `src/views/manuscript.tsx` (script entry point), `src/components/layout.tsx`
> (unlink entry point + banner mount)
> URL surface: `#/books/<id>/cast` (roster entry), `#/books/<id>/manuscript`
> (script entry) — the modal and Undo banner render at the layout level, not
> tied to either route
> OpenAPI ops: none (client-only; line attribution round-trips through the
> existing generic `PUT /api/books/{id}/state`)

Design spec: [docs/superpowers/specs/2026-07-17-cast-bulk-line-reassignment-design.md](../superpowers/specs/2026-07-17-cast-bulk-line-reassignment-design.md).

## Benefit / Rationale

- **User:** moving many mis-attributed lines from one character to another
  used to mean fixing them one at a time. The origin case — Night Watch's
  first-person narrator scattered ~700+ lines onto a side character — is not
  fixable by hand. One reusable form now handles this from the roster (a
  whole character's lines), the script view (an arbitrary multi-select), or
  the existing alias-unlink flow, with a single-click Undo.
- **Technical:** a cross-chapter bulk reducer (`setSentencesCharacterBulk`)
  replaces N single-chapter dispatches with one action + one debounced
  persist; a render-independent `Set<compositeKey>` selection model means
  "select all" scales to the 700–10k-row cases without mounting every row.
- **Architectural:** introduces the repo's first one-level, book-session-
  scoped undo slot on a redux slice (`manuscript.lastBulkReassign`), with an
  explicit clear-whitelist (not a blanket action matcher) — a pattern future
  bulk-edit features can reuse instead of re-deriving from scratch. Part (b)
  (alias re-point on unlink) is a deliberate follow-up that reuses this same
  form; not built here.

## Architectural impact

- **New seams / extension points:**
  - `ReassignSource` discriminated union (`src/modals/reassign-lines.tsx`) —
    `{ kind: 'character' }` / `{ kind: 'selection' }` / `{ kind: 'unlink' }` —
    is the extension point for future entry points into the same form.
  - `manuscript.lastBulkReassign` — a one-level undo slot, distinct from the
    append-only change-log (`change-log-slice.ts`), which has no edit/delete-
    by-id and so cannot itself represent an undoable bulk move.
  - `TOAST_ON_PERSIST_FAILURE` (`persistence-middleware.ts:47`) — an opt-in
    set of action types that surface a persist-failure toast, scoped
    narrowly to the two new bulk actions rather than broadening the existing
    swallow-on-failure behaviour for every persisted slice.
- **Invariants preserved:** the composite `(chapterId, sentenceId)` key
  discipline (sentence ids restart per chapter — see plan 92); the
  append-only change-log (`change-log-slice.ts`) is never rewritten, only
  appended to; the existing single-line reassignment reducers
  (`setSentenceCharacter`, `setSentencesCharacter`) and their stale-flag
  behaviour are untouched.
- **Migration story:** none — no persisted-state shape change.
  `lastBulkReassign` lives only in the redux slice, is explicitly excluded
  from persistence (not part of any `PERSIST_RULES` build), and is nulled on
  every book transition, so there is nothing to migrate.
- **Reversibility:** the feature IS the reversibility mechanism (Undo). If it
  ships broken, reverting the branch removes the roster/script entry points
  and the banner; the unlink flow falls back to the old caller shape only if
  `profile-drawer.tsx`'s `onReassignLines` prop is also reverted (single
  commit boundary, see plan history).

## Invariants to preserve

1. Selection is a `Set<"chapterId:sentenceId">` held over the **full
   resolved candidate list**, never derived from mounted/virtualized DOM rows
   (`src/modals/reassign-lines.tsx:112-138`). Reading selection from rendered
   rows would silently cap "select all" to the visible virtualization window.
2. `setSentencesCharacterBulk` is **exempt** from the undo-clear predicate —
   it sets the slot and must not immediately clear the one it just wrote
   (`manuscript-slice.ts:325-343`). Only `undoBulkReassign` restores + nulls
   the slot, and it does not record a new undo record (no undo-of-undo)
   (`manuscript-slice.ts:345-360`).
3. Clear-on-conflict is **key-granular**, not chapter-granular
   (`bulkUndoConflicts`, `manuscript-slice.ts:100-109`): the slot only clears
   when a later edit touches a key that was actually moved (or a second bulk
   reassignment runs). An edit to an untouched sibling line in the same
   chapter must NOT clear it.
4. `lastBulkReassign` is explicitly nulled in `manuscript.reset`,
   `hydrateFromBookState`, and `hydrateFromAnalysis`
   (`manuscript-slice.ts:152,223,236,505,556,627,644` — every book-transition
   reducer). Missing any of these leaks one book's undo slot (with its
   composite keys) onto a different book, where clicking Undo would rewrite
   colliding keys.
5. The persistence middleware's `'manuscript/setSentencesCharacterBulk'` and
   `'manuscript/undoBulkReassign'` rules build the **full**
   `{ sentences, mergedAwayKeys }` patch (`persistence-middleware.ts:98-108`)
   — dropping `mergedAwayKeys` would lose sentence-merge tombstones on the
   next PUT.
6. Apply dispatches exactly one `bumpBoundaryMove` **per affected chapter**
   (not once for the whole bulk action) so each touched chapter's stale
   indicator fires independently. Undo does not touch `bumpBoundaryMove` —
   it appends one `buildBulkReassignRevertEvent` audit entry instead
   (`change-log.ts:400`, `bulk-reassign-undo-banner.tsx:25-29`) — the
   append-only log has no revert-by-id, so post-undo the time-based stale
   clause still reads the chapter as needing regen (accepted; matches every
   pre-existing reassign-then-undo).
7. The Undo banner is **book-session-scoped, not view-scoped**: it renders
   once at the layout level (`layout.tsx:1640-1641`, alongside
   `WhatsNewBanner`/`UpdateNotifierBanner`), so it survives Cast↔Manuscript
   navigation within the same book, and only disappears via Undo, a
   conflicting edit, or a book switch.
8. Apply re-validates every selected key against the **live** store before
   dispatching (key-drift guard, `reassign-lines.tsx:apply()`): a key that no
   longer resolves (e.g. merged away while the modal was open) is silently
   skipped and the skip count is reported, never applied against a stale
   sentence.
9. The target picker disables the source character and shows a light,
   dismissible confirm step when the target is Narrator — but there is no
   "pending removal" exclusion, since `Character` carries no such state in
   part (c) (a part-(b) concept).

## Test plan

### Automated coverage

- Vitest unit (`src/store/manuscript-slice.test.ts`) — `setSentencesCharacterBulk`
  rewrites `characterId` for every key and records the correct inverse in
  `lastBulkReassign`; the bulk-set action does not immediately clear its own
  slot (C1); `undoBulkReassign` restores prior ids, nulls the slot, and
  records no new undo entry; the slot survives an edit to an untouched
  sibling line in a touched chapter and clears on an edit to a moved key or
  a second bulk; `reset`/`hydrateFromBookState`/`hydrateFromAnalysis` null
  the slot (cross-book leak guard).
- Vitest unit (`src/store/persistence-middleware.test.ts`) — both new action
  types trigger the debounced state PUT with the full
  `{ sentences, mergedAwayKeys }` patch; a failed apply/undo PUT surfaces a
  toast scoped to just these two action types.
- Vitest component (`src/modals/reassign-lines.test.tsx`) — `character`
  source lists every line grouped by chapter; select-all + apply dispatches
  one bulk move plus one `bumpBoundaryMove` per affected chapter; source
  character disabled in the target picker; text filter + select-all-matching;
  per-chapter select-all; empty state for a zero-line character; Narrator
  target requires an extra confirm and does not apply until confirmed;
  key-drift at apply skips a merged-away key and reports the count;
  **`unlink` source** resolves candidate rows from `impactedChapters` and
  defaults the target to `aliasCharacterId`.
- Vitest component (`src/modals/profile-drawer.test.tsx`) — the roster
  "Reassign lines…" action invokes `onReassignLines(characterId)`.
- Playwright e2e (`e2e/cast-bulk-reassign.spec.ts`) — golden path: roster →
  profile drawer → "Reassign lines…" → select all → pick a target → confirm
  → the layout Undo banner appears → **survives Cast↔Manuscript navigation**
  → Undo dismisses it.
- Playwright e2e (`e2e/cast-alias-edit.spec.ts`) — regression: the alias
  chip's X still opens the (now-generalized) `ReassignLinesModal` with the
  `unlink` source; asserts the renamed aria-label and empty-state copy.

If a surface area is untested: the script-view multi-select entry point
(`{ kind: 'selection' }`) has Vitest coverage on `manuscript.tsx`'s selection
toggle + the floating "Reassign N selected…" action bar wiring, but no
dedicated Playwright spec of its own yet — the roster entry point's e2e
above exercises the same modal/banner machinery end-to-end, so the marginal
coverage of a second full e2e spec for the selection source was judged not
worth the added suite runtime; call this out as a candidate follow-up if the
selection path regresses in practice.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, `npm run dev`).

1. **Roster entry point.** Analyse a fresh book, confirm the cast, land on
   `#/books/<id>/cast`. Open a character's profile drawer, click
   "Reassign lines…" → expected: `ReassignLinesModal` opens with
   `aria-label="Reassign lines"`, every sentence currently on that character
   listed grouped by chapter, "Select all" pre-selects everything.
2. **Filter + per-chapter select.** With rows spanning >1 chapter, the
   "Select all in chapter…" facet appears; picking a chapter adds only that
   chapter's rows to the selection. Typing in the text filter narrows rows;
   "Select all matching" selects exactly the filtered subset.
3. **Target picker + Narrator confirm.** The source character is disabled in
   the "Reassign to" dropdown. Picking any other character and clicking
   "Reassign N lines" shows the count/summary confirm step
   (`aria-label="Confirm reassignment"`); picking **Narrator** as the target
   additionally shows the amber "re-check this is intended" note before the
   same Confirm/Cancel pair.
4. **Apply + Undo banner.** Confirm → expected: the modal closes, and a
   non-dismissing banner reading "Reassigned N line(s) to {target}." with an
   **Undo** button appears below the top bar. Every touched chapter's
   "needs regeneration" indicator now shows.
5. **Undo across navigation.** Navigate Cast → Manuscript → Cast — the
   banner is still visible (book-session scope, not view scope). Click
   **Undo** — expected: lines revert to their prior character, the banner
   disappears, and a "Reverted bulk line reassignment" entry appears in the
   change log. The reverted chapters remain flagged for regeneration (the
   time-based stale clause; accepted, matches ordinary reassign-then-undo).
6. **Drift-skip report.** Open the modal for a character, leave it open,
   trigger a merge on one of the listed sentences elsewhere (or re-analyse),
   then Apply the original (now partly stale) selection → expected: the
   result line reads "Moved N lines; M no longer existed and were skipped."
   instead of silently applying against a dangling key.
7. **Script/selection entry point.** On `#/books/<id>/manuscript`, enable
   "Select lines" multi-select, check several lines across chapters, click
   the floating "Reassign N selected…" bar → expected: the same modal opens
   with `source: { kind: 'selection' }`, pre-seeded with exactly those keys.
8. **Unlink entry point (regression).** In a character's profile drawer,
   remove an alias chip via its X → expected: the alias splits into its own
   character AND the same `ReassignLinesModal` opens with
   `source: { kind: 'unlink' }`, target pre-set to the newly split-off
   character, empty-state copy "Nothing to reassign here — 0 lines to move
   for this selection." when the mock returns no impacted chapters.
9. **Cross-book isolation.** With a pending Undo banner on Book A, switch to
   Book B (library → open another book) → expected: no stale banner shows on
   Book B, and there is no residual `lastBulkReassign` slot pointing at
   Book A's composite keys.

## Out of scope

- Part (b) — re-point an alias to another existing character at unlink time
  (a "Drop vs. Move to \<character\>" choice) — separate follow-up spec that
  reuses this form; not implemented here.
- A server-side bulk-reassign endpoint — line attribution keeps round-
  tripping through the generic `PUT /api/books/{id}/state`.
- Heuristic/smart auto-selection of "wrong" lines — selection is manual,
  aided only by filter/invert/select-all-matching ergonomics.
- Un-flagging a chapter's stale indicator on undo (the time-based clause) —
  would require a revert-by-id capability the append-only change-log does
  not have; accepted as consistent with existing reassign-then-undo
  behaviour (see Invariant 6).
- Multi-level undo / redo — the slot is one-level by design.

## Ship notes

(Filled in when status flips to `stable`.)
