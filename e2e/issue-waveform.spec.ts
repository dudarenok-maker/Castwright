/* Browser-level proof that the Next-issue button in the generate-view
 * MiniPlayer genuinely advances the playhead between two distinct issue
 * regions derived from suspect segments.
 *
 * Two suspect segments are seeded in mockGetChapterAudio (api.ts).
 * The SB mock book state gives chapter 1 duration '38:24' = 2304 s
 * (src/lib/api.ts SB_CHAPTERS), so the segments are:
 *
 *   third = 2304/3 = 768 s
 *   issue-1 (halloran):      start=768 s, padded seekSec=766 s
 *                             leftPct = 766/2304*100 ≈ 33.2%  (zone 30–39%)
 *   lateStart = 768*2 + 88 = 1624 s
 *   issue-2 (late narrator): start=1624 s, padded seekSec=1622 s
 *                             leftPct = 1622/2304*100 ≈ 70.4% (zone 68–73%)
 *   Gap between padded end of issue-1 (1538 s) and padded start of issue-2
 *   (1622 s) = 84 s — they do NOT merge in deriveIssues.
 *
 * With autoSeekToIssues=true the player auto-seeks to issue-1 on
 * loadedmetadata.  The test then asserts:
 *   BEFORE click — thumb is in the issue-1 zone (≈33%)
 *   AFTER  click — thumb moved to the issue-2 zone (≈70%)
 * A broken Next-issue button (no-op) leaves the thumb at issue-1 →
 * the after-assertion fails, making the test non-vacuous.
 *
 * Navigation: uses the Solway Bay fixture book ('sb') — every chapter is
 * already `done` (completedSlugs covers all 18), so no analysis walk is
 * needed and the test is fast (<10 s).
 *
 * Playback suppression: HTMLMediaElement.prototype.play is patched to a
 * no-op before navigation so the stub MP3 never emits timeupdate events
 * that would overwrite currentSec back to the audio element's real time.
 * jumpToIssue sets el.currentTime directly and the player mirrors it into
 * the thumb via currentSec — the play() stub does not interfere. */

import { test, expect } from '@playwright/test';

test('Preview on a done chapter: Next-issue button advances scrubber from issue-1 to issue-2 zone', async ({
  page,
}) => {
  test.setTimeout(30_000);

  /* Stub playback BEFORE navigation so timeupdate cannot race against our
     assertions (jumpToIssue sets currentTime directly; the play() stub
     does not suppress that). */
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLMediaElement.prototype as any).play = () => Promise.resolve();
  });

  /* Navigate directly to the generate view for the Solway Bay fixture.
     All 18 chapters are pre-seeded as done, so done rows render immediately. */
  await page.goto('/#/books/sb/generate');

  /* Wait for the chapter list to hydrate. */
  await expect(page.getByText(/^CH 01$/)).toBeVisible({ timeout: 10_000 });

  /* Click the first "Preview" button (chapter 1, done row). */
  await page.getByRole('button', { name: /^Preview$/ }).first().click();

  /* MiniPlayer fetches getChapterAudio (mock: 120 ms delay) and derives
     issues.  The Next-issue button only renders when issues.length > 0. */
  const nextIssueBtn = page.getByTestId('mini-player-next-issue');
  await expect(nextIssueBtn).toBeVisible({ timeout: 10_000 });

  const thumb = page.getByTestId('scrubber-thumb');

  /* BEFORE: autoSeekToIssues moved the thumb to issue-1 (≈33%).
     Pattern "3[0-9]" matches 30–39%. */
  await expect(thumb).toHaveAttribute('style', /left:\s*3[0-9]/, { timeout: 5_000 });

  /* Click Next-issue.  jumpToIssue(1) should advance to issue-2 (seekSec≈1622 s → ≈70%). */
  await nextIssueBtn.click();

  /* AFTER: assert the thumb moved into the issue-2 zone (68–73%).
     expect.poll retries until the React state update propagates to the DOM.
     A broken click (thumb stays at ≈33%) returns a value in 30–39% and
     fails this assertion — the test is NOT vacuous. */
  await expect
    .poll(
      async () => {
        const style = (await thumb.getAttribute('style')) ?? '';
        const m = style.match(/left:\s*([\d.]+)%/);
        return m ? parseFloat(m[1]) : -1;
      },
      { timeout: 5_000, message: 'thumb left% expected in 68–73% (issue-2 zone)' },
    )
    .toBeGreaterThanOrEqual(68);

  /* Belt-and-suspenders upper bound: thumb must not have jumped past issue-2. */
  const finalStyle = (await thumb.getAttribute('style')) ?? '';
  const finalMatch = finalStyle.match(/left:\s*([\d.]+)%/);
  const finalPct = finalMatch ? parseFloat(finalMatch[1]) : -1;
  expect(finalPct).toBeLessThanOrEqual(73);
});
