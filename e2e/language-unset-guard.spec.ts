/* Task 9e (#2406) — Playwright e2e for the language-unset affordance and
   the settings-modal guard mode.

   Golden path: a book with `languageSet: false` shows the dashed "Language
   unset" affordance in the library card → clicking it opens the Edit Book
   Meta modal in guard mode (language field EMPTY, guard hint visible, Save
   disabled until a language is chosen) → picking a language and clicking
   Save closes the modal.

   Fixture: Carrick's Compass (`cc`) in MOCK_LIBRARY carries
   `languageSet: false, language: 'en'` — the exact case that must branch
   on `languageSet` (not `language`).

   Mock-mode limitation: `mockGetLibrary` returns the static MOCK_LIBRARY
   const, so the library re-hydrate after save does not reflect the PATCH.
   The spec asserts modal-level behaviour (guard opens, field empty, save
   closes the modal); the badge-after-save assertion belongs to the
   integration gate (#2386) that runs against the real server. */

import { test, expect } from '@playwright/test';

const UNSET_BOOK_ID = 'cc';

test.describe('language-unset guard (Task 9e)', () => {
  test('affordance visible → guard modal opens with empty language → save closes modal', async ({ page }) => {
    /* 1. Navigate to the library. */
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: /Start a new book/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    /* 2. The "Language unset" affordance renders on the cc card. */
    const unsetBtn = page.getByTestId(`library-language-unset-${UNSET_BOOK_ID}`);
    await expect(unsetBtn).toBeVisible({ timeout: 10_000 });

    /* 3. Click it — the settings modal opens in guard mode. */
    await unsetBtn.click();

    /* 4. Guard hint is visible with the '409' shape copy. */
    const guardHint = page.getByTestId('edit-book-language-guard');
    await expect(guardHint).toBeVisible({ timeout: 5_000 });
    await expect(guardHint).toContainText(/choose a language/i);

    /* 5. The language select is present and set to empty (Unset). */
    const langSelect = page.getByTestId('edit-book-language');
    await expect(langSelect).toBeVisible();
    await expect(langSelect).toHaveValue('');

    /* 6. Save is disabled (guard mode requires a language selection). */
    const saveBtn = page.getByRole('button', { name: /Save changes/i });
    await expect(saveBtn).toBeDisabled();

    /* 7. Pick a language — Save becomes enabled. */
    await langSelect.selectOption('fr');
    await expect(saveBtn).toBeEnabled();

    /* 8. Click Save — the modal closes. */
    await saveBtn.click();
    await expect(saveBtn).toBeHidden({ timeout: 5_000 });
  });

  test('badge renders for a book with languageSet: true', async ({ page }) => {
    /* Solway Bay has `languageSet: true, language: 'en'` — the badge
       (not the affordance) must render. */
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: /Start a new book/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    const badge = page.getByTestId('library-language-badge-sb');
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toContainText(/English/i);

    /* The "unset" affordance must NOT be present on this book. */
    const unsetBtn = page.getByTestId('library-language-unset-sb');
    await expect(unsetBtn).toBeHidden();
  });
});
