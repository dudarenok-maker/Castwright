/* Wave 1 — narrator credit defaults to "Castwright" when the book has
   no explicit narratorCredit field.

   listen.tsx computes:
     narratorName = (bookMeta?.narratorCredit && trim) || DEFAULT_NARRATOR_CREDIT
   where DEFAULT_NARRATOR_CREDIT = 'Castwright' (book-meta-slice.ts).
   listen-header.tsx renders: "· narrated by <span>{narratorName}</span>"
   inside the <p> below the book title.

   The Solway Bay mock (id 'sb') returns narratorCredit: null from the
   mock API, so the default branch fires and the header should show
   "narrated by Castwright".

   The locator scopes to the header's <p> credit line so the top-bar
   "Castwright" wordmark does NOT match (it has no "narrated by" prefix). */

import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

test('listen header shows "narrated by Castwright" when no explicit narrator credit is set', async ({
  page,
}) => {
  await page.goto('/#/books/sb/listen');
  await waitForListenViewReady(page, /Solway Bay/i);

  /* The credit line is the <p> immediately below the <h1> title; it
     contains "By <author> · narrated by <narratorName>". We assert on
     the "narrated by Castwright" substring so the test survives author-
     text changes while pinning the narrator-credit branch. Scoping to
     an <p> ancestor avoids any wordmark hit. */
  const creditLine = page.locator('p', { hasText: /narrated by/i }).first();
  await expect(creditLine).toBeVisible({ timeout: 10_000 });
  await expect(creditLine).toContainText('narrated by Castwright');
});
