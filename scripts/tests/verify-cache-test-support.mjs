// Shared fixtures for the scripts/tests/verify-cache.*.test.mjs files (#3701:
// that suite was one ~4400-line file, so node:test ran it on a single core; it
// is now split by topic and each file imports these). Not a test file itself.

import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { runPipeline, STEPS } from '../verify-cache.mjs';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';

// Track temporary directories created by mkTmp() so we can clean them up after all tests.
const createdDirs = [];

export function mkTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-cache-test-'));
  createdDirs.push(dir);
  return dir;
}

// Clean up temporary directories after all tests complete. Best-effort: ignore
// any failures to remove individual directories (e.g., locked files on Windows).
// Only remove directories this run created — never glob %TEMP% to avoid deleting
// another concurrent run's fixtures. (Registered here, at module load, so every
// verify-cache.*.test.mjs that imports the helpers gets its own cleanup.)
after(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore failures (locked files, permissions, etc.)
    }
  }
});

export const stepByName = Object.fromEntries(STEPS.map((s) => [s.name, s]));

export function writeFlakyFixture(
  dir,
  npmScriptName,
  { failFirst = false, alwaysFail = false } = {},
) {
  // Determine fixture filename and marker name based on failure mode.
  let fixtureFile;
  let markerName;
  if (alwaysFail) {
    fixtureFile = 'allfail.mjs';
    markerName = 'attempts-allfail.txt';
  } else if (failFirst) {
    fixtureFile = 'flaky.mjs';
    markerName = 'attempts-flaky.txt';
  } else {
    fixtureFile = 'pass.mjs';
    markerName = 'attempts-pass.txt';
  }
  const marker = join(dir, markerName);

  // Generate fixture code based on failure mode.
  let fixtureCode;
  if (alwaysFail) {
    fixtureCode = `import { appendFileSync } from 'node:fs';
const marker = ${JSON.stringify(marker)};
appendFileSync(marker, 'x');
process.stderr.write('Worker exited unexpectedly\\n');
process.exit(1);
`;
  } else if (failFirst) {
    fixtureCode = `import { existsSync, appendFileSync } from 'node:fs';
const marker = ${JSON.stringify(marker)};
const already = existsSync(marker);
appendFileSync(marker, 'x');
if (!already) {
  process.stderr.write('Worker exited unexpectedly\\n');
  process.exit(1);
}
process.exit(0);
`;
  } else {
    // Always pass
    fixtureCode = `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, 'x');
process.exit(0);
`;
  }

  writeFileSync(join(dir, fixtureFile), fixtureCode, 'utf8');

  // Update or create package.json, merging the new script with existing ones.
  const packageJsonPath = join(dir, 'package.json');
  let packageJson;
  if (existsSync(packageJsonPath)) {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } else {
    packageJson = { name: 'flaky-fixture', private: true, scripts: {} };
  }
  packageJson.scripts[npmScriptName] = `node ${fixtureFile}`;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson), 'utf8');

  return marker;
}

// #3682: a 30s bound flaked on CI Windows at 60553ms. That is the old 60s
// fixture self-exit plus ~0.5s of fixture start, i.e. the signature of a
// PARTIAL kill, not a slow one: the old 400ms budget fired right as npm was
// launching `node hang.mjs`, `taskkill /T` walks a one-instant snapshot of the
// tree, so a fixture spawned just after it survived, kept the piped stderr
// open, and runStepProcess (which resolves on 'close') waited for its
// self-exit. The tests now give the budget STEP_BUDGET_PAST_LAUNCH_MS of
// headroom so the tree is fully spawned when the timer fires, and the fixture
// records its pid so a survivor is named as such instead of as a slow kill.
// The production-side gap (a /T survivor holding the pipe holds the step past
// its budget) is closed by runStepProcess's timeout re-sweep (#3695); the tests
// in verify-cache.run-step.test.mjs cover it.
// The self-exit must still outlive the bound, or a kill that never lands is
// rescued by the fixture's own exit inside the bound and it can no longer fail.
export const KILL_PATH_BOUND_MS = 120_000;
export const HANG_FIXTURE_SELF_EXIT_MS = 300_000;
// npm starts `node hang.mjs` ~0.4s after spawn locally and slower under CI
// contention; 5s leaves an order of magnitude of headroom while keeping the
// passing path to ~5-6s.
export const STEP_BUDGET_PAST_LAUNCH_MS = 5_000;

