# srv-48 follow-ups: abortable reverse-evict wait + persona-gen test hardening

- **Issue:** [#1561](https://github.com/dudarenok-maker/Castwright/issues/1561)
- **Type:** `chore(server)`
- **Parent:** srv-48 (local-model persona generation, PR #1052, merge `0848054d`),
  spec `docs/superpowers/specs/2026-06-24-srv-48-persona-generation-local-model-design.md`
- **Status:** draft

## Context

Three deferred polish items from the srv-48 whole-branch review, captured on #1561
so they weren't lost when the working memory was retired. None block anything;
all are correctness/robustness tidy-ups. M2 (silent `/health` catch) was already
fixed on the srv-48 branch. This spec covers **M1, M3, M4**.

They are mutually independent — M1 is a small production change plus tests; M3 and
M4 are test-only hardening. They ship together because they share one issue and one
review context, not because they depend on each other.

## M1 — Abortable reverse-evict wait

### Problem

`unloadResidentSidecar()` (`server/src/tts/persona-gpu-plan.ts:28`) opens with:

```ts
const release = await gpuSemaphore.acquire(gpuSemaphore.budget);
```

a **full-budget** acquire that blocks until every in-flight synthesis chunk
releases. The srv-48 spec (`§Pre-pass lifecycle — heartbeats, pause, resume,
errors`, lines 341–344) requires this wait to be **abortable** so a pause during
a multi-minute pre-pass "stops promptly":

> **Pause/abort (required).** The pre-pass loop checks `job.controller.signal.aborted`
> each iteration and bails … and the reverse-evict's full-budget acquire is
> abortable so a pause during the (multi-minute) pass stops promptly.

Today it is not: once a pause fires, this acquire keeps queuing until the budget
frees. The impact is bounded (the window is a single synthesis chunk), but the
spec contract is unmet.

### Design

**Add `AbortSignal` support to `GpuSemaphore.acquire` — this is the only correct
option, not a stylistic one.** The tempting shortcut — a
`Promise.race(acquire, abortPromise)` wrapper localized in `persona-gpu-plan.ts`
— is a token-leak footgun: the losing `acquire` promise remains in the
semaphore's FIFO queue, and when `drain()` eventually grants it, no caller holds
its release. Those tokens are leaked permanently → GPU deadlock. Only the
semaphore itself can remove a queued waiter cleanly.

**Semaphore change** (`server/src/gpu/semaphore.ts`):

- New signature: `acquire(cost = 1, opts?: { signal?: AbortSignal }): Promise<() => void>`.
- **Already aborted** at call time → reject immediately with
  `new DOMException('GpuSemaphore acquire aborted', 'AbortError')`. No token taken.
- **Granted synchronously** (queue empty and tokens free) → the signal is
  irrelevant; return the release as today. A late abort after a synchronous grant
  is a no-op (caller owns the release).
- **Queued then aborted** → the abort handler splices the waiter out of `queue`
  and rejects its promise with the same `AbortError`. No tokens were ever taken,
  so nothing to release; `used`/`holders` are untouched.
- **Grant-vs-abort race:** each `Waiter` carries a `settled` guard set by whichever
  of `drain()` (grant) or the abort handler fires first; the loser no-ops. The
  abort listener is added with `{ once: true }` and removed after grant so it can't
  fire against an already-granted waiter.

`Waiter` gains the fields needed for removal/settling:
`{ cost, resolve, reject, settled, onAbort? }`.

**Threading the signal.** `job.controller.signal` already exists at the call site
(`runPersonaPrePass`, `cast-design.ts:237`). Thread an **optional** signal:

```
preparePersonaBatch(bookDir, signal?)
  → unloadResidentSidecar(signal?)
    → gpuSemaphore.acquire(gpuSemaphore.budget, { signal })
```

The two single-character `voice-style.ts` callers (lines 66, 113) pass nothing;
the optional param keeps their behaviour identical.

**Abort semantics — swallow and return CPU args (decided).**
`runDesignJob`'s outer `.catch` (`cast-design.ts:683`) turns *any* throw into a
`type:'error', code:'unknown'` broadcast — so letting an `AbortError` propagate
would surface a spurious error to the user on a clean pause. Instead:

- `unloadResidentSidecar` lets the `AbortError` from `acquire` bubble out. Because
  the `acquire` is *outside* the `try` (see the note below), a rejection throws
  before the `try` body is entered, so the `finally` is skipped and `release` (never
  assigned) is never called.
- `preparePersonaBatch` **catches `AbortError`** (alongside its existing
  `GpuBusyForPersonaError` catch) and returns CPU args
  `{ onCpu: true, keepAlive: 0 }` — the same shape as evict-refused.
- The pre-pass loop's next `if (job.controller.signal.aborted) return`
  (`cast-design.ts:247`) then stops the pass cleanly.

An `AbortError` from `acquire` only ever arises when `signal.aborted`, so this
catch can never mask a real failure.

> **Implementation note — the `finally` release.** Today `unloadResidentSidecar`
> assigns `const release = await acquire(...)` then `release()` in `finally`. When
> the acquire itself rejects, control never reaches the `try` body and there is no
> `release` to call. The current structure (acquire outside try, `try/finally`
> around the body) already handles this: a rejected acquire throws before the
> `try`, so `finally` is not entered. The implementer must preserve that ordering
> — do **not** move the `acquire` inside the `try`, or the `finally` will call an
> undefined `release`.

### Tests (M1)

> **Where the *real* abort path is verified — and why it can't be at the
> integration level.** The real abortable-`acquire` mechanism lives entirely in
> `GpuSemaphore`, so it is unit-tested there against **fresh `new GpuSemaphore(n)`
> instances** — never the module singleton `gpuSemaphore`, whose `used`/`holders`
> survive `vi.restoreAllMocks()` and would corrupt the `inFlight`-based assertions
> elsewhere in the server suite.
>
> A `preparePersonaBatch`-level test **cannot** exercise the real semaphore block:
> a full-budget `acquire` only *blocks* when `inFlight > 0`, but
> `resolvePersonaGpuPlan` (`persona-gpu-plan.ts:64`) routes any `inFlight > 0`
> state to `{ onCpu: true, evict: false }`, so `unloadResidentSidecar` is never
> even called in exactly the states where its acquire would queue. Evict-and-block
> are mutually exclusive by construction; the only production window where the
> acquire genuinely queues is a narrow TOCTOU race (tokens grabbed *between* the
> plan check and the acquire). So the integration test verifies the **catch
> behaviour only, via a spy** — it is not the real abort path, and the spec no
> longer pretends it is.

1. **`semaphore.test.ts`** (unit, on fresh `new GpuSemaphore(n)` instances):
   - Aborting a **queued** waiter rejects with `AbortError`, removes it from the
     queue (`queueDepth` drops), and leaves `usedTokens` / `inFlight` uncorrupted
     — proving no token leak. A subsequent release of the holder drains normally.
   - `acquire` with an **already-aborted** signal rejects immediately and takes no
     token.
   - A **synchronously granted** acquire ignores a later `abort()` (release still
     works; no double-settle).
2. **`prepare-persona-batch.test.ts`** (integration, catch behaviour): spy
   `gpuSemaphore.acquire` to reject with `AbortError`, assert `preparePersonaBatch`
   returns `{ onCpu: true, keepAlive: 0 }` and no throw escapes. This is explicitly
   a spy-based test of the `AbortError → CPU args` catch clause, not of the real
   semaphore abort (see the note above).

## M3 — De-brittle the evict-refused test

### Problem

`prepare-persona-batch.test.ts:92–94` sequences the `activeGenerationBooks` mock:

```ts
vi.mocked(gen.activeGenerationBooks)
  .mockReturnValueOnce([])        // 1st read: resolvePersonaGpuPlan busy-check
  .mockReturnValue(['book-1']);   // 2nd read: post-acquire recheck in unloadResidentSidecar
```

This silently encodes an assumption about **call ordering** of two internal reads.
Reorder or add a read anywhere in the call stack and the test still passes while
testing the wrong thing.

### Design

Model the scenario as **state**, and flip that state at the seam that actually
represents "time passing" — the budget acquire:

```ts
let activeBooks: string[] = [];
vi.mocked(gen.activeGenerationBooks).mockImplementation(() => activeBooks);

// A render slips in WHILE we wait for the full budget.
vi.spyOn(gpuSemaphore, 'acquire').mockImplementation(async () => {
  activeBooks = ['book-1'];
  return () => {};
});
```

This states exactly what the scenario is — a render started during the evict wait
— with zero dependence on read ordering. Assertions stay on observable outcomes:
`result` equals `{ onCpu: true, keepAlive: 0 }` and `gpuSemaphore.inFlight === 0`.

Because the `acquire` spy returns a no-op release, the real semaphore's counters
are untouched; the `inFlight === 0` assertion still holds. (The spy replaces the
whole `acquire`, so the abortable-acquire path from M1 is not exercised here — that
path has its own tests above.)

### Test (M3)

Rewrite of the existing `'evict refused → CPU args, no throw'` case. Must still go
green, and still fail if the post-acquire render recheck in `unloadResidentSidecar`
is removed.

**Make the mutant fail on a clean assertion, not incidental network behaviour.**
Because the `acquire` spy returns a no-op release, deleting the render recheck would
let `unloadResidentSidecar` fall through to the real `fetch(.../unload)` — today the
mutant is only caught by an unmocked `ECONNREFUSED`, which is timing-dependent. Add
`const fetchSpy = vi.spyOn(global, 'fetch')` and assert `expect(fetchSpy).not.toHaveBeenCalled()`
so a removed recheck fails deterministically (the refused-evict path must never
reach `/unload`).

## M4 — Make the disconnected-knob test revert-proof

### Problem

`voice-style.test.ts:231–235` verifies `resolveVoiceStyleModel()` returns the
registry default and honours `VOICE_STYLE_MODEL`:

```ts
expect(resolveVoiceStyleModel()).toBe('gemini-3.1-flash-lite');
process.env.VOICE_STYLE_MODEL = 'gemini-3.1-pro';
expect(resolveVoiceStyleModel()).toBe('gemini-3.1-pro');
```

The srv-48 fix rewired `resolveVoiceStyleModel()` to read the registry key
`analyzer.gemini.voiceStyleModel`. But `VOICE_STYLE_MODEL` is *also* that key's env
override source — so both the fixed read (`configValue('analyzer.gemini.voiceStyleModel')`)
and a reverted/disconnected read (a direct `process.env.VOICE_STYLE_MODEL` /
hardcoded default) respond to the same env var, and the defaults coincide. A revert
would **not** turn this test red.

### Design

Assert the **wiring**, not just the value: prove `resolveVoiceStyleModel()` reads
exactly the registry key `'analyzer.gemini.voiceStyleModel'` via the resolver.

**Mechanism — promote the existing resolver mock to a tracked `vi.fn()`.** The
file already replaces `configValue` inside `vi.mock('../config/resolver.js', …)`
(lines 39–51) with a plain arrow function, so a fresh `vi.spyOn(resolver,
'configValue')` would not observe the calls the mock intercepts. Instead, make the
mock's `configValue` a tracked `vi.fn()` so its calls are recorded, keeping its
current delegating behaviour. Set its implementation **inside the `vi.mock`
factory** (which already has the real `actual` in closure — no module-level
`let actualResolver` and its `vi.mock`-hoisting TDZ risk):

```ts
const configValueMock = vi.fn(); // proven pattern here — cf. `generateContent` (line 24)
vi.mock('../config/resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/resolver.js')>();
  configValueMock.mockImplementation((key: string) => {
    if (key === 'analyzer.personaGeneration.engine') return process.env.PERSONA_GEN_ENGINE || 'gemini';
    if (key === 'analyzer.personaGeneration.localModel') return process.env.PERSONA_GEN_LOCAL_MODEL || '';
    return actual.configValue(key); // real impl for analyzer.gemini.voiceStyleModel
  });
  return { ...actual, configValue: configValueMock };
});
```

> **BLOCKER hazard — `vi.restoreAllMocks()` will nuke this.** The
> `persona generation config` describe's `afterEach` calls `vi.restoreAllMocks()`
> (lines 226–229). A promoted `vi.fn()` gets its implementation stripped by that
> (a plain arrow function — today's mock — is *not* a mock, which is the only
> reason the current suite survives). Stripped, `configValueMock` returns
> `undefined`, and the sibling tests `'resolvePersonaEngine defaults to gemini…'`
> and `'resolvePersonaLocalModel…'` (lines 237, 243) go **red**. The fix is the
> same idiom `generateContent` already uses: **re-establish the implementation in
> the top-level `beforeEach` (line 104)** so it is fresh for every test. Factor the
> delegating impl into a named helper so the factory and the `beforeEach` share it.
> Acceptance is explicit: the *entire* `voice-style.test.ts` suite stays green.

Then in the M4 case:

```ts
resolveVoiceStyleModel();
expect(configValueMock).toHaveBeenCalledWith('analyzer.gemini.voiceStyleModel');
```

This pins the fix's actual change — routing through the registry key — and fails
hard on revert to a direct-env or hardcoded read. The existing default/override
value assertions stay (they still document behaviour).

The issue also asks to "tidy a couple of mid-file test imports." Scope this
narrowly: the file *deliberately* uses `await import('./voice-style.js')` inside
tests for mocks-before-import ordering — **do not** convert those dynamic imports
(gratuitous churn + timing-regression risk, against the surgical-changes rule).
Only the stray **static** `import { generateVoiceStylePersona } …` mid-file (near
line 296) should move up to the top import block. Nothing else.

### Test (M4)

The `spyOn(configValue)` assertion above, added to the existing
`'resolveVoiceStyleModel reflects the registry default and an env override'` case
(or a sibling case). Must fail on a revert of the srv-48 knob fix.

## Non-goals

- No change to the reverse-evict *policy* (fail-closed, full-budget, refuse-on-
  render). M1 only makes the *wait* abortable; the decision table is untouched.
- No new `docs/features/` regression plan — a chore of this size is specified by
  the issue body plus the paired tests. The srv-48 archived spec gets a one-line
  "M1/M3/M4 addressed in #1561" pointer, nothing more.
- No behaviour change for the two `voice-style.ts` single-character callers (they
  pass no signal).

## Files touched

| File | Change |
|---|---|
| `server/src/gpu/semaphore.ts` | `acquire` gains optional `{ signal }`; abortable queued-waiter removal |
| `server/src/gpu/semaphore.test.ts` | M1 unit tests (queued-abort, already-aborted, granted-ignores-abort) |
| `server/src/tts/persona-gpu-plan.ts` | thread `signal` through `preparePersonaBatch` → `unloadResidentSidecar` → `acquire`; catch `AbortError` → CPU args |
| `server/src/tts/prepare-persona-batch.test.ts` | M3 state-based rewrite; M1 abort-mid-wait case |
| `server/src/routes/cast-design.ts` | pass `job.controller.signal` into `preparePersonaBatch` |
| `server/src/analyzer/voice-style.test.ts` | M4 `spyOn(configValue)` wiring assertion; tidy mid-file imports |

`voice-style.ts:66,113` (voice-style routes) are **not** edited — the optional
signal defaults keep them unchanged.

## Acceptance

- All server tests green (`npm run test:server`).
- M1 semaphore unit test proves a queued abort leaks no tokens.
- M3 test passes and fails on removal of the post-acquire render recheck.
- M4 test fails on a revert of the `resolveVoiceStyleModel` knob fix.
- `npm run verify:fast:branch` green; PR is `chore(server): …`, links `Closes #1561`.
