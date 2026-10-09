/* #3440 — drifted-id canonicalisation end-to-end (browser-level).
 *
 * When the server's book-state response carries `characterIdAliases` (e.g.
 * { 'the-torment': 'the_torment' }), the client must resolve drifted ids to
 * their canonical form so that:
 *
 *  1. Manuscript sentences attributed to the drift variant ('the-torment')
 *     contribute line/word counts to the canonical cast row ('the_torment')
 *     in the Generate view's expanded chapter panel — the `aliasedSentences`
 *     memo in generation.tsx rewrites characterIds before building
 *     `characterStatsByChapter`.
 *
 *  2. SSE progress ticks carrying the drift variant resolve to the canonical
 *     cast row via `keyFor(s.characterIdAliases, ch.characters, ev.characterId)`
 *     in `applyGenerationTick` (chapters-slice.ts:652) and highlight it as
 *     "Generating…" while the non-canonical narrator row stays "Queued".
 *
 *  3. The Fix-audio modal, opened from the profile drawer for the canonical
 *     character, finds candidate chapters whose `characters` map is keyed by
 *     the canonical id — the same form `keyFor` resolves ticks to.
 *
 * The spec seeds a drift fixture via redux dispatches against the live
 * `window.__store__` after navigating to the 'ns' (Northern Star) Generate
 * view, then asserts on both the rendered UI and the slice state.
 *
 * Drift pair: canonical `the_torment`, drift variant `the-torment`, alias
 * map `{ 'the-torment': 'the_torment' }` — the exact shape the server's
 * `buildCastResolver` emits when a manuscript attribution id uses a hyphen
 * but the cast id uses an underscore (see book-state.test.ts lines 1380-1530,
 * chapters-slice.test.ts lines 1116-1250). */

import { test, expect, type Page } from '@playwright/test';
import { waitForRouteReady } from './helpers';

/* Serial mode: all three tests share the same navigate → seed pattern and
   the mock Vite server's transform cache is warm by the second test, so
   serial keeps the suite deterministic under parallel-worker contention
   (same rationale as generation-stuck-queued.spec.ts). */
test.describe.configure({ mode: 'serial' });

/* ── Drift fixture data ────────────────────────────────────────────── */

const CANONICAL_ID = 'the_torment';
const DRIFT_ID = 'the-torment';
const CHARACTER_NAME = 'The Torment';

/* Minimal BookStateJson for the manuscript-slice hydrate. The reducer
   only reads bookId / manuscriptId / title from `state`, so the rest is
   stubbed with valid-shaped defaults. Chapter 2 carries `audioModelKey`
   so it qualifies as a Fix-audio modal candidate after hydrate. */
