# Test Suite Hardening (timing margins, e2e sharding, dev scripts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three independent, already-decided changes from the spec — widen three thin timing-margin pairs in `server/src/workspace/file-lock.test.ts`, raise cloud e2e Playwright sharding from 4-way to 8-way, and add eight opt-in subsystem-scoped npm scripts for local dev loops — plus file the one design-pass issue the spec explicitly declined to implement.

**Architecture:** No new subsystems. Three small, independent edits (a test file's constants, a GitHub Actions workflow's matrix/shard config, a `package.json` scripts block + a CLAUDE.md doc bullet) bundled into one branch/PR since each is individually trivial-to-small and the spec explicitly declared them shippable together. One GitHub issue per decision (B, D, E) plus a fourth, separate issue for Decision A (filed, not implemented).

**Tech Stack:** TypeScript/Vitest (frontend + server), GitHub Actions YAML, npm scripts, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md` (HEAD `72e25bd3` at plan-writing time) — read Decisions A, B, D, E and the "Shipping notes" section before starting; this plan pulls exact values from it but the spec has the full rationale and review history behind each one.

## Global Constraints

- No behavior change to production code anywhere in this plan — Decision B widens test constants only (`server/src/workspace/file-lock.ts` itself is untouched), Decision D changes CI config only, Decision E adds new opt-in npm scripts that touch nothing else.
- Every widened/changed value must come from the spec verbatim — do not re-derive or "improve" a number while implementing (e.g. don't retune Decision B's margins beyond what's specified; don't pick a different shard count for Decision D).
- `cast-lock.test.ts` and `design-lock.test.ts` are explicitly NOT touched (spec, Decision B) — do not "helpfully" apply the same widening pattern there.
- `test:e2e:visual` is explicitly NOT sharded further and its `--workers=1` constraint is NOT touched (spec, Decision D / Out of scope).
- Decision A (CI's zero-test-selection hazard) is NOT implemented by this plan — filed as its own issue only (Task 1, sub-step 4). Do not attempt to fix it here; it needs a design pass the spec explicitly deferred.
- Decision C (sidecar pytest scoping) requires no action at all — nothing to file, nothing to implement.
- Every commit message follows CONTRIBUTING.md's `<type>(<scope>): <subject>` convention. These are `test`/`ci`/`chore` scoped changes — no `feat`/`fix`, since nothing here is new user-visible behavior or a bug fix.
- CLAUDE.md's Before-shipping checklist steps 5 (release notes, both files) and 6 (issue linkage, `Closes #NN` in the PR body) apply — both are explicit tasks below, not left implicit.

---

## Task 1: Worktree, branch, and issue filing

**Files:**
- None modified — this task only sets up the worktree and files GitHub issues.

**Interfaces:**
- Produces: a working, hook-gated worktree at a path this plan calls `$WORKTREE` for the rest of its tasks, on branch `$BRANCH`; four GitHub issue numbers (`$ISSUE_B`, `$ISSUE_D`, `$ISSUE_E`, `$ISSUE_A`) referenced by later tasks and by the final PR body.

- [ ] **Step 1: Cut the worktree and branch**

From the primary checkout (`C:\Claude\Projects\Audiobook-Generator`):

```bash
node scripts/wt-new.mjs chore/ops-test-suite-hardening
```

This creates a worktree (path printed by the command — call it `$WORKTREE` below) on branch `chore/ops-test-suite-hardening`, runs both `npm install`s, activates husky, and writes `.env.local`/`server/.env` with a non-clashing port slot. Verify hooks are active:

```bash
ls -d $WORKTREE/.husky/_ && git -C $WORKTREE config core.hooksPath
```

Both must print non-empty output. If `wt-new.mjs` fails or isn't available for some reason, follow CLAUDE.md's "Worktree setup" section manually (branch, `npx husky`, both `node_modules` junctions, `server/.env` + `.env.local`) before proceeding — do not skip hook activation.

- [ ] **Step 2: File the issue for Decision B**

