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
  bare register-ID-shaped token**, with nothing but whitespace between them
  (e.g. the word "row" directly followed by a bare `A40`-style token).
  `check-register-citations.mjs`'s `ROW_CITATION_REGEX` matches that shape
  anywhere in the tree and will fail `test:hooks` on the prose itself, not
  just on a real citation. This plan
  observes that rule throughout (see Task 9).

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/build-register-live-view.mjs` | New. Parses the `.md`, parses the current `.html`, computes the four generated targets, reconciles row shells, writes (or `--check`s) the result. |
| `scripts/tests/build-register-live-view.test.mjs` | New. Fixture-based unit tests (own `buildRegister`/`buildLiveView` helpers, mirroring `check-onbox-register.test.mjs`'s pattern) plus a real-file `--check` run — a second, disjoint real-file check alongside `check-onbox-register.test.mjs:1181`'s own, not a replacement for it (Task 8 Step 7). |
| `scripts/check-onbox-register.mjs` | Modified (Task 8). Loses the owed-total, glance-count, and `gcount` comparisons; keeps `checkRegister`, `--against-published`, and the shell-reconciliation-adjacent `extraOnly`/`staleExtra` machinery. |
| `scripts/check-register-citations.mjs` | Modified (Task 3, Task 9, Task 11). `buildLegitimateSubjectMap` reads bodies and is exported; a new, standalone `checkIdReuse` export (not a change to `recordSubjectConflict`'s existing eligibility rule); the CLI wires both `wrongId` sources together. |
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
# docs/testing/onbox-acceptance-register.md and its .html twin are read by
# scripts/check-onbox-register.mjs (structural parsing, not a byte-compare —
# checkLiveView is already CRLF-tolerant) and, once a later PR lands it, by
# scripts/build-register-live-view.mjs, the generator that will own these
# files' GENERATED regions and always write LF. The pin exists for a simpler
# reason than either parser: without it, a checkout with Git for Windows'
# default core.autocrlf=true materialises both files as CRLF, and this repo's
# convention (see the pins above) is LF for anything read as text at runtime,
# so a Windows checkout's line endings match what every other platform sees.
# Known limitation shared with every other pin in this file: this governs
# CHECKOUT, not re-checkout of a file git already believes is unchanged — an
# existing CRLF working tree does not self-heal from this pin alone.
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
- Consumes: `registerRows` — a `Map<id, { issues: Set<number>, … }>` already
  built upstream (`parseRegisterRows`, `check-register-citations.mjs:601-608`
  at review time — re-derive the exact row shape before writing this task's
  code). **`issues` holds `number`s, not strings** — `extractSubjectNumbers`
  (`:349-355`) does `nums.add(Number(...))`. `row.body` does **not** exist
  today; `parseRegisterRows` computes a local `rowBody` and discards it —
  this task must add it to the stored row shape (Step 1 below), not assume it.
- Produces: `buildLegitimateSubjectMap(registerRows): Map<number, Set<id>>` —
  same signature, richer population, **keyed by number throughout, matching
  the existing map's key type** (a body-scanned subject must be coerced to
  `Number` before use as a key, or every body-derived entry is invisible to
  every existing numeric lookup — this was the defect an earlier draft of this
  task shipped and its own tests could not catch, because both sides of its
  fixtures used strings). Consumed downstream by `recordSubjectConflict`'s
  existing `legitimate.get(subject)` call sites (unchanged by this plan) and,
  new in Task 9, by a standalone `checkIdReuse` function that calls
  `buildLegitimateSubjectMap` itself rather than extending
  `recordSubjectConflict`.
- **`buildLegitimateSubjectMap` is not exported today** — add `export` to its
  declaration in this task; the test file cannot import it otherwise.

Today `buildLegitimateSubjectMap` (re-derive its exact current line — was
`:1280` at spec-writing time) populates the map from `row.issues` only, which
is itself populated from **heading text alone**. Two gaps this task closes:

1. A subject cited in a row's **body** (not its heading) is not recognised —
   the `A3`/`#1230` case (A3's heading has no `#1230`; the number is in A3's
   body prose).
2. A **PR** number appearing near a subject number is not distinguished from
   an **issue** number — the `A32`/`#2316` case (`#2316` is a PR; A32's real
   subject, an issue, is `#2310`, already in the heading and already handled).

- [ ] **Step 1: Add `body` to the stored row shape in `parseRegisterRows`**

`parseRegisterRows` (`check-register-citations.mjs:601-608` at review time)
already computes a local `rowBody` variable while building each row, then
discards it — only `issues` (and whatever else the row object already
carries) survives into the returned `registerRows` map. Add `body: rowBody`
to that row object literal so it survives. Re-derive the exact variable name
and the row object's construction site before editing — do not assume
`rowBody` is still the name at implementation time.

- [ ] **Step 2: Write the failing tests**

```javascript
test('a subject cited only in a row body resolves via buildLegitimateSubjectMap, keyed by number like every other entry', () => {
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
  assert.deepEqual([...(map.get(1230) ?? [])], ['A3']); // number key, not '1230'
  assert.equal(map.has('1230'), false); // guards against the string-key regression directly
});

test('a PR number near a subject is not folded into the subject set', () => {
  const registerRows = new Map([
    [
      'A32',
      {
        issues: new Set([2310]),
        body: 'Fixed by PR #2316, closing #2310.',
      },
    ],
  ]);
  const map = buildLegitimateSubjectMap(registerRows);
  assert.deepEqual([...(map.get(2310) ?? [])], ['A32']);
  assert.equal(map.has(2316), false);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test scripts/tests/check-register-citations.test.mjs`
