# PR Review Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `.claude/skills/pr-review-gate/` from "how to dispatch a reviewer" into the single home for this repo's PR review process — the procedure, the rubric the reviewer applies, the triage rules, and a durable per-pass record on the PR itself.

**Architecture:** `SKILL.md` becomes the shipping session's runbook; two `references/` files carry the reviewer rubric and the findings-triage rules, and the reviewer is pointed at the rubric **by path** so it arrives verbatim. `model-routing`'s PR-specific sections move in, leaving routing to own routing. A guard test in `scripts/tests/review-gate-mechanism.test.mjs` locks the wiring, including a new link-integrity assertion that catches the dangling anchor this move would otherwise ship.

**Tech Stack:** Markdown skills (`.claude/skills/`), `node:test` via `npm run test:hooks` (`scripts/run-hooks-tests.mjs`, auto-globs `scripts/tests/*.test.mjs`), `scripts/verify-cache.mjs` input-hash cache.

**Spec:** [docs/superpowers/specs/2026-08-13-pr-review-skill-design.md](../specs/2026-08-13-pr-review-skill-design.md)

**Worktree:** `C:\Claude\Projects\wt-pr-review-skill` — branch `docs/docs-pr-review-skill`. All work happens there. Do not commit from the primary checkout: HEAD moves under you (it already did once during this spec's authoring).

## Global Constraints

- **Do not rename the skill.** Directory stays `.claude/skills/pr-review-gate/`, frontmatter `name:` stays `pr-review-gate`, and `disable-model-invocation` must never appear. Three existing guard assertions depend on all three.
- **Reference guard assertions by their test-name string, never by number.** The file's header comment numbers them in a different order than the `test()` calls appear.
- **The reviewer posts its own PR comment.** The shipping session does not relay it.
- **The reviewer modifies no tracked file.** The session verifies this with a before/after `git rev-parse HEAD` + `git status --porcelain` comparison; a delta is a gate failure.
- **Every pass posts a comment** — including one that finds nothing (`### ✅ No findings`) and including a docs-only PR's exemption note.
- **The mirror is conditional on Task 1.** "No agent needs a mirror" is a valid outcome that cancels Task 8 entirely.
- **`CLAUDE.md` and `model-routing/SKILL.md` edits land last**, in one commit, rebased immediately before — they are high-contention files across 17 live worktrees.
- Commit subjects follow `<type>(<scope>): <subject>`; this work is `docs(docs)` for skill/doc-only commits and `test(scripts)` / `chore(scripts)` for guard and cache changes.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `.claude/skills/pr-review-gate/references/reviewer-brief.md` | **Create** — house gates + defect-shape catalogue + finding contract | 2 |
| `.claude/skills/pr-review-gate/references/findings-triage.md` | **Create** — fix-now bar, void deferral reasons, design-pass carve-out | 2 |
| `.claude/skills/pr-review-gate/SKILL.md` | **Rewrite** — the runbook; absorbs model-routing's PR sections | 3 |
| `.claude/skills/model-routing/SKILL.md` | **Modify** — delete two sections, leave a pointer | 6 |
| `CLAUDE.md` | **Modify** — fix the dead anchor at :716 and the stale ladder pointer at :301-306 | 6 |
| `scripts/tests/review-gate-mechanism.test.mjs` | **Modify** — fix header numbering, retarget one assertion, add three | 2,3,5,6 |
| `scripts/verify-cache.mjs` | **Modify** — replace two literals with a `.claude/skills/**` glob | 4 |
| `scripts/tests/verify-cache.test.mjs` | **Modify** — assert a reference-file diff is in scope for `test:hooks` | 4 |
| `docs/testing/agent-skill-resolution-probe.md` | **Create** — the Task 1 probe result | 1 |

---

### Task 1: Canary probe — which agents resolve what

Everything in Task 8 is conditional on this. Run it first and **record the result even if the answer is "nothing to do"** — a probe whose outcome is unwritten gets re-run from cold by the next person.

**Files:**
- Create: `.claude/skills/zz-canary-probe/SKILL.md` (temporary, deleted in step 6)
- Create: `docs/testing/agent-skill-resolution-probe.md`

**Interfaces:**
- Produces: a recorded verdict `MIRROR_NEEDED: <agent list, or "none">` that Task 8 reads. Also `CLINE_SUBAGENT_COLD: yes|no|unknown`, which decides whether Cline's mapping in `SKILL.md` says "independent gate" or "self-run only".

- [ ] **Step 1: Create the canary skill**

```markdown
---
name: zz-canary-probe
description: Temporary probe skill. If you can see this, the agent reading it resolves project-scoped .claude/skills/. Delete after the probe.
---

# Canary

This file exists only to test skill resolution. Report the literal string
CANARY-OK-7F3A if asked whether you can see it.
```

- [ ] **Step 2: Confirm the shared CLI sees it**

Run: `npx --yes skills list --json`
Expected: an entry with `"name": "zz-canary-probe"`, `"scope": "project"`. Record its `agents` array verbatim — this is the CLI's *install bookkeeping*, not proof of what any agent resolves. Do not draw a conclusion from it alone.

- [ ] **Step 3: Ask the repo owner to run the agent-side half**

This step cannot be automated from inside Claude Code — it needs each agent driven interactively. Ask the owner to open Cline in this workspace and ask it two questions verbatim:

1. *"List your available skills. Do you see one named `zz-canary-probe`? Reply with the literal string it tells you to report."*
2. *"When you dispatch a subagent, does it start with a fresh context, or does it inherit our conversation? Can I choose which model it runs on?"*

Record both answers. Question 2 is the load-bearing one: "can dispatch" and "can dispatch an *independent* reviewer" are different claims, and only the second satisfies this gate.

- [ ] **Step 4: Write the probe result**

Create `docs/testing/agent-skill-resolution-probe.md`:

```markdown
# Agent skill-resolution probe (2026-08-13)

Run to decide whether `.claude/skills/pr-review-gate/` needs mirroring into
other agents' workspace paths, per
[the PR review skill design](../superpowers/specs/2026-08-13-pr-review-skill-design.md).

## Method

A throwaway project skill (`zz-canary-probe`) was added, then each agent was
asked to list its skills. Only what an agent actually reported counts —
`npx skills list --json` shows the *path*, and its `agents` field is the shared
CLI's install bookkeeping, not proof of resolution.

## Results

| Agent | Sees project `.claude/skills/`? | Evidence |
|---|---|---|
| Claude Code | yes | resolves this repo's three project skills today |
| Cline | <fill> | <verbatim answer> |
| <others tested> | <fill> | <verbatim answer> |

## Verdict

MIRROR_NEEDED: <comma-separated agent list, or "none">
CLINE_SUBAGENT_COLD: <yes|no|unknown>

## Not established

<Any agent not actually driven. "Not tested" is the honest entry — never
infer resolution from a binary string or a directory listing.>
```

- [ ] **Step 5: Record the verdict's consequence**

If `MIRROR_NEEDED: none`, write one explicit line in the same file: *"Task 8 of the implementation plan is cancelled; no mirror script, no mirror guard assertion, no cache entries."* Then mark Task 8 skipped in this plan rather than leaving it ambiguous.

- [ ] **Step 6: Delete the canary and commit**

```bash
rm -rf .claude/skills/zz-canary-probe
git add docs/testing/agent-skill-resolution-probe.md
git commit -m "docs(docs): record the agent skill-resolution probe result"
```

Verify the canary is gone: `npx --yes skills list --json` no longer lists `zz-canary-probe`.

---

### Task 2: Fix the header numbering, then create the two reference files

**Files:**
- Modify: `scripts/tests/review-gate-mechanism.test.mjs:1-31` (header comment) and append one test
- Create: `.claude/skills/pr-review-gate/references/reviewer-brief.md`
- Create: `.claude/skills/pr-review-gate/references/findings-triage.md`
- Modify: `.claude/skills/pr-review-gate/SKILL.md` (name the two files)

**Interfaces:**
- Produces: the two reference paths, which Task 3's `SKILL.md` dispatch section cites by path, and which Task 4's cache glob must cover.

- [ ] **Step 1: Correct the header comment's assertion numbering**

The header lists them 1 exists / 2 model-routing / 3 CLAUDE.md / 4 name-matches-directory, but the `test()` calls appear exists / name-matches-directory / model-routing / CLAUDE.md. This is a chore the work made owed — an implementer reading "assertion 3" cannot tell which test is meant. Renumber the header comment to match the actual `test()` order, and add this line under it:

```
//   Assertions are referred to elsewhere BY NAME, never by number — this
//   header and the test() order disagreed until 2026-08-13, and a plan that
//   said "retarget assertion 3" was ambiguous between two different tests.
```

- [ ] **Step 2: Write the failing test**

Append to `scripts/tests/review-gate-mechanism.test.mjs`:

```js
test('pr-review-gate/SKILL.md names both reference files, and they exist', () => {
  // The dispatch prompt points the reviewer at references/reviewer-brief.md BY
  // PATH. This layout's new failure mode is that path not resolving: the
  // reviewer is handed no rubric at all and reviews from generic instinct,
  // silently. Checking existence alone is not enough — a file nobody names is
  // just as unreachable as one that isn't there.
  const src = readNormalized(GATE_SKILL_PATH);
  const skillDir = dirname(GATE_SKILL_PATH);
  for (const rel of ['references/reviewer-brief.md', 'references/findings-triage.md']) {
    assert.ok(existsSync(join(skillDir, rel)), `missing ${rel} under ${skillDir}`);
    const literal = rel.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    assert.match(
      src,
      new RegExp(literal),
      `pr-review-gate/SKILL.md never names ${rel} — a reviewer would never be ` +
        `told to read it, so the rubric reaches it only as well as the ` +
        `dispatching session happens to retype it`,
    );
  }
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `npm run test:hooks`
Expected: FAIL — `missing references/reviewer-brief.md`.

- [ ] **Step 4: Create `references/reviewer-brief.md`**

Write the rubric. Two halves plus the contract, per the spec's "references/reviewer-brief.md — the rubric" section: house gates (paired test is a real regression test red-for-the-claimed-reason; on-box acceptance across all three surfaces; release-notes pair; `Closes #NN` outside code spans; `cast.json` lock rules and lock-timeout curation seam; a new knob's registry + `config:sync` + Settings row + `.env.example`; regenerated derived artifacts; incidental findings fixed not filed and declared in the PR body), then the ten defect shapes stated as *how each hides*, then the catalogue-maintenance rule, then the finding contract (severity, `file:line`, concrete failure scenario, correctness-vs-cleanup split, "found nothing" explicitly authorised).

Also include the posting instructions the reviewer itself executes:

```markdown
## Post your own findings before returning

Post one comment on the PR with `gh pr comment <number> --body-file <file>`
BEFORE returning your report. Do not hand it to the dispatching session to
publish — nothing would compare what it posts against what you found.

Heading: `## PR review — pass N (head <sha>, effort <level>)`. The head SHA is
required; without it the comment is uninterpretable once the branch moves.

If you found nothing, post anyway with `### ✅ No findings`. A record that
cannot distinguish "reviewed and clean" from "never reviewed" is not a record.

**Modify no tracked file.** Posting a comment is not a modification; editing,
committing, or staging anything is. The dispatching session compares
`git rev-parse HEAD` and `git status --porcelain` before and after this pass,
and any delta is reported as a gate failure.
```

- [ ] **Step 5: Create `references/findings-triage.md`**

Per the spec's section of the same name: the fix-now bar; the defect / chore / taste seam; the void deferral reasons reproduced verbatim from [CLAUDE.md → Incidental findings](../../../CLAUDE.md#incidental-findings-report-fix-record); the design-pass carve-out as the sole exception, with its issue required to name the decision owed; one dispatched fix agent per finding with one paired test; and how the 🔴/🟠 vs 🟡 split drives the re-review trigger and the loop cap.

- [ ] **Step 6: Name both files in `SKILL.md`**

Add to the existing `## Dispatch` section (the full rewrite is Task 3):

```markdown
- **The reviewer reads the rubric itself.** The dispatch prompt instructs it to
  read `.claude/skills/pr-review-gate/references/reviewer-brief.md` in full
  before it starts. Triage rules for what comes back are in
  `.claude/skills/pr-review-gate/references/findings-triage.md`.
```

- [ ] **Step 7: Run tests and verify they pass**

Run: `npm run test:hooks`
Expected: PASS, all assertions.

- [ ] **Step 8: Mutation-verify the new assertion**

Temporarily rename `references/reviewer-brief.md` to `references/reviewer-brief.md.bak`, run `npm run test:hooks`, confirm RED with the "missing" message. Then restore it, delete the line naming it in `SKILL.md`, run again, confirm RED with the "never names" message. Restore. **Both halves must have been observed red** — an assertion that only ever ran green proves nothing.

- [ ] **Step 9: Commit**

```bash
git add .claude/skills/pr-review-gate scripts/tests/review-gate-mechanism.test.mjs
git commit -m "docs(docs): add the pr-review-gate reviewer brief and triage reference"
```

---

### Task 3: Rewrite SKILL.md as the runbook

**Files:**
- Modify: `.claude/skills/pr-review-gate/SKILL.md` (full rewrite)
- Modify: `scripts/tests/review-gate-mechanism.test.mjs` (retarget one assertion)

**Interfaces:**
- Consumes: the two reference paths from Task 2.
- Produces: a `## Dispatch` section and an effort ladder inside `SKILL.md`, which the retargeted assertion reads, and which Task 6 lets `model-routing` drop.

- [ ] **Step 1: Retarget the model-routing assertion (write the failing test)**

Replace the test named `"model-routing/SKILL.md's PR-review Mechanism bullet references pr-review-gate"` with:

```js
test('pr-review-gate/SKILL.md carries the dispatch mechanism and the effort ladder', () => {
  // Retargeted 2026-08-13: this assertion used to read model-routing's
  // "## Mandatory independent review (PRs)" section, which has moved into this
  // skill. It must read the file that now OWNS the rule, or it certifies a
  // section that no longer exists.
  const src = readNormalized(GATE_SKILL_PATH);

  const dispatch = /\n## Dispatch\n([\s\S]*?)(?=\n## )/.exec(src);
  assert.ok(dispatch, 'pr-review-gate/SKILL.md has no "## Dispatch" section');
  assert.match(
    dispatch[1],
    /non-fork/,
    'the Dispatch section no longer requires a non-fork reviewer — a fork ' +
      'inherits the dispatching session, which is the opposite of independent review',
  );

  const ladder = /\n## Effort level\n([\s\S]*?)(?=\n## )/.exec(src);
  assert.ok(ladder, 'pr-review-gate/SKILL.md has no "## Effort level" section');
  for (const level of ['low', 'medium', 'high']) {
    assert.match(
      ladder[1],
      new RegExp('`' + level + '`'),
      `the effort ladder no longer names \`${level}\``,
    );
  }
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:hooks`
Expected: FAIL — `pr-review-gate/SKILL.md has no "## Effort level" section`.

- [ ] **Step 3: Rewrite `SKILL.md`**

Keep the frontmatter `name: pr-review-gate`; widen `description:` so it triggers on preparing and shipping a PR, not only on dispatching a reviewer. Sections, in order — `## When this fires` (fully-staged definition), `## Exemption` (docs-only file-set test, and the requirement to post an exemption note anyway), `## Effort level` (the `low`/`medium`/`high` ladder moved verbatim from `model-routing`), `## Dispatch` (reviewer capabilities: fresh context not a fork, strongest tier available, modifies no tracked file, reads the rubric by path; then the per-agent mapping), `## The tree check`, `## The PR comment`, `## Triage`, `## Re-review trigger and loop cap`, `## Issue verification at PR creation`, `## Merge`.

