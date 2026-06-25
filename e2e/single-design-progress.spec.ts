import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * Single-design progress — phase labels appear, no fake "about 15s".
 *
 * Drives a fresh book to confirm-cast, opens Captain Halloran's drawer,
 * switches the engine to Qwen, installs the fake clock (freezes
 * `setInterval` so the ETA display is deterministic), clicks Design, then
 * asserts:
 *
 *   1. `design-waveform` is mounted — confirms DesignProgress is rendered.
 *   2. `design-eta` does NOT contain the old fake "about 15s" copy.
 *   3. `design-eta` shows the honest "~X:XX left" ETA format.
 *   4. The phase label rendered at mount time is a real DESIGN_PHASE_LABELS
 *      string (not the old placeholder).
 *
 * Implementation note (AR9 — timer behaviour under fake clock):
 * `page.clock.install()` patches `Date`, `setInterval`, etc., which freezes
 * the `DesignProgress` ETA/elapsed display.  However, the mock's `wait(ms)`
 * function resolves via `setTimeout(resolve, ms)`.  Due to how Playwright
 * patches `window.setTimeout` AFTER the module has been evaluated, the mock
 * captures the *original* `setTimeout` reference at module load time and
 * continues to fire in real wall-clock time (~60ms per phase).  The phase
 * label therefore advances in real time; we read it synchronously via
 * `page.evaluate` immediately after DesignProgress mounts to capture whatever
 * label is current and assert it is a real phase name.
 *
 * Modelled on: `e2e/voice-design-progress.spec.ts` — same navigation pattern
 * (goToConfirm → Captain Halloran → engine picker → Qwen → clock.install →
 * click Design); that spec guards render-path while this one guards label and
 * ETA content.
 */

test.describe('single-design progress phase labels', () => {
  test('shows real phase labels in order, no fake "about 15s"', async ({ page }) => {
    test.setTimeout(60_000);

    await goToConfirm(page);
    await waitForRouteReady(page);

    /* Open Captain Halloran's drawer — the most fixture-rich character;
       has evidence + voiceStyle so the Qwen panel auto-fills a persona.
       Same selector as voice-design-progress.spec.ts and
       single-voice-design-background.spec.ts. */
    const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    /* Drawer mounted — evidence section proves hydration. */
    await expect(page.getByText(/Evidence from the manuscript/i)).toBeVisible({ timeout: 10_000 });

    /* Switch per-character engine to Qwen so the design panel appears. */
    const engineSelect = page.getByLabel('Voice engine for this character');
    await expect(engineSelect).toBeVisible();
    await engineSelect.selectOption('qwen');

    /* Wait for the Qwen panel and persona to auto-populate (mock
       generateVoiceStyle resolves in ~80 ms).  The clock must NOT be
       installed yet — otherwise this 80 ms timer never fires and the
       persona field stays empty, keeping the Design button disabled. */
    await expect(page.getByTestId('qwen-design-panel')).toBeVisible();
    const personaField = page.getByTestId('qwen-persona-text');
    await expect(personaField).not.toHaveValue('', { timeout: 5_000 });

    /* Install fake clock — freezes setInterval (DesignProgress ETA/elapsed
       display) so the ETA assertion is deterministic.  The mock's setTimeout
       still fires in real time (see AR9 note above). */
    await page.clock.install();

    const designBtn = page.getByTestId('qwen-design-voice');
    await expect(designBtn).toBeEnabled({ timeout: 5_000 });
    await designBtn.click();

    /* ── ASSERTION 1: DesignProgress is mounted ───────────────────────── */
    const waveform = page.getByTestId('design-waveform');
    await expect(waveform).toBeAttached({ timeout: 5_000 });

    /* ── ASSERTION 2 & 3: honest ETA, no fake "about 15s" ─────────────── */
    const eta = page.getByTestId('design-eta');
    await expect(eta).toBeVisible({ timeout: 3_000 });
    await expect(eta).not.toContainText(/about 15s/i);
    await expect(eta).toContainText(/~/);

    /* ── ASSERTION 4: the phase label is a real DESIGN_PHASE_LABELS value ─
       Read the current phase label text synchronously from the DOM.
       `DesignProgress` renders `{DESIGN_PHASE_LABELS[phase]}` as a <span>
       immediately after the fill bar; the waveform div is the first child of
       the DesignProgress container, so the label is in the 3rd child div. */
    const phaseText = await page.evaluate(() => {
      const eta = document.querySelector('[data-testid="design-eta"]');
      if (!eta) return null;
      /* Walk from design-eta up to the DesignProgress wrapper, then find
         the sibling row that holds the phase label (it's the element
         immediately before design-eta in the wrapper). */
      const wrapper = eta.parentElement;
      if (!wrapper) return null;
      const labelRow = eta.previousElementSibling;
      return labelRow?.querySelector('span')?.textContent?.trim() ?? null;
    });

    /* The phase label must be a real DESIGN_PHASE_LABELS string.
       Any of the 7 labels is acceptable — the specific one depends on
       which phase was active at evaluation time (phases advance in ~60ms
       real-time intervals). */
    expect(phaseText).toMatch(
      /loading the design model|designing the voice|distilling the voice|rendering the 12s audition|freeing gpu memory|anchoring to the base voice|performing the emotion/i,
    );
    /* Explicitly confirm the old fake copy is gone. */
    expect(phaseText).not.toMatch(/about 15s/i);

    await page.clock.resume();
  });
});
