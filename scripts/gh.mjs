#!/usr/bin/env node
// Shared `gh` CLI chokepoint (#2184). `gh` resolves its target repository the
// same GIT_DIR/GIT_WORK_TREE-first way git itself does (empirically: with
// GIT_DIR pointed at a decoy, `gh repo view` reports "no git remotes found"
// instead of the real repo's remotes — bump-version.mjs's original gh()
// comment, #2175 review Finding 2). Before this file, 14 call sites across 12
// scripts each grew their own local `gh()`/`ghAvailable()` helper (or an
// inline execFileSync/spawnSync call), and NONE of them scrubbed the
// GIT_DIR-family env vars the way execGit's own `env: scrubGitEnv(options?.env)`
// (bump-version.mjs, the model this file copies) already does for `git` — so a
// maintainer shell with one of those vars exported from an earlier command
// (#2169's own scenario) could silently point `npm run backlog:sync` /
// `npm run quarantine:health` / etc. at the wrong repository while still
// exiting 0. This file is the single place that fix now lives; every other
// `gh`-calling script under scripts/ imports from here instead of growing
// its own copy. scripts/tests/gh-chokepoint.test.mjs asserts, mechanically,
// that no script outside this file ever calls the `gh` binary directly again.
//
// Two functions, not one — the call shapes across scripts/ genuinely don't
// collapse into a single signature:
//
//   - gh(args, opts)     — captured output via execFileSync. Default stdio
//     captures stdout (returned as a string, `encoding: 'utf8'`) and a
//     non-zero exit THROWS, matching execFileSync's normal contract and
//     every migrated script's previous local `gh()` helper. A caller that
//     wants live streaming instead of a capture (e.g. `gh workflow run`, a
//     one-shot dispatch a human is watching but whose failure should still
//     throw so a wrapping try/catch fires) can override `stdio` in opts.
//
//   - ghSpawn(args, opts) — spawnSync, for the shapes execFileSync can't
//     serve: a caller that must NOT throw on a non-zero exit because it
//     reads `status`/`error` itself (an availability probe, or `gh run
//     watch` whose failure is a normal, expected outcome the caller
//     branches on) — with or without `stdio: 'inherit'` to stream progress.
//
// Both apply scrubGitEnv() unconditionally to whatever `env` the caller
// passes — replacing `process.env` outright with that object and THEN
// stripping the GIT_*-family keys from it, not merging the two on top of
// `process.env`; an omitted `env` scrubs `process.env` itself (same
// replace-then-scrub contract execGit documents at
// bump-version.mjs:222-224) — and default `cwd` to `repoRoot`,
// so a caller that forgets `cwd` (five of the eleven scripts migrated onto
// this wrapper did) still resolves `gh` against THIS repository rather than
// wherever the process happened to be invoked from. A caller may still pass
// its own `cwd` to override that default (e.g. a script that legitimately
// needs to run `gh` against a *different* checkout).

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from './git-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..');

/** Captured `gh` invocation — execFileSync, `cwd` defaults to `repoRoot`,
 *  `encoding: 'utf8'`, `stdio: ['ignore', 'pipe', 'pipe']` by default (stderr
 *  captured, not printed — execFileSync inherits the parent's stderr when
 *  `stdio` is left unspecified, which would otherwise leak `gh`'s stderr to
 *  the console on every failure, including from inside a retry loop that
 *  deliberately swallows the error — #2203 review Finding F6). Pass
 *  `{ stdio: 'inherit' }` to stream output live instead of capturing it
 *  (still throws on failure — use ghSpawn if the caller needs to inspect the
 *  result instead). `env` unconditionally scrubbed: an `opts.env` REPLACES
 *  `process.env` and is then scrubbed, it is not merged onto it; omit
 *  `opts.env` to scrub `process.env` itself. Throws on a non-zero exit, same
 *  as a bare execFileSync call. */
export function gh(args, opts = {}) {
  const { env, ...rest } = opts;
  return execFileSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...rest,
    env: scrubGitEnv(env),
  });
}

/** `gh` via spawnSync — same `cwd`/env-scrub defaults as gh(), for a caller
 *  that reads the result object itself (`status`/`error`) instead of relying
 *  on throw-on-failure: an availability probe (`stdio: 'ignore'`) or a
 *  long-running call whose live progress should stream to the user
 *  (`stdio: 'inherit'`) and whose non-zero exit is an expected outcome to
 *  branch on, not an exception to catch. */
export function ghSpawn(args, opts = {}) {
  const { env, ...rest } = opts;
  return spawnSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    ...rest,
    env: scrubGitEnv(env),
  });
}
