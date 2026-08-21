#!/usr/bin/env node
/* ffmpeg preflight — runs before `npm run dev`, `npm run test:server`, and
   anything that wraps them (verify, verify:quick, test:all). The MP3 encoder
   in server/src/tts/mp3.ts shells out to system ffmpeg; without it, chapter
   generation rejects mid-stream and `mp3.test.ts` silently skips its whole
   describe block. This script fails loudly with an actionable hint before
   the skip happens.

   The hint is OS-tailored: on Windows we additionally inspect the registry
   PATH (HKCU + HKLM) and `winget list` to distinguish:
   (a) ffmpeg not installed → tell the user to `winget install Gyan.FFmpeg`.
   (b) ffmpeg installed and on registry PATH but NOT on this session's PATH
       → tell them to open a fresh terminal (this is the trap that bit us:
       winget adds to PATH at install time, but already-open shells keep
       their stale env and every child process inherits it).

   Opt-out: set SKIP_FFMPEG_PREFLIGHT=1 to skip the check (useful for
   frontend-only iterations where ffmpeg genuinely isn't needed). */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/* ops-35 (#1877): we now need the banner TEXT, not just the exit code — the
   version lives in the first line of stdout. */
function probeFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, stdout: r.stdout || '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/* "ffmpeg version 6.1.1-3ubuntu5" -> "6.1"; "n6.1" -> "6.1".
   Git/nightly banners ("2026-01-01-git-abc1234", "N-114293-g...") carry no
   semver and yield null, which callers MUST treat as acceptable. */
function parseFfmpegVersion(stdout) {
  const m = /^ffmpeg version n?(\d+)\.(\d+)/m.exec(typeof stdout === 'string' ? stdout : '');
  return m ? `${m[1]}.${m[2]}` : null;
}

/* Numeric MAJOR.MINOR compare. Fails OPEN: an unparseable version or an
   absent floor is never "below". Failing a working install over a regex miss
   would be worse than the drift the floor guards against. */
function isBelowFloor(version, minimum) {
  if (!version || !minimum) return false;
  const [vMaj, vMin] = String(version).split('.').map(Number);
  const [fMaj, fMin] = String(minimum).split('.').map(Number);
  if (!Number.isFinite(vMaj) || !Number.isFinite(fMaj)) return false;
  if (vMaj !== fMaj) return vMaj < fMaj;
  return (vMin || 0) < (fMin || 0);
}

/* Single source of truth: root package.json's `castwright.ffmpeg.minimum`.
   Any read/parse failure yields null, which DISABLES the check rather than
   breaking every commit — this runs in pre-commit, pre-push and release. */
function readFfmpegFloor() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const min = pkg && pkg.castwright && pkg.castwright.ffmpeg && pkg.castwright.ffmpeg.minimum;
    return typeof min === 'string' && min ? min : null;
  } catch {
    return null;
  }
}

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function emitWindowsHint() {
  /* Read the canonical PATH from the registry — bypasses this session's
     possibly-stale $env:PATH. If ffmpeg is in the registry PATH, the user
     has it installed but their shell predates the install; the fix is
     "open a new terminal" not "install something." */
  function readRegistryPath(scope) {
    const key =
      scope === 'user'
        ? 'HKCU\\Environment'
        : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
    const r = spawnSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout) return [];
    const match = r.stdout.match(/Path\s+REG[^\s]*\s+([^\r\n]+)/);
    if (!match) return [];
    return match[1]
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function expandEnv(p) {
    return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '');
  }

  function findFfmpegInDirs(dirs) {
    for (const dir of dirs) {
      try {
        const candidate = path.join(expandEnv(dir), 'ffmpeg.exe');
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore unreadable segment */
      }
    }
    return null;
  }

  const registryDirs = [...readRegistryPath('user'), ...readRegistryPath('machine')];
  const registryHit = findFfmpegInDirs(registryDirs);

  if (registryHit) {
    process.stderr.write(
      `\n${BOLD}${RED}[preflight] ffmpeg not on this shell's PATH — but it IS installed.${RESET}\n\n` +
        `Found at:\n  ${registryHit}\n\n` +
        `That directory is on your User PATH in the registry, but the current\n` +
        `shell session was started before it was added. Every process npm spawns\n` +
        `inherits this stale PATH, so the MP3 encoder tests skip and chapter\n` +
        `generation rejects at the encode step.\n\n` +
        `${BOLD}Fix:${RESET} close this terminal, open a fresh PowerShell, and re-run the command.\n\n` +
        `(Or set ${BOLD}SKIP_FFMPEG_PREFLIGHT=1${RESET} for a single run if you don't need ffmpeg right now.)\n\n`,
    );
    return;
  }

  process.stderr.write(
    `\n${BOLD}${RED}[preflight] ffmpeg not found.${RESET}\n\n` +
      `The server encodes chapter audio to MP3 (LAME VBR V2) via system ffmpeg.\n` +
      `Without it, chapter generation rejects at the encode step.\n\n` +
      `${BOLD}Install:${RESET}\n  winget install Gyan.FFmpeg\n\n` +
      `Then ${BOLD}close + reopen this terminal${RESET} so the updated PATH is picked up.\n\n` +
      `(Or set ${BOLD}SKIP_FFMPEG_PREFLIGHT=1${RESET} for a single run if you don't need ffmpeg right now.)\n\n`,
  );
}

