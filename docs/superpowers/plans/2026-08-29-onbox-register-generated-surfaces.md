# On-box register generated surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three hand-maintained duplicate-figure surfaces in
`docs/testing/onbox-acceptance-register-live-view.html` (the stat strip, the
glance count column, the per-group `gcount` spans) plus the row-shell set with
a generator that derives them from `docs/testing/onbox-acceptance-register.md`
and checks them in CI; fix the citation checker's subject map and add an
ID-reuse-detection rule so `wrongId` can safely go fatal for the discharge
class; wire the already-built publish-nonce ancestry comparator into
`--against-published`; and stand `check-register-citations.mjs` up as its own
CI workflow.

**Architecture:** A new hand-rolled script, `scripts/build-register-live-view.mjs`
(no external deps — matches every other `scripts/*.mjs` parser), reads the `.md`
and the current `.html`, rewrites four delimited regions/structural targets in
the `.html`, and writes the result back (or, under `--check`, diffs without
writing). `scripts/check-register-citations.mjs` gets a same-file fix
(`buildLegitimateSubjectMap`) and a new same-file rule (ID-reuse detection)
rather than a new module — both operate on data structures it already builds.
`scripts/check-onbox-register.mjs` loses the four comparisons the generator's
own `--check` now covers, keeping only what stays hand-maintained
(`checkRegister`'s own `.md` arithmetic, `--against-published`).

**Tech Stack:** Node 24 (repo floor), `node:test` (no test framework dep),
plain regex/string parsing (no markdown or HTML library anywhere in `scripts/`).

**Spec:** [`docs/superpowers/specs/2026-08-28-onbox-register-generated-surfaces-design.md`](../specs/2026-08-28-onbox-register-generated-surfaces-design.md)
— read it alongside this plan; the spec argues *why*, this plan states *how*,
and its four revision notes (pass 1–4) record several designs this plan does
**not** implement (a `changelog` target, a discharge-annotation-only exemption
for `wrongId`) that an earlier draft of the spec carried and later dropped or
replaced. Do not resurrect them.

## Global Constraints

- **No `npm ci` at the CI call site.** `onbox-register-check.yml` runs
  `node scripts/*.mjs` directly with no install step — `build-register-live-view.mjs`
  may import only node builtins and `scripts/lib/*`.
- **The generator always writes LF**, regardless of the input file's line
  endings, matching the new `eol=lf` `.gitattributes` pin.
- **Every generated region is delimited by `<!-- BEGIN GENERATED:<name> -->` /
  `<!-- END GENERATED:<name> -->` HTML comments**, except `groups` and the
  row-shell set, which are located structurally (see Task 6, Task 7).
- **`.md`/`.html` line citations in this plan and the spec drift on nearly
  every merge to `main`.** Every task below re-derives what it needs from the
  live file at the start of that task rather than trusting a cited line
  number — citations here are illustrative starting points, not contracts.
  `scripts/*.mjs` function names and signatures are stable and can be trusted.
- **Never hand-edit `docs/testing/onbox-acceptance-register-live-view.html` or
  `.md`'s generated regions once a task's tests are green** — re-run
  `npm run register:build` instead, so the fixtures this plan writes stay the
  source of truth for what "generated" looks like.
- **A citation or defect description written into any tracked file — including
  this plan — must never place the word "row"/"rows" immediately before a
  bare register-ID-shaped token** (e.g. `` row A40 ``). `check-register-citations.mjs`'s
  `ROW_CITATION_REGEX` matches that shape anywhere in the tree and will fail
  `test:hooks` on the prose itself, not just on a real citation. This plan
  observes that rule throughout (see Task 9).

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/build-register-live-view.mjs` | New. Parses the `.md`, parses the current `.html`, computes the four generated targets, reconciles row shells, writes (or `--check`s) the result. |
| `scripts/tests/build-register-live-view.test.mjs` | New. Fixture-based unit tests (own `buildRegister`/`buildLiveView` helpers, mirroring `check-onbox-register.test.mjs`'s pattern) plus the real-file `--check` run that replaces `check-onbox-register.test.mjs:1181`. |
| `scripts/check-onbox-register.mjs` | Modified (Task 8). Loses the owed-total, glance-count, and `gcount` comparisons; keeps `checkRegister`, `--against-published`, and the shell-reconciliation-adjacent `extraOnly`/`staleExtra` machinery. |
| `scripts/check-register-citations.mjs` | Modified (Task 3, Task 9, Task 11). `buildLegitimateSubjectMap` reads bodies; a new reuse-detection branch in `recordSubjectConflict`; `wrongId` gated behavior changes. |
| `scripts/publish-token.mjs` | Unchanged — `comparePublishTokens`/`nonceInHistory` already exist (PR #2740); Task 12 is the wiring, not new logic here. |
| `.gitattributes` | Modified (Task 1). Pins `*.md`/`*.html` to `eol=lf`. |
| `.github/workflows/onbox-register-check.yml` | Modified (Task 8). Runs `register:build -- --check` alongside the existing checker; path filter gains the new script. |
| `.github/workflows/register-citations-check.yml` | New (Task 13). Stands `check-register-citations.mjs` up as its own workflow. |
| `docs/testing/onbox-acceptance-register.md` | Modified (Task 2: two A1 markers; Task 10: doc fixes to the two stale annotations and the one genuinely stale citation's target). |
| `docs/testing/onbox-acceptance-register-live-view.html` | Modified (Task 2: region markers; Task 8: first `register:build` run's diff). |

---

## PR 1 — data and pins

### Task 1: Pin `*.md` and `*.html` to `eol=lf`

**Files:**
- Modify: `.gitattributes`

**Interfaces:** none — this task has no code dependents, only later tasks' CRLF-safety assumptions depend on it having landed.

- [ ] **Step 1: Add the pin**

Add, following the existing pattern (each pinned line has a comment explaining
why):

```gitattributes
# docs/testing/onbox-acceptance-register.md and its .html twin are read and
# byte-compared by scripts/build-register-live-view.mjs and
# scripts/check-onbox-register.mjs. Without this pin, a checkout with Git for
# Windows' default core.autocrlf=true materialises both as CRLF, and a naive
# byte-compare (as opposed to the CRLF-tolerant checkLiveView) sees every line
# as different. Pin to LF; the generator also always writes LF (see
# scripts/build-register-live-view.mjs's writeFile). Known limitation shared
# with every other pin in this file: this governs CHECKOUT, not re-checkout of
# a file git already believes is unchanged — an existing CRLF working tree does
# not self-heal from this pin alone.
docs/testing/onbox-acceptance-register.md text eol=lf
docs/testing/onbox-acceptance-register-live-view.html text eol=lf
```

- [ ] **Step 2: Verify the pin is read**

Run: `git check-attr eol docs/testing/onbox-acceptance-register.md docs/testing/onbox-acceptance-register-live-view.html`
Expected: both lines end `eol: lf`.

- [ ] **Step 3: Commit**

```bash
git add .gitattributes
git commit -m "chore(ops): pin the on-box register and its live view to eol=lf"
```

---

### Task 2: Insert region markers and the two A1 stat markers

**Files:**
- Modify: `docs/testing/onbox-acceptance-register-live-view.html`
- Modify: `docs/testing/onbox-acceptance-register.md`

**Interfaces:**
- Produces: three HTML comment region-marker pairs in the `.html` (`strip`,
  `glance`, `groups`) that Task 4/5/6 locate by exact string match; two
  single-line markers in the `.md` (`stat:a1-still-owed`, `stat:a1-subtotal`)
  that Task 4 reads by regex.

This task ships **no code** — it is a content-only PR-1 step, per the spec's
"marker insertion has a validation gap until PR 3 lands" note. State that gap
explicitly in the PR body: nothing asserts these markers' presence or
well-formedness until Task 4–7 land in PR 3.

- [ ] **Step 1: Re-derive the current strip/glance markup**

Read `docs/testing/onbox-acceptance-register-live-view.html` fresh (it moves on
nearly every merge). Find:
- the six `<div class="stat">…</div>` tiles inside the summary strip;
- the `<table class="glance">` and its `<tbody>` rows.

- [ ] **Step 2: Wrap the strip in region markers**

Immediately before the first `<div class="stat">` and immediately after the
last one, insert:

```html
<!-- BEGIN GENERATED:strip -->
… (existing six tiles, unchanged) …
<!-- END GENERATED:strip -->
```

- [ ] **Step 3: Wrap the glance table's count column in region markers**

The `glance` region covers **only the count cells**, not the whole table (the
Setup description cells and jump links are hand-authored and must round-trip
byte-identical). Wrap each row's count `<td>` individually:

```html
<tr><td><a href="#ga">A</a></td><td>Setup A</td><td><!-- BEGIN GENERATED:glance:A -->12<!-- END GENERATED:glance:A --></td></tr>
```

One marker pair per group letter present in the glance table today (re-derive
the letter set from the live file — do not assume it is exactly A–H).

- [ ] **Step 4: Insert the two A1 stat markers in the `.md`**

Find A1's heading (`### A1 · …`) in `docs/testing/onbox-acceptance-register.md`.
On the line **immediately after** the heading line — never inline on the
heading itself, since `checkRegister`'s heading parser and
`check-register-citations`'s `headingCitedIds` both read that line — insert:

```markdown
### A1 · <the current title, unchanged>

<!-- stat:a1-still-owed 40 -->
<!-- stat:a1-subtotal 60 -->

<the rest of A1's existing body, unchanged>
```

Replace `40`/`60` with A1's **current, re-derived** still-owed count and
sub-item total — read them out of A1's own heading/body prose (the spec's
example, `20 of 60 run … · ~40 still owed`, is illustrative, not current).

- [ ] **Step 5: Verify no generated-target markup changed**

Run: `git diff docs/testing/onbox-acceptance-register-live-view.html docs/testing/onbox-acceptance-register.md`
Expected: only comment insertions — no tile value, glance count, or row body
text changed.

- [ ] **Step 6: Verify the register's own checks still pass**

