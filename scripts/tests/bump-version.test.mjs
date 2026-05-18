// Plan 49 — pin the bump-version script's post-state.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// Strategy: build a throwaway git repo in a tempdir with a minimal
// package.json + lockfile pair (root + server) carrying the SAME starting
// version, then shell out to `node <abs-path>/bump-version.mjs` and assert:
//   - both package.json versions advanced in lockstep
//   - both lockfiles regenerated (version field present)
//   - one new commit with subject "chore: bump version to X.Y.Z"
//   - one new annotated tag "vX.Y.Z" whose message contains "vX.Y.Z"
//
// `--dry-run` mode is asserted to print the plan WITHOUT mutating anything.
//
// `--force` is required because we're running from a throwaway branch
// (not main).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bumpScript = resolve(here, '..', 'bump-version.mjs');

function mkLockfile(name, version) {
  return JSON.stringify(
    {
      name,
      version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name, version },
      },
    },
    null,
    2,
  );
}

function setupRepo(startVersion) {
  const dir = mkdtempSync(resolve(tmpdir(), 'bump-version-test-'));
  // Root package.json + lockfile
  writeFileSync(
    resolve(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-root', version: startVersion, private: true }, null, 2),
  );
  writeFileSync(resolve(dir, 'package-lock.json'), mkLockfile('fixture-root', startVersion));
  // Server package.json + lockfile
  mkdirSync(resolve(dir, 'server'));
  writeFileSync(
    resolve(dir, 'server', 'package.json'),
    JSON.stringify({ name: 'fixture-server', version: startVersion, private: true }, null, 2),
  );
  writeFileSync(
    resolve(dir, 'server', 'package-lock.json'),
    mkLockfile('fixture-server', startVersion),
  );

  // Mirror the bump script + git history into the throwaway repo so it can
  // resolve its own scripts/ path with the same layout the real repo has.
  mkdirSync(resolve(dir, 'scripts'));
  writeFileSync(resolve(dir, 'scripts', 'bump-version.mjs'), readFileSync(bumpScript, 'utf8'));

  // Init throwaway git repo with a local identity so commits work in CI.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: dir });
  return dir;
}

function readVersion(dir, relative) {
  return JSON.parse(readFileSync(resolve(dir, relative), 'utf8')).version;
}

function runBump(dir, args) {
  return spawnSync('node', [resolve(dir, 'scripts', 'bump-version.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

test('bump-version --dry-run prints the plan and does not mutate', () => {
  const dir = setupRepo('1.0.0');
  try {
    const out = runBump(dir, ['--level', 'minor', '--dry-run']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\[PLAN\] bump 1\.0\.0 -> 1\.1\.0/);
    assert.match(out.stdout, /DRY-RUN/);

    // Nothing mutated.
    assert.equal(readVersion(dir, 'package.json'), '1.0.0');
    assert.equal(readVersion(dir, 'server/package.json'), '1.0.0');
    const tags = execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' });
    assert.equal(tags.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version --level patch advances both versions, commits, tags', () => {
  const dir = setupRepo('1.2.3');
  try {
    const out = runBump(dir, ['--level', 'patch']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readVersion(dir, 'package.json'), '1.2.4');
    assert.equal(readVersion(dir, 'server/package.json'), '1.2.4');
    assert.equal(readVersion(dir, 'package-lock.json'), '1.2.4');
    assert.equal(readVersion(dir, 'server/package-lock.json'), '1.2.4');

    const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    assert.equal(subject, 'chore: bump version to 1.2.4');

    const tags = execFileSync('git', ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(tags, 'v1.2.4');

    const annotation = execFileSync(
      'git',
      ['tag', '-l', '--format=%(contents)', 'v1.2.4'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.match(annotation, /v1\.2\.4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version --level minor zeros the patch field', () => {
  const dir = setupRepo('2.4.7');
  try {
    const out = runBump(dir, ['--level', 'minor']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readVersion(dir, 'package.json'), '2.5.0');
    assert.equal(readVersion(dir, 'server/package.json'), '2.5.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version --level major zeros minor + patch', () => {
  const dir = setupRepo('3.4.5');
  try {
    const out = runBump(dir, ['--level', 'major']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readVersion(dir, 'package.json'), '4.0.0');
    assert.equal(readVersion(dir, 'server/package.json'), '4.0.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version refuses lockstep drift', () => {
  const dir = setupRepo('1.0.0');
  try {
    /* Manually drift the server version + commit so the working tree is
       clean. The bump script's lockstep pre-flight must reject this. */
    writeFileSync(
      resolve(dir, 'server', 'package.json'),
      JSON.stringify({ name: 'fixture-server', version: '1.0.1', private: true }, null, 2),
    );
    execFileSync('git', ['add', 'server/package.json'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'drift'], { cwd: dir });

    const out = runBump(dir, ['--level', 'patch']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /Lockstep invariant violated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version --notes-file uses file content as the tag annotation', () => {
  const dir = setupRepo('1.0.0');
  try {
    /* Author the notes file OUTSIDE the repo so it doesn't show up as
       untracked in `git status` and trip the clean-tree pre-flight. The
       real workflow has the same shape: deployer keeps notes wherever
       (Desktop, Notes app), passes the path with --notes-file. */
    const notes = resolve(tmpdir(), `bump-notes-${process.pid}-${Date.now()}.md`);
    writeFileSync(notes, '# v1.0.1\n\nFixes:\n- the bug\n');
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes]);
    rmSync(notes, { force: true });
    assert.equal(out.status, 0, out.stderr);

    const annotation = execFileSync(
      'git',
      ['tag', '-l', '--format=%(contents)', 'v1.0.1'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.match(annotation, /Fixes:/);
    assert.match(annotation, /the bug/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version rejects an unknown --level', () => {
  const dir = setupRepo('1.0.0');
  try {
    const out = runBump(dir, ['--level', 'wibble']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /--level must be patch \| minor \| major/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version refuses a dirty tree (unless --dry-run)', () => {
  const dir = setupRepo('1.0.0');
  try {
    writeFileSync(resolve(dir, 'package.json'), '{"name":"fixture-root","version":"1.0.0","x":1}');
    const out = runBump(dir, ['--level', 'patch']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /Working tree is not clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
