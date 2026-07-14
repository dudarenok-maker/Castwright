# fe-49 — Analyzer/Voice wizard split + local-Ollama loop + primary/backup signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the first-run wizard's combined "Models" step into a local-first **Analysis** step (with a working Ollama pull path) and a **Voice** step; add a primary/backup (`green`/`yellow`/`red`) analyzer-readiness signal; and make the Defaults model dropdown actually switch the analyzer engine.

**Architecture:** Adds a `warn` state to the hand-written `BlockerDiagnosis.status` union on both client and server (NOT openapi-generated). The server's engine-aware pass/fail gate is preserved byte-for-byte; `warn` is a pure additive label ("will run, but no backup analyzer") layered over today's PASS set, and the boot gate is relaxed to treat `warn` as non-blocking. The wizard's `Models` step becomes two steps (`Analysis` then `Voice`); the Analysis step composes the existing `OllamaInstall` + `ModelPullStatus` leaf controls (no new picker) plus the `GeminiKeyField`. Defaults auto-derives `analysisEngine` from the picked model id's `':'` shape.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (frontend); Node/Express (server); Vitest (unit, jsdom + node), Playwright (e2e).

## Global Constraints

- **Spec of record:** `docs/superpowers/specs/2026-07-14-fe49-analyzer-wizard-split-design.md`. Every decision below traces to it.
- **`BlockerDiagnosis` is hand-written in TWO places, kept in lockstep** — client `src/lib/api.ts:7128` and server `server/src/routes/setup-readiness.ts:69`. NOT generated from `openapi.yaml`. Widen both.
- **The pass/fail gate stays byte-identical to today.** `warn` never changes what passes/fails; it only splits today's PASS set into green (`pass`, has backup) vs yellow (`warn`, no backup). The fallback is NOT modeled in the gate (matches today: `FallbackAnalyzer` rescues only an unreachable daemon, `server/src/analyzer/index.ts:235-249`).
- **Engine classification heuristic:** an analysis-model id is `local` iff it contains `':'`, else `gemini` — matches `getResolvedOllamaModel()` (`server/src/workspace/user-settings.ts:566`) and `engineForModelId()` (`src/lib/models.ts:96`).
- **Design tokens only** — no hex literals in component code; reuse existing `emerald`/`amber`/`rose`/`ink` utility classes already used by the setup components.
- **Touch-target rule** — new interactive controls keep the existing `min-h-[44px] fine-pointer:min-h-0` pattern already present in the setup components (this work reuses existing controls, so no new targets are introduced).
- **Testing discipline** — every task ships paired automated tests; the wizard restructure additionally updates the e2e spec. No `.skip`, no bypass.
- **`status`-union widening is additive; the server `AnalyzerDiagnosisInput` change is NOT.** Adding `'warn'` to the *output* `status` union does not force-edit tests that construct a `'pass'`/`'fail'` diagnosis — they still satisfy the wider union. BUT Task 2 also (a) adds a **required** `anyAnalyzerModelPulled` field to `AnalyzerDiagnosisInput` (a compile-breaking change for any existing input literal) and (b) splits today's local-ready `pass` into `pass`/`warn` (a semantic change). The one existing fixture affected — `setup-diagnosis.test.ts:214` `ANALYZER_LOCAL_READY` — is explicitly updated in Task 2 Step 4b. Do not assume the input change is free; do not churn the *client* output-union factories, which genuinely are unchanged.

## Resolved planning-open items (from spec §"Resolve during planning")

