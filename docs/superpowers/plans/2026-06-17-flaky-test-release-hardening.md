# Flaky-test release hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop timing/contention-flaky tests from ever blocking a release tag, by adding a non-gating quarantine lane (structural guarantee) and then deterministically rewriting the flaky tests so they genuinely test behavior with zero real-timer/I/O dependence.

**Architecture:** Three layers. (1) A `quarantinedIt` helper + Playwright `@quarantine` tag route identified flakes into a non-gating lane that physically cannot block `publish`. (2) The flaky server/e2e tests are rewritten to await deterministic events (not wall-clock polls) with real disk I/O mocked out, then graduated back onto the gate. (3) An ESLint guardrail at pre-push/CI blocks the anti-patterns from returning. Delivered in 6 sequential waves; Wave 0 produces the evidence that scopes the data-dependent waves.

**Tech Stack:** Vitest 4 (`pool: 'forks'`, `globals: true`), Playwright (chromium), ESLint 9 flat config (`no-restricted-syntax`), Node 24, `cross-env`, husky hooks, GitHub Actions.

## Global Constraints

- **No production *behavior* changes.** Only behavior-neutral test-seam DI is permitted, and only when the default runtime path is byte-for-byte unchanged and covered by existing tests. Prefer test-only `vi.mock` over production edits. (Spec: Non-goals.)
- **No auto-retry as a gating mechanism.** At most `--retry=1` inside the non-gating lane.
- **`RUN_QUARANTINE` is a real process-env var** (inherited by vitest forks), never a vitest `env:` config key. Set it cross-platform with `cross-env` (the `VAR=val cmd` Bash form fails on the Windows dev box).
- **The quarantine lane must never be in `publish`'s `needs:`** and must be `continue-on-error: true`.
- **Acceptance bar for any rewritten Class-A1 test:** zero awaits on real disk/network in the assertion path; completes in a small bounded microtask-drain time. Worker-count/busy-loop invariance is a *secondary* signal only.
- **The guardrail lands LAST (Wave 5), after every migration** — `lint --max-warnings 0` hard-fails on any un-migrated straggler.
- Every wave is its own branch + PR, independently `npm run verify`-green. All work stays in the `flaky-release-hardening` worktree; nothing on `main` until the user confirms v1.8.0 shipped.
- Commit subjects follow `<type>(<scope>): <subject>`; allowed scopes include `server`, `e2e`, `scripts`, `ci`, `docs`. End commit bodies with the `Co-Authored-By` trailer.

---

## File Structure

**Created:**
- `server/src/test-utils/quarantine.ts` — server `quarantinedIt`/`quarantinedDescribe` helper.
- `src/test/quarantine.ts` — frontend helper (identical; frontend has no quarantined test yet but the helper + guardrail expect it to exist).
- `docs/testing/flaky-register.md` — the live register of quarantined tests.
- `docs/testing/flake-evidence.md` — Wave 0 output: per-test load-sensitivity + which siblings/slow-files actually flake.
- `scripts/flake-repro.mjs` — load-induction harness (CPU + I/O contention) used to measure load-sensitivity.
- `scripts/tests/eslint-guardrail.test.mjs` — planted-violation test for the W5 ESLint guardrail.
- `server/src/store/analysis-cache.race.test.ts` — same-tick cache-write race regression guard.
- `.github/workflows` quarantine job addition (in `release.yml` only — NOT verify.yml; review C1/P5).

**Modified:**
- `server/src/routes/analysis-pipelining.test.ts` — migrate Case 2 to the helper (W1), then deterministic rewrite of all cases (W2).
- `server/src/routes/analysis.ts` — *only if* the optional coupling extraction (Task 2.7) is taken.
- `package.json` — `test:quarantine`, `test:e2e:quarantine` scripts; `test:e2e` grep-invert regex.
- `eslint.config.js` — `no-restricted-syntax` rule in test-file + `e2e/**` override blocks (W5).
- `CLAUDE.md` — pointer to the register + the lane commands.
- `server/vitest.config.slow.ts`, `scripts/verify-cache.mjs` — stale "5 hot files" comment fix (W3, when touched).

---

# Wave 0 — Reproduce + baseline

**Branch:** `test/flaky-w0-evidence`. Goal: a repro harness + an evidence file that scopes Waves 1/3.

### Task 0.1: Load-induction repro harness

**Files:**
- Create: `scripts/flake-repro.mjs`

**Interfaces:**
- Produces: a CLI `node scripts/flake-repro.mjs --file <relpath> [--runs N] [--cpu-load] [--io-load]` that runs a single vitest file under optional induced load and prints per-run wall-clock ms.

- [ ] **Step 1: Write the harness**

