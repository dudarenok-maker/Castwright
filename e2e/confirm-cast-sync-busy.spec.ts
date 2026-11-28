/* #4564 (PR #4862 review pass 1, owner decision a) — across the router/redux seam: while an
 * analysis runs for the library book a Confirm-cast row is matched to, its "Sync profile"
 * checkbox is disabled with a reason naming THAT book, bulk apply ticks nothing for it, and
 * Confirm cast still advances. Mock mode, so the 409 toast backstop (a real-server refusal)
 * is covered by src/routes/confirm-rehydrate.test.tsx instead. */
import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

type Win = { __store__: { dispatch: (action: unknown) => void } };

test('Sync profile is disabled, naming the busy library book, while it analyses', async ({
  page,
}) => {
  await goToConfirm(page);
  const elizaCard = page.locator('article', { hasText: 'Eliza Gray' }).first();
  await expect(elizaCard.getByRole('checkbox', { name: /Sync profile/i })).toBeEnabled();

  /* An analysis starts for the matched library book (`sb`, "Solway Bay"). */
  await page.evaluate(() => {
    (window as unknown as Win).__store__.dispatch({
      type: 'analysis/applyExternalAnalysisSnapshot',
      payload: {
        bookId: 'sb',
        manuscriptId: 'm',
        phaseId: 0,
        phaseLabel: 'x',
        phaseProgress: 0,
        remainingMs: null,
        lastTickAt: 0,
        state: 'running',
      },
    });
  });

  const box = elizaCard.getByRole('checkbox', { name: /Sync profile/i });
  await expect(box).toBeDisabled();
  await expect(elizaCard.getByText(/"Solway Bay" is re-analysing/)).toBeVisible();

  await page.getByRole('button', { name: /Confirm cast and design voices/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/cast/, { timeout: 5_000 });
});
