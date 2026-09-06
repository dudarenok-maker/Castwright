#!/usr/bin/env node
// Spawn a fresh git worktree on a new branch with non-colliding dev-server
// ports, so multiple Claude Code sessions can run in parallel against this
// repo without fighting over :5173 / :8080 / :9000 / :5174.
//
// Usage:
//   node scripts/wt-new.mjs <type>/<scope>-<slug> [--from <base-branch>] [--no-install]
//
// Example:
//   node scripts/wt-new.mjs feat/server-batch-retry
//   node scripts/wt-new.mjs fix/frontend-toolbar --from main
//   node scripts/wt-new.mjs chore/frontend-tidy --no-install
//
// What it does:
//   1. Validates the branch name (CONTRIBUTING.md "Branch naming").
//   2. Picks the lowest port-offset slot not already claimed by a live
//      worktree's generated .env.local / server/.env (slot 0 = main). #3052:
//      NOT the worktree count — that re-issued a surviving tree's slot as
//      soon as an earlier tree was torn down.
//   3. Creates ../wt-<slug> via `git worktree add -b <branch> <path> <base>`.
//   4. Writes <worktree>/.env.local with VITE_PORT / PORT / VITE_API_PORT /
//      LOCAL_TTS_PORT / PLAYWRIGHT_PORT for this slot.
//   5. Writes <worktree>/server/.env with PORT / WORKSPACE_DIR / LOCAL_TTS_PORT for this slot
//      — an ISOLATED workspace of its own, never the primary checkout's (two
//      servers on two branches can't safely share one cast.json/state.json).
//      LOCAL_TTS_PORT per-worktree isolation prevents sidecar port conflicts (#2632).
//      Nothing is copied from the primary checkout's server/.env, so secrets
//      (e.g. GEMINI_API_KEY) never leak into a worktree (#2345).
//   6. Runs `npm install` (root, which also activates husky hooks via the
//      `prepare` script) + `npm install --prefix server` inside the worktree
//      so it's ready for `npm run dev` / `npm run verify` immediately. Pass
//      `--no-install` to skip both — falls back to printing the commands.
//   7. Prints a copy-pasteable launch block.
//
// See CONTRIBUTING.md "Running multiple Claude Code conversations" for the
// scope-discipline + GPU-coordination caveats.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseBranchName } from './lib/branch-name.mjs';
import { scrubGitEnv } from './git-env.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { parseWorktreePorcelain } from './wt-list.mjs';
import { extractSlotFromEnvLocal, readSlotClaims, SLOT_CLAIM_FILES } from './lib/worktree-slot.mjs';

const BASE_PORTS = {
  VITE_PORT: 5173,
  PORT: 8080,
  VITE_API_PORT: 8080, // matches PORT — both point at the same server
  LOCAL_TTS_PORT: 9000,
  PLAYWRIGHT_PORT: 5174,
};
const PORT_STEP = 10;

function usage(extra) {
  const lines = [
    'Usage: node scripts/wt-new.mjs <type>/<scope>-<slug> [--from <base-branch>]',
    '',
    'Example:',
    '  node scripts/wt-new.mjs feat/server-batch-retry',
    '  node scripts/wt-new.mjs fix/frontend-toolbar --from main',
    '',
    'See CONTRIBUTING.md "Branch naming" for the type+scope vocabulary.',
  ];
  if (extra) lines.unshift(`Error: ${extra}`, '');
  return lines.join('\n');
}

export function parseArgs(argv) {
  const args = { branch: null, from: 'main', install: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') {
      args.from = argv[++i];
      if (!args.from) throw new Error('--from requires a value');
    } else if (a === '--no-install') {
      args.install = false;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else if (!args.branch) {
      args.branch = a;
    } else {
      throw new Error(`unexpected positional argument: ${a}`);
    }
  }
  return args;
}

function gitOrThrow(args, opts = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, ...opts, env: scrubGitEnv(opts.env) });
  if (result.error) throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// Re-exported so existing importers keep their entry point; the reader itself
// lives in scripts/lib/worktree-slot.mjs so wt-list.mjs can share it without
// closing an import cycle with this file. See that module for why the scan
// covers the whole leading comment block rather than only line 1, and why it
// reads server/.env as well as .env.local.
export { extractSlotFromEnvLocal, SLOT_CLAIM_FILES };

