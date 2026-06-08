/* Interim "third distribution method" for the Castwright Companion app:
   GET /api/companion/apk streams the packaged Android APK as a download, or
   404s when none has been dropped at the resolved location. Express serves
   HEAD on the same route automatically — that's the frontend's cheap
   availability probe (see src/lib/api.ts checkCompanionApk). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { readCompanionApkInfo, resolveCompanionApkPath } from '../companion/apk.js';

export const companionRouter = Router();

companionRouter.get('/apk', (_req: Request, res: Response) => {
  const info = readCompanionApkInfo();
  if (!info.available) {
    res.status(404).json({ error: 'Companion APK not available' });
    return;
  }
  res.sendFile(
    resolveCompanionApkPath(),
    {
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="${info.filename}"`,
        'Cache-Control': 'no-cache',
      },
    },
    (err) => {
      if (err && !res.headersSent) res.status(500).end();
    },
  );
});
