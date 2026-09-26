/* #3084 F7 (wave 2b, Task 2.9a) — a reasoning overflow in a real browser:
 * the run-level "How to fix" list, the Advanced Settings deep link, and the
 * notification that survives navigating away.
 *
 * WHY THE FAILURE IS DELIVERED, NOT STREAMED. In mock mode
 * (`VITE_USE_MOCKS=true`, the harness this suite runs in — see
 * playwright.config.ts `webServer`) no analyzer is ever called:
 * `mockAnalyseManuscript` (src/lib/api.ts) drives the canned happy path
 * in-process with `setInterval`, and the persistent subscriber
 * (src/store/analysis-stream-middleware.ts) calls the SAME
 * `api.analyseManuscript` -> mock function. There is therefore no HTTP SSE
 * endpoint for `page.route` to intercept, and no ordinary mock book can
 * organically produce a `kind: 'error', code: 'analyzer-reasoning-overflow'`
 * frame. So this spec hand-authors the terminal frame (TERMINAL_ERROR_EVENT
 * below, mirroring `AnalysisStreamEvent`'s error shape in src/lib/api.ts and
 * the `AnalyseErrorEvent` schema in openapi.yaml) and delivers it through the
 * dev/e2e `window.__store__` hook (src/main.tsx), dispatching exactly the two
 * actions the middleware's `AnalysisError` branch dispatches for that frame:
 *   - `analysis/setHalted` — carries `fixes` onto the halted run snapshot the
 *     Analysing view renders its run-level block from;
 *   - `notifications/pushToast` ({ fixes, dedupeKey: 'analysis-stream' }) —
 *     what ToastStack routes to <ReasoningOverflowToast>.
 * Same precedent, and the same reasoning, as e2e/toast-surface.spec.ts, which
 * injects a toast mock mode cannot produce and drives the slice directly.
 *
 * WHY A FULL RELOAD IS NOT ASSERTED. Confirmed by reading the harness: only
 * `ui`, `manuscript` and `settings` are wrapped in redux-persist
 * (src/store/index.ts — `uiPersistConfig` / `manuscriptPersistConfig` /
 * `settingsPersistConfig`), so the `notifications` slice is per-page
 * in-memory state and a full page reload (plus mock mode's own module-level
 * state, e.g. `MOCK_BOOK_STATES` in src/lib/api.ts) drops the toast. What the
 * middleware's ownership of the stream actually buys the user is survival
 * across IN-APP navigation — asserted below for two in-app navigations.
 *
 * Timing: the mock stream runs ~7.6 s (ANALYSIS_NORTHERN_STAR) and then
 * completes the stage, so the halt is injected on the first tick and every
 * assertion lands inside that window. */

import { test, expect, type Page } from '@playwright/test';
import { bootFreshBookIntoAnalysing, waitForRouteReady } from './helpers';

/* Hand-authored terminal frame. `fixes` is exactly what
   `reasoningOverflowFixes` (server/src/routes/failure-taxonomy.ts) returns for
   a Gemini run: two setting deep links, the label-only "switch model" advice
   (no `settingKey`, so `fixHref` returns null and it renders as plain text),
   and the one wiki-link entry LAST. No entry ever carries both a `settingKey`
   and a `wikiPage`. */
const TERMINAL_ERROR_EVENT = {
  kind: 'error',
  code: 'analyzer-reasoning-overflow',
  message: 'The analyzer spent its whole output budget on reasoning and returned no answer text.',
  remediation: 'Apply one of the fixes below, then resume — finished chapters are kept.',
  fixes: [
    {
      label: 'Lower Gemini max input tokens per request',
      settingKey: 'analyzer.gemini.maxInputTokensPerRequest',
    },
    {
      label: 'Lower the Gemini output-heavy chunk size',
      settingKey: 'analyzer.gemini.outputHeavyChunkChars',
    },
    { label: 'Switch to a different analyzer model' },
    {
      label: 'Read: When a model thinks past its output limit',
      wikiPage: 'Analysis-and-the-Analyzer',
    },
  ],
};

type E2eStore = {
  getState: () => {
    analysis?: { activeStream?: { manuscriptId?: string } | null };
  };
  dispatch: (action: unknown) => void;
};

