// #3413 — a throwaway `git init` copy of just the files a repo-scanning CLI
// needs, so a test can mutate the CLI (or a file it scans) without writing a
// real tracked file. A test that rewrites a tracked file in place and
// restores it leaves the content identical but moves ctime/ino, which
// verify-cache's stat-identity guard reads as "input changed mid-step" and so
// never caches the step. Scripts that resolve their corpus from their OWN
// location (`new URL('..', import.meta.url)` + `git ls-files`) behave
// identically from the copy.
//
// `trackedDirs` — every git-tracked file under these repo-relative paths is
// copied (what `git ls-files` would list there); `files` — explicit extras.

import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scrubGitEnv, scrubGitEnvForThrowawayRepo } from '../git-env.mjs';

// A throwaway repo has no real index to honour, so every inherited GIT_* var is
// scrubbed (GIT_INDEX_FILE too: scrubGitEnv keeps it, and `git add -A` would
// rewrite the inherited index with this repo's entries). The outer scrubGitEnv
// is a no-op on top of the broad scrub; it is there so git-scrub.test.mjs's
// source scan, which only trusts scrubGitEnv/runCommand by name, can prove it.
function throwawayGitEnv() {
  return scrubGitEnv(scrubGitEnvForThrowawayRepo());
}

// `parentDir` — where the scratch dir is created (default: the OS tmpdir).
export function makeScratchRepo(realRepo, { trackedDirs = [], files = [], parentDir = tmpdir() } = {}) {
  const root = mkdtempSync(join(parentDir, 'scratch-repo-'));
  try {
    // An empty pathspec list would make `git ls-files` list the WHOLE repo.
    const tracked = trackedDirs.length
      ? execFileSync('git', ['ls-files', '-z', '--', ...trackedDirs], {
          cwd: realRepo,
          env: throwawayGitEnv(),
          encoding: 'utf8',
          windowsHide: true,
        })
          .split('\0')
          .filter(Boolean)
      : [];
    for (const rel of [...tracked, ...files]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      copyFileSync(join(realRepo, rel), join(root, rel));
    }
    execFileSync('git', ['init', '-q'], { cwd: root, env: throwawayGitEnv(), windowsHide: true });
    execFileSync('git', ['add', '-A'], { cwd: root, env: throwawayGitEnv(), windowsHide: true });
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
