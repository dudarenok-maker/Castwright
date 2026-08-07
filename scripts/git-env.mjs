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
// #2216 correction: an ordinary git hook process does NOT export GIT_DIR —
// this file's own header used to claim it did ("e.g. every hook process git
// spawns"), which was wrong and, worse, actively misleading: it made the
// hook-resident call sites (verify-cache.mjs, guard-protected-push.mjs,
// guard-commit-subjects.mjs, is-docs-only-push.mjs) read as the highest-risk
// group when they weren't. The real #2169 exposure was an ambient shell
// export, not a hook. The one repo-discovery var a hook genuinely DOES
// export is GIT_INDEX_FILE — see the note on that key below.
//
// Shared by both scripts so a git call added to either later inherits the
// fix automatically rather than growing its own copy of this list.
export const GIT_ENV_SCRUB_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  // #2216: a git hook subprocess DOES export this one, as a path RELATIVE
  // to the hook's own cwd (typically `.git/index`). Any script that spawns
  // git from a cwd other than the repo root — e.g. verify-cache.mjs's
  // stagedDiffFiles(), which pins `cwd` explicitly — resolves that relative
  // path against the CHILD's cwd, not the repo root, so it silently reads a
  // path that doesn't exist. `git diff --cached` then reports an empty
  // staged set rather than erroring, so a caller that scope-filters test
  // legs off that set concludes nothing is staged and skips everything —
  // the commit gate still reports green. Scrubbing this is neutral-to-
  // protective for every site in scope today: git falls back to
  // `$GIT_DIR/index`, the same file, minus the relative-path hazard.
  // FUTURE HAZARD (accepted, not live today): if this repo ever adopts
  // lint-staged or any tool that stages via a temporary index, that tool
  // communicates it through exactly this variable — a scrubbed
  // `git diff --cached` would then read the real index instead of the
  // temp one. Not the case today (pre-commit runs
  // `npm run verify:fast:scoped` directly, no temporary index involved).
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
];

/** A copy of `process.env` with the repository-discovery-overriding GIT_*
 *  vars above removed, so a git call scoped to an explicit `cwd` can't be
 *  silently redirected by an inherited environment.
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
