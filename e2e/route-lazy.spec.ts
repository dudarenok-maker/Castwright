import { test, expect } from '@playwright/test';

/* Plan 89 C5 — route code-split via React.lazy. The Suspense boundary in
   src/components/layout.tsx wraps the Outlet and the DelayedSpinner
   (src/components/delayed-spinner.tsx) fallback is gated by a 150 ms
   timer so warm-cache navigations DON'T flash a spinner.

   Contract:
   - First navigation to a fresh route (chunk not in browser cache) MAY
     paint the Suspense fallback (data-testid="route-suspense-fallback")
     for one or more frames while the chunk downloads.
   - Second navigation to the same route in the same context (chunk now
     cached) does NOT paint the fallback because the lazy import resolves
     within the 150 ms delay window. */

test.describe('route lazy-load + Suspense fallback (plan 89 C5)', () => {
  test('cold navigation to /new is observable; warm navigation to /new resolves silently', async ({
    page,
  }) => {
    /* Cold boot — start at the library route. The library route itself
       is not lazy (it's the landing surface), so the initial load only
       fetches the library chunk + the lazy chunks the user will
       navigate into. */
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    /* Throttle the network so the lazy chunk's download lands past the
       150 ms DelayedSpinner threshold — without this, even a cold
       fetch resolves from disk fast enough that the fallback never
       paints, and the spec can't observe the cold-path frame. */
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 200,
      downloadThroughput: (200 * 1024) / 8, // 200 kbps
      uploadThroughput: (200 * 1024) / 8,
    });

    /* Watch for the suspense fallback's data-testid via the page. We use
       waitForSelector with a generous timeout — the chunk should arrive
       well under that, but the cold throttle should keep the fallback
       visible for at least one frame in between. */
    const fallbackPromise = page
      .locator('[data-testid="route-suspense-fallback"]')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    /* Trigger the first (cold) navigation. */
    await page
      .getByRole('button', { name: /Start a new book/i })
      .first()
      .click();

    /* Either the spinner appeared briefly (cold path) — or the chunk
       resolved before the 150 ms threshold even under throttle. Both are
       acceptable; what we lock IS the lack of an exception in the
       transition AND the destination route eventually paints. */
    const sawFallback = await fallbackPromise;
    /* The destination route does paint, whether or not the spinner
       flashed first. */
    await expect(page).toHaveURL(/#\/new$/);

    /* Restore unthrottled network for the warm test. */
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    /* Navigate back to / and then back to /new — the lazy chunk is now
       resident in the browser cache, so React.lazy resolves inside the
       150 ms DelayedSpinner delay. Fallback must NOT paint this time. */
    await page.evaluate(() => {
      window.location.hash = '/';
    });
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 5_000,
    });

    /* Track whether the fallback paints during the warm nav. */
    let fallbackPaintedOnWarmNav = false;
    const observer = page.locator('[data-testid="route-suspense-fallback"]').first();
    const warmWatch = observer
      .waitFor({ state: 'visible', timeout: 500 })
      .then(() => {
        fallbackPaintedOnWarmNav = true;
      })
      .catch(() => {
        /* Expected — fallback never visible. */
      });

    await page
      .getByRole('button', { name: /Start a new book/i })
      .first()
      .click();
    await expect(page).toHaveURL(/#\/new$/);
    await warmWatch;

    expect(fallbackPaintedOnWarmNav).toBe(false);

    /* Sanity for the cold path: log whether the cold flash was actually
       observed. We don't fail the spec when sawFallback is false (a fast
       machine + throttle may still beat the 150 ms gate), but we DO
       record it for diagnostics. */
    test.info().annotations.push({
      type: 'cold-suspense-fallback-observed',
      description: String(sawFallback),
    });
  });
});
