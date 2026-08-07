#!/usr/bin/env node
// install-ort.mjs — the ONNX-runtime swap that puts the RIGHT Kokoro runtime in
// place after the requirements overlay. The overlay always installs plain
// `onnxruntime` (kokoro-onnx's core dependency — see requirements/nvidia-cuda.txt),
// so any profile whose Kokoro must run on a GPU runtime has to REPLACE that module
// with the accelerator-specific one (they all share the `onnxruntime` import name
// and can't co-exist reliably):
//   - nvidia  → onnxruntime-gpu      (CUDAExecutionProvider)
//   - amd-win → onnxruntime-directml (disabled after S0.1 — Kokoro stays CPU)
//   - cpu/apple → no swap (plain onnxruntime is correct)
// This is the SINGLE enforcement point for GPU Kokoro: we deliberately do NOT lean
// on `kokoro-onnx[gpu]`, because that extra coexists with the core `onnxruntime`
// dep and pip's resolution order can leave the CPU build owning the namespace — a
// silent CPU-only Kokoro on a GPU box (the 2026-06-16 regression). Runs AFTER the
// overlay install (bootstrap-venv.mjs wires it into every profile's flow).
// Pure planner (planOrtSwap) + guarded CLI, mirroring install-torch.mjs.
//
// Usage (the bootstrap wires this; manual form for testing):
//   CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node install-ort.mjs <venv-python>
//
// NOTE: the minimum working onnxruntime-directml version (the release carrying
// the Kokoro ConvTranspose fix) is OWED on real AMD hardware (Wave H1). Until
// pinned there, we install the latest.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installRecipe, PROFILES } from './accelerator-profile.mjs';

/** Distribution names that OWN the onnxruntime namespace on some profile.
 *  DERIVED from installRecipe, never hand-typed — a hand-typed list is a second
 *  source of truth for a set installRecipe already determines, and would miss a
 *  future onnxruntime-directml re-enable. */
export const SWAP_ORT_PACKAGES = [
  ...new Set(
    PROFILES.flatMap((p) =>
      ['win32', 'linux', 'darwin'].map((plat) => installRecipe(p, plat).ortPackage),
    ).filter((pkg) => pkg !== 'onnxruntime'),
  ),
];

/** PEP 427 escaping: pip writes `onnxruntime-gpu` to disk as `onnxruntime_gpu`.
 *  Globbing the UNESCAPED name matches zero directories — which, combined with
 *  the fail-loudly rule, would break every NVIDIA bootstrap. */
export function escapeDistName(name) {
  return name.replace(/[-_.]+/g, '_');
}

/** Resolve site-packages inside a venv dir. Pure fs — no interpreter spawn.
 *  Returns null when absent or ambiguous; callers treat null as "do nothing". */
export function sitePackagesDir(venvDir) {
  const win = join(venvDir, 'Lib', 'site-packages');
  if (existsSync(win)) return win;
  const libDir = join(venvDir, 'lib');
  if (!existsSync(libDir)) return null;
  const hits = readdirSync(libDir)
    .filter((d) => d.startsWith('python'))
    .map((d) => join(libDir, d, 'site-packages'))
    .filter((p) => existsSync(p));
  return hits.length === 1 ? hits[0] : null;
}

export const MARKER_INSTALLER = 'castwright-ort-marker';

/** Every `onnxruntime-<version>.dist-info` in site-packages — ours AND real ones.
 *  The trailing `-\d` is what excludes `onnxruntime_gpu-…` (underscore at index 11). */
function ortDistInfoDirs(sitePackages) {
  if (!existsSync(sitePackages)) return [];
  return readdirSync(sitePackages)
    .filter((d) => /^onnxruntime-\d.*\.dist-info$/.test(d))
    .map((d) => join(sitePackages, d));
}

/** Ours ONLY if the INSTALLER is our sentinel AND the RECORD is empty.
 *  Name is never sufficient: the real plain distribution's directory name is
 *  byte-identical to ours. */
export function isOurMarker(distInfoDir) {
  try {
    const installer = readFileSync(join(distInfoDir, 'INSTALLER'), 'utf8').trim();
    if (installer !== MARKER_INSTALLER) return false;
    return readFileSync(join(distInfoDir, 'RECORD'), 'utf8').trim() === '';
  } catch {
    return false;
  }
}

/** Real (non-marker) plain onnxruntime distributions. Tests EVERY match — ours
 *  and a real one can coexist, so answering from the first is a false negative. */
export function findPlainOrtDistInfos(sitePackages) {
  return ortDistInfoDirs(sitePackages).filter((d) => !isOurMarker(d));
}

