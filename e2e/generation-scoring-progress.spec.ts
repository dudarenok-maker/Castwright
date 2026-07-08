/* Browser-level proof of the srv-36 scoreBook incremental-hardening UI —
 * a live "checking character voices" progress row on the Quality Gate card
 * during a scoring pass, an Activity feed entry for the pass starting, and
 * the "Resume scoring" button for a book left with unscored characters.
 *
 * Scoping note (Task 14, per the plan): this spec drives the MOCKED
 * frontend SSE reaction directly with hand-fed tick effects — it tests
 * "does the UI react correctly when these ticks arrive," the mechanism this
 * feature adds. It does NOT (and cannot, at this layer) assert that a real
 * `scoreBook` run's ticks are guaranteed to arrive live end-to-end on a real
 * server — the live portion of a real run is best-effort (broadcasts only
 * reach a book's active generation-job subscribers; the resume path and the
 * post-render tail have none). That server-side reality is covered by
 * Tasks 1-7's own unit/integration tests, not here.
 *
 * Two mock-architecture gaps found while writing this spec (see the inline
 * comments at each site below), both bridged with the smallest addition
 * that follows an existing precedent rather than a new mechanism:
 *
 *   1. `mockStreamGeneration` (src/lib/api.ts) never emits
 *      scoring_started/scoring_progress/scoring_complete ticks — it only
 *      drives chapter progress/completion. There is no mock-stream helper
 *      to extend, so this spec instead dispatches the exact store actions
 *      generation-stream-runner.ts's `handleTickFor` would dispatch for
 *      each tick type, via the already-established `window.__store__`
 *      test hook (main.tsx) — the same technique
 *      e2e/marketing/scenes.ts's 'generating-revision-diff' scene uses to
 *      stand in for a tick a dead/incomplete mock stream can't fire, and
 *      the same hook generation-resume.spec.ts / generation-stuck-queued.spec.ts
 *      already use to seed chapter state directly.
 *   2. `mockGetQaReport` (src/lib/api.ts) always returns the same fixed
 *      MOCK_QA_REPORT regardless of bookId (confirmed by
 *      e2e/qa-report.spec.ts's own comment) — voiceDrift.charactersPending
 *      is always `[]`, so the Resume-scoring branch of VoiceMatchRow is
 *      unreachable through the mock's default response, and there's no
 *      real network request to intercept for it (mock mode never calls
 *      `fetch` for this endpoint at all). Added a `window.__mockQaReportOverride`
 *      read in `mockGetQaReport`, mirroring the existing
 *      `window.__mockGenConcurrency` idiom in the same file. Similarly,
 *      `api.resumeScoring` under mock mode is `mockResumeScoring` — a
 *      no-op that never touches the network either (unlike
 *      `realResumeScoring`), so the second test asserts the click's
 *      observable UI-visible effect (the button's own post-click state
 *      transition) rather than a `page.route` interception, which would
 *      never fire under mock mode. */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm, confirmCastAndReachManuscript } from './helpers';

/* Serial mode: the cold-boot analysis walk is long; keep it in one worker so
   the mock SSE phase transitions don't miss their window under contention
   (same rationale as generation-resume.spec.ts / generation-stuck-queued.spec.ts). */
test.describe.configure({ mode: 'serial' });

/* Dispatch a plain Redux action straight into the store via the
   `window.__store__` test hook (main.tsx, DEV/e2e gate). Same idiom as
   generation-resume.spec.ts's inline `store.dispatch({...})` call. */
async function dispatchAction(page: Page, action: { type: string; payload?: unknown }): Promise<void> {
  await page.evaluate((a) => {
    const s = (window as unknown as { __store__?: { dispatch: (action: unknown) => void } }).__store__;
    if (!s) throw new Error('window.__store__ is not exposed (main.tsx DEV/e2e gate regressed)');
    s.dispatch(a);
  }, action);
}

async function getBookId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __store__?: { getState: () => { ui: { stage: { bookId?: string } } } };
      }
    ).__store__;
    if (!s) throw new Error('window.__store__ is not exposed (main.tsx DEV/e2e gate regressed)');
    const bookId = s.getState().ui.stage.bookId;
    if (!bookId) throw new Error('stage has no bookId — expected ready/generate stage');
    return bookId;
  });
}

/* Reach the Generate view WITHOUT clicking "Approve cast & start
   generating" — plan 137: a plain nav never auto-enqueues, so no mock SSE
   stream opens and nothing races our hand-fed ticks below. Same pattern as
   generation-resume.spec.ts / generation-stuck-queued.spec.ts. */
async function goToGenerateView(page: Page): Promise<void> {
  await goToConfirm(page);
  await confirmCastAndReachManuscript(page);
  await page.getByRole('button', { name: /^Generate$/ }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });
}

