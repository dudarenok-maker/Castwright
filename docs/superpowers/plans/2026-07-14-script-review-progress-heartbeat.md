# Script-review Progress Heartbeat, Model Naming & Clean Model-Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the script-review pass show continuous liveness (warm/waiting/streaming timer + intra-chapter progress) and its engine·model on the global activity pill, add an explicit cold-Ollama warm step that aborts cleanly (or switches to Gemini) instead of hanging silently, and surface the previously-silent mid-pass Gemini fallback.

**Architecture:** Extend the one shared `SubstageEntry` (fed by the existing script-review SSE → thunk → `scriptReview.activeStreams` → `selectAnalysisSubstage` path) with five optional fields; the server stamps coarse `activityState` + `model`/`engine` onto `phase` events and emits a per-chunk `phase` and a warm `phase`; the client adds the missing `heartbeat` case, upgrades to `streaming` on a `receivedBytes`-bearing heartbeat, ticks a client-side timer, and renders engine·model + timer + fallback note in the status-popover (with an amber compact-pill tone). Only the global pill (top-bar `StatusPill` + `StatusPopover`) changes; the inline manuscript pill is untouched.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (frontend); Node + Express SSE (server); Vitest (frontend + server), Playwright (e2e).

## Global Constraints

- Design tokens are CSS custom properties — **no hex literals** in component code (use existing `--*` vars / Tailwind token classes; reuse the amber/warn token the codebase already uses for warn toasts).
- OpenAPI is the type source of truth for `Character`/`Chapter`/`Sentence`; do **not** hand-write those. The SSE event payloads here are *not* OpenAPI-modelled (they flow through the permissive `replay`/event objects) — extend the hand-rolled parsers instead.
- RTK reducers mutate via Immer drafts — mutate the draft directly, never return spreads.
- Reducers stay **pure**: no `Date.now()` inside a reducer. The thunk stamps timestamps and passes them in the payload.
- Every post-init script-review event dispatches through the **merge** action (`updateProgress`), never `setActive` (which fully replaces the entry and would wipe the new fields).
- Mocks behind `VITE_USE_MOCKS`: components import only from `api.*`. The mock `reviewScript` must emit the new events so e2e/component tests can exercise them.
- Commit convention: `<type>(<scope>): <subject>`. Use `feat(frontend)` / `feat(server)` / `test(...)` / `docs(frontend)` as fits each task.

---

## File Structure

**Server (`server/src/`):**
- `routes/ollama-health.ts` — extract the `/load` warm body into an exported `warmOllamaModel(...)` helper; route calls it. (Task 3)
- `analyzer/types.ts` (or wherever `StageCall` is declared — grep `interface StageCall`) — add optional `onFallback`. (Task 4)
- `analyzer/index.ts` — `FallbackAnalyzer.runScriptReviewChapter` invokes `call.onFallback`. (Task 4)
- `routes/script-review.ts` — `runScriptReviewJob`: model/engine/`activityState` on chapter-start `phase`, per-chunk `phase`, warm step + C1 gating + `switchToFallback` latch, `onFallback` wiring, cancel-during-warm. (Tasks 5, 6)

**Frontend state (`src/store/`):**
- `prosody-slice.ts` — add five optional fields to `SubstageEntry`. (Task 1)
- `analysis-substage-reducers.ts` — extend both payload types + both reducer bodies (change-stamped `activitySince`). (Task 1)
- `analysis-substage-selectors.ts` — project the five fields. (Task 2)
- `script-review-thunk.ts` — drive new fields via `updateProgress`, `onHeartbeat` streaming upgrade, Retry toast. (Task 9)

**Frontend lib/hooks (`src/lib/`, `src/hooks/`):**
- `lib/api.ts` — `SubstagePhaseEvent` + `parseSubstagePhaseEvent` extend; `ReviewScriptOpts.onPhase` extend + add `onHeartbeat`; `case 'heartbeat'` in `realReviewScript` **and** `realAttachScriptReview`. (Task 8)
- `hooks/use-elapsed.ts` (new) — ticking elapsed-seconds hook. (Task 10)
- `mocks/*` — mock `reviewScript`/`attachScriptReview` emit new events. (Task 13)

**Frontend components (`src/components/`):**
- `status-popover.tsx` — `SubstageRow`: engine·model line + timer + fallback note; widen prop. (Task 11)
- `top-bar.tsx` — `summarizeStatus` amber tone; widen `StatusInput.analysisSubstage`. (Task 12)

**Tests / docs:**
- `e2e/responsive/*` or a new `e2e/script-review-heartbeat.spec.ts`. (Task 14)
- `docs/release-notes-next.md`, `RELEASE_NOTES.md`, spec `status:`. (Task 15)

---

### Task 1: Extend the shared `SubstageEntry` + reducers

**Files:**
- Modify: `src/store/prosody-slice.ts:20-32` (the `SubstageEntry` interface)
- Modify: `src/store/analysis-substage-reducers.ts:14-63`
- Test: `src/store/analysis-substage-reducers.test.ts` (create if absent)

**Interfaces:**
- Produces: `SubstageEntry` gains `model?`, `engine?: 'local'|'gemini'`, `activityState?: 'loading'|'waiting'|'streaming'`, `activitySince?: number`, `fallbackActive?: boolean`. `UpdateSubstageProgressPayload` gains those five plus `now?: number` (the client timestamp used to stamp `activitySince` on an `activityState` change). `SetActiveSubstagePayload` is unchanged (pass-start only ever sets `progress`/`label`).

- [ ] **Step 1: Write the failing test**