```js
// scripts/flake-repro.mjs — measure a test file's runtime under induced load.
// Usage: node scripts/flake-repro.mjs --file server/src/routes/analysis-pipelining.test.ts --runs 3 --cpu-load --io-load
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const file = get('--file');
const runs = Number(get('--runs', '3'));
if (!file) { console.error('--file <relpath> required'); process.exit(2); }

// Decide config: slow files run via the slow config.
const SLOW = ['analysis-pipelining', 'gemini', 'book-state', 'chapters-restructure',
  'generation', 'generation-boundary-recycle', 'pdf-real', 'setup-readiness.route',
  'kokoro-install.route', 'venv-bootstrap.route'];
const isSlow = SLOW.some((s) => file.includes(s));
const cwd = file.startsWith('server/') ? 'server' : '.';
const rel = file.replace(/^server\//, '');

let cpuBurners = [];
function startCpuLoad() {
  const n = Math.max(1, cpus().length - 1);
  for (let i = 0; i < n; i++) {
    cpuBurners.push(spawn(process.execPath, ['-e', 'while(true){Math.sqrt(Math.random())}'], { stdio: 'ignore' }));
  }
}
function stopCpuLoad() { cpuBurners.forEach((c) => c.kill('SIGKILL')); cpuBurners = []; }

let ioBurner = null, ioDir = null;
function startIoLoad() {
  ioDir = mkdtempSync(join(tmpdir(), 'flake-io-'));
  // Run the I/O load in a SEPARATE child process. A setInterval in THIS process
  // never fires while the blocking spawnSync vitest run holds the event loop
  // (review C3 — verified: 0 ticks during a 300ms spawnSync), so an in-process
  // timer induces ZERO contention during the measured window.
  const burn =
    "const{writeFileSync}=require('fs');const{join}=require('path');" +
    `const d=${JSON.stringify(ioDir)};let n=0;` +
    "setInterval(()=>{try{writeFileSync(join(d,'f'+(n%50)+'.tmp'),'x'.repeat(65536));n++;}catch{}},2);";
  ioBurner = spawn(process.execPath, ['-e', burn], { stdio: 'ignore' });
}
function stopIoLoad() { if (ioBurner) ioBurner.kill('SIGKILL'); if (ioDir) rmSync(ioDir, { recursive: true, force: true }); }

if (has('--cpu-load')) startCpuLoad();
if (has('--io-load')) startIoLoad();

const cmd = isSlow
  ? ['vitest', 'run', '--config', 'vitest.config.slow.ts', rel]
  : ['vitest', 'run', rel];

const results = [];
for (let i = 0; i < runs; i++) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync('npx', cmd, { cwd, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, RUN_QUARANTINE: '1' } }); // RUN_QUARANTINE=1 so quarantined cases run
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.push({ run: i + 1, ms: Math.round(ms), code: r.status });
  console.log(`run ${i + 1}: ${Math.round(ms)}ms exit=${r.status}`);
}
stopCpuLoad(); stopIoLoad();
console.log('SUMMARY', JSON.stringify(results));
```

- [ ] **Step 2: Smoke-run it (no load) against the offender**

Run: `node scripts/flake-repro.mjs --file server/src/routes/analysis-pipelining.test.ts --runs 1`
Expected: it executes the slow config for that file and prints `run 1: <ms>ms exit=0`.

- [ ] **Step 3: Commit**

```bash
git add scripts/flake-repro.mjs
git commit -m "test(scripts): add load-induction flake-repro harness"
```

### Task 0.2: Capture the evidence file

**Files:**
- Create: `docs/testing/flake-evidence.md`

- [ ] **Step 1: Measure the pipelining family under no-load vs induced load**

Run both and record numbers:
```bash
node scripts/flake-repro.mjs --file server/src/routes/analysis-pipelining.test.ts --runs 3
node scripts/flake-repro.mjs --file server/src/routes/analysis-pipelining.test.ts --runs 3 --cpu-load --io-load
```
Note: this runs the *whole file* (all 5 cases + plan-118). To attribute per-case, additionally run with a name filter, e.g. append the case title:
```bash
cd server && npx vitest run --config vitest.config.slow.ts -t "rolling roster" analysis-pipelining.test.ts
```

- [ ] **Step 2: Measure each remaining slow file under induced load** (to scope Wave 3)

For each of the 9 non-pipelining slow files in `server/vitest.config.slow.ts`'s `SLOW_FILES`, run:
```bash
node scripts/flake-repro.mjs --file server/src/routes/book-state.test.ts --runs 3 --cpu-load --io-load
```
Record which exceed their per-test budget or fail under load vs. which stay flat.

- [ ] **Step 3: Write the evidence file**

Record, as a committed artifact, a table the later waves consume:

```markdown
# Flake evidence (Wave 0 baseline) — 2026-06-17

## analysis-pipelining.test.ts (Class A1)
| Case | no-load ms | induced-load ms | flakes on CI today? | quarantine in W1? |
|------|-----------|-----------------|---------------------|-------------------|
| 1 interleaved | … | … | (yes/no from history) | … |
| 2 rolling roster | … | … | already skipIf(CI) | yes (migrate) |
| 3 back-pressure | … | … | … | … |
| 4 sequential | … | … | … | … |
| 5 concurrent | … | … | … | … |
| plan-118 | … | … | … | … |

Decision rule: quarantine in Wave 1 any case whose induced-load runtime exceeds
its per-test budget OR has failed a CI/pre-push run.

## Slow files (Class A2) — Wave 3 scope
| File | induced-load behavior | actually flakes? | rewrite in W3? |
|------|----------------------|------------------|----------------|
| gemini.test.ts | … | … | … |
| book-state.test.ts | … | … | … |
| … (all 9) | … | … | … |

Decision rule: rewrite in Wave 3 ONLY files that actually flake; isolation-only
files that stay flat are left serialized.
```

- [ ] **Step 4: Commit**

```bash
git add docs/testing/flake-evidence.md
git commit -m "test(docs): baseline flake evidence + Wave 1/3 scoping"
```

---

# Wave 1 — Lane + register + quarantine the live siblings

**Branch:** `test/flaky-w1-lane`. Delivers the structural guarantee.

### Task 1.1: The `quarantinedIt` helper

**Files:**
- Create: `server/src/test-utils/quarantine.ts`
- Create: `src/test/quarantine.ts`
- Test: `server/src/test-utils/quarantine.test.ts`

**Interfaces:**
- Produces: `export const quarantinedIt`, `export const quarantinedDescribe`, `export const RUN_QUARANTINE: boolean` from each helper module.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/test-utils/quarantine.test.ts
import { describe, it, expect } from 'vitest';
import { RUN_QUARANTINE } from './quarantine.js';

