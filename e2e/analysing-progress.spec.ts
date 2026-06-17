/* Non-snapping sentence-attribution count + chars/s pulse.
 *
 * Boots a fresh book into the analysing stage (reusing the same flow as
 * analysing-multi-model.spec.ts), waits for the "Attributed ~N of ~M
 * sentences" headline to appear, then polls it to confirm the count never
 * decreases across a section boundary.  Also asserts the chars/s heartbeat
 * row is present alongside the sentence headline.
 *
 * The mock analysis stream (src/lib/api.ts mockAnalyseManuscript) emits
 * three live sub-ticks during Phase 0 progress 40–70%:
 *   tick 1 (40–50%): sectionsDone 0 / sentencesDone   6 / 120 sentences
 *   tick 2 (50–60%): sectionsDone 1 / sentencesDone  60 / 120 sentences
 *   tick 3 (60–70%): sectionsDone 2 / sentencesDone  65 / 120 sentences
 * Phase 0 runs for 1,500 ms (setInterval at 60 ms, ~25 ticks total).
 * A single heartbeat with charsPerSec: 320 is emitted once at tick 1.
 */

import { test, expect } from '@playwright/test';
import { bootFreshBookIntoAnalysing } from './helpers';

test('attribution shows a non-snapping sentence count + chars/s', async ({ page }) => {
  await bootFreshBookIntoAnalysing(page);
  await page.getByRole('button', { name: /Start analysis/i }).click();

  /* The headline appears once Phase 0 reaches 40% (600 ms into a 1500 ms
     phase), so an 8 s timeout is ample. */
  const headline = page.getByText(/Attributed ~\d+ of ~\d+ sentences/);
  await expect(headline).toBeVisible({ timeout: 8_000 });

  /* chars/s heartbeat row — asserted immediately while Phase 0 is still
     active (the mock emits charsPerSec: 320 on the first sentence-mode tick;
     the HeartbeatRow only renders on the active phase, so check before polling
     advances us past Phase 0's end at ~1500 ms). */
  await expect(page.getByText(/chars\/s/)).toBeVisible({ timeout: 3_000 });

  /* Poll the count ~8 times at 250 ms intervals (2 s total window).
     Deduplicate consecutive equal reads so a fast phase doesn't inflate
     the sample; then assert the deduplicated series is monotone. */
  const reads: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const txt = await headline.textContent().catch(() => null);
    if (txt) {
      const n = Number(/~(\d+) of/.exec(txt)?.[1] ?? '0');
      if (reads.length === 0 || reads[reads.length - 1] !== n) reads.push(n);
    }
    await page.waitForTimeout(250);
  }
  for (let i = 1; i < reads.length; i += 1) {
    expect(reads[i]).toBeGreaterThanOrEqual(reads[i - 1]);
  }
});
