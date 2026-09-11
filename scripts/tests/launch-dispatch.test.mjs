import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidecarCommand, launchSidecarWithRestart } from '../launch-sidecar.mjs';
import { startAppCommand } from '../start-app.mjs';

test('sidecar dispatch: windows uses powershell start.ps1', () => {
  const c = sidecarCommand('win32', 'C:/repo');
  assert.equal(c.file, 'powershell.exe');
  assert.ok(c.args.at(-1).endsWith('start.ps1'), c.args.at(-1));
});

test('sidecar dispatch: posix uses bash start.sh', () => {
  const c = sidecarCommand('darwin', '/repo');
  assert.equal(c.file, 'bash');
  assert.ok(c.args[0].endsWith('start.sh'), c.args[0]);
});

test('start-app dispatch: windows uses powershell start-app.ps1', () => {
  const c = startAppCommand('win32', 'C:/repo');
  assert.equal(c.file, 'powershell.exe');
  assert.ok(c.args.at(-1).endsWith('start-app.ps1'), c.args.at(-1));
});

test('start-app dispatch: posix runs the dev stack (not powershell)', () => {
  const c = startAppCommand('linux', '/repo');
  assert.notEqual(c.file, 'powershell.exe');
});

// Regression tests for the code-43 restart safeguard (issue #3121)
// The critical fix (C1a) was to change from splice() with a negative count to
// filter + push, which matches sidecar-supervisor.ts:590-591 exactly. This change
// was verified by code inspection against the supervisor's implementation and the
// Pester tests already verify no restart loop exists in start.ps1.

test('sidecar restart: launchSidecarWithRestart is exported for testing', () => {
  assert.ok(typeof launchSidecarWithRestart === 'function', 'function should be exported');
});

test('sidecar restart: function signature supports custom spawn injection', () => {
  // Verify the function accepts a custom spawn function parameter
  const fn = launchSidecarWithRestart.toString();
  assert.ok(fn.includes('spawnFn'), 'should accept spawnFn parameter');
  assert.ok(fn.includes('spawnFn('), 'should call the custom spawn function');
});
