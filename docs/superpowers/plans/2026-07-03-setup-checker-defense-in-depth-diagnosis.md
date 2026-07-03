# Setup Checker Defense-in-Depth Diagnosis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Setup checker's and Status popover's flat `pass`/`fail` blocker booleans with a structured, layered `BlockerDiagnosis` (cause + message + remediation + optional fix action), so a failure like an empty sidecar venv gets a real, working fix pathway instead of "not ready."

**Architecture:** A new pure module `server/src/routes/setup-diagnosis.ts` exports one decision function per blocker (`diagnoseSidecar`/`diagnoseTts`/`diagnoseFfmpeg`/`diagnoseAnalyzer`), each taking already-probed plain inputs and returning a `BlockerDiagnosis` — mirroring the existing `buildSetupReadiness`'s pure, mock-free testing style. The `GET /api/setup/readiness` route handler does all the actual probing once (reusing existing probes) and threads results through these pure functions. The frontend gains one shared `useSetupDiagnosis()` hook and one `<BlockerFixAction>` component that both the Setup wizard and the Status popover consume, so there is one diagnosis engine, not two.

**Tech Stack:** TypeScript, Express (server), React + Vitest + Testing Library (frontend), Playwright (e2e).

## Global Constraints

- Every new/changed cause is a member of the `BlockerCause` string-literal union defined in Task 1 — never a bare `string`.
- Every `BlockerDiagnosis`-returning function is **pure** — no `fetch`, no `fs` access, no `spawnSync` inside `setup-diagnosis.ts`'s `diagnose*` functions themselves. All I/O happens once in the route handler (`setup-readiness.ts`) and is passed in as plain data. This preserves the existing `setup-readiness.test.ts` no-mock testing style.
- `diagnoseSidecar()` must be called before `diagnoseTts()`, and its result passed in — the tts chain is not independently computable (spec Design §1).
- The `findPython312()` probe is only ever invoked when `!sidecarVenvPresent()`, and is TTL-cached (10s) via `setup-diagnosis.ts`'s own cache, not re-probed on every poll tick.
- `resetAndRespawn()`'s state-clearing statements must run before its first `await` — this is what makes concurrent calls safe (spec Design §2); do not reorder.
- `ModelControlPill.tsx`'s existing props/state machine are unchanged except for one new optional `suppressUnreachableAction?: boolean` prop (default `false`).
- Every migrated test file's `blockers` fixture moves from `{sidecar: 'pass', ...}` to `{sidecar: {status: 'pass', cause: 'pass', message: '...', remediation: ''}, ...}` — never left as a bare string.

---

## Task 1: `BlockerDiagnosis` data model + `venvCorePackageInstalled` probe

**Files:**
- Create: `server/src/tts/venv-core-package.ts`
- Test: `server/src/tts/venv-core-package.test.ts`
- Modify: `server/src/routes/setup-readiness.ts` (add types only — no behavior change yet)

**Interfaces:**
- Produces: `BlockerCause` (string-literal union, all causes across all 4 blockers), `BlockerActionKind`, `BlockerAction`, `BlockerDiagnosis`, exported from `server/src/routes/setup-readiness.ts` (frontend's `src/lib/api.ts` mirrors these in Task 8). `venvCorePackageInstalled(repoRoot: string): boolean` from the new file.

- [ ] **Step 1: Write the failing test for `venvCorePackageInstalled`**

```ts
// server/src/tts/venv-core-package.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { venvCorePackageInstalled } from './venv-core-package.js';

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function makeRepoRoot(): string {
  tmp = mkdtempSync(join(tmpdir(), 'venv-core-pkg-'));
  return tmp;
}

describe('venvCorePackageInstalled', () => {
  it('returns false when the venv does not exist at all', () => {
    const repoRoot = makeRepoRoot();
    expect(venvCorePackageInstalled(repoRoot)).toBe(false);
  });

  it('returns false when the venv exists but fastapi is not in site-packages', () => {
    const repoRoot = makeRepoRoot();
    mkdirSync(join(repoRoot, 'server', 'tts-sidecar', '.venv', 'Lib', 'site-packages'), {
      recursive: true,
    });
    expect(venvCorePackageInstalled(repoRoot)).toBe(false);
  });

  it('returns true when fastapi is present under Windows-layout site-packages', () => {
    const repoRoot = makeRepoRoot();
    mkdirSync(
      join(repoRoot, 'server', 'tts-sidecar', '.venv', 'Lib', 'site-packages', 'fastapi'),
      { recursive: true },
    );
    expect(venvCorePackageInstalled(repoRoot)).toBe(true);
  });

  it('returns true when fastapi is present under posix-layout site-packages', () => {
    const repoRoot = makeRepoRoot();
    mkdirSync(
      join(
        repoRoot, 'server', 'tts-sidecar', '.venv', 'lib', 'python3.12', 'site-packages', 'fastapi',
      ),
      { recursive: true },
    );
    expect(venvCorePackageInstalled(repoRoot)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/venv-core-package.test.ts`
Expected: FAIL — `Cannot find module './venv-core-package.js'`

- [ ] **Step 3: Write `venvCorePackageInstalled`**

```ts
// server/src/tts/venv-core-package.ts
/* fs-21 wave 4 — is the venv's package set actually complete, not just the
   interpreter present? A pip install interrupted after `python -m venv`
   succeeds leaves python.exe present but packages incomplete —
   sidecarVenvPresent() alone can't see that. Checks for fastapi: every
   accelerator profile (nvidia-cuda/cpu/amd-rocm) depends on it transitively
   via base.txt, since it's what main.py's server needs to start at all.
   Mirrors the exact existsSync-based pattern qwen-install-detect.ts's
   qwenPackageInstalled already uses. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function venvCorePackageInstalled(repoRoot: string): boolean {
  const venv = join(repoRoot, 'server', 'tts-sidecar', '.venv');
  const candidates = [join(venv, 'Lib', 'site-packages', 'fastapi')];
  const libDir = join(venv, 'lib');
  try {
    if (existsSync(libDir)) {
      for (const py of readdirSync(libDir)) {
        candidates.push(join(libDir, py, 'site-packages', 'fastapi'));
      }
    }
  } catch {
    /* no posix lib dir — Windows-only layout */
  }
  return candidates.some((p) => existsSync(p));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/venv-core-package.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the `BlockerDiagnosis` data model to `setup-readiness.ts`**

Open `server/src/routes/setup-readiness.ts`. Replace the `export type BlockerStatus = 'pass' | 'fail';` line and the `SetupReadiness` interface with:

```ts
export type BlockerCause =
  // sidecar
  | 'python-missing' | 'venv-missing' | 'venv-broken' | 'supervisor-exhausted'
  | 'supervisor-tripped' | 'unreachable-transient' | 'unreachable-no-supervisor'
  // tts
  | 'sidecar-blocked' | 'no-engine-installed' | 'weights-missing'
  | 'cannot-confirm-engine' | 'package-broken'
  // ffmpeg
  | 'ffmpeg-missing' | 'ffprobe-missing' | 'both-missing'
  // analyzer
  | 'ollama-unreachable' | 'model-not-pulled' | 'no-gemini-key'
  // shared terminal
  | 'pass';

export type BlockerActionKind =
  | 'venv-bootstrap' | 'qwen-install' | 'kokoro-install' | 'coqui-install'
  | 'sidecar-restart' | 'ollama-install' | 'ollama-pull' | 'navigate';

export interface BlockerAction {
  kind: BlockerActionKind;
  label: string;
  /** Extra data an action needs beyond its kind, e.g. { model: 'qwen3.5:9b' } for ollama-pull. */
  params?: Record<string, string>;
  /** For 'navigate' only — an in-app hash route (e.g. '#/models'). */
  href?: string;
}

export interface BlockerDiagnosis {
  status: 'pass' | 'fail';
  cause: BlockerCause;
  message: string;
  remediation: string;
  /** Present when a safe automated fix exists; absent for text-only guidance. */
  action?: BlockerAction;
}

export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: { sidecar: BlockerDiagnosis; ffmpeg: BlockerDiagnosis; tts: BlockerDiagnosis; analyzer: BlockerDiagnosis };
  info: { gpu: string };
}
```

Leave the rest of the file (the `checkOk`/`detail` helpers, `buildSetupReadiness`, the router) untouched for now — Task 7 rewires them.

- [ ] **Step 6: Run typecheck to confirm the type-only change compiles**

Run: `npm run typecheck`
Expected: FAIL — `buildSetupReadiness` and its callers still reference the old `BlockerStatus`/boolean shape. This is expected; Task 7 fixes it. Confirm the errors are ONLY in `setup-readiness.ts`, `setup-readiness.test.ts`, and frontend files that read `.blockers.X === 'pass'` (this is the migration surface Tasks 7–16 will each independently fix; don't fix them here).

- [ ] **Step 7: Commit**

```bash
git add server/src/tts/venv-core-package.ts server/src/tts/venv-core-package.test.ts server/src/routes/setup-readiness.ts
git commit -m "feat(server): add BlockerDiagnosis data model and venv core-package probe"
```

---

## Task 2: `diagnoseSidecar()` — sidecar cause chain

**Files:**
- Create: `server/src/routes/setup-diagnosis.ts`
- Test: `server/src/routes/setup-diagnosis.test.ts`

**Interfaces:**
- Consumes: `BlockerDiagnosis`, `BlockerCause` from Task 1 (`server/src/routes/setup-readiness.ts`).
- Produces: `SidecarDiagnosisInput` (interface), `diagnoseSidecar(input: SidecarDiagnosisInput): BlockerDiagnosis`, `probePython312Cached(nowFn?: () => number): boolean` (returns true if a 3.12 interpreter is found; TTL-cached), `_resetPythonProbeCacheForTests(): void` — all consumed by Task 3 (`diagnoseTts`) and Task 7 (route wiring).

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/routes/setup-diagnosis.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { diagnoseSidecar, probePython312Cached, _resetPythonProbeCacheForTests } from './setup-diagnosis.js';
import type { SidecarDiagnosisInput } from './setup-diagnosis.js';

const READY: SidecarDiagnosisInput = {
  venvPresent: true,
  pythonFound: true,
  corePackageInstalled: true,
  supervisorActive: true,
  supervisorTripped: false,
  supervisorExhausted: false,
  sidecarReachable: true,
};

describe('diagnoseSidecar', () => {
  it('passes when everything is healthy', () => {
    expect(diagnoseSidecar(READY)).toMatchObject({ status: 'pass', cause: 'pass' });
  });

  it('reports python-missing when the venv is absent and no 3.12 interpreter is found', () => {
    const r = diagnoseSidecar({ ...READY, venvPresent: false, pythonFound: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'python-missing' });
    expect(r.action).toBeUndefined();
  });

  it('reports venv-missing (not python-missing) when the venv is absent but python is found', () => {
    const r = diagnoseSidecar({ ...READY, venvPresent: false, pythonFound: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'venv-missing' });
    expect(r.action).toMatchObject({ kind: 'venv-bootstrap' });
  });

  it('reports venv-broken when the venv exists but the core package is not installed', () => {
    const r = diagnoseSidecar({ ...READY, venvPresent: true, corePackageInstalled: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'venv-broken' });
    expect(r.action).toMatchObject({ kind: 'venv-bootstrap' });
  });

  it('venv-missing/python-missing take priority over venv-broken and supervisor state (first-match-wins)', () => {
    const r = diagnoseSidecar({
      ...READY,
      venvPresent: false,
      pythonFound: false,
      corePackageInstalled: false,
      supervisorExhausted: true,
    });
    expect(r.cause).toBe('python-missing');
  });

  it('reports supervisor-exhausted with a sidecar-restart action', () => {
    const r = diagnoseSidecar({ ...READY, supervisorExhausted: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'supervisor-exhausted' });
    expect(r.action).toMatchObject({ kind: 'sidecar-restart' });
  });

  it('reports supervisor-tripped with a sidecar-restart action', () => {
    const r = diagnoseSidecar({ ...READY, supervisorTripped: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'supervisor-tripped' });
    expect(r.action).toMatchObject({ kind: 'sidecar-restart' });
  });

  it('supervisor-exhausted takes priority over supervisor-tripped when both are somehow true', () => {
    const r = diagnoseSidecar({ ...READY, supervisorExhausted: true, supervisorTripped: true });
    expect(r.cause).toBe('supervisor-exhausted');
  });

  it('reports unreachable-transient when a supervisor is active but not yet reachable', () => {
    const r = diagnoseSidecar({ ...READY, sidecarReachable: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'unreachable-transient' });
    expect(r.action).toBeUndefined();
  });

  it('reports unreachable-no-supervisor with a navigate action when autoStart is off', () => {
    const r = diagnoseSidecar({ ...READY, supervisorActive: false, sidecarReachable: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'unreachable-no-supervisor' });
    expect(r.action).toMatchObject({ kind: 'navigate', href: '#/models' });
  });
});

describe('probePython312Cached', () => {
  afterEach(() => {
    _resetPythonProbeCacheForTests();
    vi.restoreAllMocks();
  });

  it('caches the result across calls within the TTL window', async () => {
    const findPython312 = await import('../tts/python-discovery.js');
    const spy = vi.spyOn(findPython312, 'findPython312').mockReturnValue({ cmd: 'py', args: ['-3.12'] });
    let now = 0;
    expect(probePython312Cached(() => now)).toBe(true);
    now += 1_000;
    expect(probePython312Cached(() => now)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-probes after the TTL expires', async () => {
    const findPython312 = await import('../tts/python-discovery.js');
    const spy = vi.spyOn(findPython312, 'findPython312').mockReturnValue(null);
    let now = 0;
    probePython312Cached(() => now);
    now += 10_001;
    probePython312Cached(() => now);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/setup-diagnosis.test.ts`
