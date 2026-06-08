/* Interim companion-app distribution: resolve + describe the packaged Android
   APK that GET /api/companion/apk serves. No APK ships in the repo — a release
   or deploy drops the built file at the resolved location, and the frontend's
   "Download .apk" affordance appears only once it's present. */

import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAppVersion } from '../app-version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/* server/{src,dist}/companion → the release root is three levels up, the same
   anchor RELEASE_NOTES.md ships at (see routes/info.ts). */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_APK_PATH = join(REPO_ROOT, 'companion', 'castwright-companion.apk');

/** Absolute path to the APK the server should serve. `COMPANION_APK_PATH`
    (absolute, or relative to the release root) overrides the default drop
    location. Read per-call so a deploy can drop the file without a restart. */
export function resolveCompanionApkPath(): string {
  const override = process.env.COMPANION_APK_PATH?.trim();
  if (override) return isAbsolute(override) ? override : resolve(REPO_ROOT, override);
  return DEFAULT_APK_PATH;
}

export interface CompanionApkInfo {
  available: boolean;
  sizeBytes: number | null;
  filename: string | null;
}

/** Stat the resolved APK. Returns `available:false` (never throws) when the
    file is absent — the route then 404s and the banner hides its download
    button. The download filename carries the current app version. */
export function readCompanionApkInfo(): CompanionApkInfo {
  try {
    const st = statSync(resolveCompanionApkPath());
    if (!st.isFile()) return { available: false, sizeBytes: null, filename: null };
    return {
      available: true,
      sizeBytes: st.size,
      filename: `castwright-companion-${getAppVersion()}.apk`,
    };
  } catch {
    return { available: false, sizeBytes: null, filename: null };
  }
}
