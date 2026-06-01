import { test, expect, type Page } from '@playwright/test';

/* fe-15 — browser-level proof of the plan-114 profile-regen preview gate.
 *
 * Flow: cast → open a character's profile drawer → "Regenerate …'s lines" →
 * the per-character modal → "Preview CH 01 first" → the preview chapter renders
 * → on chapter_complete the generation-stream middleware auto-opens the A/B
 * diff player in 'preview' mode → Approve fans the remaining chapters out (and
 * appends a `regenerate` change-log event) / Reject reverts without fanning out.
 *
 * Carrick's Compass ('cc') is the only mock book carrying BOTH a populated cast
 * AND chapters its cast speaks in (api.ts `CC_CHAPTERS` + `chapterCharacters`):
 * Eliza speaks in CH1/2/3, so CH1 is the preview sample and CH2/3 are the rest.
 *
 * Determinism: serial mode + `__mockGenConcurrency = 1` pin the mock SSE
 * cadence, and the preview chapter is fast-forwarded through the e2e
 * `window.__store__` handle so chapter_complete fires on the next ~1.2s tick
 * rather than ~60s in (the mock advances +0.02 progress per 1.2s tick). The
 * mock stream reads chapter progress from that same slice, so the bump is
 * picked up on its next interval. `cc` is English, so no Qwen language banner /
 * `/api/qwen/detect` probe fires here (kept distinct from fe-16 on purpose).
 */

test.describe.configure({ mode: 'serial' });

type StoreWin = {
  __store__?: {
    getState: () => {
      chapters: { chapters: Array<{ id: number; state: string; progress: number }> };
      ui: { previewRegen: unknown };
      changeLog: { events: Array<{ type: string; title: string }> };
    };
    dispatch: (a: unknown) => void;
  };
};

async function chapterState(page: Page, id: number): Promise<string | undefined> {
  return page.evaluate((cid) => {
    const s = (window as unknown as StoreWin).__store__;
    return s?.getState().chapters.chapters.find((c) => c.id === cid)?.state;
  }, id);
}

/* Bump the in-flight preview chapter near-complete so the next mock tick emits
   chapter_complete (the mock derives progress from this same slice). */
async function fastForward(page: Page, id: number): Promise<void> {
  await page.evaluate((cid) => {
    const s = (window as unknown as StoreWin).__store__;
    if (!s) throw new Error('window.__store__ is not exposed (main.tsx DEV/e2e gate regressed)');
    const chapters = s.getState().chapters.chapters;
    s.dispatch({
      type: 'chapters/setChapters',
      payload: chapters.map((c) => (c.id === cid ? { ...c, progress: 0.99 } : c)),
    });
  }, id);
}

async function hasElizaRegenLog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const s = (window as unknown as StoreWin).__store__;
    return (s?.getState().changeLog.events ?? []).some(
      (e) => e.type === 'regenerate' && /Regenerated Eliza/i.test(e.title),
    );
  });
}

async function previewRegenIsNull(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as StoreWin).__store__?.getState().ui.previewRegen === null,
  );
}

/* Walk cast → drawer → regenerate modal → Preview, and wait for the A/B player
   to auto-open in preview mode. Returns the player locator. */
async function openPreviewPlayer(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __mockGenConcurrency?: number }).__mockGenConcurrency = 1;
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
    timeout: 10_000,
  });
  await page.goto('/#/books/cc/cast');

  /* Open Eliza's profile drawer from the cast row, then the per-character
     regenerate modal. The drawer stays mounted behind the (centered) modal and
     its sticky footer overlaps the modal's right-hand button at this viewport,
     so dismiss the drawer via the store handle — the modal's own `regenCharacterCtx`
     state is independent and stays open — before clicking Preview. */
  await page.getByTestId('cast-row-eliza_cc').click({ timeout: 10_000 });
  await page.getByRole('button', { name: /Regenerate Eliza's lines/i }).click();
  await expect(page.getByTestId('regen-character-preview')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    const s = (window as unknown as StoreWin).__store__;
    /* Dismiss the (overlapping) profile drawer — the modal's own state is
       independent and stays open. Also clear the phantom mock revision the
       per-book poll seeds for every book (rev1), so the preview chapter's stub
       lands at pending[0] instead of behind it. The next poll is 30s+ out, so
       it can't re-seed within this test. */
    s?.dispatch({ type: 'ui/setOpenProfileId', payload: null });
    s?.dispatch({ type: 'revisions/rejectAllPending' });
  });
  await page.getByTestId('regen-character-preview').click();

  /* The preview chapter (CH1) is enqueued + claimed → in_progress. Fast-forward
     it so chapter_complete fires → the middleware builds the playable stub and
     opens the diff player in preview mode. */
  await expect.poll(() => chapterState(page, 1), { timeout: 15_000 }).toBe('in_progress');
  await fastForward(page, 1);

  const player = page.getByTestId('revision-diff-player');
  await expect(player).toBeVisible({ timeout: 15_000 });
  await expect(player).toHaveAttribute('data-mode', 'preview');
  return player;
}

test.describe('profile-regen preview gate (fe-15)', () => {
  test('Approve fans the remaining chapters out and logs the regenerate', async ({ page }) => {
    test.setTimeout(45_000);
    const player = await openPreviewPlayer(page);

    /* Approve = commit the new take + fan CH2/CH3 out as whole-chapter regens.
       The durable, Reject-distinguishing signal is the appended `regenerate`
       change-log event ("Regenerated Eliza's lines"). */
    await player.getByRole('button', { name: /Approve.*regenerate the rest/i }).click();
    await expect(player).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(() => hasElizaRegenLog(page), {
        timeout: 10_000,
        message: 'Approve should append a "Regenerated Eliza" change-log event',
      })
      .toBe(true);
  });

  test('Reject reverts without fanning the rest out', async ({ page }) => {
    test.setTimeout(45_000);
    const player = await openPreviewPlayer(page);

    /* Reject = drop the revision, clear the stashed remaining chapters, no
       change-log regenerate entry. */
    await player.getByRole('button', { name: /Reject.*re-adjust/i }).click();
    await expect(player).toBeHidden({ timeout: 10_000 });
    expect(await previewRegenIsNull(page)).toBe(true);
    expect(await hasElizaRegenLog(page)).toBe(false);
  });
});
