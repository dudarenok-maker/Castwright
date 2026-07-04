import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyWikiTree, buildCommitMessage } from '../sync-wiki.mjs';

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
