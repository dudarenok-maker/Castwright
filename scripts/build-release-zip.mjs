#!/usr/bin/env node
// Manifest-driven release zip builder. Walks the repo, applies the
// MANIFEST include/exclude rules, writes a deterministic zip. Exports
// MANIFEST + matchesManifest so the unit test can assert decisions
// without driving the CLI.
//
// Usage:
//   node scripts/build-release-zip.mjs --version v1.2.3 [--out path] [--dry-run]

import {
  createWriteStream,
  mkdirSync,
  statSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { dirname, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

/* fe-37 — RELEASE_NOTES.md is now a COMMITTED, maintained brand-voice
   multi-version history (it used to be baked from the tag body here). Ship it
   verbatim: when it exists at the repo root (it always should in a real
   checkout) leave it untouched so the committed brand history reaches the
   bundle. Only if it's somehow MISSING do we write a one-line placeholder so the
   build never hard-fails on a stripped tree. The GitHub release body comes from
   the tag annotation in release.yml, not from this file; the legacy notesFile
   argument is accepted but ignored. */
export function generateReleaseNotes(version, _notesFile) {
  const out = resolve(repoRoot, 'RELEASE_NOTES.md');
  if (existsSync(out) && readFileSync(out, 'utf8').trim().length > 0) {
    return out; // committed brand history — ship verbatim, never clobber
  }
  writeFileSync(out, `# ${version}\n\nSee the GitHub release for details.\n`, 'utf8');
  return out;
}

// Patterns use POSIX-style forward slashes; we normalize repo-relative
// paths to that style before matching.
export const MANIFEST = {
  include: [
    // Root config + runnable entry points
    'package.json',
    'package-lock.json',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'tsconfig.node.json',
    'postcss.config.js',
    'tailwind.config.ts',
    'openapi.yaml',
    'README.md',
    'INSTALL.md',
    '.gitignore',

    // fs-1 — bundled release notes (generated from the tag annotation at build
    // time). GET /api/info reads it from the release root for the what's-new
    // banner. Gitignored — a build artefact, not committed.
    'RELEASE_NOTES.md',

    // fs-1 — stable launcher for the versioned-dir install. Ships inside every
    // release; setup-versioned-install.mjs copies it to the install root once.
    'launch.mjs',

    // #2291 — the shared direct-execution-guard helper. Several already-shipped
    // scripts/*.mjs runtime entry points (start-app-prod, restart-after-upgrade,
    // setup-versioned-install) and server/tts-sidecar/scripts/*.mjs installers
    // (accelerator-profile, install-ort, install-torch, and others) import this
    // at the top level, so it MUST ship or those scripts crash at import time in
    // a real install. (launch.mjs deliberately does NOT import it — see the
    // comment by its own isDirectlyInvoked for why — so it is not one of these.)
    // The stake is higher than "four CLIs fail to run": server/src/index.ts:82,
    // server/src/tts/spawn-sidecar.ts:33, and server/src/upgrade/apply.ts:24-30
    // statically import several of those same sidecar .mjs installers directly
    // into the server bundle, so a missing manifest entry here fails the
    // SERVER at boot, not just a standalone installer CLI invocation. Pinned
    // by scripts/tests/entry-point-guard-convention.test.mjs's "shared helper
    // ships in the release zip" assertion — do not remove this entry without
    // removing that assertion first.
    'scripts/lib/is-main-module.mjs',

    // Frontend source + pre-built bundle
    'src/**',
    'dist/**',

    // Server source + pre-built bundle
    'server/package.json',
    'server/package-lock.json',
    'server/tsconfig.json',
    'server/.env.example',
    'server/src/**',
    'server/dist/**',

    // Sidecar source + start script + Kokoro installers
    'server/tts-sidecar/**',

    // Analyzer skill prompts — read fresh off disk at runtime by
    // server/src/config/prompts.ts (readPrompt), analyzer/gemini.ts, and
    // analyzer/voice-style.ts. Omitting these ENOENTs every analysis on a
    // zip install (all platforms).
    'skills/**',

    // Runtime scripts the deployer invokes (start:prod / stop:prod and the
    // preflight that npm run dev triggers — useful diagnostic).
    'scripts/start-app-prod.mjs',
    'scripts/stop-app.mjs',
    'scripts/stop-app.ps1',
    'scripts/preflight-ffmpeg.cjs',
    // fs-1 upgrade machinery the deployer/runtime needs.
    'scripts/restart-after-upgrade.mjs',
    'scripts/setup-versioned-install.mjs',

    // fs-22 — the bundled, generate-able demo book (manuscript + designed cast
    // + voice files, no audio). Loaded into the workspace via the "Try the
    // sample" affordance (POST /api/samples/:slug/load).
    'samples/**',
  ],
  exclude: [
    // Installed deps + venv (deployer runs npm ci / pip install).
    'node_modules/**',
    '**/node_modules/**',
    'server/tts-sidecar/.venv/**',

    // Secrets (but .env.example IS included via the include list).
    '**/.env',
    '**/.env.local',
    '**/.env.*.local',

    // Kokoro weights (1.1 GB — fetched at install time).
    'server/tts-sidecar/voices/kokoro/**',

    // Working data + per-workspace caches.
    'server/handoff/inbox/**',
    'server/handoff/outbox/**',
    'server/audio/**',
    'server/workspace/**',

    // Dev / repo metadata.
    '.git/**',
    '.github/**',
    '.husky/**',
    '.claude/**',
    '.run/**',
    'logs/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',

    // Maintainer-only doc + test surfaces.
    'e2e/**',
    'docs/**',
    'scripts/tests/**',
    'server/tts-sidecar/tests/**',
    'CLAUDE.md',
    'CONTRIBUTING.md',

    // Maintainer-only scripts (not for deployer).
    'scripts/start-app.ps1',
    'scripts/bump-version.mjs',
    'scripts/build-release-zip.mjs',
    'scripts/validate-commit-msg.mjs',
    'scripts/verify-cache.mjs',
    'scripts/reconcile-broken-cast.ps1',
    'scripts/gen-parser-fixtures.mjs',

    // Generated / cached artefacts the deployer should not see.
    '**/*.log',
    '.verify-cache.json',
    '.verify-cache.json.tmp',
    '**/*.tsbuildinfo',
    '.vite/**',
  ],
  // .gitkeep is restored for empty working directories so the runtime layout
  // is intact even with their contents excluded.
  keepGitkeepIn: [
    'server/handoff/inbox',
    'server/handoff/outbox',
    'server/audio',
    'server/workspace',
    'server/tts-sidecar/voices/kokoro',
  ],
};

function toPosix(rel) {
  return rel.split(sep).join('/');
}

/**
 * Return true if `relPath` (forward-slash, repo-relative) should ship in
 * the release zip. Pure function — useful for unit testing the manifest
 * decisions in isolation.
 */
/** Returns the default zip output path (relative to repo root) for a given version tag. */
export function releaseZipName(version) {
  return `release/castwright-${version}.zip`;
}

/** Returns the top-level directory prefix used inside the release zip. */
export function releaseInternalPrefix(version) {
  return `castwright-${version}`;
}

/* Interim companion-app distribution — the release bundles the packaged Android
   APK so the server's GET /api/companion/apk (server/src/companion/apk.ts) can
   serve the in-app "Download .apk" button straight from the install. */

/** Absolute path to the source APK to stage into the zip. CI sets
    COMPANION_APK_SRC to the APK it built/downloaded; locally it defaults to the
    Flutter release-build output. The path may not exist — the build skips the
    APK (and logs it) rather than failing when absent. */
export function companionApkSrc() {
  const override = process.env.COMPANION_APK_SRC?.trim();
  if (override) return resolve(repoRoot, override);
  return resolve(repoRoot, 'apps/android/build/app/outputs/flutter-apk/app-release.apk');
}

/** In-zip path for the bundled APK. The server resolves it at
    <release-root>/companion/castwright-companion.apk — three levels up from
    server/dist/companion, i.e. the release prefix dir. */
export function companionApkZipEntry(version) {
  return posix.join(releaseInternalPrefix(version), 'companion', 'castwright-companion.apk');
}

export function matchesManifest(relPath, manifest = MANIFEST) {
  const p = toPosix(relPath);
  // Exclude always wins (even if include also matches).
  if (anyMatch(p, manifest.exclude)) {
    // But: keep .gitkeep files inside excluded-but-listed-as-keep-empty dirs.
    if (p.endsWith('/.gitkeep')) {
      const dir = p.slice(0, p.length - '/.gitkeep'.length);
      if (manifest.keepGitkeepIn.includes(dir)) return true;
    }
    return false;
  }
  return anyMatch(p, manifest.include);
}

function anyMatch(p, patterns) {
  return micromatchish(p, patterns);
}

// Minimal globstar matcher (see globMatch below). Sufficient for the
// patterns the manifest uses today — no character classes, no negation,
// no braces. Kept dependency-free so the test can import this module
// without pulling in archiver / fast-glob.
function micromatchish(p, patterns) {
  for (const pat of patterns) {
    if (globMatch(p, pat)) return true;
  }
  return false;
}

// Minimal glob matcher: supports **, *, and exact segments. Sufficient
// for the manifest patterns we use (no character classes, no negation,
// no braces).
function globMatch(p, pattern) {
  // Translate glob to RegExp.
  const re = new RegExp(
    '^' +
      pattern
        .split('/')
        .map((seg) => {
          if (seg === '**') return '(?:.*)';
          return seg
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*');
        })
        .join('/')
        // Collapse `(?:.*)/` so `foo/**/bar` matches `foo/bar`.
        .replace(/\(\?:\.\*\)\//g, '(?:.*/)?')
        .replace(/\/\(\?:\.\*\)$/, '(?:/.*)?') +
      '$',
  );
  return re.test(p);
}

function parseArgs(argv) {
  const out = { version: null, out: null, dryRun: false, notesFile: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') out.version = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--notes-file') out.notesFile = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') {
      // Defer the actual print + exit to main() — see the note by
      // CliError/die below on why this file no longer calls process.exit()
      // directly at all.
      out.help = true;
      break;
    } else die(`Unknown argument: ${a}`);
  }
  return out;
}

// process.exit() terminates before Node flushes pending async stdout writes
// (stdout to a pipe is synchronous on Windows but ASYNC on Linux/macOS — see
// https://nodejs.org/api/process.html#a-note-on-process-io). That silently
// truncated this script's --dry-run output on GitHub's ubuntu-latest (PR
// #2297) while looking fine on every Windows dev box. Fixed by never calling
// process.exit() here: die() sets process.exitCode and throws a CliError
// instead, so the call stack unwinds back to the single catch at the bottom
// of this file and the process exits naturally once the event loop drains.
// Every die() path holds no open handle by that point (no server/timer/child
// process), so nothing keeps it alive past that. The ZIP path is the one
// exception: while `archive.pipe(output)` is live and files are still
// queued, an `archive.on('error', …)` there is NOT a die() call and does not
// throw a CliError — it rejects the archiver Promise directly, and that
// Promise's own error handler is responsible for aborting the archive
// stream (rather than letting it drain) and removing the partial output
// file. See that handler, below, for the reasoning.
class CliError extends Error {}

function die(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exitCode = 1;
  throw new CliError(msg);
}

function info(msg) {
  process.stdout.write(`${msg}\n`);
}

async function walkRepo() {
  // Walk everything except clearly-massive trees to keep the scan fast.
  // The manifest's exclude list is the source of truth — this pre-filter
  // is just a perf shortcut. `fast-glob` is lazy-imported so the test
  // suite can import this module's pure exports without pulling it in.
  const { default: fg } = await import('fast-glob');
  const all = await fg(['**/*'], {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: [
      'node_modules/**',
      '**/node_modules/**',
      'server/tts-sidecar/.venv/**',
      'server/tts-sidecar/voices/kokoro/**',
      '.git/**',
    ],
  });
  return all;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/build-release-zip.mjs --version vX.Y.Z [--out path] [--dry-run]\n',
    );
    return;
  }
  if (!args.version) die('--version is required (e.g. --version v1.2.3)');
  if (!/^v\d+\.\d+\.\d+(-[\w.-]+)?$/.test(args.version)) {
    die(`--version must look like vMAJOR.MINOR.PATCH[-suffix], got "${args.version}"`);
  }

  const outPath = resolve(
    repoRoot,
    args.out ?? releaseZipName(args.version),
  );
  mkdirSync(dirname(outPath), { recursive: true });

  // fe-37 — RELEASE_NOTES.md is committed (brand history); ship it verbatim.
  const notesPath = generateReleaseNotes(args.version, args.notesFile);
  info(`[NOTES] bundling committed ${notesPath}`);

  info(`[SCAN] walking repo from ${repoRoot}`);
  const candidates = await walkRepo();
  const matched = [];
  let totalBytes = 0;
  for (const rel of candidates) {
    if (!matchesManifest(rel)) continue;
    const abs = resolve(repoRoot, rel);
    try {
      const s = statSync(abs);
      matched.push({ rel, abs, size: s.size });
      totalBytes += s.size;
    } catch {
      // Skip files that disappear mid-scan.
    }
  }
  matched.sort((a, b) => a.rel.localeCompare(b.rel));

  info(`[MANIFEST] ${matched.length} files, ${Math.round(totalBytes / 1024)} KB total`);

  // Interim — stage the companion APK at companion/castwright-companion.apk if
  // a source exists (CI: COMPANION_APK_SRC; local: Flutter output). Absent is
  // fine: the release just ships without the in-app download.
  const apkSrc = companionApkSrc();
  const apkExists = existsSync(apkSrc);
  if (apkExists) {
    info(`[APK] bundling ${apkSrc} → ${companionApkZipEntry(args.version)}`);
  } else {
    info(
      `[APK] SKIP — no companion APK at ${apkSrc} ` +
        `(set COMPANION_APK_SRC or run \`flutter build apk --release\`); ` +
        `release will ship without the in-app download`,
    );
  }

  if (args.dryRun) {
    for (const { rel, size } of matched) {
      info(`  ${rel}  (${size} bytes)`);
    }
    if (apkExists) {
      info(`  ${companionApkZipEntry(args.version)}  (${statSync(apkSrc).size} bytes)`);
    }
    info('[DRY-RUN] No zip written.');
    return;
  }

  info(`[ZIP] writing ${outPath}`);
  await writeReleaseZip({ outPath, matched, apkSrc, apkExists, version: args.version });

  const finalSize = statSync(outPath).size;
  info(`[OK] ${outPath}  (${Math.round(finalSize / 1024)} KB)`);
}