Run: `node scripts/check-onbox-register.mjs && node scripts/check-register-citations.mjs`
Expected: both exit 0 — the new comments and markers are inert to both
existing checkers (`checkRegister`/`checkLiveView` ignore unknown HTML
comments; `check-register-citations.mjs`'s `FROZEN_EXACT` set already excludes
both register files from citation scanning).

- [ ] **Step 7: Commit**

```bash
git add docs/testing/onbox-acceptance-register.md docs/testing/onbox-acceptance-register-live-view.html
git commit -m "chore(ops): insert generated-region markers and A1 stat markers"
```

- [ ] **Step 8: Open PR 1**

Title: `chore(ops): pin register surfaces to eol=lf and insert generator markers`.
Body must state the validation gap from this task's header note. `Refs #2721`
(no `Closes` yet — PR 1 alone doesn't close anything).

---

## PR 2 — the subject map

### Task 3: `buildLegitimateSubjectMap` reads row bodies and distinguishes PR numbers from issue numbers

**Files:**
- Modify: `scripts/check-register-citations.mjs`
- Test: `scripts/tests/check-register-citations.test.mjs`

**Interfaces:**
- Consumes: `registerRows` — a `Map<id, { issues: Set<string>, body: string, … }>`
  already built upstream (re-derive the exact row shape by reading the
  function that builds `registerRows` before writing this task's code — it is
  passed into `buildLegitimateSubjectMap` unchanged today).
- Produces: `buildLegitimateSubjectMap(registerRows): Map<subject, Set<id>>` —
  same signature, richer population. Consumed downstream by
  `recordSubjectConflict`/`checkConflictingSubjects` (Task 9 extends the same
  function further, in place).

Today `buildLegitimateSubjectMap` (re-derive its exact current line — was
`:1280` at spec-writing time) populates the map from `row.issues` only, which
is itself populated from **heading text alone**. Two gaps this task closes:

1. A subject cited in a row's **body** (not its heading) is not recognised —
   the `A3`/`#1230` case (A3's heading has no `#1230`; the number is in A3's
   body prose).
2. A **PR** number appearing near a subject number is not distinguished from
   an **issue** number — the `A32`/`#2316` case (`#2316` is a PR; A32's real
   subject, an issue, is `#2310`, already in the heading and already handled).

- [ ] **Step 1: Read the current registerRows shape and row-body extraction, if any exists**

Before writing code, grep the file for where `registerRows` is built (search
for `registerRows.set` or the function returning it) and confirm whether row
`body` text is already captured per row. If it is not, this task also needs to
capture it there — write down the actual current shape before Step 2, since
this plan cannot assume it unchanged.

- [ ] **Step 2: Write the failing tests**

```javascript
test('a subject cited only in a row body resolves via buildLegitimateSubjectMap', () => {
  const registerRows = new Map([
    [
      'A3',
      {
        issues: new Set(),
        body: 'Some prose mentioning the linked issue #1230 in passing.',
      },
    ],
  ]);
  const map = buildLegitimateSubjectMap(registerRows);
  assert.deepEqual([...(map.get('1230') ?? [])], ['A3']);
});

test('a PR number near a subject is not folded into the subject set', () => {
  const registerRows = new Map([
    [
      'A32',
      {
        issues: new Set(['2310']),
        body: 'Fixed by PR #2316, closing #2310.',
      },
    ],
  ]);
  const map = buildLegitimateSubjectMap(registerRows);
  assert.deepEqual([...(map.get('2310') ?? [])], ['A32']);
  assert.equal(map.has('2316'), false);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test scripts/tests/check-register-citations.test.mjs`
Expected: FAIL — `map.get('1230')` is `undefined` today (body not scanned).

- [ ] **Step 4: Implement the body scan with PR/issue discrimination**

The discriminator available in this corpus (verified against the two real
cases in the spec — `#2316`/PR vs `#2310`/issue, `#2398`/PR vs `#2106`/issue):
a number is a **PR** number when it is immediately preceded by the literal
text `PR ` or wrapped as a markdown link to `/pull/`; otherwise, when it
appears as a bare `#NNNN` or a markdown link to `/issues/`, it is an issue
number and a legitimate subject. Implement both surfaces (bare `#NNNN` and a
markdown `[#NNNN](.../issues/NNNN)` / `[#NNNN](.../pull/NNNN)` link), since the
real register body prose uses both — re-check this against a fresh sample of
row bodies before finalising the regex, since this plan's citation of the two
real cases may itself have drifted.

```javascript
// A number preceded by "PR " (case-sensitive — the register's own convention)
// or linked to /pull/ is a PR reference, never a legitimate subject. Every
// other #NNNN — bare or linked to /issues/ — is a candidate subject.
const PR_NUMBER_REGEX = /\bPR\s+#(\d+)\b|\/pull\/(\d+)\b/g;
const ANY_NUMBER_REGEX = /#(\d+)\b|\/issues\/(\d+)\b/g;

function extractPrNumbers(text) {
  const prs = new Set();
  for (const m of text.matchAll(PR_NUMBER_REGEX)) prs.add(m[1] ?? m[2]);
  return prs;
}

function extractBodySubjects(text) {
  const prs = extractPrNumbers(text);
  const subjects = new Set();
  for (const m of text.matchAll(ANY_NUMBER_REGEX)) {
    const n = m[1] ?? m[2];
    if (!prs.has(n)) subjects.add(n);
  }
  return subjects;
}

function buildLegitimateSubjectMap(registerRows) {
  const map = new Map();
  const add = (subject, id) => {
    if (!map.has(subject)) map.set(subject, new Set());
    map.get(subject).add(id);
  };
  for (const [id, row] of registerRows) {
    for (const subject of row.issues) add(subject, id);
    for (const subject of extractBodySubjects(row.body ?? '')) add(subject, id);
  }
  return map;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test scripts/tests/check-register-citations.test.mjs`
Expected: PASS, both new tests and every pre-existing test in the file.

- [ ] **Step 6: Re-measure the six known residuals against the real tree**

Run: `node scripts/check-register-citations.mjs --strict`
Record the output verbatim in the PR body under a "Re-measured residuals"
heading — do not summarise from the spec's own pass-3/pass-4 numbers, which
may already be stale. **This task does not correct any citation** — Task 10
does, once Task 9's reuse-detection rule has adjudicated each survivor.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-register-citations.mjs scripts/tests/check-register-citations.test.mjs
git commit -m "fix(ops): read row bodies and distinguish PR/issue numbers in the citation subject map"
```

- [ ] **Step 8: Open PR 2**

Title: `fix(ops): buildLegitimateSubjectMap reads row bodies, not just headings`.
Body includes the re-measured residual list from Step 6. `Refs #2721`.

---

## PR 3 — the generator and the retirement

### Task 4: Generator skeleton, CLI, and the `strip` target

**Files:**
- Create: `scripts/build-register-live-view.mjs`
- Create: `scripts/tests/build-register-live-view.test.mjs`

**Interfaces:**
- Produces: `parseRegisterFigures(mdText): { owedTotal, oldestDebtRaw, glanceGroups: Map<letter,int>, blockedCount, unconfirmedCount, a1StillOwed, a1Subtotal }` and `buildStripRegion(figures): string` — consumed by Task 5/6/7, which extend the same module.
- Produces: `applyGeneratedRegion(html, name, newInner): string` — a shared
  region-replace primitive (locate `<!-- BEGIN GENERATED:name -->…<!-- END
  GENERATED:name -->`, replace the inner text, throw if the pair is absent).
  Consumed by every later target.
- Produces: `main(registerPath, liveViewPath, { check = false } = {})` — the
  CLI entry, exported (not just invoked) so `main()`'s own logic is unit-testable, per the pattern `check-register-citations.mjs`'s own header comment records as the fix for an earlier "nothing called `main()` end to end" mutation-test gap.

- [ ] **Step 1: Write the failing test for the region-replace primitive**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGeneratedRegion } from '../build-register-live-view.mjs';

test('applyGeneratedRegion replaces only the marked region', () => {
  const html = 'before\n<!-- BEGIN GENERATED:x -->old<!-- END GENERATED:x -->\nafter';
  const result = applyGeneratedRegion(html, 'x', 'new');
  assert.equal(result, 'before\n<!-- BEGIN GENERATED:x -->new<!-- END GENERATED:x -->\nafter');
});

