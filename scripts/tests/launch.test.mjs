// fs-1 — pin the versioned-dir launcher's pure planLaunch() decisions.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// planLaunch must:
//   - no-op to the LOCAL start-app-prod.mjs in a dev checkout (zero env
//     overrides) so launch.mjs is harmless in a git tree,
//   - resolve releases/v<pointer>/ and the shared-data env in a versioned
//     install, skipping any env key an operator already set,
//   - self-heal an empty pointer to the highest release dir,
//   - fail loudly on a dangling pointer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { planLaunch, highestReleaseVersion } from '../../launch.mjs';

const INSTALL = join('/srv', 'audiobook');

// Build an `exists` stub that returns true only for the given set of paths.
function existsFor(paths) {
  const set = new Set(paths);
  return (p) => set.has(p);
}

test('dev checkout (no releases/ + .current-version) runs the local start-app-prod.mjs with no overrides', () => {
  const plan = planLaunch({
    installRoot: INSTALL,
    baseEnv: {},
    exists: () => false,
  });
  assert.equal(plan.mode, 'dev');
  assert.equal(plan.startScript, join(INSTALL, 'scripts', 'start-app-prod.mjs'));
  assert.equal(plan.envOverrides, undefined);
});

test('versioned install resolves releases/v<pointer>/ and the shared-data env', () => {
  const releasesDir = join(INSTALL, 'releases');
  const pointerFile = join(INSTALL, '.current-version');
  const releaseDir = join(releasesDir, 'v1.6.0');
  const plan = planLaunch({
    installRoot: INSTALL,
    baseEnv: {},
    exists: existsFor([releasesDir, pointerFile, releaseDir]),
    readPointer: () => '1.6.0\n',
  });
  assert.equal(plan.mode, 'release');
  assert.equal(plan.version, '1.6.0');
  assert.equal(plan.releaseDir, releaseDir);
  assert.equal(plan.startScript, join(releaseDir, 'scripts', 'start-app-prod.mjs'));
  assert.equal(plan.envOverrides.WORKSPACE_DIR, join(INSTALL, 'workspace'));
  assert.equal(plan.envOverrides.SIDECAR_VENV_DIR, join(INSTALL, 'venv'));
  assert.equal(plan.envOverrides.APP_LOG_DIR, join(INSTALL, 'logs'));
  assert.equal(plan.envOverrides.APP_RUN_DIR, join(INSTALL, '.run'));
  assert.equal(plan.envOverrides.KOKORO_MODEL_PATH, join(INSTALL, 'models', 'kokoro', 'kokoro-v1.0.onnx'));
  assert.equal(plan.envOverrides.NODE_ENV, 'production');
});

test('tolerates a v-prefixed pointer value', () => {
  const releasesDir = join(INSTALL, 'releases');
  const pointerFile = join(INSTALL, '.current-version');
  const releaseDir = join(releasesDir, 'v1.6.0');
  const plan = planLaunch({
    installRoot: INSTALL,
    baseEnv: {},
    exists: existsFor([releasesDir, pointerFile, releaseDir]),
    readPointer: () => 'v1.6.0',
  });
  assert.equal(plan.version, '1.6.0');
});

test('an operator-set env var wins — that key is omitted from overrides', () => {
  const releasesDir = join(INSTALL, 'releases');
  const pointerFile = join(INSTALL, '.current-version');
  const releaseDir = join(releasesDir, 'v1.6.0');
  const plan = planLaunch({
    installRoot: INSTALL,
    baseEnv: { WORKSPACE_DIR: join('/mnt', 'books') },
    exists: existsFor([releasesDir, pointerFile, releaseDir]),
    readPointer: () => '1.6.0',
  });
  assert.equal(plan.envOverrides.WORKSPACE_DIR, undefined);
  // Other keys still applied.
  assert.equal(plan.envOverrides.SIDECAR_VENV_DIR, join(INSTALL, 'venv'));
});

test('an empty pointer self-heals to the highest release directory', () => {
  const releasesDir = join(INSTALL, 'releases');
  const pointerFile = join(INSTALL, '.current-version');
  const releaseDir = join(releasesDir, 'v1.6.0');
  const plan = planLaunch({
    installRoot: INSTALL,
    baseEnv: {},
    exists: existsFor([releasesDir, pointerFile, releaseDir]),
    readPointer: () => '   ',
    readDir: () => ['v1.5.0', 'v1.6.0', 'not-a-release'],
  });
  assert.equal(plan.version, '1.6.0');
});

test('a dangling pointer (release dir missing) throws a recovery hint', () => {
  const releasesDir = join(INSTALL, 'releases');
  const pointerFile = join(INSTALL, '.current-version');
  // releaseDir intentionally absent from the exists set.
  assert.throws(
    () =>
      planLaunch({
        installRoot: INSTALL,
        baseEnv: {},
        exists: existsFor([releasesDir, pointerFile]),
        readPointer: () => '9.9.9',
      }),
    /does not exist/,
  );
});

test('highestReleaseVersion ignores non-semver names and picks the max', () => {
  assert.equal(highestReleaseVersion(['v1.2.0', 'v1.10.0', 'v1.9.3', 'junk']), '1.10.0');
  assert.equal(highestReleaseVersion([]), null);
  assert.equal(highestReleaseVersion(['nope']), null);
});
