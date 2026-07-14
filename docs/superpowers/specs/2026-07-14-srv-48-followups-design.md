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

- `unloadResidentSidecar` lets the `AbortError` from `acquire` bubble out of its
  `try` (the `finally` still runs; since no token was granted on the aborted
  acquire, `release` was never assigned — see note below).
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

1. **`semaphore.test.ts`** (unit, on `GpuSemaphore` directly):
   - Aborting a **queued** waiter rejects with `AbortError`, removes it from the
     queue (`queueDepth` drops), and leaves `usedTokens` / `inFlight` uncorrupted
     — proving no token leak. A subsequent release of the holder drains normally.
   - `acquire` with an **already-aborted** signal rejects immediately and takes no
     token.
   - A **synchronously granted** acquire ignores a later `abort()` (release still
     works; no double-settle).
2. **`persona-gpu-plan.test.ts` / `prepare-persona-batch.test.ts`:** abort mid
   evict-wait → `preparePersonaBatch` returns `{ onCpu: true, keepAlive: 0 }`, no
   throw escapes.

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
'configValue')` would not observe the calls the mock intercepts. Instead, lift the
mock's `configValue` into a top-level `vi.fn()` so its calls are recorded, keeping
its current delegating behaviour:

```ts
const configValueMock = vi.fn((key: string) => {
  if (key === 'analyzer.personaGeneration.engine') return process.env.PERSONA_GEN_ENGINE || 'gemini';
  if (key === 'analyzer.personaGeneration.localModel') return process.env.PERSONA_GEN_LOCAL_MODEL || '';
  return actualResolver.configValue(key); // real impl for analyzer.gemini.voiceStyleModel
});
vi.mock('../config/resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/resolver.js')>();
  actualResolver = actual;
  return { ...actual, configValue: configValueMock };
});
```

(The `actualResolver` late-binding dance is only needed because a `vi.mock` factory
is hoisted above top-level `const`s; if the implementer finds a cleaner shape that
keeps the same delegating behaviour and makes the calls observable, that's fine.)

Then in the M4 case:

```ts
resolveVoiceStyleModel();
expect(configValueMock).toHaveBeenCalledWith('analyzer.gemini.voiceStyleModel');
```

This pins the fix's actual change — routing through the registry key — and fails
hard on revert to a direct-env or hardcoded read. The existing default/override
value assertions stay (they still document behaviour), and every current test that
relied on the inline mock keeps working because the behaviour is byte-identical.

The issue also asks to "tidy a couple of mid-file test imports." Since we are in
this file for M4, fold that in: consolidate/relocate the stray mid-file dynamic
imports in `voice-style.test.ts` to the top where the surrounding test style keeps
them. Scope it to the blocks M4 already touches plus the named stray imports —
no unrelated reformatting (surgical-changes rule).

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
