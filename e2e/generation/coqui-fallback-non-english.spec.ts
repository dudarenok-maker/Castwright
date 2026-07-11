/* fs-60 — Russian book Coqui-fallback eligibility surfaces in the UI.
 *
 * Task 11's brief asked for a spec asserting that an undesigned Qwen
 * character on a Russian book renders via a Coqui fallback (mirroring the
 * existing English "Fallback (Kokoro)" status-pill assertion). That render-
 * time fact — `renderedFallbackEngine: 'coqui'` — is stamped exclusively by
 * the SERVER's `applyQwenFallback` (server/src/tts/synthesise-chapter.ts),
 * which mock-mode generation never calls: the frontend's mock generation
 * stream (src/store/generation-stream-runner.ts) just plays back canned
 * `chapter_progress`/`chapter_complete` events — it has no model of per-
 * character engine routing, so it can never produce a `renderedFallbackEngine`
 * value without fabricating new mock-generation internals (out of scope here;
 * that render-time contract is already pinned server-side by
 * `server/src/tts/synthesise-chapter-coqui-fallback.test.ts` and the
 * "Fallback (Coqui)" pill itself is unit-pinned by
 * `src/lib/voice-status.test.ts`).
 *
 * What mock mode CAN exercise deterministically, end-to-end, is the pair of
 * UI seams this plan actually wires ahead of a real render:
 *
 *   (a) Task 9 — a Coqui-eligible non-English book (ru) unlocks the
 *       profile-drawer's per-character engine picker to Qwen + Coqui,
 *       instead of hard-locking to Qwen.
 *   (b) Task 10 — the pre-flight voice-readiness gate offers a
 *       "Proceed anyway" escape hatch naming Coqui (not the still-
 *       unsupported-language hard block) for that same book.
 *
 * Both cross the router/redux/layout seams the e2e bar exists for, and both
 * are fully deterministic in mock mode. `library.books` is never populated
 * for a freshly analysed book in mock mode (nothing re-fetches it on this
 * walk), so — mirroring `e2e/cast-first-landing-and-voice-gate.spec.ts`'s
 * own `seedNonEnglishBook` helper — this spec seeds the active book's
 * library entry directly via a redux dispatch once the real bookId is known,
 * carrying `eligibleTtsEngines: ['qwen', 'coqui']` (the shape Task 3/4 wire
 * server-side for a real ru book) rather than inventing any new mock
 * generation internals.
 *
 * The manuscript itself is the canonical Russian fixture
 * (`server/src/__fixtures__/the-coalfall-commission.ru.md`, per CLAUDE.md's
 * fixture-citation guidance) pasted through the same "Paste text" flow
 * `e2e/language-detection.spec.ts` uses — mock `importManuscript`'s
 * Cyrillic-ratio heuristic (src/lib/api.ts) auto-detects it as Russian, so
 * the confirm route's language selector is exercised for real rather than
 * asserted by fiat.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { confirmTierPromptIfPresent, waitForRouteReady } from '../helpers';

const here = dirname(fileURLToPath(import.meta.url));
const ruFixturePath = resolve(here, '../../server/src/__fixtures__/the-coalfall-commission.ru.md');
const ruFixtureText = readFileSync(ruFixturePath, 'utf8');

/* Mirrors cast-first-landing-and-voice-gate.spec.ts's seedQwenProject: pins
   the PROJECT onto Qwen before boot (via the redux-persist blob read on
   rehydrate) so Narrator / Captain Halloran / Marcus the Cook — the canned
   cast in src/data/characters.ts — resolve as Qwen-effective + undesigned.
   Eliza already carries a designed Qwen base voice and stays excluded
   either way. */
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

/* fs-60 — mirrors cast-first-landing-and-voice-gate.spec.ts's
   seedNonEnglishBook, but adds `eligibleTtsEngines: ['qwen', 'coqui']`
   (Task 3/4's server-computed field for a Coqui-eligible non-English book)
   instead of leaving it unset — the exact fixture shape
   src/modals/profile-drawer.test.tsx's Task 9 unit tests use. */
async function seedRuCoquiEligibleBook(page: Page, bookId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = (window as unknown as { __store__: { dispatch(a: unknown): void } }).__store__;
    store.dispatch({
      type: 'library/addBook',
      payload: {
        bookId: id,
        title: 'Дело о Коалфолле',
        author: 'Castwright',
        series: null,
        isStandalone: true,
        status: 'cast_pending',
        chapterCount: 1,
        completedChapters: 0,
        characterCount: 4,
        voiceCount: 0,
        lastWorkedOn: 'just now',
        coverGradient: ['#2a2520', '#14110f'],
        language: 'ru',
        eligibleTtsEngines: ['qwen', 'coqui'],
      },
    });
  }, bookId);
}

