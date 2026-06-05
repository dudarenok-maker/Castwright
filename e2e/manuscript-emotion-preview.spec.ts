/* fe-31 (#506) — preview a designed emotion variant from the manuscript quote
 * chip. The chip control resolves the sentence's character → its designed Qwen
 * variant for the tagged emotion and auditions it through the shared sample
 * machinery (mock mode resolves a stub URL synchronously, so no sidecar needed).
 *
 * We seed via window.__store__: flip a speaking character to the bespoke Qwen
 * engine with a designed variant, and tag one of its sentences with that
 * emotion. Then the chip exposes the ▶ preview, which fires the sample path.
 *
 * Pairs with docs/features/179-fe31-emotion-chip-preview.md. */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

interface ManuscriptStore {
  getState: () => {
    cast: { characters: Array<{ id: string }> };
    manuscript: { sentences: Array<{ id: number; chapterId: number; characterId: string }> };
  };
  dispatch: (a: unknown) => void;
}

test.describe('manuscript chip — emotion variant preview', () => {
  test('a Qwen speaker exposes the ▶ preview and it fires the sample path', async ({ page }) => {
    /* The sample player uses a DETACHED `new Audio()` singleton, so it never
       lands in the DOM. Record play() calls + their src at the prototype level
       so we can assert the preview actually started a sample. */
    await page.addInitScript(() => {
      (window as unknown as { __samplePlays: string[] }).__samplePlays = [];
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        (window as unknown as { __samplePlays: string[] }).__samplePlays.push(this.src);
        return origPlay.call(this);
      };
    });

    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

    /* Wait for the manuscript slice to hydrate, then flip the first dialogue
       (non-narrator) sentence's character to a Qwen voice with an `angry`
       variant and tag the sentence `angry`. Polled because the slice populates
       after the lazy view mounts. */
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const s = (window as unknown as { __store__: ManuscriptStore }).__store__;
            const state = s.getState();
            const sentence = state.manuscript.sentences.find((x) => x.characterId !== 'narrator');
            if (!sentence) return false;
            const character = state.cast.characters.find((c) => c.id === sentence.characterId);
            if (!character) return false;
            s.dispatch({
              type: 'cast/updateCharacter',
              payload: {
                ...character,
                ttsEngine: 'qwen',
                overrideTtsVoices: {
                  qwen: {
                    name: 'qwen-preview',
                    variants: { angry: { name: 'qwen-preview-angry' } },
                  },
                },
              },
            });
            s.dispatch({
              type: 'manuscript/setSentenceEmotion',
              payload: { chapterId: sentence.chapterId, sentenceId: sentence.id, emotion: 'angry' },
            });
            return true;
          }),
        { timeout: 10_000 },
      )
      .toBe(true);

    /* The chip now carries an enabled preview button. Multiple chips may match
       across the prose; the first enabled one is our tagged Qwen line. */
    const preview = page.getByTestId('emotion-preview').first();
    await expect(preview).toBeVisible({ timeout: 5_000 });
    await expect(preview).toBeEnabled();

    await preview.click();

    /* The sample path fires through useSamplePlayback's shared (detached) audio
       element; in mock mode it resolves a stub URL and calls play(). Assert a
       play() landed and no error note surfaced. */
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (window as unknown as { __samplePlays: string[] }).__samplePlays.length,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByTestId('emotion-preview-note')).toHaveCount(0);
  });
});
