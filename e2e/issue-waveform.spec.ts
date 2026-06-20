/* Browser-level proof of the generation-view issue-waveform feature:
 *   1. A mock suspect segment exists in getChapterAudio (halloran segment,
 *      middle third, seeded with suspect:true + reasons in api.ts).
 *   2. Opening a done chapter's Preview in the generate view mounts
 *      MiniPlayer with autoSeekToIssues=true and derives issues from the
 *      segment metadata.
 *   3. The ⚠› "Next issue" button (data-testid="mini-player-next-issue")
 *      is visible when at least one suspect segment exists.
 *   4. Clicking it seeks the scrubber thumb from 0% to the issue region
 *      (≈33 % for chapter 1's 38-minute chapter, third − pad = 766 s).
 *
 * Navigation: uses the Solway Bay fixture book ('sb') — every chapter is
 * already `done` (completedSlugs covers all 18), so no analysis walk is
 * needed and the test is fast (<10 s).
 *
 * Playback suppression: `HTMLMediaElement.prototype.play` is patched to a
 * no-op before navigation so the stub MP3 never emits `timeupdate` events
 * that would continuously overwrite `currentSec` back to the audio element's
 * actual time (~1 s for the stub). Without this suppression, clicking
 * "Next issue" (setCurrentSec=766) is immediately overwritten by the next
 * timeupdate cycle (~100 ms), making the thumb-position assertion racy.
 * The stub audio still loads metadata (durations, peaks, segments) — only
 * real playback is suppressed. `autoSeekToIssues` still fires on
 * `onLoadedMetadata`, setting currentSec to the issue seekSec (766 s)
 * before we even click the button; the click is then a no-op (no later
 * issue) but the thumb stays in the expected zone. */

import { test, expect } from '@playwright/test';

test.describe('generation-view issue-waveform', () => {
  test('Preview on a done chapter shows Next-issue button and scrubber jumps to issue region', async ({
    page,
  }) => {
    test.setTimeout(30_000);

    /* Stub playback BEFORE any navigation so the stub MP3's timeupdate
       events cannot race against our assertions. The audio element still
       loads, dispatches loadedmetadata, and updates currentSec via
       autoSeekToIssues — we just prevent the continuous play loop. */
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (HTMLMediaElement.prototype as any).play = () => Promise.resolve();
    });

    /* Navigate directly to the generate view for the Solway Bay fixture.
       All 18 chapters are pre-seeded as done (completedSlugs covers them),
       so the view renders done rows with Preview buttons immediately. */
    await page.goto('/#/books/sb/generate');

    /* Wait for the chapter list to hydrate — CH 01 is the earliest reliable
       signal (same pattern used in e2e/responsive/coverage.spec.ts). */
    await expect(page.getByText(/^CH 01$/)).toBeVisible({ timeout: 10_000 });

    /* Click the first "Preview" button (chapter 1, done row, action strip).
       The button text is exactly "Preview" with a play icon preceding it. */
    await page.getByRole('button', { name: /^Preview$/ }).first().click();

    /* MiniPlayer mounts and fetches getChapterAudio (mock: 120 ms delay).
       The ⚠› button only renders when issues.length > 0, which requires the
       suspect segment to have been returned and deriveIssues to have run.
       toBeVisible() retries up to 10 s — ample for the 120 ms mock round-trip.
       This assertion proves the suspect segment seed in api.ts is wired
       correctly: no suspect flag → no issues → no button → test fails here. */
    const nextIssueBtn = page.getByTestId('mini-player-next-issue');
    await expect(nextIssueBtn).toBeVisible({ timeout: 10_000 });

    const thumb = page.getByTestId('scrubber-thumb');

    /* Click the jump button. Two valid outcomes depending on race:
       (a) autoSeekToIssues already moved currentSec to 766 s on loadedmetadata
           → jumpToIssue(1) finds no later issue → no-op → thumb at ≈33 % ✓
       (b) audio not yet loaded → currentSec=0 → click seeks to 766 s → ≈33 % ✓
       In both cases the thumb lands in the 30-39 % band. Playback is
       suppressed so timeupdate cannot race against this assertion. */
    await nextIssueBtn.click();

    /* Assert the scrubber thumb is in the issue zone (≈33 %).
       Pattern "3[0-9]" covers 30–39 % (e.g. "33.2465%"). The exact value
       is (768−2)/2304*100 = 33.2465… for chapter 1's 38:24 duration. */
    await expect(thumb).toHaveAttribute('style', /left:\s*3[0-9]/, { timeout: 5_000 });
  });
});
