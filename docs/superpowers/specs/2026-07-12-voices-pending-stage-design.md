# Design: `voices_pending` book stage

**Date:** 2026-07-12
**Status:** approved (design)
**Area:** frontend + server (book-stage model)

## Problem

Reopening a book from the library can land the user on the **Generate** tab
before they have designed voices or started generation, which contradicts the
fe-46 voice-design flow (voice design is a taught step in the **Cast** view,
*after* cast confirmation and *before* generation).

Two pieces cause it:

1. **Server status derivation** (`server/src/workspace/scan.ts:734`):

   ```
   else if (state && state.castConfirmed && completedChapters < chapterCount)
     status = 'generating';
   ```

   A book flips to `'generating'` the instant the cast is **confirmed** — even
   if zero chapters have rendered and no voices are designed. `'generating'`
   really means "cast confirmed, not yet complete," not "actively generating."

2. **Client routing** (`src/store/ui-slice.ts:246`):

   ```
   status === 'complete' ? 'listen' : status === 'generating' ? 'generate' : 'cast'
   ```

   So any `'generating'` book opened from the library jumps straight to the
   **Generate** tab.

fe-46 already routes the in-session *confirm → ready* transition to the Cast
view (`ui-slice.ts:220-225`), but the **library-reopen path bypasses that**.
The state machine has no status that distinguishes "cast confirmed, generation
not started" from "actively generating," so both share `'generating'` and both
route to Generate.

## Goal

A book that has a confirmed cast but has **not started generating** should:

- carry a distinct library status (`voices_pending`),
- show a **"Cast ready"** badge on its library card, and
- reopen onto the **Cast** view (where voice design lives), not Generate.

Once generation has started it reads `generating` and routes to Generate as
before.

## Non-goals

- Making voice design mandatory. It stays optional — the fe-46 voice-readiness
  gate ("Proceed anyway → generic fallback") is unchanged. `voices_pending` is
  a *landing/routing* decision, not a hard gate.
- Replicating the client's `resolveVoiceStatus` "Needs voice" logic on the
  server. The trigger is **generation-not-started**, not
  voices-actually-undesigned — so the server never needs to compute
  designed-ness (avoids forking the plan-240 definition).

## The state machine

```
not_analysed → analysing → cast_pending → voices_pending → generating → complete
                                          └──── NEW ────┘
```

`voices_pending` ≡ `castConfirmed === true` **AND** generation has not started
**AND** the book is not yet complete.

## Detection: derive from disk (no new state.json field)

"Generation started" is already observable on disk, so no schema change,
migration, or new server write path is needed:

```ts
const generationStarted =
  completedChapters > 0 ||
  activeChapters.some((c) => c.generationState === 'failed');
```

- `completedChapters` = audio files on disk (already computed).
- `generationState === 'failed'` = the durable per-chapter failure marker
  (`BookStateJson.chapters[].generationState`, already read).

New ladder in `scan.ts`:

```
else if (state && !state.castConfirmed)
  status = 'cast_pending';
else if (state && state.castConfirmed && !generationStarted && completedChapters < chapterCount)
  status = 'voices_pending';
else if (state && state.castConfirmed && completedChapters < chapterCount)
  status = 'generating';
else
  status = 'complete';
```

**Accepted tradeoff:** while the *first* chapter is rendering (0 done, 0 failed
yet), a cold scan briefly reports `voices_pending`, so a reopen in that window
lands on Cast rather than Generate. It is a single-chapter, self-healing window
(the next completed-or-failed chapter flips it to `generating`), and landing on
Cast is not broken — the nav reaches Generate in one click. A durable
`generationStartedAt` flag would close the window but adds a write path,
an optional schema field, and tests; rejected under "simplicity first."

## Client routing

`src/store/ui-slice.ts` `openBook` — add the new status to the ready-stage
branch so it lands on the Cast view:

```ts
const view: View =
  status === 'complete' ? 'listen'
  : status === 'generating' ? 'generate'
  : 'cast'; // covers voices_pending, not_analysed, unreadable, orphaned
```

`voices_pending` falls through to `'cast'` naturally (it is neither `complete`
nor `generating`), so this is effectively a no-op *once the status exists* — but
we assert it explicitly in a routing test so a future refactor can't regress it.

## Library card UI

`src/components/library/library-status-ui.tsx` — new `STATUS_UI` entry:

```ts
voices_pending: {
  color: 'library',            // blue — informational, not warning/error
  label: 'Cast ready',
  icon: <IconCheckCircle className="w-3.5 h-3.5" />,
},
```

