# Generation Stall Protection — Wave 1 (config safety) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generation concurrency and config-loading impossible to silently go unsafe — the cluster of faults that let a stale worktree dev server run 2 workers, adopt a leaky orphan sidecar, and never surface any of it.

**Architecture:** Four independent server/launcher changes: (A1) flip the generation-worker default from 2→1, (A2) make a missing `server/.env` LOUD instead of a swallowed info log, (A4) make the launchers refuse to honor a stale/wrong server on the port, and (prod-fresh) make prod always spawn its own sidecar instead of adopting a pre-existing one.

**Tech Stack:** TypeScript (Express server, Vitest), PowerShell + Node ESM launchers. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-08-generation-stall-protection-design.md` · **Bug:** #672 · **PR:** #673

---

## File Structure

- `server/src/config/registry.ts` — `tts.gen.workers` default (A1).
- `server/src/workspace/user-settings.ts` — `DEFAULT_USER_SETTINGS.generationWorkers` + `getResolvedGenerationWorkers` fallback (A1).
- `server/src/load-env.ts` — export load state + loud warn (A2).
- `server/src/load-env.test.ts` — **new**, unit test for the warning formatter (A2).
- `server/src/index.ts` — `/api/health` exposes `configLoad` (A2).
- `server/src/health-config.test.ts` — **new**, `/api/health` shape (A2).
- `server/src/tts/spawn-sidecar.ts` — prod "never adopt" gate (prod-fresh).
- `server/src/tts/spawn-sidecar.test.ts` — extend with prod-fresh cases.
- `scripts/start-app.ps1` — port-collision guard (A4).
- `scripts/start-app-prod.mjs` — port-collision guard (A4).

---

## Task 1: A1 — default generation workers 2 → 1

**Files:**
- Modify: `server/src/config/registry.ts:311`
- Modify: `server/src/workspace/user-settings.ts:287,446,466`
- Test: `server/src/workspace/user-settings.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/workspace/user-settings.test.ts` (in the `getResolvedGenerationWorkers` describe block; mirror the existing env-clear pattern at the top of that file):

```ts
it('defaults to 1 worker when no env, override, or setting is present', () => {
  delete process.env.GEN_WORKERS;
  // no config override, no cached setting
  expect(getResolvedGenerationWorkers()).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts -t "defaults to 1 worker"`
Expected: FAIL — receives `2`.

- [ ] **Step 3: Change the three default sites**

`server/src/workspace/user-settings.ts:287` — in `DEFAULT_USER_SETTINGS`:
```ts
  generationWorkers: 1,
```
`server/src/workspace/user-settings.ts:466` — fallback in `getResolvedGenerationWorkers`:
```ts
  return DEFAULT_USER_SETTINGS.generationWorkers ?? 1;
```
`server/src/workspace/user-settings.ts:446` — update the doc comment `3. DEFAULT_USER_SETTINGS.generationWorkers (2).` → `(1).`

`server/src/config/registry.ts:311` — change the default and the trailing comment:
```ts
    default: 1, // ← getResolvedGenerationWorkers() default in workspace/user-settings.ts
```
And update the `help` text (`registry.ts:309`) final clause to reflect the new default:
```ts
    help: 'Number of chapters the generation queue synthesises concurrently. Queue/synthesis concurrency only — the GPU semaphore is the VRAM guard. Default 1: the Qwen forward is serialised, so a 2nd same-book worker just contends on the lock, doubles per-chapter RTF, and accelerates the host-memory leak toward a recycle. Raise only on a multi-GPU / non-Qwen setup.',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts`
Expected: PASS (the new test + the existing `GEN_WORKERS=3`/`'lots'` cases still green).

- [ ] **Step 5: Update the registry-default consistency test if present**

Run: `cd server && npx vitest run src/config` — if a registry test asserts `tts.gen.workers` default is `2`, update it to `1`. If none fails, skip.

- [ ] **Step 6: Commit**

```bash
git add server/src/config/registry.ts server/src/workspace/user-settings.ts server/src/workspace/user-settings.test.ts
git commit -m "fix(server): default generation workers to 1 (safe-by-default, Refs #672)"
```

---

## Task 2: A2 — loud config-load failure

**Files:**
- Modify: `server/src/load-env.ts`
- Create: `server/src/load-env.test.ts`
- Modify: `server/src/index.ts:178-180`
- Create: `server/src/health-config.test.ts`

- [ ] **Step 1: Write the failing test for the warning formatter**

Create `server/src/load-env.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatMissingEnvWarning } from './load-env.js';

describe('formatMissingEnvWarning', () => {
  it('names the CWD and the unloaded knobs so a wrong-CWD launch self-diagnoses', () => {
    const msg = formatMissingEnvWarning('C:\\wrong\\cwd');
    expect(msg).toContain('C:\\wrong\\cwd');
    expect(msg).toContain('DEFAULTS');
    expect(msg).toMatch(/GEN_WORKERS|GPU_VRAM_BUDGET|WORKSPACE_DIR/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/load-env.test.ts`
Expected: FAIL — `formatMissingEnvWarning` is not exported.

- [ ] **Step 3: Rewrite `load-env.ts` to export state + formatter and warn loudly**

Replace the body of `server/src/load-env.ts` (keep the existing header comment) with:
```ts
/** Build-time/boot config-load state, surfaced on /api/health so a wrong-CWD
    launch (server/.env not found → silent defaults) is visible, not buried. */
export const envLoadState: { loaded: boolean; cwd: string } = {
  loaded: false,
  cwd: process.cwd(),
};

/** Pure, testable warning string for a missing .env. */
export function formatMissingEnvWarning(cwd: string): string {
  return (
    `[server] WARNING: no .env found at ${cwd}\\.env — running on DEFAULTS. ` +
    `GEN_WORKERS, GPU_VRAM_BUDGET, WORKSPACE_DIR and all other server/.env tuning ` +
    `are NOT applied. Launch the server with its working directory at server/ ` +
    `(the prod launcher does this) so server/.env loads.`
  );
}

try {
  process.loadEnvFile('.env');
  envLoadState.loaded = true;
} catch {
  // Missing .env is non-fatal (shell env still applies) but must be LOUD —
  // a silently-defaulted server is the 2026-06-08 stall incident.
  console.warn(formatMissingEnvWarning(envLoadState.cwd));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/load-env.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing /api/health test**

Create `server/src/health-config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './index.js';

describe('GET /api/health configLoad', () => {
  it('reports whether server/.env loaded + the cwd', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.configLoad.envLoaded).toBe('boolean');
    expect(typeof res.body.configLoad.cwd).toBe('string');
  });
});
```
> If `index.ts` does not already `export const app`, confirm how existing route tests import the app (`grep -rn "from './index" server/src/*.test.ts`) and match that import. If the app isn't exported, the smaller change is a `supertest` against an imported router; follow the existing test convention rather than adding a new export.

- [ ] **Step 6: Run test to verify it fails**

Run: `cd server && npx vitest run src/health-config.test.ts`
Expected: FAIL — `configLoad` is undefined.

- [ ] **Step 7: Extend the health handler**

`server/src/index.ts` — add the import near the other top imports (after the existing `./load-env.js` import that must stay FIRST):
```ts
import { envLoadState } from './load-env.js';
```
Replace the handler at `index.ts:178-180`:
```ts
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    configLoad: { envLoaded: envLoadState.loaded, cwd: envLoadState.cwd },
  });
});
```

- [ ] **Step 8: Run both new tests to verify they pass**

Run: `cd server && npx vitest run src/load-env.test.ts src/health-config.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/load-env.ts server/src/load-env.test.ts server/src/index.ts server/src/health-config.test.ts
git commit -m "feat(server): surface + warn on missing server/.env config load (Refs #672)"
```

---

## Task 3: prod-fresh-sidecar — prod never adopts a pre-existing sidecar

**Files:**
- Modify: `server/src/tts/spawn-sidecar.ts` (the adopt decision, ~line 425-445)
- Test: `server/src/tts/spawn-sidecar.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/spawn-sidecar.test.ts` (mirror the existing `it('replaces a leak-saturated adopt target …')` test at line ~260 for the health-mock + spawn-mock setup; assert REPLACE, not adopt):
```ts
it('in prod (NODE_ENV=production), replaces a HEALTHY pre-existing sidecar instead of adopting it', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    // health mock: a perfectly fit, same-protocol sidecar well under the ceiling
    // (reuse the test's healthProbeFn stub returning looksLikeSidecar:true,
    //  protocolVersion EXPECTED, recyclePending:false, committedMb: 9000)
    // findPidFn → a pid; spawnFn → a fresh handle.
    const handle = await spawnOrAdopt(/* opts with the fit-health + prod stubs */);
    // In prod we must NOT adopt: a fresh spawn happens (spawnFn called) and
    // onAdoptExisting is NOT called.
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(onAdoptExisting).not.toHaveBeenCalled();
  } finally {
    process.env.NODE_ENV = prev;
  }
});

it('in dev, still ADOPTS a healthy same-build sidecar (HMR fast-path preserved)', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const res = await spawnOrAdopt(/* same fit-health stubs */);
    expect(onAdoptExisting).toHaveBeenCalledTimes(1);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(res).toBeNull(); // adopt path returns null (no owned child)
  } finally {
    process.env.NODE_ENV = prev;
  }
});
```
> Match the actual exported entry name and option shape used by the existing tests (`grep -n "spawnOrAdopt\|export" server/src/tts/spawn-sidecar.ts` and copy a neighboring test's full stub block verbatim — do not invent the mock shape).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/spawn-sidecar.test.ts -t "in prod"`
Expected: FAIL — prod currently adopts the fit sidecar (`onAdoptExisting` called, `spawnFn` not).

- [ ] **Step 3: Add the never-adopt gate**

`server/src/tts/spawn-sidecar.ts` — add a helper near `adoptCommittedCeilingMb` (~line 107):
```ts
/* Prod never adopts a pre-existing sidecar: at boot there is no in-flight synth,
   so spawning a clean owned process (governed by the graceful soft/hard recycle
   path) is strictly safer than bolting onto an orphan of unknown leak/build. Dev
   keeps adopt-if-healthy so `tsx watch` HMR doesn't reload the model every save.
   Override with SIDECAR_NEVER_ADOPT=1/0. */
export function neverAdoptSidecar(): boolean {
  const raw = process.env.SIDECAR_NEVER_ADOPT;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV === 'production';
}
```
Then in the adopt decision (the `const fresh = freshProtocol && unfitReason === null;` line, ~437), gate it:
```ts
    const policyReplace = neverAdoptSidecar() && freshProtocol && unfitReason === null;
    const fresh = freshProtocol && unfitReason === null && !policyReplace;
```
And extend the replace `reason` (~line 451) to name the policy case first:
```ts
    const reason = policyReplace
      ? 'prod policy: spawning a fresh owned sidecar instead of adopting a pre-existing one'
      : !freshProtocol
        ? `protocol ${health.protocolVersion === null ? 'missing' : `v${health.protocolVersion}`} < v${EXPECTED_PROTOCOL_VERSION}`
        : (unfitReason ?? 'unfit');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/tts/spawn-sidecar.test.ts`
Expected: PASS (new prod + dev cases green; existing adopt/replace cases unchanged because they don't set `NODE_ENV=production`).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/spawn-sidecar.ts server/src/tts/spawn-sidecar.test.ts
git commit -m "feat(server): prod never adopts a pre-existing sidecar (Refs #672)"
```

---

## Task 4: A4 — launchers refuse a stale/wrong server on the port

**Files:**
- Modify: `scripts/start-app.ps1:108-125` (the `Test-PortListening` SKIP block)
- Modify: `scripts/start-app-prod.mjs` (its port-already-listening branch)

- [ ] **Step 1: Add a build/version probe to `start-app.ps1`**

Replace the idempotency loop (`start-app.ps1` ~117-125) so a listening port is **verified** before it's honored. After `Test-PortListening`, probe `/api/health` and compare the served version to `package.json`:
```powershell
function Get-ServedVersion($port, $useHttps) {
    $scheme = if ($useHttps) { 'https' } else { 'http' }
    try {
        $resp = Invoke-RestMethod -Uri "${scheme}://localhost:$port/api/health" -TimeoutSec 4 -SkipCertificateCheck
        return $resp
    } catch { return $null }
}

foreach ($svc in $services) {
    $pidPath = Join-Path $runDir "$($svc.Name).pid"
    if (Test-PortListening $svc.Port) {
        if ($svc.Name -eq 'server') {
            $h = Get-ServedVersion $svc.Port $lanHttps
            if ($null -eq $h) {
                Fail "Port :$($svc.Port) is occupied by a process that does not answer /api/health — likely a stale/foreign server. Stop it (npm run stop) and retry."
            }
            if ($h.configLoad -and -not $h.configLoad.envLoaded) {
                Write-Status "[WARN] server on :$($svc.Port) is running WITHOUT server/.env (cwd=$($h.configLoad.cwd)) — it is on DEFAULTS. Stop it and relaunch so server/.env loads."
            }
        }
        Write-Status "[SKIP] $($svc.Name) already listening on :$($svc.Port)"
    } else {
        if (Test-Path $pidPath) { Remove-Item $pidPath -Force }
        $toStart += $svc
    }
}
```
> `Invoke-RestMethod -SkipCertificateCheck` requires PowerShell 7+. The repo targets `#requires -Version 5.1`. If running under 5.1, guard the call: wrap in `try`/`catch` and, when `-SkipCertificateCheck` is unavailable, fall back to `curl.exe -sk`. Keep the guard minimal — the goal is "warn/refuse on an unverifiable port," never to hard-crash the launcher on a PS-version quirk.

- [ ] **Step 2: Mirror the guard in `start-app-prod.mjs`**

In `scripts/start-app-prod.mjs`, find the branch that detects the port already in use and skips the spawn. Before honoring it, `fetch` `/api/health` (Node 20 global fetch; for LAN HTTPS pass an agent that ignores the self-signed cert, matching how the file already talks to the server, or skip the TLS check with `process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'` scoped to the probe). On no-answer: log a clear error and exit non-zero. On `configLoad.envLoaded === false`: log a loud warning naming the cwd.
```js
async function probeServed(port, https) {
  const scheme = https ? 'https' : 'http';
  try {
    const res = await fetch(`${scheme}://localhost:${port}/api/health`);
    return await res.json();
  } catch { return null; }
}
// …in the "already listening" branch:
const served = await probeServed(serverPort, lanHttps);
if (!served) {
  fail(`Port :${serverPort} is occupied by a process that does not answer /api/health — likely a stale/foreign server. Run "npm run stop" and retry.`);
}
if (served.configLoad && served.configLoad.envLoaded === false) {
  console.warn(`[start] WARNING: server on :${serverPort} is running WITHOUT server/.env (cwd=${served.configLoad.cwd}) — on DEFAULTS. Stop it and relaunch from server/.`);
}
```

- [ ] **Step 3: Manual verification (no unit harness for the launchers)**

These scripts have no unit harness; verify by hand and record the result in the PR:
1. `npm run start:lan` → note the server comes up; `curl -sk https://localhost:8443/api/health` shows `configLoad.envLoaded: true`.
2. Leave it running, `npm run start:lan` again → expect `[SKIP] server already listening` (verified path), NOT a second server.
3. Start a dummy listener on :8443 (`python -m http.server 8443`) and run the launcher → expect the new **Fail** ("does not answer /api/health"), not a silent SKIP.

- [ ] **Step 4: Commit**

```bash
git add scripts/start-app.ps1 scripts/start-app-prod.mjs
git commit -m "feat(scripts): port-collision guard — verify served build/.env before honoring a listening port (Refs #672)"
```

---

## Task 5: Wave 1 wrap-up

- [ ] **Step 1: Run the full fast battery**

Run: `npm run verify:fast`
Expected: PASS (frontend + server unit + validator).

- [ ] **Step 2: Run the server suite explicitly**

Run: `npm run test:server`
Expected: PASS — confirms the worker-default, config-load, and spawn-sidecar changes hold.

- [ ] **Step 3: Update the spec status note**

In `docs/superpowers/specs/2026-06-08-generation-stall-protection-design.md`, under "Delivery", mark Wave 1 items A1/A2/A4 + prod-fresh as landed (add a `**Wave 1 shipped:** <date>, <sha>` line). Commit:
```bash
git add docs/superpowers/specs/2026-06-08-generation-stall-protection-design.md
git commit -m "docs(docs): mark Wave 1 of generation stall protection landed (Refs #672)"
```

- [ ] **Step 4: Push and surface for review**

```bash
git push
```
Then summarise the Wave 1 delta on PR #673 and leave it draft until all waves land (or split a Wave-1 PR if shipping incrementally).

---

## Self-review notes

- **Spec coverage (Wave 1):** A1 ✓ (Task 1), A2 ✓ (Task 2), A4 ✓ (Task 4), prod-fresh-sidecar ✓ (Task 3). A3 + Layers B/C are **Waves 2–3** (separate plans).
- **No new types referenced across tasks** beyond `envLoadState` (defined Task 2, used Task 2) and `neverAdoptSidecar` (defined + used Task 3).
- **Launcher tasks are manually verified** (no PS/mjs unit harness) — called out explicitly per the testing-discipline "say so when a step doesn't apply" rule.
- **Each task commits independently** and is revertible on its own.
