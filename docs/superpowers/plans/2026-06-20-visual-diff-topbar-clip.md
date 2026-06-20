# Visual-diff top-bar clip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch top-bar / branding-scale UI changes that currently slip under the 5% full-viewport visual-diff ratio, by adding a tightly-toleranced screenshot of the top-bar element only.

**Architecture:** A branding/logo change is ~1–2% of a 1280×720 viewport (under the 5% ratio) but a large fraction of a clipped ~64px `<header>`. Add a stock Playwright element screenshot of `getByRole('banner')` at a 1% tolerance (light + dark), plus a permanent negative proof and a CI count-guard fix. No new modules, no devDeps, no custom comparator.

**Tech Stack:** Playwright (`@playwright/test`), the existing `e2e/responsive/visual.spec.ts` suite, the `regen-visual-baselines.yml` GitHub Actions workflow.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-20-visual-diff-sensitivity-design.md` (rev 3).
- **Branch:** `chore/ops-visual-diff-contiguity` (already cut).
- **Baselines are per-platform AND per-project** — `snapshotPathTemplate` = `{snapshotDir}/{platform}/{testFilePath}/{projectName}/{arg}{ext}`. Windows (`win32`) baselines are blessed locally; Linux (`linux`) baselines are blessed ONLY by `regen-visual-baselines.yml` on Ubuntu.
- **Tolerance constant:** `TOPBAR_DIFF_RATIO = 0.01`.
- **Snapshot names:** `topbar.png` (light), `topbar-dark.png` (dark).
- **Selector:** `page.getByRole('banner')` (the real `<header>` at `src/components/top-bar.tsx:267`; `[data-topbar]` does NOT exist — do not use it).
- **Route:** the library route `/`.
- **Commit convention:** `<type>(<scope>): <subject>`; scope must be one of `frontend|server|sidecar|app|scripts|e2e|mocks|openapi|docs|deps|ci`. Use `test(e2e):` for the spec changes, `ci(ci):`/`chore(ci):` for the workflow, `docs(docs):` for backlog.
- **Commit message footer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01K6Ew9XcepEqNVc126nbfCK
  ```
- **No plan doc under `docs/features/`** — this is a small/localized change; the spec + paired tests are the spec (CLAUDE.md).

## File Structure

- **Modify** `e2e/responsive/visual.spec.ts` — add the `TOPBAR_DIFF_RATIO` constant, a light top-bar capture (in the `visual baselines` describe), a dark capture (in the `visual baselines (dark theme)` describe), and the negative-proof test; fix the stale "full-page / 14 specs" header comment.
- **Create** (blessed binaries, win32 only — Linux via workflow):
  `e2e/win32/responsive/visual.spec.ts/{chromium,mobile-chrome,tablet-chrome}/topbar.png`
  `e2e/win32/responsive/visual.spec.ts/{chromium,mobile-chrome,tablet-chrome}/topbar-dark.png`
- **Modify** `.github/workflows/regen-visual-baselines.yml` — count guard `-lt 42` → `-ne 51`; comment fixes.
- **Modify** `docs/BACKLOG.md` — thin row for the deferred follow-up.

---

### Task 1: Add the top-bar captures and bless Windows baselines

**Files:**
- Modify: `e2e/responsive/visual.spec.ts` (constant near line 90; light capture in the `visual baselines` describe ~line 92; dark capture in the `visual baselines (dark theme)` describe ~line 230)
- Create: `e2e/win32/responsive/visual.spec.ts/{chromium,mobile-chrome,tablet-chrome}/topbar.png` + `topbar-dark.png` (blessed)

**Interfaces:**
- Consumes: nothing.
- Produces: the constant `TOPBAR_DIFF_RATIO` and the snapshot names `topbar.png` / `topbar-dark.png`, used by Task 2.

- [ ] **Step 1: Add the tolerance constant**

In `e2e/responsive/visual.spec.ts`, immediately after the existing `VISUAL_DIFF_OPTS` declaration (~line 90), add:

```ts
/* #925 — top-bar clip gate. A branding/logo change is ~1-2% of the full
   1280x720 viewport (under VISUAL_DIFF_OPTS' 5%) but a large fraction of the
   clipped ~64px <header>, so a 1% tolerance on the element screenshot catches
   it. See docs/superpowers/specs/2026-06-20-visual-diff-sensitivity-design.md. */
const TOPBAR_DIFF_RATIO = 0.01;
```

