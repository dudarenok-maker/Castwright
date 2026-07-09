/* Task 15 (script-review-persistence plan, 2026-07-09) — browser-level proof
 * that script-review findings survive the two things that used to lose them:
 *
 *   1. Closing the modal via a click that lands on its full-viewport backdrop
 *      (the ORIGINAL bug: `handleClose` used to dispatch `clearReview`, which
 *      wiped the whole bucket — see script-review-diff.tsx's `handleClose`).
 *   2. A page reload mid-review or after a completed-but-unactioned review
 *      (the whole point of this plan: server-side persistence + reconciliation
 *      via `hydrateScriptReview` on mount — see src/store/script-review-thunk.ts).
 *
 * Setup pattern (hash-route goto + hydration signals) copied from the two
 * existing, passing script-review specs: e2e/script-review.spec.ts and
 * e2e/script-review-instruct.spec.ts. Deviations from the task brief's rough
 * sketch, and why, are documented inline below and in the Task 15 report.
 *
 * Mock-mode persistence note: `src/lib/api.ts`'s `mockGetScriptReviewState`
 * used to be a hardcoded `{ kind: 'ledger', entries: {} }` stub (confirmed by
 * Task 9's own report as a known, called-out gap) — e2e always runs mock mode
 * (playwright.config.ts never starts the real Node backend), so a
 * `page.reload()` had nothing genuine to hydrate from. This spec's reload
 * tests only became possible once that stub grew a small sessionStorage-
 * backed shim (same file) that mirrors what the real ledger does closely
 * enough to observe reload-survival through the browser. */

import { test, expect } from '@playwright/test';

/* >=1280 (xl) so the inline top-bar tab strip renders instead of the
 * hamburger drawer (design spec §8; confirmed via
 * e2e/responsive/topbar-nav.spec.ts's own `width >= 1280` skip threshold).
 * The first test below clicks the real "Cast" tab and relies on the
 * script-review modal's full-viewport backdrop (z-50) sitting ABOVE the
 * sticky top bar (z-40, top-bar.tsx) to reproduce the original bug's exact
 * mechanism — bumped to 1366 (comfortably past the 1280 boundary) rather
 * than sitting exactly on it, so viewport-rounding/scrollbar-width can't
 * flip the strip into the hamburger and break that click. */
test.use({ viewport: { width: 1366, height: 900 } });

test.describe('script review persistence (Task 15)', () => {
  test('clicking through the modal backdrop closes without discarding findings', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const reviewBtn = page.getByTestId('review-script-chapter');
    await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();

    await expect(page.getByRole('heading', { name: /Script review suggestions/i })).toBeVisible({
      timeout: 10_000,
    });

    /* THE regression: a click that lands on the backdrop while it's up.
     * `getByRole('button', { name: 'Cast' }).click()` would NOT reproduce
     * this — Playwright's actionability check refuses to click an element
     * a different, stably-on-top element is intercepting (the modal
     * backdrop, z-50, sits above the top bar's z-40), so it would just time
     * out with an "intercepts pointer events" error rather than exercising
     * `handleClose`. A raw `page.mouse.click(x, y)` at the Cast tab's
     * on-screen position skips that per-locator check and dispatches a real
     * pointer event at that coordinate — which the browser delivers to
     * whatever is topmost there (the backdrop), exactly reproducing how a
     * user's attempted nav-tab click used to silently wipe the findings. */
    const castTab = page.getByRole('button', { name: 'Cast', exact: true });
    await expect(castTab).toBeVisible();
    const box = await castTab.boundingBox();
    if (!box) throw new Error('Cast tab has no bounding box to click through the backdrop.');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    /* The backdrop click closes the modal either way (buggy or fixed) — the
     * real assertion is whether the findings survived it. */
    await expect(
      page.getByRole('heading', { name: /Script review suggestions/i }),
    ).toBeHidden({ timeout: 8_000 });
    await expect(reviewBtn).toContainText('(');

    /* We never actually navigated (the backdrop swallowed the click) —
     * confirm that, then also prove the complementary invariant: genuinely
     * switching views and back (unmount/remount of ManuscriptView, which
     * re-runs the hydrateScriptReview mount effect) doesn't lose the
     * findings either. */
    await expect(page).toHaveURL(/#\/books\/sb\/manuscript/);
    await page.goto('/#/books/sb/cast');
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await expect(reviewBtn).toContainText('(', { timeout: 8_000 });
  });

  test('reloading mid-review resumes progress without resetting to 0%', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* review-script-wholebook lives behind the scope-picker disclosure
     * (data-testid="review-script-menu-toggle") — it isn't rendered until
     * that menu is opened. */
    await page.getByTestId('review-script-menu-toggle').click();
    const wholeBookBtn = page.getByTestId('review-script-wholebook');
    await expect(wholeBookBtn).toBeVisible({ timeout: 5_000 });
    await wholeBookBtn.click();

    const pill = page.getByTestId('review-script-progress');
    await expect(pill).toBeVisible({ timeout: 5_000 });

    /* The pill mounts at 0% the instant the run starts (runReviewScript
     * dispatches setActive({progress: 0, ...}) before the mock's first
     * onPhase fires ~60ms later) — reading it immediately would be racy
     * and could legitimately show "0%" even on correct code. Poll for the
     * mock's first real phase (25%) to land before reloading, so the
     * post-reload assertion is actually about resume behavior, not a
     * mount-order coincidence. The percent itself has no dedicated
     * data-testid (only the optional chapter/ETA detail span does, via
     * detailTestId — the brief's original sketch pointed at that span
     * expecting a "0%"-shaped string, but it renders "Chapter N of M" /ETA
     * text, never a percent), so read the whole pill's text and parse the
     * trailing "N%" out of it. */
    const readPercent = async (): Promise<number> => {
      const text = (await pill.textContent()) ?? '';
      const m = text.match(/(\d+)%/);
      return m ? Number(m[1]) : 0;
    };
    await expect.poll(readPercent, { timeout: 5_000 }).toBeGreaterThan(0);

    await page.reload();

    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await expect(pill).toBeVisible({ timeout: 8_000 });
    await expect.poll(readPercent, { timeout: 5_000 }).toBeGreaterThan(0);
  });

  test('reloading after a completed-but-unactioned review restores findings and the badge', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const reviewBtn = page.getByTestId('review-script-chapter');
    await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();

    await expect(page.getByRole('heading', { name: /Script review suggestions/i })).toBeVisible({
      timeout: 10_000,
    });

    /* close-button (the X) is handleClose too — hide, not discard. */
    await page.getByTestId('close-button').click();
    await expect(
      page.getByRole('heading', { name: /Script review suggestions/i }),
    ).toBeHidden({ timeout: 8_000 });

    await page.reload();

    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await expect(reviewBtn).toContainText('(', { timeout: 10_000 });
  });
});