/** Who owns site-packages/onnxruntime/ — decided from FILES the wheel ships.
 *  'swap'  → a swap distribution (onnxruntime-gpu / -directml)
 *  'plain' → the CPU build
 *  'none'  → absent or gutted (nothing importable)
 *  NEVER uses import/get_available_providers(): __version__ is identical across
 *  builds, and a GPU install with unloadable CUDA DLLs reports CPU providers. */
export function detectOrtOwner(sitePackages) {
  const capi = join(sitePackages, 'onnxruntime', 'capi');
  if (!existsSync(capi)) return 'none';
  let entries;
  try {
    entries = readdirSync(capi);
  } catch {
    return 'none';
  }
  if (entries.length === 0) return 'none';

  const infoPath = join(capi, 'build_and_package_info.py');
  if (existsSync(infoPath)) {
    try {
      const m = readFileSync(infoPath, 'utf8').match(/package_name\s*=\s*['"]([^'"]+)['"]/);
      if (m) return SWAP_ORT_PACKAGES.includes(m[1]) ? 'swap' : 'plain';
    } catch {
      /* fall through to the DLL signal */
    }
  }
  if (entries.some((e) => /^onnxruntime_providers_(cuda|rocm)\./.test(e))) return 'swap';
  return 'plain';
}

/** Write (or overwrite) the marker. Removes any stale marker first so the
 *  version can never lag the installed runtime. */
export function writeOrtMarker(sitePackages, version) {
  deleteOrtMarkerIfOurs(sitePackages);
  const dir = join(sitePackages, `onnxruntime-${version}.dist-info`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'METADATA'),
    `Metadata-Version: 2.1\nName: onnxruntime\nVersion: ${version}\n` +
      `Summary: Provided by ${SWAP_ORT_PACKAGES.join('/')} (same namespace, same API).\n`,
  );
  writeFileSync(join(dir, 'INSTALLER'), `${MARKER_INSTALLER}\n`);
  writeFileSync(join(dir, 'RECORD'), ''); // MUST stay empty — see the spec's Spike 2
}

