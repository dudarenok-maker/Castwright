/* fe-5 — coarse-pointer hover-reveal proof.
 *
 * Runs across all three projects (chromium / mobile-chrome / tablet-chrome)
 * via the e2e/responsive/*.spec.ts testMatch glob. Playwright's toBeVisible()
 * ignores opacity, so we read getComputedStyle().opacity directly and branch
 * on the project's *runtime* pointer type: a coarse pointer (touch) must reveal
 * the action without hover; a fine pointer (mouse) must keep it hidden until
 * hover. mobile-chrome guarantees the coarse branch is exercised; chromium
 * (in the pre-push battery) covers the fine branch.
 */
import { test, expect } from '@playwright/test';

test.describe('coarse-pointer hover-reveal affordances (fe-5)', () => {
  test('book-options ⋯ trigger respects pointer type', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Book options' }).first();
    await trigger.waitFor({ state: 'attached', timeout: 10_000 });

    const { isCoarse, opacity } = await trigger.evaluate((el) => ({
      isCoarse: window.matchMedia('(pointer: coarse)').matches,
      opacity: getComputedStyle(el as HTMLElement).opacity,
    }));

    if (isCoarse) {
      // Touch: the menu trigger is reachable without any hover.
      expect(opacity, 'options trigger should be revealed on coarse pointer').toBe('1');
    } else {
      // Mouse: stays hidden until hover (desktop affordance unchanged).
      expect(opacity, 'options trigger should be hover-hidden on fine pointer').toBe('0');
    }
  });
});
