/* Plan 49 — production-mode frontend static mount.
   Extracted from server/src/index.ts so the colocated unit test can drive
   it without booting the whole server.

   Mounts the Vite-built bundle at `/` when NODE_ENV=production OR when the
   bundle is already present on disk at `distDir/index.html`. The mount uses
   `fallthrough: true` so a 404 inside dist/ doesn't shadow downstream API
   routes; the caller is responsible for mounting this AFTER every /api/*,
   /audio/*, /workspace/* route so the API always wins. */

import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface FrontendStaticMountResult {
  mounted: boolean;
  distDir: string;
  reason: string;
}

export function mountFrontendStatic(app: Express, distDir: string): FrontendStaticMountResult {
  const resolved = resolve(distDir);
  const indexExists = existsSync(resolve(resolved, 'index.html'));
  const forced = process.env.NODE_ENV === 'production';

  if (!forced && !indexExists) {
    return {
      mounted: false,
      distDir: resolved,
      reason: 'dev-mode (NODE_ENV!=production and dist/index.html not on disk)',
    };
  }

  if (forced && !indexExists) {
    return {
      mounted: false,
      distDir: resolved,
      reason: `NODE_ENV=production but ${resolved}/index.html is missing — run "npm run build" first`,
    };
  }

  app.use(express.static(resolved, { fallthrough: true, maxAge: '1h' }));
  return {
    mounted: true,
    distDir: resolved,
    reason: indexExists
      ? 'dist/index.html present on disk'
      : 'NODE_ENV=production (forced)',
  };
}