Expected: FAIL — `map.get(1230)` is `undefined` today (body not scanned; also
`buildLegitimateSubjectMap` is not exported yet, so this currently fails at
import time — export it as part of Step 1's shape change before running).

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
// other #NNNN — bare or linked to /issues/ — is a candidate subject. Both
// sets are Sets of NUMBER, matching row.issues' own element type throughout
// — a string here would silently split the map into two parallel, mutually
// invisible key spaces.
const PR_NUMBER_REGEX = /\bPR\s+#(\d+)\b|\/pull\/(\d+)\b/g;
const ANY_NUMBER_REGEX = /#(\d+)\b|\/issues\/(\d+)\b/g;

function extractPrNumbers(text) {
  const prs = new Set();
  for (const m of text.matchAll(PR_NUMBER_REGEX)) prs.add(Number(m[1] ?? m[2]));
  return prs;
}

function extractBodySubjects(text) {
  const prs = extractPrNumbers(text);
  const subjects = new Set();
  for (const m of text.matchAll(ANY_NUMBER_REGEX)) {
    const n = Number(m[1] ?? m[2]);
    if (!prs.has(n)) subjects.add(n);
  }
  return subjects;
}

export function buildLegitimateSubjectMap(registerRows) {
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

  // Always write LF. In practice this is a no-op today: readNormalized
  // already collapsed \r\n->\n on both inputs, and every string literal in
  // this module's own source is LF (this file is itself pinned eol=lf).
  // Kept explicit — not because it currently does anything, but because it
  // is the one line that keeps that true if a future edit ever concatenates
  // in raw, unnormalised text.
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
    process.exitCode = 1;
  } else {
    // NOT process.exit(main(...)) — scripts/lib/is-main-module.mjs's own
    // header comment documents why: process.exit() terminates before Node
    // flushes pending async stdout writes, which is synchronous on Windows
    // but asynchronous on Linux/macOS, so a script with more than trivial
    // output can truncate its own tail on CI (ubuntu-latest) while looking
    // fine on every Windows dev box. This script's own console.log/error
    // calls are one line each — genuinely tiny — but set exitCode rather
    // than call exit() regardless, matching the documented safe pattern
    // rather than relying on today's output staying short forever.
    process.exitCode = main(DEFAULT_REGISTER_PATH, DEFAULT_LIVE_VIEW_PATH, { check });
  }
}
```

Check `scripts/lib/is-main-module.mjs` exists with an `isDirectlyInvoked` export
before relying on it (`stamp-publish-token.mjs` already imports it, so it
should) — re-derive its exact signature and read its full header comment
(not just the export line) before wiring the CLI tail, since that comment is
what Step above's `process.exitCode` choice is based on.

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
    <div class="stat"><div class="n blk">${figures.blockedCount}</div><div class="l">Blocked</div></div>
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
per letter). **Also give each group section a full `<header>…</header>` plus
at least one real `<details class="item">` shell** — Task 7 (and Task 8's
idempotence tests) call `buildLiveViewFixture()` bare and need a
structurally-complete page to reconcile, not just a strip/glance skeleton.
Match the real shape:
`<section class="group" id="ga"><header><h3 class="gtitle">…<span class="gcount">N rows</span></h3></header><details class="item"><summary><span class="num">A1</span>…</summary><div class="body">…</div></details></section>`,
one such section per glance-table letter, and write:

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
  `buildLiveView`, called **after** the `groups` target (Task 6) has already
  rewritten each section's `gcount` span, since this task's replace only
  touches the `<details>` list, never the `<header>` block `groups` writes
  into. Also produces `splitMdSections(mdText): [{ title, body }]`, an
  internal helper this task defines and Task 6 could have reused but does
  not need to (Task 6 already ships without it) — needed here because
  `reconcileRowShells` locates each `## Group <Letter>` section's row-ID
  order the same way `parseBodyGroupCounts` locates its counts, just
  returning the ordered `{id, title}` list instead of a bare count.

**The real shell markup is NOT `<summary>…</summary><div class="body">…</div>`
sitting directly in the section — every row is wrapped in its own
`<details class="item">`, and every section (including Blocked and
Unconfirmed) opens with a `<header>` block containing the `gtitle`/`gcount`/
`setup` markup, which this task must never touch.** Confirmed against the
real file (`onbox-acceptance-register-live-view.html:366-376` for Group A,
`:1504-1509` for Blocked):

```html
<section class="group" id="ga">
  <header>
    <h3 class="gtitle"><span class="gtag">A</span> The GPU box <span class="gcount">38 rows</span></h3>
    <p class="setup"> … hand-authored … </p>
  </header>

  <details class="item">
    <summary><span class="num">A1</span><span class="iname">…</span><span class="risk hot">…</span><span class="chev">›</span></summary>
    <div class="body"> … </div>
  </details>
  <details class="item">
    <summary><span class="num">A2</span>…</summary>
    <div class="body"> … </div>
  </details>
</section>
```

Blocked/Unconfirmed shells are the same `<details class="item">` shape, with
`<span class="num">—</span>` instead of an ID span. This is the single
riskiest assumption in the whole plan — **re-confirm this structure against
the real file yourself, at implementation time, before writing a single line
of `reconcileRowShells`**, since a boundary mismatch here silently deletes a
group's header on the first real run (Task 7 Step 9 exists specifically to
catch that before it ships).

- [ ] **Step 1: Write `splitMdSections` and the failing tests for ID-set insert/delete/reorder**

```javascript
function splitMdSections(mdText) {
  const headingRegex = /^## (.+)$/gm;
  const matches = [...mdText.matchAll(headingRegex)];
  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : mdText.length;
    sections.push({ title: matches[i][1].trim(), body: mdText.slice(start, end) });
  }
  return sections;
}
```

