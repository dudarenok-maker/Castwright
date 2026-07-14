# srv-48 follow-ups (M1/M3/M4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the persona-pre-pass reverse-evict wait abortable (M1) and harden two srv-48 tests so they fail on the regressions they exist to catch (M3, M4).

**Architecture:** M1 adds optional `AbortSignal` support to the singleton `GpuSemaphore.acquire` (queued-waiter removal on abort — the only leak-safe way), then threads `job.controller.signal` through `preparePersonaBatch → unloadResidentSidecar → acquire`; a paused pre-pass swallows the resulting `AbortError` and falls back to CPU. M3 rewrites the evict-refused test to be state-based. M4 makes the disconnected-knob test assert the registry-key wiring, not just a value that survives a revert.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node 20+, Vitest (node env). Server package: `server/`.

**Spec:** `docs/superpowers/specs/2026-07-14-srv-48-followups-design.md`. **Issue:** #1561.

## Global Constraints

- **Server-only.** All files under `server/src/`. TypeScript ESM — import specifiers end in `.js`.
- **Commit convention:** `<type>(<scope>): <subject>`; use scope `server`. Type `test` for test-only commits, `fix` for the M1 production change.
- **Tests colocate** next to the unit as `*.test.ts`; run with `cd server && npm run test` (or `npm run test:server` from root).
- **No behaviour change** for the two `routes/voice-style.ts` callers of `preparePersonaBatch` (lines 66, 113) — the new `signal` parameter is optional; they pass nothing.
- **Abort error shape:** a `DOMException` with `name === 'AbortError'` (Node's standard abort reason). Detect it by `name`, not by `instanceof`.
- **`GpuSemaphore` is a module singleton** (`gpuSemaphore`). New M1 unit tests use fresh `new GpuSemaphore(n)` instances, never the singleton, so leaked tokens can't corrupt other suites' `inFlight` assertions.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `server/src/gpu/semaphore.ts` | Add optional `{ signal }` to `acquire`; leak-safe queued-waiter removal on abort | 1 |
| `server/src/gpu/semaphore.test.ts` | Unit tests for the abortable acquire (fresh instances) | 1 |
| `server/src/tts/persona-gpu-plan.ts` | Thread `signal` through `preparePersonaBatch`/`unloadResidentSidecar`; catch `AbortError` → CPU args | 2 |
| `server/src/routes/cast-design.ts` | Pass `job.controller.signal` into `preparePersonaBatch` | 2 |
| `server/src/tts/persona-gpu-plan.test.ts` | Existing suite that pins `unloadResidentSidecar`'s `acquire(budget)` call shape — must stay green (no edit; the conditional keeps the no-signal call 1-arg) | 2 (run only) |
| `server/src/tts/prepare-persona-batch.test.ts` | Add M1 abort-catch integration test (Task 2); M3 state-based rewrite (Task 3) | 2, 3 |
| `server/src/analyzer/voice-style.test.ts` | M4 revert-proof wiring assertion + stray-import tidy | 4 |
| `docs/release-notes-next.md` | One technical entry (PR-refed) | 5 |

**Parallelism for delivery:** Stream A = Tasks 1 → 2 → 3 (sequential: 2 depends on 1's API; 3 shares a test file with 2). Stream B = Task 4 (isolated file, no dependency). A and B run concurrently. Task 5 lands after A+B in the integrating stream.

---

### Task 1: Abortable `GpuSemaphore.acquire`

**Files:**
- Modify: `server/src/gpu/semaphore.ts` (the `Waiter` type ~line 33, `acquire` ~55-69, `drain` ~96-103)
- Test: `server/src/gpu/semaphore.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `acquire(cost?: number, opts?: { signal?: AbortSignal }): Promise<() => void>` — rejects with `DOMException('…','AbortError')` if the signal is already aborted at call time, or fires while the acquire is queued (the queued waiter is removed, no tokens leak). A synchronously-granted acquire ignores later aborts. Task 2 relies on this exact signature and reject shape.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/gpu/semaphore.test.ts` (inside the top-level `describe('GpuSemaphore', …)` or a new sibling describe):

```ts
describe('GpuSemaphore — abortable acquire', () => {
  it('aborting a queued waiter rejects with AbortError and leaks no tokens', async () => {
    const sem = new GpuSemaphore(1);
    const held = await sem.acquire(1);            // occupies the only token
    const ac = new AbortController();
    const queued = sem.acquire(1, { signal: ac.signal }); // must queue
    expect(sem.queueDepth).toBe(1);

    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(sem.queueDepth).toBe(0);               // waiter removed
    expect(sem.usedTokens).toBe(1);               // only `held` still holds
    expect(sem.inFlight).toBe(1);

    // The semaphore is still healthy: releasing the holder grants a fresh acquire.
    held();
    const next = await sem.acquire(1);            // must resolve, not hang
    next();
    expect(sem.inFlight).toBe(0);
  });

  it('acquire with an already-aborted signal rejects immediately and takes no token', async () => {
    const sem = new GpuSemaphore(2);
    const ac = new AbortController();
    ac.abort();
    await expect(sem.acquire(1, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sem.usedTokens).toBe(0);
    expect(sem.inFlight).toBe(0);
  });

  it('a synchronously granted acquire ignores a later abort', async () => {
    const sem = new GpuSemaphore(2);
    const ac = new AbortController();
    const release = await sem.acquire(1, { signal: ac.signal }); // granted immediately (tokens free)
    expect(sem.inFlight).toBe(1);
    ac.abort();                                   // must NOT throw or double-settle
    expect(sem.inFlight).toBe(1);
    release();
    expect(sem.inFlight).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/gpu/semaphore.test.ts -t "abortable acquire"`
Expected: FAIL — `acquire` ignores the second arg today. Tests 1 and 2 fail: test 1 by **timeout** (the queued promise never rejects, so the `rejects` assertion hangs to the default ~5s limit), test 2 because an already-aborted signal is ignored and the acquire resolves instead of rejecting. (Test 3, "synchronously granted ignores a later abort", actually passes on current code too — today's `acquire` grants immediately and has nothing to double-settle; it's a deliberate regression-guard for the new abort path, not a fail-first case. The describe is still red overall from tests 1–2.)

- [ ] **Step 3: Implement the abortable acquire**

In `server/src/gpu/semaphore.ts`, extend the `Waiter` type:

```ts
type Waiter = {
  cost: number;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
};
```

Replace `acquire` with:

```ts
async acquire(cost = 1, opts?: { signal?: AbortSignal }): Promise<() => void> {
  const want = this.clampCost(cost);
  const signal = opts?.signal;
  if (signal?.aborted) {
    throw new DOMException('GpuSemaphore acquire aborted', 'AbortError');
  }
  if (this.queue.length === 0 && this.used + want <= this.capacity) {
    this.used += want;
    this.holders += 1;
    return this.makeRelease(want);
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = { cost: want, resolve, reject, settled: false, signal };
    if (signal) {
      waiter.onAbort = () => {
        if (waiter.settled) return;        // already granted — abort is a no-op
        waiter.settled = true;
        const idx = this.queue.indexOf(waiter);
        if (idx !== -1) this.queue.splice(idx, 1);  // remove: never granted, no tokens to free
        reject(new DOMException('GpuSemaphore acquire aborted', 'AbortError'));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    this.queue.push(waiter);
  });
}
```

Replace `drain` so granting a waiter settles it and detaches its abort listener:

```ts
private drain(): void {
  while (this.queue.length > 0 && this.used + this.queue[0].cost <= this.capacity) {
    const next = this.queue.shift()!;
    if (next.settled) continue;            // defensive: aborted concurrently (splice usually removed it first)
    next.settled = true;
    if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
    this.used += next.cost;
    this.holders += 1;
    next.resolve(this.makeRelease(next.cost));
  }
}
```

> **Why this is leak-safe (do not "simplify" to a `Promise.race`):** a queued waiter never incremented `used`/`holders`, so splicing it out frees nothing and corrupts nothing. A `Promise.race(acquire, abort)` wrapper would leave the losing `acquire` in the queue; `drain` later grants it with no one holding its release → tokens leak → GPU deadlock. JS is single-threaded, so `drain` (synchronous) and `onAbort` never interleave mid-statement; the `settled` flag only guards the grant-then-late-abort ordering.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/gpu/semaphore.test.ts`
Expected: PASS — the new abortable-acquire describe AND every pre-existing GpuSemaphore test (backward compat: `acquire()` and `acquire(n)` with no opts behave exactly as before).

- [ ] **Step 5: Commit**

```bash
git add server/src/gpu/semaphore.ts server/src/gpu/semaphore.test.ts
git commit -m "fix(server): make GpuSemaphore.acquire abortable via optional signal"
```

---

### Task 2: Thread the abort signal through the persona pre-pass (M1 wiring)

**Files:**
- Modify: `server/src/tts/persona-gpu-plan.ts` (`unloadResidentSidecar` ~28, `preparePersonaBatch` ~83-97)
- Modify: `server/src/routes/cast-design.ts` (call site ~line 237)
- Test: `server/src/tts/prepare-persona-batch.test.ts` (add one integration test)

**Interfaces:**
- Consumes: `gpuSemaphore.acquire(cost, { signal })` from Task 1.
- Produces: `preparePersonaBatch(bookDir: string, signal?: AbortSignal)` and `unloadResidentSidecar(signal?: AbortSignal)`. On an aborted evict-wait, `preparePersonaBatch` resolves to `{ onCpu: true, keepAlive: 0 }` (never throws). Task 3 relies on `preparePersonaBatch`'s CPU-fallback return shape.

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/prepare-persona-batch.test.ts` (inside `describe('preparePersonaBatch', …)`):

```ts
it('threads the signal into the evict acquire; aborted wait → CPU args, no throw', async () => {
  const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
  const residency = await import('../gpu/residency.js');
  const gen = await import('../routes/generation.js');

  mockResolvePersonaEngine.mockReturnValue('local');
  vi.mocked(residency.shouldEvictBeforeSidecarLoad).mockReturnValue(true); // plan.evict = true
  vi.mocked(gen.activeGenerationBooks).mockReturnValue([]);

  // A pause fires while the full-budget acquire is queued → acquire rejects AbortError.
  // (Spy-based: the REAL semaphore block can't be reached here — see the spec note. The
  //  real abort mechanism is unit-tested in semaphore.test.ts.)
  const acquireSpy = vi.spyOn(gpuSemaphore, 'acquire').mockRejectedValue(
    new DOMException('GpuSemaphore acquire aborted', 'AbortError'),
  );

  const ac = new AbortController();
  const result = await preparePersonaBatch('/a', ac.signal);
  expect(result).toEqual({ onCpu: true, keepAlive: 0 });
  // The signal is actually forwarded to the reverse-evict acquire (the 2-arg branch):
  expect(acquireSpy).toHaveBeenCalledWith(gpuSemaphore.budget, { signal: ac.signal });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/prepare-persona-batch.test.ts -t "threads the signal"`
Expected: FAIL — today `preparePersonaBatch` only catches `GpuBusyForPersonaError`, so the `AbortError` re-throws out of `preparePersonaBatch` and the `await` rejects (the assertion is never even reached).

- [ ] **Step 3: Thread the signal and catch `AbortError`**

In `server/src/tts/persona-gpu-plan.ts`, change `unloadResidentSidecar`'s signature (keep the `acquire` OUTSIDE the `try` — a rejected acquire must skip the `finally`, which would otherwise call an undefined `release`):

```ts
export async function unloadResidentSidecar(signal?: AbortSignal): Promise<void> {
  // Conditional: the no-signal path stays a literal 1-arg acquire(budget) — byte-identical
  // to today — so persona-gpu-plan.test.ts:14's `toHaveBeenCalledWith(budget)` needs no edit.
  // The 2-arg branch (signal present) is exercised by this task's new test.
  const release = signal
    ? await gpuSemaphore.acquire(gpuSemaphore.budget, { signal })
    : await gpuSemaphore.acquire(gpuSemaphore.budget);
  try {
    // ...unchanged body (render recheck + /unload + /health)...
  } finally {
    release();
  }
}
```

Change `preparePersonaBatch` to accept and forward `signal`, and add the `AbortError` arm to the catch:

```ts
export async function preparePersonaBatch(
  bookDir: string,
  signal?: AbortSignal,
): Promise<{ onCpu: boolean; keepAlive: string | number }> {
  if (resolvePersonaEngine() !== 'local') return { onCpu: false, keepAlive: 0 };
  const plan = resolvePersonaGpuPlan(bookDir);
  if (plan.evict) {
    try {
      await unloadResidentSidecar(signal);
    } catch (err) {
      // Render slipped in (GpuBusy) OR a pause aborted the evict-wait → fall back to CPU.
      if (
        err instanceof GpuBusyForPersonaError ||
        (err as { name?: string } | null)?.name === 'AbortError'
      ) {
        return { onCpu: true, keepAlive: 0 };
      }
      throw err;
    }
  }
  return { onCpu: plan.onCpu, keepAlive: plan.keepAlive };
}
```

In `server/src/routes/cast-design.ts`, pass the job's signal at the call site (~line 237):

```ts
const prep = await preparePersonaBatch(job.bookDir, job.controller.signal);
```

- [ ] **Step 4: Run BOTH affected suites to verify they pass**

Run: `cd server && npx vitest run src/tts/prepare-persona-batch.test.ts src/tts/persona-gpu-plan.test.ts`
Expected: PASS —
- the new abort test AND the three existing `preparePersonaBatch` tests stay green (they call `preparePersonaBatch('/a')` with no signal; the optional param is undefined);
- **`persona-gpu-plan.test.ts` stays green unchanged**, specifically `unloadResidentSidecar`'s `expect(acquire).toHaveBeenCalledWith(gpuSemaphore.budget)` at line 14 — because `unloadResidentSidecar()` is called there with no signal, so the conditional keeps it a literal 1-arg `acquire(budget)`. **This is the regression the plan review caught; running this file is mandatory in this task.**

- [ ] **Step 5: Typecheck the touched files**

Run: `npm run typecheck`
Expected: PASS — `cast-design.ts`'s existing `preparePersonaBatch` call now passes a second arg; no other caller changes (the two `routes/voice-style.ts` calls omit it, which is valid).

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/persona-gpu-plan.ts server/src/routes/cast-design.ts server/src/tts/prepare-persona-batch.test.ts
git commit -m "fix(server): thread pause signal through persona reverse-evict wait"
```

---

### Task 3: De-brittle the evict-refused test (M3)

**Files:**
- Test: `server/src/tts/prepare-persona-batch.test.ts` (rewrite the existing `'evict refused → CPU args, no throw'` case ~lines 82-99)

**Interfaces:**
- Consumes: `preparePersonaBatch` (Task 2), `gpuSemaphore` (spy target).
- Produces: nothing.

- [ ] **Step 1: Rewrite the test to be state-based**

Replace the existing `it('evict refused → CPU args, no throw', …)` in `server/src/tts/prepare-persona-batch.test.ts` with:

```ts
it('evict refused (render slips in during the budget wait) → CPU args, no throw', async () => {
  const { preparePersonaBatch } = await import('./persona-gpu-plan.js');
  const residency = await import('../gpu/residency.js');
  const gen = await import('../routes/generation.js');

  mockResolvePersonaEngine.mockReturnValue('local');
  vi.mocked(residency.shouldEvictBeforeSidecarLoad).mockReturnValue(true);

  // State-based: idle at plan time; a render starts WHILE we wait for the full budget.
  let activeBooks: string[] = [];
  vi.mocked(gen.activeGenerationBooks).mockImplementation(() => activeBooks);
  vi.spyOn(gpuSemaphore, 'acquire').mockImplementation(async () => {
    activeBooks = ['book-1']; // render slipped in during the evict wait
    return () => {};          // no-op release
  });
  const fetchSpy = vi.spyOn(global, 'fetch');

  const result = await preparePersonaBatch('/a');
  expect(result).toEqual({ onCpu: true, keepAlive: 0 });
  expect(fetchSpy).not.toHaveBeenCalled(); // refused evict must NOT reach /unload
  expect(gpuSemaphore.inFlight).toBe(0);   // real semaphore untouched (acquire was spied)
});
```

Note: this removes the fragile `mockReturnValueOnce([]).mockReturnValue(['book-1'])` call-order sequencing. The plan-time read (`resolvePersonaGpuPlan`) sees `[]`; the post-acquire recheck in `unloadResidentSidecar` sees `['book-1']` because the `acquire` spy flipped the state — no dependence on which internal read fires first.

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd server && npx vitest run src/tts/prepare-persona-batch.test.ts -t "evict refused"`
Expected: PASS.

- [ ] **Step 3: Verify it kills the mutant (manual sanity, then revert)**

Temporarily comment out the render recheck in `server/src/tts/persona-gpu-plan.ts` `unloadResidentSidecar` (the `if (activeGenerationBooks().length > 0) throw new GpuBusyForPersonaError(...)` block). Run the test again:

Run: `cd server && npx vitest run src/tts/prepare-persona-batch.test.ts -t "evict refused"`
Expected: FAIL — with the recheck gone, control reaches the real `fetch(.../unload)` (the `fetchSpy` has no mock impl, so it hits `http://localhost:9000`). The test then fails either way: `expect(fetchSpy).not.toHaveBeenCalled()` trips, and/or the real fetch rejection propagates out of `preparePersonaBatch`. Either failure proves the recheck is load-bearing. **Restore the recheck** and confirm the test passes again before committing.

- [ ] **Step 4: Commit**

```bash
git add server/src/tts/prepare-persona-batch.test.ts
git commit -m "test(server): make persona evict-refused test state-based, not call-ordered"
```

---

### Task 4: Revert-proof the disconnected-knob test (M4) — INDEPENDENT

**Files:**
- Test: `server/src/analyzer/voice-style.test.ts` (resolver mock ~lines 39-51; top-level `beforeEach` ~line 104; the M4 case ~lines 231-235; stray import at line 296)

**Interfaces:**
- Consumes: `resolveVoiceStyleModel` (already imported at top), `configValue` (via the resolver mock).
- Produces: nothing.

- [ ] **Step 1: Write the failing assertion**

First, add the tracked mock + shared helper. Replace the current resolver mock (lines 39-51) with:

```ts
const configValueMock = vi.fn(); // proven pattern here — cf. `generateContent` at line 24
let realConfigValue: (key: string) => unknown;
function delegateConfigValue(key: string) {
  if (key === 'analyzer.personaGeneration.engine') return process.env.PERSONA_GEN_ENGINE || 'gemini';
  if (key === 'analyzer.personaGeneration.localModel') return process.env.PERSONA_GEN_LOCAL_MODEL || '';
  return realConfigValue(key); // real impl for analyzer.gemini.voiceStyleModel
}
vi.mock('../config/resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/resolver.js')>();
  realConfigValue = actual.configValue;
  configValueMock.mockImplementation(delegateConfigValue);
  return { ...actual, configValue: configValueMock };
});
```

Then re-establish the impl every test so the two `vi.restoreAllMocks()` afterEach sites (line ~228 and line ~305) can't blank it out, AND clear its call history so the wiring assertion is per-test isolated (the mutant-kill in Step 3 must not false-pass just because an earlier test happened to call the key). Add these lines to the **top-level** `beforeEach` (~line 104, alongside the `generateContent.mockReset()` idiom):

```ts
  configValueMock.mockClear();                          // reset call history (impl-preserving)
  configValueMock.mockImplementation(delegateConfigValue);
```

Now extend the M4 case (`'resolveVoiceStyleModel reflects the registry default and an env override'`, ~line 231) with the wiring assertion:

```ts
  it('resolveVoiceStyleModel reflects the registry default and an env override', () => {
    expect(resolveVoiceStyleModel()).toBe('gemini-3.1-flash-lite'); // registry default, not a code literal
    process.env.VOICE_STYLE_MODEL = 'gemini-3.1-pro';
    expect(resolveVoiceStyleModel()).toBe('gemini-3.1-pro');
    // Revert-proof: prove it reads the registry KEY, not process.env directly.
    resolveVoiceStyleModel();
    expect(configValueMock).toHaveBeenCalledWith('analyzer.gemini.voiceStyleModel');
  });
```

- [ ] **Step 2: Run the test to verify the new assertion passes and nothing else broke**

Run: `cd server && npx vitest run src/analyzer/voice-style.test.ts`
Expected: PASS — the whole file stays green, specifically the siblings `'resolvePersonaEngine defaults to gemini, honours the env toggle'` (line ~237) and `'resolvePersonaLocalModel…'` (line ~243), which would go red if the `beforeEach` re-establishment were missing.

- [ ] **Step 3: Verify it kills the mutant (manual sanity, then revert)**

Temporarily revert the knob in `server/src/analyzer/voice-style.ts` `resolveVoiceStyleModel` to a disconnected read, e.g.:

```ts
export function resolveVoiceStyleModel(): string {
  return process.env.VOICE_STYLE_MODEL || 'gemini-3.1-flash-lite';
}
```

Run: `cd server && npx vitest run src/analyzer/voice-style.test.ts -t "resolveVoiceStyleModel reflects"`
Expected: FAIL — `configValueMock` is never called with `'analyzer.gemini.voiceStyleModel'`, so `toHaveBeenCalledWith` fails (the value assertions still pass, which is exactly the blind spot this closes). **Restore** the real `configValue('analyzer.gemini.voiceStyleModel')` read and confirm green.

- [ ] **Step 4: Tidy the one stray static import**

Move `import { generateVoiceStylePersona } from './voice-style.js';` (line 296) up into the top import block (~lines 18-22). Leave every `await import('./voice-style.js')` call untouched (that dynamic style is deliberate for mocks-before-import ordering). The `generateVoiceStylePersona dispatch` describe (line 300+) still resolves the symbol from the hoisted top-level import.

- [ ] **Step 5: Run the file once more**

Run: `cd server && npx vitest run src/analyzer/voice-style.test.ts`
Expected: PASS — full file green after the import move.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/voice-style.test.ts
git commit -m "test(server): make voice-style-model knob test assert registry wiring"
```

---

### Task 5: Release note (integrating stream, after Tasks 1-4)

**Files:**
- Modify: `docs/release-notes-next.md`

**Rationale:** M3/M4 are test-only (no shippable delta). M1 is an internal correctness fix; its only observable effect is that pausing a **local**-engine cast-design pre-pass now stops promptly instead of after the current synthesis chunk — marginal and operator-facing. Per the Before-shipping checklist, add the technical (PR-refed) entry; **skip** the user-facing `RELEASE_NOTES.md` brand-voice line — there is no meaningful end-user delta to phrase. State this skip explicitly in the PR body.

- [ ] **Step 1: Append the technical entry**

Add under the current in-progress section of `docs/release-notes-next.md` (match the surrounding entry format; PR number filled in once the PR exists):

```markdown
- fix(server): the local-persona pre-pass reverse-evict wait is now abortable, so
  pausing a local-engine cast design stops promptly instead of waiting out the
  current synthesis chunk; hardened two srv-48 regression tests (evict-refused
  state-based; voice-style-model knob asserts registry wiring). (#1561, PR #<NN>)
```

- [ ] **Step 2: Commit**

```bash
git add docs/release-notes-next.md
git commit -m "docs(server): release note for srv-48 follow-ups (M1/M3/M4)"
```

---

## Self-Review

**Spec coverage:**
- M1 (abortable acquire) → Task 1 (mechanism) + Task 2 (wiring + catch). ✓
- M1 tests: real path on fresh instances (Task 1 Step 1); spy-based integration catch (Task 2 Step 1). ✓ Matches the spec's unit-vs-integration split.
- M3 (state-based evict-refused + fetch-not-called mutant kill) → Task 3. ✓
- M4 (registry-wiring assertion + `vi.restoreAllMocks` beforeEach fix + import tidy) → Task 4. ✓
- Release notes decision → Task 5 (technical only, user-facing skip justified). ✓
- Backward-compat for `routes/voice-style.ts` → Task 2 Step 5 typecheck. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. Mutant-kill steps give exact temporary edits + restore instructions. PR number in Task 5 is a genuine unknown-until-PR-exists placeholder, flagged as such.

**Type consistency:** `acquire(cost, { signal })` defined in Task 1 is consumed with that exact shape in Task 2. `preparePersonaBatch(bookDir, signal?)` defined in Task 2 is consumed (no signal) in Task 3's test and unchanged in the two route callers. `configValueMock` / `delegateConfigValue` / `realConfigValue` names are consistent within Task 4. `AbortError` detection is `name`-based everywhere.

## Acceptance (whole branch)

- `cd server && npm run test` green (all five affected suites: `semaphore.test.ts`, `persona-gpu-plan.test.ts`, `prepare-persona-batch.test.ts`, `voice-style.test.ts`, plus the whole battery).
- `npm run typecheck` green.
- `npm run verify:fast:branch` green.
- M1 semaphore unit test proves a queued abort leaks no tokens; M3 and M4 each fail on their respective reverts (verified in Task 3/4 Step 3).
- PR is `chore(server)` (or `fix(server)` if you prefer the M1 lead), body links `Closes #1561`, and states the `RELEASE_NOTES.md` skip rationale.
