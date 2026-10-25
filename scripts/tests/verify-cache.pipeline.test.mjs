// runPipeline against throwaway git repos: scope filtering, [cached]/[run], step
// timeout, attempt persistence (#3018) and the unconditional register-citation
// check (#3271).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeScopes } from '../ci-scope.mjs';
import {
  loadCache,
  stepTouchedByDiff,
  runPipeline,
  runUnconditionalLocalChecks,
  UNCONDITIONAL_LOCAL_CHECK_SCRIPTS,
  STEPS,
} from '../verify-cache.mjs';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';
import {
  STEP_BUDGET_PAST_LAUNCH_MS,
  armSurvivorWatch,
  assertHangFixtureKilled,
  gitAt,
  makeGitFixture,
  stepByName,
  writeFlakyFixture,
  writeHangingFixture,
} from './verify-cache-test-support.mjs';


// Resolve relative to THIS file, not the process cwd — same rationale as
// scripts/tests/run-golden-audio.test.mjs's own HERE/SRC_PATH.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, '..', 'verify-cache.mjs');
const src = readFileSync(SRC_PATH, 'utf8');

// Castwright#3393 review pass 2: the run/skip decision must describe a step's
// inputs as they are when THAT step starts, not as they were when the pre-pass
// planned the run. Step B (`check:onbox-register`) passes only on the ORIGINAL
// content and is cached on it by run 1 (B alone). Run 2 is A,B: step A
// (`lint`) rewrites B's input after the pre-pass planned B as `skip`, so B
// must run again (and fail), never print `[cached]`. This is a route #3413's
// post-run guard cannot mask: B's entry is legitimately written in run 1, and
// only the start-of-step re-plan stands between it and a false `[cached]`.
async function runTwoStepFixture({ sharedFile, createsFile = false }) {
  const dir = makeGitFixture();
  // `sharedFile` true: the mutated file is ALSO an input of step A (a `.mjs`
  // matched by both `lint` and `check:onbox-register`), so a per-run memo
  // populated while planning/running A would serve B a stale hash.
  // `createsFile` true: the target does not exist (never `git add`ed) until A
  // creates it, so it is absent from any file LIST taken before A ran — the
  // file SET, not just the hashes, must be taken at B's start.
  const target = createsFile
    ? 'scripts/new.mjs'
    : sharedFile
      ? 'scripts/shared.mjs'
      : 'docs/testing/onbox-acceptance-register.md';
  mkdirSync(dirname(join(dir, target)), { recursive: true });
  if (!createsFile) writeFileSync(join(dir, target), 'orig', 'utf8');
  writeFileSync(
    join(dir, 'a.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, target))}, 'mutated');\n`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'b.mjs'),
    createsFile
      ? `import { existsSync } from 'node:fs';\nprocess.exit(existsSync(${JSON.stringify(join(dir, target))}) ? 1 : 0);\n`
      : `import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync(${JSON.stringify(join(dir, target))}, 'utf8') === 'orig' ? 0 : 1);\n`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'stale-hash-fixture',
      private: true,
      scripts: { lint: 'node a.mjs', 'check:onbox-register': 'node b.mjs' },
    }),
    'utf8',
  );
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);

  const run = async (steps = 'lint,check:onbox-register') => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const result = await runPipeline({
        argv: ['--steps', steps],
        cwd: dir,
        env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
      });
      return { result, logs };
    } finally {
      console.log = originalLog;
    }
  };

  // Run 1: B alone, on the original content — passes and is cached.
  const first = await run('check:onbox-register');
  assert.equal(first.result, 0, `run 1 must pass (B sees the original):\n${first.logs.join('\n')}`);
  assert.ok(first.logs.some((l) => l.includes('[pass] check:onbox-register')), first.logs.join('\n'));
  // Run 2: A then B. A mutates B's input after the pre-pass planned B as cached.
  const second = await run();
  return { second };
}


for (const [label, sharedFile] of [
  ['an input only the later step reads', false],
  ['an input BOTH steps read (per-run memo route)', true],
]) {
  test(`runPipeline: a step's cache entry reflects its inputs at START, not at plan time — ${label} (#3393)`, async () => {
    const { second } = await runTwoStepFixture({ sharedFile });
    assert.ok(
      !second.logs.some((l) => l.includes('[cached] check:onbox-register')),
      `check:onbox-register was cached on content A has since changed; it must not be [cached]:\n${second.logs.join('\n')}`,
    );
    assert.ok(second.logs.some((l) => l.includes('[run] check:onbox-register')));
    assert.equal(second.result, 1, 'B fails on the content A wrote');
  });
}


