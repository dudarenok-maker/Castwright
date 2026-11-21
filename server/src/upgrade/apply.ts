/* fs-1 — apply a validated, staged release zip in the versioned-dir layout.

   The swap NEVER touches the running release. It extracts into a FRESH
   releases/v<candidate>/ sibling, installs deps, conditionally reinstalls the
   shared venv, then flips the .current-version pointer (the atomic commit) and
   spawns the detached restarter. Failure BEFORE the flip leaves the pointer
   untouched, so the next launch still runs the old release — and the
   half-written candidate dir is removed. The destructive steps are injected so
   the orchestration + rollback are unit-tested with fakes; createApplySteps()
   wires the real fs/child_process implementations. */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import yauzl from 'yauzl';
import { refuseUnderVitest } from '../system/refuse-under-vitest.js';
import { requestFailureMessageFs } from '../workspace/file-lock.js';
import {
  classifyVenvState,
  readStamp,
  resolveRequired,
  overlayFileForProfile,
  type VenvStamp,
} from '../../tts-sidecar/scripts/venv-migration.mjs';
// @ts-expect-error — standalone install scripts ship no .d.ts; pure helpers are plain JS.
import { resolveInstallProfile } from '../../tts-sidecar/scripts/accelerator-profile.mjs';
// @ts-expect-error — standalone install scripts ship no .d.ts; pure helpers are plain JS.
import { planTorchPreinstall } from '../../tts-sidecar/scripts/install-torch.mjs';
// @ts-expect-error — standalone install scripts ship no .d.ts; pure helpers are plain JS.
import { planOrtSwap, applyOrtMarkerDelete, applyOrtMarkerWrite } from '../../tts-sidecar/scripts/install-ort.mjs';

export interface ApplyContext {
  installRoot: string;
  releasesDir: string;
  stagedZipPath: string;
  topDir: string; // castwright-vX.Y.Z (zip prefix to strip)
  candidateVersion: string;
  reqHash: string | null;
  oldPid: number | null;
}

export interface ApplySteps {
  /** Remove a directory tree (used to clear a partial candidate on rollback). */
  rmDir: (dir: string) => Promise<void>;
  exists: (p: string) => boolean;
  /** Extract the zip into releaseDir, stripping the topDir prefix. */
  extract: (zipPath: string, releaseDir: string, topDir: string) => Promise<void>;
  /** npm ci in the release root + server/. */
  npmCi: (releaseDir: string) => Promise<void>;
  /** pip install -r requirements.txt into the shared venv. */
  pipInstall: (releaseDir: string) => Promise<void>;
  /** The shared venv's recorded requirements hash (null if never installed). */
  readReqHash: () => string | null;
  writeReqHash: (hash: string) => void;
  /** The shared venv's stamp (null on a missing/corrupt/old-v1.7.0 stamp). */
  readStamp: () => VenvStamp | null;
  /** What the CANDIDATE release requires, read from its extracted sidecar dir. */
  resolveRequired: (sidecarDir: string) => VenvStamp;
  /** Atomic .current-version pointer flip — the commit point. */
  flipPointer: (installRoot: string, version: string) => Promise<void>;
  /** Spawn the detached restarter (waits for oldPid, then runs launch.mjs). */
  spawnRestarter: (opts: { installRoot: string; releaseDir: string; oldPid: number | null }) => void;
  log?: (msg: string) => void;
}

export type ApplyPhase =
  | 'extract'
  | 'npm-ci'
  | 'needs-reinstall'
  | 'pip-install'
  | 'flip'
  | 'restart'
  | 'done';

export interface ApplyResult {
  ok: boolean;
  version: string;
  releaseDir: string;
  phase: ApplyPhase;
  error?: string;
  /** Curated twin of `error`, safe for non-loopback (LAN) clients: fs errors are
   *  reduced to a fixed path-free sentence, computed from the original Error
   *  (#4322). `error` stays raw for loopback. */
  errorLan?: string;
  pipRan?: boolean;
}

const NEEDS_REINSTALL_MESSAGE =
  'The installed Python environment is incompatible with this release. ' +
  'A fresh reinstall is required (your books and voices are preserved).';

