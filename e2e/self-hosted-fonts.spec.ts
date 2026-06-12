import { test, expect } from '@playwright/test';

/* #698 — webfonts are self-hosted (public/fonts/), so page.goto()'s `load`
 * event never waits on an external CDN. Under parallel-worker contention a slow
 * CDN pushed `goto` past its 60s budget and flaked the pre-push e2e gate; the
 * spike proved it causally (goto ~28s with a slow external font vs ~1s without).
 *
 * This is the behavioural regression test: across the cold-boot route and two
 * historically-flaky direct-goto lazy routes, the page must make ZERO requests
 * to a font CDN, and the real webfonts must end up loaded from same-origin. */

const FONT_CDN =
  /(api\.fontshare\.com|cdn\.fontshare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/;

test('no external font requests; webfonts load same-origin', async ({ page }) => {
  // Three sequential gotos (incl. two lazy routes) can run long on a cold Vite
  // dev server in isolation; the shared-server suite is warm. Generous budget.
  test.setTimeout(60_000);

  const externalFontRequests: string[] = [];
  page.on('request', (req) => {
    if (FONT_CDN.test(req.url())) externalFontRequests.push(req.url());
  });

  // goto's default waitUntil:'load' is enough — external font CSS would be
  // requested during <head> parse, before `load`, so the listener catches it.
  // (We deliberately avoid 'networkidle': the mock app's polling middleware
  // keeps the network busy, so it never settles.)
  for (const route of ['/', '/#/about', '/#/admin']) {
    await page.goto(route);
  }

  expect(externalFontRequests, 'page must not request any external font CDN').toEqual([]);

  // Prove the self-hosted faces are present AND loadable. We force the load
  // (rather than document.fonts.check(), which returns true even for a missing
  // family) — the src is now same-origin, so a broken/missing woff2 would leave
  // the face unloaded and fail the assertion. Any request this triggers is
  // also still watched by the listener above, so it can't be external.
  const loaded = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 1em "General Sans"'),
      document.fonts.load('italic 400 1em "Lora"'),
    ]);
    return [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => f.family.replace(/['"]/g, ''));
  });
  expect(loaded, 'General Sans should load from same-origin').toContain('General Sans');
  expect(loaded, 'Lora should load from same-origin').toContain('Lora');
  expect(externalFontRequests, 'forced font load must stay same-origin too').toEqual([]);
});