- [ ] **Step 2: Add the light top-bar capture**

Inside the `test.describe('visual baselines', () => {` block (the light one, after the `generate` test ~line 160, before the closing `});`), add:

```ts
  test('top-bar (branding)', async ({ page }) => {
    await page.goto('/');
    /* The <header> carries the implicit ARIA banner role. */
    await expect(page.getByRole('banner')).toBeVisible({ timeout: 10_000 });
    /* Match the siblings' settle for staggered mount transitions. */
    await page.waitForTimeout(300);
    await expect(page.getByRole('banner')).toHaveScreenshot('topbar.png', {
      maxDiffPixelRatio: TOPBAR_DIFF_RATIO,
    });
  });
```

- [ ] **Step 3: Add the dark top-bar capture**

Inside the `test.describe('visual baselines (dark theme)', () => {` block (which already has the `beforeEach` seeding `persist:ui` to dark), after the `generate (dark)` test (~line 299, before the closing `});`), add:

```ts
  test('top-bar (branding, dark)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await expect(page.getByRole('banner')).toHaveScreenshot('topbar-dark.png', {
      maxDiffPixelRatio: TOPBAR_DIFF_RATIO,
    });
  });
```

- [ ] **Step 4: Bless the chromium baselines (the "make it pass" for a visual test)**

A visual baseline test "fails" the first time (no baseline → writes actual). Blessing creates the baseline; the next compare run passes. Bless only the new captures via `--grep`:

Run:
```bash
npm run test:e2e:visual -- --grep "top-bar" --update-snapshots
```
Expected: writes `e2e/win32/responsive/visual.spec.ts/chromium/topbar.png` and `topbar-dark.png`; output reports them as written/updated.

- [ ] **Step 5: Bless the mobile + tablet baselines**

The chromium-only `test:e2e:visual` script doesn't cover the other two projects; invoke Playwright directly:

Run:
```bash
npx playwright test --project=mobile-chrome --project=tablet-chrome --workers=1 \
  e2e/responsive/visual.spec.ts --grep "top-bar" --update-snapshots
```
Expected: writes `topbar.png` + `topbar-dark.png` under both `mobile-chrome/` and `tablet-chrome/` (4 more PNGs). Total new win32 PNGs: 6.

- [ ] **Step 6: Verify the captures pass in compare mode**

Run:
```bash
npm run test:e2e:visual -- --grep "top-bar"
```
Expected: PASS (2 passed — light + dark on chromium) with no `--update-snapshots`.

- [ ] **Step 7: Record self-noise (calibration sanity)**

Run the compare twice more back-to-back and confirm zero (or ≪1%) drift:
```bash
npm run test:e2e:visual -- --grep "top-bar"
npm run test:e2e:visual -- --grep "top-bar"
```
Expected: PASS both times. Note the result for the PR description (e.g. "chromium top-bar clip: 0 diff across 3 consecutive runs").

- [ ] **Step 8: Fix the stale header comment**

In `e2e/responsive/visual.spec.ts`, the file header (~lines 1–41) calls the captures "full-page" and references "seven core surfaces". Update the opening line and the count to reflect reality — viewport captures, and now 17 per project. Change the first sentence to:

```ts
/* Visual-regression baselines for the core surfaces (viewport captures, not
 * full-page — toHaveScreenshot defaults fullPage:false) plus a clipped top-bar
 * branding gate (#925).
 *
```
(Leave the rest of the header intact; this is a one-sentence correction, not a rewrite.)

- [ ] **Step 9: Commit**

```bash
git add e2e/responsive/visual.spec.ts e2e/win32/responsive/visual.spec.ts/
git commit -m "$(cat <<'EOF'
test(e2e): add clipped top-bar branding visual gate (#925)

A branding/logo change dilutes below the 5% full-viewport ratio but is a large
fraction of the clipped <header>, so a 1% element-screenshot tolerance catches
it. Adds light + dark top-bar captures (getByRole('banner')) and blesses win32
baselines across the three projects.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K6Ew9XcepEqNVc126nbfCK
EOF
)"
```

---