test('applyGeneratedRegion throws when the marker pair is missing', () => {
  assert.throws(
    () => applyGeneratedRegion('no markers here', 'x', 'new'),
    /missing generated-region marker pair "x"/,
  );
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test scripts/tests/build-register-live-view.test.mjs`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement the region-replace primitive and the module shell**

```javascript
#!/usr/bin/env node
// scripts/build-register-live-view.mjs
//
// Reconciles derived figures and row shells in
// docs/testing/onbox-acceptance-register-live-view.html against
// docs/testing/onbox-acceptance-register.md. Every hand-authored byte outside
// a generated target (BEGIN/END GENERATED:<name> region, or a row shell's own
// body/iname/risk spans) is preserved verbatim. See
// docs/superpowers/specs/2026-08-28-onbox-register-generated-surfaces-design.md
// for the design; this comment states only the invariants the code must hold.
//
// Usage:
//   node scripts/build-register-live-view.mjs            # write the result
//   node scripts/build-register-live-view.mjs --check     # report, change nothing; exit 1 on drift
//
// No npm dependencies: onbox-register-check.yml runs this with no `npm ci`
// step. node builtins and scripts/lib/* only.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNormalized } from './lib/read-normalized.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REGISTER_PATH = 'docs/testing/onbox-acceptance-register.md';
export const DEFAULT_LIVE_VIEW_PATH = 'docs/testing/onbox-acceptance-register-live-view.html';

export function applyGeneratedRegion(html, name, newInner) {
  const beginMarker = `<!-- BEGIN GENERATED:${name} -->`;
  const endMarker = `<!-- END GENERATED:${name} -->`;
  const beginIndex = html.indexOf(beginMarker);
  const endIndex = html.indexOf(endMarker);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    throw new Error(`missing generated-region marker pair "${name}"`);
  }
  const before = html.slice(0, beginIndex + beginMarker.length);
  const after = html.slice(endIndex);
  return `${before}${newInner}${after}`;
}

export function main(
  registerPath = DEFAULT_REGISTER_PATH,
  liveViewPath = DEFAULT_LIVE_VIEW_PATH,
  { check = false, repoRoot = REPO_ROOT } = {},
) {
  const mdPath = resolve(repoRoot, registerPath);
  const htmlPath = resolve(repoRoot, liveViewPath);
  const mdText = readNormalized(mdPath);
  const currentHtml = readNormalized(htmlPath);

  const nextHtml = buildLiveView(mdText, currentHtml);

  if (check) {
    if (nextHtml !== currentHtml) {
      console.error(
        `register:build --check: ${liveViewPath} is out of date. Run \`npm run register:build\` and commit the result.`,
      );
      return 1;
    }
    console.log('register:build --check: up to date.');
    return 0;
  }

  // Always write LF — see Task 8's CRLF-handling addition to buildLiveView's
  // caller contract; this file's job is only to persist bytes it is handed.
  writeFileSync(htmlPath, nextHtml.replace(/\r\n/g, '\n'));
  console.log(`register:build: wrote ${liveViewPath}.`);
  return 0;
}

// buildLiveView itself is added incrementally across Tasks 4-7 — this
// placeholder is replaced by Step 4 below in THIS task (strip only), then
// extended in place by each later task. Never leave it calling only a subset
// silently — every task in PR 3 must update this function's body, not add a
// parallel one.
export function buildLiveView(mdText, currentHtml) {
  const figures = parseRegisterFigures(mdText);
  let html = currentHtml;
  html = applyGeneratedRegion(html, 'strip', buildStripRegion(figures));
  return html;
}

if (isDirectlyInvoked(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const unknown = args.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    console.error(`register:build: unrecognised argument(s): ${unknown.join(', ')}`);
    process.exit(1);
  }
  process.exit(main(DEFAULT_REGISTER_PATH, DEFAULT_LIVE_VIEW_PATH, { check }));
}
```

Check `scripts/lib/is-main-module.mjs` exists with an `isDirectlyInvoked` export
before relying on it (`stamp-publish-token.mjs` already imports it, so it
should) — re-derive its exact signature from that file if this import fails.

- [ ] **Step 4: Write the failing tests for `parseRegisterFigures` and `buildStripRegion`**

```javascript
function buildRegisterFixture({
  owed = 61,
  oldest = '**2026-06-01**',
  glanceRows = [['A', 37], ['B', 2], ['C', 4], ['D', 3], ['E', 10], ['G', 2], ['H', 2]],
  blocked = 5,
  unconfirmed = 2,
  a1StillOwed = 40,
  a1Subtotal = 60,
} = {}) {
  const rows = glanceRows
    .map(([l, n]) => `| **${l}** | Setup ${l} | ${n} |`)
    .join('\n');
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
${rows}
| — | **Blocked** (hardware absent) | ${blocked} |
| — | **Unconfirmed** (not debts until substantiated) | ${unconfirmed} |

**${owed} owed.** Oldest: ${oldest} (plan 161).

---

## Group A — setup a

### A1 · A title

<!-- stat:a1-still-owed ${a1StillOwed} -->
<!-- stat:a1-subtotal ${a1Subtotal} -->

Some body text.
`;
}

test('parseRegisterFigures reads the owed total, oldest debt, and A1 markers', () => {
  const figures = parseRegisterFigures(buildRegisterFixture());
  assert.equal(figures.owedTotal, 61);
  assert.equal(figures.oldestDebtRaw, '**2026-06-01**');
  assert.equal(figures.a1StillOwed, 40);
  assert.equal(figures.a1Subtotal, 60);
});

test('parseRegisterFigures excludes Blocked/Unconfirmed from glanceGroups', () => {
  const figures = parseRegisterFigures(buildRegisterFixture());
  assert.deepEqual([...figures.glanceGroups.keys()].sort(), ['A', 'B', 'C', 'D', 'E', 'G', 'H']);
  assert.equal(figures.blockedCount, 5);
  assert.equal(figures.unconfirmedCount, 2);
});

test('buildStripRegion derives the Groups tile excluding Blocked/Unconfirmed, and the Oldest-debt tile strips markup and the year', () => {
  const inner = buildStripRegion(parseRegisterFigures(buildRegisterFixture()));
  assert.match(inner, /Groups.*7/s); // 7 lettered groups, not 9
  assert.match(inner, /06-01/);
  assert.doesNotMatch(inner, /2026-06-01/);
});

test('buildStripRegion does not derive the A1 tile from the owed total — the coincidence trap', () => {
  const withDifferentOwed = buildRegisterFixture({ owed: 999 });
  const inner = buildStripRegion(parseRegisterFigures(withDifferentOwed));
  assert.match(inner, /\(of 60\)/); // still A1's own subtotal marker, unaffected by owed=999
});

test('a missing A1 marker is an explicit error, not a silent skip', () => {
  const noMarkers = buildRegisterFixture().replace(
    /<!-- stat:a1-still-owed \d+ -->\n<!-- stat:a1-subtotal \d+ -->\n/,
    '',
  );
  assert.throws(() => parseRegisterFigures(noMarkers), /stat:a1-still-owed/);
});
```

- [ ] **Step 5: Verify failure**

Run: `node --test scripts/tests/build-register-live-view.test.mjs`
Expected: FAIL — `parseRegisterFigures`/`buildStripRegion` don't exist yet.

- [ ] **Step 6: Implement `parseRegisterFigures` and `buildStripRegion`**

```javascript
const GLANCE_ROW_REGEX = /^\|\s*(?:\*\*([A-Z])\*\*|—)\s*\|\s*(.*?)\s*\|\s*(\d+)\s*\|\s*$/gm;
const OWED_TOTAL_REGEX = /\*\*(\d+)\s+owed\.\*\*\s*Oldest:\s*(\S.*?)\s*\(/;
const A1_STILL_OWED_REGEX = /<!--\s*stat:a1-still-owed\s+(\d+)\s*-->/;
const A1_SUBTOTAL_REGEX = /<!--\s*stat:a1-subtotal\s+(\d+)\s*-->/;

export function parseRegisterFigures(mdText) {
  const glanceGroups = new Map();
  let blockedCount = null;
  let unconfirmedCount = null;
  for (const m of mdText.matchAll(GLANCE_ROW_REGEX)) {
    const [, letter, label, countRaw] = m;
    const count = Number(countRaw);
    if (letter) {
      glanceGroups.set(letter, count);
    } else if (/^\*\*Blocked\*\*/.test(label)) {
      blockedCount = count;
    } else if (/^\*\*Unconfirmed\*\*/.test(label)) {
      unconfirmedCount = count;
    }
  }
  if (blockedCount === null) throw new Error('parseRegisterFigures: no Blocked row in the glance table');
  if (unconfirmedCount === null) throw new Error('parseRegisterFigures: no Unconfirmed row in the glance table');

  const owedMatch = mdText.match(OWED_TOTAL_REGEX);
  if (!owedMatch) throw new Error('parseRegisterFigures: no "**N owed.** Oldest: ..." line found');
  const owedTotal = Number(owedMatch[1]);
  const oldestDebtRaw = owedMatch[2];

  const a1StillOwedMatch = mdText.match(A1_STILL_OWED_REGEX);
  if (!a1StillOwedMatch) throw new Error('parseRegisterFigures: missing stat:a1-still-owed marker');
  const a1SubtotalMatch = mdText.match(A1_SUBTOTAL_REGEX);
  if (!a1SubtotalMatch) throw new Error('parseRegisterFigures: missing stat:a1-subtotal marker');

  return {
    owedTotal,
    oldestDebtRaw,
    glanceGroups,
    blockedCount,
    unconfirmedCount,
    a1StillOwed: Number(a1StillOwedMatch[1]),
    a1Subtotal: Number(a1SubtotalMatch[1]),
  };
}

// Oldest-debt tile: strip bold markup, then the leading YYYY- year prefix,
// keeping MM-DD. Three transforms — bold-strip, label-strip (none present in
// oldestDebtRaw as captured, since OWED_TOTAL_REGEX already stops before any
// trailing label), year-strip — the year-strip is the one earlier drafts of
// this rule missed.
function formatOldestDebt(raw) {
  const noBold = raw.replace(/\*\*/g, '');
  const noYear = noBold.replace(/^\d{4}-/, '');
  return noYear;
}

export function buildStripRegion(figures) {
  return `
    <div class="stat"><div class="n owed">${figures.owedTotal}</div><div class="l">Owed</div></div>
    <div class="stat"><div class="n">${figures.glanceGroups.size}</div><div class="l">Groups</div></div>
    <div class="stat"><div class="n">${figures.blockedCount}</div><div class="l">Blocked</div></div>
    <div class="stat"><div class="n">${figures.unconfirmedCount}</div><div class="l">Unconfirmed</div></div>
    <div class="stat"><div class="n">${figures.a1StillOwed}</div><div class="l">Still owed in A1 (of ${figures.a1Subtotal})</div></div>
    <div class="stat"><div class="n">${formatOldestDebt(figures.oldestDebtRaw)}</div><div class="l">Oldest debt</div></div>
  `;
}
```

Before trusting the six-tile ordering/label wording above, **read the current
`<!-- BEGIN GENERATED:strip -->` region's six tiles** (inserted in Task 2) and
match this function's output exactly against their existing label text — the
snippet above is a starting structure, not a verified transcript, per this
plan's own re-derive-at-implementation-time constraint.

- [ ] **Step 7: Verify pass**

Run: `node --test scripts/tests/build-register-live-view.test.mjs`
Expected: PASS.

- [ ] **Step 8: Run against the real files and inspect the diff**

Run: `node scripts/build-register-live-view.mjs && git diff docs/testing/onbox-acceptance-register-live-view.html`
Expected: only the six strip tiles change (or none, if they already agree —
unlikely, since the A1-tile note in the spec already found a live discrepancy).
Read the diff; if anything outside the `strip` region changed, `applyGeneratedRegion`
or the marker placement from Task 2 is wrong — stop and fix before continuing.

- [ ] **Step 9: Revert the real-file write for now**

```bash
git checkout -- docs/testing/onbox-acceptance-register-live-view.html
```

(Task 8 is where the real-file write actually lands, after every target and
the CI wiring are in place — writing it now would ship a half-generated file.)

- [ ] **Step 10: Commit**

```bash
git add scripts/build-register-live-view.mjs scripts/tests/build-register-live-view.test.mjs package.json
git commit -m "feat(ops): add the register live-view generator (strip target)"
```

Add `"register:build": "node scripts/build-register-live-view.mjs"` to
`package.json`'s `scripts` block in this commit.

---

### Task 5: The `glance` target

**Files:**
- Modify: `scripts/build-register-live-view.mjs`
- Test: `scripts/tests/build-register-live-view.test.mjs`

**Interfaces:**
- Consumes: `figures.glanceGroups` from Task 4.
- Produces: extends `buildLiveView` to also rewrite each `glance:<letter>`
  region; no new exported names.

- [ ] **Step 1: Extend the test fixture with per-group markers**

Update `buildRegisterFixture`'s companion live-view fixture (add a
`buildLiveViewFixture` matching Task 4's `buildRegisterFixture`'s group
letters, with `<!-- BEGIN GENERATED:glance:A -->99<!-- END GENERATED:glance:A -->`
per letter) and write:

```javascript
test('buildLiveView rewrites only the glance count cells that changed', () => {
  const md = buildRegisterFixture({ glanceRows: [['A', 5], ['B', 2]] });
  const html = buildLiveViewFixture({ glance: { A: 99, B: 2 } });
  const next = buildLiveView(md, html);
  assert.match(next, /BEGIN GENERATED:glance:A -->5<!-- END/);
  assert.match(next, /BEGIN GENERATED:glance:B -->2<!-- END/); // unchanged value, still rewritten byte-identically
});

test('buildLiveView never touches the Setup cell or the jump link', () => {
  const md = buildRegisterFixture();
  const html = buildLiveViewFixture({ setupText: 'A hand-authored, editorially shortened description' });
  const next = buildLiveView(md, html);
  assert.match(next, /A hand-authored, editorially shortened description/);
});
```

- [ ] **Step 2: Verify failure, implement, verify pass**

Run: `node --test scripts/tests/build-register-live-view.test.mjs` → FAIL.

```javascript
export function buildLiveView(mdText, currentHtml) {
  const figures = parseRegisterFigures(mdText);
  let html = currentHtml;
  html = applyGeneratedRegion(html, 'strip', buildStripRegion(figures));
  for (const [letter, count] of figures.glanceGroups) {
    html = applyGeneratedRegion(html, `glance:${letter}`, String(count));
  }
  return html;
}
```

Run: `node --test scripts/tests/build-register-live-view.test.mjs` → PASS.

- [ ] **Step 3: Commit**

```bash
git add scripts/build-register-live-view.mjs scripts/tests/build-register-live-view.test.mjs
git commit -m "feat(ops): register-build generator — glance target"
```

---

### Task 6: The `groups` target (`gcount` spans)

**Files:**
- Modify: `scripts/build-register-live-view.mjs`
- Test: `scripts/tests/build-register-live-view.test.mjs`

**Interfaces:**
- Consumes: body group-heading counts, parsed fresh in this task (per-letter
  count of `### <Letter><N> · …` headings under each `## Group <Letter>`
  section), plus `figures.blockedCount`/`unconfirmedCount` from Task 4.
- Produces: extends `buildLiveView`; no new exported top-level names beyond an
  internal `parseBodyGroupCounts(mdText): Map<letter,int>` (exported for its
  own unit tests).

This target is **structural, not region-delimited** — the `gcount` span is
found by its enclosing `section[id]`, not a marker comment (the spec's own
rationale: "two targets are too scattered for regions").

- [ ] **Step 1: Write the failing tests**

```javascript
test('parseBodyGroupCounts counts headings, not the glance table', () => {
  const md = `## Group A — setup a

### A1 · one
### A2 · two

## Group B — setup b

### B1 · one
`;
  const counts = parseBodyGroupCounts(md);
  assert.deepEqual([...counts.entries()], [['A', 2], ['B', 1]]);
});

test('buildLiveView rewrites a gcount span located by its enclosing section id, leaving gtitle prose untouched', () => {
  const md = buildRegisterFixture({ glanceRows: [['A', 3]] }) + '\n### A2 · two\n### A3 · three\n';
  const html = buildLiveViewFixture({ sections: { A: { gcount: 1, gtitle: 'The GPU box (hand-authored)' } } });
  const next = buildLiveView(md, html);
  assert.match(next, /<span class="gcount">3 rows<\/span>/);
  assert.match(next, /The GPU box \(hand-authored\)/);
});

test('the groups target covers Blocked and Unconfirmed sections too', () => {
  const md = buildRegisterFixture({ blocked: 5, unconfirmed: 2 });
  const html = buildLiveViewFixture({ sections: { blocked: { gcount: 99 }, unconfirmed: { gcount: 99 } } });
  const next = buildLiveView(md, html);
  assert.match(/id="blocked"[\s\S]*?<span class="gcount">5 rows<\/span>/, next);
  assert.match(/id="unconfirmed"[\s\S]*?<span class="gcount">2 rows<\/span>/, next);
});
```

Write `buildLiveViewFixture`'s `sections` option to emit
`<section class="group" id="g<lower(letter)>">…<h3 class="gtitle">…<span class="gcount">N rows</span></h3>…</section>`
per the real markup's structure — re-derive the exact structure (attribute
order, `1 row` singular vs `N rows` plural) from the live file before finalising.

