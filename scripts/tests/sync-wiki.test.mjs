import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  copyWikiTree,
  buildCommitMessage,
  diffWikiTree,
  exceedsDeleteThreshold,
  DELETE_THRESHOLD,
} from '../sync-wiki.mjs';

test('copyWikiTree copies markdown and images, excluding .git', () => {
  const src = mkdtempSync(path.join(tmpdir(), 'wiki-src-'));
  const dest = mkdtempSync(path.join(tmpdir(), 'wiki-dest-'));
  try {
    writeFileSync(path.join(src, 'Home.md'), '# Home');
    mkdirSync(path.join(src, 'images', 'home'), { recursive: true });
    writeFileSync(path.join(src, 'images', 'home', '01-test.png'), 'fake-png');
    mkdirSync(path.join(src, '.git'), { recursive: true });
    writeFileSync(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/master');

    copyWikiTree(src, dest);

    assert.equal(readFileSync(path.join(dest, 'Home.md'), 'utf8'), '# Home');
    assert.equal(
      readFileSync(path.join(dest, 'images', 'home', '01-test.png'), 'utf8'),
      'fake-png',
    );
    assert.equal(existsSync(path.join(dest, '.git')), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('copyWikiTree mirrors: removes stale dest files no longer in source, preserves .git', () => {
  const src = mkdtempSync(path.join(tmpdir(), 'wiki-src-'));
  const dest = mkdtempSync(path.join(tmpdir(), 'wiki-dest-'));
  try {
    writeFileSync(path.join(src, 'Home.md'), '# Home');

    // Simulate a freshly-cloned wiki repo: a page that no longer exists in
    // srcDir (deleted locally) plus a .git dir that must survive the sync.
    writeFileSync(path.join(dest, 'Stale.md'), 'stale page');
    mkdirSync(path.join(dest, '.git'), { recursive: true });
    writeFileSync(path.join(dest, '.git', 'HEAD'), 'ref: refs/heads/master');

    copyWikiTree(src, dest);

    assert.equal(existsSync(path.join(dest, 'Stale.md')), false);
    assert.equal(readFileSync(path.join(dest, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/master');
    assert.equal(readFileSync(path.join(dest, 'Home.md'), 'utf8'), '# Home');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('copyWikiTree throws when the source directory is missing', () => {
  const dest = mkdtempSync(path.join(tmpdir(), 'wiki-dest-'));
  try {
    assert.throws(
      () => copyWikiTree(path.join(dest, 'does-not-exist'), dest),
      /source directory not found/,
    );
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('buildCommitMessage embeds the short source SHA', () => {
  assert.equal(buildCommitMessage('abc1234'), 'sync wiki from Castwright@abc1234');
});

// #1343 — sync-wiki's mirror-then-push had no diff-review gate before a
// deletion reached the live wiki. diffWikiTree computes the would-be
// added/removed/changed set BEFORE copyWikiTree mutates anything, so a
// caller can refuse the push on an unexpected mass-deletion.
test('diffWikiTree reports added/removed/changed pages without mutating either tree', () => {
  const src = mkdtempSync(path.join(tmpdir(), 'wiki-src-'));
  const dest = mkdtempSync(path.join(tmpdir(), 'wiki-dest-'));
  try {
    writeFileSync(path.join(src, 'Home.md'), 'new home content');
    writeFileSync(path.join(src, 'New-Page.md'), 'brand new');
    writeFileSync(path.join(dest, 'Home.md'), 'old home content');
    writeFileSync(path.join(dest, 'Stale-Page.md'), 'about to be removed');

    const { added, removed, changed } = diffWikiTree(src, dest);

    assert.deepEqual(added, ['New-Page.md']);
    assert.deepEqual(removed, ['Stale-Page.md']);
    assert.deepEqual(changed, ['Home.md']);
    // Neither tree was touched by the diff itself.
    assert.equal(existsSync(path.join(dest, 'Stale-Page.md')), true);
    assert.equal(readFileSync(path.join(dest, 'Home.md'), 'utf8'), 'old home content');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('diffWikiTree ignores .git and walks nested directories', () => {
  const src = mkdtempSync(path.join(tmpdir(), 'wiki-src-'));
  const dest = mkdtempSync(path.join(tmpdir(), 'wiki-dest-'));
  try {
    mkdirSync(path.join(dest, '.git'), { recursive: true });
    writeFileSync(path.join(dest, '.git', 'HEAD'), 'ref: refs/heads/master');
    mkdirSync(path.join(src, 'images'), { recursive: true });
    writeFileSync(path.join(src, 'images', 'cover.png'), 'binary-ish');

    const { added, removed } = diffWikiTree(src, dest);

    assert.deepEqual(added, ['images/cover.png']);
    assert.deepEqual(removed, []);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('exceedsDeleteThreshold refuses once removed pages exceed the threshold, unless allowed', () => {
  assert.equal(exceedsDeleteThreshold(DELETE_THRESHOLD, false), false);
  assert.equal(exceedsDeleteThreshold(DELETE_THRESHOLD + 1, false), true);
  assert.equal(exceedsDeleteThreshold(DELETE_THRESHOLD + 1, true), false);
});
