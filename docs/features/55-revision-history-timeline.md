---
status: active
shipped: null
owner: null
---

# 55 — Revision history timeline

> Status: active
> Key files: `src/components/revision-timeline-modal.tsx`, `src/store/revisions-slice.ts`,
> `src/store/persistence-middleware.ts`, `src/store/ui-slice.ts`,
> `src/views/revision-diff.tsx`, `src/components/layout.tsx`,
> `server/src/routes/book-state.ts`, `openapi.yaml`
> URL surface: indirect — opens as a modal from the existing revision-diff
> player (no new hash).
> OpenAPI ops: `GET /api/books/{bookId}/state` (timeline rides on the
> existing revisions envelope); no new endpoints.

## Benefit / Rationale

- **User:** Per-chapter chronological visibility of every accept / reject
  decision. Today there's no audit trail — the user clicks Accept and the
  prior decision evaporates with no breadcrumb. The timeline modal closes
  that gap and makes "what did I decide last time?" answerable from the
  revision-diff player itself.
- **Technical:** Read-side consumer for plan 20's `acceptedSelections`
  map. The map has been on disk since 2026-05-18 but nothing has read it
  back; plan 55 makes the field visible (kept under-the-hood, but the
  timeline entry carries the same revisionId so future per-segment regen
  can correlate).
- **Architectural:** Establishes the timeline persistence seam. v1.4.0
  builds multi-step rollback on top by extending plan 20's
  `preserveExistingAsPrevious` to write `.previous.<entryId>.mp3` (one
  snapshot per timeline entry) and wiring a rollback POST endpoint.

## Architectural impact

- **New seam:** `revisions.timeline: Record<chapterId, TimelineEntry[]>`
  carried on the `revisions` slice and persisted as part of the existing
  `revisions.json` envelope. Per-chapter append-only list of accept /
  reject / rolled-back events. Each entry: `{ id, chapterId, characterId?,
  eventKind, timestamp, revisionId?, status, reversible? }`.
- **New UI:** `RevisionTimelineModal` mounted alongside `RevisionDiffPlayer`
  from `layout.tsx`. Toggled by a "History" button in the player header
  via the new `ui.revisionHistoryFor: { chapterId } | null` slice field.
- **Invariants preserved** (from cross-cutting plans 00 / 23 / 24 / 26 / 27):
  - Plan 24 (OpenAPI source of truth): `TimelineEntry` is defined in
    `openapi.yaml`; `src/lib/types.ts` re-exports it from generated
    `api-types.ts`.
  - Plan 26 (RTK Immer drafts): reducer mutations append in-place via the
    `appendTimelineEntryHelper`, no spread rewrites.
  - Plan 27 (book state persistence): the timeline lives on
    `revisions.json` (not a sibling file) — same load/write path. New
    field is OPTIONAL on hydrate (defensive `normaliseTimelineKeys` coerces
    string-keyed JSON back to numeric).
- **Reversibility:** Reducer mutations are pure additions on `s.timeline`.
  Reverting the plan removes the field from the slice; existing
  `revisions.json` files with a `timeline` field continue parsing (other
  consumers ignore unknown fields).

## v1.3.0 scope (read-only history view)

This release ships the **history view only**, not the rollback action.
Rationale: plan 20's accept / reject paths each consume the
`.previous.<slug>.mp3` chain — after either action there is no
preserved audio on disk to roll back to. True non-linear rollback needs
**snapshot-per-entry** (one preserved `.previous.<entryId>.mp3` per
timeline entry, with a garbage-collection pass after the user commits or
disk pressure exceeds a cap).

Plumbing for snapshot-per-entry is parked under BACKLOG; the slice
already carries the `rolledBack` reducer + `reversible` field +
`rolled-back-from` status enum, so v1.4.0 only wires the server-side
snapshot mechanism + the rollback endpoint, not the slice.

## Invariants to preserve

