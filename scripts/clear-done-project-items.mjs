#!/usr/bin/env node
// Release-cut tool (ops-25 rollout step 9): archive every board item whose
// Status is Done. Run automatically by .github/workflows/release.yml's
// `clear-done-board-items` job after every tag's `publish` job succeeds
// (CONTRIBUTING.md "Release notes" Recipe step 8) — no *scheduled*
// automation beyond that (spec §E). Safe to run manually too, e.g. if a
// release published via a path that bypassed the workflow.
//
// Usage:
//   node scripts/clear-done-project-items.mjs           (dry-run — lists Done items)
//   node scripts/clear-done-project-items.mjs --apply   (archives them)

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const CONFIG_PATH = resolve(repoRoot, 'docs', 'backlog-project-config.json');
const PROJECT_OWNER = 'dudarenok-maker';

function info(msg) { process.stdout.write(`${msg}\n`); }
function die(msg) { process.stderr.write(`[FAIL] ${msg}\n`); process.exit(1); }
// Surfaces what was archived on the GitHub Actions run summary page (not just
// buried step logs) — the release.yml job runs --apply unattended on every
// tag with no human dry-run checkpoint, so this is the audit trail for
// catching an item that was wrongly Done. No-op outside CI (env var unset).
function writeStepSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}
function gh(args) { return execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8' }); }
function ghAvailable() {
  const r = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

// Pure: a Done board item is archivable UNLESS it's moscow:wont — the spec
// requires moscow:wont issues to render in docs/BACKLOG.md's Won't section
// "regardless of board Status" (see backlog-sync.mjs's toBacklogIssues), and
// an archived item drops out of the GraphQL items() connection entirely, so
// archiving a wont issue whose card auto-flipped to Done (a normal lifecycle
// event — closing a decided-not-to-do issue) would permanently and silently
// remove it from every future generation.
export function isArchivable(node) {
  if (!node.content || node.status?.name !== 'Done') return false;
  const labels = node.content.labels?.nodes?.map((l) => l.name) ?? [];
  return !labels.includes('moscow:wont');
}

function listDoneItems(config) {
  const query = `
    query($login: String!, $number: Int!, $after: String) {
      user(login: $login) {
        projectV2(number: $number) {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              status: fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue { name }
              }
              content { ... on Issue { number title labels(first: 20) { nodes { name } } } }
            }
          }
        }
      }
    }`;
  // Paginate — a single items(first: 100) page silently misses Done items
  // once the board grows past 100 total items (85 issues + initiative
  // parents + whatever accumulates in Done between releases).
  const results = [];
  let after = null;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `login=${PROJECT_OWNER}`, '-F', `number=${config.projectNumber}`];
    if (after) args.push('-f', `after=${after}`);
    const raw = gh(args);
    const data = JSON.parse(raw).data.user.projectV2.items;
    results.push(...data.nodes);
    if (!data.pageInfo.hasNextPage) break;
    after = data.pageInfo.endCursor;
  }
  return results.filter(isArchivable);
}

function parseArgs(argv) {
  const out = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') {
      info('Usage: node scripts/clear-done-project-items.mjs [--apply]');
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
  const doneItems = listDoneItems(config);

  info(`${doneItems.length} Done item(s):`);
  for (const item of doneItems) info(`  #${item.content.number} ${item.content.title}`);

  if (!args.apply) {
    info('\n[DRY-RUN] Nothing archived. Re-run with --apply to archive these.');
    process.exit(0);
  }

  for (const item of doneItems) {
    gh(['project', 'item-archive', String(config.projectNumber), '--owner', PROJECT_OWNER, '--id', item.id]);
    info(`  archived #${item.content.number}`);
  }
  info(`\n[OK] archived ${doneItems.length} Done item(s).`);

  writeStepSummary([
    `## Archived ${doneItems.length} Done board item(s)`,
    ...doneItems.map((item) => `- #${item.content.number} ${item.content.title}`),
  ]);
}

const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  await main();
}