test.describe('Voice-match scoring progress (srv-36 hardening)', () => {
  test('Quality Gate card and Activity feed update live as scoring_progress ticks arrive, then settle to the complete state', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await goToGenerateView(page);
    const bookId = await getBookId(page);

    /* Quality gate card must have hydrated its (mock-fetched) report before
       we start driving ticks, or the priority-ordered VoiceMatchRow branches
       have nothing to fall back to once scoring_complete clears the live
       progress below. */
    await expect(page.getByText(/quality gate/i)).toBeVisible({ timeout: 10_000 });

    /* scoring_started — mirrors generation-stream-runner.ts's handling of
       the real tick: seeds chapters.scoringProgress[bookId] and appends a
       'scoring_started' Activity-feed entry (see buildScoringStartedEvent,
       src/lib/change-log.ts). */
    await dispatchAction(page, {
      type: 'chapters/setScoringProgress',
      payload: { bookId, charactersChecked: 0, charactersOnRoster: 3 },
    });
    await dispatchAction(page, {
      type: 'changeLog/appendLogEvent',
      payload: {
        id: Date.now(),
        at: new Date().toISOString(),
        ts: 'Just now',
        date: 'today',
        type: 'scoring_started',
        title: 'Voice-match scoring started — 3 characters',
        note: 'Checking 3 characters against their own voice.',
        actor: 'system',
      },
    });

    await expect(page.getByText(/Checking character voices — 0 of 3 done/)).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText('Voice-match scoring started — 3 characters')).toBeVisible({
      timeout: 5_000,
    });

    /* scoring_progress x2 — the live "X of Y done" row copy advances. */
    await dispatchAction(page, {
      type: 'chapters/setScoringProgress',
      payload: { bookId, charactersChecked: 1, charactersOnRoster: 3 },
    });
    await expect(page.getByText(/Checking character voices — 1 of 3 done/)).toBeVisible({
      timeout: 5_000,
    });

    await dispatchAction(page, {
      type: 'chapters/setScoringProgress',
      payload: { bookId, charactersChecked: 2, charactersOnRoster: 3 },
    });
    await expect(page.getByText(/Checking character voices — 2 of 3 done/)).toBeVisible({
      timeout: 5_000,
    });

    /* scoring_complete — clears the live progress. VoiceMatchRow falls
       through to the already-fetched report (MOCK_QA_REPORT, unchanged
       throughout this spec — chaptersScored === chaptersEligible === 12,
       charactersChecked === charactersOnRoster === 18, no mismatches), which
       renders the terminal "18 of 18 characters checked" copy — the row's
       settled state once nothing is actively scoring. */
    await dispatchAction(page, {
      type: 'chapters/clearScoringProgress',
      payload: bookId,
    });
    await dispatchAction(page, {
      type: 'changeLog/appendLogEvent',
      payload: {
        id: Date.now() + 1,
        at: new Date().toISOString(),
        ts: 'Just now',
        date: 'today',
        type: 'scoring_complete',
        title: 'Voice-match scoring complete',
        note: '0 mismatches found.',
        actor: 'system',
      },
    });

    await expect(page.getByText(/18 of 18 characters checked, 0 mismatches/)).toBeVisible({
      timeout: 5_000,
    });
    /* The live "Checking character voices" copy must be gone now that
       scoringProgress cleared. */
    await expect(page.getByText(/Checking character voices/)).toHaveCount(0);
  });

  test('Resume scoring button appears when charactersPending is non-empty with no active stream, and clicking it calls the resume endpoint', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    /* Force the mock's qa-report response into the "interrupted scoring
       pass" shape — see the file-level comment (gap 2) for why this
       override exists. Must be seeded before the Generate view mounts
       (useQaReport fetches on mount), so this runs before any navigation. */
    await page.addInitScript(() => {
      (window as unknown as { __mockQaReportOverride: unknown }).__mockQaReportOverride = {
        bookId: 'pending-scoring-fixture',
        generatedAt: '2026-07-08T00:00:00.000Z',
        chaptersRendered: 2,
        chaptersTotal: 2,
        totalLines: 40,
        acoustic: { linesChecked: 40, linesRerecorded: 0, chaptersFlagged: 0 },
        asr: { linesVerified: 40, linesFlaggedDrift: 0 },
        voiceDrift: {
          attribution: 'full',
          chaptersEligible: 2,
          chaptersScored: 1,
          chaptersEmbedFailed: 0,
          charactersOnRoster: 2,
          charactersChecked: 1,
          charactersPending: ['ren'],
          mismatches: [],
          inconclusiveCount: 0,
          uncheckedCharacterIds: [],
        },
        configDrift: { counts: { mild: 0, moderate: 0, severe: 0 }, events: [] },
      };
    });

    await goToGenerateView(page);

    const resumeBtn = page.getByRole('button', { name: 'Resume scoring', exact: true });
    await expect(resumeBtn).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('1 of 2 characters checked so far')).toBeVisible();

    await resumeBtn.click();

    /* api.resumeScoring resolves to mockResumeScoring under mock mode — a
       no-op Promise that never issues a fetch (see the file-level comment,
       gap 2), so there is no network request to intercept. The button's own
       post-click state is the observable, UI-visible proof the click
       handler awaited a successful resumeScoring call: QaReportCard
       deliberately never reverts it to clickable on success (see the
       comment in src/components/qa-report-card.tsx), landing on the
       terminal "Resuming — check back in a few minutes" state and
       unmounting the button entirely. */
    await expect(page.getByText('Resuming — check back in a few minutes')).toBeVisible({
      timeout: 5_000,
    });
    await expect(resumeBtn).toHaveCount(0);
  });
});
