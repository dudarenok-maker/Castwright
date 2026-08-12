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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir as osHomedir } from 'node:os';

// Deliberately NOT `import { isDirectlyInvoked } from './scripts/lib/is-main-module.mjs'`
// (#2291's shared helper — every other scripts/*.mjs entry point uses it).
// This file is the ONE file in the repo that ships OUTSIDE the versioned
// release directory: per the install layout above, launch.mjs sits at
// <install>/launch.mjs while everything else — including scripts/lib/ — only
// ever exists under <install>/releases/vX.Y.Z/. There is no <install>/scripts/
// directory, so a relative import of the shared helper resolves to a path
// that is never there and crashes at import time with ERR_MODULE_NOT_FOUND —
// invisibly, because restart-after-upgrade.mjs spawns this file detached
// with stdio: 'ignore', so the upgrade reports success and the app just
// never comes back. launch.mjs is also NEVER replaced by an upgrade (see the
// header above) — that is the whole point of a stable bootstrapper — so it
// must not depend on anything an upgrade could leave stale or absent either.
// A few duplicated lines here is a far better trade than adding a copy step
// to scripts/setup-versioned-install.mjs to keep a second moving part in
// sync with the shared helper forever. Keep this in sync with
// scripts/lib/is-main-module.mjs's realpath logic if that ever changes —
// see its header comment for the full reasoning (Windows two-vs-three-slash
// URL shape, and why BOTH sides must be realpathed, not just one).
function realpathWithFallback(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isDirectlyInvoked(importMetaUrl) {
  const invokedRaw = process.argv[1];
  if (!invokedRaw) return false;
  const invokedHref = pathToFileURL(realpathWithFallback(invokedRaw)).href;
  const scriptPath = fileURLToPath(importMetaUrl);
  const scriptHref = pathToFileURL(realpathWithFallback(scriptPath)).href;
  return scriptHref === invokedHref;
}

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

/** Fresh-install default library dir, or null when the home dir is unusable. Pure. */
export function defaultLibraryDir(homedir = osHomedir()) {
  if (!homedir || !isAbsolute(homedir)) return null;
  return join(homedir, 'Castwright');
}

/** Resolvability-only workspace choice. Existing <installRoot>/workspace wins
    (migration guard); else ~/Castwright; else install-local. Pure. */
export function chooseWorkspaceDir({ installRoot, homedir = osHomedir(), exists = existsSync }) {
  const installLocal = join(installRoot, 'workspace');
  if (exists(installLocal)) return installLocal;
  return defaultLibraryDir(homedir) ?? installLocal;
}

/** Boot-safety: return `chosen` if creatable, else `fallback`. mkdir injected for tests. */
export function ensureWorkspaceWritable(chosen, fallback, mkdir = (p) => mkdirSync(p, { recursive: true })) {
  try {
    mkdir(chosen);
    return chosen;
  } catch {
    return fallback;
  }
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
export function planLaunch({ installRoot, baseEnv = {}, readDir = readdirSync, exists = existsSync, readPointer, homedir = osHomedir() }) {
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
    WORKSPACE_DIR: chooseWorkspaceDir({ installRoot, homedir, exists }),
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

  // Boot-safety: never emit a WORKSPACE_DIR we can't create. Only probe a
  // fresh ~/Castwright pick — never mkdir-probe an install-local path the
  // installer already owns.
  if (plan.mode === 'release' && plan.envOverrides.WORKSPACE_DIR) {
    const installLocal = join(installRoot, 'workspace');
    if (plan.envOverrides.WORKSPACE_DIR !== installLocal) {
      plan.envOverrides.WORKSPACE_DIR = ensureWorkspaceWritable(plan.envOverrides.WORKSPACE_DIR, installLocal);
    }
  }

  const childEnv = { ...process.env };
  if (plan.mode === 'release') {
    Object.assign(childEnv, plan.envOverrides);
    process.stdout.write(`[launch] starting release v${plan.version} from ${plan.releaseDir}\n`);
  } else {
    process.stdout.write('[launch] dev checkout (no releases/ + .current-version) — running local start-app-prod.mjs\n');
  }

  const cwd = plan.mode === 'release' ? plan.releaseDir : installRoot;
  const child = spawn(process.execPath, [plan.startScript], {
    cwd,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    process.stderr.write(`[launch] failed to start ${plan.startScript}: ${err.message}\n`);
    process.exit(1);
  });
}

// CLI guard — only run main() when invoked directly, not when imported by tests.
// Uses the inline isDirectlyInvoked() defined above, NOT the shared
// scripts/lib/is-main-module.mjs helper — see the comment by that function
// for why this one file deliberately duplicates it. An un-realpathed
// comparison misses whenever the invocation path crosses a symlink/junction
// (#2291).
const invokedDirectly = isDirectlyInvoked(import.meta.url);
if (invokedDirectly) main();
