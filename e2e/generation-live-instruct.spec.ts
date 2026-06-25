/* Browser-level proof of the fs-57 per-book liveInstruct toggle on the
 * Generate view.
 *
 * The toggle is a checkbox that dispatches `bookMetaActions.setLiveInstruct`
 * when clicked; the persistence-middleware watches that action and PUTs
 * `{ slice: 'state', patch: { liveInstruct } }` to the server. This spec:
 *  1. Drives the mock into the Generate view.
 *  2. Asserts the toggle is visible and starts unchecked.
 *  3. Clicks it and reads the Redux store to confirm liveInstruct=true.
 *  4. Clicks again to confirm it flips back to false.
 *
 * Using `__store__` (the DEV/e2e gate in main.tsx) to inspect Redux state is
 * the same pattern the existing generation-resume.spec.ts and
 * generation-stuck-queued.spec.ts use. */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm } from './helpers';

test.describe.configure({ mode: 'serial' });

async function liveInstructFromStore(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __store__?: {
          getState: () => { bookMeta: { liveInstruct: Record<string, boolean> } };
        };
      }
    ).__store__;
    if (!s) throw new Error('window.__store__ is not exposed (main.tsx DEV/e2e gate regressed)');
    /* liveInstruct is a per-book map (the real selector reads liveInstruct[bookId]);
       read the flag for the book currently in the URL, not the whole map object. */
    const map = s.getState().bookMeta.liveInstruct ?? {};
    const bookId = window.location.hash.match(/#\/books\/([^/]+)/)?.[1];
    return bookId ? (map[bookId] ?? false) : false;
  });
}

test.describe('liveInstruct toggle (fs-57)', () => {
  test('toggle starts off, flips on, then off again on the Generate view', async ({ page }) => {
    test.setTimeout(60_000);

    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });

    await page.getByRole('button', { name: /^Generate$/ }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });

    /* Toggle is rendered but GREYED OUT (disabled) — the default mock cast has
       no Qwen 1.7B member, so flipping it would be a no-op (#1100). */
    const toggle = page.getByTestId('live-instruct-toggle');
    await expect(toggle).toBeVisible({ timeout: 5_000 });

    const checkbox = toggle.locator('input[type="checkbox"]');
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeDisabled();

    /* Store confirms liveInstruct starts false */
    expect(await liveInstructFromStore(page)).toBe(false);

    /* Promote the first cast member to the 1.7B Quality tier so the toggle
       becomes active (the view's `characters` prop reads s.cast.characters). */
    await page.evaluate(() => {
      const s = (
        window as unknown as {
          __store__?: {
            getState: () => { cast: { characters: Array<{ id: string }> } };
            dispatch: (a: unknown) => void;
          };
        }
      ).__store__;
      if (!s) throw new Error('window.__store__ is not exposed');
      const chars = s.getState().cast.characters;
      if (!chars.length) throw new Error('no cast characters to promote to 1.7B');
      s.dispatch({
        type: 'cast/updateCharacter',
        payload: { ...chars[0], ttsModelKey: 'qwen3-tts-1.7b' },
      });
    });
    await expect(checkbox).toBeEnabled();

    /* Click to enable */
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    expect(await liveInstructFromStore(page)).toBe(true);

    /* Click to disable */
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    expect(await liveInstructFromStore(page)).toBe(false);
  });
});
