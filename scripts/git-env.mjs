#!/usr/bin/env node
// #2169 — git resolves the repository from these env vars BEFORE it falls
// back to discovery from `cwd`. Any script that pins a git invocation to a
// specific `cwd`/repoRoot (the pattern both bump-version.mjs and
// release-body.mjs use) is silently overridden whenever one of these is
// already set in the ambient environment — e.g. every hook process git
// spawns, or a shell where an earlier command exported one. The failure is
// invisible: the command still exits 0, just against the wrong repository.
//
// Shared by both scripts so a git call added to either later inherits the
// fix automatically rather than growing its own copy of this list.
export const GIT_ENV_SCRUB_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
];

/** A copy of `process.env` with the repository-discovery-overriding GIT_*
 *  vars above removed, so a git call scoped to an explicit `cwd` can't be
 *  silently redirected by an inherited environment. */
export function scrubGitEnv(env = process.env) {
  const out = { ...env };
  for (const key of GIT_ENV_SCRUB_KEYS) delete out[key];
  return out;
}