/* The manuscript id the run itself is keyed on — the same value the view's
 * halted-snapshot guard compares against, so we never have to guess how a
 * book id maps to a manuscript id. The view dispatches `setActiveStream`
 * before its POST, and the mock's first tick lands ~60 ms later. */
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

/* Deliver the hand-authored terminal error frame the way the analysis-stream
 * middleware delivers a real one: the halted-run snapshot (which the view's
 * run-level block reads `haltFixes` from when it has no live `error` of its
 * own) plus the persistent toast. See the file header for why this harness
 * has no SSE socket to write a frame onto. */
async function deliverTerminalError(page: Page, manuscriptId: string): Promise<void> {
  await page.evaluate(
    ({ manuscriptId: id, frame }) => {
      const store = (window as unknown as { __store__: E2eStore }).__store__;
      store.dispatch({
        type: 'analysis/setHalted',
        payload: {
          manuscriptId: id,
          code: frame.code,
          message: frame.message,
          fixes: frame.fixes,
        },
      });
      store.dispatch({
        type: 'notifications/pushToast',
        payload: {
          kind: 'error',
          message: frame.message,
          fixes: frame.fixes,
          dedupeKey: 'analysis-stream',
        },
      });
    },
    { manuscriptId, frame: TERMINAL_ERROR_EVENT },
  );
}

/* File-level serial mode — the cold-boot upload flow below races the single
 * Vite dev server under parallel workers, the same mitigation 10+ sibling
 * specs use. */
test.describe.configure({ mode: 'serial' });

test.describe('#3084 F7 — reasoning overflow names its fixes', () => {
  test('run-level "How to fix" list, the Advanced Settings deep link, and the toast that survives navigation', async ({
    page,
  }) => {
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();

    /* The halted-run snapshot is keyed on the run's own manuscript id, so take
     * it from the live run rather than guessing a book -> manuscript mapping,
     * then deliver the hand-authored terminal frame. */
    const manuscriptId = await readLiveManuscriptId(page);
    await deliverTerminalError(page, manuscriptId);

    /* (1) The run-level block renders the structured "How to fix" list, with a
     * link per `settingKey`/`wikiPage` entry and plain text for the label-only
     * one. Four fixes: two setting links, one wiki link, one plain label. */
    await expect(page.getByText('How to fix:')).toBeVisible({ timeout: 5_000 });
    const fixList = page
      .locator('ul')
      .filter({ hasText: 'Lower Gemini max input tokens per request' });
    await expect(fixList.getByRole('listitem')).toHaveCount(4);
    await expect(fixList.getByRole('link')).toHaveCount(3);
    await expect(
      fixList.getByRole('link', { name: 'Switch to a different analyzer model' }),
    ).toHaveCount(0);

    /* (2) Clicking a setting entry deep-links Advanced Settings with that row
     * focused and highlighted — `fixHref` builds `#/advanced?focus=<key>` and
     * `AdvancedRoute` scrolls the matching row in and marks it. */
    const settingLink = fixList.getByRole('link', {
      name: 'Lower Gemini max input tokens per request',
    });
    await expect(settingLink).toHaveAttribute(
      'href',
      '#/advanced?focus=analyzer.gemini.maxInputTokensPerRequest',
    );
    await settingLink.click();
    await expect(page).toHaveURL(
      /#\/advanced\?focus=analyzer\.gemini\.maxInputTokensPerRequest$/,
    );
    await waitForRouteReady(page);
    const highlightedRow = page.locator('[data-highlighted="true"]');
    await expect(highlightedRow).toBeVisible({ timeout: 3_000 });
    await expect(highlightedRow).toContainText(/max input tokens per request/i);

    /* (3) The notification is the middleware's, not the view's, so it is still
     * there after the user has navigated away — asserted across two in-app
     * navigations (this one, then the history pop back below). It carries the
     * same "How to fix" list and a dismiss button, and no auto-dismiss timer
     * the way a plain ToastItem has. A full reload would clear it: the
     * notifications slice is not in redux-persist's whitelist (file header). */
    const toast = page.getByRole('status').filter({ hasText: /output budget on reasoning/i });
    await expect(toast).toBeVisible({ timeout: 3_000 });
    await expect(toast.getByRole('button', { name: /Dismiss notification/i })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/#\/books\/.+\/analysing$/);
    await expect(toast).toBeVisible({ timeout: 3_000 });
  });
});
