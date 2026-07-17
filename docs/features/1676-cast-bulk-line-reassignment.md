---
status: active
shipped: null
owner: null
---

# Cast: bulk line reassignment + alias repoint on unlink (#1676, parts b+c)

> Status: active
> Key files: `src/modals/reassign-lines.tsx`, `src/components/bulk-reassign-undo-banner.tsx`,
> `src/store/manuscript-slice.ts`, `src/store/persistence-middleware.ts`,
> `src/lib/change-log.ts`, `src/modals/profile-drawer.tsx` (roster entry point),
> `src/views/manuscript.tsx` (script entry point), `src/components/layout.tsx`
> (unlink entry point + banner mount + split/move branch), `src/modals/unlink-alias-dialog.tsx`
> (destination dialog, part b), `server/src/routes/cast-aliases.ts` (`repoint-alias`
> route, part b), `src/lib/api.ts` (`repointAlias` client, part b), `src/store/cast-slice.ts`
> (`applyRepointAlias` reducer, part b)
> URL surface: `#/books/<id>/cast` (roster entry), `#/books/<id>/manuscript`
> (script entry) — the modal and Undo banner render at the layout level, not
> tied to either route
> OpenAPI ops: `POST /api/books/{id}/cast/repoint-alias` (part b; sibling to the
> existing `unlink-alias`/`add-alias` routes) — line attribution itself still
> round-trips through the generic `PUT /api/books/{id}/state`

Design specs: [docs/superpowers/specs/2026-07-17-cast-bulk-line-reassignment-design.md](../superpowers/specs/2026-07-17-cast-bulk-line-reassignment-design.md)
(part c) and [docs/superpowers/specs/2026-07-17-cast-alias-repoint-on-unlink-design.md](../superpowers/specs/2026-07-17-cast-alias-repoint-on-unlink-design.md)
(part b). Part b's implementation plan:
[docs/superpowers/plans/2026-07-17-cast-alias-repoint-on-unlink.md](../superpowers/plans/2026-07-17-cast-alias-repoint-on-unlink.md).

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
  (alias re-point on unlink) landed as a follow-up on the same branch: it
  reuses this exact `ReassignLinesModal`/`unlink` source unchanged, adding
  only a destination choice ahead of it (see "Part (b): alias repoint on
  unlink" below) — no new line-reassignment machinery, just a new server
  route + reducer that redirect where the alias's chip lands before the
  existing modal opens.

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

## Part (b): alias repoint on unlink

Previously, removing an alias chip in the Profile Drawer only ever **split**
it — the alias always became a brand-new standalone character, even when the
"alias" was really a distinct, pre-existing cast member that had been
mis-merged (the motivating case, per the design spec: an over-eager fold
merging a real character's name into another's alias list). Part (b) adds a
second destination so the user can send the alias's lines straight onto an
**existing** character instead of minting a new one.

- **Destination dialog** (`src/modals/unlink-alias-dialog.tsx`,
  `UnlinkAliasDialog`) — a small controlled dialog (no store/api access of its
  own) shown when an alias chip's × is clicked. Two radio options: "Make
  «alias» its own character" (the pre-existing split, unchanged, now just
  gated behind this dialog instead of firing immediately) and "Move «alias»
  to [target picker]" (new). Confirm is disabled until a target is picked in
  move mode. Returns a `UnlinkDestination` discriminated union (`{ mode:
  'split' }` / `{ mode: 'move'; targetCharacterId: string }`) to the caller.
- **Server route** `POST /api/books/{id}/cast/repoint-alias`
  (`server/src/routes/cast-aliases.ts`) — sibling to the existing
  `unlink-alias`/`add-alias` routes. Validates `sourceCharacterId`,
  `aliasName`, `targetCharacterId` are all present and that source ≠ target
  (400 otherwise), then atomically strips the alias off the source and
  dedup-appends it to the target's `aliases` (skipping the append —
  `alreadyPresent: true` — when the target already carries the alias, or the
  alias equals the target's own name). Reuses the exact same
  journal-then-`chapterCast`-fallback lineage lookup as `unlink-alias` to
  compute `impactedChapters`, since the candidate lines are the same
  source-attributed sentences regardless of destination. Responds
  `{ impactedChapters, alreadyPresent }`.
- **Reducer** `cast/applyRepointAlias` (`src/store/cast-slice.ts`) — client-side
  mirror of the route: strips the alias from the source and dedup-appends to
  the target (no-op on a blank/whitespace alias name or a missing
  source/target), so the store update and the disk write stay in lockstep
  without a full-cast refetch.
