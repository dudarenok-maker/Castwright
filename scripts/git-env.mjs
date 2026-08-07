#!/usr/bin/env node
// #2169 — git resolves the repository from these env vars BEFORE it falls
// back to discovery from `cwd`. Any script that pins a git invocation to a
// specific `cwd`/repoRoot (the pattern both bump-version.mjs and
// release-body.mjs use) is silently overridden whenever one of these is
// already set in the ambient environment — e.g. a shell where an earlier
// command exported one, or a script invoked from inside another git
// operation's callback. The failure is invisible: the command still exits 0,
// just against the wrong repository.
//
// This sweep (#2216) is about REPOSITORY REDIRECTION and nothing else. The
// four keys below all answer "which repository" — `GIT_DIR`/`GIT_WORK_TREE`
// directly, `GIT_OBJECT_DIRECTORY`/`GIT_COMMON_DIR` for the object store a
// linked worktree can point elsewhere. Inheriting any one of them silently
// redirects a command that pins an explicit `cwd`, which is #2169's actual
// defect, and there is no legitimate reason a script in this repo would want
// that inherited value: every call site here already computes its own `cwd`.
//
// #2216 correction (this file's header used to be wrong on two points,
// caught by review of #2227 before merge — see that issue's decision-comment
// thread for the full account):
//
//   1. An ordinary git hook process does NOT export `GIT_DIR`. This header
//      used to claim it did ("e.g. every hook process git spawns"), which
//      made the hook-resident call sites (verify-cache.mjs,
//      guard-protected-push.mjs, guard-commit-subjects.mjs,
//      is-docs-only-push.mjs) read as the highest-risk group when they
//      weren't. The real #2169 exposure was an ambient shell export, not a
//      hook — an operator's shell, or a script invoked from inside another
//      repo's tooling.
//
//   2. `GIT_INDEX_FILE` was in this list and is NOT anymore. It was added on
//      the theory that a hook-exported relative `GIT_INDEX_FILE` resolves
//      against a spawned child's cwd rather than the repo root — measured,
//      and false: with `GIT_INDEX_FILE` set ALONE (the shape a hook actually
//      exports), git re-anchors it to the discovered toplevel and the answer
//      is correct regardless of cwd. The wrong-repository hazard needs
//      `GIT_DIR` as well, and hooks don't export that (point 1). Worse: this
//      key answers "which INDEX", not "which repository" — and native git
//      routes ordinary commands through a temporary index. Measured inside a
//      real `pre-commit` hook (git 2.54.0.windows.1): `git commit` (already
//      staged) hands the hook `.git/index`, but `git commit -a` hands it
//      `<abs>/.git/index.lock` and `git commit -- <path>` hands it
//      `<abs>/.git/next-index-NNNNN.lock`. `scripts/verify-cache.mjs`'s
//      `stagedDiffFiles()` exists specifically to read the index the
//      in-flight commit is about — scrubbing this var doesn't prevent a
//      redirection, it manufactures a wrong answer (or an empty one, which
//      is worse: `verify-cache.mjs` treats null/error as "diff failed, run
//      everything," but an empty array is a normal answer that disables the
//      scope filter's per-leg checks — a silently-green commit gate having
//      verified nothing, for `git commit -a` and `git commit -- <path>`).
//      `GIT_INDEX_FILE` is deliberately left out of this list for exactly
//      that reason: a command whose job is to read the staged set must
//      honour whichever index git is actually using, not the one this repo
//      guesses at.
//
// Shared by both scripts so a git call added to either later inherits the
// fix automatically rather than growing its own copy of this list.
export const GIT_ENV_SCRUB_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
];

/** A copy of `process.env` with the repository-discovery-overriding GIT_*
 *  vars above removed, so a git call scoped to an explicit `cwd` can't be
 *  silently redirected by an inherited environment. Deliberately does NOT
 *  touch `GIT_INDEX_FILE` — see the key-list comment above.
 *
 *  Matched case-insensitively: `{ ...process.env }` snapshots whatever
 *  casing Windows happened to store a variable under (env lookup itself is
 *  case-insensitive there), so a `delete out[key]` keyed on the canonical
 *  uppercase name alone would leave a `git_dir`-cased survivor in `out` that
 *  git still honours — a no-op fix for exactly the case this function
 *  exists to close. */
export function scrubGitEnv(env = process.env) {
  const out = { ...env };
  const targets = new Set(GIT_ENV_SCRUB_KEYS);
  for (const key of Object.keys(out)) {
    if (targets.has(key.toUpperCase())) delete out[key];
  }
  return out;
}