1. **`anyAnalyzerModelPulled` predicate (backup label only):** a pulled tag counts iff it prefix-matches a curated model in the pull allowlist (`DEFAULT_ALLOWED_MODELS`, `server/src/ollama/pull-bootstrap.ts:63` — analyzer LLMs only, no embedding models), using the same tag-canonicalisation match as `ollama-health.ts:184-189`. This cleanly excludes an embedding-only install like `nomic-embed-text`. A user's custom non-curated tag does not light the backup-green on its own — but see item below (the gate-passed local primary is still credited via `modelPulled`), so no working analyzer is ever mislabeled.
2. **`warn` remedy action:** `warn` carries **no `action`** (text-only). There is no single "add a backup" destination (it's either a Gemini key OR a second local model), so a navigate button would mislead. `BlockerFixAction` already renders nothing without an action; the status-popover renders `warn` as a gentle, non-alarming line.
3. **Ollama bridge line → Defaults shortcut:** **plain guidance text, no jump button** for v1. Wizard steps are intentionally decoupled from paging (they receive only `{ readiness, onRefetch }`); threading a step-navigation callback for one line is unwarranted coupling (YAGNI). Defaults is one `Next` away.

## Deviation from spec (flagged correctness fix)

The spec §5 defines `localBackup = ollamaReachable && anyAnalyzerModelPulled`. Verified against the code, that mislabels one real case: **engine=`local`, resolved model is a custom non-curated tag, Gemini key set** — the local analyzer works AND Gemini is a real backup, so it should be **green**, but `anyAnalyzerModelPulled` is false for the custom tag, yielding `warn`. Fix (green-vs-yellow only, never the gate): `localBackup = ollamaReachable && (anyAnalyzerModelPulled || modelPulled)`. When the local gate has passed, `modelPulled` is true, so a running local primary always counts as a provisioned analyzer. This preserves the "embedding-only doesn't count" acceptance (`modelPulled` = *resolved analyzer* model pulled; an embedding-only box has neither true).

## File map

| File | Change |
|---|---|
| `src/lib/api.ts` | Widen `BlockerDiagnosis.status`; widen `mockBlocker`; add a `warn` mock scenario. |
| `server/src/routes/setup-readiness.ts` | Widen server `BlockerDiagnosis.status`; probe both engines; wire `anyAnalyzerModelPulled`; relax `ready` gate. |
| `server/src/routes/setup-diagnosis.ts` | Widen `diagnosis()`; rewrite `diagnoseAnalyzer` (add `warn`); add `anyAnalyzerModelPulled` helper. |
| `src/components/status-popover.tsx` | `DiagnosisBlock` renders `warn` as a gentle note. |
| `src/components/blocker-fix-action.tsx` | Guard: only render the fix button for `status === 'fail'`. |
| `src/components/setup/step-analysis.tsx` (new) | Local-first analyzer step: tri-state badge + `OllamaInstall` + `ModelPullStatus` + bridge line + `GeminiKeyField`. |
| `src/components/setup/step-voice.tsx` (new) | Voice-engines step (verbatim lift of today's voice half). |
| `src/components/setup/step-models.tsx` + `.test.tsx` | Delete. |
| `src/components/setup/setup-wizard.tsx` | `StepId`/`STEPS`/`renderStep`: `models` → `analysis` + `voice`; `buildSummaryRows` reorder + `SummaryStatus` gains `warn`. |
| `src/components/setup/step-defaults.tsx` | `handleAnalysisModelChange` auto-derives + saves `analysisEngine`. |
| `e2e/setup-wizard.spec.ts` | 6 → 7 steps, new order, Ollama pull path (mocked). |

Tests colocate next to each unit (`*.test.ts(x)`); server tests under `server/src/routes/`.

---

### Task 1: Client tri-state plumbing (`warn` state, render + mock)

Introduce `warn` on the client `BlockerDiagnosis` and make the two non-wizard consumers handle it: the status-popover renders it as a gentle note (not a red problem block), and the fix-action never surfaces for it. Nothing emits `warn` from the real API yet (Task 2 does); this task proves the client models & renders it, driven by a mock.

**Files:**
- Modify: `src/lib/api.ts:7128-7134` (type), `:7154-7158` (`mockBlocker`), `:7175-7205` (`mockGetSetupReadiness`)
- Modify: `src/components/status-popover.tsx:180-188` (`DiagnosisBlock`)
- Modify: `src/components/blocker-fix-action.tsx:69-70`
- Test: `src/components/status-popover.test.tsx`

**Interfaces:**
- Produces: `BlockerDiagnosis.status: 'pass' | 'warn' | 'fail'` (client). `mockBlocker(status: 'pass' | 'warn' | 'fail')`.

- [ ] **Step 1: Write the failing test** — `warn` renders a gentle note, no fix button.

In `src/components/status-popover.test.tsx`, add — **using the file's existing `readinessWith()` (`:32`) and `makeProps()` (`:43`) helpers**, which fill all blockers with PASS and supply every required `StatusPopover` prop. Using them is what makes this test fail for the RIGHT reason (the `status` union rejects `'warn'`) rather than on ~15 missing props:

```tsx
// readinessWith + makeProps already exist at the top of this file — reuse them.
it('renders a non-alarming note for a warn analyzer (no fix button)', () => {
  const warnAnalyzer: BlockerDiagnosis = {
    status: 'warn',
    cause: 'pass',
    message: 'Analyzer ready — no backup analyzer configured.',
    remediation: '',
  };
  render(<StatusPopover {...makeProps({ readiness: readinessWith({ analyzer: warnAnalyzer }) })} />);
  expect(screen.getByText(/no backup analyzer configured/i)).toBeInTheDocument();
  // No fix-action button for a warn: BlockerFixAction renders nothing without an
  // action AND is now gated to status === 'fail'.
  expect(screen.queryByRole('button', { name: /open|install|pull|set up/i })).toBeNull();
});
```

> The union widening (Step 3) is what flips this from red (TS rejects `status: 'warn'` in the typed `BlockerDiagnosis`) to green. The amber-note branch (Step 4) is exercised by the render; its tone is a class detail not asserted here (the load-bearing lock is "no fix button + message shown + non-blocking").

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/status-popover.test.tsx`
Expected: FAIL — TS rejects `status: 'warn'` (union is still `'pass' | 'fail'`), or the warn falls into the red block and renders a fix button.

- [ ] **Step 3: Widen the client type + mock.**

`src/lib/api.ts` — widen the union:

```ts
export interface BlockerDiagnosis {
  status: 'pass' | 'warn' | 'fail';
  cause: BlockerCause;
  message: string;
  remediation: string;
  action?: BlockerAction;
}
```

Widen `mockBlocker` and add the `warn` shape:

```ts
function mockBlocker(status: 'pass' | 'warn' | 'fail'): BlockerDiagnosis {
  if (status === 'pass') return { status: 'pass', cause: 'pass', message: 'Ready', remediation: '' };
  if (status === 'warn')
    return {
      status: 'warn',
      cause: 'pass',
      message: 'Analyzer ready — no backup analyzer configured.',
      remediation: '',
    };
  return { status: 'fail', cause: 'venv-missing', message: 'Not set up', remediation: 'Set it up.' };
}
```

In `mockGetSetupReadiness`, add a `warn` scenario keyed off a hash flag (so e2e/unit can exercise it) — insert before the final `ready: true` return:

```ts
if (window.location.hash.includes('setup=nobackup')) {
  return {
    ready: true,
    completedAt: '2026-06-12T00:00:00.000Z',
    blockers: {
      sidecar: mockBlocker('pass'),
      ffmpeg: mockBlocker('pass'),
      tts: mockBlocker('pass'),
      analyzer: mockBlocker('warn'),
    },
    info: { gpu: 'cuda · 1.2 / 8.0 GB reserved' },
  };
}
```

- [ ] **Step 4: Handle `warn` in `DiagnosisBlock`** (`src/components/status-popover.tsx`):

```tsx
function DiagnosisBlock({ diagnosis, onDone }: { diagnosis: BlockerDiagnosis; onDone: () => void }) {
  if (diagnosis.status === 'pass') return null;
  if (diagnosis.status === 'warn') {
    return (
      <div className="mt-2">
        <p className="text-sm text-amber-700/80">{diagnosis.message}</p>
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-sm text-ink/70">{diagnosis.message}</p>
      <BlockerFixAction diagnosis={diagnosis} onDone={onDone} />
    </div>
  );
}
```

- [ ] **Step 5: Guard `BlockerFixAction` to `fail` only** (`src/components/blocker-fix-action.tsx`, right after `const action = diagnosis.action;`):

```ts
  const action = diagnosis.action;
  if (diagnosis.status !== 'fail') return null;
  if (!action) return null;
```

(Belt-and-suspenders: `warn` carries no action anyway, but this locks the invariant that a fix button is a `fail`-only affordance.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/components/status-popover.test.tsx`
Expected: PASS.

- [ ] **Step 7: Full frontend suite (shared-component blast radius).**

Run: `npm test`
Expected: PASS — the union widening is additive, so existing `'pass'`/`'fail'` factories in `setup.test.tsx`, `layout.test.tsx`, `use-setup-diagnosis.test.ts`, `prosody-autotrigger.test.tsx`, `status-popover.test.tsx` still compile untouched. Fix any that annotated a *local* `'pass' | 'fail'` type (widen those to include `'warn'`); do NOT edit ones that merely use string literals.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api.ts src/components/status-popover.tsx src/components/blocker-fix-action.tsx src/components/status-popover.test.tsx
git commit -m "feat(frontend): add warn state to BlockerDiagnosis (client render + mock)"
```

---

### Task 2: Server `warn` leg — `diagnoseAnalyzer` + probe-both + relaxed gate

Emit the real `warn` from `/api/setup/readiness`: preserve today's pass/fail gate byte-for-byte, add the backup-label split, probe both engines unconditionally, and relax the boot gate so `warn` is non-blocking.

**Files:**
- Modify: `server/src/routes/setup-readiness.ts:69-76` (type), `:104` (gate), `:194-212` (analyzer wiring)
- Modify: `server/src/routes/setup-diagnosis.ts:43-51` (`diagnosis()` helper), `:216-258` (`diagnoseAnalyzer` + new `anyAnalyzerModelPulled` helper)
- Test: `server/src/routes/setup-diagnosis.test.ts`, `server/src/routes/setup-readiness.test.ts`

**Interfaces:**
- Consumes: `probeOllamaHealth()` → `{ status, models?, expectedModel?, modelPulled?, pullable?, error? }` (`server/src/routes/ollama-health.ts:143`).
- Produces: `anyAnalyzerModelPulled(pulledTags: string[], curated: string[]): boolean`; `AnalyzerDiagnosisInput` gains `anyAnalyzerModelPulled: boolean`.

- [ ] **Step 1: Write the failing matrix test** (`server/src/routes/setup-diagnosis.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { diagnoseAnalyzer, anyAnalyzerModelPulled } from './setup-diagnosis.js';

const base = { expectedModel: 'qwen3.5:4b', pullable: ['qwen3.5:4b', 'llama3.1:8b'], ollamaError: null };

describe('diagnoseAnalyzer tri-state', () => {
  // engine = gemini
  it('gemini, no key → fail', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'gemini', geminiKeySet: false, ollamaReachable: false, modelPulled: false, anyAnalyzerModelPulled: false }).status).toBe('fail');
  });
  it('gemini, key only (no local model) → warn', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'gemini', geminiKeySet: true, ollamaReachable: true, modelPulled: false, anyAnalyzerModelPulled: false }).status).toBe('warn');
  });
  it('gemini, key + local analyzer model → pass', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'gemini', geminiKeySet: true, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: true }).status).toBe('pass');
  });
  // engine = local
  it('local, resolved model not pulled → fail', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: false, ollamaReachable: true, modelPulled: false, anyAnalyzerModelPulled: false }).status).toBe('fail');
  });
  it('local, resolved model pulled, no key → warn', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: false, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: true }).status).toBe('warn');
  });
  it('local, resolved model pulled + key → pass', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: true, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: true }).status).toBe('pass');
  });

  // Regression guards — the gate is NEVER more lenient than today.
  it('gemini + no key + Ollama model pulled → still fail (no gemini→local fallback)', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'gemini', geminiKeySet: false, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: true }).status).toBe('fail');
  });
  it('local + resolved model NOT pulled + key set → still fail (fallback is unreachable-only)', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: true, ollamaReachable: true, modelPulled: false, anyAnalyzerModelPulled: false }).status).toBe('fail');
  });
  it('local + daemon unreachable → fail with ollama-install action', () => {
    const d = diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: false, ollamaReachable: false, modelPulled: false, anyAnalyzerModelPulled: false });
    expect(d.status).toBe('fail');
    expect(d.action?.kind).toBe('ollama-install');
  });
  // Deviation-fix guard: local custom-model primary + key → green (a running local counts).
  it('local, resolved (custom) model pulled but not curated, key set → pass', () => {
    expect(diagnoseAnalyzer({ ...base, engine: 'local', geminiKeySet: true, ollamaReachable: true, modelPulled: true, anyAnalyzerModelPulled: false }).status).toBe('pass');
  });
});