### Task 2: Add the permanent negative proof

**Files:**
- Modify: `e2e/responsive/visual.spec.ts` (in the `visual baselines` light describe, after the `top-bar (branding)` test)

**Interfaces:**
- Consumes: `TOPBAR_DIFF_RATIO` and the committed `topbar.png` baseline from Task 1.
- Produces: nothing.

- [ ] **Step 1: Write the negative-proof test**

Inside the `visual baselines` (light) describe, after the `top-bar (branding)` test, add. Note the `test.skip` guard — under `--update-snapshots` this test would otherwise overwrite `topbar.png` with the injected magenta state and corrupt the baseline:

```ts
  /* #925 — proves the top-bar gate actually catches a branding change, so a
     future loosening of TOPBAR_DIFF_RATIO can't silently re-open the gap.
     Skipped under --update-snapshots: in bless mode toHaveScreenshot would
     write the injected (magenta) capture over the real topbar.png baseline. */
  test('top-bar gate catches a branding repaint', async ({ page }, testInfo) => {
    test.skip(
      testInfo.config.updateSnapshots !== 'none',
      'compare-mode only — would overwrite topbar.png under --update-snapshots',
    );
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible({ timeout: 10_000 });
    /* Fixed-size repaint on the real header (top-bar.tsx:267) — a background
       swap, so no reflow (a reflow would change the element box and trip a
       size mismatch instead of the diff we want to prove). */
    await page.addStyleTag({ content: 'header.sticky { background: #f0f !important; }' });
    let threw = false;
    try {
      await expect(page.getByRole('banner')).toHaveScreenshot('topbar.png', {
        maxDiffPixelRatio: TOPBAR_DIFF_RATIO,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
```

- [ ] **Step 2: Run the negative proof — verify it PASSES**

Run:
```bash
npm run test:e2e:visual -- --grep "branding repaint"
```
Expected: PASS — the magenta header differs from the blessed `topbar.png` by far more than 1%, so `toHaveScreenshot` throws, `threw` is `true`, and the assertion holds.

- [ ] **Step 3: Verify the proof can FAIL (meaningful-test check)**

Temporarily change the negative test's `maxDiffPixelRatio: TOPBAR_DIFF_RATIO` to `maxDiffPixelRatio: 1` (allow up to 100% diff → never throws).

Run:
```bash
npm run test:e2e:visual -- --grep "branding repaint"
```
Expected: FAIL — `toHaveScreenshot` tolerates the change, `threw` stays `false`, `expect(threw).toBe(true)` fails. This confirms the proof exercises the gate rather than passing vacuously.

- [ ] **Step 4: Revert the temporary change**

Restore `maxDiffPixelRatio: 1` back to `maxDiffPixelRatio: TOPBAR_DIFF_RATIO`. Re-run to confirm PASS:
```bash
npm run test:e2e:visual -- --grep "branding repaint"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/responsive/visual.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): add permanent proof the top-bar gate catches branding changes (#925)

Injects a fixed-size background repaint on the real <header> and asserts the
1% top-bar screenshot gate rejects it. Skipped under --update-snapshots so a
bless run can't overwrite the baseline with the injected state.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K6Ew9XcepEqNVc126nbfCK
EOF
)"
```

---

### Task 3: Fix the regen workflow count guard

**Files:**
- Modify: `.github/workflows/regen-visual-baselines.yml` (the "Verify PNG count" step ~line 121–126, and the stale "14/42" comments at lines ~7, 27, 99, 147, 174)

**Interfaces:**
- Consumes: the +6 PNGs from Task 1 (45 → 51 total across three projects).
- Produces: nothing.

- [ ] **Step 1: Update the count assertion to an exact match**

In `.github/workflows/regen-visual-baselines.yml`, change the guard (~line 125) from:
```bash
          if [ "$count" -lt 42 ]; then
            echo "::error::Expected 42 PNGs (14 per project × 3 projects), found $count. Aborting PR."
```
to (exact match catches both over- and under-generation):
```bash
          if [ "$count" -ne 51 ]; then
            echo "::error::Expected 51 PNGs (17 per project × 3 projects), found $count. Aborting PR."
```

- [ ] **Step 2: Fix the stale "14 specs / 42 PNGs" comments**

