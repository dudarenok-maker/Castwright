import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVenvPython } from '../run-sidecar-tests.mjs';

function fixture(relPath) {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-'));
  const abs = join(dir, ...relPath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '', 'utf8');
  return dir;
}

test('resolveVenvPython finds the POSIX venv layout', () => {
  const dir = fixture('.venv/bin/python');
  assert.equal(resolveVenvPython(dir, 'linux'), join(dir, '.venv', 'bin', 'python'));
});

test('resolveVenvPython finds the Windows venv layout', () => {
  const dir = fixture('.venv/Scripts/python.exe');
  assert.equal(resolveVenvPython(dir, 'win32'), join(dir, '.venv', 'Scripts', 'python.exe'));
});

test('resolveVenvPython returns null when no venv exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-'));
  assert.equal(resolveVenvPython(dir, 'linux'), null);
});

// A POSIX venv must not be found by the Windows probe and vice versa —
// otherwise the runner would report a venv it cannot execute.
test('resolveVenvPython does not cross platforms', () => {
  const posix = fixture('.venv/bin/python');
  assert.equal(resolveVenvPython(posix, 'win32'), null);
});