```bash
gh issue create --repo dudarenok-maker/Castwright \
  --title "chore(ops): widen file-lock.test.ts's thin timing-margin pairs" \
  --label "type:chore" --label "area:ops" \
  --body "Three tests in \`server/src/workspace/file-lock.test.ts\`'s \`withKeyLock acquisition timeout (#2260)\` \`describe\` block race a 20ms lock-acquisition-timeout budget against a 150-200ms holder to assert ordering. Widen to an absolute-gap floor of \u2265500ms per pair, per \`docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md\` Decision B. Shipped as cheap, no-regret insurance, not a diagnosed fix \u2014 the spec's own review found a real technical argument that these margins may never have been able to flip under contention (Node dispatches timers by expiry, not arrival, and the waiter's timer is armed before the holder's). No production code change; three tests' constants widen, with comments recording the new absolute gap.

Closes nothing on its own; part of the shipping PR for docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md."
```

Record the returned issue number as `$ISSUE_B`.

- [ ] **Step 3: File the issue for Decision D**

```bash
gh issue create --repo dudarenok-maker/Castwright \
  --title "chore(ops): increase cloud e2e Playwright sharding from 4-way to 8-way" \
  --label "type:chore" --label "area:ops" \
  --body ".github/workflows/verify.yml's e2e job shards test:e2e 4-way today. Per docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md Decision D, raise to 8-way (matrix array, the single --shard=N/4 site, job name label) and fix two stale prose comments in the same file that still cite the 4-way figure and a ~110-spec-files estimate (actual: 137). Cost caveats (unconditional per-shard checkout/setup overhead, an unverified concurrent-job-slot ceiling) are documented in the spec and should be watched after shipping, not resolved here."
```

Record the returned issue number as `$ISSUE_D`.

- [ ] **Step 4: File the issue for Decision E**

```bash
gh issue create --repo dudarenok-maker/Castwright \
  --title "chore(ops): add subsystem-scoped npm scripts for local test-loop convenience" \
  --label "type:chore" --label "area:ops" \
  --body "Add 8 opt-in, manual npm scripts (test:server:routes/tts/analyzer/workspace, test:components/store/lib/views) that narrow vitest to one subsystem, per docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md Decision E. Not added to the automated verify pipeline (STEPS[]), not cached, not gated by any hook \u2014 pure developer convenience for a fast local loop when working in one area. Document in CLAUDE.md's Commands section."
```

Record the returned issue number as `$ISSUE_E`.

- [ ] **Step 5: File the separate, NOT-implemented issue for Decision A**

This one is filed but nothing in this plan fixes it — it needs the design pass the spec names.

```bash
gh issue create --repo dudarenok-maker/Castwright \
  --title "chore(ops): CI's --changed narrowing can select zero tests on a server-lockfile-only diff" \
  --label "type:chore" --label "area:ops" \
  --body "\`.github/workflows/verify.yml\`'s \`test:server\`/\`test:server-slow\` step body decides narrowed-vs-full only on whether \`\$BASE\` is set, never on the \`shared\` scope boolean \`computeShared\` already computes. Confirmed live hazard: a \`server/package-lock.json\`-only PR is not \`shared\` scope (only the ROOT lockfile/manifest and \`.github/actions/**\` are), so it reaches \`step_test_server\` through \`stepTouchedByDiff\`'s \`includeLockfiles\` branch and stays narrowed \u2014 and neither \`package-lock.json\` nor \`server/package-lock.json\` appears in \`server/vitest.config.ts\`'s \`forceRerunTriggers\`, so \`--changed \"\$BASE\"\` can select zero tests and report green.

Root \`package.json\` is NOT part of this hazard \u2014 already protected by both vitest configs' \`forceRerunTriggers\` (measured proof already in \`server/vitest.config.ts\`'s own comment: stripped selects 0, restored selects 5389). The frontend leg is NOT part of this hazard either \u2014 it runs \`npm run test:a11y\` unconditionally regardless of what \`--changed\` selects, so it always does real work. \`test:server-slow\` shares \`test:server\`'s step body, so whatever fix lands applies to both, not as a separate instance.

**Needs a design pass, not a mechanical fix** \u2014 a naive \`shared\`-only check (tried and rejected during this spec's review) doesn't cover the server-lockfile case. The decision this issue is waiting on: what property of a diff actually guarantees \`--changed <base>\` selects a correct, non-empty test set for a given vitest config, given that config's own \`forceRerunTriggers\` list? A real answer likely needs to reconcile per-config \`forceRerunTriggers\` coverage with the CI-side scope decision in \`scripts/ci-scope.mjs\`, not just patch \`verify.yml\`'s step-body conditional.

Full history and review trail: docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md, Decision A."
```

