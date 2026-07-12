#!/usr/bin/env node
/* `npm run install:cert-mobile` — first-time-setup walkthrough for accessing
   the app over LAN HTTPS from a phone or tablet (plan 81 mobile + tablet
   support).

   Flow:
     1. Run setupLanCerts() — ensures mkcert is installed, generates per-LAN-IP
        certs, drops them under .run/certs/.
     2. Print LAN URLs (HTTPS) for both Vite (5173) and Node (8443).
     3. Print an ASCII QR code linking to https://<lan-ip>:8443/cert/root.crt
        so the user can scan with their phone and download the root CA.
     4. Print per-OS install steps (iOS / iPadOS / Android / macOS / Windows).

   No automation past printing — installing a root CA is a deliberate,
   security-sensitive action the user makes on each device. We make it easy
   to do, not invisible. */

import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode';
import { setupLanCerts } from './setup-lan-certs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function line(s = '') {
  process.stdout.write(`${s}\n`);
}
function rule(label) {
  line('');
  line(`──── ${label} ${'─'.repeat(Math.max(0, 70 - label.length - 6))}`);
  line('');
}

async function asciiQr(text) {
  return qrcode.toString(text, { type: 'terminal', small: true });
}

const certs = await setupLanCerts();
if (certs === null) {
  // setupLanCerts already printed the mkcert install guidance / failure reason.
  process.stderr.write(
    '\n[cert-mobile] LAN certs were not created — install mkcert (see above) and re-run `npm run install:cert-mobile`.\n',
  );
  process.exit(1);
}
const { lanIps } = certs;

if (lanIps.length === 0) {
  line('');
  line('No LAN IPv4 addresses detected. Are you connected to a network?');
  line('Loopback URLs (https://localhost:5173 and https://localhost:8443) still work for testing on the dev box.');
  process.exit(0);
}

const primaryIp = lanIps[0];
const certUrl = `https://${primaryIp}:8443/cert/root.crt`;
const viteUrl = `https://${primaryIp}:5173`;
const nodeUrl = `https://${primaryIp}:8443`;

rule('LAN URLs');
line(`Vite dev (HMR):     ${viteUrl}        (run with: npm run dev:lan)`);
line(`Node prod bundle:   ${nodeUrl}        (run with: npm run start:lan)`);
line('');
line('Friendly hostnames (same servers, each served by exactly one command):');
line('  https://castwright.dev.local:5173   (Vite dev, run with: npm run dev:lan)');
line('  https://castwright.local:8443       (Node prod bundle, run with: npm run start:lan)');
line('  iOS / Android / macOS resolve .local names automatically. A Windows LAN');
line('  peer may need Bonjour installed to resolve them — the LAN-IP URLs above');
line('  always work as a fallback.');
if (lanIps.length > 1) {
  line('');
  line(`Other LAN IPs:  ${lanIps.slice(1).join(', ')}`);
}

rule('Step 1 — Scan with your phone or tablet');
line(`The QR code below links to:  ${certUrl}`);
line('Scan it from the device that needs LAN HTTPS access. Then your device downloads the root CA file.');
line('');
line('(Make sure `npm run start:lan` is running on the dev box, OR start it now in another terminal, so the QR URL responds.)');
line('');
line(await asciiQr(certUrl));

rule('Step 2 — Trust the root CA on each device');
line('iOS / iPadOS (Safari + every app):');
line('  1. Tap "Allow" on the profile-download banner.');
line('  2. Settings → "Profile Downloaded" → Install (enter passcode).');
line('  3. Settings → General → About → Certificate Trust Settings → toggle "mkcert ..." ON.');
line('  Done. https://<lan-ip>:8443 now shows a lock icon, no warning.');
line('');
line('Android (Chrome, Firefox, etc.):');
line('  1. After download, the file lands in Downloads.');
line('  2. Settings → Security → "Encryption & credentials" → Install a certificate → "CA certificate".');
line('  3. Pick the downloaded rootCA.pem and confirm.');
line('  Done.');
line('');
line('macOS (Safari + Chrome):');
line('  1. Double-click the downloaded rootCA.pem → Keychain Access opens.');
line('  2. Search for "mkcert", double-click the entry, expand "Trust", set "When using this certificate" to "Always Trust".');
line('  3. Close → enter password to save.');
line('  Done.');
line('');
line('Windows (Chrome + Edge — for testing on the dev box itself from a different browser):');
line('  Usually `mkcert -install` (run as part of this setup) already added it to the OS trust store. No extra step.');
line('');
line('Linux (Chrome, Firefox):');
line('  Most distros: `mkcert -install` added it. Firefox may need its own NSS trust store update — re-run `mkcert -install` from a terminal after installing libnss3-tools.');

rule('Step 3 — Run the app');
line('Pick one:');
line('  npm run dev:lan     # HTTPS Vite (HMR) + backend in dev mode at https://<lan-ip>:5173');
line('  npm run build && npm run start:lan   # production bundle at https://<lan-ip>:8443');
line('');
line('Then open the URL on your mobile device. With the root CA trusted (step 2), no warning appears.');
line('');
line(`Cert files written to: ${resolve(repoRoot, '.run', 'certs')}`);
line('Re-run this script any time your LAN IPs change (new network, new VPN, etc.) to regenerate the cert.');
