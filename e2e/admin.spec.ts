/* fs-18 — Admin watch console golden path. Crosses the router/redux/layout
   seam (a new stage + always-visible top-bar pill), so it earns one Playwright
   spec per CLAUDE.md's e2e bar. Runs against Vite in mock mode, where
   GET /api/diagnostics returns an all-green board. */

import { test, expect } from '@playwright/test';

/* Run this file's tests sequentially on a single worker. Each test does a cold
 * `goto('/#/admin')` (or `/`) that triggers a route-level React.lazy chunk load; with
 * fullyParallel + local workers these cold-loads pile onto the single Vite dev
 * server and the visibility timeouts flake under peak battery contention (passes
 * on retry in isolation, exhausts retries under full load). Serial mode caps this
 * file at one concurrent cold-load — the same mitigation 10+ sibling specs use. */
test.describe.configure({ mode: 'serial' });

test.describe('Admin watch console', () => {
  test('reachable for all users via the top-bar Admin pill', async ({ page }) => {
    await page.goto('/');
    // The Admin pill is always rendered (no longer dev-gated).
    const pill = page.getByTestId('topbar-admin-link');
    await expect(pill).toBeVisible({ timeout: 10_000 });

    await pill.click();
    await expect(page).toHaveURL(/#\/admin$/);
    await expect(page.getByRole('heading', { name: 'Admin', level: 2 })).toBeVisible();
  });

  test('renders the health board and a healthy status dot', async ({ page }) => {
    await page.goto('/#/admin');

    const board = page.getByTestId('health-board');
    await expect(board).toBeVisible({ timeout: 10_000 });
    // The mock board carries the full fs-18 check set.
    await expect(page.getByTestId('health-row-sidecar')).toBeVisible();
    await expect(page.getByTestId('health-row-disk')).toBeVisible();

    // The top-bar dot reflects the mock board's overall: 'ok'.
    await expect(page.getByTestId('topbar-health-dot')).toHaveAttribute('data-status', 'ok');
  });

  test('throughput table shows the QA re-record RTF column', async ({ page }) => {
    await page.goto('/#/admin');

    // Wait for the generation throughput table to load.
    const table = page.getByTestId('generation-throughput-table');
    await expect(table).toBeVisible({ timeout: 10_000 });

    // The "QA" header cell is visible within the throughput table (scoped so
    // it can't collide with any other "QA" text elsewhere on the page).
    await expect(table.getByText('QA', { exact: true })).toBeVisible();

    // The mock's newest chapter (id=7) carries rerecordRtf: 0.02, formatted
    // via fmtRtf — proves the value actually flows through the QA cell
    // specifically, not just present somewhere else in the row (e.g. the
    // Synth-wall or RTF cells, which carry unrelated numbers).
    const row7 = page.getByTestId('throughput-row-7');
    await expect(row7.getByTestId('throughput-qa-cell')).toHaveText('0.02');
  });
});
