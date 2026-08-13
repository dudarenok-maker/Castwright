// ops-55 (#2241): guard that the mandated PR-review-gate mechanism is
// actually model-reachable, not just documented. The failure mode this
// closes: CLAUDE.md/model-routing/SKILL.md describe a gate that a dispatched
// subagent cannot actually invoke (the built-in `code-review` skill is
// user-invocable only — `disable-model-invocation`), and nothing catches the
// wiring rotting apart from prose review.
//
// Four assertions, each independently falsifiable:
//   1. .claude/skills/pr-review-gate/SKILL.md exists and does NOT disable
//      model invocation (the entire point of routing the gate through it).
//   2. pr-review-gate/SKILL.md's frontmatter `name:` matches its directory
//      basename (`pr-review-gate`) — the convention is that the directory is
//      the skill's identifier and `name:` must agree with it. Assertion 1
//      above only checks the path exists and reads its frontmatter for
//      disable-model-invocation, so it stays green even if `name:` drifts to
//      something else; assertion 1 catches half of the "stays resolvable"
//      invariant (the path), this assertion catches the other half (the
//      frontmatter agreeing with it).
//   3. model-routing/SKILL.md's Mechanism bullet actually references
//      pr-review-gate, rather than silently drifting back to naming
//      code-review directly.
//   4. CLAUDE.md's before-shipping step 10 references pr-review-gate too,
//      so the checklist entry point agrees with the routing spec.
//
//   Assertions are referred to elsewhere BY NAME, never by number — this
//   header and the test() order disagreed until 2026-08-13, and a plan that
//   said "retarget assertion 3" was ambiguous between two different tests.
//
// Run via `npm run test:hooks` (node --test). All three source files are
// `extraFiles` on the `test:hooks` step in scripts/verify-cache.mjs — none
// of them sit under the step's existing globs (scripts/**, pinokio-scripts/**,
// .github/**, .husky/**), so without those entries a diff touching only
// .claude/skills/** or CLAUDE.md would print test:hooks [cached] and skip
// the very guard that diff would break (the #1847 trap the comments there
// document at length).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { readNormalized } from '../lib/read-normalized.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const GATE_SKILL_PATH = join(REPO_ROOT, '.claude', 'skills', 'pr-review-gate', 'SKILL.md');
const ROUTING_SKILL_PATH = join(REPO_ROOT, '.claude', 'skills', 'model-routing', 'SKILL.md');
const CLAUDE_MD_PATH = join(REPO_ROOT, 'CLAUDE.md');

test('pr-review-gate/SKILL.md exists and does not disable model invocation', () => {
  assert.ok(existsSync(GATE_SKILL_PATH), `missing ${GATE_SKILL_PATH}`);
  // readNormalized, not a bare readFileSync: the frontmatter regex below
  // requires a literal '\n---', which misses on a CRLF checkout (#2291).
  const src = readNormalized(GATE_SKILL_PATH);
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(src);
  assert.ok(frontmatterMatch, 'pr-review-gate/SKILL.md has no --- frontmatter block');
  const frontmatter = frontmatterMatch[1];
  assert.doesNotMatch(
    frontmatter,
    /disable-model-invocation:\s*true/,
    'pr-review-gate/SKILL.md sets disable-model-invocation: true — a dispatched ' +
      'subagent could no longer invoke it, defeating the whole point of ops-55',
  );
});

test("pr-review-gate/SKILL.md's frontmatter name: matches its directory", () => {
  // The path existing (assertion 1 above) is not sufficient on its own: the
  // convention is that the skill's directory basename IS its identifier, and
  // frontmatter `name:` must agree with it. A rename of `name:` to anything
  // else would leave the file at the same path, still without
  // disable-model-invocation, still readable by every other assertion here —
  // and still mismatched with the directory that names it. Assertion 1
  // covers the path half of that invariant; this assertion covers the
  // frontmatter half, deriving the expected value from the directory itself
  // rather than a hardcoded literal.
  const expectedName = basename(dirname(GATE_SKILL_PATH));
  // readNormalized: see the comment on the same read above.
  const src = readNormalized(GATE_SKILL_PATH);
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(src);
  assert.ok(frontmatterMatch, 'pr-review-gate/SKILL.md has no --- frontmatter block');
  const frontmatter = frontmatterMatch[1];
  const nameRegex = new RegExp(`^name:\\s*${expectedName}\\s*$`, 'm');
  assert.match(
    frontmatter,
    nameRegex,
    `pr-review-gate/SKILL.md's frontmatter name: is not exactly ` +
      `"${expectedName}" (its own directory basename) — Skill(skill: ` +
      `"${expectedName}") would no longer resolve to this file`,
  );
});

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

