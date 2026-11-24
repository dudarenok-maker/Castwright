// scripts/tests/check-utf8.test.mjs
// Acceptance tests for scripts/check-utf8.mjs (#4586). Fixtures live in an OS
// temp dir, never inside the repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findNonUtf8, scanTrackedTextFiles } from '../check-utf8.mjs';
import { scrubGitEnv } from '../git-env.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-utf8.mjs');

test('findNonUtf8: valid UTF-8 with a multi-byte em dash passes', () => {
  const bytes = Buffer.from('// a — b\n', 'utf8');
  assert.deepEqual(findNonUtf8([{ path: 'server/a.ts', bytes }]), []);
});

test('findNonUtf8: a lone 0x97 byte fails and reports its offset', () => {
  const bytes = Buffer.concat([Buffer.from('// a '), Buffer.from([0x97]), Buffer.from(' b\n')]);
  assert.deepEqual(findNonUtf8([{ path: 'server/a.ts', bytes }]), [
    { path: 'server/a.ts', offset: 5 },
  ]);
});

test('findNonUtf8: a lead byte followed by ASCII reports the lead byte, not the ASCII', () => {
  const bytes = Buffer.from([0x61, 0x62, 0xe2, 0x78]);
  assert.deepEqual(findNonUtf8([{ path: 'server/a.ts', bytes }]), [
    { path: 'server/a.ts', offset: 2 },
  ]);
});

test('findNonUtf8: a sequence truncated at EOF reports its lead byte', () => {
  const bytes = Buffer.from([0x61, 0x62, 0xe2, 0x80]);
  assert.deepEqual(findNonUtf8([{ path: 'server/a.ts', bytes }]), [
    { path: 'server/a.ts', offset: 2 },
  ]);
});

test('findNonUtf8: a BOM\'d UTF-16LE .ts is reported as non-UTF-8, not skipped', () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('// hi\n', 'utf16le')]);
  assert.deepEqual(findNonUtf8([{ path: 'server/ps-out.ts', bytes }]), [
    { path: 'server/ps-out.ts', offset: 0 },
  ]);
});

test('findNonUtf8: a valid-UTF-8 .mjs with an embedded NUL passes', () => {
  const bytes = Buffer.from('const k = `${a}\0${b}`;\n', 'utf8');
  assert.deepEqual(findNonUtf8([{ path: 'scripts/keys.mjs', bytes }]), []);
});

test('findNonUtf8: an embedded NUL does not hide a stray 0x97 in a .mjs', () => {
  const bytes = Buffer.concat([Buffer.from('// a '), Buffer.from([0x97]), Buffer.from('\nconst k = `${a}\0${b}`;\n')]);
  assert.deepEqual(findNonUtf8([{ path: 'scripts/keys.mjs', bytes }]), [
    { path: 'scripts/keys.mjs', offset: 5 },
  ]);
});

test('findNonUtf8: epub, pcm and webm fixtures are skipped by extension', () => {
  const bytes = Buffer.from([0x00, 0x97, 0x41]);
  assert.deepEqual(
    findNonUtf8(['a.epub', 'a.pcm', 'a.webm'].map((p) => ({ path: `server/${p}`, bytes }))),
    [],
  );
});

test('findNonUtf8: a skip-listed extension is skipped even when not valid UTF-8', () => {
  const bytes = Buffer.from([0x97, 0x97]);
  assert.deepEqual(findNonUtf8([{ path: 'src/logo.PNG', bytes }]), []);
});

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-utf8-'));
  spawnSync('git', ['init', '-q'], { cwd: dir, env: scrubGitEnv(), windowsHide: true });
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  }
  spawnSync('git', ['add', '-A'], { cwd: dir, env: scrubGitEnv(), windowsHide: true });
  return dir;
}

test('CLI: a temp git repo with one bad file exits non-zero and names it', () => {
  const dir = makeRepo({
    'server/ok.ts': Buffer.from('// —\n'),
    'server/bad.ts': Buffer.concat([Buffer.from('x'), Buffer.from([0x97])]),
  });
  try {
    const r = spawnSync(process.execPath, [CLI], { cwd: dir, env: scrubGitEnv(), encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /FAIL/);
    assert.match(r.stdout, /server\/bad\.ts/);
    assert.match(r.stdout, /offset 1/);
    assert.doesNotMatch(r.stdout, /server\/ok\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a clean temp git repo exits 0', () => {
  const dir = makeRepo({ 'src/ok.ts': Buffer.from('// —\n') });
  try {
    const r = spawnSync(process.execPath, [CLI], { cwd: dir, env: scrubGitEnv(), encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /check-utf8: OK — 1 tracked text files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanTrackedTextFiles: extension-skipped files are counted as skipped, not checked', () => {
  const dir = makeRepo({
    'src/ok.ts': Buffer.from('// —\n'),
    'src/logo.png': Buffer.from([0x89, 0x97]),
  });
  try {
    const r = scanTrackedTextFiles(dir);
    assert.equal(r.checked, 1);
    assert.equal(r.skipped, 1);
    assert.deepEqual(r.offenders, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: the OK line counts only decoded files and prints the skipped count', () => {
  const dir = makeRepo({
    'src/ok.ts': Buffer.from('// —\n'),
    'src/logo.png': Buffer.from([0x89, 0x97]),
  });
  try {
    const r = spawnSync(process.execPath, [CLI], { cwd: dir, env: scrubGitEnv(), encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /check-utf8: OK — 1 tracked text files are valid UTF-8 \(1 skipped by extension\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