For gates CLAUDE.md already owns — regression plan, paired test, on-box register, release-notes pair, `INDEX.md`, `verify:fast:branch` — **name and link them; do not restate their text.**

Include the tree check as an explicit runbook step:

```markdown
## The tree check

Before dispatching, capture:

    git rev-parse HEAD && git status --porcelain

Re-run both after the pass returns. **Any delta is a gate failure** — report it
as such, do not absorb it. This is the one behavioural property of the pass
verifiable from outside it, so it is the one that gets verified. The guard test
cannot check it, and does not claim to.
```

And Cline's mapping, gated on Task 1's `CLINE_SUBAGENT_COLD`:

```markdown
- **Cline** — dispatches subagents. Whether that subagent starts cold is
  recorded in docs/testing/agent-skill-resolution-probe.md. Until it reads
  `CLINE_SUBAGENT_COLD: yes`, a Cline-run pass is labelled a **self-run**, not
  the independent gate: reporting a fork as the gate is exactly the
  substitution the standing rule forbids.
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm run test:hooks`
Expected: PASS.

- [ ] **Step 5: Mutation-verify**

Delete the `## Effort level` heading, run, confirm RED. Restore. Change `non-fork` to `forked` in the Dispatch section, run, confirm RED. Restore.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/pr-review-gate/SKILL.md scripts/tests/review-gate-mechanism.test.mjs
git commit -m "docs(docs): make pr-review-gate/SKILL.md the full PR review runbook"
```

---

### Task 4: Close the extraFiles enumeration trap

**Files:**
- Modify: `scripts/verify-cache.mjs:236-251`
- Modify: `scripts/tests/verify-cache.test.mjs` (append near the existing `stepTouchedByDiff` block at :414-440)

**Interfaces:**
- Consumes: the reference paths from Task 2.
- Produces: `test:hooks` scope coverage for anything under `.claude/skills/**`, which Task 8's mirror would otherwise each need hand-registering.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/verify-cache.test.mjs`:

```js
test('stepTouchedByDiff: a pr-review-gate reference-file diff is in scope for test:hooks', () => {
  // The three .claude/skills literals this replaced could not see a file that
  // did not exist when they were written — defect shape "a guard that
  // enumerates loses one spelling per round". A reference file added later
  // would print test:hooks [cached] and leave review-gate-mechanism.test.mjs
  // stale-green on exactly the diff that breaks it.
  const diff = ['.claude/skills/pr-review-gate/references/reviewer-brief.md'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});

test('stepTouchedByDiff: a brand-new skill file is in scope for test:hooks', () => {
  const diff = ['.claude/skills/pr-review-gate/references/some-future-file.md'];
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], diff), true);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npm run test:hooks`
Expected: FAIL — both assertions get `false`, since the literals do not match either path.

- [ ] **Step 3: Replace the literals with a glob**

In `scripts/verify-cache.mjs`, add to the `test:hooks` `globs` array (after `'.husky/**',`):

```js
        /* .claude/skills/** is an input because review-gate-mechanism.test.mjs
           reads those files as TEXT at RUNTIME. This was three literal paths
           until 2026-08-13; a literal list cannot see a file that does not
           exist yet, so every reference file added later would have needed
           hand-registering here or its diff would print test:hooks [cached]
           and leave the guard stale-green. Same #1847 trap as fixtures/**
           above, with the enumeration failure mode on top. */
        '.claude/skills/**',
