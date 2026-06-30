/* Dedicated e2e for the pre-generation voice-model prompt (#1160 StartGenerationModal).
 *
 * QUARANTINED (#1178, 2026-06-30): every case is tagged `@quarantine` so the
 * gating `test:e2e` grep-inverts it out. The shared `goToConfirm`/
 * `goToStartGenModal` cold-load race exhausts Playwright's retries under
 * battery / cold-webServer load (fails 1/6 in the full battery, 5/6 in
 * isolation), reddening the gate on unrelated pushes. Run on demand via
 * `npm run test:e2e:quarantine`. De-quarantine once `goToStartGenModal` waits
 * on an explicit ready signal instead of implicit cold-load timing; see the
 * flaky-register rewrite playbook.
 *
 * The other generation specs only DISMISS the prompt (confirmTierPromptIfPresent);
 * this spec asserts the prompt's OWN behaviour: for a Qwen book it appears before
 * the run starts, offers both Qwen tiers with the cast-pin-aware default
 * pre-selected, and confirming a chosen tier starts generation. The mock
 * upload-flow cast renders on Qwen, so clicking the start CTA opens the prompt
 * (a non-Qwen book starts directly — covered by the start-generation-flow thunk
 * unit test). One test = one (cold-start-flaky) upload setup; Playwright's
 * configured retries ride out the shared goToConfirm helper's cold-load race.
 *
 * The four cases (A/B/C/D) below lock down the "all three sinks converge" fix
 * described in the implementation plan:
 *   A. 1.7B pick → session default + cast pins both flip to 1.7B AND
 *      ttsModelKeyExplicit is true (so settings-hydration can't silently
 *      rewind an in-flight pick).
 *   B. The enqueued queue entry's persisted `modelKey` field is 1.7B. The
 *      queue dispatcher reads ui.ttsModelKey at dispatch time; the persisted
 *      field is what proves the session default moved BEFORE the enqueue
 *      landed — otherwise Chapter 1's queue entry would carry 0.6B.
 *   C. 0.6B pick → every Qwen member's ttsModelKey is null AND
 *      ttsModelKeyExplicit is now true (explicit 0.6B is the new "no
 *      auto-upgrade" signal documented in plan 229; the existing
 *      `resetSelectedModelToDefault` reducer is the recovery path).
 *   D. Guard rail: a freshly-analysed book with NO designed voices → 1.7B
 *      pick surfaces a warn toast and generation does NOT start; 0.6B does
 *      start (baseline behaviour). The re-open path also proves the modal's
 *      "Start generating" button isn't stuck in busy=true (Finding 1).
 */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm } from './helpers';

/* Drive from analysing-ready into the Generate view's StartGen modal. Shared
   by all four cases so the cold-start flakiness stays in one place. */
async function goToStartGenModal(page: Page): Promise<void> {
  await goToConfirm(page);
  await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
  await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });
}

/* Drive from analysing-ready into the Generate view's StartGen modal WITH a
   fully-designed Qwen cast (every Qwen member has `overrideTtsVoices.qwen.name`
   set). Used by cases A/B so the modal's "1.7B" guard rail doesn't refuse the
   pick for an undesigned cast — the guard rail is correct behaviour (see case
   D) and the production user hits this state after clicking "Design full cast"
   on the cast view before pressing "Approve cast & start generating".

   The mock `startCastDesign` emits one `character_designed` per needs-voice
   character; after the run every base voice is designed and the picker
   dispatches a toast summarising "Designed N." */
