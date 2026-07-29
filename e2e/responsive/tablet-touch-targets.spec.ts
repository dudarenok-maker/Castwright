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
       proves the fix does NOT oversize the control for mouse users. At the
       pinned 768px viewport this does NOT by itself prove the shrink is
       pointer-driven rather than the old width-driven bug: both the old
       `sm:`/`md:` classes and the new `fine-pointer:` classes shrink under a
       fine pointer at 768px, so a regression back to the old width-driven
       classes would still pass every assertion at this viewport. The
       narrow-viewport (400px) tests below close that gap — see their own
       comment for why 400px specifically discriminates the two.
     - mobile-chrome / tablet-chrome (opt-in `test:e2e:mobile`): coarse
       pointer — proves the 44px floor actually holds on a touch device.
   The viewport is pinned to 768px (tablet width, ≥ both the old `sm:` (640)
   and `md:` (768) breakpoints the bug shrank at) regardless of project, so
   the same width is exercised under every pointer type. */

import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { waitForListenViewReady, goToConfirm, waitForConfirmViewReady } from '../helpers';

/* mobile-chrome forces the same 768px viewport as tablet-chrome below (both
   are coarse-pointer projects), so it exercises exactly the same assertions
   for zero extra signal — skip it here rather than pay for a duplicate run. */
// Playwright's fixture-detection heuristic requires the literal
// object-destructuring shape here, even with no fixture actually used.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile-chrome',
    'this spec forces a 768px tablet viewport; mobile-chrome duplicates tablet-chrome at that same viewport for zero extra signal',
  );
});

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

/* Five more sites carrying the same superseded `sm:`/`md:` width-breakpoint
   pattern, reported (not fixed) in 720fb64f's commit body as out-of-scope
   for #1935's three-control fix. Same treatment, same two-sided proof. */
test.describe('tablet-range touch targets — five more sites', () => {
  test('chapter play/pause button stays ≥44px on any touch device', async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);

    const playPause = page.getByRole('button', { name: /^(Play|Pause) chapter 1$/ }).first();
    await assertTouchTarget(playPause, 'chapter play/pause button', true);
  });

  test('marker "Fix this line", kind-toggle, and delete buttons stay ≥44px on any touch device', async ({
    page,
  }: {
    page: Page;
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);

    // Markers aren't seeded by the stock mock rows — dispatch one directly
    // into the store (same pattern as e2e/qa-repair.spec.ts's chapter-flag
    // seed) so the "Fix this line" / kind-toggle / delete row renders.
    // kind: 'rerecord' is required for the "Fix this line" button to render
    // at all (see listen-player-region.tsx's MarkersPanel).
    await page.evaluate(() => {
      type StoreWin = { __store__?: { dispatch: (a: unknown) => void } };
      const s = (window as unknown as StoreWin).__store__;
      if (!s) throw new Error('window.__store__ not exposed (e2e gate regressed)');
      s.dispatch({
        type: 'listenProgress/addMarker',
        payload: {
          bookId: 'sb',
          marker: {
            id: 'e2e-touch-target-marker',
            chapterId: 1,
            sec: 5,
            label: 'touch-target probe',
            kind: 'rerecord',
            createdAt: new Date().toISOString(),
          },
        },
      });
    });

    const fixLine = page.getByTestId('listen-marker-fix-e2e-touch-target-marker');
    const kindToggle = page.getByTestId('listen-marker-kind-e2e-touch-target-marker');
    const deleteBtn = page.getByTestId('listen-marker-delete-e2e-touch-target-marker');

    // "Fix this line" is a padding-driven pill (px-3, no fixed width) like
    // the voice-override-picker trigger above — no min-width to check.
    await assertTouchTarget(fixLine, 'marker "Fix this line" button', false);
    await assertTouchTarget(kindToggle, 'marker kind-toggle button', true);
    await assertTouchTarget(deleteBtn, 'marker delete button', true);
  });

  test('mini-player Next-issue button stays ≥44px on any touch device', async ({
    page,
  }: {
    page: Page;
  }) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width: 768, height: 1024 });
    // Suppress real playback (same stub as e2e/issue-waveform.spec.ts) so
    // the stub MP3 never fires timeupdate events during the measurement.
    await page.addInitScript(() => {
      (HTMLMediaElement.prototype as { play: () => Promise<void> }).play = () => Promise.resolve();
    });
    await page.goto('/#/books/sb/generate');
    await expect(page.getByText(/^CH 01$/)).toBeVisible({ timeout: 10_000 });
    await page
      .getByRole('button', { name: /^Preview$/ })
      .first()
      .click();

    // Only renders once getChapterAudio resolves and deriveIssues finds
    // suspect segments (seeded in mockGetChapterAudio — see api.ts).
    const nextIssue = page.getByTestId('mini-player-next-issue');
    await assertTouchTarget(nextIssue, 'mini-player Next-issue button', true);
  });
});

