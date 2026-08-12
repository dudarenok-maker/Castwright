#!/usr/bin/env node
// Reusable rollout tool (ops-25 rollout step 4): link existing issues as
// native GitHub sub-issues of a parent tracking issue, via the addSubIssue
// GraphQL mutation (gh CLI has no dedicated subcommand for this yet).
//
// Usage:
//   node scripts/link-sub-issues.mjs --parent 1234 --children 111,222,333
//                                     (dry-run — prints what would link)
//   node scripts/link-sub-issues.mjs --parent 1234 --children 111,222,333 --apply

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gh, ghSpawn } from './gh.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_OWNER = 'dudarenok-maker';
const REPO_NAME = 'Castwright';

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
  const out = { parent: null, children: [], apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--parent') out.parent = Number(argv[++i]);
    else if (a === '--children') out.children = argv[++i].split(',').map(Number);
    else if (a === '--apply') out.apply = true;
    else if (a === '--help' || a === '-h') {
      // Defer the print + exit to main() — see the CliError/die note above.
      out.help = true;
      break;
    } else die(`Unknown argument: ${a}`);
  }
  if (!out.help && (!out.parent || !out.children.length)) die('Both --parent and --children are required.');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    info('Usage: node scripts/link-sub-issues.mjs --parent <n> --children <n1,n2,...> [--apply]');
    return;
  }
  if (!ghAvailable()) die('`gh` not found. Install the GitHub CLI + `gh auth login`.');

  const parent = nodeIdForIssue(args.parent);
  info(`Parent: #${args.parent} "${parent.title}"`);
  for (const childNumber of args.children) {
    const child = nodeIdForIssue(childNumber);
    info(`  child #${childNumber} "${child.title}"`);
  }

  if (!args.apply) {
    info('\n[DRY-RUN] Nothing linked. Re-run with --apply to link these as sub-issues.');
    return;
  }

  for (const childNumber of args.children) {
    const child = nodeIdForIssue(childNumber);
    addSubIssue(parent.id, child.id);
    info(`  linked #${childNumber} as a sub-issue of #${args.parent}`);
  }
  info(`\n[OK] linked ${args.children.length} sub-issue(s) under #${args.parent}.`);
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
