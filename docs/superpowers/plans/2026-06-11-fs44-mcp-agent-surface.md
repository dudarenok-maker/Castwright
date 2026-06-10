# fs-44 MCP Agent Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any MCP-capable agent (Claude Code/Cowork, Codex, Copilot CLI, Gemini CLI, Cursor…) drives the full Castwright pipeline — upload → analyze → cast → generate → export — through a Streamable-HTTP MCP endpoint at `/mcp` (plus a bundled `castwright-mcp` stdio bridge for stdio-only harnesses), with zero web-UI interaction.

**Architecture:** An in-process MCP endpoint mounted on the existing Express server (`server/src/index.ts`), behind the existing `requireLanToken` guard. ~15 hand-designed workflow-level tools in `server/src/mcp/` call the same importable service functions the REST routes use; where route logic is inlined today, this plan extracts it into an exported function that both the route and the tool call (never a second implementation). Long-running operations return composite `jobId`s projected through a uniform job view (`get_job` / `wait_for_job`); SSE stays UI-only.

**Tech Stack:** Express 5 + `@modelcontextprotocol/sdk` (StreamableHTTPServerTransport, stateless mode) + zod 4 (server), Vitest 4 + supertest + real MCP SDK client over an ephemeral HTTP listener (tests).

**Spec:** `docs/superpowers/specs/2026-06-11-castwright-mcp-agent-surface-design.md` · Issue [#721](https://github.com/dudarenok-maker/Castwright/issues/721) · Backlog `fs-44`.

**Scope note:** This plan delivers spec waves 1–4 — wave 4 (the `castwright-mcp` stdio bridge bin) is **part of the main delivery** (2026-06-11 decision: every agent type must work, including stdio-only harnesses), implemented as task 15. The MCP endpoint is deliberately NOT added to `openapi.yaml` — it is a protocol surface, not a REST resource; the regression plan documents it instead.

**Ground-truth notes (verified 2026-06-11 against the live codebase/registry — bake into execution):**

- `@modelcontextprotocol/sdk` **1.29.0** declares `zod: '^3.25 || ^4.0'` (dependency AND peer), so the server's `zod@^4` is officially in-range. No version juggling; task 1's probe still validates the wiring end-to-end.
- All four job route modules call `sub.res.end()` on every subscriber at job end (`cast-design.ts:147`, `single-design.ts:76`, `analysis.ts:1651`, `generation.ts:431`; `generation.ts:918` also compares `sub.res === res`). A synthetic subscriber without `res` **crashes the job's completion path**. Tasks 8/9/13 therefore attach subscribers built by the shared `makeRecorderSubscriber()` (task 4), which carries a stub `res = { end() {} }` — zero route-interface changes.
- The server package has a real build (`build: tsc -p .` → `dist/`, `start: node dist/index.js`) and `tsx` for dev, so the stdio bridge ships as a compiled bin (`dist/mcp/stdio-bridge.js`) with a `bin` entry, testable from source via `node --import tsx`.

**Commit scope:** `mcp` is not an allowed commit scope — use `server` (and `docs` for docs). Branch: `feat/server-fs44-mcp-agent-surface` off latest `main`, created via the using-git-worktrees skill at execution time. Open the PR as **draft** (CI-cost default), body `Closes #721`.

**Conventions that bind every task below:**

- Server is ESM (`"type": "module"`) — relative imports use the `.js` suffix (`import { scanLibrary } from '../workspace/scan.js'`).
- Tests: vitest globals, async `mkdtemp` from `fs/promises`, set `process.env.WORKSPACE_DIR` **before** deferred `await import(...)` of modules-under-test in `beforeAll` (the established pattern in `server/src/routes/book-state.test.ts`).
- Run server tests from repo root: `npm run test:server` (or `npm --prefix server run test -- <file>` for one file).
- Commit after every green task. Pre-commit hook runs scope-filtered fast tests; if committing from a worktree where husky can't spawn, use the worktree-scoped hooks setup (memory: `extensions.worktreeConfig` + `git config --worktree core.hooksPath`), never `--no-verify`.

---

## File Structure

**New — `server/src/mcp/`:**

| File | Responsibility |
| --- | --- |
| `router.ts` | Express router: stateless StreamableHTTP transport wiring, POST `/` handler, 405 for GET/DELETE |
| `server.ts` | `createMcpServer()` — McpServer factory; registers every tool group |
| `respond.ts` | `jsonResult()` / `toolError()` result helpers (summary line + JSON payload; `{code,message,remediation}` errors) |
| `job-view.ts` | Composite `jobId` scheme + `getJobView(jobId)` uniform projection over all job families |
| `job-recorder.ts` | Outcome ledger for MCP-started jobs (synthetic subscriber events → terminal state) |
| `cast-edit.ts` | `updateCastCharacter()` — thin cast.json patch helper |
| `tools/read-tools.ts` | `list_books`, `get_book`, `get_cast`, `list_voices`, `get_system_status` |
| `tools/job-tools.ts` | `get_job`, `wait_for_job` |
| `tools/pipeline-tools.ts` | `upload_manuscript`, `start_analysis`, `start_generation`, `export_audiobook` |
| `tools/cast-tools.ts` | `update_character`, `merge_characters`, `design_voice`, `design_full_cast` |
| `stdio-bridge.ts` | `castwright-mcp` bin — stdio ⇄ Streamable-HTTP pure transport proxy (wave 4, zero tool logic) |
| `test-harness.ts` | Shared test helper: ephemeral HTTP listener + connected MCP SDK client |
| `*.test.ts` colocated per module; `pipeline.e2e.test.ts` (routed to SLOW_FILES) |

**Modified:**

| File | Change |
| --- | --- |
| `server/src/index.ts` | Add `/mcp` to the guard list (line ~178) + mount `mcpRouter` |
| `server/package.json` | Add `@modelcontextprotocol/sdk` + `"bin": { "castwright-mcp": "dist/mcp/stdio-bridge.js" }` |
| `server/src/routes/generation.ts` | Export `getGenerationJobView()`; extract `beginGenerationJob()` |
| `server/src/routes/analysis.ts` | Extract `beginAnalysisJob()` (job spawn decoupled from the SSE handler) |
| `server/src/routes/cast-design.ts` | Export `getCastDesignJobView()`; extract `beginCastDesignJob()` |
| `server/src/routes/single-design.ts` | Export `getSingleDesignJobView()`; extract `beginSingleDesignJob()` |
| `server/src/routes/export.ts` | Export `getExportJobById()`, `listExportJobsForBook()`; extract `createExportJob()` |
| `server/src/routes/import.ts` | Extract `createBookFromImport()` from the POST `/books` handler |
| `server/src/routes/cast-merge.ts` | Extract `mergeCastCharacters()` from the route handler |
| `server/src/routes/voices.ts` | Add `export` to `aggregateVoices()` |
| `server/vitest.config.ts` + `server/vitest.config.slow.ts` | Add `src/mcp/pipeline.e2e.test.ts` to the mirrored SLOW_FILES lists |
| `README.md` | "Driving Castwright from an agent" section |
| `docs/features/205-mcp-agent-surface.md` | New regression plan (from TEMPLATE.md) + `docs/features/INDEX.md` entry |

---

## Wave 1 — endpoint + read parity

### Task 1: SDK install + stateless endpoint skeleton + first tool round-trip

This task proves the whole transport/SDK/zod stack early (zod-version friction between the server's zod ^4 and the SDK surfaces here, not in task 9).

**Files:**
- Modify: `server/package.json` (dependency)
- Create: `server/src/mcp/respond.ts`
- Create: `server/src/mcp/server.ts`
- Create: `server/src/mcp/router.ts`
- Create: `server/src/mcp/test-harness.ts`
- Test: `server/src/mcp/router.test.ts`

- [ ] **Step 1: Install the SDK**

```bash
npm --prefix server install @modelcontextprotocol/sdk
```

Expected: clean install — verified 2026-06-11: SDK 1.29.0 declares `zod: '^3.25 || ^4.0'`, so the server's `zod@^4` is in-range. The probe test below validates the schema wiring end-to-end regardless.

- [ ] **Step 2: Write the result helpers**

`server/src/mcp/respond.ts`:

```typescript
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Success result: one-line summary + pretty-printed JSON payload (works in every client). */
export function jsonResult(summary: string, data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: `${summary}\n${JSON.stringify(data, null, 1)}` }],
  };
}

/** Error result: structured {code,message,remediation} so agents can self-serve recovery. */
export function toolError(code: string, message: string, remediation: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message, remediation }) }],
  };
}
```

- [ ] **Step 3: Write the server factory with a single probe tool**

`server/src/mcp/server.ts` (tool groups get registered here in later tasks; for now only `ping` so the round-trip is testable):

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult } from './respond.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'castwright', version: '1.0.0' });

  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Liveness probe. Returns ok.',
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult('ok', { ok: true }),
  );

  return server;
}
```

- [ ] **Step 4: Write the stateless transport router**

`server/src/mcp/router.ts`. Stateless mode: a fresh `McpServer` + transport per POST (no session affinity — single-user server, maximally client-compatible). `express.json()` already parsed the body upstream; pass it to `handleRequest`.

```typescript
import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';

export const mcpRouter = Router();

mcpRouter.post('/', async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal MCP transport error' },
        id: null,
      });
    }
  }
});

// Stateless mode: no SSE resumption stream, no sessions to delete.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to /mcp.' },
    id: null,
  });
};
mcpRouter.get('/', methodNotAllowed);
mcpRouter.delete('/', methodNotAllowed);
```

- [ ] **Step 5: Write the shared test harness**

`server/src/mcp/test-harness.ts` — every MCP test uses this: mounts the router on a bare express app, listens on an ephemeral port, returns a connected SDK client.

```typescript
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface McpTestContext {
  client: Client;
  baseUrl: string;
  close: () => Promise<void>;
}

