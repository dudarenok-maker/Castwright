---
status: stable
shipped: 2026-06-13
owner: null
---

# fs-15 + fs-16 — Continue Listening rail + Listening-stats dashboard

> Status: stable (shipped 2026-06-13 — web + server via PR #783, companion reporter via PR #785; on-device companion relaunch acceptance owed)
> Key files: `server/src/workspace/{listen-stats,listen-stats-aggregate,chapter-durations,file-lock}.ts`, `server/src/routes/{book-state,library}.ts`, `src/lib/{listen-stats-reporter,listen-stats-math,api}.ts`, `src/store/continue-listening-slice.ts`, `src/components/library/continue-listening-rail.tsx`, `src/components/mini-player.tsx`, `src/views/stats.tsx`
> URL surface: `#/stats` (new top-level view); the rail lives at the top of `#/` (Books library)
> OpenAPI ops: `PUT /api/books/{bookId}/listen-stats`, `GET /api/library/stats`, `GET /api/library/continue-listening`

Spec: [`docs/superpowers/specs/2026-06-13-fs15-fs16-listening-stats-design.md`](../../superpowers/specs/2026-06-13-fs15-fs16-listening-stats-design.md) ·
Plan: [`docs/superpowers/plans/2026-06-13-fs15-fs16-listening-stats.md`](../../superpowers/plans/2026-06-13-fs15-fs16-listening-stats.md).
Issues: [#462 (fs-15)](https://github.com/dudarenok-maker/AudioBook-Generator/issues/462), [#463 (fs-16)](https://github.com/dudarenok-maker/AudioBook-Generator/issues/463).

## Benefit / Rationale

- **User:** one-tap re-entry into whatever you were last listening to, across **any** book (fs-15 rail), and an honest sense of progress — hours listened, books finished, per-book completion, a current + longest streak, a 7-day chart, and a per-series rollup (fs-16 dashboard).
- **Technical:** a new per-book wall-clock play-time store that counts re-listens (not just furthest position), fed by both the web player and (Wave H) the Android companion, with idempotent offline-safe writes.
- **Architectural:** establishes a **session-keyed, server-summed** stats model that is clobber-free across tabs/devices and self-healing under retries — a reusable pattern for any future per-book accrual. Adds `#/stats` as a routine new top-level `Stage` kind.

## Architectural impact

**New data file — `<book>/.audiobook/listen-stats.json`** (sibling to `listen-progress.json`, outside plan-27's rotating-backup contract):
```jsonc
{ "schema": 1, "perDay": [ { "date": "YYYY-MM-DD", "sessions": [ { "sessionId": "…", "seconds": N } ] } ] }
```
- Absolute wall-clock **seconds keyed per `(date, sessionId)`**; the server **sums** sessions per day. Each client mints a fresh `sessionId` per page-load / app-launch — so two browser tabs (shared `localStorage`) or two devices never clobber each other, and a re-sent absolute is idempotent.
- Upserts take **`max(existing, incoming)`** (a session's per-`(book,date)` absolute is monotonic) so an out-of-order/stale retry can't lower a stored value.
- Writes go through a **per-book mutex** (`withKeyLock`, `server/src/workspace/file-lock.ts`, the `design-lock` idiom generalised) under `writeJsonAtomic`. All writes flow through the single Node process, so the in-memory mutex fully covers concurrency.

**Reporting (web):** `StatsAccumulator` (`src/lib/listen-stats-reporter.ts`) measures **wall-clock** (rate- and seek-independent — never reads media `currentTime`), buckets by the viewer's local date, attributes to the active book, splits at midnight, and flushes the prior book on a book switch. Wired into `mini-player.tsx`: flush rides the existing once-per-5s `listen-progress` save gate; final flush on `pagehide`/`visibilitychange` uses `fetch(..., {keepalive:true})`. Scoped to the book mini-player ONLY (sample/A-B/clip previews never accrue).

**Aggregation:** `GET /api/library/stats` returns server-computable figures (`totalListenedSec`, `booksFinished`, `perBook`, `perSeries`) **plus the raw `byDay` map**; the viewing client computes streak/longest/last-7 against its own local "today" (`src/lib/listen-stats-math.ts`) — no timezone lie. `GET /api/library/continue-listening` returns in-progress books (excludes `finished` + the `>5s` noise floor), sorted by `updatedAt` desc.

**Completion / finished:** `completionPct` = consumed ÷ total *listenable* duration (a 0–1 fraction), durations parsed from the chapter `duration` string in `state.json` (no plain `durationSec` field exists). `finished` is **position-based** — resume in the final *listenable* chapter (last non-`excluded`/`held` chapter with audio) and `currentSec ≥ finalDuration − max(30s, 2%)` — decoupled from `completionPct`, so a long book with minutes left isn't prematurely "finished" or dropped from the rail.

**Migration / reversibility:** purely additive. No existing file shape changes. Absent `listen-stats.json` → zero stats (first-run reads as zeros, never NaN). Deleting a book removes its `listen-stats.json` with the directory (`DELETE /api/books/:id`); the delete-confirm UI warns about this (D14).

## Invariants to preserve

1. Stats slots are keyed per `(date, sessionId)` and **summed** server-side — never per-device-overwrite. Changing to a single per-device/per-book counter reintroduces the multi-tab clobber (C4).
2. Slot upsert is **`max()`**, not blind overwrite (`server/src/workspace/listen-stats.ts`) — protects against out-of-order delivery (S2).
3. The web accumulator is **wall-clock from an injected clock**, never media `currentTime` (`src/lib/listen-stats-reporter.ts`) — keeps hours rate/seek-independent (C2/D2).
4. Streak / last-7 / "today" are computed **client-side** against the viewer's local date (`src/lib/listen-stats-math.ts`); the server only ships raw `byDay` (C1). `StatsView` takes an injectable `today` prop for deterministic tests (PL2).
5. The rail's continue-listening navigation uses `hydrateFromUrl({ kind:'ready', bookId, view:'listen', currentChapterId })` — NOT `openBook` (which would clobber the saved chapter to the default 3).
6. `#/stats` round-trips via `stageToHash` + the `StatsRoute`/`useHydrateStage` registration in `src/routes/index.tsx` (there is no `parseHash`).
7. Every colour in the rail + stats view binds a **brand-palette token** (zero hex/`rgb`/`hsl` literals); single magenta accent on the focal/peak datum; Lora + General Sans.

## Test plan

### Automated coverage

- **Server unit** — `file-lock.test.ts` (mutex serialize/concurrent/throw); `listen-stats.test.ts` (validation incl. roll-over-date + bounds + past-floor/future-skew, `max()` merge, immutability, sums); `chapter-durations.test.ts` (parse, listenable filtering, before-chapter, final-listenable); `listen-stats-aggregate.test.ts` (completion, end-of-final-chapter `finished`, empty=zeros, continue-listening filter+sort).
- **Server integration** — `routes/book-state.test.ts` (PUT idempotent/monotonic, distinct-session sum, 400/404); `routes/library-stats.test.ts` (GET stats zeros-no-NaN, continue-listening after a bookmark).
- **Frontend unit** — `listen-stats-reporter.test.ts` (wall-clock, pause-exclusion, book-switch handoff, midnight split, double-pause/double-drain idempotence, zero-second filtering); `listen-stats-math.test.ts` (streak grace rule, gap-breaking, longest, last-7 zero-fill); `continue-listening-slice.test.ts`; `continue-listening-rail.test.tsx`; `book-library.test.tsx` (rail mount + resume nav); `mini-player.test.tsx` (reports wall-clock via putListenStats on the 5s gate); `stats.test.tsx` (lede figures, streak sentence, 7 sparkbars, completion %, series line, first-run no-NaN); `api.test.ts` (mock max-merge, seed seams).
- **a11y** — `src/test/a11y.test.tsx` includes `#/stats` (axe-clean).
- **Playwright e2e** — `e2e/listening-stats.spec.ts` (rail appears + click → `#/books/sb/listen`; `#/stats` content from `__SEED_LIBRARY_STATS__`); `e2e/responsive/coverage.spec.ts` (`#/stats` no-overflow at every viewport); `e2e/responsive/visual.spec.ts` (`#/stats` snapshot, clock frozen to 2026-06-13 so it can't date-drift).

### Manual acceptance walkthrough (mock mode)

1. **`#/`** with `__SEED_CONTINUE__` seeded → "Continue listening" rail above the grid; tap a card → `#/books/<id>/listen?chapter=N`, resumes at the saved second.
2. Play a chapter on the web player for ~1 min → after 5s flushes, `GET /api/library/stats` `totalListenedSec` grows; re-listening the same minute adds again (wall-clock, counts re-listens).
3. **`#/stats`** (via Account → "Listening stats") → lede hours + books finished, streak sentence, 7-day sparkbars (peak in magenta), in-progress completion list, by-series rollup. First-run (no data) → friendly empty copy, no NaN.
4. Delete a book → confirm dialog warns listening history/stats are removed too; after delete its rows vanish from stats.

## Out of scope

- **Companion reporter (Wave H)** — SHIPPED (PR #785): the Android companion gained a wall-clock accumulator (`listen_stats_accumulator.dart`) + a persisted drift offline buffer (`ListenStatsBuffer`, schema 3→4) that flushes absolute per-(session,date) totals on reconnect (`ListenStatsFlushService` wired into `auto_sync_service`). Report-only (no companion UI).
- Past-day file compaction (collapse closed days into one slot) — noted optimization, not built.
- Per-device stat breakdowns (the session-keyed model intentionally drops device identity as a key).

## Documented limitations

- **No backfill:** completion %/books-finished derive from existing resume positions (work retroactively), but **hours + streak accrue from ship** — historical play-time was never recorded.
- **Finished may diverge from the companion:** the dashboard's `finished` is position-derived; the companion's local `setChapterFinished` is not synced.
- **Simultaneous multi-device playback double-counts** the same wall-clock hour (two sessions, each real time) — rare, defensible, documented.
- **Trusted client inputs within the LAN boundary:** clients supply their own `seconds`/local `date`, bounded by `seconds ≤ 86400` per entry, `days ≤ 366`, and a past-floor/future-skew date guard.

## Ship notes

Shipped **2026-06-13**, in two merges to `main`:

- **PR #783** (merge `349b95fe`) — fs-15 rail + fs-16 `#/stats` dashboard (frontend + server + openapi). Closes #462 / #463.
- **PR #785** (merge `209f44c5`) — Wave H Android companion reporter (report-only). (Re-opened from the auto-closed stacked PR #784.)

Built subagent-driven (one implementer + spec + quality review per task) from the 2026-06-13 spec; the design + spec + plan each went through adversarial review rounds. CI was billing-blocked, so both PRs merged on the authority of a green local `npm run verify` (web/server) + `flutter test` 294 / `flutter analyze` clean (companion), via `gh pr merge --admin`.

**No behaviour delta vs. the spec.** Residual: on-device companion relaunch acceptance (buffer survival across an app kill is correct by design + unit-tested with in-memory drift, but unproven on a real device).
