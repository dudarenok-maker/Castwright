#!/usr/bin/env node
// Thin docs/BACKLOG.md to the prioritized planning view once the items have
// been migrated to GitHub issues (plan 165, run AFTER migrate-backlog-to-issues
// --apply has written docs/backlog-issue-map.json).
//
// The canonical detail (What / Acceptance / Key files / Depends on) now lives in
// each issue. This rewrite leaves docs/BACKLOG.md as the thin planning surface:
//   - Must / Should / Could items keep a rich summary — their human-written
//     _What:_ + _Benefit:_ lines (verbatim) + the issue link. The heavy fields
//     (Source / Acceptance / Key files / Depends on / Migration) are dropped;
//     they're in the issue.
//   - Won't items collapse to a single one-liner (id + link + _Why parked_ +
//     _Wake when_).
// Section headings, sub-group titles, the ID-less shipped-note paragraphs, and
// the `---` rules are preserved; the header prose is rewritten to describe the
// dual-home model. Struck-through / RESOLVED entries are left untouched for the
// human tidy pass.
//
// Usage:
//   node scripts/thin-backlog.mjs           (dry-run — prints a unified diff)
//   node scripts/thin-backlog.mjs --apply   (rewrites docs/BACKLOG.md in place)
//   node scripts/thin-backlog.mjs --help
//
// This is a one-shot lossy transform (NOT idempotent — re-running on an
// already-thin file would re-thin it). Review the diff, then --apply; the file
// is git-tracked, so `git checkout docs/BACKLOG.md` reverts.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const BACKLOG_PATH = resolve(repoRoot, 'docs', 'BACKLOG.md');
const MAP_PATH = resolve(repoRoot, 'docs', 'backlog-issue-map.json');
const REPO = 'dudarenok-maker/AudioBook-Generator';

const LEADING_ID = /^`(fe|srv|side|ops|fs)-(\d+)`/;
const TIER_FROM_SECTION = { Must: 'must', Should: 'should', Could: 'could', "Won't": 'wont' };

function info(msg) {
  process.stdout.write(`${msg}\n`);
}
function die(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(1);
}

function issueLink(id, map) {
  const n = map[id];
  if (!n) return null;
  return `[#${n}](https://github.com/${REPO}/issues/${n})`;
}

// First bullet whose label matches, e.g. firstBullet(lines, /^- _What\b/).
function firstBullet(lines, re) {
  const line = lines.find((l) => re.test(l));
  return line ? line.trim() : null;
}

// Strip a `- _Label:_ ` (or `- _Label (x):_ `) prefix to the bare prose.
function bulletText(bullet) {
  return bullet
    .replace(/^- _[^:]*:_\s*/, '')
    .replace(/^- /, '')
    .trim();
}

// Build the replacement lines for one Must/Should/Could item: keep heading +
// link, keep the human What + Benefit bullets verbatim, point at the issue.
function thinRichItem({ headingPrefix, id, title, bodyLines }, map, warnings) {
  const link = issueLink(id, map);
  if (!link) warnings.push(`${id}: no issue number in the map — link left as a placeholder.`);
  const linkSuffix = link ? ` (${link})` : ' (#? — run migrate-backlog-to-issues --apply first)';

  const what = firstBullet(bodyLines, /^- _What\b/);
  const benefit = firstBullet(bodyLines, /^- _Benefit\b/);

  const out = [`${headingPrefix} \`${id}\` — ${title}${linkSuffix}`, ''];
  if (what) {
    out.push(what);
  } else {
    // No _What:_ bullet (a prose-style item like side-11) — take the first
    // non-empty, non-quote prose line as the summary.
    const prose = bodyLines.find((l) => l.trim() && !l.startsWith('>') && !l.startsWith('#'));
    if (prose) out.push(prose.trim());
    warnings.push(`${id}: no "_What:_" bullet — used the first prose line; polish by hand.`);
  }
  if (benefit) out.push(benefit);
  if (link) out.push(`_Full detail + acceptance:_ ${link}.`);
  out.push('');
  return out;
}

// Build the single one-liner for a Won't item.
function thinWontItem({ id, title, bodyLines }, map, warnings) {
  const link = issueLink(id, map);
  if (!link) warnings.push(`${id}: no issue number in the map — link left as a placeholder.`);
  const linkText = link ? ` (${link})` : ' (#?)';

  const why = firstBullet(bodyLines, /^- _Why parked/);
  const wake = firstBullet(bodyLines, /^- _Wake when/);
  const parts = [`- \`${id}\` — ${title}${linkText}.`];
  if (why) parts.push(`_Why parked:_ ${truncate(bulletText(why))}`);
  if (wake) parts.push(`_Wake when:_ ${truncate(bulletText(wake))}`);
  return [parts.join(' '), ''];
}

function truncate(text, max = 220) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return `${(lastStop > 80 ? cut.slice(0, lastStop + 1) : cut).trim()} …`;
}

