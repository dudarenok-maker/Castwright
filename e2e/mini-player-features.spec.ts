/* Browser-level coverage for plan 53 mini-player feature pack:
 * playback speed picker, user-placed markers, sleep timer.
 *
 * Pairs with docs/features/archive/53-mini-player-feature-pack.md.
 *
 * Persistence-across-reload is covered by the Vitest server spec for
 * the PUT validator + the slice-roundtrip Vitest spec; here we drive
 * the same flow through the real browser to lock the UI wiring +
 * audio-element behaviour. */

import { test, expect, type Page } from '@playwright/test';

/* Serial within this file so the audio-element tests don't race each other
   under parallel-worker contention on Windows. Other spec files still run
   in parallel. Pattern mirrors what plan 58 applies to listen-playback +
   new-book-flow. */
test.describe.configure({ mode: 'serial' });

async function openSolwayBay(page: Page): Promise<void> {
  await page.goto('/#/books/sb/listen');
  await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
    timeout: 10_000,
  });
}

async function startPlaybackFromStart(page: Page): Promise<void> {
  const playButton = page.getByRole('button', { name: /Play from the start/i });
  await expect(playButton).toBeVisible({ timeout: 5_000 });
  await expect(playButton).toBeEnabled({ timeout: 5_000 });
  await playButton.click();
  await expect(page.locator('audio')).toHaveCount(1, { timeout: 3_000 });
}

test.describe('plan 53 — playback speed picker', () => {
  test('selecting 1.5× updates the audio element playbackRate AND label', async ({ page }) => {
    await openSolwayBay(page);
    await startPlaybackFromStart(page);

    const audio = page.locator('audio');
    const speedToggle = page.getByTestId('mini-player-speed-toggle');
    await expect(speedToggle).toBeVisible();
    await expect(speedToggle).toHaveText(/1\.0×/);

    /* Default rate before any user interaction is 1.0. */
    await expect(audio).toHaveJSProperty('playbackRate', 1, { timeout: 3_000 });

    /* Open picker, pick 1.5×. */
    await speedToggle.click();
    await page.getByTestId('mini-player-speed-option-1.5').click();
    /* Label flips + the live audio element reflects the change. */
    await expect(speedToggle).toHaveText(/1\.5×/);
    await expect(audio).toHaveJSProperty('playbackRate', 1.5, { timeout: 3_000 });
  });

  test('rate selection persists after pre-priming the listen-progress slice (reload path)', async ({
    page,
  }) => {
    /* Skip the picker-flow and seed the slice directly via
       window.__store__, then assert that on a fresh chapter mount the
       mini-player adopts the persisted rate. This is the second half
       of the persistence story — Vitest covers the PUT path; here we
       cover the rehydrate path through the browser. */
    await openSolwayBay(page);
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __store__: { dispatch: (a: unknown) => void };
        }
      ).__store__;
      store.dispatch({
        type: 'listenProgress/hydrate',
        payload: {
          bookId: 'sb',
          progress: {
            chapterId: 1,
            currentSec: 0,
            updatedAt: new Date().toISOString(),
            playbackRate: 1.5,
          },
        },
      });
    });
    await startPlaybackFromStart(page);
    const audio = page.locator('audio');
    await expect(audio).toHaveJSProperty('playbackRate', 1.5, { timeout: 5_000 });
    await expect(page.getByTestId('mini-player-speed-toggle')).toHaveText(/1\.5×/);
  });
});

