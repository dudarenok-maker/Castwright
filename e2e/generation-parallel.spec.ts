/* Browser-level proof of the parallel-chapter SSE contract — plan 87
 * follow-up (archive: docs/features/archive/87-parallel-chapter-synth.md).
 *
 * Plan 87 added a bounded worker pool on the server (default
 * `GEN_CHAPTER_CONCURRENCY=2`) so progress / chapter_complete events
 * for multiple chapters interleave on the SSE wire — each keyed by
 * `chapterId`. The mock implementation in `src/lib/api.ts`
 * (`mockStreamGeneration`) was a serial loop until BACKLOG #26: find a
 * singular active chapter, increment progress, only advance the next
 * queued chapter when active.progress >= 1. That left the parallel-SSE
 * orchestration server-vitest-pinned but not browser-e2e-pinned.
 *
 * This spec exercises the user-observable invariant in chromium against
 * Vite in mock mode:
 *
 *   1. Two or more chapters reach `state === 'in_progress'` simultaneously.
 *   2. Chapter 2's first `in_progress` transition lands BEFORE chapter 1
 *      transitions to `done` — the wire-shape proof that the K-wide
 *      in-flight set is real (and not the legacy "advance-next-on-complete"
 *      cadence).
 *   3. The Generate view renders ≥2 "Generating" pills concurrently —
 *      the user-visible payoff of the parallel pool.
 *
 * Window-level knob: the spec seeds `window.__mockGenConcurrency = 2`
 * (read by mockStreamGeneration) so the value is deterministic. The mock
 * defaults to 2 even without the knob — the seed is belt-and-suspenders
 * against future default drift.
 *
 * Wall-clock budget: <30 s on a warm cache. The mock SSE ticks at 1200ms;
 * a chapter takes ~50 ticks to complete (0.02 per tick), but a chapter
 * 2 in_progress transition lands on the very first tick (cold start
 * promotes min(K, queued.length) chapters in the same tick). */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm, confirmTierPromptIfPresent } from './helpers';

/* Plan 58 — file-level serial mode keeps long cold-boot walks in one
   worker so SSE phase transitions don't miss their event window when
   other workers' Vite traffic backs up. Same rationale as
   new-book-flow.spec.ts. */
test.describe.configure({ mode: 'serial' });

interface ChapterSnapshot {
  id: number;
  state: string;
  progress?: number;
}

/* Read the live chapter rows from the store. Exposed on `window.__store__`
   in DEV + e2e Vite modes (see src/main.tsx). */
async function getChapters(page: Page): Promise<ChapterSnapshot[]> {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __store__?: {
          getState: () => {
            chapters: { chapters: Array<{ id: number; state: string; progress?: number }> };
          };
        };
      }
    ).__store__;
    if (!s)
      throw new Error('window.__store__ is not exposed — main.tsx DEV/e2e gate may have regressed');
    return s.getState().chapters.chapters.map((c) => ({
      id: c.id,
      state: c.state,
      progress: c.progress,
    }));
  });
}

async function getBookId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __store__?: { getState: () => { ui: { stage: { bookId?: string } } } };
      }
    ).__store__;
    if (!s) throw new Error('window.__store__ is not exposed');
    const bookId = s.getState().ui.stage.bookId;
    if (!bookId) throw new Error('stage has no bookId — expected ready/confirm stage');
    return bookId;
  });
}

