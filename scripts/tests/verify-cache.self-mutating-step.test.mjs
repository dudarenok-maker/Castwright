// runPipeline cache-write guards against a step that mutates its own inputs
// while it runs (#3393 / #3413).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  runPipeline,
  _internals,
} from '../verify-cache.mjs';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';
import {
  gitAt,
  makeGitFixture,
} from './verify-cache-test-support.mjs';


// Castwright#3413: a step whose own inputs change while it runs must not be
// cached under its start-time hash. `check:onbox-register` runs `s.mjs`, which
// (optionally) rewrites/creates a file inside that step's own globs and exits 0.
async function runSelfMutatingStepFixture({ mutation }) {
  const dir = makeGitFixture();
  const register = 'docs/testing/onbox-acceptance-register.md';
  const created = 'scripts/created.mjs';
  mkdirSync(dirname(join(dir, register)), { recursive: true });
  writeFileSync(join(dir, register), 'orig', 'utf8');
  const body =
    mutation === 'rewrite'
      ? `writeFileSync(${JSON.stringify(join(dir, register))}, 'mutated');`
      : mutation === 'create'
        ? `mkdirSync(${JSON.stringify(dirname(join(dir, created)))}, { recursive: true });\nwriteFileSync(${JSON.stringify(join(dir, created))}, 'x');`
        : '';
  writeFileSync(
    join(dir, 's.mjs'),
    `import { writeFileSync, mkdirSync } from 'node:fs';\n${body}\nprocess.exit(0);\n`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'self-mutating-fixture',
      private: true,
      scripts: { 'check:onbox-register': 'node s.mjs' },
    }),
    'utf8',
  );
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);

  const run = async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      const result = await runPipeline({
        argv: ['--steps', 'check:onbox-register'],
        cwd: dir,
        env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
      });
      return { result, logs };
    } finally {
      console.log = originalLog;
    }
  };

  const first = await run();
  assert.equal(first.result, 0, `run 1 must pass:\n${first.logs.join('\n')}`);
  const cacheEntry = () => {
    const cacheFile = join(dir, _internals.CACHE_FILENAME);
    if (!existsSync(cacheFile)) return undefined;
    return JSON.parse(readFileSync(cacheFile, 'utf8')).steps?.['check:onbox-register'];
  };
  const entryAfterFirst = cacheEntry();
  // put the inputs back exactly as they were when run 1 started
  if (mutation === 'rewrite') writeFileSync(join(dir, register), 'orig', 'utf8');
  if (mutation === 'create') rmSync(join(dir, created));
  const second = await run();
  return { first, second, entryAfterFirst };
}


for (const mutation of ['rewrite', 'create']) {
  test(`runPipeline: a step whose own inputs change while it runs (${mutation}) is not cached (#3413)`, async () => {
    const { first, second, entryAfterFirst } = await runSelfMutatingStepFixture({ mutation });
    assert.equal(entryAfterFirst, undefined, 'no cache entry may be written for the self-mutating step');
    assert.ok(
      !second.logs.some((l) => l.includes('[cached] check:onbox-register')),
      `the entry would vouch for content the step did not fully run against:\n${second.logs.join('\n')}`,
    );
    assert.ok(second.logs.some((l) => l.includes('[run] check:onbox-register')));
    assert.ok(
      first.logs.some((l) => l.includes('check:onbox-register inputs changed while it ran; not caching')),
      `run 1 must log the not-caching line:\n${first.logs.join('\n')}`,
    );
  });
}


test('runPipeline: a step that leaves its inputs alone is still cached (#3413 control)', async () => {
  const { first, second, entryAfterFirst } = await runSelfMutatingStepFixture({ mutation: 'none' });
  assert.ok(!first.logs.some((l) => l.includes('not caching')), first.logs.join('\n'));
  assert.ok(entryAfterFirst, 'an input-stable step must write its cache entry');
  assert.ok(
    second.logs.some((l) => l.includes('[cached] check:onbox-register')),
    second.logs.join('\n'),
  );
});


// Castwright#3413 review pass 2: the external writer of an edit-and-restore
// test. Every wait is bounded by a deadline that throws a clear message, so a
// run that never starts the step fails the test instead of hanging it. The
// promise is `.catch`-observed so an unawaited rejection can't crash the runner
// when the caller bails out on run 1's assertion first.
function abaWriter({ started, sawMutated, file, mutated, restored, deadlineMs = 15000 }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (path, what) => {
    const end = Date.now() + deadlineMs;
    while (!existsSync(path)) {
      if (Date.now() > end) throw new Error(`abaWriter: timed out waiting for ${what} (${path})`);
      await sleep(20);
    }
  };
  const p = (async () => {
    await until(started, 'the step to start');
    await sleep(100);
    writeFileSync(file, mutated, 'utf8');
    await until(sawMutated, 'the step to see the edit');
    await sleep(100);
    writeFileSync(file, restored, 'utf8');
  })();
  p.catch(() => {});
  return p;
}


