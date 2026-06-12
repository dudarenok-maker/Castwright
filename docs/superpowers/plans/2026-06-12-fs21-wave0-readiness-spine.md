# fs-21 Wave 0 — Readiness Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundational, independently-testable spine of the fs-21 first-run wizard: a derived `GET /api/setup/readiness` (a thin mapper over the existing `diagnostics.ts` aggregator), a new `{ kind: 'setup' }` gated stage at `#/setup`, a `setupCompletedAt` persisted flag, and a boot-time gate that redirects to `#/setup` when a hard-blocker fails.

**Architecture:** The hard gate is *derived* — on boot, `Layout` fetches readiness; if any hard-blocker (sidecar+venv, ffmpeg, ≥1 TTS engine, analyzer) fails, the user is redirected to the setup stage. Readiness reuses the diagnostics probes (extracted into a reusable `buildDiagnostics()`), adding only the probes diagnostics lacks: venv-on-disk and per-engine TTS weights. The setup view itself is a stub here (Wave 2 fleshes the five-step UI); Wave 0 proves the gate + readiness contract end to end.

**Tech Stack:** Express + TypeScript (server), Vitest (server + frontend unit), React 18 + Redux Toolkit + react-router v6 hash router (frontend), Playwright (e2e). Mocks behind `VITE_USE_MOCKS`.

**Spec:** `docs/superpowers/specs/2026-06-12-fs21-first-run-wizard-design.md` · **Issue:** #474 · **Branch:** `feat/fs21-wave0-readiness-spine` off `main`.

> **Per the review-first convention, do NOT file the per-wave sub-issue until this plan is reviewed.** When approved: cut `feat/fs21-wave0-readiness-spine`, open it as a **draft** PR, run `npm run verify` locally to green, then `gh pr ready`.
>
> **Prerequisite:** the spec + this plan currently live on `docs/docs-fs21-wizard-spec`, not `main`. **Merge that docs branch first** (or have the executor read the plan from it) so the code branch — cut off `main` — has the plan available during execution.

---

## File Structure

**Server (new):**
- `server/src/diagnostics/venv.ts` — `sidecarVenvPresent()`: stats the sidecar venv python and reports presence. One responsibility: "is the Python env bootstrapped?"
- `server/src/routes/setup-readiness.ts` — `GET /api/setup/readiness` route + `buildSetupReadiness()` + the `SetupReadiness` types. The thin mapper.
- `server/src/routes/setup-readiness.test.ts` — route + mapper tests.
- `server/src/diagnostics/venv.test.ts` — venv probe test.

**Server (modify):**
- `server/src/routes/diagnostics.ts` — extract the inline handler body into an exported `buildDiagnostics(): Promise<DiagnosticsResponse>` so both the diagnostics route AND readiness reuse it (no HTTP self-call).
- `server/src/workspace/user-settings.ts` — add `setupCompletedAt?: string | null` to `UserSettings` + `getResolvedSetupCompletedAt()` + `writeSetupCompletedAt()`.
- `server/src/index.ts` — register the new router.

**Frontend (new):**
- `src/views/setup.tsx` — `SetupView` STUB (Wave 2 replaces the body). Renders the readiness summary so the route is real and testable now.
- `src/views/setup.test.tsx` — stub render test.

**Frontend (modify):**
- `src/lib/types.ts` — add `{ kind: 'setup' }` to the `Stage` union.
- `src/lib/router.ts` — `stageToHash` case for `setup`.
- `src/store/ui-slice.ts` — `openSetup` reducer.
- `src/routes/index.tsx` — `SetupRoute` + route table entry.
- `src/lib/api.ts` — `SetupReadiness` interface + `realGetSetupReadiness` / `mockGetSetupReadiness` (dual-state) + wire into the `api` object (both real + mock maps).
- `src/components/layout.tsx` — boot-time readiness fetch + splash gate + redirect.
- `src/store/ui-slice.test.ts` — `openSetup` test.
- `src/lib/router.test.ts` — `stageToHash('setup')` test.

**E2E (new):**
- `e2e/setup-gate.spec.ts` — gate fires when readiness is not-ready (mock forced to not-ready), and does NOT fire when ready.

---

## Task 1: `setupCompletedAt` persisted flag (server)

**Files:**
- Modify: `server/src/workspace/user-settings.ts`
- Test: `server/src/workspace/user-settings.test.ts` (add cases; create if absent)

- [ ] **Step 1: Write the failing test**

Add to `server/src/workspace/user-settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('setupCompletedAt', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'us-'));
    process.env.USER_SETTINGS_PATH = join(dir, 'settings.json');
  });

  it('reads null when unset', async () => {
    const { getResolvedSetupCompletedAt } = await import('./user-settings.js');
    expect(getResolvedSetupCompletedAt()).toBeNull();
  });

  it('round-trips a stamped ISO string', async () => {
    const { writeSetupCompletedAt, getResolvedSetupCompletedAt } = await import(
      './user-settings.js'
    );
    await writeSetupCompletedAt('2026-06-12T00:00:00.000Z');
    expect(getResolvedSetupCompletedAt()).toBe('2026-06-12T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts -t setupCompletedAt`
