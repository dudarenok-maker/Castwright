// ops-55 (#2241): guard that the mandated PR-review-gate mechanism is
// actually model-reachable, not just documented. The failure mode this
// closes: CLAUDE.md/model-routing/SKILL.md describe a gate that a dispatched
// subagent cannot actually invoke (the built-in `code-review` skill is
// user-invocable only — `disable-model-invocation`), and nothing catches the
// wiring rotting apart from prose review.
//
// **Assertions are referred to elsewhere BY NAME, never by number.** This
// header used to enumerate "four assertions" in an order that did not match
// the order the test() calls appear in, so a plan saying "retarget assertion
// 3" was ambiguous between two different tests. Do not reintroduce a numbered
// list here — `git grep "^test(" scripts/tests/review-gate-mechanism.test.mjs`
// is the authoritative inventory and cannot drift.
//
// What this file locks, in themes rather than numbers:
//   - the gate skill stays model-invocable and resolvable (path exists, no
//     disable-model-invocation, frontmatter `name:` == directory basename);
//   - pr-review-gate/SKILL.md — not model-routing — carries the dispatch
//     mechanism and the review-depth ladder, and model-routing carries no second
//     copy of the sections that moved out of it on 2026-08-13;
//   - CLAUDE.md's before-shipping step 10 still names the skill;
//   - both references/*.md exist AND are named by SKILL.md, so the dispatch
//     prompt cannot point a reviewer at a file it never learns about;
//   - every intra-repo .md link in the governance docs and skills resolves;
//   - the cross-agent mirror matches what sync-agent-skills.mjs would write.
//
// Run via `npm run test:hooks` (node --test). CLAUDE.md is an `extraFiles`
// entry on the `test:hooks` step in scripts/verify-cache.mjs, and
// `.claude/skills/**` is one of that step's globs (added 2026-08-13, replacing
// three hand-listed literals that could not see a file which did not exist
// yet). Without both, a diff touching only those paths would print
// test:hooks [cached] and skip the very guard that diff would break — the
// #1847 trap the comments there document at length.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readNormalized } from '../lib/read-normalized.mjs';
import {
  FILES as MIRRORED_FILES,
  buildMirrorContent,
  syncOneFile,
  assertFilesNonEmpty,
} from '../sync-agent-skills.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const GATE_SKILL_PATH = join(REPO_ROOT, '.claude', 'skills', 'pr-review-gate', 'SKILL.md');
const ROUTING_SKILL_PATH = join(REPO_ROOT, '.claude', 'skills', 'model-routing', 'SKILL.md');
const CLAUDE_MD_PATH = join(REPO_ROOT, 'CLAUDE.md');
const AGENTS_DIR = join(REPO_ROOT, '.claude', 'agents');

/** Legal `effort:` values per the harness's own schema: five named levels OR
 *  an integer (`Cs([Nr(["low","medium","high","xhigh","max"]), at().int()])`).
 *  The int branch is admitted deliberately even though this repo uses no
 *  integer efforts today — a guard that rejects what the harness accepts is a
 *  guard that gets deleted the first time someone legitimately needs one. */
const NAMED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function isLegalEffort(value) {
  return NAMED_EFFORTS.includes(value) || /^\d+$/.test(value);
}

/** Parses the role table out of model-routing/SKILL.md. Rows look like:
 *    | `pr-reviewer` | Premium | `opus` | `xhigh` | Dispatch for … |
 *  Derived, never hand-listed here: a literal roster in this file would be a
 *  third copy of the same six rows, which is the drift this guard exists to
 *  catch. */
function parseRoleTable() {
  const src = readNormalized(ROUTING_SKILL_PATH);
  const section = /\n## Named dispatch roles\n([\s\S]*?)(?=\n## )/.exec(src);
  assert.ok(section, 'model-routing/SKILL.md has no "## Named dispatch roles" section');
  const rows = [];
  for (const line of section[1].split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) rows.push({ name: m[1], tier: m[2], model: m[3], effort: m[4] });
  }
  return rows;
}

/** Reads an agent definition's YAML frontmatter into a flat key→string map.
 *  readNormalized, not readFileSync: the frontmatter regex needs a literal
 *  '\n---', which misses on a CRLF checkout (#2291). */