describe('anyAnalyzerModelPulled', () => {
  const curated = ['qwen3.5:4b', 'llama3.1:8b'];
  it('true for a curated tag (canonicalised)', () => {
    expect(anyAnalyzerModelPulled(['qwen3.5:4b-instruct-q4_K_M'], curated)).toBe(true);
  });
  it('false for an embedding-only install', () => {
    expect(anyAnalyzerModelPulled(['nomic-embed-text:latest'], curated)).toBe(false);
  });
  it('false for an empty tag list', () => {
    expect(anyAnalyzerModelPulled([], curated)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test -- src/routes/setup-diagnosis.test.ts`
Expected: FAIL — `anyAnalyzerModelPulled` is not exported; `diagnoseAnalyzer` has no `warn` branch and rejects the new input field.

- [ ] **Step 3: Add the `anyAnalyzerModelPulled` helper** (`server/src/routes/setup-diagnosis.ts`, near the other pure functions):

```ts
/** True when at least one pulled tag prefix-matches a curated analyzer model
    from the pull allowlist — mirrors ollama-health.ts's tag-canonicalisation
    (bare ⇄ family-root / `-suffix`). Excludes non-analyzer installs (e.g. an
    embedding-only `nomic-embed-text`, absent from the allowlist). Backup label
    ONLY — never the gate. */
export function anyAnalyzerModelPulled(pulledTags: string[], curated: string[]): boolean {
  return pulledTags.some((tag) => {
    const tagRoot = tag.split(':')[0];
    return curated.some((m) => {
      const root = m.split(':')[0];
      return tag === m || tag.startsWith(`${m}-`) || (tagRoot === root && tag.startsWith(`${root}:`));
    });
  });
}
```

- [ ] **Step 4: Widen `diagnosis()` and rewrite `diagnoseAnalyzer`** (`server/src/routes/setup-diagnosis.ts`).

Widen the helper signature (`:43`):

```ts
function diagnosis(
  status: 'pass' | 'warn' | 'fail',
  cause: BlockerCause,
  message: string,
  remediation: string,
  action?: BlockerDiagnosis['action'],
): BlockerDiagnosis {
  return { status, cause, message, remediation, action };
}
```

Add `anyAnalyzerModelPulled` to the input type and rewrite the function (keep the three `fail` branches byte-identical; add the backup split):

```ts
export interface AnalyzerDiagnosisInput {
  engine: 'local' | 'gemini';
  ollamaReachable: boolean;
  ollamaError: string | null;
  /** Resolved analyzer model pulled — today's gate signal (model-specific). */
  modelPulled: boolean;
  /** Any analyzer-capable model pulled — backup label only. */
  anyAnalyzerModelPulled: boolean;
  expectedModel: string;
  pullable: string[];
  geminiKeySet: boolean;
}

export function diagnoseAnalyzer(input: AnalyzerDiagnosisInput): BlockerDiagnosis {
  // ── Gate: byte-identical to today's pass/fail (fallback NOT modeled) ──
  if (input.engine === 'gemini') {
    if (!input.geminiKeySet) {
      return diagnosis(
        'fail', 'no-gemini-key',
        'No Gemini API key is configured.',
        'Enter a Gemini API key in Advanced Settings.',
        { kind: 'navigate', label: 'Open Advanced Settings', href: '#/advanced' },
      );
    }
  } else {
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
  }

  // ── activeUsable === true. Backup label splits green vs yellow (never gates). ──
  const geminiBackup = input.geminiKeySet;
  const localBackup = input.ollamaReachable && (input.anyAnalyzerModelPulled || input.modelPulled);
  if (geminiBackup && localBackup) {
    return diagnosis('pass', 'pass', 'Analyzer ready.', '');
  }
  return diagnosis('warn', 'pass', 'Analyzer ready — no backup analyzer configured.', '');
}
```

- [ ] **Step 4b: Update the EXISTING `diagnoseAnalyzer` test fixture** (`server/src/routes/setup-diagnosis.test.ts:214-222`).

The current `ANALYZER_LOCAL_READY` predates the new input field AND the backup split, so leaving it untouched breaks the suite on BOTH axes: (a) it lacks the now-**required** `anyAnalyzerModelPulled` → TS2741 compile error across all six spread cases; (b) with `geminiKeySet: false`, the two `→ pass` assertions (`:225` local, `:248` gemini-with-key) now compute **`warn`**, because a reachable+pulled local analyzer with no second engine has no backup. Fix the fixture so it represents a fully-provisioned (green) box — add `anyAnalyzerModelPulled: true` and flip `geminiKeySet` to `true`:

```ts
const ANALYZER_LOCAL_READY: AnalyzerDiagnosisInput = {
  engine: 'local',
  ollamaReachable: true,
  ollamaError: null,
  modelPulled: true,
  anyAnalyzerModelPulled: true,
  expectedModel: 'qwen3.5:9b',
  pullable: ['qwen3.5:9b'],
  geminiKeySet: true,
};
```

All six existing cases stay green under this base: the four `fail` cases each override only the field that trips their branch (the gate is engine-aware, so the added Gemini key never rescues a local fail — `:228` unreachable and `:233`/`:238` model-not-pulled still fail), and both `pass` cases (`:225`, `:248`) now have a real backup so they stay `pass`. The **local-only `warn`** semantics are pinned by the NEW matrix in Step 1 — do NOT mutate the existing assertions to `warn`.

- [ ] **Step 5: Run the diagnosis test to verify it passes**

Run: `cd server && npm test -- src/routes/setup-diagnosis.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the readiness-route test** (`server/src/routes/setup-readiness.test.ts` — extend, matching the file's existing `buildSetupReadiness` test style):

```ts
import { buildSetupReadiness } from './setup-readiness.js';

const pass = { status: 'pass' as const, cause: 'pass' as const, message: '', remediation: '' };
const warn = { status: 'warn' as const, cause: 'pass' as const, message: 'no backup', remediation: '' };
const fail = { status: 'fail' as const, cause: 'no-gemini-key' as const, message: 'x', remediation: 'y' };

it('ready=true when the only non-pass blocker is analyzer warn', () => {
  const r = buildSetupReadiness({ sidecar: pass, ffmpeg: pass, tts: pass, analyzer: warn, gpu: '' });
  expect(r.ready).toBe(true);
});
it('ready=false on analyzer fail', () => {
  const r = buildSetupReadiness({ sidecar: pass, ffmpeg: pass, tts: pass, analyzer: fail, gpu: '' });
  expect(r.ready).toBe(false);
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd server && npm test -- src/routes/setup-readiness.test.ts`
Expected: FAIL — the `warn` case reports `ready: false` (gate still `every(status === 'pass')`).

- [ ] **Step 8: Widen the server type + relax the gate + probe both engines** (`server/src/routes/setup-readiness.ts`).

Widen the type (`:69`):

```ts
export interface BlockerDiagnosis {
  status: 'pass' | 'warn' | 'fail';
  cause: BlockerCause;
  message: string;
  remediation: string;
  action?: BlockerAction;
}
```

Relax the gate (`:104`):

```ts
    ready: Object.values(blockers).every((b) => b.status === 'pass' || b.status === 'warn'),
```

Replace the analyzer wiring block (`:194-212`) — probe both unconditionally, import `anyAnalyzerModelPulled`:

```ts
  const engine = getResolvedAnalysisEngine();
  const geminiKeySet = getResolvedGeminiApiKey() != null;
  /* Probe Ollama even when engine==='gemini' — the backup label needs the
     local-availability facts regardless of the active engine. Bounded by the
     2s probe budget in probeOllamaHealth(). */
  const ollama = await probeOllamaHealth();
  const analyzer = diagnoseAnalyzer({
    engine,
    ollamaReachable: ollama.status === 'reachable',
    ollamaError: ollama.error ?? null,
    modelPulled: ollama.modelPulled ?? false,
    anyAnalyzerModelPulled: anyAnalyzerModelPulled(ollama.models ?? [], ollama.pullable ?? []),
    expectedModel: ollama.expectedModel ?? getResolvedOllamaModel(),
    pullable: ollama.pullable ?? [],
    geminiKeySet,
  });
```

Add `anyAnalyzerModelPulled` to the existing import from `./setup-diagnosis.js` (`:30-32`).

- [ ] **Step 9: Run the readiness test + full server routes suite.**

Run: `cd server && npm test -- src/routes/setup-readiness.test.ts && npm run test:server`
Expected: PASS. (No existing test asserts the gemini path skips the Ollama probe — the readiness tests target the pure `buildSetupReadiness`/`diagnose*` functions, not the route's I/O — so nothing needs updating there.)

> **Cost note (accepted):** today the gemini-engine `/readiness` makes zero Ollama probe (`setup-readiness.ts:196-200` synthesizes `reachable:true`); this change makes `probeOllamaHealth()` unconditional so the backup label is available regardless of engine. For the common "no local Ollama" gemini user the two localhost fetches fast-fail (ECONNREFUSED, sub-ms); worst case is the 2s `PROBE_TIMEOUT_MS` when a daemon is up-but-wedged. The readiness poll is 10s-cadence, so this is tolerable for v1. (A future optimization could gate the probe on a cheap `installBootstrap.detect()` — deferred, not needed now.)

- [ ] **Step 10: Commit**

```bash
git add server/src/routes/setup-diagnosis.ts server/src/routes/setup-readiness.ts server/src/routes/setup-diagnosis.test.ts server/src/routes/setup-readiness.test.ts
git commit -m "feat(server): analyzer warn state (no-backup) + engine-aware gate preserved"
```

---

### Task 3: Split `Models` → `Analysis` + `Voice` steps (+ summary reorder, tri-state badge)

Replace the combined step with a local-first **Analysis** step (closing the Ollama dead-end via `ModelPullStatus`) and a verbatim **Voice** step; reorder the wizard and summary board (Analysis before Voice); render the tri-state badge/dot.

**Files:**
- Create: `src/components/setup/step-analysis.tsx`, `src/components/setup/step-analysis.test.tsx`
- Create: `src/components/setup/step-voice.tsx`, `src/components/setup/step-voice.test.tsx`
- Delete: `src/components/setup/step-models.tsx`, `src/components/setup/step-models.test.tsx`
- Modify: `src/components/setup/setup-wizard.tsx` (`StepId`, `STEPS`, `renderStep`, `buildSummaryRows`, `SummaryStatus`, progress dot color)
- Test: `src/components/setup/setup-wizard.test.tsx`

**Interfaces:**
- Consumes: `BlockerDiagnosis.status: 'pass' | 'warn' | 'fail'` (Task 1); `ModelPullStatus({ health, pullableModels, onPulled })` (`src/components/model-pull-status.tsx:65`); `OllamaInstall({ onInstalled })`; `GeminiKeyField`; `api.getOllamaHealth()`; `fetchAnalyzerModels()` (`src/store/account-slice.ts:74`) → `account.pullableModels` + `account.localAnalyzerModels`.
- Produces: `StepAnalysis({ readiness, onRefetch })`, `StepVoice({ readiness, onRefetch })`.

- [ ] **Step 1: Write the failing Analysis-step test** (`src/components/setup/step-analysis.test.tsx`):

```tsx
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { StepAnalysis } from './step-analysis';
// Reuse the store-building helper the other setup step tests use if one exists;
// otherwise build a minimal store with the account slice.

const readiness = {
  ready: true,
  completedAt: null,
  blockers: {
    sidecar: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    ffmpeg: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    tts: { status: 'pass', cause: 'pass', message: '', remediation: '' },
    analyzer: { status: 'warn', cause: 'pass', message: 'Analyzer ready — no backup analyzer configured.', remediation: '' },
  },
  info: { gpu: '' },
} as const;

it('renders Local-via-Ollama first, then Online-via-Gemini, with the tri-state badge', () => {
  // (mock api.getOllamaHealth to resolve reachable with models: [] and a pullable list;
  //  mock global fetch for the leaf controls' raw calls)
  render(
    <Provider store={/* store with account slice */}>
      <StepAnalysis readiness={readiness} onRefetch={() => {}} />
    </Provider>,
  );
  // Ollama section (dead-end closed): the pull-status list is present.
  expect(screen.getByTestId('model-pull-status')).toBeInTheDocument();
  // Gemini card present.
  expect(screen.getByText(/gemini/i)).toBeInTheDocument();
  // Tri-state badge shows the warn (yellow) label, message-only, no fix button.
  expect(screen.getByText(/no backup analyzer configured/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /open advanced settings/i })).toBeNull();
  // Local section comes before the Gemini section in DOM order.
  const local = screen.getByText(/local via ollama/i);
  const gemini = screen.getByText(/online via gemini/i);
  expect(local.compareDocumentPosition(gemini) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/components/setup/step-analysis.test.tsx`
Expected: FAIL — `step-analysis.tsx` does not exist.

- [ ] **Step 3: Create `src/components/setup/step-analysis.tsx`.**

```tsx
/* Setup wizard — Step: Analysis (local-first).
   Two distinct cards: ① Local via Ollama (OllamaInstall + ModelPullStatus,
   closing the pull dead-end) and ② Online via Gemini (GeminiKeyField).
   Provision-only: the ACTIVE analyzer is chosen later in the Defaults step. */

import { useEffect, useState } from 'react';
import { OllamaInstall } from '../ollama-install';
import { ModelPullStatus, type OllamaHealthEnvelope } from '../model-pull-status';
import { GeminiKeyField } from '../account-forms';
import { useAppDispatch, useAppSelector } from '../../store';
import { saveGeminiApiKey, fetchAnalyzerModels } from '../../store/account-slice';
import { MODEL_OPTIONS } from '../../lib/models';
import { api } from '../../lib/api';
import type { SetupReadiness, BlockerDiagnosis } from '../../lib/api';

/* Known local analyzer-model family roots (qwen3.5, llama3.1, …) from the
   curated catalog. Used to gate the bridge line so an embedding-only install
   (e.g. nomic-embed-text) does NOT read as "analyzer available" — mirrors the
   server's anyAnalyzerModelPulled exclusion. */
const LOCAL_ANALYZER_ROOTS = new Set(
  MODEL_OPTIONS.filter((m) => m.engine === 'local').map((m) => m.id.split(':')[0]),
);

function AnalyzerBadge({ diagnosis }: { diagnosis: BlockerDiagnosis }) {
  const tone =
    diagnosis.status === 'pass'
      ? { dot: 'bg-emerald-600', chip: 'bg-emerald-100 text-emerald-800', label: 'Analyzer ready' }
      : diagnosis.status === 'warn'
        ? { dot: 'bg-amber-500', chip: 'bg-amber-100 text-amber-800', label: 'Analyzer ready — no backup' }
        : { dot: 'bg-rose-600', chip: 'bg-rose-100 text-rose-800', label: 'Analyzer needed' };
  return (
    <div className="space-y-1.5">
      <span
        data-blocker-status={diagnosis.status}
        className={['inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold', tone.chip].join(' ')}
      >
        <span className={['w-1.5 h-1.5 rounded-full', tone.dot].join(' ')} />
        {tone.label}
      </span>
      {/* Message-only: the two cards below ARE the remedies; no fix action here. */}
      {diagnosis.status !== 'pass' && <p className="text-xs text-ink/60">{diagnosis.message}</p>}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold text-ink">{children}</h2>;
}

export function StepAnalysis({ readiness, onRefetch }: { readiness: SetupReadiness; onRefetch: () => void }) {
  const dispatch = useAppDispatch();
  const account = useAppSelector((s) => s.account);
  const [health, setHealth] = useState<OllamaHealthEnvelope | null>(null);

  useEffect(() => {
    void dispatch(fetchAnalyzerModels());
    void api.getOllamaHealth().then(setHealth).catch(() => {});
  }, [dispatch]);

  const handleGeminiSave = async (key: string | null) => {
    await dispatch(saveGeminiApiKey(key));
    onRefetch();
  };

  const handlePulled = () => {
    onRefetch();
    void dispatch(fetchAnalyzerModels());
  };

  // A pulled ANALYZER-CAPABLE local model → show the bridge line to Defaults.
  // `localAnalyzerModels` is the raw /api/tags list (embeddings included), so
  // filter to a curated analyzer family or a pull-allowlist match — never bare
  // `.length > 0`, which would light for an embedding-only box.
  const hasLocalAnalyzerModel = account.localAnalyzerModels.some((m) => {
    const root = m.name.split(':')[0];
    return LOCAL_ANALYZER_ROOTS.has(root) || account.pullableModels.some((p) => p.split(':')[0] === root);
  });

  return (
    <div className="space-y-8">
      <div className="flex items-start gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold text-ink">Analysis</h1>
        <AnalyzerBadge diagnosis={readiness.blockers.analyzer} />
      </div>

      <p className="text-sm text-ink/60">
        The analyzer reads your manuscript and detects characters, scenes, and dialogue
        attribution. Castwright is local-first — run it on-device with Ollama, or use the
        free Gemini API. You pick which one runs in the Defaults step.
      </p>

      {/* ① Local via Ollama (primary, first) */}
      <section className="space-y-4">
        <SectionHeading>Local via Ollama</SectionHeading>
        <p className="text-xs text-ink/55">
          Runs the analyzer on your machine — no API key, needs a capable GPU and a one-time
          model download.
        </p>
        <OllamaInstall onInstalled={onRefetch} />
        <ModelPullStatus health={health} pullableModels={account.pullableModels} onPulled={handlePulled} />
        {hasLocalAnalyzerModel && (
          <p data-testid="analysis-local-bridge" className="text-xs text-emerald-700">
            ✓ Local analyzer available — pick it in the Defaults step to use it.
          </p>
        )}
      </section>

      {/* ② Online via Gemini (second) */}
      <section className="space-y-4">
        <SectionHeading>Online via Gemini</SectionHeading>
        <p className="text-xs text-ink/55">
          Uses Google's free Gemini tier — no local GPU required. Just paste an API key.
        </p>
        <div className="rounded-2xl border border-ink/10 bg-white p-4">
          <GeminiKeyField status={account.apiKeyStatus} onSave={handleGeminiSave} />
        </div>
      </section>
    </div>
  );
}
```

> Confirm the `GeminiKeyField` import path/prop shape against `src/components/account-forms` (copied from today's `step-models.tsx:14,149-152`). Confirm `OllamaHealthEnvelope` is exported from `model-pull-status.tsx` (it is, `:33`).

- [ ] **Step 4: Run the Analysis-step test to verify it passes**

Run: `npm test -- src/components/setup/step-analysis.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing Voice-step test** (`src/components/setup/step-voice.test.tsx`):

```tsx
import { render, screen } from '@testing-library/react';
import { StepVoice } from './step-voice';
// same readiness object as above (all-pass is fine)

it('renders the voice-engine controls (runtime + Kokoro + More engines)', () => {
  render(<StepVoice readiness={/* all-pass readiness */} onRefetch={() => {}} />);
  expect(screen.getByText(/voice engines/i)).toBeInTheDocument();
  expect(screen.getByText(/more voice engines/i)).toBeInTheDocument();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- src/components/setup/step-voice.test.tsx`
Expected: FAIL — `step-voice.tsx` does not exist.

- [ ] **Step 7: Create `src/components/setup/step-voice.tsx`** — lift the voice half of `step-models.tsx:83-129` verbatim (the `BlockerBadge` for sidecar/tts, `VenvBootstrap`, `KokoroInstall`, the "More voice engines" `<details>` with `QwenInstall` + `CoquiInstall`).

```tsx
/* Setup wizard — Step: Voice.
   Voice engines share one Python runtime — set it up once, then every engine
   can use it. Lifted verbatim from the former combined Models step. */

import { VenvBootstrap } from '../venv-bootstrap';
import { KokoroInstall } from '../kokoro-install';
import { QwenInstall } from '../qwen-install';
import { CoquiInstall } from '../coqui-install';
import { BlockerFixAction } from '../blocker-fix-action';
import type { SetupReadiness, BlockerDiagnosis } from '../../lib/api';

function BlockerBadge({ diagnosis, label, onRefetch }: { diagnosis: BlockerDiagnosis; label: string; onRefetch: () => void }) {
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

export function StepVoice({ readiness, onRefetch }: { readiness: SetupReadiness; onRefetch: () => void }) {
  return (
    <div className="space-y-8">
      <div className="flex items-start gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold text-ink">Voice</h1>
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

      <p className="text-sm text-ink/60">
        Voice engines turn your manuscript into speech. They all share one Python runtime —
        set it up once, then every voice engine can use it.
      </p>

      <VenvBootstrap onBootstrapped={onRefetch} />
      <KokoroInstall onInstalled={onRefetch} />

      <details className="group rounded-2xl border border-ink/10">
        <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-ink select-none">
          <span>More voice engines</span>
          <span className="text-xs text-ink/50 group-open:hidden">Qwen3-TTS · Coqui XTTS v2</span>
          <span className="text-xs text-ink/50 hidden group-open:inline">Hide</span>
        </summary>
        <div className="px-4 pb-4 space-y-4">
          <p className="text-xs text-ink/55">
            On a GPU box, Qwen3-TTS installs automatically with the Python runtime — fetch its
            model weights here to enable bespoke per-character voice design. Coqui XTTS v2 is an
            optional add-on for zero-shot voice cloning.
          </p>
          <QwenInstall onInstalled={onRefetch} />
          <CoquiInstall onInstalled={onRefetch} />
        </div>
      </details>
    </div>
  );
}
```

- [ ] **Step 8: Run the Voice-step test to verify it passes**

Run: `npm test -- src/components/setup/step-voice.test.tsx`
Expected: PASS.

- [ ] **Step 9: Rewire `setup-wizard.tsx`.**

Replace the `step-models` import (`:26`) with the two new steps:

```ts
import { StepAnalysis } from './step-analysis';
import { StepVoice } from './step-voice';
```

`StepId` (`:31`) + `STEPS` (`:33-40`):

```ts
type StepId = 'environment' | 'ffmpeg' | 'analysis' | 'voice' | 'defaults' | 'lanCert' | 'finish';

const STEPS: { id: StepId; title: string }[] = [
  { id: 'environment', title: 'Environment' },
  { id: 'ffmpeg', title: 'ffmpeg' },
  { id: 'analysis', title: 'Analysis' },
  { id: 'voice', title: 'Voice' },
  { id: 'defaults', title: 'Defaults' },
  { id: 'lanCert', title: 'LAN access' },
  { id: 'finish', title: 'Finish' },
];
```

`renderStep` (`:58-72`) — replace the `models` case:

```ts
    case 'analysis':
      return <StepAnalysis readiness={readiness} onRefetch={onRefetch} />;
    case 'voice':
      return <StepVoice readiness={readiness} onRefetch={onRefetch} />;
```

`buildSummaryRows` (`:246-296`) — reorder so Analyzer precedes Voice, and remap `stepIndex`; add `warn` to `SummaryStatus` and map the analyzer row through it. Replace the return array's `voice`/`analyzer`/`defaults`/`lanCert` rows:

```ts
type SummaryStatus = 'ok' | 'warn' | 'attention';
```

```ts
  const analyzerStatus: SummaryStatus =
    blockers.analyzer.status === 'pass' ? 'ok' : blockers.analyzer.status === 'warn' ? 'warn' : 'attention';
  return [
    { key: 'environment', label: 'Environment', detail: info.gpu, status: 'ok', stepIndex: 0 },
    {
      key: 'ffmpeg',
      label: 'Audio assembly',
      detail: blockers.ffmpeg.status === 'pass' ? 'ffmpeg installed' : blockers.ffmpeg.message,
      status: blockers.ffmpeg.status === 'pass' ? 'ok' : 'attention',
      stepIndex: 1,
    },
    {
      key: 'analyzer',
      label: 'Analyzer',
      detail: blockers.analyzer.status === 'pass' ? 'Ready' : blockers.analyzer.message,
      status: analyzerStatus,
      stepIndex: 2,
    },
    {
      key: 'voice',
      label: 'Voice engines',
      detail: voiceDetail,
      status: voiceOk ? 'ok' : 'attention',
      stepIndex: 3,
    },
    { key: 'defaults', label: 'Defaults', detail: 'New-book starting points', status: 'ok', stepIndex: 4 },
    { key: 'lanCert', label: 'LAN access', detail: 'Phone/tablet HTTPS certificate', status: 'ok', stepIndex: 5 },
  ];
```

In `SetupSummary`, the `attention` filter must ignore `warn` (non-blocking). It already filters `r.status === 'attention'`, so `warn` is naturally excluded from the "N items need attention" tally and the "Fix setup" button — no change needed. Add a `warn` dot color in the row render (`:346-352`):

```tsx
            className={[
              'inline-block w-2.5 h-2.5 rounded-full shrink-0',
              r.status === 'ok' ? 'bg-emerald-500' : r.status === 'warn' ? 'bg-amber-400' : 'bg-amber-500',
            ].join(' ')}
            aria-label={
              r.status === 'ok'
                ? `${r.label}: ready`
                : r.status === 'warn'
                  ? `${r.label}: ready, no backup`
                  : `${r.label}: needs attention`
            }
```

- [ ] **Step 10: Delete the old step.**

```bash
git rm src/components/setup/step-models.tsx src/components/setup/step-models.test.tsx
```

- [ ] **Step 11: Update `setup-wizard.test.tsx`** — assert 7 steps, "Step N of 7", and the summary order (Analyzer row before Voice row) + the yellow `warn` dot. Add/adjust:

```tsx
it('has 7 steps with Analysis before Voice', () => {
  // render guided wizard; expect "Step 1 of 7"
  expect(screen.getByText(/step 1 of 7/i)).toBeInTheDocument();
});

it('summary board renders the Analyzer row before Voice, with a yellow dot on warn', () => {
  // render re-entry summary with a warn analyzer readiness
  const analyzerRow = screen.getByTestId('setup-summary-row-analyzer');
  const voiceRow = screen.getByTestId('setup-summary-row-voice');
  expect(analyzerRow.compareDocumentPosition(voiceRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(analyzerRow).toHaveAttribute('data-status', 'warn');
});
```

Update any existing `setup-wizard.test.tsx` assertions that hard-code "of 6" or the old row order.

- [ ] **Step 12: Run the full frontend suite.**

Run: `npm test`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/components/setup/ && git commit -m "feat(frontend): split setup Models step into Analysis (local-first) + Voice"
```

---

### Task 4: Defaults step — auto-derive `analysisEngine` from the picked model

Make the Defaults dropdown actually switch the engine, so generation routes to the chosen analyzer.

**Files:**
- Modify: `src/components/setup/step-defaults.tsx:93-96`
- Test: `src/components/setup/step-defaults.test.tsx`

**Interfaces:**
- Consumes: `saveAccountSettings({ defaultAnalysisModel, analysisEngine })` (`src/store/account-slice.ts:53`).

- [ ] **Step 1: Write the failing test** (`src/components/setup/step-defaults.test.tsx`):

```tsx
it('picking a local (":") tag saves analysisEngine=local', async () => {
  // render StepDefaults with a spy/mock on saveAccountSettings (or assert the
  // dispatched action payload via a mock store), select a "qwen3.5:4b" option
  // change event, and assert the saved patch:
  expect(savedPatch).toEqual({ defaultAnalysisModel: 'qwen3.5:4b', analysisEngine: 'local' });
});

it('picking a Gemini id saves analysisEngine=gemini', async () => {
  expect(savedPatch).toEqual({ defaultAnalysisModel: 'gemini-3.1-flash-lite', analysisEngine: 'gemini' });
});
```

> Match the file's existing dispatch-assertion pattern (mock store vs. spied `saveAccountSettings`). The two payloads above are the contract.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/components/setup/step-defaults.test.tsx`
Expected: FAIL — the handler saves `defaultAnalysisModel` only.

- [ ] **Step 3: Update the handler** (`src/components/setup/step-defaults.tsx:93-96`):

```ts
  const handleAnalysisModelChange = (next: string) => {
    setAnalysisModel(next);
    // Auto-derive the engine from the id shape (":"→local, else gemini) — matches
    // getResolvedOllamaModel's heuristic. This is what routes generation.
    const engine = next.includes(':') ? 'local' : 'gemini';
    void dispatch(saveAccountSettings({ defaultAnalysisModel: next, analysisEngine: engine }));
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/setup/step-defaults.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/setup/step-defaults.tsx src/components/setup/step-defaults.test.tsx
git commit -m "feat(frontend): Defaults analysis-model pick auto-derives analysisEngine"
```

---

### Task 5: e2e — 7-step wizard order + Ollama pull path

Update the Playwright spec for the new step count/order and cover the closed Ollama loop.

**Files:**
- Modify: `e2e/setup-wizard.spec.ts`

- [ ] **Step 1: Update the step-count/order assertions.** Replace every `of 6` with `of 7`; the "advance through steps" loops go from ×5 to ×6 (Next disappears on step 7); the re-entry test's `setup-summary-row-ffmpeg` still drills to `step 2 of 7`. In the header comment, change "Step N of 6" → "Step N of 7". Concretely:
  - Test 1: `page.getByText(/step 1 of 7/i)`.
  - Test 2: `/step 2 of 7/i`.
  - Test 3 & 4 (reach last step): loop `for (let i = 0; i < 6; i++)`, then assert `/step 7 of 7/i`.
  - Re-entry test: assert `/step 1 of 7/i` has count 0; after clicking the ffmpeg row assert `/step 2 of 7/i`.

- [ ] **Step 2: Add an Analysis-step test** covering the closed Ollama loop.

**Mock-mode reality (important):** under `VITE_USE_MOCKS`, `api.getOllamaHealth` resolves to the in-app JS mock (`api.ts:7565`), which returns `status:'reachable'` with curated models **already pulled** (`['qwen3.5:4b','llama3.1:8b']`) and the full `pullable` list. So a `page.route('**/api/ollama/health', …)` would NOT intercept it (no network call is made) — do not route it. `ModelPullStatus` renders its list from that mock health prop, and `localAnalyzerModels` populates with the curated tags → the bridge line shows without simulating a pull. `OllamaInstall` DOES use a raw `fetch('/api/ollama/detect')` on mount, so stub only that (mirror the network-mock idiom in `setup-checker-venv-fix.spec.ts`):

```ts
test('Analysis step (step 3) exposes the Ollama pull list, Gemini card, and bridge line', async ({ page }) => {
  await page.route('**/api/ollama/detect', (r) => r.fulfill({ json: { installed: true, version: '0.1.0' } }));
  await page.goto('/#/?setup=notready');
  const next = page.getByRole('button', { name: /^next$/i });
  await next.click(); // → ffmpeg (step 2)
  await next.click(); // → analysis (step 3)
  await expect(page.getByText(/step 3 of 7/i)).toBeVisible();
  await expect(page.getByText(/local via ollama/i)).toBeVisible();
  await expect(page.getByTestId('model-pull-status')).toBeVisible();
  await expect(page.getByText(/online via gemini/i)).toBeVisible();
  // In-app mock reports curated analyzer models already pulled → bridge line shows.
  await expect(page.getByTestId('analysis-local-bridge')).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e spec.**

Run: `npm run test:e2e -- setup-wizard`
Expected: PASS. (Requires `npx playwright install chromium` once.)

- [ ] **Step 4: Commit**

```bash
git add e2e/setup-wizard.spec.ts
git commit -m "test(e2e): 7-step wizard order + Ollama pull path"
```

---

## Ship chores (Before-shipping checklist — do at PR time, not as code tasks)

- **Regression plan:** create `docs/features/<n>-fe49-analyzer-wizard-split.md` from `TEMPLATE.md` (frontmatter `status: active`), documenting the tri-state gate invariant + the two regression guards; add its `docs/features/INDEX.md` entry.
- **Release notes (both):** append a technical entry to `docs/release-notes-next.md` (PR-refed) AND a brand-voice user line to the in-progress version at the top of `RELEASE_NOTES.md`.
- **Admin follow-up (spec §7):** file a Backlog-item issue — "Mirror fe-49 analyzer/voice split + tri-state badge in `model-settings-form.tsx`/`model-manager.tsx`" (labels `area:fe`, `type:chore`, `moscow:should`) — and add the thin `docs/BACKLOG.md` row linking it.
- **PR:** title `feat(frontend): split setup analyzer/voice steps + primary-backup analyzer signal`; body `Closes #1610`; link the regression plan. Run `npm run verify:fast:branch` locally; cloud `verify.yml` + the mandatory `code-review` pass gate the merge.

## Self-review

- **Spec coverage:** Goals §1 wizard split → Task 3; §2 analysis step two-card local-first + closed dead-end + bridge line → Task 3; §4 Defaults engine derive → Task 4; §5 tri-state + probe-both + gate → Tasks 1–2; §6 pull allowlist → verified (no code change, `qwen3.5:4b` ∈ `DEFAULT_ALLOWED_MODELS`); §7 admin → ship-chore follow-up; testing § 7-step/matrix/regression-guards/mock-parity/e2e → Tasks 1–5. All acceptance-criteria bullets map to a task.
- **Placeholder scan:** none — every code step shows the code; the "match existing harness" notes point at a concrete existing file/helper to copy, not a TODO.
- **Type consistency:** `BlockerDiagnosis.status: 'pass' | 'warn' | 'fail'` widened in both hand-written locations (Tasks 1, 2); `AnalyzerDiagnosisInput.anyAnalyzerModelPulled` produced in Task 2, consumed by the route (Step 8) and both the new matrix (Step 1) and the existing fixture (Step 4b); `SummaryStatus: 'ok' | 'warn' | 'attention'` defined and used only in `setup-wizard.tsx` (Task 3); `StepAnalysis`/`StepVoice` props `{ readiness, onRefetch }` match `renderStep`'s call sites.
- **Existing-test impact (from plan review):** the only existing suite that breaks is `setup-diagnosis.test.ts` (required-field + `pass`→`warn`), handled in Task 2 Step 4b; the client `status-popover.test.tsx` `warn` test reuses that file's `makeProps`/`readinessWith` helpers so it fails for the right reason; the e2e uses the in-app Ollama mock (no dead `page.route`). No exhaustive `switch(status)` on a diagnosis exists anywhere, so the union widening breaks no client consumer.
- **Deviation flagged:** `localBackup` strengthened with `|| modelPulled` vs the spec's formula (green-vs-yellow only) — documented above with a dedicated guard test in Task 2.
