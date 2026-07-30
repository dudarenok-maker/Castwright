import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

/**
 * #1943 — a guardian-of-minor clone must let the wizard name the real
 * attester (the guardian), distinct from `personName` (the child whose
 * voice it is). This crosses the redux ↔ view seam (the attester field's
 * visibility and Continue's disabled state both depend on the relationship
 * select's live value), which is exactly what jsdom+Vitest can lie about —
 * hence a real browser here, on top of the Vitest coverage in
 * `clone-capture-panel.test.tsx` / `clone-voice-wizard.test.tsx`.
 *
 * Deliberately its own file rather than a step inside `voice-library.spec.ts`'s
 * serial golden path (same rationale as `voice-library-unassign.spec.ts`):
 * that scenario mutates the shared in-memory `mockVoiceLibraryEntries` array
 * across its steps, and a fresh page here wants a pristine fixture set.
 *
 * NOT asserted here: the final persisted `consent.attestedBy` on the saved
 * card — and the reason is the DOM, not the mock. `src/lib/api.ts`'s
 * `mockCloneVoice` (the in-memory backend e2e runs against under
 * `VITE_USE_MOCKS`) now mirrors the real route's attester handling, pinned
 * by `src/lib/api.voice-library.test.ts`. But no view renders
 * `consent.attestedBy`, so there is nothing in the DOM for this spec to
 * assert against however the mock behaves.
 *
 * So this spec proves the wizard's behaviour, NOT the persisted record:
 * the attester field's conditional visibility, the Continue gate, the
 * relationship-aware attestation sentence, and that the whole guardian
 * flow completes. The record itself is covered at the route level in
 * `server/src/routes/voice-library.test.ts`. Don't read a green run here
 * as proof that what got stored was correct.
 */
test.describe.configure({ mode: 'serial' });

async function openCloneWizard(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/#/voices');
  await waitForRouteReady(page);
  const myVoicesTab = page.getByRole('button', { name: 'My voices', exact: true });
  await expect(myVoicesTab).toBeVisible({ timeout: 20_000 });
  await myVoicesTab.click();
  await expect(page.getByTestId('voice-library-card-lib-pinned')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('my-voices-clone-cta').first().click();
  await expect(page.getByTestId('clone-voice-wizard')).toBeVisible();

  await page.getByLabel('Upload audio').setInputFiles({
    name: 'sample.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('RIFFfake-wav-bytes-for-mock-ingest'),
  });
  await expect(page.getByRole('textbox', { name: 'transcript' })).toHaveValue(
    'the quick brown fox jumped',
    { timeout: 10_000 },
  );
}

test.describe('Clone-a-voice wizard — attester consent (#1943)', () => {
  test('guardian-of-minor requires an attester name, distinct from the child, before Continue', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openCloneWizard(page);

    await page.getByLabel('person name').fill('Ana');
    await page.getByLabel('relationship').selectOption('guardian-of-minor');

    // The relationship-aware sentence names the guardian's role, not the
    // fixed "relaying permission" phrasing that fits self/family only.
    await expect(page.getByText(/as this child’s guardian/i)).toBeVisible();

    // The attester field appears for this relationship — Ana (the child)
    // is not who is attesting.
    const attesterInput = page.getByLabel('attester name');
    await expect(attesterInput).toBeVisible();

    await page.getByLabel('I attest').check();
    const continueBtn = page.getByRole('button', { name: 'Continue' });
    // Still gated: personName + the checkbox alone are not enough for a
    // non-self relationship — the attester name is required too.
    await expect(continueBtn).toBeDisabled();

    await attesterInput.fill('Dana');
    await expect(continueBtn).toBeEnabled();
    await continueBtn.click();

    // Phase 2: name + Save completes the flow end to end.
    await page.getByTestId('clone-voice-wizard-name').fill('E2E Guardian Clone');
    await page.getByTestId('clone-voice-wizard-save').click();
    await expect(page.getByTestId('clone-voice-wizard-done')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('clone-voice-wizard-done').click();

    await expect(page.getByText('E2E Guardian Clone', { exact: true })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('self omits the attester field entirely and does not require it', async ({ page }) => {
    test.setTimeout(60_000);
    await openCloneWizard(page);

    await page.getByLabel('person name').fill('Me');
    // 'self' is the select's default — no relationship change needed.
    await expect(page.getByLabel('relationship')).toHaveValue('self');
    await expect(page.getByLabel('attester name')).toHaveCount(0);
    await expect(page.getByText(/as this child’s guardian/i)).toHaveCount(0);

    await page.getByLabel('I attest').check();
    const continueBtn = page.getByRole('button', { name: 'Continue' });
    await expect(continueBtn).toBeEnabled();
  });
});
