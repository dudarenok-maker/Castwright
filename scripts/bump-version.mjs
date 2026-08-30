#!/usr/bin/env node
// Bump root + server package.json versions in lockstep, regenerate both
// lockfiles, gate on a green cross-OS verify run, commit with the
// convention-compliant subject, and create the annotated tag. Cross-platform
// Node — replaces the PowerShell-only version of the original draft.
//
// Usage:
//   node scripts/bump-version.mjs --level patch|minor|major
//                                  [--notes-file <path>]
//                                  [--allow-notes-divergence]
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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkReleaseNotes,
  checkMojibake,
  checkConflictMarkers,
  checkBOM,
  stripBOM,
  formatHonouredEcho,
} from './release-notes-gate.mjs';
import { scrubGitEnv } from './git-env.mjs';
import { gh, ghSpawn } from './gh.mjs';
// #2170 — same normaliser release.yml's publish step applies, imported
// rather than copied so the two can't drift apart (see the refusal below).
import { normalise } from './release-body.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

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
    allowPlaceholder: false,
    allowNotesDivergence: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--level') out.level = argv[++i];
    else if (a === '--notes-file') out.notesFile = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--skip-cross-os') out.skipCrossOs = true;
    else if (a === '--allow-placeholder') out.allowPlaceholder = true;
    else if (a === '--allow-notes-divergence') out.allowNotesDivergence = true;
    else if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    } else {
      die(`Unknown argument: ${a}`);
    }
  }
  return out;
}

// process.exit() truncates pending async stdout writes on POSIX pipes (sync
// on Windows, async on Linux/macOS — see build-release-zip.mjs's fix for
// #2297/the same defect class). This function and die() throw a CliError
// carrying the intended exit code instead of exiting directly, so the
// process only ever exits naturally once the event loop drains; see the
// entry guard at the bottom of this file for the single catch.
class CliError extends Error {
  constructor(msg, code = 1) {
    super(msg);
    this.code = code;
  }
}

function printHelpAndExit(code) {
  process.stdout.write(
    'Usage: node scripts/bump-version.mjs --level patch|minor|major ' +
      '[--notes-file <path>] [--allow-placeholder] [--allow-notes-divergence] ' +
      '[--dry-run] [--force] [--skip-cross-os]\n' +
      '\n' +
      `  --allow-notes-divergence  Cut anyway when --notes-file disagrees with ` +
      `${DEFAULT_NOTES_FILE} — the publish job WILL FAIL unless you reconcile ` +
      'the two before pushing the tag.\n',
  );
  throw new CliError('help', code);
}

