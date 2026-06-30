/* Dedicated e2e for the pre-generation voice-model prompt (#1160 StartGenerationModal).
 *
 * The other generation specs only DISMISS the prompt (confirmTierPromptIfPresent);
 * this spec asserts the prompt's OWN behaviour: for a Qwen book it appears before
 * the run starts, offers both Qwen tiers with the cast-pin-aware default
 * pre-selected, and confirming a chosen tier starts generation. The mock
 * upload-flow cast renders on Qwen, so clicking the start CTA opens the prompt
 * (a non-Qwen book starts directly — covered by the start-generation-flow thunk
 * unit test).
 *
 * Determinism (was #1178, de-quarantined 2026-06-30): every flow waits on an
 * explicit ready signal rather than implicit cold-load timing. waitForQwenCastHydrated
 * gates the cast-renders-on-Qwen predicate the start thunk reads (an empty cast
 * slice would start the run directly with no modal); waitForRouteReady gates each
 * lazy-chunk mount; and the designed / undesigned cast preconditions are seeded
 * through the exposed store (seedQwenDesigns / clearQwenDesigns) instead of driving
 * the brittle cast-design UI. See docs/testing/flaky-register.md's rewrite playbook.
 *
 * The three cases (A/B/C) below lock down the "all three sinks converge" fix
 * described in the implementation plan (the former case B — "the enqueued queue
 * entry persists modelKey=1.7B" — was removed graduating #1178: that invariant
 * doesn't exist, and the dispatcher's `e.modelKey ?? ui.ttsModelKey` resolution
 * is covered by queue-dispatcher-middleware.test.ts + queue-generation-
 * integration.test.ts; see the comment where it lived):
 *   A. 1.7B pick → session default + cast pins both flip to 1.7B AND
 *      ttsModelKeyExplicit is true (so settings-hydration can't silently
 *      rewind an in-flight pick).
 *   B. 0.6B pick → every Qwen member's ttsModelKey is null AND
 *      ttsModelKeyExplicit is now true (explicit 0.6B is the new "no
 *      auto-upgrade" signal documented in plan 229; the existing
 *      `resetSelectedModelToDefault` reducer is the recovery path).
 *   C. Guard rail: a freshly-analysed book with NO designed voices → 1.7B
 *      pick surfaces a warn toast and generation does NOT start; 0.6B does
 *      start (baseline behaviour). Picking 0.6B in the still-open modal after
 *      the refused 1.7B also proves the "Start generating" button isn't stuck
 *      in busy=true (Finding 1).
 */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/* Deterministic ready-signal for the "Approve cast & start generating" click.
   The CTA routes through the `startGenerationFlow` thunk, which reads
   `cast.characters` at click time: if the cast slice hasn't hydrated yet
   (`characters` still empty on a cold route mount), `castRendersOnQwen([])`
   is false and the thunk dispatches `requestStartGeneration()` directly —
   NO modal, so the `Choose the voice model` heading never appears and every
   case below fails. The mock cast (ANALYSIS_NORTHERN_STAR → initialCharacters)
   always carries Eliza with `ttsEngine: 'qwen'`, so once the slice has ANY
   character this predicate is satisfiable; poll on it instead of racing the
   implicit cold-load timing. This is the explicit ready signal the
   flaky-register rewrite playbook calls for. */
async function waitForQwenCastHydrated(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const store = (window as unknown as { __store__?: { getState(): unknown } }).__store__;
          if (!store) return false;
          const cast = (store.getState() as { cast: { characters: Array<{ ttsEngine?: string }> } })
            .cast;
          return (cast.characters ?? []).some((c) => c.ttsEngine === 'qwen');
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/* Drive from analysing-ready into the Generate view's StartGen modal. Shared
   by every case so the cold-start flakiness stays in one place. Each
   internal route hop waits for its lazy chunk to mount (waitForRouteReady)
   and the approve click is gated on the cast slice being hydrated
   (waitForQwenCastHydrated) so the modal opens deterministically. */
async function goToStartGenModal(page: Page): Promise<void> {
  await goToConfirm(page);
  await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
  await waitForRouteReady(page);
  await waitForQwenCastHydrated(page);
  await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });
  await waitForRouteReady(page);
}