- [ ] **Step 2: Verify failure, implement, verify pass**

```javascript
const BODY_GROUP_HEADING_REGEX = /^### ([A-Z])(\d+) · /gm;

export function parseBodyGroupCounts(mdText) {
  const counts = new Map();
  for (const m of mdText.matchAll(BODY_GROUP_HEADING_REGEX)) {
    const letter = m[1];
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
  }
  return counts;
}

function rewriteGcountInSection(html, sectionId, count) {
  const sectionRegex = new RegExp(
    `(<section[^>]*\\bid="${sectionId}"[^>]*>[\\s\\S]*?<span class="gcount">)\\d+( rows?</span>)`,
  );
  const match = html.match(sectionRegex);
  if (!match) throw new Error(`build-register-live-view: no gcount span found in section#${sectionId}`);
  const word = count === 1 ? 'row' : 'rows';
  return html.replace(
    sectionRegex,
    (whole, before) => `${before}${count}${count === 1 ? ' row</span>' : ' rows</span>'}`,
  );
}

export function buildLiveView(mdText, currentHtml) {
  const figures = parseRegisterFigures(mdText);
  const bodyGroupCounts = parseBodyGroupCounts(mdText);
  let html = currentHtml;
  html = applyGeneratedRegion(html, 'strip', buildStripRegion(figures));
  for (const [letter, count] of figures.glanceGroups) {
    html = applyGeneratedRegion(html, `glance:${letter}`, String(count));
  }
  for (const [letter, count] of bodyGroupCounts) {
    html = rewriteGcountInSection(html, `g${letter.toLowerCase()}`, count);
  }
  html = rewriteGcountInSection(html, 'blocked', figures.blockedCount);
  html = rewriteGcountInSection(html, 'unconfirmed', figures.unconfirmedCount);
  return html;
}
```

Re-derive Group H's actual `id` value before trusting `g${letter.toLowerCase()}`
for it — the spec notes `is-soft` is shared between Group H and Unconfirmed
but that `id="gh"` still discriminates it; confirm the id literal is exactly
`gh`, not something else.

- [ ] **Step 3: Run against the real files, inspect, revert**

```bash
node scripts/build-register-live-view.mjs
git diff docs/testing/onbox-acceptance-register-live-view.html
git checkout -- docs/testing/onbox-acceptance-register-live-view.html
```

- [ ] **Step 4: Commit**

```bash
git add scripts/build-register-live-view.mjs scripts/tests/build-register-live-view.test.mjs
git commit -m "feat(ops): register-build generator — groups (gcount) target"
```

---

### Task 7: Row-shell reconciliation (insert, delete, reorder; Blocked/Unconfirmed title matching)

**Files:**
- Modify: `scripts/build-register-live-view.mjs`
- Test: `scripts/tests/build-register-live-view.test.mjs`

**Interfaces:**
- Consumes: `### <ID> · <title>` headings for the seven ID'd sections
  (matched via `^### ([A-Z]\d+) · `, per the spec's §3 — this pattern alone
  excludes the publish-token heading and all five Blocked headings without an
  enumerated exclusion list); Blocked's own 5 headings; Unconfirmed's bullet
  list.
- Produces: `reconcileRowShells(mdText, html): string` — folded into
  `buildLiveView`.

This is the largest task in the plan. Split its steps by sub-behaviour rather
than doing it in one giant step.

- [ ] **Step 1: Write the failing test for ID-set insert/delete/reorder**

```javascript
test('a row added to the .md inserts a placeholder shell in markdown order', () => {
  const md = `## Group A — setup a

### A1 · first
### A2 · second (new)
`;
  const html = `<section class="group" id="ga">
      <summary><span class="num">A1</span><span class="iname">first</span></summary>
      <div class="body">existing body</div>
  </section>`;
  const next = reconcileRowShells(md, html);
  const order = [...next.matchAll(/<span class="num">(A\d+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['A1', 'A2']);
  assert.match(next, /A2[\s\S]*body-placeholder/);
});

test('--check fails when a committed shell still carries the placeholder class', () => {
  const html = '<p class="body-placeholder">TODO</p>';
  assert.equal(html.includes('body-placeholder'), true); // the CLI-level check asserted in Task 8, not here
});

test('a row removed from the .md deletes its shell and nothing adjacent', () => {
  const md = `## Group A — setup a

### A1 · first
`;
  const html = `<section class="group" id="ga">
      <summary><span class="num">A1</span><span class="iname">first</span></summary>
      <div class="body">keep me</div>
      <summary><span class="num">A2</span><span class="iname">discharged</span></summary>
      <div class="body">gone</div>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.match(next, /keep me/);
  assert.doesNotMatch(next, /gone/);
});