// Absolute paths of every git worktree attached to this repo, primary checkout
// included. Split out from findClaimedSlots() so that function's filesystem
// reads can be exercised against a fixture directory without a real repo.
export function listWorktreePaths() {
  const porcelain = gitOrThrow(['worktree', 'list', '--porcelain']);
  return parseWorktreePorcelain(porcelain).map((tree) => tree.path);
}

// Scan the given worktrees and collect the slots their generated env files
// claim, reading every file in SLOT_CLAIM_FILES and unioning the result.
//
// Returns { slots, scanned, silent }:
//   slots   — ascending, de-duplicated slot numbers.
//   scanned — how many worktrees were looked at.
//   silent  — how many of those HAVE a generated env file but yielded no
//             slot from any of them. That is a detection failure, not a free
//             slot, and main() prints it: without the count, "nothing is
//             claimed" and "the scan found nothing it could read" produce the
//             same output, so a total failure looks exactly like an empty
//             fleet and allocation happily re-issues a live slot.
//
// A worktree with NO generated env file at all claims nothing and does not
// count as silent — that is the expected, benign shape for a tree made by
// EnterWorktree or Agent isolation: "worktree", neither of which writes one.
// Such trees cannot be detected at all; that limit is unchanged here.
//
// `worktreePaths` defaults to the live worktree list; pass an explicit array
// to point the scan at a fixture directory.
export function collectSlotClaims(worktreePaths = listWorktreePaths()) {
  const claimed = new Set();
  let scanned = 0;
  let silent = 0;

  for (const treePath of worktreePaths) {
    scanned++;
    const { slots, present } = readSlotClaims(treePath);
    for (const slot of slots) claimed.add(slot);
    if (present > 0 && slots.length === 0) silent++;
  }

  return { slots: Array.from(claimed).sort((a, b) => a - b), scanned, silent };
}

// The slot list alone — the shape allocateNextSlot() consumes.
export function findClaimedSlots(worktreePaths = listWorktreePaths()) {
  return collectSlotClaims(worktreePaths).slots;
}

// Allocate the lowest slot not already claimed, starting from 1.
// Slot 0 is reserved for the primary checkout (main branch).
// Returns the first free slot.
//
// `claimed` must be ascending and de-duplicated — the shape findClaimedSlots()
// returns, which is also the default. Pass an explicit array to test the
// allocation core without touching git or the filesystem.
export function allocateNextSlot(claimed = findClaimedSlots()) {
  let slot = 1;
  for (const c of claimed) {
    if (c === slot) {
      slot++;
    } else if (c > slot) {
      // Gap found — use the lowest free slot.
      return slot;
    }
  }
  return slot;
}

export function computePorts(slot) {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`slot must be a non-negative integer, got ${slot}`);
  }
  const out = {};
  for (const [key, base] of Object.entries(BASE_PORTS)) {
    out[key] = base + slot * PORT_STEP;
  }
  return out;
}

export function renderEnvLocal({ slot, branch, ports }) {
  const lines = [
    `# Generated by scripts/wt-new.mjs — worktree slot ${slot} (branch ${branch}).`,
    `# Per-worktree port assignments so multiple parallel Claude Code sessions`,
    `# can run \`npm run dev\` / \`npm run test:e2e\` without colliding on ports.`,
    `# These values are read by Vite (VITE_PORT, VITE_API_PORT) and Playwright`,
    `# (PLAYWRIGHT_PORT). LOCAL_TTS_PORT is NOT read from here; it's in server/.env.`,
    `# Safe to edit; safe to delete (defaults from vite.config.ts / sidecar apply).`,
    ``,
  ];
  for (const [key, value] of Object.entries(ports)) {
    lines.push(`${key}=${value}`);
  }
  lines.push('');
  return lines.join('\n');
}

// server/src/workspace/paths.ts resolves WORKSPACE_DIR relative to server/
// (where its own .env lives) when the value isn't already absolute — see
// that file's ~line 19-38. '../castwright-workspace' therefore lands at
// <worktree>/castwright-workspace, a sibling of server/ INSIDE this
// worktree, matching the primary checkout's own layout. Written explicitly
// here (rather than left to paths.ts's built-in default, which happens to
// be this same value today) so a worktree's isolation is pinned in the
// generated file itself and doesn't silently drift if that default ever
// changes.
const WORKSPACE_DIR_RELATIVE = '../castwright-workspace';

