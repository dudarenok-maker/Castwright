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

  test('resource trends table shows the QA re-record RTF column', async ({ page }) => {
    await page.goto('/#/admin');

    const panel = page.getByTestId('resource-trends');
    await expect(panel).toBeVisible({ timeout: 10_000 });

    await expect(panel.getByText('QA', { exact: true })).toBeVisible();

    // Mock's newest chapter (id=7) carries rerecordRtf: 0.02 — same story as
    // the throughput table's mock, proving the value flows into this
    // specific cell, not just anywhere in the row.
    const row7 = page.getByTestId('resource-row-7');
    await expect(row7.getByTestId('resource-qa-cell')).toHaveText('0.02');
  });

  /* Regression for the column-alignment bug (2026-07-06): a trailing `auto`
     grid track sizes independently per row (header vs. data), since each row
     is its own grid container — jsdom string-equality tests on the class name
     can't catch this because the class is identical even when the COMPUTED
     layout drifts. Only a real layout engine (this Playwright spec) proves
     header and data cells actually land in the same horizontal position. */
  test('column headers stay aligned with their data cells in both tables', async ({ page }) => {
    await page.goto('/#/admin');

    await expect(page.getByTestId('generation-throughput-table')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('resource-trends')).toBeVisible({ timeout: 10_000 });

    const alignment = await page.evaluate(() => {
      const rectsOf = (el: Element) =>
        Array.from(el.children)
          .filter((c) => getComputedStyle(c).display !== 'none')
          .map((c) => c.getBoundingClientRect().right);

      const throughputScroll = document.querySelector('[data-testid="generation-throughput-scroll"]')!;
      const throughputHeader = throughputScroll.firstElementChild!;
      const throughputRow = document.querySelector('[data-testid="throughput-row-7"]')!;

      const trendsScroll = document.querySelector('[data-testid="resource-trends-scroll"]')!;
      const trendsHeader = trendsScroll.firstElementChild!;
      const trendsRow = document.querySelector('[data-testid="resource-row-7"]')!;

      return {
        throughput: { header: rectsOf(throughputHeader), row: rectsOf(throughputRow) },
        trends: { header: rectsOf(trendsHeader), row: rectsOf(trendsRow) },
      };
    });

    // Same number of visible columns, and each column's right edge lines up
    // within a pixel between the header row and a data row.
    expect(alignment.throughput.header.length).toBe(alignment.throughput.row.length);
    for (let i = 0; i < alignment.throughput.header.length; i++) {
      expect(Math.abs(alignment.throughput.header[i] - alignment.throughput.row[i])).toBeLessThanOrEqual(1);
    }

    expect(alignment.trends.header.length).toBe(alignment.trends.row.length);
    for (let i = 0; i < alignment.trends.header.length; i++) {
      expect(Math.abs(alignment.trends.header[i] - alignment.trends.row[i])).toBeLessThanOrEqual(1);
    }
  });
});
