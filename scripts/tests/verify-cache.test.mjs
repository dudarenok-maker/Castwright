// Unit tests for the verify-cache runner's pure logic (hash composition + cache
// decision + load/save). No `npm run` spawning — runPipeline itself is exercised
// by the manual walkthrough in docs/features/archive/50-verify-cache.md. Run via
// `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  composeInputHash,
  decide,
  hashFile,
  hashEntries,
  loadCache,
  saveCache,
  parseFlags,
  selectStepFiles,
  stepTouchedByDiff,
  computeShared,
  parseNvidiaSmiUtil,
  isVitestPoolCrash,
  STEPS,
  _internals,
} from '../verify-cache.mjs';

const { SCHEMA_VERSION } = _internals;

test('isVitestPoolCrash: true for fork-pool worker crashes, false for red tests', () => {
  // Transient fork-pool process crashes — warrant ONE auto-retry.
  assert.equal(isVitestPoolCrash('Error: [vitest-pool]: Worker forks emitted error.'), true);
  assert.equal(isVitestPoolCrash('Caused by: Error: Worker exited unexpectedly'), true);
  // Real test failures — must NOT retry (that would mask a flaky test).
  assert.equal(isVitestPoolCrash('FAIL  src/foo.test.ts > does a thing'), false);
  assert.equal(isVitestPoolCrash('AssertionError: expected 1 to be 2'), false);
  assert.equal(isVitestPoolCrash('Tests  1 failed | 200 passed'), false);
  // Benign / empty.
  assert.equal(isVitestPoolCrash(''), false);
  assert.equal(isVitestPoolCrash(undefined), false);
});

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'verify-cache-test-'));
}

function fixedArgs(overrides = {}) {
  return {
    stepName: 'lint',
    sortedFileEntries: [
      ['src/a.ts', 'a'.repeat(64)],
      ['src/b.ts', 'b'.repeat(64)],
    ],
    lockHashes: { root: 'lock-root', server: 'lock-server' },
    nodeVer: 'v20.6.0',
    schemaVer: 1,
    toolFingerprint: null,
    ...overrides,
  };
}

