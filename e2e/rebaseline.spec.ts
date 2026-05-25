import { test, expect } from '@playwright/test';
import { goToConfirm, waitForConfirmViewReady, waitForRouteReady } from './helpers';

/**
 * "Rebaseline the series" modal — plan 108, Wave 5 (the final wave).
 *
 * Drives a fresh book to the confirm-cast view (cast hydrated), confirms
 * the cast into the ready stage, then opens the book-scoped Voices tab and
 * exercises the rebaseline flow:
 *
 *   open → principal cast pre-selected → Propose (mock designs each voice)
 *        → current-vs-proposed rows render → Approve transfer → success toast.
 *
 * Why browser-level: the trigger lives on the Voices view (only when a book
 * is loaded so the series-scoped write has an anchor), the modal mounts via
 * the ui-slice flag + a portal, the propose loop fires the mock
 * designQwenVoice per character (binary blob → <audio>), and Approve writes
 * the series-scoped override + pushes a toast — the redux/router/portal seam
 * Vitest+jsdom can lie about. Vitest covers the contracts in isolation
 * (rebaseline-slice.test.ts + rebaseline-modal.test.tsx); this pins the
 * click chain in a real DOM.
 *
 * The mock backend (src/lib/api.ts) returns canned personas + a silent-WAV
 * blob for the design route and echoes the series override, so this spec
 * needs no live Gemini key or TTS sidecar.
 */
test.describe('voices view → rebaseline the series modal', () => {
  test('open → principal cast pre-selected → propose → approve → success toast', async ({
    page,
  }) => {
    await goToConfirm(page);
    await waitForConfirmViewReady(page);

    /* Confirm the cast → ready stage (the rebaseline trigger needs a loaded
       book; the cast slice stays hydrated across the transition). */
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/(manuscript|cast|generate|listen)$/, {
      timeout: 10_000,
    });

    /* Jump to the book-scoped Voices tab. */
    const url = page.url();
    const bookId = url.match(/#\/books\/([^/]+)\//)?.[1];
    expect(bookId).toBeTruthy();
    await page.goto(`/#/books/${bookId}/library`);
    await waitForRouteReady(page);

    /* The rebaseline trigger surfaces (book loaded + cast hydrated). */
    const trigger = page.getByTestId('open-rebaseline');
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();

    /* Modal mounted in setup step — at least one principal-cast row is
       pre-checked (the mock seed always populates speaking characters). */
    const dialog = page.getByRole('dialog', { name: /Rebaseline the series/i });
    await expect(dialog).toBeVisible();
    const checkedSetup = dialog.locator('input[type="checkbox"]:checked');
    await expect(checkedSetup.first()).toBeVisible({ timeout: 5_000 });

    /* Propose — the mock designs a Qwen voice per selected character. */
    await page.getByTestId('rebaseline-propose').click();

    /* current-vs-proposed rows render; Approve enables once at least one
       row is ready + included. */
    await expect(dialog.locator('[data-testid^="rebaseline-proposal-"]').first()).toBeVisible({
      timeout: 10_000,
    });
    const approve = page.getByTestId('rebaseline-approve');
    await expect(approve).toBeEnabled({ timeout: 10_000 });
    await approve.click();

    /* Success toast names the rebaselined count + the drift hint (distinct
       from the footer status by the "across the series — drift" copy). */
    await expect(
      page.getByText(/Rebaselined \d+ characters? across the series — drift/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  /* Plan 108 follow-up — the rebaseline action is now reachable PER-SERIES
     from the GLOBAL Voices view ("Every voice you've ever generated"), with
     no book open. Each series-group header carries its own button that opens
     the modal pre-loaded with that series' representative cast. */
  test('global voices view → per-series Rebaseline button opens the modal pre-loaded', async ({
    page,
  }) => {
    await page.goto('/#/voices');
    await waitForRouteReady(page);

    /* At least one series group surfaces a per-series Rebaseline button
       (testid prefixed with the series name). */
    const seriesButton = page.locator('[data-testid^="rebaseline-series-"]').first();
    await expect(seriesButton).toBeVisible({ timeout: 10_000 });
    await seriesButton.click();

    /* The modal mounts and loads the series cast — either the loading state
       briefly, then the setup step with a pre-selected principal cast. */
    const dialog = page.getByRole('dialog', { name: /Rebaseline the series/i });
    await expect(dialog).toBeVisible();
    const checkedSetup = dialog.locator('input[type="checkbox"]:checked');
    await expect(checkedSetup.first()).toBeVisible({ timeout: 10_000 });
  });
});