describe('quarantine helper', () => {
  it('RUN_QUARANTINE reflects the env flag', () => {
    expect(RUN_QUARANTINE).toBe(process.env.RUN_QUARANTINE === '1');
  });
});
```

- [ ] **Step 2: Run it — fails (module missing)**

Run: `cd server && npx vitest run src/test-utils/quarantine.test.ts`
Expected: FAIL — cannot find `./quarantine.js`.

- [ ] **Step 3: Write the helper (both copies identical)**

```ts
// server/src/test-utils/quarantine.ts  (and src/test/quarantine.ts — identical)
// Quarantined tests run ONLY in the explicit lane (RUN_QUARANTINE=1). EVERY
// gating run — local pre-push AND CI — leaves the flag unset → skipped.
// Import this; never add it to setupFiles (it must eval after vitest globals).
import { it, describe } from 'vitest';

export const RUN_QUARANTINE = process.env.RUN_QUARANTINE === '1';
export const quarantinedIt = RUN_QUARANTINE ? it : it.skip;
export const quarantinedDescribe = RUN_QUARANTINE ? describe : describe.skip;
```

- [ ] **Step 4: Run it — passes**

Run: `cd server && npx vitest run src/test-utils/quarantine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/test-utils/quarantine.ts server/src/test-utils/quarantine.test.ts src/test/quarantine.ts
git commit -m "test(server): add quarantinedIt lane helper (frontend + server)"
```

### Task 1.2: Lane + e2e scripts

**Files:**
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the scripts**

In `package.json` `scripts`, add (and change `test:e2e` to OR both exclusions into one regex):

```jsonc
"test:e2e": "playwright test --project=chromium --grep-invert=\"visual baselines|@quarantine\"",
"test:e2e:quarantine": "playwright test --project=chromium --grep=@quarantine --pass-with-no-tests",
"test:quarantine": "cross-env RUN_QUARANTINE=1 npm run test && cross-env RUN_QUARANTINE=1 npm --prefix server run test && cross-env RUN_QUARANTINE=1 npm --prefix server run test:slow"
```

- [ ] **Step 2: Verify the lane runs (and gating still skips)**

Run: `npm run test:quarantine`
Expected: completes; the quarantine helper test passes; no quarantined test errors (none migrated yet).
Run (simulate CI so `skipIf(CI)` engages — locally `CI` is unset so it would RUN and hang ~180s; review m3): `cd server && cross-env CI=1 npx vitest run --config vitest.config.slow.ts analysis-pipelining.test.ts`
Expected: Case 2 shows as skipped (still `skipIf(CI)` at this point — migrated in Task 1.4).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test(e2e): add quarantine lane scripts + single grep-invert regex"
```

### Task 1.3: The register + CLAUDE.md pointer

**Files:**
- Create: `docs/testing/flaky-register.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create the register**

```markdown
# Flaky-test register

Tests quarantined out of the gating suites into the non-gating lane
(`npm run test:quarantine`). A row here is a debt: the test does not gate
releases until it is rewritten deterministically and graduated back.
Empty register = done. See the rewrite playbook in
`docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md`.

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| _(none yet)_ | | | | | |
```

- [ ] **Step 2: Add a CLAUDE.md pointer**

Under the "Testing discipline" section, add one line:

```markdown
- **Flaky tests** route through `quarantinedIt` (`server/src/test-utils/quarantine.ts`) into the non-gating lane (`npm run test:quarantine`); each is logged in `docs/testing/flaky-register.md`. Never add a raw `it.skipIf(process.env.CI)`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/testing/flaky-register.md CLAUDE.md
git commit -m "docs: add flaky-test register + CLAUDE.md pointer"
```

### Task 1.4: Migrate Case 2 onto the helper

**Files:**
- Modify: `server/src/routes/analysis-pipelining.test.ts`
- Modify: `docs/testing/flaky-register.md`

- [ ] **Step 1: Replace the `skipIf` with the helper**

At the top of `analysis-pipelining.test.ts`, add the import:
```ts
import { quarantinedIt } from '../test-utils/quarantine.js';
```
Change the rolling-roster case (currently `it.skipIf(process.env.CI)('Phase 1 chapter K …')`) to:
```ts
// QUARANTINED(#<NN>): CPU+I/O contention timeout — drive-to-completion + real
// CACHE_DIR write. Deterministic rewrite tracked in the register; see Wave 2.
quarantinedIt('Phase 1 chapter K dispatches with a roster snapshot containing only Phase 0 chapters 1..K+LAG', async () => {
```
(Leave the body and the `}, 180_000)` for now — Wave 2 rewrites it.)

- [ ] **Step 2: Confirm gating skips it, lane runs it**

Run (gating): `cd server && npx vitest run --config vitest.config.slow.ts analysis-pipelining.test.ts`
Expected: the rolling-roster case is **skipped**.
Run (lane): `cd server && cross-env RUN_QUARANTINE=1 npx vitest run --config vitest.config.slow.ts analysis-pipelining.test.ts`
Expected: the rolling-roster case **runs** (may be slow locally — that's fine, it's non-gating).

- [ ] **Step 3: Register the row**

Replace the `_(none yet)_` row with:
```markdown
| rolling roster snapshot | server/src/routes/analysis-pipelining.test.ts | A1 | CPU+I/O contention timeout (drive-to-completion + real cache write) | #<NN> | 2026-06-17 |
```
(File the tracking issue first; substitute its number for `<NN>` here and in the code comment.)

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/analysis-pipelining.test.ts docs/testing/flaky-register.md
git commit -m "test(server): migrate rolling-roster case onto quarantinedIt helper"
```

### Task 1.5: Quarantine the flaking siblings (evidence-gated)

**Files:**
- Modify: `server/src/routes/analysis-pipelining.test.ts`
- Modify: `docs/testing/flaky-register.md`

- [ ] **Step 1: Quarantine the whole pipelining family BY SHAPE (review M2/P4)**

