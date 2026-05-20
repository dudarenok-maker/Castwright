#!/usr/bin/env node
/* Generate HTTPS certs for LAN access (mobile + tablet support, plan 81).

   Why this exists: mobile browsers — iOS Safari especially — flag every
   http://192.168.x.x URL as "Not Secure" and gate clipboard / file-picker
   / service-worker / mic / camera APIs behind secure contexts. mkcert is
   the canonical "my own LAN, my own devices" pattern: one-time root CA
   on the dev box, one-time per-device install of the public-half root,
   then every LAN HTTPS URL is trusted with no warning.

   This script:
     1. Probes for the `mkcert` CLI. Missing → prints per-OS install steps
        and exits 1.
     2. Runs `mkcert -install` (idempotent — adds the root CA to the OS
        trust store if not already there).
     3. Enumerates LAN IPv4 addresses (same logic as enumerateLanUrls).
     4. Calls `mkcert -cert-file .run/certs/lan-cert.pem
        -key-file .run/certs/lan-key.pem localhost 127.0.0.1 <lan ip 1>
        <lan ip 2> ...` to produce a single cert that covers loopback +
        every LAN interface.

   The output cert is read by:
     - `vite.config.ts` (via vite-plugin-mkcert when VITE_HTTPS=1 —
        independent code path, the plugin manages its own certs).
     - `server/src/index.ts` (when LAN_HTTPS=1 — reads these cert files
        directly to feed https.createServer).

   Cross-platform: Windows / macOS / Linux. */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const certDir = resolve(repoRoot, '.run', 'certs');
const certFile = resolve(certDir, 'lan-cert.pem');
const keyFile = resolve(certDir, 'lan-key.pem');

function info(msg) {
  process.stdout.write(`[setup-lan-certs] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[setup-lan-certs] [FAIL] ${msg}\n`);
  process.exit(1);
}

function tryMkcertVersion() {
  try {
    return execFileSync('mkcert', ['-version'], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function mkcertInstallInstructions() {
  switch (platform()) {
    case 'win32':
      return [
        '  Option A (scoop):  scoop bucket add extras && scoop install mkcert',
        '  Option B (choco):  choco install mkcert',
        '  Option C (winget): winget install FiloSottile.mkcert',
      ].join('\n');
    case 'darwin':
      return '  brew install mkcert nss';
    default:
      return [
        '  Debian/Ubuntu: sudo apt install libnss3-tools && curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64" && chmod +x mkcert-* && sudo mv mkcert-* /usr/local/bin/mkcert',
        '  Fedora:        sudo dnf install nss-tools mkcert',
        '  Arch:          sudo pacman -S mkcert',
      ].join('\n');
  }
}

export function enumerateLanIps() {
  const ips = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.internal) continue;
      if (iface.family !== 'IPv4') continue;
      if (iface.address.startsWith('169.254.')) continue;
      ips.push(iface.address);
    }
  }
  return ips;
}

export async function setupLanCerts({ silent = false } = {}) {
  const log = silent ? () => {} : info;
  const version = tryMkcertVersion();
  if (!version) {
    process.stderr.write('\n[setup-lan-certs] mkcert is not on PATH.\n\n');
    process.stderr.write('Install it once with one of:\n');
    process.stderr.write(`${mkcertInstallInstructions()}\n\n`);
    process.stderr.write('Then re-run this script.\n');
    process.exit(1);
  }
  log(`mkcert detected: ${version}`);

  try {
    execFileSync('mkcert', ['-install'], {
      stdio: silent ? 'ignore' : 'inherit',
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (err) {
    fail(`mkcert -install failed: ${err?.message ?? err}`);
  }

  mkdirSync(certDir, { recursive: true });

  const ips = enumerateLanIps();
  const hosts = ['localhost', '127.0.0.1', ...ips];
  log(`generating cert for hosts: ${hosts.join(', ')}`);

  try {
    execFileSync('mkcert', ['-cert-file', certFile, '-key-file', keyFile, ...hosts], {
      stdio: silent ? 'ignore' : 'inherit',
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (err) {
    fail(`mkcert cert generation failed: ${err?.message ?? err}`);
  }

  if (!existsSync(certFile) || !existsSync(keyFile)) {
    fail(`mkcert reported success but cert files are missing at ${certDir}`);
  }
  log(`cert: ${certFile}`);
  log(`key:  ${keyFile}`);
  return { certFile, keyFile, lanIps: ips };
}

// CLI entrypoint — when invoked directly, run setup + exit.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('setup-lan-certs.mjs')) {
  await setupLanCerts();
}
