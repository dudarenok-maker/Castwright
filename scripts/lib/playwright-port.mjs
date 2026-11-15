// scripts/lib/playwright-port.mjs — resolve the e2e port for playwright.config.ts.
//
// scripts/wt-new.mjs writes PLAYWRIGHT_PORT into each worktree's root
// .env.local; Playwright does not load dotenv files itself, so without this a
// bare `npx playwright test` fell back to 5174 and (reuseExistingServer being
// on) could silently test another tree's Vite server (#4207). An already-set
// env var wins over the file, matching process.loadEnvFile; a missing file is
// a no-op.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export function resolvePlaywrightPort(rootDir, env = process.env) {
  const file = join(rootDir, '.env.local');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return Number(env.PLAYWRIGHT_PORT ?? fromFile.PLAYWRIGHT_PORT ?? 5174);
}