test("runPipeline: a file an earlier step CREATES inside a later step's globs is in that step's hash (#3393 pass 3)", async () => {
  const { second } = await runTwoStepFixture({ sharedFile: true, createsFile: true });
  assert.ok(
    !second.logs.some((l) => l.includes('[cached] check:onbox-register')),
    `check:onbox-register was cached before step A created scripts/new.mjs; it must not be [cached]:\n${second.logs.join('\n')}`,
  );
  assert.ok(second.logs.some((l) => l.includes('[run] check:onbox-register')));
  assert.equal(second.result, 1, 'B fails once A has created the file');
});


test('runPipeline with scope filtering: a step not touched by the diff prints [skip] and does not execute (#3393)', async () => {
  // Verifies the scope filter correctly identifies and skips steps outside the diff.
  // Edited file (src/index.ts) matches lint glob but not config:check glob.
  const dir = makeGitFixture();
  const srcFile = join(dir, 'src', 'index.ts');
  const markerFile = join(dir, '.marker');
  mkdirSync(dirname(srcFile), { recursive: true });
  writeFileSync(srcFile, 'export default 1;', 'utf8');
  writeFileSync(join(dir, 'mark.cjs'), `require('fs').appendFileSync('.marker', '1');`, 'utf8');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'scope-fixture',
      private: true,
      scripts: { lint: 'node mark.cjs && exit 0' },
    }),
    'utf8',
  );
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'base']);
  gitAt(dir, ['switch', '-q', '-c', 'feature']);

  writeFileSync(srcFile, 'export default 2;', 'utf8');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'edit src']);

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const result = await runPipeline({
      argv: ['--steps', 'lint,config:check', '--scope-branch'],
      cwd: dir,
      env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
    });
    const lintLog = logs.find((l) => l.match(/^\[run\] lint\b/));
    const checkLog = logs.find((l) => l.match(/^\[skip\] config:check\b/));

    assert.ok(lintLog, `expected [run] lint, got:\n${logs.join('\n')}`);
    assert.ok(checkLog, `expected [skip] config:check, got:\n${logs.join('\n')}`);
    assert.ok(
      existsSync(markerFile),
      'lint ran (marker file created)',
    );
    assert.equal(result, 0);
  } finally {
    console.log = originalLog;
  }
});


test('runPipeline with unchanged inputs: step prints [cached], does not execute, then [run] again after input change (#3393)', async () => {
  // Verifies: (1) unchanged inputs trigger cache hit and skip execution,
  // (2) changed inputs clear cache and force re-execution.
  const dir = makeGitFixture();
  const envFile = join(dir, 'server', '.env.example');
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(envFile, 'FOO=1', 'utf8');
  writeFileSync(join(dir, 'increment.cjs'), `
const fs = require('fs');
const count = parseInt(fs.readFileSync('.exec-count', 'utf8')) + 1;
fs.writeFileSync('.exec-count', String(count));
`, 'utf8');
  writeFileSync(join(dir, '.exec-count'), '0', 'utf8');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'cache-fixture',
      private: true,
      scripts: { 'config:check': 'node increment.cjs && exit 0' },
    }),
    'utf8',
  );
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'base']);

  const run = async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const result = await runPipeline({
        argv: ['--steps', 'config:check'],
        cwd: dir,
        env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
      });
      return { result, logs };
    } finally {
      console.log = originalLog;
    }
  };

  // Run 1: no cache, step executes
  const first = await run();
  assert.equal(first.result, 0);
  const firstLog = first.logs.find((l) => l.match(/^\[run\] config:check\b/));
  assert.ok(firstLog, `run 1 expected [run], got:\n${first.logs.join('\n')}`);
  assert.equal(readFileSync(join(dir, '.exec-count'), 'utf8'), '1', 'marker shows step executed once');

  // Run 2: unchanged inputs, cache hits, step does NOT execute
  const second = await run();
  assert.equal(second.result, 0);
  const secondLog = second.logs.find((l) => l.match(/^\[cached\] config:check\b/));
  assert.ok(
    secondLog,
    `run 2 expected [cached], got:\n${second.logs.join('\n')}`,
  );
  assert.equal(
    readFileSync(join(dir, '.exec-count'), 'utf8'),
    '1',
    'marker unchanged: step did NOT execute on cache hit',
  );

  // Run 3: change an input (server/.env.example is in config:check inputs), cache invalidates, step re-executes
  writeFileSync(envFile, 'FOO=2', 'utf8');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'change env']);

  const third = await run();
  assert.equal(third.result, 0);
  const thirdLog = third.logs.find((l) => l.match(/^\[run\] config:check\b/));
  assert.ok(
    thirdLog,
    `run 3 expected [run] after input change, got:\n${third.logs.join('\n')}`,
  );
  assert.equal(
    readFileSync(join(dir, '.exec-count'), 'utf8'),
    '2',
    'marker shows step executed a second time after input change',
  );
});


