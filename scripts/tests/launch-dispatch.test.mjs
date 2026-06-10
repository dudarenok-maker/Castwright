import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidecarCommand } from '../launch-sidecar.mjs';
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
