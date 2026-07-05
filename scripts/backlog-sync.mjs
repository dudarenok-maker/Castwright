#!/usr/bin/env node
// Regenerate docs/BACKLOG.md from the GitHub Projects board (ops-25 / #1321).
// Queries type:feature issues on the board with Status != Done via GraphQL,
// groups by moscow:* label, and renders the thin planning-view row format
// (What/Benefit parsed verbatim out of each issue body — never duplicated
// free text here). Won't items (moscow:wont) are included regardless of
// board Status. See docs/superpowers/specs/2026-07-05-github-issues-kanban-design.md §D.
//
// Usage:
//   node scripts/backlog-sync.mjs            (dry-run — prints a diff)
//   node scripts/backlog-sync.mjs --apply    (rewrites docs/BACKLOG.md)
//   node scripts/backlog-sync.mjs --help
//
// NOTE on scope: this generator groups only by moscow:* tier. The hand-written
// per-tier framing paragraphs and the curated sub-group headings (e.g. "###
// Differentiation — the moats, made marketable") that exist in the current
// docs/BACKLOG.md are NOT reproduced — they're editorial curation the board has
// no way to express, and preserving them would mean hand-patching the generated
// file forever, defeating the point of generating it. The first --apply run's
// diff will look like a large rewrite that drops them; that's expected. Only
// the three tier headings + the Retired-numbering section stay as static prose.

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no `gh`, no network).
// ---------------------------------------------------------------------------

// Parse the '- _What:_ ...' / '- _Benefit...:_ ...' bullets out of an issue
// body — the same bullet shape scripts/thin-backlog.mjs already parses.
export function parseWhatBenefit(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const strip = (line) =>
    line ? line.trim().replace(/^- _[^:]*:_\s*/, '').trim() : null;
  const whatLine = lines.find((l) => /^- _What\b/.test(l.trim()));
  const benefitLine = lines.find((l) => /^- _Benefit\b/.test(l.trim()));
  return { what: strip(whatLine), benefit: strip(benefitLine) };
}

// Order two issues by their board Priority field (lower number = higher
// priority, appears first); an issue with no Priority set sorts after every
// prioritized issue; two un-prioritized issues tiebreak by issue number.
// This is the resolution to the spec's §D open risk on intra-tier
// ordering — a real Priority field, not a fallback to issue-number-only
// sort (see the plan's Global Constraints).
function compareByPriority(a, b) {
  const ap = a.priority ?? null;
  const bp = b.priority ?? null;
  if (ap !== null && bp !== null && ap !== bp) return ap - bp;
  if (ap !== null && bp === null) return -1;
  if (ap === null && bp !== null) return 1;
  return a.number - b.number;
}

// Group open, non-Done type:feature issues by moscow:* tier, each tier
// sorted by Priority. Ignores 'wont' (rendered separately, regardless of
// Status) and any issue with no recognized tier (surfaced by the
// parseability audit, scripts/audit-issue-parseability.mjs — never
// silently dropped in the real query path, see Task 3).
export function groupByMoscow(issues) {
  const groups = { must: [], should: [], could: [] };
  for (const issue of issues) {
    if (!groups[issue.moscow]) continue;
    groups[issue.moscow].push(issue);
  }
  for (const tier of Object.keys(groups)) {
    groups[tier].sort(compareByPriority);
  }
  return groups;
}

const TIER_HEADING = {
  must: '## Must — the beta → full-product spine (marketability & discoverability)',
  should: '## Should — important, not blocking ship',
  could: '## Could — nice to have, low-cost win',
};

const HEADER = `# Backlog (MoSCoW)

The prioritized planning view, **generated from the GitHub Projects board**
by \`npm run backlog:sync\` (ops-25) — do not hand-edit; edit the linked issue
and re-run the sync instead. Each item maps to exactly one GitHub issue — the
**canonical detail home** (What / Acceptance / Key files / Depends on /
Benefit). This file lists only \`type:feature\` issues whose board Status is
not \`Done\`; bugs and \`type:chore\` issues live on the board's "Bugs & Chores"
view instead and never appear here. See
[CONTRIBUTING.md "Issues"](../CONTRIBUTING.md#issues).

**Item IDs are permanent.** Each item carries a \`<prefix>-<n>\` ID — \`fe\`
(frontend), \`srv\` (server), \`side\` (TTS sidecar), \`ops\` (CI / build /
dev-tooling), \`fs\` (full-stack), or \`app\` (Android companion app). IDs are
assigned once and **never reused or renumbered**; gaps are expected.

**Priority = position.** Ordering within a tier follows each issue's numeric
\`Priority\` field on the board (lower number = higher priority, appears
first) — set it via the board UI or \`gh project item-edit --field-id
<priorityFieldId> --number <n>\` to reprioritize, then re-run \`npm run
backlog:sync\`. An issue with no \`Priority\` set sorts after every
prioritized issue in its tier.`;

