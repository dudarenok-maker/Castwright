/* Shared Playwright helpers for the e2e spec suite.
 *
 * Extracted from `e2e/new-book-flow.spec.ts` so multiple specs can drive
 * the same new-book flow without re-implementing the click chain. Today's
 * callers: `e2e/new-book-flow.spec.ts` (depth assertions) +
 * `e2e/responsive/visual.spec.ts` (per-stage baselines, plan 37).
 *
 * The mock backend in `src/lib/api.ts` is the contract these helpers
 * exercise; if you change the click affordances they target, update the
 * helper here in one place rather than every spec. */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

const PASTED_MANUSCRIPT =
  '# The E2E Test Book\n\n# Chapter 1\n\nA tiny test paragraph.\n\n' +
  '# Chapter 2\n\nA second paragraph.\n';

/* Drive from cold boot to the analysing route, stopping BEFORE the user
 * clicks "Start analysis" — the view is then in its deterministic
 * "ready to fire" state with no live phase progress, ideal for visual
 * regression baselines and as a jumping-off point for spec assertions.
 *
 * Returns once the URL matches `#/books/:id/analysing` and the Start
 * button is visible + enabled. */
export async function goToAnalysing(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
    timeout: 10_000,
  });

  await page
    .getByRole('button', { name: /Start a new book/i })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/new$/);

  await page.getByRole('button', { name: /Paste text/i }).click();
  await page.locator('textarea').fill(PASTED_MANUSCRIPT);
  await page.getByRole('button', { name: /Upload pasted text/i }).click();

  await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
    timeout: 5_000,
  });
  await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('E2E Author');
  await page.getByRole('button', { name: /Save book and start analysis/i }).click();

  await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
  /* Cold first-compile: the analysing route's React.lazy chunk can outlast the
     5 s button budget (the URL flips to /analysing before the view mounts).
     Wait for the suspense fallback to detach so the Start button check below is
     gated on an explicit ready signal, not implicit cold-load timing. */
  await waitForRouteReady(page);
  await expect(page.getByRole('button', { name: /Start analysis/i })).toBeVisible({
    timeout: 10_000,
  });
}

/* Continue from `goToAnalysing` through the analysis stream to the
 * confirm-cast route. The mock SSE takes ~7.6 s (ANALYSIS_NORTHERN_STAR),
 * so the URL wait gets a 15 s budget to absorb jitter. */
export async function goToConfirm(page: Page): Promise<void> {
  await goToAnalysing(page);
  await page.getByRole('button', { name: /Start analysis/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/confirm$/, { timeout: 15_000 });
  await waitForRouteReady(page);
  await expect(
    page.getByRole('button', { name: /Confirm cast and review manuscript/i }),
  ).toBeVisible({ timeout: 10_000 });
}

/* Plan 89 C5 — DelayedSpinner paints at +150 ms while a React.lazy chunk
 * is in flight. Waiting for it to detach gives the lazy view a determi-
 * nistic mount point regardless of cache warmth. Warm cache: spinner
 * never paints; this resolves immediately. Cold cache: blocks until the
 * lazy chunk resolves and Suspense swaps to the real view. */
export async function waitForRouteReady(page: Page): Promise<void> {
  await page
    .locator('[data-testid="route-suspense-fallback"]')
    .waitFor({ state: 'detached', timeout: 15_000 });
}

/* Per-view hydration helpers. `waitForRouteReady` proves the React.lazy
 * chunk swapped in, but each view has its own internal slices that
 * hydrate AFTER mount (chapters list, cast list, mini-player audio).
 * Specs that immediately assert on post-hydration state (chapter rows,
 * character cards, audio src) need to wait for those signals — under
 * sustained parallel-worker contention the inline 5 s budgets in
 * several specs are too tight and retry-recover on the second run.
 * These per-view hydration helpers absorb that timing.
 *
 * Each helper picks the cheapest signal that proves the slice is ready:
 *   - listen: h1 title visible AND "Play from the start" enabled
 *     (enables once listenable.length > 0 — the chapters slice has
 *     hydrated and the cross-book guard sees them).
 *   - confirm: first "Open profile for X" character button visible
 *     (mounts once the cast list has hydrated).
 *   - library: "Start a new book" CTA visible (the library route's
 *     primary mount point — same signal goToAnalysing uses). */

export async function waitForListenViewReady(
  page: Page,
  titleRe: RegExp = /./,
): Promise<void> {
  await expect(page.getByRole('heading', { name: titleRe, level: 1 })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('button', { name: /Play from the start/i })).toBeEnabled({
    timeout: 10_000,
  });
}

export async function waitForConfirmViewReady(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /Open profile for/i }).first()).toBeVisible({
    timeout: 10_000,
  });
}