/* The child-process steps (npm ci, pip, the ORT marker write) fail with plain
   Errors whose message is a full command line or a path (`run()`'s
   `<abs python> -m pip install -r <abs requirements> exited 1`, a spawn ENOENT
   on the absolute interpreter, the ORT marker's venv dir). requestFailureMessageFs
   passes plain Errors through, so for those phases the LAN reason is a fixed
   path-free sentence naming the step; an fs error inside them still gets the
   shared fs curation. */
const STEP_FAILURE_LAN: Partial<Record<ApplyPhase, string>> = {
  'npm-ci': 'The dependency install step (npm) failed. See the server log for details.',
  'pip-install': 'The dependency install step (pip) failed. See the server log for details.',
};

/* Fail closed: a phase with no entry above (a step added later) gets this fixed
   sentence rather than its raw message. extract is the one deliberate
   pass-through � its plain Errors are yauzl/zlib parse messages that name no
   host path (an fs error there is still curated by requestFailureMessageFs). */
const UNMAPPED_STEP_LAN = 'The upgrade failed. See the server log for details.';

function curateFailureForLan(err: unknown, phase: ApplyPhase): string {
  const fallback = phase === 'extract' ? (err as Error).message : (STEP_FAILURE_LAN[phase] ?? UNMAPPED_STEP_LAN);
  return requestFailureMessageFs(err, fallback);
}

export async function applyUpgrade(ctx: ApplyContext, steps: ApplySteps): Promise<ApplyResult> {
  const log = steps.log ?? (() => {});
  const releaseDir = join(ctx.releasesDir, `v${ctx.candidateVersion}`);
  let phase: ApplyPhase = 'extract';
  let pipRan = false;

  try {
    // A leftover partial candidate dir from a prior aborted apply — clear it so
    // extraction starts clean. (We never clear the RUNNING release.)
    if (steps.exists(releaseDir)) await steps.rmDir(releaseDir);

    log(`[upgrade] extracting v${ctx.candidateVersion} → ${releaseDir}`);
    await steps.extract(ctx.stagedZipPath, releaseDir, ctx.topDir);

    phase = 'npm-ci';
    log('[upgrade] npm ci (root + server)');
    await steps.npmCi(releaseDir);

    // Detect-and-reinstall guard (R2): compare the SHARED venv's stamp against
    // the CANDIDATE release's declared requirements (read from the extracted
    // release's sidecar dir — not this running old code). A Python/profile
    // mismatch (e.g. an alpha box's 3.11 venv vs a 3.12 release) classifies as
    // 'needs-reinstall' — we must NOT pip the new deps into the old interpreter.
    // Bail before pip-install/flip so the OLD release stays current (fail-safe).
    const required = steps.resolveRequired(join(releaseDir, 'server', 'tts-sidecar'));
    const { action } = classifyVenvState({
      venvExists: true,
      stamp: steps.readStamp(),
      required,
    });
    if (action === 'needs-reinstall') {
      phase = 'needs-reinstall';
      log('[upgrade] shared venv is incompatible with the candidate release — reinstall required');
      // Drop the extracted candidate; the old release (pointer untouched) stays current.
      try {
        if (steps.exists(releaseDir)) await steps.rmDir(releaseDir);
      } catch {
        /* best-effort cleanup */
      }
      return {
        ok: false,
        version: ctx.candidateVersion,
        releaseDir,
        phase,
        error: NEEDS_REINSTALL_MESSAGE,
        errorLan: NEEDS_REINSTALL_MESSAGE,
        pipRan,
      };
    }

    phase = 'pip-install';
    if (ctx.reqHash && ctx.reqHash !== steps.readReqHash()) {
      log('[upgrade] requirements.txt changed — pip install into shared venv');
      await steps.pipInstall(releaseDir);
      steps.writeReqHash(ctx.reqHash);
      pipRan = true;
    }
  } catch (err) {
    // Pre-flip failure: pointer untouched (old release still current); drop the
    // half-written candidate so the next attempt starts clean.
    try {
      if (steps.exists(releaseDir)) await steps.rmDir(releaseDir);
    } catch {
      /* best-effort cleanup */
    }
    return {
      ok: false,
      version: ctx.candidateVersion,
      releaseDir,
      phase,
      error: (err as Error).message,
      errorLan: curateFailureForLan(err, phase),
      pipRan,
    };
  }

  // COMMIT POINT — flip the pointer, then hand off to the detached restarter.
  phase = 'flip';
  await steps.flipPointer(ctx.installRoot, ctx.candidateVersion);
  phase = 'restart';
  steps.spawnRestarter({ installRoot: ctx.installRoot, releaseDir, oldPid: ctx.oldPid });
  log(`[upgrade] pointer flipped to v${ctx.candidateVersion}; restarter spawned.`);
  return { ok: true, version: ctx.candidateVersion, releaseDir, phase: 'done', pipRan };
}