All six cases in `analysis-pipelining.test.ts` share the **same** flake shape — drive-to-completion + real `saveAnalysisCache` write (the spec says so explicitly). The Wave 0 *local* timing can't see the macOS-only contention, so do **not** gate on local timing here: wrap **every** remaining case (1, 3, 4, 5, and the plan-118 case) with `quarantinedIt` + a `// QUARANTINED(#NN): …` comment, exactly as Task 1.4 did for Case 2, and add a register row each. This is cheap — Wave 2 rewrites and graduates them all one wave later — and it closes the W1→W2 release-exposure window completely. (Local timing measurement is reserved for Wave 3's *heterogeneous* slow files, where it actually discriminates.)

- [ ] **Step 2: Verify**

Run (gating): `cd server && npx vitest run --config vitest.config.slow.ts analysis-pipelining.test.ts`
Expected: the quarantined cases skip; the still-clean cases run and pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/analysis-pipelining.test.ts docs/testing/flaky-register.md
git commit -m "test(server): quarantine load-sensitive pipelining siblings (evidence-gated)"
```

### Task 1.6: Non-gating CI quarantine job

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/verify.yml`

- [ ] **Step 1: Confirm the setup composite installs server deps (review M4)**

Run: `cat .github/actions/setup/action.yml`
Expected: it runs `npm --prefix server ci` (or equivalent). `verify.yml` relies on it with no explicit server install, so it almost certainly does — but the lane runs `npm --prefix server run test`/`test:slow`, which die at module resolution without server deps. If the composite does NOT install server deps, add an explicit `- run: npm --prefix server ci` step to the job below.

- [ ] **Step 2: Add the release-time non-gating job**

In `release.yml`, add a job NOT referenced by `publish`'s `needs:`:

```yaml
  # Non-gating: runs the quarantine lane for visibility only. continue-on-error
  # so a flaky quarantined test can NEVER block the release. NOT in publish.needs.
  quarantine-lane:
    name: Quarantine lane (non-gating)
    runs-on: ubuntu-latest
    continue-on-error: true
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v6
      - uses: ./.github/actions/setup
      - name: Install ffmpeg
        run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - name: Quarantine lane
        run: npm run test:quarantine
```

- [ ] **Step 3: Verify it is not wired into `publish`**

Inspect `release.yml`: `publish.needs` must remain `[verify, cross-os-verify, mobile-e2e, companion-apk-build]` — `quarantine-lane` absent. (This is the structural guarantee.)

> **No verify.yml lane step (review C1/P5).** Adding `test:quarantine` to verify.yml re-runs the ENTIRE frontend+server+slow battery a second time on every labeled PR (the lane script is the triple-suite, not a quarantined-only subset) — a redundant multi-minute double-run against this repo's CI-cost posture. The release-tag job above already gives release-time visibility; local `npm run test:quarantine` on demand covers the rest.

- [ ] **Step 4: Lane self-test (temporary, prove it executes — then revert)**

Add a throwaway quarantined test that always fails:
```ts
// TEMP — verify the lane runs quarantined tests (delete before commit)
import { quarantinedIt } from '../test-utils/quarantine.js';
quarantinedIt('LANE SELFTEST always fails', () => { expect(true).toBe(false); });
```
Run gating: `cd server && npx vitest run src/routes/analysis-pipelining.test.ts` → selftest **skipped** (gating stays green).
Run lane: `npm run test:quarantine` → selftest appears as **run-and-failed** (proves the lane executes, not skips).
Then **delete** the throwaway test.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add non-gating quarantine lane job (off the publish gate)"
```

### Task 1.7: Wave 1 verify + PR

- [ ] **Step 1:** Run `npm run verify` → green (quarantined tests skip on the gating path).
- [ ] **Step 2:** Open the PR `test/flaky-w1-lane` → `main` (draft until v1.8.0 ships). Body: `Refs #<NN>`.

---

# Wave 2 — Class A1 deterministic rewrite

**Branch:** `test/flaky-w2-pipelining`. Make the pipelining family deterministic and graduate it back onto the gate. The key move is **mock the cache (test-only) + await events instead of polling** — no production change required.

> **Sequencing note (review m4):** Tasks 2.1→2.4 all edit the *same* file (`analysis-pipelining.test.ts`) and build on 2.1's `whenDispatched`/`record` refactor. They are a **strictly sequential chain** — dispatch one subagent at a time, never in parallel, each re-reading the current file state. Tasks 2.5 (new file) and 2.6 (optional, different file) can follow.

### Task 2.1: Pre-armed `whenDispatched` on the fixture

**Files:**
- Modify: `server/src/routes/analysis-pipelining.test.ts` (the `makePipelineFixture` factory + `PipelineFixture` interface)

**Interfaces:**
- Produces: `fixture.whenDispatched(phase: 0 | 1, chapterId: number): Promise<void>` — resolves immediately if a matching trace entry already exists, else on the push that creates it. Pre-armed: calling it registers a waiter synchronously.

- [ ] **Step 1: Write the failing fixture test**

Add a focused test (temporary, in the same file) proving the semantics:
```ts
it('whenDispatched resolves for an already-pushed entry and a future one', async () => {
  const { fixture } = makePipelineFixture();
  // future: arm before push
  const future = fixture.whenDispatched(0, 7);
  fixture.trace.push({ phase: 0, chapterId: 7, startedAt: 0 });
  fixture.__notify?.(); // the push hook (added in Step 3)
  await future; // resolves
  // already-pushed: resolves immediately
  await fixture.whenDispatched(0, 7);
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run — fails (`whenDispatched` undefined)**

Run: `cd server && npx vitest run src/routes/analysis-pipelining.test.ts -t "whenDispatched"`
Expected: FAIL.

- [ ] **Step 3: Implement `whenDispatched` + a notify hook**

In `makePipelineFixture`, maintain a waiter list and notify it wherever the analyzers push to `trace`. Replace the bare `trace.push(...)` calls in both spy analyzers with a `record(entry)` helper:
```ts
const waiters: Array<{ match: (e: CallTrace) => boolean; resolve: () => void }> = [];
function record(entry: CallTrace) {
  trace.push(entry);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(entry)) { waiters[i].resolve(); waiters.splice(i, 1); }
  }
}
function whenDispatched(phase: 0 | 1, chapterId: number): Promise<void> {
  if (trace.some((e) => e.phase === phase && e.chapterId === chapterId)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiters.push({ match: (e) => e.phase === phase && e.chapterId === chapterId, resolve });
  });
}
```
Use `record({...})` in place of `trace.push({...})` in `runStage1Chapter` (phase 0) and `runStage2Chapter` (phase 1). Expose `whenDispatched` on the returned `fixture`. (The `__notify` in the Step-1 test is unnecessary once `record` notifies — simplify the test to push via a tiny helper or call an exposed `fixture.record`. Adjust the temporary test to match.)

- [ ] **Step 4: Run — passes**

Run: `cd server && npx vitest run src/routes/analysis-pipelining.test.ts -t "whenDispatched"`
Expected: PASS. Then **delete** the temporary test.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis-pipelining.test.ts
git commit -m "test(server): add pre-armed whenDispatched event hook to pipeline fixture"
```