/** Boots the /mcp router on an ephemeral port and returns a connected MCP client. */
export async function startMcpTestClient(): Promise<McpTestContext> {
  // Deferred import so process.env.WORKSPACE_DIR set in beforeAll is honoured.
  const { mcpRouter } = await import('./router.js');
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/mcp', mcpRouter);

  const httpServer: Server = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/mcp`;

  const client = new Client({ name: 'castwright-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));

  return {
    client,
    baseUrl,
    close: async () => {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/** Parses the JSON payload out of a jsonResult() tool response (summary line + JSON). */
export function parseToolJson(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  const newline = text.indexOf('\n');
  return JSON.parse(newline === -1 ? text : text.slice(newline + 1));
}
```

- [ ] **Step 6: Write the failing test**

`server/src/mcp/router.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpTestContext } from './test-harness.js';

let ctx: McpTestContext;

beforeAll(async () => {
  const { startMcpTestClient } = await import('./test-harness.js');
  ctx = await startMcpTestClient();
});

afterAll(async () => {
  await ctx.close();
});

describe('mcp endpoint', () => {
  it('lists tools and round-trips ping', async () => {
    const tools = await ctx.client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('ping');

    const result = await ctx.client.callTool({ name: 'ping', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('"ok": true');
  });

  it('rejects GET with 405', async () => {
    const res = await fetch(ctx.baseUrl);
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 7: Run the test**

```bash
npm --prefix server run test -- src/mcp/router.test.ts
```

Expected: PASS (steps 2–5 were written before the test here because the harness IS the scaffolding under test; if it fails, fix transport wiring before moving on).

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/package-lock.json server/src/mcp/
git commit -m "feat(server): fs-44 mcp endpoint skeleton with stateless streamable-http transport"
```

---

### Task 2: Mount `/mcp` in index.ts behind the LAN guard

**Files:**
- Modify: `server/src/index.ts` (guard list at line ~178; mount near the other routers, after line ~249)

- [ ] **Step 1: Edit the guard list**

In `server/src/index.ts`, change (currently line 178):

```typescript
app.use(['/api', '/workspace'], requireLanToken);
```

to:

```typescript
app.use(['/api', '/workspace', '/mcp'], requireLanToken);
```

- [ ] **Step 2: Mount the router**

Add with the other route mounts (keep alphabetical-ish grouping; after the last `app.use('/api/...')` block):

```typescript
import { mcpRouter } from './mcp/router.js';
// ...
app.use('/mcp', mcpRouter); // fs-44 — MCP agent surface (tools over the same service layer)
```

- [ ] **Step 3: Typecheck + existing server tests stay green**

```bash
npm run typecheck
npm run test:server
```

Expected: both green (index.ts has no test harness of its own; the guard behaviour is covered by `lan-auth.test.ts` and the mount is exercised live in task 14's manual acceptance).

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): fs-44 mount /mcp behind requireLanToken guard"
```

---

### Task 3: Job-view getters in the four route modules

The four job families hold module-private state maps. Add small exported **projection** getters (read-only, no behaviour change) so the MCP layer never touches private state.

**Files:**
- Modify: `server/src/routes/generation.ts`
- Modify: `server/src/routes/cast-design.ts`
- Modify: `server/src/routes/single-design.ts`
- Modify: `server/src/routes/export.ts`
- Test: `server/src/mcp/job-view.test.ts` (created in task 4 — getters are covered there; this task gates on typecheck + existing tests)

- [ ] **Step 1: generation.ts getter**

Add near the existing exports (`isGenerationActive` at line ~374):

```typescript
export interface GenerationJobView {
  bookId: string;
  currentChapterId: number | null;
  runDone: number;
  runTotal: number;
  lastTick: {
    chapterId: number;
    progress: number;
    currentLine: number;
    totalLines: number;
  } | null;
}

/** Read-only projection of all in-flight generation jobs for a book (null when idle). */
export function getGenerationJobView(bookId: string): GenerationJobView | null {
  const jobs = inFlightByBook.get(bookId);
  if (!jobs || jobs.size === 0) return null;
  let runDone = 0;
  let runTotal = 0;
  let currentChapterId: number | null = null;
  let lastTick: GenerationJobView['lastTick'] = null;
  for (const j of jobs) {
    runTotal = Math.max(runTotal, j.runTotal);
    runDone = Math.max(runDone, j.runDoneBase + j.completedThisRun.size);
    if (j.currentChapterId != null) currentChapterId = j.currentChapterId;
    if (j.lastProgressTick) {
      lastTick = {
        chapterId: j.lastProgressTick.chapterId,
        progress: j.lastProgressTick.progress,
        currentLine: j.lastProgressTick.currentLine,
        totalLines: j.lastProgressTick.totalLines,
      };
    }
  }
  return { bookId, currentChapterId, runDone, runTotal, lastTick };
}
```

- [ ] **Step 2: cast-design.ts getter**

```typescript
export interface CastDesignJobView {
  bookId: string;
  done: number;
  total: number;
  skipped: number;
  currentName: string | null;
  failures: Array<{ characterId: string; name: string; error: string }>;
}

/** Read-only projection of the in-flight bulk design job for a book (null when idle). */
export function getCastDesignJobView(bookId: string): CastDesignJobView | null {
  const job = inFlightByBook.get(bookId);
  if (!job) return null;
  return {
    bookId,
    done: job.done,
    total: job.total,
    skipped: job.skipped,
    currentName: job.currentName,
    failures: [...job.failures],
  };
}
```

- [ ] **Step 3: single-design.ts getter**

```typescript
export interface SingleDesignJobView {
  bookId: string;
  characterId: string;
  characterName: string;
  phase: 'designing' | 'rendering';
  mode: 'first' | 'redesign';
}

/** Read-only projection of the in-flight single voice design for a book (null when idle). */
export function getSingleDesignJobView(bookId: string): SingleDesignJobView | null {
  const job = inFlightByBook.get(bookId);
  if (!job) return null;
  return {
    bookId,
    characterId: job.characterId,
    characterName: job.characterName,
    phase: job.phase,
    mode: job.mode,
  };
}
```

- [ ] **Step 4: export.ts getters**

`BookExportJob` is already exported. Add (near the `jobs` map, line ~88):

```typescript
/** Read-only lookup of one export job by id (rehydrate the book's manifests first). */
export function getExportJobById(exportId: string): BookExportJob | undefined {
  return jobs.get(exportId);
}

/** All export jobs for a book, newest first. Caller must have triggered rehydration
 *  via listExportJobsForBook or a prior route hit. */
export async function listExportJobsForBook(bookId: string, bookDir: string): Promise<BookExportJob[]> {
  await rehydrateBook(bookDir, bookId);
  return [...jobs.values()]
    .filter((j) => j.bookId === bookId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
```

(`rehydrateBook` is the existing internal at export.ts; `listExportJobsForBook` lives below it so no hoisting issue.)

- [ ] **Step 5: Typecheck + targeted suites**

```bash
npm run typecheck
npm --prefix server run test -- src/routes/export.test.ts src/routes/cast-design.test.ts src/routes/single-design.test.ts
npm run test:server-slow
```

Expected: green (generation.test.ts lives in the slow config).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/generation.ts server/src/routes/cast-design.ts server/src/routes/single-design.ts server/src/routes/export.ts
git commit -m "refactor(server): fs-44 read-only job-view getters for generation/design/export jobs"
```

---

### Task 4: Uniform job view + recorder

**Composite jobId scheme** (parse on `:`):

| Kind | jobId format | Live source | Disk fallback when not in memory |
| --- | --- | --- | --- |
| analysis | `analysis:<manuscriptId>` | `snapshotInFlightAnalysis()` | `readAnalysisState(bookDir)` → paused/halted; else recorder; else `not_found` |
| generation | `generation:<bookId>` | `getGenerationJobView()` | recorder; else state.json chapter `generationState`s |
| cast-design | `cast-design:<bookId>` | `getCastDesignJobView()` | recorder |
| single-design | `single-design:<bookId>` | `getSingleDesignJobView()` | recorder |
| export | `export:<bookId>:<exportId>` | `getExportJobById()` (after rehydrate) | export manifests persist — always resolvable |

**Files:**
- Create: `server/src/mcp/job-recorder.ts`
- Create: `server/src/mcp/job-view.ts`
- Test: `server/src/mcp/job-view.test.ts`

- [ ] **Step 1: Write the recorder**

`server/src/mcp/job-recorder.ts` — MCP-started jobs attach a synthetic subscriber whose events land here, so terminal outcomes survive the in-memory job map dropping its entry.

```typescript
export interface JobOutcome {
  state: 'done' | 'failed';
  error?: string;
  finishedAt: number;
}

const outcomes = new Map<string, JobOutcome>();
const lastEvents = new Map<string, unknown>();
const MAX_ENTRIES = 200;

function trim(map: Map<string, unknown>): void {
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value as string;
    map.delete(oldest);
  }
}

export function recordEvent(jobId: string, event: unknown): void {
  lastEvents.set(jobId, event);
  trim(lastEvents);
}

export function recordOutcome(jobId: string, outcome: JobOutcome): void {
  outcomes.set(jobId, outcome);
  trim(outcomes);
}

export function getRecordedOutcome(jobId: string): JobOutcome | undefined {
  return outcomes.get(jobId);
}

export function getLastEvent(jobId: string): unknown {
  return lastEvents.get(jobId);
}

/** Drop any prior outcome/event for a jobId — call when STARTING a new job that reuses
 *  the id (e.g. a second generation run on the same book), so a stale 'done' from run 1
 *  can never short-circuit wait_for_job on run 2. */
export function clearRecorded(jobId: string): void {
  outcomes.delete(jobId);
  lastEvents.delete(jobId);
}

/**
 * Build a synthetic subscriber for a job's `subscribers` set.
 * CRITICAL: every job route calls `sub.res.end()` on its subscribers at job end
 * (cast-design.ts:147, single-design.ts:76, analysis.ts:1651, generation.ts:431),
 * so the stub `res` with a no-op end() is load-bearing — without it the job's
 * completion path throws. `classify` maps each broadcast event to a terminal
 * outcome (or null while still running). Also clears any stale prior outcome.
 */
export function makeRecorderSubscriber(
  jobId: string,
  classify: (ev: unknown) => JobOutcome | null,
): { send: (ev: unknown) => void; res: { end: () => void } } {
  clearRecorded(jobId);
  return {
    send: (ev: unknown) => {
      recordEvent(jobId, ev);
      const outcome = classify(ev);
      if (outcome) recordOutcome(jobId, outcome);
    },
    res: { end: () => {} },
  };
}

/** Test-only: reset module state between specs. */
export function resetJobRecorder(): void {
  outcomes.clear();
  lastEvents.clear();
}
```

(Attach with `job.subscribers.add(makeRecorderSubscriber(jobId, classify) as never)` — the `as never` papers over the route-local subscriber interfaces' extra optional fields like `keepAlive`; `clearInterval(undefined)` at job end is harmless in Node.)

- [ ] **Step 2: Write the job view**

`server/src/mcp/job-view.ts`:

```typescript
import { snapshotInFlightAnalysis, isAnalysisJobRunning } from '../routes/analysis.js';
import { getGenerationJobView, isGenerationActive } from '../routes/generation.js';
import { getCastDesignJobView } from '../routes/cast-design.js';
import { getSingleDesignJobView } from '../routes/single-design.js';
import { getExportJobById, listExportJobsForBook } from '../routes/export.js';
import { readAnalysisState } from '../store/analysis-state.js';
import { findBookByBookId, findBookByManuscriptId } from '../workspace/scan.js';
import { getRecordedOutcome } from './job-recorder.js';

export type JobKind = 'analysis' | 'generation' | 'cast-design' | 'single-design' | 'export';

export interface JobView {
  jobId: string;
  kind: JobKind;
  state: 'running' | 'done' | 'failed' | 'paused' | 'halted' | 'not_found';
  phase?: string;
  percent?: number; // 0-100
  detail?: string;
  error?: string;
}

const KINDS: JobKind[] = ['analysis', 'generation', 'cast-design', 'single-design', 'export'];

export function makeJobId(kind: JobKind, ...keys: string[]): string {
  return [kind, ...keys].join(':');
}

function pct(progress: number): number {
  return Math.max(0, Math.min(100, progress <= 1 ? Math.round(progress * 100) : Math.round(progress)));
}

function fromOutcome(jobId: string, kind: JobKind): JobView | null {
  const o = getRecordedOutcome(jobId);
  if (!o) return null;
  return { jobId, kind, state: o.state, percent: o.state === 'done' ? 100 : undefined, error: o.error };
}

export async function getJobView(jobId: string): Promise<JobView> {
  const [kindRaw, ...rest] = jobId.split(':');
  const kind = KINDS.find((k) => k === kindRaw);
  if (!kind || rest.length === 0) {
    return { jobId, kind: (kind ?? 'analysis') as JobKind, state: 'not_found', error: 'Malformed jobId' };
  }

  if (kind === 'analysis') {
    const manuscriptId = rest[0];
    if (isAnalysisJobRunning(manuscriptId)) {
      const snap = snapshotInFlightAnalysis(manuscriptId);
      return {
        jobId, kind, state: 'running',
        phase: snap?.phaseLabel,
        percent: snap ? pct(snap.phaseProgress) : undefined,
        detail: snap ? `phase ${snap.phaseId}` : undefined,
      };
    }
    const recorded = fromOutcome(jobId, kind);
    if (recorded) return recorded;
    const book = await findBookByManuscriptId(manuscriptId);
    if (book) {
      const disk = await readAnalysisState(book.bookDir);
      if (disk) {
        return {
          jobId, kind,
          state: disk.state === 'running' ? 'running' : disk.state, // 'paused' | 'halted'
          phase: disk.phaseLabel, percent: pct(disk.phaseProgress), error: disk.haltReason,
        };
      }
    }
    return { jobId, kind, state: 'not_found' };
  }

  if (kind === 'generation') {
    const bookId = rest[0];
    const live = getGenerationJobView(bookId);
    if (live && isGenerationActive(bookId)) {
      const base = live.runTotal > 0 ? (live.runDone / live.runTotal) * 100 : 0;
      return {
        jobId, kind, state: 'running',
        phase: live.currentChapterId != null ? `chapter ${live.currentChapterId}` : 'starting',
        percent: Math.round(base),
        detail: `${live.runDone}/${live.runTotal} chapters` +
          (live.lastTick ? ` — line ${live.lastTick.currentLine}/${live.lastTick.totalLines}` : ''),
      };
    }
    const recorded = fromOutcome(jobId, kind);
    if (recorded) return recorded;
    // Disk fallback: derive the last run's outcome from state.json chapter states
    // (covers jobs started by the UI or a previous process — no recorder entry).
    const book = await findBookByBookId(bookId);
    if (book) {
      const chapters = (book.state.chapters ?? []) as Array<{ generationState?: string; generationError?: string }>;
      const failed = chapters.filter((c) => c.generationState === 'failed');
      if (failed.length > 0) {
        return { jobId, kind, state: 'failed', error: failed[0].generationError ?? `${failed.length} chapter(s) failed` };
      }
      if (chapters.some((c) => c.generationState === 'done')) {
        return { jobId, kind, state: 'done', percent: 100 };
      }
    }
    return { jobId, kind, state: 'not_found' };
  }

  if (kind === 'cast-design') {
    const bookId = rest[0];
    const live = getCastDesignJobView(bookId);
    if (live) {
      return {
        jobId, kind, state: 'running',
        phase: live.currentName ? `designing ${live.currentName}` : 'starting',
        percent: live.total > 0 ? Math.round((live.done / live.total) * 100) : 0,
        detail: `${live.done}/${live.total} designed, ${live.skipped} skipped, ${live.failures.length} failed`,
        error: live.failures.length ? live.failures.map((f) => `${f.name}: ${f.error}`).join('; ') : undefined,
      };
    }
    return fromOutcome(jobId, kind) ?? { jobId, kind, state: 'not_found' };
  }

  if (kind === 'single-design') {
    const bookId = rest[0];
    const live = getSingleDesignJobView(bookId);
    if (live) {
      return {
        jobId, kind, state: 'running', phase: live.phase,
        detail: `${live.mode} design for ${live.characterName}`,
      };
    }
    return fromOutcome(jobId, kind) ?? { jobId, kind, state: 'not_found' };
  }

  // export — manifests persist on disk, so this kind is always resolvable.
  const [bookId, exportId] = rest;
  const book = await findBookByBookId(bookId);
  if (book) await listExportJobsForBook(bookId, book.bookDir); // triggers manifest rehydration
  const job = getExportJobById(exportId);
  if (!job) return { jobId, kind, state: 'not_found' };
  const state =
    job.status === 'done' ? 'done'
    : job.status === 'failed' || job.status === 'cancelled' ? 'failed'
    : 'running';
  return {
    jobId, kind, state,
    phase: job.status,
    percent: job.progress != null ? pct(job.progress) : state === 'done' ? 100 : undefined,
    detail: job.downloadUrl ?? job.syncPath ?? job.filename,
    error: job.errorReason ?? undefined,
  };
}
```

- [ ] **Step 3: Write the failing test**

`server/src/mcp/job-view.test.ts` — unit-level: recorder fallbacks + malformed ids + export projection (live-job projections are exercised end-to-end in tasks 7–9 and 13).

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let jobView: typeof import('./job-view.js');
let recorder: typeof import('./job-recorder.js');

beforeAll(async () => {
  process.env.WORKSPACE_DIR = await mkdtemp(join(tmpdir(), 'audiobook-mcp-jobview-'));
  [jobView, recorder] = await Promise.all([import('./job-view.js'), import('./job-recorder.js')]);
});

beforeEach(() => recorder.resetJobRecorder());

describe('getJobView', () => {
  it('returns not_found for a malformed jobId', async () => {
    const view = await jobView.getJobView('nonsense');
    expect(view.state).toBe('not_found');
  });

  it('returns a recorded terminal outcome when the in-memory job is gone', async () => {
    recorder.recordOutcome('generation:bk_test', { state: 'done', finishedAt: Date.now() });
    const view = await jobView.getJobView('generation:bk_test');
    expect(view).toMatchObject({ kind: 'generation', state: 'done', percent: 100 });
  });

  it('returns a recorded failure with its error', async () => {
    recorder.recordOutcome('cast-design:bk_test', {
      state: 'failed', error: 'sidecar_unavailable', finishedAt: Date.now(),
    });
    const view = await jobView.getJobView('cast-design:bk_test');
    expect(view).toMatchObject({ state: 'failed', error: 'sidecar_unavailable' });
  });

  it('returns not_found for an unknown export job', async () => {
    const view = await jobView.getJobView('export:bk_missing:exp_missing');
    expect(view.state).toBe('not_found');
  });
});
```

- [ ] **Step 4: Run, expect fail, then pass**

```bash
npm --prefix server run test -- src/mcp/job-view.test.ts
```

Expected first run: FAIL (modules missing) if you wrote the test first; after steps 1–2: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/job-recorder.ts server/src/mcp/job-view.ts server/src/mcp/job-view.test.ts
git commit -m "feat(server): fs-44 uniform job view + outcome recorder over all job families"
```

---

### Task 5: Read tools (`list_books`, `get_book`, `get_cast`, `list_voices`, `get_system_status`)

**Files:**
- Modify: `server/src/routes/voices.ts` (one-word change: `export` the existing `aggregateVoices` at line ~198)
- Create: `server/src/mcp/tools/read-tools.ts`
- Modify: `server/src/mcp/server.ts` (register the group)
- Test: `server/src/mcp/tools/read-tools.test.ts`

- [ ] **Step 1: Export `aggregateVoices`**

In `server/src/routes/voices.ts` line ~198, change `async function aggregateVoices(` to `export async function aggregateVoices(`. No other change.

- [ ] **Step 2: Write the failing test**

`server/src/mcp/tools/read-tools.test.ts`. Fixture: a seeded on-disk book (same shape `book-state.test.ts` uses — `books/<Author>/<Series>/<Title>/` + `.audiobook/state.json` + `.audiobook/cast.json` + `manuscript.txt`).

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpTestContext } from '../test-harness.js';

let ctx: McpTestContext;
let parseToolJson: (r: unknown) => any;

const AUTHOR = 'Test Author';
const SERIES = 'Test Series';
const TITLE = 'Test Book';

beforeAll(async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-mcp-read-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'Chapter 1\n\nHello world.');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: 'bk_read_test',
      manuscriptId: 'm_read_test',
      title: TITLE, author: AUTHOR, series: SERIES,
      schema: 1,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-1' }],
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'narrator', name: 'Narrator', ttsEngine: 'kokoro', overrideTtsVoices: { kokoro: { name: 'af_heart' } }, lines: 10 },
        { id: 'c1', name: 'Alice', lines: 4 },
      ],
    }),
  );

  const harness = await import('../test-harness.js');
  parseToolJson = harness.parseToolJson;
  ctx = await harness.startMcpTestClient();
});