```

Then delete these two now-redundant lines from `extraFiles`:

```js
        '.claude/skills/pr-review-gate/SKILL.md',
        '.claude/skills/model-routing/SKILL.md',
```

Keep `'CLAUDE.md',` — it is not under that tree — and update the surrounding comment so it no longer claims `.claude/skills/**` is outside this step's globs, which the glob above makes false.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm run test:hooks`
Expected: PASS, including the pre-existing `stepTouchedByDiff` cases at :418-440 (they assert *negative* scope for sidecar/frontend/server diffs; a too-broad glob would turn one red).

- [ ] **Step 5: Verify the CI half moved too**

`ci-scope.mjs` derives its scope from this same `STEPS[]` entry, so the glob change affects the cloud leg as well as the local cache. Confirm nothing else reads the deleted literals:

Run: `git grep -n "skills/pr-review-gate/SKILL.md" -- scripts/`
Expected: only `scripts/tests/review-gate-mechanism.test.mjs` (which builds its own path from `join()`), no `verify-cache.mjs` hit.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-cache.mjs scripts/tests/verify-cache.test.mjs
git commit -m "chore(scripts): scope test:hooks to .claude/skills/** instead of three literals"
```

---

### Task 5: Link-integrity assertion

Write this **before** Task 6 moves the sections, so the dangling anchor is observed red rather than reasoned about.

**Files:**
- Modify: `scripts/tests/review-gate-mechanism.test.mjs`

**Interfaces:**
- Produces: an assertion Task 6 must satisfy before its commit is allowed to land.

- [ ] **Step 1: Extend the imports**

The file already imports `basename, dirname, join` from `node:path`. Add `resolve`:

```js
import { basename, dirname, join, resolve } from 'node:path';
```

- [ ] **Step 2: Write the failing test**

```js
// Markdown links of the form ](some/relative/path.md#anchor) — http(s) links
// are skipped, and so are bare #anchor links (no file part to resolve).
const INTRA_REPO_ANCHOR_LINK = /\]\((?!https?:)([^)#\s]+\.md)#([^)\s]+)\)/g;

/** GitHub's heading-anchor slug: strip backticks, lowercase, drop punctuation,
 *  spaces to hyphens. Good enough for the headings in these four files. */
