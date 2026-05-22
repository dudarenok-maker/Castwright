#!/usr/bin/env node
// Bump root + server package.json versions in lockstep, regenerate both
// lockfiles, commit with the convention-compliant subject, and create the
// annotated tag. Cross-platform Node — replaces the PowerShell-only version
// of the original draft.
//
// Usage:
//   node scripts/bump-version.mjs --level patch|minor|major
//                                  [--notes-file <path>]
//                                  [--dry-run]
//                                  [--force]
//
// Exits non-zero on any pre-flight or sub-command failure. Intended to be
// run only from a clean working tree, on `main`, by a maintainer.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { level: null, notesFile: null, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--level') out.level = argv[++i];
    else if (a === '--notes-file') out.notesFile = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
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
      '[--notes-file <path>] [--dry-run] [--force]\n',
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

function semverBump(current, level) {
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
  die(
    `Working tree is not clean — commit or stash changes first.\n${status}`,
  );
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

info(`[PLAN] bump ${rootVersion} -> ${newVersion} (level=${args.level})`);
info(`[PLAN] commit subject: chore: bump version to ${newVersion}`);
info(`[PLAN] tag: ${newTag}${args.notesFile ? ` (annotation from ${args.notesFile})` : ' (placeholder annotation)'}`);

if (args.dryRun) {
  info('[DRY-RUN] No mutations made. Re-run without --dry-run to apply.');
  process.exit(0);
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
info(`[OK] Bump complete. Next steps:`);
info(`     1. git push origin main`);
info(`     2. git push origin ${newTag}`);
info(`     3. Watch .github/workflows/release.yml — the tag push triggers it.`);
if (!args.notesFile) {
  info('');
  info(
    `[NOTE] Tag annotation is a placeholder. To replace with real notes BEFORE pushing:`,
  );
  info(`       git tag -d ${newTag}`);
  info(`       git tag -a ${newTag} -F <path-to-notes.md>`);
}
process.exit(0);