test('runPipeline: a lockfile edit alone re-runs a step whose only input is its lockfile (planStep lock hashing)', async () => {
  const dir = makeGitFixture();
  writeFileSync(join(dir, 'package-lock.json'), '{"v":1}', 'utf8');
  writeFileSync(join(dir, 'increment.cjs'), `
const fs = require('fs');
fs.writeFileSync('.exec-count', String(parseInt(fs.readFileSync('.exec-count', 'utf8')) + 1));
`, 'utf8');
  writeFileSync(join(dir, '.exec-count'), '0', 'utf8');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'cache-fixture', private: true, scripts: { audit: 'node increment.cjs' } }),
    'utf8',
  );
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'base']);

  const run = async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const result = await runPipeline({
        argv: ['--steps', 'audit'],
        cwd: dir,
        env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
      });
      return { result, logs };
    } finally {
      console.log = originalLog;
    }
  };

  assert.equal((await run()).result, 0);
  const second = await run();
  assert.ok(
    second.logs.some((l) => /^\[cached\] audit\b/.test(l)),
    `run 2 expected [cached], got:\n${second.logs.join('\n')}`,
  );
  writeFileSync(join(dir, 'package-lock.json'), '{"v":2}', 'utf8');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'bump lock']);
  const third = await run();
  assert.ok(
    third.logs.some((l) => /^\[run\] audit\b/.test(l)),
    `run 3 expected [run] after lockfile edit, got:\n${third.logs.join('\n')}`,
  );
  assert.equal(readFileSync(join(dir, '.exec-count'), 'utf8'), '2');
});


test('runPipeline: a step exceeding CASTWRIGHT_STEP_TIMEOUT_MIN reports [timeout], never a [retry]/[fail] crash-exhaustion line (mutation test)', async () => {
  const dir = makeGitFixture();
  writeHangingFixture(dir, 'test:server');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const watch = armSurvivorWatch(dir);
  const start = Date.now();
  try {
    const result = await runPipeline({
      argv: ['--steps', 'test:server'],
      cwd: dir,
      env: {
        ...scrubGitEnvForThrowawayRepo(process.env),
        SKIP_CONTENTION_CHECK: '1',
        CASTWRIGHT_STEP_TIMEOUT_MIN: String(STEP_BUDGET_PAST_LAUNCH_MS / 60_000), // small, but past npm's launch of the fixture
      },
    });
    const elapsed = Date.now() - start;
    // Without this, a genuinely broken kill (killStepChildTree() a no-op) is
    // indistinguishable from a real one: the hanging fixture's own 300s
    // self-exit (added for B1, PR #3260 review pass 1 — an orphan-prevention
    // safety net, not the mechanism under test) supplies a clean exit that
    // satisfies every assertion below just as well as a fast kill would,
    // taking ~300s instead of ~6s to do it; the survivor watch now cuts a
    // broken kill short at ~25s, and a pass takes ~5-6s (PR #3260 review
    // pass 2, B4 — this guard mirrors the one runStepProcess's own equivalent test already has
    // a few lines up). The bound sits below the self-exit so it stays
    // falsifiable (#3682).
    assertHangFixtureKilled(dir, elapsed, watch);
    assert.notEqual(result, 0, 'a timed-out step must fail the pipeline');
    const timeoutLine = logs.find((l) => l.includes('[timeout]') && l.includes('test:server'));
    assert.ok(timeoutLine, `expected a [timeout] line, got:\n${logs.join('\n')}`);
    assert.ok(
      !logs.some((l) => l.includes('[retry]')),
      'a timed-out step must never be retried as a vitest pool crash',
    );
    assert.ok(
      !logs.some((l) => l.includes('[fail]') && l.includes('3 attempts')),
      'must not be reported as a MAX_POOL_ATTEMPTS-exhausted crash-retry outcome',
    );
  } finally {
    watch.disarm();
    console.log = originalLog;
  }
});