const RETIRED_NUMBERING = `## Retired numbering

The old per-bucket \`Could #N\` / \`Should #N\` numbering was retired on
2026-05-25 in favour of the permanent \`<prefix>-<n>\` IDs above (it renumbered
on every ship, so external references rotted). Any code comment or plan doc
still citing a bare \`Could/Should/Must #N\` is either (a) a stale
pre-2026-05-25 reference — resolve it by matching the comment's described
feature to an item above or to its shipping plan — or (b) **plan-internal**
numbering of the form \`plan <NN> Should #M\`, which is frozen and correct.
Don't reintroduce bare-number backlog references.`;

function renderItem(issue) {
  const { what, benefit } = parseWhatBenefit(issue.body);
  const lines = [
    `#### \`${issue.id}\` — ${issue.title} ([#${issue.number}](${issue.url}))`,
    '',
  ];
  lines.push(
    what
      ? `- _What:_ ${what}`
      : `- _What:_ _(no _What:_ bullet found in #${issue.number} — fix the issue body, see the parseability audit)_`,
  );
  lines.push(
    benefit
      ? `- _Benefit:_ ${benefit}`
      : `- _Benefit:_ _(no _Benefit:_ bullet found in #${issue.number} — fix the issue body, see the parseability audit)_`,
  );
  lines.push(`_Full detail + acceptance:_ [#${issue.number}](${issue.url}).`, '');
  return lines.join('\n');
}

function renderWont(issue) {
  return `- \`${issue.id}\` — ${issue.title} ([#${issue.number}](${issue.url})).`;
}

