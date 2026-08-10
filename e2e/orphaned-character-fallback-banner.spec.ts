/* #2023 Piece 1, split #2040 Task 17 — the orphaned-characterId advisory
 * banner on the Cast view.
 *
 * When a rendered sentence group carries a characterId with no entry in the
 * book's cast at all (a cast/analysis id drift — e.g. a romanisation
 * mismatch), the server falls back to the narrator's voice for that line and
 * records the substitution (server/src/tts/synthesise-chapter.ts's
 * `renderedFallbackCharacterId`, aggregated by
 * `collectOrphanedCharacterFallbacks` into the book-state GET's
 * `orphanedCharacterFallbacks` map). Before this fix nothing on the wire ever
 * named the substitution — the render only logged it once per orphan id.
 *
 * Task 17 split the banner into two sections: AUTO-RECONCILED (the orphaned
 * id resolved through the id-history side-table or a normalised-key match —
 * informational, collapsed by default) and NEEDS-YOUR-DECISION (a genuine
 * miss — actionable, always expanded). Either section's "not the same
 * character" button rejects the match durably (server writes a `rejected`
 * entry in cast-id-history.json + a one-sided notLinkedTo edge).
 *
 * Mirrors `e2e/generation/coqui-fallback-non-english.spec.ts`'s established
 * pattern for this exact class of render-time fact: mock-mode generation has
 * no per-character/per-line engine or attribution model, so it can never
 * produce `orphanedCharacterFallbacks` by actually walking a mock render
 * (server-side render contract is pinned by
 * `server/src/tts/synthesise-chapter.test.ts` and
 * `server/src/routes/book-state.test.ts` instead). What e2e CAN and does
 * assert directly is the resulting UI: dispatching the real
 * `cast/setOrphanedCharacterFallbacks` reducer (src/store/cast-slice.ts) —
 * the exact action the book-state GET's hydration path fires
 * (src/components/layout.tsx) — and checking the advisory banner
 * (src/views/cast.tsx) actually renders. This crosses the redux/component
 * seam (store.dispatch through to rendered DOM) at real browser layout/focus
 * timing, going beyond a jsdom unit test — but NOT the layout.tsx hydration
 * seam itself: the spec dispatches the reducer directly rather than driving
 * it through Layout's own getBookState hydrate effect, so it cannot catch a
 * regression in THAT wiring (see `src/components/layout.test.tsx`'s
 * "orphaned-characterId fallback banner (#2023)" describe block for the test
 * that pins layout.tsx's dispatch itself).
 *
 * The reject flow goes through mock mode's `api.rejectOrphanMatch`
 * (`mockRejectOrphanMatch` in src/lib/api.ts) — a canned success response
 * with no real cast.json/cast-id-history.json to inspect, so this spec
 * asserts only the resulting DOM/redux state, not server-side persistence
 * (server/src/routes/cast-reject-orphan.test.ts owns that). */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/* Confirm the cast (fe-46: confirm lands on Cast first) without continuing
   on to the manuscript route, so the spec stays on `#/books/:id/cast` where
   the advisory banner lives. */
async function reachCastView(page: Page): Promise<void> {
  await goToConfirm(page);
  await page.getByRole('button', { name: /Confirm cast and design voices/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/cast/, { timeout: 5_000 });
  await waitForRouteReady(page);
}

/* Directly dispatches the real `cast/setOrphanedCharacterFallbacks` reducer —
   the same render-time fact the server's `collectOrphanedCharacterFallbacks`
   (server/src/audio/segments-io.ts) aggregates for real, which mock-mode
   generation has no way to reproduce (see header). Carries the real
   post-Task-17 shape (`resolution`/`resolvedCharacterId`/`segments`,
   `audioCurrent` since Task 7/#2129), mirroring
   coqui-fallback-non-english.spec.ts's `seedRenderedCoquiFallback`. One
   auto-reconciled entry ('mayrin' → 'narrator', audio current) and one
   needs-your-decision entry ('coalfall', unresolved) — both banner sections
   at once. */
async function seedOrphanedFallback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __store__: { dispatch(a: unknown): void } }).__store__;
    store.dispatch({
      type: 'cast/setOrphanedCharacterFallbacks',
      payload: {
        mayrin: {
          resolution: 'alias',
          resolvedCharacterId: 'narrator',
          segments: 6,
          audioCurrent: 'true',
        },
        coalfall: {
          resolution: 'unresolved',
          segments: 13,
          audioCurrent: 'false',
        },
      },
    });
  });
}

