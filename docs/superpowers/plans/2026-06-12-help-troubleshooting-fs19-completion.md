# fe-29 Help View + fs-19 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all analysis-path failure classification into the fs-19 structured taxonomy (PR 1), then ship the offline `#/help` view whose troubleshooting copy is shared with that taxonomy (PR 2).

**Architecture:** One ordered signature table + one dependency-free copy module (`failure-remediations.ts`) become the single source for failure codes and remediation strings; the server classifies at four analysis sites (2 cast catches, 1 coverage-suspect, 2 run-level call sites collapsing to one function), persists per-chapter error records, and the frontend renders them plus a new static Help view that deep-links per code.

**Tech Stack:** TypeScript (NodeNext server / Vite React frontend), Redux Toolkit, Vitest, Playwright. Spec: `docs/superpowers/specs/2026-06-12-help-troubleshooting-fs19-completion-design.md`.

**Constraints recap (from spec):**
- Plan-154 generation-side match ORDER must not change; existing `failure-taxonomy.test.ts` cases stay green verbatim.
- Copy module is `.ts` (NOT JSON — NodeNext ESM import-attribute/emit footgun) and imports NOTHING (frontend imports it across packages).
- Control-flow codes `aborted` / `cast_incomplete` / `stage1_shrink_refused` stay out of the taxonomy.
- `failedChapterIds: number[]` stays; error records are an additive sibling.
- PR 2 must regenerate the visual baselines (top-bar icon changes every screenshot).

**Sequencing:** Tasks 1–8 = PR 1 (`feat/server-fs19-analysis-classification`). Tasks 9–16 = PR 2 (`feat/frontend-fe29-help-view`), branched AFTER PR 1 merges.

---

## Subagent execution protocol

This plan executes via **one fresh subagent per task, strictly SEQUENTIALLY** — tasks share files (`failure-taxonomy.ts` is touched by Tasks 2–5; `analysing.tsx` by 7 and 14) and each task builds on the previous one's commits. Do NOT parallelise.

**Workspace:** create ONE isolated worktree per PR (superpowers:using-git-worktrees) and run all of that PR's task subagents inside it — this repo sees concurrent sessions switch the shared checkout mid-session. Worktree setup gotchas (from prior rounds): junction BOTH `node_modules` AND `server/node_modules` into the worktree; husky hooks may fail to spawn from a worktree — if `git commit` fails with a hook spawn error, run the gate manually (`npm run verify:fast`) and only then commit with `--no-verify`, noting it in the task report. `brand/` is git-ignored — a worktree has no copy; Task 12 must read it from the main checkout path.

**Per-task subagent prompt MUST contain:**
1. The plan path (`docs/superpowers/plans/2026-06-12-help-troubleshooting-fs19-completion.md`) + the task number, with the instruction to execute THAT task's steps exactly.
2. The worktree path and expected branch; the subagent runs `git branch --show-current` and aborts if it doesn't match.
3. The task's **Pre-flight reads** (listed per task below) — read these BEFORE editing; line numbers in this plan are anchors from 2026-06-12 main and MAY have drifted, so locate by the quoted code, not the number.
4. The report-back contract: files changed, the verification commands run with their actual output (pass/fail counts), the commit SHA, and ANY deviation from the plan steps (signature mismatch, moved anchor, renamed variable) — deviations are reported, never silently absorbed.

**Orchestrator gates (between tasks):** review `git show --stat HEAD` + the reported test output; spot-read any file where the subagent reported a deviation; re-dispatch with a correction rather than patching inline. After Tasks 5, 7, 12, and 14 (the risky merges), additionally run the relevant suite yourself before dispatching the next task. Tasks 8 and 16 (verify + PR) run their `npm run verify` INSIDE the worktree; the orchestrator (not a subagent) pushes and opens the PR.

**Subagents do NOT:** push, open/ready PRs, merge, regenerate visual baselines outside Task 13, or touch files their task doesn't list.

---

## PR 1 — fs-19 completion

### Task 1: Branch + worktree for PR 1 (orchestrator)

**Files:** none (git only)

- [ ] **Step 1: Create the PR-1 worktree on its branch** (per the execution protocol — do NOT build on the shared checkout)

```bash
git fetch origin main
git worktree add ../Audiobook-Generator-wt-fs19 -b feat/server-fs19-analysis-classification origin/main
```