export function renderServerEnv({ slot, branch, ports }) {
  const lines = [
    `# Generated by scripts/wt-new.mjs — worktree slot ${slot} (branch ${branch}).`,
    `# Per-worktree server config: this worktree's server binds its OWN HTTP`,
    `# port and reads/writes its OWN workspace, so it never collides with —`,
    `# or corrupts — another worktree's (or the primary checkout's) server.`,
    `#`,
    `# ISOLATED, not inherited: two servers on two branches can't safely`,
    `# mutate the same cast.json/state.json (the cast-lock discipline is`,
    `# per-process-tree, no cross-checkout channel) — so WORKSPACE_DIR below`,
    `# points at a workspace under THIS worktree, never the primary`,
    `# checkout's. Nothing is copied from the primary checkout's server/.env:`,
    `# no GEMINI_API_KEY, no secrets, nothing.`,
    `#`,
    `# TTS sidecar isolation (#2632): LOCAL_TTS_PORT is read by spawn-sidecar.ts`,
    `# to probe on the per-worktree port, and by getResolvedSidecarUrl() to derive`,
    `# the default URL when no explicit LOCAL_TTS_URL or user sidecarUrl is set.`,
    `# Both server and sidecar read this same variable, so they coordinate on the`,
    `# same port and never adopt each other across worktrees.`,
    `#`,
    `# Safe to edit; safe to delete (server/src/load-env.ts tolerates a`,
    `# missing .env, warns, and falls back to its own defaults).`,
    ``,
    `PORT=${ports.PORT}`,
    `WORKSPACE_DIR=${WORKSPACE_DIR_RELATIVE}`,
    `LOCAL_TTS_PORT=${ports.LOCAL_TTS_PORT}`,
    ``,
  ];
  return lines.join('\n');
}

function branchExists(branch) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    encoding: 'utf8',
    windowsHide: true,
    env: scrubGitEnv(),
  });
  return result.status === 0;
}

function repoRoot() {
  return gitOrThrow(['rev-parse', '--show-toplevel']).trim();
}

export function buildInstallCommands(worktreePath) {
  const cmds = [
    { label: 'root', args: ['install'], cwd: worktreePath },
  ];
  if (existsSync(join(worktreePath, 'server', 'package.json'))) {
    cmds.push({ label: 'server', args: ['install', '--prefix', 'server'], cwd: worktreePath });
  }
  return cmds;
}