```javascript
test('a row added to the .md inserts a placeholder shell, wrapped in <details>, in markdown order', () => {
  const md = `## Group A — setup a

### A1 · first
### A2 · second (new)
`;
  const html = `<section class="group" id="ga">
      <header><h3 class="gtitle"><span class="gtag">A</span> setup a <span class="gcount">1 row</span></h3></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">existing body</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  const order = [...next.matchAll(/<span class="num">(A\d+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['A1', 'A2']);
  assert.match(next, /A2[\s\S]*body-placeholder/);
  assert.equal((next.match(/<details class="item">/g) ?? []).length, 2);
  assert.equal((next.match(/<\/details>/g) ?? []).length, 2); // balanced — the defect an earlier draft shipped
});

test('the header block is preserved verbatim, including the gcount span Task 6 already wrote', () => {
  const md = `## Group A — setup a

### A1 · first
`;
  const html = `<section class="group" id="ga">
      <header><h3 class="gtitle"><span class="gtag">A</span> The GPU box <span class="gcount">1 row</span></h3><p class="setup">hand-authored</p></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">b</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.match(next, /hand-authored/);
  assert.match(next, /<span class="gcount">1 row<\/span>/);
});

test('a row removed from the .md deletes its shell and nothing adjacent', () => {
  const md = `## Group A — setup a

### A1 · first
`;
  const html = `<section class="group" id="ga">
      <header><h3 class="gtitle">…<span class="gcount">2 rows</span></h3></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">keep me</div>
      </details>
      <details class="item">
        <summary><span class="num">A2</span><span class="iname">discharged</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">gone</div>
      </details>
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
      <header><h3 class="gtitle">…<span class="gcount">2 rows</span></h3></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">body one</div>
      </details>
      <details class="item">
        <summary><span class="num">A2</span><span class="iname">second</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">body two</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.ok(next.indexOf('body two') < next.indexOf('body one'), 'A2 (now first in .md order) must come before A1');
});

test('the publish-token heading is not treated as a row', () => {
  const md = `## Live view

### The publish token — never hand-edit it

Some prose.

## Group A — setup a

### A1 · first
`;
  const html = `<section class="group" id="ga">
      <header><h3 class="gtitle">…<span class="gcount">1 row</span></h3></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">b</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  const order = [...next.matchAll(/<span class="num">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['A1']);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test scripts/tests/build-register-live-view.test.mjs` → FAIL (function doesn't exist).

- [ ] **Step 3: Implement row-ID extraction and `<details>`-aware shell parsing**

```javascript
const ROW_HEADING_REGEX = /^### ([A-Z]\d+) · (.+?)\r?$/gm;

function extractRowIdsInOrder(sectionMd) {
  return [...sectionMd.matchAll(ROW_HEADING_REGEX)].map((m) => ({ id: m[1], title: m[2] }));
}

// One shell = one whole <details class="item">…</details> block. Non-nested
// in this markup (no <details> inside another), so a non-greedy match to the
// FIRST </details> after the opening tag is exact, not an approximation.
const SHELL_BY_ID_REGEX = /<details class="item">\s*<summary><span class="num">([^<]+)<\/span>[\s\S]*?<\/details>/g;

function splitShellsById(sectionHtml) {
  const shells = new Map();
  for (const m of sectionHtml.matchAll(SHELL_BY_ID_REGEX)) {
    shells.set(m[1], m[0]);
  }
  return shells;
}

function buildPlaceholderShell(id, title) {
  return `      <details class="item">
        <summary><span class="num">${id}</span><span class="iname">${title}</span><span class="risk">Not yet published</span><span class="chev">›</span></summary>
        <div class="body">
          <p class="body-placeholder">Not yet published — run \`npm run register:build\` after adding row content, or fill in manually and re-run --check.</p>
        </div>
      </details>`;
}
```

- [ ] **Step 4: Implement `reconcileRowShells` for the seven ID'd sections, touching only the post-`</header>` body**

```javascript
export function reconcileRowShells(mdText, html) {
  const sections = splitMdSections(mdText);
  let result = html;
  for (const section of sections) {
    const letterMatch = section.title.match(/^Group ([A-Z])\b/);
    if (!letterMatch) continue;
    const letter = letterMatch[1];
    const rowIds = extractRowIdsInOrder(section.body);
    result = reconcileOneSection(result, `g${letter.toLowerCase()}`, rowIds);
  }
  return result;
}

// Captures three groups: everything through the closing </header> tag
// (preserved verbatim — this is where Task 6's gcount rewrite already
// landed), the details-list body (rebuilt), and the closing </section> tag
// (preserved). The header is located structurally, not assumed to be a fixed
// string, so it survives regardless of what Task 6 wrote into it.
function reconcileOneSection(html, sectionId, rowIds) {
  const sectionRegex = new RegExp(
    `(<section[^>]*\\bid="${sectionId}"[^>]*>[\\s\\S]*?<\\/header>\\s*\\n)([\\s\\S]*?)(\\s*<\\/section>)`,
  );
  const match = html.match(sectionRegex);
  if (!match) throw new Error(`reconcileRowShells: no section#${sectionId} (with a <header>) found`);
  const [, headerAndOpen, body, closeTag] = match;
  const existingShells = splitShellsById(body);
  const newBody = rowIds
    .map(({ id, title }) => existingShells.get(id) ?? buildPlaceholderShell(id, title))
    .join('\n');
  return html.replace(sectionRegex, `${headerAndOpen}${newBody}\n${closeTag}`);
}
```

- [ ] **Step 5: Run, expect the ID-set tests to pass; commit this slice**

Run: `node --test scripts/tests/build-register-live-view.test.mjs`
Expected: the six tests from Step 1 pass (including the `<details>`-balance
assertion and the header-preservation test); Blocked/Unconfirmed tests (not
yet written) don't exist yet.

```bash
git add scripts/build-register-live-view.mjs scripts/tests/build-register-live-view.test.mjs
git commit -m "feat(ops): register-build generator — row-shell insert/delete/reorder for ID'd sections"
```

- [ ] **Step 6: Write the failing tests for Blocked/Unconfirmed title matching**

The real headings and inames are not simple prose — four of the five real
Blocked headings end in a **markdown-linked** trailing parenthetical whose
`(url)` is itself inside the outer `(...)`, e.g.
`### AMD GPU support Phase 2 ([#1335](https://…/issues/1335))` — a naive
`/\s*\([^()]*\)\s*$/` strip cannot match this (the character before the final
`)` is `)`, not `(`), so the normaliser needs a **balanced** trailing-paren
strip, not a no-nested-parens regex. And normalisation must apply to **both**
sides — the `.md` heading and the decoded `.html` iname — or an entry like
`CPU-only \`RAM_HEAVY_MODELS\` clamp (plan 263, B2 step 7)` (md) vs.
`CPU-only RAM_HEAVY_MODELS clamp (B2 step 7)` (iname, which keeps its own
trailing parenthetical) never matches.

```javascript
// Strips ONE balanced trailing "(...)" — walking from the end, tracking
// paren depth, so a nested markdown link's own (url) doesn't stop the strip
// early. Returns the input unchanged if it doesn't end in ")".
function stripTrailingParenthetical(s) {
  const trimmed = s.trimEnd();
  if (!trimmed.endsWith(')')) return trimmed;
  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i] === ')') depth++;
    else if (trimmed[i] === '(') {
      depth--;
      if (depth === 0) return trimmed.slice(0, i).trimEnd();
    }
  }
  return trimmed; // unbalanced — leave as-is rather than guess
}

function decodeHtmlEntities(s) {
  return s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

// Applied to BOTH the .md heading and the decoded .html iname — not just one
// side, which is the defect an earlier draft of this normaliser shipped (its
// own paired test normalised both sides; its implementation normalised only
// the .md side, so the test could never have failed against the real file).
function normaliseTitle(raw) {
  return stripTrailingParenthetical(raw.replace(/`/g, '')).trim();
}