function githubAnchor(heading) {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/ +/g, '-');
}

function headingAnchors(file) {
  const anchors = new Set();
  for (const line of readNormalized(file).split('\n')) {
    const m = /^#{1,6} +(.+?)\s*$/.exec(line);
    if (m) anchors.add(githubAnchor(m[1]));
  }
  return anchors;
}

test('intra-repo anchor links in CLAUDE.md and both gate skills resolve to real headings', () => {
  // CLAUDE.md:716 links model-routing/SKILL.md#mandatory-independent-review-prs.
  // Moving that section breaks the anchor while the existing string-match
  // assertion ("step 10 references pr-review-gate") stays GREEN — the guard
  // would certify the very line it broke. Presence of a word is not integrity
  // of a link.
  const broken = [];
  for (const source of [CLAUDE_MD_PATH, GATE_SKILL_PATH, ROUTING_SKILL_PATH]) {
    for (const [, relPath, anchor] of readNormalized(source).matchAll(INTRA_REPO_ANCHOR_LINK)) {
      const target = resolve(dirname(source), relPath);
      if (!existsSync(target)) {
        broken.push(`${basename(source)} -> ${relPath} (file does not exist)`);
        continue;
      }
      if (!headingAnchors(target).has(anchor.toLowerCase())) {
        broken.push(`${basename(source)} -> ${relPath}#${anchor} (no such heading)`);
      }
    }
  }
  assert.deepEqual(broken, [], `dangling intra-repo anchor links:\n  ${broken.join('\n  ')}`);
});
```

- [ ] **Step 3: Run it — and triage what it reports**

Run: `npm run test:hooks`

This assertion scans three long, much-edited files, so it may surface **pre-existing** dangling links that have nothing to do with this work. Triage before touching anything, per CLAUDE.md's hook-failure rule:

- A link this branch broke → fix it here.
- A link already broken on `main` → **stop and surface it to the user.** Do not silently fold unrelated fixes into this commit. Confirm with `git stash && git switch main && npm run test:hooks` (after temporarily copying the new test in), then restore.

Expected at this point: PASS, because Task 6 has not yet moved the sections. If it passes, that is the correct baseline — the assertion's value is proven in step 4.

- [ ] **Step 4: Mutation-verify against the real defect**

Temporarily rename `## Mandatory independent review (PRs)` in `model-routing/SKILL.md` to `## Mandatory independent review`, run `npm run test:hooks`, and confirm RED naming `CLAUDE.md -> .claude/skills/model-routing/SKILL.md#mandatory-independent-review-prs`. Restore the heading. **This is the mutation that matters** — it reproduces exactly the defect Task 6 would otherwise ship.

