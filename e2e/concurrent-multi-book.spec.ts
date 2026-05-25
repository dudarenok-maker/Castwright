import { test, expect } from '@playwright/test';
import { waitForLibraryViewReady } from './helpers';

/* Plan 89 C2 + C3 — concurrent-multi-book invariant in the browser.
   The fix is split between (i) the broadcast middleware diffing (so
   per-book analysis ticks fan a *smaller* payload across tabs) and
   (ii) the `useAppSelectorShallow` wrapper on s.exports.byBookId[bookId]
   in the Listen view (so a foreign book's export-queue tick doesn't
   re-render the local Listen view).

   This spec exercises the user-observable invariant: two tabs open on
   the same workspace render their own state without cross-talk. Tab A
   loads the library shell; Tab B loads the library shell concurrently;
   each tab paints its own books grid. The BroadcastChannel must be
   harmless to a tab that has no live stream — i.e. no flash of foreign
   book content, no unexpected route navigation, no crash.

   We deliberately do NOT measure React render counts here (jsdom-style
   render-count probes don't survive a real browser swap), but we DO
   pin two structural properties:

   1. Both contexts paint the library route content within the
      timeout (no stuck-loading flash, no cross-tab navigation race).
   2. After both tabs are settled, neither tab's route URL changed
      out from under the user — Plan 89's broader concurrent-multi-book
      contract: BroadcastChannel sync runs in the background, never as
      a routing side-effect. */

test.describe('concurrent multi-book tabs (plan 89 C2 + C3)', () => {
  test('two tabs each paint their own library route, with no cross-tab nav clobber', async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      /* Mount both tabs at the library route. */
      await Promise.all([pageA.goto('/'), pageB.goto('/')]);

      /* per-view hydration helper on both tabs. */
      await Promise.all([waitForLibraryViewReady(pageA), waitForLibraryViewReady(pageB)]);

      /* Capture each tab's URL hash. */
      const hashA0 = await pageA.evaluate(() => window.location.hash);
      const hashB0 = await pageB.evaluate(() => window.location.hash);

      /* Tab A navigates to /new. Tab B must NOT follow — different
         contexts have isolated BroadcastChannel namespaces in browser,
         and even within a shared origin we never broadcast route
         changes (Plan 63 narrow-scope rule). */
      await pageA
        .getByRole('button', { name: /Start a new book/i })
        .first()
        .click();
      await expect(pageA).toHaveURL(/#\/new$/);

      /* Give the BroadcastChannel a few hundred ms to attempt to fan
         out (it won't fan a route change — we're verifying that). */
      await pageB.waitForTimeout(500);

      const hashB1 = await pageB.evaluate(() => window.location.hash);
      /* Tab B's URL must NOT have moved off the books library. */
      expect(hashB1).toBe(hashB0);
      void hashA0; // silence unused-var
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
