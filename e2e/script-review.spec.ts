/* fs-58 — browser-level proof of the per-chapter LLM script-review flow:
 *
 *  1. Open the Solway Bay fixture book to the manuscript view.
 *  2. Click the per-chapter "Review Script" button.
 *  3. The ScriptReviewDiff modal opens showing the mock strip_tag suggestion.
 *  4. Accept (Apply) — sentence id:1 gets text "x".
 *  5. Navigate to the Generate view — chapter 3 shows the stale badge
 *     because a boundary_move was logged after its audioRenderedAt.
 *
 * Mock contract: `mockReviewScript` returns a deterministic op:
 *   { chapterId: 1, ops: [{ id: 1, op: 'strip_tag', newText: 'x', rationale: 'tag' }] }
 * `initialSentences` seeds sentence id:1 in chapter 3, so planApply
 * resolves it and dispatchAcceptedOps fires setSentenceText + bumpBoundaryMove
 * for chapterId 3.
 *
 * Stale badge precondition: we inject a past `audioRenderedAt` onto chapter 3
 * via window.__store__ so `isChapterStaleFromReassign` trips when the
 * boundary_move timestamp is newer. */

import { test, expect } from '@playwright/test';

/* Serial mode: the store-injection and stale-badge assertion depend on a
   specific chapter state; run sequentially so parallel workers can't
   collide on the same in-memory Vite dev server mock state. */
test.describe.configure({ mode: 'serial' });

type Store = {
  getState: () => {
    chapters: {
      chapters: Array<{
        id: number;
        state: string;
        audioRenderedAt?: string;
      }>;
    };
    manuscript: {
      sentences: Array<{ id: number; chapterId: number; text: string }>;
    };
  };
  dispatch: (action: unknown) => void;
};

test.describe('fs-58 — script-review per-chapter accept flow', () => {
  test('modal opens → accept → sentence updated → stale badge in Generate', async ({ page }) => {
    /* Navigate directly to the Solway Bay fixture book manuscript view.
       SB is the fixture with 18 done chapters, populated by buildSolwayBayMockState.
       The manuscript slice uses initialSentences (chapterId: 3 for id:1) because
       SB's manuscriptEdits is null.
       READY_DEFAULTS seeds currentChapterId = 3, so the "per-chapter" review
       targets chapter 3. */
    await page.goto('/#/books/sb/manuscript');

    /* Wait for the manuscript view to hydrate — the chapter heading (h1) for
       chapter 3 is our hydration signal. */
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* Inject a past audioRenderedAt on chapter 3 so the stale gate trips
       after the boundary_move from Accept. The time must predate the
       boundary_move we're about to trigger; using a 2-hour-old ISO string
       is safely in the past. */
    const pastRenderedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await page.evaluate((renderedAt) => {
      const store = (window as unknown as { __store__: Store }).__store__;
      const chapters = store.getState().chapters.chapters;
      const patched = chapters.map((c) =>
        c.id === 3 ? { ...c, state: 'done', audioRenderedAt: renderedAt } : c,
      );
      store.dispatch({ type: 'chapters/setChapters', payload: patched });
    }, pastRenderedAt);

    /* Click the per-chapter "Review Script" button. The mock resolves in ~60 ms.
       The button label flips to "Reviewing…" then back; wait for the modal. */
    const reviewBtn = page.getByTestId('review-script-chapter');
    await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();

    /* The ScriptReviewDiff modal opens once mockReviewScript resolves and
       setReview lands in the store. The modal header is the hydration signal. */
    await expect(page.getByRole('heading', { name: /Script review suggestions/i })).toBeVisible({
      timeout: 10_000,
    });

    /* The mock op is strip_tag: the class heading "Strip tag" should be visible. */
    await expect(page.getByText(/Strip tag/i)).toBeVisible();

    /* The "Apply N selected" button — 1 op selected by default. */
    const applyBtn = page.getByTestId('apply-button');
    await expect(applyBtn).toBeVisible();
    await expect(applyBtn).toContainText(/Apply 1 selected/i);

    /* Accept: click Apply → dispatchAcceptedOps fires setSentenceText on
       sentence id:1 (chapterId:3) with newText:"x" and bumpBoundaryMove for
       chapterId:3 at a timestamp AFTER the injected pastRenderedAt. */
    await applyBtn.click();

    /* Modal should close after Apply. */
    await expect(
      page.getByRole('heading', { name: /Script review suggestions/i }),
    ).toBeHidden({ timeout: 5_000 });

    /* Assert the sentence text was updated. Sentence id:1 lives in chapterId:3;
       `dispatchAcceptedOps` dispatches setSentenceText with newText: 'x'. */
    const sentenceUpdated = await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      const s = store.getState().manuscript.sentences.find((s) => s.id === 1 && s.chapterId === 3);
      return s?.text === 'x';
    });
    expect(sentenceUpdated, 'sentence id:1 text should be "x" after accept').toBe(true);

    /* Navigate to the Generate view. The stale badge for chapter 3 should be
       visible because a boundary_move was logged for chapterId:3 AFTER
       pastRenderedAt, satisfying isChapterStaleFromReassign. */
    await page.goto('/#/books/sb/generate');

    /* Wait for the Generate view to hydrate — CH 03 appears once chapters load. */
    await expect(page.getByText(/^CH 03$/)).toBeVisible({ timeout: 10_000 });

    /* The stale badge is a span with "⚠ Sentences reassigned · regenerate to refresh"
       visible beneath the chapter 3 row. */
    await expect(
      page.getByText(/Sentences reassigned.*regenerate to refresh/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});