Record the returned issue number as `$ISSUE_A`. This issue stays open at the end of this plan — do not close it.

- [ ] **Step 6: Confirm all four issue numbers are recorded**

Before moving to Task 2, write down `$ISSUE_B`, `$ISSUE_D`, `$ISSUE_E`, `$ISSUE_A` somewhere durable (the PR body in the final task needs all three of B/D/E as `Closes #NN`, and `$ISSUE_A` gets referenced but never closed). No commit for this task — it's pure GitHub-side setup.

---

## Task 2: Decision B — widen `file-lock.test.ts`'s timing margins

**Files:**
- Modify: `server/src/workspace/file-lock.test.ts:113-216` (three tests inside the `withKeyLock acquisition timeout (#2260)` describe block)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks depend on — this task is self-contained.

- [ ] **Step 1: Read the current three tests to confirm line numbers match**

```bash
sed -n '113,216p' $WORKTREE/server/src/workspace/file-lock.test.ts
```

(Or use the Read tool.) Confirm the three tests below are exactly as described — `wt-new.mjs` clones from `main`, and if `main` has moved since this plan was written the surrounding code may have shifted slightly; match by test name / describe text, not blindly by line number, if they've drifted.

- [ ] **Step 2: Widen `'does not poison the key after a timeout...'`**

Current (lines ~113-148):

```typescript
  it('does not poison the key after a timeout -- a later call still works once the holder finishes', async () => {
    const key = 'unpoisoned-key';
    const order: string[] = [];
    /* The real holder -- NOT permanently stuck, unlike the deadlock test
       above. It finishes on its own, comfortably after the waiter below has
       already timed out. This is the case review Finding 2 called out: a
       first holder that never releases makes "a later call still works"
       provable only by barging past a still-running holder, which proves
       the opposite of what this test claims -- a neutralisation proof, not
       coverage. */
    const holder = withKeyLock(key, async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 150));
      order.push('first-end');
      return 'first-done';
    });

    /* Comfortably shorter than the holder's 150ms hold, so this one times out
       while the holder is still running. */
    await expect(
      withKeyLock(key, async () => 'never', 20),
    ).rejects.toThrow(/unpoisoned-key/);
```

Change to:

```typescript
  it('does not poison the key after a timeout -- a later call still works once the holder finishes', async () => {
    const key = 'unpoisoned-key';
    const order: string[] = [];
    /* The real holder -- NOT permanently stuck, unlike the deadlock test
       above. It finishes on its own, comfortably after the waiter below has
       already timed out. This is the case review Finding 2 called out: a
       first holder that never releases makes "a later call still works"
       provable only by barging past a still-running holder, which proves
       the opposite of what this test claims -- a neutralisation proof, not
       coverage. */
    const holder = withKeyLock(key, async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 700));
      order.push('first-end');
      return 'first-done';
    });

    /* Comfortably shorter than the holder's 700ms hold, so this one times out
       while the holder is still running. 700ms/50ms is a ~650ms absolute
       gap -- widened from 150ms/20ms (an ~130ms gap) as cheap, no-regret
       insurance per docs/superpowers/specs/2026-09-01-verify-scope-branch-
       timing-design.md Decision B; not a claim these margins were ever
       provably flippable. */
    await expect(
      withKeyLock(key, async () => 'never', 50),
    ).rejects.toThrow(/unpoisoned-key/);
```

