import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

/**
 * fs-38 Wave 3c GATE 1 — the two owner-decided changes to the profile
 * drawer's "My voices" surface, driven through a real browser because both
 * cross the redux ↔ router ↔ drawer-mount seams that jsdom lies about:
 *
 *  - **[F1] the assign response reports the written slots.** `POST /assign`
 *    always writes the qwen slot but writes coqui only when the entry is
 *    clone-capable there. The drawer used to mirror the ROUTED engine into
 *    redux on any 200, so a designed voice with no coqui artifact showed as
 *    a "My voice" coqui assignment the server never persisted — and the
 *    assign thunk refetches the LIBRARY, not the cast, so nothing reconciled
 *    it. The drawer now mirrors exactly the slots `written` names.
 *
 *  - **[DELTA-I5] the explicit "Remove voice" control.** Nothing else in the
 *    app can take a library voice back off a character: `PUT
 *    /api/voices/:id/override` refuses a clear when a cloned slot is present
 *    and preserves cloned provenance on a set, so an explicit stock-voice
 *    pick over a clone still rendered the clone.
 *
 * Deliberately its own spec file rather than a step inside
 * `voice-library.spec.ts`'s serial golden path: that scenario mutates the
 * shared in-memory `mockVoiceLibraryEntries` array across its steps, and
 * these assertions want a pristine fixture set. A separate file gets its own
 * page, and a fresh page load resets that module state.
 *
 * Fixtures used (`src/mocks/voice-library.ts`):
 *  - `lib-pinned` "Captain Halloran" — DESIGNED, `engines: { qwen }` only,
 *    so the mock reports `written: ['qwen']` (see `_mockAssignWrittenSlots`,
 *    src/lib/api.ts, and its unit tests pinning that every designed fixture
 *    is qwen-only).
 *  - `lib-cloned-demo` "Mum (cloned)" — CLONED with ready qwen AND xtts
 *    slots, so `written: ['qwen', 'coqui']`.
 *
 * Characters (`src/data/characters.ts`, book `ns`): `halloran` and `marcus`
 * both start with no `ttsEngine` and no `overrideTtsVoices`, so each can be
 * switched to Coqui in the drawer's picker without inheriting prior state.
 * The two tests use different characters so neither can contaminate the
 * other even if the page were reused.
 */
test.describe.configure({ mode: 'serial' });

/* The voice-library slice is hydrated by exactly one component —
   `my-voices-section.tsx`'s mount effect on the `#/voices` "My voices" tab
   (the only `fetchVoiceLibrary()` dispatch in `src/`). The cast view and the
   profile drawer both READ `voiceLibrary.entries` and never fetch, so the
   drawer's picker renders empty unless that tab has been visited in this
   page session. `voice-library.spec.ts` gets this for free from its serial
   step order; here it has to be explicit. */
async function warmVoiceLibrary(page: import('@playwright/test').Page) {
  await page.goto('/#/voices');
  await waitForRouteReady(page);
  const myVoicesTab = page.getByRole('button', { name: 'My voices', exact: true });
  /* 30 s for the same cold-chunk reason as the cast-roster budget below. */
  await expect(myVoicesTab).toBeVisible({ timeout: 30_000 });
  await myVoicesTab.click();
  await expect(page.getByTestId('voice-library-card-lib-pinned')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('voice-library-card-lib-cloned-demo')).toBeVisible();
}

async function openCastDrawerOnCoqui(page: import('@playwright/test').Page, characterId: string) {
  await page.goto('/#/books/ns/cast');
  await waitForRouteReady(page);
  /* 40 s, not the 25 s a warm run needs: each test cold-loads the (large)
     CastView chunk after a full page reload, and under sustained local worker
     contention that alone has been observed past 25 s — the same effect
     voice-library.spec.ts documents when it budgets 150 s for three such
     loads. Observed flaking at 25 s during this spec's own bring-up. */
  await expect(page.locator('[data-tour-id="cast-roster"]')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId(`cast-row-${characterId}`)).toBeVisible({ timeout: 20_000 });
  await page.getByTestId(`cast-row-${characterId}`).click();

  const drawer = page.locator('[data-tour-id="profile-drawer"]');
  await expect(drawer).toBeVisible({ timeout: 10_000 });
  await drawer.getByLabel('Voice engine for this character').selectOption('coqui');
  return drawer;
}

