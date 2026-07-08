/* Marketing screenshot capture runner. Iterates the scene registry across the
   requested viewports and writes `<id>.<viewport>.png` to git-ignored
   mockups/marketing-screens/. Driven by playwright.marketing.config.ts
   (Vite in `--mode marketing` → mock mode + VITE_DEMO_CAPTURE=1).

   Run: `npm run capture:marketing` (all desktop) or
   `CAPTURE_SCENE=<id> npm run capture:marketing` (one), or add
   `--project=phone --project=tablet` for responsive variants. */
import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENES, type Viewport } from './scenes';

const OUT = resolve(process.cwd(), 'mockups', 'marketing-screens');
mkdirSync(OUT, { recursive: true });

/* Registry guard (folded in from the dropped vitest, since vitest's include is
   src/** only): fail loudly on a malformed registry before capturing. */
const ids = SCENES.map((s) => s.id);
if (new Set(ids).size !== ids.length) throw new Error('marketing scenes: duplicate scene id');
for (const s of SCENES)
  if (!s.hash.startsWith('#/')) throw new Error(`marketing scene ${s.id}: hash must start with #/`);

const onlyScene = process.env.CAPTURE_SCENE; // optional single-scene filter

/* Wait until every <img> on the page has decoded — the book covers are large
   PNGs and won't be painted within a fixed settle. Non-fatal (a broken image
   shouldn't abort the run). */
async function waitForImages(page: import('@playwright/test').Page) {
  /* Force lazy images (e.g. the continue-listening rail covers) to fetch even
     below the fold. A full-page capture resizes the viewport AFTER this, which
     would otherwise trigger a deferred lazy fetch and paint the cover mid-decode
     (the Coalfall rail cover did exactly this). */
  await page
    .evaluate(() => {
      for (const img of Array.from(document.images)) if (img.loading === 'lazy') img.loading = 'eager';
    })
    .catch(() => {});

  /* Every <img> has finished loading... */
  await page
    .waitForFunction(
      () => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => {});

  /* ...AND finished decoding. `complete` can be true before the bitmap is
     decoded/painted, so await decode() on each to guarantee a clean frame. */
  await page
    .evaluate(() => Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {}))))
    .catch(() => {});
}

for (const scene of SCENES) {
  if (onlyScene && scene.id !== onlyScene) continue;
  const viewports = scene.viewports ?? (['desktop'] as Viewport[]);

  test(`capture ${scene.id}`, async ({ page }, testInfo) => {
    const vp = testInfo.project.name as Viewport;
    test.skip(!viewports.includes(vp), `viewport ${vp} not requested for ${scene.id}`);

    /* Hydrate the library slice first — several views (e.g. the listen cover at
       routes/index.tsx:833) read book data from `s.library.books`, which is
       only populated by visiting the library. On a cold deep-link it would be
       empty. The store persists across hash navigations, so one warm visit to
       `#/` primes it for every scene. */
    await page.goto('/#/');
    await page
      .waitForSelector('[data-testid="book-cover-hollow-tide-1"]', { timeout: 30_000 })
      .catch(() => {});

    await page.goto('/' + scene.hash);
    if (scene.waitFor) {
      // Non-fatal by default: if a view never reaches its content selector we
      // still want a screenshot (plus a console note) rather than an aborted
      // run. `strict: true` scenes re-throw instead.
      try {
        await page.waitForSelector(scene.waitFor, { timeout: 20_000 });
      } catch (err) {
        if (scene.strict) throw err;
        console.warn(`[capture] ${scene.id}: waitFor "${scene.waitFor}" timed out — capturing anyway`);
      }
    }
    await waitForImages(page);

    if (scene.action) {
      try {
        await scene.action(page);
        await page.waitForTimeout(300); // let the modal's open transition settle
      } catch (err) {
        if (scene.strict) throw err;
        console.warn(`[capture] ${scene.id}: action failed — capturing pre-interaction:`, err);
      }
    }

    /* Confirms the action actually reached its target state (unlike
       `waitFor` above, which runs BEFORE `action` and can only ever confirm
       pre-action page state). This is the field every interaction scene in
       this repo's screenshot plan uses to verify a modal opened / a section
       expanded, rather than merely that a click didn't throw. */
    if (scene.waitForAfterAction) {
      try {
        await page.waitForSelector(scene.waitForAfterAction, { timeout: 20_000 });
      } catch (err) {
        if (scene.strict) throw err;
        console.warn(
          `[capture] ${scene.id}: waitForAfterAction "${scene.waitForAfterAction}" timed out — capturing anyway`,
        );
      }
    }

    /* Frame a below-the-fold region (e.g. the continue-listening rail). Non-fatal
       — a missing target shouldn't abort the run. */
    if (scene.scrollTo) {
      await page
        .locator(scene.scrollTo)
        .evaluate((el) => el.scrollIntoView({ block: 'center' }))
        .catch(() => {});
    }

    /* Capture each requested theme. The app's default theme preference is
       "system", so emulating `prefers-color-scheme` re-themes it without any
       app change. Default: both light + dark; `CAPTURE_THEME=light|dark` limits
       to one. Output: `<scene>.<viewport>.<theme>.png`. */
    const themes = (
      process.env.CAPTURE_THEME ? [process.env.CAPTURE_THEME] : ['light', 'dark']
    ) as ('light' | 'dark')[];
    const fullPage = scene.fullPage ?? process.env.CAPTURE_FULLPAGE === '1';
    /* Full-page screenshots scroll-and-stitch multiple viewport-sized strips
       together. top-bar.tsx's `<header className="sticky top-0 z-40 …">`
       stays pinned to whatever viewport slice was active when Playwright
       captured it, so it gets composited into the stitched image at that
       scroll offset instead of once at the true top — a duplicated/misplaced
       header floating mid-page on any fullPage scene tall enough to need
       more than one strip. Forcing it to `position: static` just for the
       fullPage shot renders it once, in its real DOM position (the top of
       the page). Scoped to `header.z-40` (top-bar.tsx's own z-index, unique
       among this codebase's <header> elements) rather than the broader
       `header.sticky`, which also matches revision-diff.tsx's unrelated
       `sticky top-0 z-10` in-page header — flattening that one too would be
       an unintended regression for any fullPage scene landing on that view. */
    if (fullPage) {
      await page.addStyleTag({ content: 'header.z-40 { position: static !important; }' });
    }
    for (const theme of themes) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForTimeout(400); // settle the theme re-render
      await page.screenshot({
        path: resolve(OUT, `${scene.id}.${vp}.${theme}.png`),
        fullPage,
      });
    }
  });
}
