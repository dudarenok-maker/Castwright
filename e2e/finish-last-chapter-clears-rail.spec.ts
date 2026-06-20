/* Task 5 (fs-15 / #952) — finishing the FINAL listenable chapter auto-removes
 * the book from the Continue-listening rail.
 *
 * Task 4 wired `onCrossedFinish` in layout.tsx: when the currently-playing
 * chapter IS the last listenable chapter (derived from the chapters slice),
 * the mini-player fires `onCrossedFinish` on `ended` (or when the playhead
 * enters the last 10 s). layout.tsx responds by dispatching
 * `continueListeningActions.dismiss(bookId)` and POSTing
 * `api.setShelfStatus(bookId, { finished: true })`.
 *
 * This spec proves that path end-to-end in the browser:
 *   1. Seed the Continue-listening rail with Solway Bay (bookId: 'sb').
 *   2. Open the library — confirm the card is visible.
 *   3. Navigate to the listen view, chapter 18 of 'sb' (the final listenable).
 *   4. Start playback so the MiniPlayer mounts with chapter 18 loaded.
 *   5. Dispatch `ended` on the <audio> element — triggers onCrossedFinish.
 *   6. Navigate back to the library — the card is GONE (rail hidden).
 *
 * Assertion type: OPTIMISTIC DISMISS.
 *   The mock `getContinueListening` returns `__SEED_CONTINUE__` at boot-time.
 *   When the library mounts again after the listen session, it calls
 *   `getContinueListening()` which by that time returns [] (mockSetShelfStatus
 *   pruned __SEED_CONTINUE__). Either path removes the card: the Redux
 *   `dismiss` removes it from the in-memory slice immediately (the optimistic
 *   path), and the pruned seed means any re-hydrate also sees no item.
 *   We assert the DOM outcome — the rail heading is absent — which is the
 *   observable user-facing change that proves Task 4's logic fired.
 *
 * The test is NOT trivially green: on main (before Task 4), the mini-player
 * does not have onCrossedFinish, so dispatching `ended` on chapter 18 would
 * NOT dismiss the card and the rail heading would still be visible on return.
 *
 * Pairs with docs/features/archive/37-e2e-playwright.md.
 * Refs #952.
 */

import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

/* Serial: this spec drives the mini-player audio element, which conflicts with
   other audio-element specs under parallel-worker contention on Windows.
   Pattern mirrors player-continuity.spec.ts + listen-playback.spec.ts. */
test.describe.configure({ mode: 'serial' });

/* Generous timeout: cold Vite transform on first visit pays once per worker;
   the warmup project is skipped when running this spec in isolation. */
test.describe.configure({ timeout: 90_000 });

/** Solway Bay (bookId: 'sb') seed for the Continue-listening rail.
 *  Chapter 3 is a typical mid-book resume position — the test later
 *  manually navigates to chapter 18 (the final chapter). */
const CONTINUE_SEED = [
  {
    bookId: 'sb',
    title: 'Solway Bay',
    chapterId: 3,
    currentSec: 240,
    remainingSec: 4200,
    completionPct: 0.22,
    updatedAt: '2026-06-13T10:00:00Z',
  },
];

test.describe('Task 4 / fs-15 — finishing last chapter auto-clears Continue-listening rail', () => {
  test('card disappears from the rail after the final chapter ends', async ({ page }) => {
    /* 1. Seed __SEED_CONTINUE__ before the app boots so the mock
          getContinueListening() returns the Solway Bay entry on first call. */
    await page.addInitScript((seed) => {
      (window as unknown as { __SEED_CONTINUE__: unknown }).__SEED_CONTINUE__ = seed;
    }, CONTINUE_SEED);

    /* 2. Open the library and confirm the Continue-listening card is present
          before we start — rules out a race where the seed never arrived. */
    await page.goto('/');
    const card = page.getByRole('button', { name: /Continue listening to Solway Bay/i });
    await card.waitFor({ state: 'visible', timeout: 25_000 });
    await expect(page.getByRole('heading', { name: /Continue listening/i })).toBeVisible();

    /* 3. Navigate to Solway Bay's listen view, landing on chapter 18 ("Light
          Returning") — the final chapter (18 of 18, all chapters state=done).
          The URL grammar for a non-default chapter is ?chapter=18.
          See src/lib/router.ts stageToHash — the default chapter is 3. */
    await page.goto('/#/books/sb/listen?chapter=18');
    await waitForListenViewReady(page, /Solway Bay/i);

    /* 4. Chapter 18's row must exist and be playable before we click.
          The listen view lists all listenable chapters; chapter 18 is the last. */
    const chapter18Row = page.getByTestId('chapter-row-18');
    await expect(chapter18Row).toBeVisible({ timeout: 5_000 });

    /* Click Play on chapter 18 specifically so the MiniPlayer loads that
       chapter as the current track. Using the row's accessible button
       (same pattern as listen-playback.spec.ts "Play chapter 2"). */
    await chapter18Row.getByRole('button', { name: /Play chapter 18/i }).click();

    /* 5. Wait for the MiniPlayer's <audio> element to mount and start playing
          (its URL landing effect sets src + calls play()). */
    const audio = page.locator('audio');
    await expect(audio).toHaveCount(1, { timeout: 5_000 });
    await expect(audio).toHaveJSProperty('paused', false, { timeout: 5_000 });

    /* Dispatch the `ended` event on the live <audio> element. This is the
       same mechanism player-continuity.spec.ts and mini-player-features.spec.ts
       use for sleep-timer / auto-advance e2e coverage. The mini-player's
       onEnded handler will:
         - call onCrossedFinish() (Task 4 path: chapter 18 === finalListenable)
           → layout.tsx dispatches continueListeningActions.dismiss('sb')
           → layout.tsx calls api.setShelfStatus('sb', { finished: true })
             which prunes 'sb' from __SEED_CONTINUE__
         - set playing=false (nextAvailable=false, no next chapter) */
    await audio.evaluate((el: HTMLAudioElement) => {
      el.dispatchEvent(new Event('ended'));
    });

    /* 6. Return to the library WITHOUT a full page reload. A page.goto('/')
          would re-run addInitScript (which re-seeds __SEED_CONTINUE__) and
          reset the Redux store, defeating the test. Changing the hash in-page
          triggers a React Router hash-change that unmounts the listen view
          and mounts the library view, preserving all Redux state (including
          the dismiss we just dispatched). The library mount-effect calls
          getContinueListening() again; the dismissedIds guard in the
          continueListening slice filters the card out even if the server
          response still contains it (until mockSetShelfStatus's 15ms async
          prune resolves — but 'sb' stays in dismissedIds as long as it
          appears in the server response, per the self-terminating-dismiss
          guard in the hydrate reducer). */
    await page.evaluate(() => {
      window.location.hash = '/';
    });

    /* Wait for the library view to hydrate — the canonical signal is the
       "Start a new book" CTA becoming visible (same pattern as in
       listening-stats.spec.ts and the helpers.ts waitForLibraryViewReady). */
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 25_000,
    });

    /* The Solway Bay card must no longer be in the DOM. The rail section
       unmounts entirely when its items array is empty (ContinueListeningRail
       returns null for items.length===0), so both the card AND the heading
       disappear. This is the strongest observable assertion the harness
       supports — the DOM reflects the dismissed Redux state. */
    await expect(card).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /Continue listening/i })).not.toBeVisible();
  });
});