test('reordered .md rows reorder shells, each body following its own ID', () => {
  const md = `## Group A — setup a

### A2 · second
### A1 · first
`;
  const html = `<section class="group" id="ga">
      <summary><span class="num">A1</span><span class="iname">first</span></summary>
      <div class="body">body one</div>
      <summary><span class="num">A2</span><span class="iname">second</span></summary>
      <div class="body">body two</div>
  </section>`;
  const next = reconcileRowShells(md, html);
  const bodyOneIndex = next.indexOf('body one');
  const bodyTwoIndex = next.indexOf('body two');
  assert.ok(bodyTwoIndex < bodyOneIndex, 'A2 (now first in .md order) must come before A1');
});

test('the publish-token heading is not treated as a row', () => {
  const md = `## Live view

### The publish token — never hand-edit it

Some prose.

## Group A — setup a

### A1 · first
`;
  const html = `<section class="group" id="ga">
      <summary><span class="num">A1</span><span class="iname">first</span></summary>
      <div class="body">b</div>
  </section>`;
  const next = reconcileRowShells(md, html);
  const order = [...next.matchAll(/<span class="num">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['A1']);
});
```

Re-derive the real shell markup's exact tag structure (`<summary>`/`<div
class="body">` pairing, whether `iname`/`risk` spans live inside `<summary>`,
how one shell's boundary is detected — likely the next `<summary>` or the
enclosing `</section>`) from the live file **before** writing
`reconcileRowShells`'s parser; the fixtures above assume a shape that must be
checked, not trusted.

- [ ] **Step 2: Verify failure**

Run: `node --test scripts/tests/build-register-live-view.test.mjs` → FAIL (function doesn't exist).

- [ ] **Step 3: Implement row-ID extraction and shell parsing**

```javascript
const ROW_HEADING_REGEX = /^### ([A-Z]\d+) · (.+?)\r?$/gm;

function extractRowIdsInOrder(sectionMd) {
  return [...sectionMd.matchAll(ROW_HEADING_REGEX)].map((m) => ({ id: m[1], title: m[2] }));
}

// One shell = one <summary>...</summary> plus everything up to the next
// <summary> (or the section's closing tag). Re-derive this boundary rule
// against the real file — this is the single riskiest assumption in the
// whole task.
function splitShellsById(sectionHtml) {
  const shellRegex = /<summary><span class="num">([^<]+)<\/span>[\s\S]*?(?=<summary>|<\/section>)/g;
  const shells = new Map();
  for (const m of sectionHtml.matchAll(shellRegex)) {
    shells.set(m[1], m[0]);
  }
  return shells;
}

function buildPlaceholderShell(id, title) {
  return `<summary><span class="num">${id}</span><span class="iname">${title}</span></summary>\n      <p class="body-placeholder">Not yet published — run \`npm run register:build\` after adding row content, or fill in manually and re-run --check.</p>\n`;
}
```

- [ ] **Step 4: Implement `reconcileRowShells` for the seven ID'd sections**

```javascript
export function reconcileRowShells(mdText, html) {
  const sections = splitMdSections(mdText); // reuse/adapt the ## Group <Letter> splitter from Task 6's parseBodyGroupCounts scope
  let result = html;
  for (const section of sections) {
    const letterMatch = section.title.match(/^Group ([A-Z])\b/);
    if (!letterMatch) continue;
    const letter = letterMatch[1];
    const rowIds = extractRowIdsInOrder(section.body);
    const sectionId = `g${letter.toLowerCase()}`;
    result = reconcileOneSection(result, sectionId, rowIds);
  }
  return result;
}

function reconcileOneSection(html, sectionId, rowIds) {
  const sectionRegex = new RegExp(`(<section[^>]*\\bid="${sectionId}"[^>]*>)([\\s\\S]*?)(<\\/section>)`);
  const match = html.match(sectionRegex);
  if (!match) throw new Error(`reconcileRowShells: no section#${sectionId} found`);
  const [, openTag, body, closeTag] = match;
  const existingShells = splitShellsById(body);
  const newBody = rowIds
    .map(({ id, title }) => existingShells.get(id) ?? buildPlaceholderShell(id, title))
    .join('\n');
  return html.replace(sectionRegex, `${openTag}\n${newBody}\n      ${closeTag}`);
}
```

- [ ] **Step 5: Run, expect the ID-set tests to pass; commit this slice**

Run: `node --test scripts/tests/build-register-live-view.test.mjs`
Expected: the five tests from Step 1 pass; Blocked/Unconfirmed tests (not yet
written) don't exist yet.

```bash
git add scripts/build-register-live-view.mjs scripts/tests/build-register-live-view.test.mjs
git commit -m "feat(ops): register-build generator — row-shell insert/delete/reorder for ID'd sections"
```

- [ ] **Step 6: Write the failing tests for Blocked/Unconfirmed title matching**

```javascript
function normaliseBlockedTitle(raw) {
  // strip backtick/code-span markup, then the LAST trailing " (...)" parenthetical
  const noCode = raw.replace(/`/g, '');
  return noCode.replace(/\s*\([^()]*\)\s*$/, '').trim();
}

function decodeHtmlEntities(s) {
  return s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

test('normaliseBlockedTitle strips code spans and the trailing parenthetical, not internal text', () => {
  const md = 'CPU-only `RAM_HEAVY_MODELS` clamp (plan 263, B2 step 7)';
  const html = 'CPU-only RAM_HEAVY_MODELS clamp (B2 step 7)';
  assert.equal(normaliseBlockedTitle(md), decodeHtmlEntities(html).replace(/\s*\([^()]*\)\s*$/, '').trim());
});

test('a Blocked heading matches its shell by exact normalised title, not position', () => {
  const md = `## Blocked — hardware absent

### First blocked thing (#111)
### Second blocked thing (#222)
`;
  const html = `<section class="group is-blocked" id="blocked">
      <summary><span class="num">—</span><span class="iname">Second blocked thing</span></summary>
      <div class="body">second body</div>
      <summary><span class="num">—</span><span class="iname">First blocked thing</span></summary>
      <div class="body">first body</div>
  </section>`;
  const next = reconcileRowShells(md, html);
  const firstIndex = next.indexOf('First blocked thing');
  const secondIndex = next.indexOf('Second blocked thing');
  assert.ok(firstIndex < secondIndex, 'md order (First, then Second) must be preserved, not html order');
  assert.match(next, /First blocked thing[\s\S]*?first body/);
});

test('a Blocked title matching zero shells is an error', () => {
  const md = `## Blocked — hardware absent

### Something with no shell (#333)
`;
  const html = `<section class="group is-blocked" id="blocked"></section>`;
  assert.throws(() => reconcileRowShells(md, html), /Something with no shell/);
});

test('an Unconfirmed bullet is matched by its bold-span text as a PREFIX of the iname, not exact match', () => {
  const md = `## Unconfirmed — not debts until substantiated

- **fs-38 Wave 1** (designed-voice authoring, PR #1800) — no explicit owed callout
`;
  const html = `<section class="group is-soft" id="unconfirmed">
      <summary><span class="num">—</span><span class="iname">fs-38 Wave 1 — designed-voice authoring</span></summary>
      <div class="body">b</div>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.match(next, /fs-38 Wave 1 — designed-voice authoring/);
});

test('reordering the two Unconfirmed bullets does not re-pair their bodies', () => {
  const md = `## Unconfirmed — not debts until substantiated

- **Second bullet**
- **First bullet**
`;
  const html = `<section class="group is-soft" id="unconfirmed">
      <summary><span class="num">—</span><span class="iname">First bullet</span></summary>
      <div class="body">first body</div>
      <summary><span class="num">—</span><span class="iname">Second bullet</span></summary>
      <div class="body">second body</div>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.match(next, /Second bullet[\s\S]*?second body/);
  assert.match(next, /First bullet[\s\S]*?first body/);
});
```

- [ ] **Step 7: Verify failure, implement, verify pass**

```javascript
const BLOCKED_HEADING_REGEX = /^### (.+?)\r?$/gm; // within the Blocked section body only — see caller
const UNCONFIRMED_BULLET_REGEX = /^- \*\*(.+?)\*\*/gm; // within the Unconfirmed section body only

function reconcileTitledSection(html, sectionId, titles, { prefixMatch }) {
  const sectionRegex = new RegExp(`(<section[^>]*\\bid="${sectionId}"[^>]*>)([\\s\\S]*?)(<\\/section>)`);
  const match = html.match(sectionRegex);
  if (!match) throw new Error(`reconcileRowShells: no section#${sectionId} found`);
  const [, openTag, body, closeTag] = match;
  // Each shell's iname is between <span class="iname"> and </span>; the whole
  // shell runs to the next <summary> or the section close, same boundary rule
  // as splitShellsById above, but keyed by (decoded, normalised) iname text
  // instead of an id.
  const shellRegex = /<summary><span class="num">—<\/span><span class="iname">([^<]+)<\/span>[\s\S]*?(?=<summary>|<\/section>)/g;
  const shellsByIname = new Map();
  for (const m of body.matchAll(shellRegex)) {
    shellsByIname.set(decodeHtmlEntities(m[1]), m[0]);
  }
  const newBody = titles
    .map((title) => {
      const wanted = prefixMatch ? title : normaliseBlockedTitle(title);
      const matches = [...shellsByIname.entries()].filter(([iname]) =>
        prefixMatch ? iname.startsWith(wanted) : iname === wanted,
      );
      if (matches.length === 0) throw new Error(`reconcileRowShells: no shell title matches "${wanted}" in #${sectionId}`);
      if (matches.length > 1) throw new Error(`reconcileRowShells: "${wanted}" matches ${matches.length} shells in #${sectionId}`);
      return matches[0][1];
    })
    .join('\n');
  return html.replace(sectionRegex, `${openTag}\n${newBody}\n      ${closeTag}`);
}
```

Wire both calls into `reconcileRowShells`, extracting Blocked's titles (via
`BLOCKED_HEADING_REGEX` over the `## Blocked` section body only — re-derive
that section's exact `##` title text from the live `.md`, do not assume it is
literally `Blocked`) and Unconfirmed's bold-span-only titles (via
`UNCONFIRMED_BULLET_REGEX` over the `## Unconfirmed` section body), then call
`reconcileTitledSection(html, 'blocked', blockedTitles, { prefixMatch: false })`
and `reconcileTitledSection(html, 'unconfirmed', unconfirmedTitles, { prefixMatch: true })`.

- [ ] **Step 8: Run against real files, inspect, revert**

```bash
node scripts/build-register-live-view.mjs
git diff docs/testing/onbox-acceptance-register-live-view.html
git checkout -- docs/testing/onbox-acceptance-register-live-view.html
```

If the diff shows a shell body/`iname`/`risk` span changing (not just
insert/delete/reorder), the boundary regex from Step 3/Step 7 is wrong — stop
and fix. This is the anti-regression case the spec's Testing section leads
with; do not proceed to Task 8 with a boundary regex that mutates a
hand-authored shell's content.

- [ ] **Step 9: Commit**

```bash
git add scripts/build-register-live-view.mjs scripts/tests/build-register-live-view.test.mjs
git commit -m "feat(ops): register-build generator — Blocked/Unconfirmed title matching"
```

---

### Task 8: CRLF write-side, idempotence, real-file `--check`, CI wiring, and retirement

**Files:**
- Modify: `scripts/build-register-live-view.mjs`
- Modify: `scripts/tests/build-register-live-view.test.mjs`
- Modify: `scripts/check-onbox-register.mjs`
- Modify: `scripts/tests/check-onbox-register.test.mjs`
- Modify: `.github/workflows/onbox-register-check.yml`
- Modify: `docs/testing/onbox-acceptance-register-live-view.html` (the first real generated diff)
- Modify: `package.json` (`test:hooks` already globs `scripts/tests/*.test.mjs` — confirm no separate registration is needed before assuming so)

**Interfaces:**
- Produces: `main`'s CLI now the sole entry point real files and CI use.
- Consumes: nothing new — this task is wiring and retirement.

- [ ] **Step 1: Write the idempotence test**

```javascript
test('build then build is a no-op on an LF checkout', () => {
  const md = buildRegisterFixture();
  const html = buildLiveViewFixture();
  const once = buildLiveView(md, html);
  const twice = buildLiveView(md, once);
  assert.equal(once, twice);
});

test('build then --check passes on an LF checkout', () => {
  const md = buildRegisterFixture();
  const html = buildLiveViewFixture();
  const built = buildLiveView(md, html);
  assert.equal(buildLiveView(md, built), built);
});

test('a CRLF-normalised input passes --check rather than failing on every line', () => {
  const md = buildRegisterFixture();
  const html = buildLiveViewFixture().replace(/\n/g, '\r\n');
  // main() reads via readNormalized, so the CRLF html degrades to a correct
  // comparison rather than a whole-file false failure — exercised at the
  // main()-level test below, not here (buildLiveView itself is CRLF-agnostic
  // string work; readNormalized is main()'s job).
  const built = buildLiveView(md, html.replace(/\r\n/g, '\n'));
  assert.doesNotMatch(built, /\r\n/);
});

test('main() writes LF even when the tracked file is CRLF, and --check passes after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'register-build-'));
  try {
    const mdPath = join(dir, 'register.md');
    const htmlPath = join(dir, 'live-view.html');
    writeFileSync(mdPath, buildRegisterFixture().replace(/\n/g, '\r\n'));
    writeFileSync(htmlPath, buildLiveViewFixture().replace(/\n/g, '\r\n'));
    const writeExit = main('register.md', 'live-view.html', { repoRoot: dir, check: false });
    assert.equal(writeExit, 0);
    const written = readFileSync(htmlPath, 'utf8');
    assert.doesNotMatch(written, /\r\n/);
    const checkExit = main('register.md', 'live-view.html', { repoRoot: dir, check: true });
    assert.equal(checkExit, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Verify failure, then confirm `main`/`buildLiveView` already satisfy idempotence and the LF-write, or fix**

Run: `node --test scripts/tests/build-register-live-view.test.mjs`
If idempotence fails, the most likely cause is `reconcileRowShells` reformatting
whitespace on the second pass (e.g. the `\n${newBody}\n      ` template
differing from what a shell's own trailing whitespace already looked like) —
normalise trailing whitespace inside `reconcileOneSection`/`reconcileTitledSection`
so a shell already in the right position/order round-trips byte-identically,
not just semantically.

- [ ] **Step 3: Wire the real-file `--check` test (replaces `check-onbox-register.test.mjs:1181`'s role)**

```javascript
test('the real register and its real live view agree (register:build --check)', () => {
  const result = spawnSync(
    process.execPath,
    [CLI_PATH_FOR_REGISTER_BUILD, '--check'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
```

Define `CLI_PATH_FOR_REGISTER_BUILD`/`REPO_ROOT` following exactly the pattern
`check-onbox-register.test.mjs` already uses for its own `CLI_PATH`/paths (see
that file's top, already read in this plan's research phase).

- [ ] **Step 4: Wire `--check`'s failure on a committed placeholder**

Add to `main`: after computing `nextHtml`, if `check` is true and `nextHtml`
contains the literal string `class="body-placeholder"` **in the committed
file being compared against** (i.e. `currentHtml`, not just `nextHtml`),
report failure regardless of whether `nextHtml === currentHtml` — a committed
placeholder must fail even when the generator would reproduce it unchanged.

```javascript
if (check) {
  const placeholderStillCommitted = currentHtml.includes('class="body-placeholder"');
  if (nextHtml !== currentHtml || placeholderStillCommitted) {
    if (placeholderStillCommitted) {
      console.error(
        'register:build --check: a committed row shell still carries class="body-placeholder" — fill in its content and re-run.',
      );
    }
    if (nextHtml !== currentHtml) {
      console.error(`register:build --check: ${liveViewPath} is out of date. Run \`npm run register:build\` and commit the result.`);
    }
    return 1;
  }
  console.log('register:build --check: up to date.');
  return 0;
}
```

Paired test:

```javascript
test('--check fails when a committed shell still carries the placeholder class, even if otherwise up to date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'register-build-'));
  try {
    const mdPath = join(dir, 'register.md');
    const htmlPath = join(dir, 'live-view.html');
    writeFileSync(mdPath, buildRegisterFixture());
    const html = buildLiveViewFixture().replace(
      /<summary><span class="num">A1<\/span>.*?<\/summary>/s,
      (m) => `${m}\n<p class="body-placeholder">TODO</p>`,
    );
    writeFileSync(htmlPath, html);
    const exit = main('register.md', 'live-view.html', { repoRoot: dir, check: true });
    assert.equal(exit, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run the full generator test suite**

Run: `node --test scripts/tests/build-register-live-view.test.mjs`
Expected: PASS, all tests from Tasks 4–8.

- [ ] **Step 6: Retire the four superseded checks from `check-onbox-register.mjs`**

Re-derive each comparison's current exact line range before deleting (they
have moved since the spec was written — re-verified as still present and
roughly in the cited neighbourhood earlier in this plan's own research, but
confirm again now, at implementation time):

- Delete the owed-total `.md`-vs-`.html` comparison (`errors.push` around the
  `owedMatch`/`mdTotal` check).
- Delete the glance per-group-count comparison (`direction === 'both' &&
  lvGroups.get(letter) !== mdCount`).
- Delete the `gcount`/header-count comparison (`section.headerCount !==
  mdNumbers.length`).
- **Do not delete** the `expected`/`found`/`missing`/`extra` computation — it
  feeds `extraOnly`/`staleExtra`, which survives. Delete only the `'both'`-path
  `missing`/reporting branch that is now redundant with row-shell
  reconciliation's own coverage — re-read the surrounding code carefully
  before touching this one, since Task 4's own research found this
  computation is shared, not owned solely by the deleted comparison.

For each deletion, delete the corresponding test(s) in
`scripts/tests/check-onbox-register.test.mjs` and run the full file after each
deletion to confirm nothing else depended on the removed branch.

Run: `node --test scripts/tests/check-onbox-register.test.mjs`
Expected: PASS — every `--against-published`, `extraOnly`, baseline, and
`--discharging` test still green.

- [ ] **Step 7: Replace `check-onbox-register.test.mjs:1181`'s real-file assertion**

Delete the test asserting `checkLiveView(md, lv)` is empty against the real
files (its role is now Step 3's `register:build --check` real-file test, in
the other test file). Confirm via `git log -p` that this is the same test the
spec's §4/§5 describe before deleting it, not a different assertion that
happens to share a similar shape.

- [ ] **Step 8: Wire CI**

```yaml
      - name: Check on-box register consistency
        run: node scripts/check-onbox-register.mjs

      - name: Check the generated live-view surfaces are up to date
        run: node scripts/build-register-live-view.mjs --check
```

Add `scripts/build-register-live-view.mjs` to the workflow's `paths:` filter,
alongside the two register files and `scripts/check-onbox-register.mjs`.

- [ ] **Step 9: Run the real generator and commit the resulting diff**

```bash
node scripts/build-register-live-view.mjs
git diff --stat docs/testing/onbox-acceptance-register-live-view.html
```

Read the diff in full — this is the "PR 3 changes the published page" content
review the spec's Delivery section mandates. Confirm no shell body/`iname`/`risk`
span/`gtitle`/Setup-cell text changed; only the strip tiles, glance counts, and
`gcount` spans.

- [ ] **Step 10: Full local verification**

Run: `npm run register:build -- --check && node scripts/check-onbox-register.mjs && node scripts/check-register-citations.mjs`
Expected: all three exit 0.

- [ ] **Step 11: Commit**

```bash
git add scripts/build-register-live-view.mjs scripts/tests/build-register-live-view.test.mjs \
        scripts/check-onbox-register.mjs scripts/tests/check-onbox-register.test.mjs \
        .github/workflows/onbox-register-check.yml \
        docs/testing/onbox-acceptance-register-live-view.html
git commit -m "feat(ops): wire register:build into CI, retire superseded checks, publish first generated diff"
```

- [ ] **Step 12: Open PR 3**

Title: `feat(ops): generate the on-box register's derived live-view figures`.
`refactor` scope → `high` review depth (per Model routing). Body must state
the exact published-page diff from Step 9 and declare it as reviewed content,
per the spec's own PR-3 note. `Closes #2362`.

---

## PR 4 — `wrongId`, the held tasks, and every correction PR 2 only measured

### Task 9: ID-reuse-detection rule in `checkConflictingSubjects`

**Files:**
- Modify: `scripts/check-register-citations.mjs`
- Test: `scripts/tests/check-register-citations.test.mjs`

**Interfaces:**
- Consumes: `registerRows` (already available — its keys are the current
  valid ID set), `idSpecificAnnotationPresent`/`enclosingSectionText` (already
  used by `checkNonexistentIds`/Check A — reuse, don't reimplement).
- Modifies: `recordSubjectConflict(filePath, lineIndex, id, subject,
  legitimate, wrongId, unknownSubject)` gains two new parameters
  (`registerRows`, `lines`) and a new branch; `checkConflictingSubjects`
  passes them through.

- [ ] **Step 1: Write the failing tests**

```javascript
test('a citation to an ID currently minted for a different subject is fatal, even with a discharge annotation nearby', () => {
  const registerRows = new Map([['A19', { issues: new Set(['1976']), body: '' }]]);
  const fileTexts = new Map([
    [
      'onbox-sitting-vram-contention.md',
      '> Register row: A19 for #1893.\n> **Register row: A19 — discharged 2026-08-26, row removed from the register**\n',
    ],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(fileTexts, registerRows);
  assert.equal(wrongId.some((m) => m.includes('A19') && m.includes('1893')), true);
  assert.equal(unknownSubject.some((m) => m.includes('1893')), false);
});

test('a citation to an ID that genuinely does not exist is fatal only when no discharge annotation follows it', () => {
  const registerRows = new Map(); // A99 minted for nothing
  const withoutAnnotation = new Map([['f1.md', 'Register row: A99 for #500.\n']]);
  const { wrongId: w1 } = checkConflictingSubjects(withoutAnnotation, registerRows);
  assert.equal(w1.some((m) => m.includes('A99')), true);

  const withAnnotation = new Map([
    ['f2.md', 'Register row: A99 for #500.\n> **Register row: A99 — discharged 2026-01-01, row removed from the register**\n'],
  ]);
  const { wrongId: w2 } = checkConflictingSubjects(withAnnotation, registerRows);
  assert.equal(w2.some((m) => m.includes('A99')), false);
});

test('a citation to one ID of a still-present multi-row subject is not fatal', () => {
  const registerRows = new Map([
    ['A1', { issues: new Set(['700']), body: '' }],
    ['A2', { issues: new Set(['700']), body: '' }],
  ]);
  const fileTexts = new Map([['f.md', 'Register row: A1 for #700.\n']]);
  const { wrongId } = checkConflictingSubjects(fileTexts, registerRows);
  assert.equal(wrongId.length, 0);
});
```

Re-derive the exact fixture shape `checkConflictingSubjects`/`fileTexts`
expects (a `Map<path, text>`? Confirmed already in this plan's research —
matches `checkNonexistentIds`'s own `text, filePath, registerRows` signature;
`checkConflictingSubjects` iterates `fileTexts` similarly per its own header
comment) — verify by reading the function's current top lines before trusting
this plan's fixture.

- [ ] **Step 2: Verify failure**

Run: `node --test scripts/tests/check-register-citations.test.mjs`
Expected: FAIL — the reuse case currently lands in `unknownSubject`, not `wrongId`.

- [ ] **Step 3: Implement the reuse-detection branch**

```javascript
function recordSubjectConflict(
  filePath,
  lineIndex,
  id,
  subject,
  legitimate,
  wrongId,
  unknownSubject,
  registerRows,
  lines,
) {
  const legitimateIds = legitimate.get(subject);
  if (!legitimateIds) {
    // The subject doesn't appear in any current row's subject set (heading OR
    // body, per Task 3). Two sub-cases, not one, as of this task: does the
    // CITED ID (not the subject) currently exist in the register at all?
    if (registerRows.has(id)) {
      // The ID resolves — just to a different subject than this citation
      // means. Not a departure; a wrong pointer. Fatal regardless of any
      // discharge annotation nearby, which — if present — is itself now a
      // false statement about a row that has been reused, not removed.
      const currentRow = registerRows.get(id);
      const currentSubjects = [...currentRow.issues].sort().join('/') || '(no subject in its heading)';
      wrongId.push(
        `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}, but ${id} is currently minted ` +
          `for a different subject (${currentSubjects}) — the ID was reused, not departed; repoint or remove this citation`,
      );
      return;
    }
    // The ID genuinely does not exist anywhere in the current register.
    // Consult the discharge-annotation convention — the same helper Check A
    // (checkNonexistentIds) already uses.
    if (idSpecificAnnotationPresent(enclosingSectionText(lines, lineIndex), id)) {
      unknownSubject.push(
        `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}; ${id} has genuinely departed ` +
          `and is annotated as discharged/removed — not failing`,
      );
      return;
    }
    wrongId.push(
      `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}, but ${id} does not exist in the ` +
        `current register and carries no discharge/removal annotation — unexplained dangling reference`,
    );
    return;
  }
  if (!legitimateIds.has(id)) {
    wrongId.push(
      `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}, but the register's #${subject} ` +
        `maps to ${[...legitimateIds].sort().join('/')}, not ${id}`,
    );
  }
}
```

Every call site of `recordSubjectConflict` inside `checkConflictingSubjects`
(both the positional/`headingTitleSegments` path and the non-positional path)
needs `registerRows` and `lines` threaded through — `lines` is already
computed inside `checkConflictingSubjects`'s per-file loop for the existing
positional logic (re-derive its exact variable name before wiring), so this is
parameter-passing, not new parsing.

- [ ] **Step 4: Run to verify pass**

Run: `node --test scripts/tests/check-register-citations.test.mjs`
Expected: PASS.

- [ ] **Step 5: Re-run against the real tree**

Run: `node scripts/check-register-citations.mjs --strict`
Record the output. Expected shape: the `A19`/`#1893`, `A31`/`#2037`, `A34`/`#2106`
residuals now appear in `wrongId` output (fatal, printed by default — no
`--strict` needed for these three specifically), not `unknownSubject`. **Do
not fix the citations in this task** — Task 10 does, once this rule's output
is what names the exact fix each one needs.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-register-citations.mjs scripts/tests/check-register-citations.test.mjs
git commit -m "feat(ops): fatal ID-reuse detection for check-register-citations (#2721)"
```

---

### Task 10: Fix the five known-stale citations directly

**Files:**
- Modify: `docs/testing/onbox-sitting-vram-contention.md`
- Modify: `docs/testing/onbox-sitting-cloning-identity.md`

**Interfaces:** none — content-only doc fixes, verified by re-running Task 9's
checker against the real tree.

Per CLAUDE.md's incidental-findings rule: these are known instances this spec
and this plan surfaced, fixed in the same round, not filed and deferred.

- [ ] **Step 1: Re-run the checker to get current line numbers**

Run: `node scripts/check-register-citations.mjs --strict`
Use this run's own reported file:line locations — do not trust this plan's or
the spec's line citations for these five fixes.

- [ ] **Step 2: Fix `onbox-sitting-vram-contention.md`'s two false discharge annotations**

At the citation currently reading `A19` for `#1893`: rewrite the following
`> **Register row: A19 — discharged …, row removed from the register**` line
— it is currently false (A19 exists, reused for a different subject). Replace
with the honest statement, e.g.:

```markdown
> **Register row: A19 was later reused for a different subject (see the
> register's current A19) — this citation's original target has no current
> row. Do not treat A19 as confirming anything about this section's #1893
> claim.**
```

Do the same for the `A31`/`#2037` citation.

- [ ] **Step 3: Fix `onbox-sitting-cloning-identity.md`'s `A34`/`#2106` citation**

Determine A34's actual current subject (re-derive fresh — Task 9's checker
output names it). This run sheet's own text was written against the OLD A34
(the respawn-budget row). Either:
- retitle/repoint this run sheet's section to cite whatever ID the
  respawn-budget content now lives under, if it still exists in the register
  under a different ID, or