// A partial kill leaves a descendant holding the piped stderr, so the call under
// test would not return until the fixture's own 300s self-exit — by which time
// the survivor is dead and invisible to a post-hoc pid check. This watch looks
// at the recorded pid SURVIVOR_GRACE_MS after the budget fired (past every
// 15s-capped taskkill/census call in the kill path); a survivor is recorded and
// killed, which also lets the call return promptly instead of after ~300s.
export const SURVIVOR_GRACE_MS = 20_000;
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

// null unless the file holds a real pid: a read landing between the fixture's
// truncating open and its write sees '' -> Number('') === 0, and pid 0 means
// "this process" (the whole group on POSIX) to process.kill — it would SIGKILL
// the test runner itself.
export function readHangPid(dir) {
  const pidFile = join(dir, 'hang.pid');
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function armSurvivorWatch(dir, afterMs = STEP_BUDGET_PAST_LAUNCH_MS + SURVIVOR_GRACE_MS) {
  const watch = { survivorPid: null, disarm: () => clearTimeout(timer) };
  const timer = setTimeout(() => {
    const pid = readHangPid(dir);
    if (pid !== null && pidAlive(pid)) {
      watch.survivorPid = pid;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }, afterMs);
  return watch;
}

// Proves the fixture was running (pid marker exists) before the kill and that
// the WHOLE tree went down (no survivor, recorded pid dead), then checks the
// bound. Always best-effort kills a leftover so a failing run leaves no orphan.
export function assertHangFixtureKilled(dir, elapsed, watch) {
  watch.disarm();
  const pid = readHangPid(dir);
  try {
    assert.ok(
      pid !== null,
      'hang.pid is missing: the fixture never started before the budget fired, so the kill was not exercising a full process tree — raise STEP_BUDGET_PAST_LAUNCH_MS',
    );
    assert.equal(
      watch.survivorPid,
      null,
      `fixture survived the kill (partial kill): pid ${watch.survivorPid} was still alive ${SURVIVOR_GRACE_MS}ms after the budget fired — the tree kill missed a descendant (call returned after ${elapsed}ms)`,
    );
    assert.ok(
      !pidAlive(pid),
      `fixture survived the kill (partial kill): pid ${pid} is still alive after the call returned (took ${elapsed}ms)`,
    );
    assert.ok(
      elapsed < KILL_PATH_BOUND_MS,
      `fixture is dead and no survivor was seen, but the kill path was slow (bound ${KILL_PATH_BOUND_MS}ms, fixture self-exit ${HANG_FIXTURE_SELF_EXIT_MS}ms) — took ${elapsed}ms`,
    );
  } finally {
    if (pid !== null && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

export function writeHangingFixture(dir, npmScriptName) {
  // Deliberately never exits on its own — simulates a genuinely wedged
  // process (the 4h34m incident this feature exists to bound), so a real
  // timeout kill is exercised rather than a step that would have finished by
  // itself. The 300s self-exit is a safety net, not the mechanism under test:
  // if the kill path being tested is itself broken (the exact class of bug
  // this fixture caught on Linux CI — killTree() was a no-op there), this
  // process must not become an unreapable orphan that outlives the test run
  // — confirmed live on a real box (PR #3260 review pass 1, B1): the census
  // sweep that's supposed to catch a `/T`-survivor doesn't recognize a bare
  // `node hang.mjs` as a battery invocation, so it's invisible to
  // runCensus()'s own reap and survives until reboot.
  const fixtureFile = 'hang.mjs';
  writeFileSync(
    join(dir, fixtureFile),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync('hang.pid', String(process.pid));\n` +
      `setInterval(() => {}, 1000);\nsetTimeout(() => process.exit(0), ${HANG_FIXTURE_SELF_EXIT_MS});\n`,
    'utf8',
  );
  const packageJsonPath = join(dir, 'package.json');
  let packageJson;
  if (existsSync(packageJsonPath)) {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } else {
    packageJson = { name: 'flaky-fixture', private: true, scripts: {} };
  }
  packageJson.scripts[npmScriptName] = `node ${fixtureFile}`;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson), 'utf8');
}

// Last COMPLETE heartbeat line of beat.txt ("<t0> <now> <maxGap>\n" per beat).
// Pure so the empty / torn / garbage cases are pinned deterministically (#3419).
export function parseLastHeartbeat(text) {
  const lines = text.split('\n').slice(0, -1);
  assert.ok(lines.length > 0, 'the hanging fixture never completed a heartbeat line');
  const [, last, maxGap] = lines[lines.length - 1].split(' ').map(Number);
  assert.ok(
    Number.isFinite(last) && Number.isFinite(maxGap),
    `heartbeat line must hold finite numbers, got: ${JSON.stringify(lines[lines.length - 1])}`,
  );
  return { last, maxGap };
}

// Runs `fn` with every `powershell` spawn answered instantly with a permanent
// failure (collectProcessSnapshot then returns [] without its retry wait),
// every other spawnSync passing through. The timeout path runs a synchronous
// Win32_Process snapshot BEFORE it kills the step (#3695), so the hanging
// fixture keeps beating through it and the measured span grows by however long
// that query takes. That is 0.8-3.5s locally but 10s on a loaded GitHub
// Windows runner (Castwright#3917: throttled 20068ms vs control 10438ms, the
// same slow-WMI run that also timed out the reaper's C3 collector twice) and
// it hits one of the two compared runs, not both, so no tolerance can absorb
// it. The census is not the property under test; stubbing it removes the
// variable. Restored in `finally`; syncBuiltinESMExports republishes the patch
// to the named `spawnSync` imports in verify-cache.mjs and reap-stale-batteries.mjs.
async function withInstantCensus(fn) {
  const real = childProcess.spawnSync;
  childProcess.spawnSync = (cmd, ...rest) =>
    cmd === 'powershell' ? { status: 1, stdout: '', stderr: '', error: undefined } : real(cmd, ...rest);
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    childProcess.spawnSync = real;
    syncBuiltinESMExports();
  }
}

// Castwright#3361 behavioural pair. Both measure the span the hanging step was
// ALIVE for (first heartbeat -> last heartbeat, written by the fixture itself),
// not the `[timeout] ... after Ns` figure: that one also contains taskkill plus
// a synchronous runCensus (a PowerShell CIM spawn, 0.8-3.5s measured here),
// which is variance unrelated to the budget under test. The fixture dies at the
// kill, so the span ends when the budget fires and excludes kill/census time;
// taskkill latency (a few hundred ms) is NOT excluded and the tolerances allow
// for it. The span is only returned when the log shows the budget ended the
// step (a fixture that exits on its own would otherwise be measured as a cut),
// and the fixture's largest heartbeat gap rides along for failure messages.
export async function runHangingStepSpanMs(extraEnv) {
  const dir = makeGitFixture();
  writeHangingFixture(dir, 'test'); // vitest-backed name => affectedByContention
  writeFileSync(
    join(dir, 'hang.mjs'),
    "import { appendFileSync } from 'node:fs';\n" +
      'const t0 = Date.now();\n' +
      'let prev = t0;\n' +
      'let maxGap = 0;\n' +
      "const beat = () => { const n = Date.now(); maxGap = Math.max(maxGap, n - prev); prev = n; appendFileSync('beat.txt', t0 + ' ' + n + ' ' + maxGap + '\\n'); };\n" +
      'beat();\n' +
      'setInterval(beat, 100);\n' +
      'setTimeout(() => process.exit(0), 60_000);\n',
    'utf8',
  );
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);
  const originalLog = console.log;
  let runLoggedAt = null;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.map(String).join(' '));
    // `[run] test` is logged immediately before the step is spawned, so it
    // stands in for the budget timer's own start (npm/node startup, which
    // varies by seconds under load, is not part of the budget under test).
    if (runLoggedAt === null && String(args[0]).startsWith('[run] test')) runLoggedAt = Date.now();
  };
  let code;
  try {
    code = await withInstantCensus(() =>
      runPipeline({
        argv: ['--steps', 'test'],
        cwd: dir,
        env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1', ...extraEnv },
      }),
    );
  } finally {
    console.log = originalLog;
  }
  assert.notEqual(code, 0, 'the hanging step must time out, not pass');
  assert.ok(
    logs.some((l) => l.startsWith('[timeout] test')),
    `expected the budget (not the fixture) to end the step -- no [timeout] test line, got:\n${logs.join('\n')}`,
  );
  assert.notEqual(runLoggedAt, null, 'expected a `[run] test` log line');
  // The fixture APPENDS one line per beat instead of truncate-then-write. The
  // fixture is killed mid-run, and a truncating write killed (or read) between
  // open and write can expose an EMPTY file; the NaN/undefinedms seen on Linux
  // CI (Castwright#3419) can only come from an empty or truncated beat.txt.
  // Appending removes that window. The specific trigger on Linux CI was not
  // reproduced. Only a newline-terminated line is complete; a torn tail is dropped.
  const beatPath = join(dir, 'beat.txt');
  // The budget starts at spawn, so under load npm/node startup can consume all
  // of it and the step is killed before the fixture's first beat (Castwright#3422).
  assert.ok(
    existsSync(beatPath),
    `fixture never wrote a heartbeat within the budget (startup consumed it); no beat.txt at ${beatPath}\ncaptured logs:\n${logs.join('\n')}`,
  );
  const beatText = readFileSync(beatPath, 'utf8');
  const { last, maxGap } = parseLastHeartbeat(beatText);
  // The span above assumes the fixture died at the kill. With append, a
  // surviving hang.mjs would keep adding lines unnoticed, so prove it stopped.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    readFileSync(join(dir, 'beat.txt'), 'utf8').length,
    beatText.length,
    'the hanging fixture outlived the step kill: beat.txt kept growing after the step ended',
  );
  return { spanMs: last - runLoggedAt, maxGapMs: maxGap };
}

// Strip ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_PREFIX (and anything
// else GIT_-prefixed) before spawning: when this suite runs inside a real git
// hook (pre-commit calls `npm run verify:fast:scoped` -> `npm run
// test:hooks`), git sets these in the process env for the hook, and without
// stripping them these fixture commands would operate on the REAL repo
// instead of the throwaway `cwd`. Case-insensitive match: Windows preserves
// whatever casing a var was stored under while lookup is case-insensitive,
// and git honours a lowercase `git_dir` identically to `GIT_DIR` — a
// destructure keyed on the canonical uppercase names alone (the pre-#2841
// shape here) leaves a differently-cased survivor that still redirects these
// fixture commands at the real repo. Demonstrated live: an ambient lowercase
// `git_dir` flipped a real checkout's `core.bare` from false to true via
// `makeGitFixture()`'s `git init` below.
// Thin wrapper over the shared, broader-than-scrubGitEnv() helper — see
// git-env.mjs's scrubGitEnv() docstring for the case-insensitivity rationale,
// and why this needs a separate helper from scrubGitEnv().
export function cleanGitEnv() {
  return scrubGitEnvForThrowawayRepo();
}

export function gitAt(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

// Builds a throwaway repo with one commit on a `main` branch, so tests can
// exercise branchDiffFiles' real `git merge-base` + `git diff` calls without
// touching this actual repo.
export function makeGitFixture() {
  const dir = mkTmp();
  gitAt(dir, ['init', '-q', '-b', 'main']);
  gitAt(dir, ['config', 'user.email', 'test@example.com']);
  gitAt(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'base.txt'), 'base', 'utf8');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}