// Castwright#3413 review pass 1: an input edited AND restored while its own step
// runs has the same CONTENT at step end as at step start, so a content-only
// re-hash would cache it. The step below passes only because it saw `mutated`
// (it exits 1 on `orig`); an external writer edits the register after the step
// starts and restores it once the step has read the edit. Run 2 must re-run.
test('runPipeline: an input edited and restored while its own step runs is not cached (#3413)', async () => {
  const dir = makeGitFixture();
  const side = mkdtempSync(join(tmpdir(), 'aba-side-'));
  try {
    const register = join(dir, 'docs/testing/onbox-acceptance-register.md');
    mkdirSync(dirname(register), { recursive: true });
    writeFileSync(register, 'orig', 'utf8');
    const started = join(side, 'started');
    const sawMutated = join(side, 'saw');
    writeFileSync(
      join(dir, 's.mjs'),
      `import { readFileSync, writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(${JSON.stringify(started)}, '1');
let ok = false;
for (let i = 0; i < 100; i++) { if (readFileSync(${JSON.stringify(register)}, 'utf8') === 'mutated') { ok = true; break; } await sleep(50); }
if (!ok) process.exit(1);
writeFileSync(${JSON.stringify(sawMutated)}, '1');
for (let i = 0; i < 100; i++) { if (readFileSync(${JSON.stringify(register)}, 'utf8') === 'orig') break; await sleep(50); }
process.exit(0);
`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'aba-fixture',
        private: true,
        scripts: { 'check:onbox-register': 'node s.mjs' },
      }),
      'utf8',
    );
    gitAt(dir, ['add', '.']);
    gitAt(dir, ['commit', '-q', '-m', 'fixture']);

    const writer = abaWriter({ started, sawMutated, file: register, mutated: 'mutated', restored: 'orig' });

    const run = async () => {
      const logs = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));
      try {
        const result = await runPipeline({
          argv: ['--steps', 'check:onbox-register'],
          cwd: dir,
          env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
        });
        return { result, logs };
      } finally {
        console.log = originalLog;
      }
    };
    const first = await run();
    // Assert run 1 BEFORE awaiting the writer: if run 1 never started the step,
    // fail here with its log rather than waiting on a writer that never fires.
    assert.equal(first.result, 0, `run 1 must pass (the step saw the edit):\n${first.logs.join('\n')}`);
    await writer;
    assert.equal(readFileSync(register, 'utf8'), 'orig', 'the register ends restored');
    const second = await run();
    assert.ok(
      !second.logs.some((l) => l.includes('[cached] check:onbox-register')),
      `the step exits 1 on the restored content; it must not be [cached]:\n${second.logs.join('\n')}`,
    );
    assert.equal(second.result, 1);
  } finally {
    rmSync(side, { recursive: true, force: true });
  }
});


// Castwright#3413 review pass 2: `audit` has `globs: []`, so its lockfile is its
// ONLY real input. The lockfile is hashed (pickLockHashes) but was not in the
// stat signature, so an edit-and-restore of it mid-step was cached.
// Both lockfile-only audit steps are run: `audit:server`'s lockfile joins the
// stat signature through its own `'server'` line, which `audit` never reaches.
for (const { stepName, lockRel } of [
  { stepName: 'audit', lockRel: 'package-lock.json' },
  { stepName: 'audit:server', lockRel: 'server/package-lock.json' },
]) {

test(`runPipeline: a lockfile edited and restored while the ${stepName} step runs is not cached (#3413)`, async () => {
  const dir = makeGitFixture();
  const side = mkdtempSync(join(tmpdir(), 'lockaba-side-'));
  try {
    const lock = join(dir, lockRel);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '{"v":"orig"}', 'utf8');
    writeFileSync(join(dir, 'audit-waivers.json'), '[]', 'utf8');
    const started = join(side, 'started');
    const sawMutated = join(side, 'saw');
    writeFileSync(
      join(dir, 's.mjs'),
      `import { readFileSync, writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(${JSON.stringify(started)}, '1');
let ok = false;
for (let i = 0; i < 100; i++) { if (readFileSync(${JSON.stringify(lock)}, 'utf8').includes('mutated')) { ok = true; break; } await sleep(50); }
if (!ok) process.exit(1);
writeFileSync(${JSON.stringify(sawMutated)}, '1');
for (let i = 0; i < 100; i++) { if (readFileSync(${JSON.stringify(lock)}, 'utf8').includes('orig')) break; await sleep(50); }
process.exit(0);
`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'lockaba-fixture', private: true, scripts: { [stepName]: 'node s.mjs' } }),
      'utf8',
    );
    gitAt(dir, ['add', '.']);
    gitAt(dir, ['commit', '-q', '-m', 'fixture']);

    const writer = abaWriter({ started, sawMutated, file: lock, mutated: '{"v":"mutated"}', restored: '{"v":"orig"}' });
    const run = async () => {
      const logs = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));
      try {
        const result = await runPipeline({
          argv: ['--steps', stepName],
          cwd: dir,
          env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
        });
        return { result, logs };
      } finally {
        console.log = originalLog;
      }
    };
    const first = await run();
    assert.equal(first.result, 0, `run 1 must pass (the step saw the edit):\n${first.logs.join('\n')}`);
    await writer;
    assert.equal(readFileSync(lock, 'utf8'), '{"v":"orig"}', 'the lockfile ends restored');
    assert.ok(
      first.logs.some((l) => l.includes(`${stepName} inputs changed while it ran; not caching`)),
      `run 1 must log the not-caching line:\n${first.logs.join('\n')}`,
    );
    const cacheFile = join(dir, _internals.CACHE_FILENAME);
    const entry = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')).steps?.[stepName] : undefined;
    assert.equal(entry, undefined, 'no cache entry may be written for the lockfile-ABA step');
    const second = await run();
    assert.ok(
      !second.logs.some((l) => l.includes(`[cached] ${stepName}`)),
      `the step exits 1 on the restored lockfile; it must not be [cached]:\n${second.logs.join('\n')}`,
    );
    assert.equal(second.result, 1);
  } finally {
    rmSync(side, { recursive: true, force: true });
  }
});
}


