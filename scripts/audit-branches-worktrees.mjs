#!/usr/bin/env node
// Read-only rollout tool (ops-25 rollout step 5): inventory every local
// branch/worktree not merged into main, and flag which ones have no
// corresponding open issue. Deliberately has NO --apply — per the spec,
// branch/worktree deletion always needs explicit per-item user sign-off,
// never a script decision.
//
// Usage: node scripts/audit-branches-worktrees.mjs

import { execFileSync } from 'node:child_process';

function info(msg) { process.stdout.write(`${msg}\n`); }

function listWorktrees() {
  const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const entries = [];
  let cur = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) entries.push(cur);
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace('refs/heads/', '');
    }
  }
  if (cur.path) entries.push(cur);
  return entries;
}

function listLocalBranches() {
  const raw = execFileSync('git', ['for-each-ref', '--format=%(refname:short) %(upstream:track)', 'refs/heads/'], { encoding: 'utf8' });
  return raw.trim().split('\n').filter(Boolean).map((line) => {
    const [branch, ...rest] = line.split(' ');
    return { branch, gone: rest.join(' ').includes('[gone]') };
  });
}

function isMergedToMain(branch) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branch, 'main']);
    return true;
  } catch {
    return false;
  }
}

function openIssueTitles() {
  const raw = execFileSync('gh', ['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

// A branch name like feat/frontend-castwright-local-hostnames plausibly
// correlates to an issue title if a meaningful chunk of its slug words
// appear in the issue title — a heuristic match for a human to confirm, not
// an automatic one.
function correlate(branchSlug, issues) {
  const words = branchSlug.split(/[/-]/).filter((w) => w.length > 3);
  return issues.filter((i) => {
    const title = i.title.toLowerCase();
    return words.filter((w) => title.includes(w.toLowerCase())).length >= 2;
  });
}

function main() {
  const worktrees = listWorktrees();
  const branches = listLocalBranches();
  const issues = openIssueTitles();

  const worktreeBranches = new Set(worktrees.map((w) => w.branch).filter(Boolean));

  info('=== Worktrees ===');
  for (const w of worktrees) {
    if (!w.branch || w.branch === 'main') continue;
    const merged = isMergedToMain(w.branch);
    info(`${w.path}\n  branch: ${w.branch}  merged-to-main: ${merged}`);
    if (!merged) {
      const matches = correlate(w.branch, issues);
      info(matches.length
        ? `  possible issue match: ${matches.map((m) => `#${m.number} "${m.title}"`).join('; ')}`
        : `  ! NO open issue match found — file one, or confirm this is genuinely abandoned (needs explicit sign-off to delete)`);
    }
  }

  info('\n=== Local branches (excluding worktree-checked-out ones above, and main) ===');
  for (const b of branches) {
    if (b.branch === 'main' || worktreeBranches.has(b.branch)) continue;
    const merged = isMergedToMain(b.branch);
    if (merged) continue; // merged + no worktree = safe to delete, but still ask first
    const matches = correlate(b.branch, issues);
    info(`${b.branch}  gone-from-origin: ${b.gone}`);
    info(matches.length
      ? `  possible issue match: ${matches.map((m) => `#${m.number} "${m.title}"`).join('; ')}`
      : `  ! NO open issue match found — file one, or confirm this is genuinely abandoned (needs explicit sign-off to delete)`);
  }

  info('\nThis is a report only. For each "NO open issue match" line: either file the\nmissing issue and set its board Status to Parked with an explanatory comment,\nor bring it to the user for explicit delete/keep sign-off. No automatic action.');
}

main();
