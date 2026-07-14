#!/usr/bin/env node
// Companion marketing screenshot capture (piece #1b). Pushes the (operator-
// supplied, git-ignored) brand covers to the emulator, then runs flutter drive.
// The on-device ThumbnailCache downscales them, so no Node image lib is needed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = resolve(repoRoot, 'apps/android');
const COVERS_SRC = resolve(repoRoot, 'brand/book-covers');
// adb-writable scratch dir: survives the app install/uninstall lifecycle (the
// app's external dir is wiped on uninstall) and the app can still read it.
const DEVICE_COVERS = '/data/local/tmp/demo-covers';

export const SURFACE_PASSES = {
  phone: [{ orient: 'portrait', scenes: null }],
  tablet7: [
    { orient: 'landscape', scenes: ['library-home', 'player', 'book-detail', 'library-offline'] },
    { orient: 'portrait', scenes: ['settings', 'pairing'] },
  ],
  tablet10: [
    { orient: 'landscape', scenes: ['library-home', 'player', 'book-detail', 'library-offline'] },
    { orient: 'portrait', scenes: ['settings', 'pairing'] },
  ],
  fold: [{ orient: 'seam', scenes: ['library-home'] }],
};

// Absolute adb `user_rotation` (0/1/2/3 = 0°/90°/180°/270° from the device's
// NATURAL orientation) needed to place it in `orient`. "Which rotation is
// landscape" depends on the device's natural orientation: phones and the
// Nexus 7 are natural-PORTRAIT (rotation 1 = landscape), but the Pixel Tablet
// is natural-LANDSCAPE (rotation 0 = landscape). The caller derives
// `naturalLandscape` from `adb shell wm size` (see parseNaturalLandscape) and
// passes it in, so a fixed rotation index can't silently rotate a
// natural-landscape tablet into portrait (which the app-side `expanded` guard
// then rejects). 'seam' keeps the device at its natural rotation (0) — the
// fold crease is defined by posture, not rotation.
export const rotationValue = (orient, naturalLandscape = false) => {
  if (orient === 'seam') return 0;
  const wantLandscape = orient === 'landscape';
  if (naturalLandscape) return wantLandscape ? 0 : 1;
  return wantLandscape ? 1 : 0;
};

// True when the device's NATURAL (physical) orientation is landscape, parsed
// from `adb shell wm size` ("Physical size: WxH" — always reported in the
// natural orientation, independent of the current user_rotation). Unknown
// output falls back to false (natural-portrait), preserving the historical
// phone/Nexus-7 behaviour.
export function parseNaturalLandscape(wmSizeOutput) {
  const m = wmSizeOutput.match(/Physical size:\s*(\d+)\s*x\s*(\d+)/i);
  if (!m) return false;
  return Number(m[1]) > Number(m[2]);
}

export function buildDartDefines({ surface, orient, scenes }) {
  const defs = [`--dart-define=surface=${surface}`, `--dart-define=orient=${orient}`];
  if (scenes && scenes.length) defs.push(`--dart-define=scenes=${scenes.join(',')}`);
  return defs;
}

export function parseHalfOpenedState(printStatesOutput) {
  const m = printStatesOutput.match(/identifier=(\d+)[^}]*?name='?HALF_OPENED'?/i)
    || printStatesOutput.match(/name='?HALF_OPENED'?[^}]*?identifier=(\d+)/i);
  return m ? Number(m[1]) : null;
}