test.describe('fe-25 — volume slider', () => {
  test('changing the slider updates the audio element volume and persists across reload', async ({
    page,
  }) => {
    await openSolwayBay(page);
    await startPlaybackFromStart(page);
    const audio = page.locator('audio');

    /* Default volume is full (1) before any interaction. */
    await expect(audio).toHaveJSProperty('volume', 1, { timeout: 3_000 });

    /* Open the popover and drag the slider down. */
    const toggle = page.getByTestId('mini-player-volume-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    const slider = page.getByTestId('mini-player-volume-slider');
    await expect(slider).toBeVisible();
    await slider.fill('0.3');

    await expect(audio).toHaveJSProperty('volume', 0.3, { timeout: 3_000 });

    /* The level is persisted in the settings slice (localStorage). Assert the
       store reflects it — the redux-persist round-trip is unit-covered, so we
       read the live slice here rather than reload (which would re-fetch the
       fixture and is flakier on the audio element). */
    const persisted = await page.evaluate(
      () =>
        (
          window as unknown as {
            __store__: { getState: () => { settings: { playerVolume: number } } };
          }
        ).__store__.getState().settings.playerVolume,
    );
    expect(persisted).toBeCloseTo(0.3);

    /* Reload-survival: seed the same level through the persisted slice and
       confirm a fresh mini-player mount adopts it on load. */
    await page.reload();
    await openSolwayBay(page);
    await startPlaybackFromStart(page);
    await expect(page.locator('audio')).toHaveJSProperty('volume', 0.3, { timeout: 5_000 });
  });
});

test.describe('plan 53 — markers / bookmarks', () => {
  test('add marker with label, marker appears in sidebar, click seeks the player', async ({
    page,
  }) => {
    await openSolwayBay(page);
    await startPlaybackFromStart(page);
    const audio = page.locator('audio');

    /* Pick a marker position inside the stub MP3's actual duration
       (~0.65 s for stub-b.mp3) — seeking past the real audio's end
       gets clamped + triggers onEnded, which the marker spec
       shouldn't depend on. Wait for the duration to settle first so
       the seek lands inside a valid window. */
    await expect
      .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.duration), {
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
    const dur = await audio.evaluate((el: HTMLAudioElement) => el.duration);
    /* Halfway through the stub is a deterministic spot well inside
       the valid range. Floor to two decimals so floating-point
       drift doesn't push the assertion off by a frame. */
    const markerSec = Math.max(0.1, Math.min(dur - 0.1, dur / 2));

    /* Park the playhead at the chosen position before the marker drop
       so the captured `currentSec` matches. Pause + seek + tick so
       onTimeUpdate fires through currentSecRef. */
    await audio.evaluate((el: HTMLAudioElement, s: number) => {
      el.pause();
      el.currentTime = s;
      el.dispatchEvent(new Event('timeupdate'));
    }, markerSec);

    /* Drop a marker via the button (Plan 53 — `M` shortcut hits the
       same path; button click is the more stable e2e affordance). */
    await page.getByTestId('mini-player-add-marker').click();
    const form = page.getByTestId('mini-player-marker-form');
    await expect(form).toBeVisible({ timeout: 2_000 });

    const input = page.getByTestId('mini-player-marker-input');
    await input.fill('re-record this');
    await page.getByTestId('mini-player-marker-save').click();
    await expect(form).toBeHidden({ timeout: 2_000 });

    /* Markers sidebar lights up with the new entry. */
    const panel = page.getByTestId('listen-markers-panel');
    await expect(panel).toBeVisible({ timeout: 3_000 });
    await expect(panel.getByText(/re-record this/)).toBeVisible();

    /* Move the playhead AWAY from the marker so the upcoming click is
       a real seek (otherwise we'd be asserting that the audio stayed
       at the same place — no signal). Seek to start. */
    await audio.evaluate((el: HTMLAudioElement) => {
      el.currentTime = 0;
    });
    await expect
      .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.currentTime), {
        timeout: 2_000,
      })
      .toBeLessThan(0.1);

    /* Click the marker → mini-player consumes pendingSeek via the
       slice and snaps the audio element back to markerSec. */
    await panel.locator('[data-testid^="listen-marker-seek-"]').first().click();
    await expect
      .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.currentTime), {
        timeout: 5_000,
      })
      .toBeGreaterThan(markerSec - 0.1);
    const t = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    expect(t).toBeLessThan(markerSec + 0.5);
  });
});