Expected: FAIL — `Cannot find module './setup-diagnosis.js'`

- [ ] **Step 3: Write `setup-diagnosis.ts` (sidecar portion only)**

```ts
// server/src/routes/setup-diagnosis.ts
/* fs-21 wave 4 — pure decision functions for the Setup checker / Status
   popover's layered blocker diagnosis. Mirrors buildSetupReadiness's own
   pure, mock-free style (setup-readiness.test.ts): every diagnose* function
   here takes already-probed plain data and returns a BlockerDiagnosis — all
   I/O (fs, spawnSync, network) happens once in the setup-readiness.ts route
   handler and is threaded in. diagnoseSidecar() must run before
   diagnoseTts(), whose result it feeds (spec Design §1). */
import { findPython312 } from '../tts/python-discovery.js';
import type { BlockerDiagnosis, BlockerCause } from './setup-readiness.js';

const PYTHON_PROBE_TTL_MS = 10_000;
let pythonProbeCache: { found: boolean; expiresAt: number } | null = null;

/** True if a Python 3.12 interpreter is found — TTL-cached (10s) so a
    stuck-venv incident's repeated polls don't repeatedly spawn interpreter
    probes. Only call this when `!sidecarVenvPresent()` — a healthy system
    should never pay this subprocess cost. */
export function probePython312Cached(nowFn: () => number = Date.now): boolean {
  const now = nowFn();
  if (pythonProbeCache && pythonProbeCache.expiresAt > now) return pythonProbeCache.found;
  const found = findPython312() !== null;
  pythonProbeCache = { found, expiresAt: now + PYTHON_PROBE_TTL_MS };
  return found;
}

export function _resetPythonProbeCacheForTests(): void {
  pythonProbeCache = null;
}

export interface SidecarDiagnosisInput {
  venvPresent: boolean;
  /** Only meaningful when !venvPresent — pass probePython312Cached()'s result. */
  pythonFound: boolean;
  corePackageInstalled: boolean;
  /** getActiveSupervisor() !== null */
  supervisorActive: boolean;
  supervisorTripped: boolean;
  supervisorExhausted: boolean;
  /** The existing diagnostics 'sidecar' check reporting reachable. */
  sidecarReachable: boolean;
}

function diagnosis(
  status: 'pass' | 'fail',
  cause: BlockerCause,
  message: string,
  remediation: string,
  action?: BlockerDiagnosis['action'],
): BlockerDiagnosis {
  return { status, cause, message, remediation, action };
}

export function diagnoseSidecar(input: SidecarDiagnosisInput): BlockerDiagnosis {
  if (!input.venvPresent) {
    if (!input.pythonFound) {
      return diagnosis(
        'fail',
        'python-missing',
        'No Python 3.12 interpreter was found — the voice engine runtime cannot be built.',
        'Run node server/tts-sidecar/scripts/ensure-python312.mjs, or install Python 3.12 from python.org.',
      );
    }
    return diagnosis(
      'fail',
      'venv-missing',
      'Voice engine runtime not set up.',
      'Set up the voice engine runtime — this is a one-time, ~2 GB download.',
      { kind: 'venv-bootstrap', label: 'Set up the voice engine runtime' },
    );
  }
  if (!input.corePackageInstalled) {
    return diagnosis(
      'fail',
      'venv-broken',
      'The voice engine runtime looks incomplete — a previous setup may have been interrupted.',
      'Re-run the voice engine runtime setup. If it reports the runtime was built for a different profile, delete server/tts-sidecar/.venv and re-run setup.',
      { kind: 'venv-bootstrap', label: 'Rebuild the voice engine runtime' },
    );
  }
  if (input.supervisorExhausted) {
    return diagnosis(
      'fail',
      'supervisor-exhausted',
      'The voice engine crashed repeatedly and stopped trying to restart.',
      'Reset and restart the voice engine.',
      { kind: 'sidecar-restart', label: 'Reset & restart voice engine' },
    );
  }
  if (input.supervisorTripped) {
    return diagnosis(
      'fail',
      'supervisor-tripped',
      'The voice engine is held down after repeated crash-loop exits.',
      'Reset and restart the voice engine.',
      { kind: 'sidecar-restart', label: 'Reset & restart voice engine' },
    );
  }
  if (!input.sidecarReachable) {
    if (!input.supervisorActive) {
      return diagnosis(
        'fail',
        'unreachable-no-supervisor',
        'The voice engine is not running, and auto-start is off, so nothing will start it.',
        'Enable auto-start for the voice engine in Model Manager, or start it manually.',
        { kind: 'navigate', label: 'Open Model Manager', href: '#/models' },
      );
    }
    return diagnosis(
      'fail',
      'unreachable-transient',
      'The voice engine is starting up.',
      'This usually resolves within a few seconds.',
    );
  }
  return diagnosis('pass', 'pass', 'Voice engine ready.', '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/setup-diagnosis.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/setup-diagnosis.ts server/src/routes/setup-diagnosis.test.ts
git commit -m "feat(server): add diagnoseSidecar cause chain"
```

---

## Task 3: `diagnoseTts()` — tts cause chain (sidecar-blocked gate)

**Files:**
- Modify: `server/src/routes/setup-diagnosis.ts`
- Modify: `server/src/routes/setup-diagnosis.test.ts`

**Interfaces:**
- Consumes: `BlockerDiagnosis` (the sidecar diagnosis from Task 2, passed in as a parameter — not recomputed).
- Produces: `TtsDiagnosisInput` (interface), `diagnoseTts(sidecar: BlockerDiagnosis, input: TtsDiagnosisInput): BlockerDiagnosis`, consumed by Task 7 (route wiring).

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/setup-diagnosis.test.ts`:

```ts
import { diagnoseTts } from './setup-diagnosis.js';
import type { TtsDiagnosisInput } from './setup-diagnosis.js';

const SIDECAR_PASS = diagnoseSidecar(READY);
const SIDECAR_VENV_MISSING = diagnoseSidecar({ ...READY, venvPresent: false, pythonFound: true });
const SIDECAR_TRANSIENT = diagnoseSidecar({ ...READY, sidecarReachable: false });
const SIDECAR_NO_SUPERVISOR = diagnoseSidecar({ ...READY, supervisorActive: false, sidecarReachable: false });

const TTS_READY: TtsDiagnosisInput = {
  noEngineAtAll: false,
  anyEngineUsable: true,
  weightsMissingEngine: null,
  kokoroPackageConfirmedBroken: false,
  qwenPackageConfirmedBroken: false,
};

