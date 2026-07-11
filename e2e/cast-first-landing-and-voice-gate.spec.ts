/* fe-46 — cast-first landing + pre-flight voice-readiness gate. Covers:
 *
 *  1. Confirm lands on Cast (not Manuscript); "Continue to manuscript"
 *     advances to the manuscript route.
 *  2. English book + undesigned Qwen characters: starting generation opens
 *     the gate (not the tier prompt) listing them; "Proceed anyway" falls
 *     through to the tier modal and generation actually starts.
 *  3. "Design full cast" from the gate opens the cast view and runs the same
 *     bulk design job the cast view's own button would; once every
 *     character is designed, re-triggering start-generation shows no gate.
 *  4. Non-English book: the gate has NO proceed affordance — only Design
 *     full cast + Cancel.
 *
 * The canned cast (src/data/characters.ts) is Kokoro-default with only Eliza
 * pinned + designed on Qwen — seeding the PROJECT onto Qwen (mirrors
 * design-full-cast.spec.ts's persisted-state trick) makes Narrator / Captain
 * Halloran / Marcus the Cook resolve as Qwen-effective and undesigned, which
 * is exactly the fixture the gate needs. Scenario 4's non-English flag is
 * seeded directly on the library slice post-hoc (mirrors
 * start-generation-tier-prompt.spec.ts's direct-dispatch seams) since mock
 * mode has no click-path to mark an already-analysed book non-English. */

import { test, expect, type Page } from '@playwright/test';
import {
  goToConfirm,
  confirmCastAndReachManuscript,
  confirmTierPromptIfPresent,
  waitForRouteReady,
} from './helpers';

test.describe.configure({ mode: 'serial' });

/* Put the PROJECT on Qwen before the app boots (redux-persist rehydrate), so
   Narrator / Halloran / Marcus resolve as "Needs voice" — Eliza already
   carries a designed Qwen base voice and is excluded either way. */
async function seedQwenProject(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const raw = window.localStorage.getItem('persist:ui');
    const blob = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    blob.ttsModelKey = JSON.stringify('qwen3-tts-0.6b');
    blob.ttsModelKeyExplicit = JSON.stringify(true);
    window.localStorage.setItem('persist:ui', JSON.stringify(blob));
  });
}

async function getBookId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = (
      window as unknown as { __store__?: { getState: () => { ui: { stage: { bookId?: string } } } } }
    ).__store__;
    if (!s) throw new Error('window.__store__ is not exposed');
    const bookId = s.getState().ui.stage.bookId;
    if (!bookId) throw new Error('stage has no bookId — expected a ready/confirm stage');
    return bookId;
  });
}

/* `library.books` is empty for a freshly analysed book (never separately
   fetched in this walk), so this dispatch is a pure add — nothing else in
   the cast/manuscript flow reads this book's library entry except
   `selectIsBookNonEnglish` and the `bookLanguage` prop CastView derives from
   it (both fall back to 'en' when the book is absent, so seeding it here
   is the only way to reach the non-English branch in mock mode). */
async function seedNonEnglishBook(page: Page, bookId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = (window as unknown as { __store__: { dispatch(a: unknown): void } }).__store__;
    store.dispatch({
      type: 'library/addBook',
      payload: {
        bookId: id,
        title: 'The Northern Star',
        author: 'Marin Vale',
        series: 'Northern Coast Trilogy',
        isStandalone: false,
        status: 'cast_pending',
        chapterCount: 3,
        completedChapters: 0,
        characterCount: 4,
        voiceCount: 0,
        lastWorkedOn: 'just now',
        coverGradient: ['#2a2520', '#14110f'],
        /* fs-60 — a STILL-UNSUPPORTED non-English language (Coqui isn't in
           eligibleTtsEngines), so there's no fallback engine and the gate
           stays a hard block. A Coqui-eligible language (ru/es/fr/de) would
           now get the soft-gate proceed affordance instead — that path is
           covered by e2e/generation/coqui-fallback-non-english.spec.ts. */
        language: 'zh',
        eligibleTtsEngines: ['qwen'],
      },
    });
  }, bookId);
}

const gateHeading = (page: Page) =>
  page.getByRole('heading', { name: /Some characters still need a voice/i });