- if that content genuinely has no current row, apply the same honest
  "reused, no current row" annotation pattern as Step 2.

Re-derive which branch applies by reading the current register for the
respawn-budget subject — do not guess.

- [ ] **Step 4: Fix the two structurally-invisible citations, `A40`/`A41`**

At `onbox-sitting-cloning-identity.md`'s two `Criteria source:` lines naming
`A40`/`A41` (re-derive current line numbers): replace with the correct current
register ID for each cited subject, found by searching the register for the
subject number each line actually needs (re-derive from context — this plan
does not have the specific subject numbers in hand at plan-writing time; the
implementer reads the surrounding prose to determine what each citation was
trying to name).

- [ ] **Step 5: Verify the checker is clean**

Run: `node scripts/check-register-citations.mjs --strict`
Expected: zero `wrongId` entries for these five, and — separately — file a
follow-up issue (not fixed here, per the spec's §6 step 4) for teaching either
checker to see the `Criteria source:` citation shape generally, so a future
`A40`/`A41`-shaped citation doesn't need a human read to catch.

- [ ] **Step 6: Commit**

```bash
git add docs/testing/onbox-sitting-vram-contention.md docs/testing/onbox-sitting-cloning-identity.md
git commit -m "fix(ops): correct five stale register citations found by the reuse-detection rule"
```

---

### Task 11: Widen `wrongId` to fatal by default; rewrite the three deferral sites

**Files:**
- Modify: `scripts/check-register-citations.mjs`
- Test: `scripts/tests/check-register-citations.test.mjs`
- Modify: `docs/testing/onbox-acceptance-register.md`

**Interfaces:** none new — Task 9 already made the reuse class land in
`wrongId`, which the header comment states is "FATAL and runs by default, no
`--strict` needed" **already**, for the pre-existing wrongId class. Confirm
this is still true after Task 9's change (it should be, since Task 9 only
added a new way to reach the same `wrongId` array) before assuming this task
has no code left to do.