```ts
// src/store/analysis-substage-reducers.test.ts
import { describe, it, expect } from 'vitest';
import { setActiveSubstage, updateSubstageProgress } from './analysis-substage-reducers';
import type { SubstageEntry } from './prosody-slice';

describe('substage reducers — heartbeat/model fields', () => {
  it('updateSubstageProgress merges model/engine/activityState and stamps activitySince on state change', () => {
    const state: Record<string, SubstageEntry> = {
      b1: { progress: 0, label: 'Reviewing script' },
    };
    updateSubstageProgress(state, {
      bookId: 'b1', progress: 0, activityState: 'waiting', model: 'qwen3.5:9b', engine: 'local', now: 1000,
    });
    expect(state.b1.activityState).toBe('waiting');
    expect(state.b1.activitySince).toBe(1000);
    expect(state.b1.model).toBe('qwen3.5:9b');
    expect(state.b1.engine).toBe('local');
  });

  it('re-stamps activitySince only when activityState actually changes', () => {
    const state: Record<string, SubstageEntry> = {
      b1: { progress: 10, label: 'Reviewing script', activityState: 'streaming', activitySince: 1000 },
    };
    // same state, later tick — must NOT move activitySince (progress is a 0..1 fraction)
    updateSubstageProgress(state, { bookId: 'b1', progress: 0.2, activityState: 'streaming', now: 5000 });
    expect(state.b1.activitySince).toBe(1000);
    // transition — must re-stamp
    updateSubstageProgress(state, { bookId: 'b1', progress: 0.2, activityState: 'waiting', now: 6000 });
    expect(state.b1.activitySince).toBe(6000);
  });

  it('sets fallbackActive and does not lose it on later merges', () => {
    const state: Record<string, SubstageEntry> = { b1: { progress: 0, label: 'x' } };
    updateSubstageProgress(state, { bookId: 'b1', progress: 0, fallbackActive: true, engine: 'gemini', model: 'gemma-4-31b-it' });
    updateSubstageProgress(state, { bookId: 'b1', progress: 5 }); // bare progress tick
    expect(state.b1.fallbackActive).toBe(true);
    expect(state.b1.engine).toBe('gemini');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/store/analysis-substage-reducers.test.ts`
Expected: FAIL — the new payload fields don't exist / aren't applied.

- [ ] **Step 3: Implement**

In `src/store/prosody-slice.ts`, add to the `SubstageEntry` interface (after `estRemainingMs?`):

```ts
  /** Resolved model id (e.g. `qwen3.5:9b` or `gemma-4-31b-it`). */
  model?: string;
  /** Effective active backend (flips to 'gemini' on a mid-pass fallback). */
  engine?: 'local' | 'gemini';
  /** Coarse phase of the pass. 'loading'/'waiting' are server-stamped on
      phase events; 'streaming' is a client upgrade off a live heartbeat. */
  activityState?: 'loading' | 'waiting' | 'streaming';
  /** Client Date.now() stamped when activityState last changed; drives the
      client-side ticking timer. Re-stamped on reattach (timer resets). */
  activitySince?: number;
  /** True once the pass has switched Ollama → Gemini mid-run. Idempotent. */
  fallbackActive?: boolean;
```

In `src/store/analysis-substage-reducers.ts`, extend `UpdateSubstageProgressPayload` (add after `estRemainingMs?`):

```ts
  model?: string;
  engine?: 'local' | 'gemini';
  activityState?: 'loading' | 'waiting' | 'streaming';
  fallbackActive?: boolean;
  /** Client timestamp used to stamp activitySince when activityState changes. */
  now?: number;
```

Extend `updateSubstageProgress` (append inside the function, after the `estRemainingMs` line):

```ts
  if (payload.model !== undefined) e.model = payload.model;
  if (payload.engine !== undefined) e.engine = payload.engine;
  if (payload.fallbackActive !== undefined) e.fallbackActive = payload.fallbackActive;
  if (payload.activityState !== undefined && payload.activityState !== e.activityState) {
    e.activityState = payload.activityState;
    if (payload.now !== undefined) e.activitySince = payload.now;
  }
```

