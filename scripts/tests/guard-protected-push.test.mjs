// Tests for the protected-branch pre-push guard.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePush, PROTECTED_REFS, ZERO } from '../guard-protected-push.mjs';

// A pre-push stdin line is: "<localRef> <localSha> <remoteRef> <remoteSha>".
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// isAncestor stubs — `true` means the push is a fast-forward (allowed),
// `false` means non-fast-forward / force (blocked on a protected branch).
const ffStub = () => true;
const forceStub = () => false;
// A stub that would throw if called — proves deletion/creation short-circuit
// before any ancestry check.
const neverCalled = () => {
  throw new Error('isAncestor should not be called');
};

test('blocks deletion of a protected branch (local sha all-zero)', () => {
  const line = `(delete) ${ZERO} refs/heads/main ${SHA_B}`;
  const result = evaluatePush(line, { isAncestor: neverCalled });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /delete/i);
  assert.match(result.reason, /main/);
});

test('blocks force-push (non-fast-forward) to a protected branch', () => {
  const line = `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}`;
  const result = evaluatePush(line, { isAncestor: forceStub });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /force|fast-forward/i);
  assert.match(result.reason, /main/);
});

test('allows a fast-forward push to a protected branch', () => {
  const line = `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}`;
  const result = evaluatePush(line, { isAncestor: ffStub });
  assert.equal(result.blocked, false);
});

test('allows force-push of a non-protected (feature) branch', () => {
  const line = `refs/heads/feat-x ${SHA_A} refs/heads/feat-x ${SHA_B}`;
  const result = evaluatePush(line, { isAncestor: forceStub });
  assert.equal(result.blocked, false);
});

test('allows deletion of a non-protected (feature) branch', () => {
  const line = `(delete) ${ZERO} refs/heads/feat-x ${SHA_B}`;
  const result = evaluatePush(line, { isAncestor: neverCalled });
  assert.equal(result.blocked, false);
});

test('allows creating a protected branch (remote sha all-zero)', () => {
  const line = `refs/heads/main ${SHA_A} refs/heads/main ${ZERO}`;
  const result = evaluatePush(line, { isAncestor: neverCalled });
  assert.equal(result.blocked, false);
});

test('blocks when one line deletes main amid feature pushes', () => {
  const stdin = [
    `refs/heads/feat-a ${SHA_A} refs/heads/feat-a ${ZERO}`,
    `(delete) ${ZERO} refs/heads/main ${SHA_B}`,
    `refs/heads/feat-b ${SHA_A} refs/heads/feat-b ${SHA_B}`,
  ].join('\n');
  const result = evaluatePush(stdin, { isAncestor: ffStub });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /main/);
});

test('ignores blank lines in stdin', () => {
  const stdin = `\n\nrefs/heads/feat-x ${SHA_A} refs/heads/feat-x ${SHA_B}\n\n`;
  const result = evaluatePush(stdin, { isAncestor: forceStub });
  assert.equal(result.blocked, false);
});

test('main is a protected ref', () => {
  assert.ok(PROTECTED_REFS.includes('refs/heads/main'));
});
