import { test, expect } from '@playwright/test';

/* fs-21 defense-in-depth diagnosis, Task 17 — drives a real venv-missing
 * BlockerDiagnosis through a full failure -> fix -> pass cycle:
 *
 *   - `?setup=notready` latches mockGetSetupReadiness() (src/lib/api.ts) to
 *     report the sidecar blocker as venv-missing, with the exact message /
 *     action copied from the server's real diagnoseSidecar() (Task 8 fix).
 *   - The pre-existing <VenvBootstrap> card (src/components/venv-bootstrap.tsx)
 *     also lives on this step and owns its own /api/setup/venv/detect probe.
 *     Left alone, that probe 502s against the proxied (absent) :8080 backend
 *     and falls back to a "Voice engine runtime not set up" + "Set up the
 *     voice engine runtime" card — the SAME copy the new diagnosis-driven
 *     <BlockerFixAction> uses — which would make role/text locators
 *     ambiguous. Mocking /detect to report "no Python" steers it into its
 *     distinct manual-instructions card instead, so only the diagnosis-driven
 *     copy matches.
 *   - <BlockerFixAction> (src/components/blocker-fix-action.tsx) talks to
 *     raw fetch(), not the api.* mock indirection, so its POST/poll against
 *     /api/setup/venv/bootstrap is mocked directly here via page.route().
 *   - Once the mocked job reports 'installed', this spec flips the
 *     `mock-venv-fixed` sessionStorage flag that mockGetSetupReadiness()
 *     checks — simulating what a real backend's GET /api/setup/readiness
 *     would naturally reflect once the venv is actually installed — so the
 *     fix action's onDone -> onRefetch call observes the fixed state.
 */
test('venv-missing diagnosis shows a working fix action end to end', async ({ page }) => {
  await page.route('**/api/setup/venv/detect', async (route) => {
    await route.fulfill({ json: { state: 'no-python', venvPresent: false, pythonFound: false, installed: false } });
  });

  await page.route('**/api/setup/venv/bootstrap', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ json: { id: '1', status: 'bootstrapping', step: null, error: null } });
    } else {
      await route.continue();
    }
  });
  let polled = false;
  await page.route('**/api/setup/venv/bootstrap/1', async (route) => {
    if (!polled) {
      polled = true;
      await route.fulfill({ json: { id: '1', status: 'bootstrapping', step: 'Installing packages…', error: null } });
      return;
    }
    await page.evaluate(() => sessionStorage.setItem('mock-venv-fixed', 'true'));
    await route.fulfill({ json: { id: '1', status: 'installed', step: null, error: null } });
  });

  await page.goto('/#/?setup=notready');
  await expect(page).toHaveURL(/#\/setup/);

  // Guided (first-run) mode always opens on Step 1 (Environment); the voice
  // engine runtime diagnosis lives in Step 3 (Models).
  const next = page.getByRole('button', { name: /^next$/i });
  await next.click();
  await next.click();

  await expect(page.getByText('Voice engine runtime not set up.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /set up the voice engine runtime/i }).click();
  await expect(page.getByText(/working…/i)).toBeVisible();
  await expect(page.getByText(/runtime ready/i)).toBeVisible({ timeout: 10_000 });
});
