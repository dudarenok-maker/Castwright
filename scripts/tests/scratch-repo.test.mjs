// #3413 review pass 2 — makeScratchRepo builds a throwaway repo, so it must
// scrub EVERY inherited GIT_* var (scrubGitEnvForThrowawayRepo), GIT_INDEX_FILE
// included. scrubGitEnv() deliberately keeps GIT_INDEX_FILE, and under a hook
// that exports one (`git commit -a`) the scratch repo's `git add -A` rewrote
// THAT index with the sandbox's entries: the recorded 3,979 -> 1 tracked-files
// incident. The decoy index below is a copy in a temp dir, never the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeScratchRepo } from '../lib/scratch-repo.mjs';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';

test('makeScratchRepo leaves an inherited GIT_INDEX_FILE untouched', () => {
  const work = mkdtempSync(join(tmpdir(), 'scratch-repo-test-'));
  const savedIdx = process.env.GIT_INDEX_FILE;
  try {
    // A source repo with several tracked files, and a COPY of its index as the decoy.
    const real = join(work, 'real');
    mkdirSync(join(real, 'docs'), { recursive: true });
    for (const f of ['a.txt', 'b.txt', 'c.txt', 'docs/d.txt']) writeFileSync(join(real, f), f, 'utf8');
    const git = (cwd, args) =>
      execFileSync('git', args, { cwd, env: scrubGitEnvForThrowawayRepo(), encoding: 'utf8', windowsHide: true });
    git(real, ['init', '-q']);
    git(real, ['add', '-A']);
    const decoy = join(work, 'decoy-index');
    copyFileSync(join(real, '.git', 'index'), decoy);
    const before = readFileSync(decoy);

    process.env.GIT_INDEX_FILE = decoy; // inherited, as under a hook
    const sb = makeScratchRepo(real, { trackedDirs: ['docs'], files: ['a.txt'] });
    delete process.env.GIT_INDEX_FILE;
    try {
      assert.ok(readFileSync(decoy).equals(before), 'the inherited index must be byte-identical afterwards');
      const own = git(sb.root, ['ls-files']).split('\n').filter(Boolean);
      assert.deepEqual(own.sort(), ['a.txt', 'docs/d.txt'], 'the scratch repo tracks its own copy');
    } finally {
      sb.dispose();
    }
  } finally {
    if (savedIdx === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = savedIdx;
    rmSync(work, { recursive: true, force: true });
  }
});
