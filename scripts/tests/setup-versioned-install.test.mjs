// fs-1 — pin the one-time versioned-install layout plan.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { computeSetupPlan } from '../setup-versioned-install.mjs';

test('lays out releases/<v>, the pointer, the stable launcher, and shared-data moves', () => {
  const source = join('/tmp', 'extracted', 'audiobook-generator-v1.6.0');
  const install = join('/opt', 'audiobook');
  const from = join('/opt', 'old-checkout');
  const plan = computeSetupPlan({ version: '1.6.0', source, install, from });

  const releaseDir = join(install, 'releases', 'v1.6.0');
  // Ordered: container → code → pointer → launcher → data moves.
  assert.deepEqual(
    plan.map((o) => o.op),
    ['mkdir', 'copyDir', 'writeFile', 'copyFile', 'moveDir', 'moveDir', 'moveDir'],
  );
  assert.equal(plan[1].src, source);
  assert.equal(plan[1].dest, releaseDir);
  assert.equal(plan[2].dest, join(install, '.current-version'));
  assert.equal(plan[2].content, '1.6.0');
  assert.equal(plan[3].src, join(releaseDir, 'launch.mjs'));
  assert.equal(plan[3].dest, join(install, 'launch.mjs'));

  // Shared-data moves come FROM the old checkout, INTO siblings of releases/.
  const moves = plan.filter((o) => o.op === 'moveDir');
  assert.deepEqual(
    moves.map((o) => [o.src, o.dest, o.optional]),
    [
      [join(from, 'audiobook-workspace'), join(install, 'workspace'), true],
      [join(from, 'server', 'tts-sidecar', '.venv'), join(install, 'venv'), true],
      [join(from, 'server', 'tts-sidecar', 'voices', 'kokoro'), join(install, 'models', 'kokoro'), true],
    ],
  );
});

test('defaults the data source (from) to --source when not given separately', () => {
  const source = join('/tmp', 'release');
  const install = join('/opt', 'audiobook');
  const plan = computeSetupPlan({ version: '1.6.0', source, install, from: undefined });
  const firstMove = plan.find((o) => o.op === 'moveDir');
  assert.equal(firstMove.src, join(source, 'audiobook-workspace'));
});