function readAgentFrontmatter(name) {
  const path = join(AGENTS_DIR, `${name}.md`);
  assert.ok(existsSync(path), `missing agent definition ${path}`);
  const fm = /^---\n([\s\S]*?)\n---/.exec(readNormalized(path));
  assert.ok(fm, `${name}.md has no --- frontmatter block`);
  return Object.fromEntries(
    fm[1]
      .split('\n')
      .map((l) => /^([a-z-]+):\s*(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
}

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

test('pr-review-gate/SKILL.md carries the dispatch mechanism and the review-depth ladder', () => {
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

  const ladder = /\n## Review depth\n([\s\S]*?)(?=\n## )/.exec(src);
  assert.ok(ladder, 'pr-review-gate/SKILL.md has no "## Review depth" section');
  for (const level of ['low', 'medium', 'high']) {
    assert.match(
      ladder[1],
      new RegExp('`' + level + '`'),
      `the review-depth ladder no longer names \`${level}\``,
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

// Markdown links of the form ](some/relative/path.md) or
// ](some/relative/path.md#anchor) — http(s) links are skipped, and so are
// bare #anchor links (no file part to resolve). The anchor group is optional:
// a plain .md link with no `#` still needs its target file checked for
// existence, it just skips the heading check.
const INTRA_REPO_MD_LINK = /\]\((?!https?:)([^)#\s]+\.md)(?:#([^)\s]+))?\)/g;

/**
 * GitHub's heading-anchor slug: lowercase, drop everything that is not a
 * letter, digit, underscore, hyphen, or space — keeping letters/digits from
 * ANY script, not just ASCII — then replace each REMAINING SPACE WITH ONE
 * HYPHEN. Nothing is trimmed.
 *
 * Two subtleties, both load-bearing:
 *
 * 1. The one-for-one space replacement, not a collapse. An earlier draft of
 *    this helper got it wrong with `.replace(/ +/g, '-')`. GitHub does not
 *    collapse runs of spaces: `### Scope discipline > merge magic` drops the
 *    `>` and leaves TWO spaces, which slug to the DOUBLE hyphen in
 *    CONTRIBUTING.md#scope-discipline--merge-magic. A collapsing version
 *    reports that correct, live link as broken — a guard that fails on valid
 *    input, which is worse than no guard: it trains its reader to "fix"
 *    correct documents.
 * 2. No trimming, and non-ASCII letters survive. A still-earlier draft used
 *    `\w` (ASCII-only) and trimmed the ends, which mishandles both a leading
 *    symbol (`✅ What is solid` should slug to `-what-is-solid` — the emoji
 *    drops out, but the space after it survives untrimmed and becomes a
 *    leading hyphen) and any non-ASCII letter (`Café & bar` should slug to
 *    `café--bar`, keeping the `é`, not `caf--bar`).
 *
 * The unit test below pins all of these cases GREEN.
 */
function githubAnchor(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
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
  // stripFencedBlocks: a heading-shaped line inside a ```fence (e.g. the
  // PR-comment template in pr-review-gate/SKILL.md, which contains literal
  // "### Verdict" / "### Minor" lines as FORMAT to copy, not real headings)
  // is not a real anchor. Without this, the SOURCE side of a link (which
  // already strips fences before matching) and the TARGET side disagree, and
  // the guard accepts a link that resolves only to a fenced example.
  for (const line of stripFencedBlocks(readNormalized(file)).split('\n')) {
    // (?:\s+#+)? strips an optional closed-ATX closing sequence — GitHub
    // renders `## Foo ##` as heading text "Foo", not "Foo ##". The stripped
    // run must be whitespace-separated from the content: `## C#` keeps its
    // trailing `#` (no preceding whitespace before it), only a *space-then-
    // hashes* run at the line's end is a closing sequence. Latent today (zero
    // closed-ATX headings in the current scan set) but a plain
    // `(.+?)\s*$` would silently mis-anchor the first one that appears.
    const m = /^#{1,6} +(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (m) anchors.add(githubAnchor(m[1]));
  }
  return anchors;
}

/** Files staged for the commit this hook run is gating, or `null` when there
 *  is nothing staged (e.g. a plain `npm run test:hooks` / CI run against an
 *  already-committed tree) — the signal linkScanSet() uses to tell "gating a
 *  commit" apart from "auditing the whole repo".
 *
 *  Strips the `GIT_*` env vars (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …)
 *  git hooks set on their own process before spawning this one. Passing only
 *  `cwd` is not enough to redirect a `git` subprocess: those vars, when
 *  present, override `cwd` for repo discovery — inherited unmodified here
 *  they would point `git` at the caller's OWN repo/index regardless of `cwd`.
 *  This mattered even for the REPO_ROOT default: `stagedFiles()` runs from
 *  inside pre-commit for its real job, so this default call is the same
 *  hook-env case as the tmpDir test below, just without the tmpDir masking
 *  it — omitting the strip here silently no-ops in production too. */
function stagedFiles(cwd = REPO_ROOT) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  let out;
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd,
      env,
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
  const files = out.split('\n').filter(Boolean).map((p) => resolve(cwd, p));
  return files.length > 0 ? new Set(files) : null;
}

/** The scan set is DERIVED, not hand-listed: the two root governance docs,
 *  every markdown file under .claude/skills/**, and every markdown file under
 *  docs/testing/**. A hand-list would reproduce the enumeration trap Task 4
 *  exists to close — the next skill doc (or testing doc) added would be
 *  unprotected for exactly the same reason the three extraFiles literals were.
 *  docs/testing/** joined 2026-08-14: this branch added two files there and
 *  nothing scanned the directory, so a dangling link inside it (one was found
 *  and fixed — ort-marker-onbox-acceptance.md's plan-of-record link) shipped
 *  invisibly. Historical plan docs under docs/ (outside docs/testing/) are
 *  deliberately OUT of scope: measured 2026-08-13, they carry 15 pre-existing
 *  dangling links (relative paths written as if from the repo root), none of
 *  which this work touches.
 *
 *  When something is staged (the pre-commit case), the set is further
 *  narrowed to sources that are themselves part of THIS commit — a doc that
 *  intentionally forward-links to siblings a later commit will add (e.g. a
 *  multi-step chain's plan-of-record) would otherwise fail every intermediate
 *  commit in the chain until the last sibling lands, even though none of
 *  those commits touched the forward-linking file (#2463). A full,
 *  everything-on-disk scan still runs whenever nothing is staged — a normal
 *  `npm run test:hooks` or the CI `verify.yml` leg — so the guard's coverage
 *  of the committed tree is unchanged; only the pre-commit-time false
 *  positive on a not-yet-complete chain is narrowed. */
function linkScanSet() {
  const skillsRoot = join(REPO_ROOT, '.claude', 'skills');
  const skillDocs = readdirSync(skillsRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => join(d.parentPath ?? d.path, d.name));
  const testingRoot = join(REPO_ROOT, 'docs', 'testing');
  const testingDocs = readdirSync(testingRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => join(d.parentPath ?? d.path, d.name));
  const all = [
    join(REPO_ROOT, 'CLAUDE.md'),
    join(REPO_ROOT, 'CONTRIBUTING.md'),
    ...skillDocs,
    ...testingDocs,
  ];
  const staged = stagedFiles();
  return staged === null ? all : all.filter((f) => staged.has(resolve(f)));
}

test('githubAnchor matches GitHub slugging, including runs of spaces and non-ASCII', () => {
  // The green-on-awkward-input case. Without it, the collapsing bug that this
  // helper shipped with in draft is invisible: every OTHER assertion here is a
  // true-positive check, and a helper that over-reports passes all of them.
  assert.equal(githubAnchor('Scope discipline > merge magic'), 'scope-discipline--merge-magic');
  assert.equal(githubAnchor('Mandatory independent review (PRs)'), 'mandatory-independent-review-prs');
  assert.equal(
    githubAnchor('Incidental findings: report, fix, record'),
    'incidental-findings-report-fix-record',
  );
  // Non-ASCII cases: a leading symbol drops but its trailing space survives
  // untrimmed (leading hyphen), and a non-ASCII letter is kept, not stripped.
  assert.equal(githubAnchor('✅ What is solid'), '-what-is-solid');
  assert.equal(githubAnchor('Café & bar'), 'café--bar');
});

test("model-routing/SKILL.md's frontmatter name: matches its directory", () => {
  // Mirrors "pr-review-gate/SKILL.md's frontmatter name: matches its
  // directory" above. model-routing is now, like pr-review-gate, a mirrored,
  // name-resolved skill in the cross-agent store (scripts/sync-agent-skills.mjs) —
  // a broken `name:` breaks Cline's resolution silently, and the sync only
  // throws if the file lacks `---` entirely, not if `name:` disagrees with
  // its directory.
  const expectedName = basename(dirname(ROUTING_SKILL_PATH));
  const src = readNormalized(ROUTING_SKILL_PATH);
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(src);
  assert.ok(frontmatterMatch, 'model-routing/SKILL.md has no --- frontmatter block');
  const frontmatter = frontmatterMatch[1];
  const nameRegex = new RegExp(`^name:\\s*${expectedName}\\s*$`, 'm');
  assert.match(
    frontmatter,
    nameRegex,
    `model-routing/SKILL.md's frontmatter name: is not exactly ` +
      `"${expectedName}" (its own directory basename) — Skill(skill: ` +
      `"${expectedName}") would no longer resolve to this file`,
  );
});

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

test('the role table is non-empty and parses', () => {
  // The green-on-awkward-input case, matching githubAnchor's above. Without
  // it, every assertion below is vacuously true the moment the table heading
  // is renamed or the row format drifts: an empty rows[] passes each of them
  // by iterating nothing. This is the assertion that makes the others able
  // to fail at all.
  const rows = parseRoleTable();
  // Exact count, not `>= 1`: that's what closes the vacuous-pass hole above —
  // an empty or partially-parsed rows[] would satisfy `>= 1` just as easily
  // as a correct 6-row parse. Adding a legitimate seventh role means bumping
  // this number in the same change.
  assert.equal(rows.length, 6, `expected 6 roles in the table, parsed ${rows.length}`);
});

/** Tier is the role table's link back to the model-tier table above it in
 *  model-routing/SKILL.md — the routing authority a role is supposed to
 *  inherit from. Nothing else in this file checked it: a row could read
 *  `| implementer | Cheap | sonnet | medium |` (Tier and model disagreeing)
 *  and every other assertion here would still pass. */
const TIER_MODEL = { Premium: 'opus', Default: 'sonnet', Cheap: 'haiku' };

test('every role-table row has a tracked definition file whose frontmatter matches', () => {
  const tracked = new Set(
    execFileSync('git', ['ls-files', '.claude/agents'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((p) => basename(p, '.md')),
  );
  for (const row of parseRoleTable()) {
    assert.ok(
      tracked.has(row.name),
      `.claude/agents/${row.name}.md is not tracked by git — an untracked ` +
        'definition is invisible to CI, so the guard would certify a file no ' +
        'other machine has. Check .gitignore carries !.claude/agents/',
    );
    const fm = readAgentFrontmatter(row.name);
    assert.equal(fm.name, row.name, `${row.name}.md frontmatter name: disagrees with its filename`);
    assert.equal(fm.model, row.model, `${row.name}.md model: is ${fm.model}, table says ${row.model}`);
    assert.equal(fm.effort, row.effort, `${row.name}.md effort: is ${fm.effort}, table says ${row.effort}`);
    assert.ok(
      isLegalEffort(fm.effort),
      `${row.name}.md effort: "${fm.effort}" is not a named level or an integer`,
    );
    assert.equal(
      TIER_MODEL[row.tier],
      row.model,
      `${row.name} row: Tier "${row.tier}" implies model "${TIER_MODEL[row.tier]}", ` +
        `but the row's model column says "${row.model}"`,
    );
  }
});

test('every definition file has a role-table row — the registry is closed', () => {
  // The reverse direction, and the one with teeth: without it a definition
  // can be added with any model/effort it likes and nothing notices, which
  // makes the "table is the registry" claim in model-routing false.
  //
  // Recursive, mirroring linkScanSet()'s own .claude/skills/** walk below —
  // a bare readdirSync(AGENTS_DIR) only sees the top level, but the harness's
  // agent loader recurses into subdirectories. A definition committed one
  // directory down (e.g. .claude/agents/legacy/rogue.md) was loadable and
  // dispatchable while being invisible to this guard, leaving the "closed
  // registry" claim false for anything not directly under AGENTS_DIR.
  // Reported WITH its subpath, not a bare basename: "rogue" is ambiguous
  // between .claude/agents/rogue.md and .claude/agents/legacy/rogue.md.
  const named = new Set(parseRoleTable().map((r) => r.name));
  const onDisk = readdirSync(AGENTS_DIR, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => {
      const parentPath = d.parentPath ?? d.path;
      const rel = join(relative(AGENTS_DIR, parentPath), d.name);
      return rel.slice(0, -'.md'.length).split(sep).join('/');
    });
  const orphans = onDisk.filter((n) => !named.has(n));
  assert.deepEqual(
    orphans,
    [],
    `agent definitions with no row in model-routing's role table: ${orphans.join(', ')}. ` +
      'Add a row (it becomes a governed role) or move the file out of .claude/agents/.',
  );
});

test('scout holds no write tool', () => {
  const fm = readAgentFrontmatter('scout');
  assert.ok(fm.tools, 'scout.md declares no tools: key — it is the one role that must');
  for (const writeTool of ['Edit', 'Write', 'NotebookEdit']) {
    assert.doesNotMatch(
      fm.tools,
      new RegExp(`\\b${writeTool}\\b`),
      `scout.md lists ${writeTool} — a search-and-report role must not hold it`,
    );
  }
});

test('headingAnchors ignores heading-shaped lines inside fenced code blocks', () => {
  // pr-review-gate/SKILL.md's PR-comment template (a ```fence around lines
  // like "### Verdict" / "### 🟡 Minor" / "### ✅ What is solid") is FORMAT to
  // copy, not a real heading — GitHub does not render it as one, so no real
  // link can legitimately target it. Without stripFencedBlocks on this
  // (target) side, those lines register as anchors anyway: the guard fails
  // open on the very file it ships, exactly as the source side already
  // strips fences before matching link text.
  const anchors = headingAnchors(GATE_SKILL_PATH);
  for (const fake of ['verdict', 'minor', '-what-is-solid', 'blocking-claim', 'significant-claim']) {
    assert.ok(
      !anchors.has(fake),
      `headingAnchors(pr-review-gate/SKILL.md) reports "${fake}" as a real anchor — ` +
        'it only exists inside the ```fenced PR-comment template',
    );
  }
});

test('headingAnchors strips a closed-ATX heading\'s trailing hashes', () => {
  // GitHub renders `## Foo ##` (closed-ATX form) as heading text "Foo" — the
  // trailing ` ##` is a closing sequence, not part of the text. Before the
  // fix, the capturing regex kept it verbatim ("Foo ##"), which githubAnchor
  // then slugs to "foo-" (trailing hyphen from the stripped-but-still-spaced
  // hashes) instead of "foo" — a link to `#foo` would report as dangling
  // against a heading that visibly renders as "Foo" on GitHub. Zero
  // occurrences in today's scan set (this is latent, not live), so this unit
  // assertion is the only thing pinning the regex.
  const tmpDir = mkdtempSync(join(tmpdir(), 'heading-anchors-closed-atx-'));
  try {
    const file = join(tmpDir, 'doc.md');
    writeFileSync(file, '## Foo ##\n', 'utf8');
    const anchors = headingAnchors(file);
    assert.ok(anchors.has('foo'), `expected anchors to contain "foo", got: ${JSON.stringify([...anchors])}`);
    assert.ok(
      !anchors.has('foo-'),
      'closed-ATX trailing hashes leaked into the anchor as "foo-" instead of being stripped to "foo"',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stagedFiles() returns null with nothing staged, and the staged set when something is', () => {
  // #2463: a multi-step chain's plan-of-record can legitimately forward-link
  // to sibling docs a later commit will add. Without narrowing, every
  // intermediate commit in the chain fails the link-scan gate on files it
  // never touched. This pins the primitive linkScanSet() narrows on: null
  // (full scan) when the index is clean, the staged paths (and only those)
  // when it isn't.
  //
  // Runs its own `git` subprocesses against a throwaway repo under a tmpDir,
  // NOT this repo — but a `git` child process honours inherited GIT_DIR/
  // GIT_WORK_TREE/GIT_INDEX_FILE env vars over its `cwd` argument. Run this
  // test from inside a git hook (pre-commit sets exactly those vars) without
  // stripping them here, and 'git init'/'add'/'commit' below silently operate
  // on THIS repo's real index instead of tmpDir's — which is how an earlier
  // draft of this test committed its own scratch file into this repo's real
  // history the first time it ran under pre-commit. Strip every GIT_* var,
  // not just the well-known three: git recognises others (GIT_COMMON_DIR,
  // GIT_OBJECT_DIRECTORY, …) that same way.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'staged-files-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmpDir, env });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir, env });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, env });
    const committed = join(tmpDir, 'committed.md');
    writeFileSync(committed, 'already committed\n', 'utf8');
    execFileSync('git', ['add', 'committed.md'], { cwd: tmpDir, env });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir, env });

    assert.equal(stagedFiles(tmpDir), null, 'clean index must report null (triggers a full scan)');

    const staged = join(tmpDir, 'staged.md');
    writeFileSync(staged, 'new, staged\n', 'utf8');
    execFileSync('git', ['add', 'staged.md'], { cwd: tmpDir, env });

    const result = stagedFiles(tmpDir);
    assert.ok(result, 'a staged file must produce a non-null set');
    assert.deepEqual([...result], [resolve(tmpDir, 'staged.md')], 'only the staged file, not the committed one');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('intra-repo .md links in the governance docs and skills resolve to real files and headings', () => {
  // CLAUDE.md:716 links model-routing/SKILL.md#mandatory-independent-review-prs.
  // Moving that section breaks the anchor while the existing string-match
  // assertion ("step 10 references pr-review-gate") stays GREEN — the guard
  // would certify the very line it broke. Presence of a word is not integrity
  // of a link. A plain .md link with no `#` gets the same file-existence
  // check, minus the heading lookup — CONTRIBUTING.md:414-415 link
  // `superpowers/specs/...` and `features/archive/...` with no `docs/`
  // prefix, which only a file-existence check (not the old anchor-only regex)
  // catches, since neither link carries a `#`.
  const broken = [];
  for (const source of linkScanSet()) {
    const text = stripFencedBlocks(readNormalized(source));
    for (const [, relPath, anchor] of text.matchAll(INTRA_REPO_MD_LINK)) {
      const target = resolve(dirname(source), relPath);
      if (!existsSync(target)) {
        broken.push(`${basename(source)} -> ${relPath}${anchor ? '#' + anchor : ''} (file does not exist)`);
        continue;
      }
      if (anchor && !headingAnchors(target).has(anchor.toLowerCase())) {
        broken.push(`${basename(source)} -> ${relPath}#${anchor} (no such heading)`);
      }
    }
  }
  assert.deepEqual(broken, [], `dangling intra-repo .md links:\n  ${broken.join('\n  ')}`);
});

// The mirror lives OUTSIDE the repo, in the cross-agent store at
// ~/.agents/skills/. Cline (and five other agents) read only that store —
// verified 2026-08-13 by asking Cline in this workspace: it listed the 23
// global skills and answered "pr-review-gate: NO".
const AGENT_SKILL_STORE = join(homedir(), '.agents', 'skills');

test('MIRRORED_FILES (sync-agent-skills.mjs FILES) is non-empty and names the expected mirrored skills', () => {
  // The green-on-awkward-input case, matching "the role table is non-empty
  // and parses" above. Without it, every test below that does
  // `for (const rel of MIRRORED_FILES)` is vacuously true the moment FILES
  // is emptied: `npm run skills:sync` would exit 0 printing success having
  // written no files, and the mirror-drift / cross-skill-link tests would
  // both pass by iterating nothing. Exact list, not `.length > 0`: that's
  // what closes the vacuous-pass hole — a `> 0` check is satisfied just as
  // easily by a wrong or partial list as by the real one. Adding a
  // legitimately mirrored file means updating this list in the same change.
  assert.deepEqual(MIRRORED_FILES, [
    'pr-review-gate/SKILL.md',
    'pr-review-gate/references/reviewer-brief.md',
    'pr-review-gate/references/findings-triage.md',
    'model-routing/SKILL.md',
  ]);
});

test('the agent-store mirror matches its canonical source, when it exists', () => {
  // FAILS OPEN BY CONSTRUCTION, and that is not an oversight. The target is
  // in $HOME: absent on a fresh clone and in CI. Making this a hard failure
  // would turn every never-synced machine red. The trade is deliberate — but
  // it means a GREEN run here proves nothing about a machine that has not
  // synced, so never report this as "the mirror is in sync".
  if (!existsSync(AGENT_SKILL_STORE)) {
    console.log(`[skip] no agent-store mirror at ${AGENT_SKILL_STORE} — run npm run skills:sync`);
    return;
  }
  for (const rel of MIRRORED_FILES) {
    const mirrored = join(AGENT_SKILL_STORE, rel);
    assert.ok(existsSync(mirrored), `mirror is missing ${rel} — run npm run skills:sync`);
    assert.equal(
      readNormalized(mirrored),
      buildMirrorContent(readNormalized(join(REPO_ROOT, '.claude', 'skills', rel)), rel),
      `${rel} has drifted from its canonical copy — run npm run skills:sync`,
    );
  }
});

test('every cross-skill link in the mirrored output resolves to a path the mirror also writes', () => {
  // Computed from buildMirrorContent's return value and the FILES list — NOT
  // by reading ~/.agents/skills/, which does not exist in CI. A disk-based
  // check here would skip exactly as the mirror-drift test above does, i.e.
  // it would never run on the machine that gates the merge, which is the
  // whole reason F1 survived unnoticed since the mirror was created.
  const mirroredPaths = new Set(MIRRORED_FILES);
  const broken = [];
  for (const rel of MIRRORED_FILES) {
    const content = buildMirrorContent(readNormalized(join(REPO_ROOT, '.claude', 'skills', rel)), rel);
    for (const [, relPath] of stripFencedBlocks(content).matchAll(INTRA_REPO_MD_LINK)) {
      // `rel` is already skills-root-relative, so resolve the link inside that
      // root and compare exactly — no suffix matching.
      const target = posix.normalize(posix.join(posix.dirname(rel), relPath));
      // A link that ESCAPES the skills root is a repo document (CLAUDE.md,
      // CONTRIBUTING.md, a spec under docs/). The mirror never writes those and
      // never should: the provenance header buildMirrorContent splices in says
      // outright that relative links resolve against a Castwright checkout. Not
      // a defect, so not a finding.
      if (target.startsWith('../')) continue;
      if (!mirroredPaths.has(target)) {
        broken.push(`${rel} -> ${relPath} (mirror does not write this path)`);
      }
    }
  }
  assert.deepEqual(broken, [], `mirrored cross-skill links with no mirrored target:\n  ${broken.join('\n  ')}`);
});

test('syncOneFile throws when the CANONICAL SOURCE has a UTF-8 BOM, and writes no mirror', () => {
  // The BOM check must look at the source, not the written mirror: the
  // mirror always begins with either '---' (frontmatter) or '<!--' (the
  // provenance header on a non-frontmatter file), so a BOM landing on the
  // canonical source would otherwise be silently relocated into the middle
  // of the mirrored file rather than caught. This never touches the real
  // $HOME mirror — both paths are fixtures under a throwaway tmpdir.
  const tmpDir = mkdtempSync(join(tmpdir(), 'skills-sync-bom-'));
  try {
    const srcPath = join(tmpDir, 'SKILL.md');
    const destPath = join(tmpDir, 'mirror', 'SKILL.md');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from('---\nname: pr-review-gate\n---\nBody text.\n', 'utf8');
    writeFileSync(srcPath, Buffer.concat([bom, body]));

    assert.throws(
      () => syncOneFile(srcPath, destPath, 'SKILL.md'),
      /has a UTF-8 BOM/,
      'syncOneFile did not throw for a BOM-poisoned canonical source',
    );
    assert.ok(
      !existsSync(destPath),
      'a BOM-poisoned canonical source must not produce a mirrored file at all',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('syncOneFile throws when SKILL.md frontmatter is not the first line, and leaves a pre-existing mirror untouched', () => {
  // The frontmatter check must run BEFORE the write, like the BOM check
  // above: it inspects `mirrored`, which already exists before writeFileSync
  // is called, so nothing blocks hoisting it. Before the fix, the write ran
  // first — a malformed canonical source clobbered a previously-GOOD mirror
  // with an unusable one, and only then threw. This never touches the real
  // $HOME mirror — both paths are fixtures under a throwaway tmpdir.
  const tmpDir = mkdtempSync(join(tmpdir(), 'skills-sync-frontmatter-'));
  try {
    const srcPath = join(tmpDir, 'SKILL.md');
    const destPath = join(tmpDir, 'mirror', 'SKILL.md');
    // No leading '---\n': buildMirrorContent falls through to its
    // no-frontmatter branch (header + body), so the mirrored output starts
    // with '<!--', not '---\n' — the malformed-canonical-source case.
    writeFileSync(srcPath, 'Just body text, no frontmatter block.\n', 'utf8');
    mkdirSync(dirname(destPath), { recursive: true });
    const preExisting = '---\nname: pr-review-gate\n---\nA previously-good mirror.\n';
    writeFileSync(destPath, preExisting, 'utf8');

    // Pinned to the CANONICAL SOURCE path specifically, not just the message
    // text: the regex alone matches regardless of which path the error
    // names, so reverting the srcPath->destPath identifier in
    // sync-agent-skills.mjs (naming the mirrored destination instead of the
    // canonical source that is actually malformed) would leave this green.
    assert.throws(
      () => syncOneFile(srcPath, destPath, 'SKILL.md'),
      (err) =>
        /frontmatter is not the first line/.test(err.message) &&
        err.message.startsWith(`${srcPath}:`) &&
        !err.message.includes(destPath),
      'syncOneFile did not throw naming the canonical source path (srcPath), not the mirrored destination',
    );
    assert.equal(
      readFileSync(destPath, 'utf8'),
      preExisting,
      'a malformed canonical source must not clobber a pre-existing good mirror',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('assertFilesNonEmpty throws on an empty list, so skills:sync cannot report success having written nothing', () => {
  // syncAgentSkills() itself calls this before its loop, so an accidentally
  // emptied FILES throws instead of printing the success hint and exiting 0
  // having written no files. The commit-time exact-list assert on
  // MIRRORED_FILES above catches an emptied FILES in THIS repo's git history,
  // but skills:sync is a per-machine step run by hand — this is the runtime
  // check for the moments that guard isn't watching. Exercised directly,
  // like the FILES import right above it, rather than through
  // syncAgentSkills(), since FILES is a module-level const nothing here can
  // inject an empty value into.
  assert.throws(
    () => assertFilesNonEmpty([]),
    /FILES is empty/,
    'assertFilesNonEmpty did not throw for an empty list',
  );
  assert.doesNotThrow(
    () => assertFilesNonEmpty(MIRRORED_FILES),
    'assertFilesNonEmpty must not throw for the real, non-empty FILES list',
  );
});

// buildMirrorContent is a pure function — it needs no filesystem and runs on
// every machine, unlike the mirror-drift test above which fails open when
// $HOME has no mirror. These assertions are its only coverage that isn't
// conditional on that mirror existing.
test('buildMirrorContent: frontmatter-bearing input keeps frontmatter as the literal first line', () => {
  const input = '---\nname: pr-review-gate\n---\nBody text.\n';
  const out = buildMirrorContent(input, 'pr-review-gate/SKILL.md');
  assert.ok(out.startsWith('---\n'), `expected output to start with '---\\n', got: ${JSON.stringify(out.slice(0, 20))}`);
});

test('buildMirrorContent: the header is inserted exactly once, after the frontmatter close', () => {
  const input = '---\nname: pr-review-gate\n---\nBody text.\n';
  const out = buildMirrorContent(input, 'pr-review-gate/SKILL.md');
  const marker = 'MIRRORED COPY — do not edit here.';
  const firstIdx = out.indexOf(marker);
  assert.notEqual(firstIdx, -1, 'header must be present');
  assert.equal(out.indexOf(marker, firstIdx + 1), -1, 'header must appear exactly once');
  const frontmatterEnd = out.indexOf('\n---\n', 4) + '\n---\n'.length;
  assert.ok(firstIdx > frontmatterEnd, 'header must land after the closing frontmatter delimiter, not before/inside it');
});

test('buildMirrorContent: a non-frontmatter input gets the header at the top', () => {
  const input = 'Just a plain reference doc, no frontmatter.\n';
  const out = buildMirrorContent(input, 'pr-review-gate/references/reviewer-brief.md');
  assert.ok(out.startsWith('<!-- MIRRORED COPY'), 'header must lead a file with no frontmatter block');
});

test('buildMirrorContent: the canonical body appears exactly once, not duplicated', () => {
  const input = '---\nname: pr-review-gate\n---\nUnique body marker XYZZY appears here.\n';
  const out = buildMirrorContent(input, 'pr-review-gate/SKILL.md');
  const marker = 'Unique body marker XYZZY appears here.';
  const firstIdx = out.indexOf(marker);
  assert.notEqual(firstIdx, -1, 'canonical body text must be present');
  assert.equal(out.indexOf(marker, firstIdx + 1), -1, 'canonical body text must not be duplicated');
});
