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
//     mechanism and the effort ladder, and model-routing carries no second
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
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { readNormalized } from '../lib/read-normalized.mjs';
import { buildMirrorContent, syncOneFile } from '../sync-agent-skills.mjs';

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
const MIRRORED_SKILL = 'pr-review-gate';

test('the agent-store mirror matches its canonical source, when it exists', () => {
  // FAILS OPEN BY CONSTRUCTION, and that is not an oversight. The target is
  // in $HOME: absent on a fresh clone and in CI. Making this a hard failure
  // would turn every never-synced machine red. The trade is deliberate — but
  // it means a GREEN run here proves nothing about a machine that has not
  // synced, so never report this as "the mirror is in sync".
  const mirrorRoot = join(AGENT_SKILL_STORE, MIRRORED_SKILL);
  if (!existsSync(mirrorRoot)) {
    // Not skipped silently: say why, so a reader of CI output can tell the
    // difference between "verified" and "not checked".
    console.log(`[skip] no agent-store mirror at ${mirrorRoot} — run npm run skills:sync`);
    return;
  }
  const canonicalRoot = join(REPO_ROOT, '.claude', 'skills', MIRRORED_SKILL);
  for (const rel of ['SKILL.md', 'references/reviewer-brief.md', 'references/findings-triage.md']) {
    const mirrored = join(mirrorRoot, rel);
    assert.ok(existsSync(mirrored), `mirror is missing ${rel} — run npm run skills:sync`);
    // Compare the whole mirrored file against what the sync script WOULD write
    // for the current canonical source. Splitting on the provenance marker and
    // comparing only the tail was the earlier approach, and it forced the
    // script to duplicate SKILL.md's frontmatter block so that the tail would
    // equal the canonical file exactly — a wart in the artifact a reviewing
    // agent actually reads, to save this test one line. Comparing against the
    // builder covers the header format as well as the body, and needs no
    // magic delimiter.
    assert.equal(
      readNormalized(mirrored),
      buildMirrorContent(readNormalized(join(canonicalRoot, rel)), rel),
      `${rel} has drifted from its canonical copy — run npm run skills:sync`,
    );
  }
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

// buildMirrorContent is a pure function — it needs no filesystem and runs on
// every machine, unlike the mirror-drift test above which fails open when
// $HOME has no mirror. These assertions are its only coverage that isn't
// conditional on that mirror existing.
test('buildMirrorContent: frontmatter-bearing input keeps frontmatter as the literal first line', () => {
  const input = '---\nname: pr-review-gate\n---\nBody text.\n';
  const out = buildMirrorContent(input, 'SKILL.md');
  assert.ok(out.startsWith('---\n'), `expected output to start with '---\\n', got: ${JSON.stringify(out.slice(0, 20))}`);
});

test('buildMirrorContent: the header is inserted exactly once, after the frontmatter close', () => {
  const input = '---\nname: pr-review-gate\n---\nBody text.\n';
  const out = buildMirrorContent(input, 'SKILL.md');
  const marker = 'MIRRORED COPY — do not edit here.';
  const firstIdx = out.indexOf(marker);
  assert.notEqual(firstIdx, -1, 'header must be present');
  assert.equal(out.indexOf(marker, firstIdx + 1), -1, 'header must appear exactly once');
  const frontmatterEnd = out.indexOf('\n---\n', 4) + '\n---\n'.length;
  assert.ok(firstIdx > frontmatterEnd, 'header must land after the closing frontmatter delimiter, not before/inside it');
});

test('buildMirrorContent: a non-frontmatter input gets the header at the top', () => {
  const input = 'Just a plain reference doc, no frontmatter.\n';
  const out = buildMirrorContent(input, 'references/reviewer-brief.md');
  assert.ok(out.startsWith('<!-- MIRRORED COPY'), 'header must lead a file with no frontmatter block');
});

test('buildMirrorContent: the canonical body appears exactly once, not duplicated', () => {
  const input = '---\nname: pr-review-gate\n---\nUnique body marker XYZZY appears here.\n';
  const out = buildMirrorContent(input, 'SKILL.md');
  const marker = 'Unique body marker XYZZY appears here.';
  const firstIdx = out.indexOf(marker);
  assert.notEqual(firstIdx, -1, 'canonical body text must be present');
  assert.equal(out.indexOf(marker, firstIdx + 1), -1, 'canonical body text must not be duplicated');
});