### Task 2.2: Mock the analysis cache to in-memory (test-only)

**Files:**
- Modify: `server/src/routes/analysis-pipelining.test.ts`

- [ ] **Step 1: Add a `vi.mock` for the cache module**

Alongside the existing `vi.mock('../analyzer/select-analyzer.js', …)`, add an in-memory mock so no test in this file touches the shared `CACHE_DIR`:
```ts
vi.mock('../store/analysis-cache.js', () => {
  const mem = new Map<string, unknown>();
  return {
    // Empty-cache shape MUST match the real loadAnalysisCache miss return,
    // which is `{ chapters: {} }` (analysis-cache.ts ~L117) — NOT `{}` (review m1).
    loadAnalysisCache: async (id: string) => mem.get(id) ?? { chapters: {} },
    saveAnalysisCache: async (id: string, cache: unknown) => { mem.set(id, cache); },
    clearAnalysisCache: async (id: string) => { mem.delete(id); },
  };
});
```
Read the real `analysis-cache.ts` to confirm the exact miss-return shape. Note this mock also bypasses `assertCacheChaptersShape`/`seedEmotionsFromTags` for this file — acceptable here (scheduling tests), and Task 2.5 backfills the real-cache race coverage.

- [ ] **Step 2: Run the whole file (still quarantined cases skipped) — green + fast**