test.describe('plan 53 — sleep timer', () => {
  test('end-of-chapter mode pauses the player on the audio onEnded event', async ({ page }) => {
    /* Wall-clock countdown firing is unit-tested in
       src/lib/sleep-timer.test.ts (deterministic via injected `now`).
       End-of-chapter is the browser-driven path that needs an e2e
       lock: only the live <audio> element emits `ended`. */
    await openSolwayBay(page);
    await startPlaybackFromStart(page);
    const audio = page.locator('audio');
    await expect(audio).toHaveJSProperty('paused', false, { timeout: 3_000 });

    /* Arm end-of-chapter mode. */
    await page.getByTestId('mini-player-sleep-toggle').click();
    await page.getByTestId('mini-player-sleep-option-end-of-chapter').click();
    await expect(page.getByTestId('mini-player-sleep-pill')).toHaveText(/end of ch/i, {
      timeout: 2_000,
    });

    /* Fire the chapter-end event on the audio element. The
       mini-player's onEnded handler sets playing=false AND notifies
       the sleep-timer state machine, which transitions to fired and
       triggers the pause path through the existing effect. */
    await audio.evaluate((el: HTMLAudioElement) => {
      el.dispatchEvent(new Event('ended'));
    });

    /* Player paused; the sleep-pill clears back to idle. */
    await expect(audio).toHaveJSProperty('paused', true, { timeout: 3_000 });
    await expect(page.getByTestId('mini-player-sleep-pill')).toBeHidden();
  });

  test('selecting a countdown preset surfaces the remaining-time pill', async ({ page }) => {
    /* Sanity check that the countdown picker installs the pill — the
       actual tick → fired transition is unit-tested deterministically
       in sleep-timer.test.ts. */
    await openSolwayBay(page);
    await startPlaybackFromStart(page);

    await page.getByTestId('mini-player-sleep-toggle').click();
    await page.getByTestId('mini-player-sleep-option-15').click();
    /* Pill renders with mm:ss countdown copy. */
    await expect(page.getByTestId('mini-player-sleep-pill')).toBeVisible({ timeout: 2_000 });

    /* Cancel restores the idle state — pill disappears. */
    await page.getByTestId('mini-player-sleep-toggle').click();
    await page.getByTestId('mini-player-sleep-cancel').click();
    await expect(page.getByTestId('mini-player-sleep-pill')).toBeHidden();
  });
});

test.describe('plan 69 — Share clip', () => {
  test('opens the modal next to the play affordance, drags handles, confirms download URL', async ({
    page,
  }) => {
    /* Patch the anchor-click flow inside `defaultDownload` BEFORE
       navigation. The modal's confirm path creates a transient
       `<a download>` and clicks it; rewiring `HTMLAnchorElement.click`
       at init time captures the URL without fighting the browser's
       real download dialog. */
    await page.addInitScript(() => {
      (window as unknown as { __lastClipUrl: string }).__lastClipUrl = '';
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.href.includes('/clip?')) {
          (window as unknown as { __lastClipUrl: string }).__lastClipUrl = this.href;
          return;
        }
        return origClick.call(this);
      };
    });

    await openSolwayBay(page);

    /* Share-clip button lives in the chapter row (next to play). Use
       chapter 2 to match the BACKLOG acceptance walkthrough. */
    const shareButton = page.getByTestId('chapter-row-2-share-clip');
    await expect(shareButton).toBeVisible({ timeout: 5_000 });

    await shareButton.click();
    const modal = page.getByTestId('share-clip-modal');
    await expect(modal).toBeVisible({ timeout: 3_000 });

    /* Default values render. */
    await expect(page.getByTestId('share-clip-start-input')).toBeVisible();
    await expect(page.getByTestId('share-clip-end-input')).toBeVisible();

    /* Drag the start slider to 80 s (= 1:20) and end to 110 s (= 1:50)
       — matches the BACKLOG #6 acceptance criterion. */
    await page.getByTestId('share-clip-start-range').fill('80');
    await page.getByTestId('share-clip-end-range').fill('110');
    await expect(page.getByTestId('share-clip-start-input')).toHaveValue('1:20');
    await expect(page.getByTestId('share-clip-end-input')).toHaveValue('1:50');

    await page.getByTestId('share-clip-confirm').click();
    /* Modal closes on confirm. */
    await expect(modal).toBeHidden({ timeout: 2_000 });
    /* The download anchor click was intercepted; assert the URL shape. */
    const captured = await page.evaluate(
      () => (window as unknown as { __lastClipUrl?: string }).__lastClipUrl,
    );
    expect(captured ?? '').toMatch(/\/api\/books\/.+?\/chapters\/2\/clip\?/);
    expect(captured ?? '').toMatch(/start=80\.00/);
    expect(captured ?? '').toMatch(/duration=30\.00/);
  });
});
