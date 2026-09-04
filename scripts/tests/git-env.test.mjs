// Unit tests for scripts/git-env.mjs's shared GIT_* env helpers.
// scrubGitEnv() itself already has coverage in bump-version.test.mjs, which
// pins its case-insensitivity and GIT_INDEX_FILE preservation behavior.
// release-body.test.mjs and verify-cache.test.mjs now test only
// scrubGitEnvForThrowawayRepo() (#2865), the broader sibling those two test
// files delegate their local cleanGitEnv() to instead of each hand-rolling
// the strip loop. This file is for scrubGitEnvForThrowawayRepo().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';

// Mirrors the case-insensitivity regression already pinned per-file in
// bump-version.test.mjs / release-body.test.mjs / verify-cache.test.mjs:
// Windows preserves whatever casing a var was stored under while lookup is
// case-insensitive, and git honours a lowercase `git_dir` identically to
// `GIT_DIR`. Deliberately mixed-case-only, so it cannot pass against a
// `key.startsWith('GIT_')` filter.
test('scrubGitEnvForThrowawayRepo strips a GIT_ override regardless of stored casing', () => {
  const fakeEnv = {
    PATH: '/usr/bin',
    git_dir: '/decoy/.git',
    Git_Work_Tree: '/decoy',
  };
  const scrubbed = scrubGitEnvForThrowawayRepo(fakeEnv);
  assert.equal(scrubbed.git_dir, undefined);
  assert.equal(scrubbed.Git_Work_Tree, undefined);
  assert.equal(scrubbed.PATH, '/usr/bin');
});

// The one assertion that didn't already exist anywhere: this is the exact
// behaviour that distinguishes scrubGitEnvForThrowawayRepo() from
// scrubGitEnv() (which deliberately PRESERVES GIT_INDEX_FILE — see the #2216
// correction in git-env.mjs). A throwaway repo built fresh in a temp dir has
// no real index or ambient repository state to honour, so every GIT_*-named
// key must go, GIT_INDEX_FILE and GIT_PREFIX included.
test('scrubGitEnvForThrowawayRepo strips GIT_INDEX_FILE and GIT_PREFIX too, unlike scrubGitEnv', () => {
  const fakeEnv = {
    PATH: '/usr/bin',
    GIT_DIR: '/decoy/.git',
    GIT_WORK_TREE: '/decoy',
    GIT_OBJECT_DIRECTORY: '/decoy/.git/objects',
    GIT_COMMON_DIR: '/decoy/.git',
    GIT_INDEX_FILE: '/decoy/.git/index',
    GIT_PREFIX: 'sub/dir/',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  };
  const scrubbed = scrubGitEnvForThrowawayRepo(fakeEnv);
  assert.equal(scrubbed.GIT_DIR, undefined);
  assert.equal(scrubbed.GIT_WORK_TREE, undefined);
  assert.equal(scrubbed.GIT_OBJECT_DIRECTORY, undefined);
  assert.equal(scrubbed.GIT_COMMON_DIR, undefined);
  assert.equal(scrubbed.GIT_INDEX_FILE, undefined);
  assert.equal(scrubbed.GIT_PREFIX, undefined);
  assert.equal(scrubbed.GIT_AUTHOR_DATE, undefined);
  assert.equal(scrubbed.PATH, '/usr/bin');
});

// Default-parameter behaviour matches scrubGitEnv()'s: called with no
// argument, it scrubs process.env, not an empty object.
test('scrubGitEnvForThrowawayRepo defaults to scrubbing process.env', () => {
  const saved = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = '/decoy/.git';
    const scrubbed = scrubGitEnvForThrowawayRepo();
    assert.equal(scrubbed.GIT_DIR, undefined);
    const pathKey = Object.keys(scrubbed).find((k) => k.toUpperCase() === 'PATH');
    assert.ok(pathKey, 'PATH must survive the scrub');
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

// The override-after-strip pattern bump-version.test.mjs's runBump() relies
// on (re-adding GIT_AUTHOR_DATE/GIT_COMMITTER_DATE after stripping) must
// keep working with a plain object spread — no extra API needed.
test('a caller can re-add a specific GIT_* var after scrubbing via plain spread', () => {
  const fakeEnv = { PATH: '/usr/bin', GIT_AUTHOR_DATE: 'old' };
  const merged = { ...scrubGitEnvForThrowawayRepo(fakeEnv), GIT_AUTHOR_DATE: 'new' };
  assert.equal(merged.GIT_AUTHOR_DATE, 'new');
  assert.equal(merged.PATH, '/usr/bin');
});