test('normaliseTitle strips a balanced, markdown-linked trailing parenthetical', () => {
  const md = 'AMD GPU support Phase 2 ([#1335](https://github.com/dudarenok-maker/Castwright/issues/1335))';
  assert.equal(normaliseTitle(md), 'AMD GPU support Phase 2');
});

test('normaliseTitle applied to both sides matches the RAM_HEAVY_MODELS case', () => {
  const md = 'CPU-only `RAM_HEAVY_MODELS` clamp (plan 263, B2 step 7)';
  const iname = decodeHtmlEntities('CPU-only RAM_HEAVY_MODELS clamp (B2 step 7)');
  assert.equal(normaliseTitle(md), normaliseTitle(iname));
});
```

- [ ] **Step 7: Verify these two normalisation tests against ALL FIVE real Blocked pairs before writing `reconcileTitledSection`**

Read the five real Blocked `### ` headings and their five real `iname` spans
from the live file (re-derive — do not trust the two worked examples above as
exhaustive) and hand-check `normaliseTitle(mdHeading) === normaliseTitle(decodeHtmlEntities(iname))`
for every pair. If any pair still fails after this normaliser, that pair's
shape is genuinely new since this plan was written — stop and re-derive the
rule against it before proceeding; do not special-case it.

- [ ] **Step 8: Write the failing tests for Blocked/Unconfirmed reconciliation and implement**

```javascript
test('a Blocked heading matches its shell by exact normalised title, not position', () => {
  const md = `## Blocked — hardware absent

### First blocked thing (#111)
### Second blocked thing (#222)
`;
  const html = `<section class="group is-blocked" id="blocked">
      <header><h3 class="gtitle">…<span class="gcount">2 rows</span></h3></header>
      <details class="item">
        <summary><span class="num">—</span><span class="iname">Second blocked thing</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">second body</div>
      </details>
      <details class="item">
        <summary><span class="num">—</span><span class="iname">First blocked thing</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">first body</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.ok(next.indexOf('First blocked thing') < next.indexOf('Second blocked thing'), 'md order must be preserved, not html order');
  assert.match(next, /First blocked thing[\s\S]*?first body/);
});

test('a Blocked title matching zero shells is an error', () => {
  const md = `## Blocked — hardware absent

### Something with no shell (#333)
`;
  const html = `<section class="group is-blocked" id="blocked">
      <header><h3 class="gtitle">…<span class="gcount">0 rows</span></h3></header>
  </section>`;
  assert.throws(() => reconcileRowShells(md, html), /Something with no shell/);
});

