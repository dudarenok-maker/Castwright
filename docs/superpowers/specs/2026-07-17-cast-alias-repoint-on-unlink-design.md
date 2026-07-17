# Cast editing — re-point an alias to another character on unlink (#1676 part b)

**Status:** design approved (2026-07-17)
**Issue:** #1676 (part b; part c shipped in PR #1684)
**Area:** fs (server route + frontend)

## Problem

When the analyzer folds a name onto the wrong roster row (e.g. the first-person
narrator alias «Я» folded onto side-character Егор instead of protagonist
Антон), the only recovery today is the alias-chip ✕ in the Profile Drawer.
That ✕ **splits the alias into a brand-new standalone character** and opens the
Reassign Lines modal so its lines can follow. There is no way to say "this name
actually belongs to *that existing character*" in one gesture — the user must
split-to-new, then merge, or hand-reassign.

Part (b) adds a **destination choice** in front of the unlink action: keep
today's split-to-new, or **move the alias (and optionally its lines) onto an
existing roster character**.

## Non-goals

- No true "delete the alias" outcome. The picker offers exactly two
  destinations: *new character* (today) and *existing character X* (new).
- **No undo for the alias-string transfer itself.** The *line* move keeps its
  existing one-level undo banner (part c). Moving a name back is a trivial
  manual gesture (unlink from X → move to the original). Adding an undo slot for
  the membership change is out of scope (YAGNI).
- No new bulk-reassign surface — part (b) reuses part (c)'s `ReassignLinesModal`
  verbatim.
- No analyzer change. This is the editing tool for residual mis-attribution;
  the stage-1 first-person fix is tracked separately.

## Current behavior (what part b modifies)

- **Entry point:** `ProfileDrawer` renders an ✕ per alias chip →
  `runUnlinkAlias(aliasName)` → `onUnlinkAlias(characterId, aliasName)`
  (`src/modals/profile-drawer.tsx`).
- **Layout handler** (`src/components/layout.tsx`): calls `api.unlinkAlias`,
  dispatches `castActions.applyUnlinkAlias` (strips alias off source, appends
  the server-minted `newCharacter`), then opens `ReassignLinesModal` with
  `source: { kind: 'unlink', impactedChapters, aliasCharacterId: newCharacter.id }`.
- **Server** (`server/src/routes/cast-aliases.ts`, `POST /cast/unlink-alias`):
  strips the alias, mints a standalone `newCharacter`, atomically rewrites
  `cast.json`, and computes `impactedChapters` via
  `impactedChaptersFromJournal` → `impactedChaptersFromChapterCast`.
- **Reassign modal** (`src/modals/reassign-lines.tsx`): the `unlink` source
  already accepts an arbitrary `aliasCharacterId` as the default target — it
  does not assume the target is newly minted. No modal change is needed for (b).

## Design

### 1. Destination dialog (frontend)

Clicking ✕ on an alias chip no longer fires the unlink immediately. It opens a
small dialog (new component `src/modals/unlink-alias-dialog.tsx`) in the same
visual family as the confirm `alertdialog` already in `reassign-lines.tsx`
(rounded card, ink overlay, `role="dialog"` + `aria-modal`).

Copy: *"Unlink «{alias}» from {sourceName} — where should this name go?"*

Two radio options:

1. **Make «{alias}» its own character** — today's split-to-new path.
2. **Move «{alias}» to → [character ▾]** — a `<select>` of every roster
   character **except** the source. No default selection; picking a target is
   required to enable Continue for this branch. Background buckets
   (`narrator`, `unknown-male`, `unknown-female`) are **intentionally kept** as
   valid destinations — a first-person alias legitimately belongs on Narrator
   (e.g. «Я» narrator-protagonist), and the reassign modal already surfaces its
   narrator-target warning for the follow-on line move.

Footer: `[Cancel]` / `[Continue]`. Continue is disabled until the choice is
complete (option 2 requires a target). Cancel closes with no side effect.

The dialog is presentational: it takes the source character + alias name + the
roster list, and resolves to one of
`{ mode: 'split' } | { mode: 'move'; targetCharacterId }` which the drawer's
`onUnlinkAlias` handler acts on. `aliasBusy` continues to gate against
double-fire while the resolved action runs.

**Touch targets:** every control (`radio`, `select`, buttons) carries the
`min-h-[44px] fine-pointer:min-h-0` WCAG target per the mobile protocol.