Run: `cd server && npx vitest run --config vitest.config.slow.ts analysis-pipelining.test.ts`
Expected: PASS; the non-quarantined cases now have **no disk I/O**. Note the runtime drop vs the Wave 0 baseline.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/analysis-pipelining.test.ts
git commit -m "test(server): mock analysis-cache to in-memory in pipelining tests"
```

### Task 2.3: Rewrite the rolling-roster case (de-quarantine)

**Files:**
- Modify: `server/src/routes/analysis-pipelining.test.ts`
- Modify: `docs/testing/flaky-register.md`

- [ ] **Step 1: Replace the `waitFor` poll with `whenDispatched`**

In the rolling-roster case, replace:
```ts
await waitFor(() => fixture.trace.some((t) => t.phase === 1 && t.chapterId === 6), 30_000);
```
with:
```ts
await fixture.whenDispatched(1, 6);
```
Keep the existing roster assertions verbatim (they already assert the fold + `not.toContain('ch12-char')`). Change `quarantinedIt(` back to `it(` and reduce the per-test timeout from `180_000` to the config default (drop the trailing `, 180_000` so it inherits `testTimeout: 15_000`).

- [ ] **Step 2: Run under induced load — must stay fast**

Run: `node scripts/flake-repro.mjs --file server/src/routes/analysis-pipelining.test.ts --runs 3 --cpu-load --io-load`
Expected: PASS on every run; runtime **flat** vs the no-load baseline (acceptance bar: no real I/O, bounded drain). If it still scales with load, a real await remains — find it before proceeding.

- [ ] **Step 3: Remove the register row**

Delete the rolling-roster row from `flaky-register.md`. Close/Refs its issue in the commit.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/analysis-pipelining.test.ts docs/testing/flaky-register.md
git commit -m "test(server): rewrite rolling-roster case event-driven; graduate off quarantine (Closes #<NN>)"
```

### Task 2.4: Rewrite the remaining cases + de-quarantine siblings

**Files:**
- Modify: `server/src/routes/analysis-pipelining.test.ts`
- Modify: `docs/testing/flaky-register.md`

- [ ] **Step 1: Replace every `waitFor(...)` with `whenDispatched`/`Promise.all`**

For Cases 1, 3, 4, 5, and the plan-118 case, replace each `waitFor(() => …trace.some(…), N)` with the matching `await fixture.whenDispatched(phase, id)` (or `await Promise.all([...].map((id) => fixture.whenDispatched(1, id)))` where a case waits on several).

**Case 3's negative assertion needs special care (review M1).** It proves chapter 3 does NOT dispatch while Phase 0 ch13 is held. The current `setTimeout(r, 200)` macrotask drains the *entire* pending microtask queue; a fixed `drainMicrotasks(5)` does NOT — the dispatch loop is a pure microtask chain (synchronous watermark notify + microtask release, no `setTimeout`), so 5 hops may not even reach the point where a *buggy* early dispatch would fire, giving a vacuous pass. Instead **drain to quiescence** (until the trace stops growing) and add a **positive control** so a vacuous pass is caught:
```ts
async function settle() {
  let prev = -1;
  // Drain microtasks until the trace length is stable across two passes.
  while (fixture.trace.length !== prev) { prev = fixture.trace.length; for (let i = 0; i < 50; i++) await Promise.resolve(); }
}
// ... after positively awaiting chapters 1 AND 2 dispatched (whenDispatched):
await settle();
// positive control: chapters 1 and 2 DID dispatch (guards against a vacuous pass)
expect(fixture.trace.find((t) => t.phase === 1 && t.chapterId === 1)).toBeDefined();
expect(fixture.trace.find((t) => t.phase === 1 && t.chapterId === 2)).toBeDefined();
// the actual assertion: chapter 3 is parked
expect(fixture.trace.find((t) => t.phase === 1 && t.chapterId === 3)).toBeUndefined();
```
Un-`quarantinedIt` any sibling quarantined in Task 1.5; restore `it(`.

- [ ] **Step 2: Run all cases under induced load**

Run: `node scripts/flake-repro.mjs --file server/src/routes/analysis-pipelining.test.ts --runs 5 --cpu-load --io-load`
Expected: all cases PASS every run; runtime flat.

- [ ] **Step 3: Empty the pipelining rows from the register; commit**

```bash
git add server/src/routes/analysis-pipelining.test.ts docs/testing/flaky-register.md
git commit -m "test(server): event-driven rewrite of all pipelining cases; graduate off quarantine"
```

### Task 2.5: Same-tick cache-write race regression test

**Files:**
- Create: `server/src/store/analysis-cache.race.test.ts`

**Why:** Task 2.2 mocked the real cache away in the pipelining tests. The real concurrent same-tick atomic-write race (`tmpSeq`, plan-88) must keep deterministic coverage somewhere.

**Why a no-throw assertion is too weak (review M1/P2):** a *broken* non-atomic impl that reuses one temp filename also resolves both promises and leaves a loadable file (last-write-wins) — so `resolves.toBeDefined()` catches nothing. The real `tmpSeq` invariant is that two concurrent writes use **distinct temp paths**. Assert THAT directly, and validate the test actually fails on a regression.

- [ ] **Step 1: Read the atomic-write seam**

Read `server/src/store/state-io.ts` (`writeJsonAtomic` + the `tmpSeq` counter) to learn the exact temp-path scheme and which `fs` call performs the temp write + rename. The test spies on that call.

- [ ] **Step 2: Write the regression test asserting distinct temp paths**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import { saveAnalysisCache, clearAnalysisCache } from './analysis-cache.js';

describe('analysis-cache concurrent same-tick writes (tmpSeq race)', () => {
  const id = `race-${process.pid}`;
  afterEach(async () => { vi.restoreAllMocks(); await clearAnalysisCache(id); });

  it('two saves in the same tick write to DISTINCT temp paths (no shared-temp corruption)', async () => {
    const renamed: string[] = [];
    const realRename = fsp.rename;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      renamed.push(String(from)); // capture the temp source path
      return realRename(from as never, to as never);
    });
    await Promise.all([
      saveAnalysisCache(id, { chapters: {} } as never),
      saveAnalysisCache(id, { chapters: {} } as never),
    ]);
    // The two same-tick writes MUST have used different temp files (tmpSeq).
    expect(new Set(renamed).size).toBe(renamed.length);
    expect(renamed.length).toBe(2);
  });
});
```
Adjust the spied call (`rename` vs the temp `writeFile`) to whatever `writeJsonAtomic` actually uses; fill `{ chapters: {} }` with the real minimal `AnalysisCache` shape.

- [ ] **Step 3: Validate it goes RED on a regression, then restore**

Temporarily break `tmpSeq` in `state-io.ts` (e.g. hard-code the temp suffix to a constant so both writes collide), run the test, confirm it **FAILS** (`Set.size !== length`), then **revert** the break. This proves the guard has teeth — a regression test never shown red proves nothing.

Run (broken): `cd server && npx vitest run src/store/analysis-cache.race.test.ts` → Expected: FAIL.
Run (restored): same command → Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/store/analysis-cache.race.test.ts
git commit -m "test(server): regression-guard the same-tick cache-write race (tmpSeq)"
```

### Task 2.6 (OPTIONAL): Extract the watermark→snapshot coupling for unit coverage

**Take this ONLY if** Task 2.3's deterministic integration test does not, in review, give confident coverage of the watermark→snapshot coupling. The mocked-cache + event-driven rolling-roster case already exercises it deterministically, so this is insurance, not required. It is the one production-file change in the plan — a behavior-neutral extraction.

**Files:**
- Modify: `server/src/routes/analysis.ts` (extract `rosterSnapshotFn` logic — currently an inline closure ~L2373/L2551 — into an exported pure function)
- Test: `server/src/routes/analysis.roster-snapshot.test.ts`

- [ ] **Step 1:** Extract a pure `export function rosterSnapshotAtWatermark(chapterHints, chapterCast, watermark, language)` that returns the folded roster for chapters whose id ≤ the watermark-released set, reusing `mergeRosterChapter`. The inline closure calls the new function — default runtime path byte-for-byte equivalent.
- [ ] **Step 2:** Write a unit test asserting "snapshot at watermark-release K folds exactly chapters 1..K+LAG; excludes a held/absent chapter." Run it red-first by temporarily breaking the fold, then fix.
- [ ] **Step 3:** Run the full server slow + fast suites to prove the extraction changed nothing. Commit `refactor(server): extract rosterSnapshotAtWatermark as a testable seam`.

### Task 2.7: Playbook + Wave 2 verify + PR

- [ ] **Step 1:** Append a "Deterministic rewrite playbook" section to `docs/testing/flaky-register.md` (or a sibling `docs/testing/deterministic-test-playbook.md`): the recipe (mock real I/O via `vi.mock`; `whenDispatched` pre-armed deferreds; `drainMicrotasks` for negative assertions; backstop timeout, never a perf budget; acceptance via `flake-repro.mjs --cpu-load --io-load`).
- [ ] **Step 2:** `npm run verify` → green. Open PR `test/flaky-w2-pipelining` → `main`.

---

# Wave 3 — Class A2 burn-down (evidence-gated)

**Branch:** `test/flaky-w3-slowfiles`. Rewrite ONLY the slow files `flake-evidence.md` shows actually flake. Files that stayed flat under induced load are left serialized.

