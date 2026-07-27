# GPU device-list boot warm + codec device-knob parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Qwen codec honour a `cuda-uuid:` device pin, and warm the Node-side GPU device-list cache from a server-owned boot loop instead of depending on a frontend HTTP request.

**Architecture:** Six tasks. Tasks 1–2 harden the two pieces of shared state a new concurrent writer would otherwise destabilise (the device-list cache, and the sidecar health probe's side effects). Task 3 adds the warm module itself. Task 4 wires it into boot and de-duplicates the existing warmer. Task 5 pins the `buildSidecarEnv` contract under both cache states. Task 6 is the independent sidecar fix and can be done at any point.

**Tech Stack:** TypeScript (Node/Express, ESM, `.js` import specifiers), Vitest for server tests; Python 3.12 + FastAPI for the TTS sidecar, pytest for its tests.

**Spec:** `docs/superpowers/specs/2026-07-27-gpu-device-list-boot-warm-design.md`

## Global Constraints

- Worktree: `C:\Claude\Projects\Audiobook-Generator\.claude\worktrees\fix+1857-gpu-device-cache-boot-warm`, branch `fix/1857-gpu-device-cache-boot-warm`. Run every command from there; never `cd` to the main checkout.
- Server imports use ESM `.js` specifiers even for TypeScript sources (`./gpu-device-list-state.js`).
- `gpu/**` must never import from `routes/**` — including type-only imports, which still count as cycle edges. Cross-layer access goes through the registered-provider gates in `gpu/*-gate.ts`.
- Commit messages follow Conventional Commits with a scope (`fix(server): …`, `test(server): …`, `fix(sidecar): …`). Every commit body ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
  ```
- Server tests: `npm --prefix server run test -- <path>` from the worktree root, where `<path>` is relative to `server/` (e.g. `src/gpu/foo.test.ts`, **not** `server/src/gpu/foo.test.ts`). `server/vitest.config.ts` has `include: src/**`, resolved against whatever cwd vitest runs in — so `npx vitest run --config server/vitest.config.ts server/src/...` from the worktree root resolves `src/**` against the *frontend* tree, matches nothing, and exits 1 with "No test files found". Verified by running it.
- Sidecar tests: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/<file> -v`.
- No task requires a GPU. Every test added here runs on a CPU-only box.

## File Structure

| File | Responsibility |
|---|---|
| `server/src/gpu/gpu-device-list-state.ts` (modify) | Owns the cached uuid↔idx list. Gains the no-downgrade invariant + a test reset seam. |
| `server/src/gpu/gpu-device-list-state.test.ts` (create) | Pins the no-downgrade invariant. |
| `server/src/gpu/sidecar-health-gate.ts` (modify) | Zero-import leaf gate. Gains a second provider slot for `devices_state` only. |
| `server/src/routes/sidecar-health.ts` (modify) | Gains a `recordState` opt to suppress its three cache writes; registers the new provider. |
| `server/src/gpu/warm-device-list.ts` (create) | Idempotent warm helper + bounded retry loop. |
| `server/src/gpu/warm-device-list.test.ts` (create) | Covers dedup, retry, stop conditions. |
| `server/src/routes/config.ts` (modify) | Drops its private warmer, imports the shared one. |
| `server/src/index.ts` (modify) | Starts the warm loop at boot. |
| `server/src/tts/sidecar-env.test.ts` (modify) | Pins `buildSidecarEnv` under warm and cold caches. |
| `server/tts-sidecar/main.py` (modify) | Routes `QWEN_CODEC_DEVICE` through `_read_device_env`. |
| `server/tts-sidecar/tests/test_device_parse.py` (modify) | Pins codec UUID resolution. |

---

### Task 1: No-downgrade rule in the device-list state module

An empty device list must never overwrite a warm cache — otherwise the boot loop added in Task 3, racing `GET /api/gpu/devices` and `toUuidForm`, can flip resolved UUID pins back to `uuid_unresolved` during a sidecar recycle.

**Files:**
- Modify: `server/src/gpu/gpu-device-list-state.ts:15-23`
- Create: `server/src/gpu/gpu-device-list-state.test.ts`
- Modify: `server/src/routes/config.test.ts:344,350,383,387`
- Modify: `server/src/routes/gpu-devices.test.ts:10,25`

**Interfaces:**
- Produces: `setLastKnownGpuDevices(devices: GpuDeviceInfo[]): void` (unchanged signature, new guard), `_resetGpuDeviceListForTests(): void`, `getLastKnownGpuDevices(): GpuDeviceInfo[]` (unchanged).

- [ ] **Step 1: Write the failing test**

Create `server/src/gpu/gpu-device-list-state.test.ts`:

```ts
/* Pins the no-downgrade invariant (#1857): once the device list is warm, an
   empty list never replaces it. Three writers reach this setter — the boot
   warm loop (gpu/warm-device-list.ts), GET /api/gpu/devices, and toUuidForm on
   a PUT — and a transient empty from any of them would otherwise unpin every
   cuda-uuid: assignment until something re-warmed the cache. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setLastKnownGpuDevices,
  getLastKnownGpuDevices,
  _resetGpuDeviceListForTests,
} from './gpu-device-list-state.js';

describe('setLastKnownGpuDevices no-downgrade rule', () => {
  beforeEach(() => {
    _resetGpuDeviceListForTests();
  });

  it('stores a non-empty list', () => {
    setLastKnownGpuDevices([{ uuid: 'GPU-1', idx: 1 }]);
    expect(getLastKnownGpuDevices()).toEqual([{ uuid: 'GPU-1', idx: 1 }]);
  });

  it('ignores an empty list when the cache is already warm', () => {
    setLastKnownGpuDevices([{ uuid: 'GPU-1', idx: 1 }]);
    setLastKnownGpuDevices([]);
    expect(getLastKnownGpuDevices()).toEqual([{ uuid: 'GPU-1', idx: 1 }]);
  });

  it('accepts an empty list when the cache is already empty (no-op)', () => {
    setLastKnownGpuDevices([]);
    expect(getLastKnownGpuDevices()).toEqual([]);
  });

  it('always replaces a warm cache with another non-empty list', () => {
    setLastKnownGpuDevices([{ uuid: 'GPU-1', idx: 1 }]);
    setLastKnownGpuDevices([{ uuid: 'GPU-2', idx: 0 }]);
    expect(getLastKnownGpuDevices()).toEqual([{ uuid: 'GPU-2', idx: 0 }]);
  });

  it('_resetGpuDeviceListForTests clears a warm cache', () => {
    setLastKnownGpuDevices([{ uuid: 'GPU-1', idx: 1 }]);
    _resetGpuDeviceListForTests();
    expect(getLastKnownGpuDevices()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- src/gpu/gpu-device-list-state.test.ts`
Expected: FAIL — `_resetGpuDeviceListForTests` is not exported, and "ignores an empty list when the cache is already warm" returns `[]`.

- [ ] **Step 3: Add the guard and the reset seam**

In `server/src/gpu/gpu-device-list-state.ts`, replace the setter and add the reset:

```ts
/** Store the live device list. An EMPTY list never replaces a warm one
    (#1857): `_enumerate_cuda_devices` in the sidecar returns [] both for "no
    CUDA cards" and for "torch isn't imported yet / the probe raised", so a
    transient empty during a sidecar recycle is indistinguishable from a real
    one. Three writers reach this setter — the boot warm loop, GET
    /api/gpu/devices, and toUuidForm — and downgrading here would flip every
    resolved 'cuda-uuid:' pin to staleReason:'uuid_unresolved' and make
    buildSidecarEnv emit raw literals after having emitted indices. The
    tradeoff is deliberate: a genuinely-unplugged card keeps serving its last
    known mapping (same staleness contract as vram-state.ts, see file header). */
export function setLastKnownGpuDevices(devices: GpuDeviceInfo[]): void {
  if (devices.length === 0 && lastKnownGpuDevices.length > 0) return;
  lastKnownGpuDevices = devices;
}

/** Test seam — the ONLY way to clear a warm cache, since the setter above
    deliberately ignores an empty list. */
export function _resetGpuDeviceListForTests(): void {
  lastKnownGpuDevices = [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- src/gpu/gpu-device-list-state.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Migrate the three existing empty-reset call sites**

These pass `[]` to mean "reset", which is now a no-op and would make their cold-cache assertions pass for the wrong reason (or fail outright when an earlier test in the file left the cache warm).

In `server/src/routes/config.test.ts`, at lines 344 and 383 change the dynamic import, and at 350 and 387 change the call:

```ts
// line 344 and line 383 — was: const { setLastKnownGpuDevices } = await import(...)
const { _resetGpuDeviceListForTests } = await import('../gpu/gpu-device-list-state.js');

// line 350 and line 387 — was: setLastKnownGpuDevices([]);
_resetGpuDeviceListForTests();
```

Leave line 370/374 alone — that test sets a non-empty list and is unaffected.

In `server/src/routes/gpu-devices.test.ts`, line 10 and line 25. **Drop
`setLastKnownGpuDevices` from the import** — line 25 is its only use in the file,
so keeping it would leave an unused binding and fail lint/typecheck.
`getLastKnownGpuDevices` stays; it is still used at line 87.

```ts
// line 10 — was: import { setLastKnownGpuDevices, getLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';
import {
  getLastKnownGpuDevices,
  _resetGpuDeviceListForTests,
} from '../gpu/gpu-device-list-state.js';

// line 25, inside beforeEach — was: setLastKnownGpuDevices([]);
_resetGpuDeviceListForTests();
```

In `server/src/routes/config.test.ts` the setter is imported dynamically inside
each test, so removing it from the two dynamic imports at 344 and 383 leaves
nothing dangling. The test at 370/374 keeps its own `setLastKnownGpuDevices`
import — it passes a non-empty list.

- [ ] **Step 6: Run the affected suites**

Run: `npm --prefix server run test -- src/gpu/gpu-device-list-state.test.ts src/routes/config.test.ts src/routes/gpu-devices.test.ts`
Expected: PASS, all three files green.

- [ ] **Step 7: Commit**

```bash
git add server/src/gpu/gpu-device-list-state.ts server/src/gpu/gpu-device-list-state.test.ts server/src/routes/config.test.ts server/src/routes/gpu-devices.test.ts
git commit -F - <<'EOF'
fix(server): never downgrade a warm GPU device list to empty

Refs #1857

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
EOF
```

---

### Task 2: Side-effect-free `devices_state` accessor

The warm loop needs the sidecar's `devices_state` to tell "no CUDA cards" from "torch still importing". The obvious route, `probeSidecarHealthIfRegistered()`, would drag three cache writes (`setLastKnownQwenInstallState`, `setLastKnownVram`, `setLastKnownEngineDevices`) into a boot timer that runs while the supervisor is deciding what to spawn.

**Files:**
- Modify: `server/src/gpu/sidecar-health-gate.ts:45-58`
- Modify: `server/src/routes/sidecar-health.ts:235`, `:263-268`, `:331`
- Create: `server/src/routes/sidecar-health-record-state.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `probeSidecarHealth(opts?: { recordState?: boolean }): Promise<SidecarHealthResult>`; `type DeviceProbeState = 'pending' | 'ready' | 'error'`; `setDeviceProbeStateProvider(fn: () => Promise<DeviceProbeState | null>): void`; `probeDeviceProbeStateIfRegistered(): Promise<DeviceProbeState | null>`.

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/sidecar-health-record-state.test.ts`. **Its own file,
not appended to `sidecar-health.test.ts`:** asserting "these setters were NOT
called" requires the state modules to be mocked, and mocking them wholesale
inside that file would change what every pre-existing test there exercises.
`vi.spyOn` on the shared file is not an option either — `server/vitest.config.ts`
sets no `restoreMocks`, so spies would leak across its tests.

```ts
/* #1857 — probeSidecarHealth({ recordState: false }) parses identically but
   performs NONE of its three last-known-state writes, so the boot-time GPU
   device-list warm loop can read devices_state without moving Qwen install
   state / VRAM / per-engine device ground truth while the supervisor is still
   deciding what to spawn. Also pins that sidecar-health.ts actually REGISTERS
   the non-recording probe with the gate at module init — without that, the
   warm loop's early exit silently degrades to "always null, always retry". */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../tts/sidecar-supervisor.js', () => ({
  getActiveSupervisor: vi.fn(() => null),
  registerActiveSupervisor: vi.fn(),
  createSidecarSupervisor: vi.fn(),
}));
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));
/* All three use the importOriginal SPREAD, not a bare factory. vi.mock replaces
   the module for every importer in this test's graph, and each of these has
   other live consumers: vram-state also exports getLastKnownVram (analyzer/
   ollama.ts, routes/ollama-health.ts), engine-device-state also exports
   getLastKnownEngineDevice + _resetEngineDevicesForTests (gpu/engine-device.ts),
   and user-settings exports most of the settings surface. A bare factory
   listing only the setter would kill the import with "does not provide an
   export named …". Spread first, override the one setter. */
vi.mock('../gpu/vram-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/vram-state.js')>()),
  setLastKnownVram: vi.fn(),
}));
vi.mock('../gpu/engine-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/engine-device-state.js')>()),
  setLastKnownEngineDevices: vi.fn(),
}));
vi.mock('../workspace/user-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/user-settings.js')>()),
  setLastKnownQwenInstallState: vi.fn(),
}));

import { probeSidecarHealth } from './sidecar-health.js';
import { probeDeviceProbeStateIfRegistered } from '../gpu/sidecar-health-gate.js';
import { setLastKnownVram } from '../gpu/vram-state.js';
import { setLastKnownEngineDevices } from '../gpu/engine-device-state.js';
import { setLastKnownQwenInstallState } from '../workspace/user-settings.js';

const fetchMock = vi.fn();

function okHealth() {
  return new Response(
    JSON.stringify({
      model_loaded: true,
      vram_total_mb: 16000,
      devices: { qwen: 'cuda' },
      devices_state: 'ready',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(setLastKnownVram).mockClear();
  vi.mocked(setLastKnownEngineDevices).mockClear();
  vi.mocked(setLastKnownQwenInstallState).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeSidecarHealth recordState opt', () => {
  it('records last-known state by default', async () => {
    fetchMock.mockResolvedValue(okHealth());

    const res = await probeSidecarHealth();

    expect(res.status).toBe('reachable');
    expect(res.devicesState).toBe('ready');
    expect(setLastKnownVram).toHaveBeenCalled();
    expect(setLastKnownEngineDevices).toHaveBeenCalled();
    expect(setLastKnownQwenInstallState).toHaveBeenCalled();
  });

  it('performs no state writes when recordState is false, but parses the same result', async () => {
    fetchMock.mockResolvedValue(okHealth());

    const res = await probeSidecarHealth({ recordState: false });

    expect(res.status).toBe('reachable');
    expect(res.devicesState).toBe('ready');
    expect(res.vramTotalMb).toBe(16000);
    expect(setLastKnownVram).not.toHaveBeenCalled();
    expect(setLastKnownEngineDevices).not.toHaveBeenCalled();
    expect(setLastKnownQwenInstallState).not.toHaveBeenCalled();
  });
});

describe('device-probe-state provider registration', () => {
  it('is registered by importing sidecar-health.ts, and does not record state', async () => {
    fetchMock.mockResolvedValue(okHealth());

    // Not null => sidecar-health.ts called setDeviceProbeStateProvider at init.
    await expect(probeDeviceProbeStateIfRegistered()).resolves.toBe('ready');
    expect(setLastKnownVram).not.toHaveBeenCalled();
  });

  it('resolves null when the sidecar is unreachable, so the warm loop keeps waiting', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(probeDeviceProbeStateIfRegistered()).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- src/routes/sidecar-health-record-state.test.ts`
Expected: FAIL — `probeSidecarHealth` takes no arguments (so the `recordState: false` test still sees all three writes), and `probeDeviceProbeStateIfRegistered` is not exported from the gate.

- [ ] **Step 3: Add the opt to `probeSidecarHealth`**

In `server/src/routes/sidecar-health.ts`, change the signature at line 235 and guard the three writes at 263-268:

```ts
/** Options for {@link probeSidecarHealth}. */
export interface ProbeSidecarHealthOpts {
  /** When false, parse and return exactly as normal but perform NONE of the
      three last-known-state writes below. Used by the boot-time GPU
      device-list warm loop (gpu/warm-device-list.ts), which needs
      `devices_state` while the supervisor is still deciding what to spawn —
      letting a background timer move Qwen install state there could change
      which model the first spawn preloads (index.ts seeds it from a DISK
      probe for exactly that reason). Defaults to true: every other caller,
      including the /health route the UI polls, still records. */
  recordState?: boolean;
}

export async function probeSidecarHealth(
  opts: ProbeSidecarHealthOpts = {},
): Promise<SidecarHealthResult> {
  const { recordState = true } = opts;
```

and:

```ts
    const devices = normaliseDevices(body.devices);
    if (recordState) {
      setLastKnownQwenInstallState(qwenInstallState);
      setLastKnownVram({
        totalMb: typeof body.vram_total_mb === 'number' ? body.vram_total_mb : null,
      });
      setLastKnownEngineDevices(devices);
    }
```

(Move the `const devices = …` line above the block, as shown — the returned object still uses it.)

- [ ] **Step 4: Add the provider slot to the gate**

Append to `server/src/gpu/sidecar-health-gate.ts`:

```ts
/** The sidecar's startup device-probe state: 'pending' until torch finishes
    importing in the background, 'ready' once it has, 'error' when torch is
    missing or the probe raised. Spelled locally rather than imported from
    routes/sidecar-health.ts for the same cycle reason as
    SidecarHealthSnapshot above — a type-only import is still an edge. */
export type DeviceProbeState = 'pending' | 'ready' | 'error';

let deviceProbeStateProvider: (() => Promise<DeviceProbeState | null>) | null = null;

/** Registered by routes/sidecar-health.ts with a NON-recording probe — the
    caller (the boot warm loop) must not perturb last-known Qwen/VRAM/device
    state just by asking whether the device probe has settled. */
export function setDeviceProbeStateProvider(
  fn: () => Promise<DeviceProbeState | null>,
): void {
  deviceProbeStateProvider = fn;
}

/** Resolves to the sidecar's device-probe state, or `null` when nothing has
    registered or the sidecar is unreachable — fail closed (see file header):
    `null` means "can't tell", and callers must treat it as "keep waiting",
    never as "settled". */
export async function probeDeviceProbeStateIfRegistered(): Promise<DeviceProbeState | null> {
  if (!deviceProbeStateProvider) return null;
  return deviceProbeStateProvider();
}
```

- [ ] **Step 5: Register it**

In `server/src/routes/sidecar-health.ts`, next to line 331:

```ts
import {
  setProbeSidecarHealthProvider,
  setDeviceProbeStateProvider,
} from '../gpu/sidecar-health-gate.js';

// …at the bottom, beside the existing registration:
setProbeSidecarHealthProvider(probeSidecarHealth);
setDeviceProbeStateProvider(() =>
  probeSidecarHealth({ recordState: false }).then((r) => r.devicesState ?? null),
);
```

- [ ] **Step 6: Run tests**

Run: `npm --prefix server run test -- src/routes/sidecar-health-record-state.test.ts src/routes/sidecar-health.test.ts`
Expected: PASS — the four new tests, plus every pre-existing test in the original file unchanged.

**If the new file fails on a mock-resolution error rather than an assertion,
re-run once before debugging.** This repo has a recorded intermittent failure
with `importOriginal`-based mocks that clears on a re-run. A *consistent*
failure is a real defect; a one-off is the known flake.

- [ ] **Step 7: Commit**

```bash
git add server/src/gpu/sidecar-health-gate.ts server/src/routes/sidecar-health.ts server/src/routes/sidecar-health-record-state.test.ts
git commit -F - <<'EOF'
feat(server): side-effect-free devices_state accessor for the health gate

Refs #1857

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
EOF
```

---

### Task 3: The warm module

**Files:**
- Create: `server/src/gpu/warm-device-list.ts`
- Create: `server/src/gpu/warm-device-list.test.ts`

**Interfaces:**
- Consumes: `setLastKnownGpuDevices`, `getLastKnownGpuDevices`, `_resetGpuDeviceListForTests` (Task 1); `probeDeviceProbeStateIfRegistered`, `DeviceProbeState` (Task 2); `fetchSidecarDevices` from `./fetch-sidecar-devices.js` (existing).
- Produces: `ensureGpuDeviceListWarm(): Promise<void>`; `runGpuDeviceListWarmup(opts?: WarmupOpts): Promise<void>`; `startGpuDeviceListWarmup(opts?: WarmupOpts): void`; `_resetWarmDeviceListForTests(): void`; `interface WarmupOpts { maxAttempts?: number; attemptDelayMs?: number; log?: (msg: string) => void; delayFn?: (ms: number) => Promise<void> }`.

- [ ] **Step 1: Write the failing test**

Create `server/src/gpu/warm-device-list.test.ts`:

```ts
/* #1857 — the GPU device-list cache had exactly one warmer, GET /api/config,
   so nothing warmed it until the user opened Advanced settings. These cover
   the server-owned replacement: dedup, retry, and the two stop conditions. */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./fetch-sidecar-devices.js', () => ({ fetchSidecarDevices: vi.fn() }));
vi.mock('./sidecar-health-gate.js', () => ({
  probeDeviceProbeStateIfRegistered: vi.fn(async () => null),
}));

import { fetchSidecarDevices } from './fetch-sidecar-devices.js';
import { probeDeviceProbeStateIfRegistered } from './sidecar-health-gate.js';
import {
  ensureGpuDeviceListWarm,
  runGpuDeviceListWarmup,
  _resetWarmDeviceListForTests,
} from './warm-device-list.js';
import {
  getLastKnownGpuDevices,
  _resetGpuDeviceListForTests,
} from './gpu-device-list-state.js';

const mockFetch = vi.mocked(fetchSidecarDevices);
const mockState = vi.mocked(probeDeviceProbeStateIfRegistered);

const ONE_CARD = {
  devices: [{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }],
  cpu: true,
};
const NO_CARDS = { devices: [], cpu: true };

/* delayFn is replaced so the retry loop never actually waits — the tests
   assert attempt COUNTS, not wall-clock behaviour. */
const noWait = async () => {};

beforeEach(() => {
  mockFetch.mockReset();
  mockState.mockReset();
  mockState.mockResolvedValue(null);
  _resetGpuDeviceListForTests();
  _resetWarmDeviceListForTests();
});

describe('ensureGpuDeviceListWarm', () => {
  it('warms a cold cache from a reachable sidecar', async () => {
    mockFetch.mockResolvedValue(ONE_CARD);
    await ensureGpuDeviceListWarm();
    expect(getLastKnownGpuDevices()).toEqual([{ uuid: 'GPU-1', idx: 1 }]);
  });

  it('issues no fetch when the cache is already warm', async () => {
    mockFetch.mockResolvedValue(ONE_CARD);
    await ensureGpuDeviceListWarm();
    mockFetch.mockClear();
    await ensureGpuDeviceListWarm();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('concurrent callers share a single in-flight fetch', async () => {
    mockFetch.mockResolvedValue(ONE_CARD);
    await Promise.all([
      ensureGpuDeviceListWarm(),
      ensureGpuDeviceListWarm(),
      ensureGpuDeviceListWarm(),
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('leaves the cache cold when the sidecar is unreachable', async () => {
    mockFetch.mockResolvedValue(null);
    await ensureGpuDeviceListWarm();
    expect(getLastKnownGpuDevices()).toEqual([]);
  });
});

describe('runGpuDeviceListWarmup', () => {
  it('retries an unreachable sidecar and warms once it answers', async () => {
    mockFetch.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(ONE_CARD);
    await runGpuDeviceListWarmup({ maxAttempts: 5, delayFn: noWait });
    expect(getLastKnownGpuDevices()).toEqual([{ uuid: 'GPU-1', idx: 1 }]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('keeps retrying an empty list while devices_state is pending', async () => {
    mockFetch.mockResolvedValueOnce(NO_CARDS).mockResolvedValue(ONE_CARD);
    mockState.mockResolvedValue('pending');
    await runGpuDeviceListWarmup({ maxAttempts: 5, delayFn: noWait });
    expect(getLastKnownGpuDevices()).toEqual([{ uuid: 'GPU-1', idx: 1 }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('stops early when devices_state is ready with zero cards', async () => {
    mockFetch.mockResolvedValue(NO_CARDS);
    mockState.mockResolvedValue('ready');
    await runGpuDeviceListWarmup({ maxAttempts: 24, delayFn: noWait });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getLastKnownGpuDevices()).toEqual([]);
  });

  it('stops early when devices_state is error', async () => {
    mockFetch.mockResolvedValue(NO_CARDS);
    mockState.mockResolvedValue('error');
    await runGpuDeviceListWarmup({ maxAttempts: 24, delayFn: noWait });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying when no state provider is registered (null)', async () => {
    mockFetch.mockResolvedValue(NO_CARDS);
    mockState.mockResolvedValue(null);
    await runGpuDeviceListWarmup({ maxAttempts: 4, delayFn: noWait });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('exhausts its budget without throwing', async () => {
    mockFetch.mockResolvedValue(null);
    await expect(
      runGpuDeviceListWarmup({ maxAttempts: 3, delayFn: noWait }),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('swallows a throwing fetch and keeps going', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(ONE_CARD);
    await runGpuDeviceListWarmup({ maxAttempts: 3, delayFn: noWait });
    expect(getLastKnownGpuDevices()).toEqual([{ uuid: 'GPU-1', idx: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- src/gpu/warm-device-list.test.ts`
Expected: FAIL — `Cannot find module './warm-device-list.js'`.

- [ ] **Step 3: Write the module**

Create `server/src/gpu/warm-device-list.ts`:

```ts
/* Server-owned warm for the GPU device-list cache (#1857).

   Until PR #1852 the frontend dispatched fetchConfig() at app boot, so every
   page load in any view incidentally warmed this cache. That dispatch existed
   only to hydrate the deleted voices.library.enabled gate; with it gone, all
   three warmers (GET /api/config, GET /api/gpu/devices, and a PUT device
   write) are dispatched from src/views/advanced.tsx alone — so nothing warmed
   the cache until a user opened Advanced settings.

   This does NOT warm before the first spawnSidecar: the only source of the
   uuid<->idx mapping is the sidecar's own GET /devices, and at the initial
   boot spawn that process doesn't exist yet. It doesn't need to. The sidecar
   resolves 'cuda-uuid:<uuid>' itself via _read_device_env ->
   _resolve_uuid_to_index (main.py), which exists precisely because this cache
   is cold at spawn time. This loop is for the NODE-side consumers of a
   resolved device knob, and for the Advanced UI's staleReason reconcile. */

import { fetchSidecarDevices } from './fetch-sidecar-devices.js';
import { getLastKnownGpuDevices, setLastKnownGpuDevices } from './gpu-device-list-state.js';
import { probeDeviceProbeStateIfRegistered } from './sidecar-health-gate.js';

/* Sized to outlast a cold torch import, not a single probe. fetchSidecarDevices
   aborts each attempt at 2s (PROBE_TIMEOUT_MS) and the sidecar's /devices is a
   sync def whose first call triggers `import torch` on FastAPI's threadpool —
   so early attempts WILL abort. That's survivable because the aborted client
   fetch doesn't cancel the server-side import (a running Python thread can't be
   interrupted by a disconnect), so a later attempt lands on a warm module.
   Mirrors runCatalogAudit's 24 x 5s, which solves the same "sidecar takes
   30-60s to come up" problem. */
const DEFAULT_MAX_ATTEMPTS = 24;
const DEFAULT_ATTEMPT_DELAY_MS = 5_000;

export interface WarmupOpts {
  maxAttempts?: number;
  attemptDelayMs?: number;
  log?: (msg: string) => void;
  delayFn?: (ms: number) => Promise<void>;
}

/* Shared in-flight promise so the boot loop and a concurrent GET /api/config
   pay ONE sidecar round-trip rather than two. */
let inFlight: Promise<void> | null = null;

/** Warm the cache if it isn't already. Idempotent, deduped, and NEVER throws —
    GET /api/config awaits this inline (routes/config.ts), so a throw here would
    turn a warm failure into a 500 on the Advanced Settings load. fetchSidecarDevices
    already swallows everything and returns null; the catch is belt-and-braces
    against that contract changing. */
export async function ensureGpuDeviceListWarm(): Promise<void> {
  if (getLastKnownGpuDevices().length > 0) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const result = await fetchSidecarDevices();
      if (result) {
        setLastKnownGpuDevices(result.devices.map((d) => ({ uuid: d.uuid, idx: d.idx })));
      }
    } catch {
      // leave the cache cold; the retry loop (or the next request) tries again
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Test seam — clears the shared in-flight promise. Distinct from
    _resetGpuDeviceListForTests(), which clears the cached list itself. */
export function _resetWarmDeviceListForTests(): void {
  inFlight = null;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    // Never hold the process open on our own — same contract as the other
    // boot-time background timers (see startBackupScheduler in index.ts).
    t.unref?.();
  });
}

/** The retry loop. Exported separately from the fire-and-forget starter so
    tests can await it with an injected delayFn instead of real timers.
    Never throws — a boot-time warm failing must not affect anything else. */
export async function runGpuDeviceListWarmup(opts: WarmupOpts = {}): Promise<void> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    attemptDelayMs = DEFAULT_ATTEMPT_DELAY_MS,
    log = console.log,
    delayFn = defaultDelay,
  } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await ensureGpuDeviceListWarm();
      const cards = getLastKnownGpuDevices();
      if (cards.length > 0) {
        log(`[gpu] device list warm: ${cards.length} card(s) after ${attempt} attempt(s).`);
        return;
      }
      /* An empty list is ambiguous — the sidecar returns [] both for "no CUDA
         cards" and for "torch isn't imported yet / the probe raised". Ask the
         sidecar which it is. Only a SETTLED state ends the loop: 'ready' means
         torch is up and there genuinely are no cards, 'error' means the probe
         failed and won't fix itself. 'pending' and null (unregistered provider,
         or unreachable sidecar) both mean "can't tell yet" — keep waiting. */
      const state = await probeDeviceProbeStateIfRegistered();
      if (state === 'ready' || state === 'error') {
        log(`[gpu] device list warm: sidecar reports no CUDA cards (devices_state=${state}).`);
        return;
      }
    } catch {
      // fall through to the retry — never let a warm failure escape
    }
    if (attempt < maxAttempts) await delayFn(attemptDelayMs);
  }
  log(
    `[gpu] device list warm: gave up after ${maxAttempts} attempt(s) — ` +
      `sidecar never reported a card list. UUID device pins will resolve sidecar-side.`,
  );
}

/** Fire-and-forget starter for the boot path. */
export function startGpuDeviceListWarmup(opts: WarmupOpts = {}): void {
  void runGpuDeviceListWarmup(opts);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- src/gpu/warm-device-list.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/gpu/warm-device-list.ts server/src/gpu/warm-device-list.test.ts
git commit -F - <<'EOF'
feat(server): server-owned GPU device-list warm loop

Refs #1857

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
EOF
```

---

### Task 4: Wire it into boot; de-duplicate the route's private warmer

**Files:**
- Modify: `server/src/routes/config.ts:20-46`
- Modify: `server/src/index.ts` (import block, and `listenerCallback` after line 301)

**Interfaces:**
- Consumes: `ensureGpuDeviceListWarm`, `startGpuDeviceListWarmup` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Replace the route's private warmer with the shared one**

In `server/src/routes/config.ts`, delete the local `ensureGpuDeviceListWarm` function **and** its docblock (lines 26-43). The `GET /` handler's `await ensureGpuDeviceListWarm();` call at line 46 stays exactly as it is — it now resolves to the imported helper.

Import changes, precisely:

- **Line 21, keep unchanged.** `import { fetchSidecarDevices, type SidecarDevicesResponse } from '../gpu/fetch-sidecar-devices.js';` — the `PUT` handler still uses both (lines 82 and 101).
- **Line 22, delete.** `import { getLastKnownGpuDevices, setLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';` — both bindings become unused once the local function is gone.
- **Add**, beside the other `../gpu/` imports:

```ts
import { ensureGpuDeviceListWarm } from '../gpu/warm-device-list.js';
```

Then put a shortened docblock immediately above `configRouter.get('/', …)`, replacing the deleted one:

```ts
/* resolveAll() -> resolveKnob() reconciles a stored 'cuda-uuid:<uuid>' override
   against getLastKnownGpuDevices()'s cache SYNCHRONOUSLY. AdvancedView's mount
   effect fires fetchConfig() and getGpuDevices() concurrently with no ordering,
   and this route is a synchronous local computation that routinely resolves
   BEFORE the sidecar round-trip GET /api/gpu/devices needs — which would
   mislabel a valid uuid pin as staleReason:'uuid_unresolved' on the first
   Advanced Settings load after a restart. Warming here (a no-op once anything
   else has warmed it, including the boot loop) keeps that race closed. See
   gpu/warm-device-list.ts. */
```

**Note:** `fetchSidecarDevices` and `SidecarDevicesResponse` are still used by the `PUT` handler at lines 82 and 101 — keep that import. Only the `gpu-device-list-state.js` import becomes unused.

- [ ] **Step 2: Verify the config route still passes**

Run: `npm --prefix server run test -- src/routes/config.test.ts`
Expected: PASS — identical behaviour, warmer just lives elsewhere now.

- [ ] **Step 3: Start the loop at boot**

In `server/src/index.ts`, add to the import block (near line 48's `initDeviceTotalVram` import):

```ts
import { startGpuDeviceListWarmup } from './gpu/warm-device-list.js';
```

and immediately after `registerActiveSupervisor(sidecarSupervisor);` (line 302), inside `listenerCallback`:

```ts
    /* #1857 — warm the GPU device-list cache from the SERVER, not from a
       frontend request. Until PR #1852 the store's boot fetchConfig() dispatch
       warmed it incidentally on every page load; that dispatch existed only for
       the deleted voices.library.enabled gate, so with it gone nothing warmed
       the cache until a user opened Advanced settings. Started after the
       supervisor so the sidecar it polls is already being spawned; the loop
       retries while the sidecar comes up and stops as soon as it reports a
       settled devices_state. Fire-and-forget and unref'd — it never blocks boot
       and never holds the process open. */
    startGpuDeviceListWarmup();
```

- [ ] **Step 4: Verify boot wiring compiles and the shutdown suite is unaffected**

Run: `npx tsc -p server/tsconfig.json --noEmit`
Expected: no errors.

Run: `npm --prefix server run test -- src/index.test.ts`
Expected: PASS — `index.test.ts` imports the module but the main-module guard keeps `main()` (and therefore `listenerCallback` and the timer) from running.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/config.ts server/src/index.ts
git commit -F - <<'EOF'
fix(server): warm the GPU device list at boot, not on first GET /api/config

Refs #1857

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
EOF
```

---

### Task 5: Pin the `buildSidecarEnv` contract under both cache states

The cold-cache case is **not** a bug — the sidecar resolves the literal itself. This test documents that so the next reader doesn't "fix" it.

**This task is a characterization test, not a TDD cycle.** Both assertions pass
against unmodified production code; there is deliberately no "verify it fails"
step, because there is no behaviour change here to drive. Its value is pinning a
contract that currently exists only as tribal knowledge — #1857 was filed because
a reader saw the cold-cache literal and reasonably concluded it was a defect.

**Files:**
- Modify: `server/src/tts/sidecar-env.test.ts`

**Interfaces:**
- Consumes: `_resetGpuDeviceListForTests` (Task 1).

- [ ] **Step 1: Write the test**

Append to `server/src/tts/sidecar-env.test.ts`:

```ts
import {
  setLastKnownGpuDevices,
  _resetGpuDeviceListForTests,
} from '../gpu/gpu-device-list-state.js';

describe('buildSidecarEnv device-knob resolution against the GPU device cache', () => {
  beforeEach(() => {
    _resetGpuDeviceListForTests();
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
    delete process.env.QWEN_DEVICE;
  });

  it('translates a cuda-uuid: pin to an index when the cache is warm', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.qwen.device': 'cuda-uuid:GPU-1',
    });
    setLastKnownGpuDevices([{ uuid: 'GPU-1', idx: 1 }]);

    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });

    expect(env.QWEN_DEVICE).toBe('cuda:1');
  });

  /* CONTRACT, NOT A BUG. With a cold cache resolveKnob can't translate, so the
     raw 'cuda-uuid:' literal is handed to the sidecar — which resolves it
     itself in _read_device_env -> _resolve_uuid_to_index (main.py:1873). That
     Python-side resolution was added FOR this case: the Node cache is
     necessarily empty at the initial boot spawn, because the only source of
     the uuid<->idx mapping is the sidecar process that doesn't exist yet.
     Do not "fix" this by making it assert cuda:N. */
  it('passes the raw cuda-uuid: literal through when the cache is cold', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.qwen.device': 'cuda-uuid:GPU-1',
    });

    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });

    expect(env.QWEN_DEVICE).toBe('cuda-uuid:GPU-1');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm --prefix server run test -- src/tts/sidecar-env.test.ts`
Expected: PASS, both new tests plus the pre-existing ones.

- [ ] **Step 3: Commit**

```bash
git add server/src/tts/sidecar-env.test.ts
git commit -F - <<'EOF'
test(server): pin buildSidecarEnv device resolution under warm and cold caches