- [ ] **Step 5: Commit**

```bash
git add scripts/tests/review-gate-mechanism.test.mjs
git commit -m "test(scripts): assert intra-repo anchor links in the gate docs resolve"
```

---

### Task 6: Move the sections and fix CLAUDE.md — last, and in one commit

High-contention files. Rebase immediately before starting, and keep the window between reading and committing as small as possible.

**Files:**
- Modify: `.claude/skills/model-routing/SKILL.md` (delete two sections, add pointer)
- Modify: `CLAUDE.md:716` and `CLAUDE.md:301-306`
- Modify: `scripts/tests/review-gate-mechanism.test.mjs` (one new assertion)

**Interfaces:**
- Consumes: `SKILL.md`'s `## Effort level` and `## Dispatch` from Task 3; the link-integrity assertion from Task 5.

- [ ] **Step 1: Rebase**

```bash
git fetch origin && git rebase origin/main
npm run test:hooks
```
Expected: PASS before you change anything. If red, triage per CLAUDE.md before proceeding.

- [ ] **Step 2: Write the failing test**

```js
test('model-routing/SKILL.md no longer carries the moved PR-review sections', () => {
  // The move exists to end a rule living in two places. Without this, a future
  // edit can paste either section back and both files drift apart silently —
  // the exact failure the move was meant to fix.
  const src = readNormalized(ROUTING_SKILL_PATH);
  assert.doesNotMatch(
    src,
    /^## Mandatory independent review \(PRs\)$/m,
    'model-routing/SKILL.md still carries "## Mandatory independent review (PRs)" — ' +
      'it moved to pr-review-gate/SKILL.md; two copies will drift',
  );
  assert.doesNotMatch(
    src,
    /^## PR-gate issue verification$/m,
    'model-routing/SKILL.md still carries "## PR-gate issue verification" — ' +
      'it moved to pr-review-gate/SKILL.md; two copies will drift',
  );
  assert.match(
    src,
    /pr-review-gate/,
    'model-routing/SKILL.md must keep a pointer to where the PR sections went',
  );
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `npm run test:hooks`
Expected: FAIL — both sections still present.

- [ ] **Step 4: Delete the two sections from `model-routing/SKILL.md`**

Remove `## Mandatory independent review (PRs)` and `## PR-gate issue verification` in full. Replace them with:

