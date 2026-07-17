/* #1679 — manuscript view scene divider.

   The divider renders in src/views/manuscript.tsx above any segment whose
   head sentence carries `sceneBreakBefore: true` (server-set flag). e2e runs
   against Vite in mock mode, so we inject a synthetic sentence set via the
   dev-only `window.__store__` hook (src/main.tsx) the same way
   manuscript-virtualisation.spec.ts does — this is spec-local and never
   touches the shared mock manuscript data, so no other spec is affected.

   Covers BOTH render branches in one spec: the flat path (<60 segments) and
   the virtualized path (>=60 segments, react-virtual window). Unit tests
   (jsdom) can't reach the virtualized branch because jsdom doesn't measure
   layout — this is the browser-side proof. */

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test.describe('manuscript view — scene divider (#1679)', () => {
  test('flat render: divider shows above the segment following a scene break', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapters$/, level: 2 })).toBeVisible({
      timeout: 15_000,
    });

    /* 10 alternating-character sentences (well below the 60-segment
       threshold) with a scene break on sentence index 4. Alternating
       characters guarantees one segment per sentence, and the break sits
       on a non-first segment (index 0 never renders a divider — it's the
       top of the chapter, not a mid-chapter scene change). */
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __store__: { getState: () => unknown; dispatch: (a: unknown) => unknown };
        }
      ).__store__;
      const manuscript = (
        store.getState() as {
          manuscript: { bookId: string | null; manuscriptId: string | null; title: string | null };
        }
      ).manuscript;
      const sentences = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        chapterId: 3,
        characterId: i % 2 === 0 ? 'narrator' : 'halloran',
        /* Real analyzer shape: the scene-break glyph is captured as its OWN
           word-free sentence (i=4), and the TRUE opener (i=5) carries the flag.
           The glyph row must be suppressed; the divider represents it. */
        text: i === 4 ? '* * *' : `Flat scene-divider fixture sentence ${i + 1}.`,
        ...(i === 5 ? { sceneBreakBefore: true } : {}),
      }));
      store.dispatch({
        type: 'manuscript/hydrateFromBookState',
        payload: {
          state: {
            bookId: manuscript.bookId,
            manuscriptId: manuscript.manuscriptId,
            title: manuscript.title,
          },
          sentences,
        },
      });
    });

    /* Flat path — no virtual container in the DOM. */
    await expect(page.getByTestId('manuscript-virtual-container')).toHaveCount(0);
    await expect(page.getByTestId('scene-divider').first()).toBeVisible();
    /* The glyph sentence is suppressed from display — only the divider represents it. */
    await expect(page.getByText('* * *', { exact: true })).toHaveCount(0);
  });

  test('virtualized render: divider shows inside the windowed >=60-segment view', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapters$/, level: 2 })).toBeVisible({
      timeout: 15_000,
    });

    /* 200 alternating-character sentences (same recipe as
       manuscript-virtualisation.spec.ts) to trip the >=60-segment
       virtualizer threshold, with a scene break early (index 4) so the
       flagged segment lands inside the default overscan window and is
       actually mounted in the DOM without needing to scroll. */
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __store__: { getState: () => unknown; dispatch: (a: unknown) => unknown };
        }
      ).__store__;
      const manuscript = (
        store.getState() as {
          manuscript: { bookId: string | null; manuscriptId: string | null; title: string | null };
        }
      ).manuscript;
      const sentences = Array.from({ length: 200 }, (_, i) => ({
        id: i + 1,
        chapterId: 3,
        characterId: i % 2 === 0 ? 'narrator' : 'halloran',
        /* Real analyzer shape: glyph as its own word-free sentence (i=4),
           flag on the true opener (i=5). Both sit in the initial virtual
           window so the divider mounts without scrolling. */
        text:
          i === 4
            ? '* * *'
            : `Synthetic sentence ${i + 1} for virtualisation perf coverage. Padding to give the row some real height: lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
        ...(i === 5 ? { sceneBreakBefore: true } : {}),
      }));
      store.dispatch({
        type: 'manuscript/hydrateFromBookState',
        payload: {
          state: {
            bookId: manuscript.bookId,
            manuscriptId: manuscript.manuscriptId,
            title: manuscript.title,
          },
          sentences,
        },
      });
    });

    await expect(page.getByTestId('manuscript-virtual-container')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('scene-divider').first()).toBeVisible();
  });
});
