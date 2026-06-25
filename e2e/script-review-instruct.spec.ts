/* fs-58 (#1041) — browser-level proof of the validate_instruct apply path:
 *
 *  1. Open the Solway Bay fixture book to the manuscript view.
 *  2. Inject an `instruct` onto sentence id:1 (chapter 3) via window.__store__ so
 *     the validate_instruct REPAIR has an existing instruct to act on — without
 *     it, T7's apply guard drops the repair and the diff row never renders (the
 *     fixture sentences ship with zero instruct fields).
 *  3. Click the per-chapter "Review Script" button.
 *  4. The ScriptReviewDiff modal opens with the mock validate_instruct suggestion;
 *     its class heading is "Instruct".
 *  5. Accept (Apply) — sentence id:1's instruct becomes "a calm tone" via
 *     dispatchAcceptedOps → setSentenceInstruct.
 *
 * Mock contract: `mockReviewScript` returns a deterministic op envelope including
 *   { id: 1, op: 'validate_instruct', newInstruct: 'a calm tone', rationale: '…' }
 * resolving against sentence id:1 in chapter 3 (initialSentences[0]).
 *
 * Heading disambiguation: the class heading is the literal text "Instruct"
 * (CLASS_LABELS.validate_instruct). We match it with an EXACT role/text matcher,
 * NOT a substring `getByText('Instruct')`, which would also match "Live instruct".
 */

import { test, expect } from '@playwright/test';

/* Serial mode: store-injection + apply assertion depend on a specific chapter
   state; run sequentially so parallel workers can't collide on the shared
   in-memory Vite dev-server mock state. */
test.describe.configure({ mode: 'serial' });

type Store = {
  getState: () => {
    manuscript: {
      sentences: Array<{ id: number; chapterId: number; text: string; instruct?: string }>;
    };
  };
  dispatch: (action: unknown) => void;
};

test.describe('fs-58 — validate_instruct per-chapter accept flow (#1041)', () => {
  test('modal opens → Instruct row → accept → sentence instruct updated', async ({ page }) => {
    /* Navigate directly to the Solway Bay fixture book manuscript view.
       SB seeds currentChapterId = 3, so the "per-chapter" review targets
       chapter 3 — where sentence id:1 lives (initialSentences[0]). */
    await page.goto('/#/books/sb/manuscript');

    /* Hydration signal: the chapter heading for chapter 3. */
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* Seed an instruct on sentence id:1 (chapter 3). The validate_instruct REPAIR
       op only applies to a sentence that ALREADY has an instruct; without this the
       apply guard drops it and no diff row renders. */
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      store.dispatch({
        type: 'manuscript/setSentenceInstruct',
        payload: { chapterId: 3, sentenceId: 1, instruct: 'shouting' },
      });
    });

    /* Click the per-chapter "Review Script" button; wait for the modal. */
    const reviewBtn = page.getByTestId('review-script-chapter');
    await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();

    /* The ScriptReviewDiff modal opens once mockReviewScript resolves. */
    await expect(page.getByRole('heading', { name: /Script review suggestions/i })).toBeVisible({
      timeout: 10_000,
    });

    /* The validate_instruct class heading is the literal "Instruct" (an <h4>).
       Match it EXACTLY by role+name so it can't substring-match "Live instruct". */
    await expect(page.getByRole('heading', { name: 'Instruct', exact: true })).toBeVisible();

    /* The "Apply N selected" button is present and enabled. */
    const applyBtn = page.getByTestId('apply-button');
    await expect(applyBtn).toBeVisible();

    /* Accept: dispatchAcceptedOps fires setSentenceInstruct on sentence id:1
       (chapter 3) with instruct: 'a calm tone'. */
    await applyBtn.click();

    /* Modal closes after Apply. */
    await expect(
      page.getByRole('heading', { name: /Script review suggestions/i }),
    ).toBeHidden({ timeout: 5_000 });

    /* Assert the instruct was updated to 'a calm tone'. */
    const instructApplied = await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      const s = store
        .getState()
        .manuscript.sentences.find((x) => x.id === 1 && x.chapterId === 3);
      return s?.instruct;
    });
    expect(instructApplied, "sentence id:1 instruct should be 'a calm tone'").toBe('a calm tone');
  });
});
