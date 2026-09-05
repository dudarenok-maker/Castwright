// REAL-GIT coverage for nonceInHistory.
//
// Why this file exists: of the five green-direction Criticals found in review
// passes 5 and 6, FOUR lived in this one nine-line function — --full-history,
// the -S anchor, and merge diffing. None of them is visible from JavaScript.
// The unit suite stubs the runner, so it can pin the argv and nothing about
// what git does with it; every one of those defects passed a green unit suite.
//
// These tests build throwaway repositories and ask the real binary. They are
// the only thing standing between a git-semantics change and a silent
// fail-green, so treat a failure here as a correctness alarm, not a flake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nonceInHistory } from '../publish-token.mjs';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';

const LIVE = 'docs/live.html';

// EVERY git spawn in this file MUST use this env. Passing `cwd` is NOT enough:
// git resolves the repository from the environment BEFORE falling back to
// discovery from `cwd`, so `git -C <tmp>` does not protect you.
//
// Without it, these throwaway repositories' init/add/commit reach the REAL
// repository. Not theoretical — it happened twice while this file was being
// written, replacing a 3,979-entry index with a one-entry index holding this
// file's fixture path, and leaving a fixture commit named "base" as HEAD.
//
// TWO groups of keys, and they are scrubbed for different reasons:
//
//   1. REPOSITORY REDIRECTION — GIT_DIR, GIT_WORK_TREE, GIT_OBJECT_DIRECTORY,
//      GIT_COMMON_DIR. Delegated to `scrubGitEnv` (scripts/git-env.mjs, #2169
//      / #2216) rather than re-listed here, so this file inherits any later
//      addition instead of becoming a third divergent copy. That helper also
//      matches case-INSENSITIVELY, which matters and is easy to get wrong:
//      Windows preserves whatever casing a variable was stored under, env
//      lookup there is case-insensitive, and git honours a lowercase `git_dir`
//      exactly as it honours `GIT_DIR` (measured on git 2.54.0.windows.1 —
//      `git rev-parse --absolute-git-dir` from an unrelated cwd resolved to
//      the `git_dir` target). A `startsWith('GIT_')` filter leaves that
//      survivor in place, which is a no-op fix for the one case the scrub
//      exists to close.
//
//   2. GIT_INDEX_FILE — deliberately NOT in that helper's list, and
//      deliberately scrubbed HERE. Its exclusion there is correct and
//      measured: a hook exports it (an ordinary hook does NOT export GIT_DIR —
//      that is the header's own #2216 correction), git re-anchors it to the
//      discovered toplevel, and a command whose job is to read the in-flight
//      staged set must honour whichever index git is actually using. This file
//      is the opposite case: nothing here reads the staged set, every spawn
//      builds a disposable repository, and an inherited index is precisely
//      what turned the real one into a one-entry file. So the general rule is
//      right and this site is its exception — stated rather than assumed,
//      because deleting this line looks like tidying.
//
// Strip GIT_* env vars before spawning git in a throwaway repo. When this
// test runs from a git hook context (e.g. pre-commit via husky), the parent
// `git commit` sets GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE / GIT_PREFIX,
// which child processes inherit. Without sanitising, the test's `git commit`
// would write into the PARENT worktree's git instead of the temp fixture —
// silently creating bogus commits on whatever branch invoked the hook. A
// throwaway repo built fresh in a temp dir has no real index or ambient
// repository state to honour, so every GIT_*-named key must go, including
// GIT_INDEX_FILE, GIT_PREFIX, and GIT_AUTHOR_DATE. Delegated to the shared,
// broader-than-scrubGitEnv() helper — see git-env.mjs for the case-
// insensitivity and GIT_INDEX_FILE-preservation rationale and why
// scrubGitEnvForThrowawayRepo() is the right choice here.
const cleanEnv = () => scrubGitEnvForThrowawayRepo();

// The same shape check-onbox-register.mjs's runGitCommand returns.
const runner = (args, cwd) => {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: cleanEnv(),
      windowsHide: true,
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', error: err };
  }
};

const git = (repo, ...args) =>
  execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: cleanEnv(), windowsHide: true });
const token = (n, nonce) => `<p data-published-as="${n}" data-publish-id="${nonce}">x</p>\n`;

function writeToken(repo, n, nonce) {
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, LIVE), token(n, nonce));
}

function newRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'nonce-git-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  return repo;
}

const ask = (repo, nonce, ref = 'HEAD') => nonceInHistory(repo, LIVE, nonce, ref, runner);