// Render the full docs/BACKLOG.md contents.
// groups: output of groupByMoscow(). wontIssues: [{id,number,title,url}].
export function renderBacklogMd({ groups, wontIssues }) {
  const out = [HEADER, '', '---', ''];
  for (const tier of ['must', 'should', 'could']) {
    out.push(TIER_HEADING[tier], '');
    for (const issue of groups[tier]) out.push(renderItem(issue));
  }
  out.push("## Won't (this round) — explicitly parked", '');
  for (const issue of [...wontIssues].sort((a, b) => a.number - b.number)) {
    out.push(renderWont(issue), '');
  }
  out.push(RETIRED_NUMBERING, '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// Side-effecting glue (gh CLI + GraphQL). Mirrors scripts/thin-backlog.mjs /
// scripts/migrate-backlog-to-issues.mjs. Throwaway-tested by hand, not
// node:test — see the plan's Task 3 dry-run walkthrough.
// ---------------------------------------------------------------------------

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const BACKLOG_PATH = resolve(repoRoot, 'docs', 'BACKLOG.md');
const CONFIG_PATH = resolve(repoRoot, 'docs', 'backlog-project-config.json');
const PROJECT_OWNER = 'dudarenok-maker';

const LEADING_ID = /^(fe|srv|side|ops|fs|app)-(\d+)\s*—\s*(.*)$/;

function info(msg) {
  process.stdout.write(`${msg}\n`);
}
function die(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(1);
}
function ghAvailable() {
  const r = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

// Split an issue title "fs-1 — In-app upgrade pathway" into { id, title }.
// Returns null for a title with no leading <prefix>-<n> token (non-backlog
// issue — bugs/chores never carry this shape and are filtered out upstream
// by the `type:feature` label anyway, but this is a second, cheap guard).
function idAndTitleFromTitle(title) {
  const m = LEADING_ID.exec(String(title).trim());
  return m ? { id: `${m[1]}-${m[2]}`, title: m[3] } : null;
}

// Page through EVERY item on the Project via GraphQL (Projects v2 has no
// server-side label filter on the items connection, so type:feature
// filtering happens client-side in toBacklogIssues below), reading back the
// Status field value + labels — fields `gh project item-list` does NOT
// expose (it only prints id/content title/number/url, not custom fields).
async function fetchFeatureIssues(config) {
  const query = `
    query($login: String!, $number: Int!, $after: String) {
      user(login: $login) {
        projectV2(number: $number) {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              status: fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
              priority: fieldValueByName(name: "Priority") {
                ... on ProjectV2ItemFieldNumberValue { number }
              }
              content {
                ... on Issue {
                  number
                  title
                  url
                  body
                  state
                  labels(first: 20) { nodes { name } }
                }
              }
            }
          }
        }
      }
    }`;

  const results = [];
  let after = null;
  for (;;) {
    const args = [
      'api', 'graphql',
      '-f', `query=${query}`,
      '-f', `login=${PROJECT_OWNER}`,
      '-F', `number=${config.projectNumber}`,
    ];
    if (after) args.push('-f', `after=${after}`);
    const raw = execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8' });
    const data = JSON.parse(raw).data.user.projectV2.items;
    results.push(...data.nodes);
    if (!data.pageInfo.hasNextPage) break;
    after = data.pageInfo.endCursor;
  }
  return results;
}

// Reduce raw GraphQL item nodes down to what groupByMoscow/renderBacklogMd
// need. Done-filtering reads the board's own Status field (node.status) —
// NOT issue open/closed — because that's what "Status != Done" means per
// spec §D; a closed issue whose card missed the "Item closed -> Done"
// automation, or an OPEN issue manually dragged to Done, must both be
// judged by the field, not by GitHub's issue state. We additionally require
// state === 'OPEN' as a belt-and-suspenders guard against a *stale* Status
// value on an issue that's actually closed (matches the existing "BACKLOG.md
// is forward-looking, not a changelog" convention, spec §D). moscow:wont
// issues are the one exception: spec §D says they render "regardless of
// board Status" — so no state/status gate applies to them at all.
function toBacklogIssues(nodes) {
  const featureIssues = [];
  const wontIssues = [];
  for (const node of nodes) {
    const content = node.content;
    if (!content) continue;
    const labels = content.labels.nodes.map((l) => l.name);
    if (!labels.includes('type:feature')) continue;
    const parsed = idAndTitleFromTitle(content.title);
    // Malformed title (no leading <prefix>-<n> — shouldn't happen for a
    // type:feature issue filed via the backlog-item.yml form, but a hand-
    // edited title could drift). Flagged by scripts/audit-issue-parseability.mjs
    // (Task 9), which checks this exact shape — never silently dropped
    // without a paper trail.
    if (!parsed) continue;
    const moscowLabel = labels.find((l) => l.startsWith('moscow:'));
    const moscow = moscowLabel ? moscowLabel.slice('moscow:'.length) : null;
    const issue = {
      id: parsed.id,
      number: content.number,
      title: parsed.title,
      url: content.url,
      body: content.body,
      moscow,
      priority: node.priority?.number ?? null,
    };
    if (moscow === 'wont') {
      wontIssues.push(issue);
      continue;
    }
    if (!moscow) continue; // no moscow:* tier yet — not ready for either list
    const status = node.status?.name ?? null;
    if (content.state === 'OPEN' && status !== 'Done') featureIssues.push(issue);
  }
  return { featureIssues, wontIssues };
}

function printUnifiedDiff(original, proposed) {
  const dir = mkdtempSync(join(tmpdir(), 'backlog-sync-'));
  const tmp = join(dir, 'BACKLOG.proposed.md');
  try {
    writeFileSync(tmp, proposed, 'utf8');
    try {
      execFileSync('git', ['--no-pager', 'diff', '--no-index', '--color=never', BACKLOG_PATH, tmp], {
        stdio: 'inherit',
      });
    } catch {
      // git diff --no-index exits 1 when files differ — expected, already streamed.
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') {
      info('Usage: node scripts/backlog-sync.mjs [--apply]');
      process.exit(0);
    } else die(`Unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(CONFIG_PATH)) die(`Not found: ${CONFIG_PATH} — run the Task 1 board setup first.`);
  if (!ghAvailable()) die('`gh` not found. Install the GitHub CLI + `gh auth login`.');

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  info('Querying the Project board via GraphQL…');
  const nodes = await fetchFeatureIssues(config);
  const { featureIssues, wontIssues } = toBacklogIssues(nodes);
  const groups = groupByMoscow(featureIssues);
  const proposed = renderBacklogMd({ groups, wontIssues });

  info(`Found ${featureIssues.length} open type:feature issue(s) (must=${groups.must.length}, should=${groups.should.length}, could=${groups.could.length}) + ${wontIssues.length} won't issue(s).`);

  const original = existsSync(BACKLOG_PATH) ? readFileSync(BACKLOG_PATH, 'utf8') : '';
  if (!args.apply) {
    printUnifiedDiff(original, proposed);
    info('\n[DRY-RUN] docs/BACKLOG.md not modified. Re-run with --apply to write it.');
    process.exit(0);
  }

  writeFileSync(BACKLOG_PATH, proposed, 'utf8');
  info(`\n[OK] rewrote docs/BACKLOG.md. Review: git diff docs/BACKLOG.md`);
}

const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  await main();
}