```markdown
## PR review

Moved out of this file 2026-08-13. The sequence, the docs-only exemption, the
effort ladder, dispatch, the PR comment, findings triage, the re-review trigger
and loop cap, and issue verification at PR creation all live in
[`pr-review-gate`](../pr-review-gate/SKILL.md). Routing keeps routing; that file
owns the PR process.

The judgment-call carve-out below is shared by both review loops and stays here.
```

Keep `## Routing table`, `## Escalation (subagent dispatch)`, `## Session-level drift`, `## Mandatory adversarial review (specs & plans)`, and `## Judgment-call carve-out`.

- [ ] **Step 5: Fix `CLAUDE.md:716`**

Change step 10's link so it no longer points at the moved section:

```markdown
10. **Independent PR review.** Once every item above is done (or explicitly marked not-applicable) and the branch is pushed, run the mandatory gate via the `pr-review-gate` skill — see [the PR review runbook](.claude/skills/pr-review-gate/SKILL.md). Triage and fold findings before merge.
```

- [ ] **Step 6: Fix `CLAUDE.md:301-306`**

The bullet restates the effort ladder inline and closes with "see the model-routing skill for the full split." Keep the restatement — CLAUDE.md's quick-reference layer is deliberate — and re-aim the pointer:

```markdown
  `high` for `refactor`/`perf` or any multi-scope PR — see the
  `pr-review-gate` skill for the full split.
```

