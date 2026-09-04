import test from 'node:test';
import assert from 'node:assert/strict';
import { slugFor, computeScopes, render, main } from '../ci-scope.mjs';
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

// ops-21 (#2152): .github/actions/** is a computeShared member, and `shared`
// is a disjunct on EVERY step (ci-scope.mjs's computeScopes loop) — so an
// actions-only diff must flip `shared` AND every single step_* key, not just
// test:hooks's own glob match. Derived from STEPS so a future STEPS[]
// addition can't silently exempt itself from this assertion.
test('computeScopes routes an actions-only diff to shared and every step', () => {
  const scopes = computeScopes(['.github/actions/setup/action.yml'], {
    eventName: 'pull_request',
  });
  assert.equal(scopes.shared, true);
  for (const step of STEPS) {
    assert.equal(scopes[slugFor(step.name)], true, `${slugFor(step.name)} must be true`);
  }
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

// #2853/#2867: verify.yml's server-tests job forces a full (non-`--changed`)
// run off this key rather than trusting `--changed`, since neither lockfile
// is in either vitest config's forceRerunTriggers.
test('computeScopes sets lockfile_touched for a server lockfile diff', () => {
  const scopes = computeScopes(['server/package-lock.json'], { eventName: 'pull_request' });
  assert.equal(scopes.lockfile_touched, true);
});

// The root lockfile already flips `shared` (computeShared) — lockfile_touched
// must also be true here, since it shares CI_ONLY's `shared || fn(files)`
// formula, so verify.yml can rely on one key for either lockfile.
test('computeScopes sets lockfile_touched for a root lockfile diff', () => {
  const scopes = computeScopes(['package-lock.json'], { eventName: 'pull_request' });
  assert.equal(scopes.lockfile_touched, true);
});

test('computeScopes leaves lockfile_touched false for a non-lockfile diff', () => {
  const scopes = computeScopes(['server/src/foo.ts'], { eventName: 'pull_request' });
  assert.equal(scopes.lockfile_touched, false);
});

test('render emits GITHUB_OUTPUT lines plus the ok sentinel', () => {
  const out = render({ step_test_hooks: true, shared: false });
  assert.match(out, /^scopes=\{.*\}$/m);
  assert.match(out, /^ok=true$/m);
  const json = JSON.parse(out.match(/^scopes=(.*)$/m)[1]);
  assert.equal(json.step_test_hooks, true);
  assert.equal(json.shared, false);
});

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
  process.stdout.write = (s) => {
    chunks.push(s);
    return true;
  };
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