function emitGenericHint() {
  const tips =
    os.platform() === 'darwin'
      ? '  brew install ffmpeg'
      : '  apt install ffmpeg     # Debian/Ubuntu\n  dnf install ffmpeg     # Fedora';
  process.stderr.write(
    `\n${BOLD}${RED}[preflight] ffmpeg not found on PATH.${RESET}\n\n` +
      `The server shells out to ffmpeg for MP3 encoding. Install it:\n${tips}\n\n` +
      `${YELLOW}(Set SKIP_FFMPEG_PREFLIGHT=1 to skip this check.)${RESET}\n\n`,
  );
}

/* ops-35: present, but older than the declared support floor. Distinct copy
   from the "not installed" hints — the user has ffmpeg, they need to upgrade
   it, and the two remedies are different commands. */
function emitTooOldHint(found, minimum) {
  /* Do NOT recommend the `ffmpeg` snap here. Its stable channel is 4.3.1
     (published 2020-11-08, verified against api.snapcraft.io) — OLDER than
     Ubuntu 22.04's own archive build of 4.4.2. Telling a 22.04 user to swap
     to it downgrades them and leaves this warning up. There is no supported
     route to >=6.0 inside 22.04's own repositories, so say that plainly
     rather than inventing one. */
  const upgrade =
    os.platform() === 'win32'
      ? '  winget upgrade Gyan.FFmpeg'
      : os.platform() === 'darwin'
        ? '  brew upgrade ffmpeg'
        : '  sudo apt install ffmpeg        # Ubuntu 24.04+ / Debian 13+ ship 6.1+\n\n' +
          '  Ubuntu 22.04 tops out at ffmpeg 4.4 in its archive, and the `ffmpeg`\n' +
          '  snap is older still (4.3.1). Upgrade the OS, or install a newer build\n' +
          '  yourself and make sure it comes FIRST on PATH.';
  process.stderr.write(
    `\n${BOLD}${RED}[preflight] ffmpeg ${found} is older than Castwright supports.${RESET}\n\n` +
      `Castwright is tested against ffmpeg ${BOLD}${minimum}${RESET} and newer. The audio\n` +
      `pipeline parses ffmpeg's loudnorm JSON output, which is a version-sensitive\n` +
      `contract — older builds are not verified and may mis-normalise chapter audio.\n\n` +
      `${BOLD}Upgrade:${RESET}\n${upgrade}\n\n` +
      `(Or set ${BOLD}SKIP_FFMPEG_PREFLIGHT=1${RESET} for a single run.)\n\n`,
  );
}

function main() {
  if (process.env.SKIP_FFMPEG_PREFLIGHT === '1') return 0;

  const probe = probeFfmpeg();
  if (probe.ok) {
    const minimum = readFfmpegFloor();
    const found = parseFfmpegVersion(probe.stdout);
    if (isBelowFloor(found, minimum)) {
      emitTooOldHint(found, minimum);
      return 1;
    }
    return 0;
  }

  if (os.platform() === 'win32') emitWindowsHint();
  else emitGenericHint();
  return 1;
}

/* Side effects ONLY when run as a script. scripts/tests/ffmpeg-version.test.mjs
   requires this module to unit-test the parser — without this guard the
   require would run the check and process.exit(), silently killing the test
   run and scoring it as a pass. */
if (require.main === module) process.exit(main());

module.exports = { parseFfmpegVersion, isBelowFloor, readFfmpegFloor };