- [ ] **Step 2: Junction the dependency dirs into the worktree** (PowerShell — junctions, not git-bash mklink, per the repo's known gotcha)

```powershell
New-Item -ItemType Junction -Path ..\Audiobook-Generator-wt-fs19\node_modules -Target .\node_modules
New-Item -ItemType Junction -Path ..\Audiobook-Generator-wt-fs19\server\node_modules -Target .\server\node_modules
```

Expected: `git -C ../Audiobook-Generator-wt-fs19 branch --show-current` prints `feat/server-fs19-analysis-classification`; `npm run typecheck` works inside the worktree. All Task 2–8 subagents run inside this worktree.

### Task 2: Shared copy module + taxonomy pulls strings from it

**Depends on:** Task 1 (branch exists).
**Pre-flight reads:** `server/src/routes/failure-taxonomy.ts` (whole file, ~270 lines), `server/src/routes/failure-taxonomy.test.ts` (assertion style — it matches regexes on `classifyFailure` output, never reads `FAILURE_SIGNATURES` fields directly, which is WHY relocating the strings keeps it green).

**Files:**
- Create: `server/src/routes/failure-remediations.ts`
- Modify: `server/src/routes/failure-taxonomy.ts`
- Test: `server/src/routes/failure-taxonomy.test.ts` (add one test; existing cases must stay green UNCHANGED)

- [ ] **Step 1: Write the failing key-parity test**

Append to `server/src/routes/failure-taxonomy.test.ts`:

```ts
import { FAILURE_REMEDIATIONS } from './failure-remediations.js';

describe('failure-remediations copy module (fe-29/fs-19 shared copy)', () => {
  it('has exactly one entry per FailureCode', () => {
    expect(Object.keys(FAILURE_REMEDIATIONS).sort()).toEqual(
      [
        'analyzer-rate-limit',
        'auth',
        'cuda-poisoned',
        'disk-full',
        'model-not-loaded',
        'oom',
        'recycle-storm',
        'sidecar-unreachable',
        'synth-timeout',
        'unknown',
        'vram-spill',
        'xtts-speaker-desync',
      ].sort(),
    );
  });
  it('every entry has non-empty userMessage and remediation', () => {
    for (const [code, copy] of Object.entries(FAILURE_REMEDIATIONS)) {
      expect(copy.userMessage.length, code).toBeGreaterThan(0);
      expect(copy.remediation.length, code).toBeGreaterThan(0);
    }
  });
});
```

(The expected-keys list grows in Task 4 when the new codes land — update it there.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/routes/failure-taxonomy.test.ts`
Expected: FAIL — `Cannot find module './failure-remediations.js'`.

- [ ] **Step 3: Create the copy module**

Create `server/src/routes/failure-remediations.ts`. **This module must import NOTHING** (the frontend bundles it directly). Every string below is lifted VERBATIM from the current `FAILURE_SIGNATURES` / `UNKNOWN_REMEDIATION` in `failure-taxonomy.ts` — do not reword; the existing tests assert these exact strings.

```ts
/* fs-19 / fe-29 — canonical failure copy, shared by the server taxonomy
   (failure-taxonomy.ts pulls each signature's strings from here) and the
   frontend Help view (src/views/help.tsx imports this file across the package
   boundary; Vite bundles it statically so Help works offline).

   RULES:
   - Import NOTHING. This file must type-check identically under both the
     server (NodeNext) and frontend (bundler) tsconfigs and must never pull
     server-only code into the frontend bundle.
   - Keys must exactly equal the FailureCode union in failure-taxonomy.ts and
     the OpenAPI FailureCode enum — pinned by a test on the server side and a
     `satisfies` check on the frontend side.
   - `helpDetail` is OPTIONAL longer prose rendered only by the Help view. */

export interface FailureRemediationCopy {
  userMessage: string;
  remediation: string;
  helpDetail?: string;
}

export const FAILURE_REMEDIATIONS = {
  'synth-timeout': {
    userMessage:
      'TTS synthesis timed out for this chapter — the local engine stalled (often the ' +
      'sidecar reclaiming memory mid-render). Skipped so the queue advances; click Retry to re-render.',
    remediation:
      'Click Retry on this chapter. If it times out repeatedly, restart the TTS sidecar to clear ' +
      'a wedged GPU state, then retry.',
  },
  'sidecar-unreachable': {
    userMessage: 'Local TTS sidecar not running — start it and resume.',
    remediation:
      'Start the TTS sidecar (npm start launches it automatically), wait for the sidecar pill to ' +
      'go green, then resume the run.',
  },
  'recycle-storm': {
    userMessage: 'The TTS engine kept restarting while rendering this chapter.',
    remediation:
      'The sidecar is likely thrashing — the host-memory leak (side-11) or too little ' +
      'VRAM/RAM headroom. Restart the TTS sidecar and/or lower generation concurrency, then Retry.',
  },
  'vram-spill': {
    userMessage:
      'The GPU ran out of video memory (VRAM) mid-render — too many models were resident at once.',
    remediation:
      'Unload any models you are not generating with (the analyzer Ollama, or a second TTS engine) ' +
      'from the model pills, then retry. On an 8 GB card keep only one heavy TTS model loaded.',
  },
  oom: {
    userMessage:
      'The TTS sidecar was killed by the operating system — the machine ran out of host RAM.',
    remediation:
      'Close other memory-heavy apps and retry. If it recurs, the sidecar is leaking — restart it ' +
      'to reset its host memory, then resume.',
  },
  'disk-full': {
    userMessage:
      'The workspace volume is out of disk space — the chapter audio could not be written.',
    remediation:
      'Free up disk space on the workspace volume (delete old exports, or move the workspace to a ' +
      'larger drive), then retry the chapter.',
  },
  'analyzer-rate-limit': {
    userMessage: 'Gemini TTS rate-limited — stopped run; resume later or switch to a local engine.',
    remediation:
      'Wait for the quota window to reset (Gemini free-tier resets daily), or switch to a local ' +
      'engine (Kokoro / Qwen) in the engine picker, then resume.',
  },
  auth: {
    userMessage: 'Gemini TTS authentication failed — check GEMINI_API_KEY.',
    remediation:
      'Verify GEMINI_API_KEY in server/.env is set and valid, restart the server, then retry.',
  },
  'xtts-speaker-desync': {
    userMessage:
      'Local TTS engine rejected a speaker — the voice catalog is out of sync with the loaded model. ' +
      'Stop the sidecar, re-run the speaker manifest audit, and regenerate.',
    remediation:
      'Stop the TTS sidecar, re-run the speaker-manifest audit, then restart the sidecar and ' +
      'regenerate this chapter.',
  },
  'cuda-poisoned': {
    userMessage:
      'Local TTS sidecar hit a CUDA error and is auto-restarting (the CUDA context is corrupted ' +
      'process-wide; only a fresh Python process recovers). Wait ~10 seconds for the sidecar pill ' +
      'to go green again, then click Retry on this chapter. The offending text is in the sidecar ' +
      'log (text_preview=) — usually a stray zero-width or control char in the manuscript.',
    remediation:
      'Wait ~10 seconds for the sidecar to respawn (the pill goes green), then click Retry. If it ' +
      'recurs on the same chapter, check the sidecar log text_preview= for a stray control char.',
  },
  'model-not-loaded': {
    userMessage:
      'The TTS model is not loaded in the sidecar yet — synthesis was requested before the model ' +
      'finished loading.',
    remediation:
      'Load the engine from its model pill (or wait for the auto-load to finish — the pill turns ' +
      'green), then retry the chapter.',
  },
  unknown: {
    userMessage:
      'Something failed in a way the app does not recognise — the raw error message is shown in place ' +
      'of this line.',
    remediation:
      'Click Retry on this chapter. If it keeps failing, check the server / sidecar logs for the full ' +
      'error and report it.',
  },
} as const satisfies Record<string, FailureRemediationCopy>;
```

- [ ] **Step 4: Refactor `failure-taxonomy.ts` to pull copy from the module**

In `server/src/routes/failure-taxonomy.ts`:

1. Add the import + re-export at the top (the re-export lets `analysis.ts` import everything taxonomy-related from one module in Tasks 5–6):

```ts
import { FAILURE_REMEDIATIONS } from './failure-remediations.js';
export { FAILURE_REMEDIATIONS, type FailureRemediationCopy } from './failure-remediations.js';
```
2. Delete the `userMessage:` and `remediation:` properties from EVERY entry in `FAILURE_SIGNATURES`, and remove those two fields from the `FailureSignature` interface:

```ts
export interface FailureSignature {
  code: FailureCode;
  fatal: boolean;
  /** First match wins — order in FAILURE_SIGNATURES is significant. */
  match: (raw: string, ctx: FailureContext) => boolean;
}
```

3. Delete the `UNKNOWN_REMEDIATION` const (its string now lives at `FAILURE_REMEDIATIONS.unknown.remediation`).
4. In `classifyFailure`, look the copy up by code:

```ts
  for (const sig of FAILURE_SIGNATURES) {
    if (sig.match(raw, ctx)) {
      const copy = FAILURE_REMEDIATIONS[sig.code];
      return {
        code: sig.code,
        userMessage: copy.userMessage,
        remediation: copy.remediation,
        fatal: sig.fatal,
        raw,
      };
    }
  }
  return {
    code: 'unknown',
    userMessage: trimRaw(raw),
    remediation: FAILURE_REMEDIATIONS.unknown.remediation,
    fatal: false,
    raw,
  };
```

5. Add a compile-time completeness pin right after the import (catches a FailureCode added without copy):

```ts
/* Compile-time pin: every FailureCode has copy. (The reverse — no extra keys —
   is asserted by the key-parity test in failure-taxonomy.test.ts.) */
const _copyComplete: Record<FailureCode, { userMessage: string; remediation: string }> =
  FAILURE_REMEDIATIONS;
void _copyComplete;
```

IMPORTANT: do NOT touch the regexes, the entry order, the `fatal` values, or any comment explaining ordering. The table-order comments (synth-timeout-first, recycle-storm-before-vram-spill, etc.) stay attached to their entries.

- [ ] **Step 5: Run the full taxonomy test file**

Run: `cd server && npx vitest run src/routes/failure-taxonomy.test.ts`
Expected: PASS — all pre-existing cases green (strings unchanged) + the two new tests.

- [ ] **Step 6: Run the server suite + typecheck to catch fallout**

Run: `cd server && npx tsc --noEmit && npm run test`
Expected: PASS (generation-error.test.ts asserts `errorReason === userMessage` — unaffected because strings are identical).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy.test.ts
git commit -m "refactor(server): extract fs-19 failure copy into shared failure-remediations module"
```

### Task 3: Source-gating + matchName on the signature table

**Depends on:** Task 2 (`FAILURE_REMEDIATIONS` lookup is already wired into `classifyFailure`; this task restructures the scan around it).
**Pre-flight reads:** `server/src/routes/failure-taxonomy.ts` as left by Task 2.

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts`
- Test: `server/src/routes/failure-taxonomy.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `failure-taxonomy.test.ts`:

```ts
import { classifyAnalysisError } from './failure-taxonomy.js'; // table-scan entry point (Task 3)

describe('source gating (spec A2)', () => {
  it('classifyFailure (generation) still matches sidecar-unreachable on ECONNREFUSED', () => {
    const r = classifyFailure(new Error('connect ECONNREFUSED 127.0.0.1:8001'));
    expect(r.code).toBe('sidecar-unreachable');
  });
  it('classifyAnalysisError never blames the sidecar for an analysis failure', () => {
    const r = classifyAnalysisError(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    expect(r.code).not.toBe('sidecar-unreachable');
  });
  it('analysis path still sees the both-gated quota signature', () => {
    const err = Object.assign(new Error('429 Too Many Requests: quota exceeded'), { status: 429 });
    expect(classifyAnalysisError(err).code).toBe('analyzer-rate-limit');
  });
  it('analysis path still sees the both-gated disk-full signature', () => {
    expect(classifyAnalysisError(new Error('ENOSPC: no space left on device')).code).toBe('disk-full');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/routes/failure-taxonomy.test.ts`
Expected: FAIL — `classifyAnalysisError` is not exported.

- [ ] **Step 3: Implement source gating**

In `failure-taxonomy.ts`:

1. Extend the signature interface:

```ts
export type FailureSource = 'generation' | 'analysis' | 'both';

export interface FailureSignature {
  code: FailureCode;
  fatal: boolean;
  /** Which classification path may match this signature. Generation keeps its
      exact historical order/sequence (plan 154); analysis-only entries are
      invisible to classifyFailure and vice versa. */
  source: FailureSource;
  /** Optional typed-error matcher, tested against err.name BEFORE the regex —
      survives message rewording. */
  matchName?: string;
  match: (raw: string, ctx: FailureContext) => boolean;
}
```

2. Add `source:` to every existing entry: `'both'` for `analyzer-rate-limit`, `auth`, `disk-full`; `'generation'` for all others.
3. Generalise the scan into a shared helper and re-express `classifyFailure` over it:

```ts
function scanSignatures(
  err: unknown,
  sources: ReadonlySet<FailureSource>,
  engine?: string,
): ClassifiedFailure | null {
  const raw = rawOf(err);
  const ctx: FailureContext = {
    status: (err as { status?: number })?.status,
    name: (err as { name?: string })?.name,
    engine,
  };
  for (const sig of FAILURE_SIGNATURES) {
    if (!sources.has(sig.source)) continue;
    if ((sig.matchName != null && sig.matchName === ctx.name) || sig.match(raw, ctx)) {
      const copy = FAILURE_REMEDIATIONS[sig.code];
      return {
        code: sig.code,
        userMessage: copy.userMessage,
        remediation: copy.remediation,
        fatal: sig.fatal,
        raw,
      };
    }
  }
  return null;
}

const GENERATION_SOURCES: ReadonlySet<FailureSource> = new Set(['generation', 'both']);
const ANALYSIS_SOURCES: ReadonlySet<FailureSource> = new Set(['analysis', 'both']);

export function classifyFailure(err: unknown, engine?: string): ClassifiedFailure {
  const hit = scanSignatures(err, GENERATION_SOURCES, engine);
  if (hit) return hit;
  const raw = rawOf(err);
  return {
    code: 'unknown',
    userMessage: trimRaw(raw),
    remediation: FAILURE_REMEDIATIONS.unknown.remediation,
    fatal: false,
    raw,
  };
}

/** Bare signature-table scan for the analysis path. Production callers use
    classifyAnalysisFailure (Task 5) — which layers the ported describeError
    envelope parsing on top and falls back to this scan; exported for that
    fallback and for direct unit tests. */
export function classifyAnalysisError(err: unknown): ClassifiedFailure {
  const hit = scanSignatures(err, ANALYSIS_SOURCES);
  if (hit) return hit;
  const raw = rawOf(err);
  return {
    code: 'unknown',
    userMessage: trimRaw(raw),
    remediation: FAILURE_REMEDIATIONS.unknown.remediation,
    fatal: false,
    raw,
  };
}
```

Existing entries have no `matchName`, and `synth-timeout` / `recycle-storm` keep their `ctx.name === '…'` checks inside `match` — leave them; behaviour is identical.

- [ ] **Step 4: Run the tests**

Run: `cd server && npx vitest run src/routes/failure-taxonomy.test.ts`
Expected: PASS, including every pre-existing case (generation order unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy.test.ts
git commit -m "feat(server): source-gate the fs-19 signature table for analysis-path reuse"
```

### Task 4: New FailureCodes + OpenAPI (incl. recycle-storm drift fix)

**Depends on:** Task 3 (`source`/`matchName` fields + `classifyAnalysisError` exist).
**Pre-flight reads:** `server/src/routes/failure-taxonomy.ts` as left by Task 3; `openapi.yaml` around the `FailureCode:` schema (search for `FailureCode:` — ~line 4328).

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts`, `server/src/routes/failure-remediations.ts`, `openapi.yaml` (~line 4328 enum; analysis object ~line 4906), `server/src/routes/failure-taxonomy.test.ts`
- Regenerate: `src/lib/api-types.ts` (`npm run openapi:types`)

- [ ] **Step 1: Write the failing tests**

Append to `failure-taxonomy.test.ts`:

```ts
describe('analysis-side codes (spec A2)', () => {
  it('classifies AnalyzerTruncatedError by name', () => {
    const err = Object.assign(new Error('gemini truncated the response'), {
      name: 'AnalyzerTruncatedError',
    });
    expect(classifyAnalysisError(err).code).toBe('analyzer-truncated');
  });
  it('classifies DailyQuotaExhaustedError by name, before the rate-limit signature', () => {
    const err = Object.assign(new Error('daily quota exhausted — resets later'), {
      name: 'DailyQuotaExhaustedError',
    });
    expect(classifyAnalysisError(err).code).toBe('analyzer-daily-quota');
  });
  it('classifies an unreachable analyzer (connection refused) as analyzer-unreachable', () => {
    expect(
      classifyAnalysisError(new Error('connect ECONNREFUSED 127.0.0.1:11434')).code,
    ).toBe('analyzer-unreachable');
  });
  it('classifies GeminiStreamIdleError (retry-exhausted) as analyzer-unreachable', () => {
    const err = Object.assign(new Error('stream idle'), { name: 'GeminiStreamIdleError' });
    expect(classifyAnalysisError(err).code).toBe('analyzer-unreachable');
  });
  it('generation path never sees the analysis-only entries', () => {
    const err = Object.assign(new Error('whatever'), { name: 'AnalyzerTruncatedError' });
    expect(classifyFailure(err).code).toBe('unknown');
  });
  it('attribution-incomplete has copy (synthetic code, no signature)', () => {
    expect(FAILURE_REMEDIATIONS['attribution-incomplete'].remediation.length).toBeGreaterThan(0);
  });
});
```

Also update the Task-2 key-parity list to add: `'analyzer-daily-quota'`, `'analyzer-truncated'`, `'analyzer-unreachable'`, `'attribution-incomplete'`.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/routes/failure-taxonomy.test.ts`
Expected: FAIL — codes/keys missing.

- [ ] **Step 3: Implement**

1. `failure-taxonomy.ts` — extend the union:

```ts
export type FailureCode =
  | 'vram-spill'
  | 'recycle-storm'
  | 'sidecar-unreachable'
  | 'analyzer-rate-limit'
  | 'analyzer-daily-quota'
  | 'analyzer-truncated'
  | 'analyzer-unreachable'
  | 'attribution-incomplete'
  | 'oom'
  | 'disk-full'
  | 'model-not-loaded'
  | 'synth-timeout'
  | 'xtts-speaker-desync'
  | 'cuda-poisoned'
  | 'auth'
  | 'unknown';
```

2. Insert the three new SIGNATURES at the TOP of `FAILURE_SIGNATURES` (they are `source: 'analysis'` so the generation scan skips them — generation order is untouched; among themselves, name-driven entries first, and daily-quota BEFORE the both-gated rate-limit entry lower in the table):

```ts
  /* ---- analysis-only entries (source-gated; invisible to classifyFailure).
     Name-driven first: typed analyzer errors survive message rewording.
     analyzer-daily-quota MUST precede the 'both' analyzer-rate-limit entry —
     a daily-quota 429 would otherwise classify as a plain rate-limit. ---- */
  {
    code: 'analyzer-truncated',
    fatal: false,
    source: 'analysis',
    matchName: 'AnalyzerTruncatedError',
    match: () => false,
  },
  {
    code: 'analyzer-daily-quota',
    fatal: true,
    source: 'analysis',
    matchName: 'DailyQuotaExhaustedError',
    match: (raw, ctx) =>
      ctx.status === 429 && /free[_-]?tier|quotaValue":"\d{1,3}"/i.test(raw),
  },
  {
    code: 'analyzer-unreachable',
    fatal: true,
    source: 'analysis',
    matchName: 'GeminiStreamIdleError',
    match: (raw, ctx) =>
      ctx.status === 503 ||
      ctx.status === 500 ||
      /ECONNREFUSED|fetch failed|EAI_AGAIN|socket hang up/i.test(raw),
  },
```

3. `failure-remediations.ts` — add the four copy entries:

```ts
  'analyzer-unreachable': {
    userMessage:
      'The analyzer could not be reached or stopped responding — the local Ollama daemon is down, ' +
      'or the analyzer service returned a server error.',
    remediation:
      'Check that Ollama is running (ollama serve), or switch the analyzer in server/.env ' +
      '(ANALYZER=gemini with a GEMINI_API_KEY). Then retry the chapter or resume the run.',
    helpDetail:
      'When GEMINI_API_KEY is set, an unreachable Ollama silently retries against Gemini, so this ' +
      'error usually means no fallback was configured — or both engines failed.',
  },
  'analyzer-truncated': {
    userMessage:
      'The analyzer model cut its reply short — a chapter section was too large for one ' +
      'attribution call, even after automatic re-splitting.',
    remediation:
      'Retry the chapter. If it recurs, lower STAGE2_CHUNK_CHAR_BUDGET in server/.env (or Advanced ' +
      'Settings) or switch to a stronger analyzer model.',
  },
  'analyzer-daily-quota': {
    userMessage: 'The analyzer’s free-tier daily quota is exhausted.',
    remediation:
      'Switch to a different analyzer model (GEMINI_MODEL in server/.env or Advanced Settings — ' +
      'each model has its own daily bucket), use the local Ollama analyzer, or wait for the quota ' +
      'reset shown in the error.',
  },
  'attribution-incomplete': {
    userMessage:
      'Some lines in this chapter may be unattributed — the analyzer’s answer did not cover every ' +
      'sentence, so the best take was kept and the chapter was flagged.',
    remediation:
      'Click Retry on this chapter to re-run attribution. Already-attributed lines are kept; a ' +
      'retry usually fills the gaps.',
  },
```

4. `openapi.yaml` — in the `FailureCode` enum (~line 4328) add five values (note `recycle-storm` is a PRE-EXISTING drift fix — the server union has had it since stall-protection Wave 3 but the contract never gained it; call this out in the PR body):

```yaml
        - recycle-storm
        - analyzer-daily-quota
        - analyzer-truncated
        - analyzer-unreachable
        - attribution-incomplete
```

- [ ] **Step 4: Regenerate api-types + run tests**

Run: `npm run openapi:types && cd server && npx vitest run src/routes/failure-taxonomy.test.ts && npx tsc --noEmit`
Expected: PASS; `git diff src/lib/api-types.ts` shows only the enum additions.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): analysis-side FailureCodes + recycle-storm OpenAPI drift fix"
```

### Task 5: `classifyAnalysisFailure` — unify the run-level classifier

**Depends on:** Tasks 2–4 (copy module + re-export, `classifyAnalysisError`, the four new codes).
**Pre-flight reads:** `server/src/routes/analysis.ts` — the region around BOTH `describeError(e, analyzerLabel)` call sites (search `describeError(`; ~3604 and ~4477), the five function definitions (~4496–4627), AND the structured-log site at ~3592 that uses `tryParseApiError` independently (search `parsedLog`); `server/src/analyzer/errors.ts:19` and `server/src/analyzer/rate-limit.ts:73` (error classes).

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts` (gains the ported functions), `server/src/routes/analysis.ts` (call sites ~3604 and ~4477; DELETE `describeError` ~4496, `classifyStatus` ~4613, `formatErrorDetail` ~4560, `trimQuotaMessage` ~4582, `tryParseApiError` ~4588)
- Test: `server/src/routes/failure-taxonomy.test.ts`

`failure-taxonomy.ts` is no longer dependency-free after this task (it imports `DailyQuotaExhaustedError`) — that is fine; only `failure-remediations.ts` must stay import-free.

- [ ] **Step 1: Write the failing tests** (port `describeError`'s behaviours)

```ts
import { classifyAnalysisFailure } from './failure-taxonomy.js';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import { AnalyzerTruncatedError } from '../analyzer/errors.js';

describe('classifyAnalysisFailure (run-level, ports describeError verbatim — spec A3)', () => {
  it('AnalyzerTruncatedError → analyzer-truncated with dynamic message + structured detail', () => {
    const err = new AnalyzerTruncatedError('gemini', 'MAX_TOKENS', 8192, 4096);
    const r = classifyAnalysisFailure(err, 'Gemini (gemma-4-31b-it)');
    expect(r.code).toBe('analyzer-truncated');
    expect(r.userMessage).toContain('Gemini (gemma-4-31b-it)');
    expect(r.userMessage).toContain('MAX_TOKENS');
    expect(r.detail).toContain('engine=gemini');
    expect(r.remediation.length).toBeGreaterThan(0);
  });
  it('DailyQuotaExhaustedError → analyzer-daily-quota preserving the reset time', () => {
    const resetAt = new Date('2026-06-13T07:00:00Z');
    const err = new DailyQuotaExhaustedError('gemma-4-31b-it', resetAt);
    const r = classifyAnalysisFailure(err, 'Gemini (gemma-4-31b-it)');
    expect(r.code).toBe('analyzer-daily-quota');
    expect(r.userMessage).toContain('2026-06-13T07:00:00.000Z');
  });
  it('Google envelope 429 free-tier → analyzer-daily-quota with trimmed message', () => {
    const raw =
      'got status: 429. {"error":{"code":429,"message":"You exceeded your current quota. Free tier limit, please check. More text that should be trimmed away entirely.","status":"RESOURCE_EXHAUSTED","details":[{"quotaValue":"250"}]}}';
    const r = classifyAnalysisFailure(new Error(raw), 'Gemini (gemma-4-31b-it)');
    expect(r.code).toBe('analyzer-daily-quota');
    expect(r.userMessage).toContain('429');
    expect(r.detail).toContain('RESOURCE_EXHAUSTED');
  });
  it('envelope 503 → analyzer-unreachable; 401 → auth; 400 → unknown', () => {
    const env = (code: number, status: string) =>
      new Error(`got status: ${code}. {"error":{"code":${code},"message":"boom","status":"${status}"}}`);
    expect(classifyAnalysisFailure(env(503, 'UNAVAILABLE'), 'm').code).toBe('analyzer-unreachable');
    expect(classifyAnalysisFailure(env(401, 'UNAUTHENTICATED'), 'm').code).toBe('auth');
    expect(classifyAnalysisFailure(env(400, 'INVALID_ARGUMENT'), 'm').code).toBe('unknown');
  });
  it('bare status (no envelope) classifies too', () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
    expect(classifyAnalysisFailure(err, 'm').code).toBe('analyzer-unreachable');
  });
  it('non-envelope plain error falls through to the analysis table scan', () => {
    const r = classifyAnalysisFailure(new Error('connect ECONNREFUSED 127.0.0.1:11434'), 'Ollama');
    expect(r.code).toBe('analyzer-unreachable');
  });
  it('unmapped error → unknown with raw message preserved', () => {
    const r = classifyAnalysisFailure(new Error('some novel failure'), 'm');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toContain('some novel failure');
  });
});
```

Constructor signatures VERIFIED against source: `AnalyzerTruncatedError(engine, reason, receivedBytes, outputTokens?)` (`errors.ts:19`) and `DailyQuotaExhaustedError(model, resetAt)` (`rate-limit.ts:73`) — the test constructions above are correct as written.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/routes/failure-taxonomy.test.ts`
Expected: FAIL — `classifyAnalysisFailure` not exported.

- [ ] **Step 3: Implement — MOVE, don't rewrite**

Cut `describeError`, `classifyStatus`, `formatErrorDetail`, `trimQuotaMessage`, `tryParseApiError` from `analysis.ts` (~4496–4627) and paste into `failure-taxonomy.ts`, then adapt:

```ts
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import { AnalyzerTruncatedError } from '../analyzer/errors.js';

export interface AnalysisFailure {
  code: FailureCode;
  userMessage: string;
  remediation: string;
  detail?: string;
}

/* classifyStatus, ported from analysis.ts:4613 — now emits FailureCode per the
   spec-A2 mapping (rate_limit→analyzer-rate-limit, daily_quota→analyzer-daily-quota,
   unavailable/internal→analyzer-unreachable, invalid_key→auth, bad_request→unknown). */
function statusToFailureCode(status: number | undefined, message?: string): FailureCode {
  if (!status) return 'unknown';
  if (status === 429) {
    if (message && /free[_-]?tier|quotaValue":"\d{1,3}"/i.test(message)) return 'analyzer-daily-quota';
    return 'analyzer-rate-limit';
  }
  if (status === 503 || status === 500) return 'analyzer-unreachable';
  if (status === 401 || status === 403) return 'auth';
  return 'unknown';
}

function withCopy(code: FailureCode, userMessage: string, detail?: string): AnalysisFailure {
  return { code, userMessage, remediation: FAILURE_REMEDIATIONS[code].remediation, detail };
}

/** Run-level analysis classifier — the unified replacement for analysis.ts's
    describeError(). Typed-error checks and the Google-envelope/status parsing
    are PORTED VERBATIM (same precedence, same message construction: model
    label, status suffix, quota trimming, detail blob); only the code
    vocabulary changes to FailureCode and a remediation is attached. Plain
    unmatched errors additionally fall through to the analysis signature scan
    (so ECONNREFUSED etc. classify here too). */
export function classifyAnalysisFailure(err: unknown, modelLabel: string): AnalysisFailure {
  if (err instanceof AnalyzerTruncatedError) {
    return withCopy(
      'analyzer-truncated',
      `${modelLabel} truncated the response (${err.reason}) — a chapter section is too large for one attribution call. Lower STAGE2_CHUNK_CHAR_BUDGET and retry.`,
      `engine=${err.engine} reason=${err.reason} bytes=${err.receivedBytes}${
        err.outputTokens ? ` tokens=${err.outputTokens}` : ''
      }`,
    );
  }
  if (err instanceof DailyQuotaExhaustedError) {
    return withCopy(
      'analyzer-daily-quota',
      `${modelLabel} daily quota exhausted — resets at ${err.resetAt.toISOString()}.`,
      `resetAt: ${err.resetAt.toISOString()}`,
    );
  }
  const raw = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;

  const parsed = tryParseApiError(raw);
  if (parsed) {
    const code = statusToFailureCode(parsed.code ?? status, parsed.message);
    const trimmed =
      code === 'analyzer-rate-limit' || code === 'analyzer-daily-quota'
        ? trimQuotaMessage(parsed.message)
        : parsed.message;
    const statusSuffix = parsed.status ? ` (${parsed.status})` : '';
    return withCopy(
      code,
      `${modelLabel} returned ${parsed.code ?? status ?? '???'}${statusSuffix}: ${trimmed}`,
      formatErrorDetail(parsed, raw),
    );
  }
  if (status) {
    return withCopy(statusToFailureCode(status, raw), `${modelLabel} returned ${status}: ${raw}`);
  }
  /* Not an API envelope — give the signature table a chance (catches the
     connection-refused / fetch-failed family) before the unknown fallback. */
  const scanned = classifyAnalysisError(err);
  if (scanned.code !== 'unknown') {
    return { code: scanned.code, userMessage: scanned.userMessage, remediation: scanned.remediation };
  }
  return withCopy('unknown', raw || 'Analysis failed.');
}
```

(`tryParseApiError`, `trimQuotaMessage`, `formatErrorDetail` are pasted unchanged, module-private.)

Then in `analysis.ts`:

1. Replace both call sites (the import of `classifyAnalysisFailure` from `./failure-taxonomy.js` replaces the local functions):

```ts
    const { code, userMessage: message, remediation, detail } = classifyAnalysisFailure(e, analyzerLabel);
    endJob(job, { kind: 'error', code, message, remediation, detail });
```

2. Delete the five moved functions from `analysis.ts` — BUT `tryParseApiError` is ALSO used at `analysis.ts:3592` (the structured error-log site reads `parsedLog?.status/code/details`). Export `tryParseApiError` from `failure-taxonomy.ts` and add it to the `analysis.ts` import so that log site keeps working:

```ts
import { classifyAnalysisFailure, tryParseApiError, FAILURE_REMEDIATIONS } from './failure-taxonomy.js';
```

Then remove the now-unused `DailyQuotaExhaustedError` / `AnalyzerTruncatedError` imports IF nothing else in the file uses them (grep first — `rg -n "DailyQuotaExhaustedError|AnalyzerTruncatedError" server/src/routes/analysis.ts`).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd server && npx vitest run src/routes/failure-taxonomy.test.ts && npx tsc --noEmit && npm run test`
Expected: PASS. If any analysis.test.ts case asserted old code strings (`'daily_quota'`, `'rate_limit'`, `'truncated'`, `'unavailable'`, `'internal'`, `'invalid_key'`) on run-level error events, update those assertions to the new FailureCode values in the same commit — that rename is the point of this task. (`rg -n "daily_quota|rate_limit|invalid_key" server/src` to find them.)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy.test.ts server/src/routes/analysis.ts
git commit -m "feat(server): unify run-level analysis classifier into the fs-19 taxonomy"
```

### Task 6: Per-chapter persistence + SSE (cast catches, coverage-suspect, replay, book-state)

**Depends on:** Task 4 (`attribution-incomplete` copy exists), Task 5 (`classifyAnalysisFailure` + the `FAILURE_REMEDIATIONS` re-export are importable from `./failure-taxonomy.js`).
**Pre-flight reads:** `server/src/routes/analysis.ts` — the two cast catch sites (search `'chapter-failed'`; ~2563 full-route, ~4072 subset — confirm the analyzer-label variable name in scope at EACH), the coverage-suspect block (search `coverage SUSPECT`; ~3199–3212), `clearFailedChapterId` (~782), the replay map type (~1357) + its `case 'chapter-failed'` handler (~1568); `server/src/store/analysis-cache.ts` (whole file); `server/src/routes/book-state.ts` (~260–270 and the response literal ~460); `openapi.yaml` analysis object (search `failedChapterIds:`; ~4906).

**Files:**
- Modify: `server/src/store/analysis-cache.ts`, `server/src/routes/analysis.ts` (catch sites ~2563 / ~4072, coverage-suspect ~3209, `clearFailedChapterId` ~782, replay map ~1357 + ~1568), `server/src/routes/book-state.ts` (~267 and ~462), `openapi.yaml` (analysis object ~4906)
- Test: `server/src/routes/analysis.test.ts` (or the existing test file covering `clearFailedChapterId`), regenerate `src/lib/api-types.ts`

- [ ] **Step 1: Write the failing unit tests for the cache helpers**

In `analysis.test.ts` (colocate with the existing `clearFailedChapterId` tests — find them via `rg -n "clearFailedChapterId" server/src`):

```ts
import { recordFailedChapter, clearFailedChapterId } from './analysis.js';

describe('failedChapterErrors records (spec A4)', () => {
  it('recordFailedChapter writes id + error record', () => {
    const cache: {
      failedChapterIds?: number[];
      failedChapterErrors?: Record<string, { code: string; message: string; remediation: string }>;
    } = {};
    recordFailedChapter(cache, 7, {
      code: 'analyzer-unreachable',
      userMessage: 'msg',
      remediation: 'fix',
    });
    expect(cache.failedChapterIds).toEqual([7]);
    expect(cache.failedChapterErrors?.['7']).toEqual({
      code: 'analyzer-unreachable',
      message: 'msg',
      remediation: 'fix',
    });
  });
  it('clearFailedChapterId clears the record alongside the id', () => {
    const cache = {
      failedChapterIds: [7],
      failedChapterErrors: { '7': { code: 'unknown', message: 'm', remediation: 'r' } },
    };
    expect(clearFailedChapterId(cache, 7)).toBe(true);
    expect(cache.failedChapterIds).toEqual([]);
    expect(cache.failedChapterErrors['7']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/routes/analysis.test.ts -t failedChapterErrors`
Expected: FAIL — `recordFailedChapter` not exported.

- [ ] **Step 3: Implement the cache shape + helpers**

1. `analysis-cache.ts` — add to `AnalysisCache` (after `failedChapterIds`) and to the `loadAnalysisCache` pass-through object:

```ts
  /** fs-19 (analysis half) — per-chapter structured failure record, keyed by
      chapterId-as-string (JSON object keys). Additive sibling of
      failedChapterIds: ids stay the durable retry list; this carries the
      classified code + copy so the analysing view shows a real message +
      remediation after reload instead of the generic fallback. */
  failedChapterErrors?: Record<string, { code: string; message: string; remediation: string }>;
```

(in `loadAnalysisCache`: `failedChapterErrors: cache.failedChapterErrors ?? undefined,`)

2. `analysis.ts` — next to `clearFailedChapterId` (~782), add and extend:

```ts
/* fs-19 (analysis half) — promote a classified per-chapter failure to durable
   cache state: the id keeps driving the Retry list; the record carries the
   structured code/message/remediation for the post-reload display. */
export function recordFailedChapter(
  cache: {
    failedChapterIds?: number[];
    failedChapterErrors?: Record<string, { code: string; message: string; remediation: string }>;
  },
  chapterId: number,
  classified: { code: string; userMessage: string; remediation: string },
): void {
  const failedSet = new Set(cache.failedChapterIds ?? []);
  failedSet.add(chapterId);
  cache.failedChapterIds = Array.from(failedSet);
  cache.failedChapterErrors = {
    ...cache.failedChapterErrors,
    [String(chapterId)]: {
      code: classified.code,
      message: classified.userMessage,
      remediation: classified.remediation,
    },
  };
}
```

In `clearFailedChapterId`, widen the param type to include `failedChapterErrors?` and add inside the `if (wasFailed)` block:

```ts
    if (cache.failedChapterErrors) delete cache.failedChapterErrors[String(chapterId)];
```

3. Both cast catch sites (~2563 and ~4072) — replace the inline `failedSet` block + send with:

```ts
          const classified = classifyAnalysisFailure(chErr, analyzerLabel);
          recordFailedChapter(cache, ch.id, classified);
          await saveAnalysisCache(manuscriptId, cache);
          send({
            kind: 'chapter-failed',
            chapterId: ch.id,
            message: classified.userMessage,
            code: classified.code,
            remediation: classified.remediation,
          });
```

(keep each site's surrounding lines — `chapterCast[ch.id] = []`, logs, `sendCastLiveTick()` / `emitCastUpdate()` etc. — exactly as they are; check the in-scope variable holding the analyzer label at each site — the full route uses `analyzerLabel`; if the subset route names it differently, use that name.)

4. Coverage-suspect site (~3209) — replace the bare `failedSet` block with a synthetic record + the SSE tick it never had:

```ts
        const copy = FAILURE_REMEDIATIONS['attribution-incomplete'];
        recordFailedChapter(cache, ch.id, {
          code: 'attribution-incomplete',
          userMessage: copy.userMessage,
          remediation: copy.remediation,
        });
        send({
          kind: 'chapter-failed',
          chapterId: ch.id,
          message: copy.userMessage,
          code: 'attribution-incomplete',
          remediation: copy.remediation,
        });
```

(import `FAILURE_REMEDIATIONS` in analysis.ts; verify a `saveAnalysisCache` call follows in that flow — the chapter loop persists right after (~3216 ff.); if none does, add one.)

5. Replay map (~1357 type + ~1568 handler) — widen both to carry the new optional fields:

```ts
  failedByChapterId: Map<
    number,
    { kind: 'chapter-failed'; chapterId: number; message: string; code?: string; remediation?: string }
  >;
```

and in the `case 'chapter-failed':` handler copy `code: e.code, remediation: e.remediation` through (widen the local `e` cast accordingly).

6. `book-state.ts` — alongside `failedChapterIds` (~267):

```ts
    let failedChapterErrors: Record<string, { code: string; message: string; remediation: string }> = {};
    // …inside the `if (state.manuscriptId)` block, after failedChapterIds:
      failedChapterErrors = cache.failedChapterErrors ?? {};
```

and in the response (~462): `analysis: { failedChapterIds, failedChapterErrors },`

7. `openapi.yaml` analysis object (~4906) — add under `properties:`:

```yaml
            failedChapterErrors:
              type: object
              description: |
                fs-19 (analysis half) — per-chapter classified failure, keyed by
                chapterId as a string. Lets the analysing view show the real
                message + remediation after a reload instead of a generic line.
              additionalProperties:
                type: object
                required: [code, message, remediation]
                properties:
                  code: { $ref: '#/components/schemas/FailureCode' }
                  message: { type: string }
                  remediation: { type: string }
```

- [ ] **Step 4: Regenerate types, run server tests**

Run: `npm run openapi:types && cd server && npm run test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/store/analysis-cache.ts server/src/routes/analysis.ts server/src/routes/analysis.test.ts server/src/routes/book-state.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): persist + stream classified per-chapter analysis failures"
```

### Task 7: Frontend — stream types, analysing rows, run-error panel

**Depends on:** Task 6 (the SSE carries `code`/`remediation`; book-state serves `failedChapterErrors`; `src/lib/api-types.ts` regenerated).
**Pre-flight reads:** `src/lib/api.ts` — the `onChapterFailed` callback type (~171), BOTH `payload.kind === 'chapter-failed'` handlers (~2155, ~3469), and `class AnalysisError` (~2065); `src/lib/types.ts` (~400–410, the BookState analysis mirror); `src/views/analysing.tsx` — `failedChapters` state (~165), live handler (~427), hydrate effect (~548–580), failed-row JSX (~1286–1337), run-error panel (~1120–1150); `src/views/analysing.test.tsx` — the ENTIRE test-harness setup before writing any test (mock idioms for the stream callbacks + getBookState).

**Files:**
- Modify: `src/lib/api.ts` (`onChapterFailed` type ~171; handlers ~2155 and ~3469; the run-level `AnalysisError` class at ~2065 — has `code`/`detail`, add `remediation?`), `src/lib/types.ts` (~405: the hand-written BookState mirror `analysis?: { failedChapterIds: number[] }` MUST gain `failedChapterErrors?: Record<string, { code: string; message: string; remediation: string }>` or the hydrate code below fails typecheck), `src/views/analysing.tsx` (state ~165, live handler ~427, hydrate ~565, row JSX ~1303, error panel ~1129)
- Test: `src/views/analysing.test.tsx` (existing harness — extend)

- [ ] **Step 1: Write the failing tests**

Extend `analysing.test.tsx` (reuse its existing mock-stream helpers — read the file's setup first; the cases below state the behaviour, adapt the plumbing to the harness's idiom):

```tsx
it('renders remediation from a live chapter-failed event (fs-19 analysis half)', async () => {
  // drive the harness's onChapterFailed with:
  // { chapterId: 2, message: 'The analyzer could not be reached…',
  //   code: 'analyzer-unreachable', remediation: 'Check that Ollama is running…' }
  // assert the failed row shows BOTH the message and a "What to do:" line:
  expect(await screen.findByText(/What to do:/)).toBeInTheDocument();
  expect(screen.getByText(/Check that Ollama is running/)).toBeInTheDocument();
});

it('hydrates remediation from book-state failedChapterErrors after reload', async () => {
  // mock getBookState → analysis: { failedChapterIds: [3], failedChapterErrors:
  //   { '3': { code: 'attribution-incomplete', message: 'Some lines…', remediation: 'Click Retry…' } } }
  expect(await screen.findByText(/Some lines/)).toBeInTheDocument();
  expect(screen.getByText(/What to do:/)).toBeInTheDocument();
});

it('keeps the legacy generic line when no record exists', async () => {
  // mock getBookState → analysis: { failedChapterIds: [4], failedChapterErrors: {} }
  expect(await screen.findByText(/failed on a previous attempt/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/views/analysing.test.tsx`
Expected: new cases FAIL (no "What to do:" rendering yet).

- [ ] **Step 3: Implement**

1. `src/lib/api.ts`:
   - Type (~171): `onChapterFailed?: (e: { chapterId: number; message: string; code?: string; remediation?: string }) => void;`
   - Both handlers (~2155, ~3469): pass `code: payload.code, remediation: payload.remediation` through (the payload type union at ~2018 gains the optional fields).
   - Run-level error: find where `kind: 'error'` events construct `AnalysisError` — add an optional `remediation?: string` property mirroring the existing `detail`, populated from the payload.
2. `src/views/analysing.tsx`:
   - `failedChapters` state element type gains `code?: string; remediation?: string`.
   - Live handler (~427): store `code`/`remediation` off the event.
   - Hydrate (~565): read `res.analysis?.failedChapterErrors`; when a record exists for an id use its `message`/`code`/`remediation`; else keep the existing generic-fallback message.
   - Row JSX (~1317), under the existing message line:

```tsx
                      {f.remediation && (
                        <p className="mt-1 text-xs text-amber-900/90 wrap-break-word">
                          <span className="font-semibold">What to do:</span> {f.remediation}
                        </p>
                      )}
```

   - Run-error panel (~1129): render `error.remediation` the same way under the message, and update the two `error.code === 'daily_quota'` checks to `(error.code === 'daily_quota' || error.code === 'analyzer-daily-quota')` (legacy tolerance per spec A3 — grep for any OTHER frontend reference to the old run-level code strings: `rg -n "daily_quota|rate_limit|invalid_key" src` and apply the same dual-accept; the `error` state type gains `remediation?: string`).

- [ ] **Step 4: Run frontend tests + typecheck**

Run: `npx vitest run src/views/analysing.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/views/analysing.tsx src/views/analysing.test.tsx
git commit -m "feat(frontend): analysing view shows classified failure remediation live + after reload"
```

### Task 8: PR 1 — plan 173 update, verify, draft PR

**Depends on:** Tasks 2–7 all committed green.
**Pre-flight reads:** `docs/features/173-failure-taxonomy.md` (whole file — it's 43 lines).
**Split responsibility:** the subagent does Steps 1–2 (docs + verify) and the docs commit; the ORCHESTRATOR does the push + `gh pr create` + ready/merge (Step 3's commands), reviewing the full branch diff first.

**Files:**
- Modify: `docs/features/173-failure-taxonomy.md`

- [ ] **Step 1: Update plan 173**

In `docs/features/173-failure-taxonomy.md`: status stays `active` (live acceptance still owed). Update the Ship-notes deferral sentence to:

```markdown
Analysis-path classification shipped in the fe-29/fs-19 completion round
(spec `docs/superpowers/specs/2026-06-12-help-troubleshooting-fs19-completion-design.md`):
the run-level describeError() unified into `classifyAnalysisFailure` (old codes
truncated/daily_quota/rate_limit/unavailable/internal/invalid_key/bad_request →
FailureCode), per-chapter cast failures + the stage-2 coverage-suspect path now
persist `failedChapterErrors` records, and the analysing view renders
message + remediation live and after reload.
```

Add to **Invariants to preserve**:

```markdown
5. Analysis-side signatures are `source: 'analysis'` — the generation scan never
   sees them and its match ORDER is byte-identical to the pre-split table.
6. `failure-remediations.ts` imports nothing (the frontend bundles it directly).
```

- [ ] **Step 2: Full local verify**

Run: `npm run verify`
Expected: green (lint, typecheck, all tests, e2e, build). Triage per CLAUDE.md if anything is red — pre-existing failures get surfaced to the user, not silently fixed.

- [ ] **Step 3: Commit docs + open the draft PR**

```bash
git add docs/features/173-failure-taxonomy.md
git commit -m "docs(docs): plan 173 — analysis-path classification deferral resolved"
git push -u origin feat/server-fs19-analysis-classification
gh pr create --draft --title "feat(server,frontend): fs-19 completion — unified analysis-failure taxonomy" --body "## Summary
- Extracts fs-19 remediation copy into a shared, dependency-free \`failure-remediations.ts\` (consumed by the upcoming fe-29 Help view).
- Source-gates the signature table (\`generation | analysis | both\`) — generation match order untouched (plan 154).
- New codes: \`analyzer-unreachable\`, \`analyzer-truncated\`, \`analyzer-daily-quota\`, \`attribution-incomplete\`; also fixes the pre-existing \`recycle-storm\` OpenAPI enum drift.
- Unifies the run-level \`describeError()\` into \`classifyAnalysisFailure\` (FailureCode vocabulary + remediation on the run-error SSE).
- Persists per-chapter \`failedChapterErrors\` (cast catches + the previously-silent stage-2 coverage-suspect path, which now also emits its \`chapter-failed\` tick); analysing view shows message + 'What to do:' live and after reload.

Spec: docs/superpowers/specs/2026-06-12-help-troubleshooting-fs19-completion-design.md (PR 1 of 2). Refs #469.

## Test plan
- \`failure-taxonomy.test.ts\`: existing cases green VERBATIM + source-gating + new codes + ported describeError behaviours.
- \`analysis.test.ts\`: record/clear helpers, SSE carries code+remediation, coverage-suspect synthetic record.
- \`analysing.test.tsx\`: live remediation, hydrated remediation, legacy fallback.
- \`npm run verify\` green locally."
```

Then after a final local `npm run verify` confirms green: `gh pr ready <n>` (one billed CI run), merge per repo convention, and pull main.

---

## PR 2 — fe-29 Help view

### Task 9: Branch + worktree for PR 2 (orchestrator, after PR 1 merges)

**Depends on:** PR 1 merged to main (Tasks 10+ import `failure-remediations.ts` and the regenerated `FailureCode` enum from main). Remove the PR-1 worktree first (`git worktree remove ../Audiobook-Generator-wt-fs19`).

- [ ] **Step 1: Create the PR-2 worktree off updated main**

```bash
git fetch origin main
git worktree add ../Audiobook-Generator-wt-fe29 -b feat/frontend-fe29-help-view origin/main
```

- [ ] **Step 2: Junction the dependency dirs** (same as Task 1 Step 2, target `..\Audiobook-Generator-wt-fe29`). All Task 10–16 subagents run inside this worktree. Reminder for Task 12: `brand/` does NOT exist in the worktree — read it from the main checkout's absolute path.

### Task 10: Help content layer (curated topics + taxonomy mapper with satisfies pin)

**Depends on:** Task 9 (PR-1 code on main: `server/src/routes/failure-remediations.ts` exists with 16 keys; `src/lib/api-types.ts` has the 16-value `FailureCode` enum).
**Pre-flight reads:** `server/src/routes/failure-remediations.ts` (confirm the 16 keys), `src/lib/api-types.ts` — the `FailureCode` schema line (search `FailureCode:`).

**Files:**
- Create: `src/data/help-topics.ts`, `src/data/help-failures.ts`
- Test: `src/data/help-failures.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { HELP_FAILURE_ENTRIES } from './help-failures';
import { HELP_TOPICS } from './help-topics';

describe('help content (fe-29)', () => {
  it('has one troubleshooting entry per FailureCode, each with title/userMessage/remediation', () => {
    for (const e of HELP_FAILURE_ENTRIES) {
      expect(e.code.length).toBeGreaterThan(0);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.userMessage.length).toBeGreaterThan(0);
      expect(e.remediation.length).toBeGreaterThan(0);
    }
    expect(HELP_FAILURE_ENTRIES.length).toBe(16);
  });
  it('curated topics each have a title and body', () => {
    expect(HELP_TOPICS.length).toBeGreaterThanOrEqual(5);
    for (const t of HELP_TOPICS) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/data/help-failures.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Create `src/data/help-failures.ts`**

```ts
/* fe-29 — maps the shared fs-19 remediation copy (server/src/routes/
   failure-remediations.ts, bundled statically by Vite so Help works offline)
   into ordered, titled entries for the Help view's troubleshooting section.
   The `satisfies Record<FailureCode, string>` pin means a new FailureCode
   without a Help title fails `npm run typecheck` — the contract the spec
   calls "pinned on both ends". */
import {
  FAILURE_REMEDIATIONS,
  type FailureRemediationCopy,
} from '../../server/src/routes/failure-remediations';
import type { components } from '../lib/api-types';

export type FailureCode = components['schemas']['FailureCode'];

const TITLES = {
  'vram-spill': 'GPU out of memory (VRAM)',
  'recycle-storm': 'TTS engine keeps restarting',
  'sidecar-unreachable': 'TTS sidecar not running',
  'analyzer-rate-limit': 'Analyzer rate-limited',
  'analyzer-daily-quota': 'Analyzer daily quota exhausted',
  'analyzer-truncated': 'Analyzer reply cut short',
  'analyzer-unreachable': 'Analyzer not reachable',
  'attribution-incomplete': 'Chapter attribution incomplete',
  oom: 'Computer ran out of memory',
  'disk-full': 'Disk full',
  'model-not-loaded': 'TTS model not loaded yet',
  'synth-timeout': 'Chapter synthesis timed out',
  'xtts-speaker-desync': 'Voice catalog out of sync',
  'cuda-poisoned': 'GPU error (auto-recovering)',
  auth: 'Gemini API key problem',
  unknown: 'Unrecognised error',
} satisfies Record<FailureCode, string>;

export interface HelpFailureEntry extends FailureRemediationCopy {
  code: FailureCode;
  title: string;
}

export const HELP_FAILURE_ENTRIES: HelpFailureEntry[] = (
  Object.keys(TITLES) as FailureCode[]
).map((code) => ({
  code,
  title: TITLES[code],
  ...FAILURE_REMEDIATIONS[code],
}));
```

- [ ] **Step 4: Create `src/data/help-topics.ts`** (curated topics — full copy, hand-written, frontend-only. The copy below is a FUNCTIONAL first draft — Task 12 Step 4 runs the brand-voice pass over it before PR 2 ships; land it as-is here so the tests have content to pin.)

```ts
/* fe-29 — hand-written troubleshooting topics for failures the taxonomy can't
   see (the server/sidecar never got far enough to classify anything). */

export interface HelpTopic {
  id: string;
  title: string;
  body: string;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'app-wont-start',
    title: 'The app won’t start',
    body:
      'Run `npm start` from the install folder — it launches the web app, the server, and the ' +
      'TTS sidecar together. If the browser tab opens but stays blank, hard-refresh (Ctrl+Shift+R). ' +
      'If the terminal shows a port-in-use error, another copy is already running — close it first. ' +
      'On a fresh install, run `npm install` once before the first start.',
  },
  {
    id: 'models-missing',
    title: 'Voices or models are missing',
    body:
      'Open Models (Admin → Model Manager) to see what is installed. The Kokoro voice pack installs ' +
      'with `scripts/install-kokoro.ps1`; other engines install from the Model Manager rows. If an ' +
      'engine shows as installed but synthesis fails with “model not loaded”, load it from its pill ' +
      'in the top bar and wait for it to turn green.',
  },
  {
    id: 'generation-slow',
    title: 'Generation is much slower than usual',
    body:
      'Check the GPU isn’t shared with something heavy (games, a second model). Keep only one heavy ' +
      'TTS model loaded — unload the analyzer Ollama or a second engine from the model pills. If it ' +
      'started after hours of generating, restart the TTS sidecar (it reclaims leaked memory). The ' +
      'Admin view’s Resource trends panel shows the per-chapter speed history.',
  },
  {
    id: 'phone-cant-reach',
    title: 'My phone can’t reach the app (LAN / HTTPS)',
    body:
      'Real devices need the LAN HTTPS mode: run `npm run dev:lan` (or `npm run start:lan` for the ' +
      'production build) and open the printed https:// address. Each device must trust the local ' +
      'certificate once — run `npm run install:cert-mobile` and follow the per-OS steps it prints. ' +
      'Both devices must be on the same network.',
  },
  {
    id: 'where-files-live',
    title: 'Where are my books and audio on disk?',
    body:
      'Each book lives in its own folder under the workspace directory (server/workspace by ' +
      'default): the manuscript, the cast (cast.json), per-chapter audio, and exports. Deleting a ' +
      'book folder removes that book; back up the workspace folder to keep everything.',
  },
];
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/data/help-failures.test.ts && npm run typecheck`
Expected: PASS. If `npm run typecheck` complains about the cross-package import, check the frontend tsconfig `include` — the import is followed automatically; only add `"server/src/routes/failure-remediations.ts"` to `include` if tsc actually errors.

- [ ] **Step 6: Commit**

```bash
git add src/data/help-failures.ts src/data/help-topics.ts src/data/help-failures.test.ts
git commit -m "feat(frontend): help content layer — shared failure copy mapper + curated topics"
```

### Task 11: Router + stage for `#/help?code=`

**Depends on:** Task 9 only (independent of Task 10, but run sequentially — shared store/test files).
**Pre-flight reads:** `src/lib/router.ts` (whole file, ~78 lines), `src/lib/types.ts` Stage union (~820–830), `src/store/ui-slice.ts` — the `openAbout` reducer (~162) and the file's action-export pattern, `src/routes/index.tsx` — the `AboutRoute` (~406–416), the lazy-import block (~70–82), one `useSearchParams` consumer (~528) and the route table (~1040–1060); `src/lib/router.test.ts` + `src/store/ui-slice.test.ts` case idioms.

**Files:**
- Modify: `src/lib/types.ts` (Stage union ~826), `src/lib/router.ts`, `src/store/ui-slice.ts` (mirror the `about` reducer ~163), `src/routes/index.tsx` (lazy import ~74-80 area; route table ~1053)
- Test: `src/lib/router.test.ts`

Deviation from spec noted: `focusCode` is typed `string` (not the FailureCode enum) — it round-trips through the UNTRUSTED url hash; the view validates it against known entries (Task 12 renders no highlight for an unknown code).

- [ ] **Step 1: Write the failing router tests**

Append to `src/lib/router.test.ts` (mirror the file's existing case idiom):

```ts
it('serialises the help stage', () => {
  expect(stageToHash({ kind: 'help' })).toBe('#/help');
  expect(stageToHash({ kind: 'help', focusCode: 'vram-spill' })).toBe('#/help?code=vram-spill');
});

it('stageEqual distinguishes help focusCode', () => {
  expect(stageEqual({ kind: 'help' }, { kind: 'help' })).toBe(true);
  expect(stageEqual({ kind: 'help', focusCode: 'a' }, { kind: 'help', focusCode: 'b' })).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/router.test.ts`
Expected: FAIL (type error / wrong hash).

- [ ] **Step 3: Implement**

1. `src/lib/types.ts` Stage union (next to `{ kind: 'about' }`): `| { kind: 'help'; focusCode?: string }`
2. `src/lib/router.ts` — `stageToHash` gains (and update the grammar comment block at the top with `#/help?code=` alongside the existing lines):

```ts
    case 'help': {
      const qs = stage.focusCode ? `?code=${encodeURIComponent(stage.focusCode)}` : '';
      return `#/help${qs}`;
    }
```

and `stageEqual` gains (next to the `confirm` comparison):

```ts
  if (a.kind === 'help' && b.kind === 'help') {
    return a.focusCode === b.focusCode;
  }
```

3. `src/store/ui-slice.ts` — add the sibling of `openAbout` (~162):

```ts
    openHelp: (s, a: PayloadAction<{ focusCode?: string } | undefined>) => {
      s.stage = { kind: 'help', focusCode: a.payload?.focusCode };
    },
```

(If the file's other no-payload reducers omit `PayloadAction` imports/typing style, match the file's existing idiom — but keep the optional `focusCode` payload.)
4. `src/routes/index.tsx` — mirror `AboutRoute` (~406) with the query param (the `confirm` route's `?profile=` handling shows the file's `useSearchParams` idiom — follow it):

```tsx
const HelpView = lazyView(() => import('../views/help').then((m) => ({ default: m.HelpView })));

/* fe-29 — offline help / troubleshooting, reached from the top-bar "?" +
   Account; deep-linked per failure code via ?code=. */
function HelpRoute() {
  const [params] = useSearchParams();
  const focusCode = params.get('code') ?? undefined;
  useHydrateStage({ kind: 'help', focusCode }, [focusCode]);
  return <HelpView />;
}
```

and the route row: `{ path: 'help', element: <HelpRoute /> },` (after `about`). Match the file's actual lazy-import helper — read the `about` wiring first and copy its exact shape (the `lazyView` name above is illustrative; use whatever the file uses at ~74).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/router.test.ts src/store/ui-slice.test.ts && npm run typecheck`
Expected: PASS (extend `ui-slice.test.ts` with one case asserting the new reducer sets the stage if that file covers `about` the same way).

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/router.ts src/store/ui-slice.ts src/routes/index.tsx src/lib/router.test.ts src/store/ui-slice.test.ts
git commit -m "feat(frontend): #/help route + stage with ?code= deep-link grammar"
```

### Task 12: The Help view

**Depends on:** Task 10 (`HELP_FAILURE_ENTRIES`, `HELP_TOPICS`), Task 11 (`{ kind: 'help' }` stage + `openHelp` action — the test dispatches it).
**Pre-flight reads:** `src/views/about.tsx` (whole file — the page chrome to reuse), `src/store/index.ts` (store factory export name for the test), one existing view test (e.g. `src/views/account.test.tsx`) for the render-with-store idiom, `src/components/mini-player.tsx` ~105–115 (the defensive keybinding-read idiom), and — for Step 4 — `brand/project-narrative.md` + `docs/superpowers/specs/2026-06-07-castwright-brand-design.md` **from the MAIN checkout** (`C:\Claude\Projects\Audiobook-Generator\brand\…`; `brand/` is git-ignored so the worktree has no copy).

**Files:**
- Create: `src/views/help.tsx`
- Test: `src/views/help.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { makeStore } from '../store'; // match the idiom other view tests use — check analysing.test.tsx
import { HelpView } from './help';

function renderHelp(stage: { kind: 'help'; focusCode?: string }) {
  const store = makeStore();
  store.dispatch({ type: 'ui/openHelp', payload: { focusCode: stage.focusCode } }); // match the real action name from Task 11
  return render(
    <Provider store={store}>
      <HelpView />
    </Provider>,
  );
}

describe('HelpView (fe-29)', () => {
  it('renders the three sections', () => {
    renderHelp({ kind: 'help' });
    expect(screen.getByRole('heading', { name: /getting started/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /keyboard shortcuts/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /troubleshooting/i })).toBeInTheDocument();
  });
  it('renders a taxonomy entry with What-you-saw / What-to-do', () => {
    renderHelp({ kind: 'help' });
    expect(screen.getByText('GPU out of memory (VRAM)')).toBeInTheDocument();
    expect(screen.getAllByText(/what to do/i).length).toBeGreaterThan(0);
  });
  it('marks the focused entry when focusCode matches', () => {
    renderHelp({ kind: 'help', focusCode: 'vram-spill' });
    expect(document.getElementById('vram-spill')).toHaveAttribute('data-focused', 'true');
  });
  it('ignores an unknown focusCode', () => {
    renderHelp({ kind: 'help', focusCode: 'nonsense' });
    expect(document.querySelector('[data-focused="true"]')).toBeNull();
  });
  it('shows the live keybindings from the store', () => {
    renderHelp({ kind: 'help' });
    expect(screen.getByText(/play \/ pause/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/views/help.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/views/help.tsx`**

Follow `src/views/about.tsx` for page chrome (container widths, heading styles, token classes — read it first and reuse its wrapper classes). Structure (complete component logic; copy prose as written):

```tsx
/* fe-29 — offline Help / troubleshooting view (#/help, ?code= deep-link).
   All content ships in the bundle: the troubleshooting entries come from the
   shared fs-19 copy module via src/data/help-failures.ts, so Help keeps
   working when the server is down — which is exactly when it's needed. */
import { useEffect, useRef } from 'react';
import { useAppSelector } from '../store';
import { formatKeyLabel } from '../lib/keybindings';
import { stageToHash } from '../lib/router';
import { HELP_FAILURE_ENTRIES } from '../data/help-failures';
import { HELP_TOPICS } from '../data/help-topics';

const GETTING_STARTED: { title: string; body: string }[] = [
  {
    title: 'Add a book',
    body: 'Click “New book” on the library and drop in a manuscript (txt, epub, pdf). Chapters are detected automatically — adjust the boundaries on the next screen if needed. To try the pipeline risk-free first, load the bundled demo book from the library menu.',
  },
  {
    title: 'Analysis',
    body: 'The analyzer reads every chapter, finds the characters, and works out who speaks each line. This runs locally (or via Gemini) and takes a few minutes per book; you can leave the page and come back.',
  },
  {
    title: 'Confirm the cast',
    body: 'Review the detected characters, merge duplicates, and link characters you already know from other books in the series — linked characters keep their voices.',
  },
  {
    title: 'Design voices',
    body: 'Give each character a voice: pick a preset, or design a custom one from a text description. “Design full cast” does the whole roster in one click.',
  },
  {
    title: 'Generate',
    body: 'Generate renders every chapter to audio with your cast. Failed chapters show a reason and a retry button — see Troubleshooting below for the common failures.',
  },
  {
    title: 'Listen & export',
    body: 'Play chapters in the app, or export the finished audiobook (M4B and more) from the Listen view’s download section.',
  },
];

const SHORTCUT_LABELS: { action: 'play-pause' | 'skip-back' | 'skip-forward'; label: string }[] = [
  { action: 'play-pause', label: 'Play / pause' },
  { action: 'skip-back', label: 'Skip back' },
  { action: 'skip-forward', label: 'Skip forward' },
];

export function HelpView() {
  const stage = useAppSelector((s) => s.ui.stage);
  const focusCode = stage?.kind === 'help' ? stage.focusCode : undefined;
  const keybindings = useAppSelector((s) => s.settings.keybindings);
  const focusedRef = useRef<HTMLDivElement | null>(null);

  const focusedEntryExists = HELP_FAILURE_ENTRIES.some((e) => e.code === focusCode);

  useEffect(() => {
    if (focusedEntryExists && focusedRef.current) {
      focusedRef.current.scrollIntoView({ block: 'start' });
    }
  }, [focusedEntryExists, focusCode]);

  return (
    /* …page wrapper copied from about.tsx… */
    <div>
      <nav aria-label="Help sections" /* jump-nav: sticky aside ≥lg, inline links below */>
        <a href="#getting-started">Getting started</a>
        <a href="#keyboard-shortcuts">Keyboard shortcuts</a>
        <a href="#troubleshooting">Troubleshooting</a>
      </nav>

      <section id="getting-started" aria-labelledby="getting-started-h">
        <h2 id="getting-started-h">Getting started</h2>
        {GETTING_STARTED.map((s) => (
          <div key={s.title}>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </div>
        ))}
      </section>

      <section id="keyboard-shortcuts" aria-labelledby="shortcuts-h">
        <h2 id="shortcuts-h">Keyboard shortcuts</h2>
        <ul>
          {SHORTCUT_LABELS.map(({ action, label }) => (
            <li key={action}>
              <span>{label}</span>
              <kbd>{formatKeyLabel(keybindings[action])}</kbd>
            </li>
          ))}
        </ul>
        <p>
          Change these in <a href={stageToHash({ kind: 'account' })}>Account</a>.
        </p>
      </section>

      <section id="troubleshooting" aria-labelledby="troubleshooting-h">
        <h2 id="troubleshooting-h">Troubleshooting</h2>
        <h3>Failures the app can name</h3>
        {HELP_FAILURE_ENTRIES.map((e) => {
          const focused = e.code === focusCode;
          return (
            <div
              key={e.code}
              id={e.code}
              ref={focused ? focusedRef : undefined}
              data-focused={focused ? 'true' : undefined}
              /* focused: add a highlight ring class via the data attribute */
            >
              <h4>{e.title}</h4>
              <p>
                <span className="font-semibold">What you saw:</span> {e.userMessage}
              </p>
              <p>
                <span className="font-semibold">What to do:</span> {e.remediation}
              </p>
              {e.helpDetail && <p>{e.helpDetail}</p>}
            </div>
          );
        })}
        <h3>Common questions</h3>
        {HELP_TOPICS.map((t) => (
          <div key={t.id} id={t.id}>
            <h4>{t.title}</h4>
            <p>{t.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
```

Styling: reuse `about.tsx`'s section/heading classes verbatim; token classes only (`text-ink`, `bg-canvas`, `text-magenta`, …) — NO hex literals. The jump-nav is `hidden lg:block sticky top-24` as an aside plus an inline link row `lg:hidden`. Interactive elements ≥44px on phone (`min-h-[44px] sm:min-h-0`). Keybinding lookups: mirror mini-player's defensive idiom (`keybindings?.['play-pause'] ?? 'Space'`, defaults `J`/`L` for skip-back/skip-forward) so a legacy persisted settings blob can't render `undefined`.

- [ ] **Step 4: Brand-voice pass over ALL user-facing Help copy**

The GETTING_STARTED prose, HELP_TOPICS bodies/titles (Task 10), the section intro lines, and the four NEW remediation strings (Task 4) were drafted functionally — rework them against the Castwright voice before shipping:

1. Read `brand/project-narrative.md` and `docs/superpowers/specs/2026-06-07-castwright-brand-design.md` (note: `brand/` is git-ignored local-only — it exists on this machine's checkout; if executing in a worktree, read it from the MAIN checkout's `brand/` dir). `src/views/about.tsx` and `RELEASE_NOTES.md` are the in-app voice precedents.
2. Apply the voice to: Getting-started step prose and titles, the Help page intro line, curated-topic titles/bodies, and section headings. Tone target: warm, confident, plain-spoken — "any book, performed by a full cast"; never corporate-support-speak.
3. Do NOT brand-flavour the failure entries' `userMessage`/`remediation` (shared with live error rows — error moments need plain instructions, and the existing fs-19 strings set the register; consistency wins). `helpDetail` MAY carry a touch more voice.
4. Keep every test-asserted string compatible (the tests match on headings like "Getting started" / "Troubleshooting" and entry titles — if the voice pass renames anything, update the matching test + e2e assertions in the same commit).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/views/help.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/help.tsx src/views/help.test.tsx src/data/help-topics.ts src/data/help-failures.ts
git commit -m "feat(frontend): fe-29 offline Help view — getting started, shortcuts, troubleshooting"
```

### Task 13: Entry points — top-bar "?" + Account row (+ visual baselines)

**Depends on:** Task 11 (the `'help'` stage value for the active state; the `#/help` route must resolve for the baseline screenshots to be meaningful), Task 12 (view exists — the regen run renders pages that include the top bar everywhere).
**Pre-flight reads:** `src/components/top-bar.tsx` ~320–355 (the right-hand control cluster + `stage` prop type), `src/components/top-bar.test.tsx` (render-harness idiom), `src/views/account.tsx` — the release-notes row (search `release-notes`).
**Visual-baseline warning:** Step 5 OVERWRITES committed PNGs under `e2e/responsive/` — this is the one task allowed to do that; eyeball the diff before committing.

**Files:**
- Modify: `src/components/top-bar.tsx` (~346, next to `<ThemeToggleButton />`), `src/views/account.tsx` (next to the release-notes row), `src/components/top-bar.test.tsx`
- Regenerate: `e2e/responsive/visual.spec.ts-snapshots/` baselines

- [ ] **Step 1: Write the failing test**

In `top-bar.test.tsx` (mirror its existing render-harness idiom):

```tsx
it('renders the persistent Help affordance linking to #/help (fe-29)', () => {
  renderTopBar(); // the file's existing helper
  const help = screen.getByRole('link', { name: /^help$/i });
  expect(help).toHaveAttribute('href', '#/help');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/top-bar.test.tsx`
Expected: new case FAILS.

- [ ] **Step 3: Implement**

1. `top-bar.tsx`, immediately before `<ThemeToggleButton />` (anchor `aria-label="Help"`; an `<a>` so middle-click works; active state when `stage === 'help'` — the `stage` prop is already in scope):

```tsx
          <a
            href="#/help"
            aria-label="Help"
            title="Help & troubleshooting"
            data-testid="topbar-help"
            className={`inline-flex items-center justify-center w-9 h-9 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded-full text-sm font-semibold transition-colors ${
              stage === 'help' ? 'bg-ink text-canvas' : 'text-ink/70 hover:bg-ink/10'
            }`}
          >
            ?
          </a>
```

(`stage` prop type: if `TopBar`'s `stage` prop union doesn't include `'help'`, widen it — it is derived from `ui.stage.kind`.)

2. `account.tsx` — find the release-notes row (`rg -n "release-notes" src/views/account.tsx`) and add a sibling row above/below it with the same row classes, label **Help & troubleshooting**, `href="#/help"`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/top-bar.test.tsx src/views/account.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Regenerate the visual baselines** (the new icon changes every full-page screenshot — REQUIRED, this suite is in pre-push verify)

Run: `npm run test:e2e:visual -- --update-snapshots` (MUST go through the npm script — it pins `--workers=1`, which the repo added because parallel snapshot runs race Windows font hinting; a bare `npx playwright test` regen can bake in drifted pixels)
Then: `npm run test:e2e:visual`
Expected: regen writes new PNGs; the verification run is green. Eyeball one updated PNG (e.g. library) to confirm the only visible change is the "?" in the top bar.

- [ ] **Step 6: Commit (include the regenerated snapshots)**

```bash
git add src/components/top-bar.tsx src/components/top-bar.test.tsx src/views/account.tsx e2e/responsive
git commit -m "feat(frontend): persistent Help entry points (top-bar ? + Account) + visual baseline regen"
```

### Task 14: "More help" deep-links from both failure surfaces

**Depends on:** Task 10 (`HELP_FAILURE_ENTRIES` for the analysing-side gate), Task 11 (`stageToHash` help case), PR 1 (the `code`/`remediation` fields on rows + panel, merged via Task 9's base).
**Pre-flight reads:** `src/views/generation.tsx` — the `generationRemediation` block (search `What to do`; ~1539), `src/views/analysing.tsx` — the failed-row "What to do:" block and the run-error panel as left by PR 1's Task 7, `src/views/generation.test.tsx` — the existing fs-19 remediation test (search `What to do`).

**Files:**
- Modify: `src/views/generation.tsx` (~1539, the `generationRemediation` block), `src/views/analysing.tsx` (failed-row block from Task 7; run-error panel)
- Test: extend `src/views/generation.test.tsx` + `src/views/analysing.test.tsx`

- [ ] **Step 1: Write the failing tests**

`generation.test.tsx` (mirror the harness used by the existing fs-19 remediation test — `rg -n "What to do" src/views/generation.test.tsx`):

```tsx
it('failed chapter row links to #/help?code= when a FailureCode is present (fe-29)', () => {
  // render a chapter with generationErrorCode: 'vram-spill', generationRemediation set
  const link = screen.getByRole('link', { name: /more help/i });
  expect(link).toHaveAttribute('href', '#/help?code=vram-spill');
});

it('suppresses the More-help link for unknown codes', () => {
  // render with generationErrorCode: 'unknown'
  expect(screen.queryByRole('link', { name: /more help/i })).toBeNull();
});
```

`analysing.test.tsx`: same two assertions against a failed row carrying `code: 'analyzer-unreachable'` vs `code: undefined`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/views/generation.test.tsx src/views/analysing.test.tsx`
Expected: new cases FAIL.

- [ ] **Step 3: Implement**

Shared helper in `src/lib/router.ts` (exported next to `stageToHash`):

```ts
/** fe-29 — href for the Help view's troubleshooting anchor of a failure code.
    Returns null for missing/unknown codes (the anchor adds nothing there). */
export function helpHrefForFailureCode(code: string | null | undefined): string | null {
  if (!code || code === 'unknown') return null;
  return stageToHash({ kind: 'help', focusCode: code });
}
```

`generation.tsx` — inside the existing remediation block (~1539):

```tsx
            {chapter.generationRemediation && (
              <p /* existing classes */>
                <span className="font-semibold">What to do:</span> {chapter.generationRemediation}
                {helpHrefForFailureCode(chapter.generationErrorCode) && (
                  <>
                    {' '}
                    <a
                      href={helpHrefForFailureCode(chapter.generationErrorCode)!}
                      className="underline font-semibold text-magenta hover:text-magenta/80"
                    >
                      More help
                    </a>
                  </>
                )}
              </p>
            )}
```

`analysing.tsx` — same pattern appended to the Task-7 "What to do:" row line (driven by `f.code`) and to the run-error panel's remediation line (driven by `error.code`). `helpHrefForFailureCode` stays dumb (null only for falsy/`'unknown'`) so `router.ts` keeps zero data deps — but the ANALYSING call sites must additionally gate on the known-entry list, because the run-error panel can carry legacy or control-flow code strings that have no Help anchor (a "More help" link that scrolls nowhere is worse than no link):

```tsx
import { HELP_FAILURE_ENTRIES } from '../data/help-failures';

const isHelpLinkable = (code: string | undefined): boolean =>
  code != null && HELP_FAILURE_ENTRIES.some((e) => e.code === code);

// row:   {isHelpLinkable(f.code) && <a href={helpHrefForFailureCode(f.code)!} …>More help</a>}
// panel: {isHelpLinkable(error.code) && <a href={helpHrefForFailureCode(error.code)!} …>More help</a>}
```

(`unknown` is in HELP_FAILURE_ENTRIES but `helpHrefForFailureCode` returns null for it — keep BOTH guards: `isHelpLinkable(code) && helpHrefForFailureCode(code)` truthy before rendering. The GENERATION side needs only `helpHrefForFailureCode` — `generationErrorCode` is always a taxonomy value.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/views/generation.test.tsx src/views/analysing.test.tsx src/lib/router.test.ts && npm run typecheck`
Expected: PASS (add a `helpHrefForFailureCode` unit case to router.test.ts: `'vram-spill'` → `'#/help?code=vram-spill'`, `'unknown'` → null, `undefined` → null).

- [ ] **Step 5: Commit**

```bash
git add src/lib/router.ts src/lib/router.test.ts src/views/generation.tsx src/views/generation.test.tsx src/views/analysing.tsx src/views/analysing.test.tsx
git commit -m "feat(frontend): More-help deep-links from generation + analysing failure surfaces"
```

### Task 15: E2E — help spec + responsive coverage case

**Depends on:** Tasks 12–13 (the view, the `topbar-help` testid, post-brand-voice headings — the spec's text assertions must match the SHIPPED copy, so read `help.tsx` as committed, not this plan's draft strings).
**Pre-flight reads:** `e2e/responsive/coverage.spec.ts` — the `about (global) view` case (~142) and the file's shared helpers; one root-level e2e spec for the goto/baseURL idiom; `src/views/help.tsx` as committed (actual headings + entry titles).

**Files:**
- Create: `e2e/help.spec.ts`
- Modify: `e2e/responsive/coverage.spec.ts` (append a case mirroring the `about (global) view` one at ~142 — read it and copy its navigation idiom)

- [ ] **Step 1: Write `e2e/help.spec.ts`** (mirror an existing global-view spec's boilerplate — e.g. the about spec if one exists, else `e2e/` page-load helpers):

```ts
import { expect, test } from '@playwright/test';

/* fe-29 — Help view golden path: persistent affordance opens it, the three
   sections render, and a ?code= deep-link lands focused. */

test('top-bar ? opens Help with all three sections', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('topbar-help').click();
  await expect(page).toHaveURL(/#\/help$/);
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Troubleshooting' })).toBeVisible();
  await expect(page.getByText('GPU out of memory (VRAM)')).toBeVisible();
});

test('?code= deep-link focuses the matching entry', async ({ page }) => {
  await page.goto('/#/help?code=vram-spill');
  await expect(page.locator('#vram-spill')).toHaveAttribute('data-focused', 'true');
  await expect(page.locator('#vram-spill')).toBeInViewport();
});
```

- [ ] **Step 2: Append the coverage case** to `e2e/responsive/coverage.spec.ts` (copy the `about (global) view` case verbatim, swap route to `'#/help'` and assert `page.getByRole('heading', { name: 'Troubleshooting' })` is visible).

- [ ] **Step 3: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS including the two new help specs + the coverage case at the chromium project. (Port 5174 contention with a concurrent session: re-run with `CI=1` + a free `PLAYWRIGHT_PORT` per the repo's known workaround if startup fails.)

- [ ] **Step 4: Commit**

```bash
git add e2e/help.spec.ts e2e/responsive/coverage.spec.ts
git commit -m "test(e2e): fe-29 help view golden path + responsive coverage"
```

### Task 16: Docs, verify, PR 2

**Depends on:** Tasks 10–15 all committed green.
**Pre-flight reads:** `docs/features/TEMPLATE.md`, `docs/features/INDEX.md` (neighbouring rows for format), `docs/BACKLOG.md` — the fe-29 block (~line 67), `docs/features/173-failure-taxonomy.md` Ship notes.
**Split responsibility:** subagent does docs + verify + commit; ORCHESTRATOR pushes, opens the draft PR, readies and merges after reviewing the branch diff.

**Files:**
- Create: `docs/features/209-help-troubleshooting-view.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`, `docs/BACKLOG.md` (remove the fe-29 row at ~line 67), `docs/features/173-failure-taxonomy.md` (note the deep-link delivery)

- [ ] **Step 1: Write plan 209** from TEMPLATE.md with this content core:

```markdown
---
status: active
shipped: null
owner: null
---

# 209 — In-app Help / troubleshooting view (fe-29)

> Key files: `src/views/help.tsx`, `src/data/help-failures.ts`, `src/data/help-topics.ts`,
> `server/src/routes/failure-remediations.ts`, `src/lib/router.ts`, `src/components/top-bar.tsx`
> URL surface: `#/help`, `#/help?code=<failure-code>`

## Benefit / Rationale
- **User:** support deflection — getting started, live keyboard shortcuts, and every
  fs-19 failure's remediation live where the user already is, offline, deep-linked
  from the exact failure row that sent them.
- **Architectural:** `failure-remediations.ts` is the single copy source for the
  taxonomy AND the Help view; a FailureCode without copy fails typecheck on both ends.

## Invariants to preserve
1. `failure-remediations.ts` imports NOTHING (frontend bundles it across the package boundary).
2. The Help view performs zero network calls — it must render with the server down.
3. Every `FailureCode` has a Help anchor (`id={code}`) and a title in `help-failures.ts`
   (`satisfies Record<FailureCode, string>`).
4. The top-bar "?" renders on every stage (it lives in the shared TopBar).
5. `helpHrefForFailureCode` returns null for `unknown`/missing codes — failure rows
   never link to a non-anchor.

## Test plan
- Unit: `help.test.tsx` (sections, focus, unknown-code no-op, live keybindings),
  `help-failures.test.ts` (copy completeness), router round-trip cases.
- E2E: `e2e/help.spec.ts` (top-bar entry + deep-link focus) + responsive coverage case.
- Manual: open `#/help` with the server stopped — page fully renders.
```

- [ ] **Step 2: INDEX + BACKLOG + plan 173**

- `docs/features/INDEX.md`: add the 209 row under the frontend area (mirror neighbouring rows).
- `docs/BACKLOG.md`: delete the fe-29 block (~line 67).
- `docs/features/173-failure-taxonomy.md`: append to Ship notes: `fe-29 Help view deep-links (#/help?code=) delivered — the downstream surface the taxonomy's stable codes were built for.`

- [ ] **Step 3: Full verify**

Run: `npm run verify`
Expected: green end-to-end.

- [ ] **Step 4: Commit + draft PR + ready**

```bash
git add docs/features/209-help-troubleshooting-view.md docs/features/INDEX.md docs/BACKLOG.md docs/features/173-failure-taxonomy.md
git commit -m "docs(docs): plan 209 help view + backlog/index updates"
git push -u origin feat/frontend-fe29-help-view
gh pr create --draft --title "feat(frontend): fe-29 in-app Help / troubleshooting view" --body "## Summary
- New offline \`#/help\` view: Getting started, live keyboard shortcuts, troubleshooting (every fs-19 FailureCode from the shared copy module + 5 curated topics).
- Persistent entry points: top-bar \"?\" (all stages) + Account row. Visual baselines regenerated (top-bar change).
- \`#/help?code=\` deep-links from the Generate + analysing failure surfaces (suppressed for \`unknown\`).

Spec: docs/superpowers/specs/2026-06-12-help-troubleshooting-fs19-completion-design.md (PR 2 of 2). Closes #473.

## Test plan
- \`help.test.tsx\`, \`help-failures.test.ts\`, router cases, top-bar/account/generation/analysing link tests.
- \`e2e/help.spec.ts\` + responsive coverage case; \`npm run test:e2e:visual\` green on regenerated baselines.
- \`npm run verify\` green locally. Manual: #/help renders with the server stopped."
```

Then `gh pr ready <n>` once locally green, merge, pull main.

**Post-merge (manual, GPU box — closes plan 173):** live acceptance per the spec's recipe — `sidecar-unreachable` (stop sidecar mid-generation) and `analyzer-unreachable` (stop Ollama mid-analysis **with GEMINI_API_KEY unset** — otherwise the silent Gemini fallback correctly absorbs it). Confirm row/panel copy + Help deep-link both ways, then move plan 173 → `stable` → `docs/features/archive/` and update INDEX.