/* #2129, widened by I2 (fix round, #2163) — a second seed with both
   non-exact resolution tiers represented, so the "resolves now — may still
   need a re-render" note can be pinned against a real 'normalised' row too
   (see src/views/cast.tsx's own comment on the `info.resolution !==
   'unresolved'` gate: both 'alias' and 'normalised' carry it — #2107's
   ruling is that only 'exact' means the rendered bytes are fine, and this
   section never shows an 'exact' row). Both rows carry `audioCurrent: 'true'`
   so they land in the SAME (current) audio-currency section — this seed
   pins the per-row resolution-based note, not the #2129 bucket split
   itself (see `seedOrphanedFallbackMixedCurrency` below for that). */
async function seedOrphanedFallbackWithNormalised(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __store__: { dispatch(a: unknown): void } }).__store__;
    store.dispatch({
      type: 'cast/setOrphanedCharacterFallbacks',
      payload: {
        mayrin: {
          resolution: 'alias',
          resolvedCharacterId: 'narrator',
          segments: 6,
          audioCurrent: 'true',
        },
        Mayrin_: {
          resolution: 'normalised',
          resolvedCharacterId: 'narrator',
          segments: 2,
          audioCurrent: 'true',
        },
      },
    });
  });
}

/* #2129 — one row per audio-currency bucket, so both auto-reconciled
   sections render simultaneously (mirrors the frontend unit test's
   "splits the auto-reconciled disclosure by audio currency" fixture). */
async function seedOrphanedFallbackMixedCurrency(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __store__: { dispatch(a: unknown): void } }).__store__;
    store.dispatch({
      type: 'cast/setOrphanedCharacterFallbacks',
      payload: {
        fine: {
          resolution: 'alias',
          resolvedCharacterId: 'narrator',
          segments: 6,
          audioCurrent: 'true',
        },
        stale: {
          resolution: 'alias',
          resolvedCharacterId: 'narrator',
          segments: 67,
          audioCurrent: 'false',
        },
      },
    });
  });
}

