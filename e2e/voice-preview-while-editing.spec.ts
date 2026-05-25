import { test, expect } from '@playwright/test';
import { goToConfirm, waitForConfirmViewReady } from './helpers';

/**
 * Voice-preview-while-editing flow — pairs with
 * docs/features/60-voice-preview-while-editing.md.
 *
 * Drives a fresh book to the confirm-cast view, opens the profile
 * drawer, expands the candidate-preview list, sets a custom sample
 * line, and confirms two consecutive candidates can be auditioned
 * without committing the cast assignment.
 *
 * Why browser-level: the preview button mounts an audio element via
 * the shared `useSamplePlayback` singleton and the
 * `playBaseVoiceSampleWithAutoLoad` helper. The audio element handling
 * + the singleton's src-swap-cancel semantics are the kind of layout +
 * timing seam Vitest+jsdom can lie about — a real chromium run pins it.
 *
 * The mock backend in `src/lib/api.ts` returns a stub MP3 for the base
 * voice sample route, so this spec doesn't need a live sidecar.
 */

test.describe('profile drawer → voice preview while editing', () => {
  test('expand → audition candidate A → audition candidate B without committing', async ({
    page,
  }) => {
    await goToConfirm(page);
    /* per-view hydration helper — waits for the
       first character profile button to mount before we go looking for
       Captain Halloran specifically. */
    await waitForConfirmViewReady(page);

    /* Open Captain Halloran's profile drawer. */
    const hallCard = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(hallCard).toBeVisible({ timeout: 10_000 });
    await hallCard.click();

    /* Drawer mounted — wait for the override picker (proxy for hydration). */
    await expect(page.getByText(/Model voice/i).first()).toBeVisible({ timeout: 5_000 });

    /* Candidate-preview section starts collapsed. Toggle to expand. */
    const toggle = page.getByTestId('voice-preview-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();

    /* Textarea + candidate list are now in the DOM. */
    const sampleText = page.getByTestId('voice-preview-sample-text');
    await expect(sampleText).toBeVisible();
    /* Default content is the pangram + follow-on. */
    await expect(sampleText).toHaveValue(/quick brown fox/i);

    /* Edit the sample line — the new value is what each preview button
       sends to the synth API. */
    await sampleText.fill('A custom audition line for both candidates.');
    await expect(sampleText).toHaveValue('A custom audition line for both candidates.');

    /* Candidate list mounted — first two rows are reachable. The base-voice
       catalog ordering is engine-defined; just check the first two
       data-testid'd rows exist by reading the candidate list and clicking
       the first two play buttons in order. */
    const candidates = page.getByTestId('voice-preview-candidates');
    await expect(candidates).toBeVisible();
    const playButtons = candidates.locator('[data-testid^="voice-preview-play-"]');
    await expect(playButtons.first()).toBeVisible();

    /* Capture which candidate the user is auditioning so the next click
       can target a DIFFERENT one. */
    const firstButton = playButtons.first();
    const firstName = (await firstButton.getAttribute('data-testid'))?.replace(
      'voice-preview-play-',
      '',
    );
    expect(firstName).toBeTruthy();

    /* Click candidate A. Mock returns immediately; the button momentarily
       flips to a loading state. */
    await firstButton.click();

    /* Click candidate B (different row). Each row has its own preview
       button — clicking row B doesn't commit any cast change; the
       override-picker dropdown value stays unchanged. */
    const secondButton = playButtons.nth(1);
    const secondName = (await secondButton.getAttribute('data-testid'))?.replace(
      'voice-preview-play-',
      '',
    );
    expect(secondName).toBeTruthy();
    expect(secondName).not.toBe(firstName);
    await secondButton.click();

    /* The override-picker trigger button label is the assignment-of-
       record. It must NOT have changed during preview auditioning —
       still reads "Auto — currently …" rather than a picked voice. */
    const overrideTrigger = page.getByRole('button', { name: /Model voice override/i }).first();
    await expect(overrideTrigger).toHaveText(/Auto/);

    /* Re-opening the drawer keeps the sample text — persisted to
       localStorage. Close and re-open the same character's profile. */
    await page.getByRole('button', { name: /Discard/i }).click();
    await hallCard.click();
    await page.getByTestId('voice-preview-toggle').click();
    await expect(page.getByTestId('voice-preview-sample-text')).toHaveValue(
      'A custom audition line for both candidates.',
    );
  });
});