- [ ] **Step 7: Run tests and verify they pass**

Run: `npm run test:hooks`
Expected: PASS — including the link-integrity assertion from Task 5, which is the one proving step 5 actually fixed the anchor rather than moving it.

- [ ] **Step 8: Run the branch battery**

Run: `npm run verify:fast:branch`
Expected: green, or every red leg triaged as pre-existing per CLAUDE.md.

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md .claude/skills/model-routing/SKILL.md scripts/tests/review-gate-mechanism.test.mjs
git commit -m "docs(docs): move the PR-review sections from model-routing into pr-review-gate"
```

---

### Task 7: Bookkeeping and PR

**Files:**
- Modify: `docs/features/235-model-routing-review-gates.md`
- Modify: `docs/superpowers/specs/2026-08-13-pr-review-skill-design.md` (frontmatter `status:`)

- [ ] **Step 1: File the issue**

```bash
gh issue create --title "ops-NN — widen pr-review-gate into the full PR review process" \
  --label "area:ops,type:chore" \
  --body-file -
```

Body: what moved, why, and that `docs/BACKLOG.md` needs no row because chores never render there. Use `--body-file -` and pipe the text — `--body @-` writes the literal string `@-`.

- [ ] **Step 2: Update plan 235**

Add to `docs/features/235-model-routing-review-gates.md` a line recording that the PR-review sections moved out of `model-routing/SKILL.md` into `pr-review-gate/SKILL.md` on 2026-08-13, so a reader of the older plan is not sent to a file that no longer holds them.

- [ ] **Step 3: Flip the spec's status**

Set the spec's frontmatter to `status: active`.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin docs/docs-pr-review-skill
gh pr create --title "docs(docs): widen pr-review-gate into the full PR review process" --body-file -
```

Body must contain a literal `Closes #NN` (not backticked — a code-span `Closes` does not auto-close), a Summary, and a Test plan. State explicitly:

- **Release notes: not applicable** — process/tooling change, no user- or operator-visible delta.
- **On-box acceptance: not applicable** — no hardware-provable behaviour.
- **Not docs-only** — touches `scripts/**`, so `verify.yml` runs in full and this gate applies to itself.
- **Also fixed, found in passing:** the guard file's header-comment numbering, the dead `CLAUDE.md:716` anchor, the stale `CLAUDE.md:301-306` pointer, and the `extraFiles` enumeration trap.

- [ ] **Step 5: Run the gate on itself**