/* Establish case C's precondition deterministically: an analysed cast with ZERO
   designed Qwen voices. The mock analysis fixture ALWAYS pre-designs Eliza
   (`overrideTtsVoices.qwen.name = 'qwen-eliza'` in src/data/characters.ts), so
   without this the 1.7B guard rail sees an eligible member and starts the run
   instead of warning. Strip every Qwen override (and any matched voiceId) via
   the exposed store so the guard's "no Qwen voice has been designed" branch is
   reachable. `cast/setCharacters` replaces the slice wholesale; the poll
   confirms the precondition landed (and fails loudly if the action type ever
   drifts) before the assertions run. Qwen members stay Qwen members (ttsEngine
   is preserved) — they're just undesigned. */
async function clearQwenDesigns(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (
      window as unknown as { __store__: { getState(): unknown; dispatch(a: unknown): void } }
    ).__store__;
    const chars = (store.getState() as { cast: { characters: unknown[] } }).cast.characters as Array<
      Record<string, unknown>
    >;
    const stripped = chars.map((c) => {
      const next: Record<string, unknown> = { ...c, voiceId: undefined, ttsModelKey: null };
      const otv = next.overrideTtsVoices as Record<string, unknown> | undefined;
      if (otv?.qwen) {
        const copy = { ...otv };
        delete copy.qwen;
        next.overrideTtsVoices = copy;
      }
      return next;
    });
    store.dispatch({ type: 'cast/setCharacters', payload: stripped });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const store = (window as unknown as { __store__: { getState(): unknown } }).__store__;
        const chars = (store.getState() as {
          cast: { characters: Array<{ overrideTtsVoices?: { qwen?: { name?: string } } }> };
        }).cast.characters;
        return chars.some((c) => c.overrideTtsVoices?.qwen?.name);
      }),
    )
    .toBe(false);
}

/* Establish case A's precondition: every Qwen member carries a designed
   voice (`overrideTtsVoices.qwen.name`) so the modal's 1.7B guard rail accepts
   the pick and pins ALL of them. The inverse of clearQwenDesigns, via the same
   store seam — production reaches this state through the cast-view "Design full
   cast" flow, but driving that UI here is brittle (the scope-picker's "bases"
   option disables once the fixture's pre-designed members leave nothing to
   design, and the streaming design has its own timing), and that flow is
   covered by its own spec. Seeding the state directly keeps these cases focused
   on the modal's three-sink sync logic — the actual subject under test. */
async function seedQwenDesigns(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __store__: { getState(): unknown; dispatch(a: unknown): void };
      }
    ).__store__;
    const state = store.getState() as {
      cast: { characters: Array<Record<string, unknown>> };
      ui: { ttsModelKey?: string };
    };
    const runEngine = (state.ui.ttsModelKey ?? '').startsWith('qwen') ? 'qwen' : 'other';
    const designed = state.cast.characters.map((c) => {
      const rendersOnQwen = ((c.ttsEngine as string | undefined) ?? runEngine) === 'qwen';
      if (!rendersOnQwen) return c;
      const otv = { ...((c.overrideTtsVoices as Record<string, unknown>) ?? {}) };
      const qwen = (otv.qwen as { name?: string } | undefined) ?? {};
      otv.qwen = { ...qwen, name: qwen.name || `qwen-${c.id as string}` };
      return { ...c, ttsEngine: 'qwen', overrideTtsVoices: otv };
    });
    store.dispatch({ type: 'cast/setCharacters', payload: designed });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as unknown as { __store__: { getState(): unknown } }
        ).__store__.getState() as {
          cast: { characters: Array<{ ttsEngine?: string; overrideTtsVoices?: { qwen?: { name?: string } } }> };
        };
        const qwen = state.cast.characters.filter((c) => c.ttsEngine === 'qwen');
        return qwen.length > 0 && qwen.every((c) => c.overrideTtsVoices?.qwen?.name);
      }),
    )
    .toBe(true);
}