- **Persist rule** `cast/applyRepointAlias` (`src/store/persistence-middleware.ts`)
  — persists the full `{ characters: s.cast.characters }` patch, mirroring the
  existing `cast/applyAddAlias` rule's shape.
- **Layout wiring** (`src/components/layout.tsx`, `onUnlinkAlias`) — branches
  on `destination.mode`: `'split'` is the byte-for-byte original path
  (`api.unlinkAlias` → `applyUnlinkAlias` → open `ReassignLinesModal` seeded
  to the newly-split character); `'move'` calls `api.repointAlias`, dispatches
  `applyRepointAlias`, then opens the same `ReassignLinesModal` (`source: {
  kind: 'unlink' }`) seeded to the **existing** target character instead —
  so the alias's lines follow the alias to wherever it landed, split or move,
  through the one unchanged modal.
- **No undo for the alias-string move itself** — only the subsequent line
  move (via the reused `ReassignLinesModal`/`lastBulkReassign` slot) is
  undoable, same as the pre-existing split path. Repointing the alias string
  a second time (or re-adding it) is always available as a manual correction.

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
  `unlink` source; asserts the renamed aria-label and empty-state copy; **new**
  move-to-X path: chip × → dialog → "Move to" → pick a target → confirm →
  `ReassignLinesModal` opens seeded to the target, not a freshly-split
  character.
- Vitest server (`server/src/routes/cast-aliases.test.ts`, describe block
  `repoint-alias`, 6 cases) — happy-path strip-and-append; `alreadyPresent`
  when the target already carries the alias or the alias equals the target's
  own name; 400 on a missing field or a self-target; 404 on an unknown
  source/target character or an alias not on the source; the journal/
  `chapterCast` lineage fallback is exercised identically to `unlink-alias`.
- Vitest unit (`src/store/cast-slice.test.ts`, describe block
  `applyRepointAlias`) — strips from source and dedup-appends to target;
  no-op when the target already carries the alias or the alias equals the
  target's name; no-op on a blank/whitespace alias name or a missing
  source/target character (regression test added for the whitespace +
  missing-target no-op cases).
- Vitest unit (`src/store/persistence-middleware.test.ts`) — the
  `cast/applyRepointAlias` action triggers a persist of the full
  `{ characters }` patch.
- Vitest component (`src/modals/unlink-alias-dialog.test.tsx`) — defaults to
  "own character" and confirms a split; requires a target before "move" can
  confirm; Cancel fires `onCancel` and never `onConfirm`; renders the error
  line when `error` is set; disables both buttons while `busy`; does not
  crash with an empty target list (only split selectable).
- Vitest component (`src/modals/profile-drawer.test.tsx`) — rewritten unlink
  tests route the × click through `UnlinkAliasDialog` before calling
  `onUnlinkAlias`, for both the split and move destinations; a regression
  test locks that opening the dialog for a fresh unlink clears any stale
  error left over from a previous failed attempt (placebo-proof: fails red
  without the fix).

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
8. **Unlink entry point — split (regression).** In a character's profile
   drawer, click an alias chip's X → expected: the `UnlinkAliasDialog` opens
   (`aria-label="Unlink alias"`), defaulted to "Make «alias» its own
   character." Click Continue → the alias splits into its own character AND
   the same `ReassignLinesModal` opens with `source: { kind: 'unlink' }`,
   target pre-set to the newly split-off character, empty-state copy
   "Nothing to reassign here — 0 lines to move for this selection." when the
   mock returns no impacted chapters.
9. **Unlink entry point — move to X (part b, new).** Repeat step 8 but pick
   "Move «alias» to" and choose an existing roster character from the
   dropdown, then Continue → expected: the dialog closes, the alias chip
   disappears from the source character's "Also known as" row, the alias
   reappears on the **chosen target's** "Also known as" row (no new character
   is created), and the `ReassignLinesModal` opens seeded to that target
   (not a freshly-split character) so the alias's lines follow it there.
   Confirming the reassignment leaves the target with both the alias string
   and the reassigned lines. Re-opening the drawer for a different alias
   afterwards shows a clean dialog with no leftover error from a prior
   attempt.
10. **Cross-book isolation.** With a pending Undo banner on Book A, switch to
    Book B (library → open another book) → expected: no stale banner shows on
    Book B, and there is no residual `lastBulkReassign` slot pointing at
    Book A's composite keys.

## Out of scope

- Undo for the alias-string move itself (part b) — only the subsequent line
  reassignment is undoable via the existing one-level slot; repointing the
  alias again is the manual correction path.
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