This PR is not docs-only, so it takes its own review pass — the first real exercise of the runbook it ships. Dispatch per the new `SKILL.md`, at effort `high` (multi-scope: `docs` + `scripts`). Capture the tree check before and after. The reviewer posts its own comment.

---

### Task 8 — CONDITIONAL: mirror script and guard

**Run only if Task 1 recorded `MIRROR_NEEDED:` with at least one agent.** If it recorded `none`, mark this task skipped in the plan and in the probe doc, and do not create any of these files. Shipping a synchronization mechanism with zero consumers is how #2314's three-copy problem started.

**Files (only if warranted):**
- Create: `scripts/sync-agent-skills.mjs`
- Modify: `scripts/tests/review-gate-mechanism.test.mjs`
- Modify: `package.json` (a `skills:sync` script)

- [ ] **Step 1: Write the failing test**

```js
test('each agent-skill mirror matches its canonical source', () => {
  // A mirror that silently drifts is worse than no mirror: the other agent
  // reviews against a rubric this repo no longer believes in.
  for (const [mirrorRel, canonicalRel] of MIRRORED_SKILL_PAIRS) {
    const mirror = join(REPO_ROOT, mirrorRel);
    const canonical = join(REPO_ROOT, canonicalRel);
    assert.ok(existsSync(mirror), `missing mirror ${mirrorRel} — run npm run skills:sync`);
    assert.equal(
      readNormalized(mirror),
      readNormalized(canonical),
      `${mirrorRel} has drifted from ${canonicalRel} — run npm run skills:sync`,
    );
  }
});
```

`MIRRORED_SKILL_PAIRS` is derived from the probe's agent list, declared at the top of the test file next to the other path constants.

- [ ] **Step 2: Run it and verify it fails** — Run: `npm run test:hooks`. Expected: FAIL, missing mirror.

- [ ] **Step 3: Write `scripts/sync-agent-skills.mjs`** — copies the canonical directory to each mirror path, exits non-zero on write failure. Add `"skills:sync": "node scripts/sync-agent-skills.mjs"` to `package.json`.

- [ ] **Step 4: Run the sync, then the tests** — `npm run skills:sync && npm run test:hooks`. Expected: PASS.

- [ ] **Step 5: Mutation-verify** — append a character to one mirrored file, run, confirm RED naming that file. Re-sync.

- [ ] **Step 6: Commit**

```bash
git add scripts/sync-agent-skills.mjs package.json scripts/tests/review-gate-mechanism.test.mjs <mirror paths>
git commit -m "chore(scripts): mirror pr-review-gate into the agent skill paths that need it"
```

---

## Self-Review

**Spec coverage.** Layout → Task 2. `SKILL.md` runbook + "name and link, do not restate" → Task 3. Reviewer posts its own comment, tree check, empty pass, docs-only exemption note → Tasks 2 (brief) and 3 (runbook). Rubric halves + catalogue maintenance → Task 2 step 4. Findings triage → Task 2 step 5. Portability + Cline caveat → Tasks 1 and 3. Cross-agent sync, conditional → Tasks 1 and 8. Guard: retarget by name, reference files, no-duplicate, link integrity, conditional mirror → Tasks 2, 3, 5, 6, 8. Enumeration trap → Task 4. `model-routing` move + both CLAUDE.md fixes → Task 6. Contention/merge-order constraint → Task 6 step 1 and Global Constraints. Bookkeeping → Task 7. **No spec section is unimplemented.**

**Placeholder scan.** The `<fill>` markers in Task 1 step 4 are a template the probe fills at runtime, not deferred design — the surrounding text states what counts as a valid entry. `MIRRORED_SKILL_PAIRS` in Task 8 is deliberately undefined until Task 1 names the agents; Task 8 does not run otherwise.

**Type consistency.** `GATE_SKILL_PATH`, `ROUTING_SKILL_PATH`, `CLAUDE_MD_PATH`, `REPO_ROOT` and `readNormalized` are the existing names in `review-gate-mechanism.test.mjs` and are used unchanged. `stepByName` and `stepTouchedByDiff` match `verify-cache.test.mjs:416` and its import at :32. `resolve` is the one added import (Task 5 step 1). Section headings the assertions match — `## Dispatch`, `## Effort level` — are the exact strings Task 3 step 3 creates.

**One ordering dependency worth restating:** Task 5 lands **before** Task 6 on purpose. Written after, its mutation test would be checking a bug already fixed; written before, it observes the real dangling anchor go red.
