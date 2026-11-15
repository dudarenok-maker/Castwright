// scripts/lib/playwright-port.mjs — resolve the e2e port for playwright.config.ts.
//
// scripts/wt-new.mjs writes PLAYWRIGHT_PORT into each worktree's root
// .env.local; Playwright does not load dotenv files itself, so without this a
// bare `npx playwright test` fell back to 5174 and (reuseExistingServer being
// on) could silently test another tree's Vite server (#4207). An already-set
// env var wins over the file, matching process.loadEnvFile; a missing file is
// a no-op.
//
// rootDir must be the config's own directory (playwright.config.ts passes
// __dirname), NOT process.cwd(): Playwright starts the webServer with
// cwd = configDir, so that directory is the Vite root whose .env.local the
// dev server itself reads, whatever directory `playwright test` was run from.
//
// A value that is not an integer in 1-65535 (blank included) throws, naming
// where it came from, rather than becoming port 0 / NaN and hanging until the
// 120 s webServer timeout.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export function resolvePlaywrightPort(rootDir, env = process.env) {
  const file = join(rootDir, '.env.local');
  let raw;
  let source;
  if (env.PLAYWRIGHT_PORT !== undefined) {
    raw = env.PLAYWRIGHT_PORT;
    source = 'the PLAYWRIGHT_PORT environment variable';
  } else {
    const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
    if (fromFile.PLAYWRIGHT_PORT === undefined) return 5174;
    raw = fromFile.PLAYWRIGHT_PORT;
    source = `PLAYWRIGHT_PORT in ${file}`;
  }
  const port = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}