afterAll(async () => {
  await ctx.close();
});

describe('read tools', () => {
  it('list_books surfaces the seeded book with pipeline status', async () => {
    const res = await ctx.client.callTool({ name: 'list_books', arguments: {} });
    const data = parseToolJson(res) as { books: any[] };
    const book = data.books.find((b) => b.bookId === 'bk_read_test');
    expect(book).toMatchObject({ title: TITLE, author: AUTHOR, chapterCount: 1 });
    expect(book.status).toBeDefined();
  });

  it('get_book returns chapters + cast summary + active jobs', async () => {
    const res = await ctx.client.callTool({ name: 'get_book', arguments: { bookId: 'bk_read_test' } });
    const data = parseToolJson(res) as any;
    expect(data.chapters).toHaveLength(1);
    expect(data.cast.characterCount).toBe(2);
    expect(data.activeJobs).toEqual([]);
  });

  it('get_cast returns characters with voice assignments', async () => {
    const res = await ctx.client.callTool({ name: 'get_cast', arguments: { bookId: 'bk_read_test' } });
    const data = parseToolJson(res) as { characters: any[] };
    const narrator = data.characters.find((c) => c.id === 'narrator');
    expect(narrator.voice).toEqual({ engine: 'kokoro', name: 'af_heart' });
    expect(data.characters.find((c) => c.id === 'c1').voice).toBeNull();
  });

  it('get_book errors with a structured payload for an unknown book', async () => {
    const res = await ctx.client.callTool({ name: 'get_book', arguments: { bookId: 'bk_nope' } });
    expect(res.isError).toBe(true);
    const err = JSON.parse((res.content as any[])[0].text);
    expect(err).toMatchObject({ code: 'book_not_found' });
    expect(err.remediation).toContain('list_books');
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
npm --prefix server run test -- src/mcp/tools/read-tools.test.ts
```

Expected: FAIL — tools not registered.

- [ ] **Step 4: Implement the read tools**

`server/src/mcp/tools/read-tools.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult, toolError } from '../respond.js';
import { scanLibrary, findBookByBookId } from '../../workspace/scan.js';
import { castJsonPath } from '../../workspace/paths.js';
import { readJson } from '../../workspace/state-io.js';
import { aggregateVoices } from '../../routes/voices.js';
import { listBaseVoices } from '../../tts/base-voices.js';
import { probeSidecarHealth } from '../../routes/sidecar-health.js';
import { probeOllamaHealth } from '../../routes/ollama-health.js';
import { readGpuQueueState } from '../../routes/gpu-queue.js';
import { probeFfmpeg } from '../../diagnostics/ffmpeg.js';
import { isAnalysisJobRunning } from '../../routes/analysis.js';
import { isGenerationActive } from '../../routes/generation.js';
import { getCastDesignJobView } from '../../routes/cast-design.js';
import { getSingleDesignJobView } from '../../routes/single-design.js';
import { makeJobId } from '../job-view.js';

interface CastCharacterFile {
  id: string;
  name: string;
  aliases?: string[];
  ttsEngine?: string;
  voiceId?: string;
  voiceStyle?: string;
  lines?: number;
  scenes?: number;
  overrideTtsVoices?: Record<string, { name: string }>;
}

function characterVoice(c: CastCharacterFile): { engine: string; name: string } | null {
  if (c.ttsEngine && c.overrideTtsVoices?.[c.ttsEngine]) {
    return { engine: c.ttsEngine, name: c.overrideTtsVoices[c.ttsEngine].name };
  }
  return null;
}

export const bookNotFound = (bookId: string) =>
  toolError('book_not_found', `No book with bookId "${bookId}".`, 'Call list_books to get valid bookIds.');

/** Active jobs for a book, as jobIds the agent can pass to get_job/wait_for_job. */
function activeJobIdsForBook(bookId: string, manuscriptId: string | undefined): string[] {
  const ids: string[] = [];
  if (manuscriptId && isAnalysisJobRunning(manuscriptId)) ids.push(makeJobId('analysis', manuscriptId));
  if (isGenerationActive(bookId)) ids.push(makeJobId('generation', bookId));
  if (getCastDesignJobView(bookId)) ids.push(makeJobId('cast-design', bookId));
  if (getSingleDesignJobView(bookId)) ids.push(makeJobId('single-design', bookId));
  return ids;
}

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    'list_books',
    {
      title: 'List books',
      description:
        'List every book in the Castwright library with pipeline status, chapter counts, and ids. Start here to discover bookIds.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const lib = await scanLibrary();
      const books = lib.authors.flatMap((a) =>
        a.series.flatMap((s) =>
          s.books.map((b) => ({
            bookId: b.bookId,
            title: b.title,
            author: b.author,
            series: b.series,
            isStandalone: b.isStandalone,
            status: b.status,
            language: b.language,
            chapterCount: b.chapterCount,
            completedChapters: b.completedChapters,
            characterCount: b.characterCount,
            manuscriptId: b.manuscriptId,
            lastWorkedOn: b.lastWorkedOn,
          })),
        ),
      );
      return jsonResult(`${books.length} book(s) in the library.`, { books });
    },
  );

  server.registerTool(
    'get_book',
    {
      title: 'Get book',
      description:
        'Full state of one book: pipeline stage, per-chapter status and durations, cast summary, and any active jobIds (pass those to get_job / wait_for_job).',
      inputSchema: { bookId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ bookId }) => {
      const book = await findBookByBookId(bookId);
      if (!book) return bookNotFound(bookId);
      const cast = await readJson<{ characters: CastCharacterFile[] }>(castJsonPath(book.bookDir));
      const characters = cast?.characters ?? [];
      const manuscriptId = (book.state as { manuscriptId?: string }).manuscriptId;
      return jsonResult(`"${book.title}" — ${book.state.chapters?.length ?? 0} chapter(s).`, {
        bookId,
        title: book.title,
        author: book.author,
        series: book.series,
        manuscriptId,
        chapters: (book.state.chapters ?? []).map((ch: any) => ({
          id: ch.id,
          title: ch.title,
          excluded: ch.excluded ?? false,
          duration: ch.duration ?? null,
          generationState: ch.generationState ?? null,
          generationError: ch.generationError ?? null,
        })),
        cast: {
          characterCount: characters.length,
          voiced: characters.filter((c) => characterVoice(c) !== null).length,
        },
        activeJobs: activeJobIdsForBook(bookId, manuscriptId),
      });
    },
  );

  server.registerTool(
    'get_cast',
    {
      title: 'Get cast',
      description:
        'Characters of a book with voice assignments, engines, personas, and line counts. Use before update_character / design_voice.',
      inputSchema: { bookId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ bookId }) => {
      const book = await findBookByBookId(bookId);
      if (!book) return bookNotFound(bookId);
      const cast = await readJson<{ characters: CastCharacterFile[] }>(castJsonPath(book.bookDir));
      if (!cast) {
        return toolError('cast_not_ready', `Book "${bookId}" has no cast yet.`,
          'Run start_analysis first; the cast is produced by analysis.');
      }
      const characters = cast.characters.map((c) => ({
        id: c.id,
        name: c.name,
        aliases: c.aliases ?? [],
        engine: c.ttsEngine ?? null,
        voice: characterVoice(c),
        voiceId: c.voiceId ?? null,
        persona: c.voiceStyle ?? null,
        lines: c.lines ?? 0,
        scenes: c.scenes ?? 0,
      }));
      return jsonResult(`${characters.length} character(s).`, { bookId, characters });
    },
  );

  server.registerTool(
    'list_voices',
    {
      title: 'List voices',
      description:
        'Voice library. engine filters (kokoro|qwen|coqui|gemini|piper); includeBase=true adds the preset base-voice catalog; bookId scopes series-sibling info.',
      inputSchema: {
        engine: z.enum(['kokoro', 'qwen', 'coqui', 'gemini', 'piper']).optional(),
        bookId: z.string().optional(),
        includeBase: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ engine, bookId, includeBase }) => {
      const eng = engine ?? 'kokoro';
      const derived = await aggregateVoices(bookId, eng as any);
      const base = includeBase ? await listBaseVoices({}) : undefined;
      return jsonResult(
        `${derived.length} library voice(s)${base ? ` + ${base.length} base voice(s)` : ''} for ${eng}.`,
        {
          voices: derived.map((v) => ({
            id: v.id, character: v.character, bookTitle: v.bookTitle, bookId: v.bookId,
            engine: v.ttsVoice.engine, voiceName: v.ttsVoice.name,
            pinned: v.pinned ?? false, source: v.source, inCurrentSeries: v.inCurrentSeries ?? false,
          })),
          baseVoices: base?.map((b) => ({
            engine: b.engine, name: b.name, language: b.language ?? null,
            gender: b.gender ?? null, designed: b.designed ?? false,
          })),
        },
      );
    },
  );

  server.registerTool(
    'get_system_status',
    {
      title: 'Get system status',
      description:
        'Engine/sidecar/analyzer/GPU/ffmpeg health. Call when a start_* tool reports the system is not ready, or before a long run.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [sidecar, ollama] = await Promise.all([probeSidecarHealth(), probeOllamaHealth()]);
      const gpuQueue = readGpuQueueState();
      const ffmpeg = probeFfmpeg();
      return jsonResult(
        `sidecar ${sidecar.status}, analyzer ${ollama.status}, ffmpeg ${ffmpeg.ffmpeg ? 'ok' : 'MISSING'}.`,
        { sidecar, analyzer: ollama, gpuQueue, ffmpeg },
      );
    },
  );
}
```

- [ ] **Step 5: Register the group**

In `server/src/mcp/server.ts`, after the `ping` registration:

```typescript
import { registerReadTools } from './tools/read-tools.js';
// inside createMcpServer(), before `return server`:
registerReadTools(server);
```

- [ ] **Step 6: Run to verify pass**

```bash
npm --prefix server run test -- src/mcp/tools/read-tools.test.ts
```

Expected: PASS. If `get_book` fails because the seeded `state.json` shape misses required fields, align the fixture to whatever `book-state.test.ts` seeds — that file is the canonical fixture reference.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/voices.ts server/src/mcp/
git commit -m "feat(server): fs-44 mcp read tools (list_books/get_book/get_cast/list_voices/get_system_status)"
```

---

### Task 6: `get_job` + `wait_for_job`

**Files:**
- Create: `server/src/mcp/tools/job-tools.ts`
- Modify: `server/src/mcp/server.ts` (register)
- Test: `server/src/mcp/tools/job-tools.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/mcp/tools/job-tools.test.ts` — drives the tools against recorder-backed jobs (live-job waits are covered in tasks 7–9/13):

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpTestContext } from '../test-harness.js';

