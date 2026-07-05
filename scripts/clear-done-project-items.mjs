#!/usr/bin/env node
// Release-cut tool (ops-25 rollout step 9): archive every board item whose
// Status is Done. Run manually as a step in the release-cut recipe
// (CONTRIBUTING.md "Release notes" Recipe) — no scheduled automation (spec §E).
//
// Usage:
//   node scripts/clear-done-project-items.mjs           (dry-run — lists Done items)
//   node scripts/clear-done-project-items.mjs --apply   (archives them)

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const CONFIG_PATH = resolve(repoRoot, 'docs', 'backlog-project-config.json');
const PROJECT_OWNER = 'dudarenok-maker';

function info(msg) { process.stdout.write(`${msg}\n`); }
function die(msg) { process.stderr.write(`[FAIL] ${msg}\n`); process.exit(1); }
function gh(args) { return execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8' }); }
function ghAvailable() {
  const r = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
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
              content { ... on Issue { number title } }
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
  return results.filter((n) => n.status?.name === 'Done' && n.content);
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
}

const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  await main();
}
