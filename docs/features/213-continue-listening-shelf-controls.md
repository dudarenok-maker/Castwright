---
status: active
shipped: null
owner: null
---

# Continue-listening shelf controls (covers · auto-hide · finish/hide)

> Status: active
> Key files: `src/components/library/continue-listening-rail.tsx`, `src/views/book-library.tsx`, `src/store/continue-listening-slice.ts`, `src/lib/api.ts`, `server/src/workspace/listen-stats-aggregate.ts`, `server/src/routes/book-state.ts`, `server/src/routes/library.ts`, `openapi.yaml`
> URL surface: `#/` (Books view rail) — indirect
> OpenAPI ops: `POST /api/books/{bookId}/shelf-status`; extends `ListenProgress` schema

Follow-up polish on the fs-15 Continue-listening rail (plan
[212](archive/212-fs15-fs16-listening-stats.md)). Four user-reported issues,
observed in dark mode on the live workspace.

## Benefit / Rationale

- **User:** the rail shows real cover art (not just a gradient); the scrollbar
  matches the app theme in dark mode; books you've effectively finished drop off
  automatically; and a per-card ⋯ menu lets you **Mark as finished** (e.g. when
  progress sync failed) or **Hide from shelf** without re-listening.
- **Technical:** auto-hide is a server-side aggregation tweak (no client state);
  finish/hide persist on the existing `listen-progress.json` via one new endpoint.
- **Architectural:** introduces explicit shelf flags as the durable signal the
  derived "finished" heuristic could never fully infer, while keeping the rail a
  pure render driven by `GET /api/library/continue-listening`.

## What changed

1. **Covers (#1)** — the rail renders the book's `coverImageUrl` (threaded from
   the library slice as a `bookId → url` map in `book-library.tsx`), with the
   gradient placeholder as fallback on a missing URL **and** on `<img>` error.
   No server/openapi change — the URL already exists on `LibraryBook`.
2. **Scrollbar (#2)** — the scroll strip uses the theme-aware `.scrollbar-thin`
   utility, with `--scrollbar-thin-radius: 0` and `clip-path: none` so the
   utility's rounded in-card clip can't clip the cards' hover shadow / focus ring.
3. **Auto-hide completed (#3)** — `listen-stats-aggregate.ts` gains
   `isEffectivelyComplete` (listenable total > 0 and ≤ `FINISH_TAIL_SEC` of the
   book's end remaining); `isFinished` now also accepts an explicit flag and the
   effectively-complete branch. `buildContinueListening` excludes finished,
   `hidden`, and zero-listenable-audio books. This catches the "0:00 left" cards
   whose resume bookmark sat in a non-listenable trailing chapter.
4. **Finish / Hide (#4/#5)** — `POST /api/books/:bookId/shelf-status`
   `{ finished?, hidden? }` read-modify-writes shelf flags on
   `listen-progress.json`. **`finished` is sticky** (preserved across later
   progress saves) and counts toward the fs-16 "books finished" stat; **`hidden`
   is cleared on the next progress save** (resuming un-hides). The existing
   `PUT /listen-progress` was changed to **merge** rather than overwrite so a
   position save can't erase the flags. The rail's ⋯ menu is a portal-anchored
   popover (the rail's `overflow-x-auto` strip + the card's `overflow-hidden`
   would clip an in-flow dropdown — same reason `status-popover.tsx` portals).

## Invariants to preserve

- `ListenProgress` shape stays backward-compatible — all four new fields
  (`finished`, `finishedAt`, `hidden`, `dismissedAt`) are optional; legacy
  records and the mini-player (which reads only `chapterId`/`currentSec`/
  `playbackRate`/`markers`) are unaffected.
- `PUT /listen-progress` must keep returning a record equal to what it writes
  (`book-state.test.ts` asserts on-disk === response === GET).
- The rail stays presentational; all persistence + toasts live in the
  orchestrator (`book-library.tsx`).

## Known risks (accepted)

- `POST /shelf-status` and `PUT /listen-progress` both read-modify-write
  `listen-progress.json` without a shared per-book lock — a concurrent finish +
  position-save on the *same* book could clobber. Near-impossible via the UI (a
  finished/hidden card is not the active player). Documented, not locked.
- A genuinely in-progress book missing all chapter durations won't appear on the
  rail (no listenable total) — reachable via the library grid.

## Tests

- `server/src/workspace/listen-stats-aggregate.test.ts` — auto-hide / finished /
  hidden cases incl. the "0:00 left" leak repro.
- `server/src/routes/book-state.test.ts` — `shelf-status` write/clear/idempotent/
  404 + the PUT-merge regression (finished sticky, hidden cleared on resume).
- `src/store/continue-listening-slice.test.ts` — `dismiss`.
- `src/lib/api.test.ts` — mock `setShelfStatus` prunes the seeded shelf.
- `src/components/library/continue-listening-rail.test.tsx` — cover + fallback,
  scrollbar class, ⋯ menu finish/hide/Escape.
- `e2e/listening-stats.spec.ts` — finish-via-menu removes the card.

## Ship notes

_To be filled at merge._
