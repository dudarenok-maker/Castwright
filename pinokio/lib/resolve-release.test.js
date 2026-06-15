const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestReleaseTag, highestSemverTag } = require('./resolve-release.js');

test('200 with tag_name → resolves that tag', () => {
  const out = latestReleaseTag({ status: 200, body: { tag_name: 'v1.7.0' } });
  assert.deepEqual(out, { kind: 'tag', tag: 'v1.7.0' });
});

test('404 → "none" (no published release), never main', () => {
  const out = latestReleaseTag({ status: 404, body: null });
  assert.deepEqual(out, { kind: 'none' });
});

test('network/other error → fallback signal', () => {
  assert.deepEqual(latestReleaseTag({ status: 0, body: null }), { kind: 'fallback' });
  assert.deepEqual(latestReleaseTag({ status: 500, body: null }), { kind: 'fallback' });
});

test('200 but malformed body → fallback (defensive)', () => {
  assert.deepEqual(latestReleaseTag({ status: 200, body: {} }), { kind: 'fallback' });
});

test('highestSemverTag picks the max vX.Y.Z, ignores non-semver', () => {
  assert.equal(highestSemverTag(['v1.2.0', 'v1.10.1', 'nightly', 'v1.9.9']), 'v1.10.1');
});

test('highestSemverTag returns null when no semver tags', () => {
  assert.equal(highestSemverTag(['main', 'latest']), null);
});
