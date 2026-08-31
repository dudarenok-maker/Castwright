#!/usr/bin/env node
// One-off rollout tool (ops-25 rollout step 2): add every currently-open
// issue to the Project board, setting an initial Status by heuristic and
// seeding Priority. This is a single, one-time bulk-add — GitHub Projects
// doesn't document item-add as dedup-safe against re-adding the same issue
// twice, so --apply REFUSES to run against a non-empty board (see
// boardIsEmpty below); use the per-issue `gh project item-add` manually for
// anything added later. Throwaway rollout tooling: reviewed by hand, not
// unit tested (spec's Testing section).
//
// Usage:
//   node scripts/bulk-add-project-items.mjs            (dry-run — prints the manifest)
//   node scripts/bulk-add-project-items.mjs --apply    (adds items + sets Status via gh)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gh, ghSpawn } from './gh.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const CONFIG_PATH = resolve(repoRoot, 'docs', 'backlog-project-config.json');
const BACKLOG_PATH = resolve(repoRoot, 'docs', 'BACKLOG.md');
const PROJECT_OWNER = 'dudarenok-maker';
const STALE_DAYS = 14; // no activity in this window -> Backlog; otherwise -> In Progress
const TIER_FROM_SECTION = { Must: 'must', Should: 'should', Could: 'could' };
// Deliberately includes 'app' — migrate-backlog-to-issues.mjs's LEADING_ID
// predates the Android companion area and doesn't; this is a fresh, local
// copy scoped to just extracting row order, not full item parsing, so it's
// simpler to keep it self-contained than to reuse that script's parser.
const LEADING_ID = /^\u0060(fe|srv|side|ops|fs|app)-(\d+)\u0060/;

