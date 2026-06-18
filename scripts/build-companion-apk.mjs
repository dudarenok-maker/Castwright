#!/usr/bin/env node
/*
 * Build + drop the companion Android APK so it ALWAYS update-installs on device.
 *
 * Two things break a sideload update-install (we hit both 2026-06-18):
 *   1. A versionCode that isn't STRICTLY higher than what's installed → Android
 *      rejects it (or won't see it as an update). Fixed here by stamping a
 *      monotonic timestamp versionCode (minutes since epoch) on every build via
 *      `flutter build --build-number`, so no two real builds collide and the
 *      number only ever climbs — no pubspec edits, no git churn.
 *   2. A signing-key mismatch (a debug-signed or Play-signed build vs the upload
 *      key) → INSTALL_FAILED_UPDATE_INCOMPATIBLE. Fixed here by VERIFYING the
 *      built APK's signer cert == the known upload cert before dropping; we
 *      refuse to publish a wrong-key APK.
 *
 * Output lands at the path the server serves (`GET /api/companion/apk`):
 *   <repoRoot>/companion/castwright-companion.apk  (+ a refreshed .sha1)
 * or wherever COMPANION_APK_PATH points (mirrors server/src/companion/apk.ts).
 *
 * Usage:  node scripts/build-companion-apk.mjs
 *         COMPANION_APK_PATH=/abs/companion/castwright-companion.apk node scripts/build-companion-apk.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ANDROID_DIR = join(REPO_ROOT, 'apps', 'android');

/** Known upload-keystore cert (CN=Mikhail Dudarenok, O=Castwright). A built APK
 *  whose signer SHA-256 differs from this must NOT be dropped — it would fail to
 *  update-install over an upload-signed build on device. */
export const EXPECTED_UPLOAD_CERT_SHA256 =
  'ba7b147d8d844643d2d24001ca5e233bbfac6e57cdd94b683413692ac60de66b';

// ---- pure helpers (unit-tested) ------------------------------------------

/** Monotonic versionCode: whole minutes since the Unix epoch. Strictly climbs
 *  over time; two builds in the same minute would tie, but a release build
 *  takes minutes, so real back-to-back builds never collide. ~29.7M in 2026 —
 *  far above any hand-set code and far below Play's 2.1e9 ceiling for ages. */
export function nextBuildNumber(nowMs = Date.now()) {
  return Math.floor(nowMs / 60_000);
}

/** Pull the signer cert SHA-256 (lowercase hex) out of `apksigner verify
 *  --print-certs` output, or null if absent. */
export function parseSignerSha256(apksignerOutput) {
  const m = /SHA-256 digest:\s*([0-9a-fA-F]{64})/.exec(apksignerOutput);
  return m ? m[1].toLowerCase() : null;
}

/** SHA-1 hex (lowercase) of a buffer — the format of the sidecar .sha1 file. */
export function sha1Hex(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

// ---- side-effecting steps -------------------------------------------------

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/** Locate apksigner.bat/apksigner under the Android SDK, newest build-tools first. */
function findApksigner() {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '') ||
    (process.env.HOME ? join(process.env.HOME, 'Android', 'Sdk') : '');
  const bt = sdk && join(sdk, 'build-tools');
  if (!bt || !existsSync(bt)) return null;
  const bin = process.platform === 'win32' ? 'apksigner.bat' : 'apksigner';
  const dirs = readdirSync(bt).sort().reverse(); // newest version first
  for (const d of dirs) {
    const p = join(bt, d, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

function main() {
  // Guard 2 (signing) starts here: refuse to build if the release-signing config
  // is missing, since the build would silently fall back to DEBUG signing.
  if (!existsSync(join(ANDROID_DIR, 'android', 'key.properties'))) {
    die(
      'apps/android/android/key.properties is missing → release build would fall back to\n' +
        '  DEBUG signing, which cannot update-install over an upload-signed app. Copy your\n' +
        '  key.properties + upload-keystore.jks into apps/android/android/ first.',
    );
  }

  const buildNumber = nextBuildNumber();
  console.log(`→ versionCode (build number): ${buildNumber}`);

  // Build. shell:true so `flutter` resolves to flutter.bat on Windows PATH.
  const build = spawnSync(`flutter build apk --release --build-number=${buildNumber}`, {
    cwd: ANDROID_DIR,
    stdio: 'inherit',
    shell: true,
  });
  if (build.status !== 0) die(`flutter build apk failed (exit ${build.status}).`);

  const apk = join(ANDROID_DIR, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
  if (!existsSync(apk)) die(`expected APK not found at ${apk}`);

  // Guard 2 continued: verify the signer cert is the upload key.
  const apksigner = findApksigner();
  if (apksigner) {
    // shell:true so a Windows `apksigner.bat` runs (Node refuses to spawn
    // .bat/.cmd without a shell); quote paths for safety.
    const r = spawnSync(`"${apksigner}" verify --print-certs "${apk}"`, {
      encoding: 'utf8',
      shell: true,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const got = parseSignerSha256(out);
    if (!got) die('could not read the signer cert from apksigner output.');
    if (got !== EXPECTED_UPLOAD_CERT_SHA256) {
      die(
        `signer cert MISMATCH — refusing to drop.\n  expected ${EXPECTED_UPLOAD_CERT_SHA256}\n  got      ${got}\n` +
          '  This APK would fail to update-install over the upload-signed app. Check key.properties.',
      );
    }
    console.log(`✓ signer cert verified: ${got}`);
  } else {
    console.warn(
      '⚠ apksigner not found (set ANDROID_HOME) — skipping signer verification.\n' +
        '  key.properties is present, so release signing was used, but the cert was NOT confirmed.',
    );
  }

  // Drop to the served path (mirror server/src/companion/apk.ts).
  const dest =
    process.env.COMPANION_APK_PATH?.trim() ||
    join(REPO_ROOT, 'companion', 'castwright-companion.apk');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(apk, dest);
  const bytes = readFileSync(dest);
  const sha1 = sha1Hex(bytes);
  writeFileSync(`${dest}.sha1`, `${sha1}\n`);

  const mb = (statSync(dest).size / (1024 * 1024)).toFixed(1);
  console.log(`\n✓ dropped ${dest}`);
  console.log(`  size  ${mb} MB`);
  console.log(`  sha1  ${sha1}`);
  console.log(`  code  ${buildNumber} (strictly increases each build → update-installs)\n`);
}

// Only run when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
