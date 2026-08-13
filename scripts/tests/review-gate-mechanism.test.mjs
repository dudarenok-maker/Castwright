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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
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

test("model-routing/SKILL.md's PR-review Mechanism bullet references pr-review-gate", () => {
  // readNormalized: the section regex below requires a literal '\n## ',
  // which misses on a CRLF checkout (#2291).
  const src = readNormalized(ROUTING_SKILL_PATH);
  // The file has TWO "- **Mechanism**:" bullets (the spec/plan review's
  // assumption-checker one, and the PR review's one) — scope to the section
  // heading first so a naive first-match regex can't silently grab the wrong
  // one (it did, the first time this test was written: it matched the
  // assumption-checker bullet and never actually exercised the PR-review
  // wording this guard exists to check).
  const sectionMatch = /## Mandatory independent review \(PRs\)\n([\s\S]*?)(?=\n## )/.exec(src);
  assert.ok(
    sectionMatch,
    'could not find the "## Mandatory independent review (PRs)" section in ' +
      'model-routing/SKILL.md — it may have been renamed or moved',
  );
  const mechanismMatch = /- \*\*Mechanism\*\*:[\s\S]*?(?=\n- \*\*[A-Z]|\n## )/.exec(
    sectionMatch[1],
  );
  assert.ok(
    mechanismMatch,
    'could not find the "- **Mechanism**:" bullet under "Mandatory independent ' +
      'review (PRs)" in model-routing/SKILL.md — it may have been reworded or moved',
  );
  assert.match(
    mechanismMatch[0],
    /pr-review-gate/,
    'the Mechanism bullet no longer references pr-review-gate — the gate it ' +
      'documents must be the one that is actually model-invocable',
  );
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
