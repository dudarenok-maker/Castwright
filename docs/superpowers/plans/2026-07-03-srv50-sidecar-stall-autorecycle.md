# srv-50 Sidecar Stall Auto-Recycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the TTS sidecar is wedged (not crashed) — evidenced by a readiness-poll exhaustion, a whole-chapter synthesis stall, or an exhausted in-loop recycle budget — force-kill it so the existing exit-driven supervisor respawns a fresh process automatically, instead of leaving a zombie for a human to manually `taskkill`.

**Architecture:** One new shared helper (`forceSidecarRecycle`) in `sidecar-supervisor.ts` that reuses the exact kill primitive `POST /api/sidecar/restart` already uses. Three call sites invoke it: the readiness-poll's exhaustion branch, the chapter-stall watchdog's synthesis-phase branch, and the in-loop recycle-storm branch. A fourth change wraps the previously-unprotected ASR `verify()` closure with the same per-call-timeout + recovery-loop protection every synth call site already has, so a hang there becomes a normal recoverable error instead of hanging forever undetected.

**Tech Stack:** TypeScript, Express, Vitest. No new dependencies.

## Global Constraints

- No new timing constants — reuse the existing 210s readiness budget (`READINESS_TIMEOUT_MS`) and the existing 600s synth-call ceiling (`SYNTH_CALL_TIMEOUT_MS`), per the spec's Decisions 4 and 5.
- No new crash-loop cap logic — every force-recycle is a real process exit through the existing `onChildExit` → backoff → crash-loop-cap path (`sidecar-supervisor.ts`), per spec Decision 1 / Design §6.
- `ChapterStallError` force-recycles ONLY when `stallPhase === 'synthesis'` — never `'assembly'` (spec Decision 2).
- `forceSidecarRecycle` never waits for the respawn to become healthy — it only kills; callers already have their own post-recycle polling (spec Decision 3).
- Full spec: `docs/superpowers/specs/2026-07-03-srv50-sidecar-stall-autorecycle-design.md`. GitHub issue: [#1243](https://github.com/dudarenok-maker/Castwright/issues/1243). Read the spec's "Current state" and "Design" sections before starting — this plan implements them verbatim; if anything here conflicts with the spec, the spec is stale documentation of intent and this plan is the executable source of truth for what to actually type.

---

## File Structure

- **Modify `server/src/tts/sidecar-supervisor.ts`** — add the `forceSidecarRecycle` helper + its synchronous `recycleInFlight` guard. This is the ONLY file that touches process-kill mechanics; every other task just calls this one function.
- **Modify `server/src/tts/sidecar-supervisor.test.ts`** — new `describe('forceSidecarRecycle')` block.
- **Modify `server/src/tts/ensure-sidecar-loaded.ts`** — call `forceSidecarRecycle` on readiness-poll exhaustion.
- **Modify `server/src/tts/ensure-sidecar-loaded.test.ts`** — extend the existing "gives up best-effort" test + add a new one proving no-call-when-resolved-in-time.
- **Modify `server/src/routes/generation.ts`** — call `forceSidecarRecycle` in the `isStall` (synthesis-phase only) and `isRecycleStorm` branches.
- **Modify `server/src/routes/generation-stall-watchdog.test.ts`** — new assertion on the existing synthesis-stall test + a new assembly-phase-does-not-recycle test.
- **Modify `server/src/routes/generation-recycle-recovery.test.ts`** — new assertion on the existing `RecycleStormError` test.
- **Modify `server/src/tts/synthesise-chapter.ts`** — wrap the `verify` closure (both its call sites inherit the fix automatically).
- **Modify `server/src/tts/synthesise-chapter-asr.test.ts`** — new test proving a hung ASR call is caught by the call-timeout and retried via `onRecoverRecycle`.

Task order matters: Task 1 must land first (every other task calls the function it adds).

---

### Task 1: `forceSidecarRecycle` helper + synchronous in-flight guard

**Files:**
- Modify: `server/src/tts/sidecar-supervisor.ts:148-150` (insert between the end of `getActiveSupervisor` and the start of `createSidecarSupervisor`)
- Modify: `server/src/tts/sidecar-supervisor.test.ts` (add imports + new `describe` block at the end of the file)

**Interfaces:**
- Produces: `export async function forceSidecarRecycle(reason: string, warn?: (...args: unknown[]) => void): Promise<boolean>` — every later task imports this from `../tts/sidecar-supervisor.js`.

- [ ] **Step 1: Write the failing tests**

Open `server/src/tts/sidecar-supervisor.test.ts`. Change the top import block from:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSidecarSupervisor,
  type SidecarSupervisorOpts,
} from './sidecar-supervisor.js';
import type { SidecarHandle, SpawnSidecarOpts } from './spawn-sidecar.js';
import * as breadcrumbModule from './restart-breadcrumb.js';
```

to:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSidecarSupervisor,
  registerActiveSupervisor,
  forceSidecarRecycle,
  type SidecarSupervisorOpts,
  type SidecarSupervisor,
} from './sidecar-supervisor.js';
import type { SidecarHandle, SpawnSidecarOpts } from './spawn-sidecar.js';
import * as breadcrumbModule from './restart-breadcrumb.js';
```