- [ ] **Step 1: Confirm the CLI's exit-code wiring already treats any `wrongId` entry as fatal**

Read the CLI section of `check-register-citations.mjs` (its `main`/exit-code
logic) and confirm `wrongId.length > 0` already causes a non-zero exit
regardless of `--strict`. If it does not, fix it — this is the actual
"widening" the issue asks for; Task 9 supplied the new fatal cases, this step
confirms they are actually wired to fail the build.

- [ ] **Step 2: Rewrite the three deferral sites**

Re-derive their current exact locations (the spec names
`check-register-citations.mjs:37`, `:210`, and `register.md:388` — re-verify,
these are `scripts/*.mjs` citations and are more likely to still be close, but
confirm). Each currently states that widening `wrongId` to the discharge class
is deferred pending a decision. Rewrite each to state the shipped behaviour:
`wrongId` is fatal for both the "known subject, wrong ID" class and the
"ID currently minted for a different subject" class; only a genuinely departed,
unannotated ID additionally requires the discharge-annotation absence.

- [ ] **Step 3: Verify**

Run: `node --test scripts/tests/check-register-citations.test.mjs && node scripts/check-register-citations.mjs --strict`
Expected: PASS, exit 0 (given Task 10's fixes already landed).

- [ ] **Step 4: Commit**

```bash
git add scripts/check-register-citations.mjs scripts/tests/check-register-citations.test.mjs docs/testing/onbox-acceptance-register.md
git commit -m "docs(ops): rewrite the three wrongId deferral sites to state the shipped behaviour"
```

---

### Task 12: Wire the publish-nonce ancestry comparator into `--against-published` (held Task 10)

**Files:**
- Modify: `scripts/check-onbox-register.mjs`
- Test: `scripts/tests/check-onbox-register.test.mjs`

**Interfaces:**
- Consumes: `comparePublishTokens({ working, published, baseline, lookups,
  allowBehind })` and `nonceInHistory(repoRoot, liveViewPath, nonce, ref,
  gitRunner)` — both already implemented and exported from
  `scripts/publish-token.mjs` (verified unused elsewhere in this plan's
  research phase). Re-derive `nonceInHistory`'s exact return contract (does it
  return `true`/`false`/`null` directly, or a promise?) by reading its full
  body before wiring — this plan's research read only its signature line.

