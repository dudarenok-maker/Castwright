---
status: draft
date: 2026-08-05
---

# Verify Scope-Map Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scripts/verify-cache.mjs`'s `STEPS[]` the single source of
truth for "which files does this verify step depend on", derive
`.github/workflows/verify.yml` from it, and harden the completeness guard so
it sees transitive and runtime dependencies — closing #2119 and #2120.

**Architecture:** Three sequential PRs. **A1** is purely additive (nothing
about how scope is *computed* changes) and de-circularises A2. **A2** rewrites
`verify.yml` to derive per-step scope from `STEPS[]` via a new
`scripts/ci-scope.mjs`, guarded by four assertions over the parsed workflow.
**B** hardens `scripts/tests/verify-cache.test.mjs`'s completeness guard with
AST-based extraction, a TS-aware resolver, a transitive walk stopped at
gitignored paths, and splits `check-no-budget-poll` into its own step.

**Tech Stack:** Node 20 ESM (`.mjs`), `node:test` + `node:assert/strict`,
GitHub Actions expressions (`fromJSON`), `git check-ignore --stdin`, pytest
(sidecar), PowerShell (existing sidecar runner).

**Design of record:**
[`docs/superpowers/specs/2026-08-05-verify-scope-map-unification-design.md`](../specs/2026-08-05-verify-scope-map-unification-design.md)

## Global Constraints

Every task's requirements implicitly include this section. Values are copied
verbatim from the spec.

- **The aggregator job's `name:` is `npm run verify` and MUST NOT CHANGE.**
  `main`'s ruleset 17654264 pins `required_status_checks` to the contexts
  `'npm run verify'` and `'Verify PR body links a GitHub issue'`. Renaming it
  detaches the gate and every subsequent PR merges with no check at all.
- **Conditions stay at STEP level, never hoisted to JOB level.** Hoisting
  makes scoped-down PRs skip jobs, and the aggregator fails on `'skipped'`
  (`verify.yml:445`) — turning the required check red on every PR.
- **Every job carrying a derived `if:` MUST appear in the aggregator's
  `needs:`.** A job outside that list can run, fail, and not block merge.
- **`shared` stays a disjunct in every derived condition.** Measured: a root
  `package-lock.json` diff touches **zero** steps via `stepTouchedByDiff`;
  `computeShared` is a separate global override.
- **Guards fail CLOSED.** Absent, unparseable, or error-state evidence must
  report, never be treated as clean. `git check-ignore` exit `128` and
  git-unavailable both fail closed.
- **Paths are POSIX-normalised** via `_internals.toPosix` before any
  `git check-ignore` query or glob comparison.
- **Every new guard ships with a named mutation that makes it go red.** A
  guard that cannot be shown failing is not a guard.
- Commit convention: `<type>(<scope>): <subject>`. Scope for this work is
  `ops` or `scripts`. Branch shape `<type>/<scope>-<slug>`.
- Every PR body links its issue (`Closes #NN` / `Refs #NN`).

## File Structure

| File | Phase | Responsibility |
|---|---|---|
| `scripts/ci-scope.mjs` | A2 | **new** — derive per-step CI scope from `STEPS[]`; emit `scopes` JSON + `ok` sentinel |
| `scripts/tests/ci-scope.test.mjs` | A2 | **new** — unit tests for the above (fail-safe, dispatch, shared) |
| `scripts/tests/workflow-wiring.test.mjs` | A2 | **new** — the four assertions over parsed `verify.yml` |
| `scripts/lib/module-graph.mjs` | B | **new** — AST extract, resolve, `check-ignore` classify, transitive walk |
| `scripts/tests/module-graph.test.mjs` | B | **new** — synthetic-fixture unit tests incl. M17 |
| `.github/workflows/verify.yml` | A1, A2 | scope detection + per-step gating |
| `scripts/verify-cache.mjs` | A1, A2, B | `STEPS[]` — the single source of truth |
| `scripts/tests/verify-cache.test.mjs` | A1, B | completeness guard + step-scope tests |
| `scripts/run-hooks-tests.mjs` | B | drops the `check-no-budget-poll` spawn |
| `scripts/run-sidecar-tests.mjs` | A1 | **new** — cross-platform pytest entry point |
| `server/tts-sidecar/tests/test_xtts_audio_io.py` | A1 | `importorskip("torch")` |
| `server/tts-sidecar/tests/test_speechbrain_disarm.py` | A1 | `importorskip("speechbrain")` |
| `package.json` | A1, B | `test:sidecar` rewire; `check:budget-poll` script |

---

# PHASE A1 — additive (Refs #2119)

Branch: `fix/ops-verify-scope-github-and-sidecar`

Nothing here changes how scope is computed. Both parts are pure additions to
*what runs*, so each is independently revertable.

---

### Task 1: `.github/**` becomes a real input (defect D)

Today, simulating all nine `verify.yml` matchers against the literal path
`.github/workflows/verify.yml` yields **zero** matches, and `.github` appears
in no STEP's inputs. A workflow-only PR runs no leg, in cloud or locally.

**Files:**
- Modify: `scripts/verify-cache.mjs` (`test:hooks` step, `extraFiles`)
- Modify: `.github/workflows/verify.yml:164` (the `hooks` matcher)
- Test: `scripts/tests/verify-cache.test.mjs`

**Interfaces:**
- Consumes: `stepTouchedByDiff(step, diffFiles)`, `stepByName` — existing.
- Produces: nothing new; widens an existing step's declared inputs.

- [ ] **Step 1: Write the failing test**

Add to `scripts/tests/verify-cache.test.mjs`, next to the other
`stepTouchedByDiff` cases (near `:463`):

```js
// Defect D (#2119 review): verify.yml matched NO scope, so a workflow-only
// PR ran zero legs — in cloud AND locally. The wiring assertions added in
// A2 read verify.yml as evidence, so the step that runs them must be in
// scope when verify.yml changes, or the guard cannot run on the PR that
// breaks it.
test('stepTouchedByDiff: a verify.yml diff matches test:hooks via extraFiles', () => {
  assert.equal(
    stepTouchedByDiff(stepByName['test:hooks'], ['.github/workflows/verify.yml']),
    true,
  );
});

test('stepTouchedByDiff: any workflow diff matches test:hooks', () => {
  assert.equal(
    stepTouchedByDiff(stepByName['test:hooks'], ['.github/workflows/cross-os.yml']),
    true,
  );
});

// .husky/** is covered TODAY only by verify.yml's `hooks` bash matcher
// (`^\.husky/`), which A2 deletes. It is an input to NO step — measured:
// stepTouchedByDiff returns [] for all 13 steps. Without this, A2 ships
// defect D again for .husky, on the very PR that fixes it for .github, and
// none of the four wiring assertions can see it (they check key existence
// and job membership, not whether a derived condition still covers what the
// legacy one did). release-manifest.test.mjs:95 reads .husky/pre-commit at
// runtime, so this is a real edge, not a theoretical one.
test('stepTouchedByDiff: a .husky diff matches test:hooks via globs', () => {
  for (const hook of ['.husky/pre-commit', '.husky/pre-push', '.husky/commit-msg']) {
    assert.equal(stepTouchedByDiff(stepByName['test:hooks'], [hook]), true, hook);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/tests/verify-cache.test.mjs`
Expected: FAIL — both new tests, `expected true, got false`.

- [ ] **Step 3: Add the glob to the cache step**

In `scripts/verify-cache.mjs`, the `test:hooks` entry, extend `globs`
(currently `['scripts/**/*.{mjs,cjs}', 'scripts/tests/fixtures/**']`):

```js
      globs: [
        'scripts/**/*.{mjs,cjs}',
        'scripts/tests/fixtures/**',
        /* .github/workflows/** is an input because workflow-wiring.test.mjs
           parses verify.yml at RUNTIME and asserts its `if:` conditions agree
           with ci-scope.mjs's emitted keys. Without this, a workflow-only diff
           — precisely the edit that breaks the wiring — prints [cached] and
           the assertion sits stale-green. Same #1847 trap as fixtures/**
           above (defect D, #2119 review). */
        '.github/workflows/**',
        /* .husky/** is covered TODAY only by verify.yml's `hooks` bash
           matcher, which A2 deletes — and it is an input to no step, so
           without this a .husky-only PR would run zero legs after A2.
           release-manifest.test.mjs reads .husky/pre-commit at runtime
           (plan review round 2). */
        '.husky/**',
      ],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/tests/verify-cache.test.mjs`
Expected: PASS.

- [ ] **Step 5: Close the same hole in cloud**

In `.github/workflows/verify.yml`, extend the `hooks` matcher at `:164`. Add
`\.github/workflows/` as an alternative inside the existing group:

```bash
          match '^(\.husky/|\.github/workflows/|scripts/run-hooks-tests\.mjs$|scripts/validate-commit-msg\.mjs$|RELEASE_NOTES\.md$|docs/release-notes-next\.md$|scripts/release-notes-gate\.mjs$|docs/testing/onbox-acceptance-register\.md$|docs/testing/onbox-acceptance-register-live-view\.html$)' && hooks=true
```

- [ ] **Step 6: Verify the cloud matcher by simulation**

Run:

```bash
echo ".github/workflows/verify.yml" | grep -qE '^(\.husky/|\.github/workflows/|scripts/run-hooks-tests\.mjs$)' && echo "hooks=true"
```

Expected: prints `hooks=true`.

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-cache.mjs scripts/tests/verify-cache.test.mjs .github/workflows/verify.yml
git commit -m "fix(ops): make .github/workflows an input to test:hooks (defect D)"
```

---

### Task 2: Make the sidecar suite collect without torch

Enumerating every module-scope non-stdlib import across all collected
`test_*.py` files yields exactly two absent from
`requirements/base.txt + requirements-dev.txt`: `torch` and `speechbrain`.
Both files already use `pytest.importorskip` elsewhere.

**Files:**
- Modify: `server/tts-sidecar/tests/test_xtts_audio_io.py:15`
- Modify: `server/tts-sidecar/tests/test_speechbrain_disarm.py:37`

**Interfaces:**
- Consumes: nothing.
- Produces: a suite that collects under a lean venv — Task 4 depends on this.

- [ ] **Step 1: Build the lean venv that CI will use**

This is the evidence gate. Static import inspection is what missed
`speechbrain`; it does not get a second chance to be the proof.

```bash
cd server/tts-sidecar
python -m venv .venv-lean
./.venv-lean/bin/python -m pip install -q -r requirements/base.txt -r requirements-dev.txt
```

On Windows use `./.venv-lean/Scripts/python.exe` throughout this task.

- [ ] **Step 2: Run collection to verify it FAILS**

Run: `./.venv-lean/bin/python -m pytest --collect-only -q 2>&1 | tail -20`
Expected: collection errors naming `test_xtts_audio_io.py` (`No module named
'torch'`) and `test_speechbrain_disarm.py` (`No module named 'speechbrain'`).
Exit code 2.

Record the exact error text — it is the "fails before" evidence.

- [ ] **Step 3: Convert both to importorskip**

`server/tts-sidecar/tests/test_xtts_audio_io.py`, replacing line 15's
`import torch`:

```python
# torch is an optional heavy dep: it lives in the vendor overlay, not in
# requirements/base.txt, so the lean CI venv does not have it. Matches this
# file's own pattern for torchaudio/TTS at the test level (see below).
torch = pytest.importorskip("torch")
```

`server/tts-sidecar/tests/test_speechbrain_disarm.py`, replacing line 37's
`from speechbrain.utils.importutils import LazyModule`:

```python
# speechbrain lives in requirements/speaker-qa.txt (NOT base.txt) because it
# pulls torch, so the lean CI venv does not have it. Same treatment as
# test_speaker_embed.py:21.
_sb_importutils = pytest.importorskip("speechbrain.utils.importutils")
LazyModule = _sb_importutils.LazyModule
```

Ensure `import pytest` precedes both (it does in each file; verify).

- [ ] **Step 4: Run collection to verify it PASSES**

Run: `./.venv-lean/bin/python -m pytest --collect-only -q 2>&1 | tail -5`
Expected: exit 0, a collected-tests count, **no errors**.

- [ ] **Step 5: Run the suite under the lean venv**

Run: `./.venv-lean/bin/python -m pytest -q 2>&1 | tail -15`
Expected: exit 0. Tests needing torch/speechbrain report as **skipped**, not
failed. Record the skip count.

- [ ] **Step 6: Confirm nothing regressed on the full venv**

If a bootstrapped `.venv` exists on this box:

Run: `./.venv/bin/python -m pytest -q server/tts-sidecar/tests/test_xtts_audio_io.py server/tts-sidecar/tests/test_speechbrain_disarm.py`
Expected: same pass/fail as before the change — `importorskip` is a no-op
when the module is present.

- [ ] **Step 7: Clean up and commit**

```bash
rm -rf server/tts-sidecar/.venv-lean
git add server/tts-sidecar/tests/test_xtts_audio_io.py server/tts-sidecar/tests/test_speechbrain_disarm.py
git commit -m "test(sidecar): importorskip torch and speechbrain so the suite collects lean"
```

---

### Task 3: Cross-platform sidecar test entry point

`npm run test:sidecar` currently shells to `run-tests.ps1`, which hardcodes
`.venv\Scripts\python.exe` — a layout that can never exist on
`ubuntu-latest`, so the runner would SKIP and exit 0 forever.

**Files:**
- Create: `scripts/run-sidecar-tests.mjs`
- Create: `scripts/tests/run-sidecar-tests.test.mjs`
- Modify: `package.json` (`test:sidecar`)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveVenvPython(sidecarDir, platform)` → absolute path string
  or `null`. Task 4's CI job invokes `npm run test:sidecar`.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/run-sidecar-tests.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVenvPython } from '../run-sidecar-tests.mjs';