Then append this new block at the very end of the file (after the last existing `describe`'s closing `});`):

```ts
describe('forceSidecarRecycle', () => {
  afterEach(() => registerActiveSupervisor(null));

  function fakeSupervisor(overrides: Partial<SidecarSupervisor> = {}): SidecarSupervisor {
    return {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      current: () => null,
      recycling: () => false,
      tripEvent: () => null,
      clearTripAndRespawn: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('kills the current handle and returns true', async () => {
    const handle = makeHandle();
    registerActiveSupervisor(fakeSupervisor({ current: () => handle }));

    const result = await forceSidecarRecycle('test reason', vi.fn());

    expect(result).toBe(true);
    expect(handle.kill).toHaveBeenCalledTimes(1);
  });

  it('returns false (no kill) when there is no active supervisor', async () => {
    registerActiveSupervisor(null);
    const result = await forceSidecarRecycle('test reason', vi.fn());
    expect(result).toBe(false);
  });

  it('returns false (no kill) when the supervisor reports recycling() already true', async () => {
    const handle = makeHandle();
    registerActiveSupervisor(fakeSupervisor({ recycling: () => true, current: () => handle }));

    const result = await forceSidecarRecycle('test reason', vi.fn());

    expect(result).toBe(false);
    expect(handle.kill).not.toHaveBeenCalled();
  });

  it('returns false (no kill) when there is no current handle', async () => {
    registerActiveSupervisor(fakeSupervisor({ current: () => null }));
    const result = await forceSidecarRecycle('test reason', vi.fn());
    expect(result).toBe(false);
  });

  it('a second concurrent call while the first is still in-flight no-ops (synchronous guard)', async () => {
    const handle = makeHandle();
    let releaseKill!: () => void;
    handle.kill.mockImplementation(() => new Promise<void>((r) => (releaseKill = r)));
    registerActiveSupervisor(fakeSupervisor({ current: () => handle }));

    const first = forceSidecarRecycle('first', vi.fn());
    // Second call races in BEFORE the first kill() resolves.
    const second = await forceSidecarRecycle('second', vi.fn());
    expect(second).toBe(false);
    expect(handle.kill).toHaveBeenCalledTimes(1); // only the first caller actually killed

    releaseKill();
    expect(await first).toBe(true);
  });

  it('warns with the given reason', async () => {
    const handle = makeHandle();
    registerActiveSupervisor(fakeSupervisor({ current: () => handle }));
    const warn = vi.fn();

    await forceSidecarRecycle('chapter 7 stalled 720s during synthesis', warn);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('chapter 7 stalled 720s during synthesis'),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/tts/sidecar-supervisor.test.ts`
Expected: FAIL — `forceSidecarRecycle` and `registerActiveSupervisor` (already exported, so that import is fine) errors: `"forceSidecarRecycle" is not exported by "src/tts/sidecar-supervisor.ts"` (a TypeScript/module resolution failure, since the function doesn't exist yet).

- [ ] **Step 3: Implement `forceSidecarRecycle`**

In `server/src/tts/sidecar-supervisor.ts`, insert the following between the closing `}` of `getActiveSupervisor` (line 148) and the `export function createSidecarSupervisor` line (line 150) — i.e. replace:

```ts
export function getActiveSupervisor(): SidecarSupervisor | null {
  return _activeSupervisor;
}

export function createSidecarSupervisor(opts: SidecarSupervisorOpts): SidecarSupervisor {
```

with:

```ts
export function getActiveSupervisor(): SidecarSupervisor | null {
  return _activeSupervisor;
}

/* Synchronous in-flight guard (module-level). Set before the first `await`
   below and cleared in `finally` — because JS has no preemption between
   awaits, this closes a race a `supervisor.recycling()`-only check would
   leave open (that flag flips inside the async onChildExit handler, AFTER
   kill() is called, not synchronously with it). */
let recycleInFlight = false;

/** Force-kill the current supervised sidecar child so the existing
    onChildExit → backoff → respawn path brings up a fresh process. Used when
    the caller has strong evidence the sidecar is wedged (not merely slow) —
    a readiness-poll exhausted its full budget, a chapter made zero progress
    for the full stall window, or in-loop recovery attempts were exhausted
    (RecycleStormError). Reuses the exact primitive `POST /api/sidecar/restart`
    already uses (`handle.kill()`), so the existing crash-loop cap applies
    automatically — this function adds no new cap logic. Returns false
    (no-op) when there's no active supervisor, a recycle is already in
    flight, or one is already known to be recovering — so concurrent callers
    don't pile up redundant kills on the same dying process. */
export async function forceSidecarRecycle(
  reason: string,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<boolean> {
  if (recycleInFlight) return false;
  const supervisor = getActiveSupervisor();
  if (!supervisor || supervisor.recycling()) return false;
  const handle = supervisor.current();
  if (!handle) return false;
  recycleInFlight = true;
  try {
    warn(`[sidecar] forced recycle: ${reason}`);
    await handle.kill();
    return true;
  } finally {
    recycleInFlight = false;
  }
}

export function createSidecarSupervisor(opts: SidecarSupervisorOpts): SidecarSupervisor {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/tts/sidecar-supervisor.test.ts`
Expected: PASS — all tests in the file, including the new `forceSidecarRecycle` describe block (6 new tests).

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/sidecar-supervisor.ts server/src/tts/sidecar-supervisor.test.ts
git commit -m "feat(server): add forceSidecarRecycle helper for srv-50

Refs #1243"
```

---

### Task 2: Wire the readiness-poll exhaustion hook

**Files:**
- Modify: `server/src/tts/ensure-sidecar-loaded.ts:1-38` (imports) and `:143-147` (the exhaustion branch)
- Modify: `server/src/tts/ensure-sidecar-loaded.test.ts`

**Interfaces:**
- Consumes: `forceSidecarRecycle(reason: string, warn?: ...): Promise<boolean>` from Task 1.

- [ ] **Step 1: Write the failing tests**

Open `server/src/tts/ensure-sidecar-loaded.test.ts`. Add a mock for the supervisor module right after the existing `gpu-load.js` mock (after line 17, before the `ensureSidecarEngineReady` import on line 19):

```ts
const forceSidecarRecycleMock = vi.fn(async () => true);
vi.mock('./sidecar-supervisor.js', () => ({
  forceSidecarRecycle: (...args: unknown[]) => forceSidecarRecycleMock(...args),
}));
```

Then add `forceSidecarRecycleMock.mockClear();` to the existing `afterEach` (currently `afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });` around line 22-25) — change it to:

```ts
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
  forceSidecarRecycleMock.mockClear();
});
```

Then extend the existing test `'gives up best-effort (no throw) after the budget when the sidecar stays down'` (around line 111-119) to also assert the recycle call, and add one new test proving no call fires when readiness resolves in time. Replace:

```ts
  it('gives up best-effort (no throw) after the budget when the sidecar stays down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    global.fetch = f as unknown as typeof fetch;

    await expect(ensureSidecarEngineReady('qwen', undefined, FAST)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(f.mock.calls.length).toBeGreaterThan(1); // polled, didn't bail on first failure
  });