test('runPipeline: a per-step file listing that fails mid-run logs the uncached notice once and writes no entry (#3393 pass 4)', async () => {
  const dir = makeGitFixture();
  // Step A corrupts the git index, so step B's re-taken `git ls-files` fails.
  writeFileSync(
    join(dir, 'a.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, '.git', 'index'))}, 'garbage');\n`,
    'utf8',
  );
  writeFileSync(join(dir, 'b.mjs'), 'process.exit(0);\n', 'utf8');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'listing-fails-fixture',
      private: true,
      scripts: { lint: 'node a.mjs', 'check:onbox-register': 'node b.mjs' },
    }),
    'utf8',
  );
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'fixture']);

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let result;
  try {
    result = await runPipeline({
      argv: ['--steps', 'lint,check:onbox-register'],
      cwd: dir,
      env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result, 0, `both steps must still run and pass:\n${logs.join('\n')}`);
  assert.ok(logs.some((l) => l.includes('[run] check:onbox-register')), logs.join('\n'));
  assert.equal(
    logs.filter((l) => l.includes('[verify-cache] git ls-files failed; running uncached')).length,
    1,
    `the mid-run listing failure must be announced exactly once:\n${logs.join('\n')}`,
  );
  // A's own post-run listing already fails (it corrupted the index), so since
  // #3413 no entry is written for A either and the cache file may not exist.
  const cachePath = join(dir, '.verify-cache.json');
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { steps: {} };
  assert.equal(cache.steps['check:onbox-register'], undefined, 'no cache entry for the uncached step');
});


test('runPipeline: a start-of-step listing that fails after a --changed-only predecessor logs the uncached notice once and writes no entry (#3393 pass 4)', async () => {
  // A `--changed`-only pass gets no post-run re-take (#3413), so the failed
  // listing is first hit by the NEXT step's start-of-step re-take.
  const dir = makeGitFixture();
  const srcFile = join(dir, 'src', 'index.ts');
  mkdirSync(dirname(srcFile), { recursive: true });
  writeFileSync(srcFile, 'export default 1;', 'utf8');
  writeFileSync(
    join(dir, 'corrupt.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, '.git', 'index'))}, 'garbage');\n`,
    'utf8',
  );
  writeFileSync(join(dir, 'ok.mjs'), 'process.exit(0);\n', 'utf8');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'changed-only-listing-fails-fixture',
      private: true,
      scripts: { 'test:changed': 'node corrupt.mjs', build: 'node ok.mjs' },
    }),
    'utf8',
  );
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'base']);
  // a staged diff confined to src/*.ts makes `test` run via test:changed
  writeFileSync(srcFile, 'export default 2;', 'utf8');
  gitAt(dir, ['add', '.']);

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let result;
  try {
    result = await runPipeline({
      argv: ['--steps', 'test,build', '--scope-staged'],
      cwd: dir,
      env: { ...scrubGitEnvForThrowawayRepo(process.env), SKIP_CONTENTION_CHECK: '1' },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result, 0, `both steps must still run and pass:\n${logs.join('\n')}`);
  assert.ok(logs.some((l) => l.includes('[run] test (--changed HEAD only)')), logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('[run] build')), logs.join('\n'));
  assert.equal(
    logs.filter((l) => l.includes('[verify-cache] git ls-files failed; running uncached')).length,
    1,
    `the start-of-step listing failure must be announced exactly once:\n${logs.join('\n')}`,
  );
  const cachePath = join(dir, '.verify-cache.json');
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { steps: {} };
  assert.equal(cache.steps.build, undefined, 'no cache entry for the step run uncached');
  assert.equal(cache.steps.test, undefined, 'a --changed-only pass is never cached');
});