test.describe('fe-46 cast-first landing + voice-readiness gate', () => {
  test('confirm lands on Cast; Continue to manuscript advances to Manuscript', async ({ page }) => {
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and design voices/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/cast/, { timeout: 5_000 });
    await waitForRouteReady(page);
    const continueBtn = page.getByRole('button', { name: /Continue to manuscript/i });
    await expect(continueBtn).toBeVisible({ timeout: 10_000 });
    await continueBtn.click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
  });

  test('English + undesigned Qwen cast: gate lists them; Proceed anyway falls through to the tier modal and starts generation', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await seedQwenProject(page);
    await goToConfirm(page);
    await confirmCastAndReachManuscript(page);
    await waitForRouteReady(page);

    await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });

    await expect(gateHeading(page)).toBeVisible({ timeout: 10_000 });
    const list = page.getByTestId('voice-readiness-gate-list');
    await expect(list.getByText('Narrator')).toBeVisible();
    await expect(list.getByText('Captain Halloran')).toBeVisible();
    await expect(list.getByText('Marcus the Cook')).toBeVisible();
    /* Eliza already has a designed Qwen voice — excluded from the list. */
    await expect(list.getByText('Eliza Gray')).toHaveCount(0);

    await page.getByRole('button', { name: /Proceed anyway/i }).click();
    await expect(gateHeading(page)).toBeHidden();
    await confirmTierPromptIfPresent(page);

    /* Generation actually started — a Generating pill renders. */
    await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('Design full cast from the gate runs the design; once fully designed, re-triggering shows no gate', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await seedQwenProject(page);
    await goToConfirm(page);
    await confirmCastAndReachManuscript(page);
    await waitForRouteReady(page);

    await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
    await expect(gateHeading(page)).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('voice-readiness-gate').getByRole('button', { name: 'Design full cast' }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/cast/, { timeout: 5_000 });
    await expect(gateHeading(page)).toBeHidden();

    /* The bulk run the gate kicked off designs the same needs-voice roster
       the cast view's own button would — rows flip to Designed. */
    const designBtn = page.getByTestId('design-full-cast');
    await expect(designBtn).not.toContainText(/\(\d+\)/, { timeout: 15_000 });
    await expect(page.getByText('Designed', { exact: true }).first()).toBeVisible({
      timeout: 5_000,
    });

    /* Belt-and-braces: poll the actual redux state for all three needs-voice
       characters carrying a designed Qwen voice before proceeding — the
       button text and the gate's own selector read the same `cast.characters`
       source, but this removes any doubt about a render lagging one tick
       behind the last design_char SSE event. */
    await expect
      .poll(() =>
        page.evaluate(() => {
          const store = (
            window as unknown as {
              __store__: {
                getState(): {
                  cast: { characters: Array<{ id: string; overrideTtsVoices?: { qwen?: { name?: string } } }> };
                };
              };
            }
          ).__store__;
          const byId = new Map(store.getState().cast.characters.map((c) => [c.id, c]));
          return ['narrator', 'halloran', 'marcus'].every((id) => byId.get(id)?.overrideTtsVoices?.qwen?.name);
        }),
        { timeout: 10_000 },
      )
      .toBe(true);

    /* Re-trigger start-generation — fully designed now, so the tier prompt
       opens directly with no gate. */
    await page.getByRole('button', { name: /Continue to manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
    await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });
    await expect(page.getByRole('heading', { name: /Choose the voice model/i })).toBeVisible({
      timeout: 5_000,
    });
    await expect(gateHeading(page)).not.toBeVisible();
  });

  test('still-unsupported non-English book: gate has no proceed affordance', async ({ page }) => {
    test.setTimeout(60_000);
    await seedQwenProject(page);
    await goToConfirm(page);
    await confirmCastAndReachManuscript(page);
    await waitForRouteReady(page);

    const bookId = await getBookId(page);
    await seedNonEnglishBook(page, bookId);

    await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
    await expect(gateHeading(page)).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText(/can't fall back to a generic voice/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Proceed anyway/i })).toHaveCount(0);

    /* Cancel is still the escape hatch. */
    await page.getByTestId('voice-readiness-gate').getByRole('button', { name: 'Cancel' }).click();
    await expect(gateHeading(page)).toBeHidden();
  });
});
