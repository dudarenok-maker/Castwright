# fs-15 + fs-16 — Cross-book "Continue listening" + Listening-stats dashboard

- **Date:** 2026-06-13
- **Issues:** [fs-15 #462](https://github.com/dudarenok-maker/AudioBook-Generator/issues/462), [fs-16 #463](https://github.com/dudarenok-maker/AudioBook-Generator/issues/463)
- **Areas:** frontend · server · openapi · companion (Android, report-only)
- **Status:** design (pre-plan)

## Summary

Two listener-experience features that share one new data foundation:

- **fs-15** — a cross-book **"Continue listening" rail** at the top of the web Books library, sorted by most-recently-played, that resumes straight to the saved position in any book. Mirrors the companion's existing app-14 home shelf.
- **fs-16** — a dedicated **`#/stats` view**: total hours listened, books finished, per-book completion %, current + longest streak, a 7-day activity chart, and a per-series rollup. Tufte-styled (numbers-in-sentences, sparkbars, sorted-by-value, single accent, no chrome).

fs-15 is already well-supported by the existing per-book resume bookmark. fs-16 needs a **new server-side play-time store**, because today the server keeps only the *latest* resume bookmark per book (`listen-progress.json` = `{ chapterId, currentSec, updatedAt }`) — there is no accumulation of time and no day-by-day history, so "hours listened" and "streak" cannot be derived from existing data.

The companion app becomes a **first-class reporter** of play-time (report-only — no new companion UI this round), so the web dashboard reflects listening done on either platform.

## Decisions (locked during brainstorming)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Full server-side play-time store** (not position-estimated) | Accurate hours that count re-listens; honest streak. |
| D2 | **Wall-clock seconds, playback-rate-independent** | "Time spent listening," Audible-style. Sidesteps 2×-speed inflation and seek-inflation entirely. |
| D3 | **Slots keyed per `(session, date)`, server SUMS across sessions** | A device can have multiple concurrent accumulators (two browser tabs share one origin; app relaunch). Per-*session* keys + server-side summation make writes non-clobbering, idempotent, offline-safe, and multi-device correct. `deviceId` is **not** used as a key. |
| D4 | **Per-book `listen-stats.json`** (not a workspace rollup) | Matches the existing per-book file pattern; isolated writes. Trade-off accepted: deleting a book removes its days from streak history (D14 warns the user). |
| D5 | **Calendar math (streak / longest / last-7) is client-side** | Slots are keyed by the *client's local date*; only the viewing client knows "today." Server returns the raw per-day totals; client computes the date-relative figures. |
| D6 | **Streak rule:** run of consecutive days ending on the most recent listen-day, counted as *current* only if that day is **today or yesterday** (one grace day) | Testable; matches user intuition (midnight doesn't instantly break a streak). |
| D7 | **Completion %** = consumed listenable-seconds ÷ total listenable-seconds; **finished = ≥ 99%** (live-derived, not latched) | Durations sourced from the srv-32 sync-manifest aggregation. |
| D8 | **Companion: report-only** | Smallest cross-platform footprint; web/server own the dashboard. |
| D9 | **fs-16 lives at a dedicated `#/stats` route**, Reading-column Tufte layout | Too much content for a small card. |
| D10 | **fs-15 is a "Continue listening" rail** at the top of the library, excludes finished + the `>5s` noise floor | Mirrors companion app-14; consistent cross-platform. |
| D11 | **Wire contract:** `PUT` body `{ sessionId, days: [{ date, seconds }] }` (array, not a date-keyed map) | Cleaner for the companion's Dart generator + explicit per-entry validation. |
| D12 | **Per-book read-modify-write serialized** by a small generic per-key promise-chain mutex | Prevents lost slots when web + companion write the same book's file concurrently. |
| D13 | **Accumulator scoped to the book mini-player only** | Voice previews / A-B auditions / clip-share previews are not "listening" and must not accrue stats. |
| D14 | **Delete-book confirm warns** that listening history/stats for the book are removed | Surfaces the D4 trade-off. |

## Data model

New per-book file `<book>/.audiobook/listen-stats.json` (sibling to `listen-progress.json`, outside the rotating-backup contract):

```jsonc
{
  "schema": 1,
  "perDay": [
    { "date": "2026-06-13", "sessions": [
      { "sessionId": "a1b2c3…", "seconds": 4120 },
      { "sessionId": "d4e5f6…", "seconds": 900 }
    ] }
  ]
}
```

- **`seconds`** is the *absolute* wall-clock total that session has accrued for that book on that local date. A session always re-sends its own absolute on each flush → idempotent + self-healing; no session can clobber another because each owns its own slot, and the server **sums** sessions per date.
- **`sessionId`** is a fresh random id per accumulator instance (per web page-load / per companion app-launch).
- A play interval that crosses local midnight is split across the two `date` entries.

### Write semantics

`PUT /api/books/:bookId/listen-stats` body `{ sessionId, days: [{ date, seconds }] }`:

1. `findBookByBookId` → bookDir (404 if absent).
2. Validate: `sessionId` non-empty string; each `date` an ISO `YYYY-MM-DD`; reject dates more than the existing skew window into the future; `seconds` finite ≥ 0.
3. **Under the per-book mutex (D12):** read current file, upsert each `(date, sessionId)` slot to the supplied absolute `seconds`, `writeJsonAtomic`.
4. A batched `days` array lets the companion flush several offline days in one call.

## Reporting

### Web (`src/components/mini-player.tsx`)

A checkpoint accumulator keyed by **`(bookId, sessionId, localDate)`**:

- `sessionId` minted once per page-load. `deviceId` is not used.
- On each flush tick (reuse the existing ~5s save cadence) and on every `playing`→pause, `ended`, chapter-switch, **book-switch**, and teardown: if `playing`, add `now − lastCheckpoint` to the current `(bookId, date)` counter and advance `lastCheckpoint`. Computed from `Date.now()` deltas (robust to background-tab timer throttling).
- **Book-switch (D-C5):** flush the prior book's slot, then begin attributing to the new book. Chapter-switches within a book keep accumulating.
- Midnight crossing splits the delta across two `date` counters.
- Flush = `PUT …/listen-stats` with the accumulated absolute(s). Final flush on `pagehide`/`visibilitychange` uses `fetch(url, { keepalive: true })` (not `sendBeacon`, which is POST-only) so it survives unload while keeping the `PUT` verb.
- **Scope (D13):** only the global book mini-player accumulates — `use-sample-playback`, `use-ab-playback`, and clip-share previews do not.

### Companion (Android, report-only)

- A Dart checkpoint accumulator over the app-5 `PlayerController`, counting only `playing && processingState == ready` (a LAN stall must not inflate wall-clock).
- A persisted (drift) **offline buffer storing `{ sessionId, date → seconds }`** so a flush after reconnect *or after an app relaunch* re-sends the correct absolute for the right slot, then clears on ack. Persisting seconds without the `sessionId` would corrupt the server-side sum.
- Flush on the app-8 reconnect path. Dart unit tests only; no new companion screen.

## Aggregation endpoints

### `GET /api/library/stats`

Returns the server-computable figures **plus** the raw per-day map for client-side calendar math:

```jsonc
{
  "totalListenedSec": 169920,          // Σ all sessions, all days, all books
  "booksFinished": 6,                  // count of books at ≥99% (live-derived)
  "perBook": [ { "bookId", "title", "completionPct", "finished" } ],   // sorted desc by completion
  "perSeries": [ { "series", "finishedCount", "importedCount" } ],     // imported-in-series only (D-M7)
  "byDay": [ { "date": "2026-06-13", "seconds": 5020 } ]               // summed across books + sessions; client derives streak/longest/last-7
}
```

- **Durations** for `completionPct` come from the srv-32 sync-manifest's per-chapter `durationSec` (lightest lookup — not the full gzipped-manifest HTTP builder). Completion = `(Σ durations before resume chapter + currentSec) ÷ total listenable duration`; divide-by-zero → `0%` (first-run guard).
- **`perSeries.importedCount`** is the count of books *in the workspace* for that series — we don't know the canonical series length; labeled accordingly.

### `GET /api/library/continue-listening`

```jsonc
[ { "bookId", "title", "chapterId", "currentSec", "remainingSec", "completionPct" } ]
```

- In-progress only: **excludes finished (≥99%)** and books under the **`>5s` noise floor**; sorted by resume `updatedAt` desc.
- Tap → navigate to `#/books/:bookId/listen?chapter=N`; the existing plan-47 on-mount resume-seek lands on `currentSec`. The rail only needs `bookId` + `chapterId`.

Both endpoints sit behind the existing `/api` LAN-token guard and are documented in `openapi.yaml`; `npm run openapi:types` regenerates `src/lib/api-types.ts`. The companion only consumes the `PUT`.

## UI

### fs-15 — Continue-listening rail

Mounts in the `src/views/book-library.tsx` orchestrator, above the grid region, as a new presentational sub-component under `src/components/library/`. Horizontal shelf of in-progress books (cover, title, "Ch N · M left", progress bar). Hidden when there are no in-progress books. Touch targets ≥44 px; responsive per the three-viewport protocol.

### fs-16 — Stats view (`#/stats`)

New `Stage` kind `stats` (the `Stage` union already carries ~13 top-level kinds — this is the routine pattern), `stageToHash` → `#/stats`, rendered from `App.tsx`. Entry point: a link from Account / library.

**Reading-column layout**, Tufte-compliant:
- A lede sentence with the headline figures inline ("You've listened for **47h 12m** across **N books**, finishing **6**").
- A streak sentence ("On a **12-day** streak — longest yet **23 days**").
- 7-day sparkbars (thin bars, single accent on the peak, day initials, no frame).
- Sorted in-progress completion list (thin progress bar + right-aligned %, single magenta accent on the focal row).
- By-series rollup as a small two-column table.

Design tokens only (`--peach`/`--ink`/`--magenta` etc.); no hex literals. No giant KPI cards, no pie/donut, no chrome.

## Edge cases & documented limitations

- **No backfill:** completion % and books-finished work retroactively (derived from existing resume positions), but **hours and streak accrue from ship** — historical play-time was never recorded.
- **Finished may diverge from the companion (D-M3):** the dashboard's `finished` is position-derived (≥99%); the companion's local `setChapterFinished` flag is *not* synced (report-only).
- **Trusted client inputs within the LAN boundary:** a client supplies its own `seconds` and local `date`; a wrong client clock pollutes a day, a buggy client could inflate hours. Acceptable for a LAN personal tool; stated as a boundary.
- **Deleted resume chapter:** if a bookmark's `chapterUuid` no longer resolves, completion is computed at the fallback `chapterId` position (possibly shifted). Rare.
- **Finished is not latched:** a finished book that later gains a chapter (reparse / `replace-manuscript`) grows its denominator and can drop below 99%, decrementing the count.
- **File growth:** one slot per `(session, date)` forever (tiny). **Optional follow-up (not v1):** compact closed past-days into a single daily total once `date < today`.
- **Concurrent read/write:** `writeJsonAtomic` (tmp + rename) guarantees a dashboard GET reads either the old or new file, never a torn one.

## Testing

- **Server unit:** stats merge (idempotency, multi-session sum, no-clobber under the mutex, date/sessionId validation, future-date rejection); aggregation (completion math + divide-by-zero, finished threshold, per-series imported-count, empty=zeros not NaN); `byDay` summation across books + sessions; continue-listening sort + finished/noise-floor exclusion.
- **Frontend unit:** checkpoint accumulator (wall-clock vs rate, seek not counted, pause/teardown, book-switch attribution, midnight split); `sessionId` mint; client-side streak/longest/last-7 incl. the grace-day rule and gap handling; stats view + rail render; first-run zeros.
- **e2e (Playwright):** rail appears → click resumes to saved position (crosses router/redux/layout); `#/stats` renders from seeded stats. The dashboard visual snapshot lands in the **`test:e2e:visual`** lane (`--workers=1`) to avoid Windows font-hinting flake.
- **Companion (Dart):** accumulator (ready-only), offline buffer persistence incl. `sessionId`, absolute-flush idempotency across relaunch.
- **Regression plan:** new doc under `docs/features/` + `INDEX.md` entry; issues #462/#463 linked from the delivering PR.

## Out of scope (this round)

- Any new companion UI (stats screen, server-driven continue-listening parity) — report-only.
- Past-day file compaction (noted follow-up).
- Per-device stat breakdowns (the `sessionId` model intentionally drops device identity as a key).