test("CLAUDE.md's before-shipping step 10 references pr-review-gate", () => {
  const src = readFileSync(CLAUDE_MD_PATH, 'utf8');
  const stepMatch = /^10\. \*\*Independent PR review\.\*\*.*$/m.exec(src);
  assert.ok(
    stepMatch,
    'could not find before-shipping checklist step 10 ("Independent PR review") ' +
      'in CLAUDE.md — it may have been renumbered or reworded',
  );
  assert.match(
    stepMatch[0],
    /pr-review-gate/,
    'before-shipping step 10 no longer references pr-review-gate — the entry ' +
      'point maintainers actually follow must name the model-invocable skill',
  );
});

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

// Markdown links of the form ](some/relative/path.md#anchor) — http(s) links
// are skipped, and so are bare #anchor links (no file part to resolve).
const INTRA_REPO_ANCHOR_LINK = /\]\((?!https?:)([^)#\s]+\.md)#([^)\s]+)\)/g;

/**
 * GitHub's heading-anchor slug: strip backticks, lowercase, drop everything
 * that is not a word char / space / hyphen, trim the ends, then replace each
 * REMAINING SPACE WITH ONE HYPHEN.
 *
 * The one-for-one replacement is the whole subtlety, and an earlier draft of
 * this helper got it wrong with `.replace(/ +/g, '-')`. GitHub does not
 * collapse runs of spaces: `### Scope discipline > merge magic` drops the `>`
 * and leaves TWO spaces, which slug to the DOUBLE hyphen in
 * CONTRIBUTING.md#scope-discipline--merge-magic. A collapsing version reports
 * that correct, live link as broken — a guard that fails on valid input, which
 * is worse than no guard: it trains its reader to "fix" correct documents.
 * The unit test below pins exactly that case GREEN.
 */
function githubAnchor(heading) {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\w\- ]+/g, '')
    .replace(/^ +| +$/g, '')
    .replace(/ /g, '-');
}

/** Blank out fenced code blocks — a ```js sample containing a markdown-link
 *  literal is not a link. Measured: without this, scanning this repo's own
 *  plan docs reports their example snippets as dangling. */
function stripFencedBlocks(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    out.push(inFence ? '' : line);
  }
  return out.join('\n');
}

function headingAnchors(file) {
  const anchors = new Set();
  for (const line of readNormalized(file).split('\n')) {
    const m = /^#{1,6} +(.+?)\s*$/.exec(line);
    if (m) anchors.add(githubAnchor(m[1]));
  }
  return anchors;
}

/** The scan set is DERIVED, not hand-listed: the two root governance docs plus
 *  every markdown file under .claude/skills/**. A hand-list would reproduce the
 *  enumeration trap Task 4 exists to close — the next skill doc added would be
 *  unprotected for exactly the same reason the three extraFiles literals were.
 *  Historical plan docs under docs/ are deliberately OUT of scope: measured
 *  2026-08-13, they carry 15 pre-existing dangling links (relative paths
 *  written as if from the repo root), none of which this work touches. */
function linkScanSet() {
  const skillsRoot = join(REPO_ROOT, '.claude', 'skills');
  const skillDocs = readdirSync(skillsRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => join(d.parentPath ?? d.path, d.name));
  return [join(REPO_ROOT, 'CLAUDE.md'), join(REPO_ROOT, 'CONTRIBUTING.md'), ...skillDocs];
}

test('githubAnchor matches GitHub slugging, including runs of spaces', () => {
  // The green-on-awkward-input case. Without it, the collapsing bug that this
  // helper shipped with in draft is invisible: every OTHER assertion here is a
  // true-positive check, and a helper that over-reports passes all of them.
  assert.equal(githubAnchor('Scope discipline > merge magic'), 'scope-discipline--merge-magic');
  assert.equal(githubAnchor('Mandatory independent review (PRs)'), 'mandatory-independent-review-prs');
  assert.equal(
    githubAnchor('Incidental findings: report, fix, record'),
    'incidental-findings-report-fix-record',
  );
});

test('intra-repo anchor links in the governance docs and skills resolve to real headings', () => {
  // CLAUDE.md:716 links model-routing/SKILL.md#mandatory-independent-review-prs.
  // Moving that section breaks the anchor while the existing string-match
  // assertion ("step 10 references pr-review-gate") stays GREEN — the guard
  // would certify the very line it broke. Presence of a word is not integrity
  // of a link.
  const broken = [];
  for (const source of linkScanSet()) {
    const text = stripFencedBlocks(readNormalized(source));
    for (const [, relPath, anchor] of text.matchAll(INTRA_REPO_ANCHOR_LINK)) {
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