```

with:

```ts
  it('gives up best-effort (no throw) after the budget when the sidecar stays down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    global.fetch = f as unknown as typeof fetch;

    await expect(ensureSidecarEngineReady('qwen', undefined, FAST)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(f.mock.calls.length).toBeGreaterThan(1); // polled, didn't bail on first failure
    // srv-50: exhausting the readiness budget is strong evidence of a wedge —
    // force a recycle instead of silently giving up.
    expect(forceSidecarRecycleMock).toHaveBeenCalledTimes(1);
    expect(forceSidecarRecycleMock.mock.calls[0][0]).toContain('qwen');
  });

  it('does NOT force-recycle when readiness resolves before the deadline', async () => {
    const f = vi.fn().mockResolvedValue(readyResp);
    global.fetch = f as unknown as typeof fetch;

    await ensureSidecarEngineReady('qwen', undefined, PATIENT);

    expect(forceSidecarRecycleMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/tts/ensure-sidecar-loaded.test.ts`
Expected: FAIL — `expect(forceSidecarRecycleMock).toHaveBeenCalledTimes(1)` receives 0 calls (the production code doesn't call it yet).

- [ ] **Step 3: Implement the hook**

In `server/src/tts/ensure-sidecar-loaded.ts`, add the import. Change:

```ts
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import type { TtsEngine } from './index.js';
```

to:

```ts
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';
import { forceSidecarRecycle } from './sidecar-supervisor.js';
import type { TtsEngine } from './index.js';
```

Then change the exhaustion branch (lines 143-147):

```ts
      if (Date.now() >= deadline) {
        console.warn(
          `[generation] readiness ${engine}: sidecar not ready after ${timeoutMs}ms (last: ${lastReason}) — proceeding to lazy load.`,
        );
        return;
      }
```

to:

```ts
      if (Date.now() >= deadline) {
        console.warn(
          `[generation] readiness ${engine}: sidecar not ready after ${timeoutMs}ms (last: ${lastReason}) — proceeding to lazy load.`,
        );
        await forceSidecarRecycle(
          `readiness poll for ${engine} exhausted ${timeoutMs}ms (last: ${lastReason})`,
        );
        return;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/tts/ensure-sidecar-loaded.test.ts`
Expected: PASS — all tests, including the two new/extended ones. Also re-run the full file to confirm the `withGpuLoad gate` sub-suite (which does its own `vi.resetModules()`/`vi.doMock()`) still passes — the top-level `vi.mock('./sidecar-supervisor.js', ...)` is unaffected by that sub-suite's per-test module resets, matching how the existing top-level `../workspace/user-settings.js` mock already survives them.

- [ ] **Step 5: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/ensure-sidecar-loaded.ts server/src/tts/ensure-sidecar-loaded.test.ts
git commit -m "feat(server): force-recycle sidecar on readiness-poll exhaustion

Refs #1243"
```

---

### Task 3: Wire the ChapterStallError (synthesis-phase) and RecycleStormError hooks

**Files:**
- Modify: `server/src/routes/generation.ts` (add import near line 70; edit the `isStall`/`isRecycleStorm` branches at lines 1747-1758)
- Modify: `server/src/routes/generation-stall-watchdog.test.ts`
- Modify: `server/src/routes/generation-recycle-recovery.test.ts`

**Interfaces:**
- Consumes: `forceSidecarRecycle(reason: string, warn?: ...): Promise<boolean>` from Task 1.

- [ ] **Step 1: Write the failing tests**

**3a. Stall-watchdog file.** Open `server/src/routes/generation-stall-watchdog.test.ts`. Add a supervisor mock right after the existing `vi.mock('../tts/mp3.js', ...)` block (after line 62, before the `const AUTHOR = ...` line):

```ts
const forceSidecarRecycleMock = vi.fn(async () => true);
vi.mock('../tts/sidecar-supervisor.js', () => ({
  forceSidecarRecycle: (...args: unknown[]) => forceSidecarRecycleMock(...args),
}));
```

Add `forceSidecarRecycleMock.mockClear();` to the top of the existing `beforeEach` (currently starting `beforeEach(async () => { encodeImpl = null; ...` around line 183) — insert as its first line:

```ts
beforeEach(async () => {
  forceSidecarRecycleMock.mockClear();
  encodeImpl = null;
  /* ... rest unchanged ... */
```

Extend the existing synthesis-stall test (`'aborts + records a generationError when synthesis makes no progress'`, lines 224-239) with a new assertion, and add a new test proving the assembly-phase stall does NOT recycle. Replace:

```ts
  it('aborts + records a generationError when synthesis makes no progress', async () => {
    process.env.CHAPTER_NO_PROGRESS_MS = '250';
    synthesiseImpl = () => hangForever(); // wedged synth, no ticks ever

    const body = await runChapter();

    expect(body).toContain('"type":"chapter_failed"');
    expect(body).not.toContain('"type":"chapter_complete"');
    expect(body).toContain('no progress');
    expect(body).toContain('synthesis');

    const ch = persistedChapter();
    expect(ch.generationState).toBe('failed');
    expect(ch.generationError).toMatch(/no progress/i);
    expect(ch.generationError).toMatch(/synthesis/i);
  }, 10_000);
```

with:

```ts
  it('aborts + records a generationError when synthesis makes no progress', async () => {
    process.env.CHAPTER_NO_PROGRESS_MS = '250';
    synthesiseImpl = () => hangForever(); // wedged synth, no ticks ever

    const body = await runChapter();

    expect(body).toContain('"type":"chapter_failed"');
    expect(body).not.toContain('"type":"chapter_complete"');
    expect(body).toContain('no progress');
    expect(body).toContain('synthesis');

    const ch = persistedChapter();
    expect(ch.generationState).toBe('failed');
    expect(ch.generationError).toMatch(/no progress/i);
    expect(ch.generationError).toMatch(/synthesis/i);
    // srv-50: a synthesis-phase stall is strong evidence the sidecar is
    // wedged — force a recycle instead of only failing the chapter.
    expect(forceSidecarRecycleMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('does NOT force-recycle on an assembly-phase stall (not a sidecar problem)', async () => {
    process.env.CHAPTER_NO_PROGRESS_MS = '250';
    synthesiseImpl = async () => okResult(); // synth completes fast
    encodeImpl = () => hangForever(); // ffmpeg/encode wedges → assembly never finishes

    const body = await runChapter();

    expect(body).toContain('"type":"chapter_failed"');
    expect(body).toContain('assembly');
    expect(forceSidecarRecycleMock).not.toHaveBeenCalled();
  }, 10_000);
```

**3b. Recycle-storm file.** Open `server/src/routes/generation-recycle-recovery.test.ts`. Add the same supervisor mock right after the existing `vi.mock('../tts/index.js', ...)` block (after line 65, before `const AUTHOR = ...`):

```ts
const forceSidecarRecycleMock = vi.fn(async () => true);
vi.mock('../tts/sidecar-supervisor.js', () => ({
  forceSidecarRecycle: (...args: unknown[]) => forceSidecarRecycleMock(...args),
}));
```

Change this file's existing `beforeEach` (around line 170) from:

```ts
beforeEach(async () => {
  ensureReadyCalls = 0;
  ensureReadyImpl = async () => {};
  await writeQueueFile(queuePath, {
    entries: [
      {
        id: ENTRY_ID,
        bookId,
        chapterId: 1,
        scope: 'this',
        addedAt: '2026-05-23T00:00:00.000Z',
        status: 'in_progress',
        order: 0,
      },
    ],
    paused: false,
  });
});
```

to:

```ts
beforeEach(async () => {
  forceSidecarRecycleMock.mockClear();
  ensureReadyCalls = 0;
  ensureReadyImpl = async () => {};
  await writeQueueFile(queuePath, {
    entries: [
      {
        id: ENTRY_ID,
        bookId,
        chapterId: 1,
        scope: 'this',
        addedAt: '2026-05-23T00:00:00.000Z',
        status: 'in_progress',
        order: 0,
      },
    ],
    paused: false,
  });
});
```

Extend the existing test `'surfaces chapter_failed when synthesiseChapter throws RecycleStormError'` (lines 238-262) with a new assertion. Add this line directly after the existing `expect(body).toMatch(/"remediation":"[^"]*(?:sidecar|concurrency|headroom)/i);` line (around line 252):

```ts
    // srv-50: RecycleStormError means in-loop recovery already failed
    // maxRecycleRecoveries times — force a recycle rather than leaving a
    // possibly-wedged sidecar for the next chapter to hit the same wall.
    expect(forceSidecarRecycleMock).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/routes/generation-stall-watchdog.test.ts src/routes/generation-recycle-recovery.test.ts`
Expected: FAIL — both new/extended assertions on `forceSidecarRecycleMock` receive 0 calls.

- [ ] **Step 3: Implement the hooks**

In `server/src/routes/generation.ts`, add the import next to the existing `probeSidecarHealth` import (line 70). Change:

```ts
import { probeSidecarHealth } from './sidecar-health.js';
```

to:

```ts
import { probeSidecarHealth } from './sidecar-health.js';
import { forceSidecarRecycle } from '../tts/sidecar-supervisor.js';
```

Then change the `isStall`/`isRecycleStorm` branches (lines 1747-1758):

```ts
      if (isStall) {
        console.error(
          `[generation] chapter ${chapter.id} (${chapter.slug}) STALLED during ${stallPhase}: ` +
            `no progress for ${Math.round(noProgressMs / 1000)}s — recorded as failed so the queue advances.`,
        );
      } else if (isRecycleStorm) {
        const recoveries = (e as { recoveries?: number })?.recoveries ?? MAX_RECYCLE_RECOVERIES;
        console.error(
          `[generation] chapter ${chapter.id} (${chapter.slug}) RECYCLE STORM: sidecar recycled ` +
            `${recoveries}× on one chapter — recorded non-fatal. On the queue path the run is ` +
            `stopped by pausing the queue (below); the back-compat \`*\` job relies on the cascade.`,
        );
      } else {
        console.error(`[generation] chapter ${chapter.id} (${chapter.slug}) failed:`, e);
      }
```

to:

```ts
      if (isStall) {
        console.error(
          `[generation] chapter ${chapter.id} (${chapter.slug}) STALLED during ${stallPhase}: ` +
            `no progress for ${Math.round(noProgressMs / 1000)}s — recorded as failed so the queue advances.`,
        );
        if (stallPhase === 'synthesis') {
          await forceSidecarRecycle(
            `chapter ${chapter.id} stalled ${Math.round(noProgressMs / 1000)}s during synthesis`,
          );
        }
      } else if (isRecycleStorm) {
        const recoveries = (e as { recoveries?: number })?.recoveries ?? MAX_RECYCLE_RECOVERIES;
        console.error(
          `[generation] chapter ${chapter.id} (${chapter.slug}) RECYCLE STORM: sidecar recycled ` +
            `${recoveries}× on one chapter — recorded non-fatal. On the queue path the run is ` +
            `stopped by pausing the queue (below); the back-compat \`*\` job relies on the cascade.`,
        );
        await forceSidecarRecycle(
          `chapter ${chapter.id} hit a recycle storm (${recoveries} in-loop recoveries exhausted)`,
        );
      } else {
        console.error(`[generation] chapter ${chapter.id} (${chapter.slug}) failed:`, e);
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/generation-stall-watchdog.test.ts src/routes/generation-recycle-recovery.test.ts`
Expected: PASS — all tests in both files.

- [ ] **Step 5: Run the broader generation test suite** (these hooks touch a shared catch block used by every chapter-failure path)

Run: `cd server && npx vitest run src/routes/generation.test.ts src/routes/generation-error.test.ts src/routes/generation-boundary-recycle.test.ts src/routes/generation-orphan-recovery.test.ts src/routes/generation-fallback-gate.test.ts src/routes/generation-resume-from.test.ts src/routes/generation-spk.test.ts src/routes/generation-stats.test.ts`
Expected: PASS. None of these mock `../tts/sidecar-supervisor.js`, so `forceSidecarRecycle` runs for real in them — but it no-ops safely (`getActiveSupervisor()` returns `null` outside a running server, per Task 1's guard), so no behavior change and no hang.

- [ ] **Step 6: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/generation.ts server/src/routes/generation-stall-watchdog.test.ts server/src/routes/generation-recycle-recovery.test.ts
git commit -m "feat(server): force-recycle sidecar on synthesis stall + recycle storm

Refs #1243"
```

---

### Task 4: Wrap the ASR `verify` closure with the existing timeout + recovery helpers

**Files:**
- Modify: `server/src/tts/synthesise-chapter.ts:1587-1598`
- Modify: `server/src/tts/synthesise-chapter-asr.test.ts`

**Interfaces:**
- Consumes: `withCallTimeout` and `withRecycleRecovery` (both already defined earlier in the same `synthesiseChapter` function — no import needed, they're closures in scope) and `resolveGroup` (same function, already in scope per line 1029).

- [ ] **Step 1: Write the failing test**

Open `server/src/tts/synthesise-chapter-asr.test.ts`. No new imports are needed — `synthesiseChapter` and `TranscribeResult` are already imported.

Add this new test at the end of the `describe('synthesiseChapter ASR content-QA pass', () => { ... })` block, right before its closing `});`:

```ts
  it('a hung ASR verify() call times out and is retried via onRecoverRecycle, instead of hanging forever', async () => {
    const provider = makeProvider();
    // transcribeFn never resolves — simulates the 2026-07-03 wedged-sidecar
    // incident (a worker thread stuck mid-transcribe).
    const hangingTranscribe = (): Promise<TranscribeResult> => new Promise(() => {});
    const onRecoverRecycle = vi.fn(async () => {});

    const err = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      callTimeoutMs: 40,
      asr: { maxRerecords: 0, transcribeFn: hangingTranscribe },
      onRecoverRecycle,
      maxRecycleRecoveries: 2,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    // Exhausts the shared recovery budget (2) since the transcribe call keeps
    // hanging on every retry — same shape as a hung synth call.
    expect(onRecoverRecycle).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({ name: 'RecycleStormError' });
  }, 15_000);

  it('a normal in-budget ASR call is unaffected by the timeout wrap', async () => {
    const provider = makeProvider();
    const { fn } = makeTranscriber([TEXT]);
    const res = await synthesiseChapter({
      sentences: [sentence(1)],
      cast,
      provider,
      modelKey: 'gemini-2.5-flash',
      engine: 'gemini',
      callTimeoutMs: 50_000,
      asr: { maxRerecords: 2, transcribeFn: fn },
    });
    expect(res.segments.find((s) => s.kind !== 'title')?.asr?.verdict).toBe('ok');
  });
```

The first test asserts on the outer `RecycleStormError` by shape (`{ name: 'RecycleStormError' }`) rather than `instanceof`, matching the externally-observable outcome — the same pattern as the existing `'throws RecycleStormError after the shared budget is exhausted'` test in `synthesise-chapter.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/tts/synthesise-chapter-asr.test.ts`
Expected: FAIL — the new test times out / hangs (or fails the 15s test timeout), because `verify()` is not yet wrapped in `withCallTimeout`, so the hanging `transcribeFn` never resolves and `onRecoverRecycle` is never called.

- [ ] **Step 3: Implement the wrap**

In `server/src/tts/synthesise-chapter.ts`, change the `verify` closure (lines 1587-1598) from:

```ts
    const verify = (pcm: Buffer, rate: number, group: SentenceGroup): Promise<AsrClassification> =>
      verifySegmentTranscript(pcm, rate, normaliseForTts(group.text, langCode), {
        language: asr.language,
        nameAllowlist: asr.nameAllowlist,
        thresholds: asr.thresholds,
        transcribeFn: asr.transcribeFn,
        sidecarUrl: asr.sidecarUrl,
        signal,
        /* fs-57 / srv-31: when Stage 3 prepended a vocalization, tolerate its
           leading token(s) so the gasp doesn't count as content drift. */
        ...(group.vocalization ? { vocalizationAllowlist: leadingVocalizationTokens(group.text) } : {}),
      });
```

to:

```ts
    /* srv-50: wrapped in the same withCallTimeout + withRecycleRecovery
       protection every synth call site already has — an unwrapped ASR call
       was the exact hang the 2026-07-03 wedged-sidecar incident exposed
       (it never threw, so nothing downstream ever got a chance to recover).
       Wrapping the closure (not either call site) covers BOTH call sites
       below automatically. */
    const verify = (pcm: Buffer, rate: number, group: SentenceGroup): Promise<AsrClassification> =>
      withRecycleRecovery(resolveGroup(group).route.engine, () =>
        withCallTimeout('asr-verify', (sig) =>
          verifySegmentTranscript(pcm, rate, normaliseForTts(group.text, langCode), {
            language: asr.language,
            nameAllowlist: asr.nameAllowlist,
            thresholds: asr.thresholds,
            transcribeFn: asr.transcribeFn,
            sidecarUrl: asr.sidecarUrl,
            signal: sig,
            /* fs-57 / srv-31: when Stage 3 prepended a vocalization, tolerate its
               leading token(s) so the gasp doesn't count as content drift. */
            ...(group.vocalization ? { vocalizationAllowlist: leadingVocalizationTokens(group.text) } : {}),
          }),
        ),
      );
```

Both call sites (`timed(() => verify(r.pcm, r.sampleRate, group))` and `timed(() => verify(f.pcm, f.sampleRate, group))`, further down in the same function) are unchanged — they still call `verify(...)` with the same three arguments and inherit the wrap automatically.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/tts/synthesise-chapter-asr.test.ts`
Expected: PASS — all tests in the file, including the two new ones.

- [ ] **Step 5: Run the full synthesise-chapter suite** (the wrapped closure is shared machinery touching every ASR-enabled test)

Run: `cd server && npx vitest run src/tts/synthesise-chapter.test.ts src/tts/synthesise-chapter-asr.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/tts/synthesise-chapter.ts server/src/tts/synthesise-chapter-asr.test.ts
git commit -m "feat(server): wrap ASR verify() with the existing call-timeout + recovery guard

Closes #1243"
```

---

## Final verification (after all 4 tasks)

- [ ] **Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS, zero regressions.

- [ ] **Run the full battery** (per this repo's before-shipping checklist)

Run: `npm run verify` (from the repo root)
Expected: PASS — typecheck + all tests + e2e + build.

- [ ] **Manual on-box verification** (not automatable — the spec's Testing section flags this explicitly): with `npm start` running and the sidecar up, confirm the new hooks actually recycle a real process:
  1. Note the current sidecar PID: `curl -s http://127.0.0.1:9000/health` won't show a PID directly, so instead check `tasklist | findstr python` (Windows) and note the PID whose command line is `-m uvicorn main:app --host 127.0.0.1 --port 9000` (cross-check via `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` if ambiguous).
  2. Trigger a synthesis-phase stall: temporarily set `CHAPTER_NO_PROGRESS_MS=5000` in `server/.env` and start a chapter render, then suspend the sidecar process to simulate a hang — on Windows, `(Get-Process -Id <pid>).Suspend()` (from `System.Diagnostics.Process`, no extra tooling needed) leaves the process alive but unresponsive to new requests, matching the 2026-07-03 incident shape.
  3. Wait past the 5s stall window. Confirm in `logs/server.err.log` that the `STALLED during synthesis` line is followed by a `[sidecar] forced recycle:` line (from Task 1's `warn(...)` call).
  4. Confirm the OLD pid is gone (`tasklist | findstr <old-pid>` returns nothing) and a NEW sidecar process is listening: `curl -s http://127.0.0.1:9000/health` returns `200` with a fresh process (if suspended rather than genuinely dead, first resume it with `(Get-Process -Id <pid>).Resume()` if the kill didn't already terminate it — `taskkill /F` terminates regardless of suspended state, so this should not be needed, but note it if a resume is required to observe the exit cleanly on your Windows build).
  5. Revert `CHAPTER_NO_PROGRESS_MS` in `server/.env` afterward.

- [ ] **Update the regression plan / release notes / issue link** per `CLAUDE.md`'s "Before-shipping checklist":
  1. This plan file itself + the spec under `docs/superpowers/specs/` already serve as the regression documentation for this change — no separate `docs/features/*.md` entry is needed (this is a small, localized reliability fix, not a new feature surface).
  2. Append an entry to `docs/release-notes-next.md` (technical register) and a matching brand-voice line to `RELEASE_NOTES.md`'s in-progress version section.
  3. Confirm the PR body includes `Closes #1243`.
  4. Run the mandatory `code-review` pass (medium effort — single-scope `feat`, per this repo's model-routing table) before merge.
