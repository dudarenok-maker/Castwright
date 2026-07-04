/* Regression for bug #1298: WorkspacePathRow's workspace-path <span> in
   src/components/library/library-chrome.tsx carried a fixed `max-w-[520px]`
   with no responsive breakpoint, so a realistic (long) workspace path forced
   the Books view wider than a phone viewport instead of truncating.

   The default mock workspace root ('(mock)') is too short to ever trigger a
   max-width overflow, so this uses the `?e2eWorkspaceRoot=` seam (mirrors
   `readE2eUpdateOverride` — mock mode is in-process, so page.route can't
   intercept) to force a realistic long path. Runs at the exact 390x844
   viewport from the issue's own repro regardless of Playwright project, so
   it's caught by the default (non-opt-in) `test:e2e` gate, not just the
   opt-in mobile/tablet lanes. */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const LONG_WORKSPACE_ROOT =
  'C:\\Users\\dudar\\OneDrive\\Documents\\My Audiobooks Library\\Castwright Workspace Folder';

async function measureOverflow(page: Page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

test('Books view has no horizontal overflow at phone width with a long workspace path (#1298)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  /* Baseline: the Books view carries a small (~2px), pre-existing overflow
     at this viewport unrelated to the workspace path — comparing against it
     (rather than asserting a hard near-zero) targets the actual regression:
     extra overflow CAUSED by a long path, not this page's existing noise
     floor. */
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
    timeout: 10_000,
  });
  const baselineOverflow = await measureOverflow(page);

  await page.goto(`/?e2eWorkspaceRoot=${encodeURIComponent(LONG_WORKSPACE_ROOT)}`);
  await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(LONG_WORKSPACE_ROOT)).toBeVisible();
  const longPathOverflow = await measureOverflow(page);

  expect(
    longPathOverflow - baselineOverflow,
    `overflow added by a long workspace path (baseline ${baselineOverflow}px, long-path ${longPathOverflow}px)`,
  ).toBeLessThanOrEqual(1);
});