const BOOK_STATE = {
  bookId: 'ns',
  manuscriptId: 'ns-mid',
  title: 'Northern Star',
  author: 'Spec Author',
  series: '',
  seriesPosition: null,
  isStandalone: true,
  manuscriptFile: 'ns.txt',
  castConfirmed: true,
  chapters: [
    { id: 1, title: 'Chapter 1', slug: 'ch-1' },
    { id: 2, title: 'Chapter 2', slug: 'ch-2', audioModelKey: 'kokoro-v1' },
  ],
  coverGradient: ['#1a1a2e', '#16213e'] as [string, string],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

/* Three sentences attributed to the drift variant 'the-torment' + one
   to 'narrator'. After alias resolution the canonical 'the_torment' row
   should read 3 lines / 9 words. */
const DRIFTED_SENTENCES = [
  { id: 1, chapterId: 1, text: 'The torment spoke first.', characterId: DRIFT_ID },
  { id: 2, chapterId: 1, text: 'The narrator set the scene.', characterId: 'narrator' },
  { id: 3, chapterId: 1, text: 'The torment spoke again.', characterId: DRIFT_ID },
  { id: 4, chapterId: 1, text: 'The torment laughed loudly.', characterId: DRIFT_ID },
];

const CAST_CHARACTERS = [
  { id: CANONICAL_ID, name: CHARACTER_NAME, role: 'antagonist', color: 'magenta', lines: 3 },
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', lines: 1 },
];

const ALIASES: Record<string, string> = { [DRIFT_ID]: CANONICAL_ID };

/* ── Store bridge ──────────────────────────────────────────────────── */

type StoreWin = {
  __store__?: {
    getState: () => {
      chapters: {
        chapters: Array<{
          id: number;
          state: string;
          characters: Record<string, string>;
          audioModelKey?: string;
        }>;
        characterIdAliases: Record<string, string>;
        currentBookId: string | null;
      };
      manuscript: { bookId: string | null; sentences: Array<{ id: number; characterId: string }> };
      cast: { characters: Array<{ id: string; name: string }> };
    };
    dispatch: (a: unknown) => void;
  };
};

/* Seed the drift fixture: hydrate chapters + manuscript sentences + cast
   with the canonical character and the alias map. Called after navigating
   to the Generate view so the redux store is already claimed for 'ns'. */
async function seedDriftFixture(page: Page): Promise<void> {
  await page.evaluate(
    ([state, sentences, characters, aliases, canonicalId]) => {
      const s = (window as unknown as StoreWin).__store__;
      if (!s) throw new Error('window.__store__ not exposed (e2e gate regressed)');

      /* Chapters: chapter 1 queued (for line-count + tick assertions),
         chapter 2 done with audioModelKey (Fix-audio modal candidate).
         `chapterCharacters` seeds each chapter's `characters` map with
         ONLY the canonical ids — the same form `keyFor` resolves ticks
         to, so the tick's drifted id finds a match in the map. */
      s.dispatch({
        type: 'chapters/hydrateFromBookState',
        payload: {
          bookId: 'ns',
          chapters: state.chapters,
          completedSlugs: ['ch-2'],
          characters,
          chapterCharacters: { 1: [canonicalId, 'narrator'], 2: [canonicalId] },
          characterIdAliases: aliases,
        },
      });

      /* Manuscript: sentences attributed to the DRIFT variant so the
         Generate view's `aliasedSentences` memo must rewrite them
         before `characterStatsByChapter` builds the per-character
         line/word counts. */
      s.dispatch({
        type: 'manuscript/hydrateFromBookState',
        payload: { state, sentences, wordCount: 40 },
      });

      /* Cast: the canonical characters so the profile drawer and
         Fix-audio modal can resolve the character name + id. */
      s.dispatch({
        type: 'cast/hydrateCharacters',
        payload: characters,
      });
    },
    [BOOK_STATE, DRIFTED_SENTENCES, CAST_CHARACTERS, ALIASES, CANONICAL_ID] as const,
  );
}

/* Read a character's per-chapter status from the chapters slice. */
async function characterStatus(
  page: Page,
  chapterId: number,
  cid: string,
): Promise<string | undefined> {
  return page.evaluate(
    ([chId, charId]) => {
      const s = (window as unknown as StoreWin).__store__;
      const ch = s?.getState().chapters.chapters.find((c) => c.id === chId);
      return ch?.characters[charId];
    },
    [chapterId, cid] as const,
  );
}

/* ── Tests ─────────────────────────────────────────────────────────── */

test.describe('#3440 — drifted-id canonicalisation', () => {
  test.beforeEach(async ({ page }) => {
    /* Navigate to the Northern Star Generate view. 'ns' is the mock
       book in 'generating' state (library.ts) — its Generate route is
       directly reachable via URL hash. */
    await page.goto('/#/books/ns/generate');
    await waitForRouteReady(page);

    /* Wait for the Layout's per-book hydration effect to complete before
       seeding our drift fixture — otherwise the mock book-state hydrate
       could overwrite our dispatches.

       We poll manuscript.bookId (not chapters.length) because the 'ns'
       mock returns chapters: [] (empty) — the chapters slice hydrates
       but with 0 entries. The manuscript slice DOES hydrate with
       bookId='ns' / manuscriptId='mns_ns' once the Layout's effect has
       dispatched hydrateFromBookState, which is the signal we need. */
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = (window as unknown as StoreWin).__store__;
            return s?.getState().manuscript.bookId ?? null;
          }),
        { timeout: 10_000, message: 'manuscript slice should hydrate from mock book-state (bookId=ns)' },
      )
      .toBe('ns');

    await seedDriftFixture(page);
  });

  /* Acceptance criterion 1: drifted sentence line counts render under the
     canonical character. The `aliasedSentences` memo in generation.tsx
     (line 804) rewrites `the-torment` → `the_torment` before
     `characterStatsByChapter` builds the per-character map. The expanded
     chapter-1 row should show "3 lines" for The Torment and "1 line" for
     Narrator. */
  test('drifted sentence line counts render under the canonical cast row', async ({ page }) => {
    /* Expand chapter 1 — the first button in #chapter-1 is the
       collapse/expand toggle (same pattern as generation-stuck-queued). */
    await page.locator('#chapter-1 button').first().click();

    /* The canonical character name should be visible in the expanded row. */
    await expect(page.locator('#chapter-1').getByText(CHARACTER_NAME)).toBeVisible({
      timeout: 5_000,
    });

    /* 3 lines attributed to the drift variant → aliased to canonical.
       The stat line reads "3 lines · 9 words" (or similar word count). */
    await expect(page.locator('#chapter-1').getByText(/3 lines/)).toBeVisible({
      timeout: 5_000,
    });

    /* The narrator row should show 1 line (the non-drifted sentence). */
    await expect(page.locator('#chapter-1').getByText(/1 line/)).toBeVisible({
      timeout: 5_000,
    });

    /* Verify the alias map landed in the slice — the canonical key the
       expanded row is rendering exists in the chapter's characters map. */
    const sliceState = await page.evaluate(
      ([canonicalId, driftId]) => {
        const s = (window as unknown as StoreWin).__store__;
        const ch1 = s?.getState().chapters.chapters.find((c) => c.id === 1);
        return {
          canonicalStatus: ch1?.characters[canonicalId],
          driftStatus: ch1?.characters[driftId],
          alias: s?.getState().chapters.characterIdAliases[driftId],
        };
      },
      [CANONICAL_ID, DRIFT_ID] as const,
    );
    expect(sliceState.canonicalStatus).toBe('queued');
    expect(sliceState.driftStatus).toBeUndefined();
    expect(sliceState.alias).toBe(CANONICAL_ID);
  });

  /* Acceptance criterion 2: an SSE progress tick carrying the drift
     variant resolves to the canonical cast row via `keyFor` and highlights
     it as "Generating…", while the narrator row stays "Queued". */
  test('SSE progress tick with drifted id highlights the canonical row', async ({ page }) => {
    /* Expand chapter 1 to see per-character status text. */
    await page.locator('#chapter-1 button').first().click();
    await expect(page.locator('#chapter-1').getByText(CHARACTER_NAME)).toBeVisible({
      timeout: 5_000,
    });

    /* Before the tick, both characters are "Queued". */
    await expect(page.locator('#chapter-1').getByText('Queued').first()).toBeVisible({
      timeout: 5_000,
    });

    /* Dispatch a progress tick with the DRIFT variant id. The slice's
       `keyFor(s.characterIdAliases, ch.characters, ev.characterId)` at
       chapters-slice.ts:652 must resolve 'the-torment' → 'the_torment'
       before updating the character status. */
    await page.evaluate(
      ([chId, driftId]) => {
        const s = (window as unknown as StoreWin).__store__;
        if (!s) throw new Error('window.__store__ not exposed');
        s.dispatch({
          type: 'chapters/applyGenerationTick',
          payload: {
            type: 'progress' as const,
            chapterId: chId,
            characterId: driftId,
            progress: 0.25,
            currentLine: 1,
            totalLines: 4,
          },
        });
      },
      [1, DRIFT_ID] as const,
    );

    /* The canonical character's status should flip to 'in_progress'
       (the tick's drifted id was resolved through the alias map). */
    await expect
      .poll(
        () => characterStatus(page, 1, CANONICAL_ID),
        { timeout: 5_000, message: 'canonical character should be in_progress after tick' },
      )
      .toBe('in_progress');

    /* The narrator should stay 'queued' — only the resolved canonical
       character was promoted. */
    expect(await characterStatus(page, 1, 'narrator')).toBe('queued');

    /* The UI should render "Generating…" for the canonical row. */
    await expect(page.locator('#chapter-1').getByText('Generating…')).toBeVisible({
      timeout: 5_000,
    });
  });

  /* Acceptance criterion 3: the Fix-audio modal, opened from the profile
     drawer for the canonical character, finds candidate chapters whose
     `characters` map is keyed by the canonical id (chapter 2 is done
     with `audioModelKey`). */
  test('Fix-audio modal opens with candidate chapters for the canonical character', async ({
    page,
  }) => {
    /* Open the profile drawer for the canonical character via a direct
       redux dispatch (the drawer is a Layout-level component reachable
       from any view once openProfileId is set). */
    await page.evaluate((cid) => {
      const s = (window as unknown as StoreWin).__store__;
      if (!s) throw new Error('window.__store__ not exposed');
      s.dispatch({ type: 'ui/setOpenProfileId', payload: cid });
    }, CANONICAL_ID);

    /* The fs-26 "Fix audio" affordance in the profile drawer. The button
       text uses the character's first name: "Fix The's audio (loudness /
       re-record)". */
    const fixBtn = page.getByRole('button', {
      name: /Fix .*audio \(loudness \/ re-record\)/i,
    });
    await expect(fixBtn).toBeVisible({ timeout: 5_000 });
    await fixBtn.click();

    /* The modal should open in remix mode (default). */
    await expect(page.getByText(/Boost a too-quiet voice/i)).toBeVisible({
      timeout: 5_000,
    });

    /* Dismiss the drawer behind the modal so its footer can't overlap
       the Apply button (same technique as character-splice.spec.ts). */
    await page.evaluate(() => {
      (window as unknown as StoreWin).__store__?.dispatch({
        type: 'ui/setOpenProfileId',
        payload: null,
      });
    });

    /* The Apply button should be visible and enabled — chapter 2 is
       done + has audioModelKey + has the_torment in its characters map,
       so it qualifies as a candidate. The text reads
       "Apply to 1 chapter" (singular for count === 1). */
    const apply = page.getByRole('button', { name: /Apply to \d+ chapters?/i });
    await expect(apply).toBeVisible({ timeout: 5_000 });
    await expect(apply).toBeEnabled();
    await expect(apply).toHaveText(/Apply to 1 chapter/i);
  });
});
