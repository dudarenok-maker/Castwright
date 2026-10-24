import { test, expect } from '@playwright/test';
import { goToConfirm, waitForConfirmViewReady, waitForRouteReady, stubAccountModelProbes } from './helpers';

/**
 * #3084 W4 — the design-start GPU guard. "Design full cast" on a same-card
 * OpenAI-compatible persona engine, with a render streaming, asks to pause the
 * render first (the persona analogue of analyzer-endpoints.spec.ts's analysis
 * guard); "Wait" starts nothing, and a persona engine that shares no card does
 * not ask. Browser-level because the picker → guard dialog → designAllRequested
 * path crosses the redux / layout seams the hook tests cover in isolation.
 */

async function openCastOnQwen(page: import('@playwright/test').Page, personaEngine: string) {
  await stubAccountModelProbes(page);
  await page.addInitScript((engine) => {
    const raw = window.localStorage.getItem('persist:ui');
    const blob = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    blob.ttsModelKey = JSON.stringify('qwen3-tts-0.6b');
    blob.ttsModelKeyExplicit = JSON.stringify(true);
    window.localStorage.setItem('persist:ui', JSON.stringify(blob));
    const entry = (key: string, effective: string) => ({ key, effective, source: 'override', locked: false, overridden: true });
    (window as unknown as Record<string, unknown>).__SEED_CONFIG_VALUES__ = {
      'tts.qwen.device': entry('tts.qwen.device', 'cuda:0'),
      'analyzer.personaGeneration.engine': entry('analyzer.personaGeneration.engine', engine),
    };
  }, personaEngine);

  await goToConfirm(page);
  await waitForConfirmViewReady(page);
  await page.getByRole('button', { name: /Confirm cast and design voices/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/(manuscript|cast|generate|listen)$/, { timeout: 10_000 });
  const bookId = page.url().match(/#\/books\/([^/]+)\//)?.[1];
  await page.goto(`/#/books/${bookId}/cast`);
  await waitForRouteReady(page);

  await page.evaluate((id) => {
    const w = window as unknown as { __store__: { dispatch: (a: unknown) => void } };
    w.__store__.dispatch({
      type: 'account/fetch/fulfilled',
      payload: { analyzerEndpoints: [{ id: 'same-card', name: 'Same card', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', contextTokens: 8192 }] },
    });
    w.__store__.dispatch({
      type: 'chapters/setActiveStream',
      payload: { streamKey: `${id}::1`, bookId: id, chapterId: 1, modelKey: 'qwen3-tts-0.6b', done: 0, total: 3, inProgress: 1, lastTickAt: Date.now(), halted: false },
    });
  }, bookId);
}

const TITLE = 'Pause audio generation to design voices?';

test('Design full cast asks to pause a render when the persona engine is on the render card; Wait starts nothing', async ({ page }) => {
  await openCastOnQwen(page, 'openai:same-card::m0');
  await page.getByTestId('design-full-cast').click();
  await page.getByTestId('scope-bases').click();
  await expect(page.getByText(TITLE)).toBeVisible();
  await page.getByRole('button', { name: 'Wait' }).click();
  await expect(page.getByText(TITLE)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __store__: { getState: () => { castDesign: { active: unknown } } } }).__store__.getState().castDesign.active)).toBeNull();
});

test('Design full cast does not ask for a Gemini persona engine', async ({ page }) => {
  await openCastOnQwen(page, 'gemini');
  await page.getByTestId('design-full-cast').click();
  await page.getByTestId('scope-bases').click();
  await expect(page.getByText(TITLE)).toHaveCount(0);
  /* The streaming render owns the status pill here, so read the design run off the store. */
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __store__: { getState: () => { castDesign: { active: unknown } } } }).__store__.getState().castDesign.active !== null))
    .toBe(true);
});
