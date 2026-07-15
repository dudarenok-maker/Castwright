// Generate server/.env from server/.env.example with WORKSPACE_DIR pointed at the
// fresh-install default (~/Castwright) — but only if server/.env does not already
// exist (idempotent), and keeping an existing <appDir>/workspace when present.
// See docs/superpowers/specs/2026-07-15-first-run-library-location-design.md.
//
// CLI: `node pinokio-scripts/lib/write-env.js [appDir]` — invoked by pinokio-scripts/install.js.

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, join, isAbsolute } = require('node:path');
const os = require('node:os');

/** Fresh-install default library dir, or null when the home dir is unusable. Pure. */
function defaultLibraryDir(homedir = os.homedir()) {
  if (!homedir || !isAbsolute(homedir)) return null;
  return join(homedir, 'Castwright');
}

/** Resolvability-only choice (no writability probe). Pure. */
function chooseFreshWorkspaceDir({ appDir, homedir = os.homedir(), workspaceExists }) {
  const installLocal = `${appDir}/workspace`;
  if (workspaceExists) return installLocal; // migration guard: keep an existing library
  return defaultLibraryDir(homedir) ?? installLocal; // resolvability fallback
}

/** Produce the .env contents, or null when .env already exists. Pure. */
function buildEnvContents({ exampleText, workspaceDir, envExists }) {
  if (envExists) return null;
  return exampleText.replace(/^WORKSPACE_DIR=.*$/m, `WORKSPACE_DIR=${workspaceDir}`);
}

module.exports = { buildEnvContents, defaultLibraryDir, chooseFreshWorkspaceDir };

// ---- CLI (acceptance-tested via the pure helpers above) ----
if (require.main === module) {
  const appDir = process.argv[2] || process.cwd();
  const examplePath = resolve('server', '.env.example');
  const envPath = resolve('server', '.env');
  const installLocal = `${appDir}/workspace`;

  let workspaceDir = chooseFreshWorkspaceDir({
    appDir,
    workspaceExists: existsSync(installLocal),
  });
  // Boot-safety: never emit a dir we can't create. Probe once; fall back on failure.
  try {
    mkdirSync(workspaceDir, { recursive: true });
  } catch (err) {
    process.stdout.write(`[write-env] ${workspaceDir} not creatable (${err.code}); using ${installLocal}\n`);
    workspaceDir = installLocal;
  }

  const out = buildEnvContents({
    exampleText: readFileSync(examplePath, 'utf8'),
    workspaceDir,
    envExists: existsSync(envPath),
  });
  if (out === null) {
    process.stdout.write('[write-env] server/.env already exists — left untouched\n');
  } else {
    writeFileSync(envPath, out, 'utf8');
    process.stdout.write(`[write-env] wrote server/.env (WORKSPACE_DIR=${workspaceDir})\n`);
  }
}
