// Shared spawnSync-then-throw-on-failure wrapper for the wiki scripts
// (sync-wiki.mjs, generate-release-notes-wiki.mjs). Surfaces the real
// spawn error (e.g. `gh`/`git` missing from PATH) instead of swallowing it
// into an "undefined" stderr message.
//
// Env is unconditionally scrubbed of the GIT_DIR-family vars (scrubGitEnv,
// #2169/#2184) — mirroring execGit (bump-version.mjs:221-223): a
// caller-supplied `env` REPLACES `process.env` outright and is then
// scrubbed, it is not merged onto `process.env`; omitting `env` scrubs
// `process.env` itself. sync-wiki.mjs pins several git calls to an explicit
// `cwd` (its .wiki-sync-cache clone); an inherited GIT_DIR overrides git's
// cwd-based repo discovery outright, so without this a maintainer shell
// with GIT_DIR exported could make those calls commit/push against the
// wrong repository while still exiting 0. `env` is spread last so it can't
// be overwritten by `...options`.
import { spawnSync } from 'node:child_process';
import { scrubGitEnv } from '../git-env.mjs';

export function runCommand(label, cmd, args, options = {}) {
  const { env, ...rest } = options;
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...rest, env: scrubGitEnv(env) });
  if (result.error) {
    throw new Error(`${label}: ${cmd} ${args.join(' ')} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label}: ${cmd} ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}
