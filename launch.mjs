#!/usr/bin/env node
/* fs-1 — stable launcher for a versioned-directory install.

   Lives at the install root and is the entry every shortcut / start-app.bat
   points at. It is NEVER replaced by an upgrade, so an in-progress swap can't
   delete the thing that boots the app.

   Install layout (versioned):
     <install>/launch.mjs            <- this file (stable)
     <install>/.current-version      <- pointer, e.g. "1.6.0"
     <install>/releases/v1.6.0/...   <- a release == the contents of one zip
     <install>/venv/                 <- SHARED python venv   (SIDECAR_VENV_DIR)
     <install>/models/kokoro/        <- SHARED weights        (KOKORO_*_PATH)
     <install>/workspace/            <- SHARED library        (WORKSPACE_DIR)
     <install>/logs/  <install>/.run/ <- SHARED runtime        (APP_LOG_DIR/APP_RUN_DIR)

   In a plain git/dev checkout there is no releases/ + .current-version, so this
   file is a NO-OP that runs the local scripts/start-app-prod.mjs unchanged with
   no env overrides — exactly today's behaviour. That is what lets launch.mjs
   ship inside every release zip and sit harmlessly in a developer checkout. */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_DIR = /^v(\d+)\.(\d+)\.(\d+)$/;

/** Pick the highest vX.Y.Z directory name under releasesDir, or null. */
export function highestReleaseVersion(releaseDirNames) {
  const parsed = releaseDirNames
    .map((name) => {
      const m = SEMVER_DIR.exec(name);
      return m ? { name, parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
    })
    .filter(Boolean);
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  return parsed[0].name.slice(1); // drop the leading 'v'
}

/**
 * Decide how to launch from an install root, WITHOUT spawning anything (pure,
 * so it's unit-testable). Returns either:
 *   { mode: 'dev',     startScript }                              — no overrides
 *   { mode: 'release', version, releaseDir, startScript, envOverrides }
 *
 * `envOverrides` lists the shared-data env vars to apply, but ONLY for keys not
 * already present in `baseEnv` (an explicit ops override always wins).
 */
export function planLaunch({ installRoot, baseEnv = {}, readDir = readdirSync, exists = existsSync, readPointer }) {
  const releasesDir = join(installRoot, 'releases');
  const pointerFile = join(installRoot, '.current-version');

  // Dev-checkout no-op guard: both markers must exist to be a versioned install.
  if (!exists(releasesDir) || !exists(pointerFile)) {
    return { mode: 'dev', startScript: join(installRoot, 'scripts', 'start-app-prod.mjs') };
  }

  const rawPointer = (readPointer ? readPointer(pointerFile) : readFileSync(pointerFile, 'utf8')).trim();
  let version = rawPointer.replace(/^v/, '');
  if (!version) {
    // Empty/blank pointer → self-heal to the highest release dir present.
    const healed = highestReleaseVersion(readDir(releasesDir));
    if (!healed) {
      throw new Error(`[launch] .current-version is empty and no releases/vX.Y.Z directory exists under ${releasesDir}`);
    }
    version = healed;
  }

  const releaseDir = join(releasesDir, `v${version}`);
  if (!exists(releaseDir)) {
    throw new Error(
      `[launch] .current-version points at v${version} but ${releaseDir} does not exist. ` +
        `Recover by editing .current-version to an installed release under ${releasesDir}.`,
    );
  }

  const shared = {
    WORKSPACE_DIR: join(installRoot, 'workspace'),
    SIDECAR_VENV_DIR: join(installRoot, 'venv'),
    KOKORO_MODEL_PATH: join(installRoot, 'models', 'kokoro', 'kokoro-v1.0.onnx'),
    KOKORO_VOICES_PATH: join(installRoot, 'models', 'kokoro', 'voices-v1.0.bin'),
    APP_LOG_DIR: join(installRoot, 'logs'),
    APP_RUN_DIR: join(installRoot, '.run'),
    NODE_ENV: 'production',
  };
  const envOverrides = {};
  for (const [k, v] of Object.entries(shared)) {
    if (baseEnv[k] === undefined) envOverrides[k] = v;
  }

  return {
    mode: 'release',
    version,
    releaseDir,
    startScript: join(releaseDir, 'scripts', 'start-app-prod.mjs'),
    envOverrides,
  };
}

function main() {
  const installRoot = dirname(fileURLToPath(import.meta.url));
  const plan = planLaunch({ installRoot, baseEnv: process.env });

  const childEnv = { ...process.env };
  if (plan.mode === 'release') {
    Object.assign(childEnv, plan.envOverrides);
    process.stdout.write(`[launch] starting release v${plan.version} from ${plan.releaseDir}\n`);
  } else {
    process.stdout.write('[launch] dev checkout (no releases/ + .current-version) — running local start-app-prod.mjs\n');
  }

  const cwd = plan.mode === 'release' ? plan.releaseDir : installRoot;
  const child = spawn(process.execPath, [plan.startScript], { cwd, env: childEnv, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    process.stderr.write(`[launch] failed to start ${plan.startScript}: ${err.message}\n`);
    process.exit(1);
  });
}

// CLI guard — only run main() when invoked directly, not when imported by tests.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
