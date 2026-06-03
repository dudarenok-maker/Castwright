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

- **New module** `resource-telemetry.ts`: `ResourceTelemetryRecord`, `TELEMETRY_MAX_LINES = 2000`, `telemetryFilePath()` = `<WORKSPACE_ROOT>/.telemetry/resource-telemetry.jsonl` (new `telemetryDir()` in `paths.ts`, mirroring `.backups`), `appendTelemetry(rec)` (append one JSONL line, dir auto-create, trim oldest over cap, best-effort — swallows IO errors), `readTelemetry(limit?)` (newest-first, skips a corrupt trailing line).
- `generation.ts` completion block: **fire-and-forget** `void appendTelemetry({...})` right after `recordChapterThroughput` — never awaited, never blocks the hot path. `wallSec = synthSec`; VRAM/host-RAM via a best-effort `probeSidecarHealth()` (short timeout, gated on a sidecar engine), nulls on timeout.
- **New endpoint** `GET /api/generation/telemetry?limit=` mounted on the existing `generationStatsRouter` → `{ records: ResourceTelemetryRecord[] }` newest-first. `api.getResourceTelemetry()` (real + mock).
- `src/views/admin.tsx`: a `ResourceTrends` section rendered **after** `GenerationThroughput` and **before** the DEV-only `WorktreesSection` — a compact table + a hand-rolled inline SVG RTF sparkline (no charting dependency), best-effort poll with last-good-on-error like the sibling panels.

## Invariants to preserve

1. The telemetry append is **fire-and-forget** and best-effort — a telemetry failure must never affect chapter generation or RTF.
2. The JSONL is capped at `TELEMETRY_MAX_LINES`; rotation drops the oldest; a corrupt trailing line is skipped, not thrown.
3. The panel lives in the **admin console** (`src/views/admin.tsx`), not the DEV-only worktrees view (the fs-20 issue predated the worktrees→admin fold).

## Test plan

- **Automated:** `server/src/tts/resource-telemetry.test.ts` — append N to a temp dir; JSONL round-trips; cap rotation drops oldest; `readTelemetry(limit)` newest-first + honors limit; partial trailing line skipped. `server/src/routes/generation-stats.test.ts` — `GET /telemetry` returns records. `src/views/admin.test.tsx` — mock `api.getResourceTelemetry`; panel renders rows incl. VRAM + wall columns + sparkline; empty → "No telemetry recorded yet."
- **Manual:** generate a few chapters, open `#/admin`, confirm the Resource trends panel shows RTF + VRAM + wall-time rows and the sparkline tracks RTF.

## Ship notes

Shipped on `feat/server-generation-quality` (integration round 2026-06-03), commit `ee22859`. Closes #470. Automated server + frontend coverage green via `npm run verify`. **Owed:** live acceptance after a multi-chapter run on the GPU box.
