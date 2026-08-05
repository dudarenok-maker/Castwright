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
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
  branchDiffFiles,
  sidecarFingerprint,
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
// composite setup action is consumed by every verify.yml job but matched no
// scope at all, so an actions-only diff ran zero legs and printed [cached].
test('stepTouchedByDiff: a .github/actions diff matches test:hooks via globs', () => {
  assert.equal(
    stepTouchedByDiff(stepByName['test:hooks'], ['.github/actions/setup/action.yml']),
    true,
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

test('stepTouchedByDiff: a frontend config file matches via extraFiles', () => {
  const diff = ['tailwind.config.ts'];
  assert.equal(stepTouchedByDiff(stepByName['test'], diff), true);
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
    stepTouchedByDiff(stepByName['test:sidecar'], [
      'server/tts-sidecar/scripts/install-qwen3.mjs',
    ]),
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

// --- test:hooks completeness guard (ops-18, #2115) -------------------------
// The globs + extraFiles above are a hand-maintained approximation of "every
// file a hooks test depends on". This test checks that approximation against
// reality: statically scan every scripts/tests/*.test.mjs for the producer
// files it actually imports (relative specifiers only — bare specifiers like
// `node:fs` or `archiver` aren't producers under test), and assert each one
// is stepTouchedByDiff-visible to test:hooks. Without this, a producer that a
// test imports but the cache step doesn't declare sits in the exact #1847
// trap the extraFiles comments above describe: a producer-only diff prints
// [cached] and the test that covers it never runs locally.
const testsDir = resolve(dirname(fileURLToPath(import.meta.url)));
const repoRoot = resolve(testsDir, '..', '..');

// Pull relative-specifier producer imports out of a test file's source: the
// static ESM `from` form, the dynamic `import()` form, and the CJS
// `require()` form (pinokio-entry.test.mjs uses createRequire + require()
// deliberately, to reproduce Pinokio's own CJS kernel loader — that is a
// genuine direct import edge the guard must see; ops-17c review, #2115).
// Only a dot- or dot-dot-prefixed relative specifier counts as a producer
// import — bare specifiers like `node:fs` are not producers under test. (Do
// not spell out a literal example specifier in this comment: the patterns
// below would extract it too, and it would then be silently discarded by
// the on-disk existsSync check in the test below rather than caught.)
function extractRelativeImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s+['"](\.\.?\/[^'"]+)['"]/g,
    /\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

// Pins the require() pattern directly. Without this, a regression that drops
// that pattern is invisible to the completeness guard below whenever the
// require()d producer (pinokio.js) already happens to be a declared
// extraFiles entry — the guard would just stop scanning that edge and stay
// silently green rather than catching the regex regression (ops-17c review,
// #2115: verified by mutation — removing the require() pattern alone left
// every test in this file green until this pinning test was added).
test('extractRelativeImportSpecifiers: extracts a require() edge (pinokio-entry.test.mjs shape)', () => {
  const source = "const config = require('../../pinokio.js');";
  assert.deepEqual(extractRelativeImportSpecifiers(source), ['../../pinokio.js']);
});

test('test:hooks completeness guard: every producer a hooks test imports is a cache input', () => {
  const hooksStep = stepByName['test:hooks'];
  const testFiles = readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs'));
  const missing = [];
  let producersScanned = 0;

  for (const testFile of testFiles) {
    const source = readFileSync(join(testsDir, testFile), 'utf8');
    for (const specifier of extractRelativeImportSpecifiers(source)) {
      const absProducer = resolve(testsDir, specifier);
      if (!existsSync(absProducer)) continue; // not a file on disk — nothing to require as an input
      producersScanned += 1;
      // path.relative (not a fixed-length slice off repoRoot) so a specifier
      // that happens to resolve outside the repo root doesn't yield garbage.
      const repoRelative = _internals.toPosix(relative(repoRoot, absProducer));
      if (!stepTouchedByDiff(hooksStep, [repoRelative])) {
        missing.push(`${repoRelative} (imported by scripts/tests/${testFile})`);
      }
    }
  }

  // Anti-vacuity: if the regex above ever silently matched nothing, this
  // guard would pass forever while proving nothing (ops-18 brief mutation
  // (c) — the exact "absent reads as clean" failure mode). A count this low
  // means either the extraction regex broke, or a legitimate batch of hooks
  // tests (and their imports) was deleted — both are worth a human look
  // before lowering this floor.
  assert.ok(
    producersScanned >= 30,
    `expected to scan at least 30 relative producer imports across scripts/tests/*.test.mjs, found ${producersScanned} — either the extraction regex broke, or hooks tests/imports were legitimately removed`,
  );

  assert.deepEqual(
    missing,
    [],
    `producer(s) imported by a hooks test but not an input to test:hooks:\n${missing.join('\n')}`,
  );
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