test.describe('parallel chapter generation (BACKLOG #26, plan 87)', () => {
  test('two chapters in_progress concurrently and ≥2 Generating pills render', async ({
    page,
  }) => {
    /* Walk budget: ~7.6 s of mock analysis stream + cold goto + ≤20 s of
       parallel-chapter polling. The Playwright default 30 s test timeout
       is too tight when chromium cold-boots a fresh worker (page.goto can
       take 5-10 s on a cold Vite cache). Bumped to 60 s — same headroom
       as the spec's `navigationTimeout` ceiling in playwright.config.ts. */
    test.setTimeout(60_000);

    /* Seed the concurrency knob BEFORE any in-app code reads it. The mock
       defaults to 2 anyway, but the explicit seed is a future-proof anchor:
       if the default ever changes, this spec still asserts K=2. The flag
       lives on `window` so the mock can read it without re-plumbing the
       generation-stream middleware. */
    await page.addInitScript(() => {
      (window as unknown as { __mockGenConcurrency: number }).__mockGenConcurrency = 2;
    });

    /* Drive from cold boot through analysing → confirm → ready. The
       canned analysis fixture (ANALYSIS_NORTHERN_STAR in
       src/mocks/canned-data.ts) seeds `initialChapters` which has
       multiple queued chapters (4-9 inclusive) — enough work for the
       K=2 pool to interleave. */
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });

    /* Start generating. confirmCast lands on view='manuscript'; the user
       clicks "Approve cast & start generating", which lands on
       `#/books/:bookId/generate` AND dispatches ui/requestStartGeneration —
       the only action that auto-enqueues the queued chapters (plan 137; merely
       navigating to the Generate view no longer enqueues). enqueueOnWork then
       fills the queue and the K=2 dispatcher opens two streams. */
    const bookId = await getBookId(page);
    await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
    await expect(page).toHaveURL(new RegExp(`#/books/${bookId}/generate`), { timeout: 5_000 });
    await confirmTierPromptIfPresent(page); // #1160 voice-model tier prompt

    /* Poll for the parallel-SSE proof: chapter 2's first in_progress
       transition lands BEFORE chapter 1 completes. We track the first
       observation of every chapter id we ever see in_progress, plus the
       first observation of any chapter reaching `done` after the
       analysis-seeded done set (chapters 1 + 2 are already done from
       the fixture — we watch the rows that START queued/in_progress
       and transition over the live SSE).

       The serial-loop legacy would only ever show one chapter in
       in_progress at a time post-fixture-seed. The K-wide pool shows
       two. */
    type Transition = { id: number; firstInProgressAt: number | null; firstDoneAt: number | null };
    const transitions = new Map<number, Transition>();
    const start = Date.now();

    /* The fixture pre-seeds chapter 3 in_progress and chapters 1+2 done.
       After confirmCast the slice carries those rows. The K-wide pool
       should pull chapter 4 (the first queued row) into in_progress on
       the very first tick alongside the still-running chapter 3, so we
       expect two distinct chapters in_progress within a couple of
       ticks (~2.4 s at 1200 ms cadence). */
    await expect
      .poll(
        async () => {
          const now = Date.now() - start;
          const chapters = await getChapters(page);
          for (const c of chapters) {
            const t = transitions.get(c.id) ?? {
              id: c.id,
              firstInProgressAt: null,
              firstDoneAt: null,
            };
            if (c.state === 'in_progress' && t.firstInProgressAt === null) {
              t.firstInProgressAt = now;
            }
            if (c.state === 'done' && t.firstDoneAt === null) {
              t.firstDoneAt = now;
            }
            transitions.set(c.id, t);
          }
          const concurrentInProgress = chapters.filter((c) => c.state === 'in_progress').length;
          return concurrentInProgress;
        },
        {
          timeout: 20_000,
          intervals: [200, 400, 800],
          message: 'expected ≥2 chapters concurrently in_progress (K=2 worker pool)',
        },
      )
      .toBeGreaterThanOrEqual(2);

    /* The cross-chapter ordering check. We want chapter N+1's first
       in_progress timestamp to be EARLIER than the moment ANY chapter
       first reached `done` after the run started — i.e. the new chapter
       didn't have to wait for a completion. Equivalently: the first
       "second concurrent in_progress" observation happened before the
       first "newly done" observation, where "newly" means we saw the
       chapter transition from a non-done state. We use the simpler
       inverse: at the moment we observed 2 concurrent in_progress
       chapters above, no NEW chapter had yet transitioned to done. The
       fixture pre-seeds chapters 1+2 done — those don't count as
       transitions because we only mark firstDoneAt when we OBSERVE
       state==='done' on a chapter we've also seen in_progress (or that
       was queued at first poll). */
    const observedInProgress = Array.from(transitions.values())
      .filter((t) => t.firstInProgressAt !== null)
      .sort(
        (a, b) => (a.firstInProgressAt as number) - (b.firstInProgressAt as number),
      );
    expect(
      observedInProgress.length,
      'expected ≥2 chapters to have entered in_progress',
    ).toBeGreaterThanOrEqual(2);

    const secondInProgressEntry = observedInProgress[1];
    /* No chapter that was ever in_progress should have reached `done`
       before the second concurrent chapter even started. */
    for (const t of transitions.values()) {
      if (t.firstInProgressAt === null) continue;
      if (t.firstDoneAt === null) continue;
      expect(
        t.firstDoneAt,
        `chapter ${t.id} reached done at ${t.firstDoneAt} ms — before the second concurrent ` +
          `chapter ${secondInProgressEntry.id} entered in_progress at ` +
          `${secondInProgressEntry.firstInProgressAt} ms. The K-wide pool should advance ` +
          `chapter N+1 before chapter N completes.`,
      ).toBeGreaterThan(secondInProgressEntry.firstInProgressAt as number);
    }

    /* DOM proof: ≥2 "Generating" pills render simultaneously in the
       Generate view's chapter rows. The pill is `<Pill color="peach">
       Generating</Pill>` (src/views/generation.tsx:943) — a span whose
       textContent is exactly "Generating". `Generating…` (with the
       ellipsis) is a different affordance (the inline per-character
       caption in the expanded chapter row), so the exact-string locator
       avoids accidental matches. */
    const generatingPills = page.locator('span', { hasText: /^Generating$/ });
    await expect(generatingPills.nth(1)).toBeVisible({ timeout: 10_000 });
    const pillCount = await generatingPills.count();
    expect(pillCount, `expected ≥2 'Generating' pills, saw ${pillCount}`).toBeGreaterThanOrEqual(2);
  });
});