function die(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  throw new CliError(msg, 1);
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

/* fs-1 — the sidecar carries its version in server/tts-sidecar/version.py
   (__version__ = "x.y.z"), kept in lockstep with the two package.jsons so
   /health and GET /api/info report the same number. */
export const SIDECAR_VERSION_RE = /^(__version__\s*=\s*)["']([^"']*)["']/m;

export function sidecarVersionPath(repoRootDir) {
  return resolve(repoRootDir, 'server', 'tts-sidecar', 'version.py');
}

export function readSidecarVersion(repoRootDir) {
  const p = sidecarVersionPath(repoRootDir);
  if (!existsSync(p)) return null;
  const m = SIDECAR_VERSION_RE.exec(readFileSync(p, 'utf8'));
  return m ? m[2] : null;
}

export function writeSidecarVersion(repoRootDir, version) {
  const p = sidecarVersionPath(repoRootDir);
  const content = readFileSync(p, 'utf8');
  writeFileSync(p, content.replace(SIDECAR_VERSION_RE, `$1"${version}"`), 'utf8');
}

/* plan 188 — the Flutter companion (apps/android/pubspec.yaml) carries
   `version: X.Y.Z+BUILD`. Kept in lockstep with the package.jsons so the
   installable APK / iOS build reports the same marketing version; the build
   number is derived monotonically from the semver so store uploads never
   regress. */
export const PUBSPEC_VERSION_RE = /^(version:\s*)(\S+)/m;

export function pubspecPath(repoRootDir) {
  return resolve(repoRootDir, 'apps', 'android', 'pubspec.yaml');
}

/** The marketing X.Y.Z (drops the `+BUILD`), or null if the file is absent. */
export function readPubspecVersion(repoRootDir) {
  const p = pubspecPath(repoRootDir);
  if (!existsSync(p)) return null;
  const m = PUBSPEC_VERSION_RE.exec(readFileSync(p, 'utf8'));
  return m ? m[2].split('+')[0] : null;
}

/** Deterministic, monotonic versionCode base from a semver. The semver maps to
 *  `M*10000 + m*100 + p`, then `×1000` to reserve the low three digits as a
 *  build-ITERATION band. The tagged release takes the base (iteration 0); a
 *  successive Play upload of the *same* marketing version (e.g. an internal-test
 *  build) takes `base + 1`, `base + 2`, … — distinct, strictly-increasing
 *  versionCodes that never collide with the next patch's base. Play forbids
 *  reusing a versionCode, so this is what lets you iterate test builds without a
 *  marketing bump. 1.6.0 → 10600000; 1.6.1 → 10601000 (999 iteration slots). */
export function pubspecBuildNumber(version) {
  const [maj, min, pat] = version.split('.').map((n) => parseInt(n, 10) || 0);
  return (maj * 10000 + min * 100 + pat) * 1000;
}

export function writePubspecVersion(repoRootDir, version) {
  const p = pubspecPath(repoRootDir);
  const content = readFileSync(p, 'utf8');
  const next = `${version}+${pubspecBuildNumber(version)}`;
  writeFileSync(p, content.replace(PUBSPEC_VERSION_RE, `$1${next}`), 'utf8');
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

// #2169 — every git invocation in this script routes through here so the
// env scrub (dropping an inherited GIT_DIR / GIT_WORK_TREE / etc. that would
// otherwise silently override `cwd`) can't be forgotten by a call site that
// builds its own execFileSync options. createAnnotatedTag below is the one
// call site that needs different stdio/input, so it calls this directly
// rather than growing a second copy of the scrub. `options?.env` is merged
// INTO the scrub rather than replaced by it (PR #2175 review) — a caller
// that needs to pass its own env (none does today) still gets the scrub
// applied to what it passed, not silently overridden by an unrelated
// `scrubGitEnv()` of `process.env`; that's what "a git call added later
// inherits the fix" actually requires. Exported (like buildTagMessage /
// createAnnotatedTag below) as a thin, directly-testable seam.
export function execGit(args, options) {
  return execFileSync('git', args, { windowsHide: true, ...options, env: scrubGitEnv(options?.env) });
}

function git(args, opts = {}) {
  return execGit(args, {
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
      .map((a) => (/[\s\u0022]/.test(a) ? `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : a))
      .join(' ');
    return execFileSync(`npm.cmd ${quoted}`, {
      cwd: opts.cwd ?? repoRoot,
      stdio: 'inherit',
      encoding: 'utf8',
      shell: true,
      windowsHide: true,
    });
  }
  return execFileSync('npm', args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: 'inherit',
    encoding: 'utf8',
    windowsHide: true,
  });
}

// gh()/ghSpawn() (scripts/gh.mjs, #2184) are the shared chokepoint every
// gh-calling script under scripts/ now imports instead of growing its own
// copy of this scrub — see that file's header for the full rationale.
function ghAvailable() {
  const r = ghSpawn(['--version'], { stdio: 'ignore' });
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
    gh(['workflow', 'run', CROSS_OS_WORKFLOW, '--ref', ref], { stdio: 'inherit' });
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
      const json = gh([
        'run',
        'list',
        '--workflow',
        CROSS_OS_WORKFLOW,
        '--limit',
        '20',
        '--json',
        'databaseId,headSha,status,conclusion,event,createdAt',
      ]);
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
  const watch = ghSpawn(['run', 'watch', String(runId), '--exit-status'], { stdio: 'inherit' });
  if (watch.status !== 0) {
    die(
      `Cross-OS verify FAILED (run ${runId}). The tag was NOT created. ` +
        `Inspect: gh run view ${runId} --web — fix the failure on ${ref}, then re-run bump-version.`,
    );
  }
  info(`[GATE] cross-OS verify passed (run ${runId}).`);
}

// Best-effort: refresh the code-stats block in brand/project-narrative.md so
// every release carries fresh SLOC numbers. Deliberately NON-fatal — a release
// must never hard-fail on a docs-cosmetic tool. Skips cleanly when
// scripts/code-stats.mjs is absent (e.g. the throwaway test fixture repo) or
// when tokei isn't installed (code-stats.mjs exits non-zero, which we swallow).
function refreshCodeStats() {
  const codeStats = resolve(repoRoot, 'scripts', 'code-stats.mjs');
  if (!existsSync(codeStats)) {
    info('[SKIP] code-stats: scripts/code-stats.mjs not found — narrative stats not refreshed.');
    return;
  }
  try {
    info('[STEP] refreshing code stats (brand/project-narrative.md) ...');
    execFileSync('node', [codeStats, '--write'], { cwd: repoRoot, stdio: 'inherit', windowsHide: true });
  } catch {
    info(
      '[SKIP] code-stats refresh failed (tokei not installed?). Continuing — install tokei ' +
        '(`winget install XAMPPRocky.tokei` / `brew install tokei`) to keep the stats current.',
    );
  }
}

// The canonical in-repo technical release notes (the GitHub release body).
// Defaulting to this means the tag annotation is never a silent placeholder —
// the v1.8.0 cut shipped an empty body because --notes-file was omitted.
export const DEFAULT_NOTES_FILE = 'docs/release-notes-next.md';

/** Which notes file to use: an explicit --notes-file wins; otherwise the
 *  canonical in-repo file when it exists; otherwise null (placeholder
 *  territory, which main() refuses unless --allow-placeholder). */
export function resolveNotesFile(explicit, fileExists) {
  if (explicit) return explicit;
  if (fileExists(DEFAULT_NOTES_FILE)) return DEFAULT_NOTES_FILE;
  return null;
}

/** The stale version string if the notes file declares a
 *  `release-notes-next-version: X.Y.Z` marker that doesn't match `version`,
 *  else null. No marker → null (can't verify, so don't block). Reading an
 *  explicit marker (not the first version token) avoids false positives from
 *  the `vA.B.C...vX.Y.Z` changelog footer. */
export function staleNotesVersion(notesText, version) {
  const m = /release-notes-next-version:\s*v?(\d+\.\d+\.\d+)/i.exec(notesText ?? '');
  return m && m[1] !== version ? m[1] : null;
}

/** The exact text handed to `git tag -F -` as the annotated-tag message
 *  (#2114). A thin, independently-testable seam around the BOM strip: even
 *  though pre-flight 6c above already refuses to reach the tag step with a
 *  BOM-prefixed --notes-file, this function is what actually decides the
 *  bytes git receives, so it strips defensively rather than trusting the
 *  pre-flight alone — a future reordering, or a call site that skips the
 *  pre-flight, still can't make it through here with a BOM intact. */
export function buildTagMessage(fileText) {
  return stripBOM(fileText);
}

/** Creates the annotated release tag from `notesFile`'s content (#2114). A
 *  thin, directly-callable seam separated out from main() specifically so a
 *  test can call it without going through the CLI's pre-flights: pre-flight
 *  6c already refuses to reach this point with a BOM-prefixed --notes-file,
 *  so an end-to-end run can never legitimately drive a BOM through this call
 *  — calling it directly is what lets a test pin the belt-and-suspenders
 *  guarantee below independent of that pre-flight.
 *
 *  Reads `notesFile` in Node and pipes the result of `buildTagMessage`
 *  (which strips a defensive BOM) to `git tag -F -` (stdin) rather than
 *  `-F <path>`, which would hand git the raw, unstripped bytes — so a future
 *  change to (or bypass of) the pre-flight still can't let a BOM through
 *  here. `--cleanup=verbatim` is separately load-bearing: git's default
 *  cleanup mode for both `-m` and `-F` strips lines starting with `#` as
 *  commentary, which would silently eat the `## Features` / `## Fixes` /
 *  `## Engineering` section headers CONTRIBUTING.md "Release notes"
 *  mandates — v1.4.0 shipped with stripped headers and had to be patched in
 *  place; preserve them by default from here on. */
export function createAnnotatedTag({ repoRoot, newTag, notesFile }) {
  const tagMessage = buildTagMessage(readFileSync(resolve(notesFile), 'utf8'));
  execGit(['tag', '--cleanup=verbatim', '-a', newTag, '-F', '-'], {
    cwd: repoRoot,
    input: tagMessage,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf8',
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.level) {
    printHelpAndExit(1);
  }
  if (args.notesFile && !existsSync(args.notesFile)) {
    die(`--notes-file does not exist: ${args.notesFile}`);
  }
  // Default to the canonical in-repo notes so a release can't ship a silent
  // placeholder body (the refusal is enforced after the cheap pre-flights).
  args.notesFile = resolveNotesFile(args.notesFile, existsSync);

  // #2170 (decided 2026-08-06, superseding the #2168-review heads-up below) —
  // release.yml's release-body.mjs sources the PUBLISHED GitHub release body
  // from DEFAULT_NOTES_FILE only — never from whatever --notes-file supplied
  // the tag annotation. Before #2168 a non-default --notes-file published
  // fine; now a genuine divergence guarantees resolveReleaseBody's Rule 4
  // fails the tag at PUBLISH time — after verify, cross-os-verify, mobile-e2e
  // and companion-apk-build have all run, and with the tag already pushed.
  // Refuse here, before any of the expensive pre-flights below, comparing
  // under the SAME normaliser release-body.mjs applies at publish time
  // (imported, not copied — two normalisers that drift apart reintroduce
  // exactly the failure this closes) so the refusal fires if and only if the
  // publish job actually would fail. --allow-notes-divergence opts into the
  // deliberate case. Fires only when there's an actual divergence hazard: an
  // explicit, non-default notesFile AND a DEFAULT_NOTES_FILE that exists to
  // disagree with it (resolveNotesFile only returns something other than
  // DEFAULT_NOTES_FILE when an explicit path was given, or when the default
  // is absent — the latter can't trip this, since the "exists" check below
  // is then false).
  // #2175 review, Finding 3 — DEFAULT_NOTES_FILE is a path WITHIN THE REPO
  // (same as release-body.mjs's own `resolve(repoRoot, DEFAULT_NOTES_FILE)`
  // at publish time), so both the existence check and the read below must
  // resolve it against `repoRoot`, not the invocation `process.cwd()`. Run
  // from a subdirectory (e.g. `cd server && node ../scripts/bump-version.mjs
  // … --notes-file <path>`) and the bare-relative `existsSync(DEFAULT_NOTES_FILE)`
  // would find nothing, silently skipping this whole guard rather than
  // refusing — the exact outcome #2170 exists to prevent. `args.notesFile`
  // itself is intentionally left resolved against the invocation cwd (see
  // the `--notes-file does not exist` pre-flight above, which does the same)
  // — an operator's notes file legitimately lives wherever they're standing.
  if (args.notesFile !== DEFAULT_NOTES_FILE && existsSync(resolve(repoRoot, DEFAULT_NOTES_FILE))) {
    const explicitText = readFileSync(resolve(args.notesFile), 'utf8');
    const defaultText = readFileSync(resolve(repoRoot, DEFAULT_NOTES_FILE), 'utf8');
    // Finding 5 — the tag annotation is built from buildTagMessage(explicitText),
    // which strips a defensive BOM (see buildTagMessage's own doc comment);
    // release-body.mjs's fileText is read raw. Comparing raw explicitText here
    // would report a "divergence" for a BOM-only difference that publish would
    // never have seen (pre-flight 6c below refuses a BOM'd --notes-file anyway,
    // so this isn't exploitable — but this check runs FIRST, so an unfixed
    // comparison hands the operator the misleading divergence message instead
    // of the accurate BOM one). Comparing buildTagMessage(explicitText) makes
    // this check agree with what publish actually compares.
    if (normalise(buildTagMessage(explicitText)) !== normalise(defaultText)) {
      const msg =
        `--notes-file ${args.notesFile} and ${DEFAULT_NOTES_FILE} disagree after normalising ` +
        `(CRLF -> LF, trailing whitespace stripped) — release.yml publishes the release body ` +
        `from ${DEFAULT_NOTES_FILE} only, so this tag would fail the publish job after verify, ` +
        `cross-os-verify, mobile-e2e, and companion-apk-build have all run, with the tag already ` +
        `pushed. Align the two files, or pass --allow-notes-divergence to cut anyway (the ` +
        `publish job WILL FAIL unless you fix it before pushing the tag).`;
      // Finding 4 — every other CONDITIONAL pre-flight in main() reports
      // rather than dies under --dry-run (the four that die unconditionally
      // each carry their own comment explaining why — no legitimate reason
      // for a conflict marker or a BOM to ship, ever). A dry run creates no
      // tag, so refusing here protects nothing while destroying the preview;
      // it's also exactly when an operator wants to be TOLD the real run
      // would refuse.
      if (args.allowNotesDivergence) info(`[WARN] --allow-notes-divergence: ${msg}`);
      else if (args.dryRun) info(`[DRY-RUN][WARN] ${msg}`);
      else die(msg);
    }
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
  // fs-1 — three-way lockstep: the sidecar version.py must agree too.
  const sidecarVersion = readSidecarVersion(repoRoot);
  if (sidecarVersion !== null && sidecarVersion !== rootVersion) {
    die(
      `Lockstep invariant violated: root=${rootVersion} sidecar(version.py)=${sidecarVersion}. ` +
        `Manually align them before running bump-version.`,
    );
  }
  // plan 188 — the companion pubspec marketing version must agree too.
  const pubspecVersion = readPubspecVersion(repoRoot);
  if (pubspecVersion !== null && pubspecVersion !== rootVersion) {
    die(
      `Lockstep invariant violated: root=${rootVersion} pubspec(apps/android)=${pubspecVersion}. ` +
        `Manually align apps/android/pubspec.yaml before running bump-version.`,
    );
  }

  const newVersion = semverBump(rootVersion, args.level);
  const newTag = `v${newVersion}`;

  // Pre-flight 4: target tag must not already exist (avoid re-releasing).
  const existingTag = git(['tag', '--list', newTag], { capture: true }).trim();
  if (existingTag.length > 0 && !args.dryRun) {
    die(`Tag ${newTag} already exists. A release for ${newVersion} was already cut; nothing to do.`);
  }

  // Pre-flight 5 (fe-37): the committed brand-voice RELEASE_NOTES.md must lead
  // with the new version and not be a placeholder — a release can't ship empty
  // user-facing notes. --force downgrades this to a warning for a genuine
  // emergency; --dry-run only reports.
  const notesPath = resolve(repoRoot, 'RELEASE_NOTES.md');
  if (existsSync(notesPath)) {
    const notesCheck = checkReleaseNotes(readFileSync(notesPath, 'utf8'), newVersion);
    if (!notesCheck.ok) {
      if (args.force) info(`[WARN] release-notes gate (--force): ${notesCheck.reason}`);
      else if (args.dryRun) info(`[DRY-RUN][WARN] release-notes gate: ${notesCheck.reason}`);
      else
        die(
          `Release-notes gate: ${notesCheck.reason} Update RELEASE_NOTES.md ` +
            `(top entry = the new version, brand voice) before tagging, or pass --force.`,
        );
    }
  }

  // Pre-flight 5b: refuse a silent placeholder body. A release can't ship empty
  // technical notes; --allow-placeholder opts in on purpose, --dry-run warns.
  if (!args.notesFile) {
    const msg =
      `No release notes. Author ${DEFAULT_NOTES_FILE} (technical register — the ` +
      `GitHub release body), or pass --notes-file <path>. To ship a placeholder ` +
      `body on purpose, pass --allow-placeholder.`;
    if (args.allowPlaceholder) info('[WARN] --allow-placeholder: tag annotation will be a placeholder.');
    else if (args.dryRun) info(`[DRY-RUN][WARN] ${msg}`);
    else die(msg);
  }

  // Pre-flight 5c (#1956): RELEASE_NOTES.md must be free of double-UTF-8
  // mojibake — a corrupted file would otherwise ship the mangle straight to
  // users. --force downgrades to a warning; --dry-run only reports.
  //
  // No formatHonouredEcho() call here, unlike the pre-flight 6b block below:
  // the label is always the literal string 'RELEASE_NOTES.md', and
  // checkMojibake refuses outright as soon as ANY marker exists for that
  // label (#1985) — so `mojibakeCheck.honoured` can never be non-empty on
  // this path, and an echo call here could never print anything. Confirmed
  // by running this exact CLI end to end against a RELEASE_NOTES.md carrying
  // a marker (PR #2007 review, Major 2): the run prints the refusal, never
  // an `[allow]` line. Don't add one back without first changing that
  // refusal-first invariant.
  if (existsSync(notesPath)) {
    const notesText = readFileSync(notesPath, 'utf8');

    // Pre-flight 5d (#2018): unresolved git conflict markers must never ship.
    // Runs inside the same `if (existsSync(notesPath))` gate as 5c, ahead of
    // its mojibake check, so a conflict is caught before mojibake even scans
    // the file. Unlike every other pre-flight in this file, this one dies
    // UNCONDITIONALLY — no --force, no --dry-run downgrade — because there is
    // no legitimate reason for a marker to be here (see checkConflictMarkers'
    // doc comment).
    const conflictCheck = checkConflictMarkers(notesText, 'RELEASE_NOTES.md');
    if (!conflictCheck.ok) die(conflictCheck.reason);

    // Pre-flight 5e (#2114): a leading UTF-8 BOM must never ship, same
    // unconditional posture as 5d above — no --force, no --dry-run downgrade,
    // because there is no legitimate reason for a BOM to lead this file (see
    // checkBOM's doc comment).
    const bomCheck = checkBOM(notesText, 'RELEASE_NOTES.md');
    if (!bomCheck.ok) die(bomCheck.reason);

    const mojibakeCheck = checkMojibake(notesText, 'RELEASE_NOTES.md');
    if (!mojibakeCheck.ok) {
      if (args.force) info(`[WARN] mojibake gate (--force): ${mojibakeCheck.reason}`);
      else if (args.dryRun) info(`[DRY-RUN][WARN] mojibake gate: ${mojibakeCheck.reason}`);
      else die(`Mojibake gate: ${mojibakeCheck.reason}`);
    }
  }

  // Pre-flight 6: the technical notes file must be current for THIS version.
  // Catches the "release-notes-next.md still holds the last release" trap —
  // a stale marker would otherwise become the GitHub release body verbatim.
  if (args.notesFile) {
    const notesFileText = readFileSync(resolve(args.notesFile), 'utf8');
    const stale = staleNotesVersion(notesFileText, newVersion);
    if (stale) {
      if (args.force) info(`[WARN] notes-file gate (--force): ${args.notesFile} declares ${stale}, cutting ${newVersion}`);
      else if (args.dryRun) info(`[DRY-RUN][WARN] notes-file gate: ${args.notesFile} declares ${stale}, cutting ${newVersion}`);
      else
        die(
          `${args.notesFile} declares release-notes-next-version: ${stale} but you're ` +
            `cutting ${newVersion}. Refresh it for this release (or pass --force).`,
        );
    }

    // Pre-flight 6b (#1956): the technical notes are fed verbatim into the
    // tag annotation / GitHub release body — a mojibake mangle here ships
    // straight to the public releases page. Computed (and echoed) BEFORE
    // pre-flight 6a below so "an armed marker is never silent" (#1990) holds
    // even when 6a's conflict check is what ultimately dies (PR #2049
    // review, F5) — 6a originally ran first, so a notes file carrying both a
    // conflict marker and an armed marker died naming only the conflict,
    // with the armed marker never echoed that run.
    const mojibakeCheck = checkMojibake(notesFileText, args.notesFile);
    const echo = formatHonouredEcho(args.notesFile, mojibakeCheck.honoured);
    if (echo) info(echo);

    // Pre-flight 6a (#2018): same unconditional conflict-marker refusal as
    // pre-flight 5d above, for the technical notes file.
    const conflictCheck = checkConflictMarkers(notesFileText, args.notesFile);
    if (!conflictCheck.ok) die(conflictCheck.reason);

    // Pre-flight 6c (#2114): same unconditional BOM refusal as pre-flight 5e
    // above, for the technical notes file — this is the one fed verbatim into
    // the tag annotation, so this is the check that actually protects the
    // published release body.
    const bomCheck = checkBOM(notesFileText, args.notesFile);
    if (!bomCheck.ok) die(bomCheck.reason);

    if (!mojibakeCheck.ok) {
      if (args.force) info(`[WARN] mojibake gate (--force): ${mojibakeCheck.reason}`);
      else if (args.dryRun) info(`[DRY-RUN][WARN] mojibake gate: ${mojibakeCheck.reason}`);
      else die(`Mojibake gate: ${mojibakeCheck.reason}`);
    }
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

  info(
    `[PLAN] refresh code stats: ${
      existsSync(resolve(repoRoot, 'scripts', 'code-stats.mjs'))
        ? 'brand/project-narrative.md via code-stats.mjs --write (best-effort)'
        : 'skipped (scripts/code-stats.mjs absent)'
    }`,
  );

  if (args.dryRun) {
    info('[DRY-RUN] No mutations made. Re-run without --dry-run to apply.');
    return;
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

  // Refresh the engineering-notes code stats so they ride in the bump commit.
  // Runs before the version mutation so a stats-only diff is visible alongside
  // the version bump; non-fatal (see refreshCodeStats).
  refreshCodeStats();

  // Mutate: root + server versions + both lockfiles.
  info('[STEP] npm version (root) ...');
  npm(['version', newVersion, '--no-git-tag-version']);
  info('[STEP] npm version (server) ...');
  npm(['version', newVersion, '--no-git-tag-version'], { cwd: resolve(repoRoot, 'server') });
  // fs-1 — rewrite the sidecar version.py in lockstep so /health + /api/info
  // report the new number.
  if (existsSync(sidecarVersionPath(repoRoot))) {
    info('[STEP] rewrite sidecar version.py ...');
    writeSidecarVersion(repoRoot, newVersion);
  }
  // plan 188 — bump the companion pubspec (X.Y.Z + monotonic build number).
  if (existsSync(pubspecPath(repoRoot))) {
    info('[STEP] rewrite apps/android/pubspec.yaml version ...');
    writePubspecVersion(repoRoot, newVersion);
  }

  // Stage + commit. The narrative doc is only staged when it exists AND
  // code-stats actually changed it (git add of an unchanged/absent path is a
  // no-op / skipped) — so a tokei-less box still produces a clean version bump.
  info('[STEP] git add + commit ...');
  const addPaths = [
    'package.json',
    'package-lock.json',
    'server/package.json',
    'server/package-lock.json',
  ];
  if (existsSync(sidecarVersionPath(repoRoot))) {
    addPaths.push('server/tts-sidecar/version.py');
  }
  if (existsSync(pubspecPath(repoRoot))) {
    addPaths.push('apps/android/pubspec.yaml');
  }
  // project-narrative.md is local-only (under the git-ignored brand/) — the
  // code-stats refresh updates it in place but it is never staged/committed.
  git(['add', ...addPaths]);
  git(['commit', '-m', `chore: bump version to ${newVersion}`]);

  // Annotated tag — see createAnnotatedTag()'s doc comment for why
  // `--cleanup=verbatim` and the BOM strip are both load-bearing.
  info('[STEP] git tag ...');
  if (args.notesFile) {
    createAnnotatedTag({ repoRoot, newTag, notesFile: args.notesFile });
  } else {
    git(['tag', '--cleanup=verbatim', '-a', newTag, '-m', `Castwright ${newTag}`]);
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
    // --cleanup=verbatim mirrors the real call inside createAnnotatedTag()
    // (load-bearing — see that function's doc comment). -F <path> hands git
    // the file's raw bytes — no strip like the script's own buildTagMessage
    // (#2114) runs — so the note below is the guard against re-introducing a
    // BOM here.
    info(`       git tag -a ${newTag} --cleanup=verbatim -F <path-to-notes.md>`);
    info(`       (that file must not carry a UTF-8 BOM — git passes it through verbatim)`);
  }
}

// Guarded so tests can import the pure helpers (semverBump, pickWorkflowRun)
// without executing the release procedure. See scripts/lib/is-main-module.mjs
// (#2291) for the symlink/junction mechanism this guards against — first found
// here via a macOS symlinked tmpdir.
if (isDirectlyInvoked(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof CliError) {
      process.exitCode = err.code;
    } else {
      process.stderr.write(`[FAIL] ${err.stack ?? String(err)}\n`);
      process.exitCode = 1;
    }
  });
}
