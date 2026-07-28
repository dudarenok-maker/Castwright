import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

/**
 * Plan 179 — Listen-view entry point for the audio-QA scan-and-repair stream.
 *
 * The `POST …/audio-qa-repair` endpoint shipped with no frontend consumer at
 * all, so the `voice_language_mismatch` advisory it emits ([#1889]) had nowhere
 * to land. This spec walks the whole path a user walks:
 *
 *   suspect chapter row → repair button → qa-repair-runner-middleware →
 *   api.streamQaRepair → `warning` frame → warn toast in <ToastStack/>
 *
 * Why browser-level rather than jsdom: the run crosses the chapter row's redux
 * read, the middleware's async SSE loop, and the toast stack mounted way up in
 * the global <Layout/> shell — three seams jsdom can render "green" while the
 * real composition is broken. The mock `api.streamQaRepair` resolves the arc
 * without a backend or a GPU.
 */

/* Same stabilisation as the sibling Listen-view specs (listen-loudness-report,
   listen-rename-chapter): chapter-row hydration races other workers' SSE
   traffic on Windows, so this file runs serially and asserts the hash landed
   before waiting on the view. */
test.describe.configure({ mode: 'serial' });

type StoreWin = {
  __store__?: {
    getState: () => {
      chapters: { chapters: Array<{ id: number }> };
      qaRepair: { running: Record<string, true> };
    };
    dispatch: (a: unknown) => void;
  };
};

test.describe('Listen view → audio-QA repair', () => {
  test("repairing a suspect chapter surfaces the stream's language-mismatch warning", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto('/#/books/sb/listen');
    await expect(page).toHaveURL(/#\/books\/sb\/listen/);
    /* waitForListenViewReady's own heading wait is pinned at 10 s, which a
       cold Vite module-graph compile can outrun when this file happens to be
       the first Listen spec a worker runs. Wait for the same heading with a
       longer budget first, so the helper's assertion is then immediate. */
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 30_000,
    });
    await waitForListenViewReady(page, /Solway Bay/i);

    /* Flag CH1 suspect — the affordance is deliberately gated on the srv-27
       QA verdict, so it does not render on the stock mock rows. */
    await page.evaluate(() => {
      const s = (window as unknown as StoreWin).__store__;
      if (!s) throw new Error('window.__store__ not exposed (e2e gate regressed)');
      const chapters = s.getState().chapters.chapters;
      s.dispatch({
        type: 'chapters/setChapters',
        payload: chapters.map((c) =>
          c.id === 1
            ? {
                ...c,
                state: 'done',
                progress: 1,
                audioModelKey: 'kokoro-v1',
                audioQa: { status: 'suspect', reasons: ['near-silent segment'] },
              }
            : c,
        ),
      });
    });

    /* Only the flagged row carries the affordance. */
    const repair = page.getByTestId('chapter-row-1-qa-repair');
    await expect(repair).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('chapter-row-2-qa-repair')).toHaveCount(0);

    await repair.click();

    /* The advisory the endpoint has always emitted and nothing ever read.
       Asserted on its rendered text in the live toast stack — not on store
       state — so a middleware that dispatched into the void would fail here. */
    await expect(
      page.getByText(
        /designed voice\(s\) were cleared because they were designed for a different language/i,
      ),
    ).toBeVisible({ timeout: 10_000 });

    /* And the run actually completed: the busy flag clears and the summary
       toast reports what was re-recorded. */
    await expect(page.getByText(/re-recorded 2 lines/i)).toBeVisible({ timeout: 10_000 });
    const stillRunning = await page.evaluate(
      () => (window as unknown as StoreWin).__store__?.getState().qaRepair.running['sb:1'] ?? null,
    );
    expect(stillRunning).toBeNull();
  });
});
