# Wizard Model-Status Single Source of Truth (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the setup wizard's Models step report one consistent voice-engine status — summary badges and per-engine cards can never disagree — by routing both through a single server-side computation.

**Architecture:** A new server module (`models-status.ts`) composes the existing `deriveEngineHealth` per-engine state (over a small per-surface engine registry) with the runtime (venv/process) axis and GPU info. A new `GET /api/setup/models-status` route exposes it; `GET /api/setup/readiness` derives its `sidecar`/`tts` blocker badges from the same computation. On the client, the four install cards become **controlled** (status via prop), the Models step fetches once and feeds both badges and cards, and model-manager migrates to the same source.

**Tech Stack:** TypeScript, Node/Express (server), Vitest (server + frontend), React 18 + Redux Toolkit (frontend), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-07-14-wizard-models-status-and-recommendation-design.md` (Part A only — Part B / fe-51 recommendation ships in a later plan).

**Issue:** `#1612` (child of epic `#1613` / fs-75). This plan `Closes #1612`.

## Global Constraints

- **No hex literals in component code** — use CSS custom properties / Tailwind tokens (`--peach`, `--ink`, `--magenta`, `emerald-*`, `amber-*`, etc.). Match existing card styling.
- **OpenAPI is the type source of truth** for `Character`/`Chapter`/`Sentence` etc.; the new `ModelsStatus` shape is an internal setup-status type, not an OpenAPI-modeled domain object — define it in `server/src/routes/models-status.ts` and mirror the client type in `src/lib/api.ts`'s setup types.
- **Reuse, do not re-implement:** per-engine health MUST come from `server/src/tts/engine-health.ts` `deriveEngineHealth`; disk probes MUST come from the existing `*-install-detect.ts` package/weights functions; VRAM MUST come from `getDeviceTotalVramMb()`. Do not add new detection.
- **`packageBroken` is a sidecar-up-only signal** — from `/health`; at first-run the sidecar is down so it defaults `false`. Never treat its absence as "engine is fine."
- **Discriminated-union `ui.stage`** and existing wizard prop-wiring conventions are unchanged — this plan does not touch routing or `ui.stage`.
- **Cards stay reusable:** `KokoroInstall`/`VenvBootstrap`/`QwenInstall`/`CoquiInstall` are used in BOTH `step-models.tsx` and `model-manager.tsx`. The controlled-prop migration MUST update both callers.
- **Every task ends green:** `cd server && npm test` for server tasks, `npm test` (frontend) for client tasks. Commit only on green.

---

## File Structure

**Create:**
- `server/src/tts/voice-engine-registry.ts` — the per-surface registry of installable voice engines (kokoro/qwen/coqui) → probes + live-flag selectors + default model key. One responsibility: enumerate the voice engines this surface manages and how to probe each.
- `server/src/tts/voice-engine-registry.test.ts`
- `server/src/tts/models-status.ts` — `buildModelsStatus()`: compose registry + `deriveEngineHealth` + runtime + info into the `ModelsStatus` shape. Pure over injected probe results (mirrors the `diagnose*` pure-function style).
- `server/src/tts/models-status.test.ts`
- `server/src/routes/models-status.ts` — `GET /api/setup/models-status`; does the I/O (probes, health, vram) then calls `buildModelsStatus`.
- `server/src/routes/models-status.route.test.ts`
- `src/components/setup/engine-card-status.ts` — client-side pure mapping from a `ModelsStatus` engine slice / runtime to the card's display state + a `classifyBlocker` helper (`ok`/`attention`/`pending`).
- `src/components/setup/engine-card-status.test.ts`
- `e2e/setup-models-status.spec.ts` — badge/card consistency golden path.
- `docs/features/246-wizard-models-status.md` — regression plan (number = next free; verify with `ls docs/features`).

**Modify:**
- `server/src/routes/setup-readiness.ts` — derive `blockers.sidecar`/`.tts` from `buildModelsStatus` output; add `info.vramTotalMb`.
- `server/src/routes/setup-readiness.ts` type `SetupReadiness` — add `info.vramTotalMb: number | null`.
- `src/lib/api.ts` — add `ModelsStatus` client type + `getModelsStatus()` fetch (real) and its mock.
- `src/components/kokoro-install.tsx`, `venv-bootstrap.tsx`, `qwen-install.tsx`, `coqui-install.tsx` — controlled (status via required prop; keep install-job POST/poll).
- Their `*.test.tsx` (4 files) — rewrite to the controlled-prop contract.
- `src/components/setup/step-models.tsx` — fetch `models-status` once; derive badges + card status; render neutral `starting`; render `weights-missing`/`package-missing`.
- `src/components/setup/step-models.test.tsx` — the three regression cases + broken-engine-not-masked.
- `src/components/setup/setup-wizard.tsx` — `buildSummaryRows` treats transient `starting` as neutral.
- `src/views/model-manager.tsx` + `model-manager.test.tsx` — feed status into `INSTALLER_BY_ID` rows.
- `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`.

---

## Task 1: Voice-engine registry (server)

One iterable list of the installable voice engines this surface manages, each with its disk probes, live-flag selectors (off a `SidecarHealthResult`), and default model key. This is the "one entry per engine" scaling point — not a consolidation of the codebase's other engine lists.

**Files:**
- Create: `server/src/tts/voice-engine-registry.ts`
- Test: `server/src/tts/voice-engine-registry.test.ts`

**Interfaces:**
- Consumes: `kokoroPackageInstalled`, `detectKokoroInstalledOnDisk` (`./kokoro-install-detect.js`); `qwenPackageInstalled`, `qwenWeightsPresent` (`./qwen-install-detect.js`); `coquiPackageInstalled`, `coquiWeightsPresent` (`./coqui-install-detect.js`); `SidecarHealthResult` (`../routes/sidecar-health.js`); `TtsModelKey` (`../../..` — server has no `TtsModelKey`; use `string`).
- Produces: `VOICE_ENGINES: VoiceEngineEntry[]`, `type VoiceEngineId = 'kokoro' | 'qwen' | 'coqui'`, `interface VoiceEngineEntry`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/voice-engine-registry.test.ts
import { describe, it, expect } from 'vitest';
import { VOICE_ENGINES } from './voice-engine-registry.js';