Refs #1857

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
EOF
```

---

### Task 6: `QWEN_CODEC_DEVICE` resolves a UUID pin

Independent of Tasks 1–5. `tts.qwen.codecDevice` is the fourth and only `type: 'device'` knob whose env var is read with a bare `os.environ.get`, so a card pinned from the UI is stored as `cuda-uuid:<uuid>`, passes `_validate_cuda_index` (because `_parse_device` reads it as family `cuda` with no index), then fails inside torch's `.to()` and gets rolled back to CPU.

**Files:**
- Modify: `server/tts-sidecar/main.py:2995-2997`
- Modify: `server/tts-sidecar/tests/test_device_parse.py`

**Why this task introduces a named helper.** The production read lives inside
`_load_qwen_model`, which needs real Qwen weights and a GPU to invoke — so a test
cannot reach it. Asserting on a hand-composed
`_resolve_codec_device(_read_device_env(...) or "cpu", ...)` in the test would be
a **placebo**: that expression already returns the right answer today, and would
pass whether or not `main.py:2996` was ever changed. So the fix extracts the
one-line expression into `_codec_device_pref()` and has the production line call
it. The test then exercises the exact function production uses.

- [ ] **Step 1: Write the failing test**

Append to `server/tts-sidecar/tests/test_device_parse.py`:

```python
def test_codec_device_pref_resolves_uuid(monkeypatch):
    """QWEN_CODEC_DEVICE is a type:'device' knob, so a card picked in Advanced
    Settings is persisted as 'cuda-uuid:<uuid>'. _codec_device_pref is what
    _load_qwen_model actually calls, so a UUID must never reach torch raw."""
    monkeypatch.setenv("QWEN_CODEC_DEVICE", "cuda-uuid:GPU-1")
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    assert main._codec_device_pref() == "cuda:1"
    assert main._resolve_codec_device(main._codec_device_pref(), "cuda:0") == "cuda:1"