Update the comments referencing "14 visual specs" / "14 per project" / "42 PNGs" (lines ~7, 27, 99, 147, 174) to "17" and "51" respectively. These are prose comments — adjust the numbers only, leave wording otherwise intact.

- [ ] **Step 3: Lint the workflow YAML (sanity)**

Run:
```bash
node -e "require('js-yaml')" 2>/dev/null && npx --yes js-yaml .github/workflows/regen-visual-baselines.yml >/dev/null && echo "YAML OK" || echo "(js-yaml absent — skip; rely on gh to validate)"
```
Expected: `YAML OK` (or the skip note). A malformed edit would surface here.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/regen-visual-baselines.yml
git commit -m "$(cat <<'EOF'
ci(ci): fix visual-baseline count guard for top-bar captures (#925)

The top-bar clip adds 2 captures/project, taking the tree 45 -> 51. The guard
was -lt 42 (already stale at 14/42; reality was 15/45). Switch to an exact
-ne 51 check so both over- and under-generation are caught.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K6Ew9XcepEqNVc126nbfCK
EOF
)"
```

---

### Task 4: File the deferred follow-up and add the backlog row

**Files:**
- Modify: `docs/BACKLOG.md` (add a thin row under an appropriate `area:ops` bucket)

**Interfaces:**
- Consumes: nothing.
- Produces: a GitHub issue number `#NN` referenced by the backlog row.

- [ ] **Step 1: Create the follow-up issue**

Run (one command; uses `-f` body to avoid heredoc quoting issues):
```bash
gh issue create --repo dudarenok-maker/Castwright \
  --title "ops-NN — Catch any large-region visual change (not just the top-bar)" \
  --label "area:ops,type:chore" \
  --body "Follow-up to #925 (top-bar clip). The clip closes the documented branding gap but does not catch a large-region change elsewhere on a view (e.g. a wordmark in the footer or /about). Covering that would need full-page (fullPage:true) re-blessed baselines AND a contiguity (connected-component) gate whose text-line-chaining risk under 4-/8-connectivity was analysed in the #925 design history (docs/superpowers/specs/2026-06-20-visual-diff-sensitivity-design.md, commits 379c9b3a -> 6db95b3f -> 2421f4f9). Justified only if a real non-top-bar branding regression is observed. Out of scope until then."
```
Expected: prints the new issue URL. Note its number as `#NN`.

- [ ] **Step 2: Add the thin backlog row**

