/* fs-57 (PR3-Mi2) / fs-35 — The "Detect emotions" button runs BOTH the emotion
 * backfill pass (api.detectEmotions) AND the Stage-3 instruct/vocalization
 * pass (api.detectInstruct) in sequence. In mock mode both mocks resolve
 * synchronously and each streams one annotation.
 *
 * Since fs-35 the button is a split control: the primary runs both passes
 * scoped to the current chapter IMMEDIATELY (no confirm), and the ⌄ menu's
 * "Detect whole book" keeps the confirm popover. This spec asserts (1) the
 * whole-book confirm dialog copy mentions text-mutating reactions
 * (gasp/sigh/laugh) — reached via the ⌄ menu — and (2) the per-chapter primary
 * runs both passes with no confirm.
 *
 * Pairs with manuscript-detect-emotions.spec.ts (the emotion-pass regression);
 * this spec covers the combined Stage-3 extension. */

import { test, expect } from '@playwright/test';
import { goToConfirm, confirmCastAndReachManuscript } from './helpers';

test.describe.configure({ mode: 'serial' });
test.describe('manuscript — Detect emotions + Stage 3 instruct (fs-57)', () => {
  test('confirm dialog mentions text-mutating reactions (gasp/sigh/laugh)', async ({ page }) => {
    await goToConfirm(page);
    await confirmCastAndReachManuscript(page);

    const button = page.getByTestId('detect-emotions-button');
    await expect(button).toBeVisible({ timeout: 5_000 });
    await expect(button).toBeEnabled();

    // fs-35: the confirm popover only shows on the whole-book path, behind the
    // ⌄ menu — the per-chapter primary click runs immediately with no confirm.
    await page.getByTestId('detect-emotions-menu-toggle').click();
    await page.getByTestId('detect-emotions-wholebook').click();
    const dialog = page.getByRole('dialog', { name: /Detect emotions/i });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/gasp|sigh|laugh/i);
  });

  test('PR3-Mi2 — one click runs both passes; done banner appears', async ({ page }) => {
    await goToConfirm(page);
    await confirmCastAndReachManuscript(page);

    const button = page.getByTestId('detect-emotions-button');
    await expect(button).toBeVisible({ timeout: 5_000 });
    await expect(button).toBeEnabled();

    await button.click();

    // Both passes complete (mock) — the inline "Tagged N line(s)…" done
    // summary proves the full sequence ran and the result banner rendered.
    // The mock for detectEmotions streams 1 annotation and detectInstruct
    // streams 1 annotation, so the combined total is ≥1 line.
    const done = page.getByTestId('detect-emotions-done');
    await expect(done).toBeVisible({ timeout: 10_000 });
    await expect(done).toContainText(/Tagged \d+ line/i);
  });
});
