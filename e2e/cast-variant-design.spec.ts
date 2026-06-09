import { test, expect } from '@playwright/test';
import { goToConfirm, waitForConfirmViewReady, waitForRouteReady } from './helpers';

/**
 * Emotion-variant bulk design — "Emotion variants" scope in the Design full
 * cast scope picker flips a needed-angry glyph to designed.
 *
 * Pre-conditions (seeded in mock data):
 *   - Eliza Gray has ttsEngine:'qwen' + overrideTtsVoices.qwen.name set (base
 *     voice already designed), so buildVariantTasks includes her.
 *   - Sentence id=8 (Eliza: "You'll get us all drowned, you old fool.") carries
 *     emotion:'angry', so usedEmotionsByCharacter returns {'eliza' → {'angry'}}.
 *   - No qwen.variants.angry on Eliza → variant-glyph-angry starts as 'needed'.
 *
 * Flow: book → confirm → cast view → Design full cast → scope picker →
 *   "Emotion variants" → mock SSE emits variant_designed → glyph flips.
 *
 * Why browser-level: the glyph flip crosses redux (setCharacterEmotionVariant
 * on the cast slice), the stream middleware (onVariantDesigned callback), the
 * VariantGlyphStrip component re-render, and the DesignScopePicker popover —
 * seams that unit tests cover in isolation but can only be proven end-to-end.
 */

test.describe('cast view → Design full cast → Emotion variants scope', () => {
  test('picking "Emotion variants" flips a needed-angry glyph to designed', async ({ page }) => {
    /* Seed the project engine as Qwen so the cast view's Qwen UI renders.
       MERGE into the persisted blob — same pattern as design-full-cast.spec.ts. */
    await page.addInitScript(() => {
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

    /* Navigate to the cast view. */
    await page.goto(`/#/books/${bookId}/cast`);
    await waitForRouteReady(page);

    /* Eliza's angry glyph must start as 'needed' — she has a base Qwen voice
       (overrideTtsVoices.qwen.name='qwen-eliza') and one angry-tagged sentence,
       but no designed variant yet. */
    const glyph = page.getByTestId('variant-glyph-angry').first();
    await expect(glyph).toBeVisible({ timeout: 10_000 });
    await expect(glyph).toHaveAttribute('data-state', 'needed');

    /* Open the scope picker — same button as design-full-cast spec. */
    const designBtn = page.getByTestId('design-full-cast');
    await expect(designBtn).toBeVisible({ timeout: 5_000 });
    await designBtn.click();

    /* Scope picker must appear with the "Emotion variants" row enabled
       (variantCount = 1 → not disabled). */
    await expect(page.getByTestId('design-scope-picker')).toBeVisible({ timeout: 5_000 });
    const variantsBtn = page.getByTestId('scope-variants');
    await expect(variantsBtn).toBeEnabled();

    /* Pick "Emotion variants" — dispatches designAllRequested with scope:'variants'
       and variantTasks:[{characterId:'eliza', emotions:['angry']}]. The mock SSE
       fires onVariantDesigned → setCharacterEmotionVariant → adds
       qwen.variants.angry → VariantGlyphStrip re-renders with data-state='designed'. */
    await variantsBtn.click();

    /* The glyph must flip once the mock variant_designed event lands. With
       only one in-use emotion ('angry'), VariantGlyphStrip replaces the
       individual glyph with the "variants complete" badge once it is designed
       (all in-use emotions have a variant). */
    await expect(page.getByTestId('variants-complete').first()).toBeVisible({
      timeout: 5_000,
    });
  });
});
