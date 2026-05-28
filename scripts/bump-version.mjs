#!/usr/bin/env node
// Bump root + server package.json versions in lockstep, regenerate both
// lockfiles, gate on a green cross-OS verify run, commit with the
// convention-compliant subject, and create the annotated tag. Cross-platform
// Node — replaces the PowerShell-only version of the original draft.
//
// Usage:
//   node scripts/bump-version.mjs --level patch|minor|major
//                                  [--notes-file <path>]
//                                  [--dry-run]
//                                  [--force]
//                                  [--skip-cross-os]
//
// Cross-OS gate (plan 127): before the tag is created, the script fires the
// `cross-os.yml` workflow on origin/main (macOS + Windows verify/build + mobile
// e2e) and BLOCKS on it. If that run fails the tag is NOT created — fix main
// and re-run. `--skip-cross-os` bypasses the gate (emergency / no-`gh`
// environments) and reverts to the prior local-only prepare-then-push flow.
//
// Exits non-zero on any pre-flight, gate, or sub-command failure. Intended to
// be run only from a clean working tree, on `main`, by a maintainer.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// The workflow the release gate fires + blocks on (filename under
// .github/workflows/). `gh` accepts the filename as the workflow id.
const CROSS_OS_WORKFLOW = 'cross-os.yml';
// `gh workflow run` doesn't return the run id, so we poll `gh run list` until
// the dispatched run surfaces (matched by head SHA + a freshness window), then
// hand off to `gh run watch`.
const RUN_DISCOVERY_ATTEMPTS = 20;
const RUN_DISCOVERY_INTERVAL_MS = 3000;