// --- Attempt-count wiring verification (#3018) ---
//
// Issue #3018 added an `attempts` field to runStepProcess's return value and
// wired it into the cache write. This test verifies the wiring through
// runPipeline's actual execution against a throwaway git repo: a fixture
// package.json maps scripts to one-line node invocations (not vitest, so fast —
// 1–2 seconds total). Both acceptance criteria are observable end-to-end: the
// cache entry persists attempts, and the [pass] console line conditionally
// reports the count.


test('#3018: runPipeline persists attempts to cache and reports count only on retry', async () => {
  const dir = makeGitFixture();

  // Fixture 1: crashes on first run (fork-pool crash shape), passes on retry.
  const marker1 = writeFlakyFixture(dir, 'test:server', { failFirst: true });

  // Fixture 2: always passes on first attempt.
  const marker2 = writeFlakyFixture(dir, 'test', { failFirst: false });

  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);

  // Capture console output.
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    // Criterion 1: retry case → cache.steps[step].attempts = 2
    // Criterion 2: [pass] line includes "2 attempts" (only when attempts > 1)
    logs.length = 0;
    const result1 = await runPipeline({
      argv: ['--steps', 'test:server'],
      cwd: dir,
      env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
    });
    assert.equal(result1, 0);

    const cache1 = loadCache(join(dir, '.verify-cache.json'));
    assert.equal(cache1.steps['test:server'].attempts, 2);
    assert.equal(readFileSync(marker1, 'utf8').length, 2, 'marker shows 2 launches');

    const passLine1 = logs.find((l) => l.includes('[pass]') && l.includes('test:server'));
    assert.ok(passLine1);
    assert.match(passLine1, /2 attempts/);

    // Criterion 1: first-try case → cache.steps[step].attempts = 1
    // Criterion 2: [pass] line does NOT include attempt count (only when attempts > 1)
    logs.length = 0;
    const result2 = await runPipeline({
      argv: ['--steps', 'test'],
      cwd: dir,
      env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
    });
    assert.equal(result2, 0);

    const cache2 = loadCache(join(dir, '.verify-cache.json'));
    assert.equal(cache2.steps.test.attempts, 1);
    assert.equal(readFileSync(marker2, 'utf8').length, 1, 'marker shows 1 launch');

    const passLine2 = logs.find((l) => l.includes('[pass]') && l.includes('test'));
    assert.ok(passLine2);
    assert.doesNotMatch(passLine2, /attempts/);
  } finally {
    console.log = originalLog;
  }
});


test('#3018: [fail] line reports attempt count when step crashes all retries', async () => {
  const dir = makeGitFixture();

  // Fixture: crashes on all 3 attempts (fork-pool crash shape).
  const marker = writeFlakyFixture(dir, 'test:server', { alwaysFail: true });

  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);

  // Capture console output.
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    // Run the pipeline; it will crash all 3 attempts and return non-zero
    logs.length = 0;
    const result = await runPipeline({
      argv: ['--steps', 'test:server'],
      cwd: dir,
      env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
    });
    assert.ok(result !== 0, 'pipeline should return non-zero for a failing step');

    // Verify that all 3 attempts were launched (marker file has 3 x's)
    assert.equal(
      readFileSync(marker, 'utf8').length,
      3,
      'marker shows all 3 attempts were launched',
    );

    // Criterion: [fail] line must include "3 attempts" to document how many attempts failed
    const failLine = logs.find((l) => l.includes('[fail]') && l.includes('test:server'));
    assert.ok(failLine, 'should have a [fail] line for test:server');
    assert.match(failLine, /3 attempts/, '[fail] line should include attempt count');
  } finally {
    console.log = originalLog;
  }
});


