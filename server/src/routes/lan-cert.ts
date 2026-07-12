/* castwright-local-port-cert — POST /api/lan/cert/regenerate: in-app LAN-cert
   regeneration + live hot-swap into the running HTTPS server, so a user
   doesn't have to shell out to `npm run install:cert-mobile` themselves.
   See the design spec: docs/superpowers/specs/2026-07-04-castwright-local-port-cert-design.md

   Spawns scripts/setup-lan-certs.mjs as a SUBPROCESS, not an in-process
   import — setupLanCerts() calls process.exit(1) directly on any mkcert
   failure, which would take this entire server down on exactly the error
   path a "regenerate" click is most likely to hit (mkcert not installed).
   Mirrors how server/src/mdns-owner.ts and scripts/start-app-prod.mjs
   already cross this same scripts/-vs-server module boundary. */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { resolveLanCertPaths } from '../app-dirs.js';

export const lanCertRouter = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const scriptPath = resolve(repoRoot, 'scripts', 'setup-lan-certs.mjs');

/* Cert-output location parity (was a known gap; closed 2026-07-12 by plan 250):
   scripts/setup-lan-certs.mjs now derives its cert dir from
   `APP_RUN_DIR ? resolve(APP_RUN_DIR) : <repoRoot>/.run` + `/certs`, mirroring
   resolveRunDir()/resolveLanCertPaths(), so a versioned-dir install with APP_RUN_DIR
   set writes certs where this route (and index.ts's served LAN_CERT_FILE) reads
   them. Keep the two in sync if resolveRunDir's semantics change — the .mjs script
   can't import the compiled server module, so the derivation is duplicated by
   necessity (cross-referenced in both files). */
let { certFile, keyFile } = resolveLanCertPaths(repoRoot);

/** Test-only seam — lets lan-cert.test.ts point at a temp dir instead of the
    real .run/certs/. Pass null to restore the real paths. Not used by any
    production code path. */
export function __setCertPathsForTest(paths: { certFile: string; keyFile: string } | null): void {
  if (paths === null) {
    ({ certFile, keyFile } = resolveLanCertPaths(repoRoot));
    return;
  }
  certFile = paths.certFile;
  keyFile = paths.keyFile;
}

/** Extract the host list from setup-lan-certs.mjs's own
    `generating cert for hosts: a, b, c` stdout line — avoids re-deriving
    (and risking drift from) buildCertHosts()'s own list, without importing
    across the scripts/-vs-server boundary (see the module comment above). */
export function parseHostsFromOutput(stdout: string): string[] {
  const match = stdout.match(/generating cert for hosts: (.+)/);
  if (!match) return [];
  return match[1].split(',').map((h) => h.trim());
}

/** Async wrapper around node:child_process's callback-based execFile.
    Deliberately NOT util.promisify(execFile): Node's real execFile has a
    built-in custom promisify symbol that resolves to {stdout, stderr}, but a
    test that mocks the node:child_process module won't have that custom
    symbol — util.promisify's generic fallback would then resolve differently
    (an array, not {stdout, stderr}), a silent mismatch between tests and
    production. This explicit wrapper avoids that entirely. */
function execFileAsync(
  command: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; encoding: BufferEncoding },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // windowsHide: true is already set by every caller (see the object
    // literal below) — restated here as a literal so the
    // spawn-windows-hide.test.ts static scanner (which only reads call-site
    // text, not the `options` variable's origin) can see it.
    execFile(command, args, { ...options, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        (error as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

/* Guards against two overlapping regenerate requests (double-click, or two
   browser tabs) both spawning setup-lan-certs.mjs concurrently: interleaved
   writes to lan-cert.pem/lan-key.pem could pair a cert from one mkcert run
   with a private key from the other, and setSecureContext() with a
   mismatched pair breaks TLS for every subsequent connection — recoverable
   only by restarting the app. A single in-flight flag rejects the second
   request outright instead of racing. */
let regenerationInFlight = false;

lanCertRouter.post('/cert/regenerate', async (req: Request, res: Response) => {
  if (regenerationInFlight) {
    res.status(409).json({ error: 'A certificate regeneration is already in progress.' });
    return;
  }
  regenerationInFlight = true;
  try {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(process.execPath, [scriptPath], {
        timeout: 90_000,
        windowsHide: true,
        encoding: 'utf8',
      }));
    } catch (err) {
      const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
      const message = stderr ? stderr.toString() : (err as Error).message;
      res.status(500).json({ error: message });
      return;
    }

    const hosts = parseHostsFromOutput(stdout);

    if (existsSync(certFile) && existsSync(keyFile)) {
      // Best-effort hot-swap: the actual regeneration (what the user asked
      // for) already succeeded above. If either file gets deleted or is
      // mid-write in the gap between existsSync and readFileSync (antivirus
      // scan, external cleanup, etc.), don't let that TOCTOU race turn a
      // successful regeneration into a misleading 500 -- log and still
      // return the success response with the host list.
      try {
        const server = req.app.get('lanHttpsServer') as
          | { setSecureContext: (opts: { key: Buffer; cert: Buffer }) => void }
          | undefined;
        server?.setSecureContext({ key: readFileSync(keyFile), cert: readFileSync(certFile) });
      } catch (err) {
        console.warn(
          `[lan-cert] regenerated the certificate but the hot-swap read failed: ${(err as Error).message}`,
        );
      }
    }

    res.status(200).json({ hosts });
  } finally {
    regenerationInFlight = false;
  }
});
