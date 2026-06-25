/* Task 15 (fs-65 Phase 3) — e2e: "Expressive directions" toggle on the
 * analysis form.
 *
 * Asserts the STABLE, non-flaky surface:
 *   1. The toggle is present and CHECKED by default on the analysing view
 *      (eager default — prosodyEnabled is undefined → checked).
 *   2. Unchecking the toggle works (checkbox toggles to unchecked).
 *
 * The transient background "Phase 3 — Detecting prosody" pill is timing-
 * sensitive in mocks and is covered by unit tests (layout-prosody-pill.test.tsx
 * + prosody-autotrigger.test.tsx); it is intentionally excluded here.
 *
 * Uses `bootFreshBookIntoAnalysing` from helpers.ts to reach the analysing
 * route with the "Start analysis" button visible (before the stream fires),
 * which gives a deterministic view of the toggle in its resting state. */

import { test, expect } from '@playwright/test';
import { bootFreshBookIntoAnalysing } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('analysis-form — Expressive directions toggle (fs-65 Task 15)', () => {
  test('toggle is present and checked by default on the analysing screen', async ({ page }) => {
    await bootFreshBookIntoAnalysing(page);

    const toggle = page.getByRole('checkbox', { name: /expressive directions/i });
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await expect(toggle).toBeChecked();
  });

  test('unchecking the toggle makes it unchecked', async ({ page }) => {
    await bootFreshBookIntoAnalysing(page);

    const toggle = page.getByRole('checkbox', { name: /expressive directions/i });
    await expect(toggle).toBeChecked({ timeout: 5_000 });

    await toggle.click();
    await expect(toggle).not.toBeChecked();
  });
});