In `docs/BACKLOG.md`, under the appropriate `area:ops` / Could (or Won't-for-now) bucket, add a one-line row linking the issue. Match the existing row format in that file (a `####` heading + a `_What:_` line is the house style — keep it to the minimum the surrounding rows use). Example shape:

```markdown
#### `ops-NN` — Catch any large-region visual change (not just the top-bar) ([#NN](https://github.com/dudarenok-maker/Castwright/issues/NN))

- _What:_ Full-page re-blessed baselines + a contiguity gate to catch branding-scale changes outside the top-bar. Follow-up to #925; build only if a real non-top-bar regression is seen.
```

- [ ] **Step 3: Commit**

```bash
git add docs/BACKLOG.md
git commit -m "$(cat <<'EOF'
docs(docs): backlog row for broad large-region visual coverage (#925 follow-up)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K6Ew9XcepEqNVc126nbfCK
EOF
)"
```

---

### Task 5: Verify, bless Linux baselines, open the PR

**Files:** none (integration + CI orchestration).

**Interfaces:**
- Consumes: all prior tasks committed on `chore/ops-visual-diff-contiguity`.
- Produces: a green PR with both win32 and linux top-bar baselines.

- [ ] **Step 1: Run the full local battery**

Run:
```bash
npm run verify
```
Expected: green. (The new captures pass on win32; the negative proof passes; the build/typecheck/unit tests are unaffected.) If the visual leg flags font-hinting drift on the top-bar clip beyond 1%, bump `TOPBAR_DIFF_RATIO` to twice the observed max, re-bless (Task 1 steps 4–6), and note it.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin chore/ops-visual-diff-contiguity
```
Expected: branch published. (A backgrounded/slow push here is the pre-push `npm run verify` battery, not a network hang — let it finish.)

- [ ] **Step 3: Bless the Linux baselines via the workflow**

The new captures have NO `e2e/linux/...` baseline yet, so a label-gated Ubuntu CI run of `test:e2e:visual` would fail "snapshot doesn't exist". Linux baselines are blessed only by the regen workflow. Dispatch it against this branch:

```bash
gh workflow run regen-visual-baselines.yml --ref chore/ops-visual-diff-contiguity
```
Expected: the workflow runs on Ubuntu, regenerates all 51 linux PNGs (now including `topbar.png` / `topbar-dark.png` × 3 projects), passes its `-ne 51` count guard, and opens/updates a PR (or commits a branch) carrying the linux baselines per its own logic. Watch it: `gh run watch` or the Actions tab.

- [ ] **Step 4: Integrate the Linux baselines**

Merge the regen workflow's linux-baseline branch into `chore/ops-visual-diff-contiguity` (per the workflow's documented output — it opens its own PR/branch). After merging, confirm the tree has `e2e/linux/responsive/visual.spec.ts/{chromium,mobile-chrome,tablet-chrome}/topbar*.png`.

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base main --head chore/ops-visual-diff-contiguity \
  --title "test(e2e): top-bar clip gate for branding-scale visual changes" \
  --body "$(cat <<'EOF'
## Summary

Closes #925. Adds a tightly-toleranced (1%) screenshot of the top-bar element
(`getByRole('banner')`, light + dark) so a branding/logo change — which dilutes
below the 5% full-viewport ratio — is caught as a large fraction of the clipped
`<header>`. Stock Playwright; no new modules or devDeps. Includes a permanent
negative proof and a fix to the `regen-visual-baselines.yml` count guard
(45 -> 51, exact). Broad "any large-region" coverage is deferred to a follow-up
(linked in the design history).

Design: `docs/superpowers/specs/2026-06-20-visual-diff-sensitivity-design.md`
(rev 3, after two adversarial review rounds — commits 379c9b3a -> 6db95b3f ->
2421f4f9).

Self-noise: top-bar clip showed 0 diff across 3 consecutive chromium runs.

## Test plan

- `npm run verify` green locally (win32).
- New `top-bar (branding)` / `top-bar (branding, dark)` captures pass on blessed
  win32 + linux baselines.
- `top-bar gate catches a branding repaint` passes (and was confirmed to FAIL
  when the tolerance was temporarily loosened to 100%).
- Linux baselines blessed via `regen-visual-baselines.yml`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opened. Add the `run-ci` label to confirm the Linux clip is flake-free before merge.

---

## Self-Review

**Spec coverage (rev 3):**
- "The capture" (light + dark, `getByRole('banner')`, route `/`, element screenshot, rides project matrix) → Task 1.
- "Tolerance & calibration" (`TOPBAR_DIFF_RATIO = 0.01`, 3× self-noise check, Linux confirmation) → Task 1 steps 4–7, Task 5 steps 1/3.
- "Permanent negative proof" (real `header.sticky` selector, background swap, no reflow) → Task 2; plus the `--update-snapshots` guard the spec's code block implied → Task 2 step 1.
- "Regen count guard" (45 → 51, exact) → Task 3.
- "Failure artifact (free via stock toHaveScreenshot)" → no task needed (inherent).
- "What we are NOT building" → honored: no `visual-diff.ts`, no flood-fill, no devDeps, no Phase-0 harness, no plan-227 doc.
- "Follow-up (deferred broad scope)" → Task 4.
- "Where it runs" (chromium in verify; mobile/tablet in test:e2e:all) → reflected in Task 1 bless commands + Task 5.

**Placeholder scan:** No TBD/TODO. The only `NN` placeholders are the genuinely-unknown follow-up issue number (Task 4) and are explicitly resolved at runtime (`gh issue create` prints it).

**Type/name consistency:** `TOPBAR_DIFF_RATIO`, `topbar.png`, `topbar-dark.png`, `getByRole('banner')`, `header.sticky` used identically across Tasks 1–3 and Task 5. Count `51` consistent between Task 1 (6 new PNGs over 45) and Task 3 (`-ne 51`).

**Open risk carried from the spec:** Linux clip-noise > 1% (Task 5 step 1 mitigation: bump ratio ×2, re-bless). Low — the clip is small and mostly solid chrome.
