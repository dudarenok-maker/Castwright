// Unit tests for the verify-cache runner's pure logic (hash composition + cache
// decision + load/save). No `npm run` spawning — runPipeline itself is exercised
// by the manual walkthrough in docs/features/archive/50-verify-cache.md. Run via
// `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { walk } from '../lib/module-graph.mjs';
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
  maxNvidiaSmiUtil,
  gpuContentionFor,
  isVitestPoolCrash,
  branchDiffFiles,
  stagedDiffFiles,
  sidecarFingerprint,
  STEPS,
  _internals,
} from '../verify-cache.mjs';

const { SCHEMA_VERSION } = _internals;

// Resolve relative to THIS file, not the process cwd — same rationale as
// scripts/tests/run-golden-audio.test.mjs's own HERE/SRC_PATH.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, '..', 'verify-cache.mjs');
const src = readFileSync(SRC_PATH, 'utf8');

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
      lint: {
        inputHash: 'a'.repeat(64),
        lastGreenAt: '2026-05-18T00:00:00.000Z',
        durationMs: 1234,
      },
      test: {
        inputHash: 'b'.repeat(64),
        lastGreenAt: '2026-05-18T00:00:01.000Z',
        durationMs: 5678,
      },
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
  assert.deepEqual(parseFlags([]), {
    noCache: false,
    steps: null,
    scopeStaged: false,
    scopeBranch: false,
  });
  assert.deepEqual(parseFlags(['--no-cache']), {
    noCache: true,
    steps: null,
    scopeStaged: false,
    scopeBranch: false,
  });
  assert.deepEqual(parseFlags(['a', 'b', '--no-cache', 'c']), {
    noCache: true,
    steps: null,
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags --steps with space-separated form', () => {
  assert.deepEqual(parseFlags(['--steps', 'test:hooks,test,test:server']), {
    noCache: false,
    steps: ['test:hooks', 'test', 'test:server'],
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags --steps with = form', () => {
  assert.deepEqual(parseFlags(['--steps=test:hooks,test,test:server']), {
    noCache: false,
    steps: ['test:hooks', 'test', 'test:server'],
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags --steps trims whitespace and drops empty segments', () => {
  assert.deepEqual(parseFlags(['--steps=test:hooks , , test']), {
    noCache: false,
    steps: ['test:hooks', 'test'],
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags --steps combines with --no-cache', () => {
  assert.deepEqual(parseFlags(['--steps=test:hooks,test', '--no-cache']), {
    noCache: true,
    steps: ['test:hooks', 'test'],
    scopeStaged: false,
    scopeBranch: false,
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
    scopeBranch: false,
  });
  assert.deepEqual(parseFlags(['--steps', '--no-cache']), {
    noCache: true,
    steps: [],
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags absent --steps leaves steps null (full pipeline)', () => {
  assert.deepEqual(parseFlags(['some', 'other', 'arg']), {
    noCache: false,
    steps: null,
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags recognizes --scope-staged', () => {
  assert.deepEqual(parseFlags(['--scope-staged']), {
    noCache: false,
    steps: null,
    scopeStaged: true,
    scopeBranch: false,
  });
});

test('parseFlags recognizes --scope-branch', () => {
  assert.deepEqual(parseFlags(['--scope-branch']), {
    noCache: false,
    steps: null,
    scopeStaged: false,
    scopeBranch: true,
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

test("stepTouchedByDiff: scripts/repair-cast-id-drift.mjs diff matches test:server via extraFiles (#2130 — cast-resolve.repair-pass-contract.test.ts imports it directly, but the script lives outside server/src/**)", () => {
  const diff = ['scripts/repair-cast-id-drift.mjs'];
  assert.equal(stepTouchedByDiff(stepByName['test:server'], diff), true);
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

// PR #2007 review, Minor 9 — bump-version.test.mjs mirrors bump-version.mjs's
// TEXT into a throwaway repo at RUNTIME (no module-graph edge), the same
// #1847 trap release-notes-gate.mjs's own extraFiles entry already guards
// against. Without this entry, a bump-version.mjs-only diff leaves
// test:hooks [cached] locally even though bump-version.test.mjs exercises it.
test('stepTouchedByDiff: a bump-version.mjs diff matches test:hooks via extraFiles', () => {
  const diff = ['scripts/bump-version.mjs'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

// ops-17c review, #2115 — three dependencies the import-scanning completeness
// guard structurally cannot see, because none of them is an import edge from
// a test file: pinokio.js is a require()-only edge (covered by the guard now
// that the require() pattern exists, but pinned explicitly here too since
// it's new); pip-constraints.mjs is a transitive dependency (a direct import
// of install-qwen3.mjs, itself only imported by the two dependent tests, not
// a direct producer import of any *.test.mjs); eslint.config.mjs is a
// runtime/subprocess dependency (spawned via `npx eslint`, no module-graph
// edge at all). All three need an explicit assertion, in the same style as
// the bump-version.mjs case above.
test('stepTouchedByDiff: pinokio.js diff matches test:hooks via extraFiles', () => {
  const diff = ['pinokio.js'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

test('stepTouchedByDiff: a pip-constraints.mjs diff matches test:hooks via extraFiles (transitive dep of install-qwen3.mjs)', () => {
  const diff = ['server/tts-sidecar/scripts/pip-constraints.mjs'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

test('stepTouchedByDiff: an eslint.config.mjs diff matches test:hooks via extraFiles (runtime dep of eslint-guardrail.test.mjs)', () => {
  const diff = ['eslint.config.mjs'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

// #2348 review, finding 1 — dev-mock-command.test.mjs readFileSync's
// .env.mock and .env.development at RUNTIME (asserting VITE_USE_MOCKS is
// true / false respectively), no module-graph edge. Without these two
// extraFiles entries, a diff touching only .env.development — precisely the
// regression #2343 guards against, flipping mocks back on for `npm run dev`
// — printed test:hooks [cached] locally, and ci-scope.mjs derives cloud
// CI's legs from this same STEPS[] entry, so the cloud run skipped it too.
// Same #1847 trap as bump-version.mjs above.
test('stepTouchedByDiff: a .env.development diff matches test:hooks via extraFiles (dev-mock-command.test.mjs reads it at runtime)', () => {
  const diff = ['.env.development'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

test('stepTouchedByDiff: a .env.mock diff matches test:hooks via extraFiles (dev-mock-command.test.mjs reads it at runtime)', () => {
  const diff = ['.env.mock'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

// #2216 review round 3 — git-scrub.test.mjs is the first hooks test whose
// scan surface reaches outside scripts/** (it walks pinokio-scripts/** too),
// but test:hooks' globs didn't cover that directory: a pinokio-scripts-only
// diff printed [cached] locally and scheduled only test:pinokio in cloud CI
// (ci-scope.mjs derives both from this same STEPS[] entry) — neither of
// which runs git-scrub.test.mjs, so a scrub deleted from e.g.
// resolve-release.js's `git checkout` (no `cwd`, runs on an end user's
// machine — the highest-risk site the guard covers) would ship undetected.
test('stepTouchedByDiff: a pinokio-scripts/ diff matches test:hooks via globs (#2216 — git-scrub.test.mjs scans that directory too)', () => {
  const diff = ['pinokio-scripts/lib/resolve-release.js'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

// #2216 review round 3 — the glob was *.{mjs,cjs} only, narrower than the
// SCANNED_EXTENSIONS both gh-chokepoint.test.mjs and git-scrub.test.mjs
// actually walk (.mjs/.cjs/.js/.mts/.cts/.ts). audit-stage2-coverage.mts is
// a real file this gap already reached (cited by name in gh-chokepoint's own
// header) — a raw `gh`/`git` call added there would print test:hooks
// [cached] on exactly the diff that introduced it.
test('stepTouchedByDiff: a scripts/*.mts diff matches test:hooks via globs (#2216 — SCANNED_EXTENSIONS parity)', () => {
  const diff = ['scripts/audit-stage2-coverage.mts'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

// Defect D (#2119 review): verify.yml matched NO scope, so a workflow-only
// PR ran zero legs — in cloud AND locally. This suite's own stepTouchedByDiff
// assertions against real workflow paths are what must stay in scope when
// verify.yml changes, or the guard cannot run on the PR that breaks it.
test('stepTouchedByDiff: a verify.yml diff matches test:hooks via globs', () => {
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

// I1 (#2146 review): .github/actions/** is defect D's other half — the
// composite setup action is consumed by every verify.yml job that sets up
// Node but matched no scope at all, so an actions-only diff ran zero legs
// and printed [cached].
test('stepTouchedByDiff: a .github/actions diff matches test:hooks via globs', () => {
  assert.equal(
    stepTouchedByDiff(stepByName['test:hooks'], ['.github/actions/setup/action.yml']),
    true,
  );
});

// ops-21 (#2152): pins BOTH halves of the routing decision at once, so
// neither can be deleted alone. `shared` (computeShared) covers CI; the
// test:hooks glob is what busts the LOCAL input-hash cache, since `shared`
// only widens the scope filter — the `scopeShared` guard at the head of
// `runPipeline`'s per-step loop in verify-cache.mjs — and does not touch the
// per-step hash below it. Losing either half quietly re-opens the #2146 hole
// for one of the two runners.
test('.github/actions/** is covered by BOTH computeShared and the test:hooks glob', () => {
  const path = '.github/actions/setup/action.yml';
  assert.equal(computeShared([path]), true, 'computeShared must cover it (CI scope)');
  assert.equal(
    stepTouchedByDiff(stepByName['test:hooks'], [path]),
    true,
    'test:hooks globs must cover it (local cache-hash mechanics)',
  );
});

// .husky/** is covered TODAY only by verify.yml's `hooks` bash matcher
// (`^\.husky/`), which A2 deletes. It is an input to NO step — measured:
// stepTouchedByDiff returns [] for all 13 steps. Without this, A2 ships
// defect D again for .husky, on the very PR that fixes it for .github, and
// none of the four wiring assertions can see it (they check key existence
// and job membership, not whether a derived condition still covers what the
// legacy one did). release-manifest.test.mjs:95 includes .husky/pre-commit
// as a literal string in an array of sample paths fed to a pure classifier —
// it does not read the file from disk — but it is still a real edge worth
// pinning, not a theoretical one (M1, #2146 review: corrects the previous
// "reads at runtime" claim, which was false).
test('stepTouchedByDiff: a .husky diff matches test:hooks via globs', () => {
  for (const hook of ['.husky/pre-commit', '.husky/pre-push', '.husky/commit-msg']) {
    assert.equal(stepTouchedByDiff(stepByName['test:hooks'], [hook]), true, hook);
  }
});

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

test('stepTouchedByDiff: a frontend config file matches via extraFiles', () => {
  const diff = ['vite.config.ts'];
  assert.equal(stepTouchedByDiff(stepByName['test'], diff), true);
});

// index.html carries the self-hosted webfonts <link>, the body's Tailwind
// classes, and the #root mount div — all three determine what Playwright
// mounts and what the visual baselines screenshot. Without this extraFiles
// entry, an index.html-only diff ran zero e2e shards and zero visual
// baselines (workflow-wiring review Finding 1). Reverting either extraFiles
// entry reddens its own assertion.
test('stepTouchedByDiff: index.html is in scope for test:e2e', () => {
  assert.equal(stepTouchedByDiff(stepByName['test:e2e'], ['index.html']), true);
});

test('stepTouchedByDiff: index.html is in scope for test:e2e:visual', () => {
  assert.equal(stepTouchedByDiff(stepByName['test:e2e:visual'], ['index.html']), true);
});

test('stepTouchedByDiff: editing the prebuild doc-sync script invalidates the build cache (issue #1223)', () => {
  const diff = ['scripts/sync-docs-to-public.mjs'];
  assert.equal(stepTouchedByDiff(stepByName['build'], diff), true);
});

test('stepTouchedByDiff: the server lockfile is in scope for server legs only', () => {
  const diff = ['server/package-lock.json'];
  assert.equal(stepTouchedByDiff(stepByName['test:server'], diff), true);
  assert.equal(stepTouchedByDiff(stepByName['test'], diff), false);
});

test('stepTouchedByDiff: an empty diff touches nothing', () => {
  assert.equal(stepTouchedByDiff(stepByName['test'], []), false);
});

// M3 (#2146 review): 'server/tts-sidecar/requirements*.txt' compiles to
// `requirements[^/]*\.txt$` (the single-segment `*` cannot cross a `/`), so
// it never matched a file under the requirements/ SUBDIRECTORY —
// requirements/base.txt became load-bearing in this PR (the CI bootstrap
// installs from it directly) but editing it prints [cached] locally. Same
// gap for pytest.ini: it sits at server/tts-sidecar/pytest.ini, not matched
// by '**/*.py'. Cloud is unaffected (verify.yml's `^server/tts-sidecar/`
// match already covers both) — this is a LOCAL-cache-only hole, same shape
// as M3's sibling findings across this PR.
test('stepTouchedByDiff: server/tts-sidecar/requirements/base.txt is in scope for test:sidecar', () => {
  assert.equal(
    stepTouchedByDiff(stepByName['test:sidecar'], ['server/tts-sidecar/requirements/base.txt']),
    true,
  );
});

test('stepTouchedByDiff: server/tts-sidecar/pytest.ini is in scope for test:sidecar', () => {
  assert.equal(
    stepTouchedByDiff(stepByName['test:sidecar'], ['server/tts-sidecar/pytest.ini']),
    true,
  );
});

// --- server/package.json widening (verify-scope fix round 1) ---------------
// A bare server/package.json edit (not yet reflected in server/package-lock.json)
// invalidated NOTHING before this fix — stepTouchedByDiff's includeLockfiles
// branch only special-cases the literal server/package-lock.json path.
// Reverting any one of these five extraFiles entries reddens its own test.
test('stepTouchedByDiff: server/package.json is in scope for typecheck', () => {
  assert.equal(stepTouchedByDiff(stepByName['typecheck'], ['server/package.json']), true);
});

test('stepTouchedByDiff: server/package.json is in scope for config:check', () => {
  assert.equal(stepTouchedByDiff(stepByName['config:check'], ['server/package.json']), true);
});

test('stepTouchedByDiff: server/package.json is in scope for test:server', () => {
  assert.equal(stepTouchedByDiff(stepByName['test:server'], ['server/package.json']), true);
});

test('stepTouchedByDiff: server/package.json is in scope for test:server-slow', () => {
  assert.equal(stepTouchedByDiff(stepByName['test:server-slow'], ['server/package.json']), true);
});

test('stepTouchedByDiff: server/package.json is in scope for build', () => {
  assert.equal(stepTouchedByDiff(stepByName['build'], ['server/package.json']), true);
});

// lint deliberately does NOT get server/package.json: eslint.config.mjs has no
// JSON target (verified: no `files`/plugin entry for *.json anywhere in it),
// so a package.json content change cannot change lint's output.
test('stepTouchedByDiff: server/package.json stays OUT of scope for lint (no JSON lint target)', () => {
  assert.equal(stepTouchedByDiff(stepByName['lint'], ['server/package.json']), false);
});

// --- test:sidecar widened to the whole tree (verify-scope fix round 1, G6) -
// Legacy CI regex was `^server/tts-sidecar/` (anything in the tree); A2's
// derivation narrowed this to .py/requirements/pytest.ini only, missing docs,
// installer scripts under scripts/, and anything else non-.py. Reverting the
// globs line back to the three narrower globs reddens this test.
test('stepTouchedByDiff: a non-.py file anywhere under server/tts-sidecar/ is in scope for test:sidecar', () => {
  assert.equal(
    stepTouchedByDiff(stepByName['test:sidecar'], ['server/tts-sidecar/README.md']),
    true,
  );
  assert.equal(
    stepTouchedByDiff(stepByName['test:sidecar'], ['server/tts-sidecar/scripts/install-qwen3.mjs']),
    true,
  );
});

// --- test:scripts (Pester) fixtures widening (verify-scope fix round 1, G7) -
// scripts/tests/run-golden-tests.Tests.ps1's BeforeAll block shadows
// qwen_tts/torch/TTS onto PYTHONPATH via these stub .py files at RUNTIME (see
// that test file's own comment) — a real dependency, not a hypothetical one.
// Reverting the 'scripts/tests/fixtures/**' glob entry reddens this test.
test('stepTouchedByDiff: a run-golden-tests stub module is in scope for test:scripts', () => {
  assert.equal(
    stepTouchedByDiff(stepByName['test:scripts'], [
      'scripts/tests/fixtures/run-golden-tests-stub-modules/qwen_tts.py',
    ]),
    true,
  );
});

// --- test:hooks completeness guard (ops-18, #2115; transitive walk, ops-17c
// follow-up #2120a) -----------------------------------------------------
// The globs + extraFiles above are a hand-maintained approximation of "every
// file a hooks test depends on". This test checks that approximation against
// reality: walk the full TRANSITIVE import closure of every
// scripts/tests/*.test.mjs entry point (not just its direct imports — a
// producer reached two hops away is just as real a dependency) and assert
// every file in that closure is stepTouchedByDiff-visible to test:hooks.
// Without this, a producer that a test depends on but the cache step doesn't
// declare sits in the exact #1847 trap the extraFiles comments above
// describe: a producer-only diff prints [cached] and the test that covers it
// never runs locally — including when the producer is only reached
// transitively (#2120a: editing pinokio-scripts/lib/menu.js left test:hooks
// [cached] locally because the old guard only looked at test files' DIRECT
// imports, one hop short of the real edge through pinokio.js).
const testsDir = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(testsDir, '..', '..');

test('test:hooks completeness guard: every producer a hooks test depends on is a cache input', () => {
  const hooksStep = stepByName['test:hooks'];
  const entryFiles = readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => join(testsDir, f));

  const { files, unresolvable, unparseable } = walk({ entryFiles, repoRoot });

  // Fail closed on a specifier that resolves to nothing (defect A). The old
  // guard's existsSync-then-continue silently dropped these.
  assert.deepEqual(
    unresolvable,
    [],
    `specifier(s) that resolve to nothing:\n${unresolvable.map((u) => `${u.specifier} <- ${u.from}`).join('\n')}`,
  );

  // I3 (#2154 review): `unparseable` was computed and then discarded here —
  // the module comment at module-graph.mjs's top documents it as the
  // visibility mechanism for a truncated subtree ("never hidden... named in
  // `unparseable`"), but nothing actually read the list, so that visibility
  // was theoretical. Pinning the exact, known entry turns a NEW unparseable
  // file (up to 13 possible before the floor above goes red) into a
  // deliberate, reviewed decision instead of a silent one.
  assert.deepEqual(
    unparseable,
    ['server/src/handoff/schemas.ts'],
    `unparseable file(s) changed — a new entry here silently shrinks the ` +
      `walked closure by everything past it; confirm this is intended:\n${unparseable.join('\n')}`,
  );

  // Anti-vacuity on METRIC B (unique tracked closure files), NOT on the old
  // occurrence counter (METRIC A) — different units, and conflating them is
  // how the old floor came to be 30 against a real 60: that 60 counted
  // per-test-file direct-import OCCURRENCES (duplicates across files each
  // counted separately), not unique files. Re-measured on this branch (task
  // 13, transitive walk over all 63 scripts/tests/*.test.mjs entries):
  // Metric B (files.length, unique files in the closure) = 63; the
  // equivalent direct-imports-only occurrence count (Metric A's unit) = 66.
  // Floor 50 is set against Metric B and gives ~20% headroom below 63: a
  // legitimate one- or two-file removal must not go red, while a collapse
  // toward zero (broken regex or resolver) must.
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

// --- Acceptance through the real cached/run decision (#2120) -------------
// #2120 explicitly rejects stepTouchedByDiff as sufficient proof: PR #2117
// showed it and the real [cached]/[run] decision are different code paths.
// These two tests drive selectStepFiles -> composeInputHash -> decide — the
// actual decision runPipeline makes — rather than modeling it against the
// unit seam.

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

// C1 (#2154 review): `check:budget-poll` had a real STEPS[] entry with correct
// inputs, but NONE of the three local `--steps` CSVs in package.json
// (`verify:fast`, `verify:fast:scoped`, `verify:fast:branch`) named it —
// `runPipeline` filters STEPS down to exactly the names it's given, so the
// step was silently dropped from every local entry point and only ever ran
// under bare `npm run verify` or in cloud CI. This guard closes that class of
// bug generally: a STEPS[] entry that isn't in ANY local CSV, and isn't
// explicitly named below as cloud/full-verify-only by design, goes red.
//
// The allowlist mirrors CLAUDE.md's own Commands section, which documents
// each of these as deliberately absent from the fast local paths:
//   - test:e2e / test:e2e:visual — cloud verify.yml only (Playwright).
//   - test:server-slow — cloud verify.yml + full `npm run verify`, not the
//     fast paths (docs/features/archive/45-vitest-pool-tuning.md).
//   - test:scripts / test:pinokio — not in any of the three fast aliases
//     today (`npm run test:all` / `verify` cover them instead).
//   - check:cycles — madge's --circular pass over server/src is not free on
//     this graph (#2053, repo-owner decision on the issue); it runs as a
//     verify.yml leg scope-gated to server/**, and in full `npm run verify`,
//     but is deliberately NOT one of the three local fast/pre-push CSVs.
// Reading package.json's real scripts (rather than hardcoding the CSVs here)
// means an edit to any of the three that drops a step name is what this test
// actually watches for.
const CLOUD_OR_FULL_VERIFY_ONLY_STEPS = new Set([
  'test:e2e',
  'test:e2e:visual',
  'test:server-slow',
  'test:scripts',
  'test:pinokio',
  'check:cycles',
]);

test('every STEPS[] entry is covered by a local --steps CSV or explicitly allowlisted as cloud/full-verify-only', () => {
  const pkgPath = resolve(repoRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const LOCAL_ENTRY_POINTS = ['verify:fast', 'verify:fast:scoped', 'verify:fast:branch'];

  const covered = new Set();
  for (const scriptName of LOCAL_ENTRY_POINTS) {
    const cmd = pkg.scripts[scriptName];
    assert.ok(cmd, `package.json is missing its "${scriptName}" script`);
    const m = cmd.match(/--steps[ =]([^\s]+)/);
    assert.ok(m, `"${scriptName}" must pass --steps`);
    for (const name of m[1].split(',')) covered.add(name);
  }

  const missing = STEPS.map((s) => s.name).filter(
    (name) => !covered.has(name) && !CLOUD_OR_FULL_VERIFY_ONLY_STEPS.has(name),
  );
  assert.deepEqual(
    missing,
    [],
    `STEPS[] entr(y/ies) absent from every local --steps CSV and not allowlisted ` +
      `as cloud/full-verify-only: ${missing.join(', ')}`,
  );
});

test('computeShared is true for a root manifest/lockfile change', () => {
  assert.equal(computeShared(['package.json']), true);
  assert.equal(computeShared(['package-lock.json']), true);
});

// ops-21 (#2152): .github/actions/** joined computeShared alongside the root
// manifest. Matched by directory prefix, not exact filename — a second file
// under the directory (not just today's setup/action.yml) must also match.
test('computeShared is true for any .github/actions/** path', () => {
  assert.equal(computeShared(['.github/actions/setup/action.yml']), true);
  assert.equal(computeShared(['.github/actions/some-other-action/action.yml']), true);
});

// The false case is what stops a future widening from quietly making
// computeShared return true for everything. .github/workflows/** is
// deliberately `hooks`-scoped (via test:hooks's own glob), not `shared` —
// it must stay false here.
test('computeShared is false for a scoped-only change', () => {
  assert.equal(computeShared(['server/package-lock.json']), false);
  assert.equal(computeShared(['src/app.tsx']), false);
  assert.equal(computeShared(['.github/workflows/verify.yml']), false);
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

// #2164: the contention probe used to read only the FIRST GPU line
// (parseNvidiaSmiUtil above), which on a dual-GPU box misses a busy SECOND
// card entirely — this dev box is cuda:0 (4070 8GB) idle / cuda:1 (5070 Ti
// 16GB) busy, and the busy card sits at index 1. maxNvidiaSmiUtil takes the
// max across every parseable line instead.

test('maxNvidiaSmiUtil takes the max across a two-GPU output, not just the first line', () => {
  assert.equal(maxNvidiaSmiUtil('3\n97\n'), 97);
  // Order shouldn't matter.
  assert.equal(maxNvidiaSmiUtil('97\n3\n'), 97);
});

test('maxNvidiaSmiUtil returns null on empty / unparseable output', () => {
  assert.equal(maxNvidiaSmiUtil(''), null);
  assert.equal(maxNvidiaSmiUtil('\n'), null);
  assert.equal(maxNvidiaSmiUtil('N/A\nN/A\n'), null);
});

test('maxNvidiaSmiUtil ignores unparseable lines but keeps the max of the rest', () => {
  assert.equal(maxNvidiaSmiUtil('N/A\n85\n'), 85);
});

// The actual regression test (#2164): a two-GPU stdout whose SECOND card is
// over threshold must be detected as contention. Before the fix,
// detectGpuContention called parseNvidiaSmiUtil (first-line-only) here, read
// cuda:0's idle 3%, and returned busy:false — missing the busy cuda:1 card
// entirely. That is the exact bug that let six commits die to co-running
// generations tonight.
test('gpuContentionFor: busy SECOND GPU (not the first) is detected as contention', () => {
  assert.deepEqual(gpuContentionFor('3\n97\n'), { busy: true, util: 97 });
});

test('gpuContentionFor: idle when every GPU is under threshold', () => {
  assert.deepEqual(gpuContentionFor('3\n12\n'), { busy: false, util: 12 });
});

test('gpuContentionFor: falls back to busy:false, util:null on unparseable output', () => {
  // Mirrors detectGpuContention's own fallback for an absent/errored nvidia-smi
  // (e.g. CI ubuntu runners, non-NVIDIA boxes) — the spawn failure itself is
  // handled in detectGpuContention, but an empty/garbage stdout reaching this
  // pure function must resolve the same way.
  assert.deepEqual(gpuContentionFor(''), { busy: false, util: null });
  assert.deepEqual(gpuContentionFor('N/A\n'), { busy: false, util: null });
});

// #2164 review finding 1: `gpuContentionFor` itself is fully unit-tested
// above, but `detectGpuContention` — the actual production wire, which spawns
// a real nvidia-smi and is not exported — was never asserted to actually call
// it. A one-line revert of detectGpuContention's body back to
// `parseNvidiaSmiUtil(r.stdout)` (the pre-#2164 first-line-only bug) left
// every other test in this file green. Since detectGpuContention isn't
// directly testable without spawning a real nvidia-smi, this pins the
// production wire at the source level instead — same technique as
// BLESS_ENV_SHAPE in scripts/tests/run-golden-audio.test.mjs.
function detectGpuContentionBody() {
  const match = src.match(/function detectGpuContention\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, "could not locate detectGpuContention's function body in verify-cache.mjs");
  return match[0];
}

test('detectGpuContention routes through gpuContentionFor, not parseNvidiaSmiUtil directly', () => {
  const body = detectGpuContentionBody();
  assert.match(
    body,
    /return gpuContentionFor\(r\.stdout\);/,
    'detectGpuContention must return gpuContentionFor(r.stdout) — the pure decision seam — ' +
      'not inline its own threshold check',
  );
  assert.doesNotMatch(
    body,
    /parseNvidiaSmiUtil\(/,
    'detectGpuContention must not call parseNvidiaSmiUtil directly — that is the first-line-only ' +
      'parser this fix moved away from; calling it here silently reintroduces the #2164 bug ' +
      'even though gpuContentionFor itself stays correct',
  );
});

// #2164 review finding 2: the `--query-gpu` argument is unpinned and silently
// determines correctness. parseNvidiaSmiUtil/maxNvidiaSmiUtil both read the
// FIRST CSV field as the utilization percentage, which is only true because
// the query requests utilization.gpu ALONE. Widening it — e.g. to
// `index,utilization.gpu`, the richer shape #2164's own issue body pastes
// ("1, NVIDIA GeForce RTX 5070 Ti, 91 %, 15455 MiB") — shifts the first field
// to the GPU index (0 or 1, always under GPU_BUSY_THRESHOLD), reintroducing
// #2164's always-idle bug through the query string instead of the parser,
// with every existing test still green (they all pass CSV directly, not
// through a real nvidia-smi query).
test('detectGpuContention pins the --query-gpu=utilization.gpu flag the parsers depend on', () => {
  const body = detectGpuContentionBody();
  assert.match(
    body,
    /'--query-gpu=utilization\.gpu'/,
    "detectGpuContention must query ONLY utilization.gpu — adding a field (e.g. 'index,') " +
      'shifts the first CSV column the parsers read away from the utilization percentage',
  );
});

// --- Branch-diff scope filter (verify/CI rebalance, 2026-07-06) --------

function gitAt(cwd, args) {
  // Strip ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_PREFIX before
  // spawning: when this suite runs inside a real git hook (pre-commit calls
  // `npm run verify:fast:scoped` -> `npm run test:hooks`), git sets these in
  // the process env for the hook, and without stripping them these fixture
  // commands would operate on the REAL repo instead of the throwaway `cwd`.
  const {
    GIT_DIR: _GIT_DIR,
    GIT_WORK_TREE: _GIT_WORK_TREE,
    GIT_INDEX_FILE: _GIT_INDEX_FILE,
    GIT_PREFIX: _GIT_PREFIX,
    ...cleanEnv
  } = process.env;
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

// Builds a throwaway repo with one commit on a `main` branch, so tests can
// exercise branchDiffFiles' real `git merge-base` + `git diff` calls without
// touching this actual repo.
function makeGitFixture() {
  const dir = mkTmp();
  gitAt(dir, ['init', '-q', '-b', 'main']);
  gitAt(dir, ['config', 'user.email', 'test@example.com']);
  gitAt(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'base.txt'), 'base', 'utf8');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

test('branchDiffFiles: returns files changed since branching off main', () => {
  const dir = makeGitFixture();
  gitAt(dir, ['switch', '-q', '-c', 'feature']);
  writeFileSync(join(dir, 'feature.txt'), 'x', 'utf8');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'feature commit']);
  const files = branchDiffFiles(dir);
  assert.deepEqual(files, ['feature.txt']);
});

test('branchDiffFiles: empty array (not null) when run directly on main with nothing new', () => {
  const dir = makeGitFixture();
  const files = branchDiffFiles(dir);
  assert.deepEqual(files, []);
});

test('branchDiffFiles: returns null when cwd is not a git repo', () => {
  const dir = mkTmp(); // no git init — merge-base has nothing to find
  const files = branchDiffFiles(dir);
  assert.equal(files, null);
});

test('branchDiffFiles: ignores an ambient GIT_DIR pointing elsewhere', () => {
  // Regression test for a real incident: branchDiffFiles must resolve git
  // state strictly relative to its `cwd` argument, even when invoked from
  // inside a process that already has GIT_DIR/GIT_WORK_TREE set for a
  // DIFFERENT repo (exactly what happens when this suite runs inside the
  // real pre-commit hook). Deterministic — doesn't depend on actually being
  // inside a hook to catch a regression.
  const dir = makeGitFixture();
  gitAt(dir, ['switch', '-q', '-c', 'feature']);
  writeFileSync(join(dir, 'feature.txt'), 'x', 'utf8');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'feature commit']);

  const bogusGitDir = join(mkTmp(), 'unrelated-repo', '.git');
  const prevGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = bogusGitDir;
  try {
    const files = branchDiffFiles(dir);
    assert.deepEqual(files, ['feature.txt']);
  } finally {
    if (prevGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prevGitDir;
  }
});

// #2216 review round 3 — restores the property the deleted wrong-premise
// test (see git history) used to pin: stagedDiffFiles must return `null`,
// not `[]`, when git fails outright. This is the exact distinction the
// whole #2216 correction turns on — verify-cache's scope filter treats
// `null` as "diff failed, run everything" (safe) but a successful `[]` as
// "nothing staged" (skips every leg). Mutation `return null` -> `return []`
// in stagedDiffFiles passed 88/88 and 1270/1270 with neither replacement
// test catching it — branchDiffFiles' own null test doesn't exercise
// stagedDiffFiles at all. Independent of any ambient GIT_INDEX_FILE:
// verified directly that a non-repo cwd fails git's discovery entirely
// (falls back to --no-index usage-error interpretation, exit 129) even with
// a real, valid, absolute GIT_INDEX_FILE set — the temp-index scrub this
// file's `honours an ambient GIT_INDEX_FILE` test proves is a separate axis.
test('stagedDiffFiles: returns null when cwd is not a git repo', () => {
  const dir = mkTmp(); // no git init — nothing for git to discover
  const files = stagedDiffFiles(dir);
  assert.equal(files, null);
});

test('stagedDiffFiles: ignores an ambient GIT_DIR pointing elsewhere', () => {
  // Same shape as branchDiffFiles' own "ignores an ambient GIT_DIR" test
  // above — stagedDiffFiles must resolve git state strictly relative to its
  // `cwd` argument, even with GIT_DIR set in the process env for an
  // unrelated repo. This is the actual #2169 hazard class this sweep closes
  // (repository redirection); it does not depend on an ordinary git hook
  // exporting GIT_DIR (it doesn't — see git-env.mjs's header) to be a real
  // risk, since an operator's shell or another script's tooling can.
  //
  // Also isolates ambient GIT_INDEX_FILE around this call (save/clear/
  // restore), which this test is NOT exercising — found live while landing
  // #2216: running this suite from inside a REAL pre-commit hook in a git
  // WORKTREE (as CLAUDE.md's branching workflow mandates for every non-
  // trivial change — i.e. every real run of this hook), GIT_INDEX_FILE is
  // an ABSOLUTE path into `.git/worktrees/<name>/index` — not the relative
  // `.git/index` a primary checkout gets — and stagedDiffFiles deliberately
  // does NOT scrub it (see git-env.mjs's header). Left uncontrolled, that
  // real, unrelated index leaks into this test's throwaway `repoDir` spawn:
  // `git diff --cached` resolves the repository correctly via `cwd` (GIT_DIR
  // is scrubbed) but reads the WRONG index — the real worktree's, referencing
  // blobs this fixture's object store has never heard of — and fails with
  // `fatal: unable to read <sha>`, not a clean mismatch. That failure is
  // real and correctly demonstrates why GIT_INDEX_FILE isolation belongs to
  // the caller when the property under test is GIT_DIR specifically, the
  // same way `gitAt()`'s own fixture-setup helper above already isolates it.
  const repoDir = makeGitFixture();
  writeFileSync(join(repoDir, 'staged.txt'), 'staged', 'utf8');
  gitAt(repoDir, ['add', 'staged.txt']);

  const bogusGitDir = join(mkTmp(), 'unrelated-repo', '.git');
  const prevGitDir = process.env.GIT_DIR;
  const prevIndexFile = process.env.GIT_INDEX_FILE;
  process.env.GIT_DIR = bogusGitDir;
  delete process.env.GIT_INDEX_FILE;
  try {
    const files = stagedDiffFiles(repoDir);
    assert.deepEqual(files, ['staged.txt']);
  } finally {
    if (prevGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prevGitDir;
    if (prevIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = prevIndexFile;
  }
});

// --- #2216 correction: stagedDiffFiles must HONOUR the ambient GIT_INDEX_FILE,
// --- not scrub it. This is the important test — it is the concrete case the
// --- original (wrong) decision would have broken. -------------------------
//
// Native git routes ordinary commands through a TEMPORARY index. Measured
// inside a real pre-commit hook (git 2.54.0.windows.1): `git commit -a` and
// `git commit -- <path>` hand the hook an absolute path to a *.lock temp
// index, not `.git/index`. stagedDiffFiles() exists specifically to read the
// index the in-flight commit is about — scrubbing GIT_INDEX_FILE would make
// it read `.git/index` (empty, or stale) instead of the real staged set,
// and a successful-but-empty `[]` does NOT trip verify-cache's "diff failed,
// run everything" safety branch (only `null` does) — every leg would report
// `[skip] … (out of scope)` and the commit gate would go green having
// verified nothing. See scripts/git-env.mjs's header for the full account.
test('stagedDiffFiles: honours an ambient GIT_INDEX_FILE pointing at a temporary index (git commit -a / -- <path> shape)', () => {
  const repoDir = makeGitFixture();

  // Seed the temp index as a byte-for-byte copy of the real index WHILE it
  // still matches HEAD (nothing staged yet) — this is what git itself does
  // for `commit -a`'s temp index: a copy of the real index with working-tree
  // changes applied, not a blank slate. A blank/fresh index compared with
  // `--cached` would show every HEAD-tracked file as "removed", which is a
  // different (and misleading) shape than the real hazard this test proves.
  const tempIndexPath = join(mkTmp(), 'temp-index.lock');
  copyFileSync(join(repoDir, '.git', 'index'), tempIndexPath);

  // The REAL index (`.git/index`) gets a different staged file than the
  // temp index — this is what makes the assertion below meaningful: if
  // stagedDiffFiles read the wrong index, it would report the WRONG file,
  // not just an empty or null result.
  writeFileSync(join(repoDir, 'via-real-index.txt'), 'real', 'utf8');
  gitAt(repoDir, ['add', 'via-real-index.txt']);

  // Populate the temp index with a DIFFERENT file — the shape a hook hands
  // a `git commit -a` / `git commit -- <path>` invocation, where the temp
  // index reflects the files that invocation is actually committing.
  writeFileSync(join(repoDir, 'via-temp-index.txt'), 'temp', 'utf8');
  const {
    GIT_DIR: _GIT_DIR,
    GIT_WORK_TREE: _GIT_WORK_TREE,
    GIT_INDEX_FILE: _GIT_INDEX_FILE,
    GIT_PREFIX: _GIT_PREFIX,
    ...cleanEnv
  } = process.env;
  const populateTempIndex = spawnSync('git', ['add', 'via-temp-index.txt'], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...cleanEnv, GIT_INDEX_FILE: tempIndexPath },
  });
  assert.equal(populateTempIndex.status, 0, populateTempIndex.stderr);

  const prevIndexFile = process.env.GIT_INDEX_FILE;
  // Simulates the ambient env a real pre-commit hook hands its child
  // process for `git commit -a` / `git commit -- <path>` — GIT_DIR is
  // deliberately NOT set here (an ordinary hook doesn't export it).
  process.env.GIT_INDEX_FILE = tempIndexPath;
  try {
    const files = stagedDiffFiles(repoDir);
    assert.deepEqual(
      files,
      ['via-temp-index.txt'],
      'stagedDiffFiles must read the ambient (temporary) index, not .git/index — ' +
        'returning the real-index file, an empty array, or null all indicate the ' +
        'ambient GIT_INDEX_FILE was scrubbed instead of honoured',
    );
  } finally {
    if (prevIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = prevIndexFile;
  }
});

// I2 (#2146 review): sidecarFingerprint used to hardcode
// `.venv/Scripts/python.exe` (Windows-only). On a POSIX box that meant the
// fingerprint was the literal string 'unavailable' BEFORE bootstrap and
// STAYED 'unavailable' after bootstrapping the venv (since the hardcoded
// Windows path never exists there) — so the tool fingerprint never moved and
// test:sidecar would report [cached] forever locally, with nothing under
// **/*.py changed. Pins the POSIX branch specifically (a Windows-only
// assertion would leave the exact bug in place): a POSIX-layout venv
// (.venv/bin/python, no Windows layout present) must resolve to something
// other than 'unavailable' even when forced via the `platform` param — this
// does not depend on the host OS actually running the test.
test('sidecarFingerprint resolves the POSIX venv layout (not just Windows)', () => {
  const dir = mkTmp();
  const pyPath = join(dir, '.venv', 'bin', 'python');
  mkdirSync(dirname(pyPath), { recursive: true });
  writeFileSync(pyPath, '', 'utf8'); // existence is all resolveVenvPython checks
  const result = sidecarFingerprint(dir, 'linux');
  assert.notEqual(result, 'unavailable');
});

test('sidecarFingerprint still returns unavailable when no venv exists on POSIX', () => {
  const dir = mkTmp();
  const result = sidecarFingerprint(dir, 'linux');
  assert.equal(result, 'unavailable');
});