### 2. `POST /cast/repoint-alias` (server, Approach A)

New route in `server/src/routes/cast-aliases.ts`, structurally mirroring
`unlink-alias` and **reusing its existing module-level lineage helpers**
(`impactedChaptersFromJournal`, `impactedChaptersFromChapterCast`) with zero
duplication.

Request body: `{ sourceCharacterId, aliasName, targetCharacterId }`.

Behavior:
1. Validate all three present → 400 otherwise.
2. 404 on unknown book, unknown source, unknown target, or alias-not-on-source
   (mirrors unlink-alias' existing 404s).
3. 400 if `targetCharacterId === sourceCharacterId`.
4. Always strip the alias off the source and dedup-append it to the target.
   The append is case-insensitive-idempotent (mirrors `add-alias`): if the
   target already carries the alias, the append is a no-op and the route sets
   `alreadyPresent: true`, but the source strip still happens regardless.
   **Name-collision:** unlike `add-alias` (which 400s when `aliasName ===
   target.name`), repoint treats that case as `alreadyPresent` too — the target's
   primary name already covers the alias, so strip from source and no-op the
   append rather than rejecting. (400-ing here would strip-then-fail and strand
   the alias — and this is exactly the target case the feature exists for:
   moving a first-person alias onto the protagonist whose name may match it.)
5. Apply both edits (source strip + target append, display casing preserved) in
   **one atomic `writeJsonAtomic(cast.json)`**.
6. Compute `impactedChapters` exactly as unlink does (same source-attributed
   candidate lines), so the follow-on line move defaults correctly.
7. Return `{ impactedChapters, alreadyPresent }`.

No `newCharacter` in the response — the destination already exists.

### 3. API layer + types (`src/lib/api.ts`)

Add, alongside the existing unlink/add-alias declarations:

- `RepointAliasArgs { bookId, sourceCharacterId, aliasName, targetCharacterId }`
- `RepointAliasResponse { impactedChapters: UnlinkAliasImpactedChapter[]; alreadyPresent: boolean }`
- `realRepointAlias` (POST to the new route) + `mockRepointAlias` returning
  `{ impactedChapters: [], alreadyPresent: false }` (matches `mockUnlinkAlias`,
  which returns an empty impacted list for the same reason).
- Wire both into the `real`/`mock` api objects.

These types stay hand-declared in `api.ts` (as unlink/add-alias already are) —
these routes are not modelled in `openapi.yaml`/`api-types.ts`.

### 4. Cast reducer (`src/store/cast-slice.ts`)

New `applyRepointAlias({ sourceCharacterId, aliasName, targetCharacterId })`:

- Strip the alias off the source (same filter as `applyUnlinkAlias`).
- Append it to the target with case-insensitive dedup + self-alias guard (same
  logic as `applyAddAlias`).
- Idempotent under double-dispatch (network retry): a second run finds the alias
  already gone from source and already on target → no change.

No sentence movement here — lines are handled by the reassign modal, exactly as
in the unlink flow.

**Persistence (mirror `add-alias`, not `unlink`).** These are *different*
mechanisms and the distinction matters:
- `applyUnlinkAlias` is a redux-only delta — it has **no** entry in
  `PERSIST_RULES` (`src/store/persistence-middleware.ts`); the roster change
  survives a reload solely because the unlink *route* does `writeJsonAtomic`.
- `applyAddAlias` **does** carry a client persist rule
  (`'cast/applyAddAlias'` → writes `{ characters }`), added deliberately to win
  a last-write race: a debounced full-cast PUT from an earlier edit can land
  *after* the server's alias write and clobber it with a stale character list.

Repoint mutates **two** characters (strip source + append target) and is exactly
as exposed to that clobber race, so it mirrors `add-alias`: **add a new
`'cast/applyRepointAlias'` entry to `PERSIST_RULES`** (`build: (s) => ({
characters: s.cast.characters })`). This is the one new persistence wiring the
feature needs — the route's own `writeJsonAtomic` handles the primary write; the
client rule is the race-guard, matching add-alias.

### 5. Layout wiring (`src/components/layout.tsx`)

The drawer's `onUnlinkAlias` becomes destination-aware. Rather than firing
`api.unlinkAlias` directly, the drawer now surfaces the destination dialog and
hands the resolved choice back. On resolution:

- **`split`** → unchanged: `api.unlinkAlias` + `applyUnlinkAlias` + open
  `ReassignLinesModal` (`kind:'unlink'`, target = new char).
- **`move`** → `api.repointAlias({ …, targetCharacterId })` +
  `applyRepointAlias({ …, targetCharacterId })` + open the **same**
  `ReassignLinesModal` with
  `source: { kind:'unlink', impactedChapters, aliasCharacterId: targetCharacterId }`.

Both branches keep the drawer open behind the modal (closing the modal returns
the user to the drawer, where the chip is gone), and both feed the existing
Undo banner for the line move.

**Component boundary:** the dialog is owned/rendered by `ProfileDrawer` (it
needs the drawer's roster + alias context and sits over the drawer). The drawer
exposes the resolved choice through the existing `onUnlinkAlias` callback,
widened to carry the destination — so layout stays the orchestrator of the two
API paths, and the drawer stays the owner of the chip UI. This keeps each unit
single-purpose: dialog = pick a destination; drawer = chip management; layout =
API + modal orchestration.

## Data flow (move-to-X path)

```
✕ on «Я» chip (Егор)
  → destination dialog → { mode:'move', targetCharacterId:'anton' }
  → api.repointAlias(...)            # server: strip «Я» from Егор, add to Антон, atomic cast.json
  → dispatch applyRepointAlias(...)  # roster: «Я» now under Антон
  → open ReassignLinesModal { kind:'unlink', impactedChapters, aliasCharacterId:'anton' }
  → user reviews (default: all selected → Антон) → Confirm
  → setSentencesCharacterBulk        # lines follow to Антон
  → Undo banner (existing) covers the line move
```

## Edge cases

- **Target already has the alias** → server no-ops the append (`alreadyPresent`)
  but still strips from source and still returns `impactedChapters`; the reassign
  modal still opens so lines can follow.
- **Empty `impactedChapters`** (mock, or lines already reassigned) → reassign
  modal renders its existing empty state; the name transfer still happened.
- **Concurrent-edit drift** on the line move → already handled by the modal's
  live re-validation against the store (part c).
- **Single-character roster** (no valid target) → the "Move to" option's select
  is empty; that branch stays disabled, only "own character" is selectable. (In
  practice unlinking implies ≥2 characters, but the dialog must not crash on a
  degenerate roster.)
- **Network failure on repoint** → surfaced through the drawer's existing
  `aliasError` path (same as unlink today); no partial roster mutation because
  the reducer dispatch follows a successful API resolve.

## Testing

- **Server** (`server/src/routes/cast-aliases.test.ts`): repoint moves the
  string atomically source→target; dedups when target already has it; rejects
  self-target, unknown book/source/target, and alias-not-on-source; returns the
  same lineage (`impactedChapters`) as unlink for the same alias.
- **Frontend unit:**
  - `cast-slice` — `applyRepointAlias` strips from source, appends to target,
    dedups, guards self-alias, idempotent on re-dispatch.
  - `unlink-alias-dialog.test.tsx` — Continue disabled until valid; Cancel is a
    no-op; both branches resolve the right choice; source excluded from target
    options; degenerate single-character roster doesn't crash.
  - **Rewrite the three existing `profile-drawer.test.tsx` unlink cases** (the
    "clicking the X dispatches onUnlinkAlias", "disables every X while an unlink
    is in flight", and "surfaces a server error inline" tests): ✕ now opens the
    dialog first, so they click ✕ → dialog → choose split/move → assert the
    **widened** callback. The `aliasBusy` double-fire guard and inline-error
    assertions move to the post-resolution (dialog-confirmed) path. The
    `onUnlinkAlias` test-double type must widen to carry the destination.
- **e2e** (`e2e/cast-alias-edit.spec.ts`): extend with the move-to-X path — open
  drawer, ✕ a chip, choose "Move to X", assert the chip lands under X and the
  Reassign Lines modal opens seeded to X.
- **Regression plan:** fold part (b) into the existing
  `docs/features/1676-cast-bulk-line-reassignment.md` (widen its scope title to
  cover b+c), since both share the modal + undo surface. Update
  `docs/features/INDEX.md` only if the title/scope line changes.

## Release notes

User-facing line (RELEASE_NOTES.md, in-progress section) + technical register
(docs/release-notes-next.md): "Unlinking a mis-merged name now lets you move it
straight onto the right character, not just split it into a new one."
