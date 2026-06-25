/* fs-58 — browser-level proof of the per-chapter LLM script-review flow:
 *
 * Unit A (strip_tag):
 *  1. Open the Solway Bay fixture book to the manuscript view.
 *  2. Click the per-chapter "Review Script" button.
 *  3. The ScriptReviewDiff modal opens showing the mock strip_tag suggestion.
 *  4. Accept (Apply) — sentence id:1 gets text "x".
 *  5. Navigate to the Generate view — chapter 3 shows the stale badge
 *     because a boundary_move was logged after its audioRenderedAt.
 *
 * Unit B (reattribute + flag_nonstory):
 *  1. Same setup as Unit A.
 *  2. Opt-in to the reattribute + flag_nonstory class-toggles (default OFF).
 *  3. Apply (4 ops selected) → confirm-reattribute dialog for "Ferra".
 *  4. Submit create-character — off-roster create→reassign runs.
 *  5. Assert: "p. 42" sentence is struck in manuscript, "Ferra" in cast,
 *     chapter 3 stale in Generate view.
 *
 * Mock contract: `mockReviewScript` emits five ops across two chapters:
 *   ch3 strip_tag      id:1   (default ON)
 *   ch1 strip_tag      id:1   (default ON)
 *   ch1 validate_instruct id:1 (quarantined at seed — no existing instruct; not counted)
 *   ch3 reattribute    id:3   proposed «Ferra» (default OFF — off-roster, higher risk)
 *   ch3 flag_nonstory  id:15  (default OFF — higher risk)
 * `initialSentences` seeds all targets in chapterId:3. */

import { test, expect } from '@playwright/test';

type Store = {
  getState: () => {
    chapters: {
      chapters: Array<{
        id: number;
        state: string;
        audioRenderedAt?: string;
      }>;
    };
    manuscript: {
      sentences: Array<{ id: number; chapterId: number; text: string; excludeFromSynthesis?: boolean }>;
    };
    cast: {
      characters: Array<{ id: string; name: string }>;
    };
  };
  dispatch: (action: unknown) => void;
};

/* Unit A — serial: the store-injection and stale-badge assertion depend on a
   specific chapter state; run sequentially so parallel workers can't
   collide on the same in-memory Vite dev server mock state. */
