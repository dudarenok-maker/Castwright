import { test } from '@playwright/test';

/* #698 — Vite dev-server transform-cache warm-up (Playwright setup project).
 *
 * The Vite DEV server transforms each unbundled `/src` module (TS/TSX → JS) on
 * first request and caches the result IN MEMORY — so the cache is cold on every
 * server start. A single page load pulls ~300 modules; when the parallel e2e
 * battery boots, N workers cold-load the SPA simultaneously and the first specs
 * (alphabetically about-page / admin / admin-ui-polish) time out waiting for
 * `load` while the single-threaded server transforms the graph under the herd.
 * Trace-confirmed: `goto` stalls >60s fetching the unbundled /src module graph
 * (every view + store slice, served one request per module).
 *
 * This setup project runs ONCE, before the chromium project (wired via
 * `dependencies: ['warmup']` in playwright.config.ts), and loads the app plus
 * every lazy route once — sequentially and uncontended — so the server-side
 * transform cache is warm before the workers start. The battery then streams
 * cached transforms instead of computing them under contention.
 *
 * It NEVER asserts: a route hiccup must not block the whole suite, and merely
 * REQUESTING a route's modules is enough to warm them. Skipped on CI, where
 * `workers: 1` means there is no cold-start herd to warm against.
 *
 * Routes cover the heavy common graph (any route pulls it) + each React.lazy
 * leaf (src/routes/index.tsx) so no spec pays a first-transform cost mid-run. */

const ROUTES = [
  '/',
  '/#/new',
  '/#/about',
  '/#/admin',
  '/#/account',
  '/#/models',
  '/#/advanced',
  '/#/changelog',
  '/#/release-notes',
  '/#/voices',
  '/#/books/sb/manuscript',
  '/#/books/sb/cast',
  '/#/books/sb/listen',
  '/#/books/sb/generate',
];

test('warm the Vite dev transform cache', async ({ page }) => {
  test.skip(!!process.env.CI, 'CI runs workers=1 — no cold-start herd to warm against');
  test.setTimeout(240_000);
  for (const route of ROUTES) {
    await page.goto(route, { waitUntil: 'load', timeout: 120_000 }).catch(() => {});
  }
});
