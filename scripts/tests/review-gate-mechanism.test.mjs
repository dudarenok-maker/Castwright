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
//   2. model-routing/SKILL.md's Mechanism bullet actually references
//      pr-review-gate, rather than silently drifting back to naming
//      code-review directly.
//   3. CLAUDE.md's before-shipping step 10 references pr-review-gate too,
//      so the checklist entry point agrees with the routing spec.
//   4. pr-review-gate/SKILL.md's frontmatter `name:` is literally
//      `pr-review-gate` — `Skill(skill: "…")` resolves against `name:`, not
//      the file path, so assertion 1 above (which only checks the path
//      exists and reads its frontmatter for disable-model-invocation) stays
//      green even if `name:` drifts to something else, silently breaking
//      every `Skill(skill: "pr-review-gate")` call both governing docs now
//      mandate. This assertion is the one that actually catches that.
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
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const GATE_SKILL_PATH = join(REPO_ROOT, '.claude', 'skills', 'pr-review-gate', 'SKILL.md');
const ROUTING_SKILL_PATH = join(REPO_ROOT, '.claude', 'skills', 'model-routing', 'SKILL.md');
const CLAUDE_MD_PATH = join(REPO_ROOT, 'CLAUDE.md');

test('pr-review-gate/SKILL.md exists and does not disable model invocation', () => {
  assert.ok(existsSync(GATE_SKILL_PATH), `missing ${GATE_SKILL_PATH}`);
  const src = readFileSync(GATE_SKILL_PATH, 'utf8');
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

test("pr-review-gate/SKILL.md's frontmatter name: is pr-review-gate", () => {
  // The path existing (assertion 1 above) is not sufficient: Skill(skill:
  // "…") resolves against frontmatter `name:`, not the file's path. A
  // rename of `name:` to anything else would leave the file at the same
  // path, still without disable-model-invocation, still readable by every
  // other assertion here — and still completely unreachable via
  // `Skill(skill: "pr-review-gate")`, the call both governing docs mandate.
  const src = readFileSync(GATE_SKILL_PATH, 'utf8');
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(src);
  assert.ok(frontmatterMatch, 'pr-review-gate/SKILL.md has no --- frontmatter block');
  const frontmatter = frontmatterMatch[1];
  assert.match(
    frontmatter,
    /^name:\s*pr-review-gate\s*$/m,
    'pr-review-gate/SKILL.md\'s frontmatter name: is not exactly ' +
      '"pr-review-gate" — Skill(skill: "pr-review-gate") would no longer ' +
      'resolve to this file',
  );
});

test("model-routing/SKILL.md's PR-review Mechanism bullet references pr-review-gate", () => {
  const src = readFileSync(ROUTING_SKILL_PATH, 'utf8');
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
