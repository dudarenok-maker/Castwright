import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/* Fixture: e2e/fixtures/ab-take.m4a, about 2 s of sine, AAC in an m4a container.
   Regenerate with:
   ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -c:a aac -b:a 32k -ar 22050 -movflags +faststart e2e/fixtures/ab-take.m4a */
const FIXTURE = readFileSync(fileURLToPath(new URL('./fixtures/ab-take.m4a', import.meta.url)));

test.describe.configure({ mode: 'serial' });

/**
 * Revision-diff A/B player on an M4A book (#4319, spec §7 Phase 1 step 8).
 *
 * Mock mode serves no files, so the book is seeded with `audioExt: 'm4a'` (the
 * mock then answers both takes with `.m4a` URLs) and the spec serves those URLs
 * itself with a small committed AAC fixture as `audio/mp4`.
 *
 * Playwright's bundled Chromium has no AAC decoder, so `play()` is stubbed to
 * resolve and to record the src it was called on. The `<audio>` elements
 * themselves load for real (`preload=metadata`), which is what hits the routes.
 */
test.describe('revision diff A/B player on an m4a book', () => {
  test('plays both takes from .m4a URLs and toggles between them', async ({ page }) => {
    const hits = { live: 0, previous: 0 };
    await page.route('**/mock-audio/sb/3/audio.m4a', (route) => {
      hits.live += 1;
      return route.fulfill({ status: 200, contentType: 'audio/mp4', body: FIXTURE });
    });
    await page.route('**/mock-audio/sb/3/audio/previous.m4a', (route) => {
      hits.previous += 1;
      return route.fulfill({ status: 200, contentType: 'audio/mp4', body: FIXTURE });
    });

    await page.addInitScript(() => {
      const played: string[] = [];
      (window as unknown as { __played: string[] }).__played = played;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        played.push(new URL(this.src).pathname);
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function () {};
    });

    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    /* Re-seed Solway Bay as an m4a book: same pending revision, chapter 3 keeps
       its previous take, every chapter stays live. */
    await page.evaluate(() => {
      type Seeder = {
        get: (b: string) => { pending: unknown[] };
        seed: (b: string, s: unknown) => void;
      };
      const m = (window as unknown as { __mockRevisions: Seeder }).__mockRevisions;
      m.seed('sb', {
        state: { pending: m.get('sb').pending },
        previousChapterIds: [3],
        liveChapterIds: Array.from({ length: 18 }, (_, i) => i + 1),
        audioExt: 'm4a',
      });
    });

    await page
      .getByText(/Solway Bay/i)
      .first()
      .click({ timeout: 10_000 });
    await page.getByTestId('status-pill').click();
    await page
      .getByTestId('status-popover-revisions')
      .getByRole('button', { name: /\d+ revisions?/i })
      .click();
    const player = page.getByTestId('revision-diff-player');
    await expect(player).toBeVisible({ timeout: 10_000 });

    /* Both sides must be playable (not "Original audio not preserved"). */
    const playA = player.getByRole('button', { name: 'Play A · Current' });
    const playB = player.getByRole('button', { name: 'Play B · New draft' });
    await expect(playA).toBeEnabled({ timeout: 10_000 });
    await expect(playB).toBeEnabled({ timeout: 10_000 });
    await expect(player.getByText(/Original audio not preserved/)).toHaveCount(0);
    await expect(player.getByText(/Original audio could not be loaded/)).toHaveCount(0);

    /* A, then switch to B: the player's own state flips the aria-label. */
    await playA.click();
    await expect(player.getByRole('button', { name: 'Pause A · Current' })).toBeVisible();
    await player.getByRole('button', { name: 'Play B · New draft' }).click();
    await expect(player.getByRole('button', { name: 'Pause B · New draft' })).toBeVisible();
    await expect(player.getByRole('button', { name: 'Play A · Current' })).toBeVisible();

    /* Each side played from its own .m4a URL. */
    const played = await page.evaluate(() => (window as unknown as { __played: string[] }).__played);
    expect(played).toEqual(['/mock-audio/sb/3/audio/previous.m4a', '/mock-audio/sb/3/audio.m4a']);
    expect(played.every((p) => p.endsWith('.m4a'))).toBe(true);

    /* The browser requested exactly those URLs. */
    await expect.poll(() => hits.live).toBeGreaterThan(0);
    await expect.poll(() => hits.previous).toBeGreaterThan(0);
    await expect(player.getByText(/Original audio not preserved/)).toHaveCount(0);
  });
});