test('git: the env scrub actually isolates the throwaway repo (self-check)', () => {
  // The instrument-check for every other test in this file. If the scrub ever
  // regresses, these tests do not fail — they silently operate on the real
  // repository and destroy it, which is far worse than a red test. So assert
  // the isolation directly, with GIT_DIR/GIT_INDEX_FILE deliberately set to
  // the values a hook would export.
  // BOTH casings. git honours a lowercase `git_dir` exactly as it honours
  // `GIT_DIR`, and Windows preserves whatever casing a variable was stored
  // under — so an uppercase-only injection leaves a case-sensitive scrub
  // looking correct while the survivor it misses is the live hazard.
  for (const [dirKey, indexKey] of [
    ['GIT_DIR', 'GIT_INDEX_FILE'],
    ['git_dir', 'git_index_file'],
  ]) {
    const decoy = newRepo();
    const repo = newRepo();
    try {
      const saved = { dir: process.env[dirKey], index: process.env[indexKey] };
      process.env[dirKey] = join(decoy, '.git');
      process.env[indexKey] = join(decoy, '.git', 'index');
      try {
        writeToken(repo, 1, 'nISOLATE');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-qm', 'isolated');
        // The work landed in `repo`...
        assert.equal(ask(repo, 'nISOLATE'), true, `${dirKey}: work did not land in the temp repo`);
        // ...and the decoy the env pointed at is untouched.
        const decoyFiles = execFileSync('git', ['ls-files'], {
          cwd: decoy,
          encoding: 'utf8',
          env: cleanEnv(),
          windowsHide: true,
        });
        assert.equal(decoyFiles.trim(), '', `${dirKey} leaked: the decoy repo was written to`);
      } finally {
        for (const [k, v] of [[dirKey, saved.dir], [indexKey, saved.index]]) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(decoy, { recursive: true, force: true });
    }
  }
});

test('git: a nonce on an ordinary commit is found, an absent one is not', () => {
  const repo = newRepo();
  try {
    writeToken(repo, 1, 'nBASE0');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    assert.equal(ask(repo, 'nBASE0'), true);
    assert.equal(ask(repo, 'nNEVER'), false, 'an absent nonce must be false, or every STOP dies');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git: a nonce born in a MERGE CONFLICT RESOLUTION is found (pass 6 / F1)', () => {
  // The routine shape in this repo: two lanes edit the live view, the merge
  // conflicts, and the resolution re-stamps — so the surviving token exists in
  // NEITHER parent. Without --diff-merges git computes no diff for the merge
  // and reports the nonce absent from the history that literally contains it.
  const repo = newRepo();
  try {
    writeToken(repo, 1, 'nBASE0');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');

    git(repo, 'checkout', '-q', '-b', 'lane');
    writeToken(repo, 2, 'nLANEA');
    git(repo, 'commit', '-qam', 'lane');

    git(repo, 'checkout', '-q', 'main');
    writeToken(repo, 2, 'nMAIN0');
    git(repo, 'commit', '-qam', 'main');

    git(repo, 'checkout', '-q', 'lane');
    try {
      git(repo, 'merge', '--no-commit', 'main');
    } catch {
      /* the conflict is the point */
    }
    writeToken(repo, 3, 'nRESOLV'); // the re-stamp that resolves it
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'merge + restamp');

    // Ground truth: the nonce IS the current content.
    assert.match(
      execFileSync('git', ['show', `HEAD:${LIVE}`], {
        cwd: repo,
        encoding: 'utf8',
        env: cleanEnv(),
        windowsHide: true,
      }),
      /nRESOLV/,
    );
    assert.equal(ask(repo, 'nRESOLV'), true, 'a merge-born nonce must be visible to the lookup');
    // and the other lane's pre-merge nonce is still reachable
    assert.equal(ask(repo, 'nMAIN0'), true);
    assert.equal(ask(repo, 'nNEVER'), false, 'merge diffing must not make everything true');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git: a nonce PRUNED by default history simplification is found (pass 5 / C2)', () => {
  // Two lanes diverge; the merge resolves by taking one side wholesale, so the
  // result is TREESAME to that parent for this path and default simplification
  // walks only it — pruning the other lane's commit out of the answer. Taking
  // one side wholesale is the most likely resolution for this file, which is
  // what makes `false` meaning "pruned" rather than "absent" dangerous.
  const repo = newRepo();
  try {
    writeToken(repo, 1, 'nBASE0');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');

    git(repo, 'checkout', '-q', '-b', 'laneB');
    writeToken(repo, 2, 'nLANEB');
    git(repo, 'commit', '-qam', 'B');

    git(repo, 'checkout', '-q', 'main');
    writeToken(repo, 2, 'nLANEA');
    git(repo, 'commit', '-qam', 'A');

    try {
      git(repo, 'merge', '--no-commit', 'laneB');
    } catch {
      /* conflict expected */
    }
    writeToken(repo, 2, 'nLANEA'); // take ours wholesale -> TREESAME to main
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'merge, took ours');

    // Ground truth: B is an ancestor, so its nonce IS in this history.
    assert.doesNotThrow(() => git(repo, 'merge-base', '--is-ancestor', 'laneB', 'HEAD'));
    assert.equal(ask(repo, 'nLANEB'), true, 'a pruned nonce must still be found');

    // HONEST LIMIT of this test. Measured on this exact repo:
    //   plain                                  -> 0   (pruned; C2 is real)
    //   --full-history                         -> 1
    //   --diff-merges=first-parent             -> 1
    //   --full-history --diff-merges=first-parent -> 1
    // So with the merge-diff flag present, DELETING --full-history leaves this
    // test green — the two overlap here, and this scenario cannot isolate
    // --full-history's own contribution. It is kept because it is free and
    // because no one has shown the overlap is total; the unit suite asserts it
    // stays in the argv so it cannot be dropped silently. If you can build a
    // case where --full-history matters and --diff-merges does not, add it —
    // that is the missing half of this test, and its absence is why the
    // corresponding mutant survives rather than because the flag is dead.
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git: --diff-merges alone does NOT rescue the plain-default pruning', () => {
  // The control for the note above: proves the pruning it describes is real
  // rather than an artifact, by showing the unflagged query genuinely misses.
  const repo = newRepo();
  try {
    writeToken(repo, 1, 'nBASE0');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'checkout', '-q', '-b', 'laneB');
    writeToken(repo, 2, 'nLANEB');
    git(repo, 'commit', '-qam', 'B');
    git(repo, 'checkout', '-q', 'main');
    writeToken(repo, 2, 'nLANEA');
    git(repo, 'commit', '-qam', 'A');
    try {
      git(repo, 'merge', '--no-commit', 'laneB');
    } catch {
      /* conflict expected */
    }
    writeToken(repo, 2, 'nLANEA');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'merge, took ours');

    const bare = runner(
      ['log', '--oneline', '-s', '-S', 'data-publish-id="nLANEB"', 'HEAD', '--', LIVE],
      repo,
    );
    assert.equal(bare.status, 0);
    assert.equal(
      bare.stdout.trim(),
      '',
      'the UNFLAGGED query must miss it — otherwise this whole test proves nothing',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git: the -S query is anchored — a nonce inside a longer string does not match', () => {
  // -S is a substring search. A six-hex nonce collides with the abbreviated
  // SHAs this very page quotes in its changelog prose; an unanchored query
  // would report a rival's publish as your own.
  const repo = newRepo();
  try {
    writeToken(repo, 1, 'nBASE0');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    // A commit that mentions ab12cd — a superstring of the rival nonce ab12cd
    // is not enough; use a nonce that is a strict substring of unrelated text.
    writeFileSync(join(repo, LIVE), token(2, 'nBASE0') + '<p>see commit abc123def for detail</p>\n');
    git(repo, 'commit', '-qam', 'cite a sha');
    assert.equal(
      ask(repo, 'abc123'),
      false,
      'a nonce appearing only inside prose must NOT count as published',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git: the ref is honoured — a sibling lane\'s nonce is not in my history', () => {
  const repo = newRepo();
  try {
    writeToken(repo, 1, 'nBASE0');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');

    git(repo, 'checkout', '-q', '-b', 'rival');
    writeToken(repo, 2, 'nRIVAL');
    git(repo, 'commit', '-qam', 'rival');

    git(repo, 'checkout', '-q', 'main');
    writeToken(repo, 2, 'nMINE0');
    git(repo, 'commit', '-qam', 'mine');

    // This is THE question the whole feature turns on.
    assert.equal(ask(repo, 'nRIVAL', 'HEAD'), false, "a rival's nonce must be absent from mine");
    assert.equal(ask(repo, 'nRIVAL', 'rival'), true, 'and present on theirs');
    assert.equal(ask(repo, 'nMINE0', 'HEAD'), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git: a real failure returns null, never false', () => {
  const repo = newRepo(); // no commits at all -> git log fails
  try {
    assert.equal(ask(repo, 'nBASE0'), null, 'a failed lookup must not read as "absent"');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
