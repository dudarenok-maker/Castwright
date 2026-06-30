import { test, expect } from '@playwright/test';

/**
 * Status-first Qwen voice presentation — plan 117.
 *
 * Bespoke Qwen voices are 1:1 with characters, so the (provider, name) voice-
 * family grouping degenerated into one section per voice. They now bucket by
 * design status into exactly two sections — "Qwen · Needs a voice" and
 * "Qwen · Designed voices" — while preset engines keep family grouping. This
 * crosses the router → redux → layout seams (the view partitions the library
 * and renders a different component tree per engine), so it earns a browser-
 * level golden-path spec on top of the Vitest coverage.
 *
 * Mock fixtures (src/mocks/voices.ts): Bramble (no designed voice), Thistle
 * (designed, not generated), Wren (designed + sampled), Finch (designed +
 * generated).
 */

test.describe('Qwen status sections on #/voices', () => {
  test('renders the two status sections + badges beside a preset family', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.goto('/#/voices');

    /* Preset family co-exists in the same scroll (Gemini Charon → Captain
       Halloran), proving Qwen partitioning didn't disturb preset grouping. */
    await expect(page.getByText('Captain Halloran').first()).toBeVisible({ timeout: 10_000 });

    /* Exactly two Qwen sections — not one per designed voice. */
    const needs = page.getByRole('region', { name: 'Qwen · Needs a voice' });
    const designed = page.getByRole('region', { name: 'Qwen · Designed voices' });
    await expect(needs).toBeVisible();
    await expect(designed).toBeVisible();

    /* Undesigned voice buckets under "Needs a voice". exact:true avoids the
       voice sub-line (e.g. "Voice · qwen-thistle") substring-matching the name. */
    await expect(needs.getByText('Bramble', { exact: true })).toBeVisible();

    /* Designed voices bucket together, each carrying a Designed / Sampled /
       Generated badge driven by Voice.sampled / Voice.generated. */
    await expect(designed.getByText('Thistle', { exact: true })).toBeVisible();
    await expect(designed.getByText('Wren', { exact: true })).toBeVisible();
    await expect(designed.getByText('Finch', { exact: true })).toBeVisible();
    await expect(designed.getByText('Generated', { exact: true })).toBeVisible();
    await expect(designed.getByText('Sampled', { exact: true })).toBeVisible();
    await expect(designed.getByText('Designed', { exact: true })).toBeVisible();

    /* No "Audition base voice" button on a Qwen section (a status bucket is
       not a single base voice). */
    await expect(
      designed.getByRole('button', { name: /Audition base voice/i }),
    ).toHaveCount(0);
  });
});
