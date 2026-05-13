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

if (process.env.SKIP_FFMPEG_PREFLIGHT === '1') process.exit(0);

function ffmpegOnSessionPath() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

if (ffmpegOnSessionPath()) process.exit(0);

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
    const key = scope === 'user'
      ? 'HKCU\\Environment'
      : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
    const r = spawnSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return [];
    const match = r.stdout.match(/Path\s+REG[^\s]*\s+([^\r\n]+)/);
    if (!match) return [];
    return match[1].split(';').map(s => s.trim()).filter(Boolean);
  }

  function expandEnv(p) {
    return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '');
  }

  function findFfmpegInDirs(dirs) {
    for (const dir of dirs) {
      try {
        const candidate = path.join(expandEnv(dir), 'ffmpeg.exe');
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* ignore unreadable segment */ }
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
  const tips = os.platform() === 'darwin'
    ? '  brew install ffmpeg'
    : '  apt install ffmpeg     # Debian/Ubuntu\n  dnf install ffmpeg     # Fedora';
  process.stderr.write(
    `\n${BOLD}${RED}[preflight] ffmpeg not found on PATH.${RESET}\n\n` +
    `The server shells out to ffmpeg for MP3 encoding. Install it:\n${tips}\n\n` +
    `${YELLOW}(Set SKIP_FFMPEG_PREFLIGHT=1 to skip this check.)${RESET}\n\n`,
  );
}

if (os.platform() === 'win32') emitWindowsHint();
else emitGenericHint();

process.exit(1);
