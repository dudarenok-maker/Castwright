#!/usr/bin/env node
// Companion marketing screenshot capture (piece #1b). Pushes the (operator-
// supplied, git-ignored) brand covers to the emulator, then runs flutter drive.
// The on-device ThumbnailCache downscales them, so no Node image lib is needed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = resolve(repoRoot, 'apps/android');
const COVERS_SRC = resolve(repoRoot, 'brand/book-covers');
// adb-writable scratch dir: survives the app install/uninstall lifecycle (the
// app's external dir is wiped on uninstall) and the app can still read it.
const DEVICE_COVERS = '/data/local/tmp/demo-covers';

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ ${cmd} ${args.join(' ')} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
};

// 1. An emulator/device must be up. `adb devices` prints one `<serial>\tdevice`
//    line per online device (after a header line); match that exactly.
const devices = spawnSync('adb', ['devices'], { encoding: 'utf8', shell: true }).stdout ?? '';
const online = devices.split('\n').some((line) => /\tdevice$/.test(line.trimEnd()));
if (!online) {
  console.error('✖ No running emulator/device (none shown as "device" by `adb devices`). Boot an AVD first — see apps/android/integration_test/marketing/README.md.');
  process.exit(1);
}

// 2. Push the covers (operator-supplied; git-ignored). Filenames must match the
//    bookIds in lib/src/demo/demo_data.dart (e.g. hollow-tide-1.png).
if (!existsSync(COVERS_SRC) || readdirSync(COVERS_SRC).length === 0) {
  console.error(`✖ No covers at ${COVERS_SRC}. Provide the brand book covers (git-ignored) and retry.`);
  process.exit(1);
}
sh('adb', ['shell', 'mkdir', '-p', DEVICE_COVERS]);
sh('adb', ['push', `${COVERS_SRC}/.`, DEVICE_COVERS]);

// 3. Run flutter drive once (captures all scenes × themes).
sh('flutter', [
  'drive',
  '--driver=test_driver/integration_test.dart',
  '--target=integration_test/marketing_capture_test.dart',
], { cwd: androidDir });

console.log('\n✔ Companion shots written to mockups/marketing-screens/companion/');
