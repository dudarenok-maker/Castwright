/* Plan 2 §2.5 — the Advanced Configuration device picker shows a
 * `stale_reason` badge (e.g. "fell back to CPU") when the mocked sidecar
 * /health reports a resident engine running on a different device than
 * pinned. Mock mode (VITE_USE_MOCKS=true) never makes a real network call
 * for GET /api/gpu/devices — api.getGpuDevices() is fulfilled in-process by
 * mockGetGpuDevices() in src/lib/api.ts, so page.route() interception is not
 * applicable here (mirrors model-manager-health.spec.ts's note about the
 * same mock-layer shape). Instead, seed the response via the established
 * `__SEED_...__` window-global convention (see mockGetLibraryStats /
 * mockGetContinueListening) that mockGetGpuDevices() now reads. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test('device row shows a cpu_fallback badge when the mocked sidecar health reports one', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __SEED_GPU_DEVICES__: unknown }).__SEED_GPU_DEVICES__ = {
      devices: [
        {
          uuid: 'GPU-0',
          idx: 0,
          name: 'Test Card',
          total_mb: 8000,
          free_mb: 6000,
          resident: [{ engine: 'qwen', actual_card: null, stale_reason: 'cpu_fallback' }],
        },
      ],
      cpu: true,
    };
  });

  await page.goto('/#/advanced');
  await waitForRouteReady(page);

  /* "Voice engine & device" (tts-engine) is risk:'high' and starts
     collapsed — open it before the qwen device row (and its badge) mounts. */
  await page.locator('button[aria-label="Voice engine & device"]').click();

  await expect(page.getByText(/fell back to cpu/i)).toBeVisible({ timeout: 5_000 });
});
