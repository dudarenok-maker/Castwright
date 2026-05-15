/* Atomic rename with OneDrive-friendly retry. Extracted from state-io.ts so
   the export writers can share the same EPERM/EBUSY/ENOENT backoff.

   The retry is load-bearing on this repo's Windows + OneDrive host: a
   `rename(2)` landing inside OneDrive's change-detection window briefly
   sees the destination locked (EPERM/EBUSY) or, for ENOENT, the just-
   written tmp file moved into OneDrive's own staging dir for scanning
   and dropped back milliseconds later. Anything other than those three
   is a real fault — surface immediately. */

import { rename } from 'node:fs/promises';

const RENAME_RETRY_DELAYS_MS = [25, 75, 200, 500];

export async function renameWithRetry(src: string, dest: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rename(src, dest);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOENT') throw e;
      lastErr = e;
      if (attempt === RENAME_RETRY_DELAYS_MS.length) break;
      await new Promise(r => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}