async function goToStartGenModalWithDesignedCast(page: Page): Promise<void> {
  await goToStartGenModal(page);
  const bookId = page.url().match(/#\/books\/([^/]+)\//)?.[1];
  expect(bookId).toBeTruthy();
  await page.goto(`/#/books/${bookId}/cast`);
  await expect(page.getByTestId('design-full-cast')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('design-full-cast').click();
  await expect(page.getByTestId('design-scope-picker')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('scope-bases').click();
  /* The mock designs every base voice within ~15 s. The (N) suffix drops off
     the button once all needs-voice characters have a voice. */
  await expect(page.getByTestId('design-full-cast')).not.toContainText(/\(\d+\)/, {
    timeout: 15_000,
  });
  await page.goto(`/#/books/${bookId}/generate`);
  await expect(page.getByRole('heading', { name: /Choose the voice model/i })).toBeVisible({
    timeout: 10_000,
  });
}

async function readSessionTtsModelKey(page: Page): Promise<{
  key: string;
  explicit: boolean;
}> {
  return page.evaluate(() => {
    const store = (window as unknown as { __store__: { getState(): unknown } }).__store__;
    const ui = (
      store.getState() as { ui: { ttsModelKey: string; ttsModelKeyExplicit: boolean } }
    ).ui;
    return { key: ui.ttsModelKey, explicit: ui.ttsModelKeyExplicit };
  });
}

async function readCastFromStore(
  page: Page,
): Promise<Array<{ id: string; ttsEngine?: string; ttsModelKey?: string | null }>> {
  return page.evaluate(() => {
    const store = (window as unknown as { __store__: { getState(): unknown } }).__store__;
    const state = store.getState() as { cast: { characters: unknown[] } };
    return state.cast.characters as Array<{
      id: string;
      ttsEngine?: string;
      ttsModelKey?: string | null;
    }>;
  });
}

test('voice-model prompt before a Qwen run: both tiers, 0.6B default, confirm starts (#1160) @quarantine', async ({
  page,
}) => {
  await goToStartGenModal(page);

  /* The prompt appears with both Qwen tiers. */
  const heading = page.getByRole('heading', { name: /Choose the voice model/i });
  await expect(heading).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('start-gen-tier-qwen3-tts-0.6b')).toBeVisible();
  await expect(page.getByTestId('start-gen-tier-qwen3-tts-1.7b')).toBeVisible();
  /* A freshly-analysed cast carries no 1.7B pin → 0.6B is the default selection. */
  await expect(page.getByTestId('start-gen-tier-qwen3-tts-0.6b')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('start-gen-tier-qwen3-tts-1.7b')).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  /* Confirm the default 0.6B pick → the prompt closes and generation starts.
     (Picking 1.7B on an undesigned mock cast trips the new "design voices
     first" guard rail — covered by case D. The production path reaches this
     point with voices already designed via the cast-view "Design full cast"
     button; cases A and B drive that path explicitly.) */
  await page.getByRole('button', { name: 'Start generating', exact: true }).click();
  await expect(heading).toBeHidden({ timeout: 5_000 });
  /* Generation is live once a chapter-row "Generating" pill shows. */
  await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
    timeout: 20_000,
  });
});