### Task 3.1: Per-file isolation fixes (driven by the evidence file)

**Files:**
- Modify: each flagged `server/src/**/*.test.ts` from `flake-evidence.md`
- Modify: `server/vitest.config.slow.ts`, `scripts/verify-cache.mjs` (stale-comment fix)

- [ ] **Step 1: For each flagged file, apply the matching recipe**

- *tmpdir race:* give each test a unique dir and tear it down:
  ```ts
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cw-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  ```
- *cross-file `vi.mock` contamination:* add `afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });` and move `vi.mock` factories to return fresh state per test.
- *in-`beforeAll` fake HTTP server:* bind to an ephemeral port (`listen(0)`) and `await once(server, 'listening')`; capture `server.address().port`; close in `afterAll`.
- *real I/O in assertion path:* `vi.mock` the I/O module to in-memory (as Wave 2 Task 2.2).

- [ ] **Step 2: Prove each rewritten file is load-invariant**

Run: `node scripts/flake-repro.mjs --file server/src/routes/<file>.test.ts --runs 5 --cpu-load --io-load`
Expected: PASS every run, flat runtime.

- [ ] **Step 3: Graduate out of the slow tier where earned**

If a rewritten file no longer races, remove it from `SLOW_FILES` in `server/vitest.config.slow.ts` AND from `server/vitest.config.ts`'s `test.exclude` (the mirror invariant in the config header). Re-run both configs to confirm no double-run / no-run.

- [ ] **Step 4: Fix the stale comments (if touching these files; otherwise Wave 5 does it unconditionally)**

Change "5 hot files" → **10** in `server/vitest.config.slow.ts:3` AND `scripts/verify-cache.mjs:~98`, and extend the enumerated list in the config header (`vitest.config.slow.ts` ~L11–26) to include `setup-readiness.route`, `kokoro-install.route`, `venv-bootstrap.route` (review m1/m6). If Wave 0 evidence flags no slow file to rewrite, this still gets done in Wave 5 Task 5.3 (review m2 — it's a spec-required deliverable, not conditional).

- [ ] **Step 5: Commit per file** (one file = one reviewable commit), e.g.:
```bash
git commit -m "test(server): de-flake <file> via isolated tmpdir/mock reset"
```

- [ ] **Step 6:** `npm run verify` → green. PR `test/flaky-w3-slowfiles` → `main`.

---

# Wave 4 — Class B (e2e) burn-down

**Branch:** `test/flaky-w4-e2e`. Prioritize Ubuntu flakes (they can hit release legs) over Windows-only proc leaks (local pre-push only).

### Task 4.1: Audit e2e for the anti-patterns

**Files:**
- Modify: flagged `e2e/**/*.spec.ts`, possibly `playwright.config.ts`, `e2e/global-teardown.ts`

- [ ] **Step 1: Grep the audit surface**

```bash
grep -rnE "waitForTimeout|localhost:[0-9]{4}|127\.0\.0\.1:[0-9]{4}" e2e/
```
Record each hit in `flake-evidence.md` under an "e2e" section with a fix disposition.

- [ ] **Step 2: Apply fixes per hit**

- `page.waitForTimeout(N)` → state-based wait: `await expect(locator).toBeVisible()` / `await expect.poll(() => …).toBe(…)` / `await expect(async () => { … }).toPass()`.
- hard-coded port → derive from the Playwright `baseURL`/`webServer.port` config, never a literal.
- missing teardown → confirm `e2e/global-teardown.ts` sweeps leaked `headless_shell`/browser procs on Windows (extend it if a leak is found).

- [ ] **Step 3: Run e2e repeatedly to confirm stability**

Run: `npm run test:e2e` three times back-to-back.
Expected: green all three (no port-reuse / proc-leak contamination).

- [ ] **Step 4:** Anything that can't be fixed in this wave → quarantine via the `@quarantine` tag + register row (don't leave it gating). Commit per fix. `npm run verify` → green. PR `test/flaky-w4-e2e` → `main`.

---

# Wave 5 — Guardrail + closeout

**Branch:** `test/flaky-w5-guardrail`. Lands LAST so zero existing violations remain.

### Task 5.1: ESLint `no-restricted-syntax` guardrail

**Files:**
- Modify: `eslint.config.js`
- Test: `eslint.config.guardrail.test.mjs` (planted-violation check via the `test:hooks`/node test tier)

- [ ] **Step 1: Confirm zero existing violations first**

```bash
grep -rnE "it\.skipIf\(process\.env\.CI" server/src src e2e
grep -rnE "page\.waitForTimeout\(" e2e
```
Expected: **no output**. If any remain, finish their migration before adding the rule.

- [ ] **Step 2: Add the rule to the test-file + e2e override blocks**

In `eslint.config.js`, within the override block that targets `**/*.test.{ts,tsx}` (and a block for `e2e/**`), add:
```js
'no-restricted-syntax': ['error',
  {
    // VERIFIED against `it.skipIf(process.env.CI)(...)` by running the rule (review C2):
    // the plan's first-draft `callee.object.property.name='skipIf'` matched NOTHING.
    selector: "CallExpression[callee.property.name='skipIf'] > MemberExpression.arguments[object.property.name='env'][property.name='CI']",
    message: 'No it.skipIf(process.env.CI). Use quarantinedIt + a flaky-register row.',
  },
  {
    selector: "CallExpression[callee.property.name='waitForTimeout']",
    message: 'No page.waitForTimeout in e2e. Use a state-based wait (toPass / expect.poll).',
  },
  {
    // large inline per-test timeout literal, e.g. it('…', fn, 180000)
    selector: "CallExpression[callee.name=/^(it|test)$/][arguments.2.type='Literal'][arguments.2.value>30000]",
    message: 'No large inline per-test timeout. A timeout is a deadlock backstop, not a perf budget.',
  },
];
```
**Do NOT trust the selector blindly** — `--print-config` shows resolved rules, not whether a selector matches a node. Validate each selector by actually running the rule against a planted sample (Step 3 does this). Keep the existing `no-constant-condition` relaxation untouched — this rule does NOT ban `while`/`setTimeout`.

