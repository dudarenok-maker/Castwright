// scripts/tests/server-owner.test.mjs — #3264. The server's owner marker for the
// port it actually bound: `<runDir>/server.owner.<port>.json`, written by the
// server and (from the next step) read by the launcher.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pidIsAlive } from '../lib/pid-alive.mjs';
import {
  pruneDeadServerOwners,
  readServerOwner,
  releaseServerOwner,
  serverOwnerPath,
  writeServerOwner,
} from '../lib/server-owner.mjs';

/** A run dir that does not exist yet, removed when the test ends. */
function tempRunDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'server-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, '.run');
}

/** The pid of a process that has already exited, checked to be gone. */
function deadPid() {
  const { pid } = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(pidIsAlive(pid), false, `pid ${pid} should be gone`);
  return pid;
}

test('serverOwnerPath keys the marker by port inside the run dir', () => {
  assert.equal(serverOwnerPath('run', 8443), join('run', 'server.owner.8443.json'));
});

test('write then read round-trips, creating the run dir', (t) => {
  const runDir = tempRunDir(t);

  writeServerOwner({
    runDir,
    port: 8443,
    https: true,
    pid: 4321,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });

  const expected = { pid: 4321, port: 8443, https: true, startedAt: '2026-01-02T03:04:05.000Z' };
  assert.deepEqual(JSON.parse(readFileSync(serverOwnerPath(runDir, 8443), 'utf8')), expected);
  assert.deepEqual(readServerOwner(runDir, 8443), expected);
});

test('writeServerOwner defaults to this process and the current time', (t) => {
  const runDir = tempRunDir(t);
  const before = Date.now();

  writeServerOwner({ runDir, port: 8080, https: false });

  const note = readServerOwner(runDir, 8080);
  assert.equal(note.pid, process.pid);
  assert.equal(note.https, false);
  assert.ok(Date.parse(note.startedAt) >= before);
});

test('readServerOwner: an absent marker reads as null', (t) => {
  assert.equal(readServerOwner(tempRunDir(t), 8080), null);
});

for (const [name, raw] of [
  ['malformed JSON', '{"pid": 12,'],
  ['a JSON null', 'null'],
  ['a note with no pid', '{"port":8080,"https":false}'],
  ['a note with a non-positive pid', '{"pid":0,"port":8080,"https":false}'],
  ['a note with a fractional pid', '{"pid":1.5,"port":8080,"https":false}'],
  ['a note with no port', '{"pid":12,"https":false}'],
  ['a note recording a different port', '{"pid":12,"port":8081,"https":false}'],
]) {
  test(`readServerOwner: ${name} reads as null`, (t) => {
    const runDir = tempRunDir(t);
    writeServerOwner({ runDir, port: 8080, https: false });
    writeFileSync(serverOwnerPath(runDir, 8080), raw, 'utf8');

    assert.equal(readServerOwner(runDir, 8080), null);
  });
}

test('releaseServerOwner deletes the marker when its pid is ours', (t) => {
  const runDir = tempRunDir(t);
  writeServerOwner({ runDir, port: 8080, https: false });

  releaseServerOwner(runDir, 8080);

  assert.equal(existsSync(serverOwnerPath(runDir, 8080)), false);
});

test('releaseServerOwner leaves a marker that records another pid', (t) => {
  const runDir = tempRunDir(t);
  writeServerOwner({ runDir, port: 8080, https: false, pid: 555 });

  releaseServerOwner(runDir, 8080, 556);

  assert.equal(readServerOwner(runDir, 8080)?.pid, 555);
});

test('releaseServerOwner is a no-op when there is no marker', (t) => {
  assert.doesNotThrow(() => releaseServerOwner(tempRunDir(t), 8080));
});

test('pruneDeadServerOwners removes a dead-pid marker and keeps a live one', (t) => {
  const runDir = tempRunDir(t);
  writeServerOwner({ runDir, port: 8080, https: false, pid: deadPid() });
  writeServerOwner({ runDir, port: 8081, https: false, pid: process.pid });

  pruneDeadServerOwners(runDir);

  assert.equal(existsSync(serverOwnerPath(runDir, 8080)), false);
  assert.equal(existsSync(serverOwnerPath(runDir, 8081)), true);
});

test('pruneDeadServerOwners touches only server.owner markers', (t) => {
  const runDir = tempRunDir(t);
  writeServerOwner({ runDir, port: 8080, https: false, pid: 555 });
  const sidecarNote = join(runDir, 'tts.owner.9000.json');
  writeFileSync(sidecarNote, '{"pid":555,"port":9000}', 'utf8');

  pruneDeadServerOwners(runDir, () => false);

  assert.equal(existsSync(serverOwnerPath(runDir, 8080)), false);
  assert.equal(existsSync(sidecarNote), true);
});

test('pruneDeadServerOwners tolerates a run dir that does not exist', (t) => {
  assert.doesNotThrow(() => pruneDeadServerOwners(tempRunDir(t)));
});