/* ── Real step implementations ─────────────────────────────────────────── */

function isWin(): boolean {
  return process.platform === 'win32';
}

function streamEntryToFile(zip: yauzl.ZipFile, entry: yauzl.Entry, destFile: string): Promise<void> {
  return new Promise((res, rej) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return rej(err ?? new Error('read stream failed'));
      // Synchronous throw inside a yauzl callback would escape as an
      // uncaughtException (server exit) instead of rejecting (#4322).
      try {
        mkdirSync(dirname(destFile), { recursive: true });
      } catch (e) {
        // yauzl's RefUnrefFilter holds its own ref on the zip until the entry's
        // read stream is destroyed; zip.close() alone would not release it.
        stream.destroy();
        return rej(e);
      }
      // pipeline destroys BOTH streams on either side's error (pipe() would
      // leave the write fd open when the source fails).
      pipeline(stream, createWriteStream(destFile)).then(() => res(), rej);
    });
  });
}

/** Extract a release zip into releaseDir, stripping the `topDir/` prefix. */
export function extractRelease(zipPath: string, releaseDir: string, topDir: string): Promise<void> {
  return new Promise((resolve2, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      // autoClose only fires on 'end' / yauzl's own error path, so every other
      // reject must release the fd itself (a held handle blocks renaming any
      // directory containing the zip on Windows).
      const fail = (e: unknown) => {
        zip.close();
        reject(e);
      };
      const prefix = `${topDir}/`;
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (!name.startsWith(prefix)) return zip.readEntry();
        const rel = name.slice(prefix.length);
        if (!rel) return zip.readEntry();
        const dest = join(releaseDir, rel);
        if (/\/$/.test(name)) {
          try {
            mkdirSync(dest, { recursive: true });
          } catch (e) {
            return fail(e);
          }
          zip.readEntry();
        } else {
          streamEntryToFile(zip, entry, dest)
            .then(() => zip.readEntry())
            .catch(fail);
        }
      });
      zip.on('end', () => resolve2());
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: isWin(), windowsHide: true });
    child.on('error', rej);
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

/** Injectable seam for `pipInstall`'s destructive calls, so its body — otherwise
 *  a real `pip`/marker fs write — can be unit-tested with fakes. Defaults to the
 *  real `run`/`applyOrtMarkerDelete`/`applyOrtMarkerWrite` when omitted. */
export interface ApplyStepDeps {
  run?: (py: string, args: string[], cwd: string) => Promise<void>;
  markerDel?: (venvDir: string, plan: unknown) => void;
  markerWrite?: (venvDir: string, plan: unknown) => void;
}