test.describe('fs-58 — script-review per-chapter accept flow', () => {
  test.describe.configure({ mode: 'serial' });

  test('modal opens → accept → sentence updated → stale badge in Generate', async ({ page }) => {
    /* Navigate directly to the Solway Bay fixture book manuscript view.
       SB is the fixture with 18 done chapters, populated by buildSolwayBayMockState.
       The manuscript slice uses initialSentences (chapterId: 3 for id:1) because
       SB's manuscriptEdits is null.
       READY_DEFAULTS seeds currentChapterId = 3, so the "per-chapter" review
       targets chapter 3. */
    await page.goto('/#/books/sb/manuscript');

    /* Wait for the manuscript view to hydrate — the chapter heading (h1) for
       chapter 3 is our hydration signal. */
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* Inject a past audioRenderedAt on chapter 3 so the stale gate trips
       after the boundary_move from Accept. The time must predate the
       boundary_move we're about to trigger; using a 2-hour-old ISO string
       is safely in the past. */
    const pastRenderedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await page.evaluate((renderedAt) => {
      const store = (window as unknown as { __store__: Store }).__store__;
      const chapters = store.getState().chapters.chapters;
      const patched = chapters.map((c) =>
        c.id === 3 ? { ...c, state: 'done', audioRenderedAt: renderedAt } : c,
      );
      store.dispatch({ type: 'chapters/setChapters', payload: patched });
    }, pastRenderedAt);

    /* Click the per-chapter "Review Script" button. The mock resolves in ~60 ms.
       The button label flips to "Reviewing…" then back; wait for the modal. */
    const reviewBtn = page.getByTestId('review-script-chapter');
    await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();

    /* The ScriptReviewDiff modal opens once mockReviewScript resolves and
       setReview lands in the store. The modal header is the hydration signal. */
    await expect(page.getByRole('heading', { name: /Script review suggestions/i })).toBeVisible({
      timeout: 10_000,
    });

    /* The mock op is strip_tag: the class heading "Strip tag" should be visible. */
    await expect(page.getByText(/Strip tag/i)).toBeVisible();

    /* The "Apply N selected" button — 2 ops selected by default (strip_tag on
       ch3:id1 + strip_tag on ch1:id1). The mock also emits a validate_instruct
       REPAIR op on ch1:id1, but planApply quarantines it at seed time because
       sentence id:1 has no existing instruct (repair needs an existing, different
       instruct to be appliable). The reattribute + flag_nonstory ops default OFF. */
    const applyBtn = page.getByTestId('apply-button');
    await expect(applyBtn).toBeVisible();
    await expect(applyBtn).toContainText(/Apply 2 selected/i);

    /* Accept: click Apply → dispatchAcceptedOps fires setSentenceText on
       sentence id:1 (chapterId:3) with newText:"x" and bumpBoundaryMove for
       chapterId:3 at a timestamp AFTER the injected pastRenderedAt. */
    await applyBtn.click();

    /* Modal should close after Apply. */
    await expect(
      page.getByRole('heading', { name: /Script review suggestions/i }),
    ).toBeHidden({ timeout: 5_000 });

    /* Assert the sentence text was updated. Sentence id:1 lives in chapterId:3;
       `dispatchAcceptedOps` dispatches setSentenceText with newText: 'x'. */
    const sentenceUpdated = await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      const s = store.getState().manuscript.sentences.find((s) => s.id === 1 && s.chapterId === 3);
      return s?.text === 'x';
    });
    expect(sentenceUpdated, 'sentence id:1 text should be "x" after accept').toBe(true);

    /* Navigate to the Generate view. The stale badge for chapter 3 should be
       visible because a boundary_move was logged for chapterId:3 AFTER
       pastRenderedAt, satisfying isChapterStaleFromReassign. */
    await page.goto('/#/books/sb/generate');

    /* Wait for the Generate view to hydrate — CH 03 appears once chapters load. */
    await expect(page.getByText(/^CH 03$/)).toBeVisible({ timeout: 10_000 });

    /* The stale badge is a span with "⚠ Sentences reassigned · regenerate to refresh"
       visible beneath the chapter 3 row. */
    await expect(
      page.getByText(/Sentences reassigned.*regenerate to refresh/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});

/* Unit B — independent describe block so it runs regardless of Unit A's status.
   fs-58 Unit B — off-roster reattribute + flag_nonstory golden path.
   Verifies:
     (a) flag_nonstory excluded sentence renders line-through in manuscript
     (b) off-roster reattribute creates "Ferra" in the cast
     (c) chapter 3 is stale (boundary_move after audioRenderedAt) in Generate */
test.describe('fs-58 Unit B — reattribute + flag_nonstory accept flow', () => {
  test('Unit B: accept off-roster reattribute + flag_nonstory (fs-58)', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');

    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* Pre-seed chapter 3 as done with a past audioRenderedAt so the stale
       gate trips after the boundary_move ops that Apply emits. */
    const pastRenderedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await page.evaluate((renderedAt) => {
      const store = (window as unknown as { __store__: Store }).__store__;
      const chapters = store.getState().chapters.chapters;
      const patched = chapters.map((c) =>
        c.id === 3 ? { ...c, state: 'done', audioRenderedAt: renderedAt } : c,
      );
      store.dispatch({ type: 'chapters/setChapters', payload: patched });
    }, pastRenderedAt);

    /* Open the review modal. */
    const reviewBtn = page.getByTestId('review-script-chapter');
    await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();

    await expect(page.getByRole('heading', { name: /Script review suggestions/i })).toBeVisible({
      timeout: 10_000,
    });

    /* The reattribute and flag_nonstory class toggles are DEFAULT OFF (higher-risk
       classes opt-in). Check them to include these ops in the Apply set. */
    const reattributeToggle = page.getByTestId('class-toggle-reattribute');
    const flagNonstoryToggle = page.getByTestId('class-toggle-flag_nonstory');
    await expect(reattributeToggle).toBeVisible();
    await expect(flagNonstoryToggle).toBeVisible();
    await reattributeToggle.check();
    await flagNonstoryToggle.check();

    /* Now 4 ops are selected (strip_tag ch3 + strip_tag ch1 + reattribute + flag_nonstory).
       The mock's validate_instruct on ch1:id1 is quarantined at seed time (no existing
       instruct on that sentence), so it does not count. */
    const applyBtn = page.getByTestId('apply-button');
    await expect(applyBtn).toContainText(/Apply 4 selected/i);
    await applyBtn.click();

    /* The off-roster reattribute triggers the confirm-reattribute dialog.
       The CreateCharacterForm is pre-filled with «Ferra» from the proposed field.
       Clicking create-character-submit accepts the default and triggers
       api.createCharacter → addCharacter → setSentenceCharacter. */
    await expect(page.getByTestId('confirm-reattribute')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('create-character-submit').click();

    /* The confirm queue is exhausted → runProposed resolves → clearReview fires
       → the diff modal and confirm overlay both unmount. */
    await expect(
      page.getByRole('heading', { name: /Script review suggestions/i }),
    ).toBeHidden({ timeout: 8_000 });

    /* (a) The "p. 42" sentence (id:15, chapterId:3) should now have
       excludeFromSynthesis:true → the sentence span (data-sentence-id="15")
       renders with `line-through opacity-50` classes. The text lives in an
       inner span (data-text-offset="0"), so we get the text span's parent
       (the sentence span) to check the class. */
    const excludedTextSpan = page.getByText('p. 42');
    await expect(excludedTextSpan).toBeVisible({ timeout: 5_000 });
    const excludedSentenceSpan = excludedTextSpan.locator('..');
    await expect(excludedSentenceSpan).toHaveClass(/line-through/);

    /* (b) Ferra was created and dispatched via addCharacter → verify via store. */
    const ferraInCast = await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      return store.getState().cast.characters.some((c) => c.name === 'Ferra');
    });
    expect(ferraInCast, '"Ferra" should be in the cast after off-roster reattribute').toBe(true);

    /* Navigate to the Cast view to visually confirm "Ferra" is rendered.
       Use first() to avoid strict-mode violation when the name appears
       in both the card heading and a subtext (e.g. role label). */
    await page.goto('/#/books/sb/cast');
    await expect(page.getByText('Ferra').first()).toBeVisible({ timeout: 8_000 });

    /* (c) Chapter 3 is stale: boundary_move was emitted for chapterId:3 after
       pastRenderedAt → isChapterStaleFromReassign returns true in the Generate view. */
    await page.goto('/#/books/sb/generate');
    await expect(page.getByText(/^CH 03$/)).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/Sentences reassigned.*regenerate to refresh/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});

/* fs-63 — auto-voice a created off-roster character.
   On a Qwen project, the off-roster reattribute that mints "Ferra" surfaces a
   sticky "Design now" nudge; tapping it enqueues bespoke design (the design job
   activates — pill "Designing"/"Designed N" + the cast-design-done toast). On a
   preset-engine project no nudge would fire (covered by the unit tests). */
test.describe('fs-63 — off-roster auto-voice nudge', () => {
  test('Qwen project: off-roster create surfaces a Design-now nudge that kicks design', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* Put the project on Qwen so the nudge gate (engineForModelKey === 'qwen')
       passes. setTtsModelKey flips ttsModelKeyExplicit, so the default-seed
       effect won't overwrite it. */
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      store.dispatch({ type: 'ui/setTtsModelKey', payload: 'qwen3-tts-0.6b' });
    });

    /* Open review, opt into the off-roster reattribute class, apply. */
    const reviewBtn = page.getByTestId('review-script-chapter');
    await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();
    await expect(page.getByRole('heading', { name: /Script review suggestions/i })).toBeVisible({
      timeout: 10_000,
    });

    const reattributeToggle = page.getByTestId('class-toggle-reattribute');
    await expect(reattributeToggle).toBeVisible();
    await reattributeToggle.check();

    await page.getByTestId('apply-button').click();

    /* Confirm the off-roster create of «Ferra». */
    await expect(page.getByTestId('confirm-reattribute')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('create-character-submit').click();

    /* fs-63 — a sticky "Design now" nudge appears for the newly-created Ferra. */
    const designNow = page.getByRole('button', { name: /design now/i });
    await expect(designNow).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/Ferra.*needs a voice/i)).toBeVisible();

    /* Tapping enqueues bespoke design → the design job activates. The mock
       streams onProgress → onCharacterDesigned → onIdle, the last of which
       pushes a "Designed 1." summary toast (viewport-independent, lingers ~5s),
       so a "design(ing|ed)" match is race-free. "Design now" itself does not
       match this regex (no ing/ed), and the nudge is dismissed on tap. */
    await designNow.click();
    await expect(page.getByText(/design(ing|ed)/i)).toBeVisible({ timeout: 8_000 });
  });
});
