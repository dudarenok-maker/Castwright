---
status: active
shipped: null
owner: null
---

# Admin watch console (fs-18 diagnostics health board)

> Status: active
> Key files: `src/views/admin.tsx`, `src/components/admin-pill.tsx`, `server/src/routes/diagnostics.ts`, `server/src/diagnostics/{ffmpeg,disk}.ts`
> URL surface: `#/admin` (`#/worktrees` kept as an inbound alias)
> OpenAPI ops: `GET /api/diagnostics`

## Benefit / Rationale

Folds backlog item **fs-18** (#468) into the former dev-only Worktrees console, turning it into an all-users **Admin watch console**.

- **User:** "why is it broken?" becomes a glanceable green/amber/red board (GPU/VRAM, TTS sidecar + resident models, analyzer connectivity, ffmpeg, free disk) plus the live generation-throughput table — no log-grepping, no debug window, no terminal. A top-bar **Admin** pill carries a health status dot so trouble is visible from any view.
- **Technical:** one `GET /api/diagnostics` aggregator reuses the in-process probe helpers extracted from the existing health routes (no HTTP self-calls) and adds two cheap net-new probes (ffmpeg presence, free disk). Each check is isolated — one failing probe yields a `fail` row, never a 500.
- **Architectural:** the diagnostics surface is now first-class and extensible (add a `CheckId` + a `runCheck(...)` block). The git-worktree list stays the only dev-gated piece, at both layers (frontend `import.meta.env.DEV` + the server route's existing production 404).

## Architectural impact

- **New seams:** `GET /api/diagnostics` (`server/src/routes/diagnostics.ts`) + `server/src/diagnostics/{ffmpeg,disk}.ts` probes; exported in-process probe helpers `probeSidecarHealth()` / `probeOllamaHealth()` / `readGpuQueueState()` (the dedicated health routes now delegate to these). Frontend `api.getDiagnostics()` + `DiagnosticsResponse`/`DiagnosticsCheck` types.
- **Rename:** stage `{ kind: 'worktrees' }` → `{ kind: 'admin' }`; `openWorktrees` → `openAdmin`; `stageToHash` emits `#/admin`; route element `AdminRoute`; view `AdminView` (`src/views/admin.tsx`); pill `AdminPill` (`src/components/admin-pill.tsx`). `#/worktrees` stays as an inbound route alias for old dev bookmarks (canonicalises to `#/admin`).
- **Invariants preserved:** discriminated-union `ui.stage` (still one variant per surface, no flattening); OpenAPI is the type source of truth (schemas added + `npm run openapi:types` regenerated); design tokens (dots use Tailwind `bg-green/amber/rose-500`).
- **Reversibility:** the aggregator is additive; the rename is mechanical. Reverting means restoring the `worktrees` names + dropping `/api/diagnostics`.

## Invariants to preserve

- `Stage` union in `src/lib/types.ts` includes `{ kind: 'admin' }` (no longer `'worktrees'`); `stageToHash` in `src/lib/router.ts` maps `admin → #/admin`.
- The top-bar `AdminPill` is rendered **unconditionally** (`src/components/top-bar.tsx`) — it is no longer behind `import.meta.env.DEV`.
- The worktree-list section in `src/views/admin.tsx` is rendered **only** when `import.meta.env.DEV`; `server/src/routes/worktrees.ts` still 404s when `NODE_ENV === 'production'`.
- `GET /api/diagnostics` always returns HTTP 200 with the full `checks[]` array; a throwing probe degrades to a `fail` row (see `runCheck` in `server/src/routes/diagnostics.ts`).
- Analyzer rows are engine-aware: the Ollama row is `ok`/"not in use" when the resolved engine is Gemini; the Gemini row only `fail`s when Gemini is selected and `GEMINI_API_KEY` is unset.

## Test plan

### Automated coverage

- Vitest server (`server/src/diagnostics/disk.test.ts`) — `probeDiskSpace` ok/warn/fail thresholds via a stubbed `statfs`.
- Vitest server (`server/src/diagnostics/ffmpeg.test.ts`) — `probeFfmpeg` present / missing / non-zero-exit via a stubbed `spawnSync`.
- Vitest server (`server/src/routes/diagnostics.test.ts`) — per-check status derivation (GPU VRAM warn, CPU-only ok, sidecar-down fail), analyzer-skipped-when-Gemini, Gemini key present/absent, ffmpeg-missing, disk status, one-probe-throws → `fail` row + still 200, and `overall` = worst severity.
- Vitest (`src/components/admin-pill.test.tsx`) — RTF readout states (idle / live-batch / fallback / fetch-error) plus health-dot states (grey before first poll, green/amber/red from `overall`, last-known-on-error).
- Vitest (`src/views/admin.test.tsx`) — health-board rows render from mocked diagnostics; throughput table behaviour preserved; **worktrees section present only when `import.meta.env.DEV`** (flipped via `vi.stubEnv`).
- Playwright e2e (`e2e/admin.spec.ts`) — Admin pill reachable for all users, `#/admin` renders the board, status dot reflects the mock `overall: 'ok'`.
- Playwright responsive (`e2e/responsive/coverage.spec.ts`) — `admin (global) view` row asserts no horizontal overflow at all three viewports.

### Manual acceptance walkthrough

Run a real `npm start` (server + sidecar) so the probes hit live processes.

1. **Open `#/admin` as a normal user** → heading "Admin"; Health board lists GPU/VRAM, TTS sidecar, Analyzer (Ollama), Analyzer (Gemini), ffmpeg/ffprobe, Free disk, each with a green/amber/red dot + technical detail; the generation-throughput table renders below; **no Worktrees section** (production build) / Worktrees section present under `npm run dev`.
2. **Top-bar Admin pill** → shows a dot matching the board's `overall`; during a generation run it also shows the live RTF number.
3. **Kill the sidecar** → within ~30 s the GPU + TTS-sidecar rows go red and the top-bar dot turns red.
4. **Switch analyzer engine to Gemini without a key** → the Gemini row turns red ("GEMINI_API_KEY not set"); the Ollama row reads "not in use (engine: gemini)".

## Ship notes

- Shipped: _pending merge_ — branch `feat/frontend-admin-console`, closes #468.