/* A sixth survivor of the same defect, found by independent review of this
   PR rather than by 720fb64f's own grep — which searched for `md:` +
   `min-*-0` + `w-8`/`w-9` shapes specifically, a pattern `sm:w-10 sm:h-10`
   doesn't match. Same treatment, same two-sided proof. */
test.describe('tablet-range touch targets — a sixth survivor', () => {
  test('mini-player Play/Pause button stays ≥44px on any touch device', async ({
    page,
  }: {
    page: Page;
  }) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width: 768, height: 1024 });
    // Same stub as the Next-issue test above — suppress real playback so
    // the stub MP3 never fires timeupdate events during the measurement.
    await page.addInitScript(() => {
      (HTMLMediaElement.prototype as { play: () => Promise<void> }).play = () => Promise.resolve();
    });
    await page.goto('/#/books/sb/generate');
    await expect(page.getByText(/^CH 01$/)).toBeVisible({ timeout: 10_000 });
    await page
      .getByRole('button', { name: /^Preview$/ })
      .first()
      .click();

    // Exact match ("Play"/"Pause") — distinct from the chapter row's own
    // "Play chapter 1"/"Pause chapter 1" button covered above.
    const playPause = page.getByRole('button', { name: /^(Play|Pause)$/ }).first();
    await assertTouchTarget(playPause, 'mini-player Play/Pause button', true);
  });
});

/* Closes a gap in the required (chromium-only) CI gate. At the pinned 768px
   viewport used by every test above, BOTH the pre-fix width-driven classes
   (`sm:`/`md:`) and the post-fix pointer-driven classes (`fine-pointer:`)
   shrink under a fine pointer — verified experimentally: the pre-fix
   classes pass all 6 chromium (`--project=chromium`, fine-pointer) cases
   above at 768px, because `assertTouchTarget`'s fine-pointer branch only
   asserts "stays compact", which is true either way. So a regression back
   to the width-driven classes would not, by itself, fail the required
   `test:e2e` gate.

   Below BOTH the old `sm:` (640) and `md:` (768) breakpoints, the two
   implementations diverge: the width-driven classes never activate their
   shrink at all — the control stays at its unshrunk base size (>=44px)
   regardless of pointer type, because `sm:`/`md:` are gated on viewport
   width alone. The pointer-driven classes shrink under a fine pointer at
   ANY viewport width, because `fine-pointer:` is gated on pointer type, not
   width. So at 400px under a fine pointer: width-driven classes measure
   >=44px (would fail the assertion below), pointer-driven classes measure
   compact (passes). This single assertion is what turns the required
   chromium leg into a genuine regression gate for this defect class.
   Mutation-verified: reverting mini-player.tsx's Next-issue button to its
   pre-fix classes (`min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0
   md:p-2`) fails this test. */
test.describe('tablet-range touch targets — narrow-viewport regression gate', () => {
  test('mini-player Next-issue button shrinks under a fine pointer even below the old sm:/md: breakpoints (400px)', async ({
    page,
  }: {
    page: Page;
  }) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width: 400, height: 900 });
    await page.addInitScript(() => {
      (HTMLMediaElement.prototype as { play: () => Promise<void> }).play = () => Promise.resolve();
    });
    await page.goto('/#/books/sb/generate');
    await expect(page.getByText(/^CH 01$/)).toBeVisible({ timeout: 10_000 });
    await page
      .getByRole('button', { name: /^Preview$/ })
      .first()
      .click();

    const nextIssue = page.getByTestId('mini-player-next-issue');
    await expect(nextIssue).toBeVisible({ timeout: 5_000 });
    const { height, isCoarse } = await measure(nextIssue);
    // Only discriminates old (width-driven) vs new (pointer-driven) shrink
    // under a FINE pointer (see header comment above) — a coarse-pointer
    // project reads >=44px for both implementations at this width, so skip
    // rather than assert something meaningless there.
    test.skip(
      isCoarse,
      'only discriminates old (width-driven) vs new (pointer-driven) shrink under a fine pointer',
    );
    expect(height, 'mini-player Next-issue height at 400px under a fine pointer').toBeLessThan(44);
  });
});