1. **`appendTimelineEntryHelper` flips reversibility per chapter.** When a
   new reversible entry is appended on a chapter, every prior entry on the
   same chapter has its `reversible` flag cleared. This keeps `reversible:
   true` as at-most-one per chapter, matching plan 20's single
   `.previous.mp3` semantics. `src/store/revisions-slice.ts`.
2. **`hydrateFromBookState` normalises string-keyed timeline.** JSON
   round-trips Record<number, _> as Record<string, _>; the helper
   `normaliseTimelineKeys` coerces back to numeric keys so the slice's
   typed Record<number, TimelineEntry[]> contract holds at runtime. Books
   without a `timeline` key in their `revisions.json` (i.e. anything from
   before 2026-05-19) load with `timeline: {}`. `src/store/revisions-slice.ts`.
3. **Persistence middleware fans `timeline` to every revisions/* action.**
   Each revisions persist rule in `src/store/persistence-middleware.ts`
   includes `timeline: s.revisions.timeline` in the patch payload, so a
   reload reflects the latest in-memory state. The persistence-middleware
   test pins this for the accept path; reject / dismiss / enqueue /
   markPlayable all carry the same shape.
4. **The modal reads from the slice, not the server.** `useAppSelector((s)
   => s.revisions.timeline)` is the only source of truth — the data was
   already on disk via the hydrate path, so the modal opens instantly
   without an extra round-trip.

## Test plan

### Automated coverage

- `src/store/revisions-slice.test.ts` (extend) — initial-state check
  includes `timeline: {}`; new describe block `plan 55 timeline` covers
  accept/reject append, reversibility flip on subsequent accept, no-op on
  unknown revisionId, `rolledBack` reducer status flip, string-keyed
  hydrate normalisation. **+7 tests, all green.**
- `src/store/persistence-middleware.test.ts` (extend) — new case asserts
  `timeline` rides on the patch for `revisions/acceptRevision`. **+1
  test, green.**
- `src/components/revision-timeline-modal.test.tsx` (NEW) — empty state,
  reverse-chronological ordering, character name rendering, cross-chapter
  flatten view, rolled-back-from stale affordance, close-button onClose.
  **+6 tests, green.**

### Manual acceptance walkthrough

1. **Cold boot** at `#/`; open Solway Bay → mock pending revision appears.
2. Open the A/B player (top-bar Revisions pill).
3. Click **History** in the player header → modal mounts (`data-testid=
   revision-timeline-modal`).
4. Modal initially shows the empty state ("No accept or reject decisions
   recorded yet").
5. Close the modal; click **Accept** → revision drops from pending.
6. Re-open History from the next pending revision (or via store devtools
   dispatch on the same chapter): modal lists one `Accepted revision —
   Halloran` entry with a timestamp.
7. Reload the page → re-open History on the same chapter: entry persists
   (round-trips through `revisions.json` via the persistence middleware).
8. Confirm the `revisions.json` on disk now contains a `timeline` field
   keyed by chapterId.

## Out of scope

- **Rollback button + non-linear undo.** v1.3.0 ships history-only; the
  slice plumbing exists but no UI surfaces it. Multi-step rollback ships
  in v1.4.0 with snapshot-per-entry + GC + the rollback endpoint.
- **Cross-chapter timeline entry point from the Listen view.** A per-row
  "History" affordance on the Listen-view chapter list is a natural
  follow-up — file path: `src/views/listen.tsx`. Kept out of this PR to
  avoid file collisions with plan 53 (mini-player markers panel).
- **Drift events on the timeline.** Drift is its own surface (Drift
  Report); the timeline records *user actions*, not server-detected
  warnings.
- **Regeneration events (regen start / regen complete).** Today every
  regen produces a pending revision the user must accept or reject — the
  accept/reject decision IS the user-meaningful event. Adding regen
  enqueue/complete entries would be noise.

## Ship notes

(Filled in when status flips to `stable`.)