(Leave `setActiveSubstage` / `SetActiveSubstagePayload` unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/store/analysis-substage-reducers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/prosody-slice.ts src/store/analysis-substage-reducers.ts src/store/analysis-substage-reducers.test.ts
git commit -m "feat(frontend): extend substage entry with model/engine/activity fields"
```

---

### Task 2: Project the new fields through `selectAnalysisSubstage`

**Files:**
- Modify: `src/store/analysis-substage-selectors.ts:30-65`
- Test: `src/store/analysis-substage-selectors.test.ts` (create if absent)

**Interfaces:**
- Produces: `selectAnalysisSubstage` return type gains `model?`, `engine?`, `activityState?`, `activitySince?`, `fallbackActive?` (same optional shape as `SubstageEntry`), projected for both the prosody and review branches.

- [ ] **Step 1: Write the failing test**

```ts
// src/store/analysis-substage-selectors.test.ts
import { describe, it, expect } from 'vitest';
import { selectAnalysisSubstage } from './analysis-substage-selectors';
import type { RootState } from './index';

const base = (review: Record<string, unknown>) =>
  ({ prosody: { activeStreams: {} }, scriptReview: { activeStreams: review } }) as unknown as RootState;

describe('selectAnalysisSubstage — new fields', () => {
  it('projects model/engine/activityState/activitySince/fallbackActive for a review pass', () => {
    const s = base({
      b1: { progress: 12, label: 'Reviewing script', model: 'gemma-4-31b-it', engine: 'gemini', activityState: 'streaming', activitySince: 1000, fallbackActive: true },
    });
    const out = selectAnalysisSubstage(s);
    expect(out).toMatchObject({ kind: 'review', model: 'gemma-4-31b-it', engine: 'gemini', activityState: 'streaming', activitySince: 1000, fallbackActive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/store/analysis-substage-selectors.test.ts`
Expected: FAIL — projected object lacks the new keys.

- [ ] **Step 3: Implement**

In `analysis-substage-selectors.ts`, widen the `createSelector` result type (add the five optional fields to the returned union type), and add them to **both** the prosody (`p.entry.*`) and review (`r.entry.*`) return objects, e.g. for the review branch:

```ts
      return {
        kind: 'review',
        label: r.entry.label,
        percent: r.entry.progress,
        chapterIndex: r.entry.chapterIndex,
        totalChapters: r.entry.totalChapters,
        estRemainingMs: r.entry.estRemainingMs,
        model: r.entry.model,
        engine: r.entry.engine,
        activityState: r.entry.activityState,
        activitySince: r.entry.activitySince,
        fallbackActive: r.entry.fallbackActive,
      };
```

(Mirror the same five lines in the prosody branch — they'll simply be `undefined` for prosody, which is correct.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/store/analysis-substage-selectors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/analysis-substage-selectors.ts src/store/analysis-substage-selectors.test.ts
git commit -m "feat(frontend): project heartbeat/model fields through substage selector"
```

---

### Task 3: Extract `warmOllamaModel` helper (server)

**Files:**
- Modify: `server/src/routes/ollama-health.ts:296-328`
- Test: `server/src/routes/ollama-health.test.ts` (add a case; create if absent)

**Interfaces:**
- Produces: `export async function warmOllamaModel(model: string, opts?: { signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; status: number; error: string }>` — POSTs the empty-prompt `keep_alive:'5m'` generate with matching `num_ctx`/`num_gpu`, using `getResolvedOllamaUrl()` internally. The `/load` route becomes a thin wrapper over it.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/routes/ollama-health.test.ts  (add)
import { describe, it, expect, vi } from 'vitest';

describe('warmOllamaModel', () => {
  it('resolves ok:false with the upstream error when the daemon is down', async () => {
    // Point the resolver at an unreachable URL, or mock callOllamaGenerate to ok:false.
    const { warmOllamaModel } = await import('./ollama-health');
    const res = await warmOllamaModel('qwen3.5:9b');
    expect(res.ok).toBe(false);
  });
});
```

(If the suite already mocks `callOllamaGenerate`, assert `warmOllamaModel` passes `options.num_ctx === resolveAnalyzerNumCtx()` and `num_gpu === resolveAnalyzerNumGpu()` and forwards `opts.signal`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- ollama-health`
Expected: FAIL — `warmOllamaModel` not exported.

- [ ] **Step 3: Implement**

Extract the body of the `/load` handler into an exported helper and have the route call it:

```ts
export async function warmOllamaModel(
  model: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const url = getResolvedOllamaUrl();
  const result = await callOllamaGenerate(
    url,
    {
      model,
      prompt: '',
      keep_alive: '5m',
      stream: false,
      options: { num_ctx: resolveAnalyzerNumCtx(), num_gpu: resolveAnalyzerNumGpu() },
    },
    LOAD_TIMEOUT_MS,
    opts.signal,
  );
  return result.ok ? { ok: true } : { ok: false, status: result.status, error: result.error ?? '' };
}
```

And make the route a thin wrapper over it:

```ts
ollamaHealthRouter.post('/load', async (req: Request, res: Response) => {
  const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const model = requested || getResolvedOllamaModel();
  const result = await warmOllamaModel(model);
  if (!result.ok) return res.status(result.status).json({ status: 'error', error: result.error });
  return res.json({ status: 'ready' });
});
```

`callOllamaGenerate(url, body, timeoutMs)` today has **no signal param** and creates its own timeout `AbortController` internally (`ollama-health.ts:254-265`). `fetch` takes exactly one signal, so you cannot just pass `opts.signal` to `fetch` — that would drop the timeout. Add an optional trailing `signal?: AbortSignal` param and **combine** it with the internal timeout controller so both still abort the request:

```ts
// inside callOllamaGenerate, add a trailing `extSignal?: AbortSignal` param.
// Where it currently does fetch(url, { ..., signal: controller.signal }):
const signal = extSignal ? AbortSignal.any([controller.signal, extSignal]) : controller.signal;
// ... fetch(url, { ..., signal });
```
(`AbortSignal.any` is available on Node 20.6+, which this repo targets. All existing callers omit the new param, so it's backward-compatible.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- ollama-health`
Expected: PASS. Also confirm the existing `/load` route tests still pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ollama-health.ts server/src/routes/ollama-health.test.ts
git commit -m "feat(server): extract warmOllamaModel helper from /load route"
```

---

### Task 4: `StageCall.onFallback` + `FallbackAnalyzer` fires it (server)

**Files:**
- Modify: the `StageCall` interface (grep `interface StageCall` — likely `server/src/analyzer/types.ts`)
- Modify: `server/src/analyzer/index.ts:300-320` (`FallbackAnalyzer.runScriptReviewChapter`)
- Test: `server/src/analyzer/fallback-analyzer.test.ts` (create if absent; check for an existing analyzer test to extend)

**Interfaces:**
- Produces: `StageCall.onFallback?: (info: { reason: string }) => void`. `FallbackAnalyzer.runScriptReviewChapter` calls `call.onFallback?.({ reason: 'Ollama unreachable' })` immediately before delegating to the fallback, only on the `LocalUnreachableError` branch.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/analyzer/fallback-analyzer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { FallbackAnalyzer } from './index';
import { LocalUnreachableError } from './ollama'; // NOT ./errors — errors.ts only exports AnalyzerTruncatedError

const stubOut = { ops: [] } as any;

describe('FallbackAnalyzer.runScriptReviewChapter onFallback', () => {
  it('fires onFallback once and returns the fallback result when primary is unreachable', async () => {
    const primary = { runScriptReviewChapter: vi.fn().mockRejectedValue(new LocalUnreachableError('down')) } as any;
    const fallback = { runScriptReviewChapter: vi.fn().mockResolvedValue(stubOut) } as any;
    const fa = new FallbackAnalyzer(primary, fallback);
    const onFallback = vi.fn();
    const out = await fa.runScriptReviewChapter('m', 1, 'p', { onFallback } as any);
    expect(out).toBe(stubOut);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({ reason: expect.any(String) });
  });

  it('does NOT fire onFallback when primary succeeds', async () => {
    const primary = { runScriptReviewChapter: vi.fn().mockResolvedValue(stubOut) } as any;
    const fallback = { runScriptReviewChapter: vi.fn() } as any;
    const onFallback = vi.fn();
    await new FallbackAnalyzer(primary, fallback).runScriptReviewChapter('m', 1, 'p', { onFallback } as any);
    expect(onFallback).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- fallback-analyzer`
Expected: FAIL — `onFallback` never invoked.

- [ ] **Step 3: Implement**

Add to the `StageCall` interface:

```ts
  /** Fired by FallbackAnalyzer when it switches from a LocalUnreachable
      primary to the fallback for this call. Route uses it to announce the
      switch. */
  onFallback?: (info: { reason: string }) => void;
```

In `FallbackAnalyzer.runScriptReviewChapter`, change the `LocalUnreachableError` branch:

```ts
      if (err instanceof LocalUnreachableError) {
        call.onFallback?.({ reason: 'Ollama unreachable' });
        return await this.fallback.runScriptReviewChapter(manuscriptId, chapterId, promptMd, call);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- fallback-analyzer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/*.ts server/src/analyzer/fallback-analyzer.test.ts
git commit -m "feat(server): announce Ollama→Gemini fallback via StageCall.onFallback"
```

---

### Task 5: Model/engine/activityState on phase + per-chunk creep (server route)

**Files:**
- Modify: `server/src/routes/script-review.ts:690-752` (chapter-start `phase`, chunk loop)
- Test: `server/src/routes/script-review.*.test.ts` (extend the existing SSE-event test; grep for a test that asserts `kind: 'phase'`)

**Interfaces:**
- Consumes: `activeSelection` (introduced in Task 6 as a mutable `let activeSelection = selection`). **For this task, reference `selection` directly**; Task 6 renames the reads to `activeSelection`. To avoid churn, introduce `let activeSelection = selection;` right after `const selection = selectAnalyzerForPhase(...)` (line 674) now, and read `activeSelection.model` / `activeSelection.engine` here.
- Produces: chapter-start `phase` carries `activityState: 'waiting'`, `model`, `engine`; a per-chunk `phase` carries only `progress`.

- [ ] **Step 1: Write the failing test**

Extend the route test to assert (against a mocked analyzer that yields ops for a 2-chunk chapter) that:
```ts
// pseudocode within the existing SSE-collecting test harness
const phases = events.filter((e) => e.kind === 'phase');
// chapter-start phase carries model + engine + waiting
expect(phases[0]).toMatchObject({ label: 'Reviewing script', activityState: 'waiting', model: expect.any(String), engine: expect.stringMatching(/local|gemini/) });
// a per-chunk phase advanced progress strictly between chapter starts
const progresses = phases.map((p) => p.progress);
expect(progresses.some((p, i) => i > 0 && p > progresses[i - 1] && p < 1)).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- script-review`
Expected: FAIL — phase lacks `activityState`/`model`/`engine`; no intra-chapter progress.

- [ ] **Step 3: Implement**

After `const selection = selectAnalyzerForPhase({ phase: 'phase1', model });` (line 674), add:
```ts
  let activeSelection = selection; // Task 6 may reassign this to a Gemini-only selection
```

Change the chapter-start `phase` (line 693-707) to add the three fields:
```ts
      send({
        kind: 'phase',
        phaseId: 0,
        progress: i / chapterIds.length,
        label: 'Reviewing script',
        chapterId,
        activityState: 'waiting',
        model: activeSelection.model,
        engine: activeSelection.engine,
        ...chapterPacingPhaseFields({ /* unchanged */ }),
      });
```

In the chunk loop, after the successful `send({ kind: 'ops', ... })` block (or at the end of each chunk iteration, unconditionally so single-op-less chunks still advance), emit a progress-only phase:
```ts
        // Intra-chapter creep: only advances the bar for multi-chunk (local)
        // chapters; single-chunk / cloud chapters rely on the client timer.
        send({
          kind: 'phase',
          phaseId: 0,
          progress: (i + (index + 1) / chunks.length) / chapterIds.length,
          label: 'Reviewing script',
          chapterId,
        });
```

Place this **after** the `try/catch` for the chunk so a failed chunk still advances the bar. Do not emit it when `job.controller.signal.aborted` (guard with the existing check).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- script-review`
Expected: PASS. Also add/confirm a `GET /state` test asserting `lastPhase` carries `model`/`engine`/`activityState` (free, since `send()` stores the phase record into `job.replay.lastPhase`).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review*.test.ts
git commit -m "feat(server): stamp model/engine/activityState on review phases + per-chunk creep"
```

---

### Task 6: Warm step + C1 gating + `switchToFallback` latch (server route)

**Files:**
- Modify: `server/src/routes/script-review.ts:674-800` (`runScriptReviewJob`)
- Test: `server/src/routes/script-review.*.test.ts`

**Interfaces:**
- Consumes: `warmOllamaModel` (Task 3), `selectAnalyzer` (from `../analyzer` — for the Gemini-only re-selection), `activeSelection` (Task 5).
- Produces: a warm `phase { activityState: 'loading', model, engine }` before the loop; `error { code: 'model_load_failed' }` only when `selection.fallbackModel === null`; a one-time `switchToFallback` that re-selects a Gemini-only analyzer, emits one announcement `phase` with `engine: 'gemini'` + `fallbackReason`, and flips subsequent chapters onto Gemini.

- [ ] **Step 1: Write the failing tests**

```ts
// Three branch tests in the route suite (mock warmOllamaModel + selectAnalyzer):

// A) local engine, no Gemini key, warm fails → model_load_failed, zero chapters
//    expect(events).toContainEqual(objContaining({ kind: 'error', code: 'model_load_failed' }));
//    expect(events.filter(e => e.kind === 'ops')).toHaveLength(0);

// B) local engine, Gemini key present, warm fails → NO model_load_failed; one
//    announcement phase with engine 'gemini' + fallbackReason; chapters run.
//    expect(events.find(e => e.kind === 'error')).toBeUndefined();
//    expect(events.filter(e => e.kind === 'phase' && e.engine === 'gemini' && e.fallbackReason)).toHaveLength(1);

// C) cancel during warm → error code 'cancelled', NOT model_load_failed.
//    (abort the controller while warmOllamaModel is pending)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:server -- script-review`
Expected: FAIL — no warm step exists yet.

- [ ] **Step 3: Implement**

Immediately after `let activeSelection = selection;` (Task 5) and before the `for` loop, add the warm step + the switch helper. Import `warmOllamaModel` from `./ollama-health.js` and `selectAnalyzer` from `../analyzer/index.js` (**explicit `.js` — NodeNext resolution rejects a bare `'../analyzer'` directory import**; `selectAnalyzer` is exported at `analyzer/index.ts:178`):

```ts
  let fellBack = false;
  const switchToFallback = (reason: string): void => {
    if (fellBack) return;
    fellBack = true;
    // Re-select a Gemini-only analyzer (fallbackModel has no ':' → gemini),
    // so subsequent chapters skip the dead Ollama primary entirely.
    if (selection.fallbackModel) activeSelection = selectAnalyzer({ model: selection.fallbackModel });
    send({
      kind: 'phase',
      phaseId: 0,
      progress: 0,
      label: 'Reviewing script',
      activityState: 'waiting',
      model: activeSelection.model,
      engine: activeSelection.engine, // 'gemini'
      fallbackReason: reason,
    });
  };

  // Warm the analyzer model the first chapter will actually use, so a cold
  // Ollama doesn't hang silently behind chapter 1's first token.
  if (activeSelection.engine === 'local') {
    send({ kind: 'phase', phaseId: 0, progress: 0, label: 'Loading model', activityState: 'loading', model: activeSelection.model, engine: 'local' });
    const warm = await warmOllamaModel(activeSelection.model, { signal: job.controller.signal });
    if (job.controller.signal.aborted) {
      send({ kind: 'error', code: 'cancelled', message: 'Review cancelled.' });
      for (const sub of job.subscribers) sub.res.end();
      return;
    }
    if (!warm.ok) {
      if (selection.fallbackModel === null) {
        send({ kind: 'error', code: 'model_load_failed', message: `Couldn't load the analyzer model (${activeSelection.model}). Is Ollama running?`, model: activeSelection.model });
        for (const sub of job.subscribers) sub.res.end();
        return;
      }
      // A Gemini fallback exists — don't abort a setup that works today.
      switchToFallback('Ollama unreachable');
    }
  }
```

Wire `onFallback` into the per-chunk `runScriptReviewChapter` call (line 731-736) so a mid-pass drop also announces + latches:
```ts
            onThrottle: (waitMs, reason) => send({ kind: 'throttle', phaseId: 0, chapterIndex: chapterId, model: activeSelection.model, waitMs, reason }),
            onFallback: ({ reason }) => switchToFallback(reason),
```
And change `selection.analyzer` → `activeSelection.analyzer`, `selection.model` → `activeSelection.model`, `selection.engine` → `activeSelection.engine` throughout the loop (chunk budget at line 715 uses `activeSelection.engine`).

Note on cancel-during-warm: `warmOllamaModel` receives the abort signal (Task 3), so a cancel rejects/returns promptly and the `aborted` guard emits `cancelled`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:server -- script-review`
Expected: PASS (all three branches + Task 5 tests still green).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review*.test.ts
git commit -m "feat(server): explicit warm step with clean abort + Gemini-switch for review"
```

---

### Task 7: API SSE reader — parse new phase fields + `heartbeat` case

**Files:**
- Modify: `src/lib/api.ts` — `SubstagePhaseEvent` type + `parseSubstagePhaseEvent` (grep both), `ReviewScriptOpts`, `realReviewScript:3157-3202`, and the attach reader (grep `realAttachScriptReview` / the second `handle` switch).
- Test: `src/lib/api.test.ts` (or the existing script-review api test — grep `parseSubstagePhaseEvent`)

**Interfaces:**
- Produces: `onPhase` callback payload gains `model?`, `engine?: 'local'|'gemini'`, `activityState?: 'loading'|'waiting'|'streaming'`, `fallbackReason?: string`. `ReviewScriptOpts` gains `onHeartbeat?: (ev: { chapterId: number; streaming: boolean }) => void`. A new `case 'heartbeat'` calls `onHeartbeat` with `streaming: typeof p.receivedBytes === 'number'`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/api.test.ts (add)
import { describe, it, expect } from 'vitest';
import { parseSubstagePhaseEvent } from './api'; // export it if not already

describe('parseSubstagePhaseEvent — new fields', () => {
  it('parses model/engine/activityState/fallbackReason', () => {
    const ev = parseSubstagePhaseEvent({ kind: 'phase', progress: 0.5, label: 'Reviewing script', model: 'gemma-4-31b-it', engine: 'gemini', activityState: 'waiting', fallbackReason: 'Ollama unreachable' });
    expect(ev).toMatchObject({ progress: 0.5, model: 'gemma-4-31b-it', engine: 'gemini', activityState: 'waiting', fallbackReason: 'Ollama unreachable' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/api.test.ts`
Expected: FAIL — parser drops the new fields (and `parseSubstagePhaseEvent` may be unexported).

- [ ] **Step 3: Implement**

Extend the `SubstagePhaseEvent` type and `parseSubstagePhaseEvent` to carry the four optional fields (validate types: `model`/`engine`/`activityState`/`fallbackReason` are strings; only pass through when the right type, mirroring the existing guarded parse). Export `parseSubstagePhaseEvent` if needed for the test.

Extend `ReviewScriptOpts` with `onHeartbeat?: (ev: { chapterId: number; streaming: boolean }) => void;` and add the case in **both** `realReviewScript`'s and the attach reader's `handle` switch. **The heartbeat wire field is `chapterIndex`, NOT `chapterId`** (`server/src/routes/analysis-heartbeat.ts:32-43` emits `chapterIndex: chapterId, receivedBytes, …`; the existing `throttle` case at `api.ts:3165` already reads `p.chapterIndex`). Reading `p.chapterId` here would make the case never fire and silently kill the streaming upgrade:
```ts
      case 'heartbeat':
        if (typeof p.chapterIndex === 'number') {
          onHeartbeat?.({ chapterId: p.chapterIndex, streaming: typeof p.receivedBytes === 'number' });
        }
        break;
```
(Destructure `onHeartbeat` in both function signatures. `ReviewScriptOpts` is shared by `realReviewScript` and `realAttachScriptReview` — add it once. `parseSubstagePhaseEvent` is currently unexported — export it for the test.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api.test.ts
git commit -m "feat(frontend): parse model/engine/activityState + handle heartbeat in review SSE"
```

---

### Task 8: `useElapsed` hook

**Files:**
- Create: `src/hooks/use-elapsed.ts` (match the repo's hooks location — grep an existing `use-*.ts` under `src/`)
- Test: `src/hooks/use-elapsed.test.ts`

**Interfaces:**
- Produces: `export function useElapsed(since: number | undefined): number` — returns whole seconds since `since` (0 when `since` is undefined), re-rendering ~1×/s via a `setInterval`, cleaned up on unmount/`since` change.

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/use-elapsed.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useElapsed } from './use-elapsed';

afterEach(() => vi.useRealTimers());

describe('useElapsed', () => {
  it('returns 0 for undefined and ticks up from `since`', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { result, rerender } = renderHook(({ s }) => useElapsed(s), { initialProps: { s: undefined as number | undefined } });
    expect(result.current).toBe(0);
    rerender({ s: 10_000 });
    act(() => { vi.setSystemTime(13_000); vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/hooks/use-elapsed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { useEffect, useState } from 'react';

/** Whole seconds elapsed since `since` (ms epoch); 0 when undefined. Ticks
    ~1×/s so callers re-render a live counter without server chatter. */
export function useElapsed(since: number | undefined): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === undefined) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [since]);
  if (since === undefined) return 0;
  return Math.max(0, Math.floor((Date.now() - since) / 1000));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/hooks/use-elapsed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-elapsed.ts src/hooks/use-elapsed.test.ts
git commit -m "feat(frontend): add useElapsed ticking-seconds hook"
```

---

### Task 9: Thunk — drive new fields, streaming upgrade, Retry

**Files:**
- Modify: `src/store/script-review-thunk.ts:40-147` (`runReviewScript`), `:239-319` (`attachToRunningReview`)
- Test: `src/store/script-review-thunk.test.ts` (extend; grep existing)

**Interfaces:**
- Consumes: Task 1 `updateProgress` fields, Task 7 `onPhase` extended payload + `onHeartbeat`.
- Produces: `onPhase` dispatches `updateProgress` with `activityState`/`model`/`engine`/`now: Date.now()` and sets `fallbackActive: true` when `fallbackReason` present; `onHeartbeat` with `streaming: true` dispatches `updateProgress({ activityState: 'streaming', now: Date.now() })`; a `model_load_failed` error surfaces a toast **with a Retry action** that re-dispatches `runReviewScript`.

- [ ] **Step 1: Write the failing test**

```ts
// src/store/script-review-thunk.test.ts (add cases)
// 1) onPhase carrying model/engine/activityState + fallbackReason dispatches
//    updateProgress with those fields + fallbackActive true.
// 2) onHeartbeat({streaming:true}) dispatches updateProgress activityState 'streaming'.
// 3) a ReviewScriptError code 'model_load_failed' pushes a toast whose action re-runs.
// Use the existing api mock pattern in this suite (it already stubs api.reviewScript
// with a callback-driver); assert dispatched actions via a spy dispatch.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/store/script-review-thunk.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `runReviewScript`, extend the `onPhase` handler:
```ts
      onPhase: ({ progress, label, chapterIndex, totalChapters, estRemainingMs, activityState, model: phaseModel, engine, fallbackReason }) =>
        dispatch(
          scriptReviewActions.updateProgress({
            bookId, progress, label, chapterIndex, totalChapters, estRemainingMs,
            activityState, model: phaseModel, engine,
            ...(fallbackReason ? { fallbackActive: true } : {}),
            now: Date.now(),
          }),
        ),
```
Add an `onHeartbeat`:
```ts
      onHeartbeat: ({ streaming }) => {
        if (streaming) dispatch(scriptReviewActions.updateProgress({ bookId, progress: /* keep */ currentProgressFraction(), activityState: 'streaming', now: Date.now() }));
      },
```
`updateProgress` requires a `progress` number. To avoid moving the bar on a heartbeat, read the last known fraction: track `let lastProgress = 0;` updated in `onPhase` (`lastProgress = progress`) and pass it here. (Simplest correct approach — the reducer multiplies by 100 and rounds; passing the same fraction is a no-op for the bar.)

Add the Retry toast in the `catch`'s error branch. **A function-valued `action.run` is NOT viable** — `Toast`/`PushToastPayload` (`notifications-slice.ts:28-50`) have no `action` field, and toasts are stored in Redux (`s.toasts.push`), so a closure trips RTK's `serializableCheck`. Instead follow the **existing `nudge` pattern** (a serializable discriminator on the toast that the toast component renders a special action for — see `VoiceNudgeToast`): add an optional serializable `retryReview?: { bookId: string }` to `PushToastPayload`/`Toast`, and have the toast-stack component render a "Retry" button that dispatches a fresh `runReviewScript` on click.
```ts
    } else if (err instanceof ReviewScriptError && err.code === 'model_load_failed') {
      dispatch(notificationsActions.pushToast({ kind: 'error', message: err.message, retryReview: { bookId } }));
    } else {
      // existing generic error toast
    }
```
In the toast-stack component (grep `ToastStack` / where toasts render), when `toast.retryReview` is set, render a Retry button whose handler re-runs the review — reuse the same call site the manuscript "Review script" button uses so `sentences`/`characterIds`/`manuscriptId` are supplied (do NOT try to reconstruct `opts` inside the toast). Acceptance: clicking Retry re-invokes `runReviewScript(bookId, …)`.

Mirror the `onPhase`/`onHeartbeat` additions in `attachToRunningReview` (do **not** add Retry there — a reattach that fails is the existing silent/toast path).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/store/script-review-thunk.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/script-review-thunk.ts src/store/script-review-thunk.test.ts src/store/notifications-slice.ts
git commit -m "feat(frontend): drive activity/model fields + streaming upgrade + Retry in review thunk"
```

---

### Task 10: Panel `SubstageRow` — engine·model line, timer, fallback note

**Files:**
- Modify: `src/components/status-popover.tsx:110-134` (`SubstageRow`) + its prop type + the `SubstageRow` usages at `:247-274`
- Test: `src/components/status-popover.test.tsx` (extend; grep existing)

**Interfaces:**
- Consumes: `selectAnalysisSubstage` output (Task 2), `useElapsed` (Task 8), `MODEL_OPTIONS` (`src/lib/models.ts`).
- Produces: `SubstageRow` renders (when the substage is a review pass with the fields) an engine·model line, a state-aware ticking timer, and a fallback note.

- [ ] **Step 1: Write the failing test**

```tsx
// assert the row shows "Ollama · <friendly>" / "Gemini · <friendly>",
// a "Loading model" label when activityState==='loading',
// and a "Switched to Gemini" note when fallbackActive.
// Render StatusPopover (or SubstageRow directly) with a stubbed analysisSubstage prop.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/status-popover.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Widen the source type — `SubstageRow`'s prop is `analysisSubstage: NonNullable<StatusPopoverProps['analysisSubstage']>`, so add the five optional fields to `StatusPopoverProps['analysisSubstage']` (declared in `top-bar.tsx:210-216`) and they flow through. **`MODEL_OPTIONS` is already imported in `status-popover.tsx` (used at `:258`)** — only `useElapsed` is a new import. Add, below the existing label/percent/detail:
```tsx
{analysisSubstage.model && (
  <span data-testid="substage-engine-model">
    {(analysisSubstage.engine === 'gemini' ? 'Gemini' : 'Ollama')} ·{' '}
    {MODEL_OPTIONS.find((m) => m.id === analysisSubstage.model)?.label ?? analysisSubstage.model}
  </span>
)}
{/* state-aware timer */}
<SubstageTimer state={analysisSubstage.activityState} since={analysisSubstage.activitySince} />
{analysisSubstage.fallbackActive && (
  <span data-testid="substage-fallback-note">Switched to Gemini — Ollama unreachable</span>
)}
```
Add a small `SubstageTimer` local component using `useElapsed`:
```tsx
function SubstageTimer({ state, since }: { state?: 'loading' | 'waiting' | 'streaming'; since?: number }) {
  const secs = useElapsed(since);
  if (!state) return null;
  const prefix = state === 'loading' ? 'Loading model' : state === 'waiting' ? 'Waiting for model' : null;
  if (!prefix) return null; // streaming: the normal chapter/ETA detail already shows
  return <span data-testid="substage-timer">{prefix} · {secs}s</span>;
}
```
Use existing token classes for muted text — no hex.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/status-popover.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/status-popover.tsx src/components/status-popover.test.tsx
git commit -m "feat(frontend): render engine/model, ticking timer, fallback note in status popover"
```

---

### Task 11: Compact pill amber tone

**Files:**
- Modify: `src/components/top-bar.tsx:140-188` (`summarizeStatus`) + the `StatusInput.analysisSubstage` type (`:168-169`)
- Test: `src/components/top-bar.test.tsx` (extend; grep existing `summarizeStatus` test)

**Interfaces:**
- Consumes: `analysisSubstage` widened to include `activityState` + `fallbackActive`.
- Produces: `summarizeStatus` returns the warn/amber `tone` when the review substage is `loading` or `fallbackActive`; label unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// summarizeStatus with analysisSubstage { kind:'review', percent:2, activityState:'loading' }
// returns tone === '<amber/warn tone value>' and label 'Analysing'.
// And a second: fallbackActive:true → amber. And a control: streaming → default tone.
// Also assert reachability: with a PAUSED main-analysis rung present AND a review
// substage, the substage still surfaces (the rung ordering the assumption-check confirmed).
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/top-bar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Widen the `analysisSubstage` field type on `StatusInput` (today `{ kind; percent }`, `top-bar.tsx:129`) to include `activityState?` and `fallbackActive?`. In the substage rung of `summarizeStatus` (line ~168), set the amber tone conditionally. **`tone` is a local string union; existing warn states use the literal `'amber'` and the default is `'peach'` (`top-bar.tsx:157,160,169`) — there is no `WARN_TONE`/toast constant to reuse (toast `kind` is unrelated to pill `tone`):**
```ts
    if (analysisSubstage)
      return {
        label: 'Analysing',
        tone: analysisSubstage.activityState === 'loading' || analysisSubstage.fallbackActive ? 'amber' : 'peach',
        icon: /* unchanged */,
        detail: `${analysisSubstage.percent}%`,
      };
```
Thread `activityState`/`fallbackActive` into the `analysisSubstage` object built in `layout.tsx` (`selectAnalysisSubstage` already returns them after Task 2 — just pass them through where `layout.tsx:1558` constructs the `analysisSubstage` input).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/top-bar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/top-bar.tsx src/components/top-bar.test.tsx src/components/layout.tsx
git commit -m "feat(frontend): amber compact-pill tone on review loading/fallback"
```

---

### Task 12: Mock `reviewScript` emits the new events

**Files:**
- Modify: the mock script-review implementation (grep `mockReviewScript` / the mock branch of `api.reviewScript` — likely `src/mocks/` or the mock shim near `src/lib/api.ts:3226`)
- Test: covered by Task 13 e2e; add/adjust any existing mock unit test.

**Interfaces:**
- Produces: mock stream emits, in order: a `loading` phase (`activityState:'loading', engine:'local', model:'qwen3.5:9b'`), a chapter-start `waiting` phase with `model`/`engine`, a `heartbeat` with `receivedBytes`, `ops`, then `result` — so both the popover model line and the streaming timer have data to render in e2e.

- [ ] **Step 1: Write/adjust test**

If a mock unit test exists, assert the emitted sequence contains a `loading` phase and a `receivedBytes` heartbeat. Otherwise this is validated by Task 13.

- [ ] **Step 2: Run**

Run: `npm run test -- <mock test path>` (or defer to Task 13).

- [ ] **Step 3: Implement**

**The mock (`mockReviewScript`, `api.ts:3264`) is NOT an SSE parser — it invokes the typed callbacks directly** (`onPhase`/`onOps`/…). So don't emit `{ kind: … }` objects; call the callbacks: destructure `onHeartbeat` into the mock signature, then before the existing `onOps`, call `onPhase?.({ progress: 0, label: 'Loading model', activityState: 'loading', engine: 'local', model: 'qwen3.5:9b' })`, add `activityState:'waiting'`, `model`, `engine` to the per-chapter `onPhase` it already fires, and call `onHeartbeat?.({ chapterId, streaming: true })` once. Keep timings short (mock mode).

- [ ] **Step 4: Run**

Run: `npm run test -- <mock test path>`
Expected: PASS (or defer).

- [ ] **Step 5: Commit**

```bash
git add src/mocks src/lib/api.ts
git commit -m "test(frontend): mock review stream emits loading/model/heartbeat events"
```

---

### Task 13: E2E — model name + moving indicator on the global pill

**Files:**
- Create: `e2e/script-review-heartbeat.spec.ts`
- Reference: `docs/features/archive/37-e2e-playwright.md` for harness patterns

**Interfaces:**
- Consumes: mock stream (Task 12), the status popover (Task 10).

- [ ] **Step 1: Write the test**

```ts
import { test, expect } from '@playwright/test';
// Navigate to a book's manuscript view in mock mode, trigger script review,
// open the status popover (click the top-bar StatusPill), and assert:
test('script review shows engine·model and a live timer on the global pill', async ({ page }) => {
  // ... navigate + start review (reuse the existing review-trigger helper/selectors) ...
  await page.getByTestId('status-pill').click(); // adjust to the real testid
  await expect(page.getByTestId('substage-engine-model')).toContainText(/Ollama|Gemini/);
  await expect(page.getByTestId('review-script-progress')).toBeVisible();
});
```

- [ ] **Step 2: Run to verify it fails (then passes after wiring)**

Run: `npm run test:e2e -- script-review-heartbeat`
Expected: FAIL first (selectors/data), PASS once mock + render are wired.

- [ ] **Step 3–4: Adjust selectors to real testids; get it green.**

- [ ] **Step 5: Commit**

```bash
git add e2e/script-review-heartbeat.spec.ts
git commit -m "test(e2e): global pill shows review engine/model + progress"
```

---

### Task 14: Docs — release notes + spec status

**Files:**
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md` (in-progress version section), `docs/superpowers/specs/2026-07-14-script-review-progress-heartbeat-model-load-design.md` (`status: draft → active`)

- [ ] **Step 1:** Append a technical entry to `docs/release-notes-next.md` (PR-refed) and a brand-voice user line to the top version section of `RELEASE_NOTES.md` (e.g. "Script review now shows which voice-casting model is working and a live progress heartbeat — and recovers cleanly when the local model is still warming up.").
- [ ] **Step 2:** Flip the spec `status:` to `active`.
- [ ] **Step 3: Commit**

```bash
git add docs/release-notes-next.md RELEASE_NOTES.md docs/superpowers/specs/2026-07-14-script-review-progress-heartbeat-model-load-design.md
git commit -m "docs(frontend): release notes for script-review heartbeat + model naming"
```

---

## Self-Review

**Spec coverage:** warm step + clean abort (Task 6) / C1 gating (Task 6) / model+engine naming (Tasks 5,7,10,11) / activityState ownership server+client (Tasks 1,5,7,9) / per-chunk creep (Task 5) / streaming detection via receivedBytes, no onWaiting (Tasks 7,9) / onFallback once + latch (Tasks 4,6) / reducer-selector-prop surface + merge-not-setActive (Tasks 1,2,9) / Retry (Task 9) / amber tone reachability (Task 11) / cancel-during-warm (Task 6) / mock + e2e (Tasks 12,13) / docs (Task 14). All spec sections map to a task.

**Type consistency:** `activityState` union identical across `SubstageEntry`, payload, selector, phase parse, thunk. `warmOllamaModel` returns the same `{ok:false; status; error}` shape the route consumes. `onFallback: (info:{reason:string})=>void` identical in `StageCall`, `FallbackAnalyzer`, and the route's `onFallback` handler. `activeSelection` introduced in Task 5, reassigned in Task 6 — reads unified to `activeSelection.*`.

**Placeholder scan:** none. The two former soft spots are resolved to concrete code after the Opus plan review — pill tone is the literal `'amber'`/`'peach'` (`top-bar.tsx:157,169`), and Retry uses a serializable `retryReview: { bookId }` toast field on the nudge pattern (no stored closure).

**Post-review corrections folded (2026-07-14 Opus plan pass):** C-1 heartbeat field `chapterIndex` not `chapterId` (Task 7); M-1 `LocalUnreachableError` from `./ollama` (Task 4); M-2 `selectAnalyzer` from `../analyzer/index.js` (Task 6); M-3 serializable Retry toast (Task 9); M-4 `AbortSignal.any` signal-combine in `callOllamaGenerate` (Task 3); m-1 `error ?? ''`; m-2 mock calls callbacks directly (Task 12); m-3 tone literals (Task 11); m-5 `MODEL_OPTIONS` already imported + widen `StatusPopoverProps['analysisSubstage']` (Task 10). Note (N-1): Task 5's `let activeSelection` is reassigned in Task 6 — if only Task 5 has landed, `prefer-const` may flag it; it's resolved once Task 6 lands (before push).
