/* #1935 — three interactive controls (listen-view rename/regenerate/
   share-clip buttons, and the voice-override-picker trigger) carried the
   superseded phone-only touch-target pattern (`sm:`/`md:` width-breakpoint
   shrink), which collapses the WCAG 2.5.5 44px target across the ENTIRE
   tablet range (≥640px) rather than only on a real mouse. The fix swaps to
   `fine-pointer:`/`coarse-pointer:` pointer-media-query variants so the
   target tracks input *device*, not viewport *width*.

   This is exactly the seam a jsdom class-name assertion cannot prove:
   jsdom does no layout, so it can assert a Tailwind class string is present
   but not that the rendered box is actually 44px. Only a real browser can
   measure `getBoundingClientRect()` under a real `(pointer: coarse|fine)`
   media query — so this is a Playwright spec, not a Vitest one, mirroring
   e2e/responsive/coarse-pointer-reveals.spec.ts's pointer-branching pattern.

   Runs across all three projects via the e2e/responsive testMatch glob
   (playwright.config.ts):
     - chromium (required `test:e2e` CI gate): fine pointer, no touch —
       proves the fix does NOT oversize the control for mouse users, and
       that the shrink is pointer-driven, not the old width-driven bug.
     - mobile-chrome / tablet-chrome (opt-in `test:e2e:mobile`): coarse
       pointer — proves the 44px floor actually holds on a touch device.
   The viewport is pinned to 768px (tablet width, ≥ both the old `sm:` (640)
   and `md:` (768) breakpoints the bug shrank at) regardless of project, so
   the same width is exercised under every pointer type. */

import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { waitForListenViewReady, goToConfirm, waitForConfirmViewReady } from '../helpers';

async function measure(locator: Locator) {
  return locator.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    width: el.getBoundingClientRect().width,
    isCoarse: window.matchMedia('(pointer: coarse)').matches,
  }));
}

async function assertTouchTarget(locator: Locator, label: string, checkWidth: boolean) {
  await expect(locator).toBeVisible({ timeout: 5_000 });
  const { height, width, isCoarse } = await measure(locator);
  if (isCoarse) {
    expect(height, `${label} height on a coarse (touch) pointer`).toBeGreaterThanOrEqual(44);
    if (checkWidth) {
      expect(width, `${label} width on a coarse (touch) pointer`).toBeGreaterThanOrEqual(44);
    }
  } else {
    // Fine pointer (mouse): the compact box must NOT be stretched to 44px —
    // that would prove the shrink is still viewport-width-driven rather
    // than pointer-driven, i.e. the bug is still there.
    expect(height, `${label} height on a fine (mouse) pointer stays compact`).toBeLessThan(44);
  }
}

test.describe('tablet-range touch targets (#1935)', () => {
  test('listen-view rename / regenerate / share-clip buttons stay ≥44px on any touch device', async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);

    const rename = page.getByTestId('chapter-row-1-rename').first();
    const shareClip = page.getByTestId('chapter-row-1-share-clip').first();
    const regenerate = page.getByRole('button', { name: 'Regenerate chapter 1' }).first();

    await assertTouchTarget(rename, 'rename button', true);
    await assertTouchTarget(regenerate, 'regenerate button', true);
    await assertTouchTarget(shareClip, 'share-clip button', true);
  });

  test('voice-override-picker trigger stays ≥44px tall on any touch device', async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await goToConfirm(page);
    await waitForConfirmViewReady(page);

    const hallCard = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(hallCard).toBeVisible({ timeout: 10_000 });
    // Click the name heading, not the card's bounding-box center — at 768px
    // the card's right-hand decision-tile column (which stopPropagation()s
    // its own clicks, per confirm-cast.tsx) can sit under that center point
    // and swallow the click before it reaches the card's onOpenProfile.
    await hallCard.getByRole('heading', { name: 'Captain Halloran', level: 3 }).click();

    const trigger = page.getByRole('button', { name: /Model voice override/i }).first();
    // Full-width text trigger — only the height collapsed under the old
    // `sm:min-h-0` pattern, so this control has no min-width to check.
    await assertTouchTarget(trigger, 'voice-override-picker trigger', false);
  });
});