test('an Unconfirmed bullet is matched by its bold-span text as a PREFIX of the decoded iname, not exact match', () => {
  const md = `## Unconfirmed — not debts until substantiated

- **fs-38 Wave 1** (designed-voice authoring, PR #1800) — no explicit owed callout
`;
  const html = `<section class="group is-soft" id="unconfirmed">
      <header><h3 class="gtitle">…<span class="gcount">1 row</span></h3></header>
      <details class="item">
        <summary><span class="num">—</span><span class="iname">fs-38 Wave 1 — designed-voice authoring</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">b</div>
      </details>
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
      <header><h3 class="gtitle">…<span class="gcount">2 rows</span></h3></header>
      <details class="item">
        <summary><span class="num">—</span><span class="iname">First bullet</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">first body</div>
      </details>
      <details class="item">
        <summary><span class="num">—</span><span class="iname">Second bullet</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">second body</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.ok(next.indexOf('Second bullet') < next.indexOf('First bullet'));
  assert.match(next, /Second bullet[\s\S]*?second body/);
  assert.match(next, /First bullet[\s\S]*?first body/);
});
```

```javascript
const BLOCKED_HEADING_REGEX = /^### (.+?)\r?$/gm;
const UNCONFIRMED_BULLET_REGEX = /^- \*\*(.+?)\*\*/gm;
const SHELL_BY_TITLE_REGEX = /<details class="item">\s*<summary><span class="num">—<\/span><span class="iname">([^<]+)<\/span>[\s\S]*?<\/details>/g;

function reconcileTitledSection(html, sectionId, titles, { prefixMatch }) {
  const sectionRegex = new RegExp(
    `(<section[^>]*\\bid="${sectionId}"[^>]*>[\\s\\S]*?<\\/header>\\s*\\n)([\\s\\S]*?)(\\s*<\\/section>)`,
  );
  const match = html.match(sectionRegex);
  if (!match) throw new Error(`reconcileRowShells: no section#${sectionId} (with a <header>) found`);
  const [, headerAndOpen, body, closeTag] = match;
  const shellsByIname = new Map();
  for (const m of body.matchAll(SHELL_BY_TITLE_REGEX)) {
    shellsByIname.set(decodeHtmlEntities(m[1]), m[0]);
  }
  const newBody = titles
    .map((rawTitle) => {
      const wanted = prefixMatch ? rawTitle : normaliseTitle(rawTitle);
      const matches = [...shellsByIname.entries()].filter(([iname]) =>
        prefixMatch ? iname.startsWith(wanted) : normaliseTitle(iname) === wanted,
      );
      if (matches.length === 0) throw new Error(`reconcileRowShells: no shell title matches "${wanted}" in #${sectionId}`);
      if (matches.length > 1) throw new Error(`reconcileRowShells: "${wanted}" matches ${matches.length} shells in #${sectionId}`);
      return matches[0][1];
    })
    .join('\n');
  return html.replace(sectionRegex, `${headerAndOpen}${newBody}\n${closeTag}`);
}

// Wired into reconcileRowShells, added to the loop over splitMdSections:
export function reconcileRowShells(mdText, html) {
  const sections = splitMdSections(mdText);
  let result = html;
  for (const section of sections) {
    const letterMatch = section.title.match(/^Group ([A-Z])\b/);
    if (letterMatch) {
      const rowIds = extractRowIdsInOrder(section.body);
      result = reconcileOneSection(result, `g${letterMatch[1].toLowerCase()}`, rowIds);
      continue;
    }
    // Re-derive the real ## title text for these two before trusting the
    // literal match below — do not assume "Blocked"/"Unconfirmed" are the
    // whole ## line.
    if (/^Blocked\b/.test(section.title)) {
      const blockedTitles = [...section.body.matchAll(BLOCKED_HEADING_REGEX)].map((m) => m[1]);
      result = reconcileTitledSection(result, 'blocked', blockedTitles, { prefixMatch: false });
    } else if (/^Unconfirmed\b/.test(section.title)) {
      const unconfirmedTitles = [...section.body.matchAll(UNCONFIRMED_BULLET_REGEX)].map((m) => m[1]);
      result = reconcileTitledSection(result, 'unconfirmed', unconfirmedTitles, { prefixMatch: true });
    }
  }
  return result;
}
```

- [ ] **Step 9: Run against real files, inspect, revert**

```bash
node scripts/build-register-live-view.mjs
git diff docs/testing/onbox-acceptance-register-live-view.html
git checkout -- docs/testing/onbox-acceptance-register-live-view.html
```

Read the diff in full. If **any** `<header>` block, shell body, `iname`, or
`risk` span changed — not just insert/delete/reorder of whole `<details>`
blocks — the boundary regex is wrong and must not proceed to Task 8. Confirm
specifically: every group's `<header>…</header>` is byte-identical before and
after (Task 6's `gcount` value aside), and `<details>` open/close tag counts
are equal.

- [ ] **Step 10: Commit**

```bash
git add scripts/build-register-live-view.mjs scripts/tests/build-register-live-view.test.mjs
git commit -m "feat(ops): register-build generator — Blocked/Unconfirmed title matching"
```

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

- [ ] **Step 3: Wire the real-file `--check` test — a second real-file check, alongside `check-onbox-register.test.mjs:1181`'s, not a replacement for it (see Step 7)**

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

- [ ] **Step 7: Keep `check-onbox-register.test.mjs:1181`'s real-file assertion — it is not fully superseded**

Read this test in full before touching it: `test('the real register and its
real live view agree', ...)`, calling `checkLiveView(md, lv)` on the real
files, with a comment stating its purpose is to prove "the parsers actually
fit the real, hand-authored markup — the thing that breaks when someone
restyles the live view." `checkLiveView` covers substantially more than the
four comparisons Step 6 retires — per-row `extra`/`missing` sets,
`invalidRowIds`, malformed/duplicate glance letters, missing sections. Step
3's `register:build --check` real-file test does **not** cover any of that.
**Do not delete this test** — the spec's original framing ("replaced, not
deleted... near-vacuous after Step 6's deletions") does not hold once the
surviving comparisons are counted; keep it running exactly as it does today,
as one of two real-file checks (alongside Step 3's), each proving a disjoint
set of properties.

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

### Task 9: `checkIdReuse` — a new, narrowly-scoped ID-reuse check (#2721)

**Files:**
- Modify: `scripts/check-register-citations.mjs`
- Test: `scripts/tests/check-register-citations.test.mjs`

**This task is narrower than its first draft, and deliberately so — a
re-derived design, not the one this plan started with.** The first draft
tried to widen `recordSubjectConflict`/`checkConflictingSubjects` (Check C)
to also handle a departed, unannotated ID as fatal. Re-reading the file's own
architecture (its header comment, `:1352-1362`) shows that case is **already
fully handled, on exactly the citation surface the six real residuals live
on** — `checkNonexistentIds` (Check A) already scans the `Register row(s):`
prose-label idiom (via `extractCitationsByLine`, which covers `ROW_CITATION_REGEX`
and `REGISTER_ROW_LABEL_LINE_REGEX`, not just headings), and already applies
`idSpecificAnnotationPresent` there: fatal when unannotated, non-fatal when
annotated. Re-verify this against the real file before writing any code, but
if confirmed, no new "departed ID" branch is needed anywhere.

**What is genuinely missing is one narrow case: an ID that IS cited via that
same `Register row(s):` idiom, paired with a subject number on the same line,
where the ID currently exists but for a DIFFERENT subject than the one
named.** Check A doesn't check subject-correctness (only existence — the ID
resolves, so Check A is silent). Check C's `citationShapedLineIds`
deliberately does not trust the `Register row(s):` idiom as a subject-pairing
surface (only an anchored heading or a `Criteria source:` line — see
`:1319-1337`, and the 114-false-positive measurement its own history records
for widening beyond same-line, unambiguous pairing).

So this task adds a **new, narrowly-scoped check** — not a modification to
`checkConflictingSubjects`'s existing eligibility rule, which stays exactly as
documented — that trusts exactly one additional same-line shape:
`Register row(s): <ID> … #<subject>` on one physical line, mirroring the
same-line-only discipline Check C's own history already established as the
noise bar. This avoids reopening the false-positive class that shape's
history fought to close, and avoids touching `recordSubjectConflict`'s
existing, heavily-reviewed call sites and their `registerRows.has(id)` guards
at all.

**Interfaces:**
- Consumes: `registerRows` (current valid ID set + `issues`),
  `buildLegitimateSubjectMap` (Task 3, now exported and number-keyed),
  `deBold`/`stripFences` (already in this file, used by Check A/C's own text
  prep — re-derive the exact prep sequence `checkNonexistentIds` uses before
  assuming this task's snippet has it right).
- Produces: `checkIdReuse(fileTexts, registerRows): { wrongId: string[] }` — a
  new, standalone export. The CLI (Task 11 Step 1) folds its `wrongId` output
  into the same fatal bucket `checkConflictingSubjects`'s `wrongId` already
  feeds, so from the CLI's perspective there is one `wrongId` list, sourced
  from two functions.

- [ ] **Step 1: Write the failing tests**

```javascript
test('an ID cited via "Register row:" for a subject it does not currently own is fatal, even with a discharge annotation nearby', () => {
  const registerRows = new Map([['A19', { issues: new Set([1976]), body: '' }]]);
  const fileTexts = new Map([
    [
      'onbox-sitting-vram-contention.md',
      'Register row: A19 for #1893.\n> **Register row: A19 — discharged 2026-08-26, row removed from the register**\n',
    ],
  ]);
  const { wrongId } = checkIdReuse(fileTexts, registerRows);
  assert.equal(wrongId.some((m) => m.includes('A19') && m.includes('1893')), true);
});

test('an ID cited via "Register row:" for a subject it currently DOES own is not fatal', () => {
  const registerRows = new Map([['A1', { issues: new Set([700]), body: '' }]]);
  const fileTexts = new Map([['f.md', 'Register row: A1 for #700.\n']]);
  const { wrongId } = checkIdReuse(fileTexts, registerRows);
  assert.equal(wrongId.length, 0);
});

test('an ID that does not exist at all is NOT this check\'s concern — Check A already owns it', () => {
  const registerRows = new Map(); // A99 minted for nothing
  const fileTexts = new Map([['f.md', 'Register row: A99 for #500.\n']]);
  const { wrongId } = checkIdReuse(fileTexts, registerRows);
  assert.equal(wrongId.length, 0); // no crash, no false claim — this check is silent, Check A handles it
});

test('a citation to one ID of a still-present multi-row subject is not fatal', () => {
  const registerRows = new Map([
    ['A1', { issues: new Set([700]), body: '' }],
    ['A2', { issues: new Set([700]), body: '' }],
  ]);
  const fileTexts = new Map([['f.md', 'Register row: A1 for #700.\n']]);
  const { wrongId } = checkIdReuse(fileTexts, registerRows);
  assert.equal(wrongId.length, 0);
});
```

- [ ] **Step 2: Verify failure**

Run: `node --test scripts/tests/check-register-citations.test.mjs`
Expected: FAIL — `checkIdReuse` doesn't exist yet.

- [ ] **Step 3: Implement `checkIdReuse`**

```javascript
// Check D: an ID cited via the "Register row(s): <ID>" prose idiom, paired
// with a subject number on the SAME line, where the ID currently exists for
// a DIFFERENT subject than the one named. Deliberately narrower than Check
// A's full citation surface — same-line pairing only, matching Check C's own
// documented noise-avoidance rationale (see its header comment's
// 114-false-positive measurement). Does NOT handle a departed (nonexistent)
// ID — that is already Check A's (checkNonexistentIds') territory, on this
// same idiom, via idSpecificAnnotationPresent; re-verify that claim against
// the real file before relying on it.
const REGISTER_ROW_WITH_SUBJECT_REGEX = /\bRegister\s+rows?:?\s*([A-Z]\d{1,3})\b[^\n]*?#(\d+)/gi;

export function checkIdReuse(fileTexts, registerRows) {
  const legitimate = buildLegitimateSubjectMap(registerRows);
  const wrongId = [];
  for (const [filePath, rawText] of fileTexts) {
    const { text } = stripFences(rawText); // re-derive stripFences' exact return shape (this plan's earlier research found it returns { text, unterminatedFenceLine } in check-onbox-register.mjs — confirm check-register-citations.mjs's own stripFences matches before trusting this destructure)
    const lines = deBold(text).split('\n');
    lines.forEach((line, lineIndex) => {
      for (const m of line.matchAll(REGISTER_ROW_WITH_SUBJECT_REGEX)) {
        const id = m[1];
        const subject = Number(m[2]);
        if (!registerRows.has(id)) continue; // departed — Check A's territory, not this one
        const legitimateIds = legitimate.get(subject);
        if (legitimateIds && legitimateIds.has(id)) continue; // correctly resolves
        const currentRow = registerRows.get(id);
        const currentSubjects = [...currentRow.issues].sort((a, b) => a - b).join('/') || '(no subject in its heading)';
        wrongId.push(
          `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}, but ${id} is currently minted ` +
            `for a different subject (${currentSubjects}) — the ID was reused, not departed; repoint or remove this citation`,
        );
      }
    });
  }
  return { wrongId };
}
```

Re-verify `deBold`'s signature (it may expect the whole text, not
pre-split lines — confirm before wiring) and that `check-register-citations.mjs`'s
own `stripFences` (it has its own, separate from `check-onbox-register.mjs`'s
— confirm they're not literally the same imported function) returns the shape
this snippet assumes.

- [ ] **Step 4: Run to verify pass**

Run: `node --test scripts/tests/check-register-citations.test.mjs`
Expected: PASS.

- [ ] **Step 5: Re-run against the real tree**

Run: `node -e "
import('./scripts/check-register-citations.mjs').then(async (m) => {
  // however this file's own CLI gathers fileTexts/registerRows today —
  // re-derive that gathering code rather than reinventing it here, and call
  // checkIdReuse with the same two arguments checkConflictingSubjects
  // already receives.
});
"`
(This is illustrative — Step 3 of Task 11 wires `checkIdReuse` into the real
CLI; use whatever ad-hoc script or REPL call reproduces the CLI's own
`fileTexts`/`registerRows` construction to sanity-check this task's output
before that wiring lands.) Confirm the `A19`/`#1893`, `A31`/`#2037`,
`A34`/`#2106` residuals now appear in `checkIdReuse`'s `wrongId` output.
**Do not fix the citations in this task** — Task 10 does.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-register-citations.mjs scripts/tests/check-register-citations.test.mjs
git commit -m "feat(ops): add checkIdReuse — fatal ID-reuse detection for check-register-citations (#2721)"
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

**Interfaces:**
- Consumes: `checkIdReuse` (Task 9, a standalone function/export, not folded
  into `checkConflictingSubjects`) and `checkConflictingSubjects`'s own
  existing `wrongId` array.
- Modifies: the CLI's `main`/exit-code logic to call `checkIdReuse` alongside
  `checkConflictingSubjects` and combine both `wrongId` arrays into one fatal
  list, printed and exit-coded identically (no `--strict` gate on either).

Task 9 deliberately shipped `checkIdReuse` as a **separate** function rather
than folding it into `checkConflictingSubjects`, to avoid touching that
function's own heavily-reviewed eligibility rule and call-site guards. That
means, unlike a plan draft that assumed the new cases land in the existing
`wrongId` array "for free", **this task's Step 1 has real wiring to do**, not
just a confirmation.

- [ ] **Step 1: Wire `checkIdReuse` into the CLI and confirm both `wrongId` sources are fatal**

Read the CLI section of `check-register-citations.mjs` (its `main`/exit-code
logic, and wherever it currently calls `checkConflictingSubjects` and consumes
its `wrongId`/`unknownSubject`). Add a `checkIdReuse(fileTexts, registerRows)`
call alongside it, and concatenate its `wrongId` into the same fatal list
`checkConflictingSubjects`'s `wrongId` already feeds — printed the same way,
gated the same way (no `--strict` needed for either). Confirm
`wrongId.length > 0` (now from either source) causes a non-zero exit
regardless of `--strict`. If the existing wiring for `checkConflictingSubjects`'s
own `wrongId` is not already unconditionally fatal, fix that too — that half
is the pre-existing "widening" the issue originally asked for; this task is
where both halves land together.

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
  `scripts/publish-token.mjs`, and both already have real test coverage:
  `scripts/tests/publish-token.test.mjs` (20+ `comparePublishTokens` cases
  plus `nonceInHistory` unit tests) and `scripts/tests/publish-token-git.test.mjs`
  ("REAL-GIT coverage for `nonceInHistory`", already builds a throwaway repo
  with real history for exactly this task's git-dependent testing need — use
  that file's fixture pattern, not `check-onbox-register.test.mjs`'s). No new
  test-infrastructure gap here. `nonceInHistory` returns `boolean | null`
  **synchronously** (confirmed by reading its body — not a promise).
- Produces: a second baseline fetch this task adds — see Step 1.

This task is wiring, not new comparator logic. But it is **two** wiring gaps,
not one: `comparePublishTokens` is unwired into the CLI (the obvious gap), and
**the CLI has never fetched `origin/main`'s live view at all** — only the
register `.md`'s baseline is resolved today (`resolveBaselineText(repoRoot,
registerPath, gitRunner)`, `check-onbox-register.mjs:1167`), for the
`extraOnly`/`staleExtra` machinery. `comparePublishTokens`'s `baseline`
argument needs `origin/main`'s **live-view HTML**, which nothing today reads.

- [ ] **Step 1: Add a second baseline fetch for the live view**

Read `resolveBaselineText` in full (it wraps a `git fetch` + `git show
origin/main:<path>` sequence, fails closed with `CANNOT_VERIFY_BASELINE_ERROR`
when unreadable — re-derive its exact contract). Add a second call —
`resolveBaselineText(repoRoot, liveViewPath, gitRunner)` — for the live-view
path, alongside the existing register-`.md` call. Decide, and state in the
commit/PR body: when this second baseline is unverifiable, does the whole
`--against-published` run fail closed the same way the register baseline
failure already does, or does the publish-token check degrade separately from
`checkLiveView`'s own `extraOnly` result? The safer default, matching this
file's existing fail-closed posture: **the whole run fails closed** if either
baseline is unverifiable — do not ship a design where one baseline failing
silently skips only the publish-token half.

- [ ] **Step 2: Locate the `--against-published` CLI path**

Read `runCheckOnboxRegisterCli` (or whatever the current CLI entry function is
named — re-derive) and find where `direction: 'extraOnly'` is set up. This is
where the publish-token check needs to run alongside `checkLiveView`.

- [ ] **Step 3: Write the failing test**

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

Build `FIXTURE_REPO_DIR`/`FIXTURE_STALE_NONCE_PATH` following
`scripts/tests/publish-token-git.test.mjs`'s existing throwaway-repo-with-real-history
pattern (Step 1's note above), not `check-onbox-register.test.mjs`'s.

- [ ] **Step 4: Verify failure**

Run: `node --test scripts/tests/check-onbox-register.test.mjs`
Expected: FAIL — today's `--against-published` never calls `comparePublishTokens`.

- [ ] **Step 5: Wire the four lookups and the call**

```javascript
import { comparePublishTokens, nonceInHistory, parsePublishToken } from './publish-token.mjs';

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

`runGitCommand` is module-local (not exported) in `check-onbox-register.mjs`
— that's fine, this wiring stays inside the same file/module scope, so no
import is needed; just reference it directly as the `gitRunner` argument. Fold
`tokenErrors` into the CLI's overall error list alongside `checkLiveView`'s
output.

- [ ] **Step 6: Run to verify pass**

Run: `node --test scripts/tests/check-onbox-register.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

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

**Revised after an adversarial review pass (2026-08-29) found the plan not
buildable as first drafted.** That pass found: Task 7's row-shell model
omitted the real `<details class="item">` wrapper and `<header>` block
entirely (would have deleted every group's header on the first real run —
fixed by re-deriving the real markup and rewriting Task 7's parser, fixtures,
and section-replace regex to preserve `<header>` and operate on whole
`<details>` blocks); Task 7's Blocked-title normaliser failed against all
five real Blocked pairs (nested-paren markdown links, one-sided normalisation
— fixed with a balanced-paren stripper applied to both sides, hand-verified
against all five real pairs in Step 7); Task 3's body-scan used string keys
against a numeric-keyed map, making its own fix inert (fixed, plus the
function is now exported); Task 9's original design tried to widen
`checkConflictingSubjects`'s existing eligibility rule, which is unreachable
for the real citation shape and reverses a documented architectural boundary
— redesigned as a new, narrowly-scoped `checkIdReuse` function targeting
exactly the `Register row(s):` idiom, and confirmed Check A already handles
the "departed ID" half; Task 12 was missing a live-view baseline fetch
entirely and pointed at the wrong test-fixture precedent (the real one,
`publish-token-git.test.mjs`, already exists); Task 4's `process.exit(main())`
violated `is-main-module.mjs`'s own documented gotcha; Task 4's strip tiles
dropped the `blk` CSS class; Task 8 would have deleted real-file test coverage
`register:build --check` doesn't replace. All fixed in place above.

**Spec coverage:**
- §1 (generator is a reconciler) → Task 4 (`main`, region-replace primitive).
- §2 (`strip`/`glance`/`groups` targets, `changelog` dropped) → Tasks 4/5/6;
  no changelog task exists, matching the spec's pass-4 drop.
- §3 (row-shell reconciliation, title matching) → Task 7.
- §4 (enforcement, CRLF) → Task 8.
- §5 (retirement) → Task 8 Step 6-7.
- §6 (`wrongId` widening, both prerequisites, the three fixes, the two
  structurally-invisible fixes) → Task 3 (prerequisite 1), Task 9
  (prerequisite 2, as the narrower `checkIdReuse`), Task 10 (the five fixes),
  Task 11 (deferral-site rewrites + wiring both `wrongId` sources into the CLI).
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
markup detail) — never a bare "handle edge cases" with no content. Task 7's
Step 7 in particular requires the implementer to hand-verify the normaliser
against all five real Blocked pairs **before** writing the reconciliation
code, not after — the ordering the review pass found missing the first time.

**Type/name consistency:** `parseRegisterFigures`, `buildStripRegion`,
`applyGeneratedRegion`, `parseBodyGroupCounts`, `splitMdSections`,
`reconcileRowShells`, `reconcileOneSection`, `reconcileTitledSection`,
`normaliseTitle`, `checkIdReuse`, `main` are each defined once and referenced
identically in every later task or step. `splitMdSections` (called by
`reconcileRowShells`, defined in the same task) is now actually defined,
correcting the earlier draft's forward reference.
