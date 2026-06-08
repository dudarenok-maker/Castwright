# Generation Stall Protection — Wave 2 (safe recycles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a sidecar recycle never destroy in-flight work — drain before any server-initiated replace (B1), clamp same-engine synth to one in-flight call to match the sidecar's own lock (A3), and stop the queue from claiming new chapters into a known-recycling sidecar (B2).

**Architecture:** Three independent server changes. **B1** is the core fix: the supervisor's unfit-replace path calls the sidecar's existing graceful `POST /recycle` (drain-then-exit) before falling back to a hard kill. **A3** adds a per-engine `GpuSemaphore(1)` in `sidecar.ts`, outside the global VRAM semaphore, mirroring the sidecar's per-engine `_synth_lock`. **B2** exposes a `recycling` flag on `GET /api/queue` and gates the frontend dispatcher's claim step.

**Tech Stack:** TypeScript (Express server + Redux frontend middleware, Vitest). The sidecar Python is UNCHANGED — `POST /recycle` already exists (`main.py:2697`).

**Spec:** `docs/superpowers/specs/2026-06-08-generation-stall-protection-design.md` · **Bug:** #672 · **PR:** #673 · **Wave 1:** `2026-06-08-generation-stall-protection-wave1.md`

> **Priority / scope note:** Implement in order **B1 → A3 → B2**. B1 directly fixes the incident's collision. A3 prevents double-memory same-engine synth. **B2 is the lowest-value item** now that Wave 1 set `workers=1` (the per-call `ensureSidecarEngineReady` gate already makes the single in-flight chapter wait out a respawn; B2 only saves wasted slots at workers>1 and adds operator visibility). Consider B2 optional / defer-able.

---

## File Structure

- `server/src/tts/sidecar.ts` — per-engine synth clamp (A3).
- `server/src/tts/engine-synth-clamp.test.ts` — **new**, A3 unit tests.
- `server/src/tts/sidecar-supervisor.ts` — drain-before-replace in the `respawn` closure (B1).
- `server/src/tts/sidecar-supervisor.test.ts` — extend with B1 cases.
- `server/src/routes/queue.ts` — add `recycling` to `GET /api/queue` (B2).
- `src/store/queue-dispatcher-middleware.ts` — gate the claim step on `recycling` (B2).
- `src/store/queue-dispatcher-middleware.test.ts` — extend with the recycling-gate case (B2).

---

## Task 1: B1 — drain in-flight synth before a server-initiated force-replace

**Context:** `sidecar-supervisor.ts` `respawn` closure (lines ~151-160) currently delegates straight to `spawnOnce()` → `spawnSidecar()` → `findPid` + `killTree` (hard kill, no drain). The sidecar already has a graceful `POST /recycle` (`main.py:2697`) that sets `_restart_pending` (fences new synth with 503), drains `_inflight_synth`, then self-exits (code 43). B1: on a FITNESS trigger (alive-but-unfit: `recyclePending || overCeiling`), call `/recycle` first and wait for the port to free; only hard-kill as a fallback. The DISAPPEARANCE trigger (process already gone) is unchanged.

**Files:**
- Modify: `server/src/tts/sidecar-supervisor.ts`
- Test: `server/src/tts/sidecar-supervisor.test.ts`

- [ ] **Step 1: Read the current respawn/onAdopt code** to confirm exact line numbers and the `respawn(why)` signature, the `onAdopt` watchdog (TCP-disappearance vs fitness branches), `SidecarSupervisorOpts` (the injected `spawnFn`/`probeFn`/`healthProbeFn`/`delayFn` seams), and the `DEFAULT_ADOPTED_*` constants. Note how `respawn` is called from BOTH the disappearance branch and the fitness branch — B1 only changes the FITNESS branch.