test.describe('cast view — orphaned-characterId advisory banner (#2023, split #2040 Task 17)', () => {
  test('shows both sections once the book-state hydrate carries orphaned-id substitutions', async ({
    page,
  }) => {
    await reachCastView(page);

    /* No substitution yet — the banner is absent. */
    await expect(page.getByTestId('orphaned-character-fallback-banner')).toHaveCount(0);

    await seedOrphanedFallback(page);

    const banner = page.getByTestId('orphaned-character-fallback-banner');
    await expect(banner).toBeVisible({ timeout: 5_000 });

    /* needs-your-decision is expanded by default, naming the unresolved id
       and its segment count. */
    const needsDecision = page.getByTestId('orphaned-needs-decision');
    await expect(needsDecision).toContainText('coalfall');
    await expect(needsDecision).toContainText('13 segment');

    /* auto-reconciled is collapsed by default — the list is absent until
       the toggle is clicked. */
    await expect(page.getByTestId('orphaned-auto-reconciled-current')).toHaveCount(0);
    await page.getByRole('button', { name: /character id.*auto-reconciled/i }).click();
    const autoReconciled = page.getByTestId('orphaned-auto-reconciled-current');
    await expect(autoReconciled).toBeVisible();
    await expect(autoReconciled).toContainText('mayrin');
    await expect(autoReconciled).toContainText('6 segment');
  });

  test('rejecting an auto-reconciled match moves it into needs-your-decision', async ({ page }) => {
    await reachCastView(page);
    await seedOrphanedFallback(page);

    await page.getByRole('button', { name: /character id.*auto-reconciled/i }).click();
    const row = page.getByTestId('orphaned-row-mayrin');
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: /not the same character/i }).click();

    /* The rejected row drops out of auto-reconciled and reappears, unresolved,
       under needs-your-decision (now showing 2 entries). */
    await expect(page.getByTestId('orphaned-needs-decision')).toContainText('mayrin', {
      timeout: 5_000,
    });
  });

  test('needs-your-decision: the reject button stays disabled until a candidate is picked', async ({
    page,
  }) => {
    await reachCastView(page);
    await seedOrphanedFallback(page);

    const row = page.getByTestId('orphaned-row-coalfall');
    const rejectButton = row.getByRole('button', { name: /not the same character/i });
    await expect(rejectButton).toBeDisabled();

    await row.getByRole('combobox').selectOption({ label: 'Narrator' });
    await expect(rejectButton).toBeEnabled();
  });

  /* #2092/#2089 — pair-scoped reject + undo. Mock mode's rejectOrphanMatch
     always returns `resolution: null` (D2's ordinary outcome — mirrors the
     real server's typical case for an id that has nothing else to resolve
     onto), so a needs-your-decision reject leaves the row exactly where it
     is; the chip is the only visible change. */
  test('rejecting a needs-your-decision row leaves it in place and renders its "Not …" chip', async ({
    page,
  }) => {
    await reachCastView(page);
    await seedOrphanedFallback(page);

    const row = page.getByTestId('orphaned-row-coalfall');
    await row.getByRole('combobox').selectOption({ label: 'Narrator' });
    await row.getByRole('button', { name: /not the same character/i }).click();

    /* Still in needs-your-decision — a genuine miss stays a genuine miss. */
    await expect(page.getByTestId('orphaned-needs-decision')).toContainText('coalfall', {
      timeout: 5_000,
    });
    await expect(row.getByText('Not Narrator')).toBeVisible();
    await expect(row.getByRole('button', { name: /undo/i })).toBeVisible();
  });

  /* Mock mode's undoRejectOrphanMatch (M5, review round 2 — now honest
     about `wasRejected` per-session, tracking real reject/undo state
     instead of always claiming success) echoes back the `characterId` it
     was called with as `resolvedCharacterId` (with `resolution: 'history'`,
     collapsing to 'alias' in the frontend's own banner taxonomy) — the
     common/lossless real-server case — ONLY when the SAME
     (bookId, characterId, orphanedId) tuple was actually rejected first,
     which the reject below does, and exactly what restores 'mayrin' to
     auto-reconciled → 'narrator' here, since that's the same target the
     reject used. */
  test('clicking Undo on a rejected row removes the chip and returns an auto-reconciled row to its section', async ({
    page,
  }) => {
    await reachCastView(page);
    await seedOrphanedFallback(page);

    await page.getByRole('button', { name: /character id.*auto-reconciled/i }).click();
    const autoRow = page.getByTestId('orphaned-row-mayrin');
    await autoRow.getByRole('button', { name: /not the same character/i }).click();

    const movedRow = page.getByTestId('orphaned-needs-decision').getByTestId('orphaned-row-mayrin');
    await expect(movedRow).toBeVisible({ timeout: 5_000 });
    await expect(movedRow.getByText('Not Narrator')).toBeVisible();

    await movedRow.getByRole('button', { name: /undo/i }).click();

    /* The chip is gone and the row is back under auto-reconciled — but in
       the STALE section, not the section it started in: applyOrphanRejection/
       undoOrphanRejection (src/store/cast-slice.ts) always write
       `audioCurrent: 'unknown'` on a reject/undo (Task 7's fail-closed
       placeholder — neither reducer has the history/segments data to
       compute a real verdict), and `'unknown'` buckets with "needs a
       re-render", never with "current" (#2129's Global Constraint 4). The
       stale section's own disclosure was never toggled, so open it before
       reading its content. */
    await expect(page.getByTestId('orphaned-needs-decision')).not.toContainText('mayrin', {
      timeout: 5_000,
    });
    await page.getByRole('button', { name: /character id.*auto-reconciled.*re-render/i }).click();
    const autoReconciled = page.getByTestId('orphaned-auto-reconciled-stale');
    await expect(autoReconciled).toContainText('mayrin');
    await expect(autoReconciled.getByText('Not Narrator')).toHaveCount(0);
  });

  /* #2238 — the needs-your-decision row's positive action. Mock mode's
     `linkOrphanMatch` (`mockLinkOrphanMatch` in src/lib/api.ts) always
     resolves the pair (`resolution: 'history'`, `resolvedCharacterId` =
     whatever candidate was picked) — the canned success case, mirroring how
     the sibling reject spec above treats mock mode's canned response as the
     boundary and leaves server-side persistence to
     server/src/routes/cast-link-orphan.test.ts. */
  test('linking a needs-your-decision row to a picked candidate moves it into auto-reconciled (stale — a link resets audio currency)', async ({
    page,
  }) => {
    await reachCastView(page);
    await seedOrphanedFallback(page);

    const row = page.getByTestId('orphaned-row-coalfall');
    const linkButton = row.getByRole('button', { name: /link to this character/i });
    await expect(linkButton).toBeDisabled();

    await row.getByRole('combobox').selectOption({ label: 'Narrator' });
    await expect(linkButton).toBeEnabled();
    await linkButton.click();

    /* The row leaves needs-your-decision entirely (a link resolves it,
       unlike a reject on this section, which leaves it in place) — the
       section itself is conditionally mounted (see the "no substitution
       yet" case above), so the whole section disappears rather than
       shrinking to an empty list. */
    await expect(page.getByTestId('orphaned-needs-decision')).toHaveCount(0, { timeout: 5_000 });

    /* #2128/#2129 x #2238 (merge-reconciliation fix) — applyOrphanLink
       (src/store/cast-slice.ts) always resets audioCurrent to 'unknown' on
       a link, same fail-closed discipline as applyOrphanRejection/
       undoOrphanRejection: a link changes what the id resolves onto, so
       whatever currency verdict applied to its PRIOR ('unresolved') state is
       stale evidence. 'unknown' buckets with 'false' (#2129's Global
       Constraint 4), so the row lands in the STALE auto-reconciled section,
       not the current one — never the pre-#2129 single, unsplit section. */
    await page.getByRole('button', { name: /character id.*auto-reconciled.*re-render/i }).click();
    const autoReconciled = page.getByTestId('orphaned-auto-reconciled-stale');
    await expect(autoReconciled).toContainText('coalfall');
  });

  /* #2129, widened by I2 (fix round, #2163) — the banner must distinguish
     "resolves today" (auto-reconciled) from "the already-rendered audio is
     definitely fine". EVERY non-exact resolution shown in this section
     (`'alias'` — server tiers 'history'/'normalised-history' — AND
     `'normalised'` — server tier 'normalised-id') can be the exact damage
     `scripts/repair-cast-id-drift.mjs` lists as needing a re-render:
     register row A32's own real fixture (`docs/testing/onbox-acceptance-
     register.md`) is `the-torment` (*Playing with Fire*, 67 segments),
     which resolves via the **normalised-id** tier — RC2's underscore-vs-
     hyphen split, no history entry involved at all — and was still
     narrator-rendered. #2107's ruling (same register, ~line 1508) is that
     only the `'exact'` tier means the rendered bytes are fine; this section
     never shows an `'exact'` row (an exact match isn't an orphan), so both
     resolutions it does show need the note. */
  test('every auto-reconciled row is marked "audio may still need a re-render", whether it resolved via alias or via a normalised id', async ({
    page,
  }) => {
    await reachCastView(page);
    await seedOrphanedFallbackWithNormalised(page);

    await page.getByRole('button', { name: /character ids.*auto-reconciled/i }).click();
    const autoReconciled = page.getByTestId('orphaned-auto-reconciled-current');
    await expect(autoReconciled).toBeVisible();

    const aliasNote = page.getByTestId('orphaned-alias-audio-note-mayrin');
    await expect(aliasNote).toBeVisible();
    await expect(aliasNote).toContainText(/resolves now/i);
    await expect(aliasNote).toContainText(/re-render/i);

    const normalisedNote = page.getByTestId('orphaned-alias-audio-note-Mayrin_');
    await expect(normalisedNote).toBeVisible();
    await expect(normalisedNote).toContainText(/resolves now/i);
    await expect(normalisedNote).toContainText(/re-render/i);
  });

  /* #2129 (Task 8) — the auto-reconciled disclosure splits into two
     sections by `audioCurrent`, each collapsed by default, each showing its
     own count in its own header — so the actionable count (rows whose
     audio needs a re-render) is legible without expanding anything. This
     crosses the redux/component seam at real browser layout/focus timing
     (CLAUDE.md's stated bar for a Playwright spec over jsdom), same as the
     rest of this file. */
  test('splits the auto-reconciled disclosure into two collapsed sections, each showing its own count (#2129)', async ({
    page,
  }) => {
    await reachCastView(page);
    await seedOrphanedFallbackMixedCurrency(page);

    const banner = page.getByTestId('orphaned-character-fallback-banner');
    await expect(banner).toBeVisible({ timeout: 5_000 });

    /* Both headers are readable WITHOUT clicking anything. */
    const currentHeader = page.getByRole('button', {
      name: /1 character id auto-reconciled — audio is current/i,
    });
    const staleHeader = page.getByRole('button', {
      name: /1 character id auto-reconciled — audio needs a re-render/i,
    });
    await expect(currentHeader).toBeVisible();
    await expect(staleHeader).toBeVisible();

    /* Still collapsed — the detail (segment count) stays inside. */
    await expect(page.getByTestId('orphaned-auto-reconciled-current')).toHaveCount(0);
    await expect(page.getByTestId('orphaned-auto-reconciled-stale')).toHaveCount(0);

    /* Expanding one section reveals only its own row. */
    await staleHeader.click();
    const staleSection = page.getByTestId('orphaned-auto-reconciled-stale');
    await expect(staleSection).toBeVisible();
    await expect(staleSection).toContainText('stale');
    await expect(staleSection).toContainText('67 segment');
    await expect(page.getByTestId('orphaned-auto-reconciled-current')).toHaveCount(0);
  });
});