function info(msg) { process.stdout.write(`${msg}\n`); }
// process.exit() truncates pending async stdout writes on POSIX pipes (sync
// on Windows, async on Linux/macOS — see build-release-zip.mjs's fix for
// #2297/the same defect class). die() throws instead of exiting directly so
// the process only ever exits naturally, once the event loop drains; see the
// entry guard at the bottom of this file for the single catch.
class CliError extends Error {}
function die(msg) { process.stderr.write(`[FAIL] ${msg}\n`); process.exitCode = 1; throw new CliError(msg); }
function ghAvailable() {
  const r = ghSpawn(['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

// Pure: given an issue's updatedAt and whether an open PR references it,
// pick the initial board Status. Exported for readability/REPL exercise,
// not unit-tested — this script is throwaway rollout tooling per the
// spec's Testing section (reviewed by hand during rollout, like every
// other one-off script in this plan).
export function heuristicStatus(issue, { now }) {
  if (issue.linkedOpenPr) return 'In Progress';
  const ageDays = (now - new Date(issue.updatedAt).getTime()) / 86_400_000;
  return ageDays <= STALE_DAYS ? 'In Progress' : 'Backlog';
}

// Parse the CURRENT (still hand-maintained) docs/BACKLOG.md to capture each
// item's row order within its MoSCoW tier — this becomes the initial
// numeric Priority seed (resolves the spec's §D open risk on intra-tier
// ordering: the user chose a real Priority field over accepting
// issue-number ordering). Returns { "<prefix>-<n>": <priority number> },
// gapped by 10 so later manual reordering has room to insert between items
// without renumbering everything. Pure — no `gh`, takes the markdown string.
export function parseBacklogOrder(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const order = {};
  let tier = null;
  let position = 0;
  for (const line of lines) {
    const section = /^##\s+(Must|Should|Could)\b/.exec(line);
    if (section) {
      tier = TIER_FROM_SECTION[section[1]];
      position = 0;
      continue;
    }
    if (/^##\s+(Won\u0027t|Retired numbering)\b/.test(line)) {
      tier = null;
      continue;
    }
    const heading = /^#{3,4}\s+(.*\S)\s*$/.exec(line);
    if (!heading || !tier) continue;
    const idMatch = LEADING_ID.exec(heading[1]);
    if (!idMatch) continue; // sub-group title (e.g. "### Audio & playback") — not an item
    position += 10;
    order[`${idMatch[1]}-${idMatch[2]}`] = position;
  }
  return order;
}

// Pull the <prefix>-<n> id out of an issue title, matching backlog-sync.mjs's
// own idAndTitleFromTitle — a local copy, since that function isn't part of
// backlog-sync.mjs's exported (tested) surface.
function idFromTitle(title) {
  const m = /^(fe|srv|side|ops|fs|app)-(\d+)\s*—/.exec(String(title).trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

function parseArgs(argv) {
  const out = { apply: false, help: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') {
      // Defer the print + exit to main() — see the CliError/die note above.
      out.help = true;
      break;
    } else die(`Unknown argument: ${a}`);
  }
  return out;
}

// gh issue list --json includes updatedAt; linkedOpenPr approximated via
// each issue's timeline is expensive to bulk-fetch, so instead treat any
// issue whose title/number appears in an open PR's body (Closes/Refs #NN)
// as linked — cheap and good enough for a one-time heuristic seed (the
// rollout's manual correction pass, spec rollout step 2, fixes any misses).
function listOpenIssues() {
  const json = gh(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,url,updatedAt']);
  return JSON.parse(json);
}
function listOpenPrBodies() {
  const json = gh(['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'body']);
  return JSON.parse(json).map((pr) => pr.body ?? '');
}

function boardIsEmpty(config) {
  const raw = gh(['project', 'item-list', String(config.projectNumber), '--owner', PROJECT_OWNER, '--limit', '1', '--format', 'json']);
  return JSON.parse(raw).items.length === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    info('Usage: node scripts/bulk-add-project-items.mjs [--apply]');
    return;
  }
  if (!existsSync(CONFIG_PATH)) die(`Not found: ${CONFIG_PATH} — run the Task 1 board setup first.`);
  if (!ghAvailable()) die('`gh` not found. Install the GitHub CLI + `gh auth login`.');

  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (args.apply && !boardIsEmpty(config)) {
    die('The board already has items on it — this script is a ONE-SHOT bulk-add, not safe to re-run (it would double-add every issue and re-seed Priority). Use per-issue `gh project item-add` for anything added after the initial rollout.');
  }
  const issues = listOpenIssues();
  const prBodies = listOpenPrBodies();
  const now = Date.now();
  const priorityOrder = existsSync(BACKLOG_PATH) ? parseBacklogOrder(readFileSync(BACKLOG_PATH, 'utf8')) : {};

  const plan = issues.map((issue) => {
    const linkedOpenPr = prBodies.some((b) => new RegExp(`#${issue.number}\\b`).test(b));
    const id = idFromTitle(issue.title);
    const priority = id ? (priorityOrder[id] ?? null) : null;
    return { ...issue, status: heuristicStatus({ ...issue, linkedOpenPr }, { now }), priority };
  });

  info(`${plan.length} open issue(s):`);
  for (const p of plan) {
    const prio = p.priority == null ? '(no priority — bug/chore/new feature)' : `priority=${p.priority}`;
    info(`  #${p.number.toString().padEnd(5)} -> ${p.status.padEnd(12)} ${prio.padEnd(38)} ${p.title}`);
  }

  if (!args.apply) {
    info('\n[DRY-RUN] Nothing added. Re-run with --apply to add these to the board.');
    return;
  }

  for (const p of plan) {
    info(`Adding #${p.number}…`);
    const addOut = gh(['project', 'item-add', String(config.projectNumber), '--owner', PROJECT_OWNER, '--url', p.url, '--format', 'json']);
    const itemId = JSON.parse(addOut).id;
    gh([
      'project', 'item-edit',
      '--id', itemId,
      '--project-id', config.projectId,
      '--field-id', config.statusFieldId,
      '--single-select-option-id', config.statusOptions[p.status],
    ]);
    if (p.priority != null) {
      gh([
        'project', 'item-edit',
        '--id', itemId,
        '--project-id', config.projectId,
        '--field-id', config.priorityFieldId,
        '--number', String(p.priority),
      ]);
    }
  }
  info(`\n[OK] added ${plan.length} item(s), seeding Priority from today's docs/BACKLOG.md row order for every type:feature issue. Now do the manual pass: open the board and move anything that should be Next or Parked.`);
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch((err) => {
    // die() already wrote its own [FAIL] line and set exitCode before
    // throwing a CliError; only print here for a genuinely unexpected error.
    if (!(err instanceof CliError)) {
      process.stderr.write(`[FAIL] ${err.stack ?? String(err)}\n`);
    }
    process.exitCode = 1;
  });
}
