/* Guided-tour e2e — linear golden path + per-screen mini-tour.
 *
 * Context:
 *   - The mock library is NOT empty (MOCK_LIBRARY ships 3 default books),
 *     so the empty-library "Take the guided tour" CTA never renders in e2e.
 *   - Entry point: top-bar "?" button (data-testid="topbar-help") →
 *     "Take the tour" menuitem → dispatches startLinearTour() → seeds the
 *     Coalfall Commission sample + starts the linear tour at step 0.
 *   - 13 steps total, spanning library → manuscript → cast (incl. drawer)
 *     → generate → listen screens.
 *   - Clicking Next on the last step dispatches finishTour() →
 *     completeTour() → tour overlay hides.
 */

import { test, expect } from '@playwright/test';

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** Open the Help menu and click the given item label. */
async function openHelpAndClick(
  page: import('@playwright/test').Page,
  itemName: string | RegExp,
) {
  await page.getByTestId('topbar-help').click();
  await page.getByRole('menuitem', { name: itemName }).click();
}

/** Wait for the tour bubble to show a particular step title (or just be
 *  visible when titleRe is omitted). */
async function waitForBubble(
  page: import('@playwright/test').Page,
  titleRe?: RegExp,
  timeoutMs = 12_000,
) {
  await expect(page.getByTestId('tour-bubble')).toBeVisible({ timeout: timeoutMs });
  if (titleRe) {
    await expect(page.getByRole('heading', { name: titleRe })).toBeVisible({ timeout: timeoutMs });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Test 1 — linear tour: start from the ? menu, advance across all 13 steps,
   finish. The spec verifies:
     • The welcome bubble (step 1) appears after loadSample resolves.
     • Clicking Next repeatedly moves through all steps (bounded loop).
     • When the final step ("That's the whole journey") is active, the
       Next button reads "Done".
     • The chapter-1-play anchor exists in the DOM by the time the listen
       steps render.
     • Clicking Done dismisses the overlay.
   ══════════════════════════════════════════════════════════════════════════ */
test('guided tour: start from ? menu, advance across real screens, finish', async ({ page }) => {
  await page.goto('/#/');

  /* 1. Trigger the tour. */
  await openHelpAndClick(page, /take the tour/i);

  /* 2. Welcome bubble must appear (loadSample resolves in ~150 ms mock-side,
     but navigation + React re-render may add up to a few hundred ms more). */
  await waitForBubble(page, /welcome to castwright/i);

  /* 3. Advance through all 13 steps via Next (bounded to 15 iterations so the
     test can't run forever if Next never reaches Done for some reason). */
  const MAX_STEPS = 15;
  for (let i = 0; i < MAX_STEPS; i++) {
    const doneBtn = page.getByRole('button', { name: /^done$/i });
    const isDone = await doneBtn.isVisible().catch(() => false);
    if (isDone) break;

    /* Wait for the current bubble before clicking Next so we don't race
       against screen-transition animations. */
    await expect(page.getByTestId('tour-bubble')).toBeVisible({ timeout: 10_000 });

    /* On the drawer step (s7) the profile drawer may need a moment to open
       before the bubble re-renders with its anchored position. */
    await page.waitForTimeout(120);

    const nextBtn = page.getByRole('button', { name: /^next$/i });
    await nextBtn.waitFor({ state: 'visible', timeout: 8_000 });
    await nextBtn.click();
  }

  /* 4. Done button must be visible (last step rendered). */
  await expect(page.getByRole('button', { name: /^done$/i })).toBeVisible({ timeout: 10_000 });

  /* 5. The listen view's chapter-1-play anchor must exist in the DOM — it's
     the data-tour-id used by step s10. If the listen screen never mounted,
     the tour couldn't have reached this step correctly. */
  await expect(page.locator('[data-tour-id="chapter-1-play"]')).toHaveCount(1);

  /* 6. Finish the tour. */
  await page.getByRole('button', { name: /^done$/i }).click();

  /* 7. Overlay must disappear. */
  await expect(page.getByTestId('tour-overlay')).toHaveCount(0);
});

/* ══════════════════════════════════════════════════════════════════════════
   Test 2 — Skip button exits the tour immediately.
   ══════════════════════════════════════════════════════════════════════════ */
test('guided tour: Skip exits the tour immediately', async ({ page }) => {
  await page.goto('/#/');
  await openHelpAndClick(page, /take the tour/i);
  await waitForBubble(page, /welcome to castwright/i);

  await page.getByRole('button', { name: /^skip$/i }).click();

  /* Overlay must disappear. */
  await expect(page.getByTestId('tour-overlay')).toHaveCount(0);
});

/* ══════════════════════════════════════════════════════════════════════════
   Test 3 — Back button moves to the previous step.
   ══════════════════════════════════════════════════════════════════════════ */
test('guided tour: Back returns to the previous step', async ({ page }) => {
  await page.goto('/#/');
  await openHelpAndClick(page, /take the tour/i);
  await waitForBubble(page, /welcome to castwright/i);

  /* Advance one step. */
  await page.getByRole('button', { name: /^next$/i }).click();
  await waitForBubble(page, /your library/i);

  /* Back should return to the Welcome step. */
  await page.getByRole('button', { name: /^back$/i }).click();
  await waitForBubble(page, /welcome to castwright/i);

  /* Back is not shown on step 0. */
  await expect(page.getByRole('button', { name: /^back$/i })).toHaveCount(0);
});

/* ══════════════════════════════════════════════════════════════════════════
   Test 4 — per-screen mini-tour: cast "Show me this screen".
   Approach: start the linear tour (seeds the sample), skip it to land on
   the library view, navigate to the sample book's cast view, then trigger
   "Show me this screen" which starts a screen-scoped tour on the cast steps
   (s6-roster, s7-drawer, s8-fullcast). Verify the bubble renders and the
   screen tour ends after its last step.
   ══════════════════════════════════════════════════════════════════════════ */
test('per-screen mini-tour: cast "Show me this screen"', async ({ page }) => {
  await page.goto('/#/');

  /* Seed the sample + start tour so the Coalfall book is in the library. */
  await openHelpAndClick(page, /take the tour/i);
  await waitForBubble(page, /welcome to castwright/i);

  /* Skip the linear tour immediately. */
  await page.getByRole('button', { name: /^skip$/i }).click();
  await expect(page.getByTestId('tour-overlay')).toHaveCount(0);

  /* Navigate to the Coalfall cast view via the hash router. */
  const SAMPLE_BOOK_ID = 'castwright__standalones__the-coalfall-commission';
  await page.goto(`/#/books/${SAMPLE_BOOK_ID}/cast`);

  /* Wait for the cast roster to mount (the data-tour-id anchor for s6). */
  await expect(page.locator('[data-tour-id="cast-roster"]')).toBeVisible({ timeout: 12_000 });

  /* Start "Show me this screen" for the cast view. */
  await openHelpAndClick(page, /show me this screen/i);

  /* The first cast step bubble should appear. */
  await waitForBubble(page, /meet the cast/i);

  /* Advance through the remaining cast screen steps (s7, s8). The overlay
     scopes its dots/Back/Done to the active screen slice, so the final cast
     step (s8) labels the advance button "Done", not "Next". */
  const CAST_STEPS = 3; // s6-roster, s7-drawer, s8-fullcast
  for (let i = 1; i < CAST_STEPS; i++) {
    await page.getByRole('button', { name: /^next$/i }).click();
    await expect(page.getByTestId('tour-bubble')).toBeVisible({ timeout: 8_000 });
    await page.waitForTimeout(100);
  }

  /* Last cast step — the button reads "Done"; clicking it ends the screen tour. */
  await page.getByRole('button', { name: /^done$/i }).click();

  /* Tour overlay must disappear once the screen tour exhausts its steps. */
  await expect(page.getByTestId('tour-overlay')).toHaveCount(0, { timeout: 5_000 });
});
