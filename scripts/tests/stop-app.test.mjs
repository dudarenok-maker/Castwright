// scripts/tests/stop-app.test.mjs — PR #3404 review pass 1, yellow finding 4.
//
// stop-app.mjs's killTree() used to trust taskkill's own exit code (the same
// E104 defect fixed in scripts/reap-stale-batteries.mjs): a nonzero exit —
// which `/T` can produce even when the whole target tree is actually gone,
// see reap-stale-batteries.mjs's own E104 comment — made it print
// `[GONE] ... (already exited)` for a tree it had, in fact, just killed
// successfully, and could print `[OK] nothing to stop` right after. Fixed by
// probing liveness BEFORE the kill attempt (to classify "already exited"
// distinctly from "we killed it") and AGAIN afterward (to judge success by
// liveness, not by taskkill's exit code).
//
// Importing stop-app.mjs must NOT stop or sweep anything — main() is guarded
// behind an invoked-directly check (mirrors start-app-prod.mjs), so importing
// killTree() alone is side-effect-free.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killTree } from '../stop-app.mjs';

test('killTree: pid already dead before the call -> "gone", no kill attempted', () => {
  let attempted = false;
  const outcome = killTree(4242, {
    isAlive: () => false,
    kill: () => {
      attempted = true;
    },
  });
  assert.equal(outcome, 'gone');
  assert.equal(attempted, false, 'a pid already confirmed dead must never trigger a kill attempt');
});

test('killTree: kill throws (E104 shape — taskkill exits nonzero) but the pid is actually gone afterward -> "killed"', () => {
  let calls = 0;
  const outcome = killTree(4242, {
    isAlive: () => {
      calls += 1;
      return calls === 1; // alive before the attempt, gone after
    },
    kill: () => {
      throw new Error('taskkill exited 128 (E104 shape)');
    },
  });
  assert.equal(outcome, 'killed', 'a thrown/nonzero taskkill must not be trusted over the post-kill liveness check');
});

test('killTree: kill throws and the pid is still alive afterward -> "failed"', () => {
  const outcome = killTree(4242, {
    isAlive: () => true,
    kill: () => {
      throw new Error('taskkill exited 1');
    },
  });
  assert.equal(outcome, 'failed');
});

test('killTree: kill succeeds (no throw) and the pid is gone afterward -> "killed"', () => {
  let calls = 0;
  const outcome = killTree(4242, {
    isAlive: () => {
      calls += 1;
      return calls === 1;
    },
    kill: () => {},
  });
  assert.equal(outcome, 'killed');
});
