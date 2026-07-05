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
   opt-in mobile/tablet lanes.

   Also regression-tests #1325: the ~2px baseline overflow #1298's fix
   deliberately measured against (rather than fixed) turned out to be the
   filter-pills + Cards/Table view-mode-toggle row (line ~225 in
   library-chrome.tsx) — the only flex row in that file missing `flex-wrap`,
   so at 390px width the two non-wrapping children's combined intrinsic width
   narrowly exceeded the available space. Fixed by adding `flex-wrap` to
   match every sibling row in the same component. The baseline assertion
   below now pins that fix directly instead of just tolerating the number.

   That first fix attempt used `justify-between` + `flex-wrap`, which
   introduced a regression caught in code review (not by this spec, since it
   only measured scrollWidth): `justify-between` left-aligns a lone item once
   it wraps to its own line (nothing to be "between"), so the Cards/Table
   toggle jumped to the left edge under the filter pills on a narrow phone.
   Fixed by dropping `justify-between` and giving the toggle `ml-auto`
   instead, which keeps it right-anchored on any line, wrapped or not — see
   the second test below. */

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

  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
    timeout: 10_000,
  });
  const baselineOverflow = await measureOverflow(page);
  /* #1325 — this used to be ~2px; now that the missing flex-wrap is fixed
     it should be ~0, tolerating 1px for sub-pixel rounding like the rest of
     the responsive suite (see baseline.spec.ts). */
  expect(baselineOverflow, 'Books view baseline horizontal overflow (#1325)').toBeLessThanOrEqual(
    1,
  );

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

test('Books view Cards/Table toggle stays right-anchored, wrapped or not (#1325)', async ({
  page,
}) => {
  async function toggleRightGap(width: number) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    return page.evaluate(() => {
      const doc = document.documentElement;
      const toggle = document.querySelector('[data-testid="library-view-mode-toggle"]');
      return doc.clientWidth - toggle!.getBoundingClientRect().right;
    });
  }

  /* 390px: narrow enough that the toggle wraps onto its own line below the
     filter pills. 1280px: wide enough that it shares the line with them.
     Both should sit flush to the page's right padding (16px at `px-4`,
     24px at `sm:px-6`), not drift to the left edge. */
  const narrowGap = await toggleRightGap(390);
  const wideGap = await toggleRightGap(1280);
  expect(narrowGap, 'toggle→viewport-edge gap at 390px').toBeLessThanOrEqual(20);
  expect(wideGap, 'toggle→viewport-edge gap at 1280px').toBeLessThanOrEqual(30);
});
