// scripts/tests/pid-alive.test.mjs — PR #3404 review pass 1, yellow finding 1.
// pidIsAlive must fail SAFE: only ESRCH (the pid is truly gone) may read as
// gone. EPERM (alive, but not ours) and any other unexpected errno must both
// read as alive — a probe that fails open here can report a kill that never
// happened.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pidIsAlive } from '../lib/pid-alive.mjs';

function withMockedKill(impl, fn) {
  const original = process.kill;
  process.kill = impl;
  try {
    return fn();
  } finally {
    process.kill = original;
  }
}

test('pidIsAlive: no throw (process.kill succeeds) -> alive', () => {
  withMockedKill(
    () => true,
    () => {
      assert.equal(pidIsAlive(123), true);
    },
  );
});

test('pidIsAlive: ESRCH (the pid does not exist) -> gone', () => {
  withMockedKill(
    () => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    },
    () => {
      assert.equal(pidIsAlive(123), false);
    },
  );
});

test('pidIsAlive: EPERM (alive, but owned by someone else) -> alive', () => {
  withMockedKill(
    () => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    },
    () => {
      assert.equal(pidIsAlive(123), true);
    },
  );
});

test('pidIsAlive: an unexpected errno (neither ESRCH nor EPERM) fails SAFE -> alive', () => {
  withMockedKill(
    () => {
      throw Object.assign(new Error('kill ERR_INVALID_ARG_TYPE'), { code: 'ERR_INVALID_ARG_TYPE' });
    },
    () => {
      assert.equal(pidIsAlive(123), true, 'an unrecognised error must never be read as confirmed-gone');
    },
  );
});