// --- Unconditional local checks (#3271, closing #3140's local-wiring gap) ---
//
// `npm run verify` must reach `check:register-citations` UNCONDITIONALLY — never
// `[cached]`, never scope-skipped, and never through a `STEPS[]` entry. Shape
// mirrors the CI-side precedent test at
// scripts/tests/workflow-wiring.test.mjs:1496 ("register citation check: must be
// unconditional (no if: guard) — issue #3122"), which pins the
// `.github/workflows/verify.yml` step for this exact check; these tests are the
// local half of that same guarantee.
//
// WHY it cannot be a `STEPS[]` entry: scripts/ci-scope.mjs's
// `computeScopes`/`slugFor` auto-derives a `step_<slug>` scope key for EVERY
// `STEPS[]` entry, and workflow-wiring.test.mjs's "every emitted scope key is
// referenced by the workflow" test then requires that key be referenced by some
// `if:` in verify.yml — while the CI-side test above requires the
// register-citation step to have no `if:` at all. A `STEPS[]` entry would drive
// those two tests into direct contradiction.
//
// WHY it is uncached rather than merely unconditional: the checker scans the
// WHOLE git-tracked tree for register-row citations, so neither a diff-scope nor
// any `inputs.globs` set can predict whether a citation broke. Reached only via
// `test:hooks` (the pre-#3271 state), a diff touching any file outside that
// step's globs printed `test:hooks [cached]` and left a broken citation
// stale-green locally.
//
// These tests are written to go RED on the plausible reverts, not just on a
// total deletion of the feature: dropping the script from
// UNCONDITIONAL_LOCAL_CHECK_SCRIPTS (source pin + behavioural), adding a second
// STEPS[] entry for it (source pin), wrapping the call in a cache-hash check or
// a scope gate (source pin), skipping it under
// `--scope-branch`/`--scope-staged` (source pin), restricting it to some other
// subset of full runs (behavioural), and losing the early return that makes a
// broken citation fail the whole run (source pin + behavioural).


// The check this issue wires must be the one the checker script actually
// answers to. Named once, so renaming the npm script fails loudly here instead
// of silently un-pinning the assertions below.
const CHECK_SCRIPT = 'check:register-citations';


test('#3271: check:register-citations is an unconditional local check, not a STEPS[] entry', () => {
  assert.deepEqual(
    [...UNCONDITIONAL_LOCAL_CHECK_SCRIPTS],
    [CHECK_SCRIPT],
    'UNCONDITIONAL_LOCAL_CHECK_SCRIPTS must name exactly the register-citation check — ' +
      'removing it here silently restores the #3140 gap (the check then only runs via ' +
      'test:hooks, which is cache-hash-skipped and scope-gated)',
  );

  assert.ok(
    STEPS.every((s) => s.name !== CHECK_SCRIPT),
    `${CHECK_SCRIPT} must NOT appear in STEPS[]: scripts/ci-scope.mjs auto-derives a ` +
      'step_<slug> scope key for every STEPS[] entry, and workflow-wiring.test.mjs ' +
      'requires that key be referenced by an `if:` in verify.yml — contradicting its own ' +
      '"register citation check: must be unconditional" test (#3122)',
  );
});


function runPipelineBody() {
  const match = src.match(/export async function runPipeline\([\s\S]*?\n\}\n/);
  assert.ok(match, "could not locate runPipeline's function body in verify-cache.mjs");
  return match[0];
}


