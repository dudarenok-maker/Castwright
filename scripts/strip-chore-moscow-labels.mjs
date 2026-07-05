#!/usr/bin/env node
// One-off rollout tool (ops-25 rollout step 3): moscow:* is no longer
// meaningful on type:chore issues (spec §A) — do NOT combine --label flags
// in one `gh issue list` call, they AND-combine rather than OR (a real bug
// this repo's own kanban-design review caught twice). Three separate
// per-tier queries instead. Also cross-references the `tracking` label and
// adds it to ops-17/#790 (matches the same upstream-blocked-watchdog
// semantic as side-23/srv-4 but doesn't carry the label yet), then sets
// every tracking chore's board Status to Waiting/Blocked.
//
// Usage:
//   node scripts/strip-chore-moscow-labels.mjs            (dry-run)
//   node scripts/strip-chore-moscow-labels.mjs --apply

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const CONFIG_PATH = resolve(repoRoot, 'docs', 'backlog-project-config.json');
const PROJECT_OWNER = 'dudarenok-maker';
const MOSCOW_TIERS = ['moscow:must', 'moscow:should', 'moscow:could'];
const OPS_17_NUMBER = 790;

function info(msg) { process.stdout.write(`${msg}\n`); }
function die(msg) { process.stderr.write(`[FAIL] ${msg}\n`); process.exit(1); }
function gh(args) { return execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8' }); }
function ghAvailable() {
  const r = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

// One query per tier — gh's --label flags AND-combine, so `--label
// type:chore --label moscow:must,moscow:should` would (wrongly) require an
// issue to carry ALL of those simultaneously.
function listChoresByTier(tier) {
  const json = gh(['issue', 'list', '--state', 'open', '--label', 'type:chore', '--label', tier, '--json', 'number,title,labels']);
  return JSON.parse(json);
}
function listTrackingChores() {
  const json = gh(['issue', 'list', '--state', 'open', '--label', 'type:chore', '--label', 'tracking', '--json', 'number,title']);
  return JSON.parse(json);
}

function parseArgs(argv) {
  const out = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') {
      info('Usage: node scripts/strip-chore-moscow-labels.mjs [--apply]');
      process.exit(0);
    } else die(`Unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!ghAvailable()) die('`gh` not found. Install the GitHub CLI + `gh auth login`.');

  const byTier = {};
  for (const tier of MOSCOW_TIERS) byTier[tier] = listChoresByTier(tier);
  const total = Object.values(byTier).reduce((n, l) => n + l.length, 0);

  info(`type:chore issues carrying a moscow:* label (${total} total):`);
  for (const tier of MOSCOW_TIERS) {
    for (const issue of byTier[tier]) info(`  #${issue.number} [${tier}] ${issue.title}`);
  }

  const needsTracking = byTier['moscow:should'].some((i) => i.number === OPS_17_NUMBER);
  info(needsTracking
    ? `\n#${OPS_17_NUMBER} (ops-17) needs the 'tracking' label added.`
    : `\n#${OPS_17_NUMBER} (ops-17) not found in the moscow:should chore set — verify it still needs this step before --apply.`);

  const trackingChores = listTrackingChores();
  info(`\n'tracking' type:chore issues to move to Waiting/Blocked (${trackingChores.length}):`);
  for (const issue of trackingChores) info(`  #${issue.number} ${issue.title}`);

  if (!args.apply) {
    info('\n[DRY-RUN] Nothing changed. Re-run with --apply to strip labels + add tracking + set board Status.');
    process.exit(0);
  }
  if (!existsSync(CONFIG_PATH)) die(`Not found: ${CONFIG_PATH} — run the Task 1 board setup first.`);
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

  for (const tier of MOSCOW_TIERS) {
    for (const issue of byTier[tier]) {
      gh(['issue', 'edit', String(issue.number), '--remove-label', tier]);
      info(`  stripped ${tier} from #${issue.number}`);
    }
  }

  if (needsTracking) {
    gh(['issue', 'edit', String(OPS_17_NUMBER), '--add-label', 'tracking']);
    info(`  added 'tracking' to #${OPS_17_NUMBER}`);
  }

  // Union the pre-mutation tracking list with ops-17 (if just labeled) rather
  // than re-querying `gh issue list` — its search index can lag a moment
  // after a label write and silently omit the issue we just tagged.
  const finalTracking = needsTracking && !trackingChores.some((i) => i.number === OPS_17_NUMBER)
    ? [...trackingChores, { number: OPS_17_NUMBER, title: byTier['moscow:should'].find((i) => i.number === OPS_17_NUMBER)?.title ?? 'ops-17' }]
    : trackingChores;
  const findOut = gh(['project', 'item-list', String(config.projectNumber), '--owner', PROJECT_OWNER, '--limit', '500', '--format', 'json']);
  const boardItems = JSON.parse(findOut).items;
  for (const issue of finalTracking) {
    const item = boardItems.find((i) => i.content?.number === issue.number);
    if (!item) {
      info(`  ! #${issue.number} not found on the board — run bulk-add-project-items.mjs first.`);
      continue;
    }
    gh([
      'project', 'item-edit',
      '--id', item.id,
      '--project-id', config.projectId,
      '--field-id', config.statusFieldId,
      '--single-select-option-id', config.statusOptions['Waiting/Blocked'],
    ]);
    info(`  set #${issue.number} -> Waiting/Blocked`);
  }

  info(`\n[OK] reclassified ${total} chore(s), ${needsTracking ? 1 : 0} tracking label added, ${finalTracking.length} set to Waiting/Blocked.`);
}

const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  await main();
}
