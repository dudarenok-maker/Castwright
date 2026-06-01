#!/usr/bin/env node
// Reconcile the GitHub issue-label taxonomy for plan 165. This file IS the
// source of truth for the labels — version-controlled so a fresh clone (or the
// day the repo goes public) can reproduce them with one command.
//
// Three axes + two helpers (see CONTRIBUTING.md "Issues"):
//   area:<prefix>   — dominant area, mirrors the BACKLOG.md `<prefix>-<n>` IDs
//   moscow:<tier>   — MoSCoW bucket (must/should/could/wont)
//   type:<kind>     — feature | chore (+ the conventional bare `bug`)
//   needs-plan      — owes a docs/features/NN-*.md regression plan
//   tracking        — watchdog item, no direct code fix
//
// Usage:
//   node scripts/gh-labels.mjs            (dry-run — prints the gh commands)
//   node scripts/gh-labels.mjs --apply    (creates/updates the labels via `gh`)
//   node scripts/gh-labels.mjs --help
//
// Idempotent: `gh label create --force` upserts, so --apply both creates
// missing labels and reconciles colour/description drift on existing ones.

import { execFileSync, spawnSync } from 'node:child_process';

// Exported so a test (or a reader) can assert the taxonomy without invoking gh.
export const LABELS = [
  // Area — green.
  { name: 'area:fe', color: '0e8a16', description: 'Frontend (src/)' },
  { name: 'area:srv', color: '0e8a16', description: 'Server (server/src/)' },
  { name: 'area:side', color: '0e8a16', description: 'TTS sidecar (server/tts-sidecar/)' },
  { name: 'area:ops', color: '0e8a16', description: 'CI / build / dev-tooling / distribution' },
  { name: 'area:fs', color: '0e8a16', description: 'Full-stack (frontend + server)' },

  // MoSCoW tier — blue.
  { name: 'moscow:must', color: '1d76db', description: 'Blocks v1 ship or hurts existing users' },
  { name: 'moscow:should', color: '1d76db', description: 'Important, not blocking ship' },
  { name: 'moscow:could', color: '1d76db', description: 'Nice to have, low-cost win' },
  { name: 'moscow:wont', color: '1d76db', description: 'Explicitly parked this round' },

  // Type — purple, except the conventional red `bug`.
  { name: 'type:feature', color: '5319e7', description: 'New user-visible behaviour (backlog feature item)' },
  { name: 'type:chore', color: '5319e7', description: 'Tooling / deps / refactor / tracking item' },
  { name: 'bug', color: 'd73a4a', description: 'Defect — tracked via issues, off the MoSCoW backlog' },

  // Helpers — amber.
  { name: 'needs-plan', color: 'fbca04', description: 'Substantial — owes a docs/features/NN-*.md regression plan' },
  { name: 'tracking', color: 'fbca04', description: 'Watchdog item, no direct code fix' },
];

function info(msg) {
  process.stdout.write(`${msg}\n`);
}
function die(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(1);
}
function gh(args) {
  return execFileSync('gh', args, { stdio: 'inherit', encoding: 'utf8' });
}
function ghAvailable() {
  const r = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function labelArgs(label) {
  return [
    'label',
    'create',
    label.name,
    '--color',
    label.color,
    '--description',
    label.description,
    '--force',
  ];
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    info('Usage: node scripts/gh-labels.mjs [--apply]');
    process.exit(0);
  }
  const apply = argv.includes('--apply');
  const unknown = argv.filter((a) => a !== '--apply');
  if (unknown.length) die(`Unknown argument(s): ${unknown.join(', ')}`);

  info(`${LABELS.length} labels in the taxonomy:`);
  for (const label of LABELS) {
    info(`  gh ${labelArgs(label).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
  }

  if (!apply) {
    info('\n[DRY-RUN] Nothing changed. Re-run with --apply to upsert these labels.');
    process.exit(0);
  }
  if (!ghAvailable()) {
    die('`gh` not found. Install the GitHub CLI + `gh auth login`, then re-run with --apply.');
  }

  for (const label of LABELS) {
    gh(labelArgs(label));
  }
  info(`\n[OK] reconciled ${LABELS.length} labels.`);
}

main();
