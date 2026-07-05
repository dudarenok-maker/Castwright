#!/usr/bin/env node
// Reusable rollout tool (ops-25 rollout step 4): link existing issues as
// native GitHub sub-issues of a parent tracking issue, via the addSubIssue
// GraphQL mutation (gh CLI has no dedicated subcommand for this yet).
//
// Usage:
//   node scripts/link-sub-issues.mjs --parent 1234 --children 111,222,333
//                                     (dry-run — prints what would link)
//   node scripts/link-sub-issues.mjs --parent 1234 --children 111,222,333 --apply

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_OWNER = 'dudarenok-maker';
const REPO_NAME = 'Castwright';

function info(msg) { process.stdout.write(`${msg}\n`); }
function die(msg) { process.stderr.write(`[FAIL] ${msg}\n`); process.exit(1); }
function gh(args) { return execFileSync('gh', args, { encoding: 'utf8' }); }
function ghAvailable() {
  const r = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function nodeIdForIssue(number) {
  const query = `query { repository(owner: "${REPO_OWNER}", name: "${REPO_NAME}") { issue(number: ${number}) { id title } } }`;
  const raw = gh(['api', 'graphql', '-f', `query=${query}`]);
  const issue = JSON.parse(raw).data.repository.issue;
  if (!issue) die(`Issue #${number} not found.`);
  return issue;
}

function addSubIssue(parentId, childId) {
  const mutation = `mutation { addSubIssue(input: { issueId: "${parentId}", subIssueId: "${childId}" }) { issue { number } subIssue { number } } }`;
  gh(['api', 'graphql', '-f', `query=${mutation}`]);
}

function parseArgs(argv) {
  const out = { parent: null, children: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--parent') out.parent = Number(argv[++i]);
    else if (a === '--children') out.children = argv[++i].split(',').map(Number);
    else if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') {
      info('Usage: node scripts/link-sub-issues.mjs --parent <n> --children <n1,n2,...> [--apply]');
      process.exit(0);
    } else die(`Unknown argument: ${a}`);
  }
  if (!out.parent || !out.children.length) die('Both --parent and --children are required.');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!ghAvailable()) die('`gh` not found. Install the GitHub CLI + `gh auth login`.');

  const parent = nodeIdForIssue(args.parent);
  info(`Parent: #${args.parent} "${parent.title}"`);
  for (const childNumber of args.children) {
    const child = nodeIdForIssue(childNumber);
    info(`  child #${childNumber} "${child.title}"`);
  }

  if (!args.apply) {
    info('\n[DRY-RUN] Nothing linked. Re-run with --apply to link these as sub-issues.');
    process.exit(0);
  }

  for (const childNumber of args.children) {
    const child = nodeIdForIssue(childNumber);
    addSubIssue(parent.id, child.id);
    info(`  linked #${childNumber} as a sub-issue of #${args.parent}`);
  }
  info(`\n[OK] linked ${args.children.length} sub-issue(s) under #${args.parent}.`);
}

const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  await main();
}
