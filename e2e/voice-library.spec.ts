import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

/**
 * fs-38 Wave 1, Task 17 — Voice library golden path (create / assign /
 * cross-book reuse / promote).
 *
 * One long, serial scenario rather than several independent tests: every
 * step consumes state the previous step created in the shared in-memory
 * mock voice-library array (`mockVoiceLibraryEntries` in src/lib/api.ts),
 * which is NOT reset between hash navigations within a page session (only
 * a fresh `page.goto('/')` full load resets it) but WOULD be reset by
 * Playwright's normal per-test page isolation if this were split into
 * multiple `test()` blocks. `test.describe.configure({ mode: 'serial' })`
 * is kept regardless, per the project convention for specs sharing this
 * mock array, so a future split stays safe.
 *
 * Route map used below:
 *   - `#/voices` (global) → the three-segment nav (My voices | In use |
 *     Catalogue). "My voices" defaults CLOSED (the view mounts on "In
 *     use") — src/views/voices.tsx `section` state.
 *   - `#/books/ns/cast` (Northern Star — narrator/halloran/eliza/marcus,
 *     `src/data/characters.ts`) and `#/books/cc/cast` (Carrick's Compass —
 *     eliza_cc/greene, `buildCarricksCompassMockState`) are the two "mock
 *     books" for the assign + cross-book-reuse steps.
 *
 * Assign-affordance note: `VoiceLibraryPanel`'s own "My voices" tap-to-
 * assign group (the cast-view sidebar) dispatches `assignVoice` but has NO
 * local reducer wired to reflect the result back into the cast table or
 * any `VoiceProvenanceBadge` — under mocks nothing observable changes on
 * that path. `profile-drawer.tsx`'s "Or use a voice from My voices" picker
 * DOES thread through: on success it dispatches
 * `castActions.setQwenOverrideName`, which flips `qwenSampleBlocked` false
 * and enables the "Play 12s sample" button. That's the assign path this
 * spec drives, and the button's enabled/disabled state (plus the "Design a
 * Qwen voice below before sampling." hint disappearing) is what stands in
 * for "the cast row reflects the assignment" — the literal
 * `VoiceProvenanceBadge` "My voice" pill is only wired into the
 * `views/voices.tsx` In-use "Designed voices" card footer, and none of the
 * seeded Qwen-designed library voices (`v_bramble`/`v_thistle`/`v_wren`/
 * `v_finch` in `src/mocks/voices.ts`) resolve to a character in the seeded
 * casts, so that particular badge isn't reachable through any UI path
 * under the current mock fixtures.
 *
 * Step 5 ("an In-use Designed card shows Save to my voices") is driven
 * from `profile-drawer.tsx`'s own "Save to my voices" button instead of
 * `views/voices.tsx`'s In-use "Designed voices" card footer, for the same
 * reason — Eliza Gray (book `ns`) already carries a live designed Qwen
 * voice (`overrideTtsVoices.qwen.name: 'qwen-eliza'`) that resolves
 * against the real redux cast, where the `views/voices.tsx` footer's
 * candidates don't.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Voice library — create / assign / cross-book reuse / promote', () => {
  test('golden path', async ({ page }) => {
    /* 150 s — this scenario cold-loads the (large) CastView chunk up to three
       times (steps 3/4/5), and under sustained local worker contention that
       cold load alone can run 15-20+ s each (see the per-navigation comments
       below). 90 s left too little headroom for more than one of those to
       land on the slow side in the same run. */
    test.setTimeout(150_000);

    await page.goto('/');
    await waitForRouteReady(page);
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    /* ── Step 1: #/voices → "My voices" renders first with the fixtures ── */
    await page.goto('/#/voices');
    /* waitForRouteReady is a best-effort early gate, not a full substitute
       for budget: DelayedSpinner's fallback only attaches 150 ms after
       navigation (src/components/delayed-spinner.tsx), so calling
       waitForRouteReady immediately after a bare goto() can observe "not
       attached" and return instantly on both a genuinely-warm chunk AND a
       cold one still inside that 150 ms window — it can't fully replace a
       generous timeout on the content assertion that follows. Keep both:
       the route-ready wait catches the common cold-chunk case, and the 20 s
       budget below (same as the original, pre-stabilization value) absorbs
       the residual race. */
    await waitForRouteReady(page);
    const myVoicesTab = page.getByRole('button', { name: 'My voices', exact: true });
    await expect(myVoicesTab).toBeVisible({ timeout: 20_000 });
    await myVoicesTab.click();

    /* Six voice-library fixtures (src/mocks/voice-library.ts): the four
       original entries, the fs-38 Wave 3a cloned demo (renders in My voices
       with a Revoke action), and the Wave 3b2 revoked cloned fixture
       (renders with the "Needs attention" Broken chip). */
    await expect(page.getByTestId('voice-library-card-lib-pinned')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('voice-library-card-lib-promoted')).toBeVisible();
    await expect(page.getByTestId('voice-library-card-lib-stale')).toBeVisible();
    await expect(page.getByTestId('voice-library-card-lib-used')).toBeVisible();
    await expect(page.getByTestId('voice-library-card-lib-cloned-demo')).toBeVisible();
    await expect(page.getByTestId('voice-library-card-lib-cloned-revoked')).toBeVisible();
    await expect(page.locator('[data-testid^="voice-library-card-"]')).toHaveCount(6);

    /* ── Step 2: Create voice → persona → design (mock ~300 ms) → save →
       the new card appears in the Designed group ── */
    await page.getByTestId('my-voices-create-cta').first().click();
    const createModal = page.getByTestId('create-library-voice-modal');
    await expect(createModal).toBeVisible();
    await page.getByTestId('create-library-voice-name').fill('E2E Harbor Pilot');
    await page
      .getByTestId('create-library-voice-persona')
      .fill('A calm harbor pilot, tenor, steady under pressure.');
    await page.getByTestId('create-library-voice-design').click();
    await expect(page.getByTestId('create-library-voice-audition')).toBeVisible({
      timeout: 5_000,
    });
    const saveBtn = page.getByTestId('create-library-voice-save');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(createModal).toBeHidden();

    await expect(page.getByText('E2E Harbor Pilot', { exact: true })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator('[data-testid^="voice-library-card-"]')).toHaveCount(7);

    /* ── Step 3: assign a My-voices fixture to a character in book `ns` —
       Marcus the Cook starts with no Qwen voice designed. ── */
    await page.goto('/#/books/ns/cast');
    /* Same best-effort-plus-budget approach as the #/voices navigation
       above: waitForRouteReady catches the common cold-chunk case, then
       the cast-roster container (src/views/cast.tsx `[data-tour-id="cast-
       roster"]`) is a stable precondition beyond route-ready — it mounts
       unconditionally with the view (no data-hydration gate), so waiting
       on it first isolates "the route chunk mounted" from "the cast rows
       hydrated" before asserting on the individual row. */
    await waitForRouteReady(page);
    await expect(page.locator('[data-tour-id="cast-roster"]')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('cast-row-marcus')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('cast-row-marcus').click();

    const marcusDrawer = page.locator('[data-tour-id="profile-drawer"]');
    await expect(marcusDrawer).toBeVisible({ timeout: 10_000 });
    const marcusEngineSelect = marcusDrawer.getByLabel('Voice engine for this character');
    await expect(marcusEngineSelect).toBeVisible();
    await marcusEngineSelect.selectOption('qwen');

    const marcusPlayBtn = marcusDrawer.getByRole('button', { name: /Play 12s sample/i });
    await expect(marcusPlayBtn).toBeDisabled();
    await expect(
      marcusDrawer.getByText('Design a Qwen voice below before sampling.'),
    ).toBeVisible();

    await expect(marcusDrawer.getByText('Or use a voice from My voices')).toBeVisible({
      timeout: 5_000,
    });
    const marcusUseLibStale = marcusDrawer.getByTestId('profile-drawer-my-voice-lib-stale');
    await expect(marcusUseLibStale).toBeVisible();
    await marcusUseLibStale.click();

    /* Assign resolved: the sample gate clears and the button enables — the
       observable stand-in for "the cast row now reflects the My-voices
       assignment" (see the file-level doc comment above). */
    await expect(marcusPlayBtn).toBeEnabled({ timeout: 5_000 });
    await expect(
      marcusDrawer.getByText('Design a Qwen voice below before sampling.'),
    ).toBeHidden();
    await expect(marcusDrawer.getByTestId('profile-drawer-my-voices-error')).toHaveCount(0);

    /* ── Step 4: a SECOND mock book — the same voice is assignable there
       too (cross-book reuse). Carrick's Compass / First Mate Greene, also
       starting with no Qwen voice designed. ── */
    await page.goto('/#/books/cc/cast');
    /* Same gate as the `ns` cast navigation above. */
    await waitForRouteReady(page);
    await expect(page.locator('[data-tour-id="cast-roster"]')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('cast-row-greene')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('cast-row-greene').click();

    const greeneDrawer = page.locator('[data-tour-id="profile-drawer"]');
    await expect(greeneDrawer).toBeVisible({ timeout: 10_000 });
    const greeneEngineSelect = greeneDrawer.getByLabel('Voice engine for this character');
    await expect(greeneEngineSelect).toBeVisible();
    await greeneEngineSelect.selectOption('qwen');

    const greenePlayBtn = greeneDrawer.getByRole('button', { name: /Play 12s sample/i });
    await expect(greenePlayBtn).toBeDisabled();

    /* The exact same voiceUuid ('lib-stale') that was just used on `ns` is
       offered again here — the library is book-independent. */
    const greeneUseLibStale = greeneDrawer.getByTestId('profile-drawer-my-voice-lib-stale');
    await expect(greeneUseLibStale).toBeVisible({ timeout: 5_000 });
    await greeneUseLibStale.click();

    await expect(greenePlayBtn).toBeEnabled({ timeout: 5_000 });
    await expect(greeneDrawer.getByTestId('profile-drawer-my-voices-error')).toHaveCount(0);

    /* ── Step 5: an in-use Designed voice shows "Save to my voices";
       clicking it adds a library entry. Eliza Gray (book `ns`) already
       carries a live designed Qwen voice, so the button renders without
       any engine-switch step. ── */
    await page.goto('/#/books/ns/cast');
    await waitForRouteReady(page);
    await expect(page.locator('[data-tour-id="cast-roster"]')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('cast-row-eliza')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('cast-row-eliza').click();

    const elizaDrawer = page.locator('[data-tour-id="profile-drawer"]');
    await expect(elizaDrawer).toBeVisible({ timeout: 10_000 });
    const saveToMyVoicesBtn = elizaDrawer.getByTestId('profile-drawer-save-to-my-voices');
    await expect(saveToMyVoicesBtn).toBeVisible({ timeout: 5_000 });
    await saveToMyVoicesBtn.click();
    await expect(saveToMyVoicesBtn).toHaveText('Save to my voices', { timeout: 5_000 });
    await expect(elizaDrawer.getByTestId('profile-drawer-my-voices-error')).toHaveCount(0);

    /* An eighth library entry now exists (6 fixtures — incl. the Wave 3a
       cloned demo and the Wave 3b2 revoked-clone fixture — + Step 2's "E2E
       Harbor Pilot" + this promoted "Eliza Gray"; + Step 6's cloned entry
       below brings the running total to 9). */
    await page.goto('/#/voices');
    await waitForRouteReady(page);
    const myVoicesTabAgain = page.getByRole('button', { name: 'My voices', exact: true });
    await expect(myVoicesTabAgain).toBeVisible({ timeout: 10_000 });
    await myVoicesTabAgain.click();
    await expect(page.getByText('E2E Harbor Pilot', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid^="voice-library-card-"]')).toHaveCount(8);
    await expect(page.getByText('Eliza Gray', { exact: true }).last()).toBeVisible();

    /* ── Step 6: clone a voice from the new CTA → wizard → Save → a ready
       cloned card appears in My voices (8 → 9), then assign it to a
       character. The mock cloneVoiceSample returns a candidate and the mock
       cloneVoice mints a ready `provenance:'cloned'` entry, so the assign
       step below isn't semantically broken. ── */
    await page.getByTestId('my-voices-clone-cta').first().click();
    await expect(page.getByTestId('clone-voice-wizard')).toBeVisible();

    // Phase 1: upload a tiny fake clip + fill consent (CloneCapturePanel controls).
    await page.getByLabel('Upload audio').setInputFiles({
      name: 'sample.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from('RIFFfake-wav-bytes-for-mock-ingest'),
    });
    await page.getByLabel('person name').fill('Mum');
    await page.getByLabel('relationship').selectOption('family-with-permission');
    await page.getByLabel('I attest').check();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Phase 2: name + Save.
    await page.getByTestId('clone-voice-wizard-name').fill('E2E Mum');
    await page.getByTestId('clone-voice-wizard-save').click();
    await expect(page.getByTestId('clone-voice-wizard-done')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('clone-voice-wizard-done').click();

    await expect(page.getByText('E2E Mum', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid^="voice-library-card-"]')).toHaveCount(9);

    // Capture the newly-minted cloned uuid from its card testid for the assign step.
    const cloneCardTestId = await page
      .locator('[data-testid^="voice-library-card-lib-clone-"]')
      .first()
      .getAttribute('data-testid');
    const cloneUuid = cloneCardTestId!.replace('voice-library-card-', '');

    /* Assign the cloned voice to a character via the profile-drawer My-voices
       picker (the generic, provenance-agnostic path — no cloned-specific
       wiring needed). Marcus (book `ns`) already carries lib-stale from Step 3,
       but the picker offers every ready library voice including this clone. */
    await page.goto('/#/books/ns/cast');
    await waitForRouteReady(page);
    await expect(page.locator('[data-tour-id="cast-roster"]')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('cast-row-marcus')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('cast-row-marcus').click();

    const clonedDrawer = page.locator('[data-tour-id="profile-drawer"]');
    await expect(clonedDrawer).toBeVisible({ timeout: 10_000 });
    await clonedDrawer.getByLabel('Voice engine for this character').selectOption('qwen');
    const clonedPick = clonedDrawer.getByTestId(`profile-drawer-my-voice-${cloneUuid}`);
    await expect(clonedPick).toBeVisible({ timeout: 5_000 });
    await clonedPick.click();
    const clonedPlayBtn = clonedDrawer.getByRole('button', { name: /Play 12s sample/i });
    await expect(clonedPlayBtn).toBeEnabled({ timeout: 5_000 });
    await expect(clonedDrawer.getByTestId('profile-drawer-my-voices-error')).toHaveCount(0);
  });
});