test.describe('Voice library — assign reconciliation + Remove voice (GATE 1)', () => {
  test('[F1] a qwen-only assign on a Coqui-routed character does not show a Coqui assignment', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    /* No preliminary `goto('/')`: `warmVoiceLibrary` already does a full page
       load (which is what resets the shared mock voice-library array), and on
       a contended box every extra cold chunk-load is a real flake source. */
    await warmVoiceLibrary(page);

    const drawer = await openCastDrawerOnCoqui(page, 'halloran');

    /* Nothing assigned yet, so the Remove control — which renders off the
       character's slot for the ROUTED engine — must be absent. Asserting
       this first is what makes its continued absence below meaningful
       rather than vacuous. */
    await expect(drawer.getByTestId('profile-drawer-remove-my-voice')).toHaveCount(0);

    const designedPick = drawer.getByTestId('profile-drawer-my-voice-lib-pinned');
    await expect(designedPick).toBeVisible({ timeout: 5_000 });
    await designedPick.click();

    /* The partial result is surfaced, not swallowed: the server wrote qwen
       and declined coqui, and the user asked for coqui. */
    const notice = drawer.getByTestId('profile-drawer-my-voices-error');
    await expect(notice).toBeVisible({ timeout: 5_000 });
    await expect(notice).toContainText('Coqui XTTS v2');

    /* THE regression. Pre-fix the drawer mirrored the routed (coqui) slot on
       any 200, so this control appeared — the visible proof of an assignment
       cast.json never carried. It must stay absent. */
    await expect(drawer.getByTestId('profile-drawer-remove-my-voice')).toHaveCount(0);
  });

  test('[DELTA-I5] Remove voice takes a cloned library voice back off the character', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    /* No preliminary `goto('/')`: `warmVoiceLibrary` already does a full page
       load (which is what resets the shared mock voice-library array), and on
       a contended box every extra cold chunk-load is a real flake source. */
    await warmVoiceLibrary(page);

    const drawer = await openCastDrawerOnCoqui(page, 'marcus');
    await expect(drawer.getByTestId('profile-drawer-remove-my-voice')).toHaveCount(0);

    const clonedPick = drawer.getByTestId('profile-drawer-my-voice-lib-cloned-demo');
    await expect(clonedPick).toBeVisible({ timeout: 5_000 });
    await clonedPick.click();

    /* A cloned entry IS clone-capable on coqui, so the coqui slot is written
       and the assigned-voice line + Remove control appear, naming the entry. */
    const assigned = drawer.getByTestId('profile-drawer-assigned-my-voice');
    await expect(assigned).toBeVisible({ timeout: 5_000 });
    await expect(assigned).toContainText('Mum (cloned)');
    await expect(drawer.getByTestId('profile-drawer-my-voices-error')).toHaveCount(0);

    /* Icon-only control, so it carries the WCAG 2.5.5 target on any touch
       device (`min-h`/`min-w` 44px, dropped only at fine-pointer). Measured
       in the browser because the class-name convention is exactly what a
       jsdom test cannot verify — chromium here is a fine-pointer device, so
       assert the rule exists rather than the rendered box. */
    const removeBtn = drawer.getByTestId('profile-drawer-remove-my-voice');
    await expect(removeBtn).toBeVisible();
    const cls = (await removeBtn.getAttribute('class')) ?? '';
    expect(cls).toContain('min-h-[44px]');
    expect(cls).toContain('min-w-[44px]');
    expect(cls).toContain('fine-pointer:min-h-0');
    expect(cls).toContain('fine-pointer:min-w-0');
    // The superseded phone-only pattern removes the target across the whole
    // tablet range — it must not reappear here.
    expect(cls).not.toContain('sm:min-h-0');
    expect(cls).not.toContain('sm:min-w-0');

    await removeBtn.click();

    // Back to "no voice assigned": the line and the control both go.
    await expect(drawer.getByTestId('profile-drawer-assigned-my-voice')).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(drawer.getByTestId('profile-drawer-my-voices-error')).toHaveCount(0);

    /* And the voice itself survives in My voices — this clears the
       ASSIGNMENT, never the library entry (the picker still offers it). */
    await expect(drawer.getByTestId('profile-drawer-my-voice-lib-cloned-demo')).toBeVisible();
  });
});