test('#3271: runPipeline calls the unconditional checks unguarded, outside the cache and scope paths', () => {
  const body = runPipelineBody();

  assert.match(
    body,
    /runUnconditionalLocalChecks\(\{\s*cwd,\s*env\s*\}\)/,
    'runPipeline must call runUnconditionalLocalChecks({ cwd, env }) directly',
  );

  assert.match(
    body,
    /if \(!flags\.steps \|\| flags\.steps\.length === 0\) \{\s*\n\s*const checkCode = await runUnconditionalLocalChecks\(/,
    'the call must be gated only on "this is a full run" (`!flags.steps`) — the same ' +
      'condition the step-selection block above uses to tell "full" from "--steps"-filtered',
  );

  assert.match(
    body,
    /if \(checkCode !== 0\) return checkCode;/,
    'a non-zero exit from the unconditional checks must fail the WHOLE run (early return), ' +
      'exactly like a failed step',
  );

  // The failure modes this test exists to catch: a future "optimisation" that
  // routes the call back through the same machinery that caused #3140.
  assert.doesNotMatch(
    body,
    /decide\(\{[\s\S]{0,200}?stepName: \u0027[^\u0027]*register-citations\u0027/,
    'the register-citation check must not be routed through decide() (the cache-hash ' +
      'skip) — a cached citation check is the #3140 bug itself',
  );
  assert.doesNotMatch(
    body,
    /stepTouchedByDiff\([^)]*register-citations/,
    'the register-citation check must not be scope-filtered — it scans the whole tracked tree',
  );
  // Scope-gating pin, aimed at the current spelling (the scope test is the
  // shared `outOfScope` predicate over scopeDiff/scopeShared, defined AFTER the
  // call). Everything before the call must be free of all three names: the call
  // sits ahead of the scope machinery, so any of them appearing earlier means it
  // was moved under (or after) a scope guard. Asserts the call was located first,
  // so a failed extraction cannot pass vacuously.
  const callIdx = body.indexOf('runUnconditionalLocalChecks({');
  assert.ok(callIdx > 0, 'could not locate the runUnconditionalLocalChecks call in runPipeline');
  assert.doesNotMatch(
    body.slice(0, callIdx),
    /outOfScope|scopeDiff|scopeShared/,
    'the unconditional checks must not be moved under a scope guard — ' +
      'that is exactly the `--scope-branch`/`--scope-staged` skip this issue removes',
  );
});


test('#3271: runUnconditionalLocalChecks spawns via the existing runStepProcess helper', () => {
  const match = src.match(/export async function runUnconditionalLocalChecks\([\s\S]*?\n\}\n/);
  assert.ok(match, 'could not locate runUnconditionalLocalChecks in verify-cache.mjs');
  const body = match[0];

  assert.match(
    body,
    /await runStepProcess\(/,
    'must spawn through the existing runStepProcess helper rather than inventing a new ' +
      'spawn path (same retry/`shell: true`/windowsHide semantics as every STEPS[] step)',
  );
  assert.match(
    body,
    /\[fail\] \$\{script\} \(exit \$\{code\}, took \$\{formatSecs\(dt\)\}\)/,
    'the failure line must match the existing step-output shape ' +
      '`[fail] <name> (exit <n>, took <n>s)`',
  );
  assert.match(
    body,
    /return code;/,
    'must return the failing exit code so runPipeline can fail the run',
  );
});


// The source pins above are cheap but blind to the wiring actually executing.
// These behavioural tests drive runPipeline's real code path against a throwaway
// git repo whose `check:register-citations` script is a one-line node invocation
// (not vitest, so fast).
function writeRegisterCitationFixture(dir, { passing = true } = {}) {
  const marker = join(dir, 'citations-attempts.txt');
  writeFileSync(
    join(dir, 'citations-fixture.mjs'),
    passing
      ? `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'x');\nprocess.exit(0);\n`
      : `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'x');\nprocess.stderr.write('register citation broken: A99 cites a row that does not exist\\n');\nprocess.exit(1);\n`,
    'utf8',
  );
  const pkgPath = join(dir, 'package.json');
  const pkg = existsSync(pkgPath)
    ? JSON.parse(readFileSync(pkgPath, 'utf8'))
    : { name: 'citations-fixture', private: true, scripts: {} };
  pkg.scripts[CHECK_SCRIPT] = 'node citations-fixture.mjs';
  writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8');
  return marker;
}


async function captureLogs(fn) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = originalLog;
  }
}


test('#3271: a full run executes the citation check every time, and never reports it [cached]', async () => {
  const dir = makeGitFixture();
  const marker = writeRegisterCitationFixture(dir);
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);
  const env = { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' };

  // Two consecutive full runs with nothing changed in between — the exact shape
  // that printed `test:hooks [cached]` before #3271.
  for (const run of [1, 2]) {
    const { logs } = await captureLogs(() => runPipeline({ argv: [], cwd: dir, env }));

    assert.ok(
      logs.some((l) => l.startsWith(`[run] ${CHECK_SCRIPT} (unconditional)`)),
      `run ${run}: a full run must print the unconditional [run] line for ${CHECK_SCRIPT}`,
    );
    assert.ok(
      logs.some((l) => l.startsWith(`[pass] ${CHECK_SCRIPT}`)),
      `run ${run}: expected a [pass] line for ${CHECK_SCRIPT} — got:\n${logs.join('\n')}`,
    );
    assert.ok(
      !logs.some((l) => l.includes('[cached]') && l.includes(CHECK_SCRIPT)),
      `run ${run}: the citation check must NEVER be reported [cached] — the checker scans ` +
        'the whole tracked tree, so no input hash can say it is unchanged (#3140)',
    );
    assert.ok(
      !logs.some((l) => l.includes('[skip]') && l.includes(CHECK_SCRIPT)),
      `run ${run}: the citation check must never be scope-skipped`,
    );
    assert.equal(
      readFileSync(marker, 'utf8').length,
      run,
      `run ${run}: the checker must have been spawned exactly once per full run`,
    );
  }
});


test('#3271: a --scope-branch run with EVERY step out of scope still runs the citation check', async () => {
  // makeGitFixture is on `main` with no diff vs main, so scopeDiff is [] and
  // every STEPS[] entry is out of scope. The check must still run: it scans the
  // whole tracked tree, so it can never be scope-gated.
  const dir = makeGitFixture();
  const marker = writeRegisterCitationFixture(dir);
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);
  const env = { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' };

  const { logs } = await captureLogs(() => runPipeline({ argv: ['--scope-branch'], cwd: dir, env }));

  assert.ok(
    logs.some((l) => l.includes('nothing in scope')),
    `expected the all-out-of-scope path — got:\n${logs.join('\n')}`,
  );
  assert.ok(
    logs.some((l) => l.startsWith(`[pass] ${CHECK_SCRIPT}`)),
    `the citation check must run and pass under an all-out-of-scope --scope-branch run — got:\n${logs.join('\n')}`,
  );
  assert.equal(readFileSync(marker, 'utf8').length, 1, 'the checker must have been spawned once');
});


test('#3271: a broken citation fails the whole run with the checker error visible', async () => {
  const dir = makeGitFixture();
  const marker = writeRegisterCitationFixture(dir, { passing: false });
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);
  const env = { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' };

  const { result, logs } = await captureLogs(() => runPipeline({ argv: [], cwd: dir, env }));

  assert.equal(result, 1, 'runPipeline must return the failure exit code');
  assert.equal(readFileSync(marker, 'utf8').length, 1, 'the checker must have run once');
  const failLine = logs.find((l) => l.startsWith(`[fail] ${CHECK_SCRIPT}`));
  assert.ok(
    failLine,
    `expected a [fail] line for ${CHECK_SCRIPT} matching the existing step shape — got:\n${logs.join('\n')}`,
  );
  assert.match(failLine, /\(exit 1, took /);
  // `result === 1` alone doesn't prove the early return fired: STEPS[0] is
  // `lint`, which also fails (with "Missing script") in this throwaway
  // fixture repo, so a deleted `if (checkCode !== 0) return checkCode;`
  // would still leave `result` at 1 for the wrong reason. Assert `lint`
  // never ran (runPipeline logs `[run] ${step.name}` per step) so this only
  // passes when the early return actually short-circuited the pipeline.
  assert.ok(
    !logs.some((l) => l.startsWith('[run] lint')),
    'the early return must short-circuit before any STEPS[] entry runs — got:\n' +
      logs.join('\n'),
  );
});


test('#3271: a --steps run is left alone (the deliberate narrow developer/hook filter)', async () => {
  const dir = makeGitFixture();
  const marker = writeRegisterCitationFixture(dir);
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);
  const env = { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' };

  // The pre-commit hook and package.json's verify:fast* scripts are narrow
  // `--steps` filters, and test:hooks already covers the checker there. Widening
  // them would silently change what the hook costs.
  assert.equal(await runUnconditionalLocalChecks({ cwd: dir, env }), 0);
  assert.equal(readFileSync(marker, 'utf8').length, 1);

  const { logs } = await captureLogs(() =>
    runPipeline({ argv: ['--steps', 'test:hooks'], cwd: dir, env }),
  );
  assert.ok(
    !logs.some((l) => l.startsWith(`[run] ${CHECK_SCRIPT} (unconditional)`)),
    'a --steps run must not run the unconditional local leg',
  );
  assert.equal(
    readFileSync(marker, 'utf8').length,
    1,
    'the checker must not have been spawned again by the --steps run',
  );
});


// check-audit.test.mjs reads audit-waivers.json (the committed-waivers
// validity test) as TEXT at RUNTIME - no module-graph edge. Without this
// extraFiles entry, a waivers-only diff leaves test:hooks [cached] locally and
// skips its CI leg (computeScopes derives from the same STEPS[] entry).
test('stepTouchedByDiff + computeScopes: an audit-waivers.json-only diff puts test:hooks in scope (check-audit.test.mjs reads it at runtime)', () => {
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], ['audit-waivers.json']), true);
  assert.equal(computeScopes(['audit-waivers.json']).step_test_hooks, true);
});

