/* fs-1 — GET /api/info: the app's version + schema + what's-new state, the
   single source the top-bar version pill, the useAppInfo() hook, and the
   what's-new banner read from. POST /api/info/dismiss-whats-new clears the
   post-upgrade banner.

   appVersion is server-authoritative (a stale cached bundle's __APP_VERSION__
   can lie). sidecarVersion is a best-effort probe — null when the sidecar is
   down. releaseNotes is the bundled RELEASE_NOTES.md (empty when absent). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { readFileSync } from 'node:fs';
import { platform as osPlatform, arch as osArch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAppVersion } from '../app-version.js';
import { CURRENT_STATE_SCHEMA } from '../workspace/state-migrate.js';
import { SCHEMA_SEAMS } from '../workspace/schema-migrate.js';
import { SYNC_MANIFEST_SCHEMA } from '../workspace/sync-manifest.js';
import { readUserSettings, writeUpgradeMeta, getResolvedSidecarUrl } from '../workspace/user-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/* server/{src,dist}/routes → repoRoot is three levels up. RELEASE_NOTES.md ships
   at the release root (see build-release-zip MANIFEST). */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const RELEASE_NOTES_PATH = join(REPO_ROOT, 'RELEASE_NOTES.md');

export const infoRouter = Router();

function schemaMap(): Record<string, number> {
  const out: Record<string, number> = { state: CURRENT_STATE_SCHEMA };
  for (const seam of SCHEMA_SEAMS) {
    // 'cast.json' → 'cast', 'manuscript-edits.json' → 'manuscriptEdits'.
    const key = seam.label.replace(/\.json$/, '').replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    out[key] = seam.current;
  }
  // srv-32 — the companion compat-gates the sync-manifest contract off this.
  out.syncManifest = SYNC_MANIFEST_SCHEMA;
  return out;
}

/* fs-43 — host hardware, for the in-app "Will it run on my machine?" panel.
   Server-sourced on purpose: the SERVER runs the models, while the browser may
   be a paired LAN phone, so client-side (navigator) detection would describe
   the wrong machine. This is the SENSIBLE slice — host platform/arch (incl.
   Apple Silicon, reliably detectable). The deeper "which torch device is the
   active engine actually on, incl. mps" ground-truth is side-14. */
export interface HardwareInfo {
  platform: string;
  arch: string;
  appleSilicon: boolean;
  label: string;
}

function detectHardware(): HardwareInfo {
  const platform = osPlatform(); // 'win32' | 'darwin' | 'linux' | …
  const arch = osArch(); // 'x64' | 'arm64' | …
  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  const label = appleSilicon
    ? 'Apple Silicon Mac'
    : platform === 'darwin'
      ? 'Intel Mac'
      : platform === 'win32'
        ? `Windows (${arch})`
        : platform === 'linux'
          ? `Linux (${arch})`
          : `${platform} (${arch})`;
  return { platform, arch, appleSilicon, label };
}

function readReleaseNotes(): string {
  try {
    return readFileSync(RELEASE_NOTES_PATH, 'utf8');
  } catch {
    return '';
  }
}

/** Best-effort sidecar version probe — short timeout, null on any failure so a
    down sidecar never blocks /api/info. */
async function fetchSidecarVersion(): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${getResolvedSidecarUrl()}/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { __version__?: string };
    return typeof body.__version__ === 'string' ? body.__version__ : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

infoRouter.get('/', async (_req: Request, res: Response) => {
  const settings = await readUserSettings();
  const appVersion = getAppVersion();
  const sidecarVersion = await fetchSidecarVersion();
  res.json({
    appVersion,
    sidecarVersion,
    schemas: schemaMap(),
    lastSeenAppVersion: settings.lastSeenAppVersion ?? null,
    showWhatsNew: settings.showWhatsNew === true,
    releaseNotes: readReleaseNotes(),
    hardware: detectHardware(),
  });
});

infoRouter.post('/dismiss-whats-new', async (_req: Request, res: Response) => {
  await writeUpgradeMeta({ showWhatsNew: false });
  res.json({ ok: true });
});