- [ ] **Step 3: Write the planted-violation test**

Place the test at `scripts/tests/eslint-guardrail.test.mjs` so `scripts/run-hooks-tests.mjs` (which globs `scripts/tests/*.test.mjs`) auto-discovers it (review M2 — a root-level `*.test.mjs` is NOT discovered). Write the planted file **inside the repo tree**, not `os.tmpdir()` — ESLint flat config ignores files outside its base path ("File ignored… exit 0"), which would false-pass (review C1).

```js
// scripts/tests/eslint-guardrail.test.mjs — run via node --test (test:hooks tier)
import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd(); // test:hooks runs from repo root

test('guardrail rejects a planted it.skipIf(process.env.CI)', () => {
  // INSIDE the repo so the flat config's base path applies. *.test.ts → the
  // test-file override block (and its TS parser) matches.
  const dir = mkdtempSync(join(repoRoot, 'guardrail-tmp-'));
  const f = join(dir, 'planted.test.ts');
  writeFileSync(f, "import {it} from 'vitest';\nit.skipIf(process.env.CI)('x', () => {});\n");
  let failed = false;
  try { execFileSync('npx', ['eslint', f], { cwd: repoRoot, stdio: 'pipe', shell: process.platform === 'win32' }); }
  catch { failed = true; } // eslint exits non-zero on an error-level violation
  finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(failed, true, 'eslint should reject the planted violation');
});
```
Confirm `guardrail-tmp-*` is not swept into the lint glob of a real run (it only exists during the test; add it to `.gitignore`).

- [ ] **Step 4: Run — planted violation rejected, clean tree passes**

Run: `npm run test:hooks` (expected PASS — the guardrail rejects the planted file) and `npm run lint` (expected PASS — no real violations remain).

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js scripts/tests/eslint-guardrail.test.mjs .gitignore
git commit -m "ci: guardrail against skipIf(CI)/waitForTimeout/large-inline-timeout"
```

### Task 5.2: Budgeted-poll grep + review checklist

**Files:**
- Create: `scripts/check-no-budget-poll.mjs` (grep heuristic)
- Modify: `CONTRIBUTING.md` (review checklist line)

- [ ] **Step 1:** Write a grep heuristic that flags the `Date.now() - <start> > <budget>` poll shape and any reintroduced `waitFor(` budget helper in `server/src/**/*.test.ts`; exit non-zero on a hit. Wire into `test:hooks`.
- [ ] **Step 2:** Add a CONTRIBUTING.md review-checklist bullet: "No budgeted polling loops in tests — await an event or use a microtask drain."
- [ ] **Step 3:** Commit `ci: heuristic check + review checklist for budgeted-poll loops`.

### Task 5.3: Closeout

- [ ] **Step 1:** Confirm `docs/testing/flaky-register.md` is empty (or holds only documented hard cases, each with an issue + rationale).
- [ ] **Step 2 (unconditional stale-comment fix, review m2):** If Wave 3 did not already do it, change "5 hot files" → **10** in `server/vitest.config.slow.ts:3` and `scripts/verify-cache.mjs:~98`, and complete the enumerated list in the config header.
- [ ] **Step 3 (remove the gating-path retry, review m5):** `server/vitest.config.slow.ts:62` has `retry: 1` on the **gating** slow tier — which contradicts the "no auto-retry as a gating mechanism" constraint and masks the very flakiness this work removes. Now that the slow tier is deterministic, delete `retry: 1` and run `npm run test:server-slow` 3× to confirm it stays green without it. (If anything goes red without retry, that file isn't actually deterministic yet — fix it, don't restore the retry.)
- [ ] **Step 4:** Add the plan to `docs/features/INDEX.md`; set the spec `status: stable` and fill its Ship notes (date + merge SHA); `git mv` the spec under `docs/features/archive/` if it’s being tracked as a feature plan, otherwise leave under `specs/`.
- [ ] **Step 5:** `npm run verify` → green. PR `test/flaky-w5-guardrail` → `main`.

---

## Self-Review

**Spec coverage:** Structural guarantee → W1 (helper + non-gating job, Task 1.6 Step 2 asserts `publish.needs` excludes the lane). Deterministic rewrite → W2 (events + mocked I/O) / W3 (isolation) / W4 (e2e). I/O-free acceptance bar → `flake-repro.mjs` + the per-rewrite Step that runs it under `--cpu-load --io-load`. Coverage not lost → fold already covered (noted), same-tick race test (2.5), optional coupling extraction (2.6). Guardrail at lint/pre-push not pre-commit → W5 Task 5.1. Evidence-gating → W0 + the decision rules in 1.5 / 3.1. `cross-env` + 3 configs lane → Task 1.2. Single grep-invert regex → Task 1.2. Stale comments → 3.1 Step 4. Ratchet → 5.1 Step 1.

**Placeholders:** `#<NN>` (issue numbers) and the `flake-evidence.md`-driven targets are genuine runtime data, not placeholders — each has an explicit decision rule. Cache-shape literals in 2.2/2.5 instruct reading the real type — acceptable (the exact shape is in the source, not inventable here).

**Type consistency:** `quarantinedIt`/`RUN_QUARANTINE` (1.1) used in 1.4/1.5/1.6. `whenDispatched(phase, chapterId)` (2.1) used in 2.3/2.4. `record(entry)` internal to the fixture. `rosterSnapshotAtWatermark` (2.6) self-contained. Cache mock mirrors `loadAnalysisCache`/`saveAnalysisCache`/`clearAnalysisCache` (confirmed exported in `analysis-cache.ts`).