// Fatal: throws (rather than process.exit) on non-zero so callers' `finally`
// blocks still run — a capture failure must not skip rotation/posture cleanup.
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status}).`);
  }
};

// Non-fatal: for cleanup commands only. Warns instead of throwing/exiting so
// one failed restore step can't mask the real failure or abort the rest of
// the same `finally` block.
const shSoft = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.warn(`⚠ ${cmd} ${args.join(' ')} failed (exit ${r.status}) (ignored).`);
  }
};

function parseArgs(argv) {
  const surfaceArg = argv.find((a) => a.startsWith('--surface='));
  const orientArg = argv.find((a) => a.startsWith('--orient='));
  const scenesArg = argv.find((a) => a.startsWith('--scenes='));
  const surface = surfaceArg ? surfaceArg.slice('--surface='.length) : 'phone';
  // Validate up front so a typo'd --surface (e.g. "tabletX") errors loudly in
  // BOTH the CLI-supplied-orient branch below and the SURFACE_PASSES lookup
  // branch, rather than silently flowing an unknown surface into the
  // dart-define.
  if (!SURFACE_PASSES[surface]) {
    throw new Error(`Unknown surface "${surface}". Known surfaces: ${Object.keys(SURFACE_PASSES).join(', ')}.`);
  }
  if (orientArg || scenesArg) {
    const orient = orientArg ? orientArg.slice('--orient='.length) : 'portrait';
    const scenes = scenesArg ? scenesArg.slice('--scenes='.length).split(',') : null;
    return { surface, passes: [{ orient, scenes }] };
  }
  return { surface, passes: SURFACE_PASSES[surface] };
}

async function main(argv) {
  try {
    const { surface, passes } = parseArgs(argv);

    // 1. An emulator/device must be up. `adb devices` prints one `<serial>\tdevice`
    //    line per online device (after a header line); match that exactly.
    const devices = spawnSync('adb', ['devices'], { encoding: 'utf8', shell: true }).stdout ?? '';
    const online = devices.split('\n').some((line) => /\tdevice$/.test(line.trimEnd()));
    if (!online) {
      throw new Error('No running emulator/device (none shown as "device" by `adb devices`). Boot an AVD first — see apps/android/integration_test/marketing/README.md.');
    }

    // 2. Push the covers (operator-supplied; git-ignored). Filenames must match the
    //    bookIds in lib/src/demo/demo_data.dart (e.g. hollow-tide-1.png).
    if (!existsSync(COVERS_SRC) || readdirSync(COVERS_SRC).length === 0) {
      throw new Error(`No covers at ${COVERS_SRC}. Provide the brand book covers (git-ignored) and retry.`);
    }
    sh('adb', ['shell', 'mkdir', '-p', DEVICE_COVERS]);
    sh('adb', ['push', `${COVERS_SRC}/.`, DEVICE_COVERS]);

    // The rotation index for "landscape" depends on the device's natural
    // orientation (phones/Nexus 7 are natural-portrait; the Pixel Tablet is
    // natural-landscape), so read it once from `adb shell wm size` and thread
    // it into rotationValue below.
    const wmSize = spawnSync('adb', ['shell', 'wm', 'size'], { encoding: 'utf8', shell: true }).stdout ?? '';
    const naturalLandscape = parseNaturalLandscape(wmSize);

    // 3. Run flutter drive once per pass (rotation/posture set beforehand, reset after).
    for (const pass of passes) {
      sh('adb', ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
      sh('adb', ['shell', 'settings', 'put', 'system', 'user_rotation', String(rotationValue(pass.orient, naturalLandscape))]);
      try {
        if (pass.orient === 'seam') {
          let halfOpenIdx = process.env.FOLD_HALF_OPEN_STATE
            ? Number(process.env.FOLD_HALF_OPEN_STATE)
            : null;
          if (halfOpenIdx === null) {
            const printStates = spawnSync('adb', ['shell', 'cmd', 'device_state', 'print-states'], { encoding: 'utf8', shell: true }).stdout ?? '';
            halfOpenIdx = parseHalfOpenedState(printStates);
          }
          if (halfOpenIdx === null) {
            throw new Error('Could not determine the fold half-open device_state index. Set FOLD_HALF_OPEN_STATE to override.');
          }
          sh('adb', ['shell', 'cmd', 'device_state', 'state', String(halfOpenIdx)]);
        }

        sh('flutter', [
          'drive',
          '--driver=test_driver/integration_test.dart',
          '--target=integration_test/marketing_capture_test.dart',
          ...buildDartDefines({ surface, orient: pass.orient, scenes: pass.scenes }),
        ], { cwd: androidDir });
      } finally {
        // Always restore rotation control — non-fatal so a restore hiccup
        // can't mask the real failure or skip the posture-reset check below.
        shSoft('adb', ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1']);
        // Only the fold seam pass changes posture; resetting it unconditionally
        // on every pass (including tablet passes, which never set it) risked a
        // fatal `sh()` call killing the script between the tablet landscape and
        // portrait passes.
        if (pass.orient === 'seam') {
          shSoft('adb', ['shell', 'cmd', 'device_state', 'state', 'reset']);
        }
      }
    }

    console.log('\n✔ Companion shots written to mockups/marketing-screens/companion/');
  } catch (e) {
    console.error(`\n✖ ${e.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