Leave the rest of the test (the `2000`ms second timing pair at what's currently line ~143, and everything after) untouched — the spec explicitly does not ask for that pair to change, only notes its headroom shrinks (from ~1870ms to ~1350ms against the widened 700ms holder), which is still comfortable.

- [ ] **Step 3: Widen `'does not let a later caller barge past a still-running holder...'`**

Current (lines ~150-181):

```typescript
  it('does not let a later caller barge past a still-running holder after an earlier waiter times out', async () => {
    /* Case review Finding 3 -- the regression test for Finding 1. Nothing in
       the tests above pins ordering strictly enough to catch a `chains`
       cleanup on the timeout path that deletes the wrong thing: a subsequent
       caller must queue behind the ACTUAL holder, not merely "eventually
       succeed" (which a barge-past-and-race outcome can also produce by
       accident once the holder happens to finish first). */
    const key = 'mutex-key';
    const order: string[] = [];
    const holder = withKeyLock(key, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 200));
      order.push('a-end');
    });

    /* Times out well before the holder's 200ms hold ends. */
    await expect(
      withKeyLock(key, async () => { order.push('b-ran'); }, 20),
    ).rejects.toThrow(/mutex-key/);
```

Change to:

```typescript
  it('does not let a later caller barge past a still-running holder after an earlier waiter times out', async () => {
    /* Case review Finding 3 -- the regression test for Finding 1. Nothing in
       the tests above pins ordering strictly enough to catch a `chains`
       cleanup on the timeout path that deletes the wrong thing: a subsequent
       caller must queue behind the ACTUAL holder, not merely "eventually
       succeed" (which a barge-past-and-race outcome can also produce by
       accident once the holder happens to finish first). */
    const key = 'mutex-key';
    const order: string[] = [];
    const holder = withKeyLock(key, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 750));
      order.push('a-end');
    });

    /* Times out well before the holder's 750ms hold ends -- a ~700ms
       absolute gap, widened from 200ms/20ms (an ~180ms gap) per Decision B,
       same no-regret-insurance rationale as the test above. */
    await expect(
      withKeyLock(key, async () => { order.push('b-ran'); }, 50),
    ).rejects.toThrow(/mutex-key/);
```

Leave the rest of the test (the `later` acquisition and its assertions) untouched.

- [ ] **Step 4: Widen `'leaves exactly one chains entry after a timeout...'`**

Current (lines ~183-216):

```typescript
    const key = 'chains-accounting-key';
    const before = __chainsSizeForTest();

    const holder = withKeyLock(key, async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    await expect(withKeyLock(key, async () => 'never', 20)).rejects.toThrow(/chains-accounting-key/);
    await holder;
```

Change to:

```typescript
    const key = 'chains-accounting-key';
    const before = __chainsSizeForTest();

    const holder = withKeyLock(key, async () => {
      /* 700ms/50ms is a ~650ms absolute gap, widened from 150ms/20ms per
         Decision B -- same no-regret-insurance rationale as the two tests
         above in this file. */
      await new Promise((r) => setTimeout(r, 700));
    });
    await expect(withKeyLock(key, async () => 'never', 50)).rejects.toThrow(/chains-accounting-key/);
    await holder;
```

Leave the rest of the test (the `__chainsSizeForTest()` assertions) untouched.

- [ ] **Step 5: Confirm nothing else in the file changed**

Diff against `main` and confirm the only changes are the six literal values above (three `150`→`700` or `200`→`750`, three `20`→`50`) plus the three comment updates:

```bash
git -C $WORKTREE diff main -- server/src/workspace/file-lock.test.ts
```

- [ ] **Step 6: Run the file's own tests to confirm they still pass**

```bash
cd $WORKTREE/server && npx vitest run src/workspace/file-lock.test.ts
```

Expected: all tests in the file pass, same pass count as before the edit (no test added or removed, only constants changed).

- [ ] **Step 7: Commit**

```bash
git -C $WORKTREE add server/src/workspace/file-lock.test.ts
git -C $WORKTREE commit -m "$(cat <<'EOF'
test(server): widen file-lock.test.ts's thin timing-margin pairs

Three tests in withKeyLock acquisition timeout (#2260) race a 20ms
lock-acquisition-timeout budget against a 150-200ms holder to assert
ordering -- widened to an absolute-gap floor of >=500ms per pair, as cheap,
no-regret insurance rather than a diagnosed fix. No production code change.

Refs #ISSUE_B_NUMBER
EOF
)"
```

Replace `#ISSUE_B_NUMBER` with the actual `$ISSUE_B` issue number from Task 1.

---

## Task 3: Decision D — increase cloud e2e sharding to 8-way

**Files:**
- Modify: `.github/workflows/verify.yml` (header comment block near the top, the `e2e` job's own rationale comment, and the `e2e` job definition itself)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Fix the file's header comment (near the top, the "E2E ITSELF IS SHARDED" block)**

Find the comment block (originally around line 34-43) that reads approximately:

```yaml
# E2E ITSELF IS SHARDED (2026-07-10): a live timing comparison showed the
# functional e2e battery (~110 spec files, CI-pinned to workers=1 to avoid
# in-job Vite dev-server contention) was the dominant leg at ~16 min, dwarfing
# every other job. `--shard=N/4` splits it across 4 matrix jobs, each its own
# runner/dev-server — the workers=1 anti-flake guarantee still holds PER
# SHARD, just with 4x less work per shard. Visual baselines were pulled into
```

Change the four stale figures (`~110`, `N/4`, `4 matrix jobs`, `4x less work`) to match the 8-way split:

```yaml
# E2E ITSELF IS SHARDED (2026-07-10, raised to 8-way 2026-09): a live timing
# comparison showed the functional e2e battery (137 spec files, CI-pinned to
# workers=1 to avoid in-job Vite dev-server contention) was the dominant leg
# at ~16 min, dwarfing every other job. `--shard=N/8` splits it across 8
# matrix jobs, each its own runner/dev-server — the workers=1 anti-flake
# guarantee still holds PER SHARD, just with less work per shard (per-shard
# fixed cost — checkout, setup, the warmup project, a fresh Vite dev server —
# doesn't shrink with more shards, so the wall-clock win is sub-linear; see
# docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md
# Decision D). Visual baselines were pulled into
```

Keep the rest of that comment block (everything after "Visual baselines were pulled into...") unchanged.

- [ ] **Step 2: Fix the `e2e` job's own rationale comment**

Find the comment immediately above the `e2e:` job definition (originally around line 392-399), reading approximately:

```yaml
  # E2E functional battery (~110 spec files) is the long pole of the whole
  # workflow — CI intentionally pins Playwright to `workers: 1` (playwright.
  # config.ts) so parallel Chromium instances can't thundering-herd the
  # single Vite dev server WITHIN one job. That constraint is per-job, not
  # global: `--shard=N/4` below splits the spec list across 4 independent
  # matrix jobs, each on its own runner with its own dev server (no shared
  # process to contend over), while every shard still runs serially inside
  # itself — same anti-flake guarantee, ~4x less wall-clock.
```

Change to:

```yaml
  # E2E functional battery (137 spec files) is the long pole of the whole
  # workflow — CI intentionally pins Playwright to `workers: 1` (playwright.
  # config.ts) so parallel Chromium instances can't thundering-herd the
  # single Vite dev server WITHIN one job. That constraint is per-job, not
  # global: `--shard=N/8` below splits the spec list across 8 independent
  # matrix jobs, each on its own runner with its own dev server (no shared
  # process to contend over), while every shard still runs serially inside
  # itself — same anti-flake guarantee, less wall-clock (sub-linear: fixed
  # per-shard cost — checkout, setup, the warmup project, a fresh Vite dev
  # server — doesn't shrink with more shards; watch actual PR wall-clock
  # after this ships, not just this job's own duration).
```

- [ ] **Step 3: Raise the matrix shard count**

Find (originally around line 400-408):

```yaml
  e2e:
    name: E2E (chromium) — shard ${{ matrix.shard }}/4
    needs: detect
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
```

Change to:

```yaml
  e2e:
    name: E2E (chromium) — shard ${{ matrix.shard }}/8
    needs: detect
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4, 5, 6, 7, 8]
```

- [ ] **Step 4: Fix the `--shard=` argument itself**

Find (originally around line 442-444):

```yaml
      - name: E2E (chromium)
        if: fromJSON(needs.detect.outputs.scopes).step_test_e2e || fromJSON(needs.detect.outputs.scopes).shared
        run: npm run test:e2e -- --shard=${{ matrix.shard }}/4
```

Change the trailing `/4` to `/8`:

```yaml
      - name: E2E (chromium)
        if: fromJSON(needs.detect.outputs.scopes).step_test_e2e || fromJSON(needs.detect.outputs.scopes).shared
        run: npm run test:e2e -- --shard=${{ matrix.shard }}/8
```

- [ ] **Step 5: Confirm `test:e2e:visual`'s job is untouched**

Grep the file to confirm no other `/4` or `[1, 2, 3, 4]` reference was accidentally changed:

```bash
grep -n "shard\|/4\b" $WORKTREE/.github/workflows/verify.yml
```

Only the `e2e` job's three sites (now `/8`) should reference sharding. The `test:e2e:visual` job must still show no `matrix:`/`shard` at all — confirm it wasn't touched.

- [ ] **Step 6: Validate the YAML is well-formed**

```bash
cd $WORKTREE && node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/verify.yml', 'utf8')); console.log('OK')"
```

(If `js-yaml` isn't directly requirable from the repo root in this context, use `npx -y js-yaml .github/workflows/verify.yml > /dev/null && echo OK` instead — either way, confirm the file still parses as valid YAML before committing.)

- [ ] **Step 7: Commit**

```bash
git -C $WORKTREE add .github/workflows/verify.yml
git -C $WORKTREE commit -m "$(cat <<'EOF'
ci: increase e2e Playwright sharding from 4-way to 8-way

Also fixes two stale prose comments (verify.yml's header block and the e2e
job's own rationale comment) that still cited the old 4-way figure and a
~110-spec-files estimate -- actual is 137. Per docs/superpowers/specs/
2026-09-01-verify-scope-branch-timing-design.md Decision D; see that
section for the cost caveats (unconditional per-shard checkout/setup
overhead, unverified concurrent-job-slot ceiling) worth watching after
this ships.

Refs #ISSUE_D_NUMBER
EOF
)"
```

Replace `#ISSUE_D_NUMBER` with the actual `$ISSUE_D` issue number from Task 1.

**Note:** this task cannot be locally test-run end-to-end (it's cloud CI config) — the actual verification (8 shard jobs appear and complete) happens via a manual `gh workflow run` dispatch after the PR is pushed, covered in the final "Ship" section below, not as a task step here.

---

## Task 4: Decision E — subsystem-scoped npm scripts + CLAUDE.md doc

**Files:**
- Modify: `package.json` (root — add 8 new scripts)
- Modify: `CLAUDE.md:340` (Commands section — add one bullet documenting the new scripts)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the 8 new scripts to root `package.json`**

Find the `"scripts"` block's `test:server-slow` line (currently):

```json
    "test:server-slow": "npm --prefix server run test:slow",
```

Add the 8 new scripts immediately after it (before `"test:scripts"`):

```json
    "test:server-slow": "npm --prefix server run test:slow",
    "test:server:routes":    "npm --prefix server run test -- src/routes",
    "test:server:tts":       "npm --prefix server run test -- src/tts",
    "test:server:analyzer":  "npm --prefix server run test -- src/analyzer",
    "test:server:workspace": "npm --prefix server run test -- src/workspace",
    "test:components": "vitest run src/components",
    "test:store":       "vitest run src/store",
    "test:lib":         "vitest run src/lib",
    "test:views":       "vitest run src/views",
```

(Match the existing file's actual indentation/quoting style exactly — `npm run format:check` will catch a mismatch if Prettier disagrees with manual spacing; run `npm run format` on just this file if needed before committing, or just match the two-space JSON indent already used throughout the file.)

- [ ] **Step 2: Run each of the 8 scripts and confirm it selects real tests**

This is the step that matters most — round 4 of the spec's own review found a real path bug here (`server/src/routes` instead of the correct `src/routes`, since `npm --prefix server` already sets `cwd=server/`) that inspection alone missed and only running the command caught. Do not skip this by "it looks right."

```bash
cd $WORKTREE && npm run test:server:routes -- --reporter=verbose 2>&1 | tail -20
```

Expected: a real test run, NOT "No test files found, exiting with code 1". Repeat for `test:server:tts`, `test:server:analyzer`, `test:server:workspace`, `test:components`, `test:store`, `test:lib`, `test:views` — each must select a nonzero number of real test files matching its subdirectory. For the server-side four, additionally confirm the selected file count is in the right ballpark (spec's measured figures: routes 138 files, tts 123, analyzer 73, workspace 57) — a wildly different count (e.g. 0, or the whole suite) means the path is still wrong.

If any of the 8 fails this check, the fix is almost certainly the same class of bug the spec's round 4 already found once — double-check the path is relative to the correct `cwd` for that invocation (server-relative for the four `npm --prefix server` ones, repo-root-relative for the four bare `vitest run` ones) rather than assuming the string in this plan is already correct without running it.

- [ ] **Step 3: Add the CLAUDE.md Commands-section bullet**

Find (`CLAUDE.md`, in the Commands section, immediately after the `test:server-slow` bullet):

```markdown
- `npm run test:server-slow` — Vitest single-run for 10 timeout-prone server test files (analyzer/gemini, a parsers PDF test, and routes tests), pinned to one fork via `server/vitest.config.slow.ts`. Runs in the cloud `verify.yml` battery and the full local `npm run verify`, not in pre-push `verify:fast:branch` or `verify:fast` pre-commit. See `docs/features/archive/45-vitest-pool-tuning.md` for the rationale.
```

Add a new bullet immediately after it:

```markdown
- `npm run test:server:routes` / `:tts` / `:analyzer` / `:workspace` and `npm run test:components` / `:store` / `:lib` / `:views` — opt-in, manual, subsystem-scoped test runs (`vitest run <subdir>` under the hood) for a fast local loop when you know you're only touching one area. Not part of the automated verify pipeline — not in `STEPS[]`, not cached, not gated by any hook, and carry no coverage guarantee (a `routes/` change that breaks something in `workspace/` isn't caught by `test:server:routes` alone). The four server-side ones cover 76.9% of `test:server` by test count; the four frontend ones cover most of `test`'s largest directories. See `docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md` Decision E.
```

- [ ] **Step 4: Confirm the diff is scoped to exactly these two files**

```bash
git -C $WORKTREE status --porcelain
```

Expected: only `package.json` and `CLAUDE.md` modified.

- [ ] **Step 5: Commit**

```bash
git -C $WORKTREE add package.json CLAUDE.md
git -C $WORKTREE commit -m "$(cat <<'EOF'
chore(ops): add subsystem-scoped npm scripts for local test-loop convenience

8 opt-in, manual scripts (test:server:routes/tts/analyzer/workspace,
test:components/store/lib/views) narrowing vitest to one subsystem. Not
added to the automated verify pipeline -- pure developer convenience.
Documented in CLAUDE.md's Commands section.

Refs #ISSUE_E_NUMBER
EOF
)"
```

Replace `#ISSUE_E_NUMBER` with the actual `$ISSUE_E` issue number from Task 1.

---

## Task 5: Release notes

**Files:**
- Modify: `docs/release-notes-next.md` (append to the "🧪 Test gates → Test harness & suite hygiene" section)
- Modify: `RELEASE_NOTES.md` (append one brand-voice bullet to the in-progress version section at the top)

**Interfaces:**
- Consumes: nothing from other tasks (this task runs last, after B/D/E are all committed, so it can describe what actually shipped).
- Produces: nothing — this is the final content task before the PR/ship section.

- [ ] **Step 1: Append the technical entry to `docs/release-notes-next.md`**

Find the end of the "### Test harness & suite hygiene" section (the last bullet currently ends with `.gitignore` did not cover `.env.bak`...` — find that section's last line and append after it, still inside the same `###` section, before the next `##`/`###` heading).

Append:

```markdown
- **Three thin timing-margin pairs in `file-lock.test.ts` widened to an absolute-gap floor, cloud e2e sharding raised 4-way to 8-way, and eight opt-in subsystem-scoped npm scripts added for local dev loops** (see `docs/superpowers/specs/2026-09-01-verify-scope-branch-timing-design.md`). A pre-push run on a box with several concurrent worktree test batteries took 70-80 minutes and failed three times in a row on different lock tests, unrelated to the diff being pushed — no failure log was captured, and the repo separately documents fork-pool crashes (which retry the entire step up to 3x under contention) as an independently-sufficient explanation, so this doesn't claim to have diagnosed the incident. The three widened tests race a 20ms lock-acquisition-timeout budget against a 150-200ms holder; margins now target ≥500ms of absolute gap, shipped as cheap insurance rather than a proven fix — later review found a real argument that Node's timer-dispatch-by-expiry-time behavior may mean these margins were never actually flippable by contention. Separately, `--shard=N/4` → `N/8` on the e2e job (137 spec files, not the stale ~110 the workflow's own comments cited) for cloud wall-clock, and eight new manual `npm run test:server:<routes|tts|analyzer|workspace>` / `test:<components|store|lib|views>` scripts (not part of the automated gate) for a fast local check of one subsystem. A fourth, larger idea from the same investigation — extending pre-push's `--changed`-based test narrowing from pre-commit to pre-push — was explored across four rounds of review and declined: its real-world hit rate measured at 0 of the last 60 merged branches, too small to justify the machinery it would have required.
```

- [ ] **Step 2: Append the brand-voice entry to `RELEASE_NOTES.md`**

Find the top-of-file version section (`# Castwright 1.15.0` or whatever the current in-progress version marker is — check `docs/release-notes-next.md`'s `release-notes-next-version:` line for the current number) and append one bullet after the existing last bullet in that section.

```markdown
- **A stuck test run on a busy machine can no longer eat an hour of your time for reasons that have nothing to do with what you changed.** A few timing-sensitive checks in Castwright's own test suite have been given more breathing room, and the checks that run before your code ships now split across more machines in parallel — both aimed at keeping a red result meaningful instead of a symptom of a busy computer.
```

- [ ] **Step 3: Confirm both files' diffs are scoped correctly**

```bash
git -C $WORKTREE diff docs/release-notes-next.md RELEASE_NOTES.md
```

Confirm each diff is a single new bullet appended in the right section — nothing else in either file changed.

- [ ] **Step 4: Commit**

```bash
git -C $WORKTREE add docs/release-notes-next.md RELEASE_NOTES.md
git -C $WORKTREE commit -m "$(cat <<'EOF'
docs(release-notes): add v1.15.0 entries for test-suite hardening

Technical register entry under Test harness & suite hygiene, plus a
matching brand-voice line in RELEASE_NOTES.md, for the file-lock.test.ts
margin widening, the e2e shard bump, and the new subsystem-scoped dev
scripts.
EOF
)"
```

---

## Ship (not a task — controlling-thread work per CLAUDE.md's Execution model phase 3)

Once Tasks 1-5 are all committed:

1. **Run `npm run verify:fast:branch`** locally in `$WORKTREE` and confirm it's green (Decision B's file is under `test:server`'s scope, so this exercises the widened tests for real).
2. **Push the branch** and open the PR. PR title must match the commit-convention subject format (this is a multi-scope change — `test`/`ci`/`chore` — so title it something like `chore(ops): widen timing margins, shard e2e, add dev-loop scripts`). PR body: `Closes #<ISSUE_B>`, `Closes #<ISSUE_D>`, `Closes #<ISSUE_E>` (three separate `Closes` lines so all three auto-close on merge) — do NOT close `$ISSUE_A`, it stays open. Link the spec doc in the body.
3. **Cloud `verify.yml`** runs automatically and is the required check — confirm green, including watching the e2e job specifically since this PR changes its shard count.
4. **Mandatory `pr-review-gate` pass** — per CLAUDE.md's Before-shipping checklist step 10 and the `pr-review-gate` skill. This PR is multi-scope (`test`+`ci`+`chore` in one PR), which the review-depth ladder maps to `high` depth regardless of any individual commit's size — dispatch accordingly, not at `low`/`medium`.
5. **Manually dispatch `gh workflow run verify.yml --ref <branch>`** once on the pushed branch specifically to observe the e2e job's 8 shards appear and complete (Task 3's own verification step, which can't run locally) — this is in addition to, not instead of, the PR's automatic CI run.
6. Once findings are triaged and CI + review are both green: merge via "Create a merge commit" per CLAUDE.md's Branching workflow. Tear down the worktree (junctions first, if any — `wt-new.mjs` real-installs `node_modules` rather than junctioning, so this worktree's `node_modules`/`server/node_modules` are real directories, not junctions; a plain `git worktree remove` after deleting the directory is sufficient, no junction-deletion-first step needed. Verify with `Test-Path` before assuming.)
