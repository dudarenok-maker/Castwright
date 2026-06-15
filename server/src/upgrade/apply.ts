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
import { dirname, join } from 'node:path';
import yauzl from 'yauzl';
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
import { planOrtSwap } from '../../tts-sidecar/scripts/install-ort.mjs';

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
  pipRan?: boolean;
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
        error:
          'The installed Python environment is incompatible with this release. ' +
          'A fresh reinstall is required (your books and voices are preserved).',
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
    return { ok: false, version: ctx.candidateVersion, releaseDir, phase, error: (err as Error).message, pipRan };
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
      mkdirSync(dirname(destFile), { recursive: true });
      const out = createWriteStream(destFile);
      stream.on('error', rej);
      out.on('error', rej);
      out.on('close', res);
      stream.pipe(out);
    });
  });
}

/** Extract a release zip into releaseDir, stripping the `topDir/` prefix. */
export function extractRelease(zipPath: string, releaseDir: string, topDir: string): Promise<void> {
  return new Promise((resolve2, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'));
      const prefix = `${topDir}/`;
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        if (!name.startsWith(prefix)) return zip.readEntry();
        const rel = name.slice(prefix.length);
        if (!rel) return zip.readEntry();
        const dest = join(releaseDir, rel);
        if (/\/$/.test(name)) {
          mkdirSync(dest, { recursive: true });
          zip.readEntry();
        } else {
          streamEntryToFile(zip, entry, dest)
            .then(() => zip.readEntry())
            .catch(reject);
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

/** Wire the real destructive steps. `venvDir` is the shared SIDECAR_VENV_DIR. */
export function createApplySteps(opts: { venvDir: string; log?: (m: string) => void }): ApplySteps {
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
      await run(npm, ['ci'], releaseDir);
      await run(npm, ['ci'], join(releaseDir, 'server'));
    },
    // Install the engine deps for the effective profile into the shared venv,
    // reading the CANDIDATE release's requirements/scripts: ROCm torch pre-install
    // (amd only) → the profile's requirements overlay → onnxruntime→directml swap
    // (amd-win only). For nvidia/cpu/apple this is just the overlay — same as the
    // old single requirements.txt install for nvidia.
    pipInstall: async (releaseDir) => {
      const profile = effectiveProfile();
      const sidecar = join(releaseDir, 'server', 'tts-sidecar');
      const torch = planTorchPreinstall(profile, process.platform);
      if (torch.action === 'install') {
        await run(venvPython, ['-m', 'pip', 'install', '--no-cache-dir', ...torch.wheels], releaseDir);
      }
      await run(
        venvPython,
        ['-m', 'pip', 'install', '-r', join(sidecar, 'requirements', overlayFileForProfile(profile))],
        releaseDir,
      );
      const ort = planOrtSwap(profile, process.platform);
      if (ort.action === 'swap') {
        for (const step of ort.steps) await run(venvPython, ['-m', 'pip', ...step], releaseDir);
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
      // rename is atomic on the same volume.
      rmSync(pointer, { force: true });
      const { renameSync } = await import('node:fs');
      renameSync(tmp, pointer);
    },
    spawnRestarter: ({ installRoot, releaseDir, oldPid }) => {
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
    },
    log: opts.log,
  };
}