/** Wire the real destructive steps. `venvDir` is the shared SIDECAR_VENV_DIR. */
export function createApplySteps(
  opts: { venvDir: string; log?: (m: string) => void },
  deps: ApplyStepDeps = {},
): ApplySteps {
  const runFn =
    deps.run ??
    refuseUnderVitest(run, 'createApplySteps: real spawn refused under vitest (#3712); inject deps.run');
  const markerDel = deps.markerDel ?? applyOrtMarkerDelete;
  const markerWrite = deps.markerWrite ?? applyOrtMarkerWrite;
  const npm = isWin() ? 'npm.cmd' : 'npm';
  const reqHashFile = join(opts.venvDir, '.req-hash');
  const venvPython = isWin()
    ? join(opts.venvDir, 'Scripts', 'python.exe')
    : join(opts.venvDir, 'bin', 'python');

  // Effective profile for THIS box, memoised so the GPU probe runs once across
  // the resolveRequired + pipInstall steps. Carry-forward (the shared venv's
  // stamped profile) beats detection so an existing install is never force-
  // migrated; an explicit ACCELERATOR override switches it (→ needs-reinstall).
  let cachedProfile: string | undefined;
  const effectiveProfile = (): string => {
    if (cachedProfile === undefined) {
      const resolved: string = resolveInstallProfile({
        envOverride: process.env.ACCELERATOR ?? null,
        stampProfile: readStamp(opts.venvDir)?.profile ?? null,
        platform: process.platform,
      });
      cachedProfile = resolved;
    }
    return cachedProfile;
  };

  return {
    rmDir: async (dir) => rmSync(dir, { recursive: true, force: true }),
    exists: existsSync,
    extract: extractRelease,
    npmCi: async (releaseDir) => {
      await runFn(npm, ['ci'], releaseDir);
      await runFn(npm, ['ci'], join(releaseDir, 'server'));
    },
    // Install the engine deps for the effective profile into the shared venv,
    // reading the CANDIDATE release's requirements/scripts: ROCm torch pre-install
    // (amd only) → the profile's requirements overlay → onnxruntime→directml swap
    // (amd-win only). For nvidia/cpu/apple this is just the overlay — same as the
    // old single requirements.txt install for nvidia.
    pipInstall: async (releaseDir) => {
      const profile = effectiveProfile();
      const sidecar = join(releaseDir, 'server', 'tts-sidecar');
      const plan = planOrtSwap(profile, process.platform);
      // Delete FIRST, before the first pip call: a stale marker present when the
      // overlay lands plain onnxruntime would make a later re-check see it as
      // already-swapped. Safe to call unconditionally — it's a no-op off ours.
      markerDel(opts.venvDir, plan);

      const torch = planTorchPreinstall(profile, process.platform);
      if (torch.action === 'install') {
        await runFn(venvPython, ['-m', 'pip', 'install', '--no-cache-dir', ...torch.wheels], releaseDir);
      }
      await runFn(
        venvPython,
        ['-m', 'pip', 'install', '-r', join(sidecar, 'requirements', overlayFileForProfile(profile))],
        releaseDir,
      );
      if (plan.action === 'swap') {
        try {
          for (const step of plan.steps) await runFn(venvPython, ['-m', 'pip', ...step], releaseDir);
        } catch (err) {
          markerDel(opts.venvDir, plan);
          throw err;
        }
        // Write LAST, only after every swap step succeeded.
        markerWrite(opts.venvDir, plan);
      }
    },
    readReqHash: () => {
      try {
        return readFileSync(reqHashFile, 'utf8').trim();
      } catch {
        return null;
      }
    },
    writeReqHash: (hash) => {
      mkdirSync(dirname(reqHashFile), { recursive: true });
      writeFileSync(reqHashFile, hash, 'utf8');
    },
    // Read the shared venv's stamp + the candidate release's required descriptor
    // via the pure venv-migration core (the same functions bootstrap-venv.mjs
    // uses), so the two install paths can never disagree (S3).
    readStamp: () => readStamp(opts.venvDir),
    resolveRequired: (sidecarDir) => resolveRequired(sidecarDir, effectiveProfile()),
    flipPointer: async (installRoot, version) => {
      const pointer = join(installRoot, '.current-version');
      const tmp = `${pointer}.tmp`;
      writeFileSync(tmp, version, 'utf8');
      // rename is atomic on the same volume, and replaces an existing pointer.
      // On Windows it fails with EPERM/EACCES/EBUSY while the pointer is
      // read-only or held open by another process, so clear the read-only bit
      // and retry for about a second. The pointer is never deleted first.
      const { renameSync, chmodSync } = await import('node:fs');
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(tmp, pointer);
          return;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (attempt >= 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw err;
          try {
            chmodSync(pointer, 0o666);
          } catch {
            /* retry regardless */
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    },
    spawnRestarter: refuseUnderVitest(({ installRoot, releaseDir, oldPid }) => {
      // The restarter ships inside the just-extracted release; it runs the
      // STABLE installRoot/launch.mjs once the old server exits.
      const inRelease = join(releaseDir, 'scripts', 'restart-after-upgrade.mjs');
      const restarterScript = existsSync(inRelease)
        ? inRelease
        : join(installRoot, 'scripts', 'restart-after-upgrade.mjs');
      const child = spawn(process.execPath, [restarterScript], {
        cwd: installRoot,
        env: {
          ...process.env,
          UPGRADE_OLD_PID: oldPid != null ? String(oldPid) : '',
          UPGRADE_INSTALL_ROOT: installRoot,
        },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    }, 'createApplySteps: real spawn refused under vitest (#3712); the restarter is never run in tests'),
    log: opts.log,
  };
}