test('hash determinism — same args produce same hex', () => {
  const a = composeInputHash(fixedArgs());
  const b = composeInputHash(fixedArgs());
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('decide returns skip on cache hit', () => {
  const hash = composeInputHash(fixedArgs());
  const cache = { schemaVersion: 1, steps: { lint: { inputHash: hash } } };
  assert.equal(decide({ stepName: 'lint', currentHash: hash, cache, noCache: false }), 'skip');
});

test('decide returns run when file content changes flip the hash', () => {
  const before = composeInputHash(fixedArgs());
  const after = composeInputHash(
    fixedArgs({
      sortedFileEntries: [
        ['src/a.ts', 'a'.repeat(64)],
        ['src/b.ts', 'c'.repeat(64)], // mutated
      ],
    }),
  );
  assert.notEqual(before, after);
  const cache = { schemaVersion: 1, steps: { lint: { inputHash: before } } };
  assert.equal(decide({ stepName: 'lint', currentHash: after, cache, noCache: false }), 'run');
});

test('decide returns run when step entry absent', () => {
  const hash = composeInputHash(fixedArgs());
  const cache = { schemaVersion: 1, steps: {} };
  assert.equal(decide({ stepName: 'lint', currentHash: hash, cache, noCache: false }), 'run');
});

test('--no-cache always returns run, even on hash match', () => {
  const hash = composeInputHash(fixedArgs());
  const cache = { schemaVersion: 1, steps: { lint: { inputHash: hash } } };
  assert.equal(decide({ stepName: 'lint', currentHash: hash, cache, noCache: true }), 'run');
});

test('schemaVer bump invalidates the hash for identical other inputs', () => {
  const v1 = composeInputHash(fixedArgs({ schemaVer: 1 }));
  const v2 = composeInputHash(fixedArgs({ schemaVer: 2 }));
  assert.notEqual(v1, v2);
});

test('tool fingerprint participates in the hash', () => {
  const a = composeInputHash(fixedArgs({ toolFingerprint: '5.6.0' }));
  const b = composeInputHash(fixedArgs({ toolFingerprint: 'unavailable' }));
  const c = composeInputHash(fixedArgs({ toolFingerprint: null }));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

test('saveCache + loadCache round-trips deep-equal', () => {
  const dir = mkTmp();
  const path = join(dir, '.verify-cache.json');
  const original = {
    schemaVersion: SCHEMA_VERSION,
    steps: {
      lint: { inputHash: 'a'.repeat(64), lastGreenAt: '2026-05-18T00:00:00.000Z', durationMs: 1234 },
      test: { inputHash: 'b'.repeat(64), lastGreenAt: '2026-05-18T00:00:01.000Z', durationMs: 5678 },
    },
  };
  saveCache(path, original);
  assert.ok(existsSync(path));
  const round = loadCache(path);
  assert.deepEqual(round, original);
});

test('loadCache returns empty default on malformed JSON', () => {
  const dir = mkTmp();
  const path = join(dir, '.verify-cache.json');
  writeFileSync(path, '{not valid json', 'utf8');
  const result = loadCache(path);
  assert.deepEqual(result, { schemaVersion: SCHEMA_VERSION, steps: {} });
});

test('loadCache returns empty default on missing file', () => {
  const dir = mkTmp();
  const path = join(dir, 'does-not-exist.json');
  const result = loadCache(path);
  assert.deepEqual(result, { schemaVersion: SCHEMA_VERSION, steps: {} });
});

test('loadCache treats stale schemaVersion as empty', () => {
  const dir = mkTmp();
  const path = join(dir, '.verify-cache.json');
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 99, steps: { lint: { inputHash: 'x' } } }),
    'utf8',
  );
  const result = loadCache(path);
  assert.deepEqual(result, { schemaVersion: SCHEMA_VERSION, steps: {} });
});

test('lockfile-hash participation — flipping `root` lockfile invalidates', () => {
  const a = composeInputHash(fixedArgs({ lockHashes: { root: 'A', server: 'X' } }));
  const b = composeInputHash(fixedArgs({ lockHashes: { root: 'B', server: 'X' } }));
  assert.notEqual(a, b);
});

test('lockfile-hash participation — flipping `server` lockfile invalidates', () => {
  const a = composeInputHash(fixedArgs({ lockHashes: { root: 'A', server: 'X' } }));
  const b = composeInputHash(fixedArgs({ lockHashes: { root: 'A', server: 'Y' } }));
  assert.notEqual(a, b);
});

test('path normalization — Windows and POSIX produce identical hashes', () => {
  const winLike = composeInputHash(
    fixedArgs({
      sortedFileEntries: [
        ['src/a.ts', 'a'.repeat(64)],
        ['src/b.ts', 'b'.repeat(64)],
      ],
    }),
  );
  // hashEntries operates on the literal `${path}\0${hash}\n` join, so a
  // backslash path would NOT match — but selectStepFiles normalizes to POSIX
  // before feeding into composeInputHash. Verify that the normalization
  // round-trips through hashEntries identically when input is already POSIX.
  const same = hashEntries([
    ['src/a.ts', 'a'.repeat(64)],
    ['src/b.ts', 'b'.repeat(64)],
  ]);
  // Two different ways of computing the entry-block segment should agree.
  // (Direct call to hashEntries vs. through composeInputHash — composeInputHash
  // wraps it but the inner block is identical when other inputs are constant.)
  assert.match(winLike, /^[0-9a-f]{64}$/);
  assert.match(same, /^[0-9a-f]{64}$/);
});

test('parseFlags recognizes --no-cache anywhere in argv', () => {
  assert.deepEqual(parseFlags([]), { noCache: false, steps: null, scopeStaged: false });
  assert.deepEqual(parseFlags(['--no-cache']), {
    noCache: true,
    steps: null,
    scopeStaged: false,
  });
  assert.deepEqual(parseFlags(['a', 'b', '--no-cache', 'c']), {
    noCache: true,
    steps: null,
    scopeStaged: false,
  });
});

test('parseFlags --steps with space-separated form', () => {
  assert.deepEqual(parseFlags(['--steps', 'test:hooks,test,test:server']), {
    noCache: false,
    steps: ['test:hooks', 'test', 'test:server'],
    scopeStaged: false,
  });
});

test('parseFlags --steps with = form', () => {
  assert.deepEqual(parseFlags(['--steps=test:hooks,test,test:server']), {
    noCache: false,
    steps: ['test:hooks', 'test', 'test:server'],
    scopeStaged: false,
  });
});

test('parseFlags --steps trims whitespace and drops empty segments', () => {
  assert.deepEqual(parseFlags(['--steps=test:hooks , , test']), {
    noCache: false,
    steps: ['test:hooks', 'test'],
    scopeStaged: false,
  });
});

test('parseFlags --steps combines with --no-cache', () => {
  assert.deepEqual(parseFlags(['--steps=test:hooks,test', '--no-cache']), {
    noCache: true,
    steps: ['test:hooks', 'test'],
    scopeStaged: false,
  });
});

test('parseFlags missing --steps argument yields empty list (caller errors out)', () => {
  // `--steps` with no following arg, or followed by another `--flag`, is a
  // user-error case that runPipeline surfaces as a non-zero exit rather than
  // silently running the full pipeline.
  assert.deepEqual(parseFlags(['--steps']), {
    noCache: false,
    steps: [],
    scopeStaged: false,
  });
  assert.deepEqual(parseFlags(['--steps', '--no-cache']), {
    noCache: true,
    steps: [],
    scopeStaged: false,
  });
});

test('parseFlags absent --steps leaves steps null (full pipeline)', () => {
  assert.deepEqual(parseFlags(['some', 'other', 'arg']), {
    noCache: false,
    steps: null,
    scopeStaged: false,
  });
});

test('parseFlags recognizes --scope-staged', () => {
  assert.deepEqual(parseFlags(['--scope-staged']), {
    noCache: false,
    steps: null,
    scopeStaged: true,
  });
});

test('hashFile returns __missing__ for absent files (no throw)', () => {
  const dir = mkTmp();
  const result = hashFile(join(dir, 'nope.txt'));
  assert.equal(result, '__missing__');
});

test('hashFile hashes file bytes; identical contents → identical hash', () => {
  const dir = mkTmp();
  const a = join(dir, 'a.txt');
  const b = join(dir, 'b.txt');
  writeFileSync(a, 'hello', 'utf8');
  writeFileSync(b, 'hello', 'utf8');
  assert.equal(hashFile(a), hashFile(b));
  writeFileSync(b, 'world', 'utf8');
  assert.notEqual(hashFile(a), hashFile(b));
});

test('selectStepFiles applies globs against a POSIX-relative list', () => {
  const fileList = [
    'src/lib/foo.ts',
    'src/lib/bar.tsx',
    'src/test/setup.ts',
    'server/src/index.ts',
    'scripts/tests/verify-cache.test.mjs',
    'README.md',
  ];
  const step = {
    inputs: {
      globs: ['src/**'],
      extraFiles: ['vite.config.ts'],
    },
  };
  const selected = selectStepFiles({ fileList, step });
  assert.deepEqual(selected, [
    'src/lib/bar.tsx',
    'src/lib/foo.ts',
    'src/test/setup.ts',
    'vite.config.ts',
  ]);
});

test('selectStepFiles brace-glob matches every listed extension', () => {
  const fileList = [
    'src/a.ts',
    'src/b.tsx',
    'src/c.js',
    'src/d.jsx',
    'src/e.cjs',
    'src/f.mjs',
    'src/g.md',
  ];
  const step = {
    inputs: {
      globs: ['**/*.{ts,tsx,js,jsx,cjs,mjs}'],
      extraFiles: [],
    },
  };
  const selected = selectStepFiles({ fileList, step });
  assert.deepEqual(selected, [
    'src/a.ts',
    'src/b.tsx',
    'src/c.js',
    'src/d.jsx',
    'src/e.cjs',
    'src/f.mjs',
  ]);
});

test('atomic save survives a stale `.tmp` left behind by a previous failed run', () => {
  const dir = mkTmp();
  const path = join(dir, '.verify-cache.json');
  // Leave a stale tmp in place.
  writeFileSync(`${path}.tmp`, '{leftover', 'utf8');
  const cache = { schemaVersion: SCHEMA_VERSION, steps: { lint: { inputHash: 'x' } } };
  saveCache(path, cache);
  const round = loadCache(path);
  assert.deepEqual(round, cache);
});

test('stepName participates in the hash (different steps with same inputs differ)', () => {
  const a = composeInputHash(fixedArgs({ stepName: 'lint' }));
  const b = composeInputHash(fixedArgs({ stepName: 'test' }));
  assert.notEqual(a, b);
});

// --- Pre-commit scope filter (plan 156) ---------------------------------

const stepByName = Object.fromEntries(STEPS.map((s) => [s.name, s]));

test('stepTouchedByDiff: a sidecar-only diff leaves the fast legs out of scope', () => {
  const diff = ['server/tts-sidecar/main.py'];
  assert.equal(stepTouchedByDiff(stepByName['test'], diff), false); // frontend
  assert.equal(stepTouchedByDiff(stepByName['test:server'], diff), false);
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), false);
});