`src/views/book-library.tsx`:

- add `voices_pending` to `IN_PROGRESS_STATUSES` (it belongs under the
  "In progress" filter and the in-progress total).

No `progress` value (nothing generated), so the card shows no progress bar —
consistent with `cast_pending`.

**Defensive fallback** (`library-grid.tsx:167`): `realGetLibrary`
(`src/lib/api.ts:1830`) casts the server JSON straight to `LibraryResponse`
with no runtime enum validation, and `library-grid.tsx:167` reads
`STATUS_UI[book.status].color/.label` unconditionally. A server/client version
skew (server ships a status the bundled `STATUS_UI` map lacks) would make the
lookup `undefined` and **crash every card in the grid**, not just the affected
book. Harden the read so an unknown status degrades to a neutral pill instead
of crashing:

```ts
const meta = STATUS_UI[book.status] ?? {
  color: 'library', label: book.status, icon: <IconCircle className="w-3.5 h-3.5" />,
};
```

This is defence-in-depth for the enum living in **three hand-synced places**
(`server/src/workspace/scan.ts`, `src/lib/types.ts`, generated
`src/lib/api-types.ts`) with no shared type across the server boundary.

## Propagation sites (don't miss a consumer)

| Site | Change |
|---|---|
| `server/src/workspace/scan.ts` `LibraryBookStatus` union | add `'voices_pending'` |
| `server/src/workspace/scan.ts:442` `isConfirmed` helper | include `voices_pending` — it **is** a confirmed cast; series-memory counting must not regress |
| `src/lib/types.ts` `LibraryBookStatus` | add `'voices_pending'` |
| `openapi.yaml` status enum | add `voices_pending`; regenerate `src/lib/api-types.ts` via `npm run openapi:types` |
| `src/store/ui-slice.ts` `openBook` | routing assertion (above) |
| `src/components/library/library-status-ui.tsx` `STATUS_UI` | new entry |
| `src/views/book-library.tsx` `IN_PROGRESS_STATUSES` | add status |
| `src/mocks/library.ts`, `src/data/books.ts` | add a `voices_pending` sample so mock/dev mode renders the state |
| `src/components/library/library-grid.tsx:167` | defensive `STATUS_UI[status] ?? neutral` fallback (see above) |
| `src/components/layout.tsx:991-1003` (`bgBookIds` poll) | **reviewed — no change.** Negative-list filter; `voices_pending` books already passed it as `generating`, so inclusion is unchanged |

**Atomicity requirement:** the three enum-union edits (`scan.ts`, `types.ts`,
regenerated `api-types.ts`) and the `STATUS_UI` map entry must land in the same
change — a bundle where the server emits `voices_pending` but the client map
lacks it would rely solely on the defensive fallback above.

**Positive-vs-negative-list rule (audit invariant):** the hazard when splitting
a status off `generating` is *positive-list* checks (`status === 'generating'`)
— they now silently miss the split-off books. *Negative-list* checks
(`status !== 'analysing' && …`) are safe (the book stays included). Every
positive-list consumer was enumerated: `isConfirmed` (fixed), `IN_PROGRESS_STATUSES`
(fixed), `library-grid.tsx:353` progress bar (correctly *excludes* `voices_pending`).
No positive-list consumer is missed.

## Testing

- **`scan.test.ts`** (server): castConfirmed + 0 rendered + 0 failed →
  `voices_pending`; +1 rendered → `generating`; all-chapters-failed (0 rendered,
  ≥1 failed) → `generating`; castConfirmed + all rendered → `complete`.
- **`ui-slice` test**: `openBook({status:'voices_pending'})` → `ready` stage on
  `cast` view.
- **`library-status-ui.test.ts`**: this test iterates a **hardcoded**
  `ALL_STATUSES` array (not the map), so add `'voices_pending'` to it — the
  `Record<LibraryBookStatus, StatusMeta>` type already forces the map entry at
  compile time, but the test must list the new key to actually exercise it.
- **`book-library` filter test**: a `voices_pending` book counts under
  "In progress".
- **e2e**: extend `e2e/cast-first-landing-and-voice-gate.spec.ts` — a
  cast-confirmed, not-yet-generated book reopened from the library lands on the
  Cast view.

## Regression plan

New feature doc under `docs/features/` (from `TEMPLATE.md`) documenting the
stage, the derivation invariant, and the manual acceptance walkthrough; add its
entry to `docs/features/INDEX.md`.

## Ship notes

_(filled at ship time)_