Expected: FAIL — `getResolvedSetupCompletedAt is not a function`.

- [ ] **Step 3: Implement the field + getter + writer**

In `server/src/workspace/user-settings.ts`, add `setupCompletedAt?: string | null;` to the `UserSettings` interface (near `lastSeenAppVersion`), then add the getter + writer.

**Important:** the getter must read the module-level sync `cached` (NOT the async `readUserSettings()` — that returns a `Promise`), exactly like `getResolvedGeminiApiKey` does. And the writer must mirror `writeUpgradeMeta` (a *dedicated* writer that goes straight through `writeChain` + `writeJsonAtomic` + sets `cached`) — NOT `writeUserSettings()`, because that path runs `patchSchema.parse()` + `stripForbiddenKeys()` and would drop a brand-new field.

```ts
/** fs-21 — ISO timestamp stamped when the user finishes (or exits) the
    guided first-run flow. Suppresses the guided re-intro; the hard gate
    itself stays derived from live readiness, so this never grants access.
    Sync read off the in-process cache, like getResolvedGeminiApiKey. */
export function getResolvedSetupCompletedAt(): string | null {
  return cached?.setupCompletedAt ?? null;
}

/** Dedicated writer (mirrors writeUpgradeMeta): bypasses the general
    writeUserSettings schema/strip path so the new field persists, and
    refreshes the sync `cached` the getter reads. */
export async function writeSetupCompletedAt(ts: string | null): Promise<UserSettings> {
  const next = writeChain.then(async () => {
    const current = await readUserSettings();
    const merged: UserSettings = { ...current, setupCompletedAt: ts };
    await writeJsonAtomic(USER_SETTINGS_PATH, merged);
    cached = merged;
    return merged;
  });
  writeChain = next.catch(() => undefined);
  return next;
}
```

> `cached`, `writeChain`, `readUserSettings`, `writeJsonAtomic`, and `USER_SETTINGS_PATH` are all module-private symbols already declared in this file (see `writeUpgradeMeta` at ~line 605). This code lives in the same module, so it reads/writes them directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts -t setupCompletedAt`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/user-settings.ts server/src/workspace/user-settings.test.ts
git commit -m "feat(server): add setupCompletedAt user-setting (fs-21 wave 0)"
```

---

## Task 2: Extract `buildDiagnostics()` from the diagnostics route

**Files:**
- Modify: `server/src/routes/diagnostics.ts`
- Test: `server/src/routes/diagnostics.test.ts` (existing — must stay green)

- [ ] **Step 1: Run the existing diagnostics test to capture green baseline**

Run: `cd server && npx vitest run src/routes/diagnostics.test.ts`
Expected: PASS (baseline before refactor).

- [ ] **Step 2: Extract the handler body into an exported function**

In `server/src/routes/diagnostics.ts`, move the entire async body of `diagnosticsRouter.get('/', ...)` into a new exported function, and have the route delegate. The function returns the same `DiagnosticsResponse` already defined in the file:

```ts
export async function buildDiagnostics(): Promise<DiagnosticsResponse> {
  // ↓ the exact body that was inside the route handler (sidecar probe,
  //   the Promise.all([...]) of runCheck(...) calls, worst(), response).
  const sidecar = await probeSidecarHealth().catch(
    (e: Error) => ({ status: 'unreachable' as const, url: '', proxy: 'sidecar' as const, error: e.message }),
  );
  const engine = getResolvedAnalysisEngine();
  const checks = await Promise.all([ /* …unchanged runCheck(...) calls… */ ]);
  return { ts: new Date().toISOString(), overall: worst(checks), checks };
}

diagnosticsRouter.get('/', async (_req: Request, res: Response) => {
  res.json(await buildDiagnostics());
});
```

This is a pure move — no logic changes. The route now just JSON-returns `buildDiagnostics()`.

- [ ] **Step 3: Run the existing diagnostics test to verify still green**

Run: `cd server && npx vitest run src/routes/diagnostics.test.ts`
Expected: PASS (refactor preserved behaviour).

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/diagnostics.ts
git commit -m "refactor(server): extract buildDiagnostics() for reuse (fs-21 wave 0)"
```

---

## Task 3: Sidecar venv presence probe (server)

**Files:**
- Create: `server/src/diagnostics/venv.ts`
- Test: `server/src/diagnostics/venv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sidecarVenvPresent } from './venv.js';