/**
 * Streams `matched` (plus the companion APK, when present) into a zip at
 * `outPath` via archiver's ZipArchive. Exported (and `loadArchiver`
 * injectable) so the regression test can drive the exact error-handling
 * wiring below without needing to reproduce a real archiver-internal race —
 * scripts/tests/archiver-zip.test.mjs separately pins that the real
 * .pipe/.file/.finalize/warning/error surface behaves as this code assumes.
 *
 * On a mid-archive error (a queued file becomes unreadable, e.g. EACCES/
 * EMFILE/ENOENT after the initial stat), aborts the archiver — stopping it
 * from draining the remaining queue — destroys the output stream, and
 * removes the partial outPath: a failed build must never leave a larger,
 * complete-looking but INVALID zip behind. See the comment by
 * CliError/die above for why this function's own Promise, not a thrown
 * CliError, is what carries that failure back to main()'s catch.
 */
export async function writeReleaseZip({
  outPath,
  matched,
  apkSrc,
  apkExists,
  version,
  loadArchiver = () => import('archiver'),
}) {
  /* Lazy-load archiver — v8 is pure ESM and exposes only named class
     exports (Archiver / ZipArchive / …), with NO callable default
     factory (the v7 `archiver('zip', …)` signature is gone). Dynamic
     `import()` keeps the dep out of the module graph so the MANIFEST
     unit test (scripts/tests/release-manifest.test.mjs) imports this
     file without needing archiver installed. */
  const { ZipArchive } = await loadArchiver();
  await new Promise((resolveZip, rejectZip) => {
    const output = createWriteStream(outPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolveZip);
    const onArchiveError = (err) => {
      archive.abort();
      output.destroy();
      try {
        unlinkSync(outPath);
      } catch {
        // Nothing (yet) written to outPath, or it's already gone — fine
        // either way; the goal is just that it not survive with content.
      }
      rejectZip(err);
    };
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') return;
      onArchiveError(err);
    });
    archive.on('error', onArchiveError);
    archive.pipe(output);
    for (const { rel, abs } of matched) {
      // Use POSIX separators in the zip entries for cross-platform extract.
      archive.file(abs, { name: posix.join(releaseInternalPrefix(version), toPosix(rel)) });
    }
    // Interim companion-app distribution — bundle the APK at its served path.
    if (apkExists) {
      archive.file(apkSrc, { name: companionApkZipEntry(version) });
    }
    archive.finalize();
  });
}

// Only run the CLI if invoked directly (not when imported by tests). See
// scripts/lib/is-main-module.mjs — a resolve()-only comparison misses when
// the invocation crosses a symlink/junction (#2291).
const invokedAsCli = isDirectlyInvoked(import.meta.url);
if (invokedAsCli) {
  main().catch((err) => {
    // die() already wrote its own [FAIL] line and set exitCode before
    // throwing a CliError; only print here for a genuinely unexpected error
    // (e.g. a rejected archiver promise) that never went through die().
    if (!(err instanceof CliError)) {
      process.stderr.write(`[FAIL] ${err.stack ?? String(err)}\n`);
    }
    process.exitCode = 1;
  });
}