const NEW_HEADER = `# Backlog (MoSCoW)

The prioritized planning view. Each item maps to exactly one GitHub issue — the
**canonical detail home** (What / Acceptance / Key files / Depends on / Benefit).
This file stays the single MoSCoW-bucketed, position-prioritized list; the issue
holds the detail and the delivery history. Bugs are GitHub issues with the \`bug\`
label and stay **off** this list (they're out-of-band — filed as the user hits
them). See [CONTRIBUTING.md "Issues"](../CONTRIBUTING.md#issues).

**Item IDs are permanent.** Each item carries a \`<prefix>-<n>\` ID — \`fe\` (frontend),
\`srv\` (server), \`side\` (TTS sidecar), \`ops\` (CI / build / dev-tooling), or \`fs\`
(full-stack). IDs are assigned once and **never reused or renumbered**; gaps are
expected. Cite an item by its ID from code or docs and the reference won't rot.
The issue title leads with the same ID; the issue \`#NN\` is the GitHub-native
auto-close hook (\`Closes #NN\` on the delivering PR).

**Priority = position.** Top of a bucket — and of a sub-group within it — is
highest priority. Reprioritising is pure reordering; it never changes an ID.

**Update rule:** when an item ships, close its issue (or let the PR auto-close it
via \`Closes #NN\`) and remove its row here; update the source plan's \`status:\` /
Ship notes and archive it if \`stable\`. When you discover a new item, file a
Backlog-item issue AND add the thin row here linking it, in the same round.`;

// Walk the raw markdown, splicing item blocks. Returns the new markdown.
function thinBacklog(markdown, map, warnings) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let tier = null;
  let i = 0;

  // Rewrite the header: replace everything between the H1 and the first
  // "## Must" with NEW_HEADER + a rule.
  const firstMust = lines.findIndex((l) => /^##\s+Must\b/.test(l));
  if (firstMust === -1) die('Could not find the "## Must" section — is this the right BACKLOG.md?');
  out.push(NEW_HEADER, '', '---', '');
  i = firstMust;

  for (; i < lines.length; i++) {
    const line = lines[i];

    const section = /^##\s+(Must|Should|Could|Won't)\b/.exec(line);
    if (section) {
      tier = TIER_FROM_SECTION[section[1]];
      out.push(line);
      continue;
    }
    if (/^##\s+Retired numbering\b/.test(line)) {
      tier = null;
      out.push(line);
      continue;
    }

    const heading = /^(#{3,4})\s+(.*\S)\s*$/.exec(line);
    const idMatch = heading ? LEADING_ID.exec(heading[2]) : null;
    if (!heading || !idMatch || !tier) {
      out.push(line); // section prose, sub-group title, shipped-note, --- rule
      continue;
    }

    const headingText = heading[2];
    const afterId = headingText.slice(idMatch[0].length);
    const isResolved = /\bRESOLVED\b/.test(headingText) || /^\s*~~/.test(afterId);

    // Find this item's block end (same boundaries the parser uses).
    let end = i + 1;
    for (; end < lines.length; end++) {
      const b = lines[end];
      if (/^#{2,4}\s/.test(b) || /^---\s*$/.test(b) || /^_`/.test(b)) break;
    }
    const bodyLines = lines.slice(i + 1, end);

    if (isResolved) {
      out.push(...lines.slice(i, end)); // leave struck-through entries for the human pass
      i = end - 1;
      continue;
    }

    const id = `${idMatch[1]}-${idMatch[2]}`;
    const title = afterId.replace(/^\s*[—–-]\s*/, '').replace(/~~(.+?)~~/g, '$1').trim();
    const replacement =
      tier === 'wont'
        ? thinWontItem({ id, title, bodyLines }, map, warnings)
        : thinRichItem({ headingPrefix: heading[1], id, title, bodyLines }, map, warnings);
    out.push(...replacement);
    i = end - 1;
  }

  // Collapse 3+ blank lines to a single blank line.
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function printUnifiedDiff(original, proposed) {
  const dir = mkdtempSync(join(tmpdir(), 'thin-backlog-'));
  const tmp = join(dir, 'BACKLOG.proposed.md');
  try {
    writeFileSync(tmp, proposed, 'utf8');
    try {
      execFileSync('git', ['--no-pager', 'diff', '--no-index', '--color=never', BACKLOG_PATH, tmp], {
        stdio: 'inherit',
      });
    } catch {
      // `git diff --no-index` exits 1 when the files differ — that's expected,
      // the diff already streamed to stdout via inherit.
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    info('Usage: node scripts/thin-backlog.mjs [--apply]');
    process.exit(0);
  }
  const apply = argv.includes('--apply');
  const unknown = argv.filter((a) => a !== '--apply');
  if (unknown.length) die(`Unknown argument(s): ${unknown.join(', ')}`);

  if (!existsSync(BACKLOG_PATH)) die(`Not found: ${BACKLOG_PATH}`);
  if (!existsSync(MAP_PATH)) {
    die(`Not found: ${MAP_PATH} — run \`node scripts/migrate-backlog-to-issues.mjs --apply\` first.`);
  }
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  const original = readFileSync(BACKLOG_PATH, 'utf8');
  const warnings = [];
  const proposed = thinBacklog(original, map, warnings);

  if (!apply) {
    printUnifiedDiff(original, proposed);
    if (warnings.length) {
      info(`\nWarnings (polish these rows by hand):`);
      for (const w of warnings) info(`  ! ${w}`);
    }
    info(`\n[DRY-RUN] docs/BACKLOG.md not modified. Re-run with --apply to write it.`);
    process.exit(0);
  }

  writeFileSync(BACKLOG_PATH, proposed, 'utf8');
  if (warnings.length) {
    info(`Warnings (polish these rows by hand):`);
    for (const w of warnings) info(`  ! ${w}`);
  }
  info(`\n[OK] rewrote docs/BACKLOG.md. Review: git diff docs/BACKLOG.md  ·  revert: git checkout docs/BACKLOG.md`);
}

main();