- [ ] **Step 2: Write the failing tests** in `server/src/tts/sidecar-supervisor.test.ts` (copy the existing adopted-fitness test's setup — the one asserting "replaces an adopted sidecar that becomes leak-saturated"). Add a new injected seam `recycleSidecarFn` to the opts in these tests:
```ts
it('on a fitness trigger, calls POST /recycle (graceful drain) BEFORE hard-replacing', async () => {
  const calls: string[] = [];
  const recycleSidecarFn = vi.fn(async () => { calls.push('recycle'); return true; });
  const spawnFn = vi.fn(async () => { calls.push('spawn'); return makeFakeHandle(); });
  // probeFn: port still held for 1 tick after recycle, then frees (sidecar self-exits post-drain)
  let probeCount = 0;
  const probeFn = vi.fn(async () => (probeCount++ < 1)); // true once, then false
  // healthProbeFn: first fitness poll returns leak-saturated (overCeiling)
  // ... build supervisor via createSidecarSupervisor with these seams + a fast delayFn ...
  // ... drive the adopted fitness watchdog one cycle ...
  expect(recycleSidecarFn).toHaveBeenCalledTimes(1);
  expect(calls.indexOf('recycle')).toBeLessThan(calls.indexOf('spawn')); // recycle BEFORE spawn
});

it('falls back to hard replace when /recycle fails (recycleSidecarFn → false)', async () => {
  const recycleSidecarFn = vi.fn(async () => false);
  const spawnFn = vi.fn(async () => makeFakeHandle());
  // probeFn keeps returning true (port never frees) — supervisor must still spawn after drainWaitMs
  // ... assert spawnFn still called (the spawnSidecar hard-kill fallback path runs) ...
  expect(spawnFn).toHaveBeenCalled();
});

it('does NOT call /recycle on the DISAPPEARANCE trigger (process already gone)', async () => {
  const recycleSidecarFn = vi.fn(async () => true);
  // probeFn returns false immediately (TCP gone) → disappearance branch
  // ... assert recycleSidecarFn NOT called, spawnFn called ...
  expect(recycleSidecarFn).not.toHaveBeenCalled();
});
```
> Match the REAL supervisor factory signature and the existing test's handle/seam construction (`makeFakeHandle`, the `delayFn`, how the watchdog cycle is driven). Copy a neighboring test verbatim as the skeleton — do not invent the harness.

- [ ] **Step 3: Run, confirm the first two FAIL** (recycle seam doesn't exist yet / isn't called before spawn):
`cd server && npx vitest run src/tts/sidecar-supervisor.test.ts -t "graceful drain"`

- [ ] **Step 4: Implement.** In `server/src/tts/sidecar-supervisor.ts`:
  1. Add to `SidecarSupervisorOpts`:
```ts
  /** Graceful drain: POST /recycle on the sidecar so it drains in-flight synth
      and self-exits, instead of a hard kill. Returns true on a 2xx (drain
      started), false otherwise. Default fetches `${host}:${port}/recycle`. */
  recycleSidecarFn?: (host: string, port: number) => Promise<boolean>;
  /** Max ms to wait for the port to free after a graceful /recycle before
      falling through to the hard-kill replace. Default 185_000 (sidecar drain
      grace 180s + margin). */
  drainWaitMs?: number;
```
  2. Add a default `recycleSidecarFn` (module-level, near the other defaults): `fetch(\`http://${host}:${port}/recycle\`, { method: 'POST', signal: AbortSignal.timeout(3000) })` → `res.ok`; catch → false.
  3. In `onAdopt`, change ONLY the FITNESS branch (the `if (health.recyclePending || overCeiling)` path) so that before `respawn(...)` it attempts a graceful drain. Concretely, give `respawn` an optional `graceful` flag, or add a `drainThenRespawn(why)` that:
     - calls `await recycleSidecarFn(info.host, info.port)`;
     - if true, polls `probeFn` every `adoptedPollMs` until it returns false (port freed = sidecar self-exited) OR `drainWaitMs` elapses (use `delayFn` for the sleeps);
     - then calls `spawnOnce()` (which finds the port free → skips killTree; or, on timeout, hard-kills as today).
     The DISAPPEARANCE branch and `onChildExit` keep calling the existing immediate `respawn` (no drain).
  4. Thread `recycleSidecarFn` + `drainWaitMs` through the destructure with their defaults.

- [ ] **Step 5: Run the supervisor suite, confirm all green** (new B1 cases + all existing adopt/disappear/respawn tests):
`cd server && npx vitest run src/tts/sidecar-supervisor.test.ts`

- [ ] **Step 6: Run spawn-sidecar tests** (unchanged, but confirm no regression): `cd server && npx vitest run src/tts/spawn-sidecar.test.ts`

- [ ] **Step 7: Commit**
```bash
git add server/src/tts/sidecar-supervisor.ts server/src/tts/sidecar-supervisor.test.ts
git commit -m "feat(server): drain in-flight synth before force-replacing an unfit sidecar (Refs #672)"
```

---

## Task 2: A3 — per-engine in-flight synth clamp

**Context:** `SidecarTtsProvider` (`sidecar.ts`) has one class with an `engine` field and two synth methods — `synthesize()` (~line 84) and `synthesizeBatch()` (~line 143) — each does `const releaseGpu = await gpuSemaphore.acquire(costForEngine(this.engine))` in a try/finally. With `GPU_VRAM_BUDGET=2` and qwen cost 1, two Qwen synths fit the GLOBAL budget and both pass to the sidecar, where they serialize on `_synth_lock` but double transient memory. A3 adds a per-engine `GpuSemaphore(1)` acquired OUTSIDE the global one (avoids priority inversion), so at most one Qwen synth is in flight while Kokoro+Qwen can still overlap.

**Files:**
- Modify: `server/src/tts/sidecar.ts`
- Test: `server/src/tts/engine-synth-clamp.test.ts` (new)

- [ ] **Step 1: Read `sidecar.ts`** to confirm the class name (`SidecarTtsProvider`), the `engine` field, the two acquire sites, and the constructor (for the injection seam). Read `server/src/gpu/semaphore.ts` for the `GpuSemaphore` API and `server/src/gpu/semaphore.test.ts` for the `flush()` test idiom.

- [ ] **Step 2: Write the failing test** `server/src/tts/engine-synth-clamp.test.ts`. Mock `undici` fetch the way `sidecar.test.ts` does (vi.mock preserving `Agent`); make the mocked fetch return a controllable deferred so the first synth call can be held open. Assert:
```ts
it('serialises two SAME-engine (qwen) synth calls — the 2nd waits for the 1st', async () => {
  // hold fetch open for call 1; start qwen synth A and B; flush();
  // assert fetch called ONCE (B is queued behind A's per-engine sem); resolve A; flush();
  // assert fetch now called twice.
});
it('allows DIFFERENT engines (qwen + kokoro) to overlap', async () => {
  // hold fetch open; start qwen + kokoro; flush();
  // assert fetch called TWICE (both in flight — different per-engine sems).
});
```
> Use the existing `sidecar.test.ts` mock setup verbatim. For isolation, the per-engine semaphore map MUST be injectable (see Step 4) so each test gets a fresh map — otherwise module-level state leaks between tests.

- [ ] **Step 3: Run, confirm the serialise test FAILS** (today both qwen calls hit fetch immediately): `cd server && npx vitest run src/tts/engine-synth-clamp.test.ts`

- [ ] **Step 4: Implement** in `server/src/tts/sidecar.ts`:
```ts
// module-level, after imports
const defaultEngineSynths = new Map<string, GpuSemaphore>();
function engineSynthSem(map: Map<string, GpuSemaphore>, engine: string): GpuSemaphore {
  let sem = map.get(engine);
  if (!sem) { sem = new GpuSemaphore(1); map.set(engine, sem); }
  return sem;
}
```
Add an optional constructor field `private readonly engineSynths: Map<string, GpuSemaphore>` defaulting to `defaultEngineSynths` (so prod shares one map; tests inject a fresh `new Map()`). In BOTH `synthesize()` and `synthesizeBatch()`, wrap the existing body with an OUTER per-engine acquire/release around the existing global acquire:
```ts
const releaseEngine = await engineSynthSem(this.engineSynths, this.engine).acquire();
try {
  const releaseGpu = await gpuSemaphore.acquire(costForEngine(this.engine));
  try {
    /* ...existing fetch + arrayBuffer + parse... */
  } finally { releaseGpu(); }
} finally { releaseEngine(); }
```
Import `GpuSemaphore` from `../gpu/semaphore.js` (alongside the existing `gpuSemaphore` import).

- [ ] **Step 5: Run, confirm both A3 tests PASS:** `cd server && npx vitest run src/tts/engine-synth-clamp.test.ts`

- [ ] **Step 6: Run the existing sidecar + concurrency tests** (must stay green — they run the real semaphore): `cd server && npx vitest run src/tts/sidecar.test.ts src/tts/sidecar-timeout.test.ts`

- [ ] **Step 7: Commit**
```bash
git add server/src/tts/sidecar.ts server/src/tts/engine-synth-clamp.test.ts
git commit -m "feat(server): clamp same-engine synth to one in-flight call (mirror sidecar lock, Refs #672)"
```

---

## Task 3: B2 — pause queue dispatch while the sidecar is recycling (LOWER PRIORITY / optional)

**Context:** The per-call `ensureSidecarEngineReady` gate already makes an in-flight chapter wait out a respawn, so this is correctness-safe today — B2 only stops the frontend dispatcher from CLAIMING a new chapter into a known-recycling sidecar (wasted slots at workers>1) and adds visibility. With Wave-1 `workers=1` this is low-value; implement only if the user wants it.

**Files:**
- Modify: `server/src/routes/queue.ts` (add `recycling` to `GET /api/queue`)
- Modify: `src/store/queue-dispatcher-middleware.ts` (gate the claim step)
- Test: `src/store/queue-dispatcher-middleware.test.ts`

- [ ] **Step 1: Read** `server/src/routes/queue.ts` `GET /api/queue` handler (it already returns `paused`), and the source of a "recycling" signal: `getActiveSupervisor()?.current()` (null between respawns) in `sidecar-supervisor.ts`, and `getSidecarRecyclePending()` in `generation.ts` (probes `/health` `recycle_pending`). Read `src/store/queue-dispatcher-middleware.ts` `tick()` STEP 2 (the `if (queue.paused) return` gate) and its test file's paused-gate test.

- [ ] **Step 2: Write the failing frontend test** in `src/store/queue-dispatcher-middleware.test.ts`, mirroring the existing `queue.paused` gate test:
```ts
it('does not claim/open a new entry while the queue is recycling', () => {
  // build store with a queued entry + queue.recycling = true
  // tick(); assert runner.open was NOT called and inFlight stays empty
});
```

- [ ] **Step 3: Run, confirm FAIL:** `npx vitest run src/store/queue-dispatcher-middleware.test.ts -t "recycling"`

- [ ] **Step 4: Implement.**
  - Server: in `GET /api/queue` (`server/src/routes/queue.ts`), compute `recycling` and add it to the JSON. Source it from the synchronous supervisor signal first (`getActiveSupervisor()?.current() === null`); optionally OR the last-known `recycle_pending`. Keep it cheap (no new blocking probe on the hot path — prefer the synchronous supervisor check, or a cached health value).
  - Frontend: in `queue-dispatcher-middleware.ts` `tick()` STEP 2, change the gate to `if (queue.paused || queue.recycling) return;` and thread `recycling` through the queue slice/selector the same way `paused` is.

- [ ] **Step 5: Run, confirm PASS + no regression:** `npx vitest run src/store/queue-dispatcher-middleware.test.ts` and `cd server && npx vitest run src/routes/queue`

- [ ] **Step 6: Commit**
```bash
git add server/src/routes/queue.ts src/store/queue-dispatcher-middleware.ts src/store/queue-dispatcher-middleware.test.ts
git commit -m "feat(server,frontend): hold queue dispatch while the sidecar is recycling (Refs #672)"
```

---

## Task 4: Wave 2 wrap-up

- [ ] **Step 1: Full fast battery** — `npm run verify:fast` → PASS.
- [ ] **Step 2: Server suite** — `npm run test:server` → PASS.
- [ ] **Step 3: Typecheck** — `npm run typecheck` → PASS.
- [ ] **Step 4: Mark the spec** — add `**Wave 2 landed:** <date>, <shas>` under Delivery in the design spec; commit `docs(docs): mark Wave 2 of generation stall protection landed (Refs #672)`.
- [ ] **Step 5: Push** and update PR #673 with the Wave 2 delta.

---

## Self-review notes

- **Spec coverage (Wave 2):** A3 ✓ (Task 2), B1 ✓ (Task 1), B2 ✓ (Task 3, flagged optional). The prod-fresh policy + drain together satisfy "recycles never kill mid-synth"; B1 reuses the sidecar's existing `POST /recycle` (no Python change).
- **Cross-task types:** the new `recycleSidecarFn`/`drainWaitMs` opts (Task 1), the injectable `engineSynths` map (Task 2), and the `recycling` queue field (Task 3) are each defined and consumed within their own task.
- **Ordering:** B1 first (core fix), A3 second, B2 last/optional. Each commits independently and is revertible.
- **Sidecar Python is untouched** — `POST /recycle` already exists; B1 is purely a server-side change to USE it on the unfit-replace path.