/* Boot fresh, paste the canonical Russian fixture, run it through the mock
   Cyrillic-ratio language heuristic, confirm the auto-detected language is
   Russian, click through to the cast view, then seed the Coqui-eligible
   library entry both downstream tests need. Returns the active book's id
   (unused by callers today, but kept for parity with the source pattern). */
async function importRuFixtureAndReachCast(page: Page): Promise<string> {
  await seedQwenProject(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
    timeout: 10_000,
  });
  await page
    .getByRole('button', { name: /Start a new book/i })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/new$/);

  await page.getByRole('button', { name: /Paste text/i }).click();
  await page.locator('textarea').fill(ruFixtureText);
  await page.getByRole('button', { name: /Upload pasted text/i }).click();
  await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
    timeout: 5_000,
  });

  /* The pasted manuscript is genuinely Cyrillic — the mock heuristic
     (src/lib/api.ts's Cyrillic-ratio check) auto-detects Russian for real,
     on the confirm-METADATA view, right after upload and before analysis
     even starts — not by test fiat. */
  const language = page.getByTestId('confirm-language');
  await expect(language).toHaveValue('ru');

  await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('Castwright');
  await page.getByRole('button', { name: /Save book and start analysis/i }).click();

  await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
  await waitForRouteReady(page);
  await expect(page.getByRole('button', { name: /Start analysis/i })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: /Start analysis/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/confirm$/, { timeout: 15_000 });
  await waitForRouteReady(page);

  await expect(
    page.getByRole('button', { name: /Confirm cast and design voices/i }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Confirm cast and design voices/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/cast/, { timeout: 5_000 });
  await waitForRouteReady(page);

  const bookId = await getBookId(page);
  await seedRuCoquiEligibleBook(page, bookId);
  return bookId;
}

test.describe('fs-60 — Russian book Coqui-fallback eligibility', () => {
  test('undesigned narrator unlocks Qwen + Coqui in the profile-drawer engine picker', async ({
    page,
  }) => {
    await importRuFixtureAndReachCast(page);

    await page.getByTestId('cast-row-narrator').click();
    const engineSelect = page.getByLabel('Voice engine for this character');
    await expect(engineSelect).toBeVisible({ timeout: 10_000 });

    /* fs-60 Task 9 — a Coqui-eligible non-English book unlocks the picker
       (no hard Qwen lock) and offers Coqui XTTS as a selectable engine,
       mirroring profile-drawer.test.tsx's "unlocks the engine picker to
       Qwen + Coqui for a Coqui-eligible non-English book (ru)" case. */
    await expect(page.getByTestId('qwen-locked-note')).toHaveCount(0);
    await expect(engineSelect.locator('option', { hasText: 'Coqui XTTS' })).toHaveCount(1);
    await expect(engineSelect.locator('option', { hasText: 'Qwen (bespoke)' })).toHaveCount(1);
  });

  test('undesigned cast surfaces a Coqui proceed-anyway affordance in the readiness gate', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await importRuFixtureAndReachCast(page);

    await page.getByRole('button', { name: /Continue to manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });

    await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });

    const gateHeading = page.getByRole('heading', { name: /Some characters still need a voice/i });
    await expect(gateHeading).toBeVisible({ timeout: 10_000 });
    const list = page.getByTestId('voice-readiness-gate-list');
    await expect(list.getByText('Narrator')).toBeVisible();
    await expect(list.getByText('Captain Halloran')).toBeVisible();
    await expect(list.getByText('Marcus the Cook')).toBeVisible();

    /* fs-60 Task 10 — a Coqui-eligible non-English book gets the SOFT gate
       (a "Proceed anyway" escape hatch naming the real fallback engine),
       not the still-unsupported-language hard block (no proceed button at
       all). This is the exact regression this plan's server-side changes
       fix: before Tasks 1-10, this ru book had no fallback engine wired at
       all and the gate would have shown the hard-block copy with no
       "Proceed anyway" button. */
    const proceedBtn = page.getByRole('button', { name: /Proceed anyway/i });
    await expect(proceedBtn).toBeVisible();
    await expect(proceedBtn).toHaveText(/generic Coqui fallback voices/i);

    await proceedBtn.click();
    await expect(gateHeading).toBeHidden();
    await confirmTierPromptIfPresent(page);

    /* Generation actually started — the eligibility soft-gate didn't block
       it. A real (non-mock) render of this book would resolve Narrator /
       Halloran / Marcus's missing designed voices through the server's
       Coqui fallback (server/src/tts/synthesise-chapter.ts's
       applyQwenFallback), surfacing the "Fallback (Coqui)" status pill
       (src/lib/voice-status.ts) once complete — pinned server-side by
       synthesise-chapter-coqui-fallback.test.ts and unit-pinned by
       voice-status.test.ts; not reproducible in mock mode (see header). */
    await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