function parseArgs(argv) {
  const out = {
    level: null,
    notesFile: null,
    dryRun: false,
    force: false,
    skipCrossOs: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--level') out.level = argv[++i];
    else if (a === '--notes-file') out.notesFile = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--skip-cross-os') out.skipCrossOs = true;
    else if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    } else {
      die(`Unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelpAndExit(code) {
  process.stdout.write(
    'Usage: node scripts/bump-version.mjs --level patch|minor|major ' +
      '[--notes-file <path>] [--dry-run] [--force] [--skip-cross-os]\n',
  );
  process.exit(code);
}

function die(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(1);
}

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

function readVersion(pkgPath) {
  const json = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (typeof json.version !== 'string') {
    die(`${pkgPath} has no version field.`);
  }
  return json.version;
}

export function semverBump(current, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) die(`Current version "${current}" is not strict semver MAJOR.MINOR.PATCH.`);
  let [, major, minor, patch] = m.map((v, i) => (i === 0 ? v : Number(v)));
  if (level === 'patch') patch += 1;
  else if (level === 'minor') {
    minor += 1;
    patch = 0;
  } else if (level === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else {
    die(`--level must be patch | minor | major (got "${level}")`);
  }
  return `${major}.${minor}.${patch}`;
}

// Pure: pick the run we just dispatched out of `gh run list --json
// databaseId,headSha,status,conclusion,event,createdAt`. Match the head SHA
// (the commit cross-OS is validating) + a `workflow_dispatch` event +
// a freshness window (createdAt at/after when we fired, minus a small
// clock-skew slack). Newest match wins. Returns the databaseId, or null when
// the run hasn't surfaced yet so the caller keeps polling.
export function pickWorkflowRun(runs, { headSha, sinceMs, skewMs = 10000 }) {
  if (!Array.isArray(runs)) return null;
  const matches = runs
    .filter((r) => {
      if (!r || r.headSha !== headSha || r.event !== 'workflow_dispatch') return false;
      const createdMs = new Date(r.createdAt).getTime();
      return Number.isFinite(createdMs) && createdMs >= sinceMs - skewMs;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return matches.length > 0 ? matches[0].databaseId : null;
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
}

function npm(args, opts = {}) {
  /* Node 20+ on Windows refuses to execFile .cmd / .bat directly (CVE-2024-27980
     mitigation). We have to opt into a real shell when invoking npm.cmd. The
     args still get quoted by Node since `shell: true` triggers cmd.exe
     interpolation — wrap each arg with backslash-escaped double quotes to
     defend against spaces (unlikely here, but safe). */
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    const quoted = args
      .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
      .join(' ');
    return execFileSync(`npm.cmd ${quoted}`, {
      cwd: opts.cwd ?? repoRoot,
      stdio: 'inherit',
      encoding: 'utf8',
      shell: true,
    });
  }
  return execFileSync('npm', args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: 'inherit',
    encoding: 'utf8',
  });
}

// `gh` wrapper. capture=true returns stdout; otherwise inherits stdio so
// `gh run watch`'s live progress streams to the user.
function gh(args, opts = {}) {
  return execFileSync('gh', args, {
    cwd: repoRoot,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
}

function ghAvailable() {
  const r = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fire cross-os.yml on `ref`, find the dispatched run, block on it. Dies (so
// the caller never reaches `git tag`) if the run concludes non-success.
async function runCrossOsGate({ ref, headSha }) {
  if (!ghAvailable()) {
    die(
      'The cross-OS gate needs the GitHub CLI (`gh`) authenticated, but `gh` was not found. ' +
        'Install it + `gh auth login`, or pass --skip-cross-os to bypass the gate.',
    );
  }
  const sinceMs = Date.now();
  info(`[GATE] firing ${CROSS_OS_WORKFLOW} on ${ref} — cross-OS verify must pass before the tag is created.`);
  try {
    gh(['workflow', 'run', CROSS_OS_WORKFLOW, '--ref', ref]);
  } catch {
    die(
      `Failed to dispatch ${CROSS_OS_WORKFLOW}. Confirm the workflow exists and you're authenticated (\`gh auth status\`), ` +
        'or pass --skip-cross-os.',
    );
  }

  let runId = null;
  for (let attempt = 1; attempt <= RUN_DISCOVERY_ATTEMPTS && runId === null; attempt++) {
    await sleep(RUN_DISCOVERY_INTERVAL_MS);
    let parsed = [];
    try {
      const json = gh(
        [
          'run',
          'list',
          '--workflow',
          CROSS_OS_WORKFLOW,
          '--limit',
          '20',
          '--json',
          'databaseId,headSha,status,conclusion,event,createdAt',
        ],
        { capture: true },
      );
      parsed = JSON.parse(json);
    } catch {
      parsed = []; // transient gh/network hiccup — retry
    }
    runId = pickWorkflowRun(parsed, { headSha, sinceMs });
    if (runId === null) {
      info(`[GATE] waiting for the dispatched run to surface (attempt ${attempt}/${RUN_DISCOVERY_ATTEMPTS})...`);
    }
  }
  if (runId === null) {
    die(
      `Dispatched ${CROSS_OS_WORKFLOW} but couldn't locate the run after ${RUN_DISCOVERY_ATTEMPTS} attempts. ` +
        `Check \`gh run list --workflow ${CROSS_OS_WORKFLOW}\`; once it's green, re-run bump-version.`,
    );
  }
  info(`[GATE] watching run ${runId} (blocks until macOS + Windows verify/build + mobile e2e finish)...`);
  const watch = spawnSync('gh', ['run', 'watch', String(runId), '--exit-status'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (watch.status !== 0) {
    die(
      `Cross-OS verify FAILED (run ${runId}). The tag was NOT created. ` +
        `Inspect: gh run view ${runId} --web — fix the failure on ${ref}, then re-run bump-version.`,
    );
  }
  info(`[GATE] cross-OS verify passed (run ${runId}).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.level) {
    printHelpAndExit(1);
  }
  if (args.notesFile && !existsSync(args.notesFile)) {
    die(`--notes-file does not exist: ${args.notesFile}`);
  }

  // Pre-flight 1: clean working tree (unless dry-run).
  const status = git(['status', '--porcelain'], { capture: true });
  if (status.trim().length > 0 && !args.dryRun) {
    die(`Working tree is not clean — commit or stash changes first.\n${status}`);
  }

  // Pre-flight 2: on main (unless --force).
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).trim();
  if (branch !== 'main' && !args.force) {
    die(
      `Not on main (current: ${branch}). Pass --force if you intentionally want to bump from a non-main branch.`,
    );
  }

  // Pre-flight 3: lockstep invariant.
  const rootPkg = resolve(repoRoot, 'package.json');
  const serverPkg = resolve(repoRoot, 'server', 'package.json');
  const rootVersion = readVersion(rootPkg);
  const serverVersion = readVersion(serverPkg);
  if (rootVersion !== serverVersion) {
    die(
      `Lockstep invariant violated: root=${rootVersion} server=${serverVersion}. ` +
        `Manually align them before running bump-version.`,
    );
  }

  const newVersion = semverBump(rootVersion, args.level);
  const newTag = `v${newVersion}`;

  // Pre-flight 4: target tag must not already exist (avoid re-releasing).
  const existingTag = git(['tag', '--list', newTag], { capture: true }).trim();
  if (existingTag.length > 0 && !args.dryRun) {
    die(`Tag ${newTag} already exists. A release for ${newVersion} was already cut; nothing to do.`);
  }

  const gateOn = !args.skipCrossOs;
  info(`[PLAN] bump ${rootVersion} -> ${newVersion} (level=${args.level})`);
  info(`[PLAN] commit subject: chore: bump version to ${newVersion}`);
  info(`[PLAN] tag: ${newTag}${args.notesFile ? ` (annotation from ${args.notesFile})` : ' (placeholder annotation)'}`);
  info(
    `[PLAN] cross-OS gate: ${
      gateOn
        ? `ON — fires ${CROSS_OS_WORKFLOW} on ${branch} and blocks before tagging`
        : 'OFF (--skip-cross-os)'
    }`,
  );

  if (args.dryRun) {
    info('[DRY-RUN] No mutations made. Re-run without --dry-run to apply.');
    process.exit(0);
  }

  // Cross-OS gate (plan 127): fire + block BEFORE any mutation, so a red
  // cross-OS run leaves the tree pristine and the tag uncreated. The gate
  // validates origin/<branch> (the commit your release is based on); the
  // version-bump commit it then creates changes only version strings + lockfile
  // version fields, never the dependency tree or source the matrix exercises —
  // and the exact tagged commit is still Ubuntu-verified by release.yml.
  if (gateOn) {
    let remoteSha = '';
    try {
      git(['fetch', 'origin', branch]);
      remoteSha = git(['rev-parse', `origin/${branch}`], { capture: true }).trim();
    } catch {
      die(`Couldn't resolve origin/${branch}. Ensure the remote exists, or pass --skip-cross-os.`);
    }
    const localSha = git(['rev-parse', 'HEAD'], { capture: true }).trim();
    if (localSha !== remoteSha) {
      die(
        `Local ${branch} (${localSha.slice(0, 8)}) is out of sync with origin/${branch} (${remoteSha.slice(0, 8)}). ` +
          `The cross-OS gate validates origin/${branch} — push/pull so they match, or pass --skip-cross-os.`,
      );
    }
    await runCrossOsGate({ ref: branch, headSha: localSha });
  } else {
    info(
      '[SKIP] cross-OS gate skipped (--skip-cross-os). Fire cross-os.yml manually before announcing the release.',
    );
  }

  // Mutate: root + server versions + both lockfiles.
  info('[STEP] npm version (root) ...');
  npm(['version', newVersion, '--no-git-tag-version']);
  info('[STEP] npm version (server) ...');
  npm(['version', newVersion, '--no-git-tag-version'], { cwd: resolve(repoRoot, 'server') });

  // Stage + commit.
  info('[STEP] git add + commit ...');
  git([
    'add',
    'package.json',
    'package-lock.json',
    'server/package.json',
    'server/package-lock.json',
  ]);
  git(['commit', '-m', `chore: bump version to ${newVersion}`]);

  // Annotated tag. `--cleanup=verbatim` is load-bearing: git's default
  // cleanup mode for both `-m` and `-F` strips lines starting with `#`
  // as commentary, which silently eats the `## Features` / `## Fixes` /
  // `## Engineering` section headers CONTRIBUTING.md "Release notes"
  // mandates. v1.4.0 shipped with stripped headers and had to be patched
  // in place; preserve them by default from here on.
  info('[STEP] git tag ...');
  if (args.notesFile) {
    git(['tag', '--cleanup=verbatim', '-a', newTag, '-F', resolve(args.notesFile)]);
  } else {
    git(['tag', '--cleanup=verbatim', '-a', newTag, '-m', `Audiobook generator ${newTag}`]);
  }

  info('');
  info(`[OK] Bump complete${gateOn ? ' (cross-OS verified)' : ''}. Next steps:`);
  info(`     1. git push origin ${branch}`);
  info(`     2. git push origin ${newTag}`);
  info(`     3. Watch .github/workflows/release.yml — the tag push triggers it.`);
  if (!args.notesFile) {
    info('');
    info(`[NOTE] Tag annotation is a placeholder. To replace with real notes BEFORE pushing:`);
    info(`       git tag -d ${newTag}`);
    info(`       git tag -a ${newTag} -F <path-to-notes.md>`);
  }
  process.exit(0);
}

// Guarded so tests can import the pure helpers (semverBump, pickWorkflowRun)
// without executing the release procedure (matches install-qwen3.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
