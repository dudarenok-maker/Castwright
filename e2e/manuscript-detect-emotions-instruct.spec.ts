/* fs-57 (PR3-Mi2) — The "Detect emotions" button now runs BOTH the emotion
 * backfill pass (api.detectEmotions) AND the Stage-3 instruct/vocalization
 * pass (api.detectInstruct) in sequence. In mock mode both mocks resolve
 * synchronously and each streams one annotation.
 *
 * This spec asserts that a single button click drives the full
 * confirm → run → both-passes-done → result-shown flow, and that the
 * confirm dialog copy mentions text-mutating reactions (gasp/sigh/laugh).
 *
 * Pairs with manuscript-detect-emotions.spec.ts (the fs-33 emotion-only
 * regression). The fs-33 spec still runs unchanged and covers the legacy
 * flow; this spec covers the combined Stage-3 extension. */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

test.describe.configure({ mode: 'serial' });
test.describe('manuscript — Detect emotions + Stage 3 instruct (fs-57)', () => {
  test('confirm dialog mentions text-mutating reactions (gasp/sigh/laugh)', async ({ page }) => {
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

    const button = page.getByTestId('detect-emotions-button');
    await expect(button).toBeVisible({ timeout: 5_000 });
    await expect(button).toBeEnabled();

    await button.click();
    // Confirm dialog must mention that text will change
    const dialog = page.getByRole('dialog', { name: /Detect emotions/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/gasp|sigh|laugh/i);
  });

  test('PR3-Mi2 — one click runs both passes; done banner appears', async ({ page }) => {
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

    const button = page.getByTestId('detect-emotions-button');
    await expect(button).toBeVisible({ timeout: 5_000 });
    await expect(button).toBeEnabled();

    await button.click();
    const confirm = page.getByTestId('detect-emotions-confirm');
    await expect(confirm).toBeVisible();
    await confirm.click();

    // Both passes complete (mock) — the inline "Tagged N line(s)…" done
    // summary proves the full sequence ran and the result banner rendered.
    // The mock for detectEmotions streams 1 annotation and detectInstruct
    // streams 1 annotation, so the combined total is ≥1 line.
    const done = page.getByTestId('detect-emotions-done');
    await expect(done).toBeVisible({ timeout: 10_000 });
    await expect(done).toContainText(/Tagged \d+ line/i);
  });
});