function runInstalls(worktreePath) {
  const cmds = buildInstallCommands(worktreePath);
  for (const { label, args, cwd } of cmds) {
    process.stdout.write(`[wt-new] ${label} install: npm ${args.join(' ')} (in ${cwd})\n`);
    const result = spawnSync('npm', args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    if (result.error) {
      throw new Error(`npm ${label} install failed to spawn: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`npm ${label} install exited ${result.status}`);
    }
  }
}

export function renderLaunchBlock({ worktreePath, branch, ports, slot, install }) {
  const winPath = worktreePath.replace(/\//g, '\\');
  const lines = [
    ``,
    `[wt-new] slot ${slot} → ports VITE=${ports.VITE_PORT} API=${ports.PORT} TTS=${ports.LOCAL_TTS_PORT} E2E=${ports.PLAYWRIGHT_PORT}`,
    `[wt-new] worktree created at ${worktreePath}`,
    `[wt-new] branch ${branch} (from ${branch === 'main' ? 'HEAD' : 'requested base'})`,
    ``,
    `Next steps — paste into a new terminal:`,
    ``,
    `  cd "${winPath}"`,
    `  # Doing real sidecar/TTS work? Junction server/tts-sidecar/.venv AND server/tts-sidecar/voices/ from`,
    `  # the primary checkout first — see CLAUDE.md "Worktree setup" step 2. Missing voices/ causes`,
    `  # Kokoro model errors that trigger recycle-storm; check logs/tts.err.log if #399 looks like it.`,
  ];
  if (install === false) {
    lines.push(`  npm install                  # root deps + husky hooks (skipped: --no-install)`);
    lines.push(`  npm install --prefix server  # server-side deps (skipped: --no-install)`);
  }
  lines.push(`  npm run dev        # frontend :${ports.VITE_PORT}, server :${ports.PORT}`);
  lines.push(`  # in another tab:`);
  lines.push(`  claude             # launch a parallel Claude Code session here`);
  lines.push(``);
  return lines.join('\n');
}

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(usage(err.message) + '\n');
    return 2;
  }
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (!args.branch) {
    process.stderr.write(usage('missing branch name') + '\n');
    return 2;
  }

  const parsed = parseBranchName(args.branch);
  if (!parsed.ok) {
    process.stderr.write(usage(`invalid branch name "${args.branch}": ${parsed.reason}`) + '\n');
    return 2;
  }

  if (branchExists(args.branch)) {
    process.stderr.write(`Error: branch ${args.branch} already exists. Pick a different slug or delete it first.\n`);
    return 1;
  }

  const root = repoRoot();
  const worktreePath = resolve(root, '..', `wt-${parsed.slug}`);
  if (existsSync(worktreePath)) {
    process.stderr.write(`Error: ${worktreePath} already exists. Remove it (or choose a different slug) first.\n`);
    return 1;
  }

  // Allocate the lowest slot not already claimed by reading slot markers
  // from existing worktrees' generated env files. This avoids collision when
  // worktrees are torn down and recreated (#3052).
  //
  // TOCTOU, deliberately not closed: the claim is only written once the
  // worktree exists (`git worktree add` below takes seconds), so two
  // concurrent wt-new.mjs runs can both allocate before either writes its
  // .env.local and both land on the same slot. The old count-based rule
  // raced identically, so this is not a regression, and a lock here would be
  // machine-wide state for a command a human runs by hand a few times a day.
  // If two lanes are spawned in the same breath, check `node
  // scripts/wt-list.mjs` for a duplicated slot afterwards.
  const claims = collectSlotClaims();
  const slot = allocateNextSlot(claims.slots);
  const ports = computePorts(slot);

  // Say what the scan actually saw. A silent skip is otherwise invisible:
  // see collectSlotClaims' own comment.
  process.stdout.write(
    `[wt-new] scanned ${claims.scanned} worktree(s); slots claimed: ${claims.slots.join(', ') || '(none)'}\n`,
  );
  if (claims.silent > 0) {
    process.stderr.write(
      `[wt-new] WARNING: ${claims.silent} worktree(s) have a generated ${SLOT_CLAIM_FILES.join(' / ')} ` +
        `but no readable slot marker — their slots are NOT protected and may be re-issued.\n`,
    );
  }

  process.stdout.write(`[wt-new] creating worktree at ${worktreePath} on new branch ${args.branch}\n`);
  gitOrThrow(['worktree', 'add', '-b', args.branch, worktreePath, args.from]);

  const envPath = join(worktreePath, '.env.local');
  writeFileSync(envPath, renderEnvLocal({ slot, branch: args.branch, ports }), 'utf8');
  process.stdout.write(`[wt-new] wrote ${envPath}\n`);

  // Mirrors buildInstallCommands' own check below — only worktrees that
  // actually carry a server/ (every real Castwright checkout does) get a
  // generated server/.env.
  if (existsSync(join(worktreePath, 'server', 'package.json'))) {
    const serverEnvPath = join(worktreePath, 'server', '.env');
    writeFileSync(serverEnvPath, renderServerEnv({ slot, branch: args.branch, ports }), 'utf8');
    process.stdout.write(`[wt-new] wrote ${serverEnvPath}\n`);
  }

  if (args.install) {
    try {
      runInstalls(worktreePath);
    } catch (err) {
      process.stderr.write(`[wt-new] install step failed: ${err.message}\n`);
      process.stderr.write(`[wt-new] worktree at ${worktreePath} is created but deps are NOT installed.\n`);
      process.stderr.write(`[wt-new] resume manually: cd "${worktreePath}" && npm install && npm install --prefix server\n`);
      return 1;
    }
  } else {
    process.stdout.write(`[wt-new] --no-install: skipping npm install steps\n`);
  }

  process.stdout.write(
    renderLaunchBlock({ worktreePath, branch: args.branch, ports, slot, install: args.install }),
  );
  return 0;
}

// CLI entry — only runs when invoked directly, not when imported by tests.
//
// process.exit() truncates pending async stdout writes on POSIX pipes
// (synchronous on Windows, ASYNCHRONOUS on Linux/macOS) — see the comment by
// scripts/lib/is-main-module.mjs's own isDirectlyInvoked for why that shape
// is unsafe for anything but provably-tiny output. main() prints the
// worktree-creation log, the npm-install output (stdio: 'inherit', so
// unaffected either way), and the multi-line launch block, so it doesn't
// qualify; setting exitCode and letting the process exit naturally once the
// event loop drains avoids the truncation instead. main() is `async` only in
// signature — every git/npm call inside it is spawnSync — so nothing keeps
// the event loop alive once its promise settles.
if (isDirectlyInvoked(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