/** Delete the marker if (and only if) we wrote it. Returns whether it removed one. */
export function deleteOrtMarkerIfOurs(sitePackages) {
  let removed = false;
  for (const dir of ortDistInfoDirs(sitePackages)) {
    if (!isOurMarker(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

/** Version of the installed swap distribution, read from its dist-info METADATA.
 *  null when absent OR ambiguous — the caller treats null as fatal for a swap
 *  (better a loud install failure than a marker whose version is a guess). */
export function readInstalledOrtVersion(sitePackages, ortPackage) {
  if (!existsSync(sitePackages)) return null;
  const prefix = `${escapeDistName(ortPackage)}-`;
  const hits = readdirSync(sitePackages).filter(
    (d) => d.startsWith(prefix) && d.endsWith('.dist-info'),
  );
  if (hits.length !== 1) return null;
  try {
    const meta = readFileSync(join(sitePackages, hits[0], 'METADATA'), 'utf8');
    const m = meta.match(/^Version:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// onnxruntime-gpu version constraint (side-28): without one, the runtime a user
// actually runs Kokoro on is whatever happened to be latest on PyPI on their
// install date — this dev box validated 1.27.0, a fresh install today lands
// 1.28.0, and nobody chose that drift on purpose. Floor-plus-cap on the MINOR
// line rather than an exact `==` so a same-line patch release (a security fix)
// still flows without a code change; only crossing the minor boundary needs a
// deliberate bump of this constant (bump the runtime and this pin together,
// once 1.28 is desk-validated — never bump one without the other).
// This is the ONLY place the constraint can live: it must NOT move into
// requirements/*.txt, because onnxruntime-gpu can never appear there AT ALL —
// those overlays are also read on macOS (no onnxruntime-gpu wheel exists for
// Apple Silicon), and test_no_bare_unmarked_onnxruntime_gpu
// (tests/test_requirements.py) enforces that a bare, unmarked
// `onnxruntime-gpu` line never lands there and aborts `pip install` on that
// platform. The swap in this file is reached only for the nvidia profile
// (win/linux), so pinning it here never touches the mac path.
const ONNXRUNTIME_GPU_CONSTRAINT = '>=1.27,<1.28';

/**
 * Apply the onnxruntime-gpu version constraint to an ortPackage name for the
 * INSTALL step only — the uninstall step takes bare package names (a version
 * spec there is meaningless to `pip uninstall` and would be a silent no-op).
 * Any other ortPackage (e.g. a future onnxruntime-directml re-enable) installs
 * unconstrained until it has its own desk-validated line. Pure — no I/O.
 * @returns {string}
 */
function constrainForInstall(ortPackage) {
  return ortPackage === 'onnxruntime-gpu'
    ? `onnxruntime-gpu${ONNXRUNTIME_GPU_CONSTRAINT}`
    : ortPackage;
}

/**
 * Decide the ordered pip steps to put the correct ONNX runtime in place after the
 * overlay install. The overlay always lands plain `onnxruntime` (kokoro-onnx's
 * core dep), so any profile whose recipe needs a different ortPackage (nvidia →
 * onnxruntime-gpu; a future DirectML re-enable → onnxruntime-directml) is a swap;
 * a recipe that already wants plain `onnxruntime` (cpu/amd/apple) is a no-op. Pure
 * — no I/O. `steps` are pip sub-command arg arrays, run in order with the venv
 * python. `ortPackage` on the swap variant lets the CLI report which package it
 * actually put in place without re-deriving it (#1844) — a second source of
 * truth there is exactly how the CLI drifted into naming the wrong package.
 * @returns {{action:'skip', reason:string, marker:{action:string}} | {action:'swap', steps:string[][], ortPackage:string, marker:{action:string}}}
 */
export function planOrtSwap(profile, platform) {
  const { ortPackage } = installRecipe(profile, platform);
  if (ortPackage === 'onnxruntime') {
    return {
      action: 'skip',
      reason: 'plain onnxruntime from the overlay is correct; no swap',
      marker: { action: 'delete' },
    };
  }
  return {
    action: 'swap',
    ortPackage,
    marker: { action: 'write' },
    steps: [
      // Uninstall BOTH the plain `onnxruntime` the overlay landed AND any cached
      // `ortPackage` first, so the shared `onnxruntime/` namespace directory is
      // fully cleared — then `--force-reinstall` lays ortPackage's files fresh.
      // A plain `install ortPackage` is a NO-OP when ortPackage is already cached
      // (at a skewed version — e.g. the overlay pulls onnxruntime 1.27.0 but
      // onnxruntime-gpu 1.26.0 is in pip's cache): pip reports "already
      // satisfied" and skips, leaving the namespace half-overwritten by the
      // just-uninstalled onnxruntime → `import onnxruntime` breaks (no
      // __version__/get_available_providers) and Kokoro silently fails to load.
      // `--no-deps` keeps the overlay's numpy/protobuf/etc. pins untouched.
      ['uninstall', '-y', 'onnxruntime', ortPackage],
      ['install', '--force-reinstall', '--no-deps', constrainForInstall(ortPackage)],
    ],
  };
}

/** Delete our marker. Safe on every plan and every venv shape — the failure
 *  path calls it with a SWAP plan before re-throwing. */
export function applyOrtMarkerDelete(venvDir, _plan) {
  const sp = sitePackagesDir(venvDir);
  if (!sp) return;
  deleteOrtMarkerIfOurs(sp);
}

/** Write the marker. NO-OP unless the plan says write — the skip variant has no
 *  ortPackage, so a write there would glob `undefined-*` and either resolve
 *  nothing or overwrite the REAL plain distribution. */
export function applyOrtMarkerWrite(venvDir, plan) {
  if (plan?.marker?.action !== 'write') return;
  const sp = sitePackagesDir(venvDir);
  if (!sp) throw new Error(`ORT marker: no site-packages under ${venvDir}`);
  const version = readInstalledOrtVersion(sp, plan.ortPackage);
  if (!version) {
    throw new Error(
      `ORT marker: could not read the installed ${plan.ortPackage} version (absent or ambiguous)`,
    );
  }
  writeOrtMarker(sp, version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profile = process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? 'nvidia';
  const plan = planOrtSwap(profile, process.platform);
  if (plan.action === 'skip') {
    process.stdout.write(`[install-ort] skip — ${plan.reason}.\n`);
    process.exit(0);
  }
  const python = process.argv[2]; // venv python path
  if (!python) {
    process.stderr.write('[install-ort] FAIL: pass the venv python path as the first arg.\n');
    process.exit(1);
  }
  for (const step of plan.steps) {
    process.stdout.write(`[install-ort] pip ${step.join(' ')}\n`);
    const code =
      spawnSync(python, ['-m', 'pip', ...step], { stdio: 'inherit', windowsHide: true }).status ?? 1;
    if (code !== 0) {
      process.stderr.write(`[install-ort] FAIL: pip ${step.join(' ')} exited ${code}.\n`);
      process.exit(code);
    }
  }
  process.stdout.write(`[install-ort] ${plan.ortPackage} in place.\n`);
  process.exit(0);
}
