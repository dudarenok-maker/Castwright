// Generate server/.env from server/.env.example with WORKSPACE_DIR pointed at
// <appDir>/workspace — but only if server/.env does not already exist
// (idempotent, so update/re-install preserve a user's edits).
//
// CLI: `node pinokio/lib/write-env.js [appDir]` — invoked by pinokio/install.js.

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

/**
 * Produce the .env contents, or null when .env already exists. Pure.
 * @param {{exampleText:string, appDir:string, envExists:boolean}} a
 * @returns {string|null}
 */
function buildEnvContents({ exampleText, appDir, envExists }) {
  if (envExists) return null;
  const workspace = `${appDir}/workspace`;
  return exampleText.replace(/^WORKSPACE_DIR=.*$/m, `WORKSPACE_DIR=${workspace}`);
}

module.exports = { buildEnvContents };

// ---- CLI (acceptance-tested) ----
if (require.main === module) {
  // appDir defaults to the app root (cwd) — install.js runs this from the repo
  // root, so no {{cwd}} template is needed.
  const appDir = process.argv[2] || process.cwd();
  const examplePath = resolve('server', '.env.example');
  const envPath = resolve('server', '.env');
  const out = buildEnvContents({
    exampleText: readFileSync(examplePath, 'utf8'),
    appDir,
    envExists: existsSync(envPath),
  });
  if (out === null) {
    process.stdout.write('[write-env] server/.env already exists — left untouched\n');
  } else {
    writeFileSync(envPath, out, 'utf8');
    process.stdout.write(`[write-env] wrote server/.env (WORKSPACE_DIR=${appDir}/workspace)\n`);
  }
}
