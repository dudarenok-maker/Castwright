/* Bug #3169 — an idle analysing view (mounted, never started) rendered
 * phase 0 as active: spinner, progress bar, and the model chip's "· streaming"
 * label + pulsing dot, even though no run had ever begun. A reader reported a
 * long wait on a screen that looked busy; an idle page that looks busy
 * invites exactly that.
 *
 * bootFreshBookIntoAnalysing lands the page on /analysing with the "Start
 * analysis" button visible and WITHOUT clicking it — mock mode does not
 * auto-start the analysis stream, so this is genuinely the idle state the
 * bug report describes, not a stub.
 */

import { test, expect } from '@playwright/test';
import { bootFreshBookIntoAnalysing } from './helpers';

test('phase 0 reads pending (not streaming) on the idle analysing view, then streaming once started', async ({
  page,
}) => {
  await bootFreshBookIntoAnalysing(page);

  /* Only one copy of the chip exists while idle — the sticky bar (which
     would otherwise duplicate the testid) mounts only once a run is
     actually in flight. */
  const chip = page.getByTestId('phase-model-chip-0');
  await expect(chip).toHaveAttribute('data-phase-state', 'pending');
  await expect(chip).not.toContainText('streaming');

  await page.getByRole('button', { name: /Start analysis/i }).click();

  /* Once running, the sticky bar mounts its own copy of the chip too —
     `.first()` picks the PhaseCard's, mirroring analysing-multi-model.spec.ts. */
  const activeChip = page.getByTestId('phase-model-chip-0').first();
  await expect(activeChip).toHaveAttribute('data-phase-state', 'streaming', { timeout: 5_000 });
  await expect(activeChip).toContainText('streaming');
});