def test_codec_device_pref_unresolvable_uuid_follows_the_model(monkeypatch):
    """A vanished card degrades to 'auto', which for the codec means "follow
    the model" -- never a different card, and never a CPU demotion."""
    monkeypatch.setenv("QWEN_CODEC_DEVICE", "cuda-uuid:GONE")
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    assert main._codec_device_pref() == "auto"
    assert main._resolve_codec_device(main._codec_device_pref(), "cuda:0") == "cuda:0"


def test_codec_device_pref_unset_still_means_cpu(monkeypatch):
    """Regression guard on the `or 'cpu'` fallback: unset must stay CPU-only,
    i.e. _resolve_codec_device returns None (no move attempted)."""
    monkeypatch.delenv("QWEN_CODEC_DEVICE", raising=False)
    assert main._codec_device_pref() == "cpu"
    assert main._resolve_codec_device(main._codec_device_pref(), "cuda:0") is None


def test_codec_device_pref_passes_through_plain_values(monkeypatch):
    """cpu / auto / cuda:N are unchanged -- no behaviour change for any value
    that already worked."""
    for raw, expected in (("cpu", "cpu"), ("auto", "auto"), ("cuda:1", "cuda:1")):
        monkeypatch.setenv("QWEN_CODEC_DEVICE", raw)
        assert main._codec_device_pref() == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_device_parse.py -v -k codec_device_pref`
Expected: all four FAIL with `AttributeError: module 'main' has no attribute '_codec_device_pref'`.

- [ ] **Step 3: Add the helper and route the production read through it**

In `server/tts-sidecar/main.py`, define the helper immediately after
`_resolve_codec_device` (i.e. after line 403), so it sits beside the function it
feeds:

```python
def _codec_device_pref() -> str:
    """QWEN_CODEC_DEVICE as a resolved device string, defaulting to 'cpu'.

    Goes through _read_device_env like COQUI_DEVICE / KOKORO_DEVICE /
    QWEN_DEVICE, because QWEN_CODEC_DEVICE is a type:'device' knob too --
    PUT /api/config persists a picked card as 'cuda-uuid:<uuid>'. A bare
    os.environ.get (the #1857 bug) let that literal through _validate_cuda_index
    untouched, because _parse_device reads 'cuda-uuid:x' as family cuda with NO
    index and the range check only fires on a concrete index. It then failed
    inside torch's .to() in _move_codec_to_device and got rolled back to CPU --
    so a pinned codec silently ran on the wrong device.

    Named rather than inlined at the call site so it is reachable from tests:
    the call site is inside _load_qwen_model, which needs real weights + a GPU.
    """
    return _read_device_env("QWEN_CODEC_DEVICE") or "cpu"