let ctx: McpTestContext;
let recorder: typeof import('../job-recorder.js');
let parseToolJson: (r: unknown) => any;

beforeAll(async () => {
  process.env.WORKSPACE_DIR = await mkdtemp(join(tmpdir(), 'audiobook-mcp-jobs-'));
  recorder = await import('../job-recorder.js');
  const harness = await import('../test-harness.js');
  parseToolJson = harness.parseToolJson;
  ctx = await harness.startMcpTestClient();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(() => recorder.resetJobRecorder());

describe('job tools', () => {
  it('get_job projects a recorded outcome', async () => {
    recorder.recordOutcome('generation:bk_j1', { state: 'done', finishedAt: Date.now() });
    const res = await ctx.client.callTool({ name: 'get_job', arguments: { jobId: 'generation:bk_j1' } });
    expect(parseToolJson(res)).toMatchObject({ state: 'done', kind: 'generation' });
  });

  it('wait_for_job returns immediately on an already-terminal job', async () => {
    recorder.recordOutcome('cast-design:bk_j2', { state: 'failed', error: 'boom', finishedAt: Date.now() });
    const started = Date.now();
    const res = await ctx.client.callTool({
      name: 'wait_for_job',
      arguments: { jobId: 'cast-design:bk_j2', timeoutSec: 30 },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(parseToolJson(res)).toMatchObject({ state: 'failed', error: 'boom' });
  });

  it('wait_for_job returns when a running job completes mid-wait', async () => {
    // not_found → done transition: simulates the in-memory job finishing
    setTimeout(() => recorder.recordOutcome('export:bk_j3:exp_1', { state: 'done', finishedAt: Date.now() }), 1_200);
    const res = await ctx.client.callTool({
      name: 'wait_for_job',
      arguments: { jobId: 'export:bk_j3:exp_1', timeoutSec: 10 },
    });
    const view = parseToolJson(res);
    expect(view.state).toBe('done');
    expect(view.timedOut).toBeUndefined();
  });

  it('wait_for_job times out with timedOut flag', async () => {
    const res = await ctx.client.callTool({
      name: 'wait_for_job',
      arguments: { jobId: 'generation:bk_never', timeoutSec: 1 },
    });
    expect(parseToolJson(res)).toMatchObject({ state: 'not_found', timedOut: true });
  });
});
```

Note: the export-kind wait in test 3 resolves via the recorder (not disk) — that's exactly the seam `wait_for_job` polls.

- [ ] **Step 2: Run to verify failure**

```bash
npm --prefix server run test -- src/mcp/tools/job-tools.test.ts
```

Expected: FAIL — tools not registered.

- [ ] **Step 3: Implement**

`server/src/mcp/tools/job-tools.ts`. Timeout cap **55 s** (below the common 60 s client tool-timeout floor), default 25 s, poll every 750 ms; return early on terminal state OR phase/percent change after the first terminal-or-changed observation? No — spec: return on **completion/failure/phase change**. Implementation returns on (a) terminal state, (b) `phase` differing from the first observation, (c) timeout (flagged).

```typescript
import { z } from 'zod';
import { setTimeout as sleep } from 'node:timers/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult } from '../respond.js';
import { getJobView, type JobView } from '../job-view.js';

const TERMINAL: Array<JobView['state']> = ['done', 'failed', 'halted'];
const POLL_MS = 750;
const DEFAULT_TIMEOUT_SEC = 25;
const MAX_TIMEOUT_SEC = 55;

export function registerJobTools(server: McpServer): void {
  server.registerTool(
    'get_job',
    {
      title: 'Get job status',
      description:
        'Status of a long-running job by jobId (returned by start_analysis / start_generation / design_voice / design_full_cast / export_audiobook). Prefer wait_for_job over polling this in a loop.',
      inputSchema: { jobId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => {
      const view = await getJobView(jobId);
      return jsonResult(`${view.kind} job is ${view.state}${view.phase ? ` (${view.phase})` : ''}.`, view);
    },
  );

  server.registerTool(
    'wait_for_job',
    {
      title: 'Wait for job',
      description:
        `Block up to timeoutSec (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}) until the job completes, fails, or changes phase — then return its status. ` +
        'On timedOut:true simply call wait_for_job again; long generations need several chained waits.',
      inputSchema: {
        jobId: z.string(),
        timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId, timeoutSec }) => {
      const deadline = Date.now() + (timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1_000;
      const first = await getJobView(jobId);
      if (TERMINAL.includes(first.state)) {
        return jsonResult(`${first.kind} job already ${first.state}.`, first);
      }
      let last = first;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        last = await getJobView(jobId);
        if (TERMINAL.includes(last.state)) {
          return jsonResult(`${last.kind} job ${last.state}.`, last);
        }
        if (last.state !== first.state || (last.phase && last.phase !== first.phase)) {
          return jsonResult(`${last.kind} job ${last.state} — phase changed to ${last.phase ?? '?'}.`, last);
        }
      }
      return jsonResult(`Still ${last.state} after timeout — call wait_for_job again.`, {
        ...last,
        timedOut: true,
      });
    },
  );
}
```

Register in `server.ts`: `registerJobTools(server);`

- [ ] **Step 4: Run to verify pass**

```bash
npm --prefix server run test -- src/mcp/tools/job-tools.test.ts
```

Expected: PASS. (Test 3's transition is not_found→done; the `state !== first.state` branch also fires for it — terminal check wins first, same result.)

- [ ] **Step 5: Commit — wave 1 complete**

```bash
git add server/src/mcp/
git commit -m "feat(server): fs-44 get_job + wait_for_job long-poll tools"
```

---

## Wave 2 — pipeline actions

### Task 7: `upload_manuscript` (extract `createBookFromImport` from import.ts)

**Files:**
- Modify: `server/src/routes/import.ts`
- Create: `server/src/mcp/tools/pipeline-tools.ts`
- Modify: `server/src/mcp/server.ts` (register)
- Test: `server/src/mcp/tools/pipeline-tools.test.ts`

- [ ] **Step 1: Extract the confirm flow**

In `server/src/routes/import.ts`, the `POST /api/books` handler (line ~162–333) validates the request, then builds the book directory, writes the manuscript + `state.json`, and registers the manuscript record. Extract everything AFTER request validation/staging lookup into an exported function **in the same file**, moving the existing body verbatim (only renaming `req.body` locals to the `opts` parameters):

```typescript
export interface ConfirmImportOpts {
  author: string;
  title: string;
  series: string;
  seriesPosition?: number;
  isStandalone?: boolean;
  language?: string;
  excludedSlugs?: string[];
}

export interface ConfirmedBook {
  bookId: string;
  manuscriptId: string;
  title: string;
  author: string;
  series: string;
  bookDir: string;
  wordCount: number;
  chapterCount: number;
}

/** Create the on-disk book from a parsed manuscript entry. Shared by POST /api/books and the MCP upload_manuscript tool. */
export async function createBookFromImport(
  entry: StagedImport,
  opts: ConfirmImportOpts,
): Promise<ConfirmedBook> {
  // ← moved body of the POST /api/books handler: dir layout, manuscript write,
  //   writeStateJsonAtomic(stateJsonPath(bookDir), state), putManuscript(record)
  // returns the same identifiers the route used to respond with
}
```

The route handler keeps: zod/manual validation, `getStaging(tempId)` + 404, then `const book = await createBookFromImport(entry, opts)`, `dropStaging(tempId)`, and responds with the same JSON shape as before (rebuild it from `book` + `entry`).

- [ ] **Step 2: Existing import tests stay green**

```bash
npm --prefix server run test -- src/routes/import.test.ts
```

Expected: PASS unchanged (pure extraction). If there is no `import.test.ts`, run the whole fast suite: `npm run test:server`.

- [ ] **Step 3: Write the failing tool test**

Add to `server/src/mcp/tools/pipeline-tools.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpTestContext } from '../test-harness.js';

let ctx: McpTestContext;
let parseToolJson: (r: unknown) => any;
let manuscriptPath: string;
let uploadedBookId: string; // set by the upload test; reused by the start_analysis/start_generation/export describes

beforeAll(async () => {
  process.env.WORKSPACE_DIR = await mkdtemp(join(tmpdir(), 'audiobook-mcp-pipeline-'));
  manuscriptPath = join(await mkdtemp(join(tmpdir(), 'audiobook-mcp-src-')), 'tale.txt');
  await writeFile(
    manuscriptPath,
    'Chapter 1\n\n"Hello," said Alice.\n\nChapter 2\n\nThe end came quickly.',
  );
  const harness = await import('../test-harness.js');
  parseToolJson = harness.parseToolJson;
  ctx = await harness.startMcpTestClient();
});

afterAll(async () => {
  await ctx.close();
});

describe('upload_manuscript', () => {
  it('imports from a server-local file path and creates the book', async () => {
    const res = await ctx.client.callTool({
      name: 'upload_manuscript',
      arguments: { filePath: manuscriptPath, title: 'A Tale', author: 'Tester', isStandalone: true },
    });
    const data = parseToolJson(res);
    expect(data.bookId).toBeTruthy();
    expect(data.manuscriptId).toBeTruthy();
    expect(data.chapterCount).toBe(2);
    uploadedBookId = data.bookId;

    const bookRes = await ctx.client.callTool({ name: 'get_book', arguments: { bookId: data.bookId } });
    expect(parseToolJson(bookRes).chapters).toHaveLength(2);
  });

  it('rejects a missing file with structured error', async () => {
    const res = await ctx.client.callTool({
      name: 'upload_manuscript',
      arguments: { filePath: 'Z:/does/not/exist.txt', title: 'X', author: 'Y', isStandalone: true },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as any[])[0].text).code).toBe('file_not_readable');
  });
});
```

Run: `npm --prefix server run test -- src/mcp/tools/pipeline-tools.test.ts` — expected FAIL.

- [ ] **Step 4: Implement the tool**

Create `server/src/mcp/tools/pipeline-tools.ts` (the other three pipeline tools join this file in tasks 8–10):

```typescript
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult, toolError } from '../respond.js';
import { parseManuscript } from '../../parsers/index.js';
import { createBookFromImport } from '../../routes/import.js';
import type { StagedImport } from '../../store/import-staging.js';

export function registerPipelineTools(server: McpServer): void {
  server.registerTool(
    'upload_manuscript',
    {
      title: 'Upload manuscript',
      description:
        'Create a book from a manuscript. Provide filePath (server-local .txt/.md/.epub/.pdf/.mobi) OR inline text. ' +
        'title/author are required; set isStandalone:true unless the book belongs to a named series. Returns bookId — then call start_analysis.',
      inputSchema: {
        filePath: z.string().optional(),
        text: z.string().optional(),
        title: z.string(),
        author: z.string(),
        series: z.string().optional(),
        seriesPosition: z.number().int().optional(),
        isStandalone: z.boolean().optional(),
        language: z.string().optional(),
      },
    },
    async (args) => {
      if (!args.filePath && !args.text) {
        return toolError('missing_source', 'Provide filePath or text.', 'Pass a server-local file path or the manuscript text inline.');
      }
      let buffer: Buffer | undefined;
      if (args.filePath) {
        try {
          buffer = await readFile(args.filePath);
        } catch (err) {
          return toolError('file_not_readable', `Cannot read "${args.filePath}": ${(err as Error).message}`,
            'The path must exist on the machine running the Castwright server.');
        }
      }
      const parsed = await parseManuscript({
        buffer,
        text: args.text,
        fileName: args.filePath ? basename(args.filePath) : 'manuscript.txt',
      });
      const entry: StagedImport = {
        tempId: `mcp_${Date.now().toString(36)}`,
        format: parsed.format,
        title: args.title,
        author: args.author,
        series: args.series ?? '',
        seriesPosition: args.seriesPosition ?? null,
        sourceText: parsed.sourceText,
        chapters: parsed.chapters,
        originalFileName: args.filePath ? basename(args.filePath) : 'manuscript.txt',
        byteSize: buffer?.byteLength ?? Buffer.byteLength(args.text ?? ''),
        originalBuffer: buffer ?? Buffer.from(args.text ?? '', 'utf-8'),
        createdAt: new Date().toISOString(),
      };
      const book = await createBookFromImport(entry, {
        author: args.author,
        title: args.title,
        series: args.series ?? '',
        seriesPosition: args.seriesPosition,
        isStandalone: args.isStandalone ?? !args.series,
        language: args.language,
      });
      return jsonResult(
        `Created "${book.title}" (${book.chapterCount} chapters). Next: start_analysis with bookId.`,
        book,
      );
    },
  );
}
```

Register in `server.ts`: `registerPipelineTools(server);`. If the `StagedImport` interface has additional required fields, fill them from `parsed` — match the interface in `server/src/store/import-staging.ts` exactly rather than widening it.

- [ ] **Step 5: Run to verify pass + commit**

```bash
npm --prefix server run test -- src/mcp/tools/pipeline-tools.test.ts src/routes/import.test.ts
git add server/src/routes/import.ts server/src/mcp/
git commit -m "feat(server): fs-44 upload_manuscript tool via extracted createBookFromImport"
```

---

### Task 8: `start_analysis` (extract `beginAnalysisJob` from analysis.ts)

`POST /api/manuscripts/:id/analysis` is an SSE handler that validates, builds the `AnalysisJob`, and spawns `void runMainAnalyzerJob(job, record, selection, {...})` at line ~1835. Decouple job creation/spawn from the SSE subscription so the MCP layer can start a job with no HTTP client attached.

**Files:**
- Modify: `server/src/routes/analysis.ts`
- Modify: `server/src/mcp/tools/pipeline-tools.ts`
- Test: extend `server/src/mcp/tools/pipeline-tools.test.ts`

- [ ] **Step 1: Extract `beginAnalysisJob`**

In `analysis.ts`, move the block of the SSE route that (a) constructs the `AnalysisJob` (controller, replay state, registration into `inFlightAnalysisByManuscript`), and (b) spawns `void runMainAnalyzerJob(...)`, into:

```typescript
/** Create + spawn an analysis job with no subscribers attached.
 *  Shared by the SSE route (which subscribes after calling this) and the MCP start_analysis tool.
 *  Throws { code: 'analysis_already_running' } if one is in flight for this manuscript. */
export async function beginAnalysisJob(opts: {
  record: ManuscriptRecord;
  selection?: number[]; // chapter subset; undefined = full run
  engine?: 'local' | 'gemini';
}): Promise<AnalysisJob> {
  if (isAnalysisJobRunning(opts.record.manuscriptId)) {
    throw Object.assign(new Error('Analysis already running for this manuscript.'), {
      code: 'analysis_already_running',
    });
  }
  // ← moved verbatim: job construction, map registration,
  //   void runMainAnalyzerJob(job, opts.record, opts.selection, { ...same opts as before })
  return job;
}
```

The SSE route then becomes: validation → `const job = await beginAnalysisJob(...)` (or attach to the existing in-flight job exactly as it does today for resubscribes) → SSE headers → add its subscriber to `job.subscribers`. **Move code, don't rewrite it** — the diff for the moved block should be pure relocation plus the `opts.` prefix.

The subset route (`POST /api/manuscripts/:id/analysis/chapters`, line ~3641) keeps its own flow; the MCP tool passes `selection` through `beginAnalysisJob` only if the main runner supports subsets via the same path — if subsets run through a different runner (`inFlightSubsetByManuscript`), keep v1 `start_analysis` full-run-only and document that in the tool description.

- [ ] **Step 2: Existing analysis suites stay green**

```bash
npm run test:server
npm run test:server-slow
```

Expected: green (`analysis-pipelining.test.ts` is in the slow set). Any failure here means the extraction changed behaviour — fix the extraction, never the test.

- [ ] **Step 3: Write the failing tool test**

Append to `pipeline-tools.test.ts`. Mock the analyzer the way `analysis-pipelining.test.ts` does (mirror its `vi.mock` of the analyzer engine module so no Ollama/Gemini call happens — copy its mock helper verbatim):

```typescript
describe('start_analysis', () => {
  it('starts a job and reports it via get_job', async () => {
    // bookId from the upload test above (store it in a shared let at describe scope)
    const res = await ctx.client.callTool({ name: 'start_analysis', arguments: { bookId: uploadedBookId } });
    const data = parseToolJson(res);
    expect(data.jobId).toMatch(/^analysis:/);

    const job = parseToolJson(
      await ctx.client.callTool({ name: 'get_job', arguments: { jobId: data.jobId } }),
    );
    expect(['running', 'done']).toContain(job.state);
  });

  it('409s a second start while one is running', async () => {
    const res = await ctx.client.callTool({ name: 'start_analysis', arguments: { bookId: uploadedBookId } });
    if (res.isError) {
      expect(JSON.parse((res.content as any[])[0].text).code).toBe('analysis_already_running');
    } // else the first finished already under the mock — acceptable
  });
});
```

- [ ] **Step 4: Implement the tool**

Append to `pipeline-tools.ts` inside `registerPipelineTools`:

```typescript
import { beginAnalysisJob } from '../../routes/analysis.js';
import { findBookByBookId } from '../../workspace/scan.js';
import { getOrHydrateManuscript } from '../../store/manuscripts.js';
import { makeJobId } from '../job-view.js';
import { makeRecorderSubscriber } from '../job-recorder.js';
import { bookNotFound } from './read-tools.js'; // shared 'book_not_found' error (also used by tasks 9–10 in this file)

server.registerTool(
  'start_analysis',
  {
    title: 'Start analysis',
    description:
      'Run character/dialogue analysis for a book (minutes; uses the configured analyzer). Returns a jobId — chain wait_for_job until done, then get_cast.',
    inputSchema: { bookId: z.string() },
  },
  async ({ bookId }) => {
    const book = await findBookByBookId(bookId);
    if (!book) return bookNotFound(bookId);
    const manuscriptId = (book.state as { manuscriptId?: string }).manuscriptId;
    if (!manuscriptId) {
      return toolError('no_manuscript', `Book "${bookId}" has no manuscript record.`,
        'Re-import the book via upload_manuscript.');
    }
    const record = await getOrHydrateManuscript(manuscriptId);
    if (!record) {
      return toolError('manuscript_unreadable', `Manuscript ${manuscriptId} could not be hydrated.`,
        'Check the book directory on disk; re-import if the manuscript file is gone.');
    }
    const jobId = makeJobId('analysis', manuscriptId);
    let job;
    try {
      job = await beginAnalysisJob({ record });
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'analysis_start_failed';
      return toolError(code, (err as Error).message,
        code === 'analysis_already_running'
          ? `Wait for the running job: wait_for_job with jobId "${jobId}".`
          : 'Check get_system_status (analyzer reachable?) and retry.');
    }
    job.subscribers.add(
      makeRecorderSubscriber(jobId, (ev) => {
        const e = ev as { kind?: string; message?: string };
        if (e.kind === 'result') return { state: 'done', finishedAt: Date.now() };
        if (e.kind === 'error') return { state: 'failed', error: e.message, finishedAt: Date.now() };
        return null;
      }) as never,
    );
    return jsonResult(`Analysis started. Chain wait_for_job with jobId "${jobId}".`, { jobId, bookId });
  },
);
```

The recorder subscriber's stub `res` is what keeps `analysis.ts:1651`'s `sub.res.end()` from crashing at job end — do NOT replace it with a bare `{ send }` object.

- [ ] **Step 5: Run, pass, commit**

```bash
npm --prefix server run test -- src/mcp/tools/pipeline-tools.test.ts
npm run test:server-slow
git add server/src/routes/analysis.ts server/src/mcp/
git commit -m "feat(server): fs-44 start_analysis tool via extracted beginAnalysisJob"
```

---

### Task 9: `start_generation` (extract `beginGenerationJob` from generation.ts)

Same decoupling pattern as task 8, on `POST /api/books/:bookId/generation` (handler at line ~456; `registerJob(key, job)` + detached loop at line ~349).

**Files:**
- Modify: `server/src/routes/generation.ts`
- Modify: `server/src/mcp/tools/pipeline-tools.ts`
- Test: extend `server/src/mcp/tools/pipeline-tools.test.ts`

- [ ] **Step 1: Extract `beginGenerationJob`**

Move the job-construction + spawn block (everything between request validation and the SSE subscriber attach) into:

```typescript
/** Create + spawn generation for a chapter set with no subscribers attached.
 *  Shared by the SSE route and the MCP start_generation tool.
 *  Throws { code: 'generation_already_running' } when the same chapters are already in flight,
 *  and { code: 'cast_gaps' , characters: [...] } when unvoiced characters would force a loud fallback
 *  (the SSE route's fallbackConfirmed gate — the MCP path never auto-confirms). */
export async function beginGenerationJob(opts: {
  bookId: string;
  chapterIds?: number[]; // undefined = all pending chapters
}): Promise<{ jobs: RunningJob[]; runTotal: number }> {
  // ← moved verbatim from the route handler
}
```

The route handler becomes: validate → `beginGenerationJob` (or attach to in-flight) → SSE headers → subscribe. Keep the existing fallback-confirmation flow in the ROUTE (it is a UI interaction); the extracted function refuses with `cast_gaps` where the route would have asked.

- [ ] **Step 2: Existing generation suites stay green**

```bash
npm run test:server-slow
```

Expected: green (`generation.test.ts`, `generation-boundary-recycle.test.ts` live here). Pure-relocation rule applies.

- [ ] **Step 3: Write the failing tool test**

Append to `pipeline-tools.test.ts`, mocking the sidecar exactly as `generation.test.ts` does (global fetch stub returning PCM, plus any module mocks it uses — copy its helpers):

```typescript
describe('start_generation', () => {
  it('starts chapters and the job view tracks progress to done', async () => {
    const res = await ctx.client.callTool({
      name: 'start_generation',
      arguments: { bookId: uploadedBookId, chapterIds: [1] },
    });
    const { jobId } = parseToolJson(res);
    expect(jobId).toBe(`generation:${uploadedBookId}`);

    let view = parseToolJson(await ctx.client.callTool({
      name: 'wait_for_job', arguments: { jobId, timeoutSec: 30 },
    }));
    for (let i = 0; i < 5 && view.state === 'running'; i++) {
      view = parseToolJson(await ctx.client.callTool({
        name: 'wait_for_job', arguments: { jobId, timeoutSec: 30 },
      }));
    }
    expect(view.state).toBe('done');
  });

  it('refuses with cast_gaps when characters have no voice and no fallback confirm', async () => {
    // seed a second book whose cast has an unvoiced character, then:
    const res = await ctx.client.callTool({
      name: 'start_generation',
      arguments: { bookId: gapBookId, chapterIds: [1] },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as any[])[0].text).code).toBe('cast_gaps');
  });
});
```

If full synth mocking proves heavier than `generation.test.ts`'s existing helpers allow in this file, move BOTH generation cases into task 14's `pipeline.e2e.test.ts` (slow set) and leave only the `cast_gaps` refusal here — note the move in the task-14 commit message.

- [ ] **Step 4: Implement the tool**

Append inside `registerPipelineTools`:

```typescript
import { beginGenerationJob } from '../../routes/generation.js';

server.registerTool(
  'start_generation',
  {
    title: 'Start generation',
    description:
      'Synthesize audio for a book (hours for a full book). chapterIds limits the run; omit for all pending chapters. ' +
      'Refuses with cast_gaps if characters lack voices — fix via update_character or design_full_cast first. ' +
      'Returns a jobId; chain wait_for_job repeatedly (it times out by design on long runs — just call it again).',
    inputSchema: {
      bookId: z.string(),
      chapterIds: z.array(z.number().int()).optional(),
    },
  },
  async ({ bookId, chapterIds }) => {
    const book = await findBookByBookId(bookId);
    if (!book) return bookNotFound(bookId);
    const jobId = makeJobId('generation', bookId);
    let begun;
    try {
      begun = await beginGenerationJob({ bookId, chapterIds });
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'generation_start_failed';
      const detail =
        code === 'cast_gaps'
          ? 'Some characters have no voice. Call get_cast, then update_character / design_full_cast, then retry.'
          : code === 'generation_already_running'
            ? `Already running — wait_for_job with jobId "${jobId}".`
            : 'Check get_system_status (sidecar loaded?) and retry.';
      return toolError(code, (err as Error).message, detail);
    }
    // One recorder per chapter job, all sharing the jobId; classify covers both terminal conditions.
    // makeRecorderSubscriber clears stale outcomes once per add — same jobId, idempotent.
    for (const job of begun.jobs) {
      job.subscribers.add(
        makeRecorderSubscriber(jobId, (ev) => {
          const e = ev as { type?: string; errorReason?: string; runDone?: number; runTotal?: number };
          if (e.type === 'chapter_failed') {
            return { state: 'failed', error: e.errorReason, finishedAt: Date.now() };
          }
          if (e.type === 'chapter_complete' && e.runDone != null && e.runDone === e.runTotal) {
            return { state: 'done', finishedAt: Date.now() };
          }
          return null;
        }) as never,
      );
    }
    return jsonResult(
      `Generation started for ${begun.runTotal} chapter(s). Chain wait_for_job with jobId "${jobId}".`,
      { jobId, bookId, chapterCount: begun.runTotal },
    );
  },
);
```

(The stub `res` inside the recorder subscriber is load-bearing: `generation.ts:431` calls `sub.res.end()` at job end and `generation.ts:918` compares `sub.res === res` — a stub object satisfies both.)

- [ ] **Step 5: Run, pass, commit**

```bash
npm --prefix server run test -- src/mcp/tools/pipeline-tools.test.ts
npm run test:server-slow
git add server/src/routes/generation.ts server/src/mcp/
git commit -m "feat(server): fs-44 start_generation tool via extracted beginGenerationJob"
```

---

### Task 10: `export_audiobook` (extract `createExportJob` from export.ts)

**Files:**
- Modify: `server/src/routes/export.ts`
- Modify: `server/src/mcp/tools/pipeline-tools.ts`
- Test: extend `server/src/mcp/tools/pipeline-tools.test.ts`

- [ ] **Step 1: Extract `createExportJob`**

Move the body of `POST /api/books/:bookId/exports` (line ~196–327: job record creation, disk-guard check, manifest write, `void runExportJob(...)` spawn) into:

```typescript
/** Create + spawn an export job. Shared by POST /api/books/:bookId/exports and the MCP tool.
 *  Throws { code: 'no_audio' } when no completed chapters exist,
 *  { code: 'disk_low' } when the disk guard refuses. */
export async function createExportJob(opts: {
  bookId: string;
  format: BookExportJob['format'];
  destination: BookExportJob['destination'];
}): Promise<BookExportJob> {
  // ← moved verbatim from the route handler
}
```

Route handler keeps validation + calls it + returns the job JSON (including the existing `warning` field pass-through).

- [ ] **Step 2: Existing export tests stay green**

```bash
npm --prefix server run test -- src/routes/export.test.ts
```

- [ ] **Step 3: Failing tool test**

Append to `pipeline-tools.test.ts` (runs after the generation test so chapter 1 has audio; if generation moved to task 13, seed a fake completed chapter mp3 + state the way `export.test.ts` does — copy its fixture helper):

```typescript
describe('export_audiobook', () => {
  it('creates an export job that completes with a download path', async () => {
    const res = await ctx.client.callTool({
      name: 'export_audiobook',
      arguments: { bookId: uploadedBookId, format: 'mp3-folder' },
    });
    const { jobId } = parseToolJson(res);
    expect(jobId).toMatch(/^export:/);

    let view = parseToolJson(await ctx.client.callTool({
      name: 'wait_for_job', arguments: { jobId, timeoutSec: 55 },
    }));
    for (let i = 0; i < 3 && view.state === 'running'; i++) {
      view = parseToolJson(await ctx.client.callTool({
        name: 'wait_for_job', arguments: { jobId, timeoutSec: 55 },
      }));
    }
    expect(view.state).toBe('done');
    expect(view.detail).toBeTruthy(); // downloadUrl / syncPath / filename
  });
});
```

- [ ] **Step 4: Implement the tool**

Append inside `registerPipelineTools`:

```typescript
import { createExportJob } from '../../routes/export.js';

server.registerTool(
  'export_audiobook',
  {
    title: 'Export audiobook',
    description:
      'Package generated audio. format: m4b (single audiobook file) | mp3-zip | mp3-folder | aac-m4a-zip | opus-ogg-zip. ' +
      'Returns a jobId; wait_for_job until done — the result detail carries the download URL / output path.',
    inputSchema: {
      bookId: z.string(),
      format: z.enum(['mp3-zip', 'm4b', 'mp3-folder', 'aac-m4a-zip', 'opus-ogg-zip']),
      destination: z.enum(['download', 'sync-folder']).optional(),
    },
  },
  async ({ bookId, format, destination }) => {
    const book = await findBookByBookId(bookId);
    if (!book) return bookNotFound(bookId);
    try {
      const job = await createExportJob({ bookId, format, destination: destination ?? 'download' });
      const jobId = makeJobId('export', bookId, job.id);
      return jsonResult(`Export started (${format}). wait_for_job with jobId "${jobId}".`, {
        jobId, exportId: job.id, filename: job.filename,
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'export_start_failed';
      return toolError(code, (err as Error).message,
        code === 'no_audio'
          ? 'No completed chapters. Run start_generation first (get_book shows chapter states).'
          : 'Check get_system_status (ffmpeg, disk) and retry.');
    }
  },
);
```

No recorder subscriber needed — export jobs persist in the `jobs` map + disk manifests, so `getJobView` resolves them at every stage.

- [ ] **Step 5: Run, pass, commit — wave 2 complete**

```bash
npm --prefix server run test -- src/mcp/tools/pipeline-tools.test.ts src/routes/export.test.ts
git add server/src/routes/export.ts server/src/mcp/
git commit -m "feat(server): fs-44 export_audiobook tool via extracted createExportJob"
```

---

## Wave 3 — cast & voice parity + pipeline e2e

### Task 11: `update_character`

**Files:**
- Create: `server/src/mcp/cast-edit.ts`
- Create: `server/src/mcp/tools/cast-tools.ts`
- Modify: `server/src/mcp/server.ts` (register)
- Test: `server/src/mcp/tools/cast-tools.test.ts`

- [ ] **Step 1: Failing test**

`server/src/mcp/tools/cast-tools.test.ts` (fixture book seeded like read-tools.test.ts, with characters `narrator` voiced and `c1` unvoiced):

```typescript
describe('update_character', () => {
  it('renames and assigns an engine+voice', async () => {
    const res = await ctx.client.callTool({
      name: 'update_character',
      arguments: {
        bookId: 'bk_cast_test', characterId: 'c1',
        name: 'Alice Liddell', voice: { engine: 'kokoro', name: 'af_bella' },
      },
    });
    expect(res.isError).toBeFalsy();
    const cast = parseToolJson(
      await ctx.client.callTool({ name: 'get_cast', arguments: { bookId: 'bk_cast_test' } }),
    );
    const c1 = cast.characters.find((c: any) => c.id === 'c1');
    expect(c1).toMatchObject({
      name: 'Alice Liddell',
      engine: 'kokoro',
      voice: { engine: 'kokoro', name: 'af_bella' },
    });
    expect(c1.aliases).toContain('Alice'); // old name preserved as alias
  });

  it('errors on unknown character', async () => {
    const res = await ctx.client.callTool({
      name: 'update_character',
      arguments: { bookId: 'bk_cast_test', characterId: 'ghost', name: 'X' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as any[])[0].text).code).toBe('character_not_found');
  });
});
```

Expected: FAIL (tool missing).

- [ ] **Step 2: Implement the edit helper**

`server/src/mcp/cast-edit.ts` — same persistence helpers the routes use (`readJson`/`writeJsonAtomic` on `castJsonPath`); rename keeps the old name as an alias (mirrors the merge route's alias-union convention via the exported `unionStrings`):

```typescript
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { unionStrings } from '../routes/cast-merge.js';

export interface CharacterPatch {
  name?: string;
  voice?: { engine: string; name: string };
}

export async function updateCastCharacter(
  bookDir: string,
  characterId: string,
  patch: CharacterPatch,
): Promise<{ id: string; name: string }> {
  const path = castJsonPath(bookDir);
  const cast = await readJson<{ characters: any[] }>(path);
  if (!cast) throw Object.assign(new Error('cast.json missing'), { code: 'cast_not_ready' });
  const character = cast.characters.find((c) => c.id === characterId);
  if (!character) {
    throw Object.assign(new Error(`No character "${characterId}" in this book.`), {
      code: 'character_not_found',
    });
  }
  if (patch.name && patch.name !== character.name) {
    character.aliases = unionStrings(character.aliases ?? [], [character.name]);
    character.name = patch.name;
  }
  if (patch.voice) {
    character.ttsEngine = patch.voice.engine;
    character.overrideTtsVoices = {
      ...(character.overrideTtsVoices ?? {}),
      [patch.voice.engine]: { name: patch.voice.name },
    };
  }
  await writeJsonAtomic(path, cast);
  return { id: character.id, name: character.name };
}
```

If `unionStrings` in `cast-merge.ts` is not yet exported, add `export` to it (it's a pure helper at line ~270).

- [ ] **Step 3: Implement the tool**

`server/src/mcp/tools/cast-tools.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult, toolError } from '../respond.js';
import { findBookByBookId } from '../../workspace/scan.js';
import { updateCastCharacter } from '../cast-edit.js';
import { bookNotFound } from './read-tools.js';

export function registerCastTools(server: McpServer): void {
  server.registerTool(
    'update_character',
    {
      title: 'Update character',
      description:
        'Rename a character and/or assign its TTS engine + voice. Get characterIds and current assignments from get_cast; ' +
        'valid voice names from list_voices (includeBase:true for preset voices).',
      inputSchema: {
        bookId: z.string(),
        characterId: z.string(),
        name: z.string().optional(),
        voice: z.object({
          engine: z.enum(['kokoro', 'qwen', 'coqui', 'gemini', 'piper']),
          name: z.string(),
        }).optional(),
      },
    },
    async ({ bookId, characterId, name, voice }) => {
      if (!name && !voice) {
        return toolError('empty_patch', 'Nothing to update.', 'Pass name and/or voice.');
      }
      const book = await findBookByBookId(bookId);
      if (!book) return bookNotFound(bookId);
      try {
        const updated = await updateCastCharacter(book.bookDir, characterId, { name, voice });
        return jsonResult(`Updated ${updated.name}.`, { bookId, character: updated });
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'update_failed';
        return toolError(code, (err as Error).message, 'Call get_cast for valid characterIds.');
      }
    },
  );
}
```

Register in `server.ts`: `registerCastTools(server);`

- [ ] **Step 4: Run, pass, commit**

```bash
npm --prefix server run test -- src/mcp/tools/cast-tools.test.ts
git add server/src/mcp/ server/src/routes/cast-merge.ts
git commit -m "feat(server): fs-44 update_character tool with cast.json patch helper"
```

---

### Task 12: `merge_characters` (extract `mergeCastCharacters` from cast-merge.ts)

**Files:**
- Modify: `server/src/routes/cast-merge.ts`
- Modify: `server/src/mcp/tools/cast-tools.ts`
- Test: extend `server/src/mcp/tools/cast-tools.test.ts`

- [ ] **Step 1: Extract the merge core**

Move the body of the route handler (lines ~48–227: cast read, alias/evidence merge, manuscript-edits rewrite, analysis-cache update, cast write) into:

```typescript
/** Fold source character into target across cast.json, manuscript-edits, and the analysis cache.
 *  Shared by POST /api/books/:bookId/cast/merge and the MCP merge_characters tool.
 *  Throws { code: 'character_not_found' } when either id is missing. */
export async function mergeCastCharacters(
  bookDir: string,
  sourceId: string,
  targetId: string,
): Promise<{ characters: CharacterOutput[] }> {
  // ← moved verbatim from the route handler
}
```

Route handler keeps param validation + book lookup + `res.json(await mergeCastCharacters(...))`.

- [ ] **Step 2: Existing merge tests stay green**

```bash
npm --prefix server run test -- src/routes/cast-merge.test.ts
```

- [ ] **Step 3: Failing tool test → implement → pass**

Test (append to cast-tools.test.ts; seed a third character `c2` with aliases in the fixture):

```typescript
describe('merge_characters', () => {
  it('folds source into target and unions aliases', async () => {
    const res = await ctx.client.callTool({
      name: 'merge_characters',
      arguments: { bookId: 'bk_cast_test', sourceId: 'c2', targetId: 'c1' },
    });
    expect(res.isError).toBeFalsy();
    const cast = parseToolJson(
      await ctx.client.callTool({ name: 'get_cast', arguments: { bookId: 'bk_cast_test' } }),
    );
    expect(cast.characters.find((c: any) => c.id === 'c2')).toBeUndefined();
    expect(cast.characters.find((c: any) => c.id === 'c1').aliases).toContain('Albert');
  });
});
```

Tool (append to `registerCastTools`):

```typescript
import { mergeCastCharacters } from '../../routes/cast-merge.js';

server.registerTool(
  'merge_characters',
  {
    title: 'Merge characters',
    description:
      'Fold a duplicate character (sourceId) into another (targetId): aliases/evidence union, dialogue re-attributed, source removed. Same operation as the UI merge. Irreversible without the merge journal.',
    inputSchema: { bookId: z.string(), sourceId: z.string(), targetId: z.string() },
  },
  async ({ bookId, sourceId, targetId }) => {
    const book = await findBookByBookId(bookId);
    if (!book) return bookNotFound(bookId);
    try {
      const result = await mergeCastCharacters(book.bookDir, sourceId, targetId);
      return jsonResult(`Merged ${sourceId} into ${targetId}.`, {
        bookId, characterCount: result.characters.length,
      });
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'merge_failed';
      return toolError(code, (err as Error).message, 'Call get_cast for valid character ids.');
    }
  },
);
```

- [ ] **Step 4: Run, pass, commit**

```bash
npm --prefix server run test -- src/mcp/tools/cast-tools.test.ts src/routes/cast-merge.test.ts
git add server/src/routes/cast-merge.ts server/src/mcp/
git commit -m "feat(server): fs-44 merge_characters tool via extracted mergeCastCharacters"
```

---

### Task 13: `design_voice` + `design_full_cast` (extract begin functions from the design routes)

**Files:**
- Modify: `server/src/routes/cast-design.ts`
- Modify: `server/src/routes/single-design.ts`
- Modify: `server/src/mcp/tools/cast-tools.ts`
- Test: extend `server/src/mcp/tools/cast-tools.test.ts`

- [ ] **Step 1: Extract `beginCastDesignJob` and `beginSingleDesignJob`**

Same pattern as tasks 8–9 — job construction + spawn decoupled from SSE subscription, design-lock 409 semantics preserved:

In `cast-design.ts`:

```typescript
/** Create + spawn the bulk design job with no subscribers. Shared by the SSE route and MCP.
 *  Throws { code: 'design_busy' } when the per-book design lock is held,
 *  { code: 'sidecar_unavailable' } when the sidecar probe fails. */
export async function beginCastDesignJob(opts: {
  bookId: string;
  scope: 'bases' | 'variants' | 'both';
}): Promise<DesignJob> {
  // ← moved verbatim from POST /api/books/:bookId/cast/design (line ~321)
}
```

In `single-design.ts`:

```typescript
/** Create + spawn a single-character voice design with no subscribers. Shared by the SSE route and MCP. */
export async function beginSingleDesignJob(opts: {
  bookId: string;
  characterId: string;
}): Promise<SingleJob> {
  // ← moved verbatim; mode ('first' | 'redesign') derived inside exactly as the route does today;
  //   MCP always uses the non-preview path so a first design auto-persists (plan 195 behaviour)
}
```

- [ ] **Step 2: Existing design suites stay green**

```bash
npm --prefix server run test -- src/routes/cast-design.test.ts src/routes/single-design.test.ts
```

- [ ] **Step 3: Failing tool tests**

Append to `cast-tools.test.ts`, reusing `cast-design.test.ts`'s `okSidecarResponse()` fetch-stub + `vi.mock('../analyzer/voice-style.js')` persona-mock helpers (copy them into this file):

```typescript
describe('design tools', () => {
  it('design_full_cast runs to done and designs the unvoiced characters', async () => {
    const res = await ctx.client.callTool({
      name: 'design_full_cast',
      arguments: { bookId: 'bk_cast_test', scope: 'bases' },
    });
    const { jobId } = parseToolJson(res);
    expect(jobId).toBe('cast-design:bk_cast_test');

    let view = parseToolJson(await ctx.client.callTool({
      name: 'wait_for_job', arguments: { jobId, timeoutSec: 30 },
    }));
    for (let i = 0; i < 5 && view.state === 'running'; i++) {
      view = parseToolJson(await ctx.client.callTool({
        name: 'wait_for_job', arguments: { jobId, timeoutSec: 30 },
      }));
    }
    expect(view.state).toBe('done');
  });

  it('design_voice 409s while a bulk job holds the design lock', async () => {
    // start bulk with a slow sidecar stub, then:
    const res = await ctx.client.callTool({
      name: 'design_voice',
      arguments: { bookId: 'bk_cast_test', characterId: 'c1' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as any[])[0].text).code).toBe('design_busy');
  });
});
```

- [ ] **Step 4: Implement the tools**

Append to `registerCastTools`:

```typescript
import { beginCastDesignJob } from '../../routes/cast-design.js';
import { beginSingleDesignJob } from '../../routes/single-design.js';
import { makeJobId } from '../job-view.js';
import { makeRecorderSubscriber } from '../job-recorder.js';

server.registerTool(
  'design_full_cast',
  {
    title: 'Design full cast',
    description:
      'Bulk Qwen voice design for every character that needs one. scope: bases (new voices) | variants (emotion variants for designed voices) | both. ' +
      'GPU-heavy, minutes per character. Returns a jobId; chain wait_for_job.',
    inputSchema: {
      bookId: z.string(),
      scope: z.enum(['bases', 'variants', 'both']).optional(),
    },
  },
  async ({ bookId, scope }) => {
    const book = await findBookByBookId(bookId);
    if (!book) return bookNotFound(bookId);
    const jobId = makeJobId('cast-design', bookId);
    try {
      const job = await beginCastDesignJob({ bookId, scope: scope ?? 'both' });
      job.subscribers.add(
        makeRecorderSubscriber(jobId, (ev) => {
          const e = ev as { type?: string; message?: string; failures?: unknown[] };
          if (e.type === 'idle') {
            return {
              state: e.failures?.length ? 'failed' : 'done',
              error: e.failures?.length ? `${e.failures.length} character(s) failed` : undefined,
              finishedAt: Date.now(),
            };
          }
          if (e.type === 'error') return { state: 'failed', error: e.message, finishedAt: Date.now() };
          return null;
        }) as never,
      );
      return jsonResult(`Bulk design started (${job.total} character(s)). wait_for_job with "${jobId}".`,
        { jobId, bookId, total: job.total });
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'design_start_failed';
      return toolError(code, (err as Error).message,
        code === 'design_busy'
          ? `A design job is already running — wait_for_job with "${jobId}".`
          : 'Check get_system_status (sidecar/Qwen loaded?) and retry.');
    }
  },
);

server.registerTool(
  'design_voice',
  {
    title: 'Design voice',
    description:
      'Qwen voice design for ONE character (from its persona). First design auto-persists. GPU-heavy. Returns a jobId; chain wait_for_job.',
    inputSchema: { bookId: z.string(), characterId: z.string() },
  },
  async ({ bookId, characterId }) => {
    const book = await findBookByBookId(bookId);
    if (!book) return bookNotFound(bookId);
    const jobId = makeJobId('single-design', bookId);
    try {
      const job = await beginSingleDesignJob({ bookId, characterId });
      job.subscribers.add(
        makeRecorderSubscriber(jobId, (ev) => {
          const e = ev as { type?: string; message?: string };
          if (e.type === 'designed' || e.type === 'preview_ready') {
            return { state: 'done', finishedAt: Date.now() };
          }
          if (e.type === 'error') return { state: 'failed', error: e.message, finishedAt: Date.now() };
          return null;
        }) as never,
      );
      return jsonResult(`Designing ${job.characterName}. wait_for_job with "${jobId}".`,
        { jobId, bookId, characterId });
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'design_start_failed';
      return toolError(code, (err as Error).message,
        code === 'design_busy'
          ? 'Another design is running for this book — wait for it first.'
          : 'Check get_system_status and retry.');
    }
  },
);
```

- [ ] **Step 5: Run, pass, commit**

```bash
npm --prefix server run test -- src/mcp/tools/cast-tools.test.ts src/routes/cast-design.test.ts src/routes/single-design.test.ts
git add server/src/routes/cast-design.ts server/src/routes/single-design.ts server/src/mcp/
git commit -m "feat(server): fs-44 design_voice + design_full_cast tools via extracted begin functions"
```

---

### Task 14: MCP pipeline integration test (slow set)

The spec's "doubles as the whole-pipeline integration test": upload → analyze → cast-fix → generate → export, entirely through the MCP client, all engines mocked.

**Files:**
- Create: `server/src/mcp/pipeline.e2e.test.ts`
- Modify: `server/vitest.config.ts` (SLOW_FILES_TO_EXCLUDE) + `server/vitest.config.slow.ts` (SLOW_FILES) — add `'src/mcp/pipeline.e2e.test.ts'` to BOTH (mirror invariant)

- [ ] **Step 1: Write the test**

`server/src/mcp/pipeline.e2e.test.ts` — single `it` walking the whole pipeline. Mock setup copies the analyzer mock from `analysis-pipelining.test.ts` and the sidecar fetch-stub from `generation.test.ts` (both files are the canonical mock references; lift their helpers verbatim):

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpTestContext } from './test-harness.js';

// vi.mock(...) analyzer + sidecar stubs here, copied from
// src/routes/analysis-pipelining.test.ts and src/routes/generation.test.ts
// (src/mcp/ sits at the same '../' depth as src/routes/, so the relative
//  mock specifiers copy unchanged — vi.mock resolves against THIS file)

let ctx: McpTestContext;
let parseToolJson: (r: unknown) => any;

beforeAll(async () => {
  process.env.WORKSPACE_DIR = await mkdtemp(join(tmpdir(), 'audiobook-mcp-e2e-'));
  const harness = await import('./test-harness.js');
  parseToolJson = harness.parseToolJson;
  ctx = await harness.startMcpTestClient();
});

afterAll(async () => {
  await ctx.close();
});

async function waitUntilTerminal(jobId: string, rounds = 10): Promise<any> {
  let view: any;
  for (let i = 0; i < rounds; i++) {
    view = parseToolJson(await ctx.client.callTool({
      name: 'wait_for_job', arguments: { jobId, timeoutSec: 30 },
    }));
    if (view.state === 'done' || view.state === 'failed') return view;
  }
  return view;
}

describe('mcp full pipeline (mock engines)', () => {
  it('upload → analyze → voice-fix → generate → export with zero REST calls', async () => {
    const src = join(await mkdtemp(join(tmpdir(), 'mcp-e2e-src-')), 'demo.txt');
    await writeFile(src, 'Chapter 1\n\n"Hello," said Alice. The narrator continued calmly.');

    const up = parseToolJson(await ctx.client.callTool({
      name: 'upload_manuscript',
      arguments: { filePath: src, title: 'Demo', author: 'E2E', isStandalone: true },
    }));

    const an = parseToolJson(await ctx.client.callTool({
      name: 'start_analysis', arguments: { bookId: up.bookId },
    }));
    expect((await waitUntilTerminal(an.jobId)).state).toBe('done');

    const cast = parseToolJson(await ctx.client.callTool({
      name: 'get_cast', arguments: { bookId: up.bookId },
    }));
    for (const c of cast.characters.filter((c: any) => !c.voice)) {
      await ctx.client.callTool({
        name: 'update_character',
        arguments: { bookId: up.bookId, characterId: c.id, voice: { engine: 'kokoro', name: 'af_heart' } },
      });
    }

    const gen = parseToolJson(await ctx.client.callTool({
      name: 'start_generation', arguments: { bookId: up.bookId },
    }));
    expect((await waitUntilTerminal(gen.jobId)).state).toBe('done');

    const ex = parseToolJson(await ctx.client.callTool({
      name: 'export_audiobook', arguments: { bookId: up.bookId, format: 'mp3-folder' },
    }));
    const exported = await waitUntilTerminal(ex.jobId);
    expect(exported.state).toBe('done');
    expect(exported.detail).toBeTruthy();
  });
});
```

- [ ] **Step 2: Route to the slow config**

Add `'src/mcp/pipeline.e2e.test.ts'` to the SLOW_FILES array in `server/vitest.config.slow.ts` AND the mirrored exclude list in `server/vitest.config.ts`.

- [ ] **Step 3: Run**

```bash
npm run test:server-slow
```

Expected: PASS, including the new file. If the analyzer/sidecar mocks fight this file's module graph, isolate by giving the e2e its own seeded analysis output (write the analysis cache directly the way `generation.test.ts` fixtures do) and drop the live-analysis leg to `start_analysis` + recorder-done assertion only — but keep upload/generation/export real.

- [ ] **Step 4: Commit**

```bash
git add server/src/mcp/pipeline.e2e.test.ts server/vitest.config.ts server/vitest.config.slow.ts
git commit -m "test(server): fs-44 mcp full-pipeline integration test (slow set)"
```

---

## Wave 4 — stdio bridge (`castwright-mcp` bin)

### Task 15: stdio ⇄ HTTP bridge bin

Codex, older Copilot CLI builds, and other stdio-first harnesses spawn MCP servers as child processes. The bridge is a **pure transport proxy** — stdio JSON-RPC in, Streamable-HTTP out — so the tool surface can never fork between transports. Zero tool logic lives here.

**Files:**
- Create: `server/src/mcp/stdio-bridge.ts`
- Modify: `server/package.json` (`bin` field)
- Test: `server/src/mcp/stdio-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

`server/src/mcp/stdio-bridge.test.ts` — boots the real HTTP endpoint via the harness, then connects a SECOND client through the bridge spawned as a child process (from TS source via `node --import tsx`, cwd at `server/` so tsx resolves):

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpTestContext } from './test-harness.js';

const here = dirname(fileURLToPath(import.meta.url)); // .../server/src/mcp
const serverDir = join(here, '..', '..');
const bridgeSrc = join(here, 'stdio-bridge.ts');

let httpCtx: McpTestContext;
let stdioClient: Client;

beforeAll(async () => {
  process.env.WORKSPACE_DIR = await mkdtemp(join(tmpdir(), 'audiobook-mcp-stdio-'));
  const harness = await import('./test-harness.js');
  httpCtx = await harness.startMcpTestClient();

  stdioClient = new Client({ name: 'stdio-bridge-test', version: '0.0.0' });
  await stdioClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', bridgeSrc, '--url', httpCtx.baseUrl],
      cwd: serverDir,
    }),
  );
}, 60_000);

afterAll(async () => {
  await stdioClient.close();
  await httpCtx.close();
});

describe('castwright-mcp stdio bridge', () => {
  it('exposes the same tool surface as the HTTP endpoint', async () => {
    const viaBridge = (await stdioClient.listTools()).tools.map((t) => t.name).sort();
    const direct = (await httpCtx.client.listTools()).tools.map((t) => t.name).sort();
    expect(viaBridge).toEqual(direct); // proxy can never fork the surface
  });

  it('round-trips a tool call through stdio → HTTP → stdio', async () => {
    const result = await stdioClient.callTool({ name: 'ping', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('"ok": true');
  });
});
```

Run: `npm --prefix server run test -- src/mcp/stdio-bridge.test.ts` — expected FAIL (bridge missing).

- [ ] **Step 2: Implement the bridge**

`server/src/mcp/stdio-bridge.ts` (the shebang must be line 1 — `tsc` preserves it into `dist/`):

```typescript
#!/usr/bin/env node
/**
 * castwright-mcp — stdio ⇄ Streamable-HTTP bridge for MCP clients without HTTP transports
 * (Codex, stdio-only harnesses). Pure transport proxy: NO tool logic lives here, so the
 * tool surface can never diverge from the /mcp endpoint.
 *
 * Usage:   castwright-mcp [--url http://localhost:8080/mcp] [--token <lan-token>]
 * Env:     CASTWRIGHT_MCP_URL, CASTWRIGHT_MCP_TOKEN (flags win)
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const url = argValue('--url') ?? process.env.CASTWRIGHT_MCP_URL ?? 'http://localhost:8080/mcp';
const token = argValue('--token') ?? process.env.CASTWRIGHT_MCP_TOKEN;

async function main(): Promise<void> {
  const upstream = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const downstream = new StdioServerTransport();

  let closing = false;
  const shutdown = (err?: unknown): void => {
    if (closing) return;
    closing = true;
    if (err) process.stderr.write(`[castwright-mcp] ${(err as Error).message ?? String(err)}\n`);
    void upstream.close();
    void downstream.close();
    process.exit(err ? 1 : 0);
  };

  downstream.onmessage = (msg) => {
    upstream.send(msg).catch(shutdown);
  };
  upstream.onmessage = (msg) => {
    downstream.send(msg).catch(shutdown);
  };
  downstream.onclose = () => shutdown();
  upstream.onclose = () => shutdown();
  downstream.onerror = shutdown;
  upstream.onerror = shutdown;

  await upstream.start();
  await downstream.start();
}

void main();
```

Implementation notes for the executor:
- This pipes raw JSON-RPC between the two `Transport` implementations — correct for a **stateless** upstream (each POST is independent; no session id to thread). Do NOT wrap it in a `Client`/`McpServer` pair — that would re-handshake and double-initialize.
- `StreamableHTTPClientTransport.start()` is lazy (no connection until the first send) — an unreachable server surfaces on the first message; the `.catch(shutdown)` paths turn that into a clean exit 1 with the error on stderr, which stdio MCP clients report verbatim.

- [ ] **Step 3: Add the bin entry**

In `server/package.json` add at top level:

```json
"bin": { "castwright-mcp": "dist/mcp/stdio-bridge.js" }
```

- [ ] **Step 4: Run to verify pass (test + built bin smoke)**

```bash
npm --prefix server run test -- src/mcp/stdio-bridge.test.ts
npm --prefix server run build
node server/dist/mcp/stdio-bridge.js --url http://127.0.0.1:1/mcp < NUL
```

Expected: test PASS; build clean; the smoke invocation exits 1 quickly with a `[castwright-mcp]` connection error on stderr (proves the compiled bin runs standalone). On bash use `< /dev/null` instead of `< NUL`.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/stdio-bridge.ts server/src/mcp/stdio-bridge.test.ts server/package.json
git commit -m "feat(server): fs-44 castwright-mcp stdio bridge bin (wave 4)"
```

---

## Docs + ship

### Task 16: Docs — README section + regression plan + INDEX

**Files:**
- Modify: `README.md`
- Create: `docs/features/205-mcp-agent-surface.md` (verify 205 is still the next free number: `ls docs/features/ | sort` — if taken, use the next free and adjust references)
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1: README section**

Add after the existing usage sections:

````markdown
## Driving Castwright from an agent (MCP)

Castwright exposes an MCP endpoint at `http://localhost:8080/mcp` (or `https://<lan-ip>:8443/mcp`
with the LAN token in LAN mode) so any MCP-capable agent can run the whole pipeline —
upload → analyze → cast → generate → export — without the web UI. ~15 workflow-level
tools; long jobs return a `jobId` you chain through `wait_for_job`.

**Claude Code / Cowork**

```bash
claude mcp add --transport http castwright http://localhost:8080/mcp
```

**Codex and other stdio-first clients** (`~/.codex/config.toml`) — use the bundled `castwright-mcp` bridge (a pure proxy onto the same endpoint):

```toml
[mcp_servers.castwright]
command = "node"
args = ["<castwright-install>/server/dist/mcp/stdio-bridge.js"]
```

**Copilot CLI / Gemini CLI / Cursor** (JSON MCP config — HTTP where supported, else the same bridge)

```json
{ "mcpServers": { "castwright": { "url": "http://localhost:8080/mcp" } } }
```

LAN access from another machine: use `https://<lan-ip>:8443/mcp` and pass the LAN token
(`Authorization: Bearer <token>` header, or `--token <token>` on the bridge).

Try: *“List my books, then generate chapter 1 of <title> and tell me when it’s exported as m4b.”*
````

- [ ] **Step 2: Regression plan**

Create `docs/features/205-mcp-agent-surface.md` from `docs/features/TEMPLATE.md`:

```markdown
---
status: active
shipped: null
owner: null
---

# MCP agent surface (fs-44)

> Status: active
> Key files: `server/src/mcp/` (router/server/tools/job-view/stdio-bridge), `server/src/index.ts` (mount), extracted begin/create functions in `server/src/routes/{import,analysis,generation,export,cast-merge,cast-design,single-design}.ts`
> URL surface: none (protocol endpoint at `/mcp`)
> OpenAPI ops: none — deliberately outside `openapi.yaml` (MCP protocol surface, not a REST resource)

## Benefit / Rationale

- **User:** any MCP-capable agent (Claude, Codex, Copilot CLI, Gemini CLI, Cursor) drives upload → analyze → cast → generate → export with zero UI interaction.
- **Architectural:** tools are a curated façade over the SAME service functions the REST routes call — extraction, never duplication.
- **Technical:** the MCP pipeline e2e doubles as the missing whole-pipeline integration test.

## Invariants to preserve

1. `/mcp` sits behind `requireLanToken` exactly like `/api` — no separate auth surface.
2. Every tool handler calls an exported service/route function; no business logic lives in `server/src/mcp/tools/`.
3. Tool results: one-line summary + JSON payload; errors: `{ code, message, remediation }` with `isError: true`.
4. Composite jobId grammar `kind:key[:subkey]` is stable — agents persist these across waits.
5. `wait_for_job` never exceeds 55 s (client tool-timeout floor); long jobs are chained waits.
6. Core-spec MCP only: tools + text content. No sampling/elicitation/roots; annotations advisory.
7. SSE remains UI-only; MCP reads job state through the exported view getters + recorder.
8. The `castwright-mcp` stdio bridge is a pure transport proxy — zero tool logic; its test pins `listTools()` equality with the HTTP endpoint so the surfaces can never fork.
9. Synthetic recorder subscribers always carry a stub `res` (the job routes call `sub.res.end()` at job end).

## Manual acceptance

1. `claude mcp add --transport http castwright http://localhost:8080/mcp`; in a fresh session run the full pipeline on a small public-domain manuscript (pairs with fs-22's bundled demo book) with zero UI use.
2. Repeat from one non-Claude harness (Codex or Copilot CLI), connected through the `castwright-mcp` stdio bridge.
3. LAN mode: confirm `/mcp` 401s without the token and works with it (HTTP header and bridge `--token` both).

## Ship notes

_(fill at ship: date, PR, commit)_
```

- [ ] **Step 3: INDEX entry**

Add a row to `docs/features/INDEX.md` under the server area: `205-mcp-agent-surface.md — MCP agent surface (fs-44): /mcp endpoint + 15 workflow tools`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/features/205-mcp-agent-surface.md docs/features/INDEX.md
git commit -m "docs(docs,server): fs-44 mcp agent surface docs + regression plan 205"
```

---

### Task 17: Full verify + PR

- [ ] **Step 1: Full battery**

```bash
npm run verify
```

Expected: lint + typecheck + all unit suites + e2e + build green. Triage any failure per the CLAUDE.md hook-failure protocol (related → fix; pre-existing → surface to the user, do not fix in this branch).

- [ ] **Step 2: Push + draft PR**

```bash
git push -u origin feat/server-fs44-mcp-agent-surface
gh pr create --draft --title "feat(server): fs-44 MCP agent surface — /mcp endpoint, 15 workflow tools, stdio bridge" --body-file <(echo "## Summary

- fs-44: Streamable-HTTP MCP endpoint at /mcp (stateless, behind requireLanToken) with 15 workflow-level tools: read/inspect, pipeline (upload/analyze/generate/export), cast & voice parity, get_job/wait_for_job over a uniform job view.
- castwright-mcp stdio bridge bin (wave 4): pure transport proxy onto /mcp so stdio-only harnesses (Codex etc.) get the identical tool surface.
- Route-handler logic reused via surgical extractions (createBookFromImport, beginAnalysisJob, beginGenerationJob, createExportJob, mergeCastCharacters, beginCastDesignJob, beginSingleDesignJob) — routes and tools call the same functions.
- Regression plan docs/features/205-mcp-agent-surface.md; README 'Driving Castwright from an agent'.

Closes #721

## Test plan

- server/src/mcp/*.test.ts — endpoint, every tool group, job view/recorder, stdio bridge surface-equality + round-trip (vitest + real MCP SDK client over ephemeral HTTP / spawned stdio child).
- server/src/mcp/pipeline.e2e.test.ts (slow set) — full upload→analyze→generate→export through the MCP client, engines mocked.
- All extraction-touched route suites green unchanged. npm run verify green locally.")
```

(On Windows PowerShell, write the body to a temp file and pass `--body-file` instead of process substitution.)

- [ ] **Step 3: Manual acceptance (live box, deferred to user/GPU session)**

From Claude Code: `claude mcp add --transport http castwright http://localhost:8080/mcp`, then drive a small book end-to-end. Repeat once from a non-Claude harness. Then `gh pr ready`, merge, fill plan-205 Ship notes, close out the fs-44 BACKLOG row per the backlog update rule.

---

## Post-plan checklist (maps to CLAUDE.md "Before shipping")

- Regression plan: task 16 (plan 205). Backlog/issue: PR body `Closes #721`; remove the fs-44 row from `docs/BACKLOG.md` on merge.
- Wave 4 (stdio bridge): DELIVERED by task 15 — no follow-up item needed.
- Known risks called out to the implementer: (1) the analysis/generation extractions are the two riskiest diffs — pure-relocation discipline + the slow suites are the net; (2) recorder subscribers MUST go through `makeRecorderSubscriber` (stub `res` prevents the `sub.res.end()` crash at job end — verified call sites: cast-design.ts:147, single-design.ts:76, analysis.ts:1651, generation.ts:431); (3) zod-4/SDK compat is verified (SDK 1.29.0 range `^3.25 || ^4.0`) — task 1's probe is belt-and-suspenders.
```