This task is wiring, not new comparator logic — `comparePublishTokens`
already exists, is presumably tested in its own right (confirm a
`publish-token.test.mjs` or equivalent exists; if not, that gap is itself a
finding to fix in this task, not defer).

- [ ] **Step 1: Locate the `--against-published` CLI path**

Read `runCheckOnboxRegisterCli` (or whatever the current CLI entry function is
named — re-derive) and find where `direction: 'extraOnly'` is set up. This is
where the publish-token check needs to run alongside `checkLiveView`.

- [ ] **Step 2: Write the failing test**

```javascript
test('--against-published fails when the working copy was bumped without a fresh nonce', () => {
  // A minimal repro: working token's counter is ahead of the published
  // token's, but the working nonce is already present in the baseline's
  // history — the "bumped without minting" signature comparePublishTokens
  // exists to catch.
  const result = spawnSync(
    process.execPath,
    [CLI_PATH, '--against-published', FIXTURE_STALE_NONCE_PATH],
    { cwd: FIXTURE_REPO_DIR, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /publish token/i);
});
```

Building `FIXTURE_REPO_DIR`/`FIXTURE_STALE_NONCE_PATH` requires a throwaway
git repo with real commit history for `nonceInHistory`'s `git log -S` lookups
to run against — follow whatever pattern
`scripts/tests/check-onbox-register.test.mjs` already uses for its own
`resolveBaselineText`/git-dependent tests (it has some, per its imports of
`spawnSync`/`mkdtempSync` — re-derive that pattern rather than inventing a new
one).

- [ ] **Step 3: Verify failure**

Run: `node --test scripts/tests/check-onbox-register.test.mjs`
Expected: FAIL — today's `--against-published` never calls `comparePublishTokens`.

- [ ] **Step 4: Wire the four lookups and the call**

```javascript
import { comparePublishTokens, nonceInHistory } from './publish-token.mjs';

// Inside the --against-published CLI path, after resolving `published` (the
// saved copy) and `baseline` (origin/main's live view) and before/alongside
// the existing checkLiveView(..., { direction: 'extraOnly', ... }) call:
const workingToken = parsePublishToken(workingHtml);
const publishedToken = parsePublishToken(publishedHtml);
const baselineToken = parsePublishToken(baselineHtml);
const lookups = {};
if (publishedToken && !publishedToken.malformed) {
  lookups.inBaseline = nonceInHistory(repoRoot, liveViewPath, publishedToken.nonce, 'origin/main', runGitCommand);
  lookups.inMine = nonceInHistory(repoRoot, liveViewPath, publishedToken.nonce, 'HEAD', runGitCommand);
}
if (baselineToken && !baselineToken.malformed) {
  lookups.baselineInMine = nonceInHistory(repoRoot, liveViewPath, baselineToken.nonce, 'HEAD', runGitCommand);
}
if (workingToken && !workingToken.malformed && baselineToken && workingToken.n > baselineToken.n) {
  lookups.workingInBaseline = nonceInHistory(repoRoot, liveViewPath, workingToken.nonce, 'origin/main', runGitCommand);
}
const tokenErrors = comparePublishTokens({
  working: workingHtml,
  published: publishedHtml,
  baseline: baselineHtml,
  lookups,
});
```

Re-derive `runGitCommand`'s exact signature (already exported/used elsewhere
in this file per this plan's research) before wiring it as the `gitRunner`
argument. Fold `tokenErrors` into the CLI's overall error list alongside
`checkLiveView`'s output.

- [ ] **Step 5: Run to verify pass**

Run: `node --test scripts/tests/check-onbox-register.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-onbox-register.mjs scripts/tests/check-onbox-register.test.mjs
git commit -m "feat(ops): wire the publish-nonce ancestry comparator into --against-published (#2599)"
```

---

### Task 13: Stand `check-register-citations.mjs` up as its own CI workflow (held Task 12)

**Files:**
- Create: `.github/workflows/register-citations-check.yml`

**Interfaces:** none — a new workflow invoking an existing, unmodified-by-this-task CLI.

- [ ] **Step 1: Write the workflow, mirroring `onbox-register-check.yml`'s shape**

```yaml
name: Register citations check

on:
  pull_request:
    paths:
      - 'docs/testing/**'
      - 'scripts/**'
      - 'CLAUDE.md'
      - '.github/workflows/register-citations-check.yml'

permissions:
  contents: read

jobs:
  check:
    name: Check register citation integrity
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Check register citations
        run: node scripts/check-register-citations.mjs
```

Re-derive the exact `test:hooks` diff-gate path list this plan's research
found (`docs/testing/**`, `scripts/**`, `CLAUDE.md`) from the real
`ci-scope.mjs`/`verify-cache.mjs` config before finalising `paths:` — match it
exactly, since the spec's whole point in filing this task was parity between
`test:hooks`'s existing trigger surface and this new workflow's.

Deliberately **not** `--strict` in this default run — `unknownSubject` stays
exploratory/opt-in per the file's own header comment; only `wrongId` (now
including the reuse class) is fatal by default.

- [ ] **Step 2: Verify the workflow is syntactically valid**

Run: `node -e "require('js-yaml') || true"` is not available (no yaml dep) —
instead verify by running the workflow's own command locally:
Run: `node scripts/check-register-citations.mjs`
Expected: exit 0 (given Task 10/11 already landed).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/register-citations-check.yml
git commit -m "ci(ops): stand check-register-citations.mjs up as its own workflow (#2603)"
```

- [ ] **Step 4: Open PR 4**

Title: `feat(ops): widen wrongId to the ID-reuse class, wire ancestry comparator, add citations workflow`.
Body must record: the re-measured residual list from PR 2, Task 9's new rule
and its output against the real tree, Task 10's five fixes, and the follow-up
issue filed in Task 10 Step 5. `Closes #2721`, `Refs #2599`, `Refs #2603`.

---

## Self-Review

**Spec coverage:**
- §1 (generator is a reconciler) → Task 4 (`main`, region-replace primitive).
- §2 (`strip`/`glance`/`groups` targets, `changelog` dropped) → Tasks 4/5/6;
  no changelog task exists, matching the spec's pass-4 drop.
- §3 (row-shell reconciliation, title matching) → Task 7.
- §4 (enforcement, CRLF) → Task 8.
- §5 (retirement) → Task 8 Step 6-7.
- §6 (`wrongId` widening, both prerequisites, the three fixes, the two
  structurally-invisible fixes) → Task 3 (prerequisite 1), Task 9
  (prerequisite 2 + widening mechanism), Task 10 (the five fixes), Task 11
  (deferral-site rewrites + confirming the fatal wiring).
- §7 (held Task 10/12) → Task 12, Task 13, named explicitly as "held" to avoid
  numbering collision with this plan's own Task 10/12.
- Ticket disposition table → PR bodies' `Closes`/`Refs` trailers in Tasks 8's
  Step 12 and Task 13's Step 4; #2708 deliberately not referenced anywhere in
  this plan, matching the spec's explicit non-closure.
- Delivery's sequencing hazard (the `#2759` sweep chain) → not a task; a
  pre-flight check belongs in the executing session's setup, not a plan step,
  since it depends on the state of an unrelated chain at execution time — flag
  this to whoever executes PR 1's Task 1 as a manual pre-check.

**Placeholder scan:** every step above either contains real code, a real shell
command, or an explicit "re-derive X before trusting this" instruction paired
with the concrete thing being deferred (a line number, a fixture shape, a
markup detail) — never a bare "handle edge cases" with no content. Several
steps deliberately flag their own weakest assumption (shell-boundary regexes
in Task 7, the `nonceInHistory` return contract in Task 12) rather than
asserting confidence the research phase didn't actually reach.

**Type/name consistency:** `parseRegisterFigures`, `buildStripRegion`,
`applyGeneratedRegion`, `parseBodyGroupCounts`, `reconcileRowShells`, `main`
are each defined once (Task 4/5/6/7) and referenced identically in every later
task. `recordSubjectConflict`'s new parameter list (`registerRows`, `lines`)
is introduced once in Task 9 and not redefined elsewhere.