```

Then replace the call site. **Do not go by line number** — inserting the helper
above shifts it from 2995-2997 to roughly 3010. Find it by content:

```python
        # BEFORE (find this):
        codec_device = _resolve_codec_device(
            os.environ.get("QWEN_CODEC_DEVICE", "cpu"), self._device
        )

        # AFTER:
        codec_device = _resolve_codec_device(_codec_device_pref(), self._device)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_device_parse.py -v`
Expected: PASS, all tests in the file.

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_module_import_order.py -v`
Expected: PASS — `_read_device_env` is reached at module-import time via `ENGINES = {...}`, and this file guards that ordering.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_parse.py
git commit -F - <<'EOF'
fix(sidecar): resolve a cuda-uuid: pin for QWEN_CODEC_DEVICE

Refs #1857

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
EOF
```

---

## Final verification

- [ ] Run the full server suite: `npm run test:server`
- [ ] Run typecheck: `npm run typecheck` (the repo script — root `tsc --noEmit` **and** `npm --prefix server run typecheck`; a bare `npx tsc -p server/tsconfig.json` only covers the second half)
- [ ] Run the sidecar device tests: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_device_parse.py server/tts-sidecar/tests/test_module_import_order.py -v`
- [ ] **Confirm no `gpu/ → routes/` import was introduced.** This repo has **no** cycle checker — `madge` is not a dependency and there is no `import/no-cycle` ESLint rule, so the `gpu/*-gate.ts` pattern is enforced by review alone. Verify by grep instead, which must return nothing:
  ```bash
  grep -rn "from '\.\./routes/" server/src/gpu/
  ```
  The registration test in Task 2 covers the other half — that routing *around* the cycle didn't leave the provider unregistered.
- [ ] Open PR with `Closes #1857` in the body, and post the premise correction (the sidecar already resolves `cuda-uuid:` for the three engine knobs; the issue's acceptance criteria are superseded by the spec's).
