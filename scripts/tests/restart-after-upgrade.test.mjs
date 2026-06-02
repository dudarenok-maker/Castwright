// fs-1 — pin restart-after-upgrade's waitForExit polling.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForExit } from '../restart-after-upgrade.mjs';

const noSleep = async () => {};

test('resolves true as soon as the pid is gone', async () => {
  let calls = 0;
  // alive for the first 2 polls, then exits.
  const isAlive = () => {
    calls += 1;
    return calls < 3;
  };
  const exited = await waitForExit({ pid: 123, timeoutMs: 10000, intervalMs: 1, isAlive, sleep: noSleep });
  assert.equal(exited, true);
});

test('resolves true immediately when the pid is already gone', async () => {
  const exited = await waitForExit({ pid: 123, isAlive: () => false, sleep: noSleep });
  assert.equal(exited, true);
});

test('resolves false on timeout when the pid never exits', async () => {
  // Injected clock advances past the deadline after a couple of polls.
  let t = 0;
  const now = () => (t += 400); // deadline = first now() + 1000
  const exited = await waitForExit({
    pid: 123,
    timeoutMs: 1000,
    intervalMs: 1,
    isAlive: () => true,
    sleep: noSleep,
    now,
  });
  assert.equal(exited, false);
});