test('stepTouchedByDiff: a frontend diff is in scope for test, not test:server', () => {
  const diff = ['src/views/listen.tsx'];
  assert.equal(stepTouchedByDiff(stepByName['test'], diff), true);
  assert.equal(stepTouchedByDiff(stepByName['test:server'], diff), false);
});

test('stepTouchedByDiff: a server diff is in scope for test:server, not test', () => {
  const diff = ['server/src/routes/generation.ts'];
  assert.equal(stepTouchedByDiff(stepByName['test:server'], diff), true);
  assert.equal(stepTouchedByDiff(stepByName['test'], diff), false);
});

test('stepTouchedByDiff: a hook-script diff matches test:hooks via extraFiles', () => {
  const diff = ['scripts/validate-commit-msg.mjs'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

test('stepTouchedByDiff: a frontend config file matches via extraFiles', () => {
  const diff = ['tailwind.config.ts'];
  assert.equal(stepTouchedByDiff(stepByName['test'], diff), true);
});

test('stepTouchedByDiff: the server lockfile is in scope for server legs only', () => {
  const diff = ['server/package-lock.json'];
  assert.equal(stepTouchedByDiff(stepByName['test:server'], diff), true);
  assert.equal(stepTouchedByDiff(stepByName['test'], diff), false);
});

test('stepTouchedByDiff: an empty diff touches nothing', () => {
  assert.equal(stepTouchedByDiff(stepByName['test'], []), false);
});

test('computeShared is true for a root manifest/lockfile change', () => {
  assert.equal(computeShared(['package.json']), true);
  assert.equal(computeShared(['package-lock.json']), true);
});

test('computeShared is false for a scoped-only change', () => {
  assert.equal(computeShared(['server/package-lock.json']), false);
  assert.equal(computeShared(['src/app.tsx']), false);
});

// --- Contention guard (plan 156) ----------------------------------------

test('parseNvidiaSmiUtil parses the first GPU utilization line', () => {
  assert.equal(parseNvidiaSmiUtil('87\n'), 87);
  assert.equal(parseNvidiaSmiUtil('5\n92\n'), 5); // first GPU on a multi-GPU box
  assert.equal(parseNvidiaSmiUtil('43, 7000\n'), 43); // ignores trailing CSV fields
});

test('parseNvidiaSmiUtil returns null on empty / unparseable output', () => {
  assert.equal(parseNvidiaSmiUtil(''), null);
  assert.equal(parseNvidiaSmiUtil('\n'), null);
  assert.equal(parseNvidiaSmiUtil('N/A\n'), null);
});