/* Drive into the Generate view's StartGen modal WITH a fully-designed Qwen cast
   (case A). Open the modal first (post-route-hydration), THEN seed the
   designs so a generate-route re-hydration can't wipe them. */
async function goToStartGenModalWithDesignedCast(page: Page): Promise<void> {
  await goToStartGenModal(page);
  await seedQwenDesigns(page);
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

test('voice-model prompt before a Qwen run: both tiers, 0.6B default, confirm starts (#1160)', async ({
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
     first" guard rail — covered by case C. The production path reaches this
     point with voices already designed via the cast-view "Design full cast"
     button; case A drives that path explicitly.) */
  await page.getByRole('button', { name: 'Start generating', exact: true }).click();
  await expect(heading).toBeHidden({ timeout: 5_000 });
  /* Generation is live once a chapter-row "Generating" pill shows. */
  await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
    timeout: 20_000,
  });
});

test.describe('StartGenerationModal: three-sink sync', () => {
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

  /* (Former case B — "the enqueued queue entry carries modelKey=1.7B" — was
     removed graduating #1178. It asserted a non-existent invariant: a fresh
     start-generation enqueues auto-work entries with NO per-entry modelKey
     (generation-stream-middleware builds {id,bookId,chapterId,scope}); the tier
     is resolved as `e.modelKey ?? ui.ttsModelKey` at stream-open, and the
     entries drain to 0 as chapters complete — a transient window that can't be
     observed reliably in e2e. Its real coverage lives in the lower tiers:
     queue-dispatcher-middleware.test.ts (the `e.modelKey ?? ui.ttsModelKey`
     resolution) + queue-generation-integration.test.ts (requestStartGeneration
     enqueues the viewed book), and case A proves ui.ttsModelKey/cast both flip
     to 1.7B end-to-end. */

  test('B. 0.6B pick clears pins AND flips ttsModelKeyExplicit (the new "no auto-upgrade" signal)', async ({
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

  test('C. Guard rail: 1.7B on an undesigned cast warns + does not start; 0.6B does start', async ({
    page,
  }) => {
    /* The mock analysis fixture pre-designs Eliza on Qwen, so strip every
       Qwen override first to reach the "zero designed Qwen voices" state the
       guard rail should refuse 1.7B on. (Skipping the cast-view design step
       alone is NOT enough — the fixture ships one designed member.) */
    await goToStartGenModal(page);
    const heading = page.getByRole('heading', { name: /Choose the voice model/i });
    await expect(heading).toBeVisible({ timeout: 5_000 });
    await clearQwenDesigns(page);

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
              queue: { entries?: unknown[] };
            };
            return (state.queue?.entries ?? []).length;
          }),
        { timeout: 2_000 },
      )
      .toBe(0);

    /* Finding 1: the refused 1.7B pick must NOT leave the modal stuck in
       busy=true. The guard returns BEFORE the busy setter (layout.tsx), so the
       modal stays open and fully interactive — verify the confirm button is
       still enabled rather than cancelling and re-opening (the generate view's
       start CTA has an analysis-dependent label, so a conditional re-open is
       an unreliable precondition for the 0.6B pick below). */
    await expect(heading).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Start generating', exact: true }),
    ).toBeEnabled();

    /* Switch the pick to 0.6B in the SAME open modal → generation DOES start
       (baseline behaviour for a no-design cast). */
    await page.getByTestId('start-gen-tier-qwen3-tts-0.6b').click();
    await page.getByRole('button', { name: 'Start generating', exact: true }).click();
    await expect(heading).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
