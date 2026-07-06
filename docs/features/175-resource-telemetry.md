---
status: active
shipped: null
owner: null
---

# 175 — Per-run resource telemetry + admin trend panel (fs-20)

> Status: active — automated coverage green; live acceptance owed.
> Key files: `server/src/tts/resource-telemetry.ts`, `server/src/routes/generation.ts`, `server/src/routes/generation-stats.ts`, `server/src/workspace/paths.ts`, `src/views/admin.tsx`, `src/lib/api.ts`
> URL surface: `#/admin` (new "Resource trends" section)
> OpenAPI ops: `GET /api/generation/telemetry`

## Benefit / Rationale

- **Technical:** durable per-chapter telemetry (RTF, VRAM reserved/total, committed host RAM, wall-time) gives perf-regression visibility for exactly the RTF / VRAM / host-RAM firefighting that has dominated recent history — without grepping logs.
- **User (operator):** the new "Resource trends" panel in the all-users **Admin** watch console (plan 172) charts RTF over recent chapters and tabulates VRAM + wall-time at a glance.
- **Architectural:** complements the in-memory `recordChapterThroughput` (plan 127) with a rolling on-disk JSONL that survives restarts; the admin console gains a third data panel alongside Health board + Generation throughput.

## Architectural impact

- **`bookTitle` on the record (2026-06-07):** the JSONL record carries the human-readable `state.title` alongside the `bookId` slug, stamped at append time in `generation.ts`. Nullable for legacy records written before the field. The admin panel groups newest-first rows into contiguous per-book runs (`groupTelemetryByBook`) under a sticky header (label = `bookTitle ?? bookId ?? '(unknown book)'`), and caps the rows at `max-h-[60vh]` with `overflow-y-auto` so a long run scrolls inside the card instead of running off the page. Filed as a `bug` (no scroll + no book name in the table).
- **New module** `resource-telemetry.ts`: `ResourceTelemetryRecord`, `TELEMETRY_MAX_LINES = 2000`, `telemetryFilePath()` = `<WORKSPACE_ROOT>/.telemetry/resource-telemetry.jsonl` (new `telemetryDir()` in `paths.ts`, mirroring `.backups`), `appendTelemetry(rec)` (append one JSONL line, dir auto-create, trim oldest over cap, best-effort — swallows IO errors), `readTelemetry(limit?)` (newest-first, skips a corrupt trailing line).
- `generation.ts` completion block: **fire-and-forget** `void appendTelemetry({...})` right after `recordChapterThroughput` — never awaited, never blocks the hot path. `wallSec = synthSec`; VRAM/host-RAM via a best-effort `probeSidecarHealth()` (short timeout, gated on a sidecar engine), nulls on timeout.
- **New endpoint** `GET /api/generation/telemetry?limit=` mounted on the existing `generationStatsRouter` → `{ records: ResourceTelemetryRecord[] }` newest-first. `api.getResourceTelemetry()` (real + mock).
- `src/views/admin.tsx`: a `ResourceTrends` section rendered **after** `GenerationThroughput` and **before** the DEV-only `WorktreesSection` — a compact table + a hand-rolled inline SVG RTF sparkline (no charting dependency), best-effort poll with last-good-on-error like the sibling panels.
- **QA column (2026-07-06):** `ResourceTelemetryRecord` gained `rerecordRtf: number | null`, computed the same way as `generation-stats.ts`'s field of the same name and passed through `generation.ts`'s `appendTelemetry` call, gated on `oneWorker` (mirrors the throughput table's gate). The panel renders it as a "QA" column immediately before RTF (`Chapter, Engine, QA, RTF, Wall, VRAM`), hidden below `sm` alongside Engine/Wall — this is the [[127-generation-rtf-telemetry]] PR-2 plan's Task 5 deferred option (b), now shipped. `verifyRtf` was intentionally left off this table (and the throughput one) — no user-facing need yet.
- **Column-alignment fix (2026-07-06):** `TRENDS_COLS`'s (and `THROUGHPUT_COLS`'s) grid template ended its last column in `auto`, which sizes independently per row (header vs. data are separate grid containers) and drifted every later column out of line with the header — most visible on this table's VRAM column. Fixed by using an explicit rem width for every column; see [[127-generation-rtf-telemetry]] for the full root-cause writeup and the mobile-breakpoint track-count fix that went with it.

## Invariants to preserve

1. The telemetry append is **fire-and-forget** and best-effort — a telemetry failure must never affect chapter generation or RTF.
2. The JSONL is capped at `TELEMETRY_MAX_LINES`; rotation drops the oldest; a corrupt trailing line is skipped, not thrown.
3. The panel lives in the **admin console** (`src/views/admin.tsx`), not the DEV-only worktrees view (the fs-20 issue predated the worktrees→admin fold).
4. Rows group into **contiguous** per-book runs (split on every `bookId` change), preserving the newest-first chronological order — never collapse all of a book's rows together, which would reorder interleaved multi-book runs.

## Test plan

- **Automated:** `server/src/tts/resource-telemetry.test.ts` — append N to a temp dir; JSONL round-trips; cap rotation drops oldest; `readTelemetry(limit)` newest-first + honors limit; partial trailing line skipped; a non-null and a null `rerecordRtf` both round-trip. `server/src/routes/generation-stats.test.ts` — `GET /telemetry` returns records. `server/src/routes/generation.test.ts` ("B1 QA-cost telemetry passthrough") — a lone chapter render's telemetry record carries the matching `rerecordRtf` (polled via `vi.waitFor` since the append is fire-and-forget). `src/views/admin.test.tsx` — mock `api.getResourceTelemetry`; panel renders rows incl. VRAM + wall + QA columns + sparkline; a null `rerecordRtf` renders a dash distinct from the RTF cell; empty → "No telemetry recorded yet."; rows group under a per-book header splitting on `bookId` change; header falls back `bookTitle → bookId → '(unknown book)'`. Playwright `e2e/admin.spec.ts` — the QA column is visible with the mock's value, and a real-layout assertion pins header/row column alignment.
- **Manual:** generate a few chapters, open `#/admin`, confirm the Resource trends panel shows RTF + QA + VRAM + wall-time rows and the sparkline tracks RTF.

## Ship notes

Shipped on `feat/server-generation-quality` (integration round 2026-06-03), commit `ee22859`. Closes #470. Automated server + frontend coverage green via `npm run verify`. **Owed:** live acceptance after a multi-chapter run on the GPU box.
