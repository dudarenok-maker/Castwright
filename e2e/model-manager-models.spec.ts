/* Plan 61 — Account → Models card e2e.
 *
 * Asserts the install → pull → analyze loop end-to-end from the browser,
 * with the actual network calls intercepted and replayed via Playwright's
 * route stubs so the spec stays offline. The mocked install + mocked
 * pull walk through their state machines tick-by-tick. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('plan 61 — in-app multi-model management UX', () => {
  test('install Ollama → pull qwen3.5:4b → ready for analysis', async ({ page }) => {
    /* Track which step of the install state machine we're on. */
    let installPolls = 0;
    let detectInstalled = false;

    await page.route('**/api/ollama/detect', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          detectInstalled
            ? { installed: true, version: 'ollama version 0.5.4 (mock)' }
            : { installed: false, version: null },
        ),
      });
    });

    await page.route('**/api/ollama/install', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          id: '1',
          status: 'downloading',
          platform: 'linux',
          arch: 'x64',
          bytesReceived: 0,
          bytesTotal: 1_000_000,
          manualInstallerPath: null,
          error: null,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        }),
      });
    });

    await page.route('**/api/ollama/install/1', async (route) => {
      installPolls += 1;
      /* Walk the state machine across two ticks:
           poll 1 → downloading 50%
           poll 2+ → installed (and detect flips to true) */
      let body: Record<string, unknown>;
      if (installPolls === 1) {
        body = {
          id: '1',
          status: 'downloading',
          platform: 'linux',
          arch: 'x64',
          bytesReceived: 500_000,
          bytesTotal: 1_000_000,
          manualInstallerPath: null,
          error: null,
          startedAt: 0,
          updatedAt: 0,
        };
      } else {
        detectInstalled = true;
        body = {
          id: '1',
          status: 'installed',
          platform: 'linux',
          arch: 'x64',
          bytesReceived: 1_000_000,
          bytesTotal: 1_000_000,
          manualInstallerPath: null,
          error: null,
          startedAt: 0,
          updatedAt: 0,
        };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    let pullPolls = 0;
    let modelOnDisk = false;
    await page.route('**/api/ollama/pull', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = JSON.parse(route.request().postData() ?? '{}');
      expect(body.model).toBe('qwen3.5:4b');
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          id: '7',
          model: 'qwen3.5:4b',
          status: 'pulling',
          lastStatusMessage: 'pulling manifest',
          bytesReceived: 0,
          bytesTotal: 1_000_000,
          error: null,
          startedAt: 0,
          updatedAt: 0,
        }),
      });
    });

    await page.route('**/api/ollama/pull/7', async (route) => {
      pullPolls += 1;
      let body: Record<string, unknown>;
      if (pullPolls === 1) {
        body = {
          id: '7',
          model: 'qwen3.5:4b',
          status: 'pulling',
          lastStatusMessage: 'downloading',
          bytesReceived: 500_000,
          bytesTotal: 1_000_000,
          error: null,
          startedAt: 0,
          updatedAt: 0,
        };
      } else {
        modelOnDisk = true;
        body = {
          id: '7',
          model: 'qwen3.5:4b',
          status: 'pulled',
          lastStatusMessage: 'success',
          bytesReceived: 1_000_000,
          bytesTotal: 1_000_000,
          error: null,
          startedAt: 0,
          updatedAt: 0,
        };
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });

    await page.route('**/api/ollama/health', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'reachable',
          url: 'http://localhost:11434',
          models: modelOnDisk ? ['qwen3.5:4b'] : [],
          expectedModel: 'qwen3.5:4b',
          modelPulled: modelOnDisk,
          resident: [],
          modelResident: false,
        }),
      });
    });

    await page.route('**/api/ollama/refresh', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'reachable',
          url: 'http://localhost:11434',
          models: modelOnDisk ? ['qwen3.5:4b'] : [],
          expectedModel: 'qwen3.5:4b',
          modelPulled: modelOnDisk,
        }),
      });
    });

    await page.goto('/#/models');
    await waitForRouteReady(page);

    /* Step 1 — Models card surfaces. */
    const card = page.getByTestId('account-models-card');
    await expect(card).toBeVisible();

    /* Step 2 — Ollama not detected; click Install. */
    await expect(page.getByTestId('ollama-install-not-detected')).toBeVisible();
    await page.getByRole('button', { name: /install ollama/i }).click();

    /* Step 3 — wait for the job card to flip through to installed.
       The poll loop is on a 1s interval; allow ample time. */
    await expect(page.getByTestId('ollama-install-job')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('ollama-install-ready')).toBeVisible({ timeout: 10_000 });

    /* Step 4 — pull qwen3.5:4b. */
    await page.getByTestId('model-pull-qwen3.5:4b').click();
    await expect(page.getByTestId('model-pull-progress-qwen3.5:4b')).toBeVisible({
      timeout: 3_000,
    });

    /* Step 5 — once the pull completes, the refresh hook should
       re-render the row as "on disk." */
    await expect(page.getByTestId('model-row-qwen3.5:4b')).toContainText(/on disk/i, {
      timeout: 10_000,
    });

    /* Step 6 — Refresh available models button re-runs /refresh. */
    await page.getByTestId('model-pull-refresh').click();
    await expect(page.getByTestId('model-row-qwen3.5:4b')).toContainText(/on disk/i);
  });
});