test.describe('StartGenerationModal: three-sink sync @quarantine', () => {
  test('A. 1.7B pick flips session default + every Qwen member pin', async ({ page }) => {
    await goToStartGenModalWithDesignedCast(page);
    const heading = page.getByRole('heading', { name: /Choose the voice model/i });
    await page.getByTestId('start-gen-tier-qwen3-tts-1.7b').click();
    await page.getByRole('button', { name: 'Start generating', exact: true }).click();
    await expect(heading).toBeHidden({ timeout: 5_000 });

    /* Sink 1: session default flipped to 1.7B AND marked explicit. */
    const session = await readSessionTtsModelKey(page);
    expect(session.key).toBe('qwen3-tts-1.7b');
    expect(session.explicit).toBe(true);

    /* Sink 2: every Qwen member in the cast has ttsModelKey === 'qwen3-tts-1.7b'. */
    const cast = await readCastFromStore(page);
    const qwenMembers = cast.filter((c) => c.ttsEngine === 'qwen');
    expect(qwenMembers.length).toBeGreaterThan(0);
    for (const c of qwenMembers) expect(c.ttsModelKey).toBe('qwen3-tts-1.7b');

    /* Generation is live — the chapter-row "Generating" pill appears. */
    await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('B. 1.7B pick → enqueued queue entry carries modelKey=qwen3-tts-1.7b', async ({
    page,
  }) => {
    /* If the modal left ui.ttsModelKey on 0.6B, the persisted queue entry
       would carry 0.6B and the model would mismatch the cast pins. Reading
       the queue slice directly proves the session default was synced BEFORE
       requestStartGeneration dispatched. */
    await goToStartGenModalWithDesignedCast(page);
    await page.getByTestId('start-gen-tier-qwen3-tts-1.7b').click();
    await page.getByRole('button', { name: 'Start generating', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: /Choose the voice model/i }),
    ).toBeHidden({ timeout: 5_000 });

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const store = (window as unknown as { __store__: { getState(): unknown } }).__store__;
            const state = store.getState() as {
              queue: { snapshot?: { entries?: Array<{ modelKey?: string }> } };
            };
            const entries = state.queue?.snapshot?.entries ?? [];
            return entries.map((e) => e.modelKey ?? null);
          }),
        { timeout: 20_000 },
      )
      .toContain('qwen3-tts-1.7b');
  });

  test('C. 0.6B pick clears pins AND flips ttsModelKeyExplicit (the new "no auto-upgrade" signal)', async ({
    page,
  }) => {
    await goToStartGenModal(page);
    const heading = page.getByRole('heading', { name: /Choose the voice model/i });
    await expect(heading).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('start-gen-tier-qwen3-tts-0.6b').click();
    await page.getByRole('button', { name: 'Start generating', exact: true }).click();
    await expect(heading).toBeHidden({ timeout: 5_000 });

    const session = await readSessionTtsModelKey(page);
    expect(session.key).toBe('qwen3-tts-0.6b');
    /* Documented as a "Suggested follow-up" in plan 229: an explicit 0.6B
       pick now flags the picker as user-locked, blocking settings-hydration
       from silently upgrading to 1.7B. `resetSelectedModelToDefault` (the
       "Reset to default" pill on the override badge) is the recovery path. */
    expect(session.explicit).toBe(true);

    /* Every Qwen member's ttsModelKey cleared (null). */
    const cast = await readCastFromStore(page);
    const qwenMembers = cast.filter((c) => c.ttsEngine === 'qwen');
    expect(qwenMembers.length).toBeGreaterThan(0);
    for (const c of qwenMembers) expect(c.ttsModelKey ?? null).toBeNull();
  });

  test('D. Guard rail: 1.7B on an undesigned cast warns + does not start; 0.6B does start', async ({
    page,
  }) => {
    /* Fresh book lands with zero designed Qwen voices. Skip the design
       step entirely so no character carries overrideTtsVoices.qwen.name —
       the exact state the guard rail should refuse 1.7B on. */
    await goToStartGenModal(page);
    const heading = page.getByRole('heading', { name: /Choose the voice model/i });
    await expect(heading).toBeVisible({ timeout: 5_000 });

    /* Pick 1.7B and confirm → modal stays open, warn toast appears, no enqueue. */
    await page.getByTestId('start-gen-tier-qwen3-tts-1.7b').click();
    await page.getByRole('button', { name: 'Start generating', exact: true }).click();
    await expect(heading).toBeVisible({ timeout: 1_000 });
    await expect(page.getByText(/No Qwen voice has been designed yet/i)).toBeVisible({
      timeout: 5_000,
    });

    /* No queue entry created (Finding 6: strongest regression signal we can
       add at this layer for the hand-waved server-side routeFor fallback). */
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const store = (window as unknown as { __store__: { getState(): unknown } }).__store__;
            const state = store.getState() as {
              queue: { snapshot?: { entries?: unknown[] } };
            };
            return (state.queue?.snapshot?.entries ?? []).length;
          }),
        { timeout: 2_000 },
      )
      .toBe(0);

    /* Modal's CTA isn't stuck in busy=true (Finding 1). Cancel + open again
       and verify the button is enabled. */
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(heading).toBeHidden({ timeout: 5_000 });

    /* The Generate view's start CTA re-opens the modal if the user re-clicks. */
    const startCta = page.getByRole('button', { name: /Start generating/i }).first();
    if (await startCta.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await startCta.click();
      await expect(heading).toBeVisible({ timeout: 5_000 });
      await expect(page.getByRole('button', { name: 'Start generating', exact: true })).toBeEnabled();
    }

    /* Pick 0.6B now → generation DOES start (baseline behaviour for a
       no-design cast). */
    await page.getByTestId('start-gen-tier-qwen3-tts-0.6b').click();
    await page.getByRole('button', { name: 'Start generating', exact: true }).click();
    await expect(heading).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
