/* #3084 wave 5a (Task 5.6e, owner decision 5.6-D2) — the analyzer reasoning editor and its deep link in a
 * real browser: router -> redux -> layout (Tasks 5.5c, 5.6-ii, 5.6b).
 *
 * Mock mode (playwright.config.ts `webServer`) always has the Ollama model `qwen3.5:4b` in the catalog,
 * offered `model-default`/`off`/`on`; the Gemini group needs an API key, so every case uses the Ollama row.
 * Mock module state (`MOCK_USER_SETTINGS`) does not survive a full reload, so persistence is asserted across
 * an in-app hash navigation, never `page.reload()`. The terminal failure frame is delivered through
 * `window.__store__` exactly as e2e/reasoning-overflow-fixes.spec.ts explains.
 *
 * Wave 5b (Task 5.12f) adds the custom parameter editors: an Ollama payload saved with a level, and invalid
 * JSON shown under the Gemini editor (always rendered, 5b-D7). */

import { test, expect, type Page } from '@playwright/test';
import { bootFreshBookIntoAnalysing, waitForRouteReady } from './helpers';

const MODEL = 'qwen3.5:4b';
const ROW_ID = `analyzer-reasoning-ollama-${MODEL}`;
const HIGHLIGHT_CLASS = /ring-magenta\/60/;

const OVERFLOW_FRAME = {
  kind: 'error',
  code: 'analyzer-reasoning-overflow',
  message: 'The analyzer spent its whole output budget on reasoning and returned no answer text.',
  remediation: 'Apply one of the fixes below, then resume — finished chapters are kept.',
  fixes: [
    {
      label: `Turn reasoning off for ${MODEL}`,
      reasoningSetting: { engine: 'ollama', model: MODEL },
    },
  ],
};

type E2eStore = {
  getState: () => { analysis?: { activeStream?: { manuscriptId?: string } | null } };
  dispatch: (action: unknown) => void;
};

async function readLiveManuscriptId(page: Page): Promise<string> {
  const handle = await page.waitForFunction(
    () => {
      const store = (window as unknown as { __store__?: E2eStore }).__store__;
      const id = store?.getState().analysis?.activeStream?.manuscriptId;
      return typeof id === 'string' && id.length > 0 ? id : null;
    },
    undefined,
    { timeout: 10_000 },
  );
  return (await handle.jsonValue()) as string;
}

async function deliverTerminalError(page: Page, manuscriptId: string): Promise<void> {
  await page.evaluate(
    ({ manuscriptId: id, frame }) => {
      const store = (window as unknown as { __store__: E2eStore }).__store__;
      store.dispatch({
        type: 'analysis/setHalted',
        payload: { manuscriptId: id, code: frame.code, message: frame.message, fixes: frame.fixes },
      });
    },
    { manuscriptId, frame: OVERFLOW_FRAME },
  );
}

test.describe.configure({ mode: 'serial' });

test.describe('#3084 wave 5a — analyzer reasoning editor', () => {
  test('a deep link lands on the model row and highlights it briefly', async ({ page }) => {
    await page.goto(`/#/advanced?reasoningEngine=ollama&reasoningModel=${encodeURIComponent(MODEL)}`);
    await waitForRouteReady(page);

    const card = page.getByTestId('analyzer-request-controls');
    await expect(card).toBeVisible();

    /* The editor is its own card above the settings groups (5.6-D1). */
    const firstGroup = page.locator('section[id^="cfg-section-"]').first();
    await expect(firstGroup).toBeVisible();
    const cardBox = await card.boundingBox();
    const groupBox = await firstGroup.boundingBox();
    expect(cardBox).not.toBeNull();
    expect(groupBox).not.toBeNull();
    expect(cardBox!.y).toBeLessThan(groupBox!.y);

    const row = page.locator(`[id="${ROW_ID}"]`);
    await expect(row).toBeInViewport({ timeout: 5_000 });
    await expect(row).toHaveClass(HIGHLIGHT_CLASS);
    await expect(row).not.toHaveClass(HIGHLIGHT_CLASS, { timeout: 5_000 });
  });

  test('a saved level survives an in-app navigation away and back', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);

    const select = page.getByTestId(ROW_ID);
    await expect(select).toBeVisible({ timeout: 10_000 });
    await select.selectOption('on');
    await page.getByTestId('analyzer-request-controls-save').click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5_000 });

    await page.evaluate(() => {
      location.hash = '#/';
    });
    await expect(page).toHaveURL(/#\/$/);
    await page.evaluate(() => {
      location.hash = '#/advanced';
    });
    await expect(page).toHaveURL(/#\/advanced/);
    await waitForRouteReady(page);

    await expect(page.getByTestId(ROW_ID)).toHaveValue('on', { timeout: 10_000 });
  });

  test("a reasoning-overflow failure's fix link lands on the model row", async ({ page }) => {
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();
    await deliverTerminalError(page, await readLiveManuscriptId(page));

    const panel = page
      .locator('div.mt-6.rounded-2xl.border-rose-200')
      .filter({ hasText: `Turn reasoning off for ${MODEL}` });
    await expect(panel.getByText('How to fix:')).toBeVisible({ timeout: 5_000 });
    await panel.getByRole('link', { name: `Turn reasoning off for ${MODEL}` }).click();

    await expect(page).toHaveURL(
      new RegExp(`#/advanced\\?reasoningEngine=ollama&reasoningModel=${encodeURIComponent(MODEL).replace(/\./g, '\\.')}$`),
    );
    await waitForRouteReady(page);
    await expect(page.locator(`[id="${ROW_ID}"]`)).toHaveClass(HIGHLIGHT_CLASS, { timeout: 5_000 });
  });
});

async function readAccount(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __store__: { getState: () => { account: Record<string, unknown> } } };
    return w.__store__.getState().account;
  });
}

test.describe('#3084 wave 5b — custom parameter editors', () => {
  test('saves an Ollama reasoning level and payload through the settings round-trip', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);
    await expect(page.getByTestId('analyzer-request-controls')).toBeVisible();
    await page.getByTestId(ROW_ID).selectOption('on');
    await page.getByTestId('analyzer-extra-params-ollama').fill('{"options": {"min_p": 0.05}}');
    await page.getByTestId('analyzer-request-controls-save').click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5_000 });
    await expect.poll(async () => (await readAccount(page)).analyzerReasoningByEngine).toEqual({ ollama: { [MODEL]: 'on' }, gemini: {} });
    await expect.poll(async () => (await readAccount(page)).analyzerExtraParamsByEngine).toEqual({ ollama: { options: { min_p: 0.05 } } });
  });

  test('invalid JSON under the Gemini editor shows a visible reason, with no Gemini key set (5b-D7)', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);
    await page.getByTestId('analyzer-extra-params-gemini').fill('{"config": ');
    await expect(page.getByTestId('analyzer-extra-params-gemini-error')).toHaveText('Not valid JSON.');
  });
});
