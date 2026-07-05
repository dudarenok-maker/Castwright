// Shared spawnSync-then-throw-on-failure wrapper for the wiki scripts
// (sync-wiki.mjs, generate-release-notes-wiki.mjs). Surfaces the real
// spawn error (e.g. `gh`/`git` missing from PATH) instead of swallowing it
// into an "undefined" stderr message.
import { spawnSync } from 'node:child_process';

export function runCommand(label, cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.error) {
    throw new Error(`${label}: ${cmd} ${args.join(' ')} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label}: ${cmd} ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}