export async function waitForLibraryViewReady(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
    timeout: 10_000,
  });
}

/* The Account view mounts QwenInstall + OllamaInstall (+ model-pull-status),
 * which probe the backend with RAW `fetch` — `/api/qwen/detect`,
 * `/api/coqui/detect`, `/api/ollama/detect`, `/api/ollama/refresh` — bypassing the VITE_USE_MOCKS
 * client layer that every other e2e surface goes through. The e2e Vite server
 * proxies `/api` to `localhost:8080` (vite.config), so on a dev box with the
 * real app running these resolve to the MACHINE's actual install state (Qwen /
 * Ollama installed) instead of the "not installed" state the Account specs
 * assume. That makes the install-card assertions flake whenever :8080 is up
 * (they pass on CI, where nothing answers the proxy), and the real-backend
 * round-trips on every mount add the latency behind the `goto`/visibility
 * timeouts under parallel-worker load. Stub the probes to a deterministic
 * not-installed / empty state so the Account view renders identically
 * regardless of the box AND mounts without a network hop. Call in a
 * `beforeEach`, before the first navigation. */
/* Boot a fresh book through the upload flow and land on the analysing route
 * with the "Start analysis" button visible + enabled. Used by both the
 * analysing-multi-model and analysing-progress specs. */
export async function bootFreshBookIntoAnalysing(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Start a new book/i })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/new$/);
  await page.getByRole('button', { name: /Paste text/i }).click();
  await page
    .locator('textarea')
    .fill('# The Analysing Spec Book\n\n# Chapter 1\n\nA tiny chapter.\n\n# Chapter 2\n\nAnother.\n');
  await page.getByRole('button', { name: /Upload pasted text/i }).click();
  await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
    timeout: 5_000,
  });
  await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('Analysing Spec Author');
  await page.getByRole('button', { name: /Save book and start analysis/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
  await expect(page.getByRole('button', { name: /Start analysis/i })).toBeVisible({
    timeout: 5_000,
  });
}

/* Start-generation tier prompt (#1160). For a Qwen book, clicking "Approve cast
   & start generating" / "Resume generation" now opens the StartGenerationModal
   so the user picks the voice-model tier before the run begins. Confirm it (keep
   the pre-selected default) so generation actually starts. No-op when the prompt
   isn't shown (a non-Qwen book starts directly). Call right after the start CTA. */
export async function confirmTierPromptIfPresent(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: /Choose the voice model/i });
  if (await heading.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Start generating', exact: true }).click();
    await expect(heading).toBeHidden({ timeout: 5_000 });
  }
}

export async function stubAccountModelProbes(page: Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/qwen/detect', (route) =>
    route.fulfill(json({ state: 'not-installed', installed: false })),
  );
  await page.route('**/api/coqui/detect', (route) =>
    route.fulfill(json({ state: 'weights-missing', installed: false })),
  );
  await page.route('**/api/ollama/detect', (route) =>
    route.fulfill(json({ installed: false, version: null })),
  );
  await page.route('**/api/ollama/refresh', (route) => route.fulfill(json({ models: [] })));
}