describe('diagnoseTts', () => {
  it('passes when the sidecar passes and an engine is present', () => {
    expect(diagnoseTts(SIDECAR_PASS, TTS_READY)).toMatchObject({ status: 'pass', cause: 'pass' });
  });

  it('reports sidecar-blocked (not no-engine-installed) when the sidecar has an actionable failure', () => {
    const r = diagnoseTts(SIDECAR_VENV_MISSING, { ...TTS_READY, noEngineAtAll: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'sidecar-blocked' });
    expect(r.action).toBeUndefined();
  });

  it('does NOT gate on unreachable-transient — disk checks still run', () => {
    const r = diagnoseTts(SIDECAR_TRANSIENT, { ...TTS_READY, noEngineAtAll: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'no-engine-installed' });
    expect(r.action).toMatchObject({ kind: 'kokoro-install' });
  });

  it('DOES gate on unreachable-no-supervisor — it is actionable, not transient', () => {
    const r = diagnoseTts(SIDECAR_NO_SUPERVISOR, { ...TTS_READY, noEngineAtAll: true });
    expect(r.cause).toBe('sidecar-blocked');
  });

  it('reports no-engine-installed when the sidecar passes but no engine has a package', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, noEngineAtAll: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'no-engine-installed' });
    expect(r.action).toMatchObject({ kind: 'kokoro-install' });
  });

  it('reports weights-missing for the reporting engine when no engine is ready yet', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, anyEngineUsable: false, weightsMissingEngine: 'qwen' });
    expect(r).toMatchObject({ status: 'fail', cause: 'weights-missing' });
    expect(r.action).toMatchObject({ kind: 'qwen-install' });
  });

  it('passes when one engine is ready even though another engine reports weights-missing (mixed state, round-2 plan review finding A2)', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, anyEngineUsable: true, weightsMissingEngine: 'qwen' });
    expect(r).toMatchObject({ status: 'pass', cause: 'pass' });
  });

  it('passes when one engine is live-confirmed-broken but another is usable (round-3 plan review finding 1)', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, anyEngineUsable: true, kokoroPackageConfirmedBroken: true });
    expect(r).toMatchObject({ status: 'pass', cause: 'pass' });
  });

  it('reports package-broken when the only ready engine is the broken one', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, anyEngineUsable: false, kokoroPackageConfirmedBroken: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'package-broken' });
  });

  it('reports cannot-confirm-engine (not pass) when sidecar is transient and disk checks found nothing', () => {
    const r = diagnoseTts(SIDECAR_TRANSIENT, TTS_READY);
    expect(r).toMatchObject({ status: 'fail', cause: 'cannot-confirm-engine' });
    expect(r.action).toBeUndefined();
  });

  it('reports package-broken only once the sidecar is confirmed pass', () => {
    const r = diagnoseTts(SIDECAR_PASS, { ...TTS_READY, kokoroPackageConfirmedBroken: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'package-broken' });
    expect(r.action).toBeUndefined();
  });

  it('never returns package-broken while the sidecar is not pass, even if the flag is somehow set', () => {
    const r = diagnoseTts(SIDECAR_TRANSIENT, { ...TTS_READY, kokoroPackageConfirmedBroken: true });
    expect(r.cause).not.toBe('package-broken');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/setup-diagnosis.test.ts`
Expected: FAIL — `diagnoseTts` is not exported.

- [ ] **Step 3: Write `diagnoseTts()`**

Append to `server/src/routes/setup-diagnosis.ts`:

```ts
export interface TtsDiagnosisInput {
  /** True only when kokoro/coqui/qwen all report 'not-installed' on disk. */
  noEngineAtAll: boolean;
  /** True when at least one engine is BOTH 'ready' on disk AND not live-
      confirmed-broken — i.e. an engine a book could actually render with
      right now. Deliberately richer than a plain disk-readiness check
      (round-3 plan review finding 1): gating `weights-missing` alone on
      disk-readiness (an earlier draft) still let a *live-broken* engine's
      package-broken verdict fail the whole blocker even when a DIFFERENT
      engine was fully usable — the same "usable engine, reported not-ready"
      reversal the disk-only check was created to prevent (round-2 finding
      A2), reproduced one layer down. Both `weights-missing` and
      `package-broken` below gate on this single combined signal instead of
      two different ones, so there's one definition of "is anything actually
      usable," not two that can disagree. */
  anyEngineUsable: boolean;
  /** First engine reporting 'weights-missing' on disk, or null. Only acted
      on when anyEngineUsable is false — see above. */
  weightsMissingEngine: 'kokoro' | 'qwen' | 'coqui' | null;
  /** From the sidecar's live /health payload — only meaningful once sidecar is reachable. */
  kokoroPackageConfirmedBroken: boolean;
  qwenPackageConfirmedBroken: boolean;
}

const ENGINE_INSTALL_ACTION: Record<'kokoro' | 'qwen' | 'coqui', BlockerDiagnosis['action']> = {
  kokoro: { kind: 'kokoro-install', label: 'Install Kokoro' },
  qwen: { kind: 'qwen-install', label: 'Install Qwen3-TTS' },
  coqui: { kind: 'coqui-install', label: 'Install Coqui XTTS v2' },
};

export function diagnoseTts(sidecar: BlockerDiagnosis, input: TtsDiagnosisInput): BlockerDiagnosis {
  if (sidecar.status === 'fail' && sidecar.cause !== 'unreachable-transient') {
    return diagnosis(
      'fail',
      'sidecar-blocked',
      'The voice engine needs to be fixed before a voice can be confirmed.',
      'Fix the voice engine above first.',
    );
  }
  if (input.noEngineAtAll) {
    return diagnosis(
      'fail',
      'no-engine-installed',
      'No voice engine is installed.',
      'Install Kokoro — the always-available default voice engine.',
      ENGINE_INSTALL_ACTION.kokoro,
    );
  }
  if (!input.anyEngineUsable && input.weightsMissingEngine) {
    return diagnosis(
      'fail',
      'weights-missing',
      `${input.weightsMissingEngine} is installed but its voice weights have not been downloaded.`,
      `Download ${input.weightsMissingEngine}'s voice weights.`,
      ENGINE_INSTALL_ACTION[input.weightsMissingEngine],
    );
  }
  if (sidecar.status !== 'pass') {
    return diagnosis(
      'fail',
      'cannot-confirm-engine',
      'Waiting for the voice engine to respond to confirm this.',
      'Try again shortly.',
    );
  }
  if (!input.anyEngineUsable && (input.kokoroPackageConfirmedBroken || input.qwenPackageConfirmedBroken)) {
    return diagnosis(
      'fail',
      'package-broken',
      'A voice engine package is not importable in the voice engine runtime.',
      'Repair in Model Manager.',
    );
  }
  return diagnosis('pass', 'pass', 'A voice engine is ready.', '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/setup-diagnosis.test.ts`
Expected: PASS (23 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/setup-diagnosis.ts server/src/routes/setup-diagnosis.test.ts
git commit -m "feat(server): add diagnoseTts cause chain with sidecar-blocked gate"
```

---

## Task 4: `diagnoseFfmpeg()` and `diagnoseAnalyzer()`

**Files:**
- Modify: `server/src/routes/setup-diagnosis.ts`
- Modify: `server/src/routes/setup-diagnosis.test.ts`

**Interfaces:**
- Produces: `FfmpegDiagnosisInput`, `diagnoseFfmpeg(input: FfmpegDiagnosisInput): BlockerDiagnosis`; `AnalyzerDiagnosisInput`, `diagnoseAnalyzer(input: AnalyzerDiagnosisInput): BlockerDiagnosis`. Both consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/routes/setup-diagnosis.test.ts`:

```ts
import { diagnoseFfmpeg, diagnoseAnalyzer } from './setup-diagnosis.js';
import type { FfmpegDiagnosisInput, AnalyzerDiagnosisInput } from './setup-diagnosis.js';

describe('diagnoseFfmpeg', () => {
  it('passes when both are present', () => {
    const r = diagnoseFfmpeg({ ffmpegPresent: true, ffprobePresent: true });
    expect(r).toMatchObject({ status: 'pass', cause: 'pass' });
  });
  it('reports ffmpeg-missing', () => {
    const r = diagnoseFfmpeg({ ffmpegPresent: false, ffprobePresent: true });
    expect(r).toMatchObject({ status: 'fail', cause: 'ffmpeg-missing' });
    expect(r.action).toBeUndefined();
  });
  it('reports ffprobe-missing', () => {
    const r = diagnoseFfmpeg({ ffmpegPresent: true, ffprobePresent: false });
    expect(r.cause).toBe('ffprobe-missing');
  });
  it('reports both-missing', () => {
    const r = diagnoseFfmpeg({ ffmpegPresent: false, ffprobePresent: false });
    expect(r.cause).toBe('both-missing');
  });
});

const ANALYZER_LOCAL_READY: AnalyzerDiagnosisInput = {
  engine: 'local',
  ollamaReachable: true,
  ollamaError: null,
  modelPulled: true,
  expectedModel: 'qwen3.5:9b',
  pullable: ['qwen3.5:9b'],
  geminiKeySet: false,
};

describe('diagnoseAnalyzer', () => {
  it('passes for a reachable, pulled local model', () => {
    expect(diagnoseAnalyzer(ANALYZER_LOCAL_READY)).toMatchObject({ status: 'pass', cause: 'pass' });
  });
  it('reports ollama-unreachable with an install action', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, ollamaReachable: false, ollamaError: 'ECONNREFUSED' });
    expect(r).toMatchObject({ status: 'fail', cause: 'ollama-unreachable' });
    expect(r.action).toMatchObject({ kind: 'ollama-install' });
  });
  it('reports model-not-pulled with a pull action when the model is in the allowlist', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, modelPulled: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'model-not-pulled' });
    expect(r.action).toMatchObject({ kind: 'ollama-pull', params: { model: 'qwen3.5:9b' } });
  });
  it('omits the pull action when the model is not in the allowlist', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, modelPulled: false, pullable: ['other-model'] });
    expect(r).toMatchObject({ status: 'fail', cause: 'model-not-pulled' });
    expect(r.action).toBeUndefined();
  });
  it('reports no-gemini-key with a navigate action for the gemini engine', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, engine: 'gemini', geminiKeySet: false });
    expect(r).toMatchObject({ status: 'fail', cause: 'no-gemini-key' });
    expect(r.action).toMatchObject({ kind: 'navigate' });
  });
  it('passes for the gemini engine when a key is set', () => {
    const r = diagnoseAnalyzer({ ...ANALYZER_LOCAL_READY, engine: 'gemini', geminiKeySet: true });
    expect(r).toMatchObject({ status: 'pass', cause: 'pass' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/setup-diagnosis.test.ts`
Expected: FAIL — `diagnoseFfmpeg`/`diagnoseAnalyzer` not exported.

- [ ] **Step 3: Write both functions**

Append to `server/src/routes/setup-diagnosis.ts`:

```ts
export interface FfmpegDiagnosisInput {
  ffmpegPresent: boolean;
  ffprobePresent: boolean;
}

export function diagnoseFfmpeg(input: FfmpegDiagnosisInput): BlockerDiagnosis {
  if (!input.ffmpegPresent && !input.ffprobePresent) {
    return diagnosis(
      'fail', 'both-missing',
      'ffmpeg and ffprobe are not on PATH.',
      'Install ffmpeg (which bundles ffprobe) for your OS, then click Recheck.',
    );
  }
  if (!input.ffmpegPresent) {
    return diagnosis('fail', 'ffmpeg-missing', 'ffmpeg is not on PATH.', 'Install ffmpeg for your OS, then click Recheck.');
  }
  if (!input.ffprobePresent) {
    return diagnosis('fail', 'ffprobe-missing', 'ffprobe is not on PATH.', 'Install ffmpeg (which bundles ffprobe) for your OS, then click Recheck.');
  }
  return diagnosis('pass', 'pass', 'ffmpeg and ffprobe are both installed.', '');
}

export interface AnalyzerDiagnosisInput {
  engine: 'local' | 'gemini';
  ollamaReachable: boolean;
  ollamaError: string | null;
  modelPulled: boolean;
  expectedModel: string;
  pullable: string[];
  geminiKeySet: boolean;
}

export function diagnoseAnalyzer(input: AnalyzerDiagnosisInput): BlockerDiagnosis {
  if (input.engine === 'gemini') {
    if (!input.geminiKeySet) {
      return diagnosis(
        'fail', 'no-gemini-key',
        'No Gemini API key is configured.',
        'Enter a Gemini API key in Advanced Settings.',
        { kind: 'navigate', label: 'Open Advanced Settings', href: '#/advanced' },
      );
    }
    return diagnosis('pass', 'pass', 'Gemini API key configured.', '');
  }
  if (!input.ollamaReachable) {
    return diagnosis(
      'fail', 'ollama-unreachable',
      input.ollamaError ?? 'The local Ollama analyzer is not reachable.',
      'Install and start Ollama.',
      { kind: 'ollama-install', label: 'Install Ollama' },
    );
  }
  if (!input.modelPulled) {
    const action = input.pullable.includes(input.expectedModel)
      ? { kind: 'ollama-pull' as const, label: `Pull ${input.expectedModel}`, params: { model: input.expectedModel } }
      : undefined;
    return diagnosis(
      'fail', 'model-not-pulled',
      `The analyzer model "${input.expectedModel}" has not been pulled.`,
      action ? `Pull ${input.expectedModel}.` : `Pull it via the terminal: ollama pull ${input.expectedModel}`,
      action,
    );
  }
  return diagnosis('pass', 'pass', 'Analyzer ready.', '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/setup-diagnosis.test.ts`
Expected: PASS (34 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/setup-diagnosis.ts server/src/routes/setup-diagnosis.test.ts
git commit -m "feat(server): add diagnoseFfmpeg and diagnoseAnalyzer cause chains"
```

---

## Task 5: `sidecar-supervisor.ts` — `exhaustedEvent()` + merged `resetAndRespawn()`

**Files:**
- Modify: `server/src/tts/sidecar-supervisor.ts`
- Modify: `server/src/tts/sidecar-supervisor.test.ts`
- Modify: `server/src/routes/queue.test.ts`

**Interfaces:**
- Produces: `SidecarSupervisor.exhaustedEvent(): boolean` (new interface member), `SidecarSupervisor.resetAndRespawn(): Promise<void>` (replaces `clearTripAndRespawn`). Consumed by Task 6 (`sidecar-health.ts`).

- [ ] **Step 1: Update the existing trip-recovery test to the new name**

In `server/src/tts/sidecar-supervisor.test.ts`, find the test at line 625 (`it('clearTripAndRespawn resets the streak and spawns a fresh child after a trip', ...)`). Rename it and its call:

```ts
it('resetAndRespawn resets the streak and spawns a fresh child after a trip', async () => {
  // ...unchanged body up to:
  const beforeRecovery = respawnCount();

  await sup.resetAndRespawn();

  expect(sup.tripEvent()).toBeNull(); // trip cleared
  expect(respawnCount()).toBeGreaterThan(beforeRecovery); // a fresh child was spawned
  // ...rest unchanged
```

- [ ] **Step 2: Add new failing tests for `exhaustedEvent()` and the plain-exhaustion reset path**

Add to the same file, in the same `describe` block:

```ts
it('exhaustedEvent is false before exhaustion and true once consecutiveFailures exceeds the max', async () => {
  let now = 0;
  const handles: ReturnType<typeof makeHandle>[] = [];
  const spawn = makeSpawn(handles);
  const sup = createSidecarSupervisor({
    buildOpts: async () => BASE_OPTS,
    spawnFn: spawn.fn,
    delayFn: async () => {},
    nowFn: () => now,
    maxConsecutiveFailures: 2,
    warn: vi.fn(),
    log: vi.fn(),
  });
  await sup.start();
  expect(sup.exhaustedEvent()).toBe(false);
  for (let i = 0; i < 3; i++) {
    now += 1_000; // faster than QUICK_DEATH_MS, so failures accumulate
    spawn.exit(1);
    await Promise.resolve();
  }
  expect(sup.exhaustedEvent()).toBe(true);
});

it('resetAndRespawn clears exhaustedEvent and spawns a fresh child after plain exhaustion', async () => {
  let now = 0;
  const handles: ReturnType<typeof makeHandle>[] = [];
  const spawn = makeSpawn(handles);
  const respawnCount = () => spawn.fn.mock.calls.length;
  const sup = createSidecarSupervisor({
    buildOpts: async () => BASE_OPTS,
    spawnFn: spawn.fn,
    delayFn: async () => {},
    nowFn: () => now,
    maxConsecutiveFailures: 2,
    warn: vi.fn(),
    log: vi.fn(),
  });
  await sup.start();
  for (let i = 0; i < 3; i++) {
    now += 1_000;
    spawn.exit(1);
    await Promise.resolve();
  }
  expect(sup.exhaustedEvent()).toBe(true);
  const beforeRecovery = respawnCount();

  await sup.resetAndRespawn();

  expect(sup.exhaustedEvent()).toBe(false);
  expect(respawnCount()).toBeGreaterThan(beforeRecovery);
});

it('two direct resetAndRespawn calls in a row spawn exactly once each (the second is a safe no-op)', async () => {
  let now = 0;
  const handles: ReturnType<typeof makeHandle>[] = [];
  const spawn = makeSpawn(handles);
  const respawnCount = () => spawn.fn.mock.calls.length;
  const sup = createSidecarSupervisor({
    buildOpts: async () => BASE_OPTS,
    spawnFn: spawn.fn,
    delayFn: async () => {},
    nowFn: () => now,
    maxConsecutiveFailures: 2,
    warn: vi.fn(),
    log: vi.fn(),
  });
  await sup.start();
  for (let i = 0; i < 3; i++) {
    now += 1_000;
    spawn.exit(1);
    await Promise.resolve();
  }
  const beforeRecovery = respawnCount();

  await Promise.all([sup.resetAndRespawn(), sup.resetAndRespawn()]);

  // First call resets+spawns; second observes already-cleared exhaustedEvent
  // and (per the current spawnOnce()/onChildExit() contract) still calls
  // spawnOnce() — assert it happened, and that state is consistent afterward,
  // not that a specific call count is "the" safe number. What matters is no
  // exception and exhaustedEvent() reads false at the end.
  expect(respawnCount()).toBeGreaterThan(beforeRecovery);
  expect(sup.exhaustedEvent()).toBe(false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run src/tts/sidecar-supervisor.test.ts`
Expected: FAIL — `sup.resetAndRespawn is not a function`, `sup.exhaustedEvent is not a function`.

- [ ] **Step 4: Add `exhaustedEvent()` and rename `clearTripAndRespawn` to `resetAndRespawn`**

In `server/src/tts/sidecar-supervisor.ts`, in the `SidecarSupervisor` interface (around line 103-131), the existing `tripEvent` doc comment names `clearTripAndRespawn()` by name ("...then calls `clearTripAndRespawn()` to actually bring TTS back.") — that reference must be updated to the new name too, not left dangling. Replace the `tripEvent` doc comment and the `clearTripAndRespawn` member together:

```ts
  /** Non-null once 3+ code-43 self-exits happened within RESTART43_STREAK_
      WINDOW_MS — the assignment looks structurally too small. The supervisor
      stops respawning once this trips (TTS held down); Plan 2's auto-revert
      route (Task 16) reads this to rewrite the offending knob, then calls
      resetAndRespawn() to actually bring TTS back. */
  tripEvent: () => { card: unknown; residentEngines: string[] } | null;
  /** True once consecutiveFailures has exceeded maxConsecutiveFailures and the
      supervisor gave up respawning (the plain, non-code-43 give-up path).
      Computed live from consecutiveFailures — clears the instant
      resetAndRespawn() zeroes it, with no separate flag to forget to clear. */
  exhaustedEvent: () => boolean;
  /** The way back from EITHER give-up state (a code-43 trip or plain
      consecutive-failure exhaustion) — resets whichever streak/counter is
      set and spawns a fresh child. Has no internal guard against concurrent
      calls: safety for that comes from every CALLER re-checking
      exhaustedEvent()/tripEvent() synchronously, with no intervening await,
      immediately before calling (see the /restart route in
      sidecar-health.ts). Safe to call when nothing is tripped/exhausted —
      resets an empty streak and respawns as normal. */
  resetAndRespawn: () => Promise<void>;
```

Around line 349-356, there's a second doc comment directly above the implementation ("/** The only way back from a trip — see the `clearTripAndRespawn` doc on the SidecarSupervisor interface... */") — remove it entirely rather than rename it, since the interface-level doc (just replaced above) already carries the full explanation for both callers reading the interface and callers reading the implementation:

```ts
  function resetAndRespawn(): Promise<void> {
    restart43Trip = null;
    restart43Timestamps = [];
    consecutiveFailures = 0;
    return spawnOnce();
  }
```

In the returned object (around line 358-381), replace `tripEvent()`'s neighbor:

```ts
    tripEvent() {
      return restart43Trip;
    },
    exhaustedEvent() {
      return consecutiveFailures > maxConsecutiveFailures;
    },
    resetAndRespawn,
```

- [ ] **Step 5: Fix the two `queue.test.ts` mock stubs**

In `server/src/routes/queue.test.ts`, both mock literals (lines 120-127 and 136-143) currently end with `clearTripAndRespawn: async () => {},`. Change each to:

```ts
  exhaustedEvent: () => false,
  resetAndRespawn: async () => {},
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && npx vitest run src/tts/sidecar-supervisor.test.ts src/routes/queue.test.ts`
Expected: PASS (all existing + 3 new sidecar-supervisor cases)

- [ ] **Step 7: Commit**

```bash
git add server/src/tts/sidecar-supervisor.ts server/src/tts/sidecar-supervisor.test.ts server/src/routes/queue.test.ts
git commit -m "feat(server): add exhaustedEvent and merge clearTripAndRespawn into resetAndRespawn"
```

---

## Task 6: `POST /api/sidecar/restart` — exhausted branch + stale comment fix

**Files:**
- Modify: `server/src/routes/sidecar-health.ts`
- Modify: `server/src/routes/sidecar-health.test.ts`

**Interfaces:**
- Consumes: `SidecarSupervisor.exhaustedEvent()`/`.resetAndRespawn()` from Task 5. **Concurrency note:** `resetAndRespawn()` has no internal guard against being called twice — the safety property is that this route re-checks `exhaustedEvent()`/`tripEvent()` synchronously, with no `await` in between, immediately before calling it (Design §2). This holds even across two independent, near-simultaneous HTTP requests to this route: Node's single-threaded run-to-completion execution means the second request's handler cannot run any code — not even its own guard check — until the first request's handler yields at its first `await`, by which point the first request has already reset the state. So the second request's own guard check always observes the post-reset state and falls through to the existing 409, rather than racing a second `spawnOnce()`. Don't add a mutex/lock — it isn't needed, and would just be unused complexity on top of a guarantee the language runtime already provides here.

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/sidecar-health.test.ts` (find the existing `describe('POST /api/sidecar/restart', ...)` block and add alongside its existing cases):

```ts
it('calls resetAndRespawn and polls health when the supervisor is exhausted (not tripped)', async () => {
  const resetAndRespawn = vi.fn(async () => {});
  vi.spyOn(supervisorModule, 'getActiveSupervisor').mockReturnValue({
    start: async () => {},
    stop: async () => {},
    current: () => null,
    recycling: () => true,
    tripEvent: () => null,
    exhaustedEvent: () => true,
    resetAndRespawn,
  });
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

  const res = await request(app).post('/api/sidecar/restart');

  expect(resetAndRespawn).toHaveBeenCalledTimes(1);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });
});

it('still returns the generic 409 when neither tripped nor exhausted', async () => {
  vi.spyOn(supervisorModule, 'getActiveSupervisor').mockReturnValue({
    start: async () => {},
    stop: async () => {},
    current: () => null,
    recycling: () => true,
    tripEvent: () => null,
    exhaustedEvent: () => false,
    resetAndRespawn: vi.fn(async () => {}),
  });

  const res = await request(app).post('/api/sidecar/restart');

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/will spawn one shortly/i);
});
```

(Match the exact mocking style — `vi.spyOn`, `fetchMock`, `request(app)` — already used by the neighboring tests in this file; adjust import names if the file's existing convention differs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts`
Expected: FAIL — the exhausted case falls through to the generic 409 instead of calling `resetAndRespawn`.

- [ ] **Step 3: Add the exhausted branch and fix the stale comment**

In `server/src/routes/sidecar-health.ts`, replace the comment above line 435 and the branch structure through line 456:

```ts
  const handle = supervisor.current();
  if (!handle) {
    /* A code-43 streak trip (Wave 2 §W2.5) also leaves current()===null, but
       with NO respawn coming — the supervisor stopped trying on purpose.
       Give that case its own message rather than the generic "will spawn
       shortly" claim, which would be actively misleading here: this route
       can't recover a trip by killing-and-waiting (a tripped supervisor has
       nothing to kill and nothing will respawn) unless it explicitly calls
       resetAndRespawn(), which the branch below does. */
    if (supervisor.tripEvent()) {
      return res.status(409).json({
        ok: false,
        error:
          'The sidecar is held down after repeated crash-loop exits (code-43 streak) — ' +
          'no automatic respawn is coming. Restarting via this route cannot recover it; ' +
          'the current device assignment needs fixing and the server restarted.',
      });
    }
    /* Plain (non-code-43) exhaustion: consecutiveFailures exceeded the cap and
       the supervisor gave up. Unlike the trip case above, this IS recoverable
       from this route — resetAndRespawn() zeroes the counter and spawns a
       fresh child. The exhaustedEvent()/resetAndRespawn() check-then-call
       here has no intervening await, which is what makes a second
       near-simultaneous request to this same route safe (see
       sidecar-supervisor.ts's resetAndRespawn doc). */
    if (supervisor.exhaustedEvent()) {
      await supervisor.resetAndRespawn();
      const url = getResolvedSidecarUrl();
      const target = `${url}/health`;
      const deadline = Date.now() + RESTART_HEALTH_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, RESTART_HEALTH_POLL_MS));
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
          const r = await fetch(target, { signal: controller.signal }).finally(() => clearTimeout(timer));
          if (r.ok) return res.json({ ok: true });
        } catch {
          /* sidecar still starting — keep polling */
        }
      }
      return res.status(503).json({
        ok: false,
        error: `Sidecar did not become healthy within ${RESTART_HEALTH_POLL_TIMEOUT_MS / 1000}s after reset.`,
      });
    }
    return res.status(409).json({
      ok: false,
      error: 'No sidecar child is currently running. If auto-start is on, the supervisor will spawn one shortly.',
    });
  }
```

(The existing kill-and-poll logic below this block, for the `handle` case, is unchanged — note the health-poll loop above duplicates it; if your editor flags this, extract a small shared `pollUntilHealthy(deadline)` helper used by both branches rather than leaving two copies to drift.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts`
Expected: PASS (all existing + 2 new cases)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/sidecar-health.ts server/src/routes/sidecar-health.test.ts
git commit -m "fix(server): /api/sidecar/restart actually recovers a plain-exhausted supervisor"
```

---

## Task 7: Wire `buildSetupReadiness` + the `/readiness` route to the new diagnosis functions

**Files:**
- Modify: `server/src/routes/setup-readiness.ts`
- Modify: `server/src/routes/setup-readiness.test.ts`

**Interfaces:**
- Consumes: `diagnoseSidecar`/`diagnoseTts`/`diagnoseFfmpeg`/`diagnoseAnalyzer` (Tasks 2-4), `venvCorePackageInstalled` (Task 1), `probePython312Cached` (Task 2), `SidecarSupervisor.exhaustedEvent()`/`tripEvent()`/`current()` (Task 5).
- Produces: the final `buildSetupReadiness(input): SetupReadiness` signature every other server task assumes.

- [ ] **Step 1: Rewrite `setup-readiness.test.ts` for the new pure-function signature**

Replace the entire file:

```ts
// server/src/routes/setup-readiness.test.ts
import { describe, it, expect } from 'vitest';
import { buildSetupReadiness } from './setup-readiness.js';
import type { BlockerDiagnosis } from './setup-readiness.js';

function pass(message = 'ok'): BlockerDiagnosis {
  return { status: 'pass', cause: 'pass', message, remediation: '' };
}
function fail(cause: BlockerDiagnosis['cause'], message = 'broken'): BlockerDiagnosis {
  return { status: 'fail', cause, message, remediation: 'fix it' };
}

describe('buildSetupReadiness', () => {
  it('is ready when all four blockers pass', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: 'cuda',
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual({ sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass() });
  });

  it('is not ready when the sidecar blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: fail('venv-missing'), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: 'cuda',
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.sidecar.cause).toBe('venv-missing');
  });

  it('is not ready when the tts blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: fail('no-engine-installed'), analyzer: pass(), gpu: 'cuda',
    });
    expect(r.ready).toBe(false);
  });

  it('is not ready when the ffmpeg blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: fail('both-missing'), tts: pass(), analyzer: pass(), gpu: 'cuda',
    });
    expect(r.ready).toBe(false);
  });

  it('is not ready when the analyzer blocker fails', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: fail('no-gemini-key'), gpu: 'cuda',
    });
    expect(r.ready).toBe(false);
  });

  it('surfaces the gpu info string and passes through completedAt', () => {
    const r = buildSetupReadiness({
      sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: 'cuda · 1.2/8.0 GB',
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(r.info.gpu).toBe('cuda · 1.2/8.0 GB');
    expect(r.completedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('defaults completedAt to null when omitted', () => {
    const r = buildSetupReadiness({ sidecar: pass(), ffmpeg: pass(), tts: pass(), analyzer: pass(), gpu: '' });
    expect(r.completedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/setup-readiness.test.ts`
Expected: FAIL — `buildSetupReadiness`'s current signature doesn't accept `{sidecar, ffmpeg, tts, analyzer, gpu, completedAt}`.

- [ ] **Step 3: Rewrite `buildSetupReadiness` and the route handler**

In `server/src/routes/setup-readiness.ts`, replace `buildSetupReadiness` and the `/readiness` route:

```ts
export function buildSetupReadiness(input: {
  sidecar: BlockerDiagnosis;
  ffmpeg: BlockerDiagnosis;
  tts: BlockerDiagnosis;
  analyzer: BlockerDiagnosis;
  gpu: string;
  completedAt?: string | null;
}): SetupReadiness {
  const blockers = {
    sidecar: input.sidecar, ffmpeg: input.ffmpeg, tts: input.tts, analyzer: input.analyzer,
  };
  return {
    ready: Object.values(blockers).every((b) => b.status === 'pass'),
    completedAt: input.completedAt ?? null,
    blockers,
    info: { gpu: input.gpu },
  };
}
```

`DiagnosticsResponse` only exposes each check's `detail` string, not the raw `kokoroPackageInstalled`/`qwenPackageInstalled` booleans `diagnostics.ts`'s own 'sidecar' check reads internally. Add one small helper that makes exactly one additional `probeSidecarHealth()` call (on top of the one already inside `buildDiagnostics()`, which computes `info.gpu` and the `sidecar`/`ffmpeg` `DiagnosticsCheck` rows — two total network calls per `/readiness` request, not three; the spec's Design §4 polling-cost note scopes "the one `/health` fetch" as the accepted cost, so don't call this a second time anywhere else), then replace the `GET /readiness` handler body:

```ts
import { probeSidecarHealth } from './sidecar-health.js';

async function packageBrokenFlags(
  d: DiagnosticsResponse,
): Promise<{ kokoroPackageConfirmedBroken: boolean; qwenPackageConfirmedBroken: boolean }> {
  if (!checkOk(d, 'sidecar')) return { kokoroPackageConfirmedBroken: false, qwenPackageConfirmedBroken: false };
  const h = await probeSidecarHealth();
  if (h.status !== 'reachable') return { kokoroPackageConfirmedBroken: false, qwenPackageConfirmedBroken: false };
  return {
    kokoroPackageConfirmedBroken: h.kokoroPackageInstalled === false,
    qwenPackageConfirmedBroken: h.qwenPackageInstalled === false,
  };
}

setupReadinessRouter.get('/readiness', async (_req: Request, res: Response) => {
  const diagnostics = await buildDiagnostics();
  const venvPresent = sidecarVenvPresent(REPO_ROOT);
  const pythonFound = venvPresent ? true : probePython312Cached();
  const corePackageInstalled = venvPresent ? venvCorePackageInstalled(REPO_ROOT) : false;
  const supervisor = getActiveSupervisor();

  const sidecar = diagnoseSidecar({
    venvPresent,
    pythonFound,
    corePackageInstalled,
    supervisorActive: supervisor !== null,
    supervisorTripped: supervisor?.tripEvent() != null,
    supervisorExhausted: supervisor?.exhaustedEvent() ?? false,
    sidecarReachable: checkOk(diagnostics, 'sidecar'),
  });

  const kokoroState = detectKokoroInstallStateOnDisk(REPO_ROOT);
  const qwenState = detectQwenInstallStateOnDisk(REPO_ROOT);
  const coquiState = detectCoquiInstallStateOnDisk(REPO_ROOT);
  const noEngineAtAll = [kokoroState, qwenState, coquiState].every((s) => s === 'not-installed');
  const weightsMissingEngine =
    kokoroState === 'weights-missing' ? 'kokoro' :
    qwenState === 'weights-missing' ? 'qwen' :
    coquiState === 'weights-missing' ? 'coqui' : null;
  const packageFlags = await packageBrokenFlags(diagnostics);
  /* "Usable" = ready on disk AND not live-confirmed-broken. Coqui has no
     live package-broken signal (coqui-tts is a BASE sidecar requirement
     present whenever the venv is bootstrapped — see coqui-install-detect.ts
     — so its readiness on disk is the whole story). Computed AFTER
     packageFlags, not alongside the plain disk-readiness check, precisely
     because a disk-only "any engine ready" signal is what let a live-broken
     engine still fail the whole blocker in round-3 plan review finding 1. */
  const anyEngineUsable =
    (kokoroState === 'ready' && !packageFlags.kokoroPackageConfirmedBroken) ||
    (qwenState === 'ready' && !packageFlags.qwenPackageConfirmedBroken) ||
    coquiState === 'ready';

  const tts = diagnoseTts(sidecar, {
    noEngineAtAll,
    anyEngineUsable,
    weightsMissingEngine,
    ...packageFlags,
  });

  const { ffmpeg: ffmpegPresent, ffprobe: ffprobePresent } = probeFfmpeg();
  const ffmpeg = diagnoseFfmpeg({ ffmpegPresent, ffprobePresent });

  const engine = getResolvedAnalysisEngine();
  let analyzer: BlockerDiagnosis;
  if (engine === 'gemini') {
    analyzer = diagnoseAnalyzer({
      engine: 'gemini', ollamaReachable: true, ollamaError: null, modelPulled: true,
      expectedModel: '', pullable: [], geminiKeySet: getResolvedGeminiApiKey() != null,
    });
  } else {
    const ollama = await probeOllamaHealth();
    analyzer = diagnoseAnalyzer({
      engine: 'local',
      ollamaReachable: ollama.status === 'reachable',
      ollamaError: ollama.error ?? null,
      modelPulled: ollama.modelPulled ?? false,
      expectedModel: getResolvedOllamaModel(),
      pullable: ollama.pullable ?? [],
      geminiKeySet: false,
    });
  }

  res.json(
    buildSetupReadiness({
      sidecar, tts, ffmpeg, analyzer,
      gpu: detail(diagnostics, 'gpu'),
      completedAt: getResolvedSetupCompletedAt(),
    }),
  );
});
```

Add the new imports at the top of the file:

```ts
import { getActiveSupervisor } from '../tts/sidecar-supervisor.js';
import { venvCorePackageInstalled } from '../tts/venv-core-package.js';
import { detectKokoroInstallStateOnDisk } from '../tts/kokoro-install-detect.js';
import { detectQwenInstallStateOnDisk } from '../tts/qwen-install-detect.js';
import { detectCoquiInstallStateOnDisk } from '../tts/coqui-install-detect.js';
import { probeFfmpeg } from '../diagnostics/ffmpeg.js';
import { probeOllamaHealth } from './ollama-health.js';
import { getResolvedOllamaModel } from '../workspace/user-settings.js';
import {
  diagnoseSidecar, diagnoseTts, diagnoseFfmpeg, diagnoseAnalyzer, probePython312Cached,
} from './setup-diagnosis.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/setup-readiness.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the server-scoped typecheck and full server test suite**

Run: `cd server && npm run typecheck && npm run test`
Expected: PASS. **Do not run the whole-repo `npm run typecheck` yet** — it also checks the frontend, which is still on the bare-string `blockers` shape until Task 16 finishes migrating it, so it will fail here regardless of whether this task's server-side change is correct. The server-scoped command isolates the check to what this task actually touched. The whole-repo typecheck becomes green again — and gets run for real — at Task 18's `npm run verify`.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/setup-readiness.ts server/src/routes/setup-readiness.test.ts
git commit -m "feat(server): wire buildSetupReadiness and GET /readiness to the layered diagnosis functions"
```

---

## Task 8: Frontend types + `mockGetSetupReadiness` + `api.test.ts`

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/lib/api.test.ts`

**Interfaces:**
- Produces: `BlockerDiagnosis`, `BlockerCause`, `BlockerAction`, `BlockerActionKind`, updated `SetupReadiness` (mirrors the server types from Task 1) — consumed by every remaining frontend task.

- [ ] **Step 1: Update `api.test.ts`**

In `src/lib/api.test.ts`, line 32, change:

```ts
    expect(first.blockers.tts).toBe('fail');
```
to:
```ts
    expect(first.blockers.tts.status).toBe('fail');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/api.test.ts`
Expected: FAIL — `mockGetSetupReadiness()` still returns the bare-string shape.

- [ ] **Step 3: Update the types and `mockGetSetupReadiness`**

In `src/lib/api.ts` around line 6367-6386, replace:

```ts
export type BlockerCause =
  | 'python-missing' | 'venv-missing' | 'venv-broken' | 'supervisor-exhausted'
  | 'supervisor-tripped' | 'unreachable-transient' | 'unreachable-no-supervisor'
  | 'sidecar-blocked' | 'no-engine-installed' | 'weights-missing'
  | 'cannot-confirm-engine' | 'package-broken'
  | 'ffmpeg-missing' | 'ffprobe-missing' | 'both-missing'
  | 'ollama-unreachable' | 'model-not-pulled' | 'no-gemini-key'
  | 'pass';

export type BlockerActionKind =
  | 'venv-bootstrap' | 'qwen-install' | 'kokoro-install' | 'coqui-install'
  | 'sidecar-restart' | 'ollama-install' | 'ollama-pull' | 'navigate';

export interface BlockerAction {
  kind: BlockerActionKind;
  label: string;
  params?: Record<string, string>;
  href?: string;
}

export interface BlockerDiagnosis {
  status: 'pass' | 'fail';
  cause: BlockerCause;
  message: string;
  remediation: string;
  action?: BlockerAction;
}

export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: { sidecar: BlockerDiagnosis; ffmpeg: BlockerDiagnosis; tts: BlockerDiagnosis; analyzer: BlockerDiagnosis };
  info: { gpu: string };
}
```

Find `mockGetSetupReadiness()`'s body (below line 6392) and update its two return shapes (the `notReady` branch and the ready branch) to build `BlockerDiagnosis` objects instead of bare strings — a small local helper keeps this terse:

```ts
function mockBlocker(status: 'pass' | 'fail'): BlockerDiagnosis {
  return status === 'pass'
    ? { status: 'pass', cause: 'pass', message: 'Ready', remediation: '' }
    : { status: 'fail', cause: 'venv-missing', message: 'Not set up', remediation: 'Set it up.' };
}
```

Wherever the function currently constructs `blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: notReady ? 'fail' : 'pass', analyzer: 'pass' }` (or similar — match whatever the existing conditional actually is), change each value to `mockBlocker('pass')` / `mockBlocker('fail')` accordingly, preserving the existing `notReady` conditional logic exactly (only the value shape changes, not which blocker fails under which condition).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): add BlockerDiagnosis types and update mockGetSetupReadiness"
```

---

## Task 9: `useSetupDiagnosis()` hook

**Files:**
- Create: `src/lib/use-setup-diagnosis.ts`
- Test: `src/lib/use-setup-diagnosis.test.ts`

**Interfaces:**
- Consumes: `api.getSetupReadiness()` (Task 8), `SetupReadiness` type.
- Produces: `useSetupDiagnosis(pollMs?: number): { readiness: SetupReadiness | null; refetch: () => void }`, consumed by Tasks 12, 13, 14, 15.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/use-setup-diagnosis.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useSetupDiagnosis } from './use-setup-diagnosis';
import * as api from './api';

describe('useSetupDiagnosis', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('fetches readiness on mount', async () => {
    const readiness = {
      ready: true, completedAt: null,
      blockers: {
        sidecar: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        ffmpeg: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        tts: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        analyzer: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
      },
      info: { gpu: 'cuda' },
    };
    vi.spyOn(api.api, 'getSetupReadiness').mockResolvedValue(readiness);
    const { result } = renderHook(() => useSetupDiagnosis());
    await vi.waitFor(() => expect(result.current.readiness).toEqual(readiness));
  });

  it('polls on the given interval', async () => {
    const spy = vi.spyOn(api.api, 'getSetupReadiness').mockResolvedValue({
      ready: true, completedAt: null,
      blockers: {
        sidecar: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        ffmpeg: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        tts: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        analyzer: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
      },
      info: { gpu: '' },
    });
    renderHook(() => useSetupDiagnosis(5_000));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetch triggers an immediate re-fetch', async () => {
    const spy = vi.spyOn(api.api, 'getSetupReadiness').mockResolvedValue({
      ready: true, completedAt: null,
      blockers: {
        sidecar: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        ffmpeg: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        tts: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
        analyzer: { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' },
      },
      info: { gpu: '' },
    });
    const { result } = renderHook(() => useSetupDiagnosis(60_000));
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    act(() => result.current.refetch());
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/use-setup-diagnosis.test.ts`
Expected: FAIL — `Cannot find module './use-setup-diagnosis'`

- [ ] **Step 3: Write the hook**

```ts
// src/lib/use-setup-diagnosis.ts
/* fs-21 wave 4 — shared readiness poller consumed by BOTH the Setup wizard
   and the Status popover, so there is one diagnosis engine, not two that
   can drift apart (spec Decision 1). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { SetupReadiness } from './api';

const DEFAULT_POLL_MS = 10_000;

export function useSetupDiagnosis(pollMs: number = DEFAULT_POLL_MS): {
  readiness: SetupReadiness | null;
  refetch: () => void;
} {
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNow = useCallback(() => {
    api.getSetupReadiness().then(setReadiness).catch(() => {});
  }, []);

  useEffect(() => {
    fetchNow();
    timerRef.current = setInterval(fetchNow, pollMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchNow, pollMs]);

  return { readiness, refetch: fetchNow };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/use-setup-diagnosis.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/use-setup-diagnosis.ts src/lib/use-setup-diagnosis.test.ts
git commit -m "feat(frontend): add shared useSetupDiagnosis polling hook"
```

---

## Task 10: `<BlockerFixAction>` component

**Files:**
- Create: `src/components/blocker-fix-action.tsx`
- Test: `src/components/blocker-fix-action.test.tsx`

**Interfaces:**
- Consumes: `BlockerDiagnosis`/`BlockerAction` types (Task 8).
- Produces: `<BlockerFixAction diagnosis={BlockerDiagnosis} onDone={() => void}>`, consumed by Tasks 12, 13, 15.

- [ ] **Step 1: Write the failing tests**

Mirrors `venv-bootstrap.test.tsx`'s stubbed-fetch pattern:

```tsx
// src/components/blocker-fix-action.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BlockerFixAction } from './blocker-fix-action';
import type { BlockerDiagnosis } from '../lib/api';

const fetchMock = vi.fn();
function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const VENV_MISSING: BlockerDiagnosis = {
  status: 'fail', cause: 'venv-missing',
  message: 'Voice engine runtime not set up.', remediation: 'Set it up.',
  action: { kind: 'venv-bootstrap', label: 'Set up the voice engine runtime' },
};

describe('BlockerFixAction', () => {
  it('renders nothing actionable for a diagnosis with no action (just remediation text elsewhere)', () => {
    const { container } = render(
      <BlockerFixAction diagnosis={{ status: 'fail', cause: 'ffmpeg-missing', message: 'x', remediation: 'y' }} onDone={() => {}} />,
    );
    expect(container.querySelector('button')).toBeNull();
  });

  it('venv-bootstrap: clicking POSTs the bootstrap job, polls, and calls onDone on completion', async () => {
    const onDone = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/setup/venv/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '1', status: 'bootstrapping', step: null, error: null }));
      }
      if (url.includes('/api/setup/venv/bootstrap/1')) {
        return Promise.resolve(jsonResponse({ id: '1', status: 'installed', step: null, error: null }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<BlockerFixAction diagnosis={VENV_MISSING} onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('sidecar-restart: clicking POSTs /api/sidecar/restart and calls onDone', async () => {
    const onDone = vi.fn();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    render(
      <BlockerFixAction
        diagnosis={{ status: 'fail', cause: 'supervisor-exhausted', message: 'x', remediation: 'y', action: { kind: 'sidecar-restart', label: 'Reset & restart voice engine' } }}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /reset & restart voice engine/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/sidecar/restart', expect.objectContaining({ method: 'POST' }));
  });

  it('ollama-pull: completes on the "pulled" terminal status, not just "installed"', async () => {
    const onDone = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/ollama/pull') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '9', status: 'pulling', step: null, error: null }));
      }
      if (url.includes('/api/ollama/pull/9')) {
        return Promise.resolve(jsonResponse({ id: '9', status: 'pulled', step: null, error: null }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(
      <BlockerFixAction
        diagnosis={{ status: 'fail', cause: 'model-not-pulled', message: 'x', remediation: 'y', action: { kind: 'ollama-pull', label: 'Pull qwen3.5:9b', params: { model: 'qwen3.5:9b' } } }}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /pull qwen3\.5:9b/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('navigate: clicking sets window.location.hash and calls onDone', () => {
    const onDone = vi.fn();
    render(
      <BlockerFixAction
        diagnosis={{ status: 'fail', cause: 'unreachable-no-supervisor', message: 'x', remediation: 'y', action: { kind: 'navigate', label: 'Open Model Manager', href: '#/models' } }}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /open model manager/i }));
    expect(window.location.hash).toBe('#/models');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('surfaces the job error inline on failure', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/setup/venv/bootstrap') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ id: '1', status: 'bootstrapping', step: null, error: null }));
      }
      if (url.includes('/api/setup/venv/bootstrap/1')) {
        return Promise.resolve(jsonResponse({ id: '1', status: 'error', step: null, error: 'pip install failed' }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    render(<BlockerFixAction diagnosis={VENV_MISSING} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /set up the voice engine runtime/i }));
    await waitFor(() => expect(screen.getByText(/pip install failed/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/blocker-fix-action.test.tsx`
Expected: FAIL — `Cannot find module './blocker-fix-action'`

- [ ] **Step 3: Write the component**

```tsx
// src/components/blocker-fix-action.tsx
/* fs-21 wave 4 — one shared fix-action button for every BlockerDiagnosis
   across the Setup checker and the Status popover. Owns its own job-polling
   loop (mirrors venv-bootstrap.tsx's pattern) so callers don't hand-roll
   button wiring per action kind. */
import { useRef, useState } from 'react';
import type { BlockerAction, BlockerDiagnosis } from '../lib/api';

interface Job {
  id: string;
  status: string;
  step: string | null;
  error: string | null;
  /* ollama-install only, Windows path: the job can't finish headlessly — it
     downloads a GUI installer, sets this path, and stays at 'installing'
     until the user runs it and the app re-probes via /recheck. */
  manualInstallerPath?: string | null;
}

const JOB_START_ENDPOINT: Partial<Record<BlockerAction['kind'], string>> = {
  'venv-bootstrap': '/api/setup/venv/bootstrap',
  'qwen-install': '/api/qwen/install',
  'kokoro-install': '/api/kokoro/install',
  'coqui-install': '/api/coqui/install',
  'ollama-install': '/api/ollama/install',
  'ollama-pull': '/api/ollama/pull',
};

/* Every install-job kind (venv-bootstrap, kokoro/qwen/coqui/ollama-install)
   reports success as 'installed' — EXCEPT ollama-pull, whose success status
   is 'pulled' (PullJobStatus in server/src/ollama/pull-bootstrap.ts). Missing
   'pulled' here would strand the ollama-pull fix button in "Working…"
   forever even though the pull actually succeeded server-side — the exact
   dead-end this feature exists to eliminate. No job kind emits 'done'. */
const JOB_DONE_STATUSES = ['installed', 'pulled'];
const JOB_ERROR_STATUSES = ['error'];
const POLL_MS = 1_500;

export function BlockerFixAction({
  diagnosis,
  onDone,
}: {
  diagnosis: BlockerDiagnosis;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Non-null only for the Windows ollama-install manual-installer handshake
     (round-2 plan review finding A1): the generic headless poll loop cannot
     reach a terminal status for this one job, since install-bootstrap.ts's
     win32 path returns at 'installing' with this path set and waits for a
     manual /recheck. Every other job kind never sets this. */
  const [manualInstallerPath, setManualInstallerPath] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobRef = useRef<{ endpoint: string; id: string } | null>(null);

  const action = diagnosis.action;
  if (!action) return null;

  const pollJob = (endpoint: string, id: string) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${endpoint}/${id}`);
        const body = (await res.json()) as Job;
        if (JOB_DONE_STATUSES.includes(body.status)) {
          setBusy(false);
          onDone();
          return;
        }
        if (JOB_ERROR_STATUSES.includes(body.status)) {
          setBusy(false);
          setError(body.error ?? 'Failed.');
          return;
        }
        if (body.manualInstallerPath) {
          setBusy(false);
          jobRef.current = { endpoint, id };
          setManualInstallerPath(body.manualInstallerPath);
          return;
        }
        pollJob(endpoint, id);
      } catch (e) {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_MS);
  };

  const runJobAction = async () => {
    const endpoint = JOB_START_ENDPOINT[action.kind];
    if (!endpoint) return;
    setBusy(true);
    setError(null);
    setManualInstallerPath(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: action.params ? { 'Content-Type': 'application/json' } : undefined,
        body: action.params ? JSON.stringify(action.params) : undefined,
      });
      const body = (await res.json()) as Job;
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.manualInstallerPath) {
        setBusy(false);
        jobRef.current = { endpoint, id: body.id };
        setManualInstallerPath(body.manualInstallerPath);
        return;
      }
      pollJob(endpoint, body.id);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runRecheck = async () => {
    if (!jobRef.current) return;
    const { endpoint, id } = jobRef.current;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${endpoint}/${id}/recheck`, { method: 'POST' });
      const body = (await res.json()) as Job;
      if (JOB_DONE_STATUSES.includes(body.status)) {
        setBusy(false);
        setManualInstallerPath(null);
        onDone();
        return;
      }
      // Still 'installing' (installer not run yet) — stay in the manual state.
      setBusy(false);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runRestartAction = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/sidecar/restart', { method: 'POST' });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) throw new Error(body.error ?? 'Restart failed.');
      setBusy(false);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runNavigateAction = () => {
    if (action.href) window.location.hash = action.href;
    onDone();
  };

  const onClick = () => {
    if (action.kind === 'sidecar-restart') return void runRestartAction();
    if (action.kind === 'navigate') return runNavigateAction();
    return void runJobAction();
  };

  if (manualInstallerPath) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-ink/60">
          Installer downloaded to <code className="bg-ink/5 px-1 rounded">{manualInstallerPath}</code> — run it,
          then click Recheck.
        </p>
        <button
          type="button"
          onClick={runRecheck}
          disabled={busy}
          className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink-soft disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Recheck'}
        </button>
        {error && <p className="text-xs text-rose-700">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink-soft disabled:opacity-50"
      >
        {busy ? 'Working…' : action.label}
      </button>
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Add a test for the Windows manual-installer handshake**

Add to `blocker-fix-action.test.tsx`, before the closing `});` of the `describe` block:

```tsx
it('ollama-install: shows a Recheck prompt (not endless polling) when the job needs a manual GUI install', async () => {
  const onDone = vi.fn();
  // Matches the REAL route's shape (install-bootstrap.ts): the POST returns
  // synchronously at 'detecting' with no manualInstallerPath yet — the path
  // only appears on a LATER poll, once the background job reaches the
  // win32 manual-install branch. A test that puts manualInstallerPath
  // directly on the POST response exercises runJobAction's branch, which
  // never actually runs in production — only pollJob's branch does.
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/api/ollama/install') && init?.method === 'POST' && !url.includes('/recheck')) {
      return Promise.resolve(jsonResponse({ id: '5', status: 'detecting', step: null, error: null, manualInstallerPath: null }));
    }
    if (url.includes('/api/ollama/install/5/recheck')) {
      return Promise.resolve(jsonResponse({ id: '5', status: 'installed', step: null, error: null }));
    }
    if (url.includes('/api/ollama/install/5')) {
      return Promise.resolve(jsonResponse({ id: '5', status: 'installing', step: null, error: null, manualInstallerPath: 'C:\\Users\\x\\Downloads\\OllamaSetup.exe' }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  render(
    <BlockerFixAction
      diagnosis={{ status: 'fail', cause: 'ollama-unreachable', message: 'x', remediation: 'y', action: { kind: 'ollama-install', label: 'Install Ollama' } }}
      onDone={onDone}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /install ollama/i }));
  // The manualInstallerPath only appears on the poll (POLL_MS=1500 later),
  // not on the initial POST response — give waitFor enough time to see it.
  await waitFor(() => expect(screen.getByText(/OllamaSetup\.exe/i)).toBeInTheDocument(), { timeout: 5000 });
  expect(screen.queryByText(/working…/i)).toBeNull(); // not stuck polling
  fireEvent.click(screen.getByRole('button', { name: /recheck/i }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/blocker-fix-action.test.tsx`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add src/components/blocker-fix-action.tsx src/components/blocker-fix-action.test.tsx
git commit -m "feat(frontend): add shared BlockerFixAction component"
```

---

## Task 11: `ModelControlPill` — `suppressUnreachableAction` prop

**Files:**
- Modify: `src/components/ModelControlPill.tsx`
- Modify: `src/components/ModelControlPill.test.tsx`

**Interfaces:**
- Produces: new optional prop `suppressUnreachableAction?: boolean` on `ModelControlPill`, consumed by Task 15 (`status-popover.tsx`).

- [ ] **Step 1: Write the failing test**

Add to `src/components/ModelControlPill.test.tsx`:

```tsx
it('hides the Retry button when suppressUnreachableAction is true, but keeps the label', () => {
  render(
    <ModelControlPill kind="tts" state="unreachable" onLoad={vi.fn()} onStop={vi.fn()} suppressUnreachableAction />,
  );
  expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  expect(screen.getByText(/voice engine unavailable/i)).toBeInTheDocument();
});

it('shows Retry as normal when suppressUnreachableAction is not set', () => {
  render(<ModelControlPill kind="tts" state="unreachable" onLoad={vi.fn()} onStop={vi.fn()} />);
  expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ModelControlPill.test.tsx`
Expected: FAIL — the Retry button renders regardless of the new prop.

- [ ] **Step 3: Add the prop**

In `src/components/ModelControlPill.tsx`, add to the `Props` interface (after `engineLabel`):

```ts
  /** When true and state === 'unreachable', omit the Retry button — used
      when a more specific BlockerDiagnosis fix action is rendered alongside
      this pill, so the user doesn't see two buttons for one problem. */
  suppressUnreachableAction?: boolean;
```

Destructure it in the component signature and use it to conditionally skip the button:

```tsx
export function ModelControlPill({
  kind,
  state,
  streamingDetail,
  onLoad,
  onStop,
  unreachableLabel,
  engineLabel,
  suppressUnreachableAction,
}: Props) {
  const tone = TONES[state];
  const action = actionFor(state);
  const hideButton = state === 'unreachable' && suppressUnreachableAction;
  const ariaLabel = engineLabel
    ? `${engineLabel} ${state}`
    : `${kindNoun(kind)} ${state}`;
  return (
    <span className="inline-flex items-center gap-2 flex-wrap" role="group" aria-label={ariaLabel}>
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tabular-nums ${tone.pill}`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${tone.dot} ${tone.pulse ? 'animate-pulse' : ''}`}
          aria-hidden="true"
        />
        <span>{labelFor(kind, state, streamingDetail, unreachableLabel, engineLabel)}</span>
      </span>
      {!hideButton && (
        <button
          type="button"
          onClick={action.handler === 'load' ? onLoad : onStop}
          disabled={action.disabled}
          aria-disabled={action.disabled}
          aria-label={`${action.label} (${kindNoun(kind).toLowerCase()})`}
          className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-colors ${tone.button}`}
        >
          {action.label}
        </button>
      )}
    </span>
  );
}
```

This removes the unused `dotStyle`/`CSSProperties` local — it was always `undefined` in both branches of the original ternary, so dropping it is a pre-existing dead-code cleanup that falls directly out of this edit, not a separate unrelated change. Also narrow the top-of-file import accordingly, since `CSSProperties` is no longer referenced anywhere in the file:

```ts
import type { ReactNode } from 'react';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/ModelControlPill.test.tsx`
Expected: PASS (all existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/components/ModelControlPill.tsx src/components/ModelControlPill.test.tsx
git commit -m "feat(frontend): add suppressUnreachableAction prop to ModelControlPill"
```

---

## Task 12: `setup-wizard.tsx` migration

**Files:**
- Modify: `src/components/setup/setup-wizard.tsx`
- Modify: `src/components/setup/setup-wizard.test.tsx`

- [ ] **Step 1: Update the test fixtures**

In `setup-wizard.test.tsx`, wherever a `SetupReadiness` fixture builds `blockers: {sidecar: 'pass', ...}`, change every value to a `BlockerDiagnosis` object, e.g. `{ status: 'pass', cause: 'pass', message: '', remediation: '' }` for a passing blocker and `{ status: 'fail', cause: 'venv-missing', message: '...', remediation: '...' }` for a failing one — preserve whichever specific blockers the existing tests set to fail (match the current test's intent, just change the value shape).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/setup/setup-wizard.test.tsx`
Expected: FAIL — `buildSummaryRows` still compares `blockers.X === 'pass'`.

- [ ] **Step 3: Update `buildSummaryRows`**

In `setup-wizard.tsx`, replace the function body (lines 241-281):

```ts
function buildSummaryRows(readiness: SetupReadiness): SummaryRow[] {
  const { blockers, info } = readiness;
  const voiceOk = blockers.sidecar.status === 'pass' && blockers.tts.status === 'pass';
  const voiceDetail = voiceOk
    ? 'Runtime + default voice ready'
    : (blockers.sidecar.status === 'fail' ? blockers.sidecar.message : blockers.tts.message);
  return [
    {
      key: 'environment',
      label: 'Environment',
      detail: info.gpu,
      status: 'ok',
      stepIndex: 0,
    },
    {
      key: 'ffmpeg',
      label: 'Audio assembly',
      detail: blockers.ffmpeg.status === 'pass' ? 'ffmpeg installed' : blockers.ffmpeg.message,
      status: blockers.ffmpeg.status === 'pass' ? 'ok' : 'attention',
      stepIndex: 1,
    },
    {
      key: 'voice',
      label: 'Voice engines',
      detail: voiceDetail,
      status: voiceOk ? 'ok' : 'attention',
      stepIndex: 2,
    },
    {
      key: 'analyzer',
      label: 'Analyzer',
      detail: blockers.analyzer.status === 'pass' ? 'Ready' : blockers.analyzer.message,
      status: blockers.analyzer.status === 'pass' ? 'ok' : 'attention',
      stepIndex: 2,
    },
    {
      key: 'defaults',
      label: 'Defaults',
      detail: 'New-book starting points',
      status: 'ok',
      stepIndex: 3,
    },
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/setup/setup-wizard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/setup-wizard.tsx src/components/setup/setup-wizard.test.tsx
git commit -m "feat(frontend): show real diagnosis messages in the Setup overview summary rows"
```

---

## Task 13: `step-models.tsx` migration — the direct fix for the screenshot

**Files:**
- Modify: `src/components/setup/step-models.tsx`
- Modify: `src/components/setup/step-models.test.tsx`

**Interfaces:**
- Consumes: `<BlockerFixAction>` (Task 10).

- [ ] **Step 1: Update the test fixtures**

In `step-models.test.tsx`, update `notReadyReadiness`/`readyReadiness` (or whatever the file's existing fixture names are) the same way as Task 12 — bare strings become `BlockerDiagnosis` objects. Add one new case:

```tsx
it('renders a fix-action button under the sidecar badge when a diagnosis has an action', () => {
  const readiness = { ...notReadyReadiness, blockers: {
    ...notReadyReadiness.blockers,
    sidecar: { status: 'fail' as const, cause: 'venv-missing' as const, message: 'Voice engine runtime not set up.', remediation: 'Set it up.', action: { kind: 'venv-bootstrap' as const, label: 'Set up the voice engine runtime' } },
  }};
  render(<StepModels readiness={readiness} onRefetch={vi.fn()} />);
  expect(screen.getByRole('button', { name: /set up the voice engine runtime/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/setup/step-models.test.tsx`
Expected: FAIL — `BlockerBadge` expects a bare string; the new fix-action button doesn't exist yet.

- [ ] **Step 3: Update `BlockerBadge` and wire in `BlockerFixAction`**

In `step-models.tsx`, replace the `BlockerBadge` function (lines 21-48):

```tsx
function BlockerBadge({
  diagnosis,
  label,
  onRefetch,
}: {
  diagnosis: BlockerDiagnosis;
  label: string;
  onRefetch: () => void;
}) {
  const isPass = diagnosis.status === 'pass';
  return (
    <div className="space-y-1.5">
      <span
        data-blocker-status={diagnosis.status}
        className={[
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold',
          isPass ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800',
        ].join(' ')}
      >
        <span className={['w-1.5 h-1.5 rounded-full', isPass ? 'bg-emerald-600' : 'bg-amber-600'].join(' ')} />
        {label}
      </span>
      {!isPass && (
        <>
          <p className="text-xs text-ink/60">{diagnosis.message}</p>
          <BlockerFixAction diagnosis={diagnosis} onDone={onRefetch} />
        </>
      )}
    </div>
  );
}
```

Add the import:

```ts
import { BlockerFixAction } from '../blocker-fix-action';
import type { BlockerDiagnosis } from '../../lib/api';
```

Update the three call sites (lines 83-91 and 129-133):

```tsx
        <div className="flex items-start gap-3 flex-wrap">
          <BlockerBadge
            diagnosis={readiness.blockers.sidecar}
            label={readiness.blockers.sidecar.status === 'pass' ? 'Runtime ready' : 'Runtime needed'}
            onRefetch={onRefetch}
          />
          <BlockerBadge
            diagnosis={readiness.blockers.tts}
            label={readiness.blockers.tts.status === 'pass' ? 'Voice ready' : 'Voice needed'}
            onRefetch={onRefetch}
          />
        </div>
```

```tsx
        <div className="flex items-start gap-3 flex-wrap">
          <BlockerBadge
            diagnosis={readiness.blockers.analyzer}
            label={readiness.blockers.analyzer.status === 'pass' ? 'Analyzer ready' : 'Analyzer needed'}
            onRefetch={onRefetch}
          />
        </div>
```

(The wrapping `div`'s `items-center` → `items-start` change accommodates the new multi-line badge content — each badge's own div now stacks the pill, message, and fix button vertically.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/setup/step-models.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/step-models.tsx src/components/setup/step-models.test.tsx
git commit -m "feat(frontend): show diagnosis message + working fix button in the Models step"
```

---

## Task 14: `step-ffmpeg.tsx` migration

**Files:**
- Modify: `src/components/setup/step-ffmpeg.tsx`
- Modify: `src/components/setup/step-ffmpeg.test.tsx`

- [ ] **Step 1: Update the test fixtures**

In `step-ffmpeg.test.tsx`, `makeReadiness('pass'|'fail')` currently sets `blockers.ffmpeg` to that bare string. Change it to build a `BlockerDiagnosis`:

```ts
function makeReadiness(status: 'pass' | 'fail'): SetupReadiness {
  return {
    ready: status === 'pass',
    completedAt: null,
    blockers: {
      sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      ffmpeg: status === 'pass'
        ? { status: 'pass', cause: 'pass', message: 'ffmpeg and ffprobe are both installed.', remediation: '' }
        : { status: 'fail', cause: 'both-missing', message: 'ffmpeg and ffprobe are not on PATH.', remediation: 'Install ffmpeg.' },
    },
    info: { gpu: '' },
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/setup/step-ffmpeg.test.tsx`
Expected: FAIL — `readiness.blockers.ffmpeg === 'pass'` (line 14) is always false against the new object.

- [ ] **Step 3: Fix the comparison**

In `step-ffmpeg.tsx`, line 14:

```ts
  const passed = readiness.blockers.ffmpeg.status === 'pass';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/setup/step-ffmpeg.test.tsx`
Expected: PASS — this regression-locks the exact silent-break the round-1 review caught.

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/step-ffmpeg.tsx src/components/setup/step-ffmpeg.test.tsx
git commit -m "fix(frontend): step-ffmpeg reads the new BlockerDiagnosis status correctly"
```

---

## Task 15: `status-popover.tsx` — diagnosis blocks in all four sections

**Files:**
- Modify: `src/components/status-popover.tsx`
- Modify: `src/components/status-popover.test.tsx`
- Modify: `src/components/layout.tsx` (wherever `<StatusPopover>` is instantiated, to pass the new props)

**Interfaces:**
- Consumes: `useSetupDiagnosis()` (Task 9), `<BlockerFixAction>` (Task 10), `suppressUnreachableAction` (Task 11).

**Scope note (round-3 plan review):** the spec's Design §1 describes a standing, always-rendered `recheck` action on every blocker card, independent of the poll. This plan does not add one — `useSetupDiagnosis()`'s 10s poll plus `BlockerFixAction`'s post-mutation refetch (Task 10) already surface a fix within one poll cycle, and the Setup checker's bespoke widgets already ship their own "Re-check" buttons (`VenvBootstrap`, `step-ffmpeg.tsx`) for the case that actually needs one — a user who fixed something entirely outside the app (e.g. installed ffmpeg in a terminal) between polls. A standing recheck button in the Status popover specifically is a small, cheap follow-up if that gap is felt in practice; it's called out here explicitly rather than left as a silent divergence from the spec's literal wording.

- [ ] **Step 1: Write the failing tests**

Add to `status-popover.test.tsx`:

```tsx
const FAIL_SIDECAR = { status: 'fail' as const, cause: 'venv-missing' as const, message: 'Voice engine runtime not set up.', remediation: 'x', action: { kind: 'venv-bootstrap' as const, label: 'Set up the voice engine runtime' } };
const PASS: any = { status: 'pass', cause: 'pass', message: '', remediation: '' };

function readinessWith(overrides: Partial<Record<'sidecar' | 'tts' | 'ffmpeg' | 'analyzer', any>>) {
  return {
    ready: false, completedAt: null,
    blockers: { sidecar: PASS, tts: PASS, ffmpeg: PASS, analyzer: PASS, ...overrides },
    info: { gpu: '' },
  };
}

it('shows the sidecar diagnosis block under Voice engines only when it fails', () => {
  render(<StatusPopover {...baseProps} readiness={readinessWith({ sidecar: FAIL_SIDECAR })} />);
  expect(within(screen.getByTestId('status-popover-tts')).getByText(/voice engine runtime not set up/i)).toBeInTheDocument();
});

it('does not show a sidecar diagnosis block when it passes', () => {
  render(<StatusPopover {...baseProps} readiness={readinessWith({})} />);
  expect(within(screen.getByTestId('status-popover-tts')).queryByText(/not set up/i)).toBeNull();
});

it('shows the analyzer diagnosis block under Analysis only when it fails', () => {
  const failAnalyzer = { status: 'fail' as const, cause: 'no-gemini-key' as const, message: 'No Gemini API key is configured.', remediation: 'x', action: { kind: 'navigate' as const, label: 'Open Advanced Settings', href: '#/advanced' } };
  render(<StatusPopover {...baseProps} readiness={readinessWith({ analyzer: failAnalyzer })} />);
  expect(within(screen.getByTestId('status-popover-analysis')).getByText(/no gemini api key/i)).toBeInTheDocument();
});

it('shows a top-of-panel ffmpeg banner only when it fails', () => {
  const failFfmpeg = { status: 'fail' as const, cause: 'both-missing' as const, message: 'ffmpeg and ffprobe are not on PATH.', remediation: 'x' };
  render(<StatusPopover {...baseProps} readiness={readinessWith({ ffmpeg: failFfmpeg })} />);
  expect(screen.getByTestId('status-popover-ffmpeg-banner')).toBeInTheDocument();
});

it('suppresses the TTS pill Retry button when a specific sidecar diagnosis is shown', () => {
  render(<StatusPopover {...baseProps} readiness={readinessWith({ sidecar: FAIL_SIDECAR })} ttsControls={<ModelControlPill kind="tts" state="unreachable" onLoad={vi.fn()} onStop={vi.fn()} />} />);
  // The popover itself doesn't own ttsControls' props — verify wiring in layout.tsx's own test instead;
  // here just assert the diagnosis block renders alongside whatever ttsControls was passed.
  expect(within(screen.getByTestId('status-popover-tts')).getByText(/voice engine runtime not set up/i)).toBeInTheDocument();
});
```

(Adjust `baseProps` to whatever the existing test file's default props fixture is named — every existing test in this file already builds one; add `readiness` to it as a new required prop, defaulting to `readinessWith({})` for tests that don't care.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/status-popover.test.tsx`
Expected: FAIL — `StatusPopover` doesn't accept a `readiness` prop yet.

- [ ] **Step 3: Add the `readiness` prop and render the diagnosis blocks**

In `status-popover.tsx`, add to `StatusPopoverProps`:

```ts
  /** Shared diagnosis, from useSetupDiagnosis() — drives the four
      diagnosis blocks below. Optional so existing callers/tests that don't
      care about diagnosis state aren't forced to pass it; when absent, no
      diagnosis blocks render. */
  readiness?: SetupReadiness | null;
  onDiagnosisRefetch?: () => void;
```

Add the import:

```ts
import type { SetupReadiness } from '../lib/api';
import { BlockerFixAction } from './blocker-fix-action';
```

Add a small local renderer above the `StatusPopover` function:

```tsx
function DiagnosisBlock({ diagnosis, onDone }: { diagnosis: import('../lib/api').BlockerDiagnosis; onDone: () => void }) {
  if (diagnosis.status === 'pass') return null;
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-sm text-ink/70">{diagnosis.message}</p>
      <BlockerFixAction diagnosis={diagnosis} onDone={onDone} />
    </div>
  );
}
```

In the JSX, add the ffmpeg banner right after the panel's opening `<div ...>` (before the "Voice engines" `<Section>`):

```tsx
      {readiness?.blockers.ffmpeg.status === 'fail' && (
        <div data-testid="status-popover-ffmpeg-banner" className="py-2 px-1 border-b border-ink/10 bg-amber-50/50 -mx-4 -mt-1 mb-1">
          <p className="text-xs font-semibold text-amber-900 px-4">{readiness.blockers.ffmpeg.message}</p>
          <div className="px-4 pt-1">
            <BlockerFixAction diagnosis={readiness.blockers.ffmpeg} onDone={() => onDiagnosisRefetch?.()} />
          </div>
        </div>
      )}
```

Inside the "Voice engines" `Section`, after `{ttsControls ?? (...)}`, add:

```tsx
        {readiness && (
          <>
            <DiagnosisBlock diagnosis={readiness.blockers.sidecar} onDone={() => onDiagnosisRefetch?.()} />
            <DiagnosisBlock diagnosis={readiness.blockers.tts} onDone={() => onDiagnosisRefetch?.()} />
          </>
        )}
```

Inside the "Analysis" `Section`, after its existing conditional content, add:

```tsx
        {readiness && <DiagnosisBlock diagnosis={readiness.blockers.analyzer} onDone={() => onDiagnosisRefetch?.()} />}
```

Destructure the two new props in the function signature (`readiness`, `onDiagnosisRefetch`).

- [ ] **Step 4: Wire `useSetupDiagnosis()` into `layout.tsx`'s `<StatusPopover>` call site, and suppress the TTS pill's Retry**

In `layout.tsx`, find the `<StatusPopover>` instantiation. Add:

```tsx
const { readiness: setupReadiness, refetch: refetchSetupDiagnosis } = useSetupDiagnosis();
```

near the top of the component that renders `<StatusPopover>`, and pass:

```tsx
<StatusPopover
  // ...existing props unchanged...
  readiness={setupReadiness}
  onDiagnosisRefetch={refetchSetupDiagnosis}
/>
```

Find wherever `layout.tsx` builds the TTS `ModelControlPill` passed as `ttsControls` (the four `unreachableLabel="Voice engine not running"` call sites at lines ~1181/1195/1209/1225 from the spec's Current State notes) and add:

```tsx
suppressUnreachableAction={setupReadiness?.blockers.sidecar.status === 'fail' && setupReadiness.blockers.sidecar.cause !== 'unreachable-transient'}
```

(Only suppress when the sidecar diagnosis has a *specific, actionable* cause about to render as a `DiagnosisBlock` — a merely-transient booting state has no diagnosis action either, so the pill's own Retry stays the only affordance in that case, matching today's behavior.)

Import the hook:

```ts
import { useSetupDiagnosis } from '../lib/use-setup-diagnosis';
```

- [ ] **Step 5: Migrate `layout.test.tsx`'s inline `getSetupReadiness` mock**

This task modifies `layout.tsx` directly, so its own test must compile and pass now, not after Task 16. In `src/components/layout.test.tsx`, the inline mock around line 90 currently returns `blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' }`. Change to:

```ts
    blockers: {
      sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    },
```

(Task 16's migration sweep covers the other five files that were flagged by the same review pass — `layout.test.tsx` is owned here instead, since this is the task that actually touches `layout.tsx`. Task 16's file list has been adjusted accordingly; don't migrate it twice.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/components/status-popover.test.tsx src/components/layout.test.tsx`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/status-popover.tsx src/components/status-popover.test.tsx src/components/layout.tsx src/components/layout.test.tsx
git commit -m "feat(frontend): surface all four blocker diagnoses in the Status popover"
```

---

## Task 16: Migration sweep — remaining test fixtures

**Files:**
- Modify: `src/components/setup/step-defaults.test.tsx`
- Modify: `src/components/setup/step-environment.test.tsx`
- Modify: `src/components/setup/step-finish.test.tsx`
- Modify: `src/routes/index.test.tsx`
- Modify: `src/store/prosody-autotrigger.test.tsx`

(`src/components/layout.test.tsx` is deliberately NOT in this task's file list — Task 15 Step 5 already migrates it, since Task 15 is the one that actually modifies `layout.tsx`. Confirm it's already green before starting this task; don't migrate it a second time here.)

**Before starting:** run `grep -rn "blockers\.\w* ===\|BlockerStatus\|makeReadiness\|getSetupReadiness" src/` and confirm this is the complete hit list — the spec's own migration-surface note (round-2 review finding 2) explicitly does not trust any prior "complete" claim, including this one. If the grep finds a file not listed here, add a step for it before proceeding.

- [ ] **Step 1: Run the grep sweep and record the full hit list**

Run: `grep -rn "blockers\.\w* ===\|BlockerStatus\|makeReadiness\|getSetupReadiness" src/`
Expected: every file listed above, plus any not yet migrated by Tasks 8-15. Note any surprises before continuing.

- [ ] **Step 2: Migrate the three `makeReadiness` fixtures**

In each of `step-defaults.test.tsx`, `step-environment.test.tsx`, `step-finish.test.tsx`, the `makeReadiness` helper currently returns `blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' }`. Change to:

```ts
    blockers: {
      sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
      analyzer: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    },
```

(Preserve each file's own `info.gpu` string and any `...overrides` spread exactly as-is — only the `blockers` value shape changes.)

- [ ] **Step 3: Migrate the two remaining inline `getSetupReadiness` mocks**

In each of `src/routes/index.test.tsx` and `src/store/prosody-autotrigger.test.tsx`, the inline mock currently returns:

```ts
    blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
```

Change to the same object-per-blocker shape as Step 2.

- [ ] **Step 4: Run the full frontend test suite**

Run: `npm run test`
Expected: PASS — zero references to the bare-string `blockers` shape remain anywhere in `src/`.

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/step-defaults.test.tsx src/components/setup/step-environment.test.tsx src/components/setup/step-finish.test.tsx src/routes/index.test.tsx src/store/prosody-autotrigger.test.tsx
git commit -m "test(frontend): migrate remaining SetupReadiness fixtures to BlockerDiagnosis"
```

---

## Task 17: E2E — venv-missing diagnosis end to end

**Files:**
- Create: `e2e/setup-checker-venv-fix.spec.ts`

**Interfaces:**
- Consumes: the mock-mode `mockGetSetupReadiness()` (Task 8) via the `?setup=notready` query-param latch already documented in `src/lib/api.ts`.

- [ ] **Step 1: Write the spec**

```ts
// e2e/setup-checker-venv-fix.spec.ts
import { test, expect } from '@playwright/test';

test('venv-missing diagnosis shows a working fix action end to end', async ({ page }) => {
  await page.route('**/api/setup/venv/bootstrap', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ json: { id: '1', status: 'bootstrapping', step: null, error: null } });
    } else {
      await route.continue();
    }
  });
  let polled = false;
  await page.route('**/api/setup/venv/bootstrap/1', async (route) => {
    await route.fulfill({
      json: polled
        ? { id: '1', status: 'installed', step: null, error: null }
        : ((polled = true), { id: '1', status: 'bootstrapping', step: 'Installing packages…', error: null }),
    });
  });

  await page.goto('/?setup=notready#/setup');

  await expect(page.getByText(/voice engine runtime not set up/i)).toBeVisible();
  await page.getByRole('button', { name: /set up the voice engine runtime/i }).click();
  await expect(page.getByText(/working…/i)).toBeVisible();
  await expect(page.getByText(/runtime ready/i)).toBeVisible({ timeout: 10_000 });
});
```

- [ ] **Step 2: Run the spec to verify it fails first (no implementation gaps)**

Run: `npm run test:e2e -- e2e/setup-checker-venv-fix.spec.ts`
Expected: FAIL if run before Tasks 1-16 land; PASS once they're all in place — since this is the last task, it should already pass. If it fails, the mismatch is almost always the mock's exact response shape vs. what `mockGetSetupReadiness()`/`BlockerFixAction` actually expect — compare against Task 8/10's real shapes rather than adjusting the app to match a guessed mock.

- [ ] **Step 3: Run the full spec to verify it passes**

Run: `npm run test:e2e -- e2e/setup-checker-venv-fix.spec.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add e2e/setup-checker-venv-fix.spec.ts
git commit -m "test(e2e): venv-missing diagnosis fix action end to end"
```

---

## Task 18: Full verification + regression plan + release notes

**Files:**
- Create: `docs/features/236-setup-checker-defense-in-depth.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

- [ ] **Step 1: Run the full verification battery**

Run: `npm run verify`
Expected: PASS (typecheck + all tests + e2e + build). Fix anything red before proceeding — do not skip this step.

- [ ] **Step 2: Write the regression plan**

Copy `docs/features/TEMPLATE.md` to `docs/features/236-setup-checker-defense-in-depth.md`. Document: the `BlockerDiagnosis` shape and full cause taxonomy (table from the spec's Design §1), the `resetAndRespawn()` concurrency contract (spec Design §2 — any future caller must re-check `exhaustedEvent()`/`tripEvent()` synchronously, no `await` in between), and the manual acceptance walkthrough: trigger each of the 17 causes (via the existing `?setup=notready` mock latch, or by breaking a real local venv) and confirm the checker/popover show the right message + working action. Set `status: stable` once Step 1 is green and this doc is committed.

- [ ] **Step 3: Update `docs/features/INDEX.md`**

Add an entry under the appropriate area for `236-setup-checker-defense-in-depth.md`.

- [ ] **Step 4: Update release notes**

Append a PR-refed technical entry to `docs/release-notes-next.md` (e.g. "Setup checker and Status popover now diagnose *why* the voice engine or analyzer isn't ready, with a working one-click fix where a safe automated fix exists — see #236"). Append a matching brand-voice, user-facing line to the in-progress version section at the top of `RELEASE_NOTES.md`.

- [ ] **Step 5: File the GitHub issue and commit the docs**

File a `type:feature`, `area:fe`+`area:srv` issue (multi-scope, per CONTRIBUTING.md) titled to match this plan if one doesn't already exist from the spec/brainstorming step; note its number for the PR body's `Closes #NN`.

```bash
git add docs/features/236-setup-checker-defense-in-depth.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): add regression plan and release notes for the setup checker diagnosis feature"
```

- [ ] **Step 6: Push and open the PR**

Per CLAUDE.md's PR-gate: title matches the commit convention, body links `Closes #NN`, and — since this is a multi-scope (`fe`+`srv`) feature PR — the mandatory `code-review` pass runs at `high` effort once everything above is pushed, before merge.
