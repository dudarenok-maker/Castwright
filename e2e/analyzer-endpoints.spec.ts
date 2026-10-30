/* #3084 W3d — OpenAI-compatible analyzer endpoints in mock mode (VITE_USE_MOCKS=true).
   Endpoint CRUD, keys, the catalog and the Test action are fulfilled in-process by the
   mock api layer; seeds arrive through window globals (see mockGetAnalyzerModels). */
import { test, expect, type Page } from '@playwright/test';
import { waitForRouteReady, stubAccountModelProbes } from './helpers';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await stubAccountModelProbes(page);
});

async function addEndpoint(page: Page, opts: { name: string; baseUrl: string; context: string; gpu?: string; key?: string }) {
  await page.getByTestId('add-endpoint').click();
  await page.getByTestId('endpoint-name').fill(opts.name);
  await page.getByTestId('endpoint-base-url').fill(opts.baseUrl);
  await page.getByTestId('endpoint-context-tokens').fill(opts.context);
  if (opts.gpu) await page.getByTestId('endpoint-gpu').selectOption(opts.gpu);
  if (opts.key) await page.getByTestId('endpoint-key').fill(opts.key);
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-editor')).toBeHidden();
}

test('add an endpoint (context required), pick its model, and the label shows "schema (not enforced)" from a Test record', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__SEED_ENDPOINT_MODELS__ = { 'lab-server': ['qwen3-30b'] };
    w.__SEED_ANALYZER_CAPABILITIES__ = {
      'openai:lab-server::qwen3-30b': {
        serverUrl: 'http://127.0.0.1:8080/v1',
        testedAt: '2026-09-11T10:00:00.000Z',
        control: { ok: true },
        structuredOutput: { schema: { 'model-default': 'ignored' } },
        reasoning: {},
      },
    };
  });
  await page.goto('/#/models');
  await waitForRouteReady(page);

  await page.getByTestId('add-endpoint').click();
  await page.getByTestId('endpoint-name').fill('Lab server');
  await page.getByTestId('endpoint-base-url').fill('http://127.0.0.1:8080/v1');
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-context-error')).toBeVisible();
  await page.getByTestId('endpoint-context-tokens').fill('32768');
  await page.getByTestId('endpoint-extra-params').fill('{"top_k": 40, "min_p": 0.05}');
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-row-lab-server')).toBeVisible();

  const picker = page.getByTestId('account-default-analysis-model');
  await expect(picker.locator('option[value="openai:lab-server::qwen3-30b"]')).toHaveCount(1);
  await picker.selectOption('openai:lab-server::qwen3-30b');
  const label = page.getByTestId('analyzer-default-model-label');
  await expect(label).toContainText('Lab server · qwen3-30b');
  await expect(label).toContainText('schema (not enforced)');
  await expect(label).toContainText('+ custom params');
});

test('the GPU guard prompts for an endpoint on the TTS card and not for one on another card', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__SEED_CONFIG_VALUES__ = {
      'tts.kokoro.device': { key: 'tts.kokoro.device', effective: 'cuda:0', source: 'override', locked: false, overridden: true },
    };
    w.__SEED_ENDPOINT_MODELS__ = { 'same-card': ['m0'], 'other-card': ['m1'] };
  });
  /* P13: Layout hydrates the config slice on mount, so the TTS card is known here without
     visiting Advanced Settings first. */
  await page.goto('/#/models');
  await waitForRouteReady(page);

  await addEndpoint(page, { name: 'Same card', baseUrl: 'http://127.0.0.1:8080/v1', context: '8192', gpu: 'cuda:0' });
  await addEndpoint(page, { name: 'Other card', baseUrl: 'http://127.0.0.1:8081/v1', context: '8192', gpu: 'cuda:1' });

  await page.evaluate(() => {
    const w = window as unknown as { __store__: { dispatch: (a: unknown) => void } };
    w.__store__.dispatch({
      type: 'chapters/setActiveStream',
      payload: { streamKey: 'b1::1', bookId: 'b1', chapterId: 1, modelKey: 'kokoro-v1', done: 0, total: 3, inProgress: 1, lastTickAt: Date.now(), halted: false },
    });
  });

  await page.getByTestId('model-test-openai:same-card::m0').click();
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByText('Pause audio generation to analyse?')).toBeVisible();
  await page.getByRole('button', { name: 'Wait' }).click();
  await expect(page.getByTestId('model-test-result-openai:same-card::m0')).toHaveCount(0);

  await page.getByTestId('model-test-openai:other-card::m1').click();
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByText('Pause audio generation to analyse?')).toHaveCount(0);
  await expect(page.getByTestId('model-test-result-openai:other-card::m1')).toContainText('tested');
});

test('editing the host of an endpoint with a saved key asks for the key again', async ({ page }) => {
  await page.goto('/#/models');
  await waitForRouteReady(page);
  await addEndpoint(page, { name: 'Keyed', baseUrl: 'http://127.0.0.1:8080/v1', context: '8192', key: 'sk-test' });

  await page.getByTestId('endpoint-edit-keyed').click();
  await page.getByTestId('endpoint-base-url').fill('http://10.0.0.5:8080/v1');
  await expect(page.getByTestId('endpoint-key-reentry')).toBeVisible();
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-editor')).toBeVisible();

  await page.getByTestId('endpoint-key').fill('sk-new');
  await page.getByTestId('endpoint-save').click();
  await expect(page.getByTestId('endpoint-editor')).toBeHidden();
});

test('a dropped endpoint entry shows a banner in Model Manager and in Advanced Settings, and Got it clears it (P31)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__SEED_DROPPED_ENDPOINT_ENTRIES__ = [
      { archiveId: 'a1', kind: 'endpoint', endpointId: 'old-box', name: 'Old box', issues: ['analyzerEndpoints.0.baseUrl: invalid_format'], droppedAt: '2026-09-13T10:00:00.000Z' },
      { archiveId: null, kind: 'key', endpointId: 'lab', origin: 'http://10.0.0.5:8080', issues: ['analyzerEndpointKeys.lab.key: invalid_type'], droppedAt: '2026-09-13T10:00:00.000Z' },
    ];
  });
  await page.goto('/#/models');
  await waitForRouteReady(page);
  const banner = page.getByTestId('dropped-endpoint-banner');
  await expect(banner).toContainText('Endpoint "Old box"');
  await expect(banner).toContainText('user-settings.invalid-endpoints.json');
  await expect(banner).toContainText('archive copy is still pending');

  await page.goto('/#/advanced');
  await waitForRouteReady(page);
  await expect(page.getByTestId('dropped-endpoint-banner')).toBeVisible();
  await page.getByTestId('dropped-endpoint-ack-a1').click();
  await expect(page.getByTestId('dropped-endpoint-banner')).not.toContainText('Old box');
  await expect(page.getByTestId('dropped-endpoint-banner')).toContainText('archive copy is still pending');
});

test("a fix link opens the endpoint's editor with the field focused (P34)", async ({ page }) => {
  await page.goto('/#/models');
  await waitForRouteReady(page);
  await addEndpoint(page, { name: 'Deep', baseUrl: 'http://127.0.0.1:8080/v1', context: '8192' });
  await page.evaluate(() => {
    window.location.hash = '#/models?endpoint=deep&field=contextTokens';
  });
  await expect(page.getByTestId('endpoint-editor')).toBeVisible();
  await expect(page.getByTestId('endpoint-context-tokens')).toBeFocused();
  await expect(page.getByTestId('endpoint-context-tokens')).toHaveValue('8192');
});
