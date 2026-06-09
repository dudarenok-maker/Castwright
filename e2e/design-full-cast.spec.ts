import { test, expect } from '@playwright/test';
import { goToConfirm, waitForConfirmViewReady, waitForRouteReady } from './helpers';

/**
 * "Design full cast" — bulk Qwen base-voice design from the cast view, surfaced
 * as the third top-bar status pill (alongside Analysis + Generation).
 *
 * Drives a fresh book to the confirm-cast view, confirms it into the ready
 * stage, opens the cast view on a QWEN PROJECT (seeded via the persisted
 * ttsModelKey), then clicks "Design full cast": a scope picker appears first —
 * this spec picks "Base voices" (scope-bases).  Narrator, Captain Halloran, and
 * Marcus the Cook are "Needs voice" (no overrideTtsVoices.qwen set in the
 * fixture); Eliza Gray already has a designed Qwen base voice and is excluded.
 * The mock api.startCastDesign emits a designed voice per character; the status
 * pill shows "Designing", rows flip to "Designed" as each completes, and the
 * button disappears once every needs-voice character has a voice.
 *
 * Why browser-level: the button → scope-picker → designAllRequested →
 * cast-design middleware → mock SSE → slice → top-bar pill + live row flips
 * crosses the router / redux / layout seams the unit tests
 * (src/store/cast-design-*.test.ts, src/views/cast.test.tsx,
 * src/components/top-bar.test.tsx) cover in isolation.
 */

test.describe('cast view → Design full cast', () => {
  test('designs every needs-voice character, shows the pill, flips rows to Designed', async ({
    page,
  }) => {
    /* Put the PROJECT on Qwen before the app boots (redux-persist rehydrate),
       so the cast view's characters resolve as "Needs voice" and the button
       gates on. Seeds only the two whitelisted model fields. */
    await page.addInitScript(() => {
      /* MERGE (don't replace) — this runs on every navigation, so clobbering
         the blob would wipe the persisted `ui.stage` the analyse→confirm flow
         relies on between nav steps. Only force the two model fields. */
      const raw = window.localStorage.getItem('persist:ui');
      const blob = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      blob.ttsModelKey = JSON.stringify('qwen3-tts-0.6b');
      blob.ttsModelKeyExplicit = JSON.stringify(true);
      window.localStorage.setItem('persist:ui', JSON.stringify(blob));
    });

    await goToConfirm(page);
    await waitForConfirmViewReady(page);

    /* Confirm the cast → ready stage. */
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/(manuscript|cast|generate|listen)$/, {
      timeout: 10_000,
    });
    const bookId = page.url().match(/#\/books\/([^/]+)\//)?.[1];
    expect(bookId).toBeTruthy();

    await page.goto(`/#/books/${bookId}/cast`);
    await waitForRouteReady(page);

    /* The button gates on a Qwen project + ≥1 needs-voice character. */
    const designBtn = page.getByTestId('design-full-cast');
    await expect(designBtn).toBeVisible({ timeout: 10_000 });
    await expect(designBtn).toContainText(/Design full cast/i);

    await designBtn.click();

    /* The scope picker must appear — "Design full cast" now opens a popover
       with three scope options before starting the run. */
    await expect(page.getByTestId('design-scope-picker')).toBeVisible({ timeout: 5_000 });

    /* Pick "Base voices" — designs the needs-voice characters (Narrator,
       Captain Halloran, Marcus the Cook; Eliza already has a designed Qwen
       base voice so she is not included). */
    await page.getByTestId('scope-bases').click();

    /* The third status pill surfaces "Designing" while the run is in flight. */
    await expect(page.getByTestId('status-pill')).toContainText(/Designing/i, { timeout: 5_000 });

    /* Rows flip to "Designed" as each character_designed lands. After a
       scope-bases run the base needs-voice count drops to 0, so the button
       no longer shows a "(N)" count suffix. The button itself stays visible
       because Eliza still has an emotion variant to design (variantCount > 0),
       but the "(3)" count disappears — confirming all base voices were designed. */
    await expect(designBtn).not.toContainText(/\(\d+\)/, { timeout: 15_000 });
    await expect(page.getByText('Designed', { exact: true }).first()).toBeVisible({
      timeout: 5_000,
    });
  });
});