describe('VOICE_ENGINES registry', () => {
  it('lists exactly the three installable voice engines, excluding whisper/gemini/piper', () => {
    expect(VOICE_ENGINES.map((e) => e.id).sort()).toEqual(['coqui', 'kokoro', 'qwen']);
  });

  it('each entry exposes disk probes, live selectors, and a default model key', () => {
    for (const e of VOICE_ENGINES) {
      expect(typeof e.packageInstalledOnDisk).toBe('function');
      expect(typeof e.weightsPresentOnDisk).toBe('function');
      expect(typeof e.livePackageImportable).toBe('function');
      expect(typeof e.liveLoaded).toBe('function');
      expect(e.defaultModelKey).toMatch(/^(kokoro-v1|qwen3-tts-0\.6b|coqui-xtts-v2)$/);
    }
  });

  it('live selectors read the matching SidecarHealthResult fields', () => {
    const kokoro = VOICE_ENGINES.find((e) => e.id === 'kokoro')!;
    expect(kokoro.liveLoaded({ kokoroLoaded: true } as never)).toBe(true);
    expect(kokoro.livePackageImportable({ kokoroPackageInstalled: false } as never)).toBe(false);
    // undefined health field (older sidecar) → not importable-confirmed, not loaded
    expect(kokoro.liveLoaded({} as never)).toBe(false);
    expect(kokoro.livePackageImportable({} as never)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/voice-engine-registry.test.ts`
Expected: FAIL — `Cannot find module './voice-engine-registry.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/tts/voice-engine-registry.ts
/* The per-surface registry of INSTALLABLE VOICE engines the setup Models step
   and the Model Manager manage: kokoro, qwen, coqui. NOT a consolidation of the
   codebase's other engine lists (ALL_TTS_ENGINES, TRACKED_ENGINES, EngineId…) —
   deliberately scoped to "engines with an install card + disk detector."
   Excludes whisper (ASR), gemini (cloud), piper (no detector/card).

   Adding a future voice engine = one entry here. */
import {
  kokoroPackageInstalled,
  detectKokoroInstalledOnDisk,
} from './kokoro-install-detect.js';
import { qwenPackageInstalled, qwenWeightsPresent } from './qwen-install-detect.js';
import { coquiPackageInstalled, coquiWeightsPresent } from './coqui-install-detect.js';
import type { SidecarHealthResult } from '../routes/sidecar-health.js';

export type VoiceEngineId = 'kokoro' | 'qwen' | 'coqui';

export interface VoiceEngineEntry {
  id: VoiceEngineId;
  /** Default model key this engine maps to for the Defaults handoff (Part B). */
  defaultModelKey: 'kokoro-v1' | 'qwen3-tts-0.6b' | 'coqui-xtts-v2';
  /** Python package present in the venv site-packages (disk fact). */
  packageInstalledOnDisk: (repoRoot: string) => boolean;
  /** Model weights present on disk (disk fact). */
  weightsPresentOnDisk: () => boolean;
  /** Live: package importable in the running sidecar. undefined when the health
      field is absent (older sidecar / sidecar down) — caller treats undefined as
      "unknown", never as broken. */
  livePackageImportable: (h: Partial<SidecarHealthResult>) => boolean | undefined;
  /** Live: model resident in the sidecar now. */
  liveLoaded: (h: Partial<SidecarHealthResult>) => boolean;
}

export const VOICE_ENGINES: VoiceEngineEntry[] = [
  {
    id: 'kokoro',
    defaultModelKey: 'kokoro-v1',
    packageInstalledOnDisk: (root) => kokoroPackageInstalled(root),
    weightsPresentOnDisk: () => false, // set per-repoRoot in models-status; see note
    livePackageImportable: (h) => h.kokoroPackageInstalled,
    liveLoaded: (h) => h.kokoroLoaded === true,
  },
  {
    id: 'qwen',
    defaultModelKey: 'qwen3-tts-0.6b',
    packageInstalledOnDisk: (root) => qwenPackageInstalled(root),
    weightsPresentOnDisk: () => qwenWeightsPresent(),
    livePackageImportable: (h) => h.qwenPackageInstalled,
    liveLoaded: (h) => h.qwenLoaded === true,
  },
  {
    id: 'coqui',
    defaultModelKey: 'coqui-xtts-v2',
    packageInstalledOnDisk: (root) => coquiPackageInstalled(root),
    weightsPresentOnDisk: () => coquiWeightsPresent(),
    livePackageImportable: (h) => h.coquiPackageInstalled,
    liveLoaded: (h) => h.modelLoaded === true, // Coqui uses the generic model_loaded flag
  },
];
```

> **Note on `weightsPresentOnDisk`:** Kokoro's weights probe (`detectKokoroInstalledOnDisk`) needs `repoRoot`, unlike Qwen/Coqui's no-arg probes. To keep the entry signature uniform, `models-status.ts` (Task 2) passes `repoRoot` into a small wrapper. Replace the kokoro `weightsPresentOnDisk` above with a probe that accepts `repoRoot` — see Task 2's `buildModelsStatus`, which calls `entry.weightsPresentOnDisk(repoRoot)`. Change the interface to `weightsPresentOnDisk: (repoRoot: string) => boolean` and implement each: kokoro → `detectKokoroInstalledOnDisk(root)`, qwen → `qwenWeightsPresent()` (ignores arg), coqui → `coquiWeightsPresent()` (ignores arg).

- [ ] **Step 4: Apply the uniform-signature fix**

Change the interface line to `weightsPresentOnDisk: (repoRoot: string) => boolean;` and the three entries to:
```ts
// kokoro
weightsPresentOnDisk: (root) => detectKokoroInstalledOnDisk(root),
// qwen
weightsPresentOnDisk: () => qwenWeightsPresent(),
// coqui
weightsPresentOnDisk: () => coquiWeightsPresent(),
```
Update the test's `weightsPresentOnDisk` expectation to call with a dummy root: `expect(typeof e.weightsPresentOnDisk).toBe('function')` already passes; no change needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/voice-engine-registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/voice-engine-registry.ts server/src/tts/voice-engine-registry.test.ts
git commit -m "feat(server): add per-surface voice-engine registry for models-status"
```

---

## Task 2: `models-status` composition module (server)

Compose the registry + `deriveEngineHealth` + runtime + info into `ModelsStatus`. Pure over injected probe results so it is unit-testable without fs/network.

**Files:**
- Create: `server/src/tts/models-status.ts`
- Test: `server/src/tts/models-status.test.ts`

**Interfaces:**
- Consumes: `VOICE_ENGINES`, `VoiceEngineId` (`./voice-engine-registry.js`); `deriveEngineHealth`, `EngineHealthState` (`./engine-health.js`).
- Produces: `interface ModelsStatus`, `interface EngineStatus`, `interface RuntimeStatus`, `buildModelsStatus(input: BuildModelsStatusInput): ModelsStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/tts/models-status.test.ts
import { describe, it, expect } from 'vitest';
import { buildModelsStatus } from './models-status.js';

const base = {
  runtime: { installedOnDisk: true, pythonFound: true, process: 'ready' as const },
  info: { gpu: 'cuda · 4/8 GB reserved', vramTotalMb: 8192 },
};

describe('buildModelsStatus', () => {
  it('maps each engine to its deriveEngineHealth state + packageBroken', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importable: true },
        qwen: { packageOnDisk: true, weightsOnDisk: false, loaded: false, importable: true },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
      },
    });
    expect(s.engines.kokoro.state).toBe('ready');
    expect(s.engines.qwen.state).toBe('weights-missing');
    expect(s.engines.coqui.state).toBe('not-installed');
    expect(s.engines.kokoro.packageBroken).toBe(false);
  });

  it('flags packageBroken when the package is on disk but not importable live', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importable: false },
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
      },
    });
    expect(s.engines.kokoro.packageBroken).toBe(true);
  });

  it('preserves package-missing (weights present, package absent) — not collapsed to not-installed', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: false, weightsOnDisk: true, loaded: false, importable: undefined },
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
      },
    });
    expect(s.engines.kokoro.state).toBe('package-missing');
  });

  it('does not let a green aggregate mask a broken engine (per-engine independence)', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importable: true }, // usable
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        coqui: { packageOnDisk: true, weightsOnDisk: true, loaded: false, importable: false }, // broken
      },
    });
    expect(s.engines.kokoro.state).toBe('ready');
    expect(s.engines.coqui.packageBroken).toBe(true); // coqui's own state survives
  });

  it('passes runtime + info through unchanged', () => {
    const s = buildModelsStatus({
      ...base,
      engines: {
        kokoro: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        qwen: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
        coqui: { packageOnDisk: false, weightsOnDisk: false, loaded: false, importable: undefined },
      },
    });
    expect(s.runtime.process).toBe('ready');
    expect(s.info.vramTotalMb).toBe(8192);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/models-status.test.ts`
Expected: FAIL — `Cannot find module './models-status.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/tts/models-status.ts
/* Single canonical composition of voice-engine status for the setup Models step
   and the readiness badges. NOT a new per-engine model — per-engine state reuses
   deriveEngineHealth (engine-health.ts, "one source of truth for the Model
   Manager badge, the inventory, and the readiness gate"). This layer adds the
   runtime (venv/process) axis and GPU info, and composes over the small
   voice-engine registry. Pure over injected probe results (fs/network I/O lives
   in the route handler, mirroring setup-diagnosis.ts). */
import { VOICE_ENGINES, type VoiceEngineId } from './voice-engine-registry.js';
import { deriveEngineHealth, type EngineHealthState, type EngineId } from './engine-health.js';

export type RuntimeProcessState = 'ready' | 'starting' | 'down' | 'crashed';

export interface RuntimeStatus {
  installedOnDisk: boolean;
  pythonFound: boolean;
  process: RuntimeProcessState;
}

export interface EngineStatus {
  /** Reused engine-health state: not-installed | package-missing | weights-missing | ready | loaded. */
  state: EngineHealthState;
  /** Live: package present on disk but fails to IMPORT in the sidecar. Sidecar-up-only;
      false when the sidecar is down (never a first-run "fine" guarantee). */
  packageBroken: boolean;
}

export interface ModelsStatus {
  runtime: RuntimeStatus;
  engines: Record<VoiceEngineId, EngineStatus>;
  info: { gpu: string; vramTotalMb: number | null };
}

/** Per-engine probe results, gathered by the route handler. `importable` is the
    live /health find_spec flag: true (importable), false (present-but-broken), or
    undefined (unknown — sidecar down / older sidecar). */
export interface EngineProbeResult {
  packageOnDisk: boolean;
  weightsOnDisk: boolean;
  loaded: boolean;
  importable: boolean | undefined;
}

export interface BuildModelsStatusInput {
  runtime: RuntimeStatus;
  engines: Record<VoiceEngineId, EngineProbeResult>;
  info: { gpu: string; vramTotalMb: number | null };
}

export function buildModelsStatus(input: BuildModelsStatusInput): ModelsStatus {
  const engines = {} as Record<VoiceEngineId, EngineStatus>;
  for (const entry of VOICE_ENGINES) {
    const p = input.engines[entry.id];
    const { state } = deriveEngineHealth(entry.id as EngineId, {
      packageInstalled: p.packageOnDisk,
      weightsPresent: p.weightsOnDisk,
      loaded: p.loaded,
    });
    // packageBroken: disk says package present, but the live sidecar can't import it.
    // undefined importable (sidecar down) → not broken-confirmed → false.
    const packageBroken = p.packageOnDisk && p.importable === false;
    engines[entry.id] = { state, packageBroken };
  }
  return { runtime: input.runtime, engines, info: input.info };
}

/** Derived: an engine a book could actually render with right now. */
export function engineUsable(s: EngineStatus): boolean {
  return (s.state === 'ready' || s.state === 'loaded') && !s.packageBroken;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/models-status.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/models-status.ts server/src/tts/models-status.test.ts
git commit -m "feat(server): add models-status composition over deriveEngineHealth + runtime/info"
```

---

## Task 3: `GET /api/setup/models-status` route

Do the I/O (disk probes, one `/health` probe, VRAM read, runtime axes) and call `buildModelsStatus`. Mount the router.

**Files:**
- Create: `server/src/routes/models-status.ts`
- Test: `server/src/routes/models-status.route.test.ts`
- Modify: wherever setup routers are mounted (grep `setupReadinessRouter` in `server/src/` to find the mount site — mount `modelsStatusRouter` alongside it under `/api/setup`).

**Interfaces:**
- Consumes: `buildModelsStatus`, `RuntimeProcessState` (`../tts/models-status.js`); `VOICE_ENGINES` (`../tts/voice-engine-registry.js`); `sidecarVenvPresent` (`../diagnostics/venv.js`); `probePython312Cached` (`./setup-diagnosis.js`); `probeSidecarHealth` (`./sidecar-health.js`); `getActiveSupervisor` (`../tts/sidecar-supervisor.js`); `getDeviceTotalVramMb` (`../gpu/device-total.js`); `buildDiagnostics` (`./diagnostics.js`, for the gpu detail string) or reuse the existing gpu detail path.
- Produces: `modelsStatusRouter`, `computeModelsStatus(repoRoot): Promise<ModelsStatus>` (exported so `setup-readiness.ts` reuses it — Task 4).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/routes/models-status.route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the I/O seams so the route is deterministic.
vi.mock('../diagnostics/venv.js', () => ({ sidecarVenvPresent: () => true }));
vi.mock('../tts/sidecar-supervisor.js', () => ({ getActiveSupervisor: () => ({ tripEvent: () => null, exhaustedEvent: () => false }) }));
vi.mock('../gpu/device-total.js', () => ({ getDeviceTotalVramMb: () => 8192 }));
vi.mock('./sidecar-health.js', () => ({
  probeSidecarHealth: async () => ({
    status: 'reachable', kokoroLoaded: false, kokoroPackageInstalled: true,
    qwenPackageInstalled: false, coquiPackageInstalled: false, modelLoaded: false,
  }),
}));
vi.mock('../tts/kokoro-install-detect.js', () => ({
  kokoroPackageInstalled: () => true, detectKokoroInstalledOnDisk: () => true,
}));
vi.mock('../tts/qwen-install-detect.js', () => ({
  qwenPackageInstalled: () => false, qwenWeightsPresent: () => false,
}));
vi.mock('../tts/coqui-install-detect.js', () => ({
  coquiPackageInstalled: () => false, coquiWeightsPresent: () => false,
}));

import { computeModelsStatus } from './models-status.js';

describe('computeModelsStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports kokoro ready, qwen not-installed, and runtime installed + reachable', async () => {
    const s = await computeModelsStatus('/repo');
    expect(s.engines.kokoro.state).toBe('ready');
    expect(s.engines.qwen.state).toBe('not-installed');
    expect(s.runtime.installedOnDisk).toBe(true);
    expect(s.runtime.process).toBe('ready');
    expect(s.info.vramTotalMb).toBe(8192);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/models-status.route.test.ts`
Expected: FAIL — `Cannot find module './models-status.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/routes/models-status.ts
/* GET /api/setup/models-status — the single client-facing voice-engine status
   payload. Does the I/O (disk probes, one /health probe, VRAM, runtime axes)
   then delegates the pure composition to buildModelsStatus. `computeModelsStatus`
   is exported so setup-readiness.ts derives its sidecar/tts badges from the SAME
   computation (no second source). */
import { Router } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from '../http.js';
import { buildModelsStatus, type ModelsStatus, type RuntimeProcessState } from '../tts/models-status.js';
import { VOICE_ENGINES, type VoiceEngineId } from '../tts/voice-engine-registry.js';
import { sidecarVenvPresent } from '../diagnostics/venv.js';
import { probePython312Cached } from './setup-diagnosis.js';
import { probeSidecarHealth, type SidecarHealthResult } from './sidecar-health.js';
import { getActiveSupervisor } from '../tts/sidecar-supervisor.js';
import { getDeviceTotalVramMb } from '../gpu/device-total.js';
import { buildDiagnostics } from './diagnostics.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Map the sidecar/supervisor liveness to the runtime.process axis. */
function deriveProcess(input: {
  reachable: boolean;
  supervisorActive: boolean;
  supervisorTripped: boolean;
  supervisorExhausted: boolean;
}): RuntimeProcessState {
  if (input.reachable) return 'ready';
  if (input.supervisorTripped || input.supervisorExhausted) return 'crashed';
  if (input.supervisorActive) return 'starting';
  return 'down';
}

export async function computeModelsStatus(repoRoot: string): Promise<ModelsStatus> {
  const installedOnDisk = sidecarVenvPresent(repoRoot);
  const pythonFound = installedOnDisk ? true : probePython312Cached();
  const supervisor = getActiveSupervisor();
  const health: Partial<SidecarHealthResult> = installedOnDisk
    ? await probeSidecarHealth()
    : { status: 'unreachable' };
  const reachable = health.status === 'reachable';

  const engines = {} as Record<VoiceEngineId, {
    packageOnDisk: boolean; weightsOnDisk: boolean; loaded: boolean; importable: boolean | undefined;
  }>;
  for (const e of VOICE_ENGINES) {
    engines[e.id] = {
      packageOnDisk: e.packageInstalledOnDisk(repoRoot),
      weightsOnDisk: e.weightsPresentOnDisk(repoRoot),
      loaded: reachable ? e.liveLoaded(health) : false,
      importable: reachable ? e.livePackageImportable(health) : undefined,
    };
  }

  // GPU detail string (human) — reuse the diagnostics gpu row; skip the rest.
  const diag = await buildDiagnostics({ skip: ['asr', 'analyzer', 'gemini', 'ffmpeg', 'disk'] });
  const gpu = diag.checks.find((c) => c.id === 'gpu')?.detail ?? '';

  return buildModelsStatus({
    runtime: {
      installedOnDisk,
      pythonFound,
      process: deriveProcess({
        reachable,
        supervisorActive: supervisor !== null,
        supervisorTripped: supervisor?.tripEvent() != null,
        supervisorExhausted: supervisor?.exhaustedEvent() ?? false,
      }),
    },
    engines,
    info: { gpu, vramTotalMb: getDeviceTotalVramMb() },
  });
}

export const modelsStatusRouter = Router();

modelsStatusRouter.get('/models-status', async (_req: Request, res: Response) => {
  res.json(await computeModelsStatus(REPO_ROOT));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/models-status.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Mount the router**

Find the mount site: `grep -rn "setupReadinessRouter" server/src/` → the file that does `app.use('/api/setup', setupReadinessRouter)`. Add alongside it:
```ts
import { modelsStatusRouter } from './routes/models-status.js';
// …next to the existing setup mount…
app.use('/api/setup', modelsStatusRouter);
```

- [ ] **Step 6: Verify the route is reachable**

Run: `cd server && npm run test:server` (or the targeted route test again). Then a manual smoke:
Run: `cd server && npm run dev` in one shell; `curl -s http://localhost:8080/api/setup/models-status | head -c 400`
Expected: JSON with `runtime`, `engines`, `info` keys.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/models-status.ts server/src/routes/models-status.route.test.ts <mount-file>
git commit -m "feat(server): add GET /api/setup/models-status route"
```

---

## Task 4: Derive readiness badges from `models-status` + surface `vramTotalMb`

Route `blockers.sidecar`/`.tts` through the same computation (no second source), and add `info.vramTotalMb` to `SetupReadiness`. The pure `diagnoseSidecar`/`diagnoseTts` contracts are UNCHANGED — only the route handler's input plumbing moves.

**Files:**
- Modify: `server/src/routes/setup-readiness.ts`
- Modify: `server/src/routes/setup-readiness.orchestration.test.ts` (mock seam moves to `computeModelsStatus` / the new probes)
- Test: existing `setup-readiness.test.ts` (pure builder) stays green unchanged.

**Interfaces:**
- Consumes: `computeModelsStatus` (`./models-status.js`); existing `diagnoseSidecar`, `diagnoseTts` (`./setup-diagnosis.js`); `engineUsable` (`../tts/models-status.js`).
- Produces: `SetupReadiness.info.vramTotalMb: number | null` (new field).

- [ ] **Step 1: Write the failing test (new field)**

Add to `setup-readiness.test.ts` (the pure builder test):
```ts
it('buildSetupReadiness carries vramTotalMb through info', () => {
  const r = buildSetupReadiness({
    sidecar: PASS, ffmpeg: PASS, tts: PASS, analyzer: PASS,
    gpu: 'cuda', vramTotalMb: 8192, completedAt: null,
  });
  expect(r.info.vramTotalMb).toBe(8192);
});
```
(where `PASS` is a `{ status: 'pass', cause: 'pass', message: '', remediation: '' }` literal — reuse the file's existing pass fixture if present.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/routes/setup-readiness.test.ts`
Expected: FAIL — `info.vramTotalMb` is `undefined` / type error (builder doesn't accept `vramTotalMb`).

- [ ] **Step 3: Extend the type + builder**

In `setup-readiness.ts`:
```ts
export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: { sidecar: BlockerDiagnosis; ffmpeg: BlockerDiagnosis; tts: BlockerDiagnosis; analyzer: BlockerDiagnosis };
  info: { gpu: string; vramTotalMb: number | null };
}
```
In `buildSetupReadiness`, extend the input type with `vramTotalMb: number | null` and set `info: { gpu: input.gpu, vramTotalMb: input.vramTotalMb }`.

- [ ] **Step 4: Rewire the route handler to reuse `computeModelsStatus`**

In the `/readiness` handler, replace the inline kokoro/qwen/coqui `detect*InstallStateOnDisk` + `packageBrokenFlags` block with a call to `computeModelsStatus(REPO_ROOT)`, then derive the `diagnoseSidecar`/`diagnoseTts` inputs from its output:

```ts
const models = await computeModelsStatus(REPO_ROOT);

const sidecar = diagnoseSidecar({
  venvPresent: models.runtime.installedOnDisk,
  pythonFound: models.runtime.pythonFound,
  corePackageInstalled: /* unchanged: venvCorePackageInstalled(REPO_ROOT) */,
  supervisorActive: /* unchanged */,
  supervisorTripped: /* unchanged */,
  supervisorExhausted: /* unchanged */,
  sidecarReachable: models.runtime.process === 'ready',
});

const usable = (id: 'kokoro' | 'qwen' | 'coqui') => engineUsable(models.engines[id]);
const noEngineAtAll = (['kokoro','qwen','coqui'] as const).every((id) => models.engines[id].state === 'not-installed');
const anyEngineUsable = (['kokoro','qwen','coqui'] as const).some(usable);
const weightsMissingEngine =
  models.engines.kokoro.state === 'weights-missing' ? 'kokoro' :
  models.engines.qwen.state === 'weights-missing' ? 'qwen' :
  models.engines.coqui.state === 'weights-missing' ? 'coqui' : null;

const tts = diagnoseTts(sidecar, {
  noEngineAtAll,
  anyEngineUsable,
  weightsMissingEngine,
  kokoroPackageConfirmedBroken: models.engines.kokoro.packageBroken,
  qwenPackageConfirmedBroken: models.engines.qwen.packageBroken,
});
```
Then pass `vramTotalMb: models.info.vramTotalMb` and `gpu: models.info.gpu` into `buildSetupReadiness` (drop the now-redundant separate `buildDiagnostics` gpu read if it's only used for gpu — `computeModelsStatus` already returns `info.gpu`).

> **Behavior-preservation note:** `diagnoseTts`'s existing contract is unchanged — the same four inputs, now sourced from `models-status` instead of inline detects. The `unreachable-transient` → `sidecarReachable:false` mapping is preserved because `process==='ready'` is exactly the old `checkOk(diagnostics,'sidecar')` signal.

- [ ] **Step 5: Update the orchestration test's mock seam**

In `setup-readiness.orchestration.test.ts`, replace mocks of `detectKokoroInstallStateOnDisk` etc. with a mock of `./models-status.js`'s `computeModelsStatus` returning a controlled `ModelsStatus`. Assert the resulting `blockers.tts.cause` for representative states (e.g. kokoro `weights-missing` + nothing usable → `cause: 'weights-missing'`; a broken coqui while kokoro usable → `blockers.tts.status: 'pass'` but — nothing to assert on tts; the per-engine broken state is exposed via models-status, not the aggregate badge, which is the whole point).

- [ ] **Step 6: Run the readiness suite**

Run: `cd server && npx vitest run src/routes/setup-readiness.test.ts src/routes/setup-readiness.orchestration.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/setup-readiness.ts server/src/routes/setup-readiness.test.ts server/src/routes/setup-readiness.orchestration.test.ts
git commit -m "refactor(server): derive readiness sidecar/tts badges from models-status; surface vramTotalMb"
```

---

## Task 5: Frontend `getModelsStatus` API + client type

**Files:**
- Modify: `src/lib/api.ts` (add `ModelsStatus` type mirroring the server; add `getModelsStatus()` to both the real and mock API objects).
- Test: colocate a small test if `api.ts` has a test harness; otherwise the type + fetch is exercised by Task 7's component test via a mocked `api.getModelsStatus`.

**Interfaces:**
- Produces: `export interface ModelsStatus { runtime: {...}; engines: Record<'kokoro'|'qwen'|'coqui', { state: EngineHealthState; packageBroken: boolean }>; info: { gpu: string; vramTotalMb: number | null } }`; `api.getModelsStatus(): Promise<ModelsStatus>`.

- [ ] **Step 1: Add the client type**

In `src/lib/api.ts` (near the other setup types like `SetupReadiness`):
```ts
export type EngineHealthState = 'ready' | 'package-missing' | 'weights-missing' | 'not-installed' | 'loaded';
export type RuntimeProcessState = 'ready' | 'starting' | 'down' | 'crashed';
export interface ModelsStatus {
  runtime: { installedOnDisk: boolean; pythonFound: boolean; process: RuntimeProcessState };
  engines: Record<'kokoro' | 'qwen' | 'coqui', { state: EngineHealthState; packageBroken: boolean }>;
  info: { gpu: string; vramTotalMb: number | null };
}
```

- [ ] **Step 2: Add the real fetch**

In the real API object:
```ts
async getModelsStatus(): Promise<ModelsStatus> {
  const res = await fetch('/api/setup/models-status');
  if (!res.ok) throw new Error(`models-status failed: HTTP ${res.status}`);
  return (await res.json()) as ModelsStatus;
},
```

- [ ] **Step 3: Add the mock**

In the mock API object, return a ready-state fixture:
```ts
async getModelsStatus(): Promise<ModelsStatus> {
  return {
    runtime: { installedOnDisk: true, pythonFound: true, process: 'ready' },
    engines: {
      kokoro: { state: 'ready', packageBroken: false },
      qwen: { state: 'not-installed', packageBroken: false },
      coqui: { state: 'not-installed', packageBroken: false },
    },
    info: { gpu: 'CPU — no GPU detected', vramTotalMb: null },
  };
},
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors in `api.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): add getModelsStatus API + ModelsStatus type"
```

---

## Task 6: Make the four install cards controlled

Lift the idle/detect status out of each card into a required prop; keep the install-job POST/poll and `onInstalled` callback. Rewrite each card's test to the controlled contract.

**Files:**
- Modify: `src/components/kokoro-install.tsx`, `venv-bootstrap.tsx`, `qwen-install.tsx`, `coqui-install.tsx`
- Modify: `src/components/{kokoro-install,venv-bootstrap,qwen-install,coqui-install}.test.tsx`

**Interfaces (all four cards, uniform):**
- Consumes: a `status` prop derived from `ModelsStatus` by the parent. For engine cards: `status: { state: EngineHealthState; packageBroken: boolean }`. For `VenvBootstrap`: `status: { installedOnDisk: boolean; pythonFound: boolean; process: RuntimeProcessState }`.
- Produces: unchanged install-job behavior + `onInstalled?()` / `onBootstrapped?()`.

**Migration shape (KokoroInstall — the others mirror it):**

- [ ] **Step 1: Write the failing controlled-prop test (kokoro)**

Replace `kokoro-install.test.tsx`'s self-fetch-mocking body with:
```tsx
import { render, screen } from '@testing-library/react';
import { KokoroInstall } from './kokoro-install';

it('renders weights-missing distinctly (not "not installed")', () => {
  render(<KokoroInstall status={{ state: 'weights-missing', packageBroken: false }} />);
  expect(screen.getByText(/voice weights not downloaded/i)).toBeInTheDocument();
  expect(screen.queryByText(/Kokoro is not installed/i)).not.toBeInTheDocument();
});

it('renders package-broken as a repair state', () => {
  render(<KokoroInstall status={{ state: 'ready', packageBroken: true }} />);
  expect(screen.getByText(/fails to load|repair/i)).toBeInTheDocument();
});

it('renders ready as installed', () => {
  render(<KokoroInstall status={{ state: 'ready', packageBroken: false }} />);
  expect(screen.getByText(/Kokoro is installed/i)).toBeInTheDocument();
});

it('renders not-installed with an install CTA', () => {
  render(<KokoroInstall status={{ state: 'not-installed', packageBroken: false }} />);
  expect(screen.getByRole('button', { name: /Install Kokoro/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/kokoro-install.test.tsx`
Expected: FAIL — `KokoroInstall` requires no `status` prop yet / still self-fetches.

- [ ] **Step 3: Convert KokoroInstall to controlled**

Remove the `detect` state, the `doDetect` fetch, and its `useEffect`. Add the prop and branch on `status.state` / `status.packageBroken`. Keep the install-job state/poll and the error/job renders. Key diff:
```tsx
export function KokoroInstall({
  status,
  onInstalled,
}: {
  status: { state: EngineHealthState; packageBroken: boolean };
  onInstalled?: () => void;
}) {
  const [job, setJob] = useState<KokoroInstallJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // …keep the job poll useEffect; on job 'installed' call onInstalled?.() (parent refetches models-status)…

  // Idle render is now driven by `status`, not a local detect:
  const ready = (status.state === 'ready' || status.state === 'loaded') && !status.packageBroken;
  if (!job || job.status === 'installed') {
    if (ready) return (/* green "Kokoro is installed" — keep existing markup, drop the Re-check onClick=doDetect; Re-check now calls onInstalled */);
    if (status.packageBroken) return (/* "Kokoro is installed but fails to load — repair" + Repair CTA (Repair = startInstall) */);
    if (status.state === 'package-missing') return (/* "Kokoro weights present — package needs repair" + Repair CTA */);
    if (status.state === 'weights-missing') return (/* "Kokoro is installed — voice weights not downloaded" + "Download weights" CTA (startInstall) */);
    // not-installed:
    return (/* existing "Kokoro is not installed" + Install CTA */);
  }
  // …existing detecting/installing/error job renders unchanged…
}
```
The "Re-check" button in the ready render now calls `onInstalled?.()` (which makes the parent refetch `models-status`) instead of a local `doDetect`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/kokoro-install.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Repeat for VenvBootstrap, QwenInstall, CoquiInstall**

- `VenvBootstrap`: prop `status: { installedOnDisk; pythonFound; process }`. Ready render when `installedOnDisk`. When `!installedOnDisk && !pythonFound` → manual instructions; when `!installedOnDisk && pythonFound` → setup CTA. The `process` axis drives a NEW separate liveness pill rendered by `step-models.tsx` (Task 7), NOT inside this card — this card is disk-only. Rewrite `venv-bootstrap.test.tsx` accordingly.
- `QwenInstall` / `CoquiInstall`: same engine-card shape as Kokoro (`status: { state; packageBroken }`), same five branches. Rewrite their tests.

Write the failing test first for each, watch it fail, implement, watch it pass — one card per commit.

- [ ] **Step 6: Run the full card suite**

Run: `npx vitest run src/components/kokoro-install.test.tsx src/components/venv-bootstrap.test.tsx src/components/qwen-install.test.tsx src/components/coqui-install.test.tsx`
Expected: PASS (all).

- [ ] **Step 7: Commit (one per card, or one cohesive commit)**

```bash
git add src/components/kokoro-install.tsx src/components/kokoro-install.test.tsx
git commit -m "refactor(frontend): make KokoroInstall a controlled card (status via prop)"
# …and the same for venv/qwen/coqui…
```

---

## Task 7: `step-models.tsx` — one fetch feeds badges + cards

Fetch `models-status` once; derive the summary badges AND each card's `status` prop from it; render the neutral `starting` liveness pill; refetch on any card's completion/re-check.

**Files:**
- Create: `src/components/setup/engine-card-status.ts` (+ test) — pure helpers.
- Modify: `src/components/setup/step-models.tsx`
- Modify: `src/components/setup/step-models.test.tsx`

**Interfaces:**
- Consumes: `api.getModelsStatus` (Task 5); the controlled cards (Task 6); `ModelsStatus` (Task 5).
- Produces: `classifyBlocker(status): 'ok' | 'attention' | 'pending'` and `runtimeBadgeLabel(runtime)` in `engine-card-status.ts`.

- [ ] **Step 1: Write the failing pure-helper test**

```ts
// src/components/setup/engine-card-status.test.ts
import { describe, it, expect } from 'vitest';
import { runtimeIsBlocking, runtimeLivenessPill } from './engine-card-status';

describe('runtime liveness classification', () => {
  it('transient starting is NOT a blocker (neutral)', () => {
    expect(runtimeIsBlocking({ installedOnDisk: true, pythonFound: true, process: 'starting' })).toBe(false);
    expect(runtimeLivenessPill({ installedOnDisk: true, pythonFound: true, process: 'starting' })).toEqual({ tone: 'neutral', label: expect.stringMatching(/starting/i) });
  });
  it('down/crashed ARE blockers', () => {
    expect(runtimeIsBlocking({ installedOnDisk: true, pythonFound: true, process: 'crashed' })).toBe(true);
  });
  it('not-installed-on-disk IS a blocker regardless of process', () => {
    expect(runtimeIsBlocking({ installedOnDisk: false, pythonFound: true, process: 'down' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/setup/engine-card-status.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Implement the helpers**

```ts
// src/components/setup/engine-card-status.ts
import type { ModelsStatus } from '../../lib/api';

type Runtime = ModelsStatus['runtime'];

/** Installed-on-disk is the real setup gate; a transient 'starting' process is
    NOT a blocker (it self-resolves). 'down'/'crashed' are. */
export function runtimeIsBlocking(r: Runtime): boolean {
  if (!r.installedOnDisk) return true;
  return r.process === 'down' || r.process === 'crashed';
}

export function runtimeLivenessPill(r: Runtime): { tone: 'neutral' | 'alarm'; label: string } | null {
  if (!r.installedOnDisk) return null; // the card, not a pill, tells the "set up" story
  if (r.process === 'starting') return { tone: 'neutral', label: 'Voice engine starting…' };
  if (r.process === 'down') return { tone: 'alarm', label: 'Voice engine not running' };
  if (r.process === 'crashed') return { tone: 'alarm', label: 'Voice engine crashed' };
  return null; // ready → no pill
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/setup/engine-card-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `StepModels` to fetch + derive**

`StepModels` currently takes `{ readiness, onRefetch }`. Add a `models-status` fetch (via `useEffect` + `api.getModelsStatus`, with a `refetch` callback that re-runs it), keep taking `readiness` for the aggregate badge. Pass `status={models.engines.kokoro}` to `<KokoroInstall>`, `status={models.runtime}` to `<VenvBootstrap>`, etc. Render `runtimeLivenessPill(models.runtime)` as a separate pill near the runtime card. Wire each card's `onInstalled`/`onBootstrapped` to BOTH `onRefetch` (readiness → badges) AND the local `models-status` refetch. Change the runtime summary badge label to "Runtime installed" driven by `models.runtime.installedOnDisk`.

- [ ] **Step 6: Write the three regression tests in `step-models.test.tsx`**

```tsx
// mock api.getModelsStatus per case
it('weights-missing: card wording matches the badge (no "not installed")', async () => {
  // getModelsStatus → engines.kokoro.state='weights-missing'
  // assert card shows "voice weights not downloaded" AND no "Kokoro is not installed"
});
it('starting: runtime shows a neutral pill, not an amber blocker, over the installed card', async () => {
  // runtime.process='starting', installedOnDisk=true → neutral "starting…" pill + green "Runtime installed"
});
it('broken coqui shows on its own card while the summary is green (kokoro usable)', async () => {
  // engines.kokoro.state='ready', engines.coqui={state:'ready',packageBroken:true}
  // assert coqui card shows repair; summary/aggregate not amber
});
```
Fill each with the concrete `api.getModelsStatus` mock and RTL assertions.

- [ ] **Step 7: Run the step-models suite**

Run: `npx vitest run src/components/setup/step-models.test.tsx src/components/setup/engine-card-status.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/setup/engine-card-status.ts src/components/setup/engine-card-status.test.ts src/components/setup/step-models.tsx src/components/setup/step-models.test.tsx
git commit -m "feat(frontend): derive Models-step badges + cards from one models-status fetch"
```

---

## Task 8: Summary board neutral `pending` + model-manager migration

**Files:**
- Modify: `src/components/setup/setup-wizard.tsx` (`buildSummaryRows` — the "Voice engines" row must not read `starting` as `attention`).
- Modify: `src/views/model-manager.tsx` + `src/views/model-manager.test.tsx` (feed the controlled cards their `status`).

- [ ] **Step 1: Failing test — summary row neutral on starting**

Add to the wizard test (`setup-wizard.test.tsx`): when `readiness.blockers.sidecar.cause === 'unreachable-transient'`, the Voice-engines summary row status is not `'attention'` (it's `'ok'`/neutral). Assert `data-status` on `setup-summary-row-voice`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/setup/setup-wizard.test.tsx`
Expected: FAIL — transient currently makes `voiceOk=false` → `attention`.

- [ ] **Step 3: Fix `buildSummaryRows`**

Treat `blockers.sidecar.cause === 'unreachable-transient'` as non-attention for the voice row:
```ts
const sidecarBlocking = blockers.sidecar.status === 'fail' && blockers.sidecar.cause !== 'unreachable-transient';
const voiceOk = !sidecarBlocking && blockers.tts.status === 'pass';
const voiceDetail = voiceOk
  ? 'Runtime + default voice ready'
  : (sidecarBlocking ? blockers.sidecar.message : blockers.tts.message);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/setup/setup-wizard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Migrate model-manager to feed card status**

`model-manager.tsx` renders `INSTALLER_BY_ID[id]` with `{ onInstalled }`. It already polls inventory every 30s — add a `models-status` fetch on that same cadence, and pass `status={modelsStatus.engines[id]}` into each engine card (map its inventory id → the `'kokoro'|'qwen'|'coqui'` key; skip `whisper` — WhisperInstall is out of this migration and keeps self-fetch, OR give it a follow-up; note it explicitly). Rewrite `model-manager.test.tsx` mocks to provide `api.getModelsStatus`.

> **Whisper note:** `WhisperInstall` is in `INSTALLER_BY_ID` but is ASR, not a voice engine, and is excluded from `models-status`. Leave `WhisperInstall` self-fetching (unchanged) — the controlled migration is voice-engines-only. State this in the regression plan.

- [ ] **Step 6: Run model-manager + full frontend suite**

Run: `npx vitest run src/views/model-manager.test.tsx` then `npm test`
Expected: PASS. (Per the "run FULL frontend suite before push" note — a shared component's new on-mount API call can break distant view-test mocks; run the whole suite.)

- [ ] **Step 7: Commit**

```bash
git add src/components/setup/setup-wizard.tsx src/components/setup/setup-wizard.test.tsx src/views/model-manager.tsx src/views/model-manager.test.tsx
git commit -m "feat(frontend): neutral transient runtime in summary; migrate model-manager to models-status"
```

---

## Task 9: E2E + regression plan + release notes

**Files:**
- Create: `e2e/setup-models-status.spec.ts`
- Create: `docs/features/<next-number>-wizard-models-status.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`

- [ ] **Step 1: E2E golden path**

In mock mode (the mock `getModelsStatus` returns kokoro `ready`), drive to the wizard Models step and assert the badge + card agree (no element with "not installed" while a badge says installed; runtime "installed" is present). Model the spec's file after an existing `e2e/*.spec.ts`. To exercise the weights-missing contradiction case specifically, add a mock variant or a query param the mock honors (follow the existing mock-scenario pattern in `src/mocks`).

- [ ] **Step 2: Run e2e**

Run: `npm run test:e2e -- setup-models-status`
Expected: PASS.

- [ ] **Step 3: Write the regression plan**

From `docs/features/TEMPLATE.md`: invariants (single source of truth; per-engine no-masking; neutral transient; re-check refreshes badge; `packageBroken` sidecar-up-only; Whisper excluded), the manual acceptance walkthrough (force a weights-missing Kokoro; confirm badge+card agree), and the automated coverage list (Tasks 1–8 tests + this e2e). `status: active`.

- [ ] **Step 4: Release notes (both files)**

- `docs/release-notes-next.md`: a technical entry, PR-refed, "Setup wizard Models step now reports one consistent voice-engine status (single `models-status` source); fixes #1612."
- `RELEASE_NOTES.md` (top in-progress version, brand voice): e.g. "Setup now tells you the truth about your voice engines — one clear status, no more 'installed' and 'not installed' on the same screen."

- [ ] **Step 5: INDEX + typecheck + fast battery**

Add the plan to `docs/features/INDEX.md` under its area.
Run: `npm run verify:fast:branch`
Expected: PASS (lint, typecheck, tests, build — scope-gated).

- [ ] **Step 6: Commit**

```bash
git add e2e/setup-models-status.spec.ts docs/features/<n>-wizard-models-status.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "test(e2e): models-status badge/card consistency; docs(docs): regression plan + release notes"
```

---

## Self-Review

**1. Spec coverage (Part A sections):**
- Single canonical server computation → Tasks 1–3. ✓
- `deriveEngineHealth` reuse + `package-missing` preserved → Task 2 (test asserts it). ✓
- Registry (installable voice engines, whisper/gemini/piper excluded) → Task 1. ✓
- Readiness badges derived from the same computation + `vramTotalMb` surfaced → Task 4. ✓
- Runtime two-axis (installed vs process), neutral `starting` → Tasks 7 (pill) + 8 (summary). ✓
- Kokoro card renders `state` verbatim incl. weights-missing/package-missing/packageBroken → Task 6. ✓
- Controlled cards + model-manager migration + enumerated test rewrites → Tasks 6, 8. ✓
- Re-check refreshes the badge → Task 6 (Re-check → onInstalled → parent refetch) + Task 7 wiring. ✓
- Per-engine no-masking → Task 2 test + Task 7 test. ✓
- Honesty limit / `packageBroken` sidecar-up-only → encoded in Task 2 (`importable===false` only) + regression plan. ✓
- Tests (server unit, frontend, e2e) + regression plan + release notes → Tasks 1–9. ✓

**2. Placeholder scan:** The card-render branches in Task 6 Step 3 use `/* … */` describing exact copy — these are transformation notes over EXISTING markup the implementer is editing in place (the current file already contains the markup), not net-new invented code. Every NEW module (Tasks 1–3, 5, 7 helpers) has complete literal code. Acceptable.

**3. Type consistency:** `EngineHealthState` (5-state) is used identically in server (`engine-health.ts`) and client (`api.ts` Task 5). `ModelsStatus.engines` keyed on `'kokoro'|'qwen'|'coqui'` throughout. `runtime.process` is `RuntimeProcessState` in both. `computeModelsStatus` (route) vs `buildModelsStatus` (pure) are distinct and consistently referenced (Task 3 exports `computeModelsStatus`; Task 4 consumes it). ✓

**Fixed inline:** none needed.

---

## Notes for the implementer

- **`WhisperInstall` stays self-fetching** — it's ASR, excluded from `models-status`. Don't migrate it.
- **Coqui `loaded`** comes from the generic `modelLoaded` (`model_loaded`) health flag, not a `coquiLoaded` field (there isn't one).
- **Run the FULL frontend suite** (`npm test`) before pushing — a shared component (the cards) gaining a required prop / the parent gaining an on-mount fetch can break distant view-test mocks (see the project's known-gotcha register).
- **Do not consolidate** the codebase's other engine lists (`ALL_TTS_ENGINES`, `TRACKED_ENGINES`, etc.) — out of scope; the new registry is for this surface only.