describe('sidecarVenvPresent', () => {
  it('false when the venv python is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'venv-'));
    expect(sidecarVenvPresent(root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('true when a venv python exists under either layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'venv-'));
    // POSIX layout: .venv/bin/python
    mkdirSync(join(root, 'server', 'tts-sidecar', '.venv', 'bin'), { recursive: true });
    writeFileSync(join(root, 'server', 'tts-sidecar', '.venv', 'bin', 'python'), '');
    expect(sidecarVenvPresent(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/diagnostics/venv.test.ts`
Expected: FAIL — cannot find module `./venv.js`.

- [ ] **Step 3: Implement the probe**

```ts
/* fs-21 — is the TTS sidecar's Python venv bootstrapped? The venv is
   upstream of every TTS engine (start.{sh,ps1} error out without it).
   Checks both the Windows (Scripts\python.exe) and POSIX (bin/python)
   layouts, honouring SIDECAR_VENV_DIR (versioned-install override). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function sidecarVenvPresent(repoRoot: string): boolean {
  const base =
    process.env.SIDECAR_VENV_DIR ?? join(repoRoot, 'server', 'tts-sidecar', '.venv');
  return (
    existsSync(join(base, 'bin', 'python')) ||
    existsSync(join(base, 'Scripts', 'python.exe'))
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/diagnostics/venv.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/diagnostics/venv.ts server/src/diagnostics/venv.test.ts
git commit -m "feat(server): sidecar venv presence probe (fs-21 wave 0)"
```

---

## Task 4: `GET /api/setup/readiness` mapper + route (server)

**Files:**
- Create: `server/src/routes/setup-readiness.ts`
- Test: `server/src/routes/setup-readiness.test.ts`

The readiness shape maps the diagnostics checks (by `id`) plus the venv + TTS-weights probes into four hard-blockers. Mapping rules:
- `sidecar` blocker = diagnostics `sidecar` check is `ok` **AND** `sidecarVenvPresent`.
- `ffmpeg` blocker = diagnostics `ffmpeg` check is `ok`.
- `analyzer` blocker = (engine `local`: diagnostics `analyzer` is `ok`) **OR** (engine `gemini`: diagnostics `gemini` is `ok`) — i.e. the in-use analyzer check is `ok`.
- `tts` blocker = `ttsEnginePresentFn()` (≥1 engine weights on disk) — injected so the test can drive it without real weight dirs.
- `info.gpu` = the diagnostics `gpu` check `detail` (never blocks).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildSetupReadiness } from './setup-readiness.js';
import type { DiagnosticsResponse } from './diagnostics.js';

function diag(over: Partial<Record<string, 'ok' | 'warn' | 'fail'>>): DiagnosticsResponse {
  const def: Record<string, 'ok' | 'warn' | 'fail'> = {
    gpu: 'ok', sidecar: 'ok', asr: 'ok', analyzer: 'ok', gemini: 'ok', ffmpeg: 'ok', disk: 'ok',
  };
  const merged = { ...def, ...over };
  return {
    ts: 'T',
    overall: 'ok',
    checks: Object.entries(merged).map(([id, status]) => ({
      id: id as never, label: id, status, detail: `${id}:${status}`,
    })),
  };
}

describe('buildSetupReadiness', () => {
  it('is ready when all hard-blockers pass', () => {
    const r = buildSetupReadiness({
      diagnostics: diag({}), engine: 'local', venvPresent: true, ttsEnginePresent: true,
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual({ sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' });
  });

  it('fails sidecar when venv is missing even if the sidecar pings', () => {
    const r = buildSetupReadiness({
      diagnostics: diag({}), engine: 'local', venvPresent: false, ttsEnginePresent: true,
    });
    expect(r.blockers.sidecar).toBe('fail');
    expect(r.ready).toBe(false);
  });

  it('fails tts when no engine weights are present', () => {
    const r = buildSetupReadiness({
      diagnostics: diag({}), engine: 'local', venvPresent: true, ttsEnginePresent: false,
    });
    expect(r.blockers.tts).toBe('fail');
    expect(r.ready).toBe(false);
  });

  it('uses the gemini check when engine is gemini', () => {
    const r = buildSetupReadiness({
      diagnostics: diag({ analyzer: 'fail', gemini: 'ok' }),
      engine: 'gemini', venvPresent: true, ttsEnginePresent: true,
    });
    expect(r.blockers.analyzer).toBe('pass');
  });

  it('surfaces gpu detail as info, never a blocker', () => {
    const r = buildSetupReadiness({
      diagnostics: diag({ gpu: 'fail' }), engine: 'local', venvPresent: true, ttsEnginePresent: true,
    });
    expect(r.ready).toBe(true);
    expect(r.info.gpu).toBe('gpu:fail');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/setup-readiness.test.ts`
Expected: FAIL — cannot find module `./setup-readiness.js`.

- [ ] **Step 3: Implement the mapper + route**

```ts
/* fs-21 — GET /api/setup/readiness. A THIN MAPPER over diagnostics.ts (it
   must not re-implement the aggregator), adding the two probes diagnostics
   lacks: venv-on-disk and per-engine TTS weights. Drives the adaptive gate. */
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { buildDiagnostics, type DiagnosticsResponse } from './diagnostics.js';
import { getResolvedAnalysisEngine, getResolvedSetupCompletedAt } from '../workspace/user-settings.js';
import { sidecarVenvPresent } from '../diagnostics/venv.js';
import { anyTtsEnginePresent } from '../tts/engine-presence.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* Repo root computed locally, exactly as models-inventory.ts does (this file
   is also under server/src/routes/, so '..','..','..' lands on the repo root).
   workspace/paths.ts exports WORKSPACE_ROOT, NOT a repo root — don't import. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export type BlockerStatus = 'pass' | 'fail';

export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: { sidecar: BlockerStatus; ffmpeg: BlockerStatus; tts: BlockerStatus; analyzer: BlockerStatus };
  info: { gpu: string };
}

function checkOk(d: DiagnosticsResponse, id: string): boolean {
  return d.checks.find((c) => c.id === id)?.status === 'ok';
}
function detail(d: DiagnosticsResponse, id: string): string {
  return d.checks.find((c) => c.id === id)?.detail ?? '';
}

export function buildSetupReadiness(input: {
  diagnostics: DiagnosticsResponse;
  engine: 'local' | 'gemini';
  venvPresent: boolean;
  ttsEnginePresent: boolean;
  completedAt?: string | null;
}): SetupReadiness {
  const { diagnostics: d, engine, venvPresent, ttsEnginePresent } = input;
  const blockers = {
    sidecar: (checkOk(d, 'sidecar') && venvPresent ? 'pass' : 'fail') as BlockerStatus,
    ffmpeg: (checkOk(d, 'ffmpeg') ? 'pass' : 'fail') as BlockerStatus,
    tts: (ttsEnginePresent ? 'pass' : 'fail') as BlockerStatus,
    analyzer: (checkOk(d, engine === 'gemini' ? 'gemini' : 'analyzer') ? 'pass' : 'fail') as BlockerStatus,
  };
  return {
    ready: Object.values(blockers).every((b) => b === 'pass'),
    completedAt: input.completedAt ?? null,
    blockers,
    info: { gpu: detail(d, 'gpu') },
  };
}

export const setupReadinessRouter = Router();

setupReadinessRouter.get('/readiness', async (_req: Request, res: Response) => {
  const diagnostics = await buildDiagnostics();
  res.json(
    buildSetupReadiness({
      diagnostics,
      engine: getResolvedAnalysisEngine(),
      venvPresent: sidecarVenvPresent(REPO_ROOT),
      ttsEnginePresent: anyTtsEnginePresent(REPO_ROOT),
      completedAt: getResolvedSetupCompletedAt(),
    }),
  );
});
```

- [ ] **Step 4: Create the `anyTtsEnginePresent` helper it depends on**

Create `server/src/tts/engine-presence.ts`, reusing the **same** detectors `models-inventory.ts` imports (do not write new disk logic). Note the exact signatures (verified): `coquiWeightsPresent()` takes no args; `detectQwenInstallStateOnDisk(repoRoot)` **requires `repoRoot`** and returns a **string union** `'not-installed' | 'weights-missing' | 'ready'` (so compare `=== 'ready'`, there is no `.basePresent`); `totalSizeBytes(paths)` returns a `DirSize` with `.fileCount`.

```ts
/* fs-21 — is at least one TTS engine's weights present on disk? Reuses the
   exact detectors the Model Manager inventory uses, so "present" means the
   same thing in both places. */
import { kokoroWeightPaths, totalSizeBytes } from './model-paths.js';
import { coquiWeightsPresent } from './coqui-install-detect.js';
import { detectQwenInstallStateOnDisk } from './qwen-install-detect.js';

export function anyTtsEnginePresent(repoRoot: string): boolean {
  const kokoro = totalSizeBytes(kokoroWeightPaths(repoRoot)).fileCount > 0;
  const coqui = coquiWeightsPresent();
  const qwen = detectQwenInstallStateOnDisk(repoRoot) === 'ready';
  return kokoro || coqui || qwen;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/setup-readiness.test.ts`
Expected: PASS (all five cases).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/setup-readiness.ts server/src/routes/setup-readiness.test.ts server/src/tts/engine-presence.ts
git commit -m "feat(server): GET /api/setup/readiness mapper over diagnostics (fs-21 wave 0)"
```

---

## Task 5: Register the readiness router (+ integration route test in the slow pool)

**Files:**
- Modify: `server/src/index.ts`, `server/vitest.config.slow.ts`
- Create: `server/src/routes/setup-readiness.route.test.ts` (integration, slow pool)

- [ ] **Step 1: Write the failing route test in its OWN file (it triggers a live sidecar probe)**

The route handler calls `buildDiagnostics()`, which runs `probeSidecarHealth()` — a real network probe with a timeout. That makes this an integration test that can be slow/flaky in the parallel fast pool, so it lives in a **separate file routed to `test:server-slow`** (the same treatment the analyzer/diagnostics route tests get). The pure mapper logic is already covered by `setup-readiness.test.ts` (Task 4) in the fast pool.

Create `server/src/routes/setup-readiness.route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { setupReadinessRouter } from './setup-readiness.js';

describe('GET /api/setup/readiness route (integration — live probe)', () => {
  it('returns 200 with the readiness shape even when the sidecar is down', async () => {
    const app = express();
    app.use('/api/setup', setupReadinessRouter);
    const res = await request(app).get('/api/setup/readiness');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ready');
    expect(res.body).toHaveProperty('blockers.sidecar');
    expect(res.body).toHaveProperty('info.gpu');
  });
});
```

- [ ] **Step 2: Pin the new file to the slow pool**

In `server/vitest.config.slow.ts`, add `'src/routes/setup-readiness.route.test.ts'` to the `include` list (the same array that already pins the analyzer/gemini + routes tests). Confirm the fast `server/vitest.config.ts` **excludes** it (the slow files are excluded from the fast run via the existing exclude/route mechanism — match how `diagnostics`-class tests are kept out of the fast pool).

- [ ] **Step 3: Run the slow test to verify it passes after registration**

Run: `cd server && npx vitest run --config vitest.config.slow.ts src/routes/setup-readiness.route.test.ts`
Expected: PASS (200 + shape; the sidecar being unreachable just yields `fail` blockers, never a 500).

- [ ] **Step 4: Register the router in `server/src/index.ts`**

Mirror the diagnostics registration (`import { diagnosticsRouter } from './routes/diagnostics.js';` + `app.use('/api/diagnostics', diagnosticsRouter);`). Add:

```ts
import { setupReadinessRouter } from './routes/setup-readiness.js';
```

and alongside the other `app.use('/api/...')` lines:

```ts
app.use('/api/setup', setupReadinessRouter); // fs-21 — first-run readiness probe
```

- [ ] **Step 5: Run the slow route test + typecheck**

Run: `cd server && npx vitest run --config vitest.config.slow.ts src/routes/setup-readiness.route.test.ts && npm run typecheck`
Expected: PASS + clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add server/src/index.ts server/src/routes/setup-readiness.route.test.ts server/vitest.config.slow.ts
git commit -m "feat(server): register /api/setup readiness router (fs-21 wave 0)"
```

---

## Task 6: `setup` stage variant + router + reducer (frontend)

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/router.ts`, `src/store/ui-slice.ts`
- Test: `src/lib/router.test.ts`, `src/store/ui-slice.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/router.test.ts`:

```ts
it('maps the setup stage to #/setup', () => {
  expect(stageToHash({ kind: 'setup' })).toBe('#/setup');
});
```

In `src/store/ui-slice.test.ts`:

```ts
it('openSetup sets the setup stage', () => {
  const s = uiSlice.reducer(undefined, uiActions.openSetup());
  expect(s.stage).toEqual({ kind: 'setup' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/router.test.ts src/store/ui-slice.test.ts -t setup`
Expected: FAIL — `'setup'` not assignable to `Stage`; `openSetup` undefined.

- [ ] **Step 3: Add the variant, hash case, and reducer**

In `src/lib/types.ts`, add to the `Stage` union (next to `model-manager`):

```ts
  | { kind: 'setup' }
```

In `src/lib/router.ts` `stageToHash`, add before `analysing`:

```ts
    case 'setup':
      return '#/setup';
```

In `src/store/ui-slice.ts`, add a reducer next to `openModelManager`:

```ts
    /* fs-21 — first-run setup wizard, reached on the boot gate or from Account. */
    openSetup: (s) => {
      s.stage = { kind: 'setup' };
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/router.test.ts src/store/ui-slice.test.ts -t setup`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/router.ts src/store/ui-slice.ts src/lib/router.test.ts src/store/ui-slice.test.ts
git commit -m "feat(frontend): add setup stage variant + #/setup + openSetup (fs-21 wave 0)"
```

---

## Task 7: API client — `getSetupReadiness` with dual-state mock

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api.test.ts` (add cases; create if absent)

The mock must drive BOTH ready and not-ready so dev + e2e can exercise the gate. It latches the state into `sessionStorage` from a `?setup=notready` URL param, so the state **survives the redirect to `#/setup`** (where the param is gone). Test the **exported `mockGetSetupReadiness` directly** — do NOT go through `api.*`, because the api module locks `USE_MOCKS` at import time (`import.meta.env` can't be re-toggled after import).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mockGetSetupReadiness } from './api';

describe('mockGetSetupReadiness', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.location.hash = '#/';
  });

  it('returns ready by default', async () => {
    const r = await mockGetSetupReadiness();
    expect(r.ready).toBe(true);
  });

  it('latches not-ready from the setup=notready param and persists it across nav', async () => {
    window.location.hash = '#/?setup=notready';
    const first = await mockGetSetupReadiness();
    expect(first.ready).toBe(false);
    expect(first.blockers.tts).toBe('fail');
    // param gone after a redirect — the latch keeps it not-ready
    window.location.hash = '#/setup';
    const second = await mockGetSetupReadiness();
    expect(second.ready).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/api.test.ts -t SetupReadiness`
Expected: FAIL — `api.getSetupReadiness is not a function`.

- [ ] **Step 3: Implement the interface + real + mock + wire-up**

In `src/lib/api.ts`, near the `DiagnosticsResponse` block (~line 5127), add:

```ts
/* fs-21 — first-run readiness. Mirrors SetupReadiness in
   server/src/routes/setup-readiness.ts. */
export type BlockerStatus = 'pass' | 'fail';
export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: { sidecar: BlockerStatus; ffmpeg: BlockerStatus; tts: BlockerStatus; analyzer: BlockerStatus };
  info: { gpu: string };
}

async function realGetSetupReadiness(): Promise<SetupReadiness> {
  const res = await fetch('/api/setup/readiness');
  if (!res.ok) throw new Error(`readiness ${res.status}`);
  return (await res.json()) as SetupReadiness;
}

/* Exported so unit tests can drive it directly (the `api.*` indirection locks
   USE_MOCKS at import). Latches not-ready into sessionStorage from the
   ?setup=notready param so the state survives the redirect to #/setup, where
   the query param is gone. */
export async function mockGetSetupReadiness(): Promise<SetupReadiness> {
  if (window.location.hash.includes('setup=notready')) {
    sessionStorage.setItem('mock-setup-readiness', 'notready');
  }
  const notReady = sessionStorage.getItem('mock-setup-readiness') === 'notready';
  return notReady
    ? {
        ready: false,
        completedAt: null,
        blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'fail', analyzer: 'fail' },
        info: { gpu: 'CPU — no GPU detected' },
      }
    : {
        ready: true,
        completedAt: '2026-06-12T00:00:00.000Z',
        blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
        info: { gpu: 'cuda · 1.2 / 8.0 GB reserved' },
      };
}
```

Then wire into BOTH maps in the `api` object — next to `getDiagnostics: realGetDiagnostics,` (~line 5874) add `getSetupReadiness: realGetSetupReadiness,`; next to `getDiagnostics: mockGetDiagnostics,` (~line 6121) add `getSetupReadiness: mockGetSetupReadiness,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/api.test.ts -t SetupReadiness`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): api.getSetupReadiness with dual-state mock (fs-21 wave 0)"
```

---

## Task 8: `SetupView` stub + `SetupRoute` (frontend)

**Files:**
- Create: `src/views/setup.tsx`, `src/views/setup.test.tsx`
- Modify: `src/routes/index.tsx`

- [ ] **Step 1: Write the failing test**

`src/views/setup.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SetupView } from './setup';

describe('SetupView (wave 0 stub)', () => {
  it('renders the setup heading and the blocker rows from props', () => {
    render(
      <SetupView
        readiness={{
          ready: false,
          completedAt: null,
          blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'fail', analyzer: 'fail' },
          info: { gpu: 'CPU — no GPU detected' },
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: /set up castwright/i })).toBeInTheDocument();
    expect(screen.getByText(/tts/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/setup.test.tsx`
Expected: FAIL — cannot find module `./setup`.

- [ ] **Step 3: Implement the stub view**

```tsx
/* fs-21 Wave 0 — SetupView STUB. Renders the readiness summary so the gated
   #/setup route is real and testable. Wave 2 replaces this body with the
   five-step guided/checklist wizard; the props contract (readiness) stays. */
import type { SetupReadiness } from '../lib/api';

export function SetupView({ readiness }: { readiness: SetupReadiness | null }) {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-ink">Set up Castwright</h1>
      <p className="mt-2 text-ink/60 text-sm">
        We’re checking that everything needed to produce an audiobook is in place.
      </p>
      <ul className="mt-6 space-y-2">
        {readiness &&
          Object.entries(readiness.blockers).map(([id, status]) => (
            <li
              key={id}
              className="flex items-center justify-between rounded-2xl border border-ink/10 bg-canvas px-4 py-3"
            >
              <span className="text-sm font-medium text-ink uppercase">{id}</span>
              <span className={status === 'pass' ? 'text-emerald-600' : 'text-amber-600'}>
                {status === 'pass' ? 'Ready' : 'Needs attention'}
              </span>
            </li>
          ))}
      </ul>
    </main>
  );
}
```

> No design-token hex literals: `text-ink`, `bg-canvas` are existing tokens. `emerald/amber` are placeholder status colours for the stub — Wave 2 swaps them for the brand status tokens.

- [ ] **Step 4: Add `SetupRoute` + route entry in `src/routes/index.tsx`**

Add a lazy import next to `ModelManagerView`:

```tsx
const SetupView = lazy(() => import('../views/setup').then((m) => ({ default: m.SetupView })));
```

Add the route component next to `ModelManagerRoute`:

```tsx
/* fs-21 — first-run setup wizard. Fetches readiness on mount; Wave 2 fleshes
   the steps. */
function SetupRoute() {
  useHydrateStage({ kind: 'setup' }, []);
  const [readiness, setReadiness] = useState<Awaited<ReturnType<typeof api.getSetupReadiness>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getSetupReadiness().then((r) => { if (!cancelled) setReadiness(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return <SetupView readiness={readiness} />;
}
```

Add to the `children` array (next to the `models` entry):

```tsx
      { path: 'setup', element: <SetupRoute /> },
```

- [ ] **Step 5: Run the view test to verify it passes**

Run: `npx vitest run src/views/setup.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/setup.tsx src/views/setup.test.tsx src/routes/index.tsx
git commit -m "feat(frontend): setup stub view + #/setup route (fs-21 wave 0)"
```

---

## Task 9: Boot-splash gate in Layout

**Files:**
- Modify: `src/components/layout.tsx`
- Test: `e2e/setup-gate.spec.ts` (Task 10 covers the e2e; this task's verification is the typecheck + a manual mock check)

The gate: on mount, fetch readiness once. While the fetch is pending show a splash (block content). When it resolves, if `!ready` navigate to `#/setup` (a no-op if already there); if `ready`, render normally. Never re-fetch on every navigation — one boot check (plus Wave 2's focus re-check, out of scope here).

- [ ] **Step 1: Add the gate state + effect**

In `src/components/layout.tsx`, add this state + effect **with the other top-level hooks** (the component already calls `useNavigate()` — reuse that `navigate`; place this next to the `fetchAccountSettings` boot effect ~line 453, NOT after any early return):

```tsx
const [setupReady, setSetupReady] = useState<boolean | null>(null); // null = checking
useEffect(() => {
  let cancelled = false;
  api
    .getSetupReadiness()
    .then((r) => {
      if (cancelled) return;
      setSetupReady(r.ready);
      // Redirecting to /setup when already there is a harmless no-op, so we
      // don't need to read the current stage (Layout does NOT import `store`).
      if (!r.ready) navigate('/setup');
    })
    .catch(() => { if (!cancelled) setSetupReady(true); }); // probe failure must not lock the app out
  return () => { cancelled = true; };
}, []); // eslint-disable-line react-hooks/exhaustive-deps
```

> Layout already imports `api` (line 33) and `useNavigate` (line 2) and `useState`/`useEffect` (line 1) — no new imports needed, and **do NOT import `store`** (Layout doesn't, and we no longer need it). On probe failure we fail OPEN (`setSetupReady(true)`) so a transient readiness error never bricks the app.

- [ ] **Step 2: Render the splash while checking**

Where Layout returns its tree, gate the first paint:

```tsx
if (setupReady === null) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <p className="text-ink/60 text-sm">Checking your setup…</p>
    </div>
  );
}
```

> **Rules-of-hooks:** place this early return **immediately before the component's final top-level `return (`**, after EVERY hook call in the component (Layout has ~20 hooks — `useTheme`, `useTtsLifecycle`, the many `useEffect`/`useState`, etc.). An early return placed above any hook will throw "rendered fewer hooks than expected." It only blocks the very first paint until the one-shot readiness fetch resolves; subsequent navigations don't re-trigger it (the effect has `[]` deps).

- [ ] **Step 3: Typecheck + frontend unit suite**

Run: `npm run typecheck && npm run test`
Expected: PASS (no type errors). Existing Layout tests now mount the readiness fetch on render: in unit tests `api` resolves to the mock (which returns `ready: true`) or, if it hits the real `fetch` and rejects in jsdom, the `.catch` fails OPEN (`setSetupReady(true)`) — either way the splash resolves. If a Layout test emits an `act(...)` warning from the post-mount state update, wrap its render/assertions in `await waitFor(...)` (or assert the resolved tree) rather than disabling the gate.

- [ ] **Step 4: Manual mock check**

Run: `npm run dev`, open `http://localhost:5173/#/?setup=notready` → expect redirect to `#/setup` showing the stub with TTS/analyzer "Needs attention". Open `http://localhost:5173/#/` → expect the normal library (gate open).

- [ ] **Step 5: Commit**

```bash
git add src/components/layout.tsx
git commit -m "feat(frontend): boot-splash readiness gate -> #/setup (fs-21 wave 0)"
```

---

## Task 10: E2E — the gate fires when not-ready

**Files:**
- Create: `e2e/setup-gate.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';

test('boot gate redirects to #/setup when not ready', async ({ page }) => {
  await page.goto('/#/?setup=notready');
  await expect(page).toHaveURL(/#\/setup/);
  await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();
});

test('boot gate stays out of the way when ready', async ({ page }) => {
  await page.goto('/#/');
  await expect(page).not.toHaveURL(/#\/setup/);
});
```

> Mock mode is the e2e default (port 5174). `?setup=notready` drives `mockGetSetupReadiness` to the not-ready branch (Task 7). No server needed. Each Playwright test runs in a fresh browser context, so the `sessionStorage` latch from the not-ready test does not leak into the ready test.

- [ ] **Step 2: Run the spec to verify it passes**

Run: `npm run test:e2e -- setup-gate`
Expected: PASS (both tests). If chromium isn't installed: `npx playwright install chromium` first.

- [ ] **Step 3: Add the view to responsive coverage**

Append a case for the `setup` stage to `e2e/responsive/coverage.spec.ts` following the existing per-view pattern in that file (navigate to `/#/?setup=notready`, assert the heading is visible at each project viewport).

- [ ] **Step 4: Commit**

```bash
git add e2e/setup-gate.spec.ts e2e/responsive/coverage.spec.ts
git commit -m "test(e2e): setup boot-gate happy + not-ready paths (fs-21 wave 0)"
```

---

## Task 11: Full verify + draft PR

- [ ] **Step 1: Run the full pre-push battery**

Run: `npm run verify`
Expected: typecheck + all unit + e2e + build all green. Fix any red before proceeding (triage related-vs-pre-existing per CONTRIBUTING).

- [ ] **Step 2: Open as a draft PR**

```bash
git push -u origin feat/fs21-wave0-readiness-spine
gh pr create --draft --title "feat(server,frontend): fs-21 wave 0 — readiness spine + setup gate" --body "Wave 0 of fs-21 (first-run wizard). Derived adaptive gate: GET /api/setup/readiness (thin mapper over diagnostics.ts) + { kind: 'setup' } stage at #/setup + boot splash redirect + setupCompletedAt. SetupView is a stub (Wave 2 fleshes the 5-step UI). Refs #474. Plan: docs/superpowers/plans/2026-06-12-fs21-wave0-readiness-spine.md"
```

- [ ] **Step 3: Promote to ready once green (bills exactly one CI run)**

```bash
gh pr ready
```

---

## Self-Review (completed by plan author)

**Spec coverage (Wave 0 scope only):**
- `{ kind: 'setup' }` stage + `#/setup` route → Task 6, 8 ✓
- Derived gate / boot splash / redirect on not-ready → Task 9 ✓
- `GET /api/setup/readiness` as a thin mapper over `diagnostics.ts` (not a re-impl) → Task 2 (extract) + Task 4 (map) ✓
- Hard-blocker definitions (sidecar+venv, ffmpeg, ≥1 TTS engine, analyzer-per-engine; GPU info-only) → Task 4 mapping + tests ✓
- `setupCompletedAt` persisted, hard gate stays derived → Task 1 + Task 4 (completedAt is surfaced, NOT used to open the gate) ✓
- Mockable to BOTH ready and not-ready for dev + e2e → Task 7 (`?setup=notready`) ✓
- Headless/Docker "works for free" → same derived gate fires on first UI open; no Wave-0-specific code needed (covered by Task 9's boot fetch) ✓
- **Deferred to later waves (correctly out of Wave 0):** the 5-step UI bodies + install rows (Wave 2), Kokoro install route + venv bootstrap + parity audit (Wave 1), two-tier smoke test (Wave 3), Account "Re-run setup" entry (Wave 2), docs/closure (Wave 4).

**Placeholder scan:** No TBD/TODO; every code step shows the code; every run step shows the command + expected result. All previously-hedged symbols are now pinned against the real source (subagent-execution review, 2026-06-12): the settings getter reads the module-level `cached` + a `writeUpgradeMeta`-style dedicated writer (Task 1); `REPO_ROOT` is computed locally, not imported (Task 4); `detectQwenInstallStateOnDisk(repoRoot) === 'ready'` and `coquiWeightsPresent()` no-arg (Task 4); the Layout gate uses `navigate` only (no `store` import) with an explicit rules-of-hooks placement (Task 9); the mock latches not-ready into `sessionStorage` to survive the redirect and is tested via the exported `mockGetSetupReadiness` (Task 7); the live-probe route test is isolated to the slow pool (Task 5).

**Type consistency:** `SetupReadiness` / `BlockerStatus` are defined identically server-side (Task 4) and client-side (Task 7). `buildSetupReadiness` input keys (`diagnostics`, `engine`, `venvPresent`, `ttsEnginePresent`, `completedAt`) match between its definition (Task 4 Step 3) and its callers (Task 4 route + Task 4 tests). `getSetupReadiness` is the api method name in Tasks 7, 8, 9. `openSetup` / `{ kind: 'setup' }` consistent across Tasks 6, 8, 9.