function fixture(relPath) {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-'));
  const abs = join(dir, ...relPath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '', 'utf8');
  return dir;
}

test('resolveVenvPython finds the POSIX venv layout', () => {
  const dir = fixture('.venv/bin/python');
  assert.equal(resolveVenvPython(dir, 'linux'), join(dir, '.venv', 'bin', 'python'));
});

test('resolveVenvPython finds the Windows venv layout', () => {
  const dir = fixture('.venv/Scripts/python.exe');
  assert.equal(resolveVenvPython(dir, 'win32'), join(dir, '.venv', 'Scripts', 'python.exe'));
});

test('resolveVenvPython returns null when no venv exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-'));
  assert.equal(resolveVenvPython(dir, 'linux'), null);
});

// A POSIX venv must not be found by the Windows probe and vice versa —
// otherwise the runner would report a venv it cannot execute.
test('resolveVenvPython does not cross platforms', () => {
  const posix = fixture('.venv/bin/python');
  assert.equal(resolveVenvPython(posix, 'win32'), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/tests/run-sidecar-tests.test.mjs`
Expected: FAIL — `Cannot find module '../run-sidecar-tests.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/run-sidecar-tests.mjs`:

```js
#!/usr/bin/env node
// Cross-platform pytest entry point for the TTS sidecar.
//
// Replaces the PowerShell-only path for CI: run-tests.ps1 hardcodes
// .venv\Scripts\python.exe, a Windows layout that can never exist on
// ubuntu-latest — so a CI leg calling it would take the SKIP branch and exit
// 0 forever, i.e. be vacuously green (#2119 review, defect C).
//
// Local behaviour is unchanged: no venv still means SKIP + exit 0, so a
// fresh clone doesn't fail the gate. CI passes --require-venv to turn that
// same condition into a hard failure, because on CI a missing venv means the
// bootstrap broke, not that the developer hasn't run it yet.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIDECAR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'tts-sidecar');

// platform is injected rather than read from process.platform so the layout
// probe is testable on either OS.
export function resolveVenvPython(sidecarDir, platform = process.platform) {
  const rel = platform === 'win32'
    ? ['.venv', 'Scripts', 'python.exe']
    : ['.venv', 'bin', 'python'];
  const candidate = join(sidecarDir, ...rel);
  return existsSync(candidate) ? candidate : null;
}

export function main(argv = process.argv.slice(2), sidecarDir = SIDECAR_DIR) {
  const requireVenv = argv.includes('--require-venv');
  const python = resolveVenvPython(sidecarDir);

  if (!python) {
    const msg = `sidecar pytest -- venv not found under ${sidecarDir}`;
    if (requireVenv) {
      process.stderr.write(`ERROR: ${msg}\n`);
      process.stderr.write('CI runs with --require-venv: a missing venv means the bootstrap step failed.\n');
      return 1;
    }
    process.stdout.write(`\nSKIP: ${msg}\n`);
    process.stdout.write('      Bootstrap once to enable this block in the gate:\n');
    process.stdout.write('        cd server/tts-sidecar\n');
    process.stdout.write('        python -m venv .venv\n');
    process.stdout.write('        .venv/bin/python -m pip install -r requirements.txt -r requirements-dev.txt\n\n');
    return 0;
  }

  // run-tests.ps1 also probes for pytest itself and SKIPs when a venv exists
  // but requirements-dev.txt was never installed. Without this, that box goes
  // from green-skip to RED on `npm run verify` and pre-push — a regression
  // dressed up as "local behaviour is unchanged".
  const probe = spawnSync(python, ['-m', 'pytest', '--version'], { encoding: 'utf8' });
  if ((probe.status ?? 1) !== 0) {
    const msg = 'sidecar pytest -- venv present but pytest is not installed';
    if (requireVenv) {
      process.stderr.write(`ERROR: ${msg}\n`);
      return 1;
    }
    process.stdout.write(`\nSKIP: ${msg}\n`);
    process.stdout.write('        .venv/bin/python -m pip install -r requirements-dev.txt\n\n');
    return 0;
  }

  // -m "not golden" mirrors the existing runner: the opt-in golden-audio tier
  // must never load a model here. `--tb=short -q` and the explicit tests/ path
  // also mirror it, so output is comparable to the PowerShell runner's.
  const passthrough = argv.filter((a) => a !== '--require-venv');
  const result = spawnSync(
    python,
    ['-m', 'pytest', '-m', 'not golden', '--tb=short', '-q', 'tests', ...passthrough],
    { cwd: sidecarDir, stdio: 'inherit' },
  );
  if (result.error) {
    process.stderr.write(`run-sidecar-tests: failed to spawn python: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

// Direct-execution guard. MUST use pathToFileURL: the naive
// `file://${process.argv[1]}` form yields two slashes on Windows
// (file://C:/...) where import.meta.url has three (file:///C:/...), so it is
// ALWAYS false there — the script would silently do nothing and exit 0.
// Every other script in scripts/ uses this form; see bump-version.mjs:654.
const invokedHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  process.exit(main());
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/tests/run-sidecar-tests.test.mjs`
Expected: PASS, 4/4.

- [ ] **Step 4b: Prove the entry point actually EXECUTES**

The unit tests import `resolveVenvPython` and would pass even if the script
never ran anything. Verify the guard directly:

```bash
node scripts/run-sidecar-tests.mjs
```

Expected: either the pytest output or the SKIP banner — **never silence**.
Silence means the direct-execution guard is false and the runner is
vacuously green, which is precisely the defect this task exists to remove.

- [ ] **Step 5: Rewire the npm script**

In `package.json`, change `test:sidecar` from the `run-powershell.mjs` form
to:

```json
    "test:sidecar": "node scripts/run-sidecar-tests.mjs",
```

- [ ] **Step 5b: Keep `test:sidecar`'s own cache inputs honest**

`verify-cache.mjs`'s `test:sidecar` step declares
`extraFiles: ['server/tts-sidecar/run-tests.ps1']`. After the rewire above,
the runner that actually executes is `scripts/run-sidecar-tests.mjs` — so
without this the step sits in the exact #1847 trap this whole plan is about:
editing the runner would leave `test:sidecar` printing `[cached]`.

```js
      extraFiles: [
        'server/tts-sidecar/run-tests.ps1',
        // The npm script now invokes this instead; run-tests.ps1 is retained
        // for direct local/PowerShell use, so BOTH are inputs.
        'scripts/run-sidecar-tests.mjs',
      ],
```

Verify:

```bash
node -e "import('./scripts/verify-cache.mjs').then(({STEPS,stepTouchedByDiff})=>{const s=STEPS.find(x=>x.name==='test:sidecar');console.log(stepTouchedByDiff(s,['scripts/run-sidecar-tests.mjs']));})"
```

Expected: `true`.

- [ ] **Step 6: Verify local behaviour is unchanged**

Run: `npm run test:sidecar`
Expected: on a box with a bootstrapped venv, the suite runs. On one without,
a SKIP banner and exit 0 — same as before.

- [ ] **Step 7: Commit**

```bash
git add scripts/run-sidecar-tests.mjs scripts/tests/run-sidecar-tests.test.mjs package.json
git commit -m "feat(ops): cross-platform sidecar pytest entry point"
```

---

### Task 4: Wire the sidecar job into CI *and* into the gate

**Files:**
- Modify: `.github/workflows/verify.yml` (new job + aggregator `needs:`)

**Interfaces:**
- Consumes: `npm run test:sidecar --require-venv` from Task 3; the lean-collect
  guarantee from Task 2.
- Produces: a `sidecar-tests` job that A2's ↑ assertion will check.

- [ ] **Step 1: Add the job**

Insert after the `server-tests` job in `.github/workflows/verify.yml`:

```yaml
  sidecar-tests:
    name: Sidecar tests (pytest)
    needs: detect
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      # Every other job uses this; without it this job relies on whatever Node
      # ubuntu-latest happens to ship and pins no version. `npm run
      # test:sidecar` needs Node but no node_modules, so the composite's
      # `npm ci` is cheap insurance rather than a requirement.
      - name: Setup Node + deps
        uses: ./.github/actions/setup

      - name: Setup Python
        if: needs.detect.outputs.sidecar == 'true' || needs.detect.outputs.shared == 'true'
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: pip

      # The LEAN dependency set only: requirements/base.txt is vendor-neutral
      # (fastapi/uvicorn/numpy/psutil) and requirements-dev.txt is pytest +
      # httpx. The heavy ML stack (torch, coqui-tts, speechbrain) lives in the
      # vendor overlay and speaker-qa.txt and is deliberately NOT installed —
      # tests needing it use pytest.importorskip and report as skipped.
      - name: Bootstrap sidecar venv
        if: needs.detect.outputs.sidecar == 'true' || needs.detect.outputs.shared == 'true'
        run: |
          cd server/tts-sidecar
          python -m venv .venv
          .venv/bin/python -m pip install --upgrade pip
          .venv/bin/python -m pip install -r requirements/base.txt -r requirements-dev.txt

      # --require-venv turns "no venv" from a SKIP into a hard failure: on CI a
      # missing venv means the bootstrap above broke. Without it this leg would
      # be vacuously green, which is worse than the hole it closes (#2119
      # review, defect C).
      - name: Sidecar tests
        if: needs.detect.outputs.sidecar == 'true' || needs.detect.outputs.shared == 'true'
        run: npm run test:sidecar -- --require-venv
```

- [ ] **Step 2: Add it to the aggregator's `needs:`**

`verify.yml:435`. A job absent from this list can run, fail, and **not block
merge**, because the ruleset requires only this aggregator's context.

```yaml
    needs: [lint-and-checks, frontend-tests, server-tests, sidecar-tests, e2e, e2e-visual, build]
```

- [ ] **Step 3: Verify the workflow parses**

Run: `node -e "const y=require('js-yaml');const f=require('fs');const d=y.load(f.readFileSync('.github/workflows/verify.yml','utf8'));console.log(Object.keys(d.jobs));console.log('aggregator needs:',d.jobs.verify.needs);"`

Expected: `sidecar-tests` appears in the job list **and** in the aggregator's
needs array.

If `js-yaml` is unavailable, use `npx --yes js-yaml .github/workflows/verify.yml > /dev/null && echo "parses"`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/verify.yml
git commit -m "feat(ops): add a sidecar pytest leg that can actually fail"
```

- [ ] **Step 5: Open PR A1**

```bash
git push -u origin fix/ops-verify-scope-github-and-sidecar
gh pr create --title "fix(ops): close the .github scope hole and add a real sidecar leg" --body "$(cat <<'EOF'
## Summary

Two purely additive fixes, neither of which changes how scope is computed.

- **Defect D** — `.github/workflows/**` matched no scope at all, so a
  workflow-only PR ran zero legs, in cloud and locally. It is now an input to
  `test:hooks` and matches the `hooks` scope.
- **Defect C** — `verify.yml` had no sidecar pytest leg. Adds one that can
  genuinely fail: a cross-platform entry point, a lean venv bootstrap, and
  `--require-venv` so a broken bootstrap is red rather than a silent SKIP.
  Two tests gain `pytest.importorskip` so the suite collects without torch.

Landing this first de-circularises PR A2: with `.github/**` in scope, A2's
wiring assertions actually run on A2's own PR.

## Test plan

- `node --test scripts/tests/verify-cache.test.mjs` — two new scope tests
- `node --test scripts/tests/run-sidecar-tests.test.mjs` — 4 layout tests
- `pytest --collect-only` under a `base.txt + requirements-dev.txt` venv:
  exits 0 (was exit 2, two collection errors)

Refs #2119

Design: `docs/superpowers/specs/2026-08-05-verify-scope-map-unification-design.md`
EOF
)"
```

- [ ] **Step 6: Confirm the sidecar leg actually gates (mutation M13)**

On the PR, temporarily break a sidecar test (e.g. `assert False` in
`test_smoke.py`), push, and confirm the **`npm run verify` context** — not
merely the `sidecar-tests` job — reports red. Revert the break before merge.

Record the observed context name. Watching the job's own status instead is
the exact confusion the ↑ assertion exists to prevent.

---

# PHASE A2 — the derivation (Closes #2119)

Branch: `feat/ops-verify-scope-derivation`, cut from `main` after A1 merges.

---

### Task 5: `scripts/ci-scope.mjs`

**Files:**
- Create: `scripts/ci-scope.mjs`
- Create: `scripts/tests/ci-scope.test.mjs`

**Interfaces:**
- Consumes: `STEPS`, `stepTouchedByDiff`, `computeShared` from
  `./verify-cache.mjs`.
- Produces:
  - `slugFor(stepName)` → string, e.g. `test:e2e:visual` → `step_test_e2e_visual`
  - `computeScopes(files, { eventName })` → `{ [key: string]: boolean }`
  - `render(scopes)` → string in `GITHUB_OUTPUT` format
  - `main(argv, env)` → exit code number

- [ ] **Step 1: Write the failing tests**

Create `scripts/tests/ci-scope.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugFor, computeScopes, render } from '../ci-scope.mjs';
import { STEPS } from '../verify-cache.mjs';

test('slugFor converts a step name to an output key', () => {
  assert.equal(slugFor('test:hooks'), 'step_test_hooks');
  assert.equal(slugFor('test:e2e:visual'), 'step_test_e2e_visual');
  assert.equal(slugFor('config:check'), 'step_config_check');
});

test('computeScopes emits a key for every STEP plus openapi, shared and ok', () => {
  const scopes = computeScopes(['src/app.tsx'], { eventName: 'pull_request' });
  for (const step of STEPS) {
    assert.ok(slugFor(step.name) in scopes, `missing ${slugFor(step.name)}`);
  }
  assert.ok('openapi' in scopes);
  assert.ok('shared' in scopes);
});

// #2119's four cited paths. Each previously ran no leg that covers it.
for (const path of [
  'launch.mjs',
  'server/tts-sidecar/scripts/install-qwen3.mjs',
  'pinokio.js',
  'eslint.config.mjs',
]) {
  test(`computeScopes routes ${path} to test:hooks`, () => {
    const scopes = computeScopes([path], { eventName: 'pull_request' });
    assert.equal(scopes.step_test_hooks, true, `${path} must run test:hooks`);
  });
}

// Defect D.
test('computeScopes routes a workflow diff to test:hooks', () => {
  const scopes = computeScopes(['.github/workflows/verify.yml'], { eventName: 'pull_request' });
  assert.equal(scopes.step_test_hooks, true);
});

// A root lockfile touches ZERO steps via stepTouchedByDiff — computeShared is
// a separate global override. Without `shared`, a dependency bump runs nothing.
test('computeScopes sets shared for a root lockfile diff', () => {
  const scopes = computeScopes(['package-lock.json'], { eventName: 'pull_request' });
  assert.equal(scopes.shared, true);
});

// workflow_dispatch has no PR base to diff. An empty file list is not an
// error, so the fail-safe does not fire — without this branch the documented
// clean-room full-battery run becomes a green no-op.
test('computeScopes emits all-true for workflow_dispatch', () => {
  const scopes = computeScopes([], { eventName: 'workflow_dispatch' });
  for (const [key, value] of Object.entries(scopes)) {
    assert.equal(value, true, `${key} must be true on workflow_dispatch`);
  }
});

test('computeScopes is all-false for an unrelated diff on a PR', () => {
  const scopes = computeScopes(['README.md'], { eventName: 'pull_request' });
  assert.equal(scopes.step_test_hooks, false);
  assert.equal(scopes.shared, false);
});

test('render emits GITHUB_OUTPUT lines plus the ok sentinel', () => {
  const out = render({ step_test_hooks: true, shared: false });
  assert.match(out, /^scopes=\{.*\}$/m);
  assert.match(out, /^ok=true$/m);
  const json = JSON.parse(out.match(/^scopes=(.*)$/m)[1]);
  assert.equal(json.step_test_hooks, true);
  assert.equal(json.shared, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/tests/ci-scope.test.mjs`
Expected: FAIL — `Cannot find module '../ci-scope.mjs'`.

- [ ] **Step 3: Implement**

Create `scripts/ci-scope.mjs`:

```js
#!/usr/bin/env node
// Derive per-step CI scope from verify-cache.mjs's STEPS[] — the single
// source of truth for "which files does this step depend on".
//
// Emits ONE json output rather than one output per step. GitHub requires
// every consumed output to be re-declared in the detect job's static
// `outputs:` map (there is no wildcard), so per-step outputs would make that
// map a THIRD artifact in the derivation chain: a key emitted here and
// consumed by an `if:` but missing from that map evaluates to the empty
// string, silently disabling a leg while both wiring directions still pass.
// One json output makes that map a single static line.

import { pathToFileURL } from 'node:url';
import { STEPS, stepTouchedByDiff, computeShared } from './verify-cache.mjs';

export function slugFor(stepName) {
  return `step_${stepName.replace(/[:-]/g, '_')}`;
}

// openapi gates the CI-only "OpenAPI types up to date" drift check and has no
// cache step. shared is the root-manifest global override.
const CI_ONLY = {
  openapi: (files) => files.some((f) => f === 'openapi.yaml'),
  shared: (files) => computeShared(files),
};

export function computeScopes(files, { eventName } = {}) {
  const keys = [...STEPS.map((s) => slugFor(s.name)), ...Object.keys(CI_ONLY)];

  // A manual dispatch has no PR base to diff against, so `files` is empty —
  // which is NOT an error and therefore does not trip the fail-safe. Run the
  // full battery, matching the behaviour the bash detector had.
  if (eventName === 'workflow_dispatch') {
    return Object.fromEntries(keys.map((k) => [k, true]));
  }

  const shared = computeShared(files);
  const scopes = {};
  for (const step of STEPS) {
    // `shared` is a disjunct on EVERY step: stepTouchedByDiff has a lockfile
    // branch for server/package-lock.json only — a ROOT lockfile diff touches
    // zero steps, so without this a dependency bump would run nothing.
    scopes[slugFor(step.name)] = shared || stepTouchedByDiff(step, files);
  }
  for (const [key, fn] of Object.entries(CI_ONLY)) {
    scopes[key] = key === 'shared' ? shared : shared || fn(files);
  }
  return scopes;
}

export function render(scopes) {
  return `scopes=${JSON.stringify(scopes)}\nok=true\n`;
}

function allTrue() {
  const keys = [...STEPS.map((s) => slugFor(s.name)), ...Object.keys(CI_ONLY)];
  return Object.fromEntries(keys.map((k) => [k, true]));
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let output;
  try {
    const files = (argv.find((a) => a.startsWith('--files='))?.slice('--files='.length) ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    output = render(computeScopes(files, { eventName: env.GITHUB_EVENT_NAME }));
  } catch (err) {
    // FAIL SAFE: degrade to "run the whole battery", never to "skip
    // everything". A crash here must not be able to produce a green required
    // check that ran nothing.
    process.stderr.write(`ci-scope: FAILED (${err?.message}) — emitting all-true\n`);
    output = render(allTrue());
  }
  process.stdout.write(output);
  return 0;
}

// See run-sidecar-tests.mjs — the naive `file://${process.argv[1]}` form is
// ALWAYS false on Windows (two slashes vs three). Here the consequence is
// worse than silence: the detect job would emit nothing, every `if:` would be
// false, and only the `ok` sentinel (Task 9) would catch it — as a confusing
// red rather than a clear one.
const invokedHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  process.exit(main());
}
```

- [ ] **Step 4: Run to verify pass, and that it EXECUTES**

Run: `node --test scripts/tests/ci-scope.test.mjs`
Expected: PASS, all tests.

Run: `node scripts/ci-scope.mjs --files=launch.mjs`
Expected: two lines — `scopes={...}` and `ok=true`. **Silence means the
direct-execution guard is broken**; the unit tests cannot catch that because
they import `computeScopes` directly.

- [ ] **Step 5: Prove the fail-safe (mutation M10)**

Add to `scripts/tests/ci-scope.test.mjs`:

```js
import { main } from '../ci-scope.mjs';

// M10: a thrown error must degrade to all-true + exit 0 — never to all-false
// and never to a non-zero exit. A crash that skipped every leg would produce
// a green required check that ran nothing, which is the whole failure class
// this design exists to close.
//
// Trigger: passing a non-array as argv makes `argv.find(...)` throw a
// TypeError inside the try block. In-process, no subprocess needed.
test('main fails SAFE: all-true and exit 0 when computation throws', () => {
  const chunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  process.stderr.write = () => true;

  let code;
  try {
    code = main({}, {});
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  assert.equal(code, 0, 'must exit 0');
  const out = chunks.join('');
  assert.match(out, /^ok=true$/m);
  const json = JSON.parse(out.match(/^scopes=(.*)$/m)[1]);
  assert.ok(Object.keys(json).length > 0, 'must emit keys, not an empty object');
  assert.ok(
    Object.values(json).every(Boolean),
    'every key must be true — degrading to all-FALSE would skip every leg',
  );
});
```

- [ ] **Step 5b: Prove the fail-safe is not a placebo**

Run: `node --test scripts/tests/ci-scope.test.mjs`
Expected: PASS.

Then temporarily replace the `catch` body in `ci-scope.mjs` with
`throw err;`.

Run again. Expected: **RED**. Restore.

If it stays green, the test never reached the catch — fix the trigger before
proceeding.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci-scope.mjs scripts/tests/ci-scope.test.mjs
git commit -m "feat(ops): derive per-step CI scope from verify-cache STEPS"
```

---

### Task 6: Rewire `verify.yml`'s detect job

**Files:**
- Modify: `.github/workflows/verify.yml:90-180`

**Interfaces:**
- Consumes: `scripts/ci-scope.mjs` from Task 5.
- Produces: `needs.detect.outputs.scopes` (JSON string) and
  `needs.detect.outputs.ok` for Tasks 7 and 9.

- [ ] **Step 1: Replace the outputs block**

`verify.yml:94-103` — nine hand-declared outputs become two:

```yaml
    outputs:
      # ONE json blob rather than one output per step: GitHub has no wildcard
      # for this map, so per-step outputs would be a third artifact that can
      # silently drift from the emitted keys. Consumed via fromJSON below.
      scopes: ${{ steps.changes.outputs.scopes }}
      # Sentinel: proves ci-scope.mjs actually ran and wrote. The aggregator
      # asserts this, catching the case where detect SUCCEEDS having written
      # nothing — every `if:` false, every job green, required check green
      # having run nothing.
      ok: ${{ steps.changes.outputs.ok }}
```

- [ ] **Step 2: Replace the WHOLE detection step body**

Not just the `match()` block. `verify.yml:115-123` has a **separate
`workflow_dispatch` early-exit** that emits the nine legacy scope names and
`exit 0`s. Leaving it in place means a manual dispatch emits no `scopes` and
no `ok` at all — so `fromJSON('')` raises in every `if:` **and** Task 9's
sentinel fails, turning the documented clean-room full-battery run
permanently red. `ci-scope.mjs` already handles dispatch (all-true), so the
bash branch must go.

But the `git merge-base` / `git diff` lines below it would then run on a
dispatch with empty `BASE`/`HEAD` and fail under `set -e`. Guard them.
Replace the `run:` body — **`:114` through `:180`**. Not `:113`: that line is
`        id: changes`, and deleting it removes the step id that
`steps.changes.outputs.*` resolves through, so both outputs would silently
resolve empty. (Task 9's sentinel catches it — fail-closed — but as a
red run costing a debugging cycle rather than an obvious error.)

```yaml
        run: |
          # A manual dispatch has no PR base/head to diff against. Leave FILES
          # empty and let ci-scope.mjs branch on GITHUB_EVENT_NAME — it emits
          # all-true for a dispatch, matching the old bash early-exit.
          FILES=""
          if [ "${{ github.event_name }}" != "workflow_dispatch" ]; then
            BASE="${{ github.event.pull_request.base.sha }}"
            HEAD="${{ github.event.pull_request.head.sha }}"
            # Merge-base, not BASE itself: a PR branch created from a stale
            # main would otherwise treat every file main moved past the fork
            # point as "changed in this PR".
            MERGE_BASE="$(git merge-base "$BASE" "$HEAD" 2>/dev/null || echo "$BASE")"
            FILES="$(git diff --name-only "$MERGE_BASE" "$HEAD")"
          fi
          echo "Changed files in this PR:"
          echo "$FILES"
          echo "---"
          node scripts/ci-scope.mjs --files="$FILES" >> "$GITHUB_OUTPUT"
          echo "--- derived scope ---"
          node scripts/ci-scope.mjs --files="$FILES"
```

`GITHUB_EVENT_NAME` is set by the runner automatically, so `ci-scope.mjs`
reads it without it being passed explicitly.

- [ ] **Step 3: Ensure Node is available in detect**

The `detect` job currently has no Node setup (the bash matcher needed none).
Add before the detection step:

```yaml
      - name: Setup Node + deps
        uses: ./.github/actions/setup
```

- [ ] **Step 4: Verify locally against a simulated diff**

Run:

```bash
node scripts/ci-scope.mjs --files="$(printf 'launch.mjs')"
```

Expected: a `scopes=` line whose JSON has `"step_test_hooks":true`, and
`ok=true`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/verify.yml
git commit -m "feat(ops): detect job derives scope via ci-scope.mjs"
```

---

### Task 7: Convert every `if:` to the derived form

**Files:**
- Modify: `.github/workflows/verify.yml` (all ~20 `if:` sites)

**Interfaces:**
- Consumes: `needs.detect.outputs.scopes`.
- Produces: the `fromJSON(...).<key>` reference syntax Task 8 asserts on.

- [ ] **Step 1: Convert the leg conditions**

Mechanical, one per site. `shared` stays a disjunct everywhere. Examples —
apply the same shape to every `if:`:

```yaml
      # Lint (was: frontend || server || scripts || shared)
      - name: Lint
        if: fromJSON(needs.detect.outputs.scopes).step_lint || fromJSON(needs.detect.outputs.scopes).shared

      # Hooks tests (was: hooks || scripts || shared)
      - name: Hooks tests
        if: fromJSON(needs.detect.outputs.scopes).step_test_hooks || fromJSON(needs.detect.outputs.scopes).shared

      # Server tests — test:server AND test:server-slow share this one step,
      # so the condition is the union of both steps' keys.
      # leg: test:server
      - name: Server tests (fast + slow)
        if: fromJSON(needs.detect.outputs.scopes).step_test_server || fromJSON(needs.detect.outputs.scopes).step_test_server_slow || fromJSON(needs.detect.outputs.scopes).shared
```

**Every leg step gets a `# leg: <step-name>` marker** immediately above its
`- name:`. Task 8's setup-binding assertion identifies legs by that marker,
not by searching for the first `if:` mentioning a key — setup steps precede
their leg in file order, and slugs nest (`step_test` is a substring of
`step_test_hooks`), so both heuristics bind the wrong step.

**Do not hoist any of these to job level** (Global Constraints).

- [ ] **Step 1b: Decide the `frontend-tests` condition explicitly**

This one is not mechanical and the spec flags it as an N:M irregularity
without resolving it. The step runs `vitest --changed` **plus**
`npm run test:a11y` — so it is not `npm run test`, and `test:a11y` has no
STEP of its own. Its current condition is
`frontend || e2e || shared || openapi`.

Measured: `stepTouchedByDiff(STEPS['test'], ['e2e/foo.spec.ts'])` is
**false**, so a naive `step_test || shared` would stop running the frontend
unit suite and a11y on an e2e-spec-only PR — a silent narrowing of what runs
today. `openapi.yaml` needs no special handling: it is already in `test`'s
`extraFiles`, so `step_test` covers it.

Preserve today's behaviour explicitly rather than narrowing by accident:

**`# leg:` must be the LAST comment line before `- name:`.** Task 8's regex
is `# leg: X\n\s*- name:`, and `\s*` does not span other comment lines — an
earlier draft of this very snippet put four comment lines in between, so
`# leg: test` matched nothing and the leg silently vanished from the binding
map. Put explanatory prose *above* the marker:

```yaml
      # test:e2e is a deliberate extra trigger: this step also runs
      # `npm run test:a11y`, which has no STEP of its own, and an e2e-only
      # diff should still exercise the a11y battery. Dropping it would be a
      # silent narrowing of what runs today.
      # leg: test
      - name: Frontend tests + a11y
        if: fromJSON(needs.detect.outputs.scopes).step_test || fromJSON(needs.detect.outputs.scopes).step_test_e2e || fromJSON(needs.detect.outputs.scopes).shared
```

- [ ] **Step 2: Bind each setup step to the leg it supports**

Seven `if:`-bearing steps are setup, not legs (3× Install ffmpeg, 2× Cache
Playwright, 2× Install Playwright). Each gets a machine-readable declaration
immediately above its `if:`, and its condition must be **string-identical**
to that leg's:

```yaml
      # supports: test:e2e
      - name: Install ffmpeg
        if: fromJSON(needs.detect.outputs.scopes).step_test_e2e || fromJSON(needs.detect.outputs.scopes).shared
```

If the Playwright cache/install condition and the e2e run condition diverge,
e2e runs without a browser. Task 8 asserts they cannot.

- [ ] **Step 3: Verify the workflow still parses and references resolve**

Run:

```bash
npx --yes js-yaml .github/workflows/verify.yml > /dev/null && echo "parses"
grep -c "needs.detect.outputs.scopes" .github/workflows/verify.yml
grep -c "needs.detect.outputs\.\(frontend\|server\|sidecar\|e2e\|scripts\|hooks\|pinokio\|openapi\)" .github/workflows/verify.yml
```

Expected: `parses`; a non-zero count for the first grep; **0** for the second
(no legacy scope references left).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/verify.yml
git commit -m "feat(ops): gate every verify leg on the derived scope map"
```

---

### Task 8: The four wiring assertions

**Files:**
- Create: `scripts/tests/workflow-wiring.test.mjs`

**Interfaces:**
- Consumes: `computeScopes`, `slugFor` (Task 5); the parsed `verify.yml`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing tests**

Create `scripts/tests/workflow-wiring.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeScopes, slugFor } from '../ci-scope.mjs';
import { STEPS } from '../verify-cache.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = resolve(repoRoot, '.github', 'workflows', 'verify.yml');
const source = readFileSync(workflowPath, 'utf8');

// Every key ci-scope.mjs can emit.
const emitted = new Set(Object.keys(computeScopes([], { eventName: 'pull_request' })));

// Every key the workflow references. Pinned to the dotted fromJSON form the
// workflow actually uses; a bracket or contains() form would slip this regex,
// so the anti-vacuity floor below is what catches a syntax change.
const referenced = [...source.matchAll(/fromJSON\(needs\.detect\.outputs\.scopes\)\.([A-Za-z0-9_]+)/g)]
  .map((m) => m[1]);

test('anti-vacuity: the workflow scan finds references', () => {
  // UNITS: this counts REFERENCES, not `if:` sites — and the two are not
  // convertible. This floor has now been wrong TWICE for that reason:
  //   * 20, reasoned from "~20 if: sites" (the regex counts references);
  //   * 50, reasoned as 55 pre-derivation refs + 6 for A1's sidecar job —
  //     which assumes conversion preserves refs-per-site. It does not. The
  //     pre-derivation workflow averages 2.9 refs/site because legacy scope
  //     names are broader; every derived site is exactly 2 (3 for the two
  //     union sites). Constructed post-A2: 23 sites, **49 references** —
  //     BELOW the old floor of 50, i.e. guaranteed spurious red.
  // Floor 35 gives ~29% headroom under 49. Re-measure against the real
  // workflow once Task 7 is done rather than trusting this number.
  assert.ok(
    referenced.length >= 35,
    `expected >= 35 fromJSON references, found ${referenced.length} — either the regex broke or the workflow lost wiring`,
  );
});

// -> direction: no reference to a key that is never emitted. GitHub resolves
// an unknown reference to the empty string, so a typo'd key silently disables
// a leg on the REQUIRED check while everything reports green.
test('-> every referenced scope key is emitted by ci-scope.mjs', () => {
  const unknown = [...new Set(referenced)].filter((k) => !emitted.has(k));
  assert.deepEqual(unknown, [], `workflow references key(s) ci-scope.mjs never emits:\n${unknown.join('\n')}`);
});

// <- direction: no emitted key is orphaned. This is defect C's shape — a
// verify-cache STEP with no CI home at all.
test('<- every emitted scope key is referenced by the workflow', () => {
  const refSet = new Set(referenced);
  const orphaned = [...emitted].filter((k) => !refSet.has(k));
  assert.deepEqual(orphaned, [], `emitted key(s) no workflow condition uses:\n${orphaned.join('\n')}`);
});

// ^ direction: a job carrying a derived if: but absent from the aggregator's
// needs: can run, FAIL, and not block merge — main's ruleset pins only the
// aggregator's context ('npm run verify'). The <- direction would still
// certify its key as wired.
test('^ every job with a derived condition is in the aggregator needs:', () => {
  const jobBlocks = [...source.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\n)*)/gm)];
  const aggregator = jobBlocks.find(([, name]) => name === 'verify');
  assert.ok(aggregator, 'aggregator job `verify` not found');
  const needs = (aggregator[2].match(/needs:\s*\[([^\]]*)\]/) ?? [, ''])[1]
    .split(',').map((s) => s.trim()).filter(Boolean);

  const missing = [];
  for (const [, name, body] of jobBlocks) {
    if (name === 'verify' || name === 'detect') continue;
    if (!/fromJSON\(needs\.detect\.outputs\.scopes\)/.test(body)) continue;
    if (!needs.includes(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], `job(s) with derived conditions missing from the aggregator's needs:\n${missing.join('\n')}`);
});

// Setup steps (ffmpeg, Playwright cache/install) are not legs. Each declares
// the leg it supports; its condition must be identical to that leg's, or e2e
// runs without a browser.
// The set of scope keys a condition depends on, order-independent. Compared
// instead of the raw string because a setup step legitimately carries extra
// NON-scope conjuncts: verify.yml's two "Install Playwright chromium" steps
// are `(...scopes...) && steps.playwright-cache.outputs.cache-hit != 'true'`,
// which can never be string-identical to the leg's condition. An earlier
// draft compared whole strings and would have instructed the implementer to
// delete a correct cache guard.
const scopeKeysOf = (condition) =>
  [...condition.matchAll(/fromJSON\(needs\.detect\.outputs\.scopes\)\.([A-Za-z0-9_]+)/g)]
    .map((m) => m[1])
    .sort()
    .join('|');

test('setup steps depend on the same scope keys as the leg they support', () => {
  // Legs are tagged explicitly rather than found by "first step whose if:
  // mentions this key". That heuristic is wrong twice over: setup steps
  // PRECEDE their leg in every job (Install ffmpeg :345 before E2E :363), so
  // first-match returns another setup step; and slugs nest
  // (step_test is a substring of step_test_hooks / step_test_e2e;
  // step_test_server of step_test_server_slow), so a substring match binds
  // the wrong leg entirely.
  const legs = new Map(
    [...source.matchAll(/# leg: ([a-z:0-9-]+)\n\s*- name: [^\n]+\n\s*if: ([^\n]+)\n/g)]
      .map(([, leg, condition]) => [leg, condition.trim()]),
  );
  const setups = [...source.matchAll(
    /# supports: ([a-z:0-9-]+)\n\s*- name: ([^\n]+)\n\s*if: ([^\n]+)\n/g,
  )];

  // 9, not 7: A1 adds two more if:-bearing setup steps (Setup Python,
  // Bootstrap sidecar venv) on top of the original 3x Install ffmpeg,
  // 2x Cache Playwright, 2x Install Playwright. The plan's prose said seven
  // because it was written pre-A1 — a stale constant carried across a phase
  // boundary. Re-count after Task 7 rather than trusting either number.
  assert.ok(setups.length >= 9, `expected >= 9 '# supports:' declarations, found ${setups.length}`);
  assert.ok(legs.size >= 11, `expected >= 11 '# leg:' declarations, found ${legs.size}`);

  const mismatched = [];
  for (const [, leg, stepName, condition] of setups) {
    const expected = legs.get(leg);
    if (!expected) { mismatched.push(`${stepName}: no '# leg: ${leg}' declaration found`); continue; }
    if (scopeKeysOf(condition) !== scopeKeysOf(expected)) {
      mismatched.push(
        `${stepName}\n  supports: ${leg}\n  has keys:      ${scopeKeysOf(condition) || '(none)'}\n  leg has keys:  ${scopeKeysOf(expected) || '(none)'}`,
      );
    }
  }
  assert.deepEqual(mismatched, [], `setup step(s) diverged from their leg:\n${mismatched.join('\n')}`);
});
```

- [ ] **Step 1b: The coverage-parity assertion (the fifth, and the one that matters most)**

The four assertions above check *wiring* — that keys exist, are referenced,
and live in gated jobs. **None of them checks that a derived condition still
covers what the legacy condition covered.** That is a different property, and
it is the one the derivation actually puts at risk: legacy bash matchers are
broader than the `STEPS[]` inputs replacing them. Measured across a probe
corpus, **8 of 12 sites narrow**, including `.husky/**` losing coverage
entirely (fixed in Task 1) and `openapi.yaml` no longer triggering Typecheck.

Some narrowings are correct — Pester should not run on a non-PowerShell diff.
The defect is having no record of which are intended and no guard against the
next one. Add to `scripts/tests/workflow-wiring.test.mjs`:

```js
// Replays the PRE-derivation scope matchers against the POST-derivation
// conditions over a fixed corpus. Every path that used to run a leg must
// still run it, unless the narrowing is listed and justified below.
//
// This is the only assertion that can see a coverage regression; the other
// four are blind to it by construction.
const LEGACY_MATCHERS = {
  frontend: /^(src\/|index\.html$|vite\.config\.ts$|tailwind\.config\.ts$|tsconfig\.json$|tsconfig\.node\.json$|postcss\.config\.js$|eslint\.config\.(js|mjs)$)/,
  server: /^(server\/src\/|server\/package(-lock)?\.json$|server\/tsconfig\.json$|server\/vitest\.config(\.slow)?\.ts$|openapi\.yaml$|server\/\.env\.example$|server\/scripts\/sync-env-example\.ts$|scripts\/tests\/fixtures\/)/,
  sidecar: /^server\/tts-sidecar\//,
  e2e: /^(e2e\/|playwright\.config\.ts$)/,
  scripts: /^scripts\//,
  hooks: /^(\.husky\/|\.github\/workflows\/|scripts\/run-hooks-tests\.mjs$|scripts\/validate-commit-msg\.mjs$|RELEASE_NOTES\.md$|docs\/release-notes-next\.md$|scripts\/release-notes-gate\.mjs$|docs\/testing\/onbox-acceptance-register\.md$|docs\/testing\/onbox-acceptance-register-live-view\.html$)/,
  pinokio: /^(pinokio\.js$|pinokio-scripts\/|scripts\/run-pinokio-tests\.mjs$)/,
  openapi: /^openapi\.yaml$/,
};

// Legacy step name -> the scopes that used to gate it, from git history of
// verify.yml immediately before A2. Copy these from the pre-A2 file; do not
// re-derive them from memory.
const LEGACY_GATES = {
  'Lint': ['frontend', 'server', 'scripts'],
  'Typecheck': ['frontend', 'server'],
  'Config check': ['server'],
  'Hooks tests': ['hooks', 'scripts'],
  'PowerShell-helper tests (Pester)': ['scripts'],
  'Pinokio tests': ['pinokio'],
  'Frontend tests + a11y': ['frontend', 'e2e', 'openapi'],
  'Server tests (fast + slow)': ['server', 'sidecar'],
  'E2E (chromium)': ['frontend', 'e2e'],
  'E2E visual baselines (chromium)': ['frontend', 'e2e'],
  'Build': ['frontend', 'server'],
};

// Narrowings judged CORRECT. Each needs a reason — an unexplained entry here
// is how a real regression gets waved through.
const ACCEPTED_NARROWINGS = [
  // [step name, path, why it is right to stop running]
  ['PowerShell-helper tests (Pester)', 'scripts/ci-scope.mjs',
   'Pester covers scripts/lib/*.ps1 only; a .mjs change cannot affect it'],
  ['Server tests (fast + slow)', 'server/tts-sidecar/main.py',
   'server TS suite mocks the sidecar; a sidecar-only diff runs pytest instead'],
];

const PROBE_CORPUS = [
  'src/app.tsx', 'index.html', 'tailwind.config.ts', 'tsconfig.json',
  'eslint.config.mjs', 'vite.config.ts', 'openapi.yaml',
  'server/src/tts/mp3.ts', 'server/package.json', 'server/tts-sidecar/main.py',
  'e2e/smoke.spec.ts', 'playwright.config.ts',
  'scripts/ci-scope.mjs', 'scripts/lib/log.ps1', 'scripts/tests/fixtures/x.json',
  '.husky/pre-commit', '.github/workflows/verify.yml',
  'pinokio.js', 'pinokio-scripts/lib/menu.js',
  'launch.mjs', 'server/tts-sidecar/scripts/install-qwen3.mjs',
  'RELEASE_NOTES.md', 'docs/release-notes-next.md',
];

test('coverage parity: no derived condition silently narrows a leg', () => {
  const accepted = new Set(ACCEPTED_NARROWINGS.map(([s, p]) => `${s} ${p}`));
  const regressions = [];

  for (const [stepName, legacyScopes] of Object.entries(LEGACY_GATES)) {
    // The derived condition now attached to this step, by `# leg:` marker or
    // by step name.
    const m = source.match(
      new RegExp(`- name: ${stepName.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')}\\n\\s*if: ([^\\n]+)\\n`),
    );
    assert.ok(m, `no if: found for step '${stepName}' — did it get renamed?`);
    const derivedKeys = [...m[1].matchAll(/fromJSON\(needs\.detect\.outputs\.scopes\)\.([A-Za-z0-9_]+)/g)]
      .map((x) => x[1]);

    for (const path of PROBE_CORPUS) {
      const ranBefore = legacyScopes.some((s) => LEGACY_MATCHERS[s].test(path));
      const scopes = computeScopes([path], { eventName: 'pull_request' });
      const runsNow = derivedKeys.some((k) => scopes[k]);
      if (ranBefore && !runsNow && !accepted.has(`${stepName} ${path}`)) {
        regressions.push(`${stepName} no longer runs for ${path}`);
      }
    }
  }

  assert.deepEqual(
    regressions,
    [],
    `derivation silently narrowed coverage:\n${regressions.join('\n')}\n\n` +
    `Either widen the step's inputs in verify-cache.mjs, or add an entry to ` +
    `ACCEPTED_NARROWINGS with a reason.`,
  );
});
```

**Working through the failures this produces is Task 7's real work**, not the
mechanical `if:` rewriting. Each one is a decision: widen the STEP's inputs,
or accept and document. Do not add blanket `ACCEPTED_NARROWINGS` entries to
get to green.

- [ ] **Step 2: Run to verify each assertion can fail**

Run: `node --test scripts/tests/workflow-wiring.test.mjs`
Expected: PASS once Tasks 6–7 are complete. If any fail, the workflow is
genuinely mis-wired — fix the workflow, not the test.

- [ ] **Step 3: Run the four mutations (M1, M2, M15, M16)**

Each must go red, then be reverted:

| Mutation | Edit | Expect red in |
|---|---|---|
| M1 | rename `test:hooks` → `test:hooks2` in `verify-cache.mjs` `STEPS[]` | → and ← |
| M2 | add `if: fromJSON(needs.detect.outputs.scopes).step_nope` to any step | → |
| M3 | delete the `if:` from the "Hooks tests" step entirely | ← only (fires alone, unlike M1) |
| M15 | remove `sidecar-tests` from the aggregator's `needs:` | ↑ |
| M16 | change one `# supports:`-tagged step's `if:` to a different key | setup-binding |

M1 and M3 are both listed because they exercise *different* directions: M1
trips → and ← together (the emitted key changes and the reference goes
stale), while M3 leaves the key emitted with nothing referencing it, which
only ← can see. A suite that catches M1 but not M3 has a half-working ←.

Run after each: `node --test scripts/tests/workflow-wiring.test.mjs`
Record which assertion caught it. If a mutation does **not** go red, the
assertion is a placebo — fix it before proceeding.

- [ ] **Step 4: Verify M4 (anti-vacuity)**

Temporarily change the `referenced` regex to match nothing (e.g.
`/fromJSONX\(/g`). Expected: the anti-vacuity test goes red; without it, →
and ← would both pass vacuously. Revert.

- [ ] **Step 5: Wire the new test into the cache step**

In `scripts/verify-cache.mjs`, `test:hooks` already globs
`scripts/**/*.{mjs,cjs}` so the test file itself is covered, and A1 added
`.github/workflows/**`. Confirm:

Run: `node -e "import('./scripts/verify-cache.mjs').then(({STEPS,stepTouchedByDiff})=>{const s=STEPS.find(x=>x.name==='test:hooks');console.log('test file:',stepTouchedByDiff(s,['scripts/tests/workflow-wiring.test.mjs']));console.log('workflow:',stepTouchedByDiff(s,['.github/workflows/verify.yml']));})"`

Expected: both `true`.

- [ ] **Step 6: Commit**

```bash
git add scripts/tests/workflow-wiring.test.mjs
git commit -m "test(ops): assert workflow wiring in four directions"
```

---

### Task 9: The aggregator sentinel

**Files:**
- Modify: `.github/workflows/verify.yml:433-450`

**Interfaces:**
- Consumes: `needs.detect.outputs.ok` from Task 6.

- [ ] **Step 1: Add `detect` to the aggregator's `needs:`**

Without this the `needs` context does not expose `detect` at all, and
`needs.detect.outputs.ok` is the empty string — the sentinel would fail on
**every** PR. Safe against the `'skipped'` check: `detect` has no job-level
`if:` and cannot skip.

```yaml
    needs: [detect, lint-and-checks, frontend-tests, server-tests, sidecar-tests, e2e, e2e-visual, build]
```

- [ ] **Step 2: Assert the sentinel**

Add as the FIRST step of the aggregator, before "Check leg results":

```yaml
      # Consumer-side check on a DIFFERENT artifact from the one it validates.
      # The producer-side fail-safe in ci-scope.mjs shares a failure mode with
      # what it guards: it writes the fallback to the same GITHUB_OUTPUT
      # handle. If that handle is unwritable, or detect exits 0 having written
      # nothing, every `if:` is false, every job's STEPS skip, every job
      # SUCCEEDS, and this aggregator would report green having run nothing.
      # No job is skipped in that scenario, so the check below cannot catch it.
      - name: Scope detection ran
        run: |
          if [[ "${{ needs.detect.result }}" != "success" ]]; then
            echo "::error::detect job did not succeed: ${{ needs.detect.result }}"
            exit 1
          fi
          if [[ "${{ needs.detect.outputs.ok }}" != "true" ]]; then
            echo "::error::ci-scope.mjs did not report ok=true (got '${{ needs.detect.outputs.ok }}'). Scope detection produced no output; refusing to report green."
            exit 1
          fi
          echo "Scope detection reported ok."
```

- [ ] **Step 3: Verify M12 by simulation**

Locally confirm the shell logic both ways:

```bash
ok=""    ; [[ "$ok" != "true" ]] && echo "empty  -> FAILS (correct)"
ok="true"; [[ "$ok" != "true" ]] || echo "true   -> PASSES (correct)"
```

Expected: both lines print.

- [ ] **Step 4: Commit and open PR A2**

```bash
git add .github/workflows/verify.yml
git commit -m "feat(ops): aggregator refuses to report green if scope detection did not run"
git push -u origin feat/ops-verify-scope-derivation
```

PR body: `Closes #2119`, links the design doc, and states the manual
inspection below.

- [ ] **Step 5: Hand-inspect A2's own CI run**

Self-validation is circular against a *computed-false*: if `ci-scope.mjs`
wrongly computes `step_test_hooks=false`, the wiring assertion never runs on
the PR introducing it. A1 removed this for defect D, not for the general case.

Open A2's `detect` job log, read the `--- derived scope ---` block, and check
by hand that the legs which ran match what the PR's own diff should trigger
(it touches `scripts/**` and `.github/**`, so at minimum `step_test_hooks`
must be `true` and the Hooks tests step must have executed).

---

# PHASE B — guard hardening (Closes #2120)

Branch: `fix/ops-verify-cache-completeness-guard`, cut after A2 merges.

---

### Task 10: AST-based specifier extraction and the resolver

> **Revised after plan review round 2.** An earlier draft hand-rolled a
> comment-stripping lexer. Two versions of it were written and **both were
> defective**: the first desynced on regex literals containing quotes; the
> second closed that but retained a *re-closing* desync — `return /a\/*b/;`
> is read as division, then `/*` opens a phantom block comment that a later
> `*/` closes, silently swallowing every import in between while the
> terminal state finishes at `code`. Demonstrated:
>
> ```
> onDesync reported : null          <- the whole-repo guard sees nothing
> lexer extracted   : ["./other.mjs"]   <- './real.mjs' vanished
> ```
>
> That fail-open is **not closable by another test case**, because the
> detector (terminal state) cannot observe it. `acorn` is already resolvable
> (8.16.0, via eslint) and ignores comments natively, so the entire class
> disappears. Measured on `scripts/tests/*.test.mjs`: **0 parse failures
> across 59 files**, and the only difference from the regex approach is that
> acorn correctly does **not** extract `../../pinokio.js` from inside a
> string literal — a false positive the regex produced, and the very
> specifier that resolves outside the repo and triggers `check-ignore`'s
> exit 128.

**Files:**
- Create: `scripts/lib/module-graph.mjs`
- Create: `scripts/tests/module-graph.test.mjs`

**Interfaces:**
- Produces:
  - `extractRelativeSpecifiers(source)` → string[], or **throws** on unparseable input
  - `candidatePaths(fromFile, specifier)` → string[] (pure path math)
  - `resolveSpecifier(fromFile, specifier)` → absolute path or `null`

- [ ] **Step 1: Write the failing tests**

Create `scripts/tests/module-graph.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractRelativeSpecifiers, resolveSpecifier } from '../lib/module-graph.mjs';

test('extracts static, dynamic and require specifiers', () => {
  const src = `
import a from './a.mjs';
const b = await import('./b.mjs');
const c = require('./c.js');
export { d } from './d.mjs';
export * from './e.mjs';
import fs from 'node:fs';
import pkg from 'archiver';
`;
  assert.deepEqual(
    extractRelativeSpecifiers(src).sort(),
    ['./a.mjs', './b.mjs', './c.js', './d.mjs', './e.mjs'],
  );
});

// Comments are invisible to a parser — no stripping step, no desync class.
// verify-cache.mjs:107 has a literal require('../../pinokio.js') in a comment
// that resolves OUTSIDE the repo; under fail-closed resolution the regex
// approach turned that into a check-ignore exit-128 crash.
test('ignores a specifier inside a comment', () => {
  const src = `// loads it via createRequire + require('../../pinokio.js')\nimport x from './real.mjs';\n`;
  assert.deepEqual(extractRelativeSpecifiers(src), ['./real.mjs']);
});

// The regex approach extracted this; acorn does not. It is fixture DATA in a
// test, not an edge — a false positive that inflated the closure.
test('ignores a specifier inside a string literal', () => {
  const src = `const source = "const config = require('../../pinokio.js');";\nimport y from './real.mjs';\n`;
  assert.deepEqual(extractRelativeSpecifiers(src), ['./real.mjs']);
});

// The exact shape that defeated the hand-rolled lexer: `return /a\/*b/;` is
// read as division, `/*` opens a phantom comment, a later `*/` closes it, and
// every import in between is swallowed with NO desync signal.
test('a keyword-preceded regex literal does not swallow later imports', () => {
  const src = [
    'function f() { return /a\\/*b/; }',
    "import x from './real.mjs';",
    '/* ordinary comment */',
    "import y from './other.mjs';",
  ].join('\n');
  assert.deepEqual(extractRelativeSpecifiers(src).sort(), ['./other.mjs', './real.mjs']);
});

test('handles CJS scripts that are not valid ESM', () => {
  const src = `const x = require('./a.js');\nmodule.exports = x;\n`;
  assert.deepEqual(extractRelativeSpecifiers(src), ['./a.js']);
});

test('handles a hashbang', () => {
  const src = `#!/usr/bin/env node\nimport a from './a.mjs';\n`;
  assert.deepEqual(extractRelativeSpecifiers(src), ['./a.mjs']);
});

// FAIL CLOSED: unparseable input must be reported, never treated as "no
// edges". Silently returning [] is the "absent reads as clean" shape.
test('throws on unparseable source rather than returning no edges', () => {
  assert.throws(() => extractRelativeSpecifiers('function ( { >>> ;'), /parse/i);
});

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

test('resolveSpecifier resolves an exact path', () => {
  const d = tree({ 'a.mjs': '', 'b.mjs': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './b.mjs'), join(d, 'b.mjs'));
});

test('resolveSpecifier tries extension candidates', () => {
  const d = tree({ 'a.mjs': '', 'b.js': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './b'), join(d, 'b.js'));
});

// TypeScript emits .js specifiers for .ts sources — scripts/diff-analysis-ab.mjs
// imports ../server/src/handoff/schemas.js and only the .ts exists.
test('resolveSpecifier maps a .js specifier onto a .ts source', () => {
  const d = tree({ 'a.mjs': '', 'schemas.ts': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './schemas.js'), join(d, 'schemas.ts'));
});

test('resolveSpecifier returns null when nothing resolves', () => {
  const d = tree({ 'a.mjs': '' });
  assert.equal(resolveSpecifier(join(d, 'a.mjs'), './nope.mjs'), null);
});

// Anti-vacuity on the extractor itself: every real hooks test must parse.
// A parse regression would otherwise surface only as a mysteriously shrunken
// closure. Measured at authoring time: 59 files, 0 failures.
test('every hooks test file parses', () => {
  const dir = resolve(import.meta.dirname);
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(files.length >= 40, `expected >= 40 hooks tests, found ${files.length}`);
  const failures = [];
  for (const f of files) {
    try { extractRelativeSpecifiers(readFileSync(join(dir, f), 'utf8')); }
    catch (err) { failures.push(`${f}: ${err.message}`); }
  }
  assert.deepEqual(failures, [], `unparseable hooks test(s):\n${failures.join('\n')}`);
});
```

Add `readdirSync, readFileSync` to the `node:fs` import for the last test.

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/tests/module-graph.test.mjs`
Expected: FAIL — `Cannot find module '../lib/module-graph.mjs'`.

- [ ] **Step 3: Implement**

Create `scripts/lib/module-graph.mjs`:

```js
// Static module-graph helpers for the test:hooks completeness guard.
//
// Specifiers are extracted by PARSING, not by regex over stripped text. Two
// hand-rolled comment-stripping lexers were written for this and both had a
// fail-open: a regex literal could open a phantom comment state that a later
// `*/` closed, swallowing imports with no detectable signal. A parser has no
// such failure mode — comments and string literals are simply not expressions.
//
// acorn is already a transitive dependency (via eslint) and is used here for
// its parser only; no plugin, no walker package.

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowHashBang: true,
};

const isRelative = (v) => typeof v === 'string' && /^\.\.?\//.test(v);

// Returns the relative specifiers this source depends on.
//
// THROWS on unparseable input rather than returning []. An empty result from a
// broken parse is the "absent reads as clean" shape: the guard would report a
// file has no dependencies precisely when it cannot tell.
export function extractRelativeSpecifiers(source) {
  let ast = null;
  let lastErr = null;
  // .mjs/.cjs/.js all appear in the closure; try ESM first, then script.
  for (const sourceType of ['module', 'script']) {
    try {
      ast = acorn.parse(source, { ...PARSE_OPTIONS, sourceType });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!ast) {
    throw new Error(`module-graph: parse failed (${lastErr?.message ?? 'unknown'})`);
  }

  const found = new Set();
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
      case 'ImportExpression':
        if (isRelative(node.source?.value)) found.add(node.source.value);
        break;
      case 'CallExpression':
        if (node.callee?.name === 'require' && isRelative(node.arguments?.[0]?.value)) {
          found.add(node.arguments[0].value);
        }
        break;
      default:
        break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      visit(node[key]);
    }
  })(ast);
  return [...found];
}

const CANDIDATES = ['', '.js', '.mjs', '.cjs', '/index.js', '/index.mjs'];

// Candidate paths a specifier could denote, WITHOUT touching the filesystem.
// Exported so the stop rule can classify each candidate before any existence
// probe (see walk()).
export function candidatePaths(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const paths = CANDIDATES.map((ext) => base + ext);
  // TypeScript convention: `./x.js` in source resolves to `./x.ts` on disk.
  if (specifier.endsWith('.js')) paths.push(`${base.slice(0, -3)}.ts`);
  return paths;
}

export function resolveSpecifier(fromFile, specifier) {
  for (const candidate of candidatePaths(fromFile, specifier)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test scripts/tests/module-graph.test.mjs`
Expected: PASS.

- [ ] **Step 5: Confirm acorn resolves from this location**

`acorn` is a transitive dependency, not a direct one — it resolves today via
eslint, but nothing pins that.

Run: `node -e "console.log(require('acorn').version)"`
Expected: a version string (8.x).

If it ever stops resolving, add `acorn` to `devDependencies` explicitly
rather than reinstating a hand-rolled lexer. **Do not** re-derive the
stripping approach; §Task 10's header records why.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/module-graph.mjs scripts/tests/module-graph.test.mjs
git commit -m "feat(scripts): AST-based specifier extraction with TS-aware resolution"
```


### Task 11: The `check-ignore` stop rule

**Files:**
- Modify: `scripts/lib/module-graph.mjs`
- Modify: `scripts/tests/module-graph.test.mjs`

**Interfaces:**
- Produces: `classifyIgnored(absPaths, cwd)` → `Map<string, boolean>`.
  Throws on any state that is not a clean ignored/not-ignored answer.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/tests/module-graph.test.mjs`:

```js
import { classifyIgnored } from '../lib/module-graph.mjs';
import { execFileSync } from 'node:child_process';

function gitRepo(files, ignore) {
  const dir = tree(files);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), ignore, 'utf8');
  return dir;
}

test('classifyIgnored marks gitignored paths', () => {
  const d = gitRepo({ 'src/a.js': '', 'dist/b.js': '' }, 'dist/\n');
  const m = classifyIgnored([join(d, 'dist', 'b.js'), join(d, 'src', 'a.js')], d);
  assert.equal(m.get(join(d, 'dist', 'b.js')), true);
  assert.equal(m.get(join(d, 'src', 'a.js')), false);
});

// The property the rule depends on: check-ignore is pure pattern matching, so
// it answers correctly for paths that do NOT exist. That is what makes the
// rule clone-state independent — server/dist is present locally (1,812 files)
// and absent on a fresh CI clone, and "untracked" would classify differently
// in each, giving red on CI and green locally.
test('classifyIgnored answers for a path that does not exist on disk', () => {
  const d = gitRepo({ 'src/a.js': '' }, 'dist/\n');
  const m = classifyIgnored([join(d, 'dist', 'never', 'existed.js')], d);
  assert.equal(m.get(join(d, 'dist', 'never', 'existed.js')), true);
});

// M18: exit 128 (path outside the repo) and git-unavailable must FAIL CLOSED.
// "Non-zero => not ignored" conflates 128 with 1; "non-zero => skip" would
// classify everything as ignored wherever git is absent, making the guard
// vacuously green — the "absent reads as clean" shape.
test('classifyIgnored throws on a path outside the repository (exit 128)', () => {
  const d = gitRepo({ 'src/a.js': '' }, 'dist/\n');
  assert.throws(
    () => classifyIgnored([resolve(d, '..', 'outside.js')], d),
    /check-ignore/i,
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/tests/module-graph.test.mjs`
Expected: FAIL — `classifyIgnored` is not exported.

- [ ] **Step 3: Implement**

Append to `scripts/lib/module-graph.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { relative, sep } from 'node:path';

const toPosix = (p) => p.split(sep).join('/');

// Classify a batch of candidate paths as gitignored or not.
//
// NOTE: check-ignore is INDEX-AWARE, not pure .gitignore pattern matching.
// Measured: a file matching an ignore rule but force-added to the index
// reports exit 1 (NOT ignored); with --no-index it reports 0. This is
// deliberate and must NOT be "fixed" by adding --no-index: a tracked file is
// a real producer and belongs in the closure regardless of what .gitignore
// says about its directory. The server/dist/** conclusion is unaffected —
// those files are never tracked, so they classify as ignored in both a fresh
// clone and a built tree, which is the clone-state independence this rule
// needs. What is NOT true is the simpler story that this is a property of
// .gitignore alone.
//
// BATCHED via --stdin, not one spawn per path: measured 81 individual spawns
// = 3972 ms vs one batch = 60 ms (66x). test:hooks runs in pre-commit via
// verify:fast:scoped, a path documented as sub-5s — per-query spawning would
// roughly double it on every commit touching scripts/**.
//
// Paths are POSIX-normalised first: git normalises backslashes on Windows,
// but on Linux 'server\dist\x.js' is ONE literal filename that matches
// nothing — classified not-ignored, then fail-closed resolution turns it red
// on CI only.
//
// FAILS CLOSED. git check-ignore is three-valued:
//   0   = at least one path ignored
//   1   = none ignored
//   128 = error (e.g. path outside the repository)
// 128, a spawn failure, or git being absent all THROW rather than defaulting
// either way. Defaulting to "ignored" would silently empty the walk wherever
// git is unavailable.
export function classifyIgnored(absPaths, cwd) {
  const result = new Map(absPaths.map((p) => [p, false]));
  if (absPaths.length === 0) return result;

  const posix = absPaths.map((p) => toPosix(relative(cwd, p)));
  const proc = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd,
    input: posix.join('\n'),
    encoding: 'utf8',
  });

  if (proc.error) {
    throw new Error(`check-ignore: failed to spawn git (${proc.error.message}) — refusing to guess`);
  }
  if (proc.status !== 0 && proc.status !== 1) {
    // Name the paths: check-ignore batches, and on 128 it prints nothing about
    // the good ones — so without this the error identifies neither the
    // offending specifier nor the file that imported it. Fail-closed but
    // undiagnosable is only half a guard.
    throw new Error(
      `check-ignore: git exited ${proc.status} — refusing to guess.\n` +
      `${proc.stderr ?? ''}\nPaths in this batch:\n${posix.join('\n')}`,
    );
  }

  const ignored = new Set(proc.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  for (let i = 0; i < absPaths.length; i += 1) {
    if (ignored.has(posix[i])) result.set(absPaths[i], true);
  }
  return result;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test scripts/tests/module-graph.test.mjs`
Expected: PASS.

> **M8 is NOT run here.** At this point the completeness guard still uses the
> old inline extractor and never calls `classifyIgnored`, so swapping the
> predicate would change nothing and prove nothing. M8 moves to **Task 13
> Step 4b**, after the guard actually consumes the walk.

- [ ] **Step 5: Verify the cost claim holds**

Run:

```bash
node --input-type=module -e "
import {execFileSync,execSync} from 'child_process';
const paths=Array.from({length:81},(_,i)=>i%2?'server/dist/f'+i+'.js':'scripts/f'+i+'.mjs');
let t=Date.now(); for(const p of paths){try{execSync('git check-ignore -q \"'+p+'\"',{stdio:'ignore'});}catch{}}
const per=Date.now()-t;
t=Date.now(); try{execFileSync('git',['check-ignore','--stdin'],{input:paths.join('\n'),stdio:['pipe','ignore','ignore']});}catch{}
console.log('per-query',per+'ms','batched',(Date.now()-t)+'ms');
"
```

Expected: batched is an order of magnitude faster. If not, investigate before
proceeding — the pre-commit budget depends on it.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/module-graph.mjs scripts/tests/module-graph.test.mjs
git commit -m "feat(scripts): batched, fail-closed gitignore classification"
```

---

### Task 12: The transitive walk

**Files:**
- Modify: `scripts/lib/module-graph.mjs`
- Modify: `scripts/tests/module-graph.test.mjs`

**Interfaces:**
- Produces: `walk({ entryFiles, repoRoot })` → `{ files: string[],
  unresolvable: Array<{ specifier, from }> }`, repo-relative POSIX paths.

- [ ] **Step 1: Write the failing test — including M17**

Append to `scripts/tests/module-graph.test.mjs`:

```js
import { walk } from '../lib/module-graph.mjs';

// M17 — the mutation the M5-pair alone cannot provide. In the real repo the
// walk's live case is neutralised by the declarations landing in the same PR:
// a depth-1 closure is a SUBSET of a zero-missing full closure, so it is also
// zero-missing (measured: depth-1 = 56, floor = 50, missing = [] -> GREEN).
// Deleting the walk would leave the whole battery green. This synthetic tree
// is what actually pins recursion.
test('walk follows a depth-2 edge (M17: deleting recursion must go red)', () => {
  const d = gitRepo({
    'test.mjs': "import a from './a.mjs';\n",
    'a.mjs': "import b from './b.mjs';\n",
    'b.mjs': "export default 1;\n",
  }, '');
  const { files } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.ok(files.includes('a.mjs'), 'depth-1 edge must be found');
  assert.ok(files.includes('b.mjs'), 'depth-2 edge must be found — recursion is load-bearing');
});

test('walk stops at gitignored paths', () => {
  const d = gitRepo({
    'test.mjs': "import a from './dist/a.mjs';\n",
    'dist/a.mjs': "import b from './b.mjs';\n",
    'dist/b.mjs': "export default 1;\n",
  }, 'dist/\n');
  const { files } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.deepEqual(files, [], 'nothing under an ignored dir may enter the closure');
});

test('walk survives an import cycle', () => {
  const d = gitRepo({
    'test.mjs': "import a from './a.mjs';\n",
    'a.mjs': "import b from './b.mjs';\n",
    'b.mjs': "import a from './a.mjs';\n",
  }, '');
  const { files } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.deepEqual(files.sort(), ['a.mjs', 'b.mjs']);
});

test('walk does not follow bare specifiers', () => {
  const d = gitRepo({ 'test.mjs': "import fs from 'node:fs';\nimport x from 'archiver';\n" }, '');
  const { files } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.deepEqual(files, []);
});

// M9 — needs a synthetic fixture: post-hardening the real tree has ZERO
// unresolvable specifiers (the count goes 1 -> 0 once comments are stripped),
// so asserting against the real repo would be vacuous.
test('walk reports an unresolvable specifier rather than skipping it', () => {
  const d = gitRepo({ 'test.mjs': "import x from './missing.mjs';\n" }, '');
  const { unresolvable } = walk({ entryFiles: [join(d, 'test.mjs')], repoRoot: d });
  assert.equal(unresolvable.length, 1);
  assert.equal(unresolvable[0].specifier, './missing.mjs');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/tests/module-graph.test.mjs`
Expected: FAIL — `walk` is not exported.

- [ ] **Step 3: Implement**

Append to `scripts/lib/module-graph.mjs`. **Consolidate imports at the top of
the file** as you go — Tasks 10, 11 and 12 each add some, and leaving three
separate `import` blocks mid-file works (ESM hoists) but duplicates
`node:fs`. The final header should read:

```js
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, relative, sep } from 'node:path';
```

Then the walk itself:

```js
// Breadth-first transitive walk over relative import edges.
//
// Ordering matters and is the answer to "classify or resolve first?": path
// JOIN is pure string math; module RESOLUTION is extension-candidate probing
// plus existsSync. They are different operations. Every candidate is
// classified by check-ignore BEFORE any existence probe, so whether a build
// artifact happens to be present on this box cannot change the result —
// server/dist is present locally and absent on a fresh CI clone.
//
// Classification is per-CANDIDATE, not once-then-resolve: a file-specific
// .gitignore pattern could otherwise disagree with what resolution lands on.
export function walk({ entryFiles, repoRoot }) {
  const seen = new Set();
  const files = new Set();
  const unresolvable = [];
  let frontier = [...entryFiles];

  while (frontier.length > 0) {
    // Collect every candidate for this BFS level, then classify in ONE batch.
    const edges = [];
    for (const file of frontier) {
      let source;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const specifier of extractRelativeSpecifiers(source)) {
        edges.push({ from: file, specifier, candidates: candidatePaths(file, specifier) });
      }
    }
    if (edges.length === 0) break;

    const allCandidates = [...new Set(edges.flatMap((e) => e.candidates))];
    const ignoredMap = classifyIgnored(allCandidates, repoRoot);

    const next = [];
    for (const edge of edges) {
      const live = edge.candidates.filter((c) => !ignoredMap.get(c));
      if (live.length === 0) continue; // wholly ignored — stop, not an error
      const resolved = live.find((c) => existsSync(c));
      if (!resolved) {
        // FAIL CLOSED: a specifier that resolves to nothing is reported, not
        // silently skipped. The old guard's `continue` here meant a broken
        // edge read as clean.
        unresolvable.push({ specifier: edge.specifier, from: toPosix(relative(repoRoot, edge.from)) });
        continue;
      }
      const rel = toPosix(relative(repoRoot, resolved));
      files.add(rel);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        next.push(resolved);
      }
    }
    frontier = next;
  }

  return { files: [...files].sort(), unresolvable };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test scripts/tests/module-graph.test.mjs`
Expected: PASS.

- [ ] **Step 5: Prove M17 is not a placebo**

Temporarily replace `frontier = next;` with `frontier = [];` (kills
recursion after depth 1).

Run: `node --test scripts/tests/module-graph.test.mjs`
Expected: the depth-2 test goes **RED**. Revert.

If it does not go red, the fixture is wrong — fix it before proceeding.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/module-graph.mjs scripts/tests/module-graph.test.mjs
git commit -m "feat(scripts): transitive module walk with a gitignore stop rule"
```

---

### Task 13: Point the completeness guard at the walk

**Files:**
- Modify: `scripts/tests/verify-cache.test.mjs:478-565`
- Modify: `scripts/verify-cache.mjs` (`test:hooks` extraFiles — 2 additions)

**Interfaces:**
- Consumes: `walk` from Task 12.

- [ ] **Step 1: Replace the guard body**

Replace the inline `extractRelativeImportSpecifiers` function and the
completeness test (`:501-565`) with:

```js
import { walk } from '../lib/module-graph.mjs';

test('test:hooks completeness guard: every producer a hooks test depends on is a cache input', () => {
  const hooksStep = stepByName['test:hooks'];
  const entryFiles = readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => join(testsDir, f));

  const { files, unresolvable } = walk({ entryFiles, repoRoot });

  // Fail closed on a specifier that resolves to nothing (defect A). The old
  // guard's existsSync-then-continue silently dropped these.
  assert.deepEqual(
    unresolvable,
    [],
    `specifier(s) that resolve to nothing:\n${unresolvable.map((u) => `${u.specifier} <- ${u.from}`).join('\n')}`,
  );

  // Anti-vacuity on METRIC B (unique tracked closure files), NOT on the old
  // occurrence counter — different units, and conflating them is how the old
  // floor came to be 30 against a real 60. Measured at authoring time: 59.
  // Floor 50 gives ~15% headroom: a legitimate one- or two-file removal must
  // not go red, while a collapse toward zero (broken regex or resolver) must.
  assert.ok(
    files.length >= 50,
    `expected >= 50 unique files in the hooks-test closure, found ${files.length} — either extraction/resolution broke, or hooks tests were legitimately removed`,
  );

  const missing = files.filter((f) => !stepTouchedByDiff(hooksStep, [f]));
  assert.deepEqual(
    missing,
    [],
    `producer(s) a hooks test depends on but not an input to test:hooks:\n${missing.join('\n')}`,
  );
});
```

- [ ] **Step 2: Run to verify it fails with exactly two names**

Run: `node --test scripts/tests/verify-cache.test.mjs`
Expected: FAIL listing exactly `pinokio-scripts/lib/menu.js` and
`server/src/handoff/schemas.ts`.

If more appear, **stop** — the stop rule is admitting build artifacts. If
fewer, the walk is not recursing.

- [ ] **Step 3: Add the two declarations**

In `scripts/verify-cache.mjs`, `test:hooks` `extraFiles`:

```js
        // menu.js is a TRANSITIVE dep: pinokio-entry.test.mjs asserts on the
        // menu() item list, which is implemented here and reached via
        // pinokio.js. Editing it used to leave test:hooks [cached] locally,
        // while in cloud it set pinokio=true — running test:pinokio, a
        // DIFFERENT suite from the test that asserts on it (#2120a).
        'pinokio-scripts/lib/menu.js',
        // schemas.ts is reached from diff-analysis-ab.mjs, which imports it
        // with a .js specifier per the TypeScript convention.
        'server/src/handoff/schemas.ts',
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test scripts/tests/verify-cache.test.mjs`
Expected: PASS.

- [ ] **Step 4b: Run mutation M8 — the predicate itself**

Only meaningful here, now that the guard actually consumes `classifyIgnored`.

**Write the mutation's code, not its name.** "Use `git ls-files`" read
literally means *not in the index ⇒ stop*, under which `server/dist/**` is
untracked whether or not it exists on disk — so renaming the directory
changes nothing, the mutation stays green, and the implementer reports it as
a placebo. The predicate that actually reproduces the clone-state divergence
is *present on disk but untracked*:

```js
// MUTATION ONLY — the "untracked" predicate this design rejects.
export function classifyIgnored(absPaths, cwd) {
  const tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 1e8 })
      .split('\n').filter(Boolean),
  );
  return new Map(absPaths.map((p) => [p, !tracked.has(toPosix(relative(cwd, p)))]));
}
```

Then simulate a fresh clone:

```powershell
# node_modules/.cache is gitignored; server/dist.bak is NOT, and would
# litter ~1,812 untracked files into `git status`.
Rename-Item server/dist ../dist-mutation-stash
node --test scripts/tests/verify-cache.test.mjs
Rename-Item ../dist-mutation-stash server/dist
```

(Windows: this moves ~1,812 files and fails if a server process holds any of
them — stop `npm start` first. On POSIX, `mv server/dist ../dist-mutation-stash`.)

Expected under "untracked": **7 unresolvable specifiers** from
`scripts/repair-cast-id-drift.mjs`'s `../server/dist/**` dynamic imports
(currently `:1379-1385`; **grep rather than trusting the line numbers** —
they moved once already between commits) —
red on a fresh clone, green on this box. Under `check-ignore`: identical
either way. Revert the reimplementation.

This is the mutation proving the *predicate choice* is load-bearing, as
distinct from the batching (Task 11 Step 5) and the exit-code contract
(Task 11 Step 1).

- [ ] **Step 5: Run mutation M5**

Remove `'pinokio-scripts/lib/menu.js'` from `extraFiles`.
Run: `node --test scripts/tests/verify-cache.test.mjs`
Expected: RED, naming that exact path. Restore.

- [ ] **Step 6: Run mutation M11**

Temporarily break `PATTERNS` in `module-graph.mjs` (e.g. `\bfromX\s+`).
Run: `node --test scripts/tests/verify-cache.test.mjs`
Expected: RED on the Metric B floor, message citing observed vs expected.
Revert.

- [ ] **Step 7: Commit**

```bash
git add scripts/tests/verify-cache.test.mjs scripts/verify-cache.mjs
git commit -m "fix(scripts): completeness guard walks transitive deps and fails closed"
```

---

### Task 14: Split `check:budget-poll` into its own step

**Files:**
- Modify: `scripts/run-hooks-tests.mjs:22-33`
- Modify: `scripts/verify-cache.mjs` (`STEPS[]`)
- Modify: `package.json`
- Modify: `.github/workflows/verify.yml`
- Test: `scripts/tests/verify-cache.test.mjs`

**Interfaces:**
- Produces: a `check:budget-poll` STEP; A2's ← and ↑ assertions require it be
  wired in the workflow.

- [ ] **Step 1: Write the failing test**

Add to `scripts/tests/verify-cache.test.mjs`:

```js
// The hole this closes: verify:fast:scoped runs --steps test:hooks,test,
// test:server --scope-staged, and test:hooks' globs exclude server/src/**.
// So on a server-only staged diff the budgeted-poll guardrail never ran on
// the very commit introducing the pattern (#2120b).
test('stepTouchedByDiff: a server test diff is in scope for check:budget-poll', () => {
  assert.equal(stepTouchedByDiff(stepByName['check:budget-poll'], ['server/src/tts/foo.test.ts']), true);
});

test('stepTouchedByDiff: a server test diff still does NOT bust test:hooks', () => {
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], ['server/src/tts/foo.test.ts']), false);
});

test('stepTouchedByDiff: editing the budget-poll script is in scope for its own step', () => {
  assert.equal(stepTouchedByDiff(stepByName['check:budget-poll'], ['scripts/check-no-budget-poll.mjs']), true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/tests/verify-cache.test.mjs`
Expected: FAIL — `stepByName['check:budget-poll']` is undefined.

- [ ] **Step 3: Add the STEP**

In `scripts/verify-cache.mjs`, after the `test:hooks` entry:

Note the shape: a STEP has **no `command` field**. `runStepProcess` runs
`npm run <step.name>` (`verify-cache.mjs:674-676`), so the step name *is* the
npm script name — which is why Step 4 below must add a script called exactly
`check:budget-poll`.

```js
  {
    name: 'check:budget-poll',
    inputs: {
      /* Its own step rather than widening test:hooks' inputs: this scans
         server/src/**\/*.test.ts at RUNTIME, and server tests are the hottest
         surface in the repo. Folding them into test:hooks would bust a ~25s
         cache on every server test edit; as its own ~1s step it costs almost
         nothing AND it runs on a server-only staged diff, which is exactly
         the case verify:fast:scoped used to skip. */
      globs: ['server/src/**/*.test.ts'],
      extraFiles: ['scripts/check-no-budget-poll.mjs'],
    },
  },
```

- [ ] **Step 4: Add the npm script**

In `package.json`:

```json
    "check:budget-poll": "node scripts/check-no-budget-poll.mjs",
```

- [ ] **Step 5: Remove the spawn from the hooks runner**

In `scripts/run-hooks-tests.mjs`, delete lines 22-33 (the `check` spawn and
its error handling) and replace the final lines with:

```js
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
// check-no-budget-poll.mjs used to run here. It now has its own verify step
// (`check:budget-poll`) with server/src/**/*.test.ts as its inputs, so a
// server-only diff actually runs it — which this coupling prevented.
process.exit(0);
```

- [ ] **Step 6: Wire it into CI — BEFORE running the suite**

Order matters here. `npm run test:hooks` globs `scripts/tests/*.test.mjs`,
which now includes `workflow-wiring.test.mjs`, whose **←** assertion reports
any emitted key no workflow condition references. Between Step 3 (adds the
STEP) and this step, `step_check_budget_poll` is exactly that — so running
the suite first fails for a reason unrelated to what is being built, and the
implementer would waste a cycle chasing it.

In `.github/workflows/verify.yml`, in `lint-and-checks`, after "Hooks tests":

```yaml
      # leg: check:budget-poll
      - name: Budgeted-poll guardrail
        if: fromJSON(needs.detect.outputs.scopes).step_check_budget_poll || fromJSON(needs.detect.outputs.scopes).shared
        run: npm run check:budget-poll
```

`lint-and-checks` is already in the aggregator's `needs:`, so the ↑ assertion
is satisfied without further change — this is a step in an existing job, not
a new job.

- [ ] **Step 7: Run to verify pass**

Run: `node --test scripts/tests/verify-cache.test.mjs && npm run test:hooks && npm run check:budget-poll`
Expected: all pass.

- [ ] **Step 8: Confirm A2's assertions still pass**

Run: `node --test scripts/tests/workflow-wiring.test.mjs`
Expected: PASS. The ← direction would have caught an unwired new step — this
is the window the A2-before-B ordering exists to close.

- [ ] **Step 9: Commit**

```bash
git add scripts/run-hooks-tests.mjs scripts/verify-cache.mjs package.json .github/workflows/verify.yml scripts/tests/verify-cache.test.mjs
git commit -m "fix(scripts): give the budgeted-poll guardrail its own verify step"
```

---

### Task 15: End-to-end acceptance through the real cache decision

#2120 explicitly rejects `stepTouchedByDiff` as sufficient proof, because
PR #2117 showed it and the real `[cached]`/`[run]` decision are different
code paths.

**Files:**
- Modify: `scripts/tests/verify-cache.test.mjs`

- [ ] **Step 1: Write the test**

Exact signatures (verified against `verify-cache.mjs`): `decide(...)` returns
the **string** `'run'` or `'skip'` (`:282-287`), *not* an object.
`composeInputHash` takes **`sortedFileEntries`** (`:318`), and `hashEntries`
consumes **`[path, hash]` tuples** (`:309-315`), not objects.

```js
import { selectStepFiles, composeInputHash, decide } from '../verify-cache.mjs';

// Shared harness: builds a real input hash for a step from a file list,
// letting the caller perturb one file's content hash.
function hashFor(step, fileList, bump = () => 'h0') {
  const entries = selectStepFiles({ fileList, step }).map((rel) => [rel, bump(rel)]);
  return composeInputHash({
    stepName: step.name,
    sortedFileEntries: entries,
    lockHashes: {},
    nodeVer: 'v20.0.0',
    schemaVer: 1,
    toolFingerprint: 'test',
  });
}

// #2120 rejects stepTouchedByDiff as sufficient proof: PR #2117 showed the
// unit seam and the real decision are different code paths. This drives
// selectStepFiles -> composeInputHash -> decide, the actual [cached]/[run]
// path.
test('acceptance #2120a: editing menu.js makes test:hooks RUN, not [cached]', () => {
  const step = stepByName['test:hooks'];
  const fileList = ['scripts/tests/pinokio-entry.test.mjs', 'pinokio-scripts/lib/menu.js'];

  assert.ok(
    selectStepFiles({ fileList, step }).includes('pinokio-scripts/lib/menu.js'),
    'menu.js must be among the files whose content feeds the hash',
  );

  const base = hashFor(step, fileList);
  const edited = hashFor(step, fileList, (rel) => (rel.endsWith('menu.js') ? 'h1' : 'h0'));
  assert.notEqual(base, edited, 'a menu.js edit must change the input hash');

  const cache = { steps: { [step.name]: { inputHash: base } } };
  assert.equal(decide({ stepName: step.name, currentHash: edited, cache }), 'run');
  assert.equal(decide({ stepName: step.name, currentHash: base, cache }), 'skip');
});

test('acceptance #2120b: adding a server test makes check:budget-poll RUN', () => {
  const step = stepByName['check:budget-poll'];
  const withoutTest = ['scripts/check-no-budget-poll.mjs'];
  const withTest = ['scripts/check-no-budget-poll.mjs', 'server/src/tts/new.test.ts'];

  assert.ok(selectStepFiles({ fileList: withTest, step }).includes('server/src/tts/new.test.ts'));

  const base = hashFor(step, withoutTest);
  const added = hashFor(step, withTest);
  assert.notEqual(base, added, 'adding a server test must change the input hash');

  const cache = { steps: { [step.name]: { inputHash: base } } };
  assert.equal(decide({ stepName: step.name, currentHash: added, cache }), 'run');
});
```

- [ ] **Step 2: Run**

Run: `node --test scripts/tests/verify-cache.test.mjs`
Expected: PASS.

- [ ] **Step 3: Full local battery**

Run: `npm run verify:fast:branch`
Expected: all in-scope legs green.

- [ ] **Step 4: Commit and open PR B**

```bash
git add scripts/tests/verify-cache.test.mjs
git commit -m "test(scripts): acceptance through the real cached/run decision"
git push -u origin fix/ops-verify-cache-completeness-guard
```

PR body: `Closes #2120`.

---

## Mutation ledger

The spec names 18 mutations. Each must be discharged somewhere in this plan,
and a reviewer should be able to check that without grepping. Anything marked
**run it** is an explicit mutate-observe-revert step; anything marked
**pinned by test** is discharged by a test that fails if the behaviour
regresses.

| # | What it proves | Discharged by | How |
|---|---|---|---|
| M1 | renamed step key breaks wiring | Task 8 Step 3 | run it |
| M2 | typo'd `if:` key is caught | Task 8 Step 3 | run it |
| M3 | ← fires alone on an orphaned key | Task 8 Step 3 | run it |
| M4 | wiring floor is not vacuous | Task 8 Step 4 | run it |
| M5 | a dropped declaration is caught | Task 13 Step 5 | run it |
| M6 | depth-1 is GREEN against the real repo — so M5 alone cannot prove recursion | Task 12 Step 5 (the inverse: killing recursion reddens the *fixture*) | pinned by test |
| M7 | comments/strings are not edges, and a keyword-preceded regex literal cannot swallow later imports | Task 10 Step 1 — three tests (comment, string literal, regex-literal) | pinned by test |
| M8 | the ignored-vs-untracked *predicate* is load-bearing | Task 11 Step 4b | run it |
| M9 | unresolvable specifiers fail closed | Task 12 Step 1, `walk reports an unresolvable specifier` | pinned by test |
| M10 | `ci-scope.mjs` fails safe, not silent | Task 5 Steps 5 + 5b | run it |
| M11 | Metric B floor catches a dead regex | Task 13 Step 6 | run it |
| M12 | the `ok` sentinel rejects an empty value | Task 9 Step 3 | **partial — see below** |
| M13 | the sidecar leg reddens the **pinned context** | Task 4 Step 6 | run it (on the PR) |
| M14 | a workflow-only edit runs the assertions | Task 1 Steps 1–2 + Task 8 Step 5 | pinned by test |
| M15 | a job outside `needs:` is caught | Task 8 Step 3 | run it |
| M16 | a setup step diverging from its leg is caught | Task 8 Step 3 | run it |
| M17 | recursion is load-bearing (synthetic) | Task 12 Step 5 | run it |
| M18 | `check-ignore` exit 128 fails closed | Task 11 Step 1, `throws on a path outside the repository` | pinned by test |

**M6 deserves a note.** It is the one "mutation" that is really a *measured
claim*: against the real repo a depth-1 walk yields closure **57**, clears
the floor of 50, and reports `missing = []` — **green**. That is why M17's
synthetic fixture exists at all. Do not try to make M6 red against the real
tree; if it ever does go red there, the two declarations from Task 13 have
been lost and M5 will say so.

**M12 is only partially dischargeable before merge, and the ledger says so
rather than overclaiming.** Task 9 Step 3 proves the *bash comparison* —
that an empty `ok` fails the step. It does **not** prove that a silently-empty
producer is caught end-to-end, because that requires a real workflow run with
a broken `detect`. Options, in order of preference:

1. On A2's PR, push one scratch commit that drops the `>> "$GITHUB_OUTPUT"`
   redirect, confirm `npm run verify` goes red with the sentinel's message,
   then revert it in the same PR.
2. If that is not acceptable on the required check, mark M12 **unproven at
   merge** in the PR body and discharge it on the first workflow-only PR
   after A2 lands.

Do not silently treat Step 3 as full discharge — that is the "test that
cannot fail" shape this plan exists to prevent.

## Post-merge

- [ ] Announce the ← tripwire: any future PR adding a `STEPS[]` entry is red
      until it also wires `verify.yml`. Five PRs were open at design time
      (#2116, #2118, #2122, #2124, #2125).
- [ ] Fill the spec's **Ship notes** with dates + SHAs; set `status: stable`;
      `git mv` it to `docs/features/archive/` if it is being retired there.
- [ ] `docs/release-notes-next.md` + `RELEASE_NOTES.md` — CI-only change with
      no user-visible delta; state that explicitly rather than omitting.
- [ ] No on-box acceptance row is owed: nothing here needs a GPU, a real
      sidecar model, a real analyzer, or a real book.
