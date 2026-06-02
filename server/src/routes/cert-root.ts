/* GET /cert/root.crt — serve the mkcert local root CA so a phone or tablet
   on the LAN can download + trust it once, then hit every https://<lan-ip>
   URL we expose with no browser warning.

   Plan 81 mobile + tablet support.

   Resolution order for the CA file path:
     1. Env override $MKCERT_CAROOT (escape hatch for non-standard installs).
     2. `mkcert -CAROOT` shelled out (mkcert's own truth — the user installed
        it themselves so we trust its answer over our guesses).
     3. Per-OS default fallback (where mkcert puts files when CAROOT is unset).

   The route is mounted unconditionally — it's harmless when LAN_HTTPS is off
   (Node binds HTTP on :8080 and the route's still reachable; the file is the
   *public-half* root cert by design, meant to be downloaded). If mkcert is
   not installed and no CA file exists on disk, returns 404 with a JSON body
   pointing the user at `npm run install:cert-mobile` for the bootstrap flow. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from '../http.js';

export const certRootRouter = Router();

const CA_FILENAME = 'rootCA.pem';

function tryMkcertCaroot(): string | null {
  try {
    const out = execFileSync('mkcert', ['-CAROOT'], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function defaultCarootForPlatform(): string {
  // Mirrors mkcert's own platform defaults so we can answer without shelling
  // out when the binary isn't on PATH (e.g. installed via vite-plugin-mkcert
  // into a project-local location). These are the fallbacks; user-installed
  // mkcert will override via -CAROOT above.
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'mkcert')
        : join(home, 'AppData', 'Local', 'mkcert');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'mkcert');
    default:
      return process.env.XDG_DATA_HOME
        ? join(process.env.XDG_DATA_HOME, 'mkcert')
        : join(home, '.local', 'share', 'mkcert');
  }
}

export function resolveRootCaPath(): { path: string; source: 'env' | 'mkcert' | 'default' } | null {
  const envPath = process.env.MKCERT_CAROOT;
  if (envPath) {
    const candidate = resolve(envPath, CA_FILENAME);
    if (existsSync(candidate)) return { path: candidate, source: 'env' };
  }
  const mkcertPath = tryMkcertCaroot();
  if (mkcertPath) {
    const candidate = resolve(mkcertPath, CA_FILENAME);
    if (existsSync(candidate)) return { path: candidate, source: 'mkcert' };
  }
  const fallback = resolve(defaultCarootForPlatform(), CA_FILENAME);
  if (existsSync(fallback)) return { path: fallback, source: 'default' };
  return null;
}

certRootRouter.get('/root.crt', (_req: Request, res: Response) => {
  const resolved = resolveRootCaPath();
  if (!resolved) {
    res.status(404).json({
      error: 'mkcert root CA not found on this machine',
      hint: 'Run `npm run install:cert-mobile` on the dev box to bootstrap the local CA + per-device install instructions.',
      probed: {
        env: process.env.MKCERT_CAROOT ?? null,
        mkcertCli: tryMkcertCaroot(),
        defaultForPlatform: defaultCarootForPlatform(),
      },
    });
    return;
  }
  const body = readFileSync(resolved.path);
  const size = statSync(resolved.path).size;
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', `attachment; filename="${CA_FILENAME}"`);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Mkcert-Source', resolved.source);
  res.status(200).send(body);
});
